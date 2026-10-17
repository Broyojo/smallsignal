//! Display forms of rational functions: resistances instead of
//! conductances, common factors cancelled, terms ordered by magnitude, and a
//! simplified form that drops numerically small terms.

use crate::sym::{Sym, XPoly};
use num_complex::Complex64;

#[derive(Clone, Debug)]
pub struct Term {
    pub coeff: i128,
    /// Exponent of each displayed symbol (resistances as R, not 1/R).
    pub e: Vec<u8>,
    pub spow: u32,
    /// ln(|coeff| · Π |factor values|), excluding s: kept in log form because
    /// products of resistances like 1e15 Ω (gmin-level rπ) overflow f64.
    pub lmag: f64,
    /// Sign of coeff · Π factor values.
    pub sign: f64,
}

#[derive(Clone, Debug)]
pub struct Expr {
    pub num: Vec<Term>,
    pub den: Vec<Term>,
}

fn gcd(a: i128, b: i128) -> i128 {
    let (mut a, mut b) = (a.unsigned_abs(), b.unsigned_abs());
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a as i128
}

/// Per symbol: ln|value|, whether the value is negative, and whether it is
/// symbolic-only (NaN), so `term` takes no logarithms per term.
struct Logs(Vec<(f64, bool, bool)>);

impl Logs {
    fn new(syms: &[Sym]) -> Logs {
        Logs(
            syms.iter()
                .map(|s| (s.value.abs().ln(), s.value < 0.0, s.value.is_nan()))
                .collect(),
        )
    }
}

/// (lmag, sign) of `term`.
fn magnitude(coeff: i128, e: &[u8], logs: &Logs) -> (f64, f64) {
    let mut lmag = (coeff.unsigned_abs() as f64).ln();
    // Symbol values can be negative (e.g. an inverting controlled source).
    let mut sign = coeff.signum() as f64;
    let mut symbolic = false;
    for (k, &x) in e.iter().enumerate() {
        if x == 0 {
            continue;
        }
        let (ln, negative, nan) = logs.0[k];
        if nan {
            symbolic = true;
        } else {
            lmag += x as f64 * ln;
            if negative && x % 2 == 1 {
                sign = -sign;
            }
        }
    }
    if symbolic {
        // Symbolic-only symbols have no values; order those terms by
        // coefficient alone, and give them no numeric value.
        lmag = (coeff.unsigned_abs() as f64).ln();
        sign = f64::NAN;
    }
    (lmag, sign)
}

fn term(coeff: i128, e: Vec<u8>, spow: u32, logs: &Logs) -> Term {
    let (lmag, sign) = magnitude(coeff, &e, logs);
    Term {
        coeff,
        e,
        spow,
        lmag,
        sign,
    }
}

/// A term before normalization: coefficient, exponents, power of s.
type Raw = (i128, Vec<u8>, u32);

/// Sorts by power of s, then largest magnitude, then highest degree, then
/// earlier symbols first (g_{m2} + g_{mb2}, r_{o1} + r_{o2}); stable. The
/// keys are computed once per term: the first three packed into one
/// integer, then the leading exponents.
fn sort_terms(ts: &mut Vec<Term>) {
    let mut keyed: Vec<(u128, u64, u32)> = ts
        .iter()
        .enumerate()
        .map(|(i, t)| {
            // f64::total_cmp order as an unsigned integer.
            let b = t.lmag.to_bits() as i64;
            let lm = ((b ^ ((((b >> 63) as u64) >> 1) as i64)) as u64) ^ (1 << 63);
            let key = (t.spow as u128) << 96 | ((!lm) as u128) << 32 | (!degree(&t.e)) as u128;
            // The first 8 exponents, zero-padded: where these differ they
            // order the vectors as the vectors do (descending, so negated).
            let mut head = [0u8; 8];
            let n = t.e.len().min(8);
            head[..n].copy_from_slice(&t.e[..n]);
            (key, !u64::from_be_bytes(head), i as u32)
        })
        .collect();
    // Input position last: a total order, so an unstable sort gives the
    // stable sort's result.
    keyed.sort_unstable_by(|a, b| {
        (a.0, a.1)
            .cmp(&(b.0, b.1))
            .then_with(|| ts[b.2 as usize].e.cmp(&ts[a.2 as usize].e))
            .then(a.2.cmp(&b.2))
    });
    let mut slots: Vec<Option<Term>> = std::mem::take(ts).into_iter().map(Some).collect();
    *ts = keyed
        .iter()
        .map(|&(_, _, i)| slots[i as usize].take().expect("each term once"))
        .collect();
}

