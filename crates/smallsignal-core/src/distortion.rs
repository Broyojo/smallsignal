//! Weak distortion by the method of nonlinear currents (a Volterra series).
//!
//! Each selected device's DC currents are expanded to third order about the
//! operating point in all of its controlling voltages (exactly, by Taylor
//! arithmetic on the same equations as `devices`):
//!
//! | device | controls                       | currents                    |
//! |--------|--------------------------------|-----------------------------|
//! | MOSFET | g = v_GS, d = v_DS, b = v_BS   | I_D (drain → source)        |
//! | BJT    | be = v_BE, ce = v_CE           | I_C (c → e), I_B (b → e)    |
//! | diode  | v_D                            | I_D (anode → cathode)       |
//!
//! (for a MOSFET with v_DS < 0, drain and source swap roles, as in the
//! small-signal model). Coefficient K_α multiplies u^α, the monomial in the
//! small-signal control voltages: i = (linear part) + Σ K_α u^α, so
//! K_{2g} = ½·∂²I_D/∂v_GS², K_{gd} = ∂²I_D/∂v_GS∂v_DS, K_{2gd} =
//! ½·∂³I_D/∂v_GS²∂v_DS, and so on. Names: `K_{2g,M1}` (plain `K2g_M1`),
//! `K^{C}_{be\,ce,Q1}` (`KCbece_Q1`), `K_{3,D1}` (`K3_D1`).
//!
//! The linear part is the small-signal model. The order-n response solves
//! the same linear system driven by the order-n nonlinear currents:
//! A·x₂ = −i₂(u₁), A·x₃ = −i₃(u₁, u₂), so the output is
//! v_out = a₁·v_in + a₂·v_in² + a₃·v_in³ (memoryless, at s → 0, in closed form),
//! and at a frequency H₂(jω, jω), H₃(jω, jω, jω) numerically.
//! MOS bulk junction currents are expanded too (I_BS, I_BD, bulk → source /
//! drain); reverse biased beyond 3·V_T they are linear, so they add nothing.
//! The linear part is the derivative of the DC current, so a₁ is the slope of
//! the DC transfer curve: under forward body bias (v_BS > 0) g_mb is the DC
//! slope, not ngspice's AC value (`devices::mos_gmbs_dc`).

use crate::analyze::{cancel, jw, matrix_at};
use crate::dc::{DevOp, Op};
use crate::devices::{mos_gmbs_dc, pn, vt, BjtModel, MosModel};
use crate::linalg::LuComplex;
use crate::netlist::{Kind, Netlist};
use crate::poly::Poly;
use crate::render::Expr;
use crate::ss::{Role, SsCircuit, System};
use crate::sym::{self, Sym, Symbols, XPoly, MATCH_REL};
use num_complex::Complex64;
use serde_json::{json, Value};
use std::borrow::Cow;
use std::cell::{OnceCell, RefCell};
use std::collections::hash_map::Entry;
use std::collections::HashMap;

// --- Taylor arithmetic: three variables, total degree ≤ 3 ------------------

const NJ: usize = 20;
const MONOS: [[u8; 3]; NJ] = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [2, 0, 0],
    [1, 1, 0],
    [1, 0, 1],
    [0, 2, 0],
    [0, 1, 1],
    [0, 0, 2],
    [3, 0, 0],
    [2, 1, 0],
    [2, 0, 1],
    [1, 2, 0],
    [1, 1, 1],
    [1, 0, 2],
    [0, 3, 0],
    [0, 2, 1],
    [0, 1, 2],
    [0, 0, 3],
];

fn deg(m: &[u8; 3]) -> u8 {
    m[0] + m[1] + m[2]
}

fn index(m: [u8; 3]) -> Option<usize> {
    MONOS.iter().position(|x| *x == m)
}

/// Truncated multivariate Taylor polynomial: coefficient k multiplies
/// δ^MONOS[k] (so it is the derivative divided by the factorials).
#[derive(Clone, Copy, Debug)]
pub struct Jet(pub [f64; NJ]);

impl Jet {
    fn cst(v: f64) -> Jet {
        let mut c = [0.0; NJ];
        c[0] = v;
        Jet(c)
    }
    /// v + scale·δ_k.
    fn var(v: f64, k: usize, scale: f64) -> Jet {
        let mut j = Jet::cst(v);
        j.0[1 + k] = scale;
        j
    }
    fn v(&self) -> f64 {
        self.0[0]
    }
    fn add(&self, o: &Jet) -> Jet {
        Jet(std::array::from_fn(|i| self.0[i] + o.0[i]))
    }
    fn sub(&self, o: &Jet) -> Jet {
        Jet(std::array::from_fn(|i| self.0[i] - o.0[i]))
    }
    fn scale(&self, k: f64) -> Jet {
        Jet(self.0.map(|x| x * k))
    }
    fn mul(&self, o: &Jet) -> Jet {
        let mut c = [0.0; NJ];
        for (i, a) in MONOS.iter().enumerate() {
            if self.0[i] == 0.0 {
                continue;
            }
            for (j, b) in MONOS.iter().enumerate() {
                if o.0[j] == 0.0 || deg(a) + deg(b) > 3 {
                    continue;
                }
                let k = index([a[0] + b[0], a[1] + b[1], a[2] + b[2]]).unwrap();
                c[k] += self.0[i] * o.0[j];
            }
        }
        Jet(c)
    }
    /// f(self) from f's Taylor coefficients c_k = f^(k)(v)/k! at v = self.v().
    fn compose(&self, c: [f64; 4]) -> Jet {
        let mut h = *self;
        h.0[0] = 0.0;
        let h2 = h.mul(&h);
        let h3 = h2.mul(&h);
        Jet::cst(c[0])
            .add(&h.scale(c[1]))
            .add(&h2.scale(c[2]))
            .add(&h3.scale(c[3]))
    }
    fn sqrt(&self) -> Jet {
        let a = self.v();
        let r = a.sqrt();
        self.compose([r, 0.5 / r, -0.125 / (a * r), 0.0625 / (a * a * r)])
    }
}

/// Level-1 channel current into the effective drain, effective frame
/// (vds ≥ 0), as `devices::mos_eval`.
fn mos_jet(m: &MosModel, beta: f64, vgs: Jet, vds: Jet, vbs: Jet) -> Jet {
    let sqphi = m.phi.sqrt();
    let sarg = if vbs.v() <= 0.0 {
        Jet::cst(m.phi).sub(&vbs).sqrt()
    } else {
        let l = Jet::cst(sqphi).sub(&vbs.scale(1.0 / (2.0 * sqphi)));
        if l.v() <= 0.0 {
            Jet::cst(0.0)
        } else {
            l
        }
    };
    let von = Jet::cst(m.ty * m.vto - m.gamma * sqphi).add(&sarg.scale(m.gamma));
    let vgst = vgs.sub(&von);
    if vgst.v() <= 0.0 {
        return Jet::cst(0.0);
    }
    let betap = Jet::cst(1.0).add(&vds.scale(m.lambda)).scale(beta);
    if vgst.v() <= vds.v() {
        betap.mul(&vgst).mul(&vgst).scale(0.5)
    } else {
        betap.mul(&vds).mul(&vgst.sub(&vds.scale(0.5)))
    }
}

/// `devices::pn` on a jet.
fn pn_jet(csat: f64, v: Jet, vte: f64) -> Jet {
    let v0 = v.v();
    if v0 >= -3.0 * vte {
        if v0 / vte > 709.0 {
            return Jet::cst(pn(csat, v0, vte).0);
        }
        let e = (v0 / vte).exp();
        let k = csat * e;
        v.compose([
            csat * (e - 1.0),
            k / vte,
            k / (2.0 * vte * vte),
            k / (6.0 * vte * vte * vte),
        ])
    } else {
        // −csat·(1 + (3·vte/(v·e))³)
        let a = 3.0 * vte / std::f64::consts::E;
        let a3 = a * a * a;
        let p = v.compose([v0.powi(-3), -3.0 * v0.powi(-4), 6.0 * v0.powi(-5), -10.0 * v0.powi(-6)]);
        Jet::cst(-csat).sub(&p.scale(csat * a3))
    }
}

/// `devices::bulk_junction` on a jet.
fn bulk_jet(is: f64, v: Jet, gmin: f64) -> Jet {
    let vt = vt();
    let v0 = v.v();
    if v0 <= -3.0 * vt {
        return v.scale(gmin).sub(&Jet::cst(is));
    }
    let e = (v0 / vt).min(709.0).exp();
    let k = is * e;
    v.compose([is * (e - 1.0), k / vt, k / (2.0 * vt * vt), k / (6.0 * vt * vt * vt)])
        .add(&v.scale(gmin))
}

/// (cc, cb) as `devices::bjt_eval`, normalized frame, and the same without
/// the collector–base junction branch i_μ = cbc/BR + gmin·vbc (the part the
/// leakage-free model drops with r_μ).
fn bjt_jet(m: &BjtModel, area: f64, vbe: Jet, vbc: Jet, gmin: f64) -> ((Jet, Jet), (Jet, Jet)) {
    let vt = vt();
    let csat = m.is * area;
    let cbe = pn_jet(csat, vbe, vt);
    let cbc = pn_jet(csat, vbc, vt);
    let inv_vaf = if m.vaf > 0.0 { 1.0 / m.vaf } else { 0.0 };
    let inv_qb = Jet::cst(1.0).sub(&vbc.scale(inv_vaf));
    let cc_free = cbe.sub(&cbc).mul(&inv_qb);
    let cb_free = cbe.scale(1.0 / m.bf).add(&vbe.scale(gmin));
    let imu = cbc.scale(1.0 / m.br).add(&vbc.scale(gmin));
    ((cc_free.sub(&imu), cb_free.add(&imu)), (cc_free, cb_free))
}

/// Within DC-solution accuracy of v = at.
fn near(v: f64, at: f64, scale: f64) -> bool {
    (v - at).abs() <= 1e-9 * (1.0 + scale)
}

/// The level-1 equations switch branch exactly here, so a Taylor series
/// about the point is one-sided: v_GS = V_TH, v_DS = V_DSAT, v_DS = 0 (when
/// λ or γ makes the two orientations differ), v_BS = 0 (γ > 0, bulk not
/// tied to the source) or where sarg clamps, a bulk junction at −3·V_T.
/// Effective-frame voltages.
fn mos_boundary(m: &MosModel, vgs: f64, vds: f64, vbs: f64, body_moves: bool, junctions: &[f64]) -> bool {
    let scale = vgs.abs() + vds.abs() + vbs.abs();
    let ev = crate::devices::mos_eval(m, 1.0, vgs, vds, vbs);
    let vgst = vgs - ev.von;
    let channel = vgst > -1e-9 * (1.0 + scale)
        && (near(vgst, 0.0, scale)
            || near(vds, vgst, scale)
            || (near(vds, 0.0, scale) && (m.lambda != 0.0 || m.gamma != 0.0))
            || (m.gamma != 0.0 && body_moves && (near(vbs, 0.0, scale) || near(vbs, 2.0 * m.phi, scale))));
    channel || junctions.iter().any(|&v| near(v, -3.0 * vt(), v.abs()))
}

// --- devices ----------------------------------------------------------------

