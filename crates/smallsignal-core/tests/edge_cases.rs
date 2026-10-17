//! Explicit edge cases: degenerate requests, singular circuits, parser
//! details, device regions and unusual inputs/outputs.

mod common;

use common::{close, request, run, run_err, value};
use serde_json::{json, Value};
use smallsignal_core::Request;

fn req(v: Value) -> Request {
    serde_json::from_value(v).unwrap()
}

const CS: &str = "cs\nVDD vdd 0 1.8\nVIN in 0 DC 0.7 AC 1\nRD vdd out 10k\nM1 out in 0 0 nm W=10u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1)\n";

// ---- Requests ---------------------------------------------------------------

#[test]
fn output_equal_to_reference_is_an_error() {
    let mut r = request("VIN", "out");
    r.reference = Some("OUT".into());
    assert!(run_err(CS, &r).contains("same node"));
}

#[test]
fn output_at_ground_is_an_error() {
    for out in ["0", "gnd", "GND"] {
        assert!(run_err(CS, &request("VIN", out)).contains("same node"), "{out}");
    }
}

#[test]
fn output_on_a_supply_is_exactly_zero() {
    // vdd is AC ground (its source is shorted in small-signal).
    let r = run(CS, &req(json!({ "input": "VIN", "output": "vdd", "rout": true })));
    assert_eq!(value(&r, "gain", 0), (0.0, 0.0));
    assert_eq!(r["gain"]["exact"]["latex"], "0");
    assert_eq!(value(&r, "rout", 0), (0.0, 0.0));
}

#[test]
fn unknown_names_are_clean_errors() {
    assert!(run_err(CS, &request("VX", "out")).contains("not found"));
    assert!(run_err(CS, &request("VIN", "nowhere")).contains("not found"));
    assert!(run_err(CS, &request("RD", "out")).contains("must be an independent V or I source"));
    let mut r = request("VIN", "out");
    r.reference = Some("nope".into());
    assert!(run_err(CS, &r).contains("reference node 'nope' not found"));
}

#[test]
fn blank_reference_means_ground() {
    let mut r = request("VIN", "out");
    r.reference = Some("  ".into());
    let a = run(CS, &r);
    let b = run(CS, &request("VIN", "out"));
    assert_eq!(value(&a, "gain", 0), value(&b, "gain", 0));
}

// ---- Singular circuits ------------------------------------------------------

#[test]
fn shorted_input_source_is_a_clean_error() {
    let net = "t\nVIN in 0 1\nV2 in 0 2\nR1 in 0 1k\n";
    assert!(run_err(net, &request("VIN", "in")).contains("singular"));
}

#[test]
fn loop_of_voltage_sources_is_a_clean_error() {
    let net = "t\nVIN a 0 1\nV2 a b 1\nV3 b 0 1\nR1 a 0 1k\nR2 b 0 1k\n";
    assert!(run_err(net, &request("VIN", "b")).contains("singular"));
}

#[test]
fn voltage_source_parallel_to_an_inductor_is_a_clean_error() {
    let net = "t\nVIN in 0 AC 1\nL1 in 0 1u\nR1 in out 1k\nR2 out 0 1k\n";
    assert!(run_err(net, &request("VIN", "out")).contains("singular"));
}

#[test]
fn loop_of_inductors_is_a_clean_error() {
    let net = "t\nVIN in 0 AC 1\nR1 in a 1k\nL1 a b 1u\nL2 b a 2u\nR2 b 0 1k\n";
    assert!(run_err(net, &request("VIN", "b")).contains("singular"));
}

#[test]
fn floating_subcircuit_is_a_clean_error() {
    // n1-n2 connect to nothing else: no DC path to ground.
    let net = "t\nVIN in 0 1\nR1 in 0 1k\nR2 n1 n2 1k\n";
    assert!(run_err(net, &request("VIN", "n1")).contains("singular"));
    // A node reached only through a capacitor has no DC path either.
    let net = "t\nVIN in 0 1\nR1 in 0 1k\nC1 in out 1p\n";
    assert!(run_err(net, &request("VIN", "out")).contains("singular"));
}

#[test]
fn zero_capacitor_is_ignored() {
    let a = run(
        "t\nVIN in 0 AC 1\nR1 in out 1k\nR2 out 0 1k\nC1 out 0 0\n",
        &request("VIN", "out"),
    );
    let b = run("t\nVIN in 0 AC 1\nR1 in out 1k\nR2 out 0 1k\n", &request("VIN", "out"));
    assert_eq!(value(&a, "gain", 0), value(&b, "gain", 0));
    assert_eq!(a["gain"]["exact"]["latex"], b["gain"]["exact"]["latex"]);
}

#[test]
fn zero_resistance_is_rejected() {
    assert!(run_err("t\nVIN in 0 1\nR1 in 0 0\n", &request("VIN", "in")).contains("zero resistance"));
}

#[test]
fn hitting_the_term_limit_is_a_clean_error() {
    let mut net = String::from("dense\nVIN n0 0 AC 1\n");
    for i in 0..6 {
        for j in i + 1..6 {
            net.push_str(&format!("R{i}{j} n{i} n{j} {}k\n", 1 + i + j));
        }
    }
    let r = req(json!({ "input": "VIN", "output": "n3", "maxTerms": 50 }));
    assert!(run_err(&net, &r).contains("too large"));
}

