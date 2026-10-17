//! Display symbols and exact polynomials over them.
//!
//! The solver works on multilinear polynomials over the small-signal
//! parameters (one per stamp; see `poly`). Matched devices then share one
//! *symbol*: g_{m1,2} for both gm_M1 and gm_M2. Merging must come after the
//! determinant (a merged symbol appears in two rank-one stamps, so its square
//! is a real term), so here each multilinear monomial is mapped onto symbol
//! exponents, which is exact: it only renames.

use crate::dc::{DevOp, Op};
use crate::netlist::{Kind, Netlist};
use crate::poly::Poly;
use crate::ss::{dev_latex_sub, elem_latex, Role, SsCircuit};
use std::collections::HashMap;

/// Relative agreement required to merge matched devices' values.
pub const MATCH_REL: f64 = 1e-9;

#[derive(Clone, Debug)]
pub struct Sym {
    /// Plain identifier (the first member's parameter name, e.g. gm_M1).
    pub name: String,
    pub latex: String,
    /// Displayed value (Ω for resistances), the first member's; NaN when
    /// symbolic.
    pub value: f64,
    pub inverted: bool,
    pub reactive: bool,
    pub role: Role,
    pub unit: &'static str,
    pub elements: Vec<String>,
    /// A device output resistance (r_o, r_μ, bulk junction): the quantities
    /// hand analysis takes to infinity.
    pub output_r: bool,
    /// Junction leakage (r_bs, r_bd, r_μ): present only through gmin-level
    /// junction conductance; the `display` form drops it.
    pub leakage: bool,
}

impl Sym {
    pub fn mna_value(&self) -> f64 {
        if self.inverted {
            1.0 / self.value
        } else {
            self.value
        }
    }
}

/// Symbols plus the symbol of every parameter.
#[derive(Clone, Debug)]
pub struct Symbols {
    pub syms: Vec<Sym>,
    pub class: Vec<usize>,
    /// Largest relative difference between merged values (0 when none).
    pub mismatch: f64,
}

/// A parameter's kind within its element: "gm", "ro", "rpi"… or "" for a
/// passive element's own value.
fn kind_of(name: &str, element: &str) -> String {
    match name.strip_suffix(element).and_then(|k| k.strip_suffix('_')) {
        Some(k) => k.to_string(),
        None => String::new(),
    }
}

/// TeX (base, subscript) for a device parameter kind.
fn device_sub(kind: &str) -> Option<(&'static str, &'static str)> {
    Some(match kind {
        "gm" => ("g", "m"),
        "gmb" => ("g", "mb"),
        "ro" => ("r", "o"),
        "rpi" => ("r", "\\pi "),
        "rmu" => ("r", "\\mu "),
        "rbs" => ("r", "bs"),
        "rbd" => ("r", "bd"),
        "rd" => ("r", "d"),
        _ => return None,
    })
}

/// "1,2" from M1, M2; "D1,2" from RD1, RD2; "in,out" from Min, Mout.
fn merged_rest(elements: &[String]) -> String {
    let rests: Vec<&str> = elements.iter().map(|e| &e[1..]).collect();
    let first = rests[0];
    let mut prefix = first.len();
    for r in &rests[1..] {
        prefix = prefix.min(first.chars().zip(r.chars()).take_while(|(a, b)| a == b).count());
    }
    // Keep the shared prefix only when what follows it differs in each.
    let tails: Vec<&str> = rests.iter().map(|r| &r[prefix.min(r.len())..]).collect();
    if tails.iter().any(|t| t.is_empty()) {
        return rests.join(",");
    }
    format!("{}{}", &first[..prefix], tails.join(","))
}

/// "M1,2" for M1, M2: the elements of a merged symbol, written compactly.
pub fn merged_name(elements: &[String]) -> String {
    if elements.len() == 1 {
        return elements[0].clone();
    }
    format!("{}{}", &elements[0][..1], merged_rest(elements))
}

/// `I_{C1,2}` for a quantity (base, subscript) shared by matched elements.
pub fn merged_dev_latex(base: &str, sub: &str, elements: &[String]) -> String {
    let name = format!("{}{}", &elements[0][..1], merged_rest(elements));
    dev_latex_sub(base, sub, &name)
}

fn merged_latex(kind: &str, elements: &[String]) -> String {
    let letter = &elements[0][..1];
    let name = format!("{letter}{}", merged_rest(elements));
    match device_sub(kind) {
        Some((base, sub)) => dev_latex_sub(base, sub, &name),
        None => elem_latex(&name),
    }
}

