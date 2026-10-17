//! One test per bug found by fuzzing (this crate's tests and the ngspice
//! wild-mode fuzz in oracle/regressions). Expected values are from ngspice
//! unless noted.

mod common;

use common::{close, run, value};
use serde_json::{json, Value};
use smallsignal_core::{analyze, dc, netlist, Request};

const NGSPICE_OPTIONS: &str = ".options reltol=1e-9 abstol=1e-15 vntol=1e-12 gmin=1e-15\n";

fn req(v: Value) -> Request {
    serde_json::from_value(v).unwrap()
}

/// Inserts the oracle's ngspice options after the title line.
fn with_options(net: &str) -> String {
    let (title, body) = net.split_once('\n').unwrap();
    format!("{title}\n{NGSPICE_OPTIONS}{body}")
}

fn all_finite(v: &Value, q: &str) -> bool {
    v[q]["values"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["re"].as_f64().is_some_and(f64::is_finite) && p["im"].as_f64().is_some_and(f64::is_finite))
}

#[test]
fn a_line_of_only_separators_does_not_panic() {
    // Tokenized to nothing; used to index an empty token list.
    for line in ["(", ")", ",", "( , )"] {
        let net = format!("t\nVIN in 0 1\n{line}\nR1 in 0 1k\n");
        let r = run(&net, &req(json!({ "input": "VIN", "output": "in" })));
        assert_eq!(r["op"]["nodes"]["in"], 1.0);
    }
}

#[test]
fn overflowing_values_are_rejected() {
    let e = analyze(
        "t\nVIN in 0 1\nR1 in 0 1e400\n",
        &req(json!({ "input": "VIN", "output": "in" })),
    )
    .unwrap_err();
    assert!(e.contains("bad value"), "{e}");
}

/// VIN, an inductor (DC short) and a CCVS form a loop of voltage-type
/// elements, so DC is singular. Whether LU saw an exactly zero pivot used to
/// depend on the line order; otherwise it returned a garbage point.
#[test]
fn singular_dc_is_detected_in_every_line_order() {
    let lines = [
        "RT1 n1 0 4.021183e1",
        "RT2 n2 0 1.616334e3",
        "RT3 n3 n2 4.678541e1",
        "L1 n1 n2 7.823205e-4",
        "VS2 n3 s2 0",
        "RS2 s2 n1 1.213757e4",
        "H2 0 n2 VS2 3.810494e1",
        "VIN n1 0 AC 1",
    ];
    let mut order: Vec<usize> = (0..lines.len()).collect();
    let mut rng = common::Rng::new(5);
    for _ in 0..50 {
        for i in (1..order.len()).rev() {
            let j = rng.below(i + 1);
            order.swap(i, j);
        }
        let net = format!(
            "t\n{}\n",
            order.iter().map(|&i| lines[i]).collect::<Vec<_>>().join("\n")
        );
        let e = analyze(&net, &req(json!({ "input": "VIN", "output": "n3" }))).unwrap_err();
        assert!(e.contains("singular"), "{e}\n{net}");
    }
}

/// M1 barely on (Vov = 55 mV): plain Newton cycled between the two
/// transistors' regions. ngspice: v(x) = 0.4409050, v(out) = 2.831713.
#[test]
fn cascode_with_a_barely_on_input_device_converges() {
    let net = "t\nVDD vdd 0 3.35467728933797460\nVIN in 0 DC 0.555297325243247153 AC 1\nVB vb 0 1.05529732524324715\n\
               M1 x in 0 0 mn W=10u L=1u\nM2 out vb x 0 mn W=10u L=1u\nRD vdd out 8.765930e4\n\
               .model mn nmos (kp=3.732565e-4 vto=0.5 lambda=0.1030 gamma=0.2595)\n";
    let r = run(net, &req(json!({ "input": "VIN", "output": "out" })));
    assert!((r["op"]["nodes"]["x"].as_f64().unwrap() - 0.4409050).abs() < 1e-6);
    assert!((r["op"]["nodes"]["out"].as_f64().unwrap() - 2.831713).abs() < 1e-6);
}

/// Sub-µA tail into MΩ loads: the first iterate put the tail at −160 kV
/// (held only by femtoamp leakage). ngspice: tail 1.366641, o2 10.77640.
#[test]
fn diff_pair_with_a_tiny_tail_current_converges() {
    let net = "t\nVDD vdd 0 11.754351665998463\nVIP inp 0 2.04699798097525\nVIN inn 0 2.1222873729320684\nIT tail 0 3.210e-7\n\
               M1 o1 inp tail 0 mn W=2.228e-5 L=2.101e-7\nM2 o2 inn tail 0 mn W=2.228e-5 L=2.101e-7\n\
               R1 vdd o1 3046435.7874365067\nR2 vdd o2 3046435.7874365067\n\
               .model mn nmos (kp=200u vto=0.5 lambda=0.05 gamma=0.4)\n";
    let op = dc::operating_point(&netlist::parse(net).unwrap()).unwrap();
    let n = netlist::parse(net).unwrap();
    assert!((op.v[n.node("tail").unwrap()] - 1.366641).abs() < 1e-6);
    assert!((op.v[n.node("o2").unwrap()] - 10.77640).abs() < 1e-5);
}

