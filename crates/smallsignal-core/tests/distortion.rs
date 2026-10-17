//! Distortion: closed forms against textbook results, and a1..a3 against
//! the DC transfer curve itself (finite differences of DC solves, which
//! share nothing with the Volterra solution but the device equations).
//! ngspice agreement is checked by oracle/compare.py.

mod common;

use common::{run, Rng};
use serde_json::{json, Value};
use smallsignal_core::{analyze, dc, netlist, Request};

fn req(v: Value) -> Request {
    serde_json::from_value(v).unwrap()
}

fn rel(a: f64, b: f64) -> f64 {
    if a == b {
        0.0
    } else {
        (a - b).abs() / a.abs().max(b.abs())
    }
}

fn coef(r: &Value, n: usize) -> f64 {
    r["distortion"]["coefficients"][n]["value"].as_f64().unwrap()
}

const SQUARE: &str = "cs\n.options gmin=1e-18\nVDD vdd 0 5\nVIN in 0 DC 0.9 AC 1\nRD vdd out 5k\n\
M1 out in 0 0 nm W=10u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5)\n";

#[test]
fn square_law_common_source() {
    let r = run(
        SQUARE,
        &req(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"], "amplitude": 0.02 })),
    );
    let d = &r["distortion"];
    // β = KP·W/L = 2 mA/V², Vov = 0.4: a1 = −β·Vov·RD, a2 = −(β/2)·RD, a3 = 0.
    assert!(rel(coef(&r, 0), -2e-3 * 0.4 * 5e3) < 1e-12);
    assert!(rel(coef(&r, 1), -1e-3 * 5e3) < 1e-12);
    assert_eq!(coef(&r, 2), 0.0);
    assert_eq!(d["coefficients"][1]["latex"], "-K_{2g,M1} R_{D}");
    assert_eq!(
        d["hd2"]["latex"],
        "\\frac{A}{2}\\left|\\frac{K_{2g,M1}}{g_{m1}}\\right|"
    );
    // HD2 = A/(4 Vov).
    assert!(rel(d["hd2"]["value"].as_f64().unwrap(), 0.02 / (4.0 * 0.4)) < 1e-12);
    assert_eq!(d["hd3"]["value"], 0.0);
    assert_eq!(d["iip3"]["latex"], "\\infty");
    assert!(d["iip3"]["value"].is_null());
    assert_eq!(d["check"]["ok"], true);
    // Only K2g is nonzero.
    let kept: Vec<&Value> = d["taylor"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["kept"] == true)
        .collect();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0]["monomial"], "2g");
}