#[test]
fn a_difference_of_affordable_numerators_is_held_to_the_term_limit() {
    // Two independent common-source branches measured differentially: each
    // drain's numerator is one term, their difference two. maxTerms 1 must
    // fail as an over-budget determinant does; maxTerms 2 fits.
    let net = "two\n.options gmin=1e-18\nVDD vdd 0 5\nVIN in 0 DC 0.9 AC 1\nRD1 vdd o1 5k\nRD2 vdd o2 5k\n\
M1 o1 in 0 0 nm W=10u L=1u\nM2 o2 in 0 0 nm W=20u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5)\n";
    let rq = |mt: usize| req(json!({ "input": "VIN", "output": "o1", "ref": "o2", "rout": true, "maxTerms": mt }));
    let e = run_err(net, &rq(1));
    assert!(e.contains("too large (over 1 terms)"), "{e}");
    let r = run(net, &rq(2));
    assert_eq!(r["gain"]["exact"]["latex"], "g_{m2} R_{D2} - g_{m1} R_{D1}");
    assert!(r["rout"]["exact"]["latex"].is_string());
}

// ---- Controlled sources -----------------------------------------------------

#[test]
fn current_controlled_sources_follow_e_h_and_l_branches() {
    // E1 drives 2·V(in) into 1k, sourcing 2 mA/V out of its + terminal, so
    // its branch current (+ → − inside, as for a V source) is −2 mA/V. F1
    // carries that from its n+ (0) to n− (f), pulling 2 mA/V out of f:
    // V(f) = −2·V(in). H1 turns L1's current (V(in)/1k at DC) into 500 Ω·I.
    let net = "t\nVIN in 0 AC 1\nE1 e 0 in 0 2\nRE e 0 1k\nF1 0 f E1 1\nRF f 0 1k\n\
               R1 in l 1k\nL1 l 0 1n\nH1 h 0 L1 500\nRH h 0 1k\n";
    let f = run(net, &req(json!({ "input": "VIN", "output": "f", "freqs": [0] })));
    assert!(
        close(value(&f, "gain", 0), (-2.0, 0.0), 1e-12),
        "{}",
        f["gain"]["values"]
    );
    let h = run(net, &req(json!({ "input": "VIN", "output": "h", "freqs": [0] })));
    assert!(
        close(value(&h, "gain", 0), (0.5, 0.0), 1e-12),
        "{}",
        h["gain"]["values"]
    );
}

// ---- Parser details ---------------------------------------------------------

#[test]
fn parser_is_case_insensitive_and_handles_continuations_and_comments() {
    let net = "Title line, not an element\n\
               * full-line comment\n\
               vin IN 0 dc 0.7 ac 1 ; inline comment\n\
               Vdd VDD 0 1.8 $ another comment\n\
               rd vdd OUT 10K\n\
               m1 out in 0 0 NM\n\
               + w=10U\n\
               + L = 1u\n\
               .MODEL nm NMOS (LEVEL=1 KP=200U VTO=0.5 LAMBDA=0.1)\n\
               .END\n\
               R99 this line is after .end and ignored\n";
    let a = run(net, &request("VIN", "out"));
    let b = run(CS, &request("VIN", "out"));
    assert!(close(value(&a, "gain", 0), value(&b, "gain", 0), 1e-15));
}

#[test]
fn first_line_is_always_the_title() {
    // A netlist without a title loses its first element, like SPICE.
    let r = run_err("VIN in 0 1\nR1 in 0 1k\n", &request("VIN", "in"));
    assert!(r.contains("not found"), "{r}");
}

#[test]
fn control_blocks_and_analysis_cards_are_ignored() {
    let net = "t\nVIN in 0 AC 1\nR1 in out 1k\nR2 out 0 1k\n.op\n.ac dec 10 1 1g\n.control\nrun\nplot v(out)\n.endc\n";
    let r = run(net, &request("VIN", "out"));
    assert!(close(value(&r, "gain", 0), (0.5, 0.0), 1e-15));
}

#[test]
fn unsupported_features_are_clean_errors() {
    for (net, what) in [
        ("t\nX1 a b sub\n", "subcircuit"),
        ("t\n.subckt foo a b\n.ends\n", "subcircuits"),
        ("t\n.param r=1k\n", ".param"),
        ("t\nE1 a 0 poly(1) b 0 1 2\n", "linear"),
        ("t\nM1 d g s b m\n.model m nmos level=3\n", "LEVEL=1"),
    ] {
        let e = run_err(net, &request("V1", "a"));
        assert!(e.contains(what), "{what}: {e}");
    }
}

#[test]
fn transient_source_specs_keep_their_dc_and_ac_values() {
    let net = "t\nVIN in 0 DC 0.5 SIN(0 1 1k) AC 2\nR1 in 0 1k\n";
    let r = run(net, &request("VIN", "in"));
    assert_eq!(r["op"]["nodes"]["in"].as_f64(), Some(0.5));
}

// ---- Devices ----------------------------------------------------------------