/// Builds the symbols, merging each group of matched elements whose
/// parameters agree (in numeric mode to MATCH_REL; in symbolic mode they are
/// assumed equal). A group that cannot merge is reported and left apart.
/// In symbolic mode (`symbolic`) there are no values to compare: a group
/// merges the parameter kinds its members share, and nothing is reported.
pub fn symbols(
    net: &Netlist,
    ss: &SsCircuit,
    groups: &[Vec<String>],
    symbolic: bool,
    warnings: &mut Vec<String>,
) -> Symbols {
    let np = ss.params.len();
    let mut class: Vec<usize> = (0..np).collect();
    let mut mismatch = 0.0f64;
    // Union overlapping groups.
    let mut sets: Vec<Vec<usize>> = Vec::new();
    for g in groups {
        let mut idx = Vec::new();
        for name in g {
            match net.element(name) {
                Some(i) if !idx.contains(&i) => idx.push(i),
                Some(_) => {}
                None => warnings.push(format!("No element {name} to match")),
            }
        }
        if idx.len() < 2 {
            continue;
        }
        match sets.iter().position(|s| s.iter().any(|i| idx.contains(i))) {
            Some(k) => {
                for i in idx {
                    if !sets[k].contains(&i) {
                        sets[k].push(i);
                    }
                }
            }
            None => sets.push(idx),
        }
    }
    let params_of = |ei: usize| -> HashMap<String, usize> {
        let en = &net.elements[ei].name;
        ss.params
            .iter()
            .enumerate()
            .filter(|(_, p)| &p.element == en)
            .map(|(i, p)| (kind_of(&p.name, en), i))
            .collect()
    };
    let mut members: HashMap<usize, Vec<String>> = HashMap::new();
    'groups: for set in &sets {
        let names: Vec<String> = set.iter().map(|&i| net.elements[i].name.clone()).collect();
        let letter = |i: usize| net.elements[i].name[..1].to_ascii_uppercase();
        if set.iter().any(|&i| letter(i) != letter(set[0])) {
            warnings.push(format!(
                "{} are different kinds of element, not matched",
                names.join(", ")
            ));
            continue;
        }
        if symbolic {
            // No values to compare: merge each kind across the members that
            // have it (g_mb exists only where the body is not tied to the
            // source).
            let all: Vec<HashMap<String, usize>> = set.iter().map(|&i| params_of(i)).collect();
            let mut kinds: Vec<&String> = all.iter().flat_map(|m| m.keys()).collect();
            kinds.sort();
            kinds.dedup();
            for k in kinds {
                let have: Vec<usize> = (0..set.len()).filter(|&m| all[m].contains_key(k)).collect();
                if have.len() < 2 {
                    continue;
                }
                let rep = all[have[0]][k];
                for &m in &have {
                    class[all[m][k]] = rep;
                }
                members.insert(rep, have.iter().map(|&m| names[m].clone()).collect());
            }
            continue;
        }
        let base = params_of(set[0]);
        let mut local_mismatch = 0.0f64;
        for &other in &set[1..] {
            let ps = params_of(other);
            let mut kinds: Vec<&String> = base.keys().collect();
            let mut okinds: Vec<&String> = ps.keys().collect();
            kinds.sort();
            okinds.sort();
            if kinds != okinds {
                warnings.push(format!(
                    "{} and {} differ, not matched",
                    names[0], net.elements[other].name
                ));
                continue 'groups;
            }
            for (k, &i) in &base {
                let (a, b) = (ss.params[i].value, ss.params[ps[k]].value);
                if a.is_nan() && b.is_nan() {
                    continue;
                }
                // Equal values (including two zeros) agree exactly; a NaN
                // against a number does not agree at all.
                let rel = if a == b {
                    0.0
                } else {
                    (a - b).abs() / a.abs().max(b.abs())
                };
                if rel.is_nan() || rel > MATCH_REL {
                    let _ = (a, b);
                    warnings.push(format!(
                        "{} and {} differ, not matched",
                        names[0], net.elements[other].name
                    ));
                    continue 'groups;
                }
                local_mismatch = local_mismatch.max(rel);
            }
        }
        mismatch = mismatch.max(local_mismatch);
        for &other in &set[1..] {
            let ps = params_of(other);
            for (k, &i) in &base {
                class[ps[k]] = i;
            }
        }
        for &i in base.values() {
            members.insert(i, names.clone());
        }
    }
    // Compact: one symbol per representative parameter, in parameter order.
    let mut index = vec![usize::MAX; np];
    let mut syms: Vec<Sym> = Vec::new();
    for &rep in &class {
        if index[rep] == usize::MAX {
            let p = &ss.params[rep];
            let kind = kind_of(&p.name, &p.element);
            let (latex, elements) = match members.get(&rep) {
                Some(els) => (merged_latex(&kind, els), els.clone()),
                None => (p.latex.clone(), vec![p.element.clone()]),
            };
            index[rep] = syms.len();
            syms.push(Sym {
                name: p.name.clone(),
                latex,
                value: p.value,
                inverted: p.inverted,
                reactive: p.reactive,
                role: p.role,
                unit: p.unit,
                elements,
                output_r: matches!(kind.as_str(), "ro" | "rmu" | "rbs" | "rbd"),
                leakage: matches!(kind.as_str(), "rmu" | "rbs" | "rbd"),
            });
        }
    }
    let class = class.iter().map(|&r| index[r]).collect();
    disambiguate(&mut syms);
    Symbols { syms, class, mismatch }
}