/// Unit-modulus factor of s^k: exact powers of j when s is imaginary (so a
/// real coefficient stays exactly real or imaginary), else e^{ik·arg s}.
fn phase(s: Complex64, k: u32) -> Complex64 {
    if s.re == 0.0 {
        let one = if s.im >= 0.0 { 1.0 } else { -1.0 };
        match k % 4 {
            0 => Complex64::new(1.0, 0.0),
            1 => Complex64::new(0.0, one),
            2 => Complex64::new(-1.0, 0.0),
            _ => Complex64::new(0.0, -one),
        }
    } else {
        Complex64::from_polar(1.0, k as f64 * s.arg())
    }
}

/// Σ terms at s, as (sum, Σ|terms|) scaled by e^(−shift), and the shift.
fn scaled_sum(ts: &[Term], s: Complex64) -> (Complex64, f64, f64) {
    let ls = s.norm().ln();
    let log_of = |t: &Term| {
        if t.spow == 0 {
            t.lmag
        } else {
            t.lmag + t.spow as f64 * ls
        }
    };
    let shift = ts
        .iter()
        .map(log_of)
        .filter(|l| l.is_finite())
        .fold(f64::NEG_INFINITY, f64::max);
    if !shift.is_finite() {
        return (Complex64::new(0.0, 0.0), 0.0, 0.0);
    }
    let mut sum = Complex64::new(0.0, 0.0);
    let mut abs = 0.0;
    for t in ts {
        let m = (log_of(t) - shift).exp();
        sum += phase(s, t.spow) * (m * t.sign);
        abs += m;
    }
    (sum, abs, shift)
}

/// (n·e^a) / (d·e^b) without overflowing the intermediate factors. Scaling
/// is component-wise, so an exactly real ratio stays exactly real.
fn scaled_ratio(n: Complex64, a: f64, d: Complex64, b: f64) -> Complex64 {
    let r = n / d;
    let f = (a - b).exp();
    let direct = r * f;
    if direct.re.is_finite() && direct.im.is_finite() && (f > 0.0 || a - b == f64::NEG_INFINITY) {
        return direct;
    }
    let norm = r.norm();
    if norm == 0.0 || !norm.is_finite() {
        return r;
    }
    (r / norm) * (norm.ln() + a - b).exp()
}

impl Expr {
    /// num/den in MNA form (conductances) → display form: each resistance
    /// symbol's power is raised to its largest power in either, so its
    /// conductance shows as the resistance.
    pub fn from_mna(num: &XPoly, den: &XPoly, syms: &[Sym]) -> Expr {
        let logs = Logs::new(syms);
        let mut top = vec![0u8; syms.len()];
        for (e, _) in num.terms.iter().chain(&den.terms) {
            for (k, &x) in e.iter().enumerate() {
                top[k] = top[k].max(x);
            }
        }
        let reactive: Vec<usize> = (0..syms.len()).filter(|&k| syms[k].reactive).collect();
        let inverted: Vec<bool> = syms.iter().map(|s| s.inverted).collect();
        let conv = |p: &XPoly| -> Vec<Raw> {
            p.terms
                .iter()
                .map(|(e, c)| {
                    let d: Vec<u8> = e
                        .iter()
                        .enumerate()
                        .map(|(k, &x)| if inverted[k] { top[k] - x } else { x })
                        .collect();
                    // = spow(e, syms)
                    let sp = reactive.iter().filter_map(|&k| e.get(k)).map(|&x| x as u32).sum();
                    (*c, d, sp)
                })
                .collect()
        };
        let (num, den) = (conv(num), conv(den));
        let den_lmag: Vec<f64> = den.iter().map(|(c, e, _)| magnitude(*c, e, &logs).0).collect();
        Expr::normalized(num, den, &den_lmag, syms, &logs)
    }

