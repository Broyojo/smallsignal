//! Device capacitances: the values ngspice-47 gives at the operating point
//! (each reference below printed by ngspice-47 with the oracle's options),
//! their symbols, and what is left out.
#![allow(clippy::excessive_precision)] // ngspice prints 16 digits

mod common;

use common::{close, request, run, value};
use serde_json::{json, Value};
use smallsignal_core::Request;

const OPTIONS: &str = ".options gmin=1e-15\n";

fn param<'a>(out: &'a Value, name: &str) -> Option<&'a Value> {
    out["params"].as_array().unwrap().iter().find(|p| p["name"] == name)
}

fn at(input: &str, output: &str, freqs: &[f64]) -> Request {
    serde_json::from_value(json!({ "input": input, "output": output, "freqs": freqs })).unwrap()
}

fn rel(a: f64, b: f64) -> f64 {
    (a - b).abs() / a.abs().max(b.abs())
}

/// A CS stage with Meyer, overlap and junction capacitances: every value
/// as ngspice's @m1[cgs], [cgd], [cgb], [cbd] after `ac`, and the gain at
/// 100 MHz as its v(out).
#[test]
fn mos_capacitances_match_ngspice() {
    let net = format!(
        "cs caps\n{OPTIONS}VDD vdd 0 1.8\nVIN in 0 DC 0.7 AC 1\nRD vdd out 10k\n\
         M1 out in 0 0 nm W=10u L=1u AD=20p AS=20p PD=24u PS=24u\n\
         .model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1 tox=20n cgso=3e-10 cgdo=3e-10 cgbo=1e-10 \
         cj=5e-4 cjsw=3e-10 mj=0.4 mjsw=0.3 pb=0.85)\n"
    );
    let out = run(&net, &at("VIN", "out", &[1e8]));
    for (name, latex, want) in [
        ("cgs_M1", "C_{gs1}", 1.451047933230000e-14),
        ("cgd_M1", "C_{gd1}", 3.000000000000000e-15),
        ("cgb_M1", "C_{gb1}", 1.000000000000000e-16),
        ("cbd_M1", "C_{db1}", 1.225648946363190e-14),
    ] {
        let p = param(&out, name).unwrap_or_else(|| panic!("{name}"));
        assert_eq!(p["latex"], latex);
        assert_eq!(p["unit"], "F");
        assert!(rel(p["value"].as_f64().unwrap(), want) < 1e-12, "{name} {p}");
    }
    // Bulk and source are one node: no C_sb.
    assert!(param(&out, "cbs_M1").is_none());
    let caps = &out["op"]["devices"]["M1"]["caps"];
    assert!(rel(caps["cbs"].as_f64().unwrap(), 1.72e-14) < 1e-12, "{caps}");
    assert!(close(
        value(&out, "gain", 0),
        (-4.32548644014074e+00, 4.168152657629350e-01),
        1e-9
    ));
    assert_eq!(out["gain"]["check"]["ok"], true);
}

