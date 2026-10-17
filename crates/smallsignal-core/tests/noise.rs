//! Noise analysis: spectra against hand formulas from the operating point,
//! the closed forms, band integrals against exact integrals, and contract
//! details. (ngspice agreement is checked by oracle/compare.py.)

mod common;

use common::run;
use serde_json::{json, Value};
use smallsignal_core::{analyze, Request};

const K: f64 = 1.38064852e-23;
const Q: f64 = 1.6021766208e-19;
const T: f64 = 300.15;
const FOUR_KT: f64 = 4.0 * K * T;
const COX: f64 = 3.9 * 8.854214871e-12 / 1e-7;

fn req(v: Value) -> Request {
    serde_json::from_value(v).unwrap()
}

fn rel(a: f64, b: f64) -> f64 {
    (a - b).abs() / a.abs().max(b.abs())
}

fn dev<'a>(r: &'a Value, name: &str) -> &'a Value {
    &r["op"]["devices"][name]
}

const CS: &str =
    "cs\n.options gmin=1e-18\nVDD vdd 0 5\nVIN in 0 DC 0.7 AC 1\nRD vdd out 10k\nM1 out in 0 0 nm W=10u L=1u\n\
.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1 kf=1e-24 af=1.3)\n";

#[test]
fn common_source_spectra_match_the_hand_formula() {
    let freqs: [f64; 4] = [1.0, 37.0, 1e3, 1e6];
    let r = run(
        CS,
        &req(json!({ "input": "VIN", "output": "out", "freqs": freqs, "noise": true })),
    );
    let m = dev(&r, "M1");
    let (gm, gds) = (m["gm"].as_f64().unwrap(), m["gds"].as_f64().unwrap());
    let rout = 1.0 / (gds + 1e-4);
    let n = &r["noise"];
    for (i, &f) in freqs.iter().enumerate() {
        let flicker = 1e-24 * gm * gm / (COX * 10e-6 * 1e-6 * f.powf(1.3));
        let s_out = (FOUR_KT / 1e4 + FOUR_KT * 2.0 / 3.0 * gm + flicker) * rout * rout;
        let gain = gm * rout;
        assert!(rel(n["output"][i]["v2"].as_f64().unwrap(), s_out) < 1e-9, "f={f}");
        assert!(rel(n["input"][i]["v2"].as_f64().unwrap(), s_out / (gain * gain)) < 1e-9);
        let srcs = n["contributors"][i]["sources"].as_array().unwrap();
        let sum: f64 = srcs.iter().map(|s| s["fraction"].as_f64().unwrap()).sum();
        assert!((sum - 1.0).abs() < 1e-12);
        let fl = srcs.iter().find(|s| s["kind"] == "flicker").unwrap();
        assert!(rel(fl["v2"].as_f64().unwrap(), flicker * rout * rout) < 1e-9);
    }
    // Sorted by contribution: flicker dominates at 1 Hz, thermal at 1 MHz.
    assert_eq!(n["contributors"][0]["sources"][0]["kind"], "flicker");
    assert_eq!(n["contributors"][3]["sources"][0]["kind"], "thermal");
    assert_eq!(r["noise"]["outputUnit"], "V^2/Hz");
    assert_eq!(r["noise"]["inputUnit"], "V^2/Hz");
}

#[test]
fn common_source_closed_form() {
    let r = run(CS, &req(json!({ "input": "VIN", "output": "out", "noise": true })));
    let lf = &r["noise"]["inputLowFreq"];
    // r_o cancels exactly: every source drives the same node.
    let want = "4kT\\left(\\frac{2}{3 g_{m1}} + \\frac{1}{{g_{m1}}^{2} R_{D}}\\right)";
    assert_eq!(lf["exact"]["latex"], want);
    assert_eq!(lf["simplified"]["latex"], want);
    assert_eq!(lf["check"]["ok"], true);
    let gm = dev(&r, "M1")["gm"].as_f64().unwrap();
    let v = FOUR_KT * (2.0 / (3.0 * gm) + 1.0 / (gm * gm * 1e4));
    assert!(rel(lf["exact"]["value"].as_f64().unwrap(), v) < 1e-12);
    // Flicker is not in the closed form.
    assert!(!lf["exact"]["latex"].as_str().unwrap().contains("K_F"));
}