/// A MOSFET is symmetric: swapping its drain and source names (so it runs in
/// reverse mode) must give the same operating point and small-signal results.
#[test]
fn reverse_mode_mosfet_equals_the_swapped_device() {
    let base = "rev\nVDD vdd 0 1.8\nVIN in 0 DC 1.2 AC 1\nRL out 0 20k\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1 gamma=0.4)\n";
    let fwd = format!("{base}M1 vdd in out 0 nm W=10u L=1u\n");
    let rev = format!("{base}M1 out in vdd 0 nm W=10u L=1u\n");
    let rq = req(json!({ "input": "VIN", "output": "out", "rout": true, "verify": true }));
    let (a, b) = (run(&fwd, &rq), run(&rev, &rq));
    assert_eq!(b["op"]["devices"]["M1"]["reversed"], true);
    assert_eq!(a["op"]["devices"]["M1"]["reversed"], false);
    assert!((a["op"]["nodes"]["out"].as_f64().unwrap() - b["op"]["nodes"]["out"].as_f64().unwrap()).abs() < 1e-12);
    assert!(close(value(&a, "gain", 0), value(&b, "gain", 0), 1e-10));
    assert!(close(value(&a, "rout", 0), value(&b, "rout", 0), 1e-10));
    assert_eq!(b["verify"]["kcl"], true);
}

#[test]
fn cutoff_device_contributes_nothing() {
    let net = "t\nVDD vdd 0 1.8\nVIN in 0 DC 0.2 AC 1\nRD vdd out 10k\nM1 out in 0 0 nm W=10u L=1u\nRL out 0 10k\n.model nm nmos (level=1 kp=200u vto=0.5)\n";
    let r = run(net, &request("VIN", "out"));
    assert_eq!(r["op"]["devices"]["M1"]["region"], "cutoff");
    assert_eq!(value(&r, "gain", 0), (0.0, 0.0));
    assert!(r["warnings"].to_string().contains("M1 is off"));
}

#[test]
fn triode_device_is_flagged() {
    let net = "t\nVDD vdd 0 1.8\nVIN in 0 DC 1.8 AC 1\nRD vdd out 20k\nM1 out in 0 0 nm W=10u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1)\n";
    let r = run(net, &request("VIN", "out"));
    assert_eq!(r["op"]["devices"]["M1"]["region"], "triode");
    assert!(r["warnings"].to_string().contains("triode"));
}

/// gm and gmb stay continuous across vbs = 0, where ngspice switches to its
/// forward-body-bias formula for the threshold.
#[test]
fn body_effect_is_continuous_through_zero_body_bias() {
    let op = |vb: f64| {
        let net = format!(
            "t\nVDD vdd 0 1.8\nVIN in 0 DC 1.0 AC 1\nVB b 0 {vb}\nVS s 0 0.2\nRD vdd out 10k\nM1 out in s b nm W=10u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1 gamma=0.4)\n"
        );
        run(&net, &request("VIN", "out"))["op"]["devices"]["M1"].clone()
    };
    let (lo, hi) = (op(0.2 - 1e-7), op(0.2 + 1e-7));
    for k in ["gm", "gmb", "id"] {
        let (a, b) = (lo[k].as_f64().unwrap(), hi[k].as_f64().unwrap());
        assert!((a - b).abs() <= 1e-5 * a.abs(), "{k}: {a} vs {b}");
    }
    // And a forward-biased body (vbs > 0) still solves.
    let fwd = op(0.5);
    assert!(fwd["vbs"].as_f64().unwrap() > 0.0);
}

#[test]
fn pmos_pnp_and_diode_bias_correctly() {
    let net = "t\nVDD vdd 0 3\nVIN in 0 DC 2 AC 1\nM1 out in vdd vdd pm W=10u L=1u\nRD out 0 10k\n\
               VB b 0 2.35\nQ1 c b vdd qp\nRC c 0 2k\nVD a 0 0.7\nD1 a 0 dm\n\
               .model pm pmos (kp=100u vto=-0.5 lambda=0.05)\n.model qp pnp (is=1e-15 bf=80 vaf=40)\n.model dm d (is=1e-14)\n";
    let r = run(net, &req(json!({ "input": "VIN", "output": "out", "verify": true })));
    let d = &r["op"]["devices"];
    assert_eq!(d["M1"]["region"], "saturation");
    assert!(
        d["M1"]["id"].as_f64().unwrap() < 0.0,
        "PMOS drain current flows out of the drain"
    );
    assert_eq!(d["Q1"]["region"], "forward-active");
    assert!(
        d["Q1"]["ic"].as_f64().unwrap() < 0.0,
        "PNP collector current flows out of the collector"
    );
    let id = d["D1"]["id"].as_f64().unwrap();
    let want = 1e-14 * ((0.7 / smallsignal_core::devices::vt()).exp() - 1.0) + 1e-12 * 0.7;
    assert!((id - want).abs() <= 1e-12 * want, "{id} vs {want}");
    assert!(value(&r, "gain", 0).0 < 0.0, "a PMOS CS with a load to ground inverts");
}

// ---- Inputs and outputs -----------------------------------------------------

#[test]
fn current_source_input_gives_a_transimpedance() {
    // 1 A into node in, 2k to ground ‖ 2k: Z = 1k.
    let net = "t\nIIN 0 in AC 1\nR1 in 0 2k\nR2 in 0 2k\n";
    let r = run(net, &req(json!({ "input": "IIN", "output": "in", "rin": true })));
    assert_eq!(r["gain"]["unit"], "V/A");
    assert!(close(value(&r, "gain", 0), (1000.0, 0.0), 1e-14));
    assert!(close(value(&r, "rin", 0), (1000.0, 0.0), 1e-14));
    // Reversed source direction flips the gain sign but not the impedance.
    let flip = run(
        "t\nIIN in 0 AC 1\nR1 in 0 2k\nR2 in 0 2k\n",
        &req(json!({ "input": "IIN", "output": "in", "rin": true })),
    );
    assert!(close(value(&flip, "gain", 0), (-1000.0, 0.0), 1e-14));
    assert!(close(value(&flip, "rin", 0), (1000.0, 0.0), 1e-14));
}

