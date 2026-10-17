//! DC operating point by Newton–Raphson on the MNA equations, with
//! ngspice-style junction/FET limiting, then gmin and source stepping as
//! fallbacks.

use crate::devices::*;
use crate::linalg::solve_real;
use crate::netlist::{Kind, Netlist};

#[derive(Clone, Debug)]
pub struct MosOp {
    pub ty: f64,
    /// Drain and source swapped roles (vds < 0 in the device frame).
    pub reversed: bool,
    pub region: MosRegion,
    /// Current into the drain terminal.
    pub id: f64,
    pub vgs: f64,
    pub vds: f64,
    pub vbs: f64,
    pub vth: f64,
    pub vdsat: f64,
    pub gm: f64,
    pub gds: f64,
    pub gmb: f64,
    pub gbs: f64,
    pub gbd: f64,
}

#[derive(Clone, Debug)]
pub struct BjtOp {
    pub ty: f64,
    pub region: &'static str,
    pub ic: f64,
    pub ib: f64,
    pub vbe: f64,
    pub vce: f64,
    pub gm: f64,
    pub gpi: f64,
    pub go: f64,
    pub gmu: f64,
}

#[derive(Clone, Debug)]
pub struct DiodeOp {
    pub id: f64,
    pub vd: f64,
    pub gd: f64,
}

#[derive(Clone, Debug)]
pub enum DevOp {
    Mos(MosOp),
    Bjt(BjtOp),
    Diode(DiodeOp),
}

#[derive(Clone, Debug)]
pub struct Op {
    /// Node voltages, index 0 = ground.
    pub v: Vec<f64>,
    /// Branch current per element (V, E, H, L), flowing p → n inside it.
    pub branch: Vec<Option<f64>>,
    pub dev: Vec<Option<DevOp>>,
    pub method: &'static str,
    pub iterations: usize,
}

struct Layout {
    nn: usize,
    branch: Vec<Option<usize>>,
    dim: usize,
}

impl Layout {
    fn new(net: &Netlist) -> Layout {
        let nn = net.nodes.len() - 1;
        let mut dim = nn;
        let branch = net
            .elements
            .iter()
            .map(|e| {
                e.has_branch().then(|| {
                    dim += 1;
                    dim - 1
                })
            })
            .collect();
        Layout { nn, branch, dim }
    }

    fn n(&self, node: usize) -> Option<usize> {
        (node != 0).then(|| node - 1)
    }
}

struct Asm {
    n: usize,
    a: Vec<f64>,
    z: Vec<f64>,
    /// A stamped value was infinite or NaN (a device equation overflowed).
    nonfinite: bool,
    /// The first element whose stamps were not finite.
    overflow: Option<usize>,
    /// The element being stamped, and the largest |stamp| any element made.
    current: Option<usize>,
    largest: (f64, Option<usize>),
}

impl Asm {
    fn new(n: usize) -> Asm {
        Asm {
            n,
            a: vec![0.0; n * n],
            z: vec![0.0; n],
            nonfinite: false,
            overflow: None,
            current: None,
            largest: (0.0, None),
        }
    }
    fn add(&mut self, r: Option<usize>, c: Option<usize>, v: f64) {
        if let (Some(r), Some(c)) = (r, c) {
            self.a[r * self.n + c] += v;
            self.note(v);
        }
    }
    fn note(&mut self, v: f64) {
        self.nonfinite |= !v.is_finite();
        if self.current.is_some() && v.abs() > self.largest.0 {
            self.largest = (v.abs(), self.current);
        }
    }
    fn rhs(&mut self, r: Option<usize>, v: f64) {
        if let Some(r) = r {
            self.z[r] += v;
            self.note(v);
        }
    }
}

/// Stamps a linearized device current flowing from node `from` through the
/// device into node `to`: I = i0 + Σ g·((v_p − v_q) − v0).
fn stamp_nl(asm: &mut Asm, lay: &Layout, from: usize, to: usize, i0: f64, deps: &[(f64, usize, usize, f64)]) {
    let f = lay.n(from);
    let t = lay.n(to);
    let mut ieq = i0;
    for &(g, p, q, v0) in deps {
        let (pp, qq) = (lay.n(p), lay.n(q));
        asm.add(f, pp, g);
        asm.add(f, qq, -g);
        asm.add(t, pp, -g);
        asm.add(t, qq, g);
        ieq -= g * v0;
    }
    asm.rhs(f, -ieq);
    asm.rhs(t, ieq);
}