/// A drain–bulk junction forward biased by the bias point: its conductance
/// was missing from the small-signal model (Rout 2724 Ω instead of 33.6 Ω).
#[test]
fn forward_biased_bulk_junction_is_in_the_small_signal_model() {
    let net = with_options(
        "random wild mos circuit\nV1 vdd 0 DC 2.72\nV2 in 0 DC 0.414 AC 1\nR1 n2 vdd 2724\nM5 0 n2 n2 n2 nch W=4.595u L=5u\n\
         .model nch NMOS (LEVEL=1 KP=0.0003131 VTO=0.747 LAMBDA=0.006308 GAMMA=0 PHI=0.7)\n",
    );
    let r = run(
        &net,
        &req(json!({ "input": "V2", "output": "n2", "rout": true, "freqs": [117.235] })),
    );
    assert!(
        close(value(&r, "rout", 0), (33.58529565534185, 0.0), 1e-9),
        "{}",
        r["rout"]["values"]
    );
    assert!(r["params"].to_string().contains("rbd_M5"));
}

/// Junction leakage is in the exact model wherever it moves a result by more
/// than 1e-9 (proved on the full numeric system), never by a size heuristic:
/// with the default gmin (1e-12 S) a CS stage's drain junction next to a
/// 10 kΩ load moves the gain by ~1e-8, so it shows; the simplified form
/// prunes it; with negligible leakage the exact form is the textbook one.
#[test]
fn junction_leakage_appears_exactly_when_it_matters() {
    let net = "cs\nVDD vdd 0 1.8\nVIN in 0 DC 0.7 AC 1\nRD vdd out 10k\nM1 out in 0 0 nm W=10u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1)\n";
    let r = run(net, &req(json!({ "input": "VIN", "output": "out" })));
    assert_eq!(
        r["gain"]["exact"]["latex"],
        "-g_{m1} \\left(r_{o1} \\parallel r_{bd1} \\parallel R_{D}\\right)"
    );
    assert!(!r["gain"]["simplified"]["latex"].as_str().unwrap().contains("r_{bd1}"));
    assert!(!r["omittedJunctions"].to_string().contains("rbd_M1"));
    let tiny = net.replace("cs\n", "cs\n.options gmin=1e-18\n");
    let r = run(&tiny, &req(json!({ "input": "VIN", "output": "out" })));
    assert_eq!(
        r["gain"]["exact"]["latex"],
        "-g_{m1} \\left(r_{o1} \\parallel R_{D}\\right)"
    );
    assert!(r["omittedJunctions"].to_string().contains("rbd_M1"));
    assert!(r["omissionError"].as_f64().unwrap() <= 1e-9);
}

/// The island vdd–n2 hangs only on M1's drain junction (M1 off), inside an
/// H/V-sense loop: DC did not converge, then the island floated. Kirchhoff
/// forces vbd = 0 there, so vds ≈ 0 (ngspice: −2.2e−7, its own noise).
#[test]
fn leakage_held_island_converges_and_stays_connected() {
    let net = with_options(
        "random wild mos circuit\nV2 in 0 DC 0.893 AC 1\nR1 n3 m1 5286\nR2 n2 vdd 639.8\nM1 vdd in n1 n1 pch W=11.97u L=0.5u\n\
         V3 m1 in DC 0\nH1 n3 n1 V3 10.54\n\
         .model pch PMOS (LEVEL=1 KP=0.0003912 VTO=-0.4293 LAMBDA=0.02821 GAMMA=0.7669 PHI=0.7)\n",
    );
    let r = run(
        &net,
        &req(json!({ "input": "V2", "output": "n2", "rout": true, "rin": true })),
    );
    let vds = r["op"]["devices"]["M1"]["vds"].as_f64().unwrap();
    assert!(vds.abs() < 1e-6, "{vds}");
    // ngspice: 2.57984e12 Ω (its vbd noise moves gbd by ~1e-5).
    let z = value(&r, "rout", 0).0;
    assert!((z / 2.57984e12 - 1.0).abs() < 1e-4, "{z}");
    // No DC path returns current from the input to ground: truly infinite.
    assert_eq!(r["rin"]["infinite"], true);
}