/// A CE stage with CJE, CJC (XCJC split), CJS, TF with XTF/VTF/ITF and
/// TR, a lateral PNP in cutoff and a diode with CJO/TT: ngspice's @q[cpi],
/// [cmu]+[cbx], [csub], −[cexbc] (the transcapacitance) and @d[cd], and
/// v(c) at 10 MHz.
#[test]
fn bjt_and_diode_capacitances_match_ngspice() {
    let net = format!(
        "ce caps\n{OPTIONS}VCC vcc 0 5\nVIN in 0 DC 0.75 AC 1\nRS in b 1k\nVB bb 0 0.75\nRB bb b 10k\n\
         RC vcc c 2k\nQ1 c b 0 npn1\nQ2 c2 b 0 pnp1\nRC2 c2 0 1k\nD1 c dd dmod\nRD dd 0 10k\n\
         .model npn1 npn (is=1e-16 bf=100 vaf=50 cje=1p vje=0.8 mje=0.4 tf=0.3n xtf=2 vtf=4 itf=0.01 \
         cjc=0.5p vjc=0.6 mjc=0.35 xcjc=0.7 cjs=0.8p mjs=0.3 vjs=0.7 tr=5n)\n\
         .model pnp1 pnp (is=1e-16 bf=50 vaf=30 cje=1p cjc=0.4p tf=0.1n cjs=0.5p mjs=0.2)\n\
         .model dmod d (is=1e-14 cjo=2p vj=0.7 m=0.4 tt=2n fc=0.4)\n"
    );
    let out = run(&net, &at("VIN", "c", &[1e7]));
    for (name, latex, want) in [
        ("cpi_Q1", "C_{\\pi 1}", 6.052011708093778e-12),
        ("cmu_Q1", "C_{\\mu 1}", 1.885712898556694e-13 + 8.081626708100115e-14),
        ("ccs_Q1", "C_{cs1}", 4.621755954409516e-13),
        ("cx_Q1", "C_{x1}", 2.05828168341995e-15),
        ("cpi_Q2", "C_{\\pi 2}", 7.960891960032572e-13),
        ("cmu_Q2", "C_{\\mu 2}", 3.184356784013624e-13),
        // Lateral (the PNP default): substrate to base.
        ("cbsub_Q2", "C_{bs2}", 4.354585382507812e-13),
        ("cj_D1", "C_{j1}", 2.672284385830627e-11),
    ] {
        let p = param(&out, name).unwrap_or_else(|| panic!("{name}"));
        assert_eq!(p["latex"], latex);
        assert!(rel(p["value"].as_f64().unwrap(), want) < 1e-9, "{name} {p}");
    }
    assert!(close(
        value(&out, "gain", 0),
        (-1.16805484075713e+01, 9.597123178125202e+00),
        1e-9
    ));
    assert_eq!(out["gain"]["check"]["ok"], true);
}

/// Model cards without charge parameters give no capacitances, so
/// existing circuits are unchanged; zero-valued ones are never stamped.
#[test]
fn no_charge_parameters_no_capacitances() {
    let net = format!(
        "cs\n{OPTIONS}VDD vdd 0 1.8\nVIN in 0 DC 0.7 AC 1\nRD vdd out 10k\nM1 out in 0 0 nm W=10u L=1u\n\
         .model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1 cgdo=0)\n"
    );
    let out = run(&net, &request("VIN", "out"));
    let names: Vec<&str> = out["params"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["RD", "gm_M1", "ro_M1"]);
    assert_eq!(out["gain"]["poleCount"], 0);
    assert!(!out["warnings"].to_string().contains("ignores"), "{}", out["warnings"]);
}

/// Symbolic mode (a value missing) has no operating point: the card's
/// capacitances of a saturated device appear as symbols, Meyer C_gd and
/// C_gb (zero in saturation) only through overlap, and the CS gain shows
/// the Miller zero at g_m/C_gd.
#[test]
fn symbolic_capacitances_from_the_card() {
    let net = "cs\nVDD vdd 0 1.8\nVIN in 0 DC 0.7 AC 1\nRD vdd out\nM1 out in 0 0 nm W=10u L=1u\n\
               .model nm nmos (level=1 kp=200u vto=0.5 tox=20n cgdo=1e-10)\n";
    let out = run(net, &request("VIN", "out"));
    assert_eq!(out["symbolic"], true);
    assert!(param(&out, "cgs_M1").is_some());
    assert!(param(&out, "cgd_M1").is_some());
    assert!(param(&out, "cgb_M1").is_none());
    let latex = out["gain"]["exact"]["latex"].as_str().unwrap();
    assert!(latex.contains("C_{gd1}") && !latex.contains("C_{gs1}"), "{latex}");
    assert_eq!(out["gain"]["zeroCount"], 1);
    assert_eq!(out["gain"]["poleCount"], 1);
}

/// A matched pair shares one symbol per capacitance: C_{gs1,2}.
#[test]
fn matched_pairs_share_capacitance_symbols() {
    let net = format!(
        "dp\n{OPTIONS}VDD vdd 0 1.8\nVP p 0 DC 0.9 AC 0.5\nVN n 0 DC 0.9 AC -0.5\nR1 vdd o1 10k\nR2 vdd o2 10k\n\
         M1 o1 p t 0 nm W=10u L=1u\nM2 o2 n t 0 nm W=10u L=1u\nIT t 0 100u\n\
         .model nm nmos (level=1 kp=200u vto=0.5 tox=20n cgdo=1e-10)\n"
    );
    let mut req: Value = json!({ "input": "VP", "inputNeg": "VN", "output": "o1", "ref": "o2",
        "freqs": [1e6], "match": [["M1", "M2"], ["R1", "R2"]] });
    req["mode"] = json!("differential");
    let out = run(&net, &serde_json::from_value(req).unwrap());
    let syms: Vec<&str> = out["params"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["latex"].as_str().unwrap())
        .collect();
    assert!(syms.contains(&"C_{gs1,2}") && syms.contains(&"C_{gd1,2}"), "{syms:?}");
}