pub struct NlOut {
    /// The current flows from `a` through the device to `b`.
    pub a: usize,
    pub b: usize,
    /// "" (MOSFET drain current, diode current), "BS" or "BD" (MOS bulk
    /// junctions), "C" or "B" (BJT).
    pub label: &'static str,
    pub jet: Jet,
    /// The current without junction leakage (r_bs, r_bd, r_μ): what the
    /// leakage-free model keeps.
    pub free: Jet,
}

pub struct NlDev {
    pub element: String,
    /// Control voltages v(p) − v(n), in jet-variable order.
    pub controls: Vec<(usize, usize)>,
    pub vars: &'static [&'static str],
    pub outs: Vec<NlOut>,
    /// Biased on a branch point of its equations (see `mos_boundary`).
    pub boundary: bool,
}

/// Expands each named device at the operating point.
pub fn devices(net: &Netlist, op: &Op, names: &[String]) -> Result<Vec<NlDev>, String> {
    let mut out: Vec<NlDev> = Vec::new();
    for name in names {
        let ei = net
            .element(name)
            .ok_or_else(|| format!("nonlinear device '{name}' not found"))?;
        if out.iter().any(|d| d.element == net.elements[ei].name) {
            continue;
        }
        let e = &net.elements[ei];
        let n = &e.nodes;
        let dev = match (&e.kind, &op.dev[ei]) {
            (Kind::M { model, w, l, mult }, Some(DevOp::Mos(m))) => {
                let ty = model.ty;
                let (ed, es) = if m.reversed { (n[2], n[0]) } else { (n[0], n[2]) };
                let (vgs, vds, vbs) = if m.reversed {
                    (ty * (m.vgs - m.vds), -ty * m.vds, ty * (m.vbs - m.vds))
                } else {
                    (ty * m.vgs, ty * m.vds, ty * m.vbs)
                };
                let beta = model.kp * w / l * mult;
                let (jg, jd, jb) = (Jet::var(vgs, 0, ty), Jet::var(vds, 1, ty), Jet::var(vbs, 2, ty));
                let f = mos_jet(model, beta, jg, jd, jb).scale(ty);
                let mut outs = vec![NlOut {
                    a: ed,
                    b: es,
                    label: "",
                    jet: f,
                    free: f,
                }];
                // Bulk junctions (current bulk → source / drain), unless shorted.
                let (bs, bd) = if m.reversed {
                    (jb.sub(&jd), jb)
                } else {
                    (jb, jb.sub(&jd))
                };
                let mut junctions = Vec::new();
                for (v, other, label) in [(bs, n[2], "BS"), (bd, n[0], "BD")] {
                    if other != n[3] {
                        junctions.push(v.v());
                        let jet = bulk_jet(model.is * mult, v, net.gmin).scale(ty);
                        outs.push(NlOut {
                            a: n[3],
                            b: other,
                            label,
                            jet,
                            free: Jet::cst(0.0),
                        });
                    }
                }
                NlDev {
                    element: e.name.clone(),
                    controls: vec![(n[1], es), (ed, es), (n[3], es)],
                    vars: &["g", "d", "b"],
                    outs,
                    boundary: mos_boundary(model, vgs, vds, vbs, n[3] != es, &junctions),
                }
            }
            (Kind::Q { model, area }, Some(DevOp::Bjt(q))) => {
                let ty = model.ty;
                let vbe = Jet::var(ty * q.vbe, 0, ty);
                let vce = Jet::var(ty * q.vce, 1, ty);
                let ((cc, cb), (cc_free, cb_free)) = bjt_jet(model, *area, vbe, vbe.sub(&vce), net.gmin);
                let vbc = ty * (q.vbe - q.vce);
                NlDev {
                    element: e.name.clone(),
                    controls: vec![(n[1], n[2]), (n[0], n[2])],
                    vars: &["be", "ce"],
                    outs: vec![
                        NlOut {
                            a: n[0],
                            b: n[2],
                            label: "C",
                            jet: cc.scale(ty),
                            free: cc_free.scale(ty),
                        },
                        NlOut {
                            a: n[1],
                            b: n[2],
                            label: "B",
                            jet: cb.scale(ty),
                            free: cb_free.scale(ty),
                        },
                    ],
                    boundary: [ty * q.vbe, vbc].iter().any(|&v| near(v, -3.0 * vt(), v.abs())),
                }
            }
            (Kind::D { model, area }, Some(DevOp::Diode(d))) => {
                let v = Jet::var(d.vd, 0, 1.0);
                let id = pn_jet(model.is * area, v, model.n * vt()).add(&v.scale(net.gmin));
                NlDev {
                    element: e.name.clone(),
                    controls: vec![(n[0], n[1])],
                    vars: &[""],
                    outs: vec![NlOut {
                        a: n[0],
                        b: n[1],
                        label: "",
                        jet: id,
                        free: id,
                    }],
                    boundary: near(d.vd, -3.0 * model.n * vt(), d.vd.abs()),
                }
            }
            _ => {
                return Err(format!(
                    "'{}' cannot be nonlinear: only MOSFETs, BJTs and diodes can",
                    e.name
                ))
            }
        };
        out.push(dev);
    }
    Ok(out)
}

/// One Taylor coefficient of one device current.
#[derive(Clone, Debug)]
pub struct Coef {
    pub dev: usize,
    pub out: usize,
    pub mono: [u8; 3],
    pub value: f64,
    /// The value without junction leakage (`NlOut::free`).
    pub free: f64,
}

impl Coef {
    pub fn order(&self) -> u8 {
        deg(&self.mono)
    }
}

/// Every coefficient of order 2..=order in the variables each device has.
pub fn coefficients(devs: &[NlDev], order: u8) -> Vec<Coef> {
    let mut out = Vec::new();
    for (di, d) in devs.iter().enumerate() {
        for (oi, o) in d.outs.iter().enumerate() {
            for (k, m) in MONOS.iter().enumerate() {
                let used = m.iter().enumerate().all(|(v, &x)| x == 0 || v < d.controls.len());
                if (2..=order).contains(&deg(m)) && used {
                    out.push(Coef {
                        dev: di,
                        out: oi,
                        mono: *m,
                        value: o.jet.0[k],
                        free: o.free.0[k],
                    });
                }
            }
        }
    }
    out
}

/// "2g", "gd", "g2d", "gdb" (plain) and the LaTeX subscript.
fn mono_sub(m: &[u8; 3], vars: &[&str]) -> (String, String) {
    let mut plain = String::new();
    let mut tex: Vec<String> = Vec::new();
    for (v, &x) in m.iter().enumerate() {
        if x == 0 {
            continue;
        }
        let k = if x > 1 { x.to_string() } else { String::new() };
        plain.push_str(&format!("{k}{}", vars[v]));
        tex.push(format!("{k}{}", vars[v]));
    }
    (plain, tex.join("\\,"))
}

// --- numeric Volterra ---------------------------------------------------------

/// A factorization of A whose solves are refined against the stamps
/// themselves: the residual b − A·x is summed over every stamp term
/// (each conductance, gain, s·C… alone, not their rounded sum per entry)
/// with error-free products and sums, so x solves the circuit whose
/// elements are each rounded once, not a matrix whose entries add a tiny
/// conductance to a large one and lose most of it (a node held only by a
/// gmin-sized junction next to a 640 Ω resistor: the f64 entry keeps 6 of
/// its digits). The refinement converges while κ·eps < 1.
/// Relative error of an LU solve (normwise) above which it is refined.
const REFINE_REL: f64 = 1e-12;

struct Refined {
    /// Per row: (column, value) of each stamp term.
    rows: Vec<Vec<(usize, Complex64)>>,
    lu: LuComplex,
}

impl Refined {
    /// A·x = b. When the LU solution is off by more than REFINE_REL of its
    /// size (normwise; the check compares to 1e-8), it is refined while
    /// each step shrinks the residual (at most 3 steps). Otherwise the LU
    /// solution stands, with its exact structural zeros (a refined pair of
    /// equal node voltages can differ by an ulp, which would make an
    /// exactly-zero a_n numerically nonzero).
    fn solve(&self, b: &[Complex64]) -> Vec<Complex64> {
        let n = b.len();
        let norm = |v: &[Complex64]| v.iter().map(|z| z.norm()).fold(0.0, f64::max);
        let res = |x: &[Complex64]| -> (Vec<Complex64>, f64) {
            let r: Vec<Complex64> = (0..n).map(|i| residual(&self.rows[i], x, b[i])).collect();
            let size = norm(&r);
            (r, size)
        };
        let mut x = self.lu.solve(b);
        let (mut r, mut size) = res(&x);
        for step in 0..3 {
            // Zero, or NaN (an unsolved order): nothing to refine.
            if size.is_nan() || size == 0.0 {
                break;
            }
            let dx = self.lu.solve(&r);
            let small = norm(&dx) <= REFINE_REL * norm(&x);
            if step == 0 && (small || dx.iter().any(|z| z.re.is_nan())) {
                break;
            }
            let next: Vec<Complex64> = x.iter().zip(&dx).map(|(a, d)| a + d).collect();
            let (nr, nsize) = res(&next);
            if nsize.is_nan() || nsize >= size {
                break;
            }
            (x, r, size) = (next, nr, nsize);
        }
        x
    }
}

/// bᵢ − Σ term·x_col, each part summed with error-free transformations
/// (Ogita–Rump–Oishi Dot2) and rounded once.
fn residual(row: &[(usize, Complex64)], x: &[Complex64], bi: Complex64) -> Complex64 {
    let dot2 = |init: f64, terms: &mut dyn Iterator<Item = (f64, f64)>| {
        let (mut s, mut c) = (init, 0.0f64);
        for (u, v) in terms {
            let p = u * v;
            let pe = u.mul_add(v, -p);
            let t = s + p;
            let bb = t - s;
            let se = (s - (t - bb)) + (p - bb);
            s = t;
            c += se + pe;
        }
        s + c
    };
    let re = dot2(
        bi.re,
        &mut row.iter().flat_map(|&(c, a)| [(-a.re, x[c].re), (a.im, x[c].im)]),
    );
    let im = dot2(
        bi.im,
        &mut row.iter().flat_map(|&(c, a)| [(-a.re, x[c].im), (-a.im, x[c].re)]),
    );
    Complex64::new(re, im)
}

/// Output and input scale of the analysis (the gain system's excitation).
pub struct Probe<'a> {
    pub sys: &'a System,
    pub ss: &'a SsCircuit,
    pub out: usize,
    pub rf: usize,
    /// v_in per unit of drive (2 for a differential pair driven ±1).
    pub vid: f64,
}

fn pow_mono(u: &[Complex64], m: &[u8; 3]) -> Complex64 {
    let mut p = Complex64::new(1.0, 0.0);
    for (v, &x) in m.iter().enumerate() {
        for _ in 0..x {
            p *= u[v];
        }
    }
    p
}

/// d(u^m) along (u1, u2) for |m| = 2: the order-3 part of (u1 + u2)^m.
fn bilinear(u1: &[Complex64], u2: &[Complex64], m: &[u8; 3]) -> Complex64 {
    let idx: Vec<usize> = (0..3).flat_map(|v| std::iter::repeat_n(v, m[v] as usize)).collect();
    let (i, j) = (idx[0], idx[1]);
    u1[i] * u2[j] + u2[i] * u1[j]
}