    /// `normalize` of terms given as (coefficient, exponents, power of s),
    /// with `den_lmag` each denominator term's lmag.
    fn normalized(num: Vec<Raw>, den: Vec<Raw>, den_lmag: &[f64], syms: &[Sym], logs: &Logs) -> Expr {
        let n = syms.len();
        let all = num.iter().chain(&den);
        let mut common = vec![u8::MAX; n];
        for (_, e, _) in all.clone() {
            for (c, &x) in common.iter_mut().zip(e) {
                *c = (*c).min(x);
            }
        }
        if num.is_empty() && den.is_empty() {
            common = vec![0; n];
        }
        let smin = all.clone().map(|t| t.2).min().unwrap_or(0);
        // gcd(1, x) = 1, so the fold can stop at 1.
        let g = all.fold(0, |acc, t| if acc == 1 { 1 } else { gcd(acc, t.0) });
        let g = if g == 0 { 1 } else { g };
        let flip = den
            .iter()
            .zip(den_lmag)
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map(|t| t.0 .0 < 0)
            .unwrap_or(false);
        // Common reactive symbols are removed with their s powers.
        let removed: u32 = common
            .iter()
            .zip(syms)
            .filter(|(_, s)| s.reactive)
            .map(|(&c, _)| c as u32)
            .sum();
        let fix = |ts: Vec<Raw>| -> Vec<Term> {
            let mut out: Vec<Term> = ts
                .into_iter()
                .map(|(coeff, mut e, spow)| {
                    let c = coeff / g * if flip { -1 } else { 1 };
                    e.truncate(common.len());
                    for (x, c) in e.iter_mut().zip(&common) {
                        *x -= c;
                    }
                    term(c, e, spow - removed - (smin - removed.min(smin)), logs)
                })
                .collect();
            sort_terms(&mut out);
            out
        };
        Expr {
            num: fix(num),
            den: fix(den),
        }
    }

    /// Cancels common factors, powers of s and integer content; makes the
    /// largest denominator term positive; sorts terms.
    pub fn normalize(&mut self, syms: &[Sym]) {
        let den_lmag: Vec<f64> = self.den.iter().map(|t| t.lmag).collect();
        let raw = |ts: Vec<Term>| -> Vec<Raw> { ts.into_iter().map(|t| (t.coeff, t.e, t.spow)).collect() };
        let (num, den) = (std::mem::take(&mut self.num), std::mem::take(&mut self.den));
        *self = Expr::normalized(raw(num), raw(den), &den_lmag, syms, &Logs::new(syms));
    }

    /// Back to MNA (conductance) form, up to a common monomial factor, which
    /// leaves the ratio unchanged.
    pub fn to_mna(&self, syms: &[Sym]) -> (XPoly, XPoly) {
        let mut top = vec![0u8; syms.len()];
        for t in self.num.iter().chain(&self.den) {
            for (k, &x) in t.e.iter().enumerate() {
                top[k] = top[k].max(x);
            }
        }
        let conv = |ts: &[Term]| XPoly {
            terms: ts
                .iter()
                .map(|t| {
                    let e =
                        t.e.iter()
                            .enumerate()
                            .map(|(k, &x)| if syms[k].inverted { top[k] - x } else { x })
                            .collect();
                    (e, t.coeff)
                })
                .collect(),
        };
        (conv(&self.num), conv(&self.den))
    }