#[test]
fn differential_output_of_a_balanced_pair() {
    let net = "dp\n.options gmin=1e-18\nVDD vdd 0 1.8\nVIN inp inn DC 0 AC 1\nVCM inn 0 0.9\nIT tail 0 100u\n\
               M1 op inp tail 0 nm W=10u L=1u\nM2 on inn tail 0 nm W=10u L=1u\nR1 vdd op 10k\nR2 vdd on 10k\n\
               .model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05)\n";
    let rq = req(json!({ "input": "VIN", "output": "on", "ref": "op", "verify": true }));
    let r = run(net, &rq);
    // Balanced pair: v(on) − v(op) = gm·(R ∥ ro)·v_id (inverting at op).
    let m = &r["op"]["devices"]["M1"];
    let (gm, ro) = (m["gm"].as_f64().unwrap(), 1.0 / m["gds"].as_f64().unwrap());
    let want = gm * (10e3 * ro / (10e3 + ro));
    assert!(
        close(value(&r, "gain", 0), (want, 0.0), 1e-9),
        "{} vs {want}",
        r["gain"]["values"]
    );
}

#[test]
fn infinite_input_impedance_is_reported_as_infinite() {
    let r = run(
        CS,
        &req(json!({ "input": "VIN", "output": "out", "rin": true, "freqs": [0, 1e3] })),
    );
    assert_eq!(r["rin"]["infinite"], true);
    assert_eq!(r["rin"]["values"][0]["inf"], true);
    assert!(r["rin"]["values"][0]["re"].is_null());
}

#[test]
fn values_at_dc_with_a_pole_at_dc_are_null_not_garbage() {
    // A current into a capacitor integrates: infinite gain at f = 0.
    let net = "t\nIIN 0 out AC 1\nC1 out 0 1p\nRBIG out 0 1e15\n";
    let r = run(net, &req(json!({ "input": "IIN", "output": "out", "freqs": [0, 1e3] })));
    let v1 = value(&r, "gain", 1);
    assert!(v1.0.is_finite() && v1.1.is_finite());
    let s = serde_json::to_string(&r).unwrap();
    assert!(!s.contains("NaN") && !s.contains("inf\""), "{s}");
}

// ---- Two-source inputs and matching -------------------------------------------

// gmin = 1e-18: these compare with textbook formulas, which leave out the
// junction leakage that the default gmin (1e-12 S, ~5e-9 of a 5 kΩ load)
// puts into the exact model.
const PAIR: &str = "pair\n.options gmin=1e-18\nVDD vdd 0 1.8\nVIP inp 0 DC 1 AC 1\nVINN inn 0 DC 1\nIT tail 0 200u\nIX x 0 1u\nRX x 0 1k\n\
                    M1 o1 inp tail 0 nm W=10u L=1u\nM2 o2 inn tail 0 nm W=10u L=1u\nRD1 vdd o1 5k\nRD2 vdd o2 5k\n\
                    .model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1)\n";

#[test]
fn two_source_requests_are_validated() {
    let bad = [
        (
            json!({ "input": "VIP", "inputNeg": "VIP", "output": "o1" }),
            "same source",
        ),
        (
            json!({ "input": "VIP", "inputNeg": "IX", "output": "o1" }),
            "both be voltage sources",
        ),
        (
            json!({ "input": "VIP", "inputNeg": "RD1", "output": "o1" }),
            "independent V or I source",
        ),
        (
            json!({ "input": "VIP", "inputNeg": "nope", "output": "o1" }),
            "not found",
        ),
        (
            json!({ "input": "VIP", "mode": "common", "output": "o1" }),
            "needs inputNeg",
        ),
        (
            json!({ "input": "VIP", "inputNeg": "VINN", "mode": "sideways", "output": "o1" }),
            "unknown mode",
        ),
    ];
    for (r, want) in bad {
        let e = run_err(PAIR, &req(r.clone()));
        assert!(e.contains(want), "{r}: {e}");
    }
    // An empty inputNeg or mode means a single input.
    let r = run(
        PAIR,
        &req(json!({ "input": "VIP", "inputNeg": "", "mode": "", "output": "o1" })),
    );
    assert_eq!(r["mode"], "single");
}

#[test]
fn differential_gain_of_a_balanced_pair_is_twice_the_half_circuit() {
    let r = run(
        PAIR,
        &req(
            json!({ "input": "VIP", "inputNeg": "VINN", "output": "o1", "ref": "o2", "match": [["M1", "M2"], ["RD1", "RD2"]] }),
        ),
    );
    assert_eq!(r["mode"], "differential");
    let m = &r["op"]["devices"]["M1"];
    let (gm, ro) = (m["gm"].as_f64().unwrap(), 1.0 / m["gds"].as_f64().unwrap());
    assert!(
        close(value(&r, "gain", 0), (-gm * (5e3 * ro / (5e3 + ro)), 0.0), 1e-12),
        "{}",
        r["gain"]["values"]
    );
    assert_eq!(
        r["gain"]["exact"]["latex"],
        "-g_{m1,2} \\left(r_{o1,2} \\parallel R_{D1,2}\\right)"
    );
    // Ideal tail: no common-mode gain at the differential output.
    let c = run(
        PAIR,
        &req(json!({ "input": "VIP", "inputNeg": "VINN", "mode": "common", "output": "o1", "ref": "o2" })),
    );
    assert_eq!(value(&c, "gain", 0), (0.0, 0.0));
}