impl Probe<'_> {
    fn lu(&self, s: Complex64) -> Option<Refined> {
        #[cfg(test)]
        tests::FACTORED.with(|v| v.borrow_mut().push(s.im));
        let lu = LuComplex::factor(self.sys.dim, matrix_at(self.sys, self.ss, s))?;
        // Each entry's terms (one per stamp monomial) evaluated alone.
        let n = self.sys.dim;
        let rows = (0..n)
            .map(|r| {
                let mut t = Vec::new();
                for c in 0..n {
                    for (&m, &k) in &self.sys.a[r][c].terms {
                        let mut v = k as f64;
                        let mut bits = m;
                        while bits != 0 {
                            v *= self.ss.params[bits.trailing_zeros() as usize].mna_value();
                            bits &= bits - 1;
                        }
                        t.push((c, v * s.powu((m & self.ss.reactive_mask).count_ones())));
                    }
                }
                t
            })
            .collect();
        Some(Refined { rows, lu })
    }

    fn node(&self, x: &[Complex64], n: usize) -> Complex64 {
        self.sys.node_col[n].map(|k| x[k]).unwrap_or_default()
    }

    fn inject(&self, rhs: &mut [Complex64], a: usize, b: usize, i: Complex64) {
        if let Some(k) = self.sys.node_col[a] {
            rhs[k] -= i;
        }
        if let Some(k) = self.sys.node_col[b] {
            rhs[k] += i;
        }
    }

    /// [a1, a2, a3] per input unit at frequency f (H1(jω), H2(jω,jω),
    /// H3(jω,jω,jω)), with each coefficient's value from `vals`; a3 only
    /// when `third` (NaN otherwise: the system at 3f is not solved).
    pub fn volterra(
        &self,
        devs: &[NlDev],
        coefs: &[Coef],
        vals: &[f64],
        f: f64,
        third: bool,
    ) -> Option<[Complex64; 3]> {
        let x = self.kernels(devs, coefs, vals, f, third)?;
        let k = self.vid;
        let out = |x: &[Complex64]| self.node(x, self.out) - self.node(x, self.rf);
        Some([out(&x[0]) / k, out(&x[1]) / (k * k), out(&x[2]) / (k * k * k)])
    }

    /// [H1, H2, H3] at f (as `volterra`) and `node_terms` of each.
    pub fn volterra_terms(
        &self,
        devs: &[NlDev],
        coefs: &[Coef],
        vals: &[f64],
        f: f64,
        third: bool,
    ) -> Option<([Complex64; 3], [f64; 3])> {
        let x = self.kernels(devs, coefs, vals, f, third)?;
        let k = self.vid;
        let out = |x: &[Complex64]| self.node(x, self.out) - self.node(x, self.rf);
        let h = [out(&x[0]) / k, out(&x[1]) / (k * k), out(&x[2]) / (k * k * k)];
        Some((h, self.node_terms(&x, f)))
    }

    /// The size of what each H_n's node responses are summed from, per
    /// input unit^n. A node voltage x_c is the sum its defining rows give:
    /// its KCL row (when A_cc != 0), x_c = (rhs_c − Σ_{k≠c} A_ck·x_k)/A_cc,
    /// and every constraint row with a coefficient on it (a voltage
    /// source, VCVS or inductor branch), x_c = (rhs_r − Σ_{k≠c} A_rk·x_k)/
    /// A_rc. Its size is the largest over those rows of (|rhs| + Σ_{k≠c}
    /// |A·x_k|)/|A_·c|, where in a constraint row each other node voltage
    /// counts with its own size (recursively, each node once), so a
    /// buffered notch is as large as the notch it buffers. It never rests
    /// on |x_c| alone: a notch (branch currents that cancel at a node, or
    /// node voltages that do through a buffer) leaves x_c a roundoff
    /// residual of this size.
    fn node_terms(&self, x: &[Vec<Complex64>; 3], f: f64) -> [f64; 3] {
        let dim = self.sys.dim;
        let mut is_node = vec![false; dim];
        for c in self.sys.node_col.iter().flatten() {
            is_node[*c] = true;
        }
        let mut terms = [0.0; 3];
        for n in 0..3 {
            if x[n].iter().any(|v| v.re.is_nan()) {
                terms[n] = f64::NAN;
                continue;
            }
            let a = matrix_at(self.sys, self.ss, jw(f * (n + 1) as f64));
            let mut memo: Vec<Option<f64>> = vec![None; dim];
            let mut busy = vec![false; dim];
            let mut sum = 0.0;
            for node in [self.out, self.rf] {
                if let Some(c) = self.sys.node_col[node] {
                    sum += node_size(&a, dim, &x[n], &is_node, c, &mut memo, &mut busy);
                }
            }
            terms[n] = sum / self.vid.abs().powi(n as i32 + 1);
        }
        terms
    }

    /// At f, the size of the terms each H_n (a_n at DC) is the sum of:
    /// `node_terms`, and each Taylor coefficient's part, Σ|K·∂H_n/∂K| (H_n
    /// is a polynomial of degree ≤ 2 in the K, so a central difference with
    /// any step is exact).
    /// H3's (NaN) only when `third`: an order-2 request solves at f, 2f.
    fn terms(&self, devs: &[NlDev], coefs: &[Coef], vals: &[f64], f: f64, third: bool) -> Option<[f64; 3]> {
        let x = self.kernels(devs, coefs, vals, f, third)?;
        let mut terms = self.node_terms(&x, f);
        let mut parts = [0.0; 3];
        for (i, &v) in vals.iter().enumerate() {
            if v == 0.0 {
                continue;
            }
            let at = |scale: f64| {
                let mut w = vals.to_vec();
                w[i] = v * scale;
                self.volterra(devs, coefs, &w, f, third)
            };
            let (up, down) = (at(1.5)?, at(0.5)?);
            for n in 0..3 {
                parts[n] += (up[n] - down[n]).norm();
            }
        }
        for n in 0..3 {
            terms[n] = terms[n].max(parts[n]);
        }
        Some(terms)
    }

    /// The order-1..3 solutions at f: x3 all NaN unless `third`, and x2
    /// (x3) all NaN when the system at 2f (3f) is singular, so each
    /// order fails alone. None only when the system at f is singular.
    fn kernels(
        &self,
        devs: &[NlDev],
        coefs: &[Coef],
        vals: &[f64],
        f: f64,
        third: bool,
    ) -> Option<[Vec<Complex64>; 3]> {
        let n = self.sys.dim;
        let b: Vec<Complex64> = self.sys.b.iter().map(|&v| Complex64::new(v as f64, 0.0)).collect();
        let lu1 = self.lu(jw(f))?;
        let x1 = lu1.solve(&b);
        let ctl = |x: &[Complex64]| -> Vec<Vec<Complex64>> {
            devs.iter()
                .map(|d| {
                    let mut u: Vec<Complex64> = d
                        .controls
                        .iter()
                        .map(|&(p, q)| self.node(x, p) - self.node(x, q))
                        .collect();
                    u.resize(3, Complex64::default());
                    u
                })
                .collect()
        };
        let u1 = ctl(&x1);
        let mut rhs2 = vec![Complex64::default(); n];
        for (c, &v) in coefs.iter().zip(vals) {
            if c.order() == 2 && v != 0.0 {
                let o = &devs[c.dev].outs[c.out];
                self.inject(&mut rhs2, o.a, o.b, v * pow_mono(&u1[c.dev], &c.mono));
            }
        }
        let nan = || vec![Complex64::new(f64::NAN, f64::NAN); n];
        let lu2 = if f == 0.0 { None } else { self.lu(jw(2.0 * f)) };
        if f != 0.0 && lu2.is_none() {
            return Some([x1, nan(), nan()]);
        }
        let x2 = lu2.as_ref().unwrap_or(&lu1).solve(&rhs2);
        if !third {
            return Some([x1, x2, nan()]);
        }
        let u2 = ctl(&x2);
        let mut rhs3 = vec![Complex64::default(); n];
        for (c, &v) in coefs.iter().zip(vals) {
            if v == 0.0 {
                continue;
            }
            let o = &devs[c.dev].outs[c.out];
            let i = match c.order() {
                2 => bilinear(&u1[c.dev], &u2[c.dev], &c.mono),
                3 => pow_mono(&u1[c.dev], &c.mono),
                _ => continue,
            };
            self.inject(&mut rhs3, o.a, o.b, v * i);
        }
        let lu3 = if f == 0.0 { None } else { self.lu(jw(3.0 * f)) };
        if f != 0.0 && lu3.is_none() {
            return Some([x1, x2, nan()]);
        }
        let x3 = lu3.as_ref().unwrap_or(&lu1).solve(&rhs3);
        Some([x1, x2, x3])
    }
}

/// `Probe::node_terms` for node column c of A·x = b (A dim × dim, row
/// major): the largest over its defining rows of the size of the sum that
/// row gives for x_c (see there), at least |x_c|.
fn node_size(
    a: &[Complex64],
    dim: usize,
    x: &[Complex64],
    is_node: &[bool],
    c: usize,
    memo: &mut Vec<Option<f64>>,
    busy: &mut Vec<bool>,
) -> f64 {
    if let Some(v) = memo[c] {
        return v;
    }
    busy[c] = true;
    let mut size = x[c].norm();
    for r in 0..dim {
        let arc = a[r * dim + c].norm();
        // Its KCL row, and the constraint rows on it (other nodes' KCL
        // rows only couple it).
        if arc == 0.0 || (r != c && is_node[r]) || (r == c && !is_node[c]) {
            continue;
        }
        let row = &a[r * dim..(r + 1) * dim];
        let rhs = (0..dim).map(|k| row[k] * x[k]).sum::<Complex64>().norm();
        let mut s = rhs;
        for k in (0..dim).filter(|&k| k != c && row[k].norm() != 0.0) {
            let xk = if r != c && is_node[k] && !busy[k] {
                node_size(a, dim, x, is_node, k, memo, busy)
            } else {
                x[k].norm()
            };
            s += row[k].norm() * xk;
        }
        size = size.max(s / arc);
    }
    busy[c] = false;
    memo[c] = Some(size);
    size
}