/// One symbol per parameter (no matching).
pub fn unmerged(ss: &SsCircuit) -> Symbols {
    let syms = ss
        .params
        .iter()
        .map(|p| Sym {
            name: p.name.clone(),
            latex: p.latex.clone(),
            value: p.value,
            inverted: p.inverted,
            reactive: p.reactive,
            role: p.role,
            unit: p.unit,
            elements: vec![p.element.clone()],
            output_r: matches!(kind_of(&p.name, &p.element).as_str(), "ro" | "rmu" | "rbs" | "rbd"),
            leakage: matches!(kind_of(&p.name, &p.element).as_str(), "rmu" | "rbs" | "rbd"),
        })
        .collect();
    Symbols {
        syms,
        class: (0..ss.params.len()).collect(),
        mismatch: 0.0,
    }
}

/// Distinct symbols that would render alike (e.g. merged M1,2 and Q1,2 both
/// as g_{m1,2}) get their element names spelled out.
fn disambiguate(syms: &mut [Sym]) {
    let mut seen: HashMap<String, usize> = HashMap::new();
    for s in syms.iter() {
        *seen.entry(s.latex.clone()).or_default() += 1;
    }
    for s in syms.iter_mut() {
        if seen[&s.latex] > 1 {
            let kind = kind_of(&s.name, &s.elements[0]);
            let all = s.elements.join(",");
            s.latex = match device_sub(&kind) {
                Some((base, sub)) => format!("{base}_{{{sub},{}}}", crate::ss::esc(&all)),
                None => format!("{}_{{{}}}", &all[..1], crate::ss::esc(&all)),
            };
        }
    }
}