#[test]
fn ngspice_converged_mos_and_mixed_circuits_converge() {
    let mos2 = with_options(
        "random wild mos circuit\nV1 vdd 0 DC 2.59\nV2 in 0 DC 0.631 AC 1\nR1 n8 vdd 3021\nR2 n5 vdd 431.5\nR3 n2 m2 7.744e+05\n\
         R4 n6 n2 1.591e+05\nR6 n1 m1 2214\nM5 n4 n6 0 0 nch W=6.044u L=0.5u\nL1 n1 n4 3.605e-09\nV3 m1 n5 DC 0\n\
         F1 0 n6 V3 -0.1733\nV4 m2 n5 DC 0\n\
         .model nch NMOS (LEVEL=1 KP=9.003e-05 VTO=0.7207 LAMBDA=0.08072 GAMMA=0 PHI=0.7)\n",
    );
    let r = run(
        &mos2,
        &req(json!({ "input": "V2", "output": "n8", "rout": true, "freqs": [2726.53] })),
    );
    assert!(close(value(&r, "rout", 0), (3021.0, 0.0), 1e-9));
    let mixed = with_options(
        "random wild mixed circuit\nV2 in 0 DC 8.224 AC 1\nR1 n1 0 4.923e+04\nR4 n5 0 1.932e+04\nR6 n6 n3 3.409e+04\n\
         M1 n2 in n6 n6 nch W=16.26u L=1u\nQ1 n2 in in qn\nQ3 n1 n2 n8 qn\nG1 n5 n3 n8 n6 -0.0007241\n\
         .model nch NMOS (LEVEL=1 KP=5.94e-05 VTO=0.4078 LAMBDA=0.08432 GAMMA=0 PHI=0.7)\n\
         .model qn NPN (IS=1.509e-16 BF=38.02 VAF=22.47)\n",
    );
    let r = run(
        &mixed,
        &req(json!({ "input": "V2", "output": "n6", "rout": true, "freqs": [107.051] })),
    );
    assert!(
        close(value(&r, "rout", 0), (51145.15553712157, 0.0), 1e-8),
        "{}",
        r["rout"]["values"]
    );
}

/// Cutoff BJTs at gmin = 1e-15: rπ ≈ 1e15 Ω, ro ≈ 1e21 Ω; expanded products
/// overflowed f64 and came back NaN. Exact value by 60-digit evaluation of
/// the same rational function: 219169503597515 Ω (ngspice: 2.191687e14,
/// 3e-6 off at this conditioning).
#[test]
fn gmin_level_impedances_do_not_overflow() {
    let net = with_options(
        "random wild bjt circuit\nV1 vdd 0 DC 6.2\nV2 in 0 DC 5.76 AC 1\nR1 n6 vdd 1.152e+04\nR2 n1 0 772.8\nR3 n2 n6 1.407e+04\n\
         R5 n7 in 1.098e+04\nR6 n4 n2 3307\nQ1 vdd in n7 qn\nQ2 n4 0 n1 qn\nQ3 n6 0 in qn\nQ4 in n3 n4 qn\n\
         .model qn NPN (IS=1.894e-14 BF=268.8 VAF=41.1)\n",
    );
    let r = run(
        &net,
        &req(
            json!({ "input": "V2", "output": "n7", "rin": true, "rout": true, "verify": true, "freqs": [300664.0, 6.11563e7] }),
        ),
    );
    for q in ["gain", "rin", "rout"] {
        assert!(all_finite(&r, q), "{q}: {}", r[q]["values"]);
        assert_eq!(r[q]["check"]["ok"], true, "{q}");
    }
    assert!(
        close(value(&r, "rin", 0), (219169503597515.0, 0.0), 1e-9),
        "{}",
        r["rin"]["values"]
    );
    assert_eq!(r["verify"]["kcl"], true);
}

#[test]
fn extreme_bjt_circuits_report_finite_values_and_honest_checks() {
    // wildbjt_101_021: Rin was null at one frequency while the check said ok.
    let a = with_options(
        "random wild bjt circuit\nV1 vdd 0 DC 5.9\nV2 in 0 DC 2.673 AC 1\nR1 n7 vdd 6.953e+05\nR2 n4 n7 3649\nR3 n2 m2 1.151e+04\n\
         R4 n1 m1 4.472e+05\nR5 n8 n2 3.916e+05\nR6 n5 in 1.561e+04\nR7 n3 n2 6.067e+05\nR8 n6 0 4.515e+05\nQ1 n2 n4 in qn\n\
         Q2 n2 n4 n5 qp\nQ3 n5 n6 n2 qp\nQ4 n5 0 n6 qp\nQ5 n1 n3 n8 qn\nC1 n1 n2 2.029e-15\nV3 m1 vdd DC 0\nC2 n8 n4 1.001e-13\n\
         V4 m2 n7 DC 0\nF1 n4 n6 V4 0.8269\nC3 n4 0 9.451e-12\n\
         .model qn NPN (IS=1.752e-17 BF=277.1 VAF=20.8)\n.model qp PNP (IS=1.752e-17 BF=277.1 VAF=20.8)\n",
    );
    // wildbjt_103_005: values matched ngspice, but a 330 A branch current
    // made the cross-check's LU bound fail.
    let b = with_options(
        "random wild bjt circuit\nV1 vdd 0 DC 6.8\nV2 in 0 DC 0.941 AC 1\nR1 n3 vdd 5417\nR2 n5 in 319.1\nR3 n2 n3 4087\nR4 n6 n3 1257\n\
         R5 n4 n2 6.45e+04\nR6 n1 n5 385.1\nQ1 n1 in 0 qn\nQ2 n5 0 n2 qn\nQ3 n3 n4 0 qn\nQ4 n2 n3 0 qn\nQ5 n2 n4 in qn\n\
         E1 in n6 vdd n1 6.117\nL1 n3 n5 1.69e-09\nC1 n2 n3 3.473e-11\nC2 n5 n4 2.233e-11\nG1 n4 in 0 n5 1.223e-06\n\
         .model qn NPN (IS=2.684e-15 BF=251 VAF=184.2)\n",
    );
    for (net, out, freqs) in [
        (&a, "n5", [1976370.0, 21368500.0, 520392000.0]),
        (&b, "n3", [97.3586, 204.193, 110507000.0]),
    ] {
        let r = run(
            net,
            &req(json!({ "input": "V2", "output": out, "rin": true, "rout": true, "freqs": freqs })),
        );
        for q in ["gain", "rin", "rout"] {
            assert!(all_finite(&r, q), "{q}: {}", r[q]["values"]);
            assert_eq!(r[q]["check"]["ok"], true, "{q}: {}", r[q]["check"]);
        }
    }
}

