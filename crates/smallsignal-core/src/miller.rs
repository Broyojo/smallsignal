//! The Miller approximation of a feedback capacitance, as an assumption.
//!
//! A capacitance C between two signal nodes a and b (an explicit C, or a
//! device's C_gd or C_μ) is split into two grounded ones, C_in = C(1 − K)
//! at a and C_out = C(K − 1)/K at b, where K = v_b(0)/v_a(0) under the gain
//! excitation, from the assumed model at s = 0 (where C is open, so taking
//! it out does not change K). One K serves every quantity, so one split
//! model does.
//!
//! The split model stamps C_in and C_out as two independent parameters, so
//! the determinant stays multilinear. After expansion each form is mapped
//! onto C and a symbol K exactly: C_in → C(1 − K), C_out → C(K − 1)/K, the
//! numerator and denominator both multiplied by K^m (m the highest power of
//! C_out in either), which leaves the ratio unchanged.

use crate::assume::{terms_for, Term};
use crate::netlist::{Kind, Netlist};
use crate::ss::{dev_latex_sub, esc, Excite, Param, Role, SsCircuit, Stamp};
use crate::sym::{Sym, Symbols, XPoly};
use num_complex::Complex64;
use serde::Deserialize;
use std::collections::BTreeMap;

/// `{element, term?}`: an explicit capacitor by name (no term), or a
/// device's capacitance by its term (`cgd`, `cmu`, …).
#[derive(Deserialize, Clone, Debug)]
pub struct MillerRequest {
    pub element: String,
    #[serde(default)]
    pub term: Option<String>,
}

/// A requested split, validated against the full model.
#[derive(Clone, Debug)]
pub struct Target {
    pub element: String,
    /// None: an explicit capacitor's own capacitance.
    pub term: Option<Term>,
    /// The full model's parameter (None: not in the model, 0 F).
    pub param: Option<usize>,
    /// Its ends as stamped: K = v_b/v_a.
    pub a: usize,
    pub b: usize,
}

impl Target {
    /// "C1", "cgd of M1": as warnings name it.
    pub fn what(&self) -> String {
        match self.term {
            None => self.element.clone(),
            Some(t) => format!("{} of {}", t.as_str(), self.element),
        }
    }
}

fn is_capacitance(t: Term) -> bool {
    matches!(
        t,
        Term::Cgs | Term::Cgd | Term::Cgb | Term::Cbs | Term::Cbd | Term::Cpi | Term::Cmu | Term::Ccs | Term::Cj
    )
}

/// The full model's parameter name of a target's capacitance.
fn param_name(kind: &Kind, term: Option<Term>, element: &str) -> String {
    match (term, kind) {
        (None, _) => element.to_string(),
        // A lateral device's substrate capacitance ends at the base.
        (Some(Term::Ccs), Kind::Q { model, .. }) if model.caps.subs < 0.0 => format!("cbsub_{element}"),
        (Some(t), _) => format!("{}_{element}", t.as_str()),
    }
}

