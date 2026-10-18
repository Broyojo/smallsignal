//! Named-assumption simplified forms (`approx: "named"`): the terms such a
//! form may assume and how its label reads.
//!
//! The form itself is the exact form of the model under a set of named
//! assumptions (`assume`), chosen by the `suggest` search on the numbers;
//! `analyze` builds it. Here: which terms are candidates, whether one
//! appears in a form, and the label, e.g. "r_o2 → ∞" or
//! "r_o → ∞ for M2, M4 and g_mb → 0".

use crate::assume::Term;
use crate::sym::Sym;

/// The assumptions a named form may make: output resistances to infinity,
/// body effect and junction leakage neglected, device capacitances to 0.
/// Never r_π, a passive's open or short, or a Miller split.
pub const NAMED_TERMS: &[Term] = &[
    Term::Ro,
    Term::Gmb,
    Term::Rbs,
    Term::Rbd,
    Term::Rmu,
    Term::Cgs,
    Term::Cgd,
    Term::Cgb,
    Term::Cbs,
    Term::Cbd,
    Term::Cpi,
    Term::Cmu,
    Term::Ccs,
    Term::Cj,
];

/// One assumption unit of a named form: a term of one element or of a
/// matched group, with its symbol's LaTeX (r_{o2}, r_{o1,2}).
#[derive(Clone, Debug, PartialEq)]
pub struct Unit {
    pub elements: Vec<String>,
    pub term: Term,
    pub symbol: Option<String>,
}

/// A symbol's kind within its element: "ro" for ro_M1 (r_{o1,2} too).
pub fn sym_kind(s: &Sym) -> &str {
    let first = s.elements.first().map(String::as_str).unwrap_or("");
    s.name
        .strip_suffix(first)
        .and_then(|k| k.strip_suffix('_'))
        .unwrap_or("")
}

/// The symbol standing for `kind` (a parameter kind, "ro") of `element`.
pub fn symbol_of<'a>(syms: &'a [Sym], element: &str, kind: &str) -> Option<(usize, &'a Sym)> {
    syms.iter()
        .enumerate()
        .find(|(_, s)| s.elements.iter().any(|e| e == element) && sym_kind(s) == kind)
}

fn group(t: Term) -> usize {
    match t {
        Term::Ro => 0,
        Term::Gmb => 1,
        Term::Rbs | Term::Rbd | Term::Rmu => 2,
        _ => 3,
    }
}

/// The limit a term is taken to, as the label writes it.
fn limit(t: Term) -> &'static str {
    match t {
        Term::Ro | Term::Rbs | Term::Rbd | Term::Rmu => "∞",
        _ => "0",
    }
}

/// The symbol of a term without its element: r_o, g_mb, C_gs.
fn kind_word(t: Term) -> &'static str {
    match t {
        Term::Ro => "r_o",
        Term::Gmb => "g_mb",
        Term::Rbs => "r_bs",
        Term::Rbd => "r_bd",
        Term::Rmu => "r_μ",
        Term::Rpi => "r_π",
        Term::Cgs => "C_gs",
        Term::Cgd => "C_gd",
        Term::Cgb => "C_gb",
        Term::Cbs => "C_sb",
        Term::Cbd => "C_db",
        Term::Cpi => "C_π",
        Term::Cmu => "C_μ",
        Term::Ccs => "C_cs",
        Term::Cj => "C_j",
        Term::Open => "open",
        Term::Short => "short",
    }
}

/// Plain text of a symbol's LaTeX, the subscript after "_": r_{o1,2} →
/// r_o1,2, C_{\pi 1} → C_π1.
pub fn plain(latex: &str) -> String {
    latex
        .replace("\\pi ", "π")
        .replace("\\mu ", "μ")
        .replace("\\pi", "π")
        .replace("\\mu", "μ")
        .replace("\\_", "_")
        .chars()
        .filter(|c| !matches!(c, '{' | '}' | '\\'))
        .collect()
}

