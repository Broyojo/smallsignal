//! Conventional notation for transfer functions whose DC denominator is a
//! sum of conductances (and transconductances): 1/(g_o + G_1) is written
//! r_o ∥ R_1, and 1/g_m as 1/g_m, so `-gm/(go + G1)` reads `-g_m (r_o ∥ R_1)`.
//!
//! Works on the MNA (conductance) form: with D₀ = g·m·(p₁ + … + p_k), where m
//! is a monomial and each pᵢ a single admittance-like parameter,
//!
//!   N/D = (N/(g·m))·Z / (1 + Σ_{k≥1} (D_k/(g·m))·Z·s^k),   Z = p₁⁻¹ ∥ … ∥ p_k⁻¹.
//!
//! The rewrite is used only when every remaining factor is conventional (no
//! 1/R in a numerator), and the caller checks it numerically against the
//! exact expression before showing it.

use crate::poly::{Mono, Poly};
use crate::ss::{Param, Role};
use num_complex::Complex64;

/// One displayed monomial: integer coefficient, factors shown as-is, and
/// resistances that come from dividing by a conductance.
struct DTerm {
    coeff: i128,
    factors: Vec<usize>,
    spow: u32,
}

pub struct Structured {
    pub latex: String,
    num: Vec<DTerm>,
    den: Vec<DTerm>,
    parallel: Vec<usize>,
    negate: bool,
}

fn admittance_like(p: &Param) -> bool {
    matches!(p.role, Role::Resistor | Role::DeviceR | Role::Gm | Role::Gmb)
}

/// Divides each term by `g·m`; parameters of `m` missing from a term become
/// inverse factors, allowed only for conductances (shown as their R).
/// Conductances left in a term would display as 1/R, so they reject.
fn divide(terms: &[(Mono, i128)], g: i128, m: Mono, params: &[Param], reactive: Mono) -> Option<Vec<DTerm>> {
    let mut out = Vec::new();
    for &(mask, c) in terms {
        if c % g != 0 {
            return None;
        }
        let mut factors = Vec::new();
        for (i, p) in params.iter().enumerate() {
            let bit = 1u128 << i;
            let in_term = mask & bit != 0;
            let in_m = m & bit != 0;
            match (in_term, in_m) {
                (true, true) | (false, false) => {}
                // A conductance left over would read 1/R: not conventional.
                (true, false) if p.inverted => return None,
                (true, false) => factors.push(i),
                // Dividing by a conductance gives its resistance.
                (false, true) if p.inverted => factors.push(i),
                (false, true) => return None,
            }
        }
        out.push(DTerm {
            coeff: c / g,
            factors,
            spow: (mask & reactive).count_ones(),
        });
    }
    out.sort_by(|a, b| a.spow.cmp(&b.spow).then(b.factors.len().cmp(&a.factors.len())));
    Some(out)
}

pub fn structure(num: &Poly, den: &Poly, params: &[Param], reactive: Mono) -> Option<Structured> {
    let d0: Vec<(Mono, i128)> = den
        .terms
        .iter()
        .filter(|(&m, _)| m & reactive == 0)
        .map(|(&m, &c)| (m, c))
        .collect();
    if d0.len() < 2 {
        return None;
    }
    let m = d0.iter().fold(Mono::MAX, |acc, &(mask, _)| acc & mask);
    let g = d0[0].1;
    let mut parallel = Vec::new();
    for &(mask, c) in &d0 {
        let rest = mask & !m;
        if c != g || rest.count_ones() != 1 {
            return None;
        }
        let i = rest.trailing_zeros() as usize;
        if !admittance_like(&params[i]) {
            return None;
        }
        parallel.push(i);
    }
    parallel.sort_by(|&a, &b| params[a].role.cmp(&params[b].role).then(a.cmp(&b)));

    let nterms: Vec<(Mono, i128)> = num.terms.iter().map(|(&m, &c)| (m, c)).collect();
    let hterms: Vec<(Mono, i128)> = den
        .terms
        .iter()
        .filter(|(&m, _)| m & reactive != 0)
        .map(|(&m, &c)| (m, c))
        .collect();
    let numd = divide(&nterms, g, m, params, reactive)?;
    let dend = divide(&hterms, g, m, params, reactive)?;
    let negate = !numd.is_empty() && numd.iter().all(|t| t.coeff < 0);
    let mut st = Structured {
        latex: String::new(),
        num: numd,
        den: dend,
        parallel,
        negate,
    };
    st.latex = st.render(params);
    Some(st)
}

