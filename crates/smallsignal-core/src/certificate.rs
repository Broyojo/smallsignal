//! Certificate export for the Lean checker (`lean/gen_cert.py`).
//!
//! For the gain system it emits the small-signal circuit as an element list
//! in the vocabulary of `lean/Smallsignal/Mna.lean` (admittances, VCCS,
//! CCCS, branch elements, current injections) over the system's node and
//! branch columns, and every unknown's exact solution `N_j / D`. Lean then
//! stamps the matrix itself and proves that the solution satisfies KCL and
//! every branch equation; the Rust matrix is not part of the trust base.
//!
//! Variables are MNA values: `g_X` is the conductance 1/X of a resistance X,
//! and every reactive admittance or impedance carries an explicit `s`.

use crate::analyze::Request;
use crate::dc::operating_point;
use crate::netlist::{parse, Kind};
use crate::poly::Poly;
use crate::ss::{self, Excite, SsCircuit, Stamp};
use serde_json::{json, Value};

fn ident(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// Lean identifier of parameter `i` (its MNA value).
fn var(ss: &SsCircuit, i: usize) -> String {
    let p = &ss.params[i];
    format!("p_{}{}", if p.inverted { "g_" } else { "" }, ident(&p.name))
}

/// MNA admittance (or impedance, for inductors) of parameter `i`, with `s`.
fn value(ss: &SsCircuit, i: usize) -> String {
    if ss.params[i].reactive {
        format!("s * {}", var(ss, i))
    } else {
        var(ss, i)
    }
}

/// `Σ c · Π vars · s^k`, terms in a deterministic order.
fn poly(ss: &SsCircuit, p: &Poly) -> String {
    let mut terms: Vec<(u128, i128)> = p.terms.iter().map(|(&m, &c)| (m, c)).collect();
    terms.sort();
    if terms.is_empty() {
        return "0".into();
    }
    terms
        .iter()
        .map(|&(m, c)| {
            let mut f = vec![format!("({c})")];
            for i in 0..ss.params.len() {
                if m >> i & 1 == 1 {
                    f.push(var(ss, i));
                }
            }
            for _ in 0..(m & ss.reactive_mask).count_ones() {
                f.push("s".into());
            }
            f.join(" * ")
        })
        .collect::<Vec<_>>()
        .join(" + ")
}

pub fn certificate(text: &str, req: &Request) -> Result<Value, String> {
    let net = parse(text)?;
    let input = net
        .element(&req.input)
        .ok_or_else(|| format!("input source '{}' not found", req.input))?;
    if !matches!(net.elements[input].kind, Kind::V { .. } | Kind::I { .. }) {
        return Err(format!("input '{}' must be an independent V or I source", req.input));
    }
    let symbolic = req.symbolic || !net.missing.is_empty();
    let op = if symbolic { None } else { Some(operating_point(&net)?) };
    // Named as `analyze` names them (a known triode channel is R_on).
    let (linear, _) = crate::analyze::known_regions(&net, req, symbolic);
    let full = ss::build_with(&net, op.as_ref(), &linear)?;
    // Under assumptions, the element list the gain's forms are built on.
    let ssc = match &req.assume {
        Some(r) => {
            let imposed = crate::analyze::region_model(&net, op.as_ref(), &linear, Some(r))?;
            let base = imposed.as_ref().map_or(&full, |(_, m)| m);
            let a = crate::assume::resolve(&net, base, op.as_ref(), r)?;
            crate::analyze::gain_model(&net, base, &a, &Excite::Source(input), &req.matched)
        }
        None => full,
    };
    let sys = ss::system(&net, &ssc, &Excite::Source(input));
    let max_terms = req.max_terms.unwrap_or(2_000_000);
    let d = crate::det::det(&sys.a, max_terms)?;
    let nums: Vec<Poly> = (0..sys.dim)
        .map(|j| sys.cramer(j, max_terms))
        .collect::<Result<_, _>>()?;

    let nn = sys.dim - sys.branch_col.len();
    let mut node_names: Vec<Vec<String>> = vec![Vec::new(); nn];
    for (n, c) in sys.node_col.iter().enumerate() {
        if let Some(c) = c {
            node_names[*c].push(net.nodes[n].clone());
        }
    }
    let nb = sys.branch_col.len();
    let mut branch_names = vec![String::new(); nb];
    for (&e, &c) in &sys.branch_col {
        branch_names[c - nn] = net.elements[e].name.clone();
    }
    let col = |n: usize| sys.node_col[n];
    let bidx = |e: usize| sys.branch_col[&e] - nn;

    let mut elems = Vec::new();
    let mut branches: Vec<Value> = vec![Value::Null; nb];
    let mut inj = Vec::new();
    for st in &ssc.stamps {
        match *st {
            Stamp::Adm { a, b, p } => {
                elems.push(json!({ "kind": "adm", "a": col(a), "b": col(b), "y": value(&ssc, p) }))
            }
            Stamp::Vccs { op, on, cp, cn, p } => elems.push(json!({
                "kind": "vccs", "op": col(op), "on": col(on), "cp": col(cp), "cn": col(cn), "g": value(&ssc, p),
            })),
            Stamp::Cccs { a, b, ctrl, p } => {
                elems.push(json!({ "kind": "cccs", "a": col(a), "b": col(b), "ctrl": bidx(ctrl), "f": value(&ssc, p) }))
            }
            Stamp::VSrc { e, a, b } => {
                // Shorted sources have no branch: their nodes are merged.
                if sys.branch_col.contains_key(&e) {
                    let val = if e == input { 1 } else { 0 };
                    branches[bidx(e)] = json!({ "kind": "vsrc", "a": col(a), "b": col(b), "val": val.to_string() });
                }
            }
            Stamp::ISrc { e, a, b } => {
                // SPICE current flows from n+ through the source to n−.
                if e == input {
                    inj.push(json!({ "into": col(b), "outof": col(a), "i": "1" }));
                }
            }
            Stamp::Vcvs { e, a, b, cp, cn, p } => {
                let g = p.map(|p| value(&ssc, p)).unwrap_or_else(|| "0".into());
                branches[bidx(e)] =
                    json!({ "kind": "vcvs", "a": col(a), "b": col(b), "cp": col(cp), "cn": col(cn), "e": g });
            }
            Stamp::Ccvs { e, a, b, ctrl, p } => {
                let h = p.map(|p| value(&ssc, p)).unwrap_or_else(|| "0".into());
                branches[bidx(e)] = json!({ "kind": "ccvs", "a": col(a), "b": col(b), "ctrl": bidx(ctrl), "h": h });
            }
            Stamp::Ind { e, a, b, p } => {
                branches[bidx(e)] = json!({ "kind": "ind", "a": col(a), "b": col(b), "z": value(&ssc, p) })
            }
            // An assumed short has no element: its nodes share one column.
            Stamp::Short { .. } => {}
        }
    }
    let params: Vec<Value> = (0..ssc.params.len())
        .map(|i| {
            let p = &ssc.params[i];
            json!({ "var": var(&ssc, i), "name": p.name, "conductance": p.inverted, "reactive": p.reactive })
        })
        .collect();
    Ok(json!({
        "nodes": node_names,
        "branches": branch_names,
        "params": params,
        "elems": elems,
        "branch": branches,
        "inj": inj,
        "num": nums.iter().map(|n| poly(&ssc, n)).collect::<Vec<_>>(),
        "den": poly(&ssc, &d),
    }))
}