/// "A", "A and B", "A, B and C".
fn join(parts: &[String]) -> String {
    match parts {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The LaTeX of one unit's assumption: r_{o2} \to \infty, g_{mb1} = 0.
pub fn unit_latex(u: &Unit) -> Option<String> {
    let sym = u.symbol.as_ref()?;
    Some(match limit(u.term) {
        "∞" => format!("{sym} \\to \\infty"),
        _ => format!("{sym} = 0"),
    })
}

/// The label of a named form, grouped by kind (r_o, g_mb, junction
/// leakage, capacitances): one unit by its symbol ("r_o2 → ∞"); several by
/// kind with their elements ("r_o → ∞ for M2, M4"), or without them when
/// they are every unit of that kind in the form (`present`).
pub fn label(chosen: &[Unit], present: &[Unit]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for g in 0..4 {
        let of: Vec<&Unit> = chosen.iter().filter(|u| group(u.term) == g).collect();
        let Some(first) = of.first() else { continue };
        let lim = limit(first.term);
        if let [one] = of.as_slice() {
            parts.push(match &one.symbol {
                Some(sym) => format!("{} → {lim}", plain(sym)),
                None => format!("{} → {lim} for {}", kind_word(one.term), one.elements.join(", ")),
            });
            continue;
        }
        let mut kinds: Vec<&str> = Vec::new();
        let mut elements: Vec<&str> = Vec::new();
        for u in &of {
            let k = kind_word(u.term);
            if !kinds.contains(&k) {
                kinds.push(k);
            }
            for e in &u.elements {
                if !elements.contains(&e.as_str()) {
                    elements.push(e);
                }
            }
        }
        // In the order the form's candidates list them (the netlist's).
        let rank = |e: &str| {
            present
                .iter()
                .flat_map(|u| &u.elements)
                .position(|x| x == e)
                .unwrap_or(usize::MAX)
        };
        elements.sort_by_key(|e| rank(e));
        let head = if g == 3 && kinds.len() > 2 {
            "caps".to_string()
        } else {
            kinds.join(", ")
        };
        let all = present.iter().filter(|u| group(u.term) == g).count() == of.len();
        parts.push(if all {
            format!("{head} → {lim}")
        } else {
            format!("{head} → {lim} for {}", elements.join(", "))
        });
    }
    join(&parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(elements: &[&str], term: Term, symbol: Option<&str>) -> Unit {
        Unit {
            elements: elements.iter().map(|e| e.to_string()).collect(),
            term,
            symbol: symbol.map(str::to_string),
        }
    }

    #[test]
    fn labels_group_by_kind() {
        let ro2 = unit(&["M2"], Term::Ro, Some("r_{o2}"));
        let ro4 = unit(&["M4"], Term::Ro, Some("r_{o4}"));
        let ro5 = unit(&["M5"], Term::Ro, Some("r_{o5}"));
        let gmb = unit(&["M1", "M2"], Term::Gmb, Some("g_{mb1,2}"));
        let gmb3 = unit(&["M3"], Term::Gmb, Some("g_{mb3}"));
        assert_eq!(
            label(std::slice::from_ref(&ro2), &[ro2.clone(), ro4.clone()]),
            "r_o2 → ∞"
        );
        let present = [ro2.clone(), ro4.clone(), ro5.clone(), gmb.clone(), gmb3.clone()];
        assert_eq!(
            label(&[ro2.clone(), ro4.clone(), gmb.clone(), gmb3.clone()], &present),
            "r_o → ∞ for M2, M4 and g_mb → 0"
        );
        assert_eq!(label(std::slice::from_ref(&gmb), &present), "g_mb1,2 → 0");
        let cpi = unit(&["Q1"], Term::Cpi, Some("C_{\\pi 1}"));
        assert_eq!(label(&[ro5, cpi], &present), "r_o5 → ∞ and C_π1 → 0");
        // Elements of several kinds in the form's (netlist) order.
        let cgs3 = unit(&["M3"], Term::Cgs, Some("C_{gs3}"));
        let cgd1 = unit(&["M1", "M2"], Term::Cgd, Some("C_{gd1,2}"));
        let cgd5 = unit(&["M5"], Term::Cgd, Some("C_{gd5}"));
        let present = [cgd1.clone(), cgs3.clone(), cgd5.clone(), ro2.clone()];
        assert_eq!(
            label(&[cgs3, cgd1, ro2.clone()], &present),
            "r_o2 → ∞ and C_gs, C_gd → 0 for M1, M2, M3"
        );
        assert_eq!(plain("r_{o,in}"), "r_o,in");
        assert_eq!(unit_latex(&gmb).unwrap(), "g_{mb1,2} = 0");
        assert_eq!(unit_latex(&ro2).unwrap(), "r_{o2} \\to \\infty");
    }
}