#[derive(Clone, Copy, Debug)]
enum St {
    None,
    Mos { vgs: f64, vds: f64, vbs: f64, von: f64 },
    Bjt { vbe: f64, vbc: f64 },
    Dio { vd: f64 },
}

fn initial_states(net: &Netlist) -> Vec<St> {
    let vt = vt();
    net.elements
        .iter()
        .map(|e| match &e.kind {
            Kind::M { model, .. } => St::Mos {
                vgs: model.ty * model.vto,
                vds: 0.0,
                vbs: -1.0,
                von: model.ty * model.vto,
            },
            Kind::Q { model, area, .. } => St::Bjt {
                vbe: vcrit(model.is * area, vt),
                vbc: 0.0,
            },
            Kind::D { model, area, mult } => St::Dio {
                vd: vcrit(model.is * area * mult, model.n * vt),
            },
            _ => St::None,
        })
        .collect()
}

fn volt(x: &[f64], node: usize) -> f64 {
    if node == 0 {
        0.0
    } else {
        x[node - 1]
    }
}

struct Ctx<'a> {
    net: &'a Netlist,
    lay: Layout,
}

impl Ctx<'_> {
    fn stamp_linear(&self, asm: &mut Asm, scale: f64) {
        let lay = &self.lay;
        for (ei, e) in self.net.elements.iter().enumerate() {
            let nd = |i: usize| lay.n(e.nodes[i]);
            match &e.kind {
                Kind::R { value } => {
                    let g = 1.0 / value;
                    let (p, n) = (nd(0), nd(1));
                    asm.add(p, p, g);
                    asm.add(n, n, g);
                    asm.add(p, n, -g);
                    asm.add(n, p, -g);
                }
                Kind::C { .. } => {}
                Kind::I { dc, .. } => {
                    asm.rhs(nd(0), -scale * dc);
                    asm.rhs(nd(1), scale * dc);
                }
                Kind::G { gain } => {
                    let (p, n, cp, cn) = (nd(0), nd(1), nd(2), nd(3));
                    asm.add(p, cp, *gain);
                    asm.add(p, cn, -gain);
                    asm.add(n, cp, -gain);
                    asm.add(n, cn, *gain);
                }
                Kind::F { ctrl, gain } => {
                    let k = lay.branch[*ctrl];
                    asm.add(nd(0), k, *gain);
                    asm.add(nd(1), k, -gain);
                }
                Kind::V { .. } | Kind::E { .. } | Kind::H { .. } | Kind::L { .. } => {
                    let k = lay.branch[ei];
                    let (p, n) = (nd(0), nd(1));
                    asm.add(p, k, 1.0);
                    asm.add(n, k, -1.0);
                    asm.add(k, p, 1.0);
                    asm.add(k, n, -1.0);
                    match &e.kind {
                        Kind::V { dc, .. } => asm.rhs(k, scale * dc),
                        Kind::E { gain } => {
                            asm.add(k, nd(2), -gain);
                            asm.add(k, nd(3), *gain);
                        }
                        Kind::H { ctrl, gain } => asm.add(k, lay.branch[*ctrl], -gain),
                        _ => {}
                    }
                }
                Kind::M { .. } | Kind::Q { .. } | Kind::D { .. } => {}
            }
        }
    }

    /// Linearized MNA system at `x` (device states updated in `st`). With
    /// `limit`, junction and FET voltages are step-limited from their previous
    /// states; returns whether any limiting happened.
    fn assemble(&self, x: &[f64], st: &mut [St], scale: f64, gshunt: f64, use_init: bool, limit: bool) -> (Asm, bool) {
        let net = self.net;
        let lay = &self.lay;
        let gmin = net.gmin;
        let vt = vt();
        let mut asm = Asm::new(lay.dim);
        self.stamp_linear(&mut asm, scale);
        if gshunt > 0.0 {
            for i in 0..lay.nn {
                asm.add(Some(i), Some(i), gshunt);
            }
        }
        let mut limited = false;
        for (ei, e) in net.elements.iter().enumerate() {
            let finite_before = !asm.nonfinite;
            asm.current = Some(ei);
            match &e.kind {
                Kind::M { model, w, l, mult } => {
                    let ty = model.ty;
                    let (d, g, s, b) = (e.nodes[0], e.nodes[1], e.nodes[2], e.nodes[3]);
                    let (vd, vg, vs, vb) = (volt(x, d), volt(x, g), volt(x, s), volt(x, b));
                    let (mut vgs, mut vds, mut vbs) = (ty * (vg - vs), ty * (vd - vs), ty * (vb - vs));
                    if let St::Mos {
                        vgs: og,
                        vds: od,
                        vbs: ob,
                        von,
                    } = st[ei]
                    {
                        if use_init {
                            (vgs, vds, vbs) = (og, od, ob);
                        } else if limit {
                            let (lg, ld, lb, clamped) = limit_mos(vgs, vds, vbs, og, od, ob, von, model.is * mult);
                            limited |= clamped;
                            (vgs, vds, vbs) = (lg, ld, lb);
                        }
                    }
                    let beta = model.kp * w / l * mult;
                    let ev = mos_eval(model, beta, vgs, vds, vbs);
                    let vbd = vbs - vds;
                    let (cbs, gbs) = bulk_junction(model.is * mult, vbs, gmin);
                    let (cbd, gbd) = bulk_junction(model.is * mult, vbd, gmin);
                    let (ed, es, vgs_e, vds_e, vbs_e) = if ev.mode > 0 {
                        (d, s, vgs, vds, vbs)
                    } else {
                        (s, d, vgs - vds, -vds, vbs - vds)
                    };
                    stamp_nl(
                        &mut asm,
                        lay,
                        ed,
                        es,
                        ty * ev.cdrain,
                        &[
                            (ev.gm, g, es, ty * vgs_e),
                            (ev.gds, ed, es, ty * vds_e),
                            (ev.gmbs, b, es, ty * vbs_e),
                        ],
                    );
                    stamp_nl(&mut asm, lay, b, s, ty * cbs, &[(gbs, b, s, ty * vbs)]);
                    stamp_nl(&mut asm, lay, b, d, ty * cbd, &[(gbd, b, d, ty * vbd)]);
                    st[ei] = St::Mos {
                        vgs,
                        vds,
                        vbs,
                        von: ev.von,
                    };
                }
                Kind::Q { model, area, mult } => {
                    let ty = model.ty;
                    let (c, bn, en) = (e.nodes[0], e.nodes[1], e.nodes[2]);
                    let (vc, vb, ve) = (volt(x, c), volt(x, bn), volt(x, en));
                    let (mut vbe, mut vbc) = (ty * (vb - ve), ty * (vb - vc));
                    if let St::Bjt { vbe: ob, vbc: oc } = st[ei] {
                        if use_init {
                            (vbe, vbc) = (ob, oc);
                        } else if limit {
                            let vc_ = vcrit(model.is * area, vt);
                            let (lb, lc) = (pnjlim(vbe, ob, vt, vc_), pnjlim(vbc, oc, vt, vc_));
                            if (lb, lc) != (vbe, vbc) {
                                limited = true;
                            }
                            (vbe, vbc) = (lb, lc);
                        }
                    }
                    let ev = bjt_eval(model, *area, *mult, vbe, vbc, gmin);
                    stamp_nl(
                        &mut asm,
                        lay,
                        c,
                        en,
                        ty * ev.cc,
                        &[(ev.dcc_dvbe(), bn, en, ty * vbe), (ev.dcc_dvbc(), bn, c, ty * vbc)],
                    );
                    stamp_nl(
                        &mut asm,
                        lay,
                        bn,
                        en,
                        ty * ev.cb,
                        &[(ev.gpi, bn, en, ty * vbe), (ev.gmu, bn, c, ty * vbc)],
                    );
                    st[ei] = St::Bjt { vbe, vbc };
                }
                Kind::D { model, area, mult } => {
                    let area = area * mult;
                    let (a, k) = (e.nodes[0], e.nodes[1]);
                    let mut vd = volt(x, a) - volt(x, k);
                    if let St::Dio { vd: od } = st[ei] {
                        if use_init {
                            vd = od;
                        } else if limit {
                            let vte = model.n * vt;
                            let lv = pnjlim(vd, od, vte, vcrit(model.is * area, vte));
                            if lv != vd {
                                limited = true;
                            }
                            vd = lv;
                        }
                    }
                    let (id, gd) = diode_eval(model, area, vd, gmin);
                    stamp_nl(&mut asm, lay, a, k, id, &[(gd, a, k, vd)]);
                    st[ei] = St::Dio { vd };
                }
                _ => {}
            }
            if finite_before && asm.nonfinite {
                asm.overflow = Some(ei);
            }
        }
        (asm, limited)
    }

    /// KCL/branch-equation residual of `x` relative to the size of the terms
    /// it sums, worst over all rows, with an absolute floor of
    /// KCL_TOL·RESIDUAL_FLOOR (1e-15 A or V) so femtoamp leakage nodes are not
    /// judged on roundoff. At the linearization point the companion model is
    /// exact, so A(x)·x − z(x) is the true residual.
    fn residual(&self, x: &[f64], st: &[St]) -> f64 {
        let mut st = st.to_vec();
        let (asm, _) = self.assemble(x, &mut st, 1.0, 0.0, false, false);
        let n = self.lay.dim;
        (0..n)
            .map(|r| {
                let row = &asm.a[r * n..(r + 1) * n];
                let lhs: f64 = row.iter().zip(x).map(|(a, v)| a * v).sum();
                let size: f64 = row.iter().zip(x).map(|(a, v)| (a * v).abs()).sum::<f64>() + asm.z[r].abs();
                (lhs - asm.z[r]).abs() / (size + RESIDUAL_FLOOR)
            })
            .fold(0.0, f64::max)
    }

    /// One Newton solve from `x`; returns the converged solution and states.
    fn newton(
        &self,
        scale: f64,
        gshunt: f64,
        mut x: Vec<f64>,
        mut st: Vec<St>,
        mut use_init: bool,
    ) -> Result<(Vec<f64>, Vec<St>, usize), String> {
        let lay = &self.lay;
        let mut polish = 0;
        for iter in 0..300 {
            let (asm, limited) = self.assemble(&x, &mut st, scale, gshunt, use_init, true);
            // An overflowing device equation would otherwise surface as a
            // "singular matrix" and blame the wiring.
            let overflow = |ei: usize| {
                format!(
                    "{}'s model overflows at this bias. Check its parameters.",
                    self.net.elements[ei].name
                )
            };
            if let Some(ei) = asm.overflow {
                return Err(overflow(ei));
            }
            // Finite but beyond any device: the solve fails for the device,
            // not for the wiring.
            let huge = match asm.largest {
                (v, Some(ei)) if v > HUGE_STAMP => Some(ei),
                _ => None,
            };
            let xn = solve_real(lay.dim, asm.a, asm.z).ok_or_else(|| match huge {
                Some(ei) => overflow(ei),
                None => "singular circuit matrix: a node may have no DC path to ground, or voltage sources form a loop"
                    .to_string(),
            })?;
            let mut xn = xn;
            // Damped Newton once plain steps have had their chance: a node held
            // only by a tiny conductance can otherwise be thrown volts away and
            // cycle. It changes the path, not the fixed point.
            if iter >= DAMP_AFTER {
                let step = (0..lay.nn).map(|i| (xn[i] - x[i]).abs()).fold(0.0, f64::max);
                let size = (0..lay.nn).map(|i| x[i].abs()).fold(0.0, f64::max);
                let cap = MAX_STEP.max(0.5 * size);
                if step > cap {
                    let k = cap / step;
                    for (v, old) in xn.iter_mut().zip(&x) {
                        *v = old + k * (*v - old);
                    }
                }
            }
            let close = |tol: f64| {
                xn.iter().zip(&x).enumerate().all(|(i, (a, b))| {
                    let abstol = if i < lay.nn { 1e-12 } else { 1e-15 };
                    (a - b).abs() <= tol * a.abs().max(b.abs()) + abstol * tol / 1e-10
                })
            };
            // A node held only by leakage is fixed only to within rounding
            // noise, so its steps never settle below 1e-10; there the circuit
            // equations themselves decide: small steps and a KCL residual that
            // passes the final check.
            let converged = !use_init
                && !limited
                && (close(1e-10) || (iter >= 20 && close(1e-6) && self.residual(&xn, &st) <= KCL_TOL));
            x = xn;
            use_init = false;
            if converged || polish > 0 {
                polish += 1;
                if polish > 2 {
                    return Ok((x, st, iter + 1));
                }
            }
        }
        Err("DC operating point did not converge".to_string())
    }
}

