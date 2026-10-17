//! Noise: ngspice's device noise sources at 27 °C, their exact transfers to
//! the output, output and input-referred spectra, band integrals, and the
//! input-referred low-frequency PSD in closed form.
//!
//! Every source is a current between two nodes, with PSD (A²/Hz) as ngspice
//! computes it (checked against ngspice-47 to 1e-6):
//!
//! | element  | source                       | PSD                          |
//! |----------|------------------------------|------------------------------|
//! | R        | thermal                      | 4kT/R                        |
//! | MOSFET   | channel thermal (any region) | (2/3)·4kT·gm                 |
//! | MOSFET   | flicker                      | KF·gm²/(Cox·M·W·L·f^AF)      |
//! | BJT      | collector shot (c–e)         | 2q·\|Ic\|                    |
//! | BJT      | base shot (b–e)              | 2q·\|Ib\|                    |
//! | BJT      | flicker (b–e)                | KF·\|Ib\|^AF/f               |
//! | diode    | shot                         | 2q·\|Id\|                    |
//! | diode    | flicker                      | KF·\|Id\|^AF/f               |
//!
//! Device conductances (r_o, r_π, r_d, junction leakage) carry no noise of
//! their own, as in ngspice.

use crate::analyze::{cancel, jw, matrix_at};
use crate::dc::{DevOp, Op};
use crate::devices::{BOLTZ, CHARGE, TEMP};
use crate::linalg::LuComplex;
use crate::netlist::{Kind, Netlist};
use crate::poly::{sub, Poly};
use crate::render::{factors, power_latex, Expr, Term};
use crate::ss::{dev_latex_sub, Role, SsCircuit, System};
use crate::sym::{self, Sym, Symbols, XPoly, MATCH_REL};
use num_complex::Complex64;
use serde_json::{json, Value};
use std::collections::{BinaryHeap, HashMap};

pub const FOUR_KT: f64 = 4.0 * BOLTZ * TEMP;
pub const TWO_Q: f64 = 2.0 * CHARGE;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scale {
    FourKT,
    TwoQ,
}

/// A bias current used as a symbol (shot noise): `I_{C1}` for Q1.
#[derive(Clone, Debug)]
pub struct CurrentSym {
    pub name: String,
    pub base: &'static str,
    pub sub: &'static str,
    /// |I| in amperes; NaN when symbolic.
    pub value: f64,
}

/// What a white source's PSD is proportional to.
#[derive(Clone, Debug)]
pub enum SymOf {
    /// A small-signal parameter by name, in MNA form (1/R for a resistor, gm).
    Param(String),
    Current(CurrentSym),
}

/// White PSD = scale · (num/den) · symbol.
#[derive(Clone, Debug)]
pub struct SymPsd {
    pub scale: Scale,
    pub num: i128,
    pub den: i128,
    pub of: SymOf,
}

#[derive(Clone, Debug)]
pub struct Source {
    pub element: String,
    /// thermal, flicker, shot (diode), shot_c, shot_b (BJT).
    pub kind: &'static str,
    /// The current flows between these nodes (its sign is irrelevant to a PSD).
    pub a: usize,
    pub b: usize,
    /// White PSD in A²/Hz (0 for a flicker source).
    pub white: f64,
    /// Flicker PSD coef / f^exp.
    pub flicker: Option<(f64, f64)>,
    pub sym: Option<SymPsd>,
}

impl Source {
    pub fn psd(&self, f: f64) -> f64 {
        match self.flicker {
            Some((c, x)) if f > 0.0 => c / f.powf(x),
            // c/f^x as f → 0: unbounded for x > 0, constant for x = 0.
            Some((c, x)) if x <= 0.0 => {
                if x == 0.0 {
                    c
                } else {
                    0.0
                }
            }
            Some(_) => f64::INFINITY,
            None => self.white,
        }
    }
}

/// The circuit's noise sources at its operating point (`op = None`: purely
/// symbolic, values NaN, every MOSFET taken as on).
pub fn sources(net: &Netlist, op: Option<&Op>) -> Vec<Source> {
    let mut out = Vec::new();
    for (ei, e) in net.elements.iter().enumerate() {
        let n = &e.nodes;
        let nm = e.name.clone();
        let dev = op.and_then(|o| o.dev[ei].as_ref());
        let mut push = |kind, a, b, white, flicker, sym| {
            out.push(Source {
                element: nm.clone(),
                kind,
                a,
                b,
                white,
                flicker,
                sym,
            })
        };
        let current = |base: &'static str, sub: &'static str, value: f64| {
            SymOf::Current(CurrentSym {
                name: format!("I{sub}_{}", e.name),
                base,
                sub,
                value,
            })
        };
        match &e.kind {
            Kind::R { value } => push(
                "thermal",
                n[0],
                n[1],
                FOUR_KT / value,
                None,
                Some(SymPsd {
                    scale: Scale::FourKT,
                    num: 1,
                    den: 1,
                    of: SymOf::Param(nm.clone()),
                }),
            ),
            Kind::M { model, w, l, mult } => {
                let gm = match dev {
                    Some(DevOp::Mos(m)) => m.gm,
                    _ => f64::NAN,
                };
                if op.is_some() && (gm.is_nan() || gm == 0.0) {
                    continue;
                }
                push(
                    "thermal",
                    n[0],
                    n[2],
                    FOUR_KT * 2.0 / 3.0 * gm,
                    None,
                    Some(SymPsd {
                        scale: Scale::FourKT,
                        num: 2,
                        den: 3,
                        of: SymOf::Param(format!("gm_{nm}")),
                    }),
                );
                if model.kf > 0.0 && gm > 0.0 {
                    let coef = model.kf * gm * gm / (model.cox * mult * w * l);
                    push("flicker", n[0], n[2], 0.0, Some((coef, model.af)), None);
                }
            }
            Kind::Q { model, .. } => {
                let (ic, ib) = match dev {
                    Some(DevOp::Bjt(q)) => (q.ic.abs(), q.ib.abs()),
                    _ => (f64::NAN, f64::NAN),
                };
                for (kind, a, i, sub) in [("shot_c", n[0], ic, "C"), ("shot_b", n[1], ib, "B")] {
                    if op.is_some() && i == 0.0 {
                        continue;
                    }
                    push(
                        kind,
                        a,
                        n[2],
                        TWO_Q * i,
                        None,
                        Some(SymPsd {
                            scale: Scale::TwoQ,
                            num: 1,
                            den: 1,
                            of: current("I", sub, i),
                        }),
                    );
                }
                // As bjtnoise.c: |I_B| floored at N_MINLOG, so AF = 0 gives
                // KF/f even at zero bias. (NaN: no operating point.)
                if model.kf > 0.0 && !ib.is_nan() {
                    push(
                        "flicker",
                        n[1],
                        n[2],
                        0.0,
                        Some((model.kf * ib.abs().max(N_MINLOG).powf(model.af), 1.0)),
                        None,
                    );
                }
            }
            Kind::D { model, .. } => {
                let id = match dev {
                    Some(DevOp::Diode(d)) => d.id.abs(),
                    _ => f64::NAN,
                };
                if !(op.is_some() && id == 0.0) {
                    push(
                        "shot",
                        n[0],
                        n[1],
                        TWO_Q * id,
                        None,
                        Some(SymPsd {
                            scale: Scale::TwoQ,
                            num: 1,
                            den: 1,
                            of: current("I", "D", id),
                        }),
                    );
                }
                // As dionoise.c: |I_D| floored at N_MINLOG.
                if model.kf > 0.0 && !id.is_nan() {
                    push(
                        "flicker",
                        n[0],
                        n[1],
                        0.0,
                        Some((model.kf * id.abs().max(N_MINLOG).powf(model.af), 1.0)),
                        None,
                    );
                }
            }
            _ => {}
        }
    }
    out
}

/// Numeric transfers on one small-signal system (the gain system, input
/// source at zero for the noise): one LU of Aᵀ per frequency gives the
/// output's sensitivity to a current injected at every node (adjoint).
pub struct Numeric<'a> {
    pub ss: &'a SsCircuit,
    pub sys: &'a System,
    pub out: usize,
    pub rf: usize,
    pub vid: f64,
}