/// Coefficients that may be left out of the closed form: exact zeros, then
/// (smallest current first) every one whose omission moves no requested
/// a_n (n ≤ `order`) by more than `rel` relative (an a_n that is exactly 0
/// must stay exactly 0). a3 is NaN in the reference unless `order` is 3.
pub fn prove_omission(
    probe: &Probe,
    devs: &[NlDev],
    coefs: &[Coef],
    rel: f64,
    order: u8,
) -> Option<(Vec<bool>, f64, [Complex64; 3])> {
    let (third, requested) = (order >= 3, order as usize);
    let all: Vec<f64> = coefs.iter().map(|c| c.value).collect();
    let reference = probe.volterra(devs, coefs, &all, 0.0, third)?;
    let mut keep: Vec<bool> = all.iter().map(|&v| v != 0.0).collect();
    // Size of each coefficient's current at the order-1 solution.
    let lu = probe.lu(Complex64::new(0.0, 0.0))?;
    let b: Vec<Complex64> = probe.sys.b.iter().map(|&v| Complex64::new(v as f64, 0.0)).collect();
    let x1 = lu.solve(&b);
    let size = |c: &Coef| -> f64 {
        let d = &devs[c.dev];
        let mut u: Vec<Complex64> = d
            .controls
            .iter()
            .map(|&(p, q)| probe.node(&x1, p) - probe.node(&x1, q))
            .collect();
        u.resize(3, Complex64::default());
        (c.value * pow_mono(&u, &c.mono)).norm()
    };
    let mut order: Vec<usize> = (0..coefs.len()).filter(|&k| keep[k]).collect();
    order.sort_by(|&a, &b| size(&coefs[a]).total_cmp(&size(&coefs[b])));
    let mut worst = 0.0f64;
    for k in order {
        keep[k] = false;
        let vals: Vec<f64> = coefs
            .iter()
            .zip(&keep)
            .map(|(c, &kp)| if kp { c.value } else { 0.0 })
            .collect();
        let ok = probe.volterra(devs, coefs, &vals, 0.0, third).and_then(|got| {
            let mut w = 0.0f64;
            for n in 1..requested {
                let (r, g) = (reference[n], got[n]);
                if r == Complex64::default() {
                    if g != r {
                        return None;
                    }
                } else {
                    let d = (g - r).norm() / r.norm();
                    if d > rel {
                        return None;
                    }
                    w = w.max(d);
                }
            }
            Some(w)
        });
        match ok {
            Some(w) => worst = worst.max(w),
            None => keep[k] = true,
        }
    }
    Some((keep, worst, reference))
}

// --- closed form at s → 0 ---------------------------------------------------

/// a1, a2, a3 as exact rational functions over `syms` (the analysis
/// symbols plus one per kept Taylor coefficient):
/// a_n = num[n] / (vid^n · D^pow[n]), D = det(A) at s = 0.
pub struct Closed {
    pub syms: Vec<Sym>,
    pub d: XPoly,
    pub num: Vec<XPoly>,
    pub pow: Vec<u32>,
    pub vid: i128,
    /// The symbol of each Taylor coefficient (`coefs` order), None when
    /// left out.
    pub coef_sym: Vec<Option<usize>>,
    /// Term budget of every product (as `closed` was given).
    max_terms: usize,
    /// D^0, D^1, … as far as computed, and whether the next power is over
    /// budget.
    dpow: RefCell<(Vec<XPoly>, bool)>,
    a_memo: Vec<OnceCell<Option<Quantity>>>,
    ratio_memo: Vec<OnceCell<Option<Quantity>>>,
}

/// One rational quantity of a closed form, with its expressions (of
/// num/den and of den/num) once built.
pub struct Quantity {
    pub num: XPoly,
    pub den: XPoly,
    expr: OnceCell<Option<Expr>>,
    inv_expr: OnceCell<Option<Expr>>,
}

impl Quantity {
    fn new(num: XPoly, den: XPoly) -> Quantity {
        Quantity {
            num,
            den,
            expr: OnceCell::new(),
            inv_expr: OnceCell::new(),
        }
    }

    /// num/den (or den/num when `inverted`) over `syms`.
    fn view<'a>(&'a self, syms: &'a [Sym], inverted: bool) -> View<'a> {
        if inverted {
            View {
                num: &self.den,
                den: &self.num,
                syms,
                expr: &self.inv_expr,
            }
        } else {
            View {
                num: &self.num,
                den: &self.den,
                syms,
                expr: &self.expr,
            }
        }
    }
}

/// A quantity to show: num/den over `syms`, its expression built at most once.
#[derive(Clone, Copy)]
struct View<'a> {
    num: &'a XPoly,
    den: &'a XPoly,
    syms: &'a [Sym],
    expr: &'a OnceCell<Option<Expr>>,
}

impl<'a> View<'a> {
    fn expr(&self) -> Option<&'a Expr> {
        let (num, den, syms) = (self.num, self.den, self.syms);
        self.expr.get_or_init(|| expr(num, den, syms)).as_ref()
    }
}

impl Closed {
    fn new(syms: Vec<Sym>, d: XPoly, num: Vec<XPoly>, pow: Vec<u32>, vid: i128, max_terms: usize) -> Closed {
        let n = num.len();
        Closed {
            syms,
            d,
            num,
            pow,
            vid,
            coef_sym: Vec::new(),
            max_terms,
            dpow: RefCell::new((Vec::new(), false)),
            a_memo: (0..n).map(|_| OnceCell::new()).collect(),
            ratio_memo: (0..n).map(|_| OnceCell::new()).collect(),
        }
    }

    /// f(D^k), each power computed once.
    fn with_d_pow<T>(&self, k: u32, f: impl FnOnce(&XPoly) -> Result<T, String>) -> Result<T, String> {
        let mut memo = self.dpow.borrow_mut();
        let (pows, over) = &mut *memo;
        if pows.is_empty() {
            pows.push(XPoly::constant(1, self.syms.len()));
        }
        while pows.len() <= k as usize {
            if *over {
                return Err(format!("expression too large (over {} terms)", self.max_terms));
            }
            match pows[pows.len() - 1].mul(&self.d, self.max_terms) {
                Ok(p) => pows.push(p),
                Err(e) => {
                    *over = true;
                    return Err(e);
                }
            }
        }
        f(&pows[k as usize])
    }

    /// a_n as (numerator, denominator), n = 0 for a1.
    pub fn a(&self, n: usize) -> Option<&Quantity> {
        self.a_memo
            .get(n)?
            .get_or_init(|| {
                let k = self.vid.pow(n as u32 + 1);
                let den = self.with_d_pow(self.pow[n], |p| p.scaled(k)).ok()?;
                Some(Quantity::new(self.num[n].clone(), den))
            })
            .as_ref()
    }

    /// a_n / a1 without multiplying D back in: num[n]·vid^{1−n}... as
    /// (num[n], vid^n · D^{pow[n]−1} · num[0]).
    pub fn ratio(&self, n: usize) -> Option<&Quantity> {
        self.ratio_memo
            .get(n)?
            .get_or_init(|| {
                let k = self.vid.pow(n as u32);
                let den = self
                    .with_d_pow(self.pow[n] - 1, |p| p.mul(&self.num[0], self.max_terms))
                    .and_then(|p| p.scaled(k))
                    .ok()?;
                Some(Quantity::new(self.num[n].clone(), den))
            })
            .as_ref()
    }
}

fn at_dc(a: &[Vec<Poly>], reactive: u128) -> Vec<Vec<Poly>> {
    a.iter()
        .map(|row| {
            row.iter()
                .map(|p| {
                    let mut q = Poly::zero();
                    for (&m, &c) in &p.terms {
                        if m & reactive == 0 {
                            q.add_term(m, c);
                        }
                    }
                    q
                })
                .collect()
        })
        .collect()
}

/// Symbols for the kept coefficients (their `free` values on the
/// leakage-free model); matched devices' equal coefficients share one.
/// Returns the symbol index of each coefficient.
fn coef_symbols(
    devs: &[NlDev],
    coefs: &[Coef],
    keep: &[bool],
    free: bool,
    symbols: &Symbols,
    syms: &mut Vec<Sym>,
) -> Vec<Option<usize>> {
    // Two devices are matched when the symbol layer merged any of their
    // parameters into one symbol (whatever the device kind or region: a
    // MOSFET in cutoff keeps only its junctions' r_bs, r_bd).
    let matched = |a: &str, b: &str| {
        symbols
            .syms
            .iter()
            .any(|s| s.elements.len() > 1 && s.elements.iter().any(|e| e == a) && s.elements.iter().any(|e| e == b))
    };
    let nbase = syms.len();
    let mut idx = Vec::new();
    for (c, &k) in coefs.iter().zip(keep) {
        let value = if free { c.free } else { c.value };
        if !k || value == 0.0 {
            idx.push(None);
            continue;
        }
        let d = &devs[c.dev];
        let o = &d.outs[c.out];
        let (sub, tex) = mono_sub(&c.mono, d.vars);
        let name = format!("K{}{sub}_{}", o.label, d.element);
        let twin = (nbase..syms.len()).find(|&t| {
            let s = &syms[t];
            s.name.split('_').next() == name.split('_').next()
                && matched(&s.elements[0], &d.element)
                && (s.value - value).abs() <= MATCH_REL * s.value.abs().max(value.abs())
        });
        let latex_of = |els: &[String]| {
            let head = if o.label.is_empty() {
                "K".to_string()
            } else {
                format!("K^{{{}}}", o.label)
            };
            let sub = if tex.is_empty() {
                c.order().to_string()
            } else {
                tex.clone()
            };
            format!("{head}_{{{sub},{}}}", crate::ss::esc(&sym::merged_name(els)))
        };
        match twin {
            Some(t) => {
                syms[t].elements.push(d.element.clone());
                syms[t].latex = latex_of(&syms[t].elements);
                idx.push(Some(t));
            }
            None => {
                // Leakage: the junction-leakage current alone (a bulk
                // junction, or I_B's v_CE dependence through i_μ).
                let leakage = c.free == 0.0;
                // Output-conductance-like: any v_DS / v_CE derivative.
                let output = (c.mono[1] > 0 && d.vars.len() > 1) || leakage;
                syms.push(Sym {
                    name,
                    latex: latex_of(std::slice::from_ref(&d.element)),
                    value,
                    inverted: false,
                    reactive: false,
                    role: Role::Coeff,
                    unit: match c.order() {
                        2 => "A/V^2",
                        _ => "A/V^3",
                    },
                    elements: vec![d.element.clone()],
                    output_r: output,
                    leakage,
                });
                idx.push(Some(syms.len() - 1));
            }
        }
    }
    idx
}