#[allow(clippy::too_many_arguments)]
/// ngspice's MOS step limiting; also says whether any limiter clamped. Each
/// limiter returns its input unchanged unless it clamps, so "clamped" is a
/// comparison of a limiter's output with its own input; voltages are
/// recomposed only after a clamp (recomposing an unclamped one, e.g.
/// vgs − (vgs − vds), can be 1 ulp off and would count as a clamp forever).
fn limit_mos(vgs: f64, vds: f64, vbs: f64, og: f64, od: f64, ob: f64, von: f64, is: f64) -> (f64, f64, f64, bool) {
    let vt = vt();
    let vgd = vgs - vds;
    let ogd = og - od;
    let (lvgs, lvds, c_gate, c_vds) = if od >= 0.0 {
        let lg = fetlim(vgs, og, von);
        let c_gate = lg != vgs;
        let vds1 = if c_gate { lg - vgd } else { vds };
        let ld = limvds(vds1, od);
        (lg, ld, c_gate, ld != vds1)
    } else {
        let lgd = fetlim(vgd, ogd, von);
        let c_gate = lgd != vgd;
        let vds1 = if c_gate { vgs - lgd } else { vds };
        let t = limvds(-vds1, -od);
        let c_vds = t != -vds1;
        let ld = -t;
        // vgd is the limited quantity here: vgs follows from it and vds.
        let lg = if c_gate || c_vds { lgd + ld } else { vgs };
        (lg, ld, c_gate, c_vds)
    };
    let vc = vcrit(is, vt);
    let (lvbs, c_bulk) = if lvds >= 0.0 {
        let lb = pnjlim(vbs, ob, vt, vc);
        (lb, lb != vbs)
    } else {
        let vbd = vbs - lvds;
        let lb = pnjlim(vbd, ob - od, vt, vc);
        if lb != vbd {
            (lb + lvds, true)
        } else {
            (vbs, false)
        }
    };
    (lvgs, lvds, lvbs, c_gate || c_vds || c_bulk)
}