pub struct Point {
    /// Gain (output per input unit).
    pub gain: Complex64,
    /// |transfer| from each source to the output (V/A). Kept unsquared:
    /// |Z|² alone can underflow or overflow (1e-200 Ω, 1e200 Ω) where
    /// |Z|²·PSD is representable, so contributions are formed as
    /// (|Z|·√PSD)² (`sq_scaled`).
    pub z: Vec<f64>,
    /// At f = 0 only: lim f→0 of |transfer|²·PSD for each flicker source
    /// (exponent > 0) whose transfer vanishes at DC (see `dc_limits`).
    pub dc_limit: Vec<Option<f64>>,
}

impl Numeric<'_> {
    /// Adjoint solution y with yᵀ·b = output for any right-hand side b, and
    /// the LU (for its condition number).
    fn adjoint(&self, f: f64) -> Option<(Vec<Complex64>, ScaledLu)> {
        let n = self.sys.dim;
        let a = matrix_at(self.sys, self.ss, jw(f));
        let mut at = vec![Complex64::new(0.0, 0.0); n * n];
        for r in 0..n {
            for c in 0..n {
                at[c * n + r] = a[r * n + c];
            }
        }
        let lu = ScaledLu::factor(n, at)?;
        let mut c = vec![Complex64::new(0.0, 0.0); n];
        if let Some(k) = self.sys.node_col[self.out] {
            c[k] += 1.0;
        }
        if let Some(k) = self.sys.node_col[self.rf] {
            c[k] -= 1.0;
        }
        Some((lu.solve(&c), lu))
    }

    pub fn at(&self, f: f64, srcs: &[Source]) -> Option<Point> {
        self.at_with_cond(f, srcs, false).map(|(p, _)| p)
    }

    /// Also returns κ₁(A)·eps when `cond` (a relative accuracy bound).
    pub fn at_with_cond(&self, f: f64, srcs: &[Source], cond: bool) -> Option<(Point, f64)> {
        let (y, lu) = self.adjoint(f)?;
        let col = |n: usize| self.sys.node_col[n].map(|k| y[k]).unwrap_or_default();
        let gain = self
            .sys
            .b
            .iter()
            .zip(&y)
            .map(|(&b, &v)| v * b as f64)
            .sum::<Complex64>()
            / self.vid;
        let z: Vec<f64> = srcs.iter().map(|s| (col(s.a) - col(s.b)).norm()).collect();
        let dc_limit = if f == 0.0 {
            self.dc_limits(&y, &lu, srcs, &z)
        } else {
            Vec::new()
        };
        let err = if cond { lu.cond1() * f64::EPSILON } else { 0.0 };
        Some((Point { gain, z, dc_limit }, err))
    }

    /// lim f→0 of |Z(j2πf)|²·c/f^x for each flicker source (x > 0) whose
    /// transfer Z vanishes at s = 0. With Z(s) = Σ z_n sⁿ and k the order of
    /// its zero (the first z_n ≠ 0): 0 when 2k > x, c·|z_k|²·(2π)^{2k} when
    /// 2k = x, ∞ when 2k < x (0 when Z ≡ 0). The z_n come from the Taylor
    /// series of the adjoint: with A(s) = Σ A_d s^d,
    /// A₀ᵀ y_n = −Σ_{d≥1} A_dᵀ y_{n−d}, on the LU of A₀ᵀ already factored. A zero is an exact floating-point zero,
    /// as for z₀ (a transfer that only rounds to zero counts as nonzero, so
    /// an unresolved case is ∞, never a dropped term).
    fn dc_limits(&self, y0: &[Complex64], lu: &ScaledLu, srcs: &[Source], z0: &[f64]) -> Vec<Option<f64>> {
        let wanted = |k: usize| match srcs[k].flicker {
            Some((_, x)) if x > 0.0 && z0[k] == 0.0 => Some(x),
            _ => None,
        };
        if (0..srcs.len()).all(|k| wanted(k).is_none()) {
            return Vec::new();
        }
        // Z(s) = N(s)/D(s) with D(0) ≠ 0 (A₀ factored) and N of degree at
        // most the number of reactive parameters (every monomial holds each
        // parameter at most once). So a Z still zero through that order is
        // identically zero, and no larger order is ever needed.
        let degree = self.ss.reactive_mask.count_ones() as usize;
        let top = (0..srcs.len())
            .filter_map(wanted)
            .map(|x| (x / 2.0).floor() as usize)
            .max()
            .unwrap_or(0);
        let orders = top.min(degree);
        let n = self.sys.dim;
        let coeffs = if orders > 0 {
            s_coeffs(self.sys, self.ss)
        } else {
            Vec::new()
        };
        let mut ys: Vec<Vec<Complex64>> = vec![y0.to_vec()];
        for k in 1..=orders {
            let mut rhs = vec![Complex64::new(0.0, 0.0); n];
            for (d, a) in coeffs.iter().enumerate().skip(1) {
                if d > k {
                    break;
                }
                let prev = &ys[k - d];
                for (r, row) in a.chunks(n).enumerate() {
                    for (c, &v) in row.iter().enumerate() {
                        if v != 0.0 {
                            rhs[c] -= v * prev[r];
                        }
                    }
                }
            }
            ys.push(lu.solve(&rhs));
        }
        let at = |y: &[Complex64], node: usize| self.sys.node_col[node].map(|k| y[k]).unwrap_or_default();
        (0..srcs.len())
            .map(|k| {
                let x = wanted(k)?;
                let (c, _) = srcs[k].flicker?;
                let s = &srcs[k];
                let first = (1..=orders)
                    .map(|o| (o, (at(&ys[o], s.a) - at(&ys[o], s.b)).norm()))
                    .find(|&(_, z)| z != 0.0);
                Some(match first {
                    Some((o, z)) if 2.0 * o as f64 == x => {
                        sq_scaled(z * (2.0 * std::f64::consts::PI).powi(o as i32), c)
                    }
                    Some((o, _)) if 2.0 * o as f64 > x => 0.0,
                    Some(_) => f64::INFINITY,
                    // Zero through every order with 2n ≤ x (the zero's order
                    // exceeds x/2), or through the numerator's degree (Z ≡ 0).
                    None => 0.0,
                })
            })
            .collect()
    }
}

/// LU of D_r·A·D_c, with D_r and D_c powers of two that bring every row's
/// and then every column's largest entry near 1 (exact scaling). Its κ₁ is
/// the accuracy bound of the solve: an unscaled κ₁ also counts the spread
/// of units (1e-15 S beside 1 for a source branch), which partial pivoting
/// on the equilibrated matrix does not suffer from, and overstates the
/// error by orders of magnitude (κ ~ 1e14 for a Q = 1e9 tank).
pub(crate) struct ScaledLu {
    lu: LuComplex,
    row: Vec<f64>,
    col: Vec<f64>,
}

impl ScaledLu {
    fn factor(n: usize, mut a: Vec<Complex64>) -> Option<ScaledLu> {
        // 2^-round(log2 m): exact, and 1 for an empty row or column (which
        // leaves the matrix singular for the factorization to report).
        let pow2 = |m: f64| {
            if m > 0.0 && m.is_finite() {
                (-m.log2().round()).exp2()
            } else {
                1.0
            }
        };
        let row: Vec<f64> = (0..n)
            .map(|r| pow2((0..n).map(|c| a[r * n + c].norm()).fold(0.0, f64::max)))
            .collect();
        for r in 0..n {
            for c in 0..n {
                a[r * n + c] *= row[r];
            }
        }
        let col: Vec<f64> = (0..n)
            .map(|c| pow2((0..n).map(|r| a[r * n + c].norm()).fold(0.0, f64::max)))
            .collect();
        for r in 0..n {
            for c in 0..n {
                a[r * n + c] *= col[c];
            }
        }
        Some(ScaledLu {
            lu: LuComplex::factor(n, a)?,
            row,
            col,
        })
    }

    /// x with A·x = b.
    fn solve(&self, b: &[Complex64]) -> Vec<Complex64> {
        let rb: Vec<Complex64> = b.iter().zip(&self.row).map(|(&v, &r)| v * r).collect();
        self.lu
            .solve(&rb)
            .into_iter()
            .zip(&self.col)
            .map(|(z, &c)| z * c)
            .collect()
    }