#[test]
fn match_requests_are_validated() {
    let warn =
        |m: Value| run(PAIR, &req(json!({ "input": "VIP", "output": "o1", "match": m })))["warnings"].to_string();
    assert!(warn(json!([["M1", "MX"]])).contains("No element MX to match"));
    assert!(warn(json!([["M1", "RD1"]])).contains("different kinds of element"));
    // A one-element group, or a repeated name, merges nothing and warns nothing.
    let w = warn(json!([["M1"], ["M2", "M2"]]));
    assert!(!w.contains("match"), "{w}");
    // Overlapping groups join: [M1,M2] + [M2,M1] is one group.
    let r = run(
        PAIR,
        &req(json!({ "input": "VIP", "output": "o1", "match": [["M1", "M2"], ["M2", "M1"]] })),
    );
    assert!(r["params"].to_string().contains("g_{m1,2}"));
}

#[test]
fn match_candidates_need_the_same_model_geometry_and_bias() {
    let r = run(PAIR, &req(json!({ "input": "VIP", "output": "o1" })));
    let c = r["matchCandidates"].to_string();
    assert!(c.contains("[\"M1\",\"M2\"]") && c.contains("[\"RD1\",\"RD2\"]"), "{c}");
    // Different W: not a candidate.
    let net = PAIR.replace("M2 o2 inn tail 0 nm W=10u", "M2 o2 inn tail 0 nm W=11u");
    let r = run(&net, &req(json!({ "input": "VIP", "output": "o1" })));
    assert!(
        !r["matchCandidates"].to_string().contains("M1"),
        "{}",
        r["matchCandidates"]
    );
    // Same geometry, different bias: not a candidate in numeric mode.
    let net = PAIR.replace("VINN inn 0 DC 1", "VINN inn 0 DC 1.05");
    let r = run(&net, &req(json!({ "input": "VIP", "output": "o1" })));
    assert!(
        !r["matchCandidates"].to_string().contains("M1"),
        "{}",
        r["matchCandidates"]
    );
}

#[test]
fn symbolic_leading_order_is_labelled() {
    let r = run(
        "cs\nVIN in 0\nVDD vdd 0\nRD vdd out\nM1 out in 0 0\n",
        &request("VIN", "out"),
    );
    assert_eq!(r["gain"]["simplified"]["assumption"], "ro ≫ R, 1/gm");
    assert_eq!(r["gain"]["simplified"]["latex"], "-g_{m1} R_{D}");
    assert_eq!(
        r["gain"]["exact"]["latex"],
        "-g_{m1} \\left(r_{o1} \\parallel R_{D}\\right)"
    );
}

/// A numeric simplified form may not drop terms from the numerator and the
/// denominator whose errors cancel: each coefficient stays within the
/// tolerance on its own. Before, a transconductor with R1/R2 feedback
/// (gm·RD = 2.3) showed R1/R2 (1, with R1 = 40k and R2 = 60k), which is no
/// limit of the gain (exact 1.045), and a matched CMOS inverter showed
/// −g_{m1} r_{o2}, half of each part.
#[test]
fn simplified_parts_are_each_within_tolerance() {
    let feedback = "fb\nVIN in 0 AC 1\nRD 0 out 5k\nR1 out f 50k\nR2 f 0 50k\nG1 out in f in 0.46m\n";
    let r = run(feedback, &req(json!({ "input": "VIN", "output": "out", "rout": true })));
    assert_eq!(
        r["gain"]["simplified"]["latex"],
        "\\frac{G_{1} R_{D} \\left(R_{1} + R_{2}\\right)}{G_{1} R_{D} R_{2} + R_{1} + R_{2}}"
    );
    assert_eq!(
        r["rout"]["simplified"]["latex"],
        "\\frac{R_{D} \\left(R_{1} + R_{2}\\right)}{G_{1} R_{D} R_{2} + R_{1} + R_{2}}"
    );
    let r = run(
        &feedback.replace("50k\nR2 f 0 50k", "40k\nR2 f 0 60k"),
        &request("VIN", "out"),
    );
    assert_eq!(
        r["gain"]["simplified"]["latex"],
        "\\frac{G_{1} R_{D} \\left(R_{2} + R_{1}\\right)}{G_{1} R_{D} R_{2} + R_{2} + R_{1}}"
    );
    let inverter = "inv\nVDD vdd 0 1.8\nVIN in 0 DC 0.9 AC 1\nM1 out in 0 0 nch W=10u L=1u\n\
                    M2 out in vdd vdd pch W=20u L=1u\n.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1)\n\
                    .model pch PMOS (LEVEL=1 KP=100u VTO=-0.5 LAMBDA=0.1)\n";
    let r = run(inverter, &request("VIN", "out"));
    assert_eq!(r["gain"]["simplified"]["same"], false);
    assert_eq!(
        r["gain"]["simplified"]["latex"],
        "-\\frac{r_{o1} r_{o2} \\left(g_{m1} + g_{m2}\\right)}{r_{o1} + r_{o2}}"
    );
}