#[test]
fn reverse_active_bjt_is_labelled() {
    let net = "t\nVCC vcc 0 DC 5\nVIN in 0 DC 0.75 AC 1\nQ1 n1 in vcc qn\nRC n1 0 10k\n.model qn NPN (IS=1e-15 BF=100 VAF=50)\n";
    let r = run(net, &req(json!({ "input": "VIN", "output": "n1" })));
    assert_eq!(r["op"]["devices"]["Q1"]["region"], "reverse-active");
}

#[test]
fn zero_gain_is_explained() {
    let net = "cs\nVDD vdd 0 1.8\nVIN in 0 DC 0.7 AC 1\nRD vdd out 10k\nM1 out in 0 0 nm W=10u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1)\n";
    let r = run(net, &req(json!({ "input": "VIN", "output": "vdd" })));
    assert!(
        r["warnings"].to_string().contains("No signal reaches vdd"),
        "{}",
        r["warnings"]
    );
}

#[test]
fn a_bare_parallel_group_has_no_parentheses() {
    let net = "cs\n.options gmin=1e-18\nVDD vdd 0 1.8\nVIN in 0 DC 0.7 AC 1\nRD vdd out 10k\nM1 out in 0 0 nm W=10u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1)\n";
    let r = run(net, &req(json!({ "input": "VIN", "output": "out", "rout": true })));
    assert_eq!(r["rout"]["exact"]["latex"], "r_{o1} \\parallel R_{D}");
    assert_eq!(
        r["gain"]["exact"]["latex"],
        "-g_{m1} \\left(r_{o1} \\parallel R_{D}\\right)"
    );
}

#[test]
fn tex_specials_in_names_are_escaped() {
    let net = "t\nVIN in 0 AC 1\nR{x}\\a in out 1k\nR^2 out 0 1k\n";
    let r = run(net, &req(json!({ "input": "VIN", "output": "out" })));
    let tex = r["gain"]["exact"]["latex"].as_str().unwrap();
    assert!(
        tex.contains("R_{\\{x\\}\\backslash a}") && tex.contains("R_{\\hat{}2}"),
        "{tex}"
    );
}

#[test]
fn huge_netlists_fail_fast() {
    let mut net = String::from("ladder\nVIN n0 0 1\n");
    for i in 0..5000 {
        net.push_str(&format!("R{i}a n{i} n{} 1k\nR{i}b n{} 0 1k\n", i + 1, i + 1));
    }
    let t = std::time::Instant::now();
    let e = analyze(&net, &req(json!({ "input": "VIN", "output": "n3" }))).unwrap_err();
    assert!(e.contains("too large"), "{e}");
    assert!(t.elapsed().as_secs_f64() < if cfg!(debug_assertions) { 10.0 } else { 1.0 });
}

/// Log-space evaluation used to rebuild values as magnitude∠angle, so a
/// negative real gain came back with im ≈ 5e-16 (shown as "4.19 ∠ 180°").
#[test]
fn resistive_quantities_are_exactly_real() {
    let net = "cs\nV1 g 0 DC 0.7 AC 1\nR1 VDD Vout 10k\nM1 Vout g 0 0 nm W=10u L=1u\nVSUP_VDD VDD 0 DC 1.8\n\
               .model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05)\n";
    let r = run(
        net,
        &req(json!({ "input": "V1", "output": "Vout", "rout": true, "rin": true, "freqs": [0, 1e3, 1e9] })),
    );
    for q in ["gain", "rout"] {
        for p in r[q]["values"].as_array().unwrap() {
            assert_eq!(p["im"].as_f64(), Some(0.0), "{q}: {p}");
        }
    }
    assert!(value(&r, "gain", 1).0 < 0.0);
    assert_eq!(r["gain"]["values"][1]["phaseDeg"].as_f64(), Some(180.0));
}

/// At s = jω the powers of s must be exact (±1, ±j): a capacitive circuit's
/// values keep their exact real/imaginary structure, and nothing tiny flips
/// a phase.
#[test]
fn powers_of_j_are_exact() {
    // An inductor: Z = jωL is exactly imaginary.
    let r = run(
        "t\nIIN 0 out AC 1\nL1 out 0 1u\n",
        &req(json!({ "input": "IIN", "output": "out", "freqs": [1e3, 1e6] })),
    );
    for p in r["gain"]["values"].as_array().unwrap() {
        assert_eq!(p["re"].as_f64(), Some(0.0), "{p}");
        assert!(p["im"].as_f64().unwrap() > 0.0);
    }
    // An RC divider: |im|/|z| is either 0 or well above rounding.
    let r = run(
        "t\nVIN in 0 AC 1\nR1 in out 1k\nC1 out 0 1n\n",
        &req(json!({ "input": "VIN", "output": "out", "freqs": [0, 1, 1e3] })),
    );
    for p in r["gain"]["values"].as_array().unwrap() {
        let (re, im) = (p["re"].as_f64().unwrap(), p["im"].as_f64().unwrap());
        assert!(im == 0.0 || im.abs() / re.hypot(im) > 1e-15, "{p}");
    }
    assert_eq!(r["gain"]["values"][0]["im"].as_f64(), Some(0.0));
}