    fn cond1(&self) -> f64 {
        self.lu.cond1()
    }
}

/// A(s) = Σ_d A_d s^d as dense real matrices A_0, A_1, … (row-major): each
/// term's degree in s is its number of reactive parameters.
fn s_coeffs(sys: &System, ss: &SsCircuit) -> Vec<Vec<f64>> {
    let n = sys.dim;
    let mut out: Vec<Vec<f64>> = Vec::new();
    for (r, row) in sys.a.iter().enumerate() {
        for (c, p) in row.iter().enumerate() {
            for (&m, &k) in &p.terms {
                let d = (m & ss.reactive_mask).count_ones() as usize;
                while out.len() <= d {
                    out.push(vec![0.0; n * n]);
                }
                let mut v = k as f64;
                let mut bits = m;
                while bits != 0 {
                    v *= ss.params[bits.trailing_zeros() as usize].mna_value();
                    bits &= bits - 1;
                }
                out[d][r * n + c] += v;
            }
        }
    }
    out
}

/// (a·√b)² = a²·b without forming a² (which can leave the range where
/// a²·b does not); 0 when a is 0, whatever b.
fn sq_scaled(a: f64, b: f64) -> f64 {
    if a == 0.0 {
        return 0.0;
    }
    let r = a * b.sqrt();
    r * r
}

/// Output PSD and each source's share of it at one frequency.
pub fn output_psd(p: &Point, srcs: &[Source], f: f64) -> (f64, Vec<f64>) {
    let parts: Vec<f64> = srcs
        .iter()
        .zip(&p.z)
        .enumerate()
        .map(|(k, (s, &z))| match p.dc_limit.get(k).copied().flatten() {
            Some(v) => v,
            None => sq_scaled(z, s.psd(f)),
        })
        .collect();
    (parts.iter().sum(), parts)
}

/// Input-referred PSD: Σ (|Z_k|/|gain|)²·S_k, each term scaled as in
/// `output_psd` (|gain|² alone can underflow too). With no gain it is the
/// output PSD over 0 (∞, or NaN for none).
pub fn input_psd(p: &Point, srcs: &[Source], f: f64) -> f64 {
    let g = p.gain.norm();
    if g == 0.0 {
        return output_psd(p, srcs, f).0 / 0.0;
    }
    srcs.iter()
        .zip(&p.z)
        .enumerate()
        .map(|(k, (s, &z))| match p.dc_limit.get(k).copied().flatten() {
            Some(v) => {
                let r = v.sqrt() / g;
                r * r
            }
            None => sq_scaled(z / g, s.psd(f)),
        })
        .sum()
}

pub struct Integral {
    /// ∫ output PSD, ∫ input-referred PSD over the band.
    pub value: [f64; 2],
    /// Estimated absolute error of each (|S₂ − S₁| summed over the final
    /// panels: 15× the Richardson estimate of the unextrapolated value).
    pub err: [f64; 2],
    pub evals: usize,
    pub converged: bool,
}

const MAX_EVALS: usize = 200_000;

/// Widest band integrated, in decades (10 starting panels per decade).
pub const MAX_BAND_DECADES: f64 = 40.0;

/// A band must be finite with 0 < fLow < fHigh, at most MAX_BAND_DECADES
/// wide (measured as a difference of logarithms, which cannot overflow).
pub fn check_band([lo, hi]: [f64; 2]) -> Result<(), String> {
    if !(lo > 0.0 && hi > lo && hi.is_finite()) {
        return Err(format!("noiseBand must satisfy 0 < fLow < fHigh (got [{lo}, {hi}])"));
    }
    let decades = hi.log10() - lo.log10();
    if decades > MAX_BAND_DECADES {
        return Err(format!(
            "noiseBand spans {decades:.0} decades (limit {MAX_BAND_DECADES:.0})"
        ));
    }
    Ok(())
}

/// ∫_{lo}^{hi} g(f) df for two integrands at once, by adaptive Simpson in
/// u = ln(f/lo) (integrand g(f)·f), starting from 10 panels per decade plus
/// the given breakpoints (pole and zero frequencies), refined globally: the
/// panel with the largest Richardson error estimate is split until the
/// summed estimate is within `rtol`·|integral| (`converged`), or MAX_EVALS
/// is reached.
/// u is measured from lo (u = ln1p((f − lo)/lo), f = lo + lo·expm1(u)), so a
/// band narrower than the spacing of ln f near it (e.g. two adjacent doubles
/// at 1e16 Hz) still has a positive width. A breakpoint is never merged
/// away: one that nearly coincides with a grid point replaces it.
pub fn integrate_log(
    g: &mut dyn FnMut(f64) -> Option<[f64; 2]>,
    lo: f64,
    hi: f64,
    breaks: &[f64],
    rtol: f64,
) -> Option<Integral> {
    let to_u = |f: f64| ((f - lo) / lo).ln_1p();
    let width = to_u(hi);
    if !(width > 0.0 && width.is_finite()) {
        return None;
    }
    // Callers validate the band (check_band); the bound keeps the grid finite
    // regardless.
    let decades = (width / std::f64::consts::LN_10).min(MAX_BAND_DECADES);
    let n = ((decades * 10.0).ceil() as usize).max(8);
    let mut us: Vec<f64> = (0..=n).map(|k| width * k as f64 / n as f64).collect();
    let mut replaced = vec![false; n + 1];
    for b in breaks.iter().filter(|&&b| b > lo && b < hi).map(|&b| to_u(b)) {
        // The nearest interior grid point, if b is that close to it: the
        // breakpoint takes its place (a pole's peak can be far narrower than
        // that distance). Otherwise b is a point of its own.
        let k = ((b / width * n as f64).round() as usize).clamp(1, n - 1);
        if (us[k] - b).abs() < 1e-9 * width && !replaced[k] {
            us[k] = b;
            replaced[k] = true;
        } else {
            us.push(b);
        }
    }
    us.sort_by(f64::total_cmp);
    us.dedup();
    let mut evals = 0usize;
    let mut eval = |u: f64, evals: &mut usize| -> Option<[f64; 2]> {
        *evals += 1;
        let f = (lo + lo * u.exp_m1()).clamp(lo, hi);
        let v = g(f)?;
        Some([v[0] * f, v[1] * f])
    };
    // Coarse pass: every panel's ends and midpoint, then its quarter points.
    let mut panels: Vec<Panel> = Vec::new();
    let mut fa = eval(us[0], &mut evals)?;
    for w in us.windows(2) {
        let (a, b) = (w[0], w[1]);
        let fm = eval(0.5 * (a + b), &mut evals)?;
        let fb = eval(b, &mut evals)?;
        panels.push(Panel::new(a, b, fa, fm, fb, &mut |u| eval(u, &mut evals))?);
        fa = fb;
    }
    // Global adaptive Simpson: split the panel with the largest error (each
    // integrand's error relative to its coarse total) until the summed error
    // is within rtol of the integral, or the evaluations run out.
    let sum = |ps: &[Panel], done: &[Panel]| {
        let (mut value, mut err) = ([0.0; 2], [0.0; 2]);
        for p in ps.iter().chain(done) {
            for i in 0..2 {
                value[i] += p.value[i];
                err[i] += p.err[i];
            }
        }
        (value, err)
    };
    let within = |value: [f64; 2], err: [f64; 2]| (0..2).all(|i| err[i] <= rtol * value[i].abs());
    let (mut value, mut err) = sum(&panels, &[]);
    let scale = value.map(|v| if v.is_finite() && v != 0.0 { v.abs() } else { 1.0 });
    let mut heap: BinaryHeap<ByErr> = panels.into_iter().map(|p| ByErr::new(p, scale)).collect();
    // Panels too narrow to split (no double strictly inside their halves).
    let mut done: Vec<Panel> = Vec::new();
    loop {
        if within(value, err) || !value.iter().chain(&err).all(|v| v.is_finite()) {
            // The running sums drift by rounding as panels come and go:
            // decide on exact sums.
            let all: Vec<Panel> = heap.iter().map(|p| p.panel.clone()).collect();
            (value, err) = sum(&all, &done);
            if within(value, err) || !value.iter().chain(&err).all(|v| v.is_finite()) {
                break;
            }
        }
        if evals + 4 > MAX_EVALS {
            break;
        }
        let Some(ByErr { panel: p, .. }) = heap.pop() else {
            break;
        };
        let m = p.u[2];
        if !(p.u[0] < p.u[1] && p.u[1] < m && m < p.u[3] && p.u[3] < p.u[4]) {
            done.push(p);
            continue;
        }
        let left = Panel::new(p.u[0], m, p.f[0], p.f[1], p.f[2], &mut |u| eval(u, &mut evals))?;
        let right = Panel::new(m, p.u[4], p.f[2], p.f[3], p.f[4], &mut |u| eval(u, &mut evals))?;
        for i in 0..2 {
            value[i] += left.value[i] + right.value[i] - p.value[i];
            err[i] += left.err[i] + right.err[i] - p.err[i];
        }
        heap.push(ByErr::new(left, scale));
        heap.push(ByErr::new(right, scale));
    }
    let all: Vec<Panel> = heap.into_iter().map(|p| p.panel).collect();
    let (value, err) = sum(&all, &done);
    Some(Integral {
        value,
        err,
        evals,
        converged: within(value, err),
    })
}

