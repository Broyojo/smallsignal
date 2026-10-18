//! Suggestions (`suggest`): further assumptions within a threshold of the
//! full model, in matched-group units, accumulated greedily, never one that
//! makes the quantity unbounded, and the same deviation a direct solve of
//! the applied set reports.

mod common;

use common::run;
use serde_json::{json, Value};
use smallsignal_core::{analyze, Request};

const OTA: &str = include_str!("../../../oracle/corpus/ota_5t.cir");
const UA741: &str = include_str!("../../../oracle/corpus/ua741.cir");

const CS_ISRC: &str = "cs ideal load\nVDD vdd 0 1.8\nVIN in 0 DC 0.8 AC 1\nIB vdd out 200u\n\
M1 out in 0 0 nch W=10u L=1u\nRS in 0 1meg\nCL out 0 1p\n\
.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1)\n";

fn request(v: Value) -> Request {
    serde_json::from_value(v).unwrap()
}

fn ota(extra: Value) -> Value {
    let mut v = json!({
        "input": "VIN", "output": "out", "freqs": [1e3, 1e6], "rin": true, "rout": true,
        "match": [["M1", "M2"], ["M3", "M4"]],
    });
    v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    v
}

fn items(v: &Value) -> &Vec<Value> {
    v["suggestions"]["items"].as_array().unwrap()
}

/// The (element, term) pairs of the greedy set.
fn kept(v: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for it in items(v).iter().filter(|it| !it["cumulative"].is_null()) {
        for e in it["elements"].as_array().unwrap() {
            let pair = json!({ "element": e, "term": it["term"] });
            if !out.contains(&pair) {
                out.push(pair);
            }
        }
    }
    out
}

/// Two deviations (each relative to the full value) that agree to what the
/// analysis's proven junction omissions (1e-9 of a value) and rounding allow.
fn agree(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-8
}