/// Newton iterations before node-voltage steps are capped at MAX_STEP volts
/// (or half the largest node voltage, so a far-off iterate can come back).
const DAMP_AFTER: usize = 10;
const MAX_STEP: f64 = 0.5;
/// Newton iterations allowed across one stepping strategy: 20k for small
/// circuits, fewer as each dense solve gets costlier (about 2e10 flops).
fn stepping_budget(dim: usize) -> usize {
    (2e10 / (dim.max(1) as f64).powi(3)).clamp(300.0, 20_000.0) as usize
}

/// A device stamp beyond any physical conductance or current (1 GS or 1 GA).
/// It only chooses the message when the solve has already failed.
const HUGE_STAMP: f64 = 1e9;

/// Largest relative KCL residual accepted for a DC solution.
pub const KCL_TOL: f64 = 1e-9;
const RESIDUAL_FLOOR: f64 = 1e-6;

pub fn operating_point(net: &Netlist) -> Result<Op, String> {
    let ctx = Ctx {
        net,
        lay: Layout::new(net),
    };
    let dim = ctx.lay.dim;
    let init = initial_states(net);
    let (x, iters, method) = match ctx.newton(1.0, 0.0, vec![0.0; dim], init.clone(), true) {
        Ok((x, _, it)) => (x, it, "newton"),
        Err(first) => match gmin_stepping(&ctx, &init).or_else(|_| source_stepping(&ctx, &init)) {
            Ok((x, it, m)) => (x, it, m),
            Err(_) => return Err(first),
        },
    };
    // Fail loudly rather than hand back a point that does not satisfy the
    // circuit equations (e.g. a near-singular system solved through roundoff).
    let res = ctx.residual(&x, &init);
    if res.is_nan() || res > KCL_TOL {
        return Err(format!(
            "DC operating point failed the KCL check (relative residual {res:.1e}); the circuit may be ill-conditioned"
        ));
    }
    Ok(finish(net, &ctx.lay, x, method, iters))
}