fn candidate_pairs(r: &Value) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = r["matchCandidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let e = c["elements"].as_array().unwrap();
            let (a, b) = (e[0].as_str().unwrap().to_string(), e[1].as_str().unwrap().to_string());
            if a < b {
                (a, b)
            } else {
                (b, a)
            }
        })
        .collect();
    v.sort();
    v
}

fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = list.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
    v.sort();
    v
}

/// The editor's current-mirror-loaded diff pair (no values: symbolic). The
/// tail M5 has the same default size as M3/M4 and used to be proposed with
/// both, chaining M3, M4 and M5 into one symbol.
const MIRROR_PAIR: &str = "* Main (small-signal netlist from Analog Canvas)\n\
    M1 Vout net1 VDD VDD pmos_l1 W=1u L=1u\nM2 net1 net1 VDD VDD pmos_l1 W=1u L=1u\n\
    M3 net1 Vin1 net0 0 nmos_l1 W=1u L=1u\nM4 Vout Vin2 net0 0 nmos_l1 W=1u L=1u\nM5 net0 Vb 0 0 nmos_l1 W=1u L=1u\n\
    VPIN_Vin1 Vin1 0 DC 0\nVPIN_Vin2 Vin2 0 DC 0\nVPIN_Vb Vb 0 DC 0\nVSUP_VDD VDD 0 DC 1.8\n\
    .model pmos_l1 PMOS (LEVEL=1 KP=100u VTO=-0.5 LAMBDA=0.05)\n.model nmos_l1 NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.05)\n";

#[test]
fn match_candidates_are_topologically_paired() {
    let base =
        json!({ "input": "VPIN_Vin1", "inputNeg": "VPIN_Vin2", "output": "Vout", "symbolic": true, "rout": true });
    let r = run(MIRROR_PAIR, &req(base.clone()));
    // M1/M2 share their gate (mirror), M3/M4 their source (diff pair); the
    // tail M5 shares neither with anything.
    assert_eq!(candidate_pairs(&r), pairs(&[("M1", "M2"), ("M3", "M4")]));
    let mut with = base.clone();
    with["match"] = json!([["M1", "M2"], ["M3", "M4"]]);
    let r = run(MIRROR_PAIR, &req(with));
    assert!(!r["warnings"].to_string().contains("match:"), "{}", r["warnings"]);
    assert_eq!(
        r["gain"]["simplified"]["latex"],
        "g_{m3,4} \\left(r_{o1,2} \\parallel r_{o3,4}\\right)"
    );
    assert_eq!(r["rout"]["simplified"]["latex"], "r_{o1,2} \\parallel r_{o3,4}");
}

/// Symbolic mode has no values to compare: a requested group merges the
/// parameter kinds its members share (M5 has no g_mb: body tied to source),
/// without warning.
#[test]
fn symbolic_groups_merge_their_shared_kinds_silently() {
    let r = run(
        MIRROR_PAIR,
        &req(
            json!({ "input": "VPIN_Vin1", "inputNeg": "VPIN_Vin2", "output": "Vout", "symbolic": true, "match": [["M3", "M4", "M5"]] }),
        ),
    );
    assert!(!r["warnings"].to_string().contains("match:"), "{}", r["warnings"]);
    let p = r["params"].to_string();
    assert!(p.contains("g_{m3,4,5}") && p.contains("r_{o3,4,5}"), "{p}");
    assert!(p.contains("g_{mb3,4}"), "g_mb merges only where it exists: {p}");
}

/// The editor's 5T OTA (numeric): the pair and the mirror, not the bias
/// devices (M5/M6 share gate and source, but their sizes differ).
#[test]
fn ota_candidates_are_the_pair_and_the_mirror() {
    let net = "* Testbench (small-signal netlist from Analog Canvas)\nCL vout 0 1p\nIBIAS vdd ibias DC 15u\nVDD vdd 0 DC 1.8\n\
        VINN vinn 0 DC 0.9\nVINP vinp 0 DC 0.9 AC 1\nM1 nleft_DUT vinp tail_DUT 0 nmos_l1 W=96u L=1u\n\
        M2 vout vinn tail_DUT 0 nmos_l1 W=96u L=1u\nM3 nleft_DUT nleft_DUT vdd vdd pmos_l1 W=64u L=1u\n\
        M4 vout nleft_DUT vdd vdd pmos_l1 W=64u L=1u\nM5 tail_DUT ibias 0 0 nmos_l1 W=100u L=3u\n\
        M6 ibias ibias 0 0 nmos_l1 W=60u L=3u\n\
        .model nmos_l1 NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.05)\n.model pmos_l1 PMOS (LEVEL=1 KP=100u VTO=-0.5 LAMBDA=0.05)\n";
    let r = run(
        net,
        &req(json!({ "input": "VINP", "inputNeg": "VINN", "output": "vout" })),
    );
    assert_eq!(candidate_pairs(&r), pairs(&[("M1", "M2"), ("M3", "M4")]));
    let r = run(
        net,
        &req(json!({ "input": "VINP", "inputNeg": "VINN", "output": "vout", "match": [["M1", "M2"], ["M3", "M4"]] })),
    );
    assert_eq!(r["gain"]["check"]["ok"], true);
    assert!(!r["warnings"].to_string().contains("not matched"));
}

