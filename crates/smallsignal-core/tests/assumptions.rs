//! Per-device assumptions (`assume`): exact limits before expansion, the
//! full model's values kept, restoration where an assumption makes a
//! quantity unbounded, matching, regions, noise and distortion.

mod common;

use common::{request, run, run_err, Rng};
use serde_json::{json, Value};
use smallsignal_core::assume::{self, AssumeRequest};
use smallsignal_core::poly::Poly;
use smallsignal_core::ss::{self, Excite, SsCircuit};
use smallsignal_core::{det, netlist, Request};

fn with(req: &Request, assume: Value) -> Request {
    let mut v = serde_json::to_value(RequestJson::from(req)).unwrap();
    v["assume"] = assume;
    serde_json::from_value(v).unwrap()
}

/// The request's fields the tests set, as JSON (Request is Deserialize only).
#[derive(serde::Serialize)]
struct RequestJson {
    input: String,
    output: String,
    freqs: Vec<f64>,
    rin: bool,
    rout: bool,
    symbolic: bool,
    noise: bool,
    nonlinear: Vec<String>,
    #[serde(rename = "match")]
    matched: Vec<Vec<String>>,
    #[serde(rename = "ref")]
    reference: Option<String>,
    #[serde(rename = "inputNeg")]
    input_neg: Option<String>,
    mode: Option<String>,
    #[serde(rename = "maxTerms")]
    max_terms: Option<usize>,
}

impl From<&Request> for RequestJson {
    fn from(r: &Request) -> Self {
        RequestJson {
            input: r.input.clone(),
            output: r.output.clone(),
            freqs: r.freqs.clone(),
            rin: r.rin,
            rout: r.rout,
            symbolic: r.symbolic,
            noise: r.noise,
            nonlinear: r.nonlinear.clone(),
            matched: r.matched.clone(),
            reference: r.reference.clone(),
            input_neg: r.input_neg.clone(),
            mode: r.mode.clone(),
            max_terms: r.max_terms,
        }
    }
}

fn ignore(pairs: &[(&str, &str)]) -> Value {
    json!({ "ignore": pairs.iter().map(|(e, t)| json!({ "element": e, "term": t })).collect::<Vec<_>>() })
}

fn req(input: &str, output: &str, freqs: &[f64]) -> Request {
    let mut r = request(input, output);
    r.freqs = freqs.to_vec();
    r
}

/// Σ c·Π values at the parameter values `v` (MNA values, s on reactive ones).
fn eval(p: &Poly, v: &[f64]) -> f64 {
    p.terms
        .iter()
        .map(|(&m, &c)| {
            let mut x = c as f64;
            for (i, vi) in v.iter().enumerate() {
                if m >> i & 1 == 1 {
                    x *= vi;
                }
            }
            x
        })
        .sum()
}

/// (numerator of V(out), determinant) of the gain system.
fn transfer(net: &netlist::Netlist, m: &SsCircuit, input: usize, out: usize) -> (Poly, Poly) {
    let sys = ss::system(net, m, &Excite::Source(input));
    let d = det::det(&sys.a, 1_000_000).unwrap();
    let n = match sys.node_col[out] {
        Some(c) => sys.cramer(c, 1_000_000).unwrap(),
        None => Poly::zero(),
    };
    (n, d)
}

