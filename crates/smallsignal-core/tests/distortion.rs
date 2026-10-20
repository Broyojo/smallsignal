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
    // In the square law's own terms, as hand analysis writes it:
    // K_2g = g_m/(2 V_OD), so a2 = −g_m R_D/(2 V_OD).
    assert_eq!(d["coefficients"][1]["latex"], "-\\frac{g_{m1} R_{D}}{2 V_{OD1}}");
    assert_eq!(d["hd2"]["latex"], "\\frac{A}{2}\\left|\\frac{1}{2 V_{OD1}}\\right|");
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

/// A CMOS inverter at its switching point, NMOS and PMOS of equal β and
/// V_OD: a1 in parallel notation, and a2 0 (the devices' square-law terms
/// cancel) with no junction leakage in its general form.
#[test]
fn balanced_inverter_reads_as_the_textbook() {
    let net = "inv\nVDD vdd 0 1.8\nVIN in 0 DC 0.9 AC 1\nM1 out in 0 0 nch W=10u L=1u\n\
M2 out in vdd vdd pch W=20u L=1u\n.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.05)\n\
.model pch PMOS (LEVEL=1 KP=100u VTO=-0.5 LAMBDA=0.05)\n";
    let r = run(
        net,
        &req(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1", "M2"] })),
    );
    let d = &r["distortion"];
    let a = &d["coefficients"];
    assert_eq!(
        a[0]["display"]["latex"],
        "-\\left(g_{m1} + g_{m2}\\right) \\left(r_{o1} \\parallel r_{o2}\\right)"
    );
    let a2 = &a[1]["display"]["latex"].as_str().unwrap();
    assert!(!a2.contains("r_{bd"), "{a2}");
    assert!(a2.contains("{\\left(r_{o1} + r_{o2}\\right)}^{2}"), "{a2}");
    for q in [&a[1], &d["hd2"]] {
        assert_eq!(q["simplified"]["latex"], "0");
        assert_eq!(q["simplified"]["method"], "cancels");
    }
    // a3 is not a cancellation: its simplified form stays a formula.
    assert_ne!(a[2]["simplified"]["method"], "cancels");
    // HD2 by frequency is 0 too, not roundoff.
    assert_eq!(d["vsFreq"][0]["hd2"], 0.0);
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
    // The pair's one V_OD, as its g_m and r_o.
    assert_eq!(d["symbols"][0]["latex"], "V_{OD1,2}");
    assert_eq!(d["symbols"][0]["elements"], json!(["M1", "M2"]));
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
        "4kT\\left(\\frac{2 \\gamma}{g_{m1,2}} + \\frac{2 \\gamma g_{m3,4}}{{g_{m1,2}}^{2}}\\right)"
    );
}