/// Pairs worth offering as matched: same element type and model and the
/// same geometry (W, L, M or area); passives with equal values; and in
/// numeric mode the same small-signal values (to MATCH_REL).
pub fn match_candidates(net: &Netlist, ss: &SsCircuit, op: Option<&Op>) -> Vec<(String, String, &'static str)> {
    let same = |a: f64, b: f64| a == b || (a - b).abs() <= MATCH_REL * a.abs().max(b.abs());
    let key = |i: usize| -> Option<(String, Vec<f64>, &'static str)> {
        let e = &net.elements[i];
        let model_type = |ty: f64| if ty > 0.0 { "n" } else { "p" };
        match &e.kind {
            Kind::M { model, w, l, mult } if !model.name.is_empty() => Some((
                format!("M:{}:{}", model.name.to_ascii_lowercase(), model_type(model.ty)),
                vec![*w, *l, *mult],
                "device",
            )),
            Kind::Q { model, area } if !model.name.is_empty() => Some((
                format!("Q:{}:{}", model.name.to_ascii_lowercase(), model_type(model.ty)),
                vec![*area],
                "device",
            )),
            Kind::D { model, area } if !model.name.is_empty() => {
                Some((format!("D:{}", model.name.to_ascii_lowercase()), vec![*area], "device"))
            }
            Kind::R { value } | Kind::C { value } | Kind::L { value } if value.is_finite() => {
                Some((e.name[..1].to_ascii_uppercase(), vec![*value], "passive"))
            }
            _ => None,
        }
    };
    let values = |i: usize| -> Vec<(String, f64)> {
        let en = &net.elements[i].name;
        let mut v: Vec<(String, f64)> = ss
            .params
            .iter()
            .filter(|p| &p.element == en)
            .map(|p| (kind_of(&p.name, en), p.value))
            .collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    };
    // Topology: transistors pair as a diff pair (shared source / emitter) or
    // a mirror (shared gate / base), never when fully paralleled; passives
    // pair when they share exactly one terminal (RD1, RD2 from one supply to
    // the two outputs). Strength 2 when both are shared (a mirror at one
    // supply), 1 otherwise.
    let topology = |i: usize, j: usize| -> Option<u8> {
        let (a, b) = (&net.elements[i], &net.elements[j]);
        let (na, nb) = (&a.nodes, &b.nodes);
        match &a.kind {
            Kind::M { .. } | Kind::Q { .. } => {
                // M: [d, g, s, b] and Q: [c, b, e]: the control terminal
                // (gate, base) is node 1 and the common one (source, emitter)
                // node 2 in both.
                let (share_ctl, share_com) = (na[1] == nb[1], na[2] == nb[2]);
                if !(share_ctl || share_com) || na[..3] == nb[..3] {
                    return None;
                }
                Some(if share_ctl && share_com { 2 } else { 1 })
            }
            _ => {
                let shared = na.iter().filter(|n| nb.contains(n)).count();
                (shared == 1 && na.len() == 2 && na[0] != na[1] && nb[0] != nb[1]).then_some(1)
            }
        }
    };
    let qualifies = |i: usize, j: usize| -> Option<u8> {
        let (ki, gi, kind) = key(i)?;
        let (kj, gj, _) = key(j)?;
        if ki != kj || !gi.iter().zip(&gj).all(|(a, b)| same(*a, *b)) {
            return None;
        }
        let strength = topology(i, j)?;
        if op.is_some() && kind == "device" {
            let (vi, vj) = (values(i), values(j));
            if vi.len() != vj.len() || !vi.iter().zip(&vj).all(|(a, b)| a.0 == b.0 && same(a.1, b.1)) {
                return None;
            }
            // Same region too (values can coincide across regions only by accident).
            let region = |k: usize| match &op.unwrap().dev[k] {
                Some(DevOp::Mos(m)) => m.region.as_str().to_string(),
                Some(DevOp::Bjt(b)) => b.region.to_string(),
                _ => String::new(),
            };
            if region(i) != region(j) {
                return None;
            }
        }
        Some(strength)
    };
    let n = net.elements.len();
    let mut pairs: Vec<(u8, usize, usize)> = Vec::new();
    for i in 0..n {
        for j in i + 1..n {
            if let Some(st) = qualifies(i, j) {
                pairs.push((st, i, j));
            }
        }
    }
    // Strongest first; a pair may join two groups only if every pair across
    // them qualifies, so candidates never chain into an inconsistent group.
    pairs.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let mut group: Vec<usize> = (0..n).collect();
    let mut members: Vec<Vec<usize>> = (0..n).map(|i| vec![i]).collect();
    let mut out = Vec::new();
    for (_, i, j) in pairs {
        let (gi, gj) = (group[i], group[j]);
        if gi != gj {
            if !members[gi]
                .iter()
                .all(|&a| members[gj].iter().all(|&b| qualifies(a, b).is_some()))
            {
                continue;
            }
            let moved = std::mem::take(&mut members[gj]);
            for &m in &moved {
                group[m] = gi;
            }
            members[gi].extend(moved);
        }
        let kind = key(i).map(|k| k.2).unwrap_or("device");
        out.push((net.elements[i].name.clone(), net.elements[j].name.clone(), kind));
    }
    out
}

/// A polynomial over symbols with exponents, in MNA (conductance) form; the
/// power of s of a term is the total exponent of its reactive symbols.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct XPoly {
    pub terms: Vec<(Vec<u8>, i128)>,
}

impl XPoly {
    pub fn from_poly(p: &Poly, class: &[usize], nsym: usize) -> Result<XPoly, String> {
        let mut map: HashMap<Vec<u8>, i128> = HashMap::new();
        for (&m, &c) in &p.terms {
            let mut e = vec![0u8; nsym];
            let mut bits = m;
            while bits != 0 {
                let i = bits.trailing_zeros() as usize;
                e[class[i]] += 1;
                bits &= bits - 1;
            }
            let v = map.entry(e).or_insert(0);
            *v = v.checked_add(c).ok_or("coefficient overflow merging matched symbols")?;
        }
        let mut terms: Vec<(Vec<u8>, i128)> = map.into_iter().filter(|(_, c)| *c != 0).collect();
        terms.sort();
        Ok(XPoly { terms })
    }