    /// Largest total symbol degree of any term.
    pub fn max_degree(&self) -> u32 {
        self.num
            .iter()
            .chain(&self.den)
            .map(|t| degree(&t.e))
            .max()
            .unwrap_or(0)
    }

    /// Σ|terms| / |Σ terms| for numerator plus denominator at s: how much
    /// cancellation amplifies a relative change in the terms.
    pub fn cancellation(&self, s: Complex64) -> f64 {
        let ratio = |ts: &[Term]| {
            let (sum, abs, _) = scaled_sum(ts, s);
            if sum.norm() > 0.0 {
                abs / sum.norm()
            } else {
                f64::INFINITY
            }
        };
        ratio(&self.num) + ratio(&self.den)
    }

    pub fn term_count(&self) -> usize {
        self.num.len() + self.den.len()
    }

    pub fn eval(&self, s: Complex64) -> Complex64 {
        self.eval_with_bound(s).0
    }

    /// Value plus a relative error bound for its floating-point evaluation:
    /// γ·(Σ|terms| / |Σ terms|) for numerator and denominator.
    pub fn eval_with_bound(&self, s: Complex64) -> (Complex64, f64) {
        let gamma = (self.num.len().max(self.den.len()) as f64 * 2.0 + 4.0) * f64::EPSILON;
        let bound = |sum: Complex64, abs: f64| {
            if sum.norm() > 0.0 {
                gamma * abs / sum.norm()
            } else {
                f64::INFINITY
            }
        };
        let (n, an, sn) = scaled_sum(&self.num, s);
        let (d, ad, sd) = scaled_sum(&self.den, s);
        (scaled_ratio(n, sn, d, sd), bound(n, an) + bound(d, ad))
    }

    /// Coefficients of s^k (k ascending) for num and den, each polynomial
    /// scaled by a common positive factor (which leaves its roots unchanged)
    /// so they stay representable.
    pub fn s_coeffs(&self) -> (Vec<f64>, Vec<f64>) {
        let co = |ts: &[Term]| {
            let deg = ts.iter().map(|t| t.spow).max().unwrap_or(0) as usize;
            let shift = ts.iter().map(|t| t.lmag).fold(f64::NEG_INFINITY, f64::max);
            let mut c = vec![0.0; deg + 1];
            if shift.is_finite() {
                for t in ts {
                    c[t.spow as usize] += t.sign * (t.lmag - shift).exp();
                }
            }
            c
        };
        (co(&self.num), co(&self.den))
    }

    /// Drops, within each power of s, the smallest terms whose combined
    /// magnitude stays within `eps` times that exact coefficient, so each
    /// coefficient of the numerator and the denominator moves by at most
    /// `eps` relative on its own (errors in the two cannot cancel).
    pub fn prune(&self, eps: f64, syms: &[Sym]) -> Expr {
        let pr = |ts: &[Term]| -> Vec<Term> {
            let mut out = Vec::new();
            let mut k = 0;
            while k < ts.len() {
                let sp = ts[k].spow;
                let mut grp: Vec<&Term> = ts[k..].iter().take_while(|t| t.spow == sp).collect();
                k += grp.len();
                grp.sort_by(|a, b| b.lmag.total_cmp(&a.lmag));
                // Magnitudes relative to the group's largest term.
                let top = grp[0].lmag;
                let val = |t: &Term| t.sign * (t.lmag - top).exp();
                let budget = eps * grp.iter().map(|t| val(t)).sum::<f64>().abs();
                let mut dropped = 0.0;
                let mut n = grp.len();
                while n > 1 {
                    // Terms of equal size (matched twins) go together, so a
                    // symmetric circuit keeps a symmetric form.
                    let low = grp[n - 1].lmag;
                    let ties = grp[..n]
                        .iter()
                        .rev()
                        .take_while(|t| t.lmag - low <= 1e-9)
                        .count()
                        .max(1);
                    let v: f64 = grp[n - ties..n].iter().map(|t| val(t).abs()).sum();
                    if ties < n && dropped + v <= budget {
                        dropped += v;
                        n -= ties;
                    } else {
                        break;
                    }
                }
                out.extend(grp[..n].iter().map(|t| (*t).clone()));
            }
            out
        };
        let mut e = Expr {
            num: pr(&self.num),
            den: pr(&self.den),
        };
        e.normalize(syms);
        e
    }