/// One Simpson panel [a, b] in u with its five samples (ends, quarter
/// points, midpoint) and the Richardson-extrapolated value of its two
/// halves, with |S₂ − S₁| as the error estimate.
#[derive(Clone)]
struct Panel {
    u: [f64; 5],
    f: [[f64; 2]; 5],
    value: [f64; 2],
    err: [f64; 2],
}

impl Panel {
    fn new(
        a: f64,
        b: f64,
        fa: [f64; 2],
        fm: [f64; 2],
        fb: [f64; 2],
        eval: &mut dyn FnMut(f64) -> Option<[f64; 2]>,
    ) -> Option<Panel> {
        let m = 0.5 * (a + b);
        let (ql, qr) = (0.5 * (a + m), 0.5 * (m + b));
        let (fl, fr) = (eval(ql)?, eval(qr)?);
        let simpson =
            |h: f64, x: [f64; 2], y: [f64; 2], z: [f64; 2]| [0, 1].map(|i| h / 6.0 * (x[i] + 4.0 * y[i] + z[i]));
        let whole = simpson(b - a, fa, fm, fb);
        let halves = [simpson(m - a, fa, fl, fm), simpson(b - m, fm, fr, fb)];
        let diff = [0, 1].map(|i| halves[0][i] + halves[1][i] - whole[i]);
        Some(Panel {
            u: [a, ql, m, qr, b],
            f: [fa, fl, fm, fr, fb],
            value: [0, 1].map(|i| halves[0][i] + halves[1][i] + diff[i] / 15.0),
            // |S₂ − S₁| itself, not the /15 Richardson estimate of S₂'s
            // error: a factor of safety, so that an isolated bad sample
            // (0/0 at a notch shared by every transfer) is refined away
            // rather than accepted as a small error.
            err: diff.map(f64::abs),
        })
    }
}

/// A panel in the max-heap by its larger relative error.
struct ByErr {
    key: f64,
    panel: Panel,
}

impl ByErr {
    fn new(panel: Panel, scale: [f64; 2]) -> ByErr {
        let key = (panel.err[0] / scale[0]).max(panel.err[1] / scale[1]);
        ByErr { key, panel }
    }
}

impl PartialEq for ByErr {
    fn eq(&self, other: &Self) -> bool {
        self.key.total_cmp(&other.key).is_eq()
    }
}

impl Eq for ByErr {}

impl PartialOrd for ByErr {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for ByErr {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.key.total_cmp(&other.key)
    }
}

/// The input-referred white (thermal + shot) PSD at s → 0 as exact
/// rational functions: 4kT·thermal.0/thermal.1 + 2q·shot.0/shot.1, over
/// `syms` (the analysis symbols plus bias currents).
pub struct LowFreq {
    pub syms: Vec<Sym>,
    pub thermal: (XPoly, XPoly),
    pub shot: (XPoly, XPoly),
    /// Largest relative difference between merged (matched) values: the
    /// parameters' and the bias currents'.
    pub mismatch: f64,
}

/// `a` with every reactive term removed: the s → 0 limit of each entry.
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

fn cramer_with(a: &[Vec<Poly>], col: usize, b: &[i128], max_terms: usize) -> Result<Poly, String> {
    let mut a = a.to_vec();
    for (r, row) in a.iter_mut().enumerate() {
        row[col] = Poly::constant(b[r]);
    }
    crate::det::det(&a, max_terms)
}

/// Builds the closed form. `vid` is the input scale (2 for a differential
/// pair driven ±1). Returns Err(reason) when there is no DC limit to give.
#[allow(clippy::too_many_arguments)]
pub fn low_freq(
    ss: &SsCircuit,
    symbols: &Symbols,
    sys: &System,
    srcs: &[Source],
    out: usize,
    rf: usize,
    vid: i128,
    max_terms: usize,
) -> Result<Result<LowFreq, String>, String> {
    let a0 = at_dc(&sys.a, ss.reactive_mask);
    if crate::det::det(&a0, max_terms)?.is_zero() {
        return Ok(Err(
            "the circuit has no DC solution path (singular at s = 0)".to_string()
        ));
    }
    let (co, cr) = (sys.node_col[out], sys.node_col[rf]);
    let num_for = |b: &[i128]| -> Result<Poly, String> {
        let pick = |c: Option<usize>| c.map(|c| cramer_with(&a0, c, b, max_terms)).unwrap_or(Ok(Poly::zero()));
        fit(sub(&pick(co)?, &pick(cr)?), max_terms)
    };
    let no_gain = || Ok(Err("no gain at DC".to_string()));
    let na = num_for(&sys.b)?;
    if na.is_zero() {
        return no_gain();
    }
    // Transfer numerators per node (current injected there), memoized.
    let mut per_node: HashMap<usize, Poly> = HashMap::new();
    let mut node_num = |n: usize| -> Result<Poly, String> {
        if let Some(p) = per_node.get(&n) {
            return Ok(p.clone());
        }
        let p = match sys.node_col[n] {
            Some(k) => {
                let mut b = vec![0i128; sys.dim];
                b[k] = 1;
                num_for(&b)?
            }
            None => Poly::zero(),
        };
        per_node.insert(n, p.clone());
        Ok(p)
    };

    // Symbols: the analysis symbols, then one per bias current (matched
    // devices' currents merged like their parameters).
    let mut syms = symbols.syms.clone();
    let nbase = syms.len();
    let param_index = |name: &str| ss.params.iter().position(|p| p.name == name);
    // A device's match class: its gm (MOSFET, BJT) or r_d (diode).
    let dev_class = |el: &str| {
        param_index(&format!("gm_{el}"))
            .or_else(|| param_index(&format!("rd_{el}")))
            .map(|p| symbols.class[p])
    };
    let mut mismatch = symbols.mismatch;
    let mut cur_index: Vec<Option<usize>> = Vec::new();
    // Each current symbol's kind (I_C, I_B, I_D), by index from nbase: only
    // currents of the same kind merge, whatever their names or values.
    let mut kinds: Vec<(&str, &str)> = Vec::new();
    for s in srcs {
        let Some(SymPsd {
            of: SymOf::Current(c), ..
        }) = &s.sym
        else {
            cur_index.push(None);
            continue;
        };
        let twin = (nbase..syms.len()).find(|&k| {
            let t = &syms[k];
            kinds[k - nbase] == (c.base, c.sub)
                && dev_class(&t.elements[0]).is_some()
                && dev_class(&t.elements[0]) == dev_class(&s.element)
                && (c.value.is_nan() && t.value.is_nan()
                    || (t.value - c.value).abs() <= MATCH_REL * t.value.abs().max(c.value.abs()))
        });
        match twin {
            Some(k) => {
                if !c.value.is_nan() {
                    let t = syms[k].value;
                    mismatch = mismatch.max((t - c.value).abs() / t.abs().max(c.value.abs()));
                }
                syms[k].elements.push(s.element.clone());
                syms[k].latex = sym::merged_dev_latex(c.base, c.sub, &syms[k].elements);
                cur_index.push(Some(k));
            }
            None => {
                syms.push(Sym {
                    name: c.name.clone(),
                    latex: dev_latex_sub(c.base, c.sub, &s.element),
                    value: c.value,
                    inverted: false,
                    reactive: false,
                    role: Role::Current,
                    unit: "A",
                    elements: vec![s.element.clone()],
                    output_r: false,
                    leakage: false,
                });
                kinds.push((c.base, c.sub));
                cur_index.push(Some(syms.len() - 1));
            }
        }
    }
    let nsym = syms.len();
    let x = |p: &Poly| -> Result<XPoly, String> { Ok(XPoly::from_poly(p, &symbols.class, nbase)?.padded(nsym)) };
    // XPoly::mul and XPoly::add, without a map keyed by Vec<u8>.
    let mul = |a: &XPoly, b: &XPoly| -> Result<XPoly, String> {
        Ok(XPoly {
            terms: crate::gcd::mul_terms(&a.terms, &b.terms, max_terms)?,
        })
    };
    let xa = x(&na)?;
    // The gain at s = 0 can vanish once matched symbols merge, or at the
    // numeric values (a balanced bridge): zero within its evaluation bound.
    if xa.is_zero() {
        return no_gain();
    }
    let (g0, g0_err) = Expr::from_mna(&xa, &XPoly::constant(1, nsym), &syms).eval_with_bound(Complex64::new(0.0, 0.0));
    // (Symbolic mode: no values, g0 is NaN.)
    if !g0.re.is_nan() && (g0.norm() == 0.0 || g0_err >= 1.0) {
        return no_gain();
    }
    let na2 = mul(&xa, &xa)?;
    let mut groups: [(XPoly, i128); 2] = [(XPoly::default(), 1), (XPoly::default(), 1)];
    // Common denominator per group: the lcm of the PSD fractions' denominators.
    for s in srcs.iter().filter_map(|s| s.sym.as_ref()) {
        let g = &mut groups[(s.scale == Scale::TwoQ) as usize];
        g.1 = lcm(g.1, s.den);
    }
    for (k, s) in srcs.iter().enumerate() {
        let Some(ps) = &s.sym else { continue };
        let var = match &ps.of {
            SymOf::Param(name) => match param_index(name) {
                Some(p) => XPoly::var(symbols.class[p], nsym),
                None => continue,
            },
            SymOf::Current(_) => XPoly::var(cur_index[k].expect("current symbol"), nsym),
        };
        let nk = x(&fit(sub(&node_num(s.a)?, &node_num(s.b)?), max_terms)?)?;
        if nk.is_zero() {
            continue;
        }
        let g = &mut groups[(ps.scale == Scale::TwoQ) as usize];
        let w = ps.num * (g.1 / ps.den) * vid * vid;
        let term = mul(&mul(&nk, &nk)?, &var)?.scaled(w)?;
        g.0 = add(std::mem::take(&mut g.0), term)?;
        if g.0.terms.len() > max_terms {
            return Err(too_large(max_terms));
        }
    }
    let [(th, lt), (sh, ls)] = groups;
    Ok(Ok(LowFreq {
        syms,
        thermal: (th, na2.scaled(lt)?),
        shot: (sh, na2.scaled(ls)?),
        mismatch,
    }))
}