/// Dynamic gmin stepping (as in ngspice): a shunt conductance on every node
/// makes the problem easy; shrink it by `factor` after each success, and on a
/// failure go back to the last solved point with a smaller factor.
fn gmin_stepping(ctx: &Ctx, init: &[St]) -> Result<(Vec<f64>, usize, &'static str), String> {
    let mut g = 1e-3;
    let (mut x, mut st, mut total) = loop {
        match ctx.newton(1.0, g, vec![0.0; ctx.lay.dim], init.to_vec(), true) {
            Ok(r) => break r,
            Err(e) if g >= 1.0 => return Err(e),
            Err(_) => g *= 10.0,
        }
    };
    let mut factor: f64 = 10.0;
    while total < stepping_budget(ctx.lay.dim) {
        let next = if g / factor < 1e-13 { 0.0 } else { g / factor };
        match ctx.newton(1.0, next, x.clone(), st.clone(), false) {
            Ok((nx, nst, it)) => {
                (x, st) = (nx, nst);
                total += it;
                if next == 0.0 {
                    return Ok((x, total, "gmin stepping"));
                }
                g = next;
                factor = (factor * factor.sqrt()).min(10.0);
            }
            Err(e) => {
                factor = factor.sqrt().sqrt();
                if factor < 1.00005 {
                    return Err(e);
                }
                total += 300;
            }
        }
    }
    Err("DC operating point did not converge (gmin stepping)".to_string())
}