    /// The same function with the common factors of numerator and
    /// denominator cancelled: what is left after pruning can share one the
    /// full form did not, e.g. (1 + g_m R_E) once the r_o terms are gone.
    pub fn cancelled(self, syms: &[Sym]) -> Expr {
        let (n, d) = self.to_mna(syms);
        let (cn, cd) = crate::analyze::cancel(&n, &d);
        if cn.terms.len() + cd.terms.len() < n.terms.len() + d.terms.len() {
            Expr::from_mna(&cn, &cd, syms)
        } else {
            self
        }
    }

    /// `prune` levels for a tolerance, coarsest first. None is above `tol`
    /// (or 1), so a pruned coefficient never moves by more than the
    /// tolerance even where the overall error would allow it.
    pub fn prune_levels(tol: f64) -> impl Iterator<Item = f64> {
        let top = tol.min(1.0);
        std::iter::once(top).chain(
            [0.5, 0.3, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001, 1e-4]
                .into_iter()
                .filter(move |&e| e < top),
        )
    }

    pub fn latex(&self, syms: &[Sym]) -> String {
        let neg = !self.num.is_empty() && self.num.iter().all(|t| t.coeff < 0);
        let num_terms: Vec<Term> = if neg {
            self.num
                .iter()
                .map(|t| Term {
                    coeff: -t.coeff,
                    sign: -t.sign,
                    ..t.clone()
                })
                .collect()
        } else {
            self.num.clone()
        };
        let (n, product) = factored(&num_terms, syms);
        let unit_den =
            self.den.len() == 1 && self.den[0].coeff == 1 && degree(&self.den[0].e) == 0 && self.den[0].spow == 0;
        let sign = if neg { "-" } else { "" };
        if self.num.is_empty() {
            return "0".to_string();
        }
        if unit_den {
            if neg && !product {
                format!("-\\left({n}\\right)")
            } else {
                format!("{sign}{n}")
            }
        } else {
            format!("{sign}\\frac{{{n}}}{{{}}}", factored(&self.den, syms).0)
        }
    }