/// The error of an over-budget determinant or product (det.rs), for the
/// sums and differences built from them here.
fn too_large(max_terms: usize) -> String {
    format!("exact expression too large (over {max_terms} terms); simplify the circuit or analyze a smaller block")
}

/// `p` (a difference of two numerators, up to twice their terms) within the
/// term budget.
fn fit(p: Poly, max_terms: usize) -> Result<Poly, String> {
    if p.len() > max_terms {
        Err(too_large(max_terms))
    } else {
        Ok(p)
    }
}

/// a + b (each sorted by exponent, as `XPoly` keeps them), merged.
fn add(a: XPoly, b: XPoly) -> Result<XPoly, String> {
    let mut terms = Vec::with_capacity(a.terms.len() + b.terms.len());
    let (mut a, mut b) = (a.terms.into_iter().peekable(), b.terms.into_iter().peekable());
    loop {
        let ord = match (a.peek(), b.peek()) {
            (Some(x), Some(y)) => x.0.cmp(&y.0),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => break,
        };
        match ord {
            std::cmp::Ordering::Less => terms.extend(a.next()),
            std::cmp::Ordering::Greater => terms.extend(b.next()),
            std::cmp::Ordering::Equal => {
                let ((e, x), (_, y)) = (a.next().unwrap(), b.next().unwrap());
                let c = x.checked_add(y).ok_or("coefficient overflow")?;
                if c != 0 {
                    terms.push((e, c));
                }
            }
        }
    }
    Ok(XPoly { terms })
}

fn lcm(a: i128, b: i128) -> i128 {
    let (mut x, mut y) = (a, b);
    while y != 0 {
        (x, y) = (y, x % y);
    }
    a / x * b
}

/// A group's expression after exact cancellation, or None when it is zero.
pub fn group_expr(g: &(XPoly, XPoly), syms: &[Sym]) -> Option<Expr> {
    if g.0.is_zero() {
        return None;
    }
    let (n, d) = cancel(&g.0, &g.1);
    Some(Expr::from_mna(&n, &d, syms))
}

/// Value of `scale`·expr at s = 0.
pub fn group_value(e: Option<&Expr>, scale: Scale) -> f64 {
    let k = match scale {
        Scale::FourKT => FOUR_KT,
        Scale::TwoQ => TWO_Q,
    };
    e.map(|e| k * e.eval(Complex64::new(0.0, 0.0)).re).unwrap_or(0.0)
}

/// `4kT\left(\frac{2}{3 g_{m1}} + \frac{1}{g_{m1}^{2} R_{D}}\right)`: a
/// monomial denominator is distributed over the numerator's terms.
pub fn group_latex(e: &Expr, prefix: &str, syms: &[Sym]) -> String {
    if e.den.len() != 1 || e.den[0].spow != 0 {
        return format!("{prefix}\\,{}", e.latex(syms));
    }
    let d = &e.den[0];
    let mut body = String::new();
    for (i, t) in e.num.iter().enumerate() {
        let neg = (t.coeff < 0) != (d.coeff < 0);
        if i == 0 {
            if neg {
                body.push('-');
            }
        } else {
            body.push_str(if neg { " - " } else { " + " });
        }
        body.push_str(&quotient(t, d, syms));
    }
    if e.num.len() == 1 {
        format!("{prefix}\\,{body}")
    } else {
        format!("{prefix}\\left({body}\\right)")
    }
}

/// |t/d| as a reduced fraction of monomials.
fn quotient(t: &Term, d: &Term, syms: &[Sym]) -> String {
    let (mut p, mut q) = (t.coeff.unsigned_abs(), d.coeff.unsigned_abs());
    let (mut a, mut b) = (p, q);
    while b != 0 {
        (a, b) = (b, a % b);
    }
    p /= a;
    q /= a;
    let up: Vec<u8> = t.e.iter().zip(&d.e).map(|(&x, &y)| x.saturating_sub(y)).collect();
    let down: Vec<u8> = t.e.iter().zip(&d.e).map(|(&x, &y)| y.saturating_sub(x)).collect();
    let mono = |c: u128, e: &[u8]| -> String {
        let mut parts: Vec<String> = Vec::new();
        let f = factors(e, syms);
        if c != 1 || f.is_empty() {
            parts.push(c.to_string());
        }
        parts.extend(f.into_iter().map(|(k, x)| power_latex(&syms[k].latex, x)));
        parts.join(" ")
    };
    let top = mono(p, &up);
    if q == 1 && down.iter().all(|&x| x == 0) {
        top
    } else {
        format!("\\frac{{{top}}}{{{}}}", mono(q, &down))
    }
}

/// JSON for one numeric spectrum.
pub fn spectrum(points: &[(f64, Option<f64>)]) -> Value {
    Value::Array(
        points
            .iter()
            .map(|&(f, v)| json!({ "f": f, "v2": v.filter(|v| v.is_finite()) }))
            .collect(),
    )
}