    pub fn is_zero(&self) -> bool {
        self.terms.is_empty()
    }

    pub fn scaled(&self, k: i128) -> Result<XPoly, String> {
        let terms = self
            .terms
            .iter()
            .map(|(e, c)| {
                c.checked_mul(k)
                    .map(|c| (e.clone(), c))
                    .ok_or("coefficient overflow".to_string())
            })
            .collect::<Result<_, _>>()?;
        Ok(XPoly { terms })
    }

    pub fn neg(&self) -> XPoly {
        XPoly {
            terms: self.terms.iter().map(|(e, c)| (e.clone(), -c)).collect(),
        }
    }

    pub fn constant(c: i128, nsym: usize) -> XPoly {
        let terms = if c == 0 { Vec::new() } else { vec![(vec![0u8; nsym], c)] };
        XPoly { terms }
    }

    /// One symbol to the first power.
    pub fn var(k: usize, nsym: usize) -> XPoly {
        let mut e = vec![0u8; nsym];
        e[k] = 1;
        XPoly { terms: vec![(e, 1)] }
    }

    /// The same polynomial over `nsym` ≥ its current symbols (new ones absent).
    pub fn padded(&self, nsym: usize) -> XPoly {
        XPoly {
            terms: self
                .terms
                .iter()
                .map(|(e, c)| {
                    let mut e = e.clone();
                    e.resize(nsym, 0);
                    (e, *c)
                })
                .collect(),
        }
    }

    fn collect(map: std::collections::BTreeMap<Vec<u8>, i128>) -> XPoly {
        XPoly {
            terms: map.into_iter().filter(|(_, c)| *c != 0).collect(),
        }
    }

    pub fn add(&self, other: &XPoly) -> Result<XPoly, String> {
        let mut map: std::collections::BTreeMap<Vec<u8>, i128> = self.terms.iter().cloned().collect();
        for (e, c) in &other.terms {
            let v = map.entry(e.clone()).or_insert(0);
            *v = v.checked_add(*c).ok_or("coefficient overflow")?;
        }
        Ok(XPoly::collect(map))
    }

    /// Exact product; fails on coefficient or exponent overflow, or when the
    /// result would exceed `max_terms` terms.
    pub fn mul(&self, other: &XPoly, max_terms: usize) -> Result<XPoly, String> {
        let mut map: std::collections::BTreeMap<Vec<u8>, i128> = std::collections::BTreeMap::new();
        for (ea, ca) in &self.terms {
            for (eb, cb) in &other.terms {
                let e = ea
                    .iter()
                    .zip(eb)
                    .map(|(&x, &y)| x.checked_add(y))
                    .collect::<Option<Vec<u8>>>()
                    .ok_or("exponent overflow")?;
                let c = ca.checked_mul(*cb).ok_or("coefficient overflow")?;
                let v = map.entry(e).or_insert(0);
                *v = v.checked_add(c).ok_or("coefficient overflow")?;
            }
            if map.len() > max_terms {
                return Err(format!("expression too large (over {max_terms} terms)"));
            }
        }
        Ok(XPoly::collect(map))
    }
}

pub fn spow(e: &[u8], syms: &[Sym]) -> u32 {
    e.iter()
        .zip(syms)
        .filter(|(_, s)| s.reactive)
        .map(|(&k, _)| k as u32)
        .sum()
}

/// Hand-analysis limit r_o → ∞: with every device output resistance scaled
/// as r_o/ε (its conductance as ε·g_o), keep, for each power of s, only the
/// terms of lowest order in ε.
pub fn leading_order(p: &XPoly, syms: &[Sym]) -> XPoly {
    let order = |e: &[u8]| -> u32 {
        e.iter()
            .zip(syms)
            .filter(|(_, s)| s.output_r)
            .map(|(&k, _)| k as u32)
            .sum()
    };
    let mut best: HashMap<u32, u32> = HashMap::new();
    for (e, _) in &p.terms {
        let k = spow(e, syms);
        let o = order(e);
        let b = best.entry(k).or_insert(o);
        *b = (*b).min(o);
    }
    XPoly {
        terms: p
            .terms
            .iter()
            .filter(|(e, _)| order(e) == best[&spow(e, syms)])
            .cloned()
            .collect(),
    }
}
