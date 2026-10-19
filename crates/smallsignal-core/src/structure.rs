//! Conventional notation for transfer functions whose DC denominator is a
//! sum of conductances (and transconductances): 1/(g_o + G_1) is written
//! r_o ∥ R_1, and 1/g_m as 1/g_m, so `-gm/(go + G1)` reads `-g_m (r_o ∥ R_1)`.
//!
//! Works on the MNA (conductance) form over display symbols: with
//! D₀ = g·m·(p₁ + … + p_k), where m is a monomial and each pᵢ a single
//! admittance-like symbol,
//!
//!   N/D = (N/(g·m))·Z / (1 + Σ_{k≥1} (D_k/(g·m))·Z·s^k),   Z = p₁⁻¹ ∥ … ∥ p_k⁻¹.
//!
//! The rewrite is used only when every remaining factor is conventional (no
//! 1/R in a numerator), and the caller checks it numerically against the
//! exact expression before showing it.

use crate::render::{factors, power_latex};
use crate::ss::Role;
use crate::sym::{spow, Sym, XPoly};
use num_complex::Complex64;

/// One displayed monomial: integer coefficient, symbol exponents (a
/// resistance where dividing by its conductance), power of s.
struct DTerm {
    coeff: i128,
    e: Vec<u8>,
    spow: u32,
}

pub struct Structured {
    pub latex: String,
    num: Vec<DTerm>,
    den: Vec<DTerm>,
    parallel: Vec<usize>,
    negate: bool,
}

fn admittance_like(s: &Sym) -> bool {
    matches!(s.role, Role::Resistor | Role::DeviceR | Role::Gm | Role::Gmb)
}

/// Divides each term by `g·m`; a symbol of `m` missing from a term becomes an
/// inverse factor, allowed only for conductances (shown as their R).
/// Conductances left in a term would display as 1/R, so they reject.
fn divide(terms: &[&(Vec<u8>, i128)], g: i128, m: &[u8], syms: &[Sym]) -> Option<Vec<DTerm>> {
    let mut out = Vec::new();
    for &(e, c) in terms {
        if c % g != 0 {
            return None;
        }
        let mut d = vec![0u8; syms.len()];
        for k in 0..syms.len() {
            let (x, y) = (e[k] as i32, m[k] as i32);
            if x > y {
                if syms[k].inverted {
                    return None;
                }
                d[k] = (x - y) as u8;
            } else if x < y {
                if !syms[k].inverted {
                    return None;
                }
                d[k] = (y - x) as u8;
            }
        }
        out.push(DTerm {
            coeff: c / g,
            spow: spow(e, syms),
            e: d,
        });
    }
    out.sort_by(|a, b| {
        a.spow.cmp(&b.spow).then(
            b.e.iter()
                .map(|&x| x as u32)
                .sum::<u32>()
                .cmp(&a.e.iter().map(|&x| x as u32).sum::<u32>()),
        )
    });
    Some(out)
}

pub fn structure(num: &XPoly, den: &XPoly, syms: &[Sym]) -> Option<Structured> {
    let d0: Vec<&(Vec<u8>, i128)> = den.terms.iter().filter(|(e, _)| spow(e, syms) == 0).collect();
    if d0.len() < 2 {
        return None;
    }
    let mut m = vec![u8::MAX; syms.len()];
    for (e, _) in &d0 {
        for (a, &x) in m.iter_mut().zip(e) {
            *a = (*a).min(x);
        }
    }
    let g = d0[0].1;
    let mut parallel = Vec::new();
    for (e, c) in &d0 {
        if *c != g {
            return None;
        }
        let rest: Vec<usize> = (0..syms.len()).filter(|&k| e[k] > m[k]).collect();
        if rest.len() != 1 || e[rest[0]] - m[rest[0]] != 1 || !admittance_like(&syms[rest[0]]) {
            return None;
        }
        parallel.push(rest[0]);
    }
    parallel.sort_by(|&a, &b| syms[a].role.cmp(&syms[b].role).then(a.cmp(&b)));
    parallel.dedup();
    if parallel.len() != d0.len() {
        return None;
    }

    let nterms: Vec<&(Vec<u8>, i128)> = num.terms.iter().collect();
    let hterms: Vec<&(Vec<u8>, i128)> = den.terms.iter().filter(|(e, _)| spow(e, syms) > 0).collect();
    let numd = divide(&nterms, g, &m, syms)?;
    let dend = divide(&hterms, g, &m, syms)?;
    // `-(g_{m1} + g_{m2}) (r_{o1} ∥ r_{o2})` reads as the textbook does, but
    // a sum whose terms share a factor, `(a b + a c) (…)`, reads worse than
    // the plain fraction.
    let mut k = 0;
    while k < numd.len() {
        let grp: Vec<&DTerm> = numd[k..].iter().take_while(|t| t.spow == numd[k].spow).collect();
        k += grp.len();
        if grp.len() > 1 && (0..syms.len()).any(|i| grp.iter().all(|t| t.e[i] > 0)) {
            return None;
        }
    }
    let negate = !numd.is_empty() && numd.iter().all(|t| t.coeff < 0);
    let mut st = Structured {
        latex: String::new(),
        num: numd,
        den: dend,
        parallel,
        negate,
    };
    st.latex = st.render(syms);
    Some(st)
}