/// Ignoring C_gd (the assumption term `cgd`) removes the Miller zero at
/// +g_m/C_gd: the full model's gain has that right-half-plane zero, the
/// assumed form none, and its fullModelError says how far the assumed form
/// is from the full model at the requested frequencies.
#[test]
fn ignoring_cgd_removes_the_rhp_zero() {
    let net = format!(
        "cs\n{OPTIONS}VDD vdd 0 1.8\nVIN in 0 DC 0.7 AC 1\nRS in g 1k\nRD vdd out 10k\nM1 out g 0 0 nm W=10u L=1u\n\
         .model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1 tox=20n cgso=3e-10 cgdo=3e-10)\n"
    );
    let freqs = [1e6, 1e9, 1e10];
    let full = run(&net, &at("VIN", "out", &freqs));
    let gm = full["op"]["devices"]["M1"]["gm"].as_f64().unwrap();
    let cgd = param(&full, "cgd_M1").unwrap()["value"].as_f64().unwrap();
    let zeros = full["gain"]["zeros"].as_array().unwrap();
    assert_eq!(zeros.len(), 1, "{zeros:?}");
    let z = zeros[0]["re"].as_f64().unwrap();
    assert!(rel(z, gm / cgd / (2.0 * std::f64::consts::PI)) < 1e-9, "{z}");

    let mut req = json!({ "input": "VIN", "output": "out", "freqs": freqs });
    req["assume"] = json!({ "ignore": [{ "element": "M1", "term": "cgd" }] });
    let out = run(&net, &serde_json::from_value(req).unwrap());
    let g = &out["gain"];
    // Values, poles and zeros stay the full model's; the assumed form's
    // roots pair with them under `assumed`, the RHP zero with none.
    let paired = g["assumed"]["zeros"].as_array().unwrap();
    assert_eq!(paired.len(), 1, "{g}");
    assert!(paired[0]["assumed"].is_null());
    assert!(rel(paired[0]["full"]["re"].as_f64().unwrap(), z) < 1e-12);
    assert!(!g["exact"]["latex"].as_str().unwrap().contains("C_{gd1}"));
    assert!(g["exact"]["latex"].as_str().unwrap().contains("C_{gs1}"));
    // Without C_gd the gain is −g_m(r_o ∥ R_D)/(1 + s·C_gs·R_S): close at
    // 1 MHz, far off by 10 GHz.
    let err = g["exact"]["fullModelError"].as_f64().unwrap();
    assert!(err > 0.1, "{err}");
    let assumptions = out["assumptions"].to_string();
    assert!(assumptions.contains("C_{gd1} = 0"), "{assumptions}");
}

/// Distortion vs frequency takes capacitances as linear: exact for overlap
/// (constant) ones, said in a warning for bias-dependent charges, which
/// ngspice's .disto expands.
#[test]
fn distortion_warns_about_nonlinear_charges() {
    let net = |card: &str| {
        format!(
            "cs\n{OPTIONS}VDD vdd 0 5\nVIN in 0 DC 0.9 AC 1\nRS in g 5k\nRD vdd out 5k\nM1 out g 0 0 nch W=10u L=1u\n\
             .model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1 {card})\n"
        )
    };
    let req: Request = serde_json::from_value(
        json!({ "input": "VIN", "output": "out", "freqs": [1e6], "nonlinear": ["M1"], "order": 3 }),
    )
    .unwrap();
    let warned = |card: &str| run(&net(card), &req)["warnings"].to_string().contains("as linear");
    assert!(!warned("CGSO=2e-9 CGDO=1e-9"));
    assert!(warned("TOX=10n CGDO=1e-9"));
    assert!(warned("CJ=1e-3"));
}