fn sorted(factors: &[usize], params: &[Param]) -> Vec<usize> {
    let mut f = factors.to_vec();
    f.sort_by(|&a, &b| params[a].role.cmp(&params[b].role).then(a.cmp(&b)));
    f
}

fn mono(t: &DTerm, params: &[Param], abs: bool) -> String {
    let c = if abs { t.coeff.abs() } else { t.coeff };
    let mut parts: Vec<String> = Vec::new();
    let f = sorted(&t.factors, params);
    if c.abs() != 1 || (f.is_empty() && t.spow == 0) {
        parts.push(c.abs().to_string());
    }
    parts.extend(f.iter().map(|&i| params[i].latex.clone()));
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

fn sum(ts: &[DTerm], params: &[Param], abs: bool) -> String {
    let mut out = String::new();
    for t in ts {
        let neg = !abs && t.coeff < 0;
        let body = mono(t, params, true);
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
    fn z_latex(&self, params: &[Param]) -> String {
        let items: Vec<String> = self
            .parallel
            .iter()
            .map(|&i| {
                let p = &params[i];
                if p.inverted {
                    p.latex.clone()
                } else {
                    format!("\\frac{{1}}{{{}}}", p.latex)
                }
            })
            .collect();
        format!("\\left({}\\right)", items.join(" \\parallel "))
    }

    fn render(&self, params: &[Param]) -> String {
        let z = self.z_latex(params);
        // Numerator: N' · Z, written "g_m (r_o ∥ R)" or "(a + b s) (r_o ∥ R)".
        let numer = match self.num.len() {
            0 => return "0".into(),
            1 => {
                let t = &self.num[0];
                let body = mono(t, params, true);
                if body == "1" {
                    z.clone()
                } else {
                    format!("{body} {z}")
                }
            }
            _ => format!("\\left({}\\right) {z}", sum(&self.num, params, self.negate)),
        };
        let sign = if self.negate { "-" } else { "" };
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
                factors: t.factors.clone(),
                spow: 0,
            };
            if grp.len() == 1 {
                let t = strip(grp[0]);
                den.push_str(if t.coeff < 0 { " - " } else { " + " });
                let body = mono(&t, params, true);
                let body = if body == "1" { String::new() } else { format!("{body} ") };
                den.push_str(&format!("{body}{z} {spow}"));
            } else {
                let inner: Vec<DTerm> = grp.iter().map(|t| strip(t)).collect();
                den.push_str(&format!(" + \\left({}\\right) {z} {spow}", sum(&inner, params, false)));
            }
        }
        format!("{sign}\\frac{{{numer}}}{{{den}}}")
    }

    /// Value of the structured form with each parameter's displayed value
    /// (R for resistances) taken from `vals`, for checking the rewrite.
    pub fn eval(&self, params: &[Param], vals: &[f64], s: Complex64) -> Complex64 {
        let term = |t: &DTerm| -> Complex64 {
            let v: f64 = t.factors.iter().map(|&i| vals[i]).product::<f64>() * t.coeff as f64;
            v * s.powu(t.spow)
        };
        let adm = |i: usize| if params[i].inverted { 1.0 / vals[i] } else { vals[i] };
        let z = 1.0 / self.parallel.iter().map(|&i| adm(i)).sum::<f64>();
        let n: Complex64 = self.num.iter().map(term).sum::<Complex64>() * z;
        let d: Complex64 = Complex64::new(1.0, 0.0) + self.den.iter().map(term).sum::<Complex64>() * z;
        n / d
    }
}
