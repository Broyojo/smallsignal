//! Named-assumption simplified forms (`approx: "named"`, the default in
//! numeric mode): the exact form under assumptions the numbers choose,
//! labelled with them, never a nameless dropped term; `approx: "terms"`
//! keeps the smallest-terms form; and a MOSFET in triode's channel
//! resistance R_on.

mod common;

use common::{close, run, run_err};
use serde_json::{json, Value};
use smallsignal_core::Request;

fn req(v: Value) -> Request {
    serde_json::from_value(v).unwrap()
}

fn corpus(name: &str) -> String {
    std::fs::read_to_string(format!("{}/../../oracle/corpus/{name}.cir", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn param(r: &Value, name: &str) -> f64 {
    r["params"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == name)
        .unwrap_or_else(|| panic!("no {name} in {}", r["params"]))["value"]
        .as_f64()
        .unwrap()
}

fn units(s: &Value) -> Vec<(Vec<String>, String)> {
    s["named"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| {
            let els = u["elements"].as_array().unwrap();
            (
                els.iter().map(|e| e.as_str().unwrap().to_string()).collect(),
                u["term"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

/// The engineer's case: a CMOS inverter with M1 in triode. The gain is
/// −(g_m1 + g_m2)(R_on1 ∥ r_o2) and r_o2 ≫ R_on1, so the named form is
/// −(g_m1 + g_m2) R_on1 assuming r_o2 → ∞, and Zout ≈ R_on1: its error is
/// R_on1/r_o2 (0.35%), which the form reports. Before, "smallest
/// terms" showed the same shape with r_o1 for the channel and no reason.
#[test]
fn inverter_in_triode_assumes_r_o2_and_names_r_on() {
    let r = run(
        &corpus("inverter_triode"),
        &req(json!({ "input": "VIN", "output": "out", "rout": true })),
    );
    assert_eq!(r["op"]["devices"]["M1"]["region"], "triode");
    assert_eq!(r["op"]["devices"]["M2"]["region"], "saturation");
    let (ron, ro2) = (param(&r, "ron_M1"), param(&r, "ro_M2"));
    // R_on is the level-1 linearization's 1/g_ds, as ngspice's.
    let gds = r["op"]["devices"]["M1"]["gds"].as_f64().unwrap();
    assert!(close((ron, 0.0), (1.0 / gds, 0.0), 1e-12));
    let latex = |p: &str| r["params"].as_array().unwrap().iter().find(|x| x["name"] == p).unwrap()["latex"].clone();
    assert_eq!(latex("ron_M1"), "R_{on1}");
    assert!(r["params"].as_array().unwrap().iter().all(|p| p["name"] != "ro_M1"));

    // |R_on − R_on ∥ r_o2| / (R_on ∥ r_o2).
    let want_err = ron / ro2;
    for (q, form) in [("gain", "-R_{on1} \\left(g_{m2} + g_{m1}\\right)"), ("rout", "R_{on1}")] {
        let s = &r[q]["simplified"];
        assert_eq!(s["latex"], form, "{q}");
        assert_eq!(s["same"], false);
        assert_eq!(s["method"], "named");
        assert_eq!(s["assumption"], "r_o2 → ∞", "{q}");
        assert_eq!(
            s["named"],
            json!([{ "elements": ["M2"], "term": "ro", "latex": "r_{o2} \\to \\infty" }])
        );
        let err = s["maxRelError"].as_f64().unwrap();
        assert!(close((err, 0.0), (want_err, 0.0), 1e-6), "{q}: {err} vs {want_err}");
        assert!(err < 0.005);
    }
    // In triode r_o makes no sense to neglect: M1 offers no "ro".
    let assumable = r["assumable"].as_array().unwrap();
    let terms = |e: &str| assumable.iter().find(|a| a["element"] == e).unwrap()["terms"].clone();
    assert!(!terms("M1").as_array().unwrap().contains(&json!("ro")));
    assert!(terms("M2").as_array().unwrap().contains(&json!("ro")));
}

/// R_on is never a candidate: the suggestions (and so the named search)
/// offer M2's r_o, never M1's channel; a request to neglect M1's r_o finds
/// none (`absent`) and leaves the forms as they are.
#[test]
fn r_on_is_no_candidate() {
    let net = corpus("inverter_triode");
    let r = run(
        &net,
        &req(json!({ "input": "VIN", "output": "out", "rout": true,
                     "suggest": { "quantity": "rout", "threshold": 1.0 } })),
    );
    let items = r["suggestions"]["items"].as_array().unwrap();
    assert!(items
        .iter()
        .all(|i| i["elements"] != json!(["M1"]) || i["term"] != "ro"));
    assert!(items
        .iter()
        .any(|i| i["elements"] == json!(["M2"]) && i["term"] == "ro"));
    let r = run(
        &net,
        &req(json!({ "input": "VIN", "output": "out", "rout": true,
                     "assume": { "ignore": [{ "element": "M1", "term": "ro" }] } })),
    );
    assert_eq!(r["assumptions"]["absent"], json!([{ "element": "M1", "term": "ro" }]));
    assert_eq!(r["assumptions"]["applied"], json!([]));
    assert_eq!(r["rout"]["simplified"]["latex"], "R_{on1}");
}

/// The 5T OTA: the r_o of both pairs set half of Zout each, so the named
/// form keeps them and assumes only the tail's r_o5 → ∞ (r_o → ∞ for all
/// would leave the output floating: those are put back, never chosen).
/// Unmatched, M1's and M3's r_o go too, never M2's or M4's.
#[test]
fn ota_5t_keeps_the_r_o_that_set_zout() {
    let net = corpus("ota_5t");
    let base = json!({ "input": "VIN", "output": "out", "rout": true, "matchAuto": true });
    let r = run(&net, &req(base.clone()));
    for q in ["gain", "rout"] {
        let s = &r[q]["simplified"];
        assert_eq!(s["assumption"], "r_o5 → ∞", "{q}");
        assert_eq!(units(s), vec![(vec!["M5".to_string()], "ro".to_string())]);
        let latex = s["latex"].as_str().unwrap();
        assert!(latex.contains("r_{o1,2}") && latex.contains("r_{o3,4}"), "{latex}");
        assert!(!latex.contains("r_{o5}"), "{latex}");
        assert!(s["maxRelError"].as_f64().unwrap() <= 0.05);
        let terms = |f: &Value| f["terms"]["num"].as_u64().unwrap() + f["terms"]["den"].as_u64().unwrap();
        assert!(terms(s) < terms(&r[q]["display"]));
    }
    // ro2 and ro4 each set half of Zout: alone, either is far beyond 5%.
    let mut solo = base.clone();
    solo["matchAuto"] = json!(false);
    solo["assume"] = json!({ "ignore": [{ "element": "M4", "term": "ro" }] });
    let r = run(&net, &req(solo));
    assert!(r["rout"]["exact"]["fullModelError"].as_f64().unwrap() > 0.4);

    let mut unmatched = base;
    unmatched["matchAuto"] = json!(false);
    let r = run(&net, &req(unmatched));
    let s = &r["gain"]["simplified"];
    let chosen: Vec<String> = units(s).into_iter().map(|(e, _)| e.join(",")).collect();
    assert_eq!(chosen, vec!["M1", "M3", "M5"]);
    assert_eq!(s["assumption"], "r_o → ∞ for M1, M3, M5");
    assert!(s["maxRelError"].as_f64().unwrap() <= 0.05);
}

/// On top of the engineer's own assumptions, never undoing one: with r_o5
/// neglected by hand, the named form adds r_o1 and r_o3, its error is the
/// full model's, and the label lists only what it adds.
#[test]
fn named_forms_build_on_the_requests_assumptions() {
    let net = corpus("ota_5t");
    let r = run(
        &net,
        &req(json!({ "input": "VIN", "output": "out", "rout": true,
                     "assume": { "ignore": [{ "element": "M5", "term": "ro" }] } })),
    );
    assert_eq!(
        r["assumptions"]["applied"],
        json!([{ "element": "M5", "term": "ro", "latex": "r_{o5} \\to \\infty" }])
    );
    let s = &r["gain"]["simplified"];
    assert_eq!(s["assumption"], "r_o → ∞ for M1, M3");
    let full = s["fullModelError"].as_f64().unwrap();
    assert!(full <= 0.05 && full > r["gain"]["exact"]["fullModelError"].as_f64().unwrap());
    let latex = s["latex"].as_str().unwrap();
    assert!(!latex.contains("r_{o5}") && !latex.contains("r_{o1}") && !latex.contains("r_{o3}"));
    assert!(latex.contains("r_{o2}") && latex.contains("r_{o4}"), "{latex}");
}

/// Nothing within the tolerance: the exact form alone, with `none`. With a
/// 0.1% tolerance no r_o of the triode inverter can go (r_o2 costs 0.35%).
#[test]
fn no_named_form_within_the_tolerance_shows_exact() {
    let r = run(
        &corpus("inverter_triode"),
        &req(json!({ "input": "VIN", "output": "out", "rout": true, "tolerance": 0.001 })),
    );
    for q in ["gain", "rout"] {
        let s = &r[q]["simplified"];
        assert_eq!(s["none"], true, "{q}: {s}");
        assert_eq!(s["named"], json!([]));
        assert_eq!(s["latex"], r[q]["display"]["latex"]);
        assert!(s.get("assumption").is_none());
    }
}

/// "Smallest terms" is the earlier simplified form, unchanged: the 5T
/// OTA's g_m (r_o1,2 ∥ r_o3,4) at 0.73%.
#[test]
fn smallest_terms_is_the_earlier_form() {
    let r = run(
        &corpus("ota_5t"),
        &req(json!({ "input": "VIN", "output": "out", "rout": true, "matchAuto": true, "approx": "terms" })),
    );
    let s = &r["gain"]["simplified"];
    assert_eq!(s["method"], "terms");
    assert_eq!(
        s["latex"],
        "\\frac{g_{m1,2} \\left(r_{o1,2} \\parallel r_{o3,4}\\right)}{1 + C_{L} \\left(r_{o1,2} \\parallel r_{o3,4}\\right) s}"
    );
    assert!(close(
        (s["maxRelError"].as_f64().unwrap(), 0.0),
        (0.007294314147812313, 0.0),
        1e-9
    ));
    assert!(s.get("named").is_none() && s.get("assumption").is_none());
    let e = run_err(
        "rc\nVIN in 0 AC 1\nR1 in out 1k\nC1 out 0 1n\n",
        &req(json!({ "input": "VIN", "output": "out", "approx": "smallest" })),
    );
    assert_eq!(e, "approx: no method 'smallest' (use named or terms)");
}

/// Symbolic mode keeps its hand-analysis limit whatever `approx` says.
#[test]
fn symbolic_mode_keeps_the_hand_limit() {
    let net = "cs\nVIN in 0\nVDD vdd 0\nRD vdd out\nM1 out in 0 0\n";
    for approx in ["named", "terms"] {
        let r = run(net, &req(json!({ "input": "VIN", "output": "out", "approx": approx })));
        let s = &r["gain"]["simplified"];
        assert_eq!(s["latex"], "-g_{m1} R_{D}");
        assert_eq!(s["assumption"], "ro ≫ R, 1/gm");
        assert!(s.get("method").is_none());
    }
}