#[test]
fn forward_body_bias_coefficients_are_the_dc_transfer_curve() {
    // v_BS > 0: ngspice's AC gmbs uses γ/(2·sarg), but its threshold is
    // linear in v_BS there (slope γ/(2√φ)). a1..a3 must be the Taylor
    // series of the DC transfer curve, so the linear part uses the DC slope;
    // the forward-biased source junction's own curvature is in the series.
    let models = ".model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05 gamma=0.5 phi=0.7)\n\
.model pm pmos (level=1 kp=200u vto=-0.5 lambda=0.05 gamma=0.5 phi=0.7)\n";
    for (pol, body, vin, vb) in [
        (1.0, "RD vdd out 5k\nM1 out in s b nm W=10u L=1u\nRS s 0 1k\n", 1.2, 0.5),
        (1.0, "RD vdd out 5k\nM1 out in s b nm W=10u L=1u\nRS s 0 1k\n", 1.2, 0.7),
        (1.0, "M1 vdd in out b nm W=20u L=1u\nRL out 0 5k\n", 1.8, 1.2),
        (
            -1.0,
            "RD vdd out 5k\nM1 out in s b pm W=10u L=1u\nRS s 0 1k\n",
            1.2,
            0.6,
        ),
    ] {
        let vin_line = format!("VIN in 0 DC {:.17e} AC 1", pol * vin);
        let net = format!(
            "fbb\n.options gmin=1e-18\nVDD vdd 0 {}\n{vin_line}\nVB b 0 {}\n{body}{models}",
            pol * 5.0,
            pol * vb
        );
        let r = run(
            &net,
            &req(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"] })),
        );
        let m = &r["op"]["devices"]["M1"];
        assert!(pol * m["vbs"].as_f64().unwrap() > 0.1, "{net}");
        assert_eq!(m["region"], "saturation");
        assert_eq!(r["distortion"]["check"]["ok"], true, "{net}");
        let fd = dc_taylor(&net, &vin_line, pol * vin, "out", 2e-3);
        let a = [coef(&r, 0), coef(&r, 1), coef(&r, 2)];
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
        assert!(r["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w.as_str().unwrap().contains("forward body bias")));
    }
}

#[test]
fn region_boundaries_are_flagged() {
    let boundary = |net: &str| {
        let r = run(
            net,
            &req(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"] })),
        );
        r["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w == "M1 sits on a region boundary. Its distortion is not a Taylor series.")
    };
    assert!(!boundary(SQUARE));
    // V_GS = V_TH: I_D ∝ max(V_ov, 0)², no second-order Taylor series.
    assert!(boundary(
        &SQUARE
            .replace("DC 0.9", "DC 0.5")
            .replace("vdd 0 5", "vdd 0 5\nRB out 0 1meg")
    ));
    // V_DS = V_DSAT: I_D = 0.16 mA, so RD = 4.6 V / 0.16 mA puts the drain at 0.4 V.
    assert!(boundary(&SQUARE.replace("5k", "28750")));
    assert!(!boundary(&SQUARE.replace("5k", "28000")));
    // A junction at −3·V_T, where ngspice switches to its cubic reverse tail.
    let diode = |v: f64| {
        let net = format!("d\nVIN in 0 DC {v:.17e} AC 1\nD1 in out dm\nR1 out 0 1k\n.model dm d (is=1e-14)\n");
        let r = run(
            &net,
            &req(json!({ "input": "VIN", "output": "out", "nonlinear": ["D1"] })),
        );
        r["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w == "D1 sits on a region boundary. Its distortion is not a Taylor series.")
    };
    assert!(diode(-3.0 * 1.38064852e-23 * 300.15 / 1.6021766208e-19));
    assert!(!diode(-0.1));
}

#[test]
fn matched_mosfets_at_zero_vds_share_symbols() {
    // Two MOS resistors at V_DS = 0 (gm = 0, so no g_m symbol): their
    // Taylor symbols still merge (through r_o), so a2 cancels exactly.
    let net = "mosr\nVIP inp 0 DC 1 AC 1\nVINN inn 0 DC 1\nVG g 0 3\nVR vr 0 1\nM1 inp g o1 o1 nm W=10u L=1u\n\
R1 o1 vr 10k\nM2 inn g o2 o2 nm W=10u L=1u\nR2 o2 vr 10k\n.model nm nmos (level=1 kp=200u vto=0.5)\n";
    let r = run(
        net,
        &req(
            json!({ "input": "VIP", "inputNeg": "VINN", "output": "o1", "ref": "o2", "nonlinear": ["M1", "M2"],
                     "match": [["M1", "M2"], ["R1", "R2"]] }),
        ),
    );
    assert_eq!(r["op"]["devices"]["M1"]["gm"], 0.0);
    let d = &r["distortion"];
    assert_eq!(d["coefficients"][1]["latex"], "0");
    assert_eq!(coef(&r, 1), 0.0);
    assert!(coef(&r, 2) != 0.0);
    let names: Vec<&str> = d["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["latex"].as_str().unwrap())
        .collect();
    assert!(
        names.contains(&"K_{2d,M1,2}") && names.contains(&"K_{g\\,d,M1,2}"),
        "{names:?}"
    );
    assert_eq!(d["check"]["ok"], true);
}

#[test]
fn a_rejected_reduced_form_is_not_kept() {
    // RD = 100 Ω: r_bd moves the gain by < 1e-9, so it is omitted, but the
    // reduced a_n are off by ~1e-10, so the full model's forms are used
    // (never the reduced one), each only if within maxTerms.
    let net = "cs\nVDD vdd 0 5\nVIN in 0 DC 0.9 AC 1\nRD vdd out 100\nM1 out in 0 0 nm W=10u L=1u\n\
.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05)\n";
    let rq = |mt: usize| {
        run(
            net,
            &req(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"], "maxTerms": mt })),
        )
    };
    let r = rq(2_000_000);
    assert_eq!(r["omittedJunctions"], json!(["rbd_M1"]));
    assert!(r["distortion"]["coefficients"][0]["latex"]
        .as_str()
        .unwrap()
        .contains("r_{bd1}"));
    // At maxTerms 20 the full model's a1, a2 fit (with r_bd, not the
    // reduced forms) and are checked; a3 is over budget.
    let r = rq(20);
    let d = &r["distortion"];
    assert_eq!(d["check"]["orders"], json!([1, 2]));
    let c = d["coefficients"].as_array().unwrap();
    for q in &c[..2] {
        assert!(q["latex"].as_str().unwrap().contains("r_{bd1}"), "{q}");
    }
    assert!(c[2]["skipped"].is_string() && c[2]["latex"].is_null(), "{}", c[2]);
    assert!(c[2]["display"]["relError"].as_f64().unwrap() <= 1e-3);
}

#[test]
fn indispensable_leakage_keeps_the_exact_display() {
    // The gate is driven through RG; M2's bulk junctions (bulk at the gate,
    // drain and source at the output) are the only feedback, so a3 exists
    // only through leakage and the leakage-free IIP3 has a zero
    // denominator: the display is the exact form, leakage matters.
    let net = "leak\nVDD vdd 0 5\nVIN in 0 DC 0.9 AC 1\nRG in g 1e6\nM1 out g 0 0 nm W=10u L=1u\nRD vdd out 5k\n\
M2 out 0 out g nm W=1u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5)\n";
    let r = run(
        net,
        &req(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"] })),
    );
    let d = &r["distortion"];
    for q in [&d["coefficients"][2], &d["hd3"], &d["iip3"]] {
        let disp = &q["display"];
        assert_eq!(disp["leakageMatters"], true, "{q}");
        assert_eq!(disp["value"], q["value"]);
        assert!(q["simplified"].is_object());
    }
    assert!(d["iip3"]["value"].as_f64().unwrap().is_finite());
}

#[test]
fn leakage_free_fallback_drops_the_whole_collector_base_junction() {
    // Near saturation (v_BC = −0.29 V) the collector-base junction's
    // curvature is kept. maxTerms forces the leakage-free fallback, whose
    // linear model has no r_μ: its Taylor coefficients must leave out that
    // junction's branch i_μ too (no I_B v_CE terms, I_C without i_μ).
    let net = "ce\nVCC vcc 0 10\nVIN in 0 DC 0.7 AC 1\nRC vcc c 190k\nQ1 c in e qn\nRE e 0 100\n\
.model qn npn (is=1e-16 bf=80 br=2 vaf=40)\n";
    let rq = |mt: usize| {
        run(
            net,
            &req(json!({ "input": "VIN", "output": "c", "nonlinear": ["Q1"], "maxTerms": mt })),
        )
    };
    let names = |r: &Value| -> Vec<String> {
        r["distortion"]["symbols"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["name"].as_str().unwrap().to_string())
            .collect()
    };
    let full = rq(2_000_000);
    assert!(full["distortion"]["coefficients"][2]["skipped"].is_null());
    assert!(names(&full).contains(&"KB3ce_Q1".to_string()));
    let r = rq(1000);
    let d = &r["distortion"];
    assert!(d["coefficients"][2]["skipped"].is_string());
    let fallback = names(&r);
    assert!(fallback.contains(&"KC3ce_Q1".to_string()));
    assert!(
        !fallback.iter().any(|n| n.starts_with("KB") && n.contains("ce")),
        "{fallback:?}"
    );
    // I_C's v_CE³ coefficient without i_μ differs from the full one.
    let value = |r: &Value, name: &str| {
        r["distortion"]["symbols"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == name)
            .unwrap()["value"]
            .as_f64()
            .unwrap()
    };
    assert!(rel(value(&r, "KC3ce_Q1"), value(&full, "KC3ce_Q1")) > 1e-6);
    for q in d["coefficients"].as_array().unwrap() {
        assert!(q["display"]["relError"].as_f64().unwrap() <= 1e-3, "{q}");
    }
}

const OTA: &str = "ota\nVDD vdd 0 3\nVIP inp 0 DC 1.2 AC 1\nVINN inn 0 1.2\nITAIL tail 0 100u\n\
M1 x inp tail 0 nm W=10u L=1u\nM2 out inn tail 0 nm W=10u L=1u\nM3 x x vdd vdd pm W=20u L=1u\n\
M4 out x vdd vdd pm W=20u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05 gamma=0.4)\n\
.model pm pmos (level=1 kp=100u vto=-0.5 lambda=0.05)\n";

#[test]
fn response_has_every_contract_field() {
    // SmallSignalDistortion (packages/small-signal/src/types.ts) requires
    // every field, nullable or empty when unavailable; check, taylor and
    // omissionError come with them.
    let keys = [
        "amplitude",
        "check",
        "coefficients",
        "hd2",
        "hd3",
        "iip3",
        "inputUnit",
        "nonlinear",
        "omissionError",
        "order",
        "symbols",
        "taylor",
        "vsFreq",
    ];
    let has_keys = |r: &Value| {
        let d = r["distortion"].as_object().unwrap();
        let mut got: Vec<&str> = d.keys().map(|k| k.as_str()).collect();
        got.sort_unstable();
        assert_eq!(got, keys, "{d:?}");
        assert!(d["symbols"].is_array() && d["vsFreq"].is_array() && d["coefficients"].is_array());
        assert!(d["hd2"].is_object());
    };
    let rq = |extra: Value| {
        let mut v = json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"], "freqs": [1e3] });
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        run(SQUARE, &req(v))
    };
    // Order 2: no third-order quantities, as null.
    let r = rq(json!({ "order": 2 }));
    has_keys(&r);
    let d = &r["distortion"];
    assert!(d["hd3"].is_null() && d["iip3"].is_null());
    assert_eq!(d["coefficients"].as_array().unwrap().len(), 2);
    assert!(d["vsFreq"][0]["hd3"].is_null());
    let r = rq(json!({ "order": 3 }));
    has_keys(&r);
    assert!(r["distortion"]["hd3"].is_object() && r["distortion"]["iip3"].is_object());
    // a2 and a3 over the term budget (a1 fits): the budget holds per
    // quantity, so a1 stays exact and only it is checked; a2 comes from the
    // leakage-free model, a3 is numeric only.
    let r = run(
        OTA,
        &req(
            json!({ "input": "VIP", "inputNeg": "VINN", "output": "out", "match": [["M1", "M2"], ["M3", "M4"]],
                     "nonlinear": ["M1", "M2", "M3", "M4"], "freqs": [1.0], "maxTerms": 1000 }),
        ),
    );
    has_keys(&r);
    let d = &r["distortion"];
    let c = &d["coefficients"];
    assert!(c[0]["skipped"].is_null() && c[0]["latex"].is_string(), "{}", c[0]);
    assert!(
        c[1]["skipped"].is_string() && c[1]["display"]["latex"].is_string(),
        "{}",
        c[1]
    );
    assert!(c[2]["skipped"].is_string() && c[2]["display"].is_null(), "{}", c[2]);
    assert_eq!(d["check"]["orders"], json!([1]));
    assert!(d["hd3"]["value"].as_f64().unwrap() > 0.0);
}

#[test]
fn an_unaffordable_denominator_power_falls_back_per_quantity() {
    // Degenerated CS with the drain junction's leakage in the exact model
    // (D has 4 terms, D³ 20, D⁵ 56; the numerators at most 10). With
    // maxTerms 30 the exact a1, a2, HD2 materialize but a3 = N3/D⁵ and
    // HD3, IIP3 (over D⁴·N1) do not: they come from the leakage-free model
    // (D has 2 terms there).
    let net = "cs\nVDD vdd 0 50\nVIN in 0 DC 1.0 AC 1\nRD vdd out 5k\nM1 out in s s nm W=10u L=1u\nRS s 0 1k\n\
.model nm nmos (level=1 kp=200u vto=0.5)\n";
    let rq = |mt: usize| {
        run(
            net,
            &req(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"], "maxTerms": mt })),
        )
    };
    let full = rq(2_000_000);
    let r = rq(30);
    let d = &r["distortion"];
    for q in [&d["coefficients"][0], &d["coefficients"][1], &d["hd2"]] {
        assert!(q["skipped"].is_null() && q["latex"].is_string(), "{q}");
    }
    let fd = &full["distortion"];
    for (q, f) in [
        (&d["coefficients"][2], &fd["coefficients"][2]),
        (&d["hd3"], &fd["hd3"]),
        (&d["iip3"], &fd["iip3"]),
    ] {
        assert!(q["skipped"].is_string(), "{q}");
        let v = q["value"].as_f64().unwrap();
        assert!(rel(v, f["value"].as_f64().unwrap()) < 1e-12);
        let disp = &q["display"];
        assert!(disp["relError"].as_f64().unwrap() <= 1e-3, "{q}");
        assert!(rel(disp["value"].as_f64().unwrap(), v) <= 1e-3);
        assert!(disp["latex"].is_string());
        // The leakage-free form is the full model's display form.
        assert_eq!(disp["latex"], f["display"]["latex"]);
        let s = &q["simplified"];
        assert!(s["latex"].is_string() && s["relError"].as_f64().unwrap() <= 0.05, "{q}");
    }
    assert_eq!(d["symbols"][0]["name"], "Vod_M1");
    // The exact a1, a2 that materialized are still checked against the
    // numeric reference; the full run checks all three.
    assert_eq!(d["check"]["ok"], true, "{}", d["check"]);
    assert_eq!(d["check"]["orders"], json!([1, 2]));
    assert!(d["check"]["maxRelDiff"].as_f64().unwrap() < 1e-12);
    assert_eq!(fd["check"]["orders"], json!([1, 2, 3]));
}

/// Without an amplitude, a current input gets 1 µA, not 10 mA (10 mA into a
/// diode biased at 1 mA is far outside any Taylor series).
#[test]
fn current_input_default_amplitude_is_one_microamp() {
    let net = "ci\nIIN 0 in DC 1m AC 1\nD1 in 0 dm\n.model dm D (IS=1e-14)\n";
    let r: Request = serde_json::from_value(json!({ "input": "IIN", "output": "in", "nonlinear": ["D1"] })).unwrap();
    let out = smallsignal_core::analyze(net, &r).unwrap();
    assert_eq!(out["distortion"]["amplitude"].as_f64(), Some(1e-6));
    assert_eq!(out["distortion"]["inputUnit"], "A");
}

#[test]
fn accepted_match_mismatch_is_within_the_check() {
    // M2 is 1e-12 wider than M1, within MATCH_REL: the pair is merged, so
    // the closed-form a2 cancels to exactly 0 while the numeric a2 keeps a
    // residual of order mismatch × the cancelled terms. The check allows
    // the accepted mismatch, and that allowance is tight.
    let net = |w2: &str| {
        format!(
            "dp\nVDD vdd 0 5\nRD1 vdd o1 5k\nRD2 vdd o2 5k\nM1 o1 inp tail tail nm W=10u L=1u\n\
M2 o2 inn tail tail nm W={w2} L=1u\nITAIL tail 0 200u\nVIP inp 0 DC 1.2 AC 1\nVINN inn 0 1.2\n\
.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05)\n"
        )
    };
    let rq = req(
        json!({ "input": "VIP", "inputNeg": "VINN", "output": "o1", "ref": "o2", "nonlinear": ["M1", "M2"],
                 "match": [["M1", "M2"], ["RD1", "RD2"]] }),
    );
    let r = run(&net("10.00000000001u"), &rq);
    let d = &r["distortion"];
    assert_eq!(d["coefficients"][1]["latex"], "0");
    let a2 = d["coefficients"][1]["numeric"].as_f64().unwrap();
    assert!(a2 != 0.0 && a2.abs() < 1e-9 * coef(&r, 0).abs(), "{a2}");
    let ck = &d["check"];
    assert_eq!(ck["ok"], true, "{ck}");
    let warned = r["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("closed form and numeric"));
    assert!(!warned, "{}", r["warnings"]);
    // a2's relative difference is 1 (0 against the residual); the bound
    // explains it without being loose (4.3 here). A mismatch the bound
    // does not cover cannot be built: merging needs ≤ MATCH_REL.
    let diff = ck["maxRelDiff"].as_f64().unwrap();
    let bound = ck["matchBound"].as_f64().unwrap();
    assert!(diff <= 4.0 * bound && bound <= 10.0 * diff, "{ck}");
    // Exactly matched: no allowance at all.
    let r = run(&net("10u"), &rq);
    assert_eq!(r["distortion"]["check"]["matchBound"], 0.0);
    assert_eq!(r["distortion"]["check"]["ok"], true);
}

#[test]
fn blocked_dc_input_has_no_harmonic_distortion_ratio() {
    // AC-coupled gate: at s → 0 the input never reaches M1, so a1 = a2 =
    // a3 = 0 and HD2, HD3, IIP3 are 0/0 there (null, not 0). At 1 kHz the
    // coupling capacitor passes the input and HD is defined.
    let net = "ac\n.options gmin=1e-18\nVDD vdd 0 5\nVIN in 0 DC 0 AC 1\nCC in g 1u\nRG g bias 1meg\n\
VB bias 0 0.9\nRD vdd out 5k\nM1 out g 0 0 nm W=10u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5)\n";
    let r = run(
        net,
        &req(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"], "freqs": [1e3], "amplitude": 0.02 })),
    );
    let d = &r["distortion"];
    for n in 0..3 {
        assert_eq!(coef(&r, n), 0.0);
    }
    for k in ["hd2", "hd3", "iip3"] {
        assert!(d[k].is_null(), "{k}: {}", d[k]);
    }
    // Far above the coupling pole: the DC-coupled stage's HD2 = A/(4 Vov).
    let hd = d["vsFreq"][0]["hd2"].as_f64().unwrap();
    assert!(rel(hd, 0.02 / (4.0 * 0.4)) < 1e-6, "{hd}");
}

#[test]
fn order_two_needs_no_third_harmonic_solve() {
    // An ideal LC tank (1 H, 1 F) resonates at 1/(2π) Hz, exactly 3f for
    // f = 1/(6π): the system at 3f is singular, but HD2 needs only f, 2f.
    let net = SQUARE.replace(".model", "L1 x 0 1\nC1 x 0 1\n.model");
    let f = 1.0 / (6.0 * std::f64::consts::PI);
    let rq = |order: u8| {
        run(
            &net,
            &req(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"], "freqs": [f], "order": order })),
        )
    };
    let r = rq(2);
    let vs = &r["distortion"]["vsFreq"][0];
    let hd = r["distortion"]["hd2"]["value"].as_f64().unwrap();
    assert!(rel(vs["hd2"].as_f64().unwrap(), hd) < 1e-9, "{vs}");
    assert!(vs["hd3"].is_null());
    // Order 3 does need 3f: no HD3 there, but the HD2 of that solve is
    // still given (no capacitor reaches the stage: the memoryless value).
    let r = rq(3);
    let vs = &r["distortion"]["vsFreq"][0];
    assert!(vs["hd3"].is_null(), "{vs}");
    assert!(rel(vs["hd2"].as_f64().unwrap(), hd) < 1e-9, "{vs}");
}

#[test]
fn hd_over_a_vanishing_fundamental_is_infinite() {
    // The tail node of a pair under differential drive: a1 = 0, a2 != 0
    // (the tail moves at second order), a3 = 0 by symmetry.
    let net = "tail\nVDD vdd 0 5\nRD1 vdd o1 5k\nRD2 vdd o2 5k\nM1 o1 inp tail tail nm W=10u L=1u\n\
M2 o2 inn tail tail nm W=10u L=1u\nITAIL tail 0 200u\nCT tail 0 1p\nVIP inp 0 DC 1.2 AC 1\nVINN inn 0 1.2\n\
.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05)\n";
    for matched in [true, false] {
        let mut v = json!({ "input": "VIP", "inputNeg": "VINN", "mode": "differential", "output": "tail",
                            "nonlinear": ["M1", "M2"], "freqs": [1e3, 1e8] });
        if matched {
            v["match"] = json!([["M1", "M2"], ["RD1", "RD2"]]);
        }
        let r = run(net, &req(v));
        let d = &r["distortion"];
        assert_eq!(d["coefficients"][0]["numeric"], 0.0);
        assert!(d["coefficients"][1]["numeric"].as_f64().unwrap() > 0.1);
        let hd2 = &d["hd2"];
        assert_eq!(hd2["latex"], "\\infty", "{hd2}");
        assert!(hd2["value"].is_null());
        for form in ["display", "simplified"] {
            assert_eq!(hd2[form]["latex"], "\\infty");
            assert!(hd2[form]["value"].is_null());
        }
        // a3 is 0 as well (roundoff numerically): HD3 and IIP3 are 0/0.
        assert!(d["hd3"].is_null() && d["iip3"].is_null(), "{} {}", d["hd3"], d["iip3"]);
        for p in d["vsFreq"].as_array().unwrap() {
            assert!(p["hd2"].is_null() && p["hd3"].is_null());
            assert_eq!(p["hd2Infinite"], true, "{p}");
            assert!(p.get("hd3Infinite").is_none(), "{p}");
        }
        assert_eq!(d["check"]["ok"], true);
    }
}

/// A matched NMOS pair driven at the bulks (back gates), with forward body
/// bias v_BS = 0.2 V; the second model has φ = `phi_b`, with γ and VTO
/// chosen so ngspice's g_mb (γ/(2·sarg)) and everything else match M1
/// exactly, while the DC slope γ/(2√φ) does not.
fn body_biased_pair(phi_b: f64) -> String {
    let vbs: f64 = 0.2;
    let sarg = |phi: f64| phi.sqrt() - vbs / (2.0 * phi.sqrt());
    let (ga, pa, va) = (0.4, 0.7, 0.5);
    let gb = ga * sarg(phi_b) / sarg(pa);
    let vb = va + ga * (sarg(pa) - pa.sqrt()) - gb * (sarg(phi_b) - phi_b.sqrt());
    format!(
        "fbb\nVDD vdd 0 5\nRD1 vdd o1 5k\nRD2 vdd o2 5k\nVG g 0 1.0\nM1 o1 g 0 bp na W=10u L=1u\n\
M2 o2 g 0 bn nb W=10u L=1u\nVIP bp 0 DC 0.2 AC 1\nVINN bn 0 0.2\n\
.model na nmos (level=1 kp=200u vto={va:.17e} lambda=0.05 gamma={ga:.17e} phi={pa:.17e})\n\
.model nb nmos (level=1 kp=200u vto={vb:.17e} lambda=0.05 gamma={gb:.17e} phi={phi_b:.17e})\n"
    )
}

#[test]
fn matched_pair_with_different_body_slopes_is_split() {
    let rq = req(
        json!({ "input": "VIP", "inputNeg": "VINN", "output": "o1", "ref": "o2", "nonlinear": ["M1", "M2"],
                 "match": [["M1", "M2"], ["RD1", "RD2"]] }),
    );
    let mismatch_warned = |r: &Value| {
        r["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w.as_str().unwrap().contains("closed form and numeric"))
    };
    // DC slopes 3.7% apart: the gmb symbols are split, and the closed form
    // matches the numeric expansion.
    let r = run(&body_biased_pair(0.9), &rq);
    let d = &r["distortion"];
    assert!(!mismatch_warned(&r), "{}", r["warnings"]);
    assert_eq!(d["check"]["ok"], true, "{}", d["check"]);
    for n in 0..3 {
        let a = d["coefficients"][n]["numeric"].as_f64().unwrap();
        assert!(
            a != 0.0 && rel(coef(&r, n), a) < 1e-9,
            "a{}: {} {a}",
            n + 1,
            coef(&r, n)
        );
    }
    assert!(
        r["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w.as_str().unwrap().contains("gmb")),
        "{}",
        r["warnings"]
    );
    // 1.7e-13 apart: still one symbol, and that difference is part of the
    // mismatch the check allows.
    let r = run(&body_biased_pair(0.7 * (1.0 + 1e-12)), &rq);
    let d = &r["distortion"];
    assert!(!mismatch_warned(&r), "{}", r["warnings"]);
    assert_eq!(d["check"]["ok"], true, "{}", d["check"]);
    assert!(d["check"]["matchBound"].as_f64().unwrap() > 0.0);
}

#[test]
fn a_cancelled_coefficient_is_checked_against_its_terms() {
    // oracle/corpus/dist_diffpair_dm: an exactly matched pair, so the
    // closed-form a2 is 0 and the numeric a2 is roundoff (~1e-16). The
    // check compares it relative to the node responses it is the difference
    // of, not to itself.
    let net = "dm\n.options reltol=1e-9 abstol=1e-15 vntol=1e-12 gmin=1e-15 itl1=1000 itl2=1000\n\
VDD vdd 0 3\nVIP inp 0 DC 1.2\nVINN inn 0 DC 1.2\nM1 o1 inp tail 0 nch W=10u L=1u\n\
M2 o2 inn tail 0 nch W=10u L=1u\nITAIL tail 0 DC 200u\nRD1 vdd o1 5k\nRD2 vdd o2 5k\nCL1 o1 0 1p\n\
CL2 o2 0 1p\n.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1)\n";
    let r = run(
        net,
        &req(
            json!({ "input": "VIP", "inputNeg": "VINN", "mode": "differential", "output": "o2", "ref": "o1",
                     "freqs": [1e6, 1e8], "match": [["M1", "M2"], ["RD1", "RD2"], ["CL1", "CL2"]],
                     "nonlinear": ["M1", "M2"], "order": 3, "amplitude": 0.01 }),
        ),
    );
    let d = &r["distortion"];
    assert_eq!(d["coefficients"][1]["latex"], "0");
    let ck = &d["check"];
    assert_eq!(ck["ok"], true, "{ck}");
    assert!(ck["maxRelDiff"].as_f64().unwrap() < 1e-10, "{ck}");
    assert_eq!(ck["matchBound"], 0.0);
}

#[test]
fn a_notch_in_the_fundamental_is_zero_to_roundoff() {
    // Series 1 H, 1 F traps at both drains short them at 1/(2π) Hz. At
    // f = 0.1591549430918953 (2 ulp off the float nearest 1/(2π)) the LU
    // leaves H1 a residual of order 1e-16 of the currents it sums, which
    // is 0 to roundoff: HD_n is infinite where H_n != 0 and unavailable
    // where H_n = 0 too (the differential H2, 0 by symmetry). Buffering
    // the drains with ideal VCVSs (whose output rows have no diagonal),
    // loaded or not, must not change that.
    let base = "trap\nVDD vdd 0 5\nRD1 vdd o1 5k\nRD2 vdd o2 5k\nM1 o1 inp tail tail nm W=10u L=1u\n\
M2 o2 inn tail tail nm W=10u L=1u\nRT tail 0 2k\nL1 o1 t1 1\nC1 t1 0 1\nL2 o2 t2 1\nC2 t2 0 1\n\
VIP inp 0 DC 1.2 AC 1\nVINN inn 0 1.2\n";
    let model = ".model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05)\n";
    let f = 0.1591549430918953;
    let rq = |extra: &str, output: &str, reff: Option<&str>| {
        let mut v = json!({ "input": "VIP", "inputNeg": "VINN", "mode": "differential", "output": output,
                            "nonlinear": ["M1", "M2"], "freqs": [f, 1e-3, f * (1.0 + 1e-6)],
                            "match": [["M1", "M2"], ["RD1", "RD2"], ["L1", "L2"], ["C1", "C2"]] });
        if let Some(r) = reff {
            v["ref"] = json!(r);
        }
        run(&format!("{base}{extra}{model}"), &req(v))
    };
    let buffers = "EOUT out 0 o1 o2 1\nESE se 0 o1 0 1\n";
    // (netlist extra, output, ref, H2 != 0 at the output).
    let cases = [
        ("", "o1", Some("o2"), false),
        ("", "o1", None, true),
        (buffers, "out", None, false),
        (buffers, "se", None, true),
        ("EOUT out 0 o1 o2 1\nRL out 0 1k\n", "out", None, false),
        ("ESE se 0 o1 0 1\nRL se 0 1meg\n", "se", None, true),
    ];
    for (extra, output, reff, h2) in cases {
        let r = rq(extra, output, reff);
        let vs = r["distortion"]["vsFreq"].as_array().unwrap();
        let p = &vs[0];
        let what = format!("{extra:?} {output}: {p}");
        assert!(p["hd2"].is_null() && p["hd3"].is_null(), "{what}");
        assert_eq!(p.get("hd2Infinite").is_some(), h2, "{what}");
        assert_eq!(p["hd3Infinite"], true, "{what}");
        // Away from the notch, even 1e-6 off it, HD is finite.
        for p in &vs[1..] {
            assert!(
                p["hd3"].as_f64().unwrap() > 0.0 && p.get("hd3Infinite").is_none() && p.get("hd2Infinite").is_none(),
                "{extra:?} {output}: {p}"
            );
        }
    }
}

#[test]
fn a_difference_of_affordable_responses_is_held_to_the_budget() {
    // Two cascaded common-source stages: the gain g_m1 g_m2 R_D1 R_D2 is
    // one term, but a2 sums both devices' parts, two terms. With maxTerms 1
    // that sum is over budget like any product. The budget holds per
    // quantity: a1 stays exact, a2 and a3 (built from a2's parts) are
    // numeric only, and no K symbol is shown. With maxTerms 2 all fit.
    let net = "casc\n.options gmin=1e-18\nVDD vdd 0 5\nVIN in 0 DC 0.9 AC 1\nRD1 vdd o1 20k\nRD2 vdd o2 1k\n\
M1 o1 in 0 0 nm W=10u L=1u\nM2 o2 o1 0 0 nm W=10u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5)\n";
    let rq = |mt: usize| {
        run(
            net,
            &req(json!({ "input": "VIN", "output": "o2", "nonlinear": ["M1", "M2"], "maxTerms": mt })),
        )
    };
    let r = rq(1);
    assert_eq!(r["gain"]["exact"]["latex"], "g_{m1} g_{m2} R_{D1} R_{D2}");
    let d = &r["distortion"];
    assert_eq!(d["coefficients"][0]["latex"], "g_{m1} g_{m2} R_{D1} R_{D2}");
    for (n, q) in d["coefficients"].as_array().unwrap().iter().enumerate().skip(1) {
        assert!(q["skipped"].is_string() && q["latex"].is_null(), "{q}");
        assert_eq!(q["value"], q["numeric"], "a{}", n + 1);
    }
    assert!(d["hd2"]["skipped"].is_string());
    assert_eq!(d["symbols"], json!([]));
    assert_eq!(d["check"]["orders"], json!([1]));
    let r = rq(2);
    let d = &r["distortion"];
    assert_eq!(
        d["coefficients"][1]["latex"],
        "\\frac{g_{m1} g_{m2} R_{D1} R_{D2} \\left(-g_{m1} R_{D1} V_{OD1} + V_{OD2}\\right)}{2 V_{OD1} V_{OD2}}"
    );
    assert!(rel(coef(&r, 1), d["coefficients"][1]["numeric"].as_f64().unwrap()) < 1e-12);
    assert_eq!(d["check"]["ok"], true);
}

#[test]
fn matched_cutoff_mosfets_share_their_junction_symbols() {
    // A matched pair in cutoff (no g_m, no r_o) driven at the bulks: only
    // the forward-biased bulk-source junctions are nonlinear (the
    // bulk-drain ones are reverse biased). The pair is matched through its
    // r_bs, so the junctions' equal coefficients share one symbol and the
    // differential a2 cancels exactly.
    let net =
        "cut\nVDD vdd 0 5\nRS1 s1 0 5k\nRS2 s2 0 5k\nM1 vdd 0 s1 bp nm W=10u L=1u\nM2 vdd 0 s2 bn nm W=10u L=1u\n\
VIP bp 0 DC 0.3 AC 1\nVINN bn 0 0.3\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05)\n";
    let r = run(
        net,
        &req(
            json!({ "input": "VIP", "inputNeg": "VINN", "mode": "differential", "output": "s1", "ref": "s2",
                     "nonlinear": ["M1", "M2"], "match": [["M1", "M2"], ["RS1", "RS2"]] }),
        ),
    );
    let d = &r["distortion"];
    let latex: Vec<&str> = d["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["latex"].as_str().unwrap())
        .collect();
    assert_eq!(latex, ["K^{BS}_{2b,M1,2}", "K^{BS}_{3b,M1,2}"], "{latex:?}");
    assert_eq!(d["coefficients"][1]["latex"], "0");
    assert_eq!(d["coefficients"][1]["numeric"], 0.0);
    assert!(coef(&r, 2) != 0.0);
    assert_eq!(d["check"]["ok"], true);
}

#[test]
fn order_two_omits_what_only_a3_would_need() {
    // Two cascaded stages with a 1 µΩ first load: M2's K_2g moves a2 by
    // 3e-10 (its input carries almost no linear signal) but is all of a3
    // (2·K_2g,M1·K_2g,M2 cascaded). An order-2 request proves omissions
    // against a1, a2 only and leaves it out; order 3 keeps it.
    let net = "casc\n.options gmin=1e-18\nVDD vdd 0 5\nVIN in 0 DC 0.9 AC 1\nRD1 vdd o1 1e-6\nRD2 vdd o2 1k\n\
M1 o1 in 0 0 nm W=10u L=1u\nM2 o2 bias 0 0 nm W=10u L=1u\nVB bias o1 -3.5\n.model nm nmos (level=1 kp=200u vto=0.5)\n";
    let kept = |order: u8| {
        let r = run(
            net,
            &req(json!({ "input": "VIN", "output": "o2", "nonlinear": ["M1", "M2"], "order": order })),
        );
        assert_eq!(r["distortion"]["check"]["ok"], true);
        let t = &r["distortion"]["taylor"];
        let m2 = t.as_array().unwrap().iter().find(|t| t["element"] == "M2").unwrap();
        (m2["kept"] == true, r["distortion"]["omissionError"].as_f64().unwrap())
    };
    let (k2, err2) = kept(2);
    assert!(!k2 && err2 > 0.0 && err2 <= 1e-9, "{k2} {err2}");
    let (k3, _) = kept(3);
    assert!(k3);
}

#[test]
fn a_match_the_full_model_rejects_is_reported() {
    // M1 and M2 differ only in their bulk junctions' IS, which the gain
    // omits, so the match is accepted there; distortion rebuilds on the
    // full model (the junctions move a3 by more than 1e-11), where they
    // do not match, and says so once.
    let net = "dp\n.options gmin=1e-18\nVDD vdd 0 5\nRD1 vdd o1 5k\nRD2 vdd o2 5k\nM1 o1 inp tail 0 na W=10u L=1u\n\
M2 o2 inn tail 0 nb W=10u L=1u\nITAIL tail 0 200u\nVIP inp 0 DC 0.8 AC 1\nVINN inn 0 0.8\n\
.model na nmos (level=1 kp=200u vto=0.5 lambda=0.05 is=1e-14)\n\
.model nb nmos (level=1 kp=200u vto=0.5 lambda=0.05 is=1.1e-14)\n";
    let r = run(
        net,
        &req(
            json!({ "input": "VIP", "inputNeg": "VINN", "output": "o1", "ref": "o2", "nonlinear": ["M1", "M2"],
                     "match": [["M1", "M2"], ["RD1", "RD2"]] }),
        ),
    );
    assert!(r["params"].as_array().unwrap().iter().any(|p| p["latex"] == "g_{m1,2}"));
    let n = r["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|w| *w == "M1 and M2 differ, not matched")
        .count();
    assert_eq!(n, 1, "{}", r["warnings"]);
}

#[test]
fn a_tiny_conductance_beside_a_large_one_keeps_its_digits() {
    // oracle/regressions/dc_nonconv_mos: the vdd/n2 island hangs on M1's
    // bulk-drain junction alone (3.9e-13 S) and on R2 (1.6e-3 S) to a dead
    // end, so v(n2) = v(n1) and a1 = 1 exactly, a2 = a3 = 0 (the closed
    // form). Summed into one f64 matrix entry, g_R2 + g_bd keeps only 6
    // digits of g_bd, and a numeric solve of that matrix gives
    // a1 = 1 + 2.4e-7 (and a2 = −1.1e-12): a failed check. The reference
    // is refined against each stamp term, so it agrees.
    let net = "wild\n.options reltol=1e-9 abstol=1e-15 vntol=1e-12 gmin=1e-15 itl1=1000 itl2=1000\n\
V2 in 0 DC 0.893 AC 1\nR1 n3 m1 5286\nR2 n2 vdd 639.8\nM1 vdd in n1 n1 pch W=11.97u L=0.5u\nV3 m1 in DC 0\n\
H1 n3 n1 V3 10.54\n.model pch PMOS (LEVEL=1 KP=0.0003912 VTO=-0.4293 LAMBDA=0.02821 GAMMA=0.7669 PHI=0.7)\n";
    let r = run(net, &req(json!({ "input": "V2", "output": "n2", "nonlinear": ["M1"] })));
    let d = &r["distortion"];
    assert_eq!(d["check"]["ok"], true, "{}", d["check"]);
    assert_eq!(d["coefficients"][0]["latex"], "1");
    assert!(
        rel(d["coefficients"][0]["numeric"].as_f64().unwrap(), 1.0) < 1e-12,
        "{}",
        d["coefficients"][0]
    );
    for n in 1..3 {
        assert!(
            d["coefficients"][n]["numeric"].as_f64().unwrap().abs() < 1e-20,
            "{}",
            d["coefficients"][n]
        );
    }
    assert!(!r["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("closed form and numeric")));
}

#[test]
fn a_huge_amplitude_overflows_to_unavailable_not_infinite() {
    // a1 = −4, a2 = −5, a3 ≠ 0 (λ): at A = 1e200, HD2 = 5A/8 is a number but
    // HD3 = |a3|A²/16 exceeds f64. That is unavailable (null, with a
    // warning), never \infty (which says a1 = 0), here and versus frequency.
    let net = SQUARE.replace("kp=200u vto=0.5", "kp=200u vto=0.5 lambda=0.05");
    let rq = |amp: f64| {
        run(
            &net,
            &req(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"], "amplitude": amp, "freqs": [1e3] })),
        )
    };
    let r = rq(1e200);
    let d = &r["distortion"];
    let a = |n: usize| d["coefficients"][n]["numeric"].as_f64().unwrap();
    assert!(
        rel(
            d["hd2"]["value"].as_f64().unwrap(),
            a(1).abs() * 1e200 / (2.0 * a(0).abs())
        ) < 1e-12
    );
    assert!(d["hd3"].is_null(), "{}", d["hd3"]);
    assert!(d["iip3"]["value"].as_f64().unwrap() > 0.0);
    let p = &d["vsFreq"][0];
    assert!(p["hd3"].is_null() && p.get("hd3Infinite").is_none(), "{p}");
    assert!(p["hd2"].as_f64().unwrap() > 0.0);
    let warned = |r: &Value, s: &str| {
        r["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w.as_str().unwrap().contains(s))
    };
    assert!(warned(&r, "HD3 exceeds the largest number"), "{}", r["warnings"]);
    // A product that overflows on the way to a representable value is
    // still that value: HD2 = 5·1e308/8.
    let r = rq(1e308);
    let d = &r["distortion"];
    let want = (5.0 / 8.0) * 1e308 * (a(1) / -5.0) / (a(0) / -4.0);
    assert!(
        rel(d["hd2"]["value"].as_f64().unwrap(), want) < 1e-12,
        "{}",
        d["hd2"]["value"]
    );
}

#[test]
fn a_leakage_held_fundamental_keeps_the_numeric_hd() {
    // M1's gate reaches the input only through M2's bulk junction (bulk at
    // the input, everything else at the gate): without leakage a1 = 0, with
    // it a1 = −9.2e-6. At maxTerms 50 the exact HD2, HD3 are over budget,
    // and the leakage-free fallback is 0/0; the finite numeric value wins,
    // shown as a display leakage matters for (before: null).
    let net = "lk\nVDD vdd 0 5\nVIN in 0 DC 0 AC 1\nVB b 0 0.9\nRG b g 1meg\nM1 out g 0 0 nm W=10u L=1u\n\
RD vdd out 5k\nM2 g g g in nm W=1u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05)\n";
    let r = run(
        net,
        &req(json!({ "input": "VIN", "output": "out", "nonlinear": ["M1"], "maxTerms": 50, "amplitude": 0.01 })),
    );
    let d = &r["distortion"];
    let a = |n: usize| d["coefficients"][n]["numeric"].as_f64().unwrap();
    assert!(a(0) != 0.0);
    for (k, want) in [
        ("hd2", a(1).abs() * 0.01 / (2.0 * a(0).abs())),
        ("hd3", a(2).abs() * 1e-4 / (4.0 * a(0).abs())),
    ] {
        let q = &d[k];
        assert!(q["skipped"].is_string(), "{k}: {q}");
        assert!(rel(q["value"].as_f64().unwrap(), want) < 1e-12, "{k}: {q}");
        assert_eq!(q["display"]["leakageMatters"], true, "{k}: {q}");
        assert_eq!(q["display"]["value"], q["value"]);
    }
}