/// Builds a1..a_order in closed form (with the leakage-free coefficients
/// when `free`). Err(reason) inside Ok when there is no DC limit.
#[allow(clippy::too_many_arguments)]
pub fn closed(
    ss: &SsCircuit,
    symbols: &Symbols,
    sys: &System,
    devs: &[NlDev],
    coefs: &[Coef],
    keep: &[bool],
    free: bool,
    out: usize,
    rf: usize,
    vid: i128,
    order: u8,
    max_terms: usize,
) -> Result<Result<Closed, String>, String> {
    let a0 = at_dc(&sys.a, ss.reactive_mask);
    let det = |a: &[Vec<Poly>]| crate::det::det(a, max_terms);
    let d = det(&a0)?;
    if d.is_zero() {
        return Ok(Err(
            "the circuit has no DC solution path (singular at s = 0)".to_string()
        ));
    }
    let mut syms = symbols.syms.clone();
    let cidx = coef_symbols(devs, coefs, keep, free, symbols, &mut syms);
    let nsym = syms.len();
    let nbase = symbols.syms.len();
    let x = |p: &Poly| -> Result<XPoly, String> { Ok(XPoly::from_poly(p, &symbols.class, nbase)?.padded(nsym)) };
    // det(A0) with column `col` replaced by `b`.
    let with_col = |col: usize, b: &[i128]| -> Result<Poly, String> {
        let mut a = a0.clone();
        for (r, row) in a.iter_mut().enumerate() {
            row[col] = Poly::constant(b[r]);
        }
        det(&a)
    };
    // Voltage of node n for a right-hand side: numerator over D.
    let mut memo: HashMap<(usize, usize), XPoly> = HashMap::new();
    let mut unit = |n: usize, k: usize| -> Result<XPoly, String> {
        // Node n's voltage for 1 A into node k (both nodes; ground → 0).
        if let Some(p) = memo.get(&(n, k)) {
            return Ok(p.clone());
        }
        let p = match (sys.node_col[n], sys.node_col[k]) {
            (Some(cn), Some(ck)) => {
                let mut b = vec![0i128; sys.dim];
                b[ck] = 1;
                x(&with_col(cn, &b)?)?
            }
            _ => XPoly::default(),
        };
        memo.insert((n, k), p.clone());
        Ok(p)
    };
    let dx = x(&d)?;
    let n1 = |n: usize| -> Result<XPoly, String> {
        match sys.node_col[n] {
            Some(c) => x(&with_col(c, &sys.b)?),
            None => Ok(XPoly::default()),
        }
    };
    let mt = max_terms;
    // Every stored polynomial within the budget: products check it
    // themselves, sums and differences (up to twice their operands' terms)
    // here, so an over-budget form fails exactly as a large product does.
    let fit = |p: XPoly| -> Result<XPoly, String> {
        if p.terms.len() > mt {
            Err(format!("expression too large (over {mt} terms)"))
        } else {
            Ok(p)
        }
    };
    let mul = |a: &XPoly, b: &XPoly| a.mul(b, mt);
    let sub = |a: &XPoly, b: &XPoly| fit(a.sub(b)?);
    let na = fit(n1(out)?.sub_owned(n1(rf)?)?)?;
    let mut num = vec![na];
    let mut powers = vec![1];
    // Each higher order needs the lower ones' parts, and the budget holds
    // per quantity: the first order over it (or failing otherwise) ends the
    // build there, keeping the orders below it.
    let mut higher = || -> Result<(), String> {
        if order < 2 {
            return Ok(());
        }
        // Order-1 control voltages (numerators over D).
        let mut u1: Vec<Vec<XPoly>> = Vec::new();
        for dv in devs {
            let mut u = Vec::new();
            for &(p, q) in &dv.controls {
                u.push(fit(n1(p)?.sub_owned(n1(q)?)?)?);
            }
            u.resize(3, XPoly::default());
            u1.push(u);
        }
        let kvar = |k: usize| XPoly::var(cidx[k].expect("kept"), nsym);
        let pow = |u: &[XPoly], m: &[u8; 3]| -> Result<XPoly, String> {
            let mut p = XPoly::constant(1, nsym);
            for (v, &e) in m.iter().enumerate() {
                for _ in 0..e {
                    p = mul(&p, &u[v])?;
                }
            }
            Ok(p)
        };
        // Order-2 currents per device output (numerators over D²).
        let mut i2: HashMap<(usize, usize), XPoly> = HashMap::new();
        for (k, c) in coefs.iter().enumerate() {
            if cidx[k].is_some() && c.order() == 2 {
                let t = mul(&kvar(k), &pow(&u1[c.dev], &c.mono)?)?;
                let e = i2.entry((c.dev, c.out)).or_default();
                *e = fit(std::mem::take(e).add_owned(t)?)?;
            }
        }
        // Response of node n to the order-2 currents: numerator over D³.
        let mut respond = |n: usize, cur: &HashMap<(usize, usize), XPoly>| -> Result<XPoly, String> {
            let mut acc = XPoly::default();
            for (&(dv, o), i) in cur {
                let ot = &devs[dv].outs[o];
                // The current leaves node a and enters node b.
                let t = fit(unit(n, ot.b)?.sub_owned(unit(n, ot.a)?)?)?;
                acc = fit(acc.add_owned(mul(&t, i)?)?)?;
            }
            Ok(acc)
        };
        // Each node's response to the order-2 currents, computed once.
        let mut r2: HashMap<usize, XPoly> = HashMap::new();
        for n in [out, rf] {
            if let Entry::Vacant(v) = r2.entry(n) {
                v.insert(respond(n, &i2)?);
            }
        }
        num.push(sub(&r2[&out], &r2[&rf])?);
        powers.push(3);
        if order >= 3 {
            let controls: Vec<usize> = devs
                .iter()
                .flat_map(|dv| dv.controls.iter().flat_map(|&(p, q)| [p, q]))
                .collect();
            for n in controls {
                if let Entry::Vacant(v) = r2.entry(n) {
                    v.insert(respond(n, &i2)?);
                }
            }
            // Order-2 control voltages (over D³).
            let mut u2: Vec<Vec<XPoly>> = Vec::new();
            for dv in devs {
                let mut u = Vec::new();
                for &(p, q) in &dv.controls {
                    u.push(sub(&r2[&p], &r2[&q])?);
                }
                u.resize(3, XPoly::default());
                u2.push(u);
            }
            // Order-3 currents (over D⁴): K₃·u₁³·D + K₂·(u₁u₂ + u₂u₁). A BJT's
            // two currents share each monomial's product.
            let mut prods: HashMap<(usize, [u8; 3]), XPoly> = HashMap::new();
            let mut i3: HashMap<(usize, usize), XPoly> = HashMap::new();
            for (k, c) in coefs.iter().enumerate() {
                if cidx[k].is_none() || !(2..=3).contains(&c.order()) {
                    continue;
                }
                if let Entry::Vacant(v) = prods.entry((c.dev, c.mono)) {
                    let t = match c.order() {
                        3 => mul(&pow(&u1[c.dev], &c.mono)?, &dx)?,
                        _ => {
                            let ix: Vec<usize> = (0..3)
                                .flat_map(|v| std::iter::repeat_n(v, c.mono[v] as usize))
                                .collect();
                            let (i, j) = (ix[0], ix[1]);
                            fit(mul(&u1[c.dev][i], &u2[c.dev][j])?.add_owned(mul(&u2[c.dev][i], &u1[c.dev][j])?)?)?
                        }
                    };
                    v.insert(t);
                }
                let t = mul(&kvar(k), &prods[&(c.dev, c.mono)])?;
                let e = i3.entry((c.dev, c.out)).or_default();
                *e = fit(std::mem::take(e).add_owned(t)?)?;
            }
            num.push(fit(respond(out, &i3)?.sub_owned(respond(rf, &i3)?)?)?);
            powers.push(5);
        }
        Ok(())
    };
    let _ = higher();
    let mut cl = Closed::new(syms, dx, num, powers, vid, max_terms);
    cl.coef_sym = cidx;
    Ok(Ok(cl))
}

// --- report -------------------------------------------------------------------

/// g_mb of every forward-body-biased MOSFET as the slope of its DC current,
/// where that differs from ngspice's (parameter name, value).
fn body_slopes(net: &Netlist, op: &Op) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    for (ei, e) in net.elements.iter().enumerate() {
        if let (Kind::M { model, .. }, Some(DevOp::Mos(m))) = (&e.kind, &op.dev[ei]) {
            let vbs = m.ty * if m.reversed { m.vbs - m.vds } else { m.vbs };
            match mos_gmbs_dc(model, m.gm, vbs) {
                Some(g) if g != m.gmb => out.push((format!("gmb_{}", e.name), g)),
                _ => {}
            }
        }
    }
    out
}

/// A copy of `m` with these parameter values.
fn with_values(m: &SsCircuit, values: &[(String, f64)]) -> SsCircuit {
    let mut m = m.clone();
    for p in &mut m.params {
        if let Some((_, v)) = values.iter().find(|(n, _)| *n == p.name) {
            p.value = *v;
        }
    }
    m
}

/// `s` (symbols of `m`, whose parameters already carry these values) with
/// the symbols of these parameters at their values. Matched members whose
/// new values differ by more than MATCH_REL no longer match: their class
/// is split into one symbol per member. Otherwise their difference joins
/// `mismatch`. Returns the symbols and the elements of each split class.
fn sym_values(m: &SsCircuit, s: &Symbols, values: &[(String, f64)]) -> (Symbols, Vec<Vec<String>>) {
    let mut s = s.clone();
    let mut touched: Vec<usize> = Vec::new();
    for (i, p) in m.params.iter().enumerate() {
        if values.iter().any(|(n, _)| *n == p.name) && !touched.contains(&s.class[i]) {
            touched.push(s.class[i]);
        }
    }
    let mut split = Vec::new();
    for k in touched {
        let members: Vec<usize> = (0..m.params.len()).filter(|&i| s.class[i] == k).collect();
        // The symbol carries its first member's value (and name).
        let first = members
            .iter()
            .copied()
            .find(|&i| m.params[i].name == s.syms[k].name)
            .unwrap_or(members[0]);
        let v0 = m.params[first].value;
        let rel = members
            .iter()
            .map(|&i| {
                let v = m.params[i].value;
                if v == v0 {
                    0.0
                } else {
                    (v - v0).abs() / v.abs().max(v0.abs())
                }
            })
            .fold(0.0, f64::max);
        s.syms[k].value = v0;
        if rel <= MATCH_REL {
            s.mismatch = s.mismatch.max(rel);
            continue;
        }
        split.push(members.iter().map(|&i| m.params[i].element.clone()).collect());
        let base = s.syms[k].clone();
        for &i in &members {
            let p = &m.params[i];
            let own = Sym {
                name: p.name.clone(),
                latex: p.latex.clone(),
                value: p.value,
                elements: vec![p.element.clone()],
                ..base.clone()
            };
            if i == first {
                s.syms[k] = own;
            } else {
                s.class[i] = s.syms.len();
                s.syms.push(own);
            }
        }
    }
    (s, split)
}

pub struct Ctx<'a> {
    pub net: &'a Netlist,
    pub op: Option<&'a Op>,
    pub full: &'a SsCircuit,
    pub ss: &'a SsCircuit,
    pub symbols: &'a Symbols,
    pub full_symbols: &'a dyn Fn() -> Symbols,
    /// Symbols of a model (the leakage-free one).
    pub noleak_symbols: &'a dyn Fn(&SsCircuit) -> Symbols,
    pub excite: &'a crate::ss::Excite,
    pub out: usize,
    pub rf: usize,
    pub vid: i128,
    pub input_is_v: bool,
    pub freqs: &'a [f64],
    pub names: &'a [String],
    pub order: u8,
    pub amplitude: f64,
    pub tol: f64,
    pub max_terms: usize,
}

/// The closed form against the numeric reference: `ok`, the worst relative
/// difference, the worst part of it the match mismatch does not explain,
/// the largest relative effect of that mismatch, and the orders checked.
struct Check {
    ok: bool,
    worst: f64,
    unexplained: f64,
    match_bound: f64,
    orders: Vec<usize>,
}

/// Largest relative change of a1..a3 that leaving out Taylor coefficients
/// may cause.
const OMIT_REL: f64 = 1e-9;

/// Picks one rational quantity out of a closed form.
type Getter<'a> = &'a dyn Fn(&Closed) -> Option<&Quantity>;

/// The quantity `f` picks out of `cl` (den/num when `inverted`), if built.
fn pick<'a>(cl: &'a Option<Closed>, f: Getter, inverted: bool) -> Option<View<'a>> {
    cl.as_ref().and_then(|cl| f(cl).map(|q| q.view(&cl.syms, inverted)))
}

fn num_or_null(v: f64) -> Value {
    if v.is_finite() {
        json!(v)
    } else {
        Value::Null
    }
}

