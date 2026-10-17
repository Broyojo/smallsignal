//! The Miller approximation as an assumption (`assume.miller`): K from the
//! DC solve, the split model as two grounded capacitances, the full model's
//! numbers kept, refusals and errors.

mod common;

use common::{close, run, run_err};
use serde_json::{json, Value};
use smallsignal_core::Request;

fn req(input: &str, output: &str, freqs: &[f64], extra: Value) -> Request {
    let mut v = json!({ "input": input, "output": output, "freqs": freqs });
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    serde_json::from_value(v).unwrap()
}

fn miller(items: &[(&str, Option<&str>)]) -> Value {
    json!({ "miller": items.iter().map(|(e, t)| match t {
        Some(t) => json!({ "element": e, "term": t }),
        None => json!({ "element": e }),
    }).collect::<Vec<_>>() })
}

fn points(v: &Value) -> Vec<(f64, f64)> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|p| (p["re"].as_f64().unwrap(), p["im"].as_f64().unwrap()))
        .collect()
}

/// Two transconductance stages, CC from the first stage's output to the
/// second's: A1 = −g_{m1} R_1, A2 = −g_{m2} R_2 = −100.
fn two_stage(cc: &str) -> String {
    format!(
        "two stage\nVIN in 0 DC 0 AC 1\nG1 n1 0 in 0 1m\nR1 n1 0 100k\nC1 n1 0 0.1p\n\
G2 out 0 n1 0 2m\nR2 out 0 50k\nCL out 0 2p\n{cc}\n"
    )
}

const CS: &str = "cs device caps\n.options gmin=1e-18\nVIN in 0 DC 0.8 AC 1\nRS in g 2k\nVDD vdd 0 1.8\n\
RD vdd out 10k\nM1 out g 0 0 nch W=10u L=1u AD=20p\n\
.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1 TOX=20n CGSO=3e-10 CGDO=3e-10 CJ=5e-4)\n";

const FREQS: [f64; 5] = [0.0, 1e3, 1e6, 1e8, 1e9];

#[test]
fn k_is_the_dc_gain_across_the_capacitance() {
    let r = req("VIN", "out", &FREQS, json!({ "assume": miller(&[("CC", None)]) }));
    let v = run(&two_stage("CC n1 out 1p"), &r);
    let m = &v["assumptions"]["miller"][0];
    let k = m["k"].as_f64().unwrap();
    assert!((k + 100.0).abs() <= 1e-12 * 100.0, "{k}");
    assert_eq!(m["element"], "CC");
    assert_eq!(m["term"], Value::Null);
    assert_eq!(m["latex"], "C_{C}");
    assert_eq!(m["symbol"], "K_{CC}");
    assert_eq!(m["definition"], "-G_{2} R_{2}");
    let p = v["params"].as_array().unwrap();
    let kp = p.iter().find(|p| p["name"] == "K_CC").expect("K in params");
    assert_eq!(kp["latex"], "K_{CC}");
    assert_eq!(kp["value"], m["k"]);
    assert!(p.iter().any(|p| p["name"] == "CC" && p["value"] == json!(1e-12)));
    assert!(v["warnings"].as_array().unwrap().is_empty(), "{}", v["warnings"]);

    // Written the other way round, an explicit capacitor is oriented so that
    // |K| ≥ 1: the same K, the same split.
    let w = run(&two_stage("CC out n1 1p"), &r);
    assert_eq!(w["assumptions"]["miller"][0]["k"], m["k"]);
    let (a, b) = (
        points(&v["gain"]["assumed"]["values"]),
        points(&w["gain"]["assumed"]["values"]),
    );
    for (x, y) in a.iter().zip(&b) {
        assert!(close(*x, *y, 1e-12), "{x:?} vs {y:?}");
    }
}

