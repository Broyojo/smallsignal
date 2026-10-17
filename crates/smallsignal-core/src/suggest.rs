//! Suggestions: further assumptions that move one quantity (gain, Zin or
//! Zout) little from the full model, measured numerically, so they work on
//! circuits whose exact form is over the term budget.
//!
//! Each candidate is one assumption unit not yet in effect (a term of one
//! element or of a matched group, `assume::units`), plus every transistor
//! type's term taken across all of that type ("r_o, all PMOS"). `alone` is
//! the deviation from the full model with the candidate added to the current
//! assumptions; the ones within the threshold are then accumulated greedily,
//! smallest first, each kept while the deviation of everything kept stays
//! within it. A candidate that would make the quantity unbounded (one the
//! analysis would put back, `assume::restore`) is left out.

use crate::assume::Term;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SuggestRequest {
    /// "gain", "rin" or "rout".
    pub quantity: String,
    /// Largest deviation from the full model (default 0.01).
    #[serde(default)]
    pub threshold: Option<f64>,
    /// Seconds before evaluation stops (default 20).
    #[serde(default)]
    pub time_limit: Option<f64>,
    /// Candidates evaluated at most (default 400).
    #[serde(default)]
    pub max_candidates: Option<usize>,
}

pub const DEFAULT_THRESHOLD: f64 = 0.01;
pub const DEFAULT_TIME_LIMIT_S: f64 = 20.0;
pub const DEFAULT_MAX_CANDIDATES: usize = 400;

impl SuggestRequest {
    /// The threshold, checked: finite and above 0.
    pub fn threshold(&self) -> Result<f64, String> {
        match self.threshold.unwrap_or(DEFAULT_THRESHOLD) {
            t if t.is_finite() && t > 0.0 => Ok(t),
            _ => Err("suggest: threshold must be above 0".to_string()),
        }
    }