#[test]
fn symbolic_mode_gives_the_closed_form_only() {
    let net = "cs\nVIN in 0\nVDD vdd 0\nRD vdd out\nM1 out in 0 0\n";
    let r = run(net, &req(json!({ "input": "VIN", "output": "out", "noise": true })));
    let n = &r["noise"];
    assert_eq!(n["output"], json!([]));
    assert!(n["integrated"].is_null());
    let lf = &n["inputLowFreq"];
    assert_eq!(lf["exact"]["thermal"]["num"], "3 + 2*gm_M1*RD");
    assert_eq!(lf["exact"]["thermal"]["den"], "3*gm_M1^2*RD");
    assert!(lf["exact"]["value"].is_null());
}

#[test]
fn rc_band_integral_is_exact() {
    // S_out = 4kTR/(1 + (f/fc)²): ∫ = 4kTR·fc·(atan(hi/fc) − atan(lo/fc)).
    let (rv, c) = (1e3, 1e-12);
    let fc = 1.0 / (2.0 * std::f64::consts::PI * rv * c);
    let net = "rc\nVIN in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 1p\n";
    for (lo, hi) in [(1.0, 1e12), (1e6, 2e8), (fc, fc * 1.0001)] {
        let r = run(
            net,
            &req(json!({ "input": "VIN", "output": "out", "noiseBand": [lo, hi] })),
        );
        let it = &r["noise"]["integrated"];
        let want = FOUR_KT * rv * fc * ((hi / fc).atan() - (lo / fc).atan());
        let got = it["outputV2"].as_f64().unwrap();
        assert!(rel(got, want) < 1e-7, "[{lo}, {hi}]: {got} vs {want}");
        assert!(it["relError"].as_f64().unwrap() < 1e-5);
        // Input-referred: 4kTR flat.
        assert!(rel(it["inputV2"].as_f64().unwrap(), FOUR_KT * rv * (hi - lo)) < 1e-7);
        assert!(rel(it["outputRms"].as_f64().unwrap(), want.sqrt()) < 1e-7);
        assert_eq!(it["converged"], true);
    }
    // Over everything, kT/C.
    let r = run(
        net,
        &req(json!({ "input": "VIN", "output": "out", "noiseBand": [1e-3, 1e18] })),
    );
    let got = r["noise"]["integrated"]["outputV2"].as_f64().unwrap();
    assert!(rel(got, K * T / c) < 1e-6, "{got}");
}

#[test]
fn flicker_band_integral_is_exact() {
    // A CS stage with no capacitance: S_out = (w + k/f)·Rout², so
    // ∫ = Rout²·(w·(hi − lo) + k·ln(hi/lo)) with AF = 1.
    let net = CS.replace("af=1.3", "af=1");
    let r = run(
        &net,
        &req(json!({ "input": "VIN", "output": "out", "noiseBand": [1.0, 1e5] })),
    );
    let m = dev(&r, "M1");
    let (gm, gds) = (m["gm"].as_f64().unwrap(), m["gds"].as_f64().unwrap());
    let rout = 1.0 / (gds + 1e-4);
    let w = FOUR_KT / 1e4 + FOUR_KT * 2.0 / 3.0 * gm;
    let k = 1e-24 * gm * gm / (COX * 1e-11);
    let want = rout * rout * (w * (1e5 - 1.0) + k * 1e5f64.ln());
    let got = r["noise"]["integrated"]["outputV2"].as_f64().unwrap();
    assert!(rel(got, want) < 1e-8, "{got} vs {want}");
}