#[test]
fn degenerated_and_follower_closed_forms() {
    // λ = 0, body tied to source: a2 = −K2g·RD/(1+T)³, a3 = 2K2g²·RS·RD/(1+T)⁵.
    let net = "dg\n.options gmin=1e-18\nVDD vdd 0 5\nVIN in 0 DC 1.0 AC 1\nRD vdd out 5k\n\
M1 out in s s nm W=10u L=1u\nRS s 0 1k\n.model nm nmos (level=1 kp=200u vto=0.5)\n";
    let r = run(
        net,
        &req(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"] })),
    );
    let m = &r["op"]["devices"]["M1"];
    let gm = m["gm"].as_f64().unwrap();
    let k2 = 1e-3;
    let t = 1.0 + gm * 1e3;
    assert!(rel(coef(&r, 0), -gm * 5e3 / t) < 1e-12);
    assert!(rel(coef(&r, 1), -k2 * 5e3 / t.powi(3)) < 1e-12);
    assert!(rel(coef(&r, 2), 2.0 * k2 * k2 * 1e3 * 5e3 / t.powi(5)) < 1e-12);
    // Source follower: a2 = K2g·RL/(1+gm·RL)³.
    let net = "sf\n.options gmin=1e-18\nVDD vdd 0 5\nVIN in 0 DC 1.3 AC 1\nM1 vdd in out out nm W=20u L=1u\n\
RL out 0 5k\n.model nm nmos (level=1 kp=200u vto=0.5)\n";
    let r = run(
        net,
        &req(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"] })),
    );
    let gm = r["op"]["devices"]["M1"]["gm"].as_f64().unwrap();
    let t = 1.0 + gm * 5e3;
    assert!(rel(coef(&r, 1), 2e-3 * 5e3 / t.powi(3)) < 1e-12);
    assert!(rel(coef(&r, 2), -2.0 * 4e-6 * 25e6 / t.powi(5)) < 1e-12);
}

#[test]
fn matched_differential_pair_has_no_even_order() {
    let net = "dp\nVDD vdd 0 5\nRD1 vdd o1 5k\nRD2 vdd o2 5k\nM1 o1 inp tail tail nm W=10u L=1u\n\
M2 o2 inn tail tail nm W=10u L=1u\nITAIL tail 0 200u\nVIP inp 0 DC 1.2 AC 1\nVINN inn 0 1.2\n\
.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05)\n";
    let r = run(
        net,
        &req(
            json!({ "input": "VIP", "inputNeg": "VINN", "output": "o1", "ref": "o2", "nonlinear": ["M1", "M2"],
                     "match": [["M1", "M2"], ["RD1", "RD2"]] }),
        ),
    );
    let d = &r["distortion"];
    // Exactly zero in closed form (shared symbols cancel) and numerically.
    assert_eq!(d["coefficients"][1]["latex"], "0");
    assert!(coef(&r, 1).abs() < 1e-12 * coef(&r, 0).abs());
    assert!(coef(&r, 2) != 0.0);
    assert!(d["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["latex"] == "K_{2g,M1,2}"));
    assert_eq!(d["check"]["ok"], true);
}

#[test]
fn pmos_mirror_flips_even_orders() {
    let p = "cs\n.options gmin=1e-18\nVDD vdd 0 -5\nVIN in 0 DC -0.9 AC 1\nRD vdd out 5k\n\
M1 out in 0 0 pm W=10u L=1u\n.model pm pmos (level=1 kp=200u vto=-0.5 lambda=0.05)\n";
    let n = SQUARE.replace("kp=200u vto=0.5", "kp=200u vto=0.5 lambda=0.05");
    let rq = req(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"] }));
    let (a, b) = (run(&n, &rq), run(p, &rq));
    assert!(rel(coef(&a, 0), coef(&b, 0)) < 1e-12);
    assert!(rel(coef(&a, 1), -coef(&b, 1)) < 1e-12);
    assert!(rel(coef(&a, 2), coef(&b, 2)) < 1e-12);
}

/// a1, a2, a3 of v_out(v_in) by 6th-order central differences of DC solves.
fn dc_taylor(net: &str, vin_line: &str, vin: f64, out: &str, h: f64) -> [f64; 3] {
    let f = |dv: f64| -> f64 {
        let text = net.replace(vin_line, &format!("VIN in 0 DC {:.17e} AC 1", vin + dv));
        let n = netlist::parse(&text).unwrap();
        let op = dc::operating_point(&n).unwrap();
        op.v[n.node(out).unwrap()]
    };
    let p: Vec<f64> = (-3..=3).map(|k| f(k as f64 * h)).collect();
    let (m3, m2, m1, z, p1, p2, p3) = (p[0], p[1], p[2], p[3], p[4], p[5], p[6]);
    let d1 = (45.0 * (p1 - m1) - 9.0 * (p2 - m2) + (p3 - m3)) / (60.0 * h);
    let d2 = (2.0 * (p3 + m3) - 27.0 * (p2 + m2) + 270.0 * (p1 + m1) - 490.0 * z) / (180.0 * h * h);
    let d3 = (-(p3 - m3) + 8.0 * (p2 - m2) - 13.0 * (p1 - m1)) / (8.0 * h * h * h);
    [d1, d2 / 2.0, d3 / 6.0]
}

#[test]
fn volterra_coefficients_are_the_dc_transfer_curve() {
    let mut rng = Rng::new(41);
    let mut checked = 0;
    for _ in 0..40 {
        let kind = rng.below(4);
        let pol: f64 = if rng.below(2) == 0 { 1.0 } else { -1.0 };
        let lam = rng.unit() * 0.1;
        let gamma = rng.unit() * 0.6;
        let r1 = rng.decade(1e3, 2e4);
        let vin = 0.75 + rng.unit() * 0.3;
        let v = |x: f64| pol * x;
        let (m, q) = if pol > 0.0 { ("nm", "qn") } else { ("pm", "qp") };
        let models = format!(
            ".model nm nmos (level=1 kp=200u vto=0.5 lambda={lam} gamma={gamma})\n\
.model pm pmos (level=1 kp=200u vto=-0.5 lambda={lam} gamma={gamma})\n\
.model qn npn (is=1e-16 bf=80 vaf=40)\n.model qp pnp (is=1e-16 bf=80 vaf=40)\n"
        );
        let (body, dev, vin) = match kind {
            0 => (
                format!("RD vdd out {r1}\nM1 out in s 0 {m} W=10u L=1u\nRS s 0 {}\n", r1 * 0.1),
                "M1",
                vin,
            ),
            1 => (
                format!("M1 vdd in out 0 {m} W=10u L=1u\nRL out 0 {r1}\n"),
                "M1",
                vin + 0.6,
            ),
            2 => (
                format!(
                    "RD vdd out {r1}\nM1 x in 0 0 {m} W=10u L=1u\nM2 out vb x 0 {m} W=10u L=1u\nVB vb 0 {}\n",
                    v(2.0)
                ),
                "M1,M2",
                vin,
            ),
            _ => (
                format!("RC vdd out {}\nQ1 out in e {q}\nRE e 0 {}\n", r1 * 0.2, r1 * 0.01),
                "Q1",
                0.7,
            ),
        };
        let vin_line = format!("VIN in 0 DC {:.17e} AC 1", v(vin));
        let net = format!(
            "t\n.options gmin=1e-18\nVDD vdd 0 {}\n{vin_line}\n{body}{models}",
            v(5.0)
        );
        let r = match analyze(
            &net,
            &req(json!({ "input": "VIN", "output": "out", "nonlinear": dev.split(',').collect::<Vec<_>>() })),
        ) {
            Ok(r) => r,
            Err(e) => panic!("{e}\n{net}"),
        };
        let regions_ok = r["op"]["devices"].as_object().unwrap().values().all(|d| {
            matches!(d["region"].as_str(), Some("saturation") | Some("forward-active")) && d["reversed"] != true
        });
        if !regions_ok {
            continue;
        }
        assert_eq!(r["distortion"]["check"]["ok"], true, "{net}");
        let fd = dc_taylor(&net, &vin_line, v(vin), "out", 2e-3);
        let a = [coef(&r, 0), coef(&r, 1), coef(&r, 2)];
        // Finite-difference truncation and DC rounding limit the comparison.
        for (n, tol) in [(0, 1e-7), (1, 1e-5), (2, 3e-3)] {
            let scale = a[n].abs().max(1e-6 * a[0].abs());
            assert!(
                (a[n] - fd[n]).abs() <= tol * scale,
                "a{}: {} vs DC {} ({:.1e})\n{net}",
                n + 1,
                a[n],
                fd[n],
                (a[n] - fd[n]).abs() / scale
            );
        }
        checked += 1;
    }
    assert!(checked > 15, "only {checked} circuits checked");
}

#[test]
fn harmonic_distortion_versus_frequency() {
    // A load capacitor: at low frequency HD equals the memoryless value; far
    // above the pole, HD2 = |H2(jω,jω)|A/(2|H1(jω)|) → the RD·C pole at 2ω
    // halves it relative to the fundamental's: ratio → 1/2.
    let net = SQUARE.replace(".model", "CL out 0 1p\n.model");
    let fp = 1.0 / (2.0 * std::f64::consts::PI * 5e3 * 1e-12);
    let r = run(
        &net,
        &req(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"], "freqs": [1.0, 1e3 * fp] })),
    );
    let vs = &r["distortion"]["vsFreq"];
    let hd = r["distortion"]["hd2"]["value"].as_f64().unwrap();
    assert!(rel(vs[0]["hd2"].as_f64().unwrap(), hd) < 1e-9);
    assert!(rel(vs[1]["hd2"].as_f64().unwrap(), hd / 2.0) < 1e-5);
}

#[test]
fn bad_requests() {
    let rq = |v: Value| analyze(SQUARE, &req(v)).unwrap_err();
    assert!(rq(json!({ "input": "VIN", "output": "out", "nonlinear": ["M9"] })).contains("not found"));
    assert!(rq(json!({ "input": "VIN", "output": "out", "nonlinear": ["RD"] })).contains("cannot be nonlinear"));
    assert!(rq(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"], "order": 4 })).contains("order"));
    assert!(rq(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"], "amplitude": -1 })).contains("amplitude"));
    let e = analyze(
        "cs\nVIN in 0\nVDD vdd 0\nRD vdd out\nM1 out in 0 0\n",
        &req(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"] })),
    )
    .unwrap_err();
    assert!(e.contains("operating point"), "{e}");
}

#[test]
fn five_transistor_ota_falls_back_to_the_leakage_free_closed_form() {
    // With default gmin the bulk-junction leakage stays in the exact model
    // (the output node's impedance is high), and the exact third-order form
    // exceeds the term limit: the display form comes from the leakage-free
    // model, within LEAKAGE_REL of the numeric reference.
    let net = "ota\nVDD vdd 0 3\nVIP inp 0 DC 1.2 AC 1\nVINN inn 0 1.2\nITAIL tail 0 100u\n\
M1 x inp tail 0 nm W=10u L=1u\nM2 out inn tail 0 nm W=10u L=1u\nM3 x x vdd vdd pm W=20u L=1u\n\
M4 out x vdd vdd pm W=20u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05 gamma=0.4)\n\
.model pm pmos (level=1 kp=100u vto=-0.5 lambda=0.05)\n";
    let t = std::time::Instant::now();
    let r = run(
        net,
        &req(
            json!({ "input": "VIP", "inputNeg": "VINN", "output": "out", "match": [["M1", "M2"], ["M3", "M4"]],
                     "nonlinear": ["M1", "M2", "M3", "M4"], "freqs": [1.0], "noise": true }),
        ),
    );
    assert!(t.elapsed().as_secs_f64() < 5.0, "{:?}", t.elapsed());
    let d = &r["distortion"];
    assert!(d["coefficients"][2]["skipped"].is_string());
    for q in [
        &d["coefficients"][0],
        &d["coefficients"][1],
        &d["coefficients"][2],
        &d["hd2"],
        &d["hd3"],
        &d["iip3"],
    ] {
        let v = q["value"].as_f64().unwrap();
        let disp = &q["display"];
        assert!(disp["relError"].as_f64().unwrap() <= 1e-3, "{q}");
        assert!(rel(disp["value"].as_f64().unwrap(), v) <= 1e-3);
        let s = &q["simplified"];
        assert!(s["relError"].as_f64().unwrap() <= 0.05);
        assert!(s["latex"].is_string());
    }
    // HD at 1 Hz (numeric, full model) equals the memoryless value.
    let hd2 = d["hd2"]["value"].as_f64().unwrap();
    assert!(rel(d["vsFreq"][0]["hd2"].as_f64().unwrap(), hd2) < 1e-9);
    // Noise closed form: the textbook 5T OTA result in the limit.
    assert_eq!(
        r["noise"]["inputLowFreq"]["simplified"]["latex"],
        "4kT\\left(\\frac{4}{3 g_{m1,2}} + \\frac{4 g_{m3,4}}{3 {g_{m1,2}}^{2}}\\right)"
    );
}
