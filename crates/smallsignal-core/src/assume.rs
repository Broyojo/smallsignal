//! Per-device small-signal assumptions: terms an engineer neglects (a
//! device's r_o, g_mb, r_π, r_μ, bulk junctions; a passive taken open or
//! shorted) and regions an engineer expects.
//!
//! Every assumption is an exact limit taken before expansion. Each minor of
//! the MNA matrix is multilinear in the parameters, so neglecting a
//! conductance (r → ∞) is substituting 0 for it: its stamps are left out
//! (`SsCircuit::omit`). A short (C → ∞, R, L or r_d → 0) is the leading
//! coefficient in that parameter: its nodes are merged (`Stamp::Short`).
//! An open C (C → 0) is left out; an open R, L or diode is the limit
//! R, L, r_d → ∞, which leaves the element out too.
//!
//! The operating point always comes from the full netlist, and a region is
//! only checked against it, never imposed. When a substitution makes a
//! quantity's denominator vanish identically (a node held only by the r_o
//! that was neglected), the smallest set of assumptions that avoids it is
//! put back for that quantity, with a label (`restore`).

use crate::dc::{DevOp, Op};
use crate::netlist::{Kind, Netlist};
use crate::ss::{elem_latex, SsCircuit, Stamp};
use num_complex::Complex64;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssumeRequest {
    /// Terms taken to their limit, e.g. {element: "M1", term: "ro"}.
    #[serde(default)]
    pub ignore: Vec<IgnoreRequest>,
    /// Regions to check against the operating point.
    #[serde(default)]
    pub regions: Vec<RegionRequest>,
    /// Feedback capacitances split by the Miller approximation (`miller`).
    #[serde(default)]
    pub miller: Vec<crate::miller::MillerRequest>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct IgnoreRequest {
    pub element: String,
    pub term: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct RegionRequest {
    pub element: String,
    pub region: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Term {
    Ro,
    Gmb,
    Rbs,
    Rbd,
    Rpi,
    Rmu,
    /// Device capacitances, each taken to 0.
    Cgs,
    Cgd,
    Cgb,
    Cbs,
    Cbd,
    Cpi,
    Cmu,
    /// A BJT's substrate capacitance, to the collector or (lateral) base.
    Ccs,
    /// A diode's junction capacitance.
    Cj,
    Open,
    Short,
}

impl Term {
    pub fn as_str(self) -> &'static str {
        match self {
            Term::Ro => "ro",
            Term::Gmb => "gmb",
            Term::Rbs => "rbs",
            Term::Rbd => "rbd",
            Term::Rpi => "rpi",
            Term::Rmu => "rmu",
            Term::Cgs => "cgs",
            Term::Cgd => "cgd",
            Term::Cgb => "cgb",
            Term::Cbs => "cbs",
            Term::Cbd => "cbd",
            Term::Cpi => "cpi",
            Term::Cmu => "cmu",
            Term::Ccs => "ccs",
            Term::Cj => "cj",
            Term::Open => "open",
            Term::Short => "short",
        }
    }

    pub fn parse(s: &str) -> Option<Term> {
        Some(match s.trim() {
            "ro" => Term::Ro,
            "gmb" => Term::Gmb,
            "rbs" => Term::Rbs,
            "rbd" => Term::Rbd,
            "rpi" => Term::Rpi,
            "rmu" => Term::Rmu,
            "cgs" => Term::Cgs,
            "cgd" => Term::Cgd,
            "cgb" => Term::Cgb,
            "cbs" => Term::Cbs,
            "cbd" => Term::Cbd,
            "cpi" => Term::Cpi,
            "cmu" => Term::Cmu,
            "ccs" => Term::Ccs,
            "cj" => Term::Cj,
            "open" => Term::Open,
            "short" => Term::Short,
            _ => return None,
        })
    }
}

/// The terms an element of this kind can take.
pub fn terms_for(kind: &Kind) -> &'static [Term] {
    match kind {
        Kind::M { .. } => &[
            Term::Ro,
            Term::Gmb,
            Term::Rbs,
            Term::Rbd,
            Term::Cgs,
            Term::Cgd,
            Term::Cgb,
            Term::Cbs,
            Term::Cbd,
        ],
        Kind::Q { .. } => &[Term::Ro, Term::Rpi, Term::Rmu, Term::Cpi, Term::Cmu, Term::Ccs],
        Kind::D { .. } => &[Term::Open, Term::Short, Term::Cj],
        Kind::R { .. } | Kind::C { .. } | Kind::L { .. } => &[Term::Open, Term::Short],
        _ => &[],
    }
}

/// Regions an element of this kind can be in (as `op` names them).
fn regions_for(kind: &Kind) -> &'static [&'static str] {
    match kind {
        Kind::M { .. } => &["saturation", "triode", "cutoff"],
        Kind::Q { .. } => &["forward-active", "saturation", "reverse-active", "cutoff"],
        _ => &[],
    }
}