#[test]
fn matched_diff_pair_is_twice_a_single_transistor() {
    let net = "dp\nVDD vdd 0 1.8\nRD1 vdd o1 10k\nRD2 vdd o2 10k\nM1 o1 inp tail 0 nm W=10u L=1u\n\
M2 o2 inn tail 0 nm W=10u L=1u\nITAIL tail 0 100u\nVID inp inn DC 0 AC 1\nVCM inn 0 0.9\n\
.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05)\n";
    let r = run(
        net,
        &req(
            json!({ "input": "VID", "output": "o1", "ref": "o2", "noise": true, "match": [["M1", "M2"], ["RD1", "RD2"]] }),
        ),
    );
    let lf = &r["noise"]["inputLowFreq"];
    assert_eq!(
        lf["simplified"]["latex"],
        "4kT\\left(\\frac{4}{3 g_{m1,2}} + \\frac{2}{{g_{m1,2}}^{2} R_{D1,2}}\\right)"
    );
    assert_eq!(lf["check"]["ok"], true);
    // Same circuit driven as a pair of sources (±1/2 each): same input noise.
    let net2 = net.replace("VID inp inn DC 0 AC 1\nVCM inn 0 0.9", "VIP inp 0 0.9\nVINN inn 0 0.9");
    let r2 = run(
        &net2,
        &req(json!({ "input": "VIP", "inputNeg": "VINN", "output": "o1", "ref": "o2", "noise": true, "freqs": [1e3] })),
    );
    let a = r["noise"]["input"][0]["v2"].as_f64().unwrap();
    let b = r2["noise"]["input"][0]["v2"].as_f64().unwrap();
    assert!(rel(a, b) < 1e-9, "{a} vs {b}");
    let lf2 = &r2["noise"]["inputLowFreq"];
    assert!(
        rel(
            lf2["exact"]["value"].as_f64().unwrap(),
            lf["exact"]["value"].as_f64().unwrap()
        ) < 1e-9
    );
}

#[test]
fn bjt_shot_noise_uses_bias_current_symbols() {
    let net = "ce\nVCC vcc 0 5\nVIN in 0 DC 0.65 AC 1\nRC vcc c 2k\nQ1 c in 0 qn\n\
.model qn npn (is=1e-16 bf=100 vaf=50 kf=1e-12)\n";
    let r = run(
        net,
        &req(json!({ "input": "VIN", "output": "c", "noise": true, "freqs": [1e4] })),
    );
    let q = dev(&r, "Q1");
    let (gm, go, ic) = (
        q["gm"].as_f64().unwrap(),
        q["go"].as_f64().unwrap(),
        q["ic"].as_f64().unwrap(),
    );
    let lf = &r["noise"]["inputLowFreq"];
    // Exact: with the base-collector leakage r_μ (feedforward through it);
    // the display form drops it.
    assert!(lf["exact"]["latex"].as_str().unwrap().contains("r_{\\mu 1}"));
    assert_eq!(
        lf["display"]["latex"],
        "4kT\\,\\frac{1}{{g_{m1}}^{2} R_{C}} + 2q\\,\\frac{I_{C1}}{{g_{m1}}^{2}}"
    );
    let gmu = q["gmu"].as_f64().unwrap();
    let v = (FOUR_KT / 2e3 + 2.0 * Q * ic) / ((gm - gmu) * (gm - gmu));
    assert!(rel(lf["exact"]["value"].as_f64().unwrap(), v) < 1e-12);
    assert_eq!(lf["currents"][0]["latex"], "I_{C1}");
    // Base shot noise and flicker are shorted by the ideal input source.
    let rout = 1.0 / (go + gmu + 5e-4);
    let s_out = (FOUR_KT / 2e3 + 2.0 * Q * ic) * rout * rout;
    assert!(rel(r["noise"]["output"][0]["v2"].as_f64().unwrap(), s_out) < 1e-9);
}

#[test]
fn diode_shot_and_flicker() {
    let net = "d\nI1 0 a DC 1m AC 1\nD1 a 0 dd\nR1 a 0 10k\n.model dd d (is=1e-14 n=1.5 kf=1e-15 af=1.1)\n";
    let r = run(
        net,
        &req(json!({ "input": "I1", "output": "a", "noise": true, "freqs": [10.0] })),
    );
    let d = dev(&r, "D1");
    let (id, gd) = (d["id"].as_f64().unwrap(), d["gd"].as_f64().unwrap());
    let z = 1.0 / (gd + 1e-4);
    let s = 2.0 * Q * id + 1e-15 * id.powf(1.1) / 10.0 + FOUR_KT * 1e-4;
    assert!(rel(r["noise"]["output"][0]["v2"].as_f64().unwrap(), s * z * z) < 1e-9);
    // A current input: input-referred noise is a current, in A²/Hz.
    assert_eq!(r["noise"]["inputUnit"], "A^2/Hz");
    assert!(rel(r["noise"]["input"][0]["v2"].as_f64().unwrap(), s) < 1e-9);
}