/// The netlist with the capacitance replaced by C_in = C(1 − K) from a to
/// ground and C_out = C(K − 1)/K from b to ground.
fn split_netlist(net: &str, from: &str, a: &str, b: &str, c: f64, k: f64) -> String {
    let cin = c * (1.0 - k);
    let cout = c * (k - 1.0) / k;
    let body: Vec<&str> = net.lines().filter(|l| !l.starts_with(&format!("{from} "))).collect();
    format!("{}\nCMIN {a} 0 {cin:e}\nCMOUT {b} 0 {cout:e}\n", body.join("\n"))
}

#[test]
fn the_split_model_is_two_grounded_capacitances() {
    let net = two_stage("CC n1 out 1p");
    let r = req(
        "VIN",
        "out",
        &FREQS,
        json!({ "rout": true, "assume": miller(&[("CC", None)]) }),
    );
    let v = run(&net, &r);
    let k = v["assumptions"]["miller"][0]["k"].as_f64().unwrap();
    let plain = req("VIN", "out", &FREQS, json!({ "rout": true }));
    let s = run(&split_netlist(&net, "CC", "n1", "out", 1e-12, k), &plain);
    // One split serves every quantity, the gain's K for Zin and Zout too.
    for q in ["gain", "rout"] {
        let (got, want) = (&v[q]["assumed"]["values"], &s[q]["values"]);
        for (i, (x, y)) in points(got).iter().zip(points(want)).enumerate() {
            assert!(close(*x, y, 1e-9), "{q}@{}: {x:?} vs {y:?}", FREQS[i]);
        }
        assert_eq!(v[q]["check"]["ok"], json!(true), "{q}");
    }
    // The device's own C_gd, with C_gd neglected and the two added instead.
    let r = req(
        "VIN",
        "out",
        &FREQS[1..],
        json!({ "rin": true, "assume": miller(&[("M1", Some("cgd"))]) }),
    );
    let v = run(CS, &r);
    let m = &v["assumptions"]["miller"][0];
    assert_eq!(m["latex"], "C_{gd1}");
    assert_eq!(m["symbol"], "K_{gd1}");
    assert_eq!(m["definition"], "-g_{m1} \\left(r_{o1} \\parallel R_{D}\\right)");
    let k = m["k"].as_f64().unwrap();
    let cgd = v["op"]["devices"]["M1"]["caps"]["cgd"].as_f64().unwrap();
    // K = −g_m (r_o ∥ r_bd ∥ R_D) at this bias.
    let d = &v["op"]["devices"]["M1"];
    let want = -d["gm"].as_f64().unwrap() / (d["gds"].as_f64().unwrap() + 1e-4);
    assert!((k - want).abs() <= 1e-6 * want.abs(), "{k} vs {want}");
    let neglect = req(
        "VIN",
        "out",
        &FREQS[1..],
        json!({ "rin": true, "assume": { "ignore": [{ "element": "M1", "term": "cgd" }] } }),
    );
    let s = run(&split_netlist(CS, "NONE", "g", "out", cgd, k), &neglect);
    for q in ["gain", "rin"] {
        for (x, y) in points(&v[q]["assumed"]["values"])
            .iter()
            .zip(points(&s[q]["assumed"]["values"]))
        {
            assert!(close(*x, y, 1e-9), "{q}: {x:?} vs {y:?}");
        }
    }
}

#[test]
fn values_stay_the_full_models_and_the_rhp_zero_goes() {
    let r = req("VIN", "out", &FREQS, json!({ "rin": true }));
    let plain = run(CS, &r);
    let r = req(
        "VIN",
        "out",
        &FREQS,
        json!({ "rin": true, "assume": miller(&[("M1", Some("cgd"))]) }),
    );
    let v = run(CS, &r);
    for q in ["gain", "rin"] {
        for key in ["values", "poles", "zeros", "poleCount", "zeroCount"] {
            assert_eq!(v[q][key], plain[q][key], "{q} {key}");
        }
    }
    // At DC every capacitance is open: the split changes nothing there.
    let (a, f) = (
        points(&v["gain"]["assumed"]["values"])[0],
        points(&v["gain"]["values"])[0],
    );
    assert!(close(a, f, 1e-12), "{a:?} vs {f:?}");
    assert_eq!(v["gain"]["assumed"]["relError"][0], json!(0.0));
    // The full model's RHP zero g_m/C_gd has no counterpart: removed.
    let zeros = v["gain"]["assumed"]["zeros"].as_array().unwrap();
    let rhp = zeros
        .iter()
        .find(|z| z["full"]["re"].as_f64().is_some_and(|re| re > 0.0))
        .expect("the full model's RHP zero");
    assert_eq!(rhp["assumed"], Value::Null);
    // Its cost, measured against the full model.
    let e = v["gain"]["exact"]["fullModelError"].as_f64().unwrap();
    assert!(e > 0.0, "{e}");
    assert_eq!(v["gain"]["assumed"]["maxRelError"].as_f64().unwrap(), e);
}