/// Everything `report` needs from the analysis.
pub struct Ctx<'a> {
    pub net: &'a Netlist,
    pub op: Option<&'a Op>,
    /// Every junction kept: the numeric spectra always use it.
    pub full: &'a SsCircuit,
    /// The analysis model (proven omissions applied) and its symbols.
    pub ss: &'a SsCircuit,
    pub symbols: &'a Symbols,
    /// Symbols of `full` and their warnings, built on demand (fallback for
    /// the closed form).
    pub full_symbols: &'a dyn Fn() -> (Symbols, Vec<String>),
    pub excite: &'a crate::ss::Excite,
    pub out: usize,
    pub rf: usize,
    pub vid: i128,
    pub input_is_v: bool,
    pub freqs: &'a [f64],
    pub band: Option<[f64; 2]>,
    pub tol: f64,
    pub max_terms: usize,
    /// Pole frequencies (Hz): breakpoints for the band integral.
    pub poles_hz: Vec<f64>,
    /// The gain's zeros (re, im) in Hz: breakpoints, and on the jω axis a
    /// singularity of the input-referred spectrum.
    pub zeros_hz: Vec<(f64, f64)>,
}

/// A zero with |re| ≤ AXIS_REL·|im| is taken to lie on the jω axis: root
/// finding leaves |re| ~ 1e-15·|im| on lossless LC and twin-T notches, while
/// a notch of Q up to 5e8 is integrated (its zero is a breakpoint).
const AXIS_REL: f64 = 1e-9;

/// Relative accuracy of a computed gain zero's frequency (the roots of the
/// exact numerator, to about 1e-15 on lossless notches).
const ZERO_REL: f64 = 1e-12;

/// LU accuracy bound (κ₁·eps) above which the noise results warn.
const LU_WARN: f64 = 1e-6;

/// Relative accuracy asked of the band integral.
const INTEGRAL_RTOL: f64 = 1e-6;

/// The source's PSD formula; `mult` is a MOSFET's multiplicity M.
fn kind_latex(s: &Source, mult: f64) -> String {
    match (s.kind, &s.sym) {
        ("flicker", _) => match s.element.chars().next().map(|c| c.to_ascii_uppercase()) {
            Some('M') if mult != 1.0 => "\\frac{K_F g_m^{2}}{C_{ox} M W L f^{A_F}}".to_string(),
            Some('M') => "\\frac{K_F g_m^{2}}{C_{ox} W L f^{A_F}}".to_string(),
            Some('Q') => "\\frac{K_F I_B^{A_F}}{f}".to_string(),
            _ => "\\frac{K_F I_D^{A_F}}{f}".to_string(),
        },
        ("thermal", _) if s.element.to_ascii_uppercase().starts_with('M') => "\\frac{2}{3} 4kT g_m".to_string(),
        ("thermal", _) => "\\frac{4kT}{R}".to_string(),
        ("shot_c", _) => "2qI_C".to_string(),
        ("shot_b", _) => "2qI_B".to_string(),
        _ => "2qI_D".to_string(),
    }
}