#[test]
fn pmos_mirror_has_the_same_noise() {
    let n = CS;
    let p =
        "cs\n.options gmin=1e-18\nVDD vdd 0 -5\nVIN in 0 DC -0.7 AC 1\nRD vdd out 10k\nM1 out in 0 0 pm W=10u L=1u\n\
.model pm pmos (level=1 kp=200u vto=-0.5 lambda=0.1 kf=1e-24 af=1.3)\n";
    let rq = req(json!({ "input": "VIN", "output": "out", "freqs": [1.0, 1e5], "noise": true }));
    let (a, b) = (run(n, &rq), run(p, &rq));
    for i in 0..2 {
        let (x, y) = (
            a["noise"]["output"][i]["v2"].as_f64().unwrap(),
            b["noise"]["output"][i]["v2"].as_f64().unwrap(),
        );
        assert!(rel(x, y) < 1e-12);
    }
}

#[test]
fn tox_sets_cox_and_the_default_kp() {
    // TOX = 1e-8: Cox 10× the default, KP = UO·Cox = 600e-4·Cox.
    let net = "cs\nVDD vdd 0 5\nVIN in 0 DC 0.7 AC 1\nRD vdd out 10k\nM1 out in 0 0 nm W=10u L=1u\n\
.model nm nmos (level=1 vto=0.5 tox=1e-8 kf=1e-24)\n";
    let r = run(
        net,
        &req(json!({ "input": "VIN", "output": "out", "freqs": [1.0, 1e9], "noise": true })),
    );
    let m = dev(&r, "M1");
    let (gm, gds) = (m["gm"].as_f64().unwrap(), m["gds"].as_f64().unwrap());
    let cox = COX * 10.0;
    let kp = 600e-4 * cox;
    let vov = 0.2;
    assert!(rel(gm, kp * 10.0 * vov) < 1e-6 || m["region"] != "saturation");
    let rout = 1.0 / (gds + 1e-4);
    let flicker = 1e-24 * gm * gm / (cox * 1e-11);
    let s1 = r["noise"]["output"][0]["v2"].as_f64().unwrap() / (rout * rout);
    let s9 = r["noise"]["output"][1]["v2"].as_f64().unwrap() / (rout * rout);
    assert!(rel(s1 - s9, flicker * (1.0 - 1e-9)) < 1e-6);
    assert!(r["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .all(|w| !w.as_str().unwrap().contains("ignores")));
}

#[test]
fn dc_point_with_flicker_is_null_and_bad_bands_fail() {
    let r = run(
        CS,
        &req(json!({ "input": "VIN", "output": "out", "freqs": [0.0, 1.0], "noise": true })),
    );
    assert!(r["noise"]["output"][0]["v2"].is_null());
    assert!(r["noise"]["output"][1]["v2"].as_f64().is_some());
    for band in [json!([0.0, 1.0]), json!([10.0, 1.0]), json!([5.0, 5.0])] {
        let e = analyze(CS, &req(json!({ "input": "VIN", "output": "out", "noiseBand": band }))).unwrap_err();
        assert!(e.contains("noiseBand"), "{e}");
    }
}

#[test]
fn ac_coupled_input_has_no_dc_closed_form() {
    let net = "hp\nVIN in 0 DC 0 AC 1\nC1 in out 1n\nR1 out 0 1k\n";
    let r = run(
        net,
        &req(json!({ "input": "VIN", "output": "out", "noise": true, "freqs": [1e6] })),
    );
    assert_eq!(r["noise"]["inputLowFreq"]["unavailable"], "no gain at DC");
    assert!(r["noise"]["input"][0]["v2"].as_f64().is_some());
}

fn warns(r: &Value, text: &str) -> bool {
    r["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains(text))
}

#[test]
fn bands_too_wide_to_grid_are_rejected() {
    // 600 decades: hi/lo overflows; the grid must be bounded before allocating.
    for band in [json!([1e-300, 1e300]), json!([5e-324, 1e308]), json!([1e-6, 1e40])] {
        let e = analyze(CS, &req(json!({ "input": "VIN", "output": "out", "noiseBand": band }))).unwrap_err();
        assert!(e.contains("noiseBand") && e.contains("decades"), "{e}");
    }
}

/// A series LC trap from `a` to ground: gain zero at 1/(2π√(LC)) ≈ 159.15 kHz.
const TRAP: &str = "trap\nVIN in 0 DC 0 AC 1\nR1 in a 1k\nL1 a x 1m\nC1 x 0 1n\n";

#[test]
fn a_transmission_zero_in_the_band_makes_the_input_integral_unbounded() {
    // Noise added after the notch (buffer, then a noisy divider) does not
    // vanish at the zero: S_in = S_out/|H|² is not integrable across it.
    let net = format!("{TRAP}E1 o 0 a 0 1\nR2 o out 1k\nR3 out 0 1k\n");
    let rq = |band: [f64; 2]| req(json!({ "input": "VIN", "output": "out", "noiseBand": band }));
    let it = &run(&net, &rq([1e3, 1e7]))["noise"]["integrated"];
    assert!(it["inputV2"].is_null(), "{it}");
    assert!(it["unavailable"].as_str().unwrap().contains("zero"), "{it}");
    // The output integral is still finite and reported.
    assert!(it["outputV2"].as_f64().unwrap() > 0.0, "{it}");
    // A band clear of the zero integrates as usual.
    let it = &run(&net, &rq([1e3, 1e5]))["noise"]["integrated"];
    assert!(it["inputV2"].as_f64().unwrap() > 0.0, "{it}");
}

#[test]
fn a_lossy_notch_keeps_a_finite_integral() {
    // Rs = 0.1 Ω in the trap (Q = 1e4): the zero is off the axis and the
    // Lorentzian peak of S_in integrates. With Z = Rs + j(ωL − 1/ωC),
    // S_in = 4kT·(R1 + 2000 + (R1²(Rs + 2000) + 4000·R1·Rs)/|Z|²), and
    // ∫ df/|Z|² over the band is 1/(4·Rs·L) less the tail above fHigh,
    // 1/((2πL)²·fHigh) (the tail below fLow is ~1e-8).
    let net = format!("{TRAP}E1 o 0 a 0 1\nR2 o out 1k\nR3 out 0 1k\n").replace("L1 a x 1m", "L1 a y 1m\nRS y x 0.1");
    let r = run(
        &net,
        &req(json!({ "input": "VIN", "output": "out", "noiseBand": [1e3, 1e7] })),
    );
    let it = &r["noise"]["integrated"];
    let (r1, rs, l, hi) = (1e3, 0.1, 1e-3, 1e7);
    let tail = 1.0 / ((2.0 * std::f64::consts::PI * l).powi(2) * hi);
    let want = FOUR_KT
        * ((r1 + 2000.0) * (hi - 1e3) + (r1 * r1 * (rs + 2000.0) + 4000.0 * r1 * rs) * (1.0 / (4.0 * rs * l) - tail));
    assert!(rel(it["inputV2"].as_f64().unwrap(), want) < 1e-5, "{it} vs {want}");
    assert_eq!(it["converged"], true);
}

#[test]
fn a_zero_shared_by_every_noise_transfer_keeps_the_integral() {
    // Only R1's noise, which sees the same divider as the input: S_in = 4kT·R1
    // exactly, flat through the notch.
    let r = run(
        TRAP,
        &req(json!({ "input": "VIN", "output": "a", "noiseBand": [1e3, 1e7] })),
    );
    let it = &r["noise"]["integrated"];
    let want = FOUR_KT * 1e3 * (1e7 - 1e3);
    assert!(rel(it["inputV2"].as_f64().unwrap(), want) < 1e-6, "{it}");
}

#[test]
fn flicker_with_af_zero_is_finite_at_dc() {
    // KF·gm²/(Cox·W·L·f⁰) is white, including at f = 0.
    let net = CS.replace("af=1.3", "af=0");
    let r = run(
        &net,
        &req(json!({ "input": "VIN", "output": "out", "freqs": [0.0, 1.0, 1e3], "noise": true })),
    );
    let out = &r["noise"]["output"];
    let v0 = out[0]["v2"].as_f64().expect("finite at DC");
    assert!(rel(v0, out[1]["v2"].as_f64().unwrap()) < 1e-12);
    assert!(rel(v0, out[2]["v2"].as_f64().unwrap()) < 1e-12);
    let fl = r["noise"]["contributors"][0]["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["kind"] == "flicker")
        .unwrap();
    assert!(fl["v2"].as_f64().unwrap() > 0.0);
}

#[test]
fn mos_multiplicity_shows_in_the_flicker_psd() {
    let psd = |net: &str| {
        let r = run(net, &req(json!({ "input": "VIN", "output": "out", "noise": true })));
        r["noise"]["sources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["kind"] == "flicker")
            .unwrap()["psd"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(psd(CS), "\\frac{K_F g_m^{2}}{C_{ox} W L f^{A_F}}");
    assert_eq!(
        psd(&CS.replace("L=1u", "L=1u M=2")),
        "\\frac{K_F g_m^{2}}{C_{ox} M W L f^{A_F}}"
    );
}

#[test]
fn matched_diodes_share_one_current_symbol() {
    let net = "dd\nVIN in 0 DC 5 AC 1\nVDD vdd 0 5\nR1 in a 10k\nR2 vdd b 10k\nD1 a 0 dd\nD2 b 0 dd\n\
.model dd d (is=1e-14)\n";
    let r = run(
        net,
        &req(
            json!({ "input": "VIN", "output": "a", "ref": "b", "noise": true, "match": [["D1", "D2"], ["R1", "R2"]] }),
        ),
    );
    let lf = &r["noise"]["inputLowFreq"];
    let cur = lf["currents"].as_array().unwrap();
    assert_eq!(cur.len(), 1, "{}", lf["currents"]);
    assert_eq!(cur[0]["latex"], "I_{D1,2}");
    assert_eq!(cur[0]["elements"], json!(["D1", "D2"]));
    assert_eq!(lf["check"]["ok"], true);
}

/// A resistor bridge, output a − b: gain R2/(R1+R2) − R4/(R3+R4).
fn bridge(r: [&str; 4]) -> String {
    format!(
        "br\nVIN in 0 DC 1 AC 1\nR1 in a {}\nR2 a 0 {}\nR3 in b {}\nR4 b 0 {}\n",
        r[0], r[1], r[2], r[3]
    )
}

#[test]
fn a_balanced_bridge_has_no_dc_gain() {
    let rq = |m: Value| req(json!({ "input": "VIN", "output": "a", "ref": "b", "noise": true, "match": m }));
    // Nonzero symbolically, zero at these values (the products round
    // differently: the numerator is ~1e-22 against terms of ~1e-7).
    let r = run(&bridge(["1.1k", "3.3k", "1.1k", "3.3k"]), &rq(json!([])));
    assert_eq!(
        r["noise"]["inputLowFreq"]["unavailable"], "no gain at DC",
        "{}",
        r["noise"]["inputLowFreq"]
    );
    assert!(!warns(&r, "closed form and numeric"));
    // Zero once matching merges the arms.
    let r = run(
        &bridge(["1k", "2k", "1k", "2k"]),
        &rq(json!([["R1", "R3"], ["R2", "R4"]])),
    );
    assert_eq!(
        r["noise"]["inputLowFreq"]["unavailable"], "no gain at DC",
        "{}",
        r["noise"]["inputLowFreq"]
    );
}

#[test]
fn the_closed_form_check_allows_for_the_match_tolerance() {
    // R1 and R3 merge (they differ by 9e-10 < MATCH_REL), and the small gain
    // (≈ −2.5e-4) amplifies that into ~2e-6 of the input noise.
    let r = run(
        &bridge(["1k", "1k", "1000.0000009", "1001"]),
        &req(json!({ "input": "VIN", "output": "a", "ref": "b", "noise": true, "match": [["R1", "R3"]] })),
    );
    let lf = &r["noise"]["inputLowFreq"];
    let diff = lf["check"]["maxRelDiff"].as_f64().unwrap();
    assert!(diff > 1e-7, "the merge must actually move the value: {diff}");
    assert_eq!(lf["check"]["ok"], true, "{}", lf["check"]);
    assert!(!warns(&r, "closed form and numeric"), "{}", r["warnings"]);
}

#[test]
fn band_rel_error_comes_from_the_band_solves() {
    // 100 F to ground: the MNA matrix is ill-conditioned at high frequency
    // only (κ·eps ≈ 1e-4 at 1 GHz, ≈ 1e-11 below 10 Hz).
    let net = "rc\nVIN in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 100\n";
    let rel_err = |freqs: [f64; 1], band: [f64; 2]| {
        let r = run(
            net,
            &req(json!({ "input": "VIN", "output": "out", "freqs": freqs, "noiseBand": band })),
        );
        r["noise"]["integrated"]["relError"].as_f64().unwrap()
    };
    // Ill-conditioned spectrum point, well-conditioned band.
    assert!(rel_err([1e9], [1.0, 10.0]) < 1e-6);
    // Well-conditioned spectrum point, ill-conditioned band.
    assert!(rel_err([1.0], [1e8, 1e9]) > 1e-5);
}