#[test]
fn candidates_never_chain_and_passives_need_symmetry() {
    // Ma–Mb share a gate, Mb–Mc a source, but Ma–Mc share neither: at most
    // one of the two pairs, never a three-device group.
    let chain = "t\nVDD vdd 0 1.8\nVG g1 0 1\nVG3 g3 0 1\nRA vdd d1 10k\nRB vdd d2 10k\nRC vdd d3 10k\n\
                 Ma d1 g1 s1 0 nm W=1u L=1u\nMb d2 g1 s2 0 nm W=1u L=1u\nMc d3 g3 s2 0 nm W=1u L=1u\n\
                 RS1 s1 0 1k\nRS2 s2 0 500\n.model nm nmos (kp=200u vto=0.5 lambda=0.05)\n";
    let r = run(chain, &req(json!({ "input": "VG", "output": "d1", "symbolic": true })));
    let c = candidate_pairs(&r);
    let devices: Vec<_> = c.iter().filter(|(a, _)| a.starts_with('M')).collect();
    assert!(devices.len() <= 1, "{c:?}");
    // Passives: RD1/RD2 from one supply node to two outputs pair; equal
    // resistors that share nothing, or both terminals, do not.
    let passives = "t\nVIN in 0 1\nVDD vdd 0 1\nRD1 vdd o1 5k\nRD2 vdd o2 5k\nRA in a 5k\nRB b o1 5k\nRP1 o2 0 7k\nRP2 o2 0 7k\nRZ a b 1k\n";
    let r = run(passives, &req(json!({ "input": "VIN", "output": "o1" })));
    assert_eq!(candidate_pairs(&r), pairs(&[("RD1", "RD2")]));
}

// ---- Round 4: gate-fuzz root causes (oracle/regressions, ngspice values) ----

/// Reverse-mode PMOS at vdd = 2.85 V: limiting recomposed vgs − (vgs − vds),
/// 1 ulp off, so every iteration counted as limited and DC never converged.
#[test]
fn reverse_mode_limiting_converges() {
    let net = with_options(
        "random wild mos circuit\nV1 vdd 0 DC 2.85\nV2 in 0 DC 0.236 AC 1\nR1 n1 vdd 3.983e+05\nR2 n2 in 828.1\n\
         M6 vdd in 0 vdd pch W=62.12u L=1u\n\
         .model pch PMOS (LEVEL=1 KP=0.0004965 VTO=-0.7163 LAMBDA=0.08075 GAMMA=0.459 PHI=0.7)\n",
    );
    let r = run(
        &net,
        &req(json!({ "input": "V2", "output": "n2", "ref": "n1", "rout": true, "freqs": [69235.8] })),
    );
    assert!(close(value(&r, "gain", 0), (1.0, 0.0), 1e-12));
    assert!(close(value(&r, "rout", 0), (399128.1, 0.0), 1e-9));
    assert_eq!(r["op"]["devices"]["M6"]["reversed"], true);
}

/// A junction on the input source's node (both of its ends "stiff" by the
/// old rule) carries the signal: gain 0 and Rin ∞ without it.
#[test]
fn junction_on_the_input_node_is_kept() {
    let net = with_options(
        "random wild mos circuit\nV1 vdd 0 DC 1.57\nV2 in 0 DC 1.11 AC 1\nR1 n3 vdd 2.198e+04\nM2 in n3 n3 n3 nch W=8.76u L=1u\n\
         V3 m1 n3 DC 0\n.model nch NMOS (LEVEL=1 KP=3.421e-05 VTO=0.6166 LAMBDA=0.0818 GAMMA=0 PHI=0.7)\n",
    );
    let r = run(
        &net,
        &req(json!({ "input": "V2", "output": "n3", "rin": true, "rout": true, "freqs": [8747.4] })),
    );
    assert!(
        close(value(&r, "gain", 0), (0.2453113746359534, 0.0), 1e-9),
        "{}",
        r["gain"]["values"]
    );
    assert!(close(value(&r, "rin", 0), (89600.4110393118, 0.0), 1e-9));
    assert!(close(value(&r, "rout", 0), (16588.05598550174, 0.0), 1e-9));
}

