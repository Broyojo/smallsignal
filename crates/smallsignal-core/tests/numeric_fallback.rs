//! A quantity over the term budget is numeric: values from the full model's
//! LU solve, poles and zeros as eigenvalues of the MNA pencil. On every oracle
//! circuit, forcing that path (maxTerms 1) must reproduce the exact path's
//! values, poles and zeros (to 1e-8: the exact path may leave out junctions
//! proven to move nothing by more than 1e-9).

mod common;

use common::numeric_matches_exact;
use serde_json::{json, Value};
use smallsignal_core::{analyze, Request};
use std::path::Path;

const NGSPICE_OPTIONS: &str = ".options reltol=1e-9 abstol=1e-15 vntol=1e-12 gmin=1e-15\n";

fn request(side: &Value, max_terms: Option<usize>) -> Request {
    let mut r = json!({
        "input": side["input"],
        "output": side["output"],
        "freqs": side.get("freqs").cloned().unwrap_or(json!([1e3])),
        "rin": side.get("rin").cloned().unwrap_or(json!(false)),
        "rout": side.get("rout").cloned().unwrap_or(json!(false)),
    });
    for key in ["ref", "inputNeg", "mode", "match"] {
        if let Some(v) = side.get(key).filter(|v| !v.is_null()) {
            r[key] = v.clone();
        }
    }
    if let Some(m) = max_terms {
        r["maxTerms"] = json!(m);
    }
    serde_json::from_value(r).unwrap()
}

#[test]
fn the_numeric_path_reproduces_the_exact_path_on_every_oracle_circuit() {
    let oracle = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../oracle");
    let mut names: Vec<_> = ["corpus", "regressions"]
        .iter()
        .flat_map(|d| std::fs::read_dir(oracle.join(d)).unwrap())
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "cir"))
        .collect();
    names.sort();
    let mut checked = 0;
    let mut failures = Vec::new();
    for cir in names {
        let side: Value = serde_json::from_str(&std::fs::read_to_string(cir.with_extension("json")).unwrap()).unwrap();
        let text = std::fs::read_to_string(&cir).unwrap();
        let (title, body) = text.split_once('\n').unwrap();
        let net = format!("{title}\n{NGSPICE_OPTIONS}{body}");
        let name = cir.file_stem().unwrap().to_string_lossy().to_string();
        let Ok(exact) = analyze(&net, &request(&side, None)) else {
            continue;
        };
        let numeric = match analyze(&net, &request(&side, Some(1))) {
            Ok(v) => v,
            Err(e) => {
                failures.push(format!("{name}: {e}"));
                continue;
            }
        };
        let (n, f) = numeric_matches_exact(&name, &exact, &numeric, 1e-8);
        checked += n;
        failures.extend(f);
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(checked > 50, "only {checked} quantities took the numeric path");
}