#[test]
fn ignoring_a_term_is_its_exact_limit() {
    // Multilinearity: every minor is affine in each parameter p, so the
    // circuit without p is the full one at p = 0, and p shorted (p → ∞) is
    // the coefficient of p. Checked on random RC/RL ladders, element by
    // element, at random values.
    let mut rng = Rng::new(7);
    let mut checked = 0;
    for case in 0..60 {
        let nodes = 2 + rng.below(4);
        let mut text = String::from("ladder\nVIN n1 0 DC 0 AC 1\n");
        for i in 2..=nodes {
            text += &format!("RS{i} n{} n{i} 1k\n", i - 1);
            text += &format!("RP{i} n{i} 0 2k\n");
            match rng.below(3) {
                0 => text += &format!("C{i} n{i} 0 1p\n"),
                1 => text += &format!("L{i} n{i} n{} 1u\n", rng.below(i - 1) + 1),
                _ => text += &format!("C{i} n{i} n{} 2p\n", rng.below(i - 1) + 1),
            }
        }
        let net = netlist::parse(&text).unwrap();
        let full = ss::build(&net, None).unwrap();
        let input = net.element("VIN").unwrap();
        let out = net.node(&format!("n{nodes}")).unwrap();
        let (nf, df) = transfer(&net, &full, input, out);
        let vals: Vec<f64> = (0..full.params.len()).map(|_| 0.5 + rng.unit()).collect();
        for (k, p) in full.params.iter().enumerate() {
            for term in ["open", "short"] {
                let r: AssumeRequest = serde_json::from_value(ignore(&[(&p.element, term)])).unwrap();
                let a = assume::resolve(&net, &full, None, &r).unwrap();
                let m = assume::apply(&full, &a, &[]);
                // The assumed model's parameters are the full ones less p.
                let mv: Vec<f64> = m
                    .params
                    .iter()
                    .map(|q| vals[full.params.iter().position(|x| x.name == q.name).unwrap()])
                    .collect();
                let (na, da) = transfer(&net, &m, input, out);
                let (dva, nva) = (eval(&da, &mv), eval(&na, &mv));
                let at = |x: f64| {
                    let mut v = vals.clone();
                    v[k] = x;
                    (eval(&nf, &v), eval(&df, &v))
                };
                // An open C (C = 0) or open R/L (1/R, L → ∞ is the MNA
                // value 1/R = 0, or the inductor's branch removed): p's MNA
                // value is 0 for C and R; an inductor opened is the
                // coefficient of L. A short is the coefficient of 1/R or C,
                // and L = 0.
                let leading = (term == "short") != p.name.starts_with('L');
                let (nw, dw) = if leading {
                    let (n1, d1) = at(1.0);
                    let (n0, d0) = at(0.0);
                    (n1 - n0, d1 - d0)
                } else {
                    at(0.0)
                };
                if dw.abs() < 1e-12 || dva.abs() < 1e-300 {
                    continue;
                }
                let (h, want) = (nva / dva, nw / dw);
                assert!(
                    (h - want).abs() <= 1e-10 * want.abs().max(1e-12),
                    "case {case}: {} {term}: {h} vs {want}\n{text}",
                    p.element
                );
                checked += 1;
            }
        }
    }
    assert!(checked > 200, "{checked}");
}

const CS_ISRC: &str = "cs ideal load\nVDD vdd 0 1.8\nVIN in 0 DC 0.8 AC 1\nIB vdd out 200u\n\
M1 out in 0 0 nch W=10u L=1u\nCL out 0 1p\n.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1)\n";