/// Validates the request's `miller` items. `ignored` holds the (element,
/// term) pairs the request neglects, opens or shorts: a capacitance cannot
/// take both.
pub fn resolve(
    net: &Netlist,
    full: &SsCircuit,
    req: &[MillerRequest],
    ignored: &[(usize, Term)],
) -> Result<Vec<Target>, String> {
    let mut out: Vec<Target> = Vec::new();
    let mut seen: Vec<(usize, Option<Term>)> = Vec::new();
    for item in req {
        let ei = net
            .element(&item.element)
            .ok_or_else(|| format!("assume: no element '{}'", item.element.trim()))?;
        let e = &net.elements[ei];
        let asked = item.term.as_deref().map(str::trim).filter(|t| !t.is_empty());
        let term = match (&e.kind, asked) {
            (Kind::C { .. }, None) => None,
            (Kind::C { .. }, Some(t)) => return Err(format!("assume: {} has no term {t}", e.name)),
            (Kind::M { .. } | Kind::Q { .. } | Kind::D { .. }, None) => {
                return Err(format!("assume: {} needs a capacitance term for Miller", e.name))
            }
            (Kind::M { .. } | Kind::Q { .. } | Kind::D { .. }, Some(t)) => {
                let term = Term::parse(t)
                    .filter(|x| terms_for(&e.kind).contains(x))
                    .ok_or_else(|| format!("assume: {} has no term {t}", e.name))?;
                if !is_capacitance(term) {
                    return Err(format!("assume: {t} of {} is not a capacitance", e.name));
                }
                Some(term)
            }
            _ => return Err(format!("assume: {} is not a capacitance", e.name)),
        };
        if seen.contains(&(ei, term)) {
            continue;
        }
        seen.push((ei, term));
        match term {
            None => {
                for (t, word) in [(Term::Open, "open"), (Term::Short, "short")] {
                    if ignored.contains(&(ei, t)) {
                        return Err(format!("assume: {} cannot be both {word} and Miller", e.name));
                    }
                }
            }
            Some(t) if ignored.contains(&(ei, t)) => {
                return Err(format!(
                    "assume: {} of {} cannot be both neglected and Miller",
                    t.as_str(),
                    e.name
                ))
            }
            // A diode taken open leaves out its C_j too, a shorted one
            // merges its ends.
            Some(_) => {
                for (t, word) in [(Term::Open, "open"), (Term::Short, "short")] {
                    if ignored.contains(&(ei, t)) {
                        return Err(format!("assume: {} cannot be both {word} and Miller", e.name));
                    }
                }
            }
        }
        let name = param_name(&e.kind, term, &e.name);
        let param = full.params.iter().position(|p| p.name == name && p.element == e.name);
        let ends = param.and_then(|p| {
            full.stamps.iter().find_map(|st| match *st {
                Stamp::Adm { a, b, p: q } if q == p => Some((a, b)),
                _ => None,
            })
        });
        let (a, b) = ends.unwrap_or((e.nodes[0], e.nodes[1]));
        out.push(Target {
            element: e.name.clone(),
            term,
            param: param.filter(|_| ends.is_some()),
            a,
            b,
        });
    }
    Ok(out)
}

/// A target's split, from the model it is computed on.
#[derive(Clone, Debug)]
pub struct Split {
    /// Index into `Assume::miller`.
    pub target: usize,
    /// The ends as oriented for K (an explicit capacitor's may be swapped).
    pub a: usize,
    pub b: usize,
    /// The full model's C (NaN in symbolic mode).
    pub c: f64,
    /// K = v_b(0)/v_a(0) (NaN in symbolic mode).
    pub k: f64,
    /// The capacitance's parameter name and LaTeX (cgd_M1, C_{gd1}).
    pub name: String,
    pub latex: String,
    /// The K symbol's name and LaTeX (K_cgd_M1, K_{gd1}).
    pub k_name: String,
    pub k_latex: String,
    /// The split's C_in and C_out parameter names (Cin_CC, Cout_CC), unique
    /// among the full model's parameters and the other splits'.
    pub cin_name: String,
    pub cout_name: String,
}

/// `want`, or with the first free suffix `_2`, `_3`… when another name in
/// `taken` already has it (a capacitor named cgd_M1 beside M1's C_gd).
fn unique(want: String, taken: &mut Vec<String>) -> String {
    let mut name = want.clone();
    let mut k = 2;
    while taken.contains(&name) {
        name = format!("{want}_{k}");
        k += 1;
    }
    taken.push(name.clone());
    name
}

