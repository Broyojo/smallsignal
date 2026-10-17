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
    /// hand analysis takes to infinity. Not the r_o of a device outside
    /// saturation (MOS triode, BJT saturation), which is small.
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

/// The parameter kinds of `element` that belong to a device outside its
/// intended region (the r_o of a MOSFET in triode or a BJT in saturation),
/// sorted. Devices whose lists differ are in different regions.
fn linear_kinds(ss: &SsCircuit, element: &str) -> Vec<String> {
    let mut kinds: Vec<String> = ss
        .params
        .iter()
        .filter(|p| p.element == element && p.linear)
        .map(|p| kind_of(&p.name, element))
        .collect();
    kinds.sort();
    kinds
}

/// "A and B", "A, B and C".
fn name_list(names: &[String]) -> String {
    match names.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        _ => names.join(""),
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

pub(crate) fn merged_latex(kind: &str, elements: &[String]) -> String {
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
        // One symbol per kind must stand for one region: a saturated
        // device's r_o is taken to infinity in hand analysis, a triode
        // one's is not.
        let regions: Vec<Vec<String>> = names.iter().map(|n| linear_kinds(ss, n)).collect();
        if regions.iter().any(|r| *r != regions[0]) {
            warnings.push(format!("{} are in different regions, not matched", name_list(&names)));
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
                output_r: matches!(kind.as_str(), "ro" | "rmu" | "rbs" | "rbd") && !p.linear,
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
            output_r: matches!(kind_of(&p.name, &p.element).as_str(), "ro" | "rmu" | "rbs" | "rbd") && !p.linear,
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
/// same geometry (W, L, M or area) and region; passives with equal values;
/// and in numeric mode the same small-signal values (to MATCH_REL).
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
            Kind::Q { model, area, mult } if !model.name.is_empty() => Some((
                format!("Q:{}:{}", model.name.to_ascii_lowercase(), model_type(model.ty)),
                vec![*area, *mult],
                "device",
            )),
            Kind::D { model, area, mult } if !model.name.is_empty() => Some((
                format!("D:{}", model.name.to_ascii_lowercase()),
                vec![*area, *mult],
                "device",
            )),
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
        // In symbolic mode too, where the region is known from the wiring.
        if kind == "device" && linear_kinds(ss, &net.elements[i].name) != linear_kinds(ss, &net.elements[j].name) {
            return None;
        }
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

/// Largest left factor `XPoly::mul` multiplies by merging rows.
const ROW_MERGE_MAX: usize = 16;

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

    /// `add`, taking both operands (their terms move into the sum).
    pub fn add_owned(self, other: XPoly) -> Result<XPoly, String> {
        self.merge_owned(other, false)
    }

    /// `sub`, taking both operands.
    pub fn sub_owned(self, other: XPoly) -> Result<XPoly, String> {
        self.merge_owned(other, true)
    }

    fn merge_owned(self, other: XPoly, negate: bool) -> Result<XPoly, String> {
        use std::cmp::Ordering::*;
        if !strictly_sorted(&self.terms) || !strictly_sorted(&other.terms) {
            return self.merge(&other, negate);
        }
        let mut terms = Vec::with_capacity(self.terms.len() + other.terms.len());
        let mut a = self.terms.into_iter().peekable();
        let mut b = other
            .terms
            .into_iter()
            .map(|(e, c)| (e, if negate { -c } else { c }))
            .peekable();
        loop {
            let ord = match (a.peek(), b.peek()) {
                (Some(x), Some(y)) => x.0.cmp(&y.0),
                (Some(_), None) => Less,
                (None, Some(_)) => Greater,
                (None, None) => break,
            };
            let (e, c) = match ord {
                Less => a.next().expect("peeked"),
                Greater => b.next().expect("peeked"),
                Equal => {
                    let (e, x) = a.next().expect("peeked");
                    let (_, y) = b.next().expect("peeked");
                    (e, x.checked_add(y).ok_or("coefficient overflow")?)
                }
            };
            if c != 0 {
                terms.push((e, c));
            }
        }
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
        self.merge(other, false)
    }

    /// self − other, the same as `self.add(&other.neg())`.
    pub fn sub(&self, other: &XPoly) -> Result<XPoly, String> {
        self.merge(other, true)
    }

    /// self + other, or self − other when `negate`. When both are sorted
    /// without repeats (as `XPoly`s built here are), a merge: the same sum
    /// and checks, in the same order, as through the map.
    fn merge(&self, other: &XPoly, negate: bool) -> Result<XPoly, String> {
        use std::cmp::Ordering::*;
        let sign = |c: i128| if negate { -c } else { c };
        if !strictly_sorted(&self.terms) || !strictly_sorted(&other.terms) {
            let mut map: std::collections::BTreeMap<Vec<u8>, i128> = self.terms.iter().cloned().collect();
            for (e, c) in &other.terms {
                let v = map.entry(e.clone()).or_insert(0);
                *v = v.checked_add(sign(*c)).ok_or("coefficient overflow")?;
            }
            return Ok(XPoly::collect(map));
        }
        let mut terms = Vec::with_capacity(self.terms.len() + other.terms.len());
        let mut a = self.terms.iter().peekable();
        let mut b = other.terms.iter().peekable();
        loop {
            let (e, c) = match (a.peek(), b.peek()) {
                (Some(x), Some(y)) if x.0 == y.0 => {
                    let (e, x) = a.next().expect("peeked");
                    let (_, y) = b.next().expect("peeked");
                    (e, x.checked_add(sign(*y)).ok_or("coefficient overflow")?)
                }
                (Some(x), Some(y)) if x.0.cmp(&y.0) == Less => a.next().map(|(e, c)| (e, *c)).expect("peeked"),
                (Some(_), None) => a.next().map(|(e, c)| (e, *c)).expect("peeked"),
                (_, Some(_)) => b.next().map(|(e, c)| (e, sign(*c))).expect("peeked"),
                (None, None) => break,
            };
            if c != 0 {
                terms.push((e.clone(), c));
            }
        }
        Ok(XPoly { terms })
    }

    /// Exact product; fails on coefficient or exponent overflow, or when the
    /// result would exceed `max_terms` terms.
    pub fn mul(&self, other: &XPoly, max_terms: usize) -> Result<XPoly, String> {
        match (width(&self.terms), width(&other.terms)) {
            (Some(a), Some(b)) if a == b && other.terms.len() == 1 && strictly_sorted(&self.terms) => {
                self.mul_monomial(&other.terms[0], false, max_terms)
            }
            (Some(a), Some(b)) if a == b && self.terms.len() == 1 && strictly_sorted(&other.terms) => {
                other.mul_monomial(&self.terms[0], true, max_terms)
            }
            (Some(a), Some(b)) if a == b && self.terms.len() <= ROW_MERGE_MAX && strictly_sorted(&other.terms) => {
                self.mul_rows(other, a, max_terms)
            }
            (Some(a), Some(b)) => self.mul_table(other, a.min(b), max_terms),
            _ => self.mul_map(other, max_terms),
        }
    }

    /// `mul` by one term (`m`, as the left factor when `left`) of the same
    /// exponent length, self sorted without repeats: adding one exponent
    /// vector to each keeps them distinct and in order, so each product is
    /// a term of the result, in place (with `mul`'s checks, in its order).
    fn mul_monomial(&self, m: &(Vec<u8>, i128), left: bool, max_terms: usize) -> Result<XPoly, String> {
        let (em, cm) = m;
        let mut terms = Vec::with_capacity(self.terms.len());
        let mut count = 0;
        for (e, c) in &self.terms {
            let s = e
                .iter()
                .zip(em)
                .map(|(&x, &y)| x.checked_add(y))
                .collect::<Option<Vec<u8>>>()
                .ok_or("exponent overflow")?;
            let p = if left { cm.checked_mul(*c) } else { c.checked_mul(*cm) };
            let p = p.ok_or("coefficient overflow")?;
            count += 1;
            // `mul` checks the size after each term of its left factor.
            if !left && count > max_terms {
                return Err(format!("expression too large (over {max_terms} terms)"));
            }
            if p != 0 {
                terms.push((s, p));
            }
        }
        if count > max_terms {
            return Err(format!("expression too large (over {max_terms} terms)"));
        }
        Ok(XPoly { terms })
    }

    /// `mul` for any exponent lengths (each product as long as the shorter).
    fn mul_map(&self, other: &XPoly, max_terms: usize) -> Result<XPoly, String> {
        let mut map: std::collections::BTreeMap<Vec<u8>, i128> = std::collections::BTreeMap::new();
        let mut e: Vec<u8> = Vec::new();
        for (ea, ca) in &self.terms {
            for (eb, cb) in &other.terms {
                e.clear();
                for (&x, &y) in ea.iter().zip(eb) {
                    e.push(x.checked_add(y).ok_or("exponent overflow")?);
                }
                let c = ca.checked_mul(*cb).ok_or("coefficient overflow")?;
                match map.get_mut(e.as_slice()) {
                    Some(v) => *v = v.checked_add(c).ok_or("coefficient overflow")?,
                    None => {
                        map.insert(e.clone(), c);
                    }
                }
            }
            if map.len() > max_terms {
                return Err(format!("expression too large (over {max_terms} terms)"));
            }
        }
        Ok(XPoly::collect(map))
    }

    /// `mul` when every exponent vector of each factor has one length (`w`
    /// is the shorter): the same products, summed in the same order, in an
    /// open-addressing table, then sorted. The hash is linear in the packed
    /// words, so a product's hash is the sum of its factors'.
    fn mul_table(&self, other: &XPoly, w: usize, max_terms: usize) -> Result<XPoly, String> {
        const EMPTY: u32 = u32::MAX;
        let nw = words(w);
        let (pa, pb) = (pack(&self.terms, w), pack(&other.terms, w));
        // Odd multipliers per word (splitmix64).
        let mult: Vec<u64> = (0..nw as u64)
            .map(|k| {
                let mut z = k.wrapping_add(1).wrapping_mul(0x9E37_79B9_7F4A_7C15);
                z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
                z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
                (z ^ (z >> 31)) | 1
            })
            .collect();
        let hash = |ws: &[u64]| -> u64 {
            ws.iter()
                .zip(&mult)
                .fold(0u64, |h, (&x, &m)| h.wrapping_add(x.wrapping_mul(m)))
        };
        let hb: Vec<u64> = pb.chunks_exact(nw).map(hash).collect();
        let sb: Vec<bool> = other.terms.iter().map(|(_, c)| small(*c)).collect();
        let mut keys: Vec<u64> = Vec::new();
        let mut coefs: Vec<i128> = Vec::new();
        let mut hashes: Vec<u64> = Vec::new();
        let mut slots: Vec<u32> = vec![EMPTY; 64];
        let slot_of = |h: u64, mask: usize| ((h ^ (h >> 29)).wrapping_mul(0xBF58_476D_1CE4_E5B9) >> 17) as usize & mask;
        let mut e = vec![0u64; nw];
        for ((_, ca), wa) in self.terms.iter().zip(pa.chunks_exact(nw)) {
            let ha = hash(wa);
            let sa = small(*ca);
            for ((((_, cb), wb), &h), &sb) in other.terms.iter().zip(pb.chunks_exact(nw)).zip(&hb).zip(&sb) {
                if add_words(wa, wb, &mut e) {
                    return Err("exponent overflow".to_string());
                }
                let c = if sa && sb {
                    ca * cb
                } else {
                    ca.checked_mul(*cb).ok_or("coefficient overflow")?
                };
                let h = ha.wrapping_add(h);
                let mask = slots.len() - 1;
                let mut i = slot_of(h, mask);
                loop {
                    let k = slots[i];
                    if k == EMPTY {
                        slots[i] = coefs.len() as u32;
                        keys.extend_from_slice(&e);
                        coefs.push(c);
                        hashes.push(h);
                        break;
                    }
                    let k = k as usize;
                    if hashes[k] == h && keys[k * nw..(k + 1) * nw].iter().zip(&e).all(|(a, b)| a == b) {
                        coefs[k] = coefs[k].checked_add(c).ok_or("coefficient overflow")?;
                        break;
                    }
                    i = (i + 1) & mask;
                }
                if 2 * coefs.len() > slots.len() {
                    slots = vec![EMPTY; 2 * slots.len()];
                    let mask = slots.len() - 1;
                    for (k, &h) in hashes.iter().enumerate() {
                        let mut i = slot_of(h, mask);
                        while slots[i] != EMPTY {
                            i = (i + 1) & mask;
                        }
                        slots[i] = k as u32;
                    }
                }
            }
            if coefs.len() > max_terms {
                return Err(format!("expression too large (over {max_terms} terms)"));
            }
        }
        // Sorted by the first two words, then the rest (keys are distinct).
        let word = |k: usize, j: usize| if j < nw { keys[k * nw + j] } else { 0 };
        let mut order: Vec<(u128, usize)> = (0..coefs.len())
            .filter(|&k| coefs[k] != 0)
            .map(|k| ((word(k, 0) as u128) << 64 | word(k, 1) as u128, k))
            .collect();
        order.sort_unstable_by(|a, b| {
            a.0.cmp(&b.0).then_with(|| {
                let (x, y) = (a.1, b.1);
                keys[x * nw + 2.min(nw)..(x + 1) * nw].cmp(&keys[y * nw + 2.min(nw)..(y + 1) * nw])
            })
        });
        Ok(XPoly {
            terms: order
                .into_iter()
                .map(|(_, k)| (unpack(&keys[k * nw..(k + 1) * nw], w), coefs[k]))
                .collect(),
        })
    }

    /// `mul` of a few terms by `other` sorted without repeats, every
    /// exponent vector of length `w`: each term of self times `other` is
    /// sorted, so the result is built by merging one such row at a time
    /// into the sorted sum so far (with `mul`'s checks, in its order; terms
    /// that sum to zero stay until the end, as `mul` counts them).
    fn mul_rows(&self, other: &XPoly, w: usize, max_terms: usize) -> Result<XPoly, String> {
        let nw = words(w);
        let (pa, pb) = (pack(&self.terms, w), pack(&other.terms, w));
        let sb: Vec<bool> = other.terms.iter().map(|(_, c)| small(*c)).collect();
        let (mut keys, mut coefs): (Vec<u64>, Vec<i128>) = (Vec::new(), Vec::new());
        let mut e = vec![0u64; nw];
        for ((_, ca), wa) in self.terms.iter().zip(pa.chunks_exact(nw)) {
            let sa = small(*ca);
            let mut nkeys: Vec<u64> = Vec::with_capacity(keys.len() + pb.len());
            let mut ncoefs: Vec<i128> = Vec::with_capacity(coefs.len() + other.terms.len());
            let mut i = 0;
            for (((_, cb), wb), &sb) in other.terms.iter().zip(pb.chunks_exact(nw)).zip(&sb) {
                if add_words(wa, wb, &mut e) {
                    return Err("exponent overflow".to_string());
                }
                let c = if sa && sb {
                    ca * cb
                } else {
                    ca.checked_mul(*cb).ok_or("coefficient overflow")?
                };
                while i < coefs.len() && keys[i * nw..(i + 1) * nw] < e[..] {
                    nkeys.extend_from_slice(&keys[i * nw..(i + 1) * nw]);
                    ncoefs.push(coefs[i]);
                    i += 1;
                }
                nkeys.extend_from_slice(&e);
                if i < coefs.len() && keys[i * nw..(i + 1) * nw] == e[..] {
                    ncoefs.push(coefs[i].checked_add(c).ok_or("coefficient overflow")?);
                    i += 1;
                } else {
                    ncoefs.push(c);
                }
            }
            nkeys.extend_from_slice(&keys[i * nw..]);
            ncoefs.extend_from_slice(&coefs[i..]);
            (keys, coefs) = (nkeys, ncoefs);
            if coefs.len() > max_terms {
                return Err(format!("expression too large (over {max_terms} terms)"));
            }
        }
        Ok(XPoly {
            terms: (0..coefs.len())
                .filter(|&k| coefs[k] != 0)
                .map(|k| (unpack(&keys[k * nw..(k + 1) * nw], w), coefs[k]))
                .collect(),
        })
    }
}

/// u64 words per packed exponent vector of length `w`.
fn words(w: usize) -> usize {
    w.div_ceil(8).max(1)
}

/// Exponent vectors (their first `w` entries) packed big-endian into u64
/// words, so that word order is the vectors' order.
fn pack(terms: &[(Vec<u8>, i128)], w: usize) -> Vec<u64> {
    let mut out = Vec::with_capacity(terms.len() * words(w));
    for (e, _) in terms {
        let mut chunks = e[..w].chunks(8);
        for _ in 0..words(w) {
            let mut b = [0u8; 8];
            if let Some(c) = chunks.next() {
                b[..c.len()].copy_from_slice(c);
            }
            out.push(u64::from_be_bytes(b));
        }
    }
    out
}

fn unpack(ws: &[u64], w: usize) -> Vec<u8> {
    let mut e = Vec::with_capacity(w);
    for x in ws {
        let b = x.to_be_bytes();
        e.extend_from_slice(&b[..(w - e.len()).min(8)]);
    }
    e
}

/// Bytewise sum of packed exponents into `out`; true when any byte would
/// exceed 255 (a carry out of its bit 7).
fn add_words(a: &[u64], b: &[u64], out: &mut [u64]) -> bool {
    const HIGH: u64 = 0x8080_8080_8080_8080;
    let mut over = 0u64;
    for ((s, &x), &y) in out.iter_mut().zip(a).zip(b) {
        let low = (x & !HIGH) + (y & !HIGH);
        over |= ((x & y) | ((x | y) & low)) & HIGH;
        *s = x.wrapping_add(y);
    }
    over != 0
}

/// A coefficient that fits in i64 (a product of two cannot overflow i128).
fn small(c: i128) -> bool {
    i64::try_from(c).is_ok()
}

/// The common length of the exponent vectors (None when they differ or
/// there are none).
fn width(terms: &[(Vec<u8>, i128)]) -> Option<usize> {
    let w = terms.first()?.0.len();
    terms.iter().all(|(e, _)| e.len() == w).then_some(w)
}

/// Exponent vectors in strictly increasing order (so without repeats).
fn strictly_sorted(terms: &[(Vec<u8>, i128)]) -> bool {
    terms.windows(2).all(|w| w[0].0 < w[1].0)
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
    lowest_order(p, syms, |s| s.output_r)
}

/// Hand-analysis limit g_mb ≪ g_m: the same with every g_mb scaled as ε·g_mb
/// (taken after r_o → ∞, as 1/r_o ≪ g_mb).
pub fn body_order(p: &XPoly, syms: &[Sym]) -> XPoly {
    lowest_order(p, syms, |s| s.role == Role::Gmb)
}

/// For each power of s, the terms of lowest total degree in the symbols with
/// `small`.
fn lowest_order(p: &XPoly, syms: &[Sym], small: fn(&Sym) -> bool) -> XPoly {
    // Σ e[k] over the symbols with `flag`, as e.iter().zip(syms).filter(..).
    let sum_of = |flag: fn(&Sym) -> bool| {
        let idx: Vec<usize> = (0..syms.len()).filter(|&k| flag(&syms[k])).collect();
        move |e: &[u8]| -> u32 { idx.iter().filter_map(|&k| e.get(k)).map(|&x| x as u32).sum() }
    };
    let (spow, order) = (sum_of(|s| s.reactive), sum_of(small));
    let keys: Vec<(u32, u32)> = p.terms.iter().map(|(e, _)| (spow(e), order(e))).collect();
    // Lowest order per power of s (few powers: a short list).
    let mut best: Vec<(u32, u32)> = Vec::new();
    for &(k, o) in &keys {
        match best.iter_mut().find(|b| b.0 == k) {
            Some(b) => b.1 = b.1.min(o),
            None => best.push((k, o)),
        }
    }
    let best_of = |k: u32| best.iter().find(|b| b.0 == k).map(|b| b.1);
    XPoly {
        terms: p
            .terms
            .iter()
            .zip(&keys)
            .filter(|(_, &(k, o))| best_of(k) == Some(o))
            .map(|(t, _)| t.clone())
            .collect(),
    }
}