/// Terms of equal size are dropped together or not at all: a matched pair
/// keeps a symmetric simplified form (before, r_{o2} but not r_{o1}).
#[test]
fn simplified_drops_equal_terms_together() {
    let pair = "bjt pair\nVCC vcc 0 5\nVEE vee 0 -5\nVCM cm 0 0\nVIN inp cm DC 0 AC 1\nQ1 c1 inp tail qn\n\
                Q2 c2 cm tail qn\nITAIL tail vee DC 1m\nRC1 vcc c1 5k\nRC2 vcc c2 5k\n.model qn NPN (IS=1e-15 BF=100 VAF=50)\n";
    let r = run(pair, &req(json!({ "input": "VIN", "output": "c2", "ref": "c1" })));
    assert_eq!(
        r["gain"]["simplified"]["latex"],
        "\\frac{g_{m1} g_{m2} r_{o1} r_{o2} \\left(R_{C1} + R_{C2}\\right)}{g_{m1} r_{o1} r_{o2} + g_{m2} r_{o1} r_{o2} + g_{m1} r_{o1} R_{C2} + g_{m2} r_{o2} R_{C1}}"
    );
}

/// A common factor left once terms are dropped is cancelled: r_o → ∞ in a
/// degenerated stage leaves R_D, not R_D(1 + g_m R_S)/(1 + g_m R_S).
#[test]
fn simplified_cancels_common_factors() {
    let net = "deg\nVDD vdd 0 1.8\nVIN in 0 DC 1.0 AC 1\nRD vdd out 5k\nM1 out in s 0 nm W=10u L=1u\nRS s 0 1k\n\
               .model nm NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1 GAMMA=0.5 PHI=0.7)\n";
    let r = run(net, &req(json!({ "input": "VIN", "output": "out", "rout": true })));
    assert_eq!(r["rout"]["simplified"]["latex"], "R_{D}");
}

/// Symbolic hand analysis neglects body effect with channel-length
/// modulation (g_mb ≪ g_m) and says so, except where that would leave a pure
/// number: a follower into an ideal current source keeps g_m/(g_m + g_mb),
/// which body effect alone sets, rather than 1.
#[test]
fn symbolic_hand_form_neglects_body_effect() {
    let degen = run(
        "deg\nVIN in 0\nVDD vdd 0\nRD vdd out\nM1 out in s 0\nRS s 0\n",
        &request("VIN", "out"),
    );
    assert_eq!(
        degen["gain"]["simplified"]["latex"],
        "-\\frac{g_{m1} R_{D}}{g_{m1} R_{S} + 1}"
    );
    assert_eq!(degen["gain"]["simplified"]["assumption"], "ro ≫ R, 1/gm and gmb ≪ gm");
    assert!(degen["gain"]["exact"]["latex"].as_str().unwrap().contains("g_{mb1}"));
    let sf = run(
        "sf\nVDD vdd 0\nVIN in 0\nVB vb 0\nM1 vdd in out 0\nM2 out vb 0 0\n",
        &req(json!({ "input": "VIN", "output": "out", "rout": true })),
    );
    assert_eq!(
        sf["gain"]["simplified"]["latex"],
        "g_{m1} \\left(\\frac{1}{g_{m1}} \\parallel \\frac{1}{g_{mb1}}\\right)"
    );
    assert_eq!(sf["gain"]["simplified"]["assumption"], "ro ≫ R, 1/gm");
    assert_eq!(sf["rout"]["simplified"]["latex"], "\\frac{1}{g_{m1}}");
    assert_eq!(sf["rout"]["simplified"]["assumption"], "ro ≫ R, 1/gm and gmb ≪ gm");
    // A gain through the body alone keeps its leading order in g_mb.
    let bulk = run(
        "bulk\nVDD vdd 0\nVIN in 0\nVG g 0\nRD vdd out\nM1 out g 0 in\n",
        &request("VIN", "out"),
    );
    assert_eq!(bulk["gain"]["simplified"]["latex"], "-g_{mb1} R_{D}");
}

/// Symbolic mode keeps r_o finite for a device it knows is in triode, and
/// says so. Two NMOS on one gate, the inner one's drain on the outer one's
/// source: the inner one is in triode whenever the outer one conducts (one
/// longer device), so its r_o stays. Before: −g_{m1} R_D, a cascode reading.
#[test]
fn symbolic_keeps_triode_ro() {
    let r = run(
        "stack\nVDD vdd 0\nVIN in 0\nRD vdd out\nM2 out in x 0\nM1 x in 0 0\n",
        &request("VIN", "out"),
    );
    assert_eq!(r["warnings"], json!(["M1 is in triode"]));
    assert!(
        r["gain"]["simplified"]["latex"].as_str().unwrap().contains("r_{o1}"),
        "{}",
        r["gain"]["simplified"]
    );
    assert!(!r["gain"]["simplified"]["latex"].as_str().unwrap().contains("r_{o2}"));
    // The same rule with values given (symbolic mode ignores the bias): the
    // bottom NMOS of this two-NMOS stage is in triode (r_o2 ≈ 1 kΩ at this
    // bias, as numeric mode reports).
    let net = "nn\nVDD vdd 0 1.8\nVIN in 0 DC 1.2 AC 1\nM1 vdd in out 0 nch W=10u L=1u\nM2 out in 0 0 nch W=10u L=1u\n\
               .model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1 GAMMA=0.4 PHI=0.8)\n";
    let r = run(net, &req(json!({ "input": "VIN", "output": "out", "symbolic": true })));
    assert_eq!(r["symbolic"], true);
    assert_eq!(r["warnings"], json!(["M2 is in triode"]));
    let simplified = r["gain"]["simplified"]["latex"].as_str().unwrap();
    assert!(
        simplified.contains("r_{o2}") && !simplified.contains("r_{o1}"),
        "{simplified}"
    );
}