/// The split of each target that has one, on `base` (the gain's assumed
/// model, before any split) under `excite`, with a warning for each target
/// refused or questionable: one not between two signal nodes, K undefined
/// (v_a(0) = 0 or no DC solution) or 0, a negative C_in (K > 1) or C_out
/// (0 < K < 1). An explicit capacitor's ends are oriented so |K| ≥ 1 (with
/// numbers; as written otherwise); a device's stay as stamped (K = v_d/v_g
/// for C_gd, v_c/v_b for C_μ).
pub fn gains(
    net: &Netlist,
    full: &SsCircuit,
    base: &SsCircuit,
    excite: &Excite,
    targets: &[Target],
    warnings: &mut Vec<String>,
) -> Vec<Split> {
    let sys = crate::ss::system(net, base, excite);
    let singular = crate::pencil::vanishes(&sys, base, None, true);
    // The DC solve, with numbers (symbolic mode has none: K stays a symbol).
    let numeric = !base.params.iter().any(|p| p.value.is_nan());
    let dc = if singular || !numeric {
        None
    } else {
        let a = crate::analyze::matrix_at(&sys, base, Complex64::new(0.0, 0.0));
        let b: Vec<Complex64> = sys.b.iter().map(|&v| Complex64::new(v as f64, 0.0)).collect();
        crate::linalg::LuComplex::factor(sys.dim, a).map(|lu| lu.solve(&b))
    };
    let mut out = Vec::new();
    // Parameter and symbol names in use: each split's own stay distinct.
    let mut taken: Vec<String> = full.params.iter().map(|p| p.name.clone()).collect();
    for (i, t) in targets.iter().enumerate() {
        let what = t.what();
        let refuse =
            |why: &str, warnings: &mut Vec<String>| warnings.push(format!("No Miller split for {what}, {why}"));
        // In the full model, and still in the assumed one.
        let kept = |p: usize| {
            let fp = &full.params[p];
            base.params.iter().any(|q| q.name == fp.name && q.element == fp.element)
        };
        let Some(p) = t.param.filter(|&p| kept(p)) else {
            refuse("it is not in the model", warnings);
            continue;
        };
        let (Some(mut ca), Some(mut cb)) = (sys.node_col[t.a], sys.node_col[t.b]) else {
            refuse("it is not between two signal nodes", warnings);
            continue;
        };
        if ca == cb {
            refuse("it is not between two signal nodes", warnings);
            continue;
        }
        if singular {
            refuse("K is undefined", warnings);
            continue;
        }
        // Exactly zero at DC (the polynomial, not its rounding). An explicit
        // capacitor with one end at 0 has K = 0 one way round, ∞ the other.
        let zero = |c: usize| crate::pencil::vanishes(&sys, base, Some(&[(c, 1)]), true);
        let explicit = t.term.is_none();
        match (zero(ca), zero(cb)) {
            (true, true) => {
                refuse("K is undefined", warnings);
                continue;
            }
            (true, false) if !explicit => {
                refuse("K is undefined", warnings);
                continue;
            }
            (true, false) | (false, true) => {
                refuse("K is 0", warnings);
                continue;
            }
            (false, false) => {}
        }
        let (mut a, mut b) = (t.a, t.b);
        let c = full.params[p].value;
        let k = match &dc {
            _ if !numeric => f64::NAN,
            None => {
                refuse("K is undefined", warnings);
                continue;
            }
            Some(x) => {
                if explicit && x[ca].norm() > x[cb].norm() {
                    std::mem::swap(&mut a, &mut b);
                    std::mem::swap(&mut ca, &mut cb);
                }
                let k = x[cb].re / x[ca].re;
                if k == 0.0 {
                    refuse("K is 0", warnings);
                    continue;
                }
                if !k.is_finite() {
                    refuse("K is undefined", warnings);
                    continue;
                }
                k
            }
        };
        if k > 1.0 {
            warnings.push(format!("Miller C_in of {what} is negative, K > 1"));
        } else if k > 0.0 && k < 1.0 {
            warnings.push(format!("Miller C_out of {what} is negative, 0 < K < 1"));
        }
        let fp = &full.params[p];
        let (k_name, k_latex) = match t.term {
            None => (format!("K_{}", t.element), format!("K_{{{}}}", esc(&t.element))),
            Some(_) => {
                let kind = fp.name.split('_').next().unwrap_or("");
                let sub = crate::ss::cap_sub(kind).unwrap_or(kind);
                (format!("K_{}", fp.name), dev_latex_sub("K", sub, &t.element))
            }
        };
        let k_name = unique(k_name, &mut taken);
        let cin_name = unique(format!("Cin_{}", fp.name), &mut taken);
        let cout_name = unique(format!("Cout_{}", fp.name), &mut taken);
        out.push(Split {
            target: i,
            a,
            b,
            c,
            k,
            name: fp.name.clone(),
            latex: fp.latex.clone(),
            k_name,
            k_latex,
            cin_name,
            cout_name,
        });
    }
    out
}