/// Largest term count of any closed-form polynomial the analysis builds;
/// beyond it the exact form is skipped (the leakage-free display form is
/// built instead).
const DIST_TERM_LIMIT: usize = 100_000;

/// Plain text (for checking tools, not display) up to this many terms.
pub(crate) const PLAIN_TERM_LIMIT: usize = 20_000;

/// num/den cancelled, as an expression; None when num is zero.
fn expr(num: &XPoly, den: &XPoly, syms: &[Sym]) -> Option<Expr> {
    if num.is_zero() {
        return None;
    }
    let (n, d) = cancel(num, den);
    Some(Expr::from_mna(&n, &d, syms))
}

fn value(e: Option<&Expr>) -> f64 {
    e.map(|e| e.eval(Complex64::new(0.0, 0.0)).re).unwrap_or(0.0)
}

fn lead(num: &XPoly, den: &XPoly, syms: &[Sym]) -> (XPoly, XPoly) {
    (sym::leading_order(num, syms), sym::leading_order(den, syms))
}

fn leaky(e: &[u8], syms: &[Sym]) -> bool {
    e.iter().zip(syms).any(|(&x, s)| s.leakage && x > 0)
}

/// num/den without junction-leakage terms (r_bs, r_bd, r_μ → ∞).
fn drop_leak(num: &XPoly, den: &XPoly, syms: &[Sym]) -> (XPoly, XPoly) {
    let f = |q: &XPoly| XPoly {
        terms: q.terms.iter().filter(|(e, _)| !leaky(e, syms)).cloned().collect(),
    };
    (f(num), f(den))
}

fn has_leak(num: &XPoly, den: &XPoly, syms: &[Sym]) -> bool {
    num.terms.iter().chain(&den.terms).any(|(e, _)| leaky(e, syms))
}

/// How a quantity is shown: a LaTeX wrapper (e.g. `\frac{A}{2}\left|…\right|`)
/// and a value map (e.g. x ↦ |x|·A/2).
struct Shape<'a> {
    wrap: &'a dyn Fn(&str) -> String,
    map: &'a dyn Fn(f64) -> f64,
}

/// JSON of one form: latex and plain text only when small enough to read.
fn form(e: Option<&Expr>, syms: &[Sym], shape: &Shape) -> Value {
    let terms = e.map(|e| e.term_count()).unwrap_or(0);
    let (latex, plain) = match e {
        None => (json!("0"), json!({ "num": "0", "den": "1" })),
        Some(e) => {
            let latex = if terms <= crate::analyze::LATEX_TERM_LIMIT {
                json!((shape.wrap)(&e.latex(syms)))
            } else {
                Value::Null
            };
            let plain = if terms <= PLAIN_TERM_LIMIT {
                let (n, d) = e.plain(syms);
                json!({ "num": n, "den": d })
            } else {
                Value::Null
            };
            (latex, plain)
        }
    };
    json!({ "latex": latex, "plain": plain, "terms": terms, "value": num_or_null((shape.map)(value(e))) })
}

/// Relative size below which an a_n (H_n) is 0 to roundoff: of the size
/// of the terms it is the sum of (`Probe::terms`).
const ZERO_REL: f64 = 1e-12;

/// An infinite quantity (HD with a1 = 0, IIP3 with a3 = 0): latex
/// `\infty`, value null, and so its display and simplified forms.
fn infinite() -> Value {
    let f = json!({ "latex": "\\infty", "value": null });
    json!({ "latex": "\\infty", "value": null, "display": f, "simplified": f })
}

/// A quantity's forms: exact (on `exact`, when it could be built),
/// display (junction leakage dropped when that moves the value by at most
/// LEAKAGE_REL; from `noleak`, a closed form on the leakage-free model, when
/// the exact one is too large), and simplified (the r_o → ∞ leading order
/// of the display form, then the coarsest magnitude pruning, within `tol`
/// of the reference value).
fn quantity(exact: Option<View>, noleak: Option<View>, reference: f64, shape: &Shape, tol: f64) -> Value {
    // 0/0 (a ratio over a1 when a1 = 0, e.g. an input blocked at s → 0):
    // undefined, not the zero its numerator alone would give.
    let undefined = |v: Option<View>| v.is_some_and(|v| v.num.is_zero() && v.den.is_zero());
    if reference.is_nan() || undefined(exact) || (exact.is_none() && undefined(noleak)) {
        return Value::Null;
    }
    // x/0 (a ratio over a1 = 0 with a nonzero numerator): infinite.
    let over_zero = |v: Option<View>| v.is_some_and(|v| !v.num.is_zero() && v.den.is_zero());
    if reference.is_infinite() || over_zero(exact) || (exact.is_none() && over_zero(noleak)) {
        return infinite();
    }
    let rel = |a: f64| {
        if reference != 0.0 {
            (a - reference).abs() / reference.abs()
        } else {
            a.abs()
        }
    };
    let mut q = match exact {
        Some(v) => form(v.expr(), v.syms, shape),
        None => json!({ "latex": null, "plain": null, "terms": null, "value": num_or_null(reference),
                        "skipped": "too large for the exact closed form" }),
    };
    // Display candidate: num, den, syms, same-as-exact, and its expression
    // (built only for a candidate that is kept: zero, or a nonzero den).
    type Display<'a> = (Cow<'a, XPoly>, Cow<'a, XPoly>, &'a [Sym], bool, Option<Cow<'a, Expr>>);
    let keep = |n: &XPoly, d: &XPoly| n.is_zero() || !d.is_zero();
    let display: Option<Display> = match (exact, noleak) {
        (Some(v), _) if !has_leak(v.num, v.den, v.syms) => {
            let e = v.expr().map(Cow::Borrowed);
            Some((Cow::Borrowed(v.num), Cow::Borrowed(v.den), v.syms, true, e))
        }
        // Without leakage the denominator can vanish (a node held only by a
        // junction): there is no leakage-free form then, and leakage matters.
        (Some(v), _) => {
            let (n, d) = drop_leak(v.num, v.den, v.syms);
            let e = if keep(&n, &d) {
                expr(&n, &d, v.syms).map(Cow::Owned)
            } else {
                None
            };
            Some((Cow::Owned(n), Cow::Owned(d), v.syms, false, e))
        }
        (None, Some(v)) => keep(v.num, v.den).then(|| {
            let e = v.expr().map(Cow::Borrowed);
            (Cow::Borrowed(v.num), Cow::Borrowed(v.den), v.syms, false, e)
        }),
        (None, None) => None,
    };
    // Base of the simplified form: expression, symbols, num, den.
    type Base<'a> = (Cow<'a, Expr>, &'a [Sym], Cow<'a, XPoly>, Cow<'a, XPoly>);
    let mut base: Option<Base> = None;
    match display {
        Some((n, d, syms, same, e)) => {
            let err = if d.is_zero() && !n.is_zero() {
                f64::INFINITY
            } else {
                rel((shape.map)(value(e.as_deref())))
            };
            if same || err <= crate::analyze::LEAKAGE_REL {
                let mut df = form(e.as_deref(), syms, shape);
                df["same"] = json!(same);
                df["relError"] = num_or_null(err);
                q["display"] = df;
                if let Some(e) = e {
                    base = Some((e, syms, n, d));
                }
            } else {
                q["display"] = q.clone();
                q["display"]["same"] = json!(true);
                q["display"]["leakageMatters"] = json!(true);
                // Simplify the exact form: the leakage-free one is wrong here.
                if let Some(v) = exact {
                    if let Some(e) = v.expr() {
                        base = Some((Cow::Borrowed(e), v.syms, Cow::Borrowed(v.num), Cow::Borrowed(v.den)));
                    }
                }
            }
        }
        None => q["display"] = Value::Null,
    }
    let Some((be, syms, bn, bd)) = base else {
        q["simplified"] = q["display"].clone();
        return q;
    };
    // Simplified: leading order, then pruning, coarsest within tol.
    let l = lead(&bn, &bd, syms);
    let le = expr(&l.0, &l.1, syms).map(|e| {
        let v = value(Some(&e));
        (e, v)
    });
    let start: &Expr = match &le {
        Some((e, v)) if rel((shape.map)(*v)) <= tol => e,
        _ => &be,
    };
    let mut pruned: Option<(Expr, f64)> = None;
    for eps in [0.5, 0.3, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001] {
        let p = start.prune(eps, syms);
        if p.term_count() < start.term_count() {
            let v = value(Some(&p));
            if rel((shape.map)(v)) <= tol {
                pruned = Some((p, v));
                break;
            }
        }
    }
    let cands = le
        .map(|(e, v)| (e, v, "leading order (ro ≫ R, 1/gm)"))
        .into_iter()
        .chain(pruned.map(|(e, v)| (e, v, "leading order, small terms dropped")));
    let best = cands
        .filter(|(_, v, _)| rel((shape.map)(*v)) <= tol)
        .min_by_key(|(e, _, _)| e.term_count());
    let (e, v, method) = match best {
        Some((e, v, m)) => (Cow::Owned(e), v, m),
        None => {
            let v = value(Some(&be));
            (be, v, "display form")
        }
    };
    let mut sform = form(Some(&e), syms, shape);
    sform["relError"] = num_or_null(rel((shape.map)(v)));
    sform["method"] = json!(method);
    sform["tolerance"] = json!(tol);
    q["simplified"] = sform;
    q
}