fn warnings(v: &Value) -> Vec<String> {
    v["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_capacitance_without_two_signal_nodes_or_a_k_is_refused() {
    let r = |items: &[(&str, Option<&str>)]| req("VIN", "out", &[1e3], json!({ "assume": miller(items) }));
    // To ground, and to a supply.
    let net = two_stage("CC n1 out 1p\nVDD vdd 0 1\nCS out vdd 1p");
    for (el, why) in [
        ("CL", "it is not between two signal nodes"),
        ("CS", "it is not between two signal nodes"),
    ] {
        let v = run(&net, &r(&[(el, None)]));
        assert_eq!(warnings(&v), vec![format!("No Miller split for {el}, {why}")]);
        assert_eq!(v["assumptions"]["miller"], json!([]));
        // Nothing split: the forms are the full model's.
        assert_eq!(v["gain"]["exact"]["fullModelError"], json!(0.0));
    }
    // A coupling capacitor in the signal path: no DC signal at either end.
    let net = "ac coupled\nVIN in 0 DC 0 AC 1\nCIN in a 1p\nRA a 0 1k\nG1 b 0 a 0 1m\nRB b 0 10k\nCF a b 1p\n";
    let v = run(
        net,
        &req("VIN", "b", &[1e3], json!({ "assume": miller(&[("CF", None)]) })),
    );
    assert_eq!(warnings(&v), vec!["No Miller split for CF, K is undefined"]);
    // One end without DC signal: K = 0 one way round.
    let net = "k zero\nVIN in 0 DC 0 AC 1\nR1 in a 1k\nRA a 0 1k\nRB b 0 1k\nCF a b 1p\nCO a out 1p\nRO out 0 1k\n";
    let v = run(
        net,
        &req("VIN", "out", &[1e3], json!({ "assume": miller(&[("CF", None)]) })),
    );
    assert_eq!(warnings(&v), vec!["No Miller split for CF, K is 0"]);
    // A device's C_gd with its gate AC-coupled: v_g(0) = 0.
    let net = CS.replace("RS in g 2k", "CIN in g 1p\nRG g gb 1meg\nVG gb 0 0.8");
    let v = run(
        &net,
        &req(
            "VIN",
            "out",
            &[1e3],
            json!({ "assume": miller(&[("M1", Some("cgd"))]) }),
        ),
    );
    assert!(
        warnings(&v).contains(&"No Miller split for cgd of M1, K is undefined".to_string()),
        "{:?}",
        warnings(&v)
    );
    // Not in the model (no CGDO, no TOX).
    let net = "cs\nVIN in 0 DC 0.8 AC 1\nVDD vdd 0 1.8\nRD vdd out 10k\nM1 out in 0 0 nch\n\
.model nch NMOS (LEVEL=1 KP=200u VTO=0.5)\n";
    let v = run(
        net,
        &req(
            "VIN",
            "out",
            &[1e3],
            json!({ "assume": miller(&[("M1", Some("cgd"))]) }),
        ),
    );
    assert_eq!(
        warnings(&v),
        vec!["No Miller split for cgd of M1, it is not in the model"]
    );
}

#[test]
fn a_negative_split_capacitance_is_warned() {
    // A non-inverting second stage: K = +100 > 1, C_in < 0.
    let net = "two stage\nVIN in 0 DC 0 AC 1\nG1 n1 0 in 0 1m\nR1 n1 0 100k\nG2 0 out n1 0 2m\nR2 out 0 50k\n\
CL out 0 2p\nCC n1 out 1p\n";
    let v = run(
        net,
        &req("VIN", "out", &[1e3], json!({ "assume": miller(&[("CC", None)]) })),
    );
    assert!(
        warnings(&v).contains(&"Miller C_in of CC is negative, K > 1".to_string()),
        "{:?}",
        warnings(&v)
    );
    assert!((v["assumptions"]["miller"][0]["k"].as_f64().unwrap() - 100.0).abs() < 1e-9);
    // A follower's C_gs: 0 < K < 1, C_out < 0.
    let net = "sf\nVDD vdd 0 1.8\nVIN in 0 DC 1.2 AC 1\nM1 vdd in out 0 nch W=10u L=1u\nRS out 0 10k\n\
.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1 TOX=20n)\n";
    let v = run(
        net,
        &req(
            "VIN",
            "out",
            &[1e3],
            json!({ "assume": miller(&[("M1", Some("cgs"))]) }),
        ),
    );
    assert!(
        warnings(&v).contains(&"Miller C_out of cgs of M1 is negative, 0 < K < 1".to_string()),
        "{:?}",
        warnings(&v)
    );
    let k = v["assumptions"]["miller"][0]["k"].as_f64().unwrap();
    assert!(k > 0.0 && k < 1.0, "{k}");
}

#[test]
fn requests_are_validated() {
    let net = two_stage("CC n1 out 1p");
    let err = |assume: Value| run_err(&net, &req("VIN", "out", &[1e3], json!({ "assume": assume })));
    let mut both = miller(&[("CC", None)]);
    both["ignore"] = json!([{ "element": "CC", "term": "open" }]);
    assert_eq!(err(both.clone()), "assume: CC cannot be both open and Miller");
    both["ignore"] = json!([{ "element": "CC", "term": "short" }]);
    assert_eq!(err(both), "assume: CC cannot be both short and Miller");
    assert_eq!(err(miller(&[("R1", None)])), "assume: R1 is not a capacitance");
    assert_eq!(err(miller(&[("CC", Some("cgd"))])), "assume: CC has no term cgd");
    assert_eq!(err(miller(&[("C9", None)])), "assume: no element 'C9'");
    let err = |assume: Value| run_err(CS, &req("VIN", "out", &[1e3], json!({ "assume": assume })));
    assert_eq!(
        err(miller(&[("M1", None)])),
        "assume: M1 needs a capacitance term for Miller"
    );
    assert_eq!(
        err(miller(&[("M1", Some("ro"))])),
        "assume: ro of M1 is not a capacitance"
    );
    assert_eq!(err(miller(&[("M1", Some("cmu"))])), "assume: M1 has no term cmu");
    let mut both = miller(&[("M1", Some("cgd"))]);
    both["ignore"] = json!([{ "element": "M1", "term": "cgd" }]);
    assert_eq!(err(both), "assume: cgd of M1 cannot be both neglected and Miller");
    // A repeat is one split.
    let v = run(
        CS,
        &req(
            "VIN",
            "out",
            &[1e3],
            json!({ "assume": miller(&[("M1", Some("cgd")), ("M1", Some("cgd"))]) }),
        ),
    );
    assert_eq!(v["assumptions"]["miller"].as_array().unwrap().len(), 1);
}

#[test]
fn symbolic_k_is_a_symbol_with_its_definition() {
    let net = "cs\nVIN in 0\nRS in g\nVDD vdd 0\nRD vdd out\nM1 out g 0 0 nch W=10u L=1u AD=20p\n\
.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1 TOX=20n CGSO=3e-10 CGDO=3e-10 CJ=5e-4)\n";
    let v = run(
        net,
        &req(
            "VIN",
            "out",
            &[],
            json!({ "rin": true, "assume": miller(&[("M1", Some("cgd"))]) }),
        ),
    );
    assert_eq!(v["symbolic"], json!(true));
    let m = &v["assumptions"]["miller"][0];
    assert_eq!(m["k"], Value::Null);
    assert_eq!(m["definition"], "-g_{m1} \\left(r_{o1} \\parallel R_{D}\\right)");
    let p = v["params"].as_array().unwrap();
    assert!(
        p.iter().any(|p| p["name"] == "K_cgd_M1" && p["value"].is_null()),
        "{p:?}"
    );
    // The forms are over C_gd and K, never the split's own parameters.
    let latex = v["gain"]["exact"]["latex"].as_str().unwrap();
    assert!(latex.contains("K_{gd1}") && latex.contains("C_{gd1}"), "{latex}");
    // Zin: R_S + 1/(s(C_gs + C_gd(1 − K))).
    let num = v["rin"]["exact"]["num"].as_str().unwrap();
    assert!(!num.contains("Cin") && !num.contains("Cout"), "{num}");
}

#[test]
fn matched_members_share_their_splits() {
    let net = "diff pair\nVDD vdd 0 1.8\nVIP inp 0 DC 1 AC 1\nVIN inn 0 DC 1\nRD1 vdd o1 10k\nRD2 vdd o2 10k\n\
M1 o1 inp tail 0 nch W=10u L=1u\nM2 o2 inn tail 0 nch W=10u L=1u\nIT tail 0 200u\n\
.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1 CGDO=3e-10)\n";
    let base = json!({ "inputNeg": "VIN", "ref": "o2", "match": [["M1", "M2"], ["RD1", "RD2"]] });
    let with = |items: &[(&str, Option<&str>)]| {
        let mut e = base.clone();
        e["assume"] = miller(items);
        req("VIP", "o1", &[1e3], e)
    };
    let v = run(net, &with(&[("M1", Some("cgd"))]));
    assert!(
        warnings(&v).contains(&"M1 and M2 have different assumptions, not matched".to_string()),
        "{:?}",
        warnings(&v)
    );
    // Both split: still matched, each with its own C and K.
    let v = run(net, &with(&[("M1", Some("cgd")), ("M2", Some("cgd"))]));
    let names: Vec<&str> = v["params"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"gm_M1") && !names.contains(&"gm_M2"), "{names:?}");
    assert!(names.contains(&"K_cgd_M1") && names.contains(&"K_cgd_M2"), "{names:?}");
    let ks: Vec<f64> = v["assumptions"]["miller"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["k"].as_f64().unwrap())
        .collect();
    assert_eq!(ks.len(), 2);
    assert!((ks[0] - ks[1]).abs() <= 1e-9 * ks[0].abs(), "{ks:?}");
    assert_eq!(v["gain"]["check"]["ok"], json!(true));
}

#[test]
fn assumable_lists_the_capacitances_that_bridge_two_signal_nodes() {
    let v = run(&two_stage("CC n1 out 1p"), &req("VIN", "out", &[1e3], json!({})));
    let a = v["assumable"].as_array().unwrap();
    let of = |el: &str| a.iter().find(|x| x["element"] == el).unwrap();
    assert_eq!(of("CC")["miller"], json!([null]));
    assert!(of("CL").get("miller").is_none());
    let v = run(CS, &req("VIN", "out", &[1e3], json!({})));
    let m1 = v["assumable"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["element"] == "M1")
        .unwrap()
        .clone();
    // C_gs and C_db end at ground here; C_gd bridges g and out.
    assert_eq!(m1["miller"], json!(["cgd"]));
}

#[test]
fn certificates_are_over_the_split_parameters() {
    let r = req("VIN", "out", &[], json!({ "assume": miller(&[("CC", None)]) }));
    let c = smallsignal_core::certificate::certificate(&two_stage("CC n1 out 1p"), &r).unwrap();
    let names: Vec<&str> = c["params"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"Cin_CC") && names.contains(&"Cout_CC"), "{names:?}");
    assert!(!names.contains(&"CC"), "{names:?}");
}