pub fn report(c: &Ctx, warnings: &mut Vec<String>) -> Result<Value, String> {
    if let Some(band) = c.band {
        check_band(band)?;
    }
    // A one-sided spectrum: flicker's f^-AF has no meaning below 0 Hz.
    if let Some(f) = c.freqs.iter().find(|&&f| f < 0.0) {
        return Err(format!("noise frequencies must be 0 Hz or more (got {f})"));
    }
    let srcs = sources(c.net, c.op);
    let mult_of = |name: &str| {
        c.net
            .elements
            .iter()
            .find_map(|e| match &e.kind {
                Kind::M { mult, .. } if e.name == name => Some(*mult),
                _ => None,
            })
            .unwrap_or(1.0)
    };
    let in_unit = if c.input_is_v { "V^2/Hz" } else { "A^2/Hz" };
    let src_json: Vec<Value> = srcs
        .iter()
        .map(|s| {
            json!({
                "element": s.element, "kind": s.kind, "psd": kind_latex(s, mult_of(&s.element)),
                "white": if s.flicker.is_some() { Value::Null } else { json!(s.white).as_f64().map(Value::from).unwrap_or(Value::Null) },
                "flicker": s.flicker.map(|(k, x)| json!({ "coef": k, "exp": x })),
            })
        })
        .collect();
    let symbolic = c.op.is_none();

    // Closed form at s → 0.
    let closed = |ss: &SsCircuit, symbols: &Symbols| -> Result<Result<LowFreq, String>, String> {
        let sys = crate::ss::system(c.net, ss, c.excite);
        low_freq(ss, symbols, &sys, &srcs, c.out, c.rf, c.vid, c.max_terms)
    };
    // Over the term budget (or any other failure of the exact form), the
    // closed form is unavailable with the reason; the spectra still follow.
    let lf = closed(c.ss, c.symbols).and_then(|r| r);

    if symbolic {
        let input_low = match lf {
            Ok(lf) => low_freq_json(&lf, None, c.tol),
            Err(why) => json!({ "unavailable": why }),
        };
        return Ok(json!({
            "outputUnit": "V^2/Hz", "inputUnit": in_unit, "temperature": TEMP,
            "sources": src_json, "output": [], "input": [], "contributors": [],
            "integrated": null, "inputLowFreq": input_low,
        }));
    }

    let fsys = crate::ss::system(c.net, c.full, c.excite);
    let num = Numeric {
        ss: c.full,
        sys: &fsys,
        out: c.out,
        rf: c.rf,
        vid: c.vid as f64,
    };
    let mut output = Vec::new();
    let mut input = Vec::new();
    let mut contributors = Vec::new();
    let mut lu_worst = 0.0f64;
    for &f in c.freqs {
        match num.at_with_cond(f, &srcs, true) {
            Some((p, err)) => {
                lu_worst = lu_worst.max(err);
                let (total, parts) = output_psd(&p, &srcs, f);
                output.push((f, Some(total)));
                input.push((f, Some(input_psd(&p, &srcs, f))));
                let mut items: Vec<(usize, f64)> = parts.iter().copied().enumerate().collect();
                items.sort_by(|a, b| b.1.total_cmp(&a.1));
                // The largest sources; the rest as one count and share, so the
                // output stays bounded with thousands of sources.
                let rest = items.split_off(items.len().min(MAX_CONTRIBUTORS));
                let rest_v2: f64 = rest.iter().map(|&(_, v)| v).sum();
                let list: Vec<Value> = items
                    .iter()
                    .map(|&(k, v)| {
                        json!({
                            "element": srcs[k].element, "kind": srcs[k].kind,
                            "v2": num_or_null(v),
                            "fraction": num_or_null(if total > 0.0 { v / total } else { 0.0 }),
                        })
                    })
                    .collect();
                let mut point = json!({ "f": f, "sources": list });
                if !rest.is_empty() {
                    point["omitted"] = json!({
                        "count": rest.len(), "v2": num_or_null(rest_v2),
                        "fraction": num_or_null(if total > 0.0 { rest_v2 / total } else { 0.0 }),
                    });
                }
                contributors.push(point);
            }
            None => {
                output.push((f, None));
                input.push((f, None));
                contributors.push(json!({ "f": f, "sources": [] }));
            }
        }
    }
    if lu_worst > LU_WARN {
        warnings.push(format!(
            "noise: the circuit is ill-conditioned; spectra are accurate to about {lu_worst:.0e}"
        ));
    }

    let integrated = match c.band {
        None => Value::Null,
        Some([lo, hi]) => {
            // A gain zero on the jω axis in the band: S_in = S_out/|H|² is not
            // integrable across it unless every noise transfer vanishes there
            // too (then S_in stays level). Without that, S_in at the zero
            // stands far above its neighbours (|H|² falls by (1e-4/root error)²).
            let s_in = |f: f64| num.at(f, &srcs).map(|p| input_psd(&p, &srcs, f));
            let singular = c
                .zeros_hz
                .iter()
                .filter(|&&(re, im)| im != 0.0 && re.abs() <= AXIS_REL * im.abs())
                .map(|&(_, im)| im.abs())
                // In the closed band: at an endpoint S_in ~ 1/(f − f0)² is
                // not integrable either. A zero within ZERO_REL of an endpoint
                // is taken to be at it (the root's own accuracy); one any
                // farther outside leaves S_in finite across the band.
                .filter(|&f0| f0 >= lo * (1.0 - ZERO_REL) && f0 <= hi * (1.0 + ZERO_REL))
                .find(|&f0| match s_in(f0) {
                    Some(v) if v.is_infinite() => true,
                    Some(v) => [1.0 - 1e-4, 1.0 + 1e-4]
                        .iter()
                        .all(|k| matches!(s_in(f0 * k), Some(n) if v > 100.0 * n)),
                    None => false,
                });
            // The input never reaches the output (the gain is zero across the
            // band): the output noise is still well defined, the input-referred
            // one is not.
            let zero_gain = singular.is_none()
                && [lo, (lo * hi).sqrt(), hi]
                    .iter()
                    .all(|&f| matches!(num.at_with_cond(f, &srcs, false), Some((p, _)) if p.gain.norm() == 0.0));
            let mut breaks = c.poles_hz.clone();
            breaks.extend(c.zeros_hz.iter().map(|&(re, im)| re.hypot(im)));
            // LU accuracy of the solves the quadrature actually makes.
            let mut band_lu = 0.0f64;
            let mut g = |f: f64| -> Option<[f64; 2]> {
                let (p, err) = num.at_with_cond(f, &srcs, true)?;
                band_lu = band_lu.max(err);
                let (total, _) = output_psd(&p, &srcs, f);
                let input = if singular.is_some() || zero_gain {
                    0.0
                } else {
                    input_psd(&p, &srcs, f)
                };
                Some([total, input])
            };
            let r = integrate_log(&mut g, lo, hi, &breaks, INTEGRAL_RTOL);
            if r.as_ref().is_some_and(|r| !r.converged) {
                warnings.push("noise: the band integral did not fully converge".to_string());
            }
            // The band's own solves, at the spectra's threshold: a band can
            // cross an ill-conditioned stretch the spectrum points miss.
            if band_lu > LU_WARN {
                warnings.push(format!(
                    "noise: the circuit is ill-conditioned in the band; the integrals are accurate to about {band_lu:.0e}"
                ));
            }
            // The output integral alone, the input-referred one unavailable.
            let output_only = |r: &Integral, why: String| {
                let rel = if r.value[0] > 0.0 { r.err[0] / r.value[0] } else { 0.0 };
                json!({
                    "fLow": lo, "fHigh": hi,
                    "outputRms": r.value[0].sqrt(), "inputRms": null,
                    "outputV2": r.value[0], "inputV2": null,
                    "relError": rel + band_lu,
                    "evaluations": r.evals, "converged": r.converged,
                    "unavailable": why,
                })
            };
            match (r, singular) {
                (None, _) => json!({ "fLow": lo, "fHigh": hi, "outputRms": null, "inputRms": null,
                                     "unavailable": "the circuit has no solution at a frequency in the band" }),
                (Some(r), _) if !r.value[0].is_finite() => json!({
                    "fLow": lo, "fHigh": hi, "outputRms": null, "inputRms": null,
                    "unavailable": "the output spectrum is unbounded in the band",
                }),
                (Some(r), Some(f0)) => output_only(
                    &r,
                    format!(
                        "the input-referred spectrum is unbounded in the band (the gain is zero at {})",
                        hz_text(f0)
                    ),
                ),
                (Some(r), None) if zero_gain => output_only(
                    &r,
                    "the input does not reach the output, so there is no input-referred noise".to_string(),
                ),
                (Some(r), None) if r.value[1].is_finite() => {
                    let rel = (0..2)
                        .map(|i| if r.value[i] > 0.0 { r.err[i] / r.value[i] } else { 0.0 })
                        .fold(0.0, f64::max);
                    json!({
                        "fLow": lo, "fHigh": hi,
                        "outputRms": r.value[0].sqrt(), "inputRms": r.value[1].sqrt(),
                        "outputV2": r.value[0], "inputV2": r.value[1],
                        // Estimated relative error of the integrals (the rms
                        // values' is half of it), plus LU rounding.
                        "relError": rel + band_lu,
                        "evaluations": r.evals, "converged": r.converged,
                    })
                }
                // A sample landed on a zero of the gain.
                (Some(r), None) => output_only(
                    &r,
                    "the input-referred spectrum is unbounded in the band (the gain is zero in it)".to_string(),
                ),
            }
        }
    };

    // Numeric white input-referred PSD at DC on the full model: the check.
    let white: Vec<Source> = srcs.iter().filter(|s| s.flicker.is_none()).cloned().collect();
    let dc_ref = num
        .at_with_cond(0.0, &white, true)
        .map(|(p, err)| (input_psd(&p, &white, 0.0), err));
    let input_low = match lf {
        Err(why) => json!({ "unavailable": why }),
        Ok(lf) => {
            let mut v = low_freq_json(&lf, dc_ref, c.tol);
            if v["check"]["ok"] == json!(false) && c.ss.params.len() != c.full.params.len() {
                // A proven-negligible junction for the gain need not be one
                // for the noise: redo the closed form on the full model. If
                // that fails, the reduced form is known wrong: give the reason
                // instead.
                // Its symbols' warnings (e.g. a match the full model rejects)
                // describe the form now given.
                let (fs, fw) = (c.full_symbols)();
                for w in fw {
                    if !warnings.contains(&w) {
                        warnings.push(w);
                    }
                }
                v = match closed(c.full, &fs).and_then(|r| r) {
                    Ok(lf) => low_freq_json(&lf, dc_ref, c.tol),
                    Err(why) => json!({
                        "unavailable": format!(
                            "{why} (the junctions omitted for the gain matter for the noise, so the closed form needs the full model)"
                        )
                    }),
                };
            }
            if v["check"]["ok"] == json!(false) {
                warnings.push(format!(
                    "noise: closed form and numeric solution differ ({:.2e})",
                    v["check"]["maxRelDiff"].as_f64().unwrap_or(f64::NAN)
                ));
            }
            v
        }
    };

    Ok(json!({
        "outputUnit": "V^2/Hz", "inputUnit": in_unit, "temperature": TEMP,
        "sources": src_json,
        "output": spectrum(&output), "input": spectrum(&input),
        "contributors": contributors,
        "integrated": integrated,
        "inputLowFreq": input_low,
    }))
}

/// ngspice's floor on a junction current before `^AF` in flicker noise.
const N_MINLOG: f64 = 1e-38;

/// Sources listed per frequency; any more are summed into `omitted`.
pub const MAX_CONTRIBUTORS: usize = 32;

/// 159.155 kHz.
fn hz_text(f: f64) -> String {
    let (v, unit) = [(1e9, "GHz"), (1e6, "MHz"), (1e3, "kHz")]
        .into_iter()
        .find(|&(k, _)| f >= k)
        .map(|(k, u)| (f / k, u))
        .unwrap_or((f, "Hz"));
    format!("{} {unit}", (v * 1e3).round() / 1e3)
}

fn num_or_null(v: f64) -> Value {
    if v.is_finite() {
        json!(v)
    } else {
        Value::Null
    }
}

/// Value of 4kT·thermal + 2q·shot and its relative evaluation bound.
fn pair_value(th: Option<&Expr>, sh: Option<&Expr>) -> (f64, f64) {
    let bound = [th, sh]
        .into_iter()
        .flatten()
        .map(|e| e.eval_with_bound(Complex64::new(0.0, 0.0)).1)
        .fold(0.0, f64::max);
    (group_value(th, Scale::FourKT) + group_value(sh, Scale::TwoQ), bound)
}

/// LaTeX of 4kT·thermal + 2q·shot.
fn pair_latex(th: Option<&Expr>, sh: Option<&Expr>, syms: &[Sym]) -> String {
    let mut parts = Vec::new();
    if let Some(e) = th {
        parts.push(group_latex(e, "4kT", syms));
    }
    if let Some(e) = sh {
        parts.push(group_latex(e, "2q", syms));
    }
    if parts.is_empty() {
        "0".to_string()
    } else {
        parts.join(" + ")
    }
}

/// A thermal + shot pair of expressions.
type Pair = (Option<Expr>, Option<Expr>);

fn pair_of(t: &(XPoly, XPoly), h: &(XPoly, XPoly), syms: &[Sym]) -> Pair {
    (group_expr(t, syms), group_expr(h, syms))
}

fn terms(p: &Pair) -> usize {
    p.0.as_ref().map(|e| e.term_count()).unwrap_or(0) + p.1.as_ref().map(|e| e.term_count()).unwrap_or(0)
}