pub fn report(c: &Ctx, warnings: &mut Vec<String>) -> Result<Value, String> {
    if !(2..=3).contains(&c.order) {
        return Err(format!("order must be 2 or 3 (got {})", c.order));
    }
    if !(c.amplitude > 0.0 && c.amplitude.is_finite()) {
        return Err("amplitude must be positive".to_string());
    }
    let Some(op) = c.op else {
        return Err("distortion needs an operating point (give every element a value)".to_string());
    };
    let devs = devices(c.net, op, c.names)?;
    if devs.is_empty() {
        return Err("nonlinear: name at least one device".to_string());
    }
    for d in devs.iter().filter(|d| d.boundary) {
        warnings.push(format!(
            "{} sits on a region boundary. Its distortion is not a Taylor series.",
            d.element
        ));
    }
    // The linear part must be the derivative of the expanded DC currents:
    // forward-body-biased MOSFETs get their DC-slope g_mb.
    let slopes = body_slopes(c.net, op);
    for (p, _) in slopes
        .iter()
        .filter(|(p, _)| c.full.params.iter().any(|q| q.name == *p))
    {
        let el = p.trim_start_matches("gmb_");
        warnings.push(format!(
            "{el} has forward body bias. Distortion uses the DC slope for its gmb, not ngspice's AC value."
        ));
    }
    let (full_owned, ss_owned, symbols_owned);
    let (full, ss, symbols) = if slopes.is_empty() {
        (c.full, c.ss, c.symbols)
    } else {
        full_owned = with_values(c.full, &slopes);
        ss_owned = with_values(c.ss, &slopes);
        let split;
        (symbols_owned, split) = sym_values(&ss_owned, c.symbols, &slopes);
        for els in split {
            warnings.push(format!(
                "{} have different gmb slopes under forward body bias: their gmb is not matched.",
                els.join(", ")
            ));
        }
        (&full_owned, &ss_owned, &symbols_owned)
    };
    let coefs = coefficients(&devs, c.order);
    let fsys = crate::ss::system(c.net, full, c.excite);
    let probe = Probe {
        sys: &fsys,
        ss: full,
        out: c.out,
        rf: c.rf,
        vid: c.vid as f64,
    };
    let (keep, omit_err, reference) =
        prove_omission(&probe, &devs, &coefs, OMIT_REL, c.order).ok_or("distortion: the circuit is singular at DC")?;
    let a_num: Vec<f64> = reference.iter().map(|z| z.re).collect();

    // Device Taylor coefficients (exact zeros left out).
    let taylor: Vec<Value> = coefs
        .iter()
        .zip(&keep)
        .filter(|(cf, _)| cf.value != 0.0)
        .map(|(cf, &k)| {
            let d = &devs[cf.dev];
            let o = &d.outs[cf.out];
            let (sub, _) = mono_sub(&cf.mono, d.vars);
            json!({
                "element": d.element, "current": if o.label.is_empty() { "D" } else { o.label },
                "monomial": sub, "order": cf.order(), "value": cf.value, "kept": k,
            })
        })
        .collect();

    let mt = c.max_terms.min(DIST_TERM_LIMIT);
    let build = |ss: &SsCircuit, symbols: &Symbols, free: bool| -> Option<Closed> {
        let sys = crate::ss::system(c.net, ss, c.excite);
        match closed(
            ss, symbols, &sys, &devs, &coefs, &keep, free, c.out, c.rf, c.vid, c.order, mt,
        ) {
            Ok(Ok(cl)) => Some(cl),
            _ => None,
        }
    };
    let all: Vec<f64> = coefs.iter().map(|cf| cf.value).collect();
    // Explicitly matched devices: each merged symbol (linear parameter or
    // Taylor coefficient) takes its first member's value, and the members
    // agree to within `mismatch`. To first order that moves a_n by at most
    // mismatch·Σ|p·∂a_n/∂p| over the merged values p (numerically, on the
    // full model); where the merged form cancels to exactly 0 this is the
    // residual the numeric a_n keeps. Absolute, per a_n.
    let merge_effect = |cl: &Closed, model: &SsCircuit, msyms: &Symbols| -> [f64; 3] {
        let mut members = vec![0usize; msyms.syms.len()];
        for &k in &msyms.class {
            members[k] += 1;
        }
        let params: Vec<&str> = model
            .params
            .iter()
            .zip(&msyms.class)
            .filter(|(_, &k)| members[k] > 1)
            .map(|(p, _)| p.name.as_str())
            .collect();
        let mut kmembers = vec![0usize; cl.syms.len()];
        for k in cl.coef_sym.iter().flatten() {
            kmembers[*k] += 1;
        }
        let mut mismatch = msyms.mismatch;
        let mut kmerged = Vec::new();
        for (i, (cf, k)) in coefs.iter().zip(&cl.coef_sym).enumerate() {
            if let Some(k) = *k {
                if kmembers[k] > 1 {
                    let t = cl.syms[k].value;
                    if t != cf.value {
                        mismatch = mismatch.max((t - cf.value).abs() / t.abs().max(cf.value.abs()));
                    }
                    kmerged.push(i);
                }
            }
        }
        let mut sens = [0.0f64; 3];
        if mismatch == 0.0 {
            return sens;
        }
        let h = 1e-6;
        let mut add = |up: Option<[Complex64; 3]>, down: Option<[Complex64; 3]>| {
            if let (Some(u), Some(d)) = (up, down) {
                for n in 0..3 {
                    sens[n] += (u[n] - d[n]).norm() / (2.0 * h);
                }
            }
        };
        for name in params {
            let Some(j) = full.params.iter().position(|p| p.name == name) else {
                continue;
            };
            let at = |f: f64| {
                let mut m = full.clone();
                m.params[j].value *= f;
                let sys = crate::ss::system(c.net, &m, c.excite);
                Probe {
                    sys: &sys,
                    ss: &m,
                    ..probe
                }
                .volterra(&devs, &coefs, &all, 0.0, true)
            };
            add(at(1.0 + h), at(1.0 - h));
        }
        for i in kmerged {
            let at = |f: f64| {
                let mut v = all.clone();
                v[i] *= f;
                probe.volterra(&devs, &coefs, &v, 0.0, true)
            };
            add(at(1.0 + h), at(1.0 - h));
        }
        sens.map(|x| mismatch * x)
    };
    // The closed form's a_n against the numeric reference (full model,
    // every coefficient), for each a_n that materialized, allowing for the
    // accepted match mismatch.
    // Roundoff floor of the comparison: a_n is a sum of terms (each Taylor
    // coefficient's part, and the out and ref node responses), so it is
    // compared relative to at least their size: a matched pair's a2 is 0
    // in closed form and roundoff of that size numerically. (κ₁(A)·eps is
    // no floor here: with gmin-sized conductances it reaches 1e-1.)
    let terms = probe.terms(&devs, &coefs, &all, 0.0, c.order >= 3).unwrap_or([0.0; 3]);
    let check = |cl: &Closed, model: &SsCircuit, msyms: &Symbols| -> Option<Check> {
        let merge = merge_effect(cl, model, msyms);
        let mut ck = Check {
            ok: true,
            worst: 0.0,
            unexplained: 0.0,
            match_bound: 0.0,
            orders: Vec::new(),
        };
        for (n, &r) in a_num.iter().enumerate().take(cl.num.len()) {
            let Some(q) = cl.a(n) else { continue };
            ck.orders.push(n + 1);
            let e = q.view(&cl.syms, false).expr();
            let (v, bound) = e
                .map(|e| {
                    let (z, b) = e.eval_with_bound(Complex64::new(0.0, 0.0));
                    (z.re, b)
                })
                .unwrap_or((0.0, 0.0));
            // The rebuild test keeps the plain relative difference.
            let own = v.abs().max(r.abs());
            if own > 0.0 {
                let raw = (v - r).abs() / own;
                ck.unexplained = ck.unexplained.max(raw - 4.0 * merge[n] / own);
            }
            let scale = own.max(terms[n]);
            let (d, m) = if scale > 0.0 {
                ((v - r).abs() / scale, merge[n] / scale)
            } else {
                (0.0, 0.0)
            };
            ck.worst = ck.worst.max(d);
            ck.match_bound = ck.match_bound.max(m);
            if d > 1e-8 + 2.0 * omit_err + 8.0 * bound + 4.0 * m {
                ck.ok = false;
            }
        }
        (!ck.orders.is_empty()).then_some(ck)
    };
    // Exact closed form on the analysis model (redone on the full model if
    // a junction it left out matters here); the leakage-free one when the
    // exact form is too large.
    let mut exact = build(ss, symbols, false);
    let (mut exact_model, mut exact_syms) = (ss, symbols);
    let fs;
    if let Some(cl) = &exact {
        // Junctions omitted as negligible for the gain (≤ 1e-9) can move
        // a3 by more (it is cubic in the transfers): use the full model then,
        // and no exact form if that one is too large.
        if check(cl, ss, symbols).is_some_and(|ck| ck.unexplained > 1e-11) && ss.params.len() != full.params.len() {
            let f = (c.full_symbols)();
            fs = if slopes.is_empty() {
                f
            } else {
                sym_values(full, &f, &slopes).0
            };
            exact = build(full, &fs, false);
            (exact_model, exact_syms) = (full, &fs);
        }
    }
    // Every quantity shown must materialize: `build` returns the numerators,
    // and a_n's D^(2n−1) (or a ratio's D^(2n−2)·N1) can still exceed the
    // budget. Any that does not comes from the leakage-free model.
    let order = c.order as usize;
    let complete = |cl: &Closed| (0..order).all(|n| cl.a(n).is_some()) && (1..order).all(|n| cl.ratio(n).is_some());
    let noleak_ss;
    let noleak_syms;
    let noleak = if !exact.as_ref().is_some_and(complete) && !full.optional.is_empty() {
        noleak_ss = full.omit(&full.optional);
        noleak_syms = (c.noleak_symbols)(&noleak_ss);
        build(&noleak_ss, &noleak_syms, true)
    } else {
        None
    };

    let amp = c.amplitude;
    let a = |n: usize| a_num.get(n).copied().unwrap_or(0.0);
    let mut resp = serde_json::Map::new();
    resp.insert("order".into(), json!(c.order));
    resp.insert("amplitude".into(), json!(amp));
    resp.insert("inputUnit".into(), json!(if c.input_is_v { "V" } else { "A" }));
    resp.insert(
        "nonlinear".into(),
        json!(devs.iter().map(|d| d.element.clone()).collect::<Vec<_>>()),
    );
    resp.insert("taylor".into(), json!(taylor));
    resp.insert("omissionError".into(), json!(omit_err));

    let both = |f: Getter, inverted: bool| (pick(&exact, f, inverted), pick(&noleak, f, inverted));
    let id = |s: &str| s.to_string();
    let ident = |x: f64| x;
    let mut coefs_json = Vec::new();
    for n in 0..c.order as usize {
        let (e, nl) = both(&|cl| cl.a(n), false);
        let mut q = quantity(e, nl, a(n), &Shape { wrap: &id, map: &ident }, c.tol);
        q["order"] = json!(n + 1);
        q["numeric"] = json!(a(n));
        coefs_json.push(q);
    }
    resp.insert("coefficients".into(), json!(coefs_json));
    // With a1 = 0 a ratio over it is infinite, or 0/0 (unavailable) when
    // a_n is 0 too, to roundoff of its terms.
    let zero = |n: usize| a(n).abs() <= ZERO_REL * terms[n];
    let over_a1 = |n: usize, v: f64| {
        if !zero(0) {
            v
        } else if zero(n) {
            f64::NAN
        } else {
            f64::INFINITY
        }
    };
    let w2 = |l: &str| format!("\\frac{{A}}{{2}}\\left|{l}\\right|");
    let m2 = |x: f64| x.abs() * amp / 2.0;
    let (e, nl) = both(&|cl| cl.ratio(1), false);
    resp.insert(
        "hd2".into(),
        quantity(
            e,
            nl,
            over_a1(1, a(1).abs() * amp / (2.0 * a(0).abs())),
            &Shape { wrap: &w2, map: &m2 },
            c.tol,
        ),
    );
    if c.order >= 3 {
        let w3 = |l: &str| format!("\\frac{{A^{{2}}}}{{4}}\\left|{l}\\right|");
        let m3 = |x: f64| x.abs() * amp * amp / 4.0;
        let (e, nl) = both(&|cl| cl.ratio(2), false);
        resp.insert(
            "hd3".into(),
            quantity(
                e,
                nl,
                over_a1(2, a(2).abs() * amp * amp / (4.0 * a(0).abs())),
                &Shape { wrap: &w3, map: &m3 },
                c.tol,
            ),
        );
        let iip3 = if zero(2) && !zero(0) {
            infinite()
        } else {
            let wi = |l: &str| format!("\\sqrt{{\\frac{{4}}{{3}}\\left|{l}\\right|}}");
            let mi = |x: f64| (4.0 * x.abs() / 3.0).sqrt();
            let (e, nl) = both(&|cl| cl.ratio(2), true);
            quantity(
                e,
                nl,
                match (zero(0), zero(2)) {
                    (true, true) => f64::NAN,
                    (true, false) => 0.0,
                    _ => (4.0 * a(0).abs() / (3.0 * a(2).abs())).sqrt(),
                },
                &Shape { wrap: &wi, map: &mi },
                c.tol,
            )
        };
        resp.insert("iip3".into(), iip3);
    } else {
        resp.insert("hd3".into(), Value::Null);
        resp.insert("iip3".into(), Value::Null);
    }
    // The K symbols of the forms shown, exact first: those in the
    // numerator of an a_n or HD_n (and so IIP3) that the closed form
    // supplies (a1 has none; empty when no closed form supplies one).
    let mut ksyms: Vec<&Sym> = Vec::new();
    for (which, cl) in [&exact, &noleak].into_iter().enumerate() {
        let Some(cl) = cl.as_ref() else { continue };
        let mut used = vec![false; cl.syms.len()];
        for n in 1..order.min(cl.num.len()) {
            let by_exact = |f: &dyn Fn(&Closed) -> bool| exact.as_ref().is_some_and(f);
            let shown = if which == 0 {
                cl.a(n).is_some() || cl.ratio(n).is_some()
            } else {
                (cl.a(n).is_some() && !by_exact(&|e| e.a(n).is_some()))
                    || (cl.ratio(n).is_some() && !by_exact(&|e| e.ratio(n).is_some()))
            };
            if shown {
                for (e, _) in &cl.num[n].terms {
                    for (k, &x) in e.iter().enumerate() {
                        used[k] |= x > 0;
                    }
                }
            }
        }
        for (k, s) in cl.syms.iter().enumerate() {
            if used[k] && s.role == Role::Coeff && !ksyms.iter().any(|q| q.name == s.name) {
                ksyms.push(s);
            }
        }
    }
    let ksyms: Vec<Value> = ksyms
        .iter()
        .map(|s| json!({ "name": s.name, "latex": s.latex, "value": s.value, "unit": s.unit, "elements": s.elements }))
        .collect();
    resp.insert("symbols".into(), json!(ksyms));
    match exact.as_ref().and_then(|cl| check(cl, exact_model, exact_syms)) {
        Some(ck) => {
            if !ck.ok {
                warnings.push(format!(
                    "distortion: closed form and numeric solution differ ({:.2e})",
                    ck.worst
                ));
            }
            resp.insert(
                "check".into(),
                json!({ "ok": ck.ok, "maxRelDiff": ck.worst, "orders": ck.orders, "matchBound": ck.match_bound }),
            );
        }
        None => {
            resp.insert("check".into(), Value::Null);
        }
    }

    // Harmonic distortion versus frequency, numerically on the full model:
    // HD2 = |H2(jω,jω)|·A/(2|H1(jω)|), HD3 = |H3(jω,jω,jω)|·A²/(4|H1(jω)|).
    let vs: Vec<Value> = c
        .freqs
        .iter()
        .map(|&f| match probe.volterra_terms(&devs, &coefs, &all, f, c.order >= 3) {
            Some((h, nt)) => {
                // H1 is 0 to roundoff of what its node responses sum (a
                // notch at f): then HD_n is infinite or unavailable below.
                let h1_zero = h[0].norm() <= ZERO_REL * nt[0];
                let a1 = if h1_zero { 0.0 } else { h[0].norm() };
                let mut p = json!({
                    "f": f,
                    "hd2": num_or_null(h[1].norm() * amp / (2.0 * a1)),
                    "hd3": if c.order >= 3 { num_or_null(h[2].norm() * amp * amp / (4.0 * a1)) } else { Value::Null },
                });
                // H1 = 0: HD_n is infinite unless H_n is 0 too (to roundoff
                // of its terms), then unavailable.
                if h1_zero {
                    let t = probe.terms(&devs, &coefs, &all, f, c.order >= 3).unwrap_or([0.0; 3]);
                    for (n, key) in [(1, "hd2Infinite"), (2, "hd3Infinite")] {
                        if (n == 1 || c.order >= 3) && h[n].norm() > ZERO_REL * t[n] {
                            p[key] = json!(true);
                        }
                    }
                }
                p
            }
            None => json!({ "f": f, "hd2": null, "hd3": null }),
        })
        .collect();
    resp.insert("vsFreq".into(), json!(vs));
    Ok(Value::Object(resp))
}