/// The full model's parameter that `term` removes from `element`.
fn param_name(kind: &Kind, term: Term, element: &str) -> String {
    match (term, kind) {
        (Term::Open | Term::Short, Kind::D { .. }) => format!("rd_{element}"),
        (Term::Open | Term::Short, _) => element.to_string(),
        // A lateral device's substrate capacitance ends at the base.
        (Term::Ccs, Kind::Q { model, .. }) if model.caps.subs < 0.0 => format!("cbsub_{element}"),
        (t, _) => format!("{}_{element}", t.as_str()),
    }
}

/// One assumption as applied to the full model.
#[derive(Clone, Debug)]
pub struct Applied {
    /// The element's netlist name.
    pub element: String,
    pub term: Term,
    /// The full model's parameter it removes (None for a short of an
    /// element the model does not have, a capacitor of 0 F).
    pub param: Option<usize>,
    /// The nodes it shorts.
    pub short: Option<(usize, usize)>,
}

#[derive(Clone, Debug)]
pub struct RegionCheck {
    pub element: String,
    pub assumed: String,
    /// The operating point's region; None in symbolic mode.
    pub actual: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Assume {
    pub applied: Vec<Applied>,
    /// Asked for, but the full model has no such parameter (e.g. g_mb with
    /// the body on the source, r_bs of a junction with no conductance).
    pub absent: Vec<(String, Term)>,
    pub regions: Vec<RegionCheck>,
    /// Capacitances to split (`miller`).
    pub miller: Vec<crate::miller::Target>,
}

/// Validates the request against the netlist and maps each term onto the
/// full model's parameter.
pub fn resolve(net: &Netlist, full: &SsCircuit, op: Option<&Op>, req: &AssumeRequest) -> Result<Assume, String> {
    let mut out = Assume::default();
    let mut seen: Vec<(usize, Term)> = Vec::new();
    for item in &req.ignore {
        let ei = net
            .element(&item.element)
            .ok_or_else(|| format!("assume: no element '{}'", item.element.trim()))?;
        let e = &net.elements[ei];
        let term = Term::parse(&item.term)
            .filter(|t| terms_for(&e.kind).contains(t))
            .ok_or_else(|| format!("assume: {} has no term {}", e.name, item.term.trim()))?;
        if seen.contains(&(ei, term)) {
            continue;
        }
        let other = match term {
            Term::Open => Some(Term::Short),
            Term::Short => Some(Term::Open),
            _ => None,
        };
        if other.is_some_and(|o| seen.contains(&(ei, o))) {
            return Err(format!("assume: {} cannot be both open and short", e.name));
        }
        seen.push((ei, term));
        let name = param_name(&e.kind, term, &e.name);
        let param = full.params.iter().position(|p| p.name == name && p.element == e.name);
        let short = (term == Term::Short).then(|| (e.nodes[0], e.nodes[1]));
        if param.is_none() && short.is_none() {
            out.absent.push((e.name.clone(), term));
            continue;
        }
        out.applied.push(Applied {
            element: e.name.clone(),
            term,
            param,
            short,
        });
    }
    out.miller = crate::miller::resolve(net, full, &req.miller, &seen)?;
    for item in &req.regions {
        let ei = net
            .element(&item.element)
            .ok_or_else(|| format!("assume: no element '{}'", item.element.trim()))?;
        let e = &net.elements[ei];
        let region = item.region.trim();
        if !regions_for(&e.kind).contains(&region) {
            return Err(format!("assume: {} has no region {region}", e.name));
        }
        if out.regions.iter().any(|r| r.element == e.name) {
            return Err(format!("assume: {} has two regions", e.name));
        }
        let actual = op.and_then(|op| match &op.dev[ei] {
            Some(DevOp::Mos(m)) => Some(m.region.as_str().to_string()),
            Some(DevOp::Bjt(q)) => Some(q.region.to_string()),
            _ => None,
        });
        out.regions.push(RegionCheck {
            element: e.name.clone(),
            assumed: region.to_string(),
            actual,
        });
    }
    Ok(out)
}

/// The full model under the assumptions, except those whose index is in
/// `restored`.
pub fn apply(full: &SsCircuit, a: &Assume, restored: &[usize]) -> SsCircuit {
    let active = || a.applied.iter().enumerate().filter(|(i, _)| !restored.contains(i));
    let drop: Vec<usize> = active().filter_map(|(_, x)| x.param).collect();
    let mut model = full.omit(&drop);
    for (_, x) in active() {
        if let Some((a, b)) = x.short {
            model.stamps.push(Stamp::Short { a, b });
        }
    }
    model
}

/// The assumptions that are put back together: one unit per term and
/// matched group (`group` names an element's group), ordered by group and
/// term, not by the request.
pub fn units(a: &Assume, group: impl Fn(&str) -> String) -> Vec<Vec<usize>> {
    let mut out: Vec<((String, Term), Vec<usize>)> = Vec::new();
    for (i, x) in a.applied.iter().enumerate() {
        let k = (group(&x.element), x.term);
        match out.iter_mut().find(|(q, _)| *q == k) {
            Some((_, u)) => u.push(i),
            None => out.push((k, vec![i])),
        }
    }
    out.sort_by(|x, y| x.0.cmp(&y.0));
    out.into_iter().map(|(_, u)| u).collect()
}

/// Sets of three units are searched only while there are at most this many
/// (30 units); sets of one and two always are.
const RESTORE_TRIPLES: usize = 4_060;

/// Which assumptions to put back so that `singular` (given the assumption
/// indices put back) no longer holds: none when it does not hold to begin
/// with. Otherwise every unit that belongs to some smallest set of units
/// that suffices (their union, so the answer does not depend on the order
/// of the request: a CS stage with an active load gets both r_o back),
/// searched over every set of one and two units, and of three while there
/// are at most 30 units. Past that, an irreducible set found by putting
/// every unit back and taking units out again, in `units`' (canonical)
/// order, while it still suffices.
pub fn restore(units: &[Vec<usize>], singular: impl Fn(&[usize]) -> bool) -> Vec<usize> {
    if units.is_empty() || !singular(&[]) {
        return Vec::new();
    }
    let flat = |set: &[usize]| -> Vec<usize> { set.iter().flat_map(|&u| units[u].iter().copied()).collect() };
    let n = units.len();
    for k in 1..=3.min(n) {
        if k == 3 && binomial(n, 3) > RESTORE_TRIPLES {
            break;
        }
        let mut found: Vec<usize> = Vec::new();
        let mut combo: Vec<usize> = (0..k).collect();
        loop {
            if !singular(&flat(&combo)) {
                for &u in &combo {
                    if !found.contains(&u) {
                        found.push(u);
                    }
                }
            }
            // Next combination in lexicographic order.
            let Some(i) = (0..k).rev().find(|&i| combo[i] != i + n - k) else {
                break;
            };
            combo[i] += 1;
            for j in i + 1..k {
                combo[j] = combo[j - 1] + 1;
            }
        }
        if !found.is_empty() {
            found.sort_unstable();
            return flat(&found);
        }
    }
    let mut set: Vec<usize> = (0..n).collect();
    for u in 0..n {
        let without: Vec<usize> = set.iter().copied().filter(|&x| x != u).collect();
        if !singular(&flat(&without)) {
            set = without;
        }
    }
    flat(&set)
}

fn binomial(n: usize, k: usize) -> usize {
    (0..k).fold(1usize, |acc, i| acc.saturating_mul(n - i) / (i + 1))
}

/// LaTeX of an applied assumption with its symbol, e.g. `r_{o1} \to \infty`,
/// `g_{mb1} = 0`, `C_{1} \to \infty` (shorted).
pub fn latex_of(net: &Netlist, x: &Applied, symbol: Option<&str>) -> String {
    let fallback;
    let sym = match symbol {
        Some(s) => s,
        None => {
            fallback = elem_latex(&x.element);
            &fallback
        }
    };
    let capacitor = net
        .element(&x.element)
        .is_some_and(|ei| matches!(net.elements[ei].kind, Kind::C { .. }));
    let to_inf = match x.term {
        Term::Gmb
        | Term::Cgs
        | Term::Cgd
        | Term::Cgb
        | Term::Cbs
        | Term::Cbd
        | Term::Cpi
        | Term::Cmu
        | Term::Ccs
        | Term::Cj => false,
        Term::Open => !capacitor,
        Term::Short => capacitor,
        _ => true,
    };
    if to_inf {
        format!("{sym} \\to \\infty")
    } else {
        format!("{sym} = 0")
    }
}

/// Every element that can take an assumption, with the terms its full
/// model has (a short always applies).
pub fn assumable(net: &Netlist, full: &SsCircuit) -> Value {
    let mut out = Vec::new();
    for e in &net.elements {
        let terms: Vec<&str> = terms_for(&e.kind)
            .iter()
            .filter(|&&t| {
                t == Term::Short || {
                    let name = param_name(&e.kind, t, &e.name);
                    full.params.iter().any(|p| p.name == name && p.element == e.name)
                }
            })
            .map(|t| t.as_str())
            .collect();
        if terms.is_empty() {
            continue;
        }
        let ty = match &e.kind {
            Kind::M { model, .. } if model.ty > 0.0 => "nmos",
            Kind::M { .. } => "pmos",
            Kind::Q { model, .. } if model.ty > 0.0 => "npn",
            Kind::Q { .. } => "pnp",
            Kind::D { .. } => "diode",
            Kind::R { .. } => "resistor",
            Kind::C { .. } => "capacitor",
            _ => "inductor",
        };
        out.push(json!({ "element": e.name, "type": ty, "terms": terms }));
    }
    Value::Array(out)
}

/// Relative distance of a value from the full model's: |h − f| over |f|,
/// floored at `floor` (1e-3 of the full response's peak, so a zero of the
/// response does not dominate). One of them infinite: ∞; both: NaN, there
/// is nothing to compare (reported as null).
pub fn distance(h: Option<Complex64>, f: Option<Complex64>, floor: f64) -> f64 {
    match (h, f) {
        (None, None) => f64::NAN,
        (Some(h), Some(f)) => {
            let d = (h - f).norm();
            if d == 0.0 {
                0.0
            } else {
                d / f.norm().max(floor)
            }
        }
        _ => f64::INFINITY,
    }
}

/// The floor of `distance` for a full response: 1e-3 of its largest finite
/// magnitude.
pub fn floor_of(full: &[Option<Complex64>]) -> f64 {
    1e-3 * full.iter().flatten().map(|z| z.norm()).fold(0.0, f64::max)
}

/// Greedy pairing of the assumed model's roots with the full model's (both
/// in Hz): the closest pair first by |ln|a| − ln|f|| + |arg a − arg f|, only
/// within a factor of 10 in magnitude. Roots at DC (below 1e-12 of the
/// largest) pair only with each other. Unpaired roots get None on the other
/// side. Returns (assumed, full, relative error), full roots first in their
/// order, then the unpaired assumed roots.
pub fn pair_roots(
    assumed: &[Complex64],
    full: &[Complex64],
) -> Vec<(Option<Complex64>, Option<Complex64>, Option<f64>)> {
    let max = assumed.iter().chain(full).map(|z| z.norm()).fold(0.0, f64::max);
    let dc = |z: &Complex64| z.norm() <= 1e-12 * max;
    let mut cands: Vec<(f64, usize, usize)> = Vec::new();
    for (i, a) in assumed.iter().enumerate() {
        for (j, f) in full.iter().enumerate() {
            let cost = match (dc(a), dc(f)) {
                (true, true) => 0.0,
                (false, false) => {
                    let ratio = a.norm() / f.norm();
                    if !(0.1..=10.0).contains(&ratio) {
                        continue;
                    }
                    let mut darg = (a.arg() - f.arg()).abs();
                    if darg > std::f64::consts::PI {
                        darg = 2.0 * std::f64::consts::PI - darg;
                    }
                    ratio.ln().abs() + darg
                }
                _ => continue,
            };
            cands.push((cost, i, j));
        }
    }
    cands.sort_by(|x, y| x.0.total_cmp(&y.0).then(x.2.cmp(&y.2)).then(x.1.cmp(&y.1)));
    let mut of_full: Vec<Option<usize>> = vec![None; full.len()];
    let mut used = vec![false; assumed.len()];
    for (_, i, j) in cands {
        if !used[i] && of_full[j].is_none() {
            used[i] = true;
            of_full[j] = Some(i);
        }
    }
    let rel = |a: Complex64, f: Complex64| {
        if f.norm() > 0.0 {
            Some((a - f).norm() / f.norm())
        } else if a.norm() == 0.0 {
            Some(0.0)
        } else {
            None
        }
    };
    let mut out: Vec<(Option<Complex64>, Option<Complex64>, Option<f64>)> = full
        .iter()
        .zip(&of_full)
        .map(|(&f, i)| match i {
            Some(i) => (Some(assumed[*i]), Some(f), rel(assumed[*i], f)),
            None => (None, Some(f), None),
        })
        .collect();
    for (i, &a) in assumed.iter().enumerate() {
        if !used[i] {
            out.push((Some(a), None, None));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_takes_the_union_of_the_smallest_fixes() {
        // Singular unless unit 1 or unit 2 is back (a node held by two r_o).
        let units = vec![vec![0], vec![1], vec![2]];
        let got = restore(&units, |r| !(r.contains(&1) || r.contains(&2)));
        assert_eq!(got, vec![1, 2]);
        // Two needed together (a cascode): none alone suffices.
        let got = restore(&units, |r| !(r.contains(&0) && r.contains(&2)));
        assert_eq!(got, vec![0, 2]);
        // Not singular: nothing comes back.
        assert!(restore(&units, |_| false).is_empty());
    }

    #[test]
    fn every_pair_is_searched_however_many_units() {
        // 89 units, two pairs that each suffice: their union, never one
        // irreducible set picked by order.
        let units: Vec<Vec<usize>> = (0..89).map(|i| vec![i]).collect();
        let fix = |r: &[usize]| (r.contains(&5) && r.contains(&77)) || (r.contains(&6) && r.contains(&78));
        assert_eq!(restore(&units, |r| !fix(r)), vec![5, 6, 77, 78]);
        // 30 units: every triple too.
        let units: Vec<Vec<usize>> = (0..30).map(|i| vec![i]).collect();
        let fix = |r: &[usize]| [3, 17, 29].iter().all(|u| r.contains(u)) || [4, 17, 28].iter().all(|u| r.contains(u));
        assert_eq!(restore(&units, |r| !fix(r)), vec![3, 4, 17, 28, 29]);
    }

    #[test]
    fn roots_pair_by_magnitude_and_phase() {
        let c = |re: f64, im: f64| Complex64::new(re, im);
        let full = [c(-1e3, 0.0), c(-1e6, 1e6), c(-1e6, -1e6)];
        let assumed = [c(-1.1e6, -1e6), c(-1.1e6, 1e6), c(-5e9, 0.0)];
        let p = pair_roots(&assumed, &full);
        assert_eq!(p[0], (None, Some(full[0]), None));
        assert_eq!(p[1].0, Some(assumed[1]));
        assert_eq!(p[2].0, Some(assumed[0]));
        assert_eq!(p[3], (Some(assumed[2]), None, None));
        // DC roots pair only with each other.
        let p = pair_roots(&[c(0.0, 0.0)], &[c(0.0, 0.0), c(-1.0, 0.0)]);
        assert_eq!(p[0], (Some(c(0.0, 0.0)), Some(c(0.0, 0.0)), Some(0.0)));
        assert_eq!(p[1], (None, Some(c(-1.0, 0.0)), None));
    }
}