    pub fn plain(&self, syms: &[Sym]) -> (String, String) {
        (
            poly_str(&self.num, syms, Style::Plain),
            poly_str(&self.den, syms, Style::Plain),
        )
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Style {
    Latex,
    Plain,
}

fn degree(e: &[u8]) -> u32 {
    e.iter().map(|&x| x as u32).sum()
}

/// Symbols of a term, ordered by role (g_m before r_o before R…).
pub(crate) fn factors(e: &[u8], syms: &[Sym]) -> Vec<(usize, u8)> {
    let mut idx: Vec<(usize, u8)> = e
        .iter()
        .enumerate()
        .filter(|(_, &x)| x > 0)
        .map(|(k, &x)| (k, x))
        .collect();
    idx.sort_by(|&(a, _), &(b, _)| syms[a].role.cmp(&syms[b].role).then(a.cmp(&b)));
    idx
}

pub(crate) fn power_latex(latex: &str, x: u8) -> String {
    if x == 1 {
        latex.to_string()
    } else {
        format!("{{{latex}}}^{{{x}}}")
    }
}

/// Monomial body without sign: `2 g_{m1} R_{D}` / `2*gm_M1*RD`.
fn mono_str(t: &Term, with_s: bool, syms: &[Sym], st: Style) -> String {
    let mut parts: Vec<String> = Vec::new();
    let c = t.coeff.unsigned_abs();
    let f = factors(&t.e, syms);
    if c != 1 || (f.is_empty() && (!with_s || t.spow == 0)) {
        parts.push(c.to_string());
    }
    for (k, x) in f {
        parts.push(match st {
            Style::Latex => power_latex(&syms[k].latex, x),
            Style::Plain if x == 1 => syms[k].name.clone(),
            Style::Plain => format!("{}^{x}", syms[k].name),
        });
    }
    if with_s && t.spow > 0 {
        parts.push(s_pow(t.spow, st));
    }
    match st {
        Style::Latex => parts.join(" "),
        Style::Plain => parts.join("*"),
    }
}

fn s_pow(k: u32, st: Style) -> String {
    match (k, st) {
        (1, _) => "s".to_string(),
        (k, Style::Latex) => format!("s^{{{k}}}"),
        (k, Style::Plain) => format!("s^{k}"),
    }
}

/// LaTeX of a sum with its common monomial and integer factor pulled out:
/// `g_{m1} r_{o1} \left(g_{m2} r_{o2} + 1\right)`.
/// Also says whether the result is a single product (needs no parentheses).
fn factored(ts: &[Term], syms: &[Sym]) -> (String, bool) {
    if ts.len() < 2 {
        return (poly_str(ts, syms, Style::Latex), true);
    }
    let mut common = ts[0].e.clone();
    for t in &ts[1..] {
        for (c, &x) in common.iter_mut().zip(&t.e) {
            *c = (*c).min(x);
        }
    }
    let smin = ts.iter().map(|t| t.spow).min().unwrap_or(0);
    let g = ts.iter().fold(0, |acc, t| gcd(acc, t.coeff));
    // A leading minus on every term is the caller's to show, so keep g > 0.
    let g = g.max(1);
    if degree(&common) == 0 && smin == 0 && g == 1 {
        return (poly_str(ts, syms, Style::Latex), false);
    }
    let rest: Vec<Term> = ts
        .iter()
        .map(|t| Term {
            coeff: t.coeff / g,
            e: t.e.iter().zip(&common).map(|(x, c)| x - c).collect(),
            spow: t.spow - smin,
            ..t.clone()
        })
        .collect();
    // Common reactive symbols and powers of s go with the head; each term's
    // total power of s is unchanged.
    let head = Term {
        coeff: g,
        e: common,
        spow: smin,
        lmag: 0.0,
        sign: 1.0,
    };
    let body = format!(
        "{} \\left({}\\right)",
        mono_str(&head, true, syms, Style::Latex),
        poly_str(&rest, syms, Style::Latex)
    );
    (body, true)
}

/// Polynomial grouped by powers of s: `a + b + (c + d) s + e s^{2}`.
fn poly_str(ts: &[Term], syms: &[Sym], st: Style) -> String {
    if ts.is_empty() {
        return "0".to_string();
    }
    let mut out = String::new();
    let mut k = 0;
    while k < ts.len() {
        let sp = ts[k].spow;
        let grp: Vec<&Term> = ts[k..].iter().take_while(|t| t.spow == sp).collect();
        k += grp.len();
        if grp.len() == 1 || sp == 0 {
            for t in grp {
                let body = mono_str(t, true, syms, st);
                push_signed(&mut out, t.coeff < 0, &body);
            }
        } else {
            let mut inner = String::new();
            for t in &grp {
                push_signed(&mut inner, t.coeff < 0, &mono_str(t, false, syms, st));
            }
            let body = match st {
                Style::Latex => format!("\\left({inner}\\right) {}", s_pow(sp, st)),
                Style::Plain => format!("({inner})*{}", s_pow(sp, st)),
            };
            push_signed(&mut out, false, &body);
        }
    }
    out
}

fn push_signed(out: &mut String, negative: bool, body: &str) {
    if out.is_empty() {
        if negative {
            out.push('-');
        }
    } else {
        out.push_str(if negative { " - " } else { " + " });
    }
    out.push_str(body);
}
