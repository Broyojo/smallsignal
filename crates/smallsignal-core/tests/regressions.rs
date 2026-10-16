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

#[test]
fn reverse_biased_bulk_junctions_stay_out_of_textbook_results() {
    let net = "cs\nVDD vdd 0 1.8\nVIN in 0 DC 0.7 AC 1\nRD vdd out 10k\nM1 out in 0 0 nm W=10u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1)\n";
    let r = run(net, &req(json!({ "input": "VIN", "output": "out" })));
    assert_eq!(
        r["gain"]["exact"]["latex"],
        "-g_{m1} \\left(r_{o1} \\parallel R_{D}\\right)"
    );
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
        r["warnings"].to_string().contains("no signal reaches vdd from VIN"),
        "{}",
        r["warnings"]
    );
}

#[test]
fn a_bare_parallel_group_has_no_parentheses() {
    let net = "cs\nVDD vdd 0 1.8\nVIN in 0 DC 0.7 AC 1\nRD vdd out 10k\nM1 out in 0 0 nm W=10u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1)\n";
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
