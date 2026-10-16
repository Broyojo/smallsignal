//! Display forms of rational functions: resistances instead of
//! conductances, common factors cancelled, terms ordered by magnitude, and a
//! simplified form that drops numerically small terms.

use crate::poly::{Mono, Poly};
use crate::ss::Param;
use num_complex::Complex64;

#[derive(Clone, Debug)]
pub struct Term {
    pub coeff: i128,
    /// Displayed factors (resistances as R, not 1/R).
    pub mask: Mono,
    pub spow: u32,
    /// |coeff| · Π factor values (excluding s).
    pub mag: f64,
    pub signed: f64,
}

#[derive(Clone, Debug)]
pub struct Expr {
    pub num: Vec<Term>,
    pub den: Vec<Term>,
}

fn gcd(a: i128, b: i128) -> i128 {
    let (mut a, mut b) = (a.abs(), b.abs());
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

fn term(coeff: i128, mask: Mono, spow: u32, params: &[Param]) -> Term {
    // Parameter values can be negative (e.g. an inverting controlled source).
    let mut signed = coeff as f64;
    let mut m = mask;
    while m != 0 {
        let i = m.trailing_zeros() as usize;
        signed *= params[i].value;
        m &= m - 1;
    }
    // Symbolic-only parameters have NaN values; order those terms by
    // coefficient alone.
    let mag = if signed.is_nan() {
        coeff.unsigned_abs() as f64
    } else {
        signed.abs()
    };
    Term {
        coeff,
        mask,
        spow,
        mag,
        signed,
    }
}

impl Expr {
    /// num/den in MNA form (conductances) → display form.
    pub fn from_rational(num: &Poly, den: &Poly, params: &[Param], inv: Mono, reactive: Mono) -> Expr {
        let inv_set = (num.support() | den.support()) & inv;
        let conv = |p: &Poly| -> Vec<Term> {
            p.terms
                .iter()
                .map(|(&m, &c)| {
                    let d = (m & !inv) | (inv_set & !m);
                    term(c, d, (m & reactive).count_ones(), params)
                })
                .collect()
        };
        let mut e = Expr {
            num: conv(num),
            den: conv(den),
        };
        e.normalize(params);
        e
    }

    /// Cancels common factors, powers of s and integer content; makes the
    /// largest denominator term positive; sorts terms.
    pub fn normalize(&mut self, params: &[Param]) {
        let all = self.num.iter().chain(&self.den);
        let common = all.clone().fold(Mono::MAX, |acc, t| acc & t.mask);
        let smin = all.clone().map(|t| t.spow).min().unwrap_or(0);
        let g = all.fold(0, |acc, t| gcd(acc, t.coeff));
        let g = if g == 0 { 1 } else { g };
        let flip = self
            .den
            .iter()
            .max_by(|a, b| a.mag.total_cmp(&b.mag))
            .map(|t| t.coeff < 0)
            .unwrap_or(false);
        let fix = |ts: &mut Vec<Term>| {
            for t in ts.iter_mut() {
                let c = t.coeff / g * if flip { -1 } else { 1 };
                *t = term(c, t.mask & !common, t.spow - smin, params);
            }
            ts.sort_by(|a, b| {
                a.spow
                    .cmp(&b.spow)
                    .then(b.mag.total_cmp(&a.mag))
                    .then(b.mask.count_ones().cmp(&a.mask.count_ones()))
                    .then(a.mask.cmp(&b.mask))
            });
        };
        fix(&mut self.num);
        fix(&mut self.den);
    }

    /// Back to MNA (conductance) form, up to a common monomial factor, which
    /// leaves the ratio unchanged.
    pub fn to_mna(&self, inv: Mono) -> (Poly, Poly) {
        let inv_all = self.num.iter().chain(&self.den).fold(0, |acc, t| acc | (t.mask & inv));
        let conv = |ts: &[Term]| {
            let mut p = Poly::zero();
            for t in ts {
                p.add_term((t.mask & !inv) | (inv_all & !t.mask), t.coeff);
            }
            p
        };
        (conv(&self.num), conv(&self.den))
    }

    pub fn term_count(&self) -> usize {
        self.num.len() + self.den.len()
    }

    pub fn eval(&self, s: Complex64) -> Complex64 {
        let ev = |ts: &[Term]| ts.iter().map(|t| t.signed * s.powu(t.spow)).sum::<Complex64>();
        ev(&self.num) / ev(&self.den)
    }

    /// Value plus a relative error bound for its floating-point evaluation:
    /// γ·(Σ|terms| / |Σ terms|) for numerator and denominator.
    pub fn eval_with_bound(&self, s: Complex64) -> (Complex64, f64) {
        let ev = |ts: &[Term]| {
            let mut sum = Complex64::new(0.0, 0.0);
            let mut abs = 0.0;
            for t in ts {
                let v = t.signed * s.powu(t.spow);
                sum += v;
                abs += v.norm();
            }
            let gamma = (ts.len() as f64 + 2.0 + self.num.len().max(self.den.len()) as f64) * f64::EPSILON;
            (
                sum,
                if sum.norm() > 0.0 {
                    gamma * abs / sum.norm()
                } else {
                    f64::INFINITY
                },
            )
        };
        let (n, bn) = ev(&self.num);
        let (d, bd) = ev(&self.den);
        (n / d, bn + bd)
    }

    /// Coefficients of s^k (k ascending) for num and den.
    pub fn s_coeffs(&self) -> (Vec<f64>, Vec<f64>) {
        let co = |ts: &[Term]| {
            let deg = ts.iter().map(|t| t.spow).max().unwrap_or(0) as usize;
            let mut c = vec![0.0; deg + 1];
            for t in ts {
                c[t.spow as usize] += t.signed;
            }
            c
        };
        (co(&self.num), co(&self.den))
    }

    /// Drops, within each power of s, the smallest terms whose combined
    /// magnitude stays below `eps` times the remaining coefficient.
    pub fn prune(&self, eps: f64, params: &[Param]) -> Expr {
        let pr = |ts: &[Term]| -> Vec<Term> {
            let mut out = Vec::new();
            let mut k = 0;
            while k < ts.len() {
                let sp = ts[k].spow;
                let mut grp: Vec<&Term> = ts[k..].iter().take_while(|t| t.spow == sp).collect();
                k += grp.len();
                grp.sort_by(|a, b| b.mag.total_cmp(&a.mag));
                let mut kept_sum: f64 = grp.iter().map(|t| t.signed).sum();
                let mut dropped = 0.0;
                let mut n = grp.len();
                while n > 1 {
                    let t = grp[n - 1];
                    let rest = kept_sum - t.signed;
                    if dropped + t.mag <= eps * rest.abs() {
                        dropped += t.mag;
                        kept_sum = rest;
                        n -= 1;
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
        e.normalize(params);
        e
    }

    pub fn latex(&self, params: &[Param]) -> String {
        let neg = !self.num.is_empty() && self.num.iter().all(|t| t.coeff < 0);
        let num_terms: Vec<Term> = if neg {
            self.num
                .iter()
                .map(|t| Term {
                    coeff: -t.coeff,
                    signed: -t.signed,
                    ..t.clone()
                })
                .collect()
        } else {
            self.num.clone()
        };
        let n = poly_str(&num_terms, params, Style::Latex);
        let unit_den = self.den.len() == 1 && self.den[0].coeff == 1 && self.den[0].mask == 0 && self.den[0].spow == 0;
        let sign = if neg { "-" } else { "" };
        if self.num.is_empty() {
            return "0".to_string();
        }
        if unit_den {
            if neg && num_terms.len() > 1 {
                format!("-\\left({n}\\right)")
            } else {
                format!("{sign}{n}")
            }
        } else {
            format!("{sign}\\frac{{{n}}}{{{}}}", poly_str(&self.den, params, Style::Latex))
        }
    }

    pub fn plain(&self, params: &[Param]) -> (String, String) {
        (
            poly_str(&self.num, params, Style::Plain),
            poly_str(&self.den, params, Style::Plain),
        )
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Style {
    Latex,
    Plain,
}

fn factors(mask: Mono, params: &[Param]) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..params.len()).filter(|&i| mask >> i & 1 == 1).collect();
    idx.sort_by(|&a, &b| params[a].role.cmp(&params[b].role).then(a.cmp(&b)));
    idx
}

/// Monomial body without sign: `2 g_{m1} R_{D}` / `2*gm_M1*RD`.
fn mono_str(t: &Term, with_s: bool, params: &[Param], st: Style) -> String {
    let mut parts: Vec<String> = Vec::new();
    let c = t.coeff.unsigned_abs();
    let f = factors(t.mask, params);
    if c != 1 || (f.is_empty() && (!with_s || t.spow == 0)) {
        parts.push(c.to_string());
    }
    for i in f {
        parts.push(match st {
            Style::Latex => params[i].latex.clone(),
            Style::Plain => params[i].name.clone(),
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

/// Polynomial grouped by powers of s: `a + b + (c + d) s + e s^{2}`.
fn poly_str(ts: &[Term], params: &[Param], st: Style) -> String {
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
                let body = mono_str(t, true, params, st);
                push_signed(&mut out, t.coeff < 0, &body);
            }
        } else {
            let mut inner = String::new();
            for t in &grp {
                push_signed(&mut inner, t.coeff < 0, &mono_str(t, false, params, st));
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