/// Every reported deviation within the threshold, sorted, and the greedy
/// set's deviation equal to a direct solve of it.
fn check(net: &str, req: Value, quantity: &str) -> Value {
    let v = run(net, &request(req.clone()));
    let s = &v["suggestions"];
    let threshold = s["threshold"].as_f64().unwrap();
    let alone: Vec<f64> = items(&v).iter().map(|it| it["alone"].as_f64().unwrap()).collect();
    assert!(alone.windows(2).all(|w| w[0] <= w[1]), "{alone:?}");
    assert!(alone.iter().all(|&a| a <= threshold));
    let mut last = 0.0f64;
    for it in items(&v) {
        if let Some(c) = it["cumulative"].as_f64() {
            assert!(c <= threshold, "{it}");
            last = c;
        }
    }
    let combined = s["combined"].as_f64().unwrap();
    if !kept(&v).is_empty() {
        assert_eq!(combined, last);
    }
    // Applying the set: the analysis's own deviation, to rounding.
    let mut applied = req.clone();
    let current = req["assume"]["ignore"].as_array().cloned().unwrap_or_default();
    // Regions and Miller splits stay as they were.
    if !applied["assume"].is_object() {
        applied["assume"] = json!({});
    }
    applied["assume"]["ignore"] = json!(current.into_iter().chain(kept(&v)).collect::<Vec<_>>());
    applied.as_object_mut().unwrap().remove("suggest");
    let w = run(net, &request(applied));
    let direct = w[quantity]["assumed"]["maxRelError"].as_f64().unwrap();
    assert!(agree(combined, direct), "suggested {combined}, solved {direct}");
    // Nothing more is put back than the current assumptions need.
    let before = v[quantity]["assumed"]["restored"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(w[quantity]["assumed"]["restored"].as_array().unwrap(), &before);
    v
}

#[test]
fn the_greedy_set_stays_within_the_threshold() {
    // Zin looks into a gate: unbounded in every model, nothing to compare.
    let v = run(OTA, &request(ota(json!({ "suggest": { "quantity": "rin" } }))));
    assert_eq!(v["suggestions"]["base"], Value::Null);
    assert_eq!(v["suggestions"]["items"], json!([]));
    for quantity in ["gain", "rout"] {
        for threshold in [1e-3, 1e-2, 0.1] {
            let req = ota(json!({ "suggest": { "quantity": quantity, "threshold": threshold } }));
            let v = check(OTA, req, quantity);
            assert_eq!(v["suggestions"]["quantity"], quantity);
            assert_eq!(v["suggestions"]["threshold"], threshold);
            assert_eq!(v["suggestions"]["base"], 0.0);
        }
    }
}

#[test]
fn candidates_are_matched_group_units() {
    let v = check(OTA, ota(json!({ "suggest": { "quantity": "gain" } })), "gain");
    assert_eq!(v["suggestions"]["threshold"], 0.01);
    for it in items(&v) {
        let els: Vec<&str> = it["elements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e.as_str().unwrap())
            .collect();
        // A matched member never alone: always its whole group.
        for (a, b) in [("M1", "M2"), ("M3", "M4")] {
            assert_eq!(els.contains(&a), els.contains(&b), "{it}");
        }
        let scope = it["scope"].as_str().unwrap();
        match scope {
            "group" => assert_eq!(els.len(), 2),
            "part" => assert_eq!(els.len(), 1),
            "type" => assert!(els.len() >= 2),
            _ => panic!("{it}"),
        }
    }
    // r_o of the mirror: within 1% of the gain.
    assert!(items(&v)
        .iter()
        .any(|it| it["term"] == "ro" && it["elements"] == json!(["M5"])));
}

#[test]
fn a_match_the_solver_rejects_gives_no_group_candidate() {
    // M1 and M5 are both NMOS but biased apart: "differ, not matched".
    let req = json!({
        "input": "VIN", "output": "out", "freqs": [1e3, 1e6], "rout": true,
        "match": [["M1", "M5"]],
        "suggest": { "quantity": "gain" },
    });
    let v = check(OTA, req, "gain");
    let w: Vec<&str> = v["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_str().unwrap())
        .collect();
    assert!(w.iter().any(|w| w.contains("differ, not matched")), "{w:?}");
    assert!(
        !items(&v).iter().any(|it| it["scope"] == "group"),
        "{}",
        v["suggestions"]
    );
    // M5's r_o on its own, within 1% as without the match.
    assert!(items(&v)
        .iter()
        .any(|it| it["term"] == "ro" && it["elements"] == json!(["M5"])));
}

#[test]
fn an_absent_open_rules_out_its_short() {
    // C0 is 0 F: open is absent from the model, short is assumable.
    let net = "cs\nVDD vdd 0 1.8\nVIN in 0 DC 0.8 AC 1\nRD vdd out 10k\nM1 out in 0 0 nch W=10u L=1u\n\
C0 out 0 0\n.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1)\n";
    let base = json!({ "input": "VIN", "output": "out", "freqs": [1e3], "suggest": { "quantity": "gain" } });
    let plain = run(net, &request(base.clone()));
    let mut req = base;
    req["assume"] = json!({ "ignore": [{ "element": "C0", "term": "open" }] });
    let v = run(net, &request(req));
    assert_eq!(v["assumptions"]["absent"], json!([{ "element": "C0", "term": "open" }]));
    let (s, p) = (&v["suggestions"], &plain["suggestions"]);
    assert_eq!(s["unbounded"], 0, "{s}");
    assert_eq!(s["candidates"].as_u64().unwrap() + 1, p["candidates"].as_u64().unwrap());
}

#[test]
fn the_current_assumptions_are_the_base() {
    let assume = json!({ "ignore": [
        { "element": "M5", "term": "ro" },
    ] });
    let v = check(
        OTA,
        ota(json!({ "assume": assume, "suggest": { "quantity": "gain", "threshold": 0.02 } })),
        "gain",
    );
    let base = v["suggestions"]["base"].as_f64().unwrap();
    let own = v["gain"]["assumed"]["maxRelError"].as_f64().unwrap();
    assert!(agree(base, own), "{base} {own}");
    assert!(base > 0.0);
    // Nothing already in effect is suggested again.
    assert!(!items(&v)
        .iter()
        .any(|it| it["term"] == "ro" && it["elements"].as_array().unwrap().contains(&json!("M5"))));
}

#[test]
fn a_candidate_that_makes_the_quantity_unbounded_is_left_out() {
    let req = json!({
        "input": "VIN", "output": "out", "freqs": [1e3], "rout": true,
        "suggest": { "quantity": "gain", "threshold": 0.5 },
    });
    let v = check(CS_ISRC, req, "gain");
    assert!(v["suggestions"]["unbounded"].as_u64().unwrap() >= 1);
    // The ideal current-source load: only r_o holds the output.
    assert!(!items(&v).iter().any(|it| it["term"] == "ro"), "{}", v["suggestions"]);
    // RS across an ideal source moves nothing: open is free.
    assert!(items(&v)
        .iter()
        .any(|it| it["term"] == "open" && it["elements"] == json!(["RS"])));

    // Current assumptions that already need r_o back: suggestions keep
    // exactly that restore.
    let req = json!({
        "input": "VIN", "output": "out", "freqs": [1e3], "rout": true,
        "assume": { "ignore": [{ "element": "M1", "term": "ro" }] },
        "suggest": { "quantity": "gain", "threshold": 0.5 },
    });
    let v = check(CS_ISRC, req, "gain");
    assert_eq!(v["gain"]["assumed"]["restored"].as_array().unwrap().len(), 1);
    assert!(items(&v)
        .iter()
        .any(|it| it["term"] == "open" && it["elements"] == json!(["RS"])));
}

#[test]
fn caps_stop_the_evaluation_and_say_so() {
    let v = run(
        OTA,
        &request(ota(json!({ "suggest": { "quantity": "gain", "maxCandidates": 2 } }))),
    );
    let s = &v["suggestions"];
    assert_eq!(s["capped"], "candidates");
    assert_eq!(s["evaluated"], 2);
    assert!(s["candidates"].as_u64().unwrap() > 2);
    let v = run(
        OTA,
        &request(ota(json!({ "suggest": { "quantity": "gain", "timeLimit": 0 } }))),
    );
    let s = &v["suggestions"];
    assert_eq!(s["capped"], "time");
    assert_eq!(s["evaluated"], 0);
    assert_eq!(s["items"], json!([]));
    let v = run(OTA, &request(ota(json!({ "suggest": { "quantity": "gain" } }))));
    assert_eq!(v["suggestions"]["capped"], Value::Null);
}

#[test]
fn requests_are_validated() {
    let err = |extra: Value| analyze(OTA, &request(ota(extra))).unwrap_err();
    assert_eq!(
        err(json!({ "suggest": { "quantity": "gain" }, "symbolic": true })),
        "suggest: needs a bias point"
    );
    assert_eq!(
        err(json!({ "suggest": { "quantity": "zin" } })),
        "suggest: no quantity 'zin' (use gain, rin or rout)"
    );
    assert_eq!(
        err(json!({ "suggest": { "quantity": "rout" }, "rout": false })),
        "suggest: rout needs rout in the request"
    );
    assert_eq!(
        err(json!({ "suggest": { "quantity": "gain", "threshold": 0 } })),
        "suggest: threshold must be above 0"
    );
}

/// Over the term budget: numeric throughout, and still the deviation a
/// direct solve of the applied set gives.
#[test]
fn the_ua741_gets_suggestions_over_budget() {
    let req = json!({
        "input": "VINP", "output": "OUT", "freqs": [1, 1e3, 1e5, 1e6], "rin": true, "rout": true,
        "matchAuto": true, "maxTerms": 1,
        "suggest": { "quantity": "gain", "threshold": 0.01 },
    });
    let v = check(UA741, req, "gain");
    let s = &v["suggestions"];
    assert_eq!(s["capped"], Value::Null);
    assert!(kept(&v).len() > 20, "{s}");
    assert!(items(&v).iter().any(|it| it["scope"] == "type"));
}

const CAPS_CS: &str = include_str!("../../../oracle/corpus/caps_cs.cir");
const CS_CGD: &str = include_str!("../../../oracle/corpus/assume_cs_cgd_miller.cir");
const OTA_CC: &str = include_str!("../../../oracle/corpus/assume_ota_miller_cc.cir");

#[test]
fn device_capacitances_are_candidates() {
    let req = json!({
        "input": "VIN", "output": "out", "freqs": [1e3, 1e6], "rout": true,
        "suggest": { "quantity": "gain" },
    });
    let v = check(CAPS_CS, req, "gain");
    // M1's gate-bulk overlap: a fraction of a percent of the gain.
    assert!(
        items(&v)
            .iter()
            .any(|it| it["term"] == "cgb" && it["elements"] == json!(["M1"])),
        "{}",
        v["suggestions"]
    );
}

#[test]
fn a_miller_split_in_effect_is_kept_and_never_a_candidate() {
    // C_gd of M1 split, then CC: the base is the split model's own
    // deviation, and what a split keeps (the capacitance; a capacitor's open
    // and short) is no candidate, so none is evaluated only to be refused.
    for (net, split, gone, rin) in [
        (CS_CGD, json!({ "element": "M1", "term": "cgd" }), 1, true),
        (OTA_CC, json!({ "element": "CC" }), 2, false),
    ] {
        let mut req = json!({
            "input": "VIN", "output": "out", "freqs": [1e3, 1e6], "rin": rin, "rout": true,
            "suggest": { "quantity": "gain", "threshold": 1.0 },
        });
        let plain = run(net, &request(req.clone()));
        req["assume"] = json!({ "miller": [split] });
        let v = check(net, req, "gain");
        let (s, p) = (&v["suggestions"], &plain["suggestions"]);
        let base = s["base"].as_f64().unwrap();
        let own = v["gain"]["assumed"]["maxRelError"].as_f64().unwrap();
        assert!(base > 0.0 && agree(base, own), "{base} {own}");
        let target = split["element"].clone();
        let term = split.get("term").cloned();
        assert!(
            !items(&v)
                .iter()
                .any(|it| it["elements"] == json!([target]) && term.as_ref().is_none_or(|t| it["term"] == *t)),
            "{s}"
        );
        assert_eq!(
            s["candidates"].as_u64().unwrap() + gone,
            p["candidates"].as_u64().unwrap(),
            "{s}"
        );
        assert_eq!(s["unbounded"], p["unbounded"], "{s}");
    }
}