#[cfg(test)]
mod tests {
    use super::*;

    thread_local! {
        /// ω of every factorization `Probe::lu` makes on this thread.
        pub(super) static FACTORED: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
    }

    /// An order-2 request classifies a notched fundamental (H1 = 0 to
    /// roundoff) with solves at f and 2f only, never 3f.
    #[test]
    fn order_two_notch_needs_no_third_harmonic_system() {
        let net = "trap\nVDD vdd 0 5\nRD1 vdd o1 5k\nRD2 vdd o2 5k\nM1 o1 inp tail tail nm W=10u L=1u\n\
M2 o2 inn tail tail nm W=10u L=1u\nRT tail 0 2k\nL1 o1 t1 1\nC1 t1 0 1\nL2 o2 t2 1\nC2 t2 0 1\n\
VIP inp 0 DC 1.2 AC 1\nVINN inn 0 1.2\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05)\n";
        let f = 0.1591549430918953;
        let rq: crate::Request = serde_json::from_value(json!({
            "input": "VIP", "inputNeg": "VINN", "mode": "differential", "output": "o1",
            "nonlinear": ["M1", "M2"], "freqs": [f], "order": 2,
            "match": [["M1", "M2"], ["RD1", "RD2"], ["L1", "L2"], ["C1", "C2"]] }))
        .unwrap();
        FACTORED.with(|v| v.borrow_mut().clear());
        let r = crate::analyze(net, &rq).unwrap();
        let p = &r["distortion"]["vsFreq"][0];
        assert_eq!(p["hd2Infinite"], true, "{p}");
        let w3 = jw(3.0 * f).im;
        FACTORED.with(|v| {
            let v = v.borrow();
            assert!(v.contains(&jw(2.0 * f).im) && !v.contains(&w3), "{v:?}");
        });
    }
    use crate::devices::{bjt_eval, mos_eval};

    fn mos(gamma: f64, lambda: f64, ty: f64) -> MosModel {
        MosModel {
            name: "m".into(),
            ty,
            kp: 2e-4,
            vto: 0.5 * ty,
            lambda,
            gamma,
            phi: 0.7,
            is: 1e-14,
            cox: 3.45e-4,
            kf: 0.0,
            af: 1.0,
        }
    }

    /// First-order jet coefficients are the small-signal parameters, and
    /// higher orders match finite differences of `mos_eval`.
    #[test]
    fn mos_jet_matches_mos_eval() {
        for (vgs, vds, vbs) in [(1.2, 2.0, -0.5), (1.5, 0.3, -1.0), (0.9, 1.0, 0.0), (1.0, 1.5, 0.3)] {
            let m = mos(0.4, 0.1, 1.0);
            let ev = mos_eval(&m, 2e-3, vgs, vds, vbs);
            let j = mos_jet(
                &m,
                2e-3,
                Jet::var(vgs, 0, 1.0),
                Jet::var(vds, 1, 1.0),
                Jet::var(vbs, 2, 1.0),
            );
            let rel = |a: f64, b: f64| (a - b).abs() / a.abs().max(b.abs()).max(1e-300);
            assert!(rel(j.0[0], ev.cdrain) < 1e-14);
            assert!(rel(j.0[1], ev.gm) < 1e-13);
            assert!(rel(j.0[2], ev.gds) < 1e-13);
            if vbs < 0.0 {
                assert!(rel(j.0[3], ev.gmbs) < 1e-13);
            }
            // v_BS > 0: the DC slope, not ngspice's gmbs.
            if vbs > 0.0 {
                let g = mos_gmbs_dc(&m, ev.gm, vbs).unwrap();
                assert!(rel(j.0[3], g) < 1e-13 && rel(g, ev.gmbs) > 0.1);
                let f = |db: f64| mos_eval(&m, 2e-3, vgs, vds, vbs + db).cdrain;
                assert!(rel((f(1e-6) - f(-1e-6)) / 2e-6, g) < 1e-7);
            }
            // ½∂²I/∂vgs² and ⅙∂³I/∂vbs³ by central differences.
            let f = |dg: f64, db: f64| mos_eval(&m, 2e-3, vgs + dg, vds, vbs + db).cdrain;
            let h = 1e-3;
            let k2g = (f(h, 0.0) - 2.0 * f(0.0, 0.0) + f(-h, 0.0)) / (2.0 * h * h);
            assert!(rel(j.0[index([2, 0, 0]).unwrap()], k2g) < 1e-6);
            if vbs < 0.0 {
                let k3b =
                    (f(0.0, 2.0 * h) - 2.0 * f(0.0, h) + 2.0 * f(0.0, -h) - f(0.0, -2.0 * h)) / (2.0 * h * h * h) / 6.0;
                assert!(rel(j.0[index([0, 0, 3]).unwrap()], k3b) < 1e-4, "{} {k3b}", j.0[19]);
            }
        }
    }

    #[test]
    fn bjt_jet_matches_bjt_eval() {
        let m = BjtModel {
            name: "q".into(),
            ty: 1.0,
            is: 1e-16,
            bf: 100.0,
            br: 2.0,
            vaf: 40.0,
            kf: 0.0,
            af: 1.0,
        };
        for (vbe, vbc) in [(0.65, -2.0), (0.7, 0.5), (-1.0, -5.0)] {
            let ev = bjt_eval(&m, 1.0, vbe, vbc, 1e-12);
            let be = Jet::var(vbe, 0, 1.0);
            let ce = Jet::var(vbe - vbc, 1, 1.0);
            let ((cc, cb), _) = bjt_jet(&m, 1.0, be, be.sub(&ce), 1e-12);
            let rel = |a: f64, b: f64| (a - b).abs() / a.abs().max(b.abs()).max(1e-300);
            assert!(rel(cc.0[0], ev.cc) < 1e-14 && rel(cb.0[0], ev.cb) < 1e-14);
            // ∂Ic/∂vbe at fixed vce = gm − gμ... in bjt_eval terms
            // dcc/dvbe + dcc/dvbc; ∂Ic/∂vce = −dcc/dvbc.
            assert!(rel(cc.0[1], ev.dcc_dvbe() + ev.dcc_dvbc()) < 1e-12);
            assert!(rel(cc.0[2], -ev.dcc_dvbc()) < 1e-12);
            assert!(rel(cb.0[1], ev.gpi + ev.gmu) < 1e-12);
        }
    }

    #[test]
    fn jet_algebra() {
        // (1 + x + y)³ truncated, and sqrt(4 + x) to third order.
        let x = Jet::var(1.0, 0, 1.0).add(&Jet::var(0.0, 1, 1.0));
        let c = x.mul(&x).mul(&x);
        assert_eq!(c.0[index([1, 1, 0]).unwrap()], 6.0);
        assert_eq!(c.0[index([2, 1, 0]).unwrap()], 3.0);
        assert_eq!(c.0[index([3, 0, 0]).unwrap()], 1.0);
        let s = Jet::var(4.0, 0, 1.0).sqrt();
        assert!((s.0[index([3, 0, 0]).unwrap()] - 1.0 / 512.0).abs() < 1e-18);
    }
}
