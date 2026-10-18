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

fn terms(f: &Value) -> u64 {
    f["terms"]["num"].as_u64().unwrap() + f["terms"]["den"].as_u64().unwrap()
}

/// The 5T OTA: the r_o of both pairs set half of Zout each. r_o5 → ∞
/// alone (0.007%) leaves 9 terms; the hand limit r_o ≫ R, 1/g_m leaves the
/// textbook g_m(r_o1,2 ∥ r_o3,4)/(1 + C_L(…)s) at 0.73%, fewer terms, so it
/// is the one shown. r_o → ∞ for all would leave the output floating:
/// those are put back, never chosen. Unmatched, the limit keeps r_o2 and
/// r_o4, the output's, and nothing of M1, M3 or M5.
#[test]
fn ota_5t_keeps_the_r_o_that_set_zout() {
    let net = corpus("ota_5t");
    let base = json!({ "input": "VIN", "output": "out", "rout": true, "matchAuto": true });
    let r = run(&net, &req(base.clone()));
    let mut by_terms = base.clone();
    by_terms["approx"] = json!("terms");
    let t = run(&net, &req(by_terms));
    for q in ["gain", "rout"] {
        let s = &r[q]["simplified"];
        assert_eq!(s["assumption"], "r_o ≫ R, 1/g_m", "{q}");
        assert_eq!(
            s["leadingOrder"],
            json!({ "elements": ["M1", "M2", "M3", "M4", "M5"], "all": true })
        );
        assert_eq!(s["named"], json!([]));
        let latex = s["latex"].as_str().unwrap();
        assert!(latex.contains("r_{o1,2} \\parallel r_{o3,4}"), "{latex}");
        assert!(!latex.contains("r_{o5}"), "{latex}");
        // The same form smallest terms finds, now with its name.
        assert_eq!(s["latex"], t[q]["simplified"]["latex"]);
        assert_eq!(s["maxRelError"], t[q]["simplified"]["maxRelError"]);
        assert!(s["maxRelError"].as_f64().unwrap() <= 0.05);
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
    assert_eq!(s["assumption"], "r_o ≫ R, 1/g_m");
    let latex = s["latex"].as_str().unwrap();
    assert!(latex.contains("r_{o2}") && latex.contains("r_{o4}"), "{latex}");
    for gone in ["r_{o1}", "r_{o3}", "r_{o5}"] {
        assert!(!latex.contains(gone), "{latex}");
    }
    assert!(s["maxRelError"].as_f64().unwrap() <= 0.05);
}

/// A cascode into an ideal current source (oracle/corpus/cascode_isrc,
/// checked against ngspice): Zout = r_o1 + r_o2 + (g_m2 + g_mb2) r_o1 r_o2.
/// No r_o can go (the output would float), so substitutions alone leave
/// the exact form; the hand limit gives the textbook (g_m2 + g_mb2) r_o1
/// r_o2, and −g_m1 times it for the gain −g_m1 r_o1 (1 + (g_m2 + g_mb2)
/// r_o2), each at its true error.
#[test]
fn cascode_reads_g_m_r_o_r_o() {
    let r = run(
        &corpus("cascode_isrc"),
        &req(json!({ "input": "VIN", "output": "out", "rout": true })),
    );
    let (gm2, gmb2) = (param(&r, "gm_M2"), param(&r, "gmb_M2"));
    let (ro1, ro2) = (param(&r, "ro_M1"), param(&r, "ro_M2"));
    let rout = (gm2 + gmb2) * ro1 * ro2;
    let gain = -param(&r, "gm_M1") * rout;
    for (q, form, approx) in [
        ("gain", "-g_{m1} r_{o2} r_{o1} \\left(g_{m2} + g_{mb2}\\right)", gain),
        ("rout", "r_{o2} r_{o1} \\left(g_{m2} + g_{mb2}\\right)", rout),
    ] {
        let s = &r[q]["simplified"];
        assert_eq!(s["latex"], form, "{q}");
        assert_eq!(s["assumption"], "r_o ≫ R, 1/g_m");
        // No capacitance: one value at every frequency, the full model's.
        let full = r[q]["values"][0]["re"].as_f64().unwrap();
        let want = (approx - full).abs() / full.abs();
        let err = s["maxRelError"].as_f64().unwrap();
        assert!(close((err, 0.0), (want, 0.0), 1e-6), "{q}: {err} vs {want}");
        assert!(err < 0.02);
    }
}

/// The two-stage Miller OTA (oracle/corpus/ota_miller): the hand limit on
/// every device is 5.7% off, past the tolerance; on the first stage's (M1
/// to M5) it is within it, with no more terms than smallest terms gives
/// (16 and 11), the second stage's r_o6 ∥ r_o7 kept.
#[test]
fn ota_miller_takes_the_limit_on_the_first_stage() {
    let net = corpus("ota_miller");
    let base = json!({ "input": "VIN", "output": "out", "rout": true, "matchAuto": true });
    let r = run(&net, &req(base.clone()));
    let mut by_terms = base;
    by_terms["approx"] = json!("terms");
    let t = run(&net, &req(by_terms));
    for q in ["gain", "rout"] {
        let s = &r[q]["simplified"];
        assert_eq!(s["assumption"], "r_o ≫ R, 1/g_m for M1, M2, M3, M4, M5", "{q}");
        assert_eq!(s["leadingOrder"]["all"], false);
        assert!(s["maxRelError"].as_f64().unwrap() <= 0.05);
        assert!(terms(s) <= terms(&t[q]["simplified"]), "{q}: {} terms", terms(s));
        let latex = s["latex"].as_str().unwrap();
        assert!(latex.contains("r_{o6}") && latex.contains("r_{o7}"), "{latex}");
    }
}

/// On top of the engineer's own assumptions, never undoing one: with r_o5
/// neglected by hand, the named form takes the hand limit, keeping the
/// output's r_o2 and r_o4; its full-model error includes r_o5's, and the
/// label lists only what it adds.
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
    assert_eq!(s["assumption"], "r_o ≫ R, 1/g_m");
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