/// gμ on the signal path: without it (the old gμ > 1e-6·gπ rule) the gain
/// was exactly 0; ngspice gives 2.27e-9.
#[test]
fn bjt_gmu_is_kept_when_it_matters() {
    let net = with_options(
        "random wild mixed circuit\nV1 vdd 0 DC 6.5\nV2 in 0 DC 0.544 AC 1\nR4 n4 0 132.5\nR5 n1 n4 464.8\n\
         M1 n2 n2 vdd vdd nch W=2.685u L=1u\nQ2 n1 n2 n5 qn\nQ3 in n4 0 qn\n\
         .model nch NMOS (LEVEL=1 KP=7.323e-05 VTO=0.2004 LAMBDA=0.2636 GAMMA=0 PHI=0.7)\n\
         .model qn NPN (IS=6.375e-14 BF=281.2 VAF=169.9)\n",
    );
    let r = run(
        &net,
        &req(json!({ "input": "V2", "output": "n5", "rin": true, "rout": true, "freqs": [36.5047] })),
    );
    assert!(
        close(value(&r, "gain", 0), (2.266626197137731e-09, 0.0), 1e-6),
        "{}",
        r["gain"]["values"]
    );
    assert!(close(value(&r, "rin", 0), (177.01132851088292, 0.0), 1e-9));
    for q in ["gain", "rin", "rout"] {
        assert_eq!(r[q]["check"]["ok"], true, "{q}");
    }
}

/// Weak-bias junctions under the old 1e-6 node-relative threshold still
/// moved Rin by 1.1e-6.
#[test]
fn weak_junctions_are_kept_when_they_matter() {
    let net = with_options(
        "random wild mixed circuit\nV1 vdd 0 DC 1.9\nV2 in 0 DC 0.238 AC 1\nR1 n5 vdd 2.98e+05\nR2 n2 in 1526\nR3 n6 0 308.1\n\
         R4 n1 n2 2.754e+04\nR5 n4 in 5238\nR6 n3 n5 3.222e+04\nM1 n6 n3 n4 n4 nch W=14.51u L=1u\nM2 n5 n5 n1 n1 pch W=0.7879u L=0.35u\n\
         .model nch NMOS (LEVEL=1 KP=2.045e-05 VTO=0.4992 LAMBDA=0.288 GAMMA=0 PHI=0.7)\n\
         .model pch PMOS (LEVEL=1 KP=2.045e-05 VTO=-0.4992 LAMBDA=0.288 GAMMA=0 PHI=0.7)\n",
    );
    let r = run(
        &net,
        &req(json!({ "input": "V2", "output": "n4", "rin": true, "rout": true, "freqs": [5136350.0] })),
    );
    assert!(
        close(value(&r, "rin", 0), (12308.027948906687, 0.0), 1e-9),
        "{}",
        r["rin"]["values"]
    );
    assert!(close(value(&r, "gain", 0), (0.5900878308262557, 0.0), 1e-9));
    assert!(close(value(&r, "rout", 0), (4010.32522462296, 0.0), 1e-9));
}

/// An omission is accepted only if the full system proves it moves nothing
/// by more than 1e-9, and the cross-check always solves the full system.
#[test]
fn omitted_junctions_are_proven_negligible() {
    let mut rng = common::Rng::new(41);
    for _ in 0..60 {
        let vin = 0.55 + rng.unit() * 0.5;
        let rd = rng.decade(1e3, 1e6);
        let net = format!(
            "cs\nVDD vdd 0 1.8\nVIN in 0 DC {vin} AC 1\nRD vdd out {rd:.6e}\nM1 out in s 0 nm W=10u L=1u\nRS s 0 1k\nCL out 0 1p\n\
             .model nm nmos (level=1 kp=200u vto=0.5 lambda=0.05 gamma=0.4)\n"
        );
        let r = run(
            &net,
            &req(json!({ "input": "VIN", "output": "out", "rin": true, "rout": true, "freqs": [0, 1e3, 1e9] })),
        );
        assert!(r["omissionError"].as_f64().unwrap() <= 1e-9);
        for q in ["gain", "rout"] {
            assert_eq!(r[q]["check"]["ok"], true, "{q}\n{net}");
        }
    }
}

#[test]
fn degenerate_junctions_are_named() {
    // DC that converges to an unphysical point is flagged, not silent.
    let r = run(
        "deg\nV1 a 0 1.5\nD1 a 0 dm\nVIN in 0 AC 1\nR1 in 0 1k\n.model dm d is=1e-14\n",
        &req(json!({ "input": "VIN", "output": "in" })),
    );
    let w = r["warnings"].to_string();
    assert!(w.contains("D1 diode junction is forced on by a source"), "{w}");
    // A BJT base-emitter junction across an ideal 2 V source.
    let r = analyze(
        "deg\nVB b 0 2\nVC c 0 5\nQ1 c b 0 qn\nVIN in 0 AC 1\nR1 in 0 1k\n.model qn npn is=1e-15 bf=100\n",
        &req(json!({ "input": "VIN", "output": "in" })),
    );
    let text = match r {
        Ok(v) => v["warnings"].to_string(),
        Err(e) => e,
    };
    assert!(
        text.contains("Q1 base-emitter junction is forced on by a source"),
        "{text}"
    );
}

