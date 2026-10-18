//! The Bode sweep (`sweep`): the same values the response gives at
//! `freqs`, at log-spaced frequencies, for the full model, the assumed
//! model and the simplified form. ngspice's .ac at the swept frequencies:
//! `oracle/compare.py` (sidecar `sweep`).

mod common;

use common::{run, run_err};
use serde_json::{json, Value};
use smallsignal_core::Request;

fn req(v: Value) -> Request {
    serde_json::from_value(v).unwrap()
}

fn corpus(name: &str) -> String {
    std::fs::read_to_string(format!("{}/../../oracle/corpus/{name}.cir", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn freqs(r: &Value) -> Vec<f64> {
    r["sweep"]["f"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_f64().unwrap())
        .collect()
}

fn point(v: &Value) -> Option<(f64, f64)> {
    v.as_array().map(|p| (p[0].as_f64().unwrap(), p[1].as_f64().unwrap()))
}

fn value(v: &Value) -> Option<(f64, f64)> {
    Some((v["re"].as_f64()?, v["im"].as_f64()?))
}

/// A curve at the sweep's frequencies against `values` (and the assumed
/// model's) of a solve asked for exactly those frequencies.
fn same_as_values(net: &str, base: Value) {
    let mut swept = base.clone();
    swept["sweep"] = json!({});
    let r = run(net, &req(swept));
    let f = freqs(&r);
    assert!(f.len() > 20, "{} points", f.len());
    let mut at = base;
    at["freqs"] = json!(f);
    let v = run(net, &req(at));
    for q in ["gain", "rout"] {
        let curves = &r[q]["sweep"];
        let full = curves["full"].as_array().unwrap();
        let values = v[q]["values"].as_array().unwrap();
        assert_eq!(full.len(), values.len(), "{q}");
        for (p, w) in full.iter().zip(values) {
            assert_eq!(point(p), value(w), "{q} at {}", w["f"]);
        }
        if let Some(assumed) = curves["assumed"].as_array() {
            let want = v[q]["assumed"]["values"].as_array().unwrap();
            for (p, w) in assumed.iter().zip(want) {
                assert_eq!(point(p), value(w), "{q} assumed at {}", w["f"]);
            }
        }
    }
}

#[test]
fn full_and_assumed_curves_are_the_values_at_those_frequencies() {
    let base = json!({ "input": "VIN", "output": "out", "rout": true, "freqs": [1e3] });
    same_as_values(&corpus("caps_ota5t"), base.clone());
    let mut miller = base;
    miller["assume"] = json!({ "miller": [{ "element": "CC" }] });
    same_as_values(&corpus("assume_ota_miller_cc"), miller);
}

/// On the check grid's own frequencies (four per decade from 1 Hz) the
/// simplified curve is no further from the reference than its reported
/// `maxRelError`, which is the worst over that grid.
#[test]
fn approx_curve_is_the_simplified_form() {
    let net = corpus("assume_ota_miller_cc");
    let r = run(
        &net,
        &req(json!({
            "input": "VIN", "output": "out", "rout": true, "freqs": [1e3],
            "sweep": { "fLow": 1.0, "fHigh": 1e11, "perDecade": 4 },
        })),
    );
    for q in ["gain", "rout"] {
        let s = &r[q]["simplified"];
        assert_eq!(s["same"], false, "{q}");
        let full: Vec<(f64, f64)> = r[q]["sweep"]["full"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| point(p).unwrap())
            .collect();
        let approx: Vec<(f64, f64)> = r[q]["sweep"]["approx"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| point(p).unwrap())
            .collect();
        let norm = |(a, b): (f64, f64)| a.hypot(b);
        let peak = full.iter().map(|&h| norm(h)).fold(0.0, f64::max);
        let worst = full
            .iter()
            .zip(&approx)
            .map(|(&h, &a)| norm((a.0 - h.0, a.1 - h.1)) / norm(h).max(1e-3 * peak))
            .fold(0.0, f64::max);
        let reported = s["maxRelError"].as_f64().unwrap();
        assert!(
            worst > 0.0 && worst <= reported * (1.0 + 1e-9) + 1e-12,
            "{q}: {worst} > {reported}"
        );
    }
}

#[test]
fn explicit_band_and_no_curve_without_reactance_or_numbers() {
    let net = corpus("caps_ota5t");
    let r = run(
        &net,
        &req(json!({ "input": "VIN", "output": "out", "sweep": { "fLow": 10.0, "fHigh": 1e4, "perDecade": 2 } })),
    );
    assert_eq!(r["sweep"]["f"].as_array().unwrap().len(), 7);
    assert_eq!(r["sweep"]["fLow"], 10.0);
    // A simplified form identical to the exact one has no curve of its own.
    let flat = "R divider\nVIN in 0 DC 0 AC 1\nR1 in out 1k\nR2 out 0 1k\n.end\n";
    let r = run(flat, &req(json!({ "input": "VIN", "output": "out", "sweep": {} })));
    assert_eq!(r["sweep"], Value::Null);
    assert!(r["gain"].get("sweep").is_none());
    let rc = "RC\nVIN in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 1n\n.end\n";
    let r = run(rc, &req(json!({ "input": "VIN", "output": "out", "sweep": {} })));
    // The pole at 159 kHz and the 1 kHz asked for (the default), a decade
    // of margin either side, whole decades.
    assert_eq!(
        (r["sweep"]["fLow"].as_f64(), r["sweep"]["fHigh"].as_f64()),
        (Some(100.0), Some(1e7))
    );
    assert_eq!(r["gain"]["sweep"]["approx"], Value::Null);
    let r = run(
        rc,
        &req(json!({ "input": "VIN", "output": "out", "symbolic": true, "sweep": {} })),
    );
    assert_eq!(r["sweep"], Value::Null);
    for bad in [
        json!({ "fLow": 10.0 }),
        json!({ "fLow": 0.0, "fHigh": 1.0 }),
        json!({ "perDecade": 0 }),
    ] {
        let e = run_err(rc, &req(json!({ "input": "VIN", "output": "out", "sweep": bad })));
        assert!(e.starts_with("sweep:"), "{e}");
    }
}