fn mono(t: &DTerm, syms: &[Sym], abs: bool) -> String {
    let c = t.coeff;
    let mut parts: Vec<String> = Vec::new();
    let f = factors(&t.e, syms);
    if c.unsigned_abs() != 1 || (f.is_empty() && t.spow == 0) {
        parts.push(c.unsigned_abs().to_string());
    }
    parts.extend(f.iter().map(|&(k, x)| power_latex(&syms[k].latex, x)));
    if t.spow == 1 {
        parts.push("s".into());
    } else if t.spow > 1 {
        parts.push(format!("s^{{{}}}", t.spow));
    }
    let body = parts.join(" ");
    if !abs && c < 0 {
        format!("-{body}")
    } else {
        body
    }
}

fn sum(ts: &[DTerm], syms: &[Sym], abs: bool) -> String {
    let mut out = String::new();
    for t in ts {
        let neg = !abs && t.coeff < 0;
        let body = mono(t, syms, true);
        if out.is_empty() {
            out.push_str(if neg { "-" } else { "" });
        } else {
            out.push_str(if neg { " - " } else { " + " });
        }
        out.push_str(&body);
    }
    out
}

impl Structured {
    /// The parallel group in parentheses, `(r_o ∥ R)`.
    fn z_latex(&self, syms: &[Sym]) -> String {
        format!("\\left({}\\right)", self.z_items(syms))
    }

    /// The parallel group alone, `r_o ∥ R`.
    fn z_items(&self, syms: &[Sym]) -> String {
        let items: Vec<String> = self
            .parallel
            .iter()
            .map(|&i| {
                let p = &syms[i];
                if p.inverted {
                    p.latex.clone()
                } else {
                    format!("\\frac{{1}}{{{}}}", p.latex)
                }
            })
            .collect();
        items.join(" \\parallel ")
    }

    fn render(&self, syms: &[Sym]) -> String {
        let sign = if self.negate { "-" } else { "" };
        // a·b·k (1/a ∥ 1/b) = k/(1/a + 1/b): two transconductances in series
        // (a follower into a common gate), read without the products.
        if let ([t], [a, b], true) = (&self.num[..], &self.parallel[..], self.den.is_empty()) {
            if [a, b].iter().all(|&&i| !syms[i].inverted && t.e[i] > 0) {
                let mut k = DTerm {
                    coeff: t.coeff,
                    e: t.e.clone(),
                    spow: t.spow,
                };
                k.e[*a] -= 1;
                k.e[*b] -= 1;
                let inv = |i: usize| format!("\\frac{{1}}{{{}}}", syms[i].latex);
                return format!("{sign}\\frac{{{}}}{{{} + {}}}", mono(&k, syms, true), inv(*a), inv(*b));
            }
        }
        let z = self.z_latex(syms);
        // Numerator: N' · Z, written "g_m (r_o ∥ R)" or "(a + b s) (r_o ∥ R)".
        let numer = match self.num.len() {
            0 => return "0".into(),
            1 => {
                let t = &self.num[0];
                let body = mono(t, syms, true);
                if body == "1" {
                    // Alone in a numerator (or as the whole result) the group
                    // needs no parentheses.
                    self.z_items(syms)
                } else {
                    format!("{body} {z}")
                }
            }
            _ => format!("\\left({}\\right) {z}", sum(&self.num, syms, self.negate)),
        };
        if self.den.is_empty() {
            return format!("{sign}{numer}");
        }
        // Denominator: 1 + Σ (D_k / g·m) · Z · s^k, grouped by power of s.
        let mut den = String::from("1");
        let mut k = 0;
        while k < self.den.len() {
            let sp = self.den[k].spow;
            let grp: Vec<&DTerm> = self.den[k..].iter().take_while(|t| t.spow == sp).collect();
            k += grp.len();
            let spow = if sp == 1 {
                "s".to_string()
            } else {
                format!("s^{{{sp}}}")
            };
            let strip = |t: &DTerm| DTerm {
                coeff: t.coeff,
                e: t.e.clone(),
                spow: 0,
            };
            if grp.len() == 1 {
                let t = strip(grp[0]);
                den.push_str(if t.coeff < 0 { " - " } else { " + " });
                let body = mono(&t, syms, true);
                let body = if body == "1" { String::new() } else { format!("{body} ") };
                den.push_str(&format!("{body}{z} {spow}"));
            } else {
                let inner: Vec<DTerm> = grp.iter().map(|t| strip(t)).collect();
                den.push_str(&format!(" + \\left({}\\right) {z} {spow}", sum(&inner, syms, false)));
            }
        }
        format!("{sign}\\frac{{{numer}}}{{{den}}}")
    }

    /// Value of the structured form with each symbol's displayed value
    /// (R for resistances) taken from `vals`, for checking the rewrite.
    pub fn eval(&self, syms: &[Sym], vals: &[f64], s: Complex64) -> Complex64 {
        let term = |t: &DTerm| -> Complex64 {
            let v: f64 = t.e.iter().zip(vals).map(|(&x, v)| v.powi(x as i32)).product::<f64>() * t.coeff as f64;
            v * s.powu(t.spow)
        };
        let adm = |i: usize| if syms[i].inverted { 1.0 / vals[i] } else { vals[i] };
        let z = 1.0 / self.parallel.iter().map(|&i| adm(i)).sum::<f64>();
        let n: Complex64 = self.num.iter().map(term).sum::<Complex64>() * z;
        let d: Complex64 = Complex64::new(1.0, 0.0) + self.den.iter().map(term).sum::<Complex64>() * z;
        n / d
    }
}