#[test]
fn an_unbounded_quantity_gets_its_term_back() {
    let mut r = req("VIN", "out", &[1e3, 1e6]);
    r.rout = true;
    let v = run(CS_ISRC, &with(&r, ignore(&[("M1", "ro")])));
    for q in ["gain", "rout"] {
        let restored = &v[q]["assumed"]["restored"];
        assert_eq!(
            restored,
            &json!([{ "element": "M1", "term": "ro", "latex": "r_{o1}" }]),
            "{q}"
        );
        // Put back, the gain is the full model's.
        assert!(v[q]["assumed"]["maxRelError"].as_f64().unwrap() < 1e-12, "{q}");
    }
    let w: Vec<&str> = v["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_str().unwrap())
        .collect();
    assert!(w.contains(&"ro of M1 kept, gain is unbounded without it"), "{w:?}");
    assert!(w.contains(&"ro of M1 kept, Zout is unbounded without it"), "{w:?}");
    assert_eq!(
        v["gain"]["simplified"]["latex"],
        "-\\frac{g_{m1} r_{o1}}{1 + r_{o1} C_{L} s}"
    );
}

#[test]
fn a_cascode_gets_both_its_r_o_back() {
    // Neither r_o alone bounds the gain of a cascode into an ideal source.
    let net = "cascode\nVDD vdd 0 3\nVIN in 0 DC 0.8 AC 1\nVB vb 0 1.6\nIB vdd out 100u\n\
M1 x in 0 0 nch W=10u L=1u\nM2 out vb x 0 nch W=10u L=1u\n.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1)\n";
    let mut r = req("VIN", "out", &[1e3]);
    r.rout = true;
    let v = run(net, &with(&r, ignore(&[("M1", "ro"), ("M2", "ro")])));
    for q in ["gain", "rout"] {
        let els: Vec<&str> = v[q]["assumed"]["restored"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["element"].as_str().unwrap())
            .collect();
        assert_eq!(els, ["M1", "M2"], "{q}");
    }
}

#[test]
fn each_quantity_restores_only_what_it_needs() {
    // r_π ignored: the base node is held by RS alone, so no current enters
    // and Zin is unbounded; the gain is still −g_m R_C.
    let net = "ce\nVCC vcc 0 5\nVIN in 0 DC 0.75 AC 1\nRS in b 1k\nQ1 c b 0 npn\nRC vcc c 2k\n\
.model npn NPN (IS=1e-15 BF=100 VAF=50)\n";
    let mut r = req("VIN", "c", &[1e3]);
    r.rin = true;
    let v = run(net, &with(&r, ignore(&[("Q1", "rpi"), ("Q1", "ro")])));
    assert_eq!(v["gain"]["assumed"]["restored"], json!([]));
    let rin: Vec<&str> = v["rin"]["assumed"]["restored"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["term"].as_str().unwrap())
        .collect();
    assert_eq!(rin, ["rpi"]);
    assert_eq!(v["gain"]["display"]["latex"], "-g_{m1} R_{C}");
}

#[test]
fn a_short_across_the_input_restores() {
    let net = "rc\nVIN in 0 DC 0 AC 1\nC1 in 0 1p\nR1 in out 1k\nC2 out 0 1p\n";
    let v = run(net, &with(&req("VIN", "out", &[1e6]), ignore(&[("C1", "short")])));
    assert_eq!(
        v["gain"]["assumed"]["restored"],
        json!([{ "element": "C1", "term": "short", "latex": "C_{1}" }])
    );
    // The other short is applied: C2 → ∞ grounds the output.
    let v = run(net, &with(&req("VIN", "out", &[1e6]), ignore(&[("C2", "short")])));
    assert_eq!(v["gain"]["exact"]["latex"], "0");
    assert_eq!(v["gain"]["assumed"]["values"][0]["re"], json!(0.0));
}

#[test]
fn values_poles_and_zeros_stay_the_full_models() {
    let net = "cs\nVDD vdd 0 1.8\nVIN in 0 DC 0.8 AC 1\nRD vdd out 10k\nM1 out in 0 0 nch W=10u L=1u\nCL out 0 1p\n\
CGD in out 10f\n.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1)\n";
    let mut r = req("VIN", "out", &[0.0, 1e3, 1e8]);
    r.rout = true;
    let plain = run(net, &r);
    for set in [
        ignore(&[]),
        ignore(&[("M1", "ro")]),
        ignore(&[("CGD", "open"), ("M1", "ro")]),
    ] {
        let v = run(net, &with(&r, set.clone()));
        for q in ["gain", "rout"] {
            for key in ["values", "poles", "zeros", "poleCount", "zeroCount"] {
                assert_eq!(v[q][key], plain[q][key], "{set} {q} {key}");
            }
        }
    }
    // The empty set changes no form, and measures 0 from the full model.
    let v = run(net, &with(&r, ignore(&[])));
    for q in ["gain", "rout"] {
        assert_eq!(v[q]["exact"]["latex"], plain[q]["exact"]["latex"]);
        for form in ["exact", "display", "simplified"] {
            let e = v[q][form]["fullModelError"].as_f64().unwrap();
            let want = if form == "exact" {
                0.0
            } else {
                plain[q][form]["maxRelError"].as_f64().unwrap()
            };
            assert!((e - want).abs() <= 1e-15 + 1e-12 * want, "{q} {form}: {e} vs {want}");
        }
        assert_eq!(v[q]["assumed"]["maxRelError"], json!(0.0));
    }
    // ro ignored: −g_m R_D / (1 + s R_D (C_L + C_GD) …), measured against
    // the full model.
    let v = run(net, &with(&r, ignore(&[("M1", "ro")])));
    let e = v["gain"]["exact"]["fullModelError"].as_f64().unwrap();
    assert!(e > 0.01 && e < 0.2, "{e}");
    assert_eq!(v["gain"]["assumed"]["maxRelError"].as_f64().unwrap(), e);
    let pairs = v["gain"]["assumed"]["poles"].as_array().unwrap();
    assert_eq!(pairs.len(), plain["gain"]["poles"].as_array().unwrap().len());
    assert!(
        pairs.iter().all(|p| p["relError"].as_f64().is_some_and(|x| x < 0.2)),
        "{pairs:?}"
    );
    assert_eq!(
        v["assumptions"]["applied"],
        json!([{ "element": "M1", "term": "ro", "latex": "r_{o1} \\to \\infty" }])
    );
}

#[test]
fn matched_members_share_their_assumptions() {
    let net = "diff pair\nVDD vdd 0 1.8\nVIP ip 0 DC 0.9 AC 1\nVIN in 0 DC 0.9\nIT t 0 200u\n\
M1 o1 ip t 0 nch W=10u L=1u\nM2 o2 in t 0 nch W=10u L=1u\nR1 vdd o1 5k\nR2 vdd o2 5k\n\
.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1 GAMMA=0.4)\n";
    let mut r = req("VIP", "o1", &[1e3]);
    r.input_neg = Some("VIN".into());
    r.matched = vec![vec!["M1".into(), "M2".into()], vec!["R1".into(), "R2".into()]];
    let sym = |v: &Value| -> Vec<String> {
        v["params"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["latex"].as_str().unwrap().to_string())
            .collect()
    };
    let v = run(net, &with(&r, ignore(&[("M1", "gmb"), ("M2", "gmb")])));
    let s = sym(&v);
    assert!(
        s.contains(&"r_{o1,2}".to_string()) && !s.iter().any(|x| x.contains("mb")),
        "{s:?}"
    );
    let latex: Vec<&str> = v["assumptions"]["applied"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["latex"].as_str().unwrap())
        .collect();
    assert_eq!(latex, ["g_{mb1,2} = 0", "g_{mb1,2} = 0"]);
    let v = run(net, &with(&r, ignore(&[("M1", "ro")])));
    let w = v["warnings"].as_array().unwrap();
    assert!(
        w.contains(&json!("M1 and M2 have different assumptions, not matched")),
        "{w:?}"
    );
    let s = sym(&v);
    assert!(
        s.contains(&"r_{o2}".to_string()) && s.contains(&"g_{m1}".to_string()),
        "{s:?}"
    );
}

/// The level-1 saturation linearization at an NMOS bias (vbs = 0, no body
/// effect): (gm, gds) = (β(1 + λ v_DS)·v_ov, λβ·v_ov²/2), v_ov = v_GS − V_TO.
fn saturation_at(beta: f64, lambda: f64, vto: f64, vgs: f64, vds: f64) -> (f64, f64) {
    let vov = vgs - vto;
    (beta * (1.0 + lambda * vds) * vov, lambda * beta * vov * vov / 2.0)
}

fn rel(a: f64, b: f64) -> f64 {
    (a - b).abs() / a.abs().max(b.abs())
}

#[test]
fn a_region_is_imposed_at_the_bias() {
    // M1 in triode (v_GS = 1.5 V, v_DS ≈ 0.1 V).
    let net = "triode\nVDD vdd 0 1.8\nVIN in 0 DC 1.5 AC 1\nRD vdd out 50k\nM1 out in 0 0 nch W=10u L=1u\n\
.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1)\n";
    let mut r = req("VIN", "out", &[0.0, 1e3]);
    r.rout = true;
    let plain = run(net, &r);
    assert!(plain["warnings"]
        .as_array()
        .unwrap()
        .contains(&json!("M1 is in triode")));
    let region = |reg: &str| json!({ "regions": [{ "element": "M1", "region": reg }] });
    // The bias's own region: nothing changes, no warning.
    let v = run(net, &with(&r, region("triode")));
    let w = v["warnings"].as_array().unwrap();
    assert!(!w.iter().any(|x| x.as_str().unwrap().starts_with("M1 ")), "{w:?}");
    assert_eq!(
        v["assumptions"]["regions"],
        json!([{ "element": "M1", "assumed": "triode", "actual": "triode", "effect": "same" }])
    );
    assert_eq!(v["gain"]["exact"]["latex"], plain["gain"]["exact"]["latex"]);
    assert_eq!(v["gain"]["exact"]["fullModelError"], 0.0);
    // Saturation imposed: the saturation equations at the same voltages.
    let v = run(net, &with(&r, region("saturation")));
    let w = v["warnings"].as_array().unwrap();
    assert!(w.contains(&json!("M1 bias says triode")), "{w:?}");
    assert!(!w.contains(&json!("M1 is in triode")), "{w:?}");
    let m = &plain["op"]["devices"]["M1"];
    let (vgs, vds) = (m["vgs"].as_f64().unwrap(), m["vds"].as_f64().unwrap());
    let (gm, gds) = saturation_at(200e-6 * 10.0, 0.1, 0.5, vgs, vds);
    let reg = &v["assumptions"]["regions"][0];
    assert_eq!(reg["effect"], "imposed");
    assert_eq!(reg["actual"], "triode");
    assert!(rel(reg["linearized"]["gm"].as_f64().unwrap(), gm) < 1e-14, "{reg}");
    assert!(rel(reg["linearized"]["gds"].as_f64().unwrap(), gds) < 1e-14, "{reg}");
    // The forms are a saturated device's: r_o, not R_on.
    assert_eq!(
        v["gain"]["display"]["latex"],
        "-g_{m1} \\left(r_{o1} \\parallel R_{D}\\right)"
    );
    assert_eq!(v["rout"]["display"]["latex"], "r_{o1} \\parallel R_{D}");
    // The values stay the full model's; the assumed ones are the hand form's.
    assert_eq!(v["gain"]["values"], plain["gain"]["values"]);
    let ro = 1.0 / gds;
    let param = |name: &str| {
        v["params"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == name)
            .unwrap()["value"]
            .as_f64()
            .unwrap()
    };
    // The drain junction's leakage stays in the model.
    let hand = -gm / (gds + 1.0 / 50e3 + 1.0 / param("rbd_M1"));
    let a = v["gain"]["assumed"]["values"][0]["re"].as_f64().unwrap();
    assert!(rel(a, hand) < 1e-12, "{a} {hand}");
    let f = plain["gain"]["values"][0]["re"].as_f64().unwrap();
    let e = v["gain"]["exact"]["fullModelError"].as_f64().unwrap();
    assert!(rel(e, (a - f).abs() / f.abs()) < 1e-9, "{e}");
    assert!(rel(param("ro_M1"), ro) < 1e-14);
}

#[test]
fn a_region_that_cannot_hold_is_refused() {
    let cs = |vin: f64| {
        format!(
            "cs\nVDD vdd 0 1.8\nVIN in 0 DC {vin} AC 1\nRD vdd out 10k\nM1 out in 0 0 nch W=10u L=1u\n\
.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1)\n"
        )
    };
    let r = req("VIN", "out", &[1e3]);
    let region = |reg: &str| json!({ "regions": [{ "element": "M1", "region": reg }] });
    // Saturated: the triode current falls past V_DS = V_GS − V_TH.
    let net = cs(0.8);
    let plain = run(&net, &r);
    let v = run(&net, &with(&r, region("triode")));
    assert!(v["warnings"]
        .as_array()
        .unwrap()
        .contains(&json!("M1 is saturated, cannot assume triode")));
    assert_eq!(v["assumptions"]["regions"][0]["effect"], "refused");
    assert_eq!(v["gain"]["exact"]["latex"], plain["gain"]["exact"]["latex"]);
    assert_eq!(v["gain"]["assumed"]["values"], plain["gain"]["values"]);
    // Off: there is no channel to linearize.
    let net = cs(0.3);
    let v = run(&net, &with(&r, region("saturation")));
    let w = v["warnings"].as_array().unwrap();
    assert!(w.contains(&json!("M1 is off, cannot assume saturation")), "{w:?}");
    assert!(!w.contains(&json!("M1 is off")), "{w:?}");
    // A BJT's region is only checked.
    let ce = "ce\nVCC vcc 0 5\nVIN in 0 DC 0.7 AC 1\nRB in b 1k\nQ1 c b 0 npn\nRC vcc c 2k\n\
.model npn NPN (IS=1e-15 BF=100 VAF=50)\n";
    let r = req("VIN", "c", &[1e3]);
    let plain = run(ce, &r);
    let v = run(
        ce,
        &with(&r, json!({ "regions": [{ "element": "Q1", "region": "saturation" }] })),
    );
    assert_eq!(v["assumptions"]["regions"][0]["effect"], "checked");
    assert_eq!(v["gain"]["exact"]["latex"], plain["gain"]["exact"]["latex"]);
}

#[test]
fn an_imposed_region_follows_the_source_drain_swap() {
    // The same triode device drawn either way round: v_DS < 0 in the second
    // swaps drain and source, as ngspice does, and imposes the same model.
    let net = |d: &str, s: &str| {
        format!(
            "swap\nVDD vdd 0 1.8\nVIN in 0 DC 1.5 AC 1\nRD vdd out 50k\nM1 {d} in {s} 0 nch W=10u L=1u\n\
.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1 GAMMA=0.4 PHI=0.7)\n"
        )
    };
    let mut r = req("VIN", "out", &[1e3]);
    r.rout = true;
    let sat = json!({ "regions": [{ "element": "M1", "region": "saturation" }] });
    let a = run(&net("out", "0"), &with(&r, sat.clone()));
    let b = run(&net("0", "out"), &with(&r, sat));
    assert_eq!(a["op"]["devices"]["M1"]["reversed"], false);
    assert_eq!(b["op"]["devices"]["M1"]["reversed"], true);
    for q in ["gain", "rout"] {
        let x = a[q]["assumed"]["values"][0]["re"].as_f64().unwrap();
        let y = b[q]["assumed"]["values"][0]["re"].as_f64().unwrap();
        assert!(rel(x, y) < 1e-12, "{q}: {x} {y}");
    }
    assert_eq!(a["assumptions"]["regions"][0]["effect"], "imposed");
    assert_eq!(b["assumptions"]["regions"][0]["effect"], "imposed");
}

#[test]
fn noise_and_distortion_follow_an_imposed_region() {
    let net = "inverter\nVDD vdd 0 1.8\nVIN in 0 DC 1.1 AC 1\nM1 out in 0 0 nch W=10u L=1u\n\
M2 out in vdd vdd pch W=20u L=1u\n.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1)\n\
.model pch PMOS (LEVEL=1 KP=100u VTO=-0.5 LAMBDA=0.1)\n";
    let mut r = req("VIN", "out", &[1e3]);
    r.noise = true;
    r.nonlinear = vec!["M1".into(), "M2".into()];
    let plain = run(net, &r);
    let v = run(
        net,
        &with(&r, json!({ "regions": [{ "element": "M1", "region": "saturation" }] })),
    );
    // Spectra and numeric coefficients stay the full model's.
    assert_eq!(v["noise"]["output"], plain["noise"]["output"]);
    let low = &v["noise"]["inputLowFreq"];
    assert_eq!(low["check"]["ok"], true, "{low}");
    assert!(low["exact"]["fullModelError"].as_f64().unwrap() > 0.1, "{low}");
    let d = &v["distortion"];
    assert_eq!(d["check"]["ok"], true, "{}", d["check"]);
    for (x, y) in d["coefficients"]
        .as_array()
        .unwrap()
        .iter()
        .zip(plain["distortion"]["coefficients"].as_array().unwrap())
    {
        assert_eq!(x["numeric"], y["numeric"]);
    }
    // a₁ is the assumed gain at DC.
    let a1 = d["coefficients"][0]["value"].as_f64().unwrap();
    let g = v["gain"]["assumed"]["values"][0]["re"].as_f64().unwrap();
    assert!(rel(a1, g) < 1e-9, "{a1} {g}");
    // Saturation imposed on M1 (triode at its bias): its square law, so
    // its V_OD; the bias's own forms have none for it.
    let vod = |r: &Value| {
        r["distortion"]["symbols"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["name"] == "Vod_M1")
    };
    assert!(vod(&v), "{}", d["symbols"]);
    assert!(!vod(&plain), "{}", plain["distortion"]["symbols"]);
    assert!(d["coefficients"][1]["latex"].as_str().unwrap().contains("V_{OD1}"));
}

#[test]
fn a_declared_region_overrides_the_wiring_in_symbolic_mode() {
    // Two devices on one gate, one's drain on the other's source: the inner
    // one is taken to be in triode, unless saturation is declared.
    let net = "stack\nVDD vdd 0\nVIN in 0\nRD vdd out\nM1 out in x 0\nM2 x in 0 0\n";
    let r = req("VIN", "out", &[]);
    let plain = run(net, &r);
    let latex = |v: &Value| {
        v["params"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["latex"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    };
    assert!(latex(&plain).contains(&"R_{on2}".to_string()));
    let v = run(
        net,
        &with(&r, json!({ "regions": [{ "element": "M2", "region": "saturation" }] })),
    );
    let l = latex(&v);
    assert!(
        l.contains(&"r_{o2}".to_string()) && !l.contains(&"R_{on2}".to_string()),
        "{l:?}"
    );
    assert_eq!(v["assumptions"]["regions"][0]["effect"], "imposed");
    assert!(!v["warnings"].as_array().unwrap().contains(&json!("M2 is in triode")));
}

#[test]
fn noise_drops_the_sources_an_assumption_takes_to_zero() {
    let net = "ce\nVCC vcc 0 5\nVIN in 0 DC 0.7 AC 1\nRB in b 1k\nQ1 c b 0 npn\nRC vcc c 2k\n\
.model npn NPN (IS=1e-15 BF=100 VAF=50 KF=1e-16)\n";
    let mut r = req("VIN", "c", &[1e3]);
    r.noise = true;
    let plain = run(net, &r);
    let v = run(net, &with(&r, ignore(&[("Q1", "rpi")])));
    let ignored: Vec<String> = v["noise"]["sources"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["ignored"] == true)
        .map(|s| format!("{}:{}", s["element"].as_str().unwrap(), s["kind"].as_str().unwrap()))
        .collect();
    assert_eq!(ignored, ["Q1:shot_b", "Q1:flicker"]);
    // The spectra stay the full model's.
    assert_eq!(v["noise"]["output"], plain["noise"]["output"]);
    let low = &v["noise"]["inputLowFreq"];
    assert_eq!(low["check"]["ok"], true, "{low}");
    let shot = low["exact"]["shot"]["num"].as_str().unwrap();
    assert!(!shot.contains("IB_Q1"), "{shot}");
    let full = plain["noise"]["inputLowFreq"]["exact"]["value"].as_f64().unwrap();
    let got = low["exact"]["value"].as_f64().unwrap();
    let e = low["exact"]["fullModelError"].as_f64().unwrap();
    assert!((e - (got - full).abs() / full).abs() < 1e-12 && e > 0.0, "{e}");
}

#[test]
fn distortion_drops_the_terms_an_ignored_conductance_linearizes() {
    let net = "cs\nVDD vdd 0 5\nVIN in 0 DC 0.9 AC 1\nRD vdd out 5k\nM1 out in 0 0 nm W=10u L=1u\n\
.model nm NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.05)\n";
    let mut r = req("VIN", "out", &[1e3]);
    r.nonlinear = vec!["M1".into()];
    let plain = run(net, &r);
    let v = run(net, &with(&r, ignore(&[("M1", "ro")])));
    let d = &v["distortion"];
    for t in d["taylor"].as_array().unwrap() {
        let has_d = t["monomial"].as_str().unwrap().contains('d');
        assert_eq!(t["ignored"] == true, has_d, "{t}");
    }
    assert_eq!(d["check"]["ok"], true, "{}", d["check"]);
    // The numeric a_n stay the full model's; the closed form is λ = 0's:
    // a2 = −K_2g R_D = −g_m R_D/(2 V_OD).
    for (a, b) in d["coefficients"]
        .as_array()
        .unwrap()
        .iter()
        .zip(plain["distortion"]["coefficients"].as_array().unwrap())
    {
        assert_eq!(a["numeric"], b["numeric"]);
    }
    let a2 = &d["coefficients"][1];
    assert_eq!(a2["simplified"]["latex"], "-\\frac{g_{m1} R_{D}}{2 V_{OD1}}", "{a2}");
    assert!(a2["fullModelError"].as_f64().unwrap() > 0.0);
    assert!(d["hd2"]["fullModelError"].is_number());
}

#[test]
fn requests_are_validated() {
    let r = req("VIN", "out", &[1e3]);
    let net = "cs\nVDD vdd 0 1.8\nVIN in 0 DC 0.8 AC 1\nRD vdd out 10k\nM1 out in 0 0 nch W=10u L=1u\nC1 out 0 1p\n\
.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1)\n";
    assert_eq!(
        run_err(net, &with(&r, ignore(&[("M9", "ro")]))),
        "assume: no element 'M9'"
    );
    assert_eq!(
        run_err(net, &with(&r, ignore(&[("M1", "rpi")]))),
        "assume: M1 has no term rpi"
    );
    assert_eq!(
        run_err(net, &with(&r, ignore(&[("VIN", "short")]))),
        "assume: VIN has no term short"
    );
    assert_eq!(
        run_err(net, &with(&r, ignore(&[("C1", "open"), ("C1", "short")]))),
        "assume: C1 cannot be both open and short"
    );
    assert_eq!(
        run_err(
            net,
            &with(&r, json!({ "regions": [{ "element": "M1", "region": "active" }] }))
        ),
        "assume: M1 has no region active"
    );
    // g_mb with the body on the source: nothing to take away.
    let v = run(net, &with(&r, ignore(&[("M1", "gmb")])));
    assert_eq!(v["assumptions"]["absent"], json!([{ "element": "M1", "term": "gmb" }]));
    assert_eq!(v["assumptions"]["applied"], json!([]));
    let assumable = &v["assumable"];
    assert_eq!(
        assumable[0],
        json!({ "element": "RD", "type": "resistor", "terms": ["open", "short"], "miller": [] })
    );
    assert_eq!(assumable[1]["element"], "M1");
    assert_eq!(assumable[1]["terms"], json!(["ro", "rbd"]));
}

#[test]
fn symbolic_mode_takes_the_same_limits() {
    let net = "cs\nVIN in 0\nVDD vdd 0\nRD vdd out\nM1 out in 0 0\n";
    let mut r = req("VIN", "out", &[]);
    r.rout = true;
    let v = run(net, &with(&r, ignore(&[("M1", "ro")])));
    assert_eq!(v["symbolic"], true);
    assert_eq!(v["gain"]["exact"]["latex"], "-g_{m1} R_{D}");
    assert_eq!(v["rout"]["exact"]["latex"], "R_{D}");
    assert_eq!(v["gain"]["exact"]["fullModelError"], Value::Null);
    // A declared triode region keeps the channel resistance R_on finite in
    // the hand-analysis form.
    let triode = json!({ "regions": [{ "element": "M1", "region": "triode" }] });
    let v = run(net, &with(&r, triode.clone()));
    assert_eq!(
        v["gain"]["simplified"]["latex"],
        "-g_{m1} \\left(R_{on1} \\parallel R_{D}\\right)"
    );
    assert_eq!(v["assumptions"]["regions"][0]["actual"], Value::Null);
    // R_on is no r_o: neglecting r_o there finds nothing to neglect.
    let mut both = triode;
    both["ignore"] = json!([{ "element": "M1", "term": "ro" }]);
    let v = run(net, &with(&r, both));
    assert_eq!(v["assumptions"]["absent"], json!([{ "element": "M1", "term": "ro" }]));
    assert_eq!(
        v["gain"]["exact"]["latex"],
        "-g_{m1} \\left(R_{on1} \\parallel R_{D}\\right)"
    );
}

#[test]
fn certificates_cover_the_assumed_element_list() {
    let net = "rc\nVIN in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 1p\nR2 out 0 2k\n";
    let r = with(&req("VIN", "out", &[]), ignore(&[("C1", "short"), ("R2", "open")]));
    let c = smallsignal_core::certificate::certificate(net, &r).unwrap();
    assert_eq!(c["elems"].as_array().unwrap().len(), 1, "{c}");
    assert_eq!(c["nodes"].as_array().unwrap().len(), 1, "{c}");
}

#[test]
fn matched_members_with_different_regions_are_not_matched() {
    // Symbolic mode: a declared triode region makes M1's channel R_on, kept
    // finite in the hand form, against M2's r_o. Merged, the form would
    // follow whichever member came first; so they are not matched, in
    // either order.
    let net = "diff pair\nVDD vdd 0\nVIP ip 0\nVIN in 0\nIT t 0\nM1 o1 ip t 0\nM2 o2 in t 0\nR1 vdd o1\nR2 vdd o2\n";
    for (a, b) in [("triode", "saturation"), ("saturation", "triode")] {
        let mut r = req("VIP", "o1", &[]);
        r.input_neg = Some("VIN".into());
        r.matched = vec![vec!["M1".into(), "M2".into()]];
        let regions = json!({ "regions": [{ "element": "M1", "region": a }, { "element": "M2", "region": b }] });
        let v = run(net, &with(&r, regions));
        let w = v["warnings"].as_array().unwrap();
        assert!(
            w.contains(&json!("M1 and M2 have different assumptions, not matched")),
            "{a}: {w:?}"
        );
        let latex: Vec<&str> = v["params"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["latex"].as_str().unwrap())
            .collect();
        let (one, two) = match a {
            "triode" => ("R_{on1}", "r_{o2}"),
            _ => ("r_{o1}", "R_{on2}"),
        };
        assert!(latex.contains(&one) && latex.contains(&two), "{a}: {latex:?}");
    }
}

#[test]
fn an_unbounded_quantity_has_no_error_metric() {
    // Zin looking into a gate is infinite in both models: nothing to
    // compare, so null rather than 0, on the exact and the numeric path.
    let net = "cs\nVDD vdd 0 1.8\nVIN in 0 DC 0.8 AC 1\nRD vdd out 10k\nM1 out in 0 0 nch W=10u L=1u\n\
.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1)\n";
    for budget in [None, Some(1)] {
        let mut r = req("VIN", "out", &[1e3, 1e6]);
        r.rin = true;
        r.max_terms = budget;
        let v = run(net, &with(&r, ignore(&[("M1", "ro")])));
        let rin = &v["rin"];
        assert_eq!(rin["infinite"], true, "{budget:?}");
        assert_eq!(rin["assumed"]["maxRelError"], Value::Null, "{budget:?} {rin}");
        assert_eq!(rin["assumed"]["relError"], json!([null, null]), "{budget:?}");
        if budget.is_none() {
            assert_eq!(rin["exact"]["fullModelError"], Value::Null, "{rin}");
        }
        // A finite quantity next to it is still measured.
        assert!(v["gain"]["assumed"]["maxRelError"].as_f64().is_some_and(|e| e > 0.0));
    }
}

#[test]
fn stability_is_the_full_models() {
    // Positive feedback through E1 (k = 3): a right-half-plane pole at
    // 1/(2π R C). With C1 open the assumed circuit has no pole at all, yet
    // the warning stays: stability is a property of the full circuit.
    let net = "pf\nVIN in 0 AC 1\nR1 in a 1k\nR2 out a 1k\nC1 a 0 1n\nE1 out 0 a 0 3\n";
    for budget in [None, Some(1)] {
        let mut r = req("VIN", "out", &[1e3]);
        r.max_terms = budget;
        let v = run(net, &with(&r, ignore(&[("C1", "open")])));
        assert_eq!(
            v["warnings"],
            json!(["Unstable at this bias: a right-half-plane pole."]),
            "{budget:?}"
        );
        assert_eq!(v["gain"]["poleCount"], 1, "{budget:?}");
        let pairs = v["gain"]["assumed"]["poles"].as_array().unwrap();
        assert_eq!(pairs.len(), 1, "{budget:?}");
        assert_eq!(pairs[0]["assumed"], Value::Null, "{budget:?}");
    }
}

#[test]
fn an_assumed_model_over_budget_keeps_its_matched_classes() {
    // A matched pair driven in common mode, output o1 − o2: the merged
    // numerator cancels exactly, so the assumed values are exactly 0 even
    // on the numeric path (the full model's too, as before).
    let net = "diff pair\nVDD vdd 0 1.8\nVIP ip 0 DC 0.9 AC 1\nVIN in 0 DC 0.9\nRT t 0 2.5k\n\
M1 o1 ip t 0 nch W=10u L=1u\nM2 o2 in t 0 nch W=10u L=1u\nR1 vdd o1 5k\nR2 vdd o2 5k\n\
C1 o1 0 1p\nC2 o2 0 1p\n.model nch NMOS (LEVEL=1 KP=200u VTO=0.5 LAMBDA=0.1)\n";
    let mut r = req("VIP", "o1", &[1e3, 1e6]);
    r.reference = Some("o2".into());
    r.input_neg = Some("VIN".into());
    r.mode = Some("common".into());
    r.matched = vec![
        vec!["M1".into(), "M2".into()],
        vec!["R1".into(), "R2".into()],
        vec!["C1".into(), "C2".into()],
    ];
    r.max_terms = Some(1);
    let v = run(net, &with(&r, ignore(&[("M1", "ro"), ("M2", "ro")])));
    let g = &v["gain"];
    assert_eq!(g["skipped"], "too large for the exact closed form", "{g}");
    for p in g["assumed"]["values"].as_array().unwrap() {
        assert_eq!((p["re"].as_f64(), p["im"].as_f64()), (Some(0.0), Some(0.0)), "{p}");
    }
    assert!(g["assumed"]["zeros"].as_array().unwrap().is_empty(), "{g}");
    // Unmerged, the numerator would not vanish and its roots not be found.
    assert_eq!(v["warnings"], json!(["No signal reaches o1 − o2"]));
}