    pub fn limits(&self) -> Result<Limits, String> {
        let time = self.time_limit.unwrap_or(DEFAULT_TIME_LIMIT_S);
        if time.is_nan() || time < 0.0 {
            return Err("suggest: timeLimit must be 0 or more".to_string());
        }
        Ok(Limits {
            time_ms: time * 1e3,
            candidates: self.max_candidates.unwrap_or(DEFAULT_MAX_CANDIDATES),
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub time_ms: f64,
    pub candidates: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// One element.
    Part,
    /// A matched group, which shares its assumptions.
    Group,
    /// Every element of one transistor type.
    Type,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Scope::Part => "part",
            Scope::Group => "group",
            Scope::Type => "type",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub elements: Vec<String>,
    pub term: Term,
    /// The elements' type, as `assumable` names it.
    pub ty: &'static str,
    pub scope: Scope,
}

impl Candidate {
    fn pairs(&self) -> impl Iterator<Item = (String, Term)> + '_ {
        self.elements.iter().map(move |e| (e.clone(), self.term))
    }
}

/// Every candidate on top of `current` (the assumptions in effect, by
/// element and term): `assumable` lists each element's type and terms,
/// `group` names an element's matched group. Type-wide candidates come first
/// (so a cap reaches them), then units in netlist and term order.
pub fn candidates(
    assumable: &[(String, &'static str, Vec<Term>)],
    current: &[(String, Term)],
    group: impl Fn(&str) -> String,
) -> Vec<Candidate> {
    let taken = |e: &str, t: Term| current.iter().any(|(x, u)| x == e && *u == t);
    let mut units: Vec<((String, Term), Candidate)> = Vec::new();
    for (element, ty, terms) in assumable {
        for &term in terms {
            let other = match term {
                Term::Open => Some(Term::Short),
                Term::Short => Some(Term::Open),
                _ => None,
            };
            if taken(element, term) || other.is_some_and(|o| taken(element, o)) {
                continue;
            }
            let key = (group(element), term);
            match units.iter_mut().find(|(k, _)| *k == key) {
                Some((_, c)) => {
                    c.elements.push(element.clone());
                    c.scope = Scope::Group;
                }
                None => units.push((
                    key,
                    Candidate {
                        elements: vec![element.clone()],
                        term,
                        ty,
                        scope: Scope::Part,
                    },
                )),
            }
        }
    }
    let units: Vec<Candidate> = units.into_iter().map(|(_, c)| c).collect();
    let mut out: Vec<Candidate> = Vec::new();
    for ty in ["nmos", "pmos", "npn", "pnp"] {
        let mut terms: Vec<Term> = units.iter().filter(|c| c.ty == ty).map(|c| c.term).collect();
        terms.sort();
        terms.dedup();
        for term in terms {
            let of: Vec<&Candidate> = units.iter().filter(|c| c.ty == ty && c.term == term).collect();
            if of.len() >= 2 {
                out.push(Candidate {
                    elements: of.iter().flat_map(|c| c.elements.iter().cloned()).collect(),
                    term,
                    ty,
                    scope: Scope::Type,
                });
            }
        }
    }
    out.extend(units);
    out
}

/// What a set of assumptions does to the quantity.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Outcome {
    /// The analysis would put an assumption back (or a different set than
    /// the current assumptions need).
    Unbounded,
    /// Worst relative distance from the full model over the check grid;
    /// NaN when there is nothing to compare (unbounded in both).
    Deviation(f64),
}

#[derive(Clone, Debug)]
pub struct Item {
    pub candidate: Candidate,
    pub alone: f64,
    /// The deviation with this and every earlier kept item; None when it is
    /// not in the greedy set.
    pub cumulative: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct Report {
    /// The current assumptions' deviation.
    pub base: Option<f64>,
    pub items: Vec<Item>,
    /// The deviation with every item whose `cumulative` is set.
    pub combined: Option<f64>,
    pub candidates: usize,
    pub evaluated: usize,
    /// Candidates left out because the quantity would be unbounded.
    pub unbounded: usize,
    /// "time" or "candidates" when a cap stopped the evaluation.
    pub capped: Option<&'static str>,
}

/// Evaluates `cands` with `eval` (the assumptions added to the current
/// ones, by element and term), keeps those within `threshold`, sorted, and
/// accumulates them greedily. `now` is the clock in ms (None: no time cap).
pub fn run(
    cands: Vec<Candidate>,
    threshold: f64,
    limits: Limits,
    now: impl Fn() -> Option<f64>,
    mut eval: impl FnMut(&[(String, Term)]) -> Outcome,
) -> Report {
    let start = now();
    let out_of_time = || matches!((start, now()), (Some(s), Some(t)) if t - s > limits.time_ms);
    let base = match eval(&[]) {
        Outcome::Deviation(d) if !d.is_nan() => Some(d),
        _ => None,
    };
    let total = cands.len();
    let mut capped = (total > limits.candidates).then_some("candidates");
    let (mut evaluated, mut unbounded) = (0, 0);
    let mut kept: Vec<(Candidate, f64)> = Vec::new();
    for c in cands.into_iter().take(limits.candidates) {
        if out_of_time() {
            capped = Some("time");
            break;
        }
        let pairs: Vec<(String, Term)> = c.pairs().collect();
        evaluated += 1;
        match eval(&pairs) {
            Outcome::Unbounded => unbounded += 1,
            Outcome::Deviation(d) if d <= threshold => kept.push((c, d)),
            Outcome::Deviation(_) => {}
        }
    }
    // Stable: equal deviations keep the candidates' order.
    kept.sort_by(|a, b| a.1.total_cmp(&b.1));
    let mut set: Vec<(String, Term)> = Vec::new();
    let mut combined = base;
    let mut items = Vec::new();
    for (c, alone) in kept {
        let has = |set: &[(String, Term)], e: &str, t: Term| set.iter().any(|(x, u)| x == e && *u == t);
        let new: Vec<(String, Term)> = c.pairs().filter(|(e, t)| !has(&set, e, *t)).collect();
        let conflict = new.iter().any(|(e, t)| match t {
            Term::Open => has(&set, e, Term::Short),
            Term::Short => has(&set, e, Term::Open),
            _ => false,
        });
        let cumulative = if new.is_empty() {
            // Already in the set, through a type-wide candidate.
            combined
        } else if conflict {
            None
        } else if out_of_time() {
            capped = Some("time");
            None
        } else {
            let trial: Vec<(String, Term)> = set.iter().cloned().chain(new.iter().cloned()).collect();
            match eval(&trial) {
                Outcome::Deviation(d) if d <= threshold => {
                    set = trial;
                    combined = Some(d);
                    Some(d)
                }
                _ => None,
            }
        };
        items.push(Item {
            candidate: c,
            alone,
            cumulative,
        });
    }
    Report {
        base,
        items,
        combined,
        candidates: total,
        evaluated,
        unbounded,
        capped,
    }
}

fn num_or_null(v: Option<f64>) -> Value {
    match v {
        Some(v) if v.is_finite() => json!(v),
        _ => Value::Null,
    }
}

impl Report {
    pub fn json(&self, quantity: &str, threshold: f64) -> Value {
        let items: Vec<Value> = self
            .items
            .iter()
            .map(|it| {
                json!({
                    "elements": it.candidate.elements,
                    "term": it.candidate.term.as_str(),
                    "type": it.candidate.ty,
                    "scope": it.candidate.scope.as_str(),
                    "alone": it.alone,
                    "cumulative": num_or_null(it.cumulative),
                })
            })
            .collect();
        json!({
            "quantity": quantity,
            "threshold": threshold,
            "base": num_or_null(self.base),
            "items": items,
            "combined": num_or_null(self.combined),
            "candidates": self.candidates,
            "evaluated": self.evaluated,
            "unbounded": self.unbounded,
            "capped": self.capped,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assumable() -> Vec<(String, &'static str, Vec<Term>)> {
        vec![
            ("M1".into(), "nmos", vec![Term::Ro, Term::Gmb]),
            ("M2".into(), "nmos", vec![Term::Ro, Term::Gmb]),
            ("M3".into(), "pmos", vec![Term::Ro]),
            ("M4".into(), "pmos", vec![Term::Ro]),
            ("M5".into(), "nmos", vec![Term::Ro]),
            ("C1".into(), "capacitor", vec![Term::Open, Term::Short]),
        ]
    }

    #[test]
    fn candidates_are_matched_group_units_and_type_wide() {
        let group = |e: &str| if e == "M2" { "M1".to_string() } else { e.to_string() };
        let current = [("M3".to_string(), Term::Ro), ("C1".to_string(), Term::Open)];
        let got = candidates(&assumable(), &current, group);
        let names: Vec<(Vec<&str>, Term, Scope)> = got
            .iter()
            .map(|c| (c.elements.iter().map(String::as_str).collect(), c.term, c.scope))
            .collect();
        assert_eq!(
            names,
            vec![
                // r_o of every NMOS: M1 = M2 and M5 (two units).
                (vec!["M1", "M2", "M5"], Term::Ro, Scope::Type),
                (vec!["M1", "M2"], Term::Ro, Scope::Group),
                (vec!["M1", "M2"], Term::Gmb, Scope::Group),
                // M3's r_o is in effect: M4 alone, no PMOS-wide candidate.
                (vec!["M4"], Term::Ro, Scope::Part),
                (vec!["M5"], Term::Ro, Scope::Part),
                // C1 is open: no short.
            ]
        );
    }

    /// Deviation is the sum of each assumption's weight; "M5:ro" unbounded.
    fn additive<'a>(weights: &'a [(&'a str, f64)]) -> impl FnMut(&[(String, Term)]) -> Outcome + 'a {
        move |set| {
            if set.iter().any(|(e, t)| e == "M5" && *t == Term::Ro) {
                return Outcome::Unbounded;
            }
            Outcome::Deviation(
                set.iter()
                    .map(|(e, _)| weights.iter().find(|(w, _)| w == e).map_or(0.0, |w| w.1))
                    .sum(),
            )
        }
    }

    #[test]
    fn greedy_set_stays_within_the_threshold() {
        let cands = candidates(&assumable(), &[], |e: &str| e.to_string());
        let weights = [
            ("M1", 0.004),
            ("M2", 0.003),
            ("M3", 0.0005),
            ("M4", 0.0005),
            ("C1", 0.02),
        ];
        let limits = Limits {
            time_ms: 1e9,
            candidates: 100,
        };
        let r = run(cands, 0.01, limits, || None, additive(&weights));
        assert_eq!(r.base, Some(0.0));
        // M5 (and every NMOS-wide set, which has it) is unbounded.
        assert!(r.unbounded >= 2);
        assert!(r.items.windows(2).all(|w| w[0].alone <= w[1].alone));
        for it in &r.items {
            assert!(it.alone <= 0.01);
            assert!(it.cumulative.is_none_or(|c| c <= 0.01));
        }
        // M3, M4, then M2's r_o and g_mb reach 0.007; M1's terms would
        // pass 0.01, so they are skipped.
        let kept: f64 = r.items.iter().filter_map(|i| i.cumulative).fold(0.0, f64::max);
        assert_eq!(r.combined, Some(kept));
        assert!(r.combined.unwrap() <= 0.01);
        assert!(r.items.iter().any(|i| i.cumulative.is_none()));
        assert!(r.capped.is_none());
    }

    #[test]
    fn caps_stop_the_evaluation() {
        let cands = candidates(&assumable(), &[], |e: &str| e.to_string());
        let n = cands.len();
        let r = run(
            cands.clone(),
            0.01,
            Limits {
                time_ms: 1e9,
                candidates: 2,
            },
            || None,
            additive(&[]),
        );
        assert_eq!((r.capped, r.evaluated, r.candidates), (Some("candidates"), 2, n));
        // A clock past the limit stops at once.
        let t = std::cell::Cell::new(0.0);
        let clock = || {
            t.set(t.get() + 10.0);
            Some(t.get())
        };
        let r = run(
            cands,
            0.01,
            Limits {
                time_ms: 5.0,
                candidates: 100,
            },
            clock,
            additive(&[]),
        );
        assert_eq!((r.capped, r.evaluated), (Some("time"), 0));
        assert!(r.items.is_empty());
    }
}