/// Matching never merges devices in different regions. A shared-gate stack
/// of one model and geometry (outer saturated, inner in triode) is offered
/// no match, and an explicit match is refused, so the inner device keeps its
/// finite r_o in either element order. Before: matchAuto merged them into
/// r_{o1,2}, which the outer one's region took to infinity, or kept finite
/// when the inner one came first.
#[test]
fn matching_keeps_regions_apart() {
    let stack = |a: &str, b: &str| {
        format!(
            "nn\nVDD vdd 0 1.8\nVIN in 0 DC 1.2 AC 1\n{a}\n{b}\n\
             .model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1 GAMMA=0.4 PHI=0.8)\n"
        )
    };
    let (outer, inner) = ("M1 vdd in out 0 nch W=10u L=1u", "M2 out in 0 0 nch W=10u L=1u");
    for net in [stack(outer, inner), stack(inner, outer)] {
        let base = json!({ "input": "VIN", "output": "out", "symbolic": true });
        let mut auto = base.clone();
        auto["matchAuto"] = json!(true);
        let r = run(&net, &req(auto));
        assert_eq!(r["matchCandidates"], json!([]));
        assert_eq!(r["warnings"], json!(["M2 is in triode"]));
        let simplified = r["gain"]["simplified"]["latex"].as_str().unwrap();
        assert!(
            simplified.contains("r_{o2}") && !simplified.contains("r_{o1"),
            "{simplified}"
        );
        let mut explicit = base.clone();
        explicit["match"] = json!([["M1", "M2"]]);
        let r = run(&net, &req(explicit));
        assert_eq!(
            r["warnings"],
            json!(["M2 is in triode", "M1 and M2 are in different regions, not matched"])
        );
        assert_eq!(r["gain"]["simplified"]["latex"], simplified);
    }
}

/// The inner device of a shared-gate stack is in triode only when its
/// threshold is provably no higher than the outer one's: both bulks on one
/// node, or each on its own source. With the inner bulk elsewhere, body
/// effect can keep it saturated, so nothing is inferred (before: "M1 is in
/// triode" and a finite r_{o1}).
#[test]
fn triode_inference_needs_the_bulk_bias() {
    let r = run(
        "stack\nVDD vdd 0\nVIN in 0\nVB vb 0\nRD vdd out\nM2 out in x 0\nM1 x in 0 vb\n",
        &request("VIN", "out"),
    );
    assert_eq!(r["warnings"], json!([]));
    assert!(!r["gain"]["simplified"]["latex"].as_str().unwrap().contains("r_{o"));
    let r = run(
        "stack\nVDD vdd 0\nVIN in 0\nRD vdd out\nM2 out in x x\nM1 x in 0 0\n",
        &request("VIN", "out"),
    );
    assert_eq!(r["warnings"], json!(["M1 is in triode"]));
}

/// An element with both ends on one node contributes nothing: it is named,
/// and the result is the circuit's without it.
#[test]
fn element_on_one_node_is_named() {
    let net = "deg\nCSB 0 0 1f\nR9 out out 1k\nI9 out out 1m\nVIN in 0 AC 1\nR1 in out 1k\nR2 out 0 1k\n";
    let r = run(net, &request("VIN", "out"));
    assert_eq!(
        r["warnings"],
        json!([
            "CSB has both ends at 0",
            "R9 has both ends at out",
            "I9 has both ends at out"
        ])
    );
    assert_eq!(r["gain"]["exact"]["latex"], "\\frac{R_{2}}{R_{1} + R_{2}}");
}

/// Symbolic mode has no root values but counts them: a CS stage with C_GD
/// and C_L has two poles and one zero (g_m/C_GD), as numeric mode finds.
#[test]
fn symbolic_counts_poles_and_zeros() {
    let r = run(
        "m\nVIN in 0\nRS in g\nVDD vdd 0\nRD vdd out\nM1 out g 0 0\nCGD g out\nCL out 0\n",
        &request("VIN", "out"),
    );
    assert_eq!(r["gain"]["poles"], json!([]));
    assert_eq!(
        (r["gain"]["poleCount"].as_u64(), r["gain"]["zeroCount"].as_u64()),
        (Some(2), Some(1))
    );
    let r = run(
        "m\nVIN in 0 DC 0.7 AC 1\nRS in g 1k\nVDD vdd 0 1.8\nRD vdd out 10k\nM1 out g 0 0 nm W=10u L=1u\nCGD g out 1p\n\
         CL out 0 1p\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1)\n",
        &request("VIN", "out"),
    );
    assert_eq!(
        r["gain"]["poleCount"].as_u64(),
        Some(r["gain"]["poles"].as_array().unwrap().len() as u64)
    );
}