/// Adaptive source stepping: ramp every independent source from 0 to its
/// value, growing the step after successes and backing off after failures.
fn source_stepping(ctx: &Ctx, init: &[St]) -> Result<(Vec<f64>, usize, &'static str), String> {
    let (mut x, mut st, mut total) = ctx.newton(0.0, 0.0, vec![0.0; ctx.lay.dim], init.to_vec(), true)?;
    let (mut alpha, mut step) = (0.0f64, 0.05f64);
    while total < stepping_budget(ctx.lay.dim) {
        let next = (alpha + step).min(1.0);
        match ctx.newton(next, 0.0, x.clone(), st.clone(), false) {
            Ok((nx, nst, it)) => {
                (x, st) = (nx, nst);
                total += it;
                if next >= 1.0 {
                    return Ok((x, total, "source stepping"));
                }
                alpha = next;
                step = (step * 1.5).min(0.25);
            }
            Err(e) => {
                step /= 4.0;
                if step < 1e-7 {
                    return Err(e);
                }
                total += 300;
            }
        }
    }
    Err("DC operating point did not converge (source stepping)".to_string())
}

fn finish(net: &Netlist, lay: &Layout, x: Vec<f64>, method: &'static str, iterations: usize) -> Op {
    let gmin = net.gmin;
    let mut v = vec![0.0];
    v.extend_from_slice(&x[..lay.nn]);
    let branch = lay.branch.iter().map(|b| b.map(|k| x[k])).collect();
    let dev = net
        .elements
        .iter()
        .map(|e| {
            let nv = |i: usize| v[e.nodes[i]];
            match &e.kind {
                Kind::M { model, w, l, mult } => {
                    let ty = model.ty;
                    let (vgs, vds, vbs) = (nv(1) - nv(2), nv(0) - nv(2), nv(3) - nv(2));
                    let beta = model.kp * w / l * mult;
                    let ev = mos_eval(model, beta, ty * vgs, ty * vds, ty * vbs);
                    let (_, gbs) = bulk_junction(model.is * mult, ty * vbs, gmin);
                    let (cbd, gbd) = bulk_junction(model.is * mult, ty * (vbs - vds), gmin);
                    let ich = if ev.mode > 0 { ev.cdrain } else { -ev.cdrain };
                    Some(DevOp::Mos(MosOp {
                        ty,
                        reversed: ev.mode < 0,
                        region: ev.region,
                        id: ty * (ich - cbd),
                        vgs,
                        vds,
                        vbs,
                        vth: ty * ev.von,
                        vdsat: ty * ev.vdsat,
                        gm: ev.gm,
                        gds: ev.gds,
                        gmb: ev.gmbs,
                        gbs,
                        gbd,
                    }))
                }
                Kind::Q { model, area, mult } => {
                    let ty = model.ty;
                    let (vbe, vbc) = (nv(1) - nv(2), nv(1) - nv(0));
                    let ev = bjt_eval(model, *area, *mult, ty * vbe, ty * vbc, gmin);
                    // Junction on above 0.4 V, as the oracle labels them.
                    let region = match (ty * vbe > 0.4, ty * vbc > 0.4) {
                        (true, false) => "forward-active",
                        (true, true) => "saturation",
                        (false, true) => "reverse-active",
                        (false, false) => "cutoff",
                    };
                    Some(DevOp::Bjt(BjtOp {
                        ty,
                        region,
                        ic: ty * ev.cc,
                        ib: ty * ev.cb,
                        vbe,
                        vce: nv(0) - nv(2),
                        gm: ev.gm,
                        gpi: ev.gpi,
                        go: ev.go,
                        gmu: ev.gmu,
                    }))
                }
                Kind::D { model, area, mult } => {
                    let vd = nv(0) - nv(1);
                    let (id, gd) = diode_eval(model, area * mult, vd, gmin);
                    Some(DevOp::Diode(DiodeOp { id, vd, gd }))
                }
                _ => None,
            }
        })
        .collect();
    Op {
        v,
        branch,
        dev,
        method,
        iterations,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::netlist::parse;

    #[test]
    fn divider() {
        let n = parse("t\nV1 a 0 10\nR1 a b 1k\nR2 b 0 3k\n").unwrap();
        let op = operating_point(&n).unwrap();
        assert!((op.v[n.node("b").unwrap()] - 7.5).abs() < 1e-12);
        // Current flows + → − inside the source, i.e. −2.5 mA here.
        assert!((op.branch[0].unwrap() + 2.5e-3).abs() < 1e-15);
    }

    #[test]
    fn cs_saturation_matches_square_law() {
        let n = parse(
            "t\nVDD vdd 0 1.8\nVIN in 0 0.7\nRD vdd out 10k\nM1 out in 0 0 nm W=10u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1)\n",
        )
        .unwrap();
        let op = operating_point(&n).unwrap();
        let Some(DevOp::Mos(m)) = &op.dev[3] else { panic!() };
        let vout = op.v[n.node("out").unwrap()];
        let beta = 200e-6 * 10.0;
        let id = beta / 2.0 * 0.2f64.powi(2) * (1.0 + 0.1 * vout);
        assert_eq!(m.region, MosRegion::Saturation);
        // The drain-bulk junction leaks gmin·vbd (as in ngspice), hence 1e-6.
        assert!((m.id - id).abs() < 1e-6 * id, "{} vs {}", m.id, id);
        assert!(((1.8 - vout) / 10e3 - m.id).abs() < 1e-15);
    }

    #[test]
    fn bjt_ce_bias() {
        let n = parse("t\nVCC vcc 0 5\nVB b 0 0.65\nRC vcc c 2k\nQ1 c b 0 qn\n.model qn npn is=1e-15 bf=100 vaf=50\n")
            .unwrap();
        let op = operating_point(&n).unwrap();
        let Some(DevOp::Bjt(q)) = &op.dev[3] else { panic!() };
        assert_eq!(q.region, "forward-active");
        assert!((q.ic - q.ib * 100.0 * (1.0 + q.vce / 50.0)).abs() / q.ic < 0.02);
    }
}
