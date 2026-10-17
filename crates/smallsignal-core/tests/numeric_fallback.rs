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

/// Roots the pencil cannot find (two time constants 16 decades apart, past
/// what one shift resolves) are null with a warning, never an empty list
/// that reads as a circuit without poles. Their number stays exact, and
/// stability is not judged from them. Before: `poles: []` and no warning.
#[test]
fn roots_the_pencil_cannot_find_are_unavailable() {
    let net = "wide\nVIN in 0 AC 1\nR1 in a 1\nC1 a 0 1\nR2 a out 1\nC2 out 0 1e-16\n";
    let req = |max_terms: Option<usize>| {
        let mut r = json!({ "input": "VIN", "output": "out", "rin": true, "rout": true });
        if let Some(m) = max_terms {
            r["maxTerms"] = json!(m);
        }
        serde_json::from_value::<Request>(r).unwrap()
    };
    let exact = analyze(net, &req(None)).unwrap();
    assert_eq!(exact["warnings"], json!([]));
    let r = analyze(net, &req(Some(1))).unwrap();
    for q in ["gain", "rin", "rout"] {
        assert_eq!(r[q]["skipped"], "too large for the exact closed form");
        assert_eq!(r[q]["poles"], Value::Null, "{q}");
        assert_eq!(r[q]["poleCount"], exact[q]["poleCount"], "{q}");
        assert_eq!(r[q]["zeroCount"], exact[q]["zeroCount"], "{q}");
    }
    assert_eq!(r["gain"]["poleCount"], 2);
    // No zeros to find, and one the pencil does find.
    assert_eq!(r["gain"]["zeros"], json!([]));
    assert_eq!(r["rin"]["zeros"], Value::Null);
    let z = r["rout"]["zeros"][0]["re"].as_f64().unwrap();
    assert!(
        (z / exact["rout"]["zeros"][0]["re"].as_f64().unwrap() - 1.0).abs() < 1e-9,
        "{z}"
    );
    assert_eq!(
        r["warnings"],
        json!([
            "Gain poles not found.",
            "Stability not checked. Its poles were not found.",
            "Zin poles and zeros not found.",
            "Zout poles not found."
        ])
    );
}

/// A matched pair's numerator that cancels (a differential pair seen at its
/// tail) vanishes on the numeric path as on the exact one, matched
/// parameters sharing one value in the orders in s: no signal, no zeros to
/// find, values 0. Before: two zeros the pencil could not find, no warning,
/// and LU rounding (1e-18) for values.
#[test]
fn a_matched_cancellation_vanishes_on_the_numeric_path() {
    let net = "tail\nVDD vdd 0 3\nVIP inp 0 DC 1.2\nVINN inn 0 DC 1.2\nM1 o1 inp tail 0 nch W=10u L=1u\n\
               M2 o2 inn tail 0 nch W=10u L=1u\nITAIL tail 0 DC 200u\nRD1 vdd o1 5k\nRD2 vdd o2 5k\n\
               CL1 o1 0 1p\nCL2 o2 0 1p\n.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1)\n";
    let req = |max_terms: usize| {
        serde_json::from_value::<Request>(json!({
            "input": "VIP", "inputNeg": "VINN", "output": "tail", "freqs": [1e6, 1e8],
            "match": [["M1", "M2"], ["RD1", "RD2"], ["CL1", "CL2"]], "maxTerms": max_terms,
        }))
        .unwrap()
    };
    for r in [analyze(net, &req(2_000_000)).unwrap(), analyze(net, &req(1)).unwrap()] {
        assert_eq!(r["warnings"], json!(["No signal reaches tail"]));
        assert_eq!((&r["gain"]["zeros"], &r["gain"]["zeroCount"]), (&json!([]), &json!(0)));
        for v in r["gain"]["values"].as_array().unwrap() {
            assert_eq!(v["mag"], 0.0, "{v}");
        }
    }
}