/// An operating point with a right-half-plane natural frequency is named:
/// positive feedback through a VCVS of gain k puts the pole at
/// (k − 2)/(2π R C), unstable above k = 2. A lossless LC (poles on the jω
/// axis) is not.
#[test]
fn right_half_plane_poles_are_warned() {
    let net = |k: &str| format!("pf\nVIN in 0 AC 1\nR1 in a 1k\nR2 out a 1k\nC1 a 0 1n\nE1 out 0 a 0 {k}\n");
    let r = run(&net("3"), &request("VIN", "out"));
    assert_eq!(
        r["warnings"],
        json!(["Unstable at this bias: a right-half-plane pole."])
    );
    let pole = r["gain"]["poles"][0]["re"].as_f64().unwrap();
    assert!(
        (pole / (1.0 / (2.0 * std::f64::consts::PI * 1e-6)) - 1.0).abs() < 1e-9,
        "{pole}"
    );
    let r = run(&net("1.5"), &request("VIN", "out"));
    assert_eq!(r["warnings"], json!([]));
    let lc = "lc\nIIN 0 a AC 1\nL1 a 0 1u\nC1 a 0 1n\nL2 a b 1u\nC2 b 0 1n\n";
    let r = run(lc, &request("IIN", "b"));
    assert_eq!(r["warnings"], json!([]));
}

/// Two transconductances in series read as R_D/(1/g_{m1} + 1/g_{m2}), not
/// g_{m1} g_{m2} R_D (1/g_{m1} ∥ 1/g_{m2}): a follower driving a common gate.
#[test]
fn series_transconductances_read_as_a_sum() {
    let r = run(
        "sf cg\nVDD vdd 0\nVIN in 0\nVB vb 0\nM1 vdd in x x\nM2 out vb x x\nIB x 0\nRD vdd out\n",
        &request("VIN", "out"),
    );
    assert_eq!(
        r["gain"]["simplified"]["latex"],
        "\\frac{R_{D}}{\\frac{1}{g_{m1}} + \\frac{1}{g_{m2}}}"
    );
}

// ---- Overflowing models -----------------------------------------------------

/// A device equation that overflows names the device; it is never reported
/// as a wiring fault, and never yields a non-finite result.
#[test]
fn overflowing_models_name_the_device() {
    let cases = [
        // IS = 1 A and N = 0.01 forced to 0.7 V by an ideal source.
        ("d\nVIN in 0 DC 0.7 AC 1\nD1 in 0 dm\nR1 in out 1k\nR2 out 0 1k\n.model dm D (IS=1 N=0.01)\n", "D1"),
        // A subnormal Early voltage: 1/VAF is infinite.
        ("q\nVCC vcc 0 5\nVIN b 0 DC 0.7 AC 1\nRC vcc out 1k\nQ1 out b 0 qm\n.model qm NPN (IS=1e-15 BF=100 VAF=5e-324)\n", "Q1"),
        // IS = 1 A at a forced 0.7 V base.
        ("q\nVCC vcc 0 5\nVIN b 0 DC 0.7 AC 1\nRC vcc out 1k\nQ1 out b 0 qm\n.model qm NPN (IS=1 BF=100 VAF=50)\n", "Q1"),
    ];
    for (netlist, device) in cases {
        let err = run_err(netlist, &request("VIN", "out"));
        assert!(err.contains(&format!("{device}'s model overflows")), "{err}");
    }
}

/// Extreme but representable models still solve, with finite results.
#[test]
fn extreme_models_that_stay_finite_still_solve() {
    let cases = [
        "d\nVIN in 0 DC 0.7 AC 1\nR1 in out 1k\nD1 out 0 dm\n.model dm D (IS=1 N=0.01)\n",
        "d\nVIN in 0 DC 10 AC 1\nR1 in out 1\nD1 out 0 dm\n.model dm D (IS=1e-14 N=1)\n",
        "m\nVDD vdd 0 5\nVIN g 0 DC 1 AC 1\nRD vdd out 1k\nM1 out g 0 0 nm W=1u L=1u\n.model nm NMOS (LEVEL=1 KP=10 VTO=-100 LAMBDA=10)\n",
    ];
    for netlist in cases {
        let out = run(netlist, &request("VIN", "out"));
        let (re, im) = value(&out, "gain", 0);
        assert!(re.is_finite() && im.is_finite(), "{netlist}: {re} {im}");
    }
}

/// Two ideal sources in parallel is still a wiring fault.
#[test]
fn a_source_loop_is_still_singular() {
    let err = run_err(
        "loop\nV1 a 0 1\nV2 a 0 2\nR1 a 0 1k\nVIN in 0 AC 1\nR2 in out 1k\nR3 out 0 1k\n",
        &request("VIN", "out"),
    );
    assert!(err.contains("singular"), "{err}");
}

/// TOX gives C_ox, not the Meyer gate capacitances ngspice adds: say so.
#[test]
fn tox_warns_that_gate_capacitances_are_not_modeled() {
    let with_tox = CS.replace("lambda=0.1)", "lambda=0.1 tox=20n)");
    let out = run(&with_tox, &request("VIN", "out"));
    let warnings = out["warnings"].to_string();
    assert!(
        warnings.contains("Model nm has no gate capacitances from TOX"),
        "{warnings}"
    );
    let plain = run(CS, &request("VIN", "out"));
    assert!(!plain["warnings"].to_string().contains("TOX"));
}