/// JSON of one form: LaTeX and plain num/den per group (coefficients of 4kT
/// and of 2q) only when small enough to read.
fn pair_json(p: &Pair, syms: &[Sym]) -> (Value, f64, f64) {
    let (value, bound) = pair_value(p.0.as_ref(), p.1.as_ref());
    let small = terms(p) <= crate::analyze::LATEX_TERM_LIMIT;
    // LaTeX only when it will be shown: building it walks every term.
    let latex = small.then(|| pair_latex(p.0.as_ref(), p.1.as_ref(), syms));
    let readable = terms(p) <= crate::distortion::PLAIN_TERM_LIMIT;
    let plain = |e: Option<&Expr>| {
        e.map(|e| {
            let (n, d) = e.plain(syms);
            json!({ "num": n, "den": d })
        })
    };
    let v = json!({
        "latex": latex,
        "value": num_or_null(value),
        "thermal": if readable { json!(plain(p.0.as_ref())) } else { Value::Null },
        "shot": if readable { json!(plain(p.1.as_ref())) } else { Value::Null },
        "terms": terms(p),
    });
    (v, value, bound)
}

/// A group's r_o → ∞ leading order.
fn lead_ro(g: &(XPoly, XPoly), syms: &[Sym]) -> (XPoly, XPoly) {
    (sym::leading_order(&g.0, syms), sym::leading_order(&g.1, syms))
}

fn low_freq_json(lf: &LowFreq, dc_ref: Option<(f64, f64)>, tol: f64) -> Value {
    let syms = &lf.syms;
    let exact = pair_of(&lf.thermal, &lf.shot, syms);
    let (exact_json, value, bound) = pair_json(&exact, syms);
    let numeric = value.is_finite();
    let rel = |v: f64| {
        if value != 0.0 {
            (v - value).abs() / value.abs()
        } else {
            v.abs()
        }
    };
    let symbols_json: Vec<Value> = syms
        .iter()
        .filter(|s| s.role == Role::Current)
        .map(|s| json!({ "name": s.name, "latex": s.latex, "value": num_or_null(s.value), "unit": s.unit, "elements": s.elements }))
        .collect();

    // Display: without junction leakage (r_bs, r_bd, r_μ → ∞) unless that
    // moves the value by more than LEAKAGE_REL, as for the other quantities.
    let leaky = |e: &[u8]| e.iter().zip(syms).any(|(&x, s)| s.leakage && x > 0);
    let drop = |g: &(XPoly, XPoly)| {
        let f = |p: &XPoly| XPoly {
            terms: p.terms.iter().filter(|(e, _)| !leaky(e)).cloned().collect(),
        };
        (f(&g.0), f(&g.1))
    };
    let has_leak = [&lf.thermal, &lf.shot]
        .iter()
        .any(|g| g.0.terms.iter().chain(&g.1.terms).any(|(e, _)| leaky(e)));
    // The display form's groups and expressions (`bp`): the exact ones
    // unless leakage is dropped.
    let dropped;
    let mut base = (&lf.thermal, &lf.shot);
    let mut dropped_pair = None;
    let mut display = exact_json.clone();
    display["same"] = json!(true);
    display["relError"] = json!(0.0);
    if has_leak {
        let (dt, ds) = (drop(&lf.thermal), drop(&lf.shot));
        let ok = |g: &(XPoly, XPoly)| g.0.is_zero() || !g.1.is_zero();
        let dp = pair_of(&dt, &ds, syms);
        let (dj, dv, _) = pair_json(&dp, syms);
        if ok(&dt) && ok(&ds) && (!numeric || rel(dv) <= crate::analyze::LEAKAGE_REL) {
            display = dj;
            display["same"] = json!(false);
            display["relError"] = if numeric { num_or_null(rel(dv)) } else { Value::Null };
            dropped = (dt, ds);
            base = (&dropped.0, &dropped.1);
            dropped_pair = Some(dp);
        } else {
            display["leakageMatters"] = json!(true);
        }
    }
    // Merged matched values take the first member's; members agree to
    // `mismatch`, which moves each group by at most that per merged factor,
    // amplified by cancellation (as the other quantities' check).
    let merge = if lf.mismatch > 0.0 {
        [&exact.0, &exact.1]
            .into_iter()
            .flatten()
            .map(|e| lf.mismatch * e.max_degree() as f64 * e.cancellation(Complex64::new(0.0, 0.0)))
            .fold(0.0, f64::max)
    } else {
        0.0
    };
    // The exact pair, kept when the display form drops leakage: the fallback
    // when even the display form is outside the tolerance.
    let exact_fallback = dropped_pair.as_ref().map(|_| exact.clone());
    let bp = dropped_pair.unwrap_or(exact);

    // Simplified: the r_o → ∞ leading order of the display form, then the
    // coarsest magnitude pruning; the smallest form within `tol`.
    // In symbolic mode also g_mb → 0, as for the other quantities.
    let lead = |g: &(XPoly, XPoly)| {
        let l = lead_ro(g, syms);
        if numeric {
            l
        } else {
            (sym::body_order(&l.0, syms), sym::body_order(&l.1, syms))
        }
    };
    let (lt, ls) = (lead(base.0), lead(base.1));
    let lp = if (&lt, &ls) == base {
        bp.clone()
    } else {
        pair_of(&lt, &ls, syms)
    };
    // Whether dropping g_mb changed what is shown (its terms can cancel).
    let body = !numeric && {
        let latex = |p: &Pair| pair_json(p, syms).0["latex"].clone();
        latex(&lp) != latex(&pair_of(&lead_ro(base.0, syms), &lead_ro(base.1, syms), syms))
    };
    let val = |p: &Pair| group_value(p.0.as_ref(), Scale::FourKT) + group_value(p.1.as_ref(), Scale::TwoQ);
    let mut cands: Vec<(Pair, &str)> = vec![(lp.clone(), "leading order (ro ≫ R, 1/gm)")];
    if numeric {
        // Prune the leading order when it is within tol, else the display
        // form itself: only the former assumes r_o → ∞.
        let from_lead = rel(val(&lp)) <= tol;
        let start = if from_lead { lp } else { bp.clone() };
        for eps in Expr::prune_levels(tol) {
            let p = (
                start.0.as_ref().map(|e| e.prune(eps, syms)),
                start.1.as_ref().map(|e| e.prune(eps, syms)),
            );
            if terms(&p) < terms(&start) && rel(val(&p)) <= tol {
                let method = if from_lead {
                    "leading order, small terms dropped"
                } else {
                    "small terms dropped"
                };
                cands.push(((p.0.map(|e| e.cancelled(syms)), p.1.map(|e| e.cancelled(syms))), method));
                break;
            }
        }
        cands.retain(|(p, _)| rel(val(p)) <= tol);
        // The display form qualifies if within tol; under a tolerance tighter
        // than its own leakage error, the exact form does.
        match exact_fallback {
            Some(ex) if rel(val(&bp)) > tol => cands.push((ex, "exact form")),
            _ => cands.push((bp, "display form")),
        }
    }
    let (sp, method) = cands.into_iter().min_by_key(|(p, _)| terms(p)).expect("one candidate");
    let (mut simplified, sv, _) = pair_json(&sp, syms);
    simplified["relError"] = if numeric { num_or_null(rel(sv)) } else { Value::Null };
    simplified["method"] = json!(method);
    if method.starts_with("leading order") {
        let assumption = if body {
            crate::analyze::HAND_BODY
        } else {
            crate::analyze::HAND
        };
        simplified["assumption"] = json!(assumption);
    }
    simplified["tolerance"] = json!(tol);

    let check = match dc_ref {
        Some((want, lu)) if numeric => {
            let diff = if want != 0.0 || value != 0.0 {
                (value - want).abs() / want.abs().max(value.abs())
            } else {
                0.0
            };
            json!({ "ok": diff <= 1e-9 + 8.0 * lu + 4.0 * bound + 4.0 * merge, "maxRelDiff": diff })
        }
        _ => Value::Null,
    };
    json!({
        "unit": "per Hz",
        "exact": exact_json,
        "display": display,
        "simplified": simplified,
        "currents": symbols_json,
        "check": check,
    })
}