/// `assumable` (the `assume::assumable` list) with each element's
/// capacitances that bridge two signal nodes of `sys` (the full model's gain
/// system), as `miller`: the term, or null for an explicit capacitor
/// (empty when none does).
pub fn with_targets(
    mut assumable: serde_json::Value,
    net: &Netlist,
    full: &SsCircuit,
    sys: &crate::ss::System,
) -> serde_json::Value {
    let mut found: Vec<(String, Option<&'static str>)> = Vec::new();
    for st in &full.stamps {
        let Stamp::Adm { a, b, p } = *st else { continue };
        let prm = &full.params[p];
        if prm.role != Role::Capacitor {
            continue;
        }
        let (Some(ca), Some(cb)) = (sys.node_col[a], sys.node_col[b]) else {
            continue;
        };
        if ca == cb {
            continue;
        }
        let Some(ei) = net.element(&prm.element) else { continue };
        let term = match &net.elements[ei].kind {
            Kind::C { .. } if prm.name == prm.element => None,
            Kind::M { .. } | Kind::Q { .. } | Kind::D { .. } => {
                let kind = prm.name.split('_').next().unwrap_or("");
                let kind = if kind == "cbsub" { "ccs" } else { kind };
                match Term::parse(kind).filter(|&t| is_capacitance(t)) {
                    Some(t) => Some(t.as_str()),
                    None => continue,
                }
            }
            _ => continue,
        };
        found.push((prm.element.clone(), term));
    }
    if let Some(list) = assumable.as_array_mut() {
        for entry in list.iter_mut() {
            let el = entry["element"].as_str().unwrap_or("").to_string();
            let terms: Vec<serde_json::Value> = found
                .iter()
                .filter(|(e, _)| *e == el)
                .map(|(_, t)| t.map_or(serde_json::Value::Null, |t| serde_json::json!(t)))
                .collect();
            entry["miller"] = serde_json::Value::Array(terms);
        }
    }
    assumable
}

/// Names of a split's two grounded parameters in the split model.
fn split_names(s: &Split) -> (String, String) {
    (s.cin_name.clone(), s.cout_name.clone())
}

/// `base` with each split's capacitance replaced by C_in = C(1 − K) from a
/// to ground and C_out = C(K − 1)/K from b to ground, two independent
/// parameters. They belong to no netlist element, so matching never merges
/// them (two matched devices can have different K).
pub fn split(base: &SsCircuit, splits: &[Split], targets: &[Target]) -> SsCircuit {
    if splits.is_empty() {
        return base.clone();
    }
    let drop: Vec<usize> = splits
        .iter()
        .filter_map(|s| {
            let el = &targets[s.target].element;
            base.params.iter().position(|p| p.name == s.name && &p.element == el)
        })
        .collect();
    let mut m = base.omit(&drop);
    for s in splits {
        let (cin, cout) = split_names(s);
        let owner = format!("{}~miller", targets[s.target].element);
        let values = [s.c * (1.0 - s.k), s.c * (s.k - 1.0) / s.k];
        for ((name, node), (value, side)) in [(cin, s.a), (cout, s.b)]
            .into_iter()
            .zip(values.into_iter().zip(["in", "out"]))
        {
            m.params.push(Param {
                name,
                latex: format!("{}^{{{side}}}", s.latex),
                value,
                inverted: false,
                reactive: true,
                role: Role::Capacitor,
                unit: "F",
                element: owner.clone(),
                linear: false,
            });
            m.stamps.push(Stamp::Adm {
                a: node,
                b: 0,
                p: m.params.len() - 1,
            });
        }
    }
    let (inv, reactive) = crate::ss::masks(&m.params);
    m.inv_mask = inv;
    m.reactive_mask = reactive;
    m
}

/// The symbols of `split_syms` (over the split model's parameters) with
/// each split's C_in symbol taken by C and its C_out symbol by K, and the
/// slots of each: (C, K). Forms free of C_in and C_out read the same in
/// both.
pub fn shown(split_model: &SsCircuit, split_syms: &Symbols, splits: &[Split]) -> (Symbols, Vec<(usize, usize)>) {
    let mut out = split_syms.clone();
    let mut slots = Vec::new();
    for s in splits {
        let (cin, cout) = split_names(s);
        let slot = |name: &str| {
            let p = split_model
                .params
                .iter()
                .position(|p| p.name == name)
                .expect("split parameter");
            split_syms.class[p]
        };
        let (i, j) = (slot(&cin), slot(&cout));
        let element = split_model
            .params
            .iter()
            .find(|p| p.name == cin)
            .map(|p| p.element.clone());
        let element = element
            .as_deref()
            .and_then(|e| e.strip_suffix("~miller"))
            .unwrap_or("")
            .to_string();
        out.syms[i] = Sym {
            name: s.name.clone(),
            latex: s.latex.clone(),
            value: s.c,
            inverted: false,
            reactive: true,
            role: Role::Capacitor,
            unit: "F",
            elements: vec![element.clone()],
            output_r: false,
            leakage: false,
        };
        out.syms[j] = Sym {
            name: s.k_name.clone(),
            latex: s.k_latex.clone(),
            value: s.k,
            inverted: false,
            reactive: false,
            role: Role::Gain,
            unit: "V/V",
            elements: vec![element],
            output_r: false,
            leakage: false,
        };
        slots.push((i, j));
    }
    (out, slots)
}

fn binomial(n: u32, k: u32) -> i128 {
    (0..k).fold(1i128, |acc, i| acc * (n - i) as i128 / (i + 1) as i128)
}

/// num/den over the split symbols mapped onto C and K at `slots` (C_in's
/// slot holds C, C_out's holds K), exactly: C_in^x C_out^y →
/// (−1)^y C^(x+y) (1 − K)^(x+y) K^(m−y), m the highest y in either, which
/// multiplies both by K^m.
/// Past `max_terms` terms in either, the over-budget error (the quantity is
/// then numeric, as for an over-budget determinant).
pub fn substitute(
    num: &XPoly,
    den: &XPoly,
    slots: &[(usize, usize)],
    max_terms: usize,
) -> Result<(XPoly, XPoly), String> {
    let (mut n, mut d) = (num.clone(), den.clone());
    for &(i, j) in slots {
        let m = n.terms.iter().chain(&d.terms).map(|(e, _)| e[j]).max().unwrap_or(0);
        n = one(&n, i, j, m, max_terms)?;
        d = one(&d, i, j, m, max_terms)?;
    }
    Ok((n, d))
}

fn one(p: &XPoly, i: usize, j: usize, m: u8, max_terms: usize) -> Result<XPoly, String> {
    let overflow = || "coefficient overflow in the Miller substitution".to_string();
    let mut map: BTreeMap<Vec<u8>, i128> = BTreeMap::new();
    for (e, c) in &p.terms {
        let (x, y) = (e[i], e[j]);
        let n = x.checked_add(y).ok_or_else(overflow)?;
        let sign: i128 = if y % 2 == 1 { -1 } else { 1 };
        for t in 0..=n {
            let mut f = e.clone();
            f[i] = n;
            f[j] = (m - y).checked_add(t).ok_or_else(overflow)?;
            let tsign: i128 = if t % 2 == 1 { -1 } else { 1 };
            let coef = c
                .checked_mul(binomial(n as u32, t as u32))
                .and_then(|v| v.checked_mul(sign * tsign))
                .ok_or_else(overflow)?;
            let v = map.entry(f).or_insert(0);
            *v = v.checked_add(coef).ok_or_else(overflow)?;
            if map.len() > max_terms {
                return Err(crate::det::too_large(max_terms));
            }
        }
    }
    Ok(XPoly {
        terms: map.into_iter().filter(|(_, c)| *c != 0).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Value of `p` with symbol values `v` (MNA form, no s).
    fn eval(p: &XPoly, v: &[f64]) -> f64 {
        p.terms
            .iter()
            .map(|(e, c)| *c as f64 * e.iter().zip(v).map(|(&x, &y)| y.powi(x as i32)).product::<f64>())
            .sum()
    }

    #[test]
    fn substitution_is_exact_at_random_points() {
        // Over [g, C_in, C_out]: an arbitrary multilinear num and den.
        let t = |e: [u8; 3], c: i128| (e.to_vec(), c);
        let num = XPoly {
            terms: vec![t([1, 0, 0], 3), t([0, 1, 0], -2), t([0, 0, 1], 5), t([1, 1, 1], 7)],
        };
        let den = XPoly {
            terms: vec![t([0, 0, 0], 1), t([1, 1, 0], 4), t([0, 1, 1], -3), t([1, 0, 1], 2)],
        };
        let (n2, d2) = substitute(&num, &den, &[(1, 2)], usize::MAX).unwrap();
        let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % 1_000_000) as f64 / 250_000.0 - 2.0
        };
        for _ in 0..200 {
            let (g, c, k) = (rnd(), rnd(), rnd());
            if k.abs() < 1e-3 {
                continue;
            }
            let split = [g, c * (1.0 - k), c * (k - 1.0) / k];
            let want = eval(&num, &split) / eval(&den, &split);
            // Slot 1 holds C, slot 2 holds K.
            let got = eval(&n2, &[g, c, k]) / eval(&d2, &[g, c, k]);
            assert!((got - want).abs() <= 1e-9 * want.abs().max(1.0), "{got} vs {want}");
        }
    }

    #[test]
    fn at_k_1_the_split_is_the_capacitance_open() {
        // K = 1: C_in = C_out = 0, whatever C. Over [g, C_in, C_out].
        let t = |e: [u8; 3], c: i128| (e.to_vec(), c);
        let num = XPoly {
            terms: vec![t([1, 0, 0], 2), t([1, 1, 0], -3), t([0, 1, 1], 4)],
        };
        let den = XPoly {
            terms: vec![t([0, 0, 0], 1), t([0, 0, 1], 6), t([1, 1, 1], -1)],
        };
        let (n2, d2) = substitute(&num, &den, &[(1, 2)], usize::MAX).unwrap();
        for (g, c) in [(0.3, 1.7), (2.5, -0.4), (1.1, 9.0)] {
            let open = eval(&num, &[g, 0.0, 0.0]) / eval(&den, &[g, 0.0, 0.0]);
            let got = eval(&n2, &[g, c, 1.0]) / eval(&d2, &[g, c, 1.0]);
            assert!((got - open).abs() <= 1e-12 * open.abs(), "{got} vs {open}");
        }
    }

    #[test]
    fn substitution_keeps_to_the_term_budget() {
        // 3 terms after the substitution: g·K and C·g·(1 − K).
        let num = XPoly {
            terms: vec![(vec![1, 0, 0], 1), (vec![1, 0, 1], 2)],
        };
        let den = XPoly {
            terms: vec![(vec![0, 0, 0], 1)],
        };
        let err = substitute(&num, &den, &[(1, 2)], 2).unwrap_err();
        assert!(err.starts_with("exact expression too large"), "{err}");
        assert!(substitute(&num, &den, &[(1, 2)], 3).is_ok());
    }

    #[test]
    fn substitution_without_c_out_multiplies_nothing() {
        let num = XPoly {
            terms: vec![(vec![1, 0], 1)],
        };
        let den = XPoly {
            terms: vec![(vec![0, 0], 1)],
        };
        let (n, d) = substitute(&num, &den, &[(0, 1)], usize::MAX).unwrap();
        // C_in → C(1 − K): C − C·K over 1.
        assert_eq!(n.terms, vec![(vec![1, 0], 1), (vec![1, 1], -1)]);
        assert_eq!(d, den);
    }
}