#[test]
fn cross_coupled_pairs_warn_about_multiple_solutions() {
    let net = "latch\nVDD vdd 0 1.8\nVIN in 0 DC 0 AC 1\nRIN in 0 1k\nR1 vdd a 10k\nR2 vdd b 10k\n\
               M1 a b 0 0 nm W=10u L=1u\nM2 b a 0 0 nm W=10u L=1u\n.model nm nmos kp=200u vto=0.5\n";
    let r = run(net, &req(json!({ "input": "VIN", "output": "a" })));
    assert!(
        r["warnings"].to_string().contains("M1 and M2 are cross-coupled"),
        "{}",
        r["warnings"]
    );
    // A diff pair is not cross-coupled.
    let pair = "p\nVDD vdd 0 1.8\nVIP inp 0 DC 1 AC 1\nVINN inn 0 DC 1\nIT t 0 100u\nM1 o1 inp t 0 nm W=1u L=1u\nM2 o2 inn t 0 nm W=1u L=1u\n\
                R1 vdd o1 5k\nR2 vdd o2 5k\n.model nm nmos kp=200u vto=0.5\n";
    let r = run(pair, &req(json!({ "input": "VIP", "output": "o1" })));
    assert!(!r["warnings"].to_string().contains("cross-coupled"));
}

/// The display form drops junction leakage (r_bs, r_bd, r_μ → ∞) when that
/// moves no value by more than 1e-3, and says how much it does move them;
/// values stay those of the full model.
#[test]
fn display_form_neglects_junction_leakage() {
    let net = "cs\nVDD vdd 0 1.8\nVIN in 0 DC 0.7 AC 1\nRD vdd out 10k\nM1 out in 0 0 nm W=10u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1)\n";
    let r = run(
        net,
        &req(json!({ "input": "VIN", "output": "out", "rout": true, "freqs": [1e3] })),
    );
    let (g, d) = (&r["gain"], &r["gain"]["display"]);
    assert!(g["exact"]["latex"].as_str().unwrap().contains("r_{bd1}"));
    assert_eq!(d["latex"], "-g_{m1} \\left(r_{o1} \\parallel R_{D}\\right)");
    assert_eq!(d["same"], false);
    assert_eq!(d["leakageMatters"], false);
    assert!(d["maxRelError"].as_f64().unwrap() < 1e-6);
    assert_eq!(r["rout"]["display"]["latex"], "r_{o1} \\parallel R_{D}");
    assert!(!g["simplified"]["latex"].as_str().unwrap().contains("r_{bd"));
    // Values come from the model with the junction, not from the display.
    let m = &r["op"]["devices"]["M1"];
    let (gm, ro) = (m["gm"].as_f64().unwrap(), 1.0 / m["gds"].as_f64().unwrap());
    let textbook = -gm * ro * 1e4 / (ro + 1e4);
    let v = value(&r, "gain", 0).0;
    assert!(v != textbook && ((v - textbook) / textbook).abs() < 1e-6);
    // No leakage at all: display is exact.
    let r = run(
        "t\nVIN in 0 AC 1\nR1 in out 1k\nR2 out 0 1k\n",
        &req(json!({ "input": "VIN", "output": "out" })),
    );
    assert_eq!(r["gain"]["display"]["same"], true);
    assert_eq!(r["gain"]["display"]["latex"], r["gain"]["exact"]["latex"]);
}

#[test]
fn leakage_that_matters_stays_in_the_display_form() {
    let net = with_options(
        "random wild mos circuit\nV1 vdd 0 DC 2.72\nV2 in 0 DC 0.414 AC 1\nR1 n2 vdd 2724\nM5 0 n2 n2 n2 nch W=4.595u L=5u\n\
         .model nch NMOS (LEVEL=1 KP=0.0003131 VTO=0.747 LAMBDA=0.006308 GAMMA=0 PHI=0.7)\n",
    );
    let r = run(
        &net,
        &req(json!({ "input": "V2", "output": "n2", "rout": true, "freqs": [117.235] })),
    );
    let d = &r["rout"]["display"];
    assert_eq!(d["leakageMatters"], true);
    assert_eq!(d["same"], true);
    assert!(d["latex"].as_str().unwrap().contains("r_{bd5}"), "{d}");
    assert!(close(value(&r, "rout", 0), (33.58529565534185, 0.0), 1e-9));
}

/// The panel matches in one solve (matchAuto): a two-step solve showed the
/// unmatched expression first and then flipped. `unmatch` opts a pair out.
#[test]
fn match_auto_applies_candidates_in_one_solve() {
    let net = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../oracle/corpus/ota_5t_dm.cir"
    ))
    .unwrap();
    let side: Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../oracle/corpus/ota_5t_dm.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let base = json!({
        "input": side["input"], "inputNeg": side["inputNeg"], "mode": "differential",
        "output": side["output"], "matchAuto": true,
    });
    let r = analyze(&net, &req(base.clone())).unwrap();
    let applied: Vec<bool> = r["matchCandidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["applied"].as_bool().unwrap())
        .collect();
    assert_eq!(applied, vec![true, true]);
    let simplified = r["gain"]["simplified"]["latex"].as_str().unwrap();
    assert!(
        simplified.contains("g_{m1,2}") && simplified.contains("r_{o1,2} \\parallel r_{o3,4}"),
        "{simplified}"
    );

    let mut opt_out = base;
    opt_out["unmatch"] = json!([["M1", "M2"]]);
    let r = analyze(&net, &req(opt_out)).unwrap();
    let m12 = r["matchCandidates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["elements"] == json!(["M1", "M2"]))
        .unwrap();
    assert_eq!(m12["applied"], json!(false));
    let display = r["gain"]["display"]["latex"].as_str().unwrap();
    assert!(!display.contains("g_{m1,2}") && display.contains("g_{m1}"), "{display}");
}
