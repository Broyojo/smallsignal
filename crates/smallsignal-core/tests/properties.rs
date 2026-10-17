//! Property tests on random circuits: identities every correct solver must
//! satisfy, checked without an external simulator.

mod common;

use common::{close, request, run, value, Rng};
use num_complex::Complex64;
use serde_json::Value;
use smallsignal_core::poly::Poly;
use smallsignal_core::ss::{self, Excite, SsCircuit};
use smallsignal_core::{analyze, dc, det, netlist, render, roots, structure, sym};

const CASES: usize = 300;

/// A random linear circuit on nodes n1..n{nodes}: a resistor spanning tree to
/// ground (so DC is defined), extra R/C/L, and optionally controlled sources.
/// Inductors and voltage-type outputs never close a loop of shorts.
struct Linear {
    lines: Vec<String>,
    nodes: usize,
}

fn find(uf: &mut [usize], x: usize) -> usize {
    let mut r = x;
    while uf[r] != r {
        r = uf[r];
    }
    r
}

fn linear(rng: &mut Rng, controlled: bool, reactive: bool) -> Linear {
    let nodes = 2 + rng.below(5);
    let mut lines = Vec::new();
    let mut uf: Vec<usize> = (0..=nodes).collect();
    // The tests drive n1 from ground with VIN, which is a DC short too.
    uf[1] = 0;
    let short = |uf: &mut Vec<usize>, a: usize, b: usize| -> bool {
        let (ra, rb) = (find(uf, a), find(uf, b));
        if ra == rb {
            return false;
        }
        uf[ra] = rb;
        true
    };
    let nd = |i: usize| if i == 0 { "0".to_string() } else { format!("n{i}") };
    for i in 1..=nodes {
        let to = rng.below(i);
        lines.push(format!("RT{i} {} {} {:.6e}", nd(i), nd(to), rng.decade(10.0, 1e6)));
    }
    let mut k = 0;
    for _ in 0..rng.below(2 * nodes) {
        k += 1;
        let (a, b) = (rng.below(nodes + 1), rng.below(nodes + 1));
        if a == b {
            continue;
        }
        match rng.below(if reactive { 3 } else { 1 }) {
            0 => lines.push(format!("R{k} {} {} {:.6e}", nd(a), nd(b), rng.decade(10.0, 1e6))),
            1 => lines.push(format!("C{k} {} {} {:.6e}", nd(a), nd(b), rng.decade(1e-15, 1e-9))),
            _ => {
                if short(&mut uf, a, b) {
                    lines.push(format!("L{k} {} {} {:.6e}", nd(a), nd(b), rng.decade(1e-9, 1e-3)));
                }
            }
        }
    }
    if controlled {
        for _ in 0..1 + rng.below(3) {
            k += 1;
            let (a, b, c, d) = (
                rng.below(nodes + 1),
                rng.below(nodes + 1),
                rng.below(nodes + 1),
                rng.below(nodes + 1),
            );
            if a == b {
                continue;
            }
            let gain = (if rng.below(2) == 0 { -1.0 } else { 1.0 }) * rng.decade(0.01, 10.0);
            match rng.below(4) {
                0 => {
                    if short(&mut uf, a, b) {
                        lines.push(format!("E{k} {} {} {} {} {gain:.6e}", nd(a), nd(b), nd(c), nd(d)));
                    }
                }
                1 => lines.push(format!(
                    "G{k} {} {} {} {} {:.6e}",
                    nd(a),
                    nd(b),
                    nd(c),
                    nd(d),
                    gain * 1e-3
                )),
                _ => {
                    // A 0 V sense source in series with a resistor controls F/H.
                    let (p, q) = (rng.below(nodes + 1), rng.below(nodes + 1));
                    if p == q {
                        continue;
                    }
                    lines.push(format!("VS{k} {} s{k} 0", nd(p)));
                    lines.push(format!("RS{k} s{k} {} {:.6e}", nd(q), rng.decade(100.0, 1e5)));
                    if rng.below(2) == 0 {
                        lines.push(format!("F{k} {} {} VS{k} {gain:.6e}", nd(a), nd(b)));
                    } else if short(&mut uf, a, b) {
                        lines.push(format!("H{k} {} {} VS{k} {:.6e}", nd(a), nd(b), gain * 1e3));
                    }
                }
            }
        }
    }
    Linear { lines, nodes }
}

fn netlist_text(title: &str, lines: &[String]) -> String {
    format!("{title}\n{}\n.end\n", lines.join("\n"))
}

fn req_json(v: Value) -> smallsignal_core::Request {
    serde_json::from_value(v).unwrap()
}

/// Runs, treating a singular circuit (a legitimate outcome for random
/// controlled sources) as None.
fn try_run(net: &str, req: &smallsignal_core::Request) -> Option<Value> {
    match analyze(net, req) {
        Ok(v) => Some(v),
        Err(e) if e.contains("singular") => None,
        Err(e) => panic!("analyze failed: {e}\n{net}"),
    }
}

const FREQS: [f64; 4] = [0.0, 1e3, 1e6, 1e9];

#[test]
fn reciprocity_of_passive_networks() {
    let mut rng = Rng::new(11);
    for _ in 0..CASES {
        let c = linear(&mut rng, false, true);
        let i = 1 + rng.below(c.nodes);
        let j = 1 + rng.below(c.nodes);
        // Z_ij: current into node j, voltage at node i.
        let z = |inject: usize, measure: usize| {
            let mut lines = c.lines.clone();
            lines.push(format!("IIN 0 n{inject} AC 1"));
            let net = netlist_text("recip", &lines);
            let r = run(
                &net,
                &req_json(
                    serde_json::json!({ "input": "IIN", "output": format!("n{measure}"), "freqs": FREQS, "verify": true }),
                ),
            );
            assert_eq!(r["verify"]["kcl"], true, "{net}");
            r
        };
        let (zij, zji) = (z(j, i), z(i, j));
        for k in 0..FREQS.len() {
            assert!(
                close(value(&zij, "gain", k), value(&zji, "gain", k), 1e-9),
                "Z{i}{j} != Z{j}{i}\n{:?}",
                c.lines
            );
        }
    }
}

#[test]
fn series_and_parallel_are_exact() {
    let mut rng = Rng::new(12);
    for _ in 0..CASES {
        let rs: Vec<f64> = (0..2 + rng.below(4)).map(|_| rng.decade(1.0, 1e7)).collect();
        // Parallel: Zin = 1/Σ(1/R).
        let mut lines = vec!["VIN in 0 AC 1".to_string()];
        lines.extend(rs.iter().enumerate().map(|(k, r)| format!("R{k} in 0 {r:.17e}")));
        let r = run(
            &netlist_text("par", &lines),
            &req_json(serde_json::json!({ "input": "VIN", "output": "in", "rin": true })),
        );
        let want = 1.0 / rs.iter().map(|r| 1.0 / r).sum::<f64>();
        assert!(close(value(&r, "rin", 0), (want, 0.0), 1e-12), "{r}");
        // Series divider: gain = R_last / Σ R.
        let mut lines = vec!["VIN n0 0 AC 1".to_string()];
        lines.extend(rs.iter().enumerate().map(|(k, r)| {
            let to = if k + 1 == rs.len() {
                "0".to_string()
            } else {
                format!("n{}", k + 1)
            };
            format!("R{k} n{k} {to} {r:.17e}")
        }));
        let last = format!("n{}", rs.len() - 1);
        let r = run(
            &netlist_text("ser", &lines),
            &req_json(serde_json::json!({ "input": "VIN", "output": last, "rin": true })),
        );
        let total: f64 = rs.iter().sum();
        assert!(
            close(value(&r, "gain", 0), (rs[rs.len() - 1] / total, 0.0), 1e-12),
            "{r}"
        );
        assert!(close(value(&r, "rin", 0), (total, 0.0), 1e-12), "{r}");
    }
}

/// Scales impedances by k: R, L and H by k; C and G by 1/k; E and F stay.
fn scale_line(line: &str, k: f64) -> String {
    let t: Vec<&str> = line.split_whitespace().collect();
    let last = t.len() - 1;
    let f = match t[0].chars().next().unwrap() {
        'R' | 'L' | 'H' => k,
        'C' | 'G' => 1.0 / k,
        _ => return line.to_string(),
    };
    let v: f64 = t[last].parse().unwrap();
    let mut out: Vec<String> = t.iter().map(|s| s.to_string()).collect();
    out[last] = format!("{:.17e}", v * f);
    out.join(" ")
}

#[test]
fn impedance_scaling_leaves_the_gain_unchanged() {
    let mut rng = Rng::new(13);
    let mut solved = 0;
    for _ in 0..CASES {
        let c = linear(&mut rng, true, true);
        let k = rng.decade(1e-3, 1e3);
        let out = format!("n{}", 1 + rng.below(c.nodes));
        let mut a = c.lines.clone();
        a.push("VIN n1 0 AC 1".into());
        let b: Vec<String> = a.iter().map(|l| scale_line(l, k)).collect();
        let req = req_json(serde_json::json!({ "input": "VIN", "output": out, "freqs": FREQS, "rin": true }));
        let (Some(ra), Some(rb)) = (
            try_run(&netlist_text("a", &a), &req),
            try_run(&netlist_text("b", &b), &req),
        ) else {
            continue;
        };
        solved += 1;
        for i in 0..FREQS.len() {
            assert!(
                close(value(&ra, "gain", i), value(&rb, "gain", i), 1e-8),
                "gain changed under scaling by {k}\n{a:?}"
            );
            let (za, zb) = (value(&ra, "rin", i), value(&rb, "rin", i));
            if za.0.is_finite() {
                assert!(close((za.0 * k, za.1 * k), zb, 1e-8), "Zin did not scale by {k}\n{a:?}");
            }
        }
    }
    assert!(solved > CASES / 2, "only {solved} circuits solved");
}

#[test]
fn renaming_and_reordering_change_nothing() {
    let mut rng = Rng::new(14);
    for _ in 0..CASES {
        let c = linear(&mut rng, true, true);
        let mut a = c.lines.clone();
        a.push("VIN n1 0 AC 1".into());
        let out = 1 + rng.below(c.nodes);
        // Rename every node n{i} → node_{i}_X and shuffle lines.
        let mut b: Vec<String> = a
            .iter()
            .map(|l| {
                l.split_whitespace()
                    .map(|t| match t.strip_prefix('n').and_then(|d| d.parse::<usize>().ok()) {
                        Some(i) => format!("Node_{i}_X"),
                        None => t.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect();
        for i in (1..b.len()).rev() {
            let j = rng.below(i + 1);
            b.swap(i, j);
        }
        let ra = try_run(
            &netlist_text("a", &a),
            &req_json(serde_json::json!({ "input": "VIN", "output": format!("n{out}"), "freqs": FREQS, "rout": true })),
        );
        let rb = try_run(
            &netlist_text("b", &b),
            &req_json(
                serde_json::json!({ "input": "VIN", "output": format!("node_{out}_x"), "freqs": FREQS, "rout": true }),
            ),
        );
        match (ra, rb) {
            (Some(ra), Some(rb)) => {
                for i in 0..FREQS.len() {
                    for q in ["gain", "rout"] {
                        assert!(
                            close(value(&ra, q, i), value(&rb, q, i), 1e-9),
                            "{q} changed\n{a:?}\n{b:?}"
                        );
                    }
                }
                assert_eq!(ra["gain"]["exact"]["terms"], rb["gain"]["exact"]["terms"]);
            }
            (None, None) => {}
            (ra, rb) => panic!(
                "singular in one ordering only: {} vs {}\n{a:?}",
                ra.is_some(),
                rb.is_some()
            ),
        }
    }
}

#[test]
fn zero_volt_source_in_series_changes_nothing() {
    let mut rng = Rng::new(15);
    for _ in 0..CASES {
        let c = linear(&mut rng, false, true);
        let mut a = c.lines.clone();
        a.push("VIN n1 0 AC 1".into());
        // Split the first resistor with a 0 V source.
        let r0: Vec<&str> = a[0].split_whitespace().collect();
        let mut b = a.clone();
        b[0] = format!("{} {} mid {}", r0[0], r0[1], r0[3]);
        b.push(format!("VZ mid {} 0", r0[2]));
        let out = format!("n{}", 1 + rng.below(c.nodes));
        let req = req_json(
            serde_json::json!({ "input": "VIN", "output": out, "freqs": FREQS, "rin": true, "rout": true, "verify": true }),
        );
        let (ra, rb) = (run(&netlist_text("a", &a), &req), run(&netlist_text("b", &b), &req));
        for i in 0..FREQS.len() {
            for q in ["gain", "rin", "rout"] {
                let (x, y) = (value(&ra, q, i), value(&rb, q, i));
                if x.0.is_finite() || y.0.is_finite() {
                    assert!(close(x, y, 1e-9), "{q}: {x:?} vs {y:?}\n{a:?}");
                }
            }
        }
    }
}

/// Every random circuit: exact KCL identity, numeric cross-check, simplified
/// error within tolerance, structured form consistent with the expansion.
#[test]
fn solver_self_checks_always_hold() {
    let mut rng = Rng::new(16);
    let mut solved = 0;
    for _ in 0..CASES {
        let controlled = rng.below(2) == 0;
        let c = linear(&mut rng, controlled, true);
        let mut lines = c.lines.clone();
        lines.push("VIN n1 0 AC 1".into());
        let net = netlist_text("self", &lines);
        let tol = *rng.pick(&[0.01, 0.05, 0.2]);
        let req = req_json(serde_json::json!({
            "input": "VIN", "output": format!("n{}", 1 + rng.below(c.nodes)), "freqs": FREQS,
            "rin": true, "rout": true, "verify": true, "tolerance": tol,
        }));
        let Some(r) = try_run(&net, &req) else { continue };
        solved += 1;
        assert_eq!(r["verify"]["kcl"], true, "{net}");
        for q in ["gain", "rin", "rout"] {
            if r[q]["infinite"] == true {
                continue;
            }
            assert_eq!(r[q]["check"]["ok"], true, "{q} check failed: {}\n{net}", r[q]["check"]);
            let s = &r[q]["simplified"];
            assert!(
                s["maxRelError"].as_f64().unwrap() <= tol,
                "{q} simplified error over tolerance\n{net}"
            );
            if s["same"] == true {
                assert_eq!(s["maxRelError"].as_f64().unwrap(), 0.0);
            }
        }
    }
    assert!(solved > CASES / 2, "only {solved} circuits solved");
}

fn eval_poly(p: &Poly, vals: &[f64], reactive: u128, s: Complex64) -> Complex64 {
    let mut acc = Complex64::new(0.0, 0.0);
    for (&m, &c) in &p.terms {
        let mut v = c as f64;
        for (i, val) in vals.iter().enumerate() {
            if m >> i & 1 == 1 {
                v *= val;
            }
        }
        acc += v * s.powu((m & reactive).count_ones());
    }
    acc
}

/// Gain num/den of a parsed circuit (MNA form), with its small-signal model.
fn gain_polys(text: &str, symbolic: bool, out: &str) -> Option<(SsCircuit, Poly, Poly)> {
    let net = netlist::parse(text).unwrap();
    let op = if symbolic {
        None
    } else {
        Some(dc::operating_point(&net).ok()?)
    };
    let ss = ss::build(&net, op.as_ref()).unwrap();
    let sys = ss::system(&net, &ss, &Excite::Source(net.element("VIN").unwrap()));
    let d = det::det(&sys.a, 1 << 22).unwrap();
    let col = sys.node_col[net.node(out).unwrap()]?;
    let n = sys.cramer(col, 1 << 22).unwrap();
    Some((ss, n, d))
}

#[test]
fn structured_notation_is_the_same_function() {
    // Tested directly (analyze also filters it), so a wrong rewrite is a
    // failure here rather than a silent fallback.
    let mut rng = Rng::new(17);
    let mut structured = 0;
    for case in 0..2 * CASES {
        // Half random networks, half transconductance stages loaded by
        // parallel R/C (where the ∥ form applies).
        let (text, out) = if case % 2 == 0 {
            let (controlled, reactive) = (rng.below(3) == 0, rng.below(2) == 0);
            let c = linear(&mut rng, controlled, reactive);
            let mut lines = c.lines.clone();
            lines.push("VIN n1 0 AC 1".into());
            (netlist_text("st", &lines), format!("n{}", 1 + rng.below(c.nodes)))
        } else {
            let mut lines = vec!["VIN in 0 AC 1".to_string(), "RIN in 0 1k".into()];
            lines.push(format!("G1 out 0 in 0 {:.6e}", rng.decade(1e-5, 1e-1)));
            for k in 0..1 + rng.below(4) {
                lines.push(format!(
                    "R{k} out {} {:.6e}",
                    if rng.below(4) == 0 { "in" } else { "0" },
                    rng.decade(10.0, 1e6)
                ));
            }
            for k in 0..rng.below(3) {
                lines.push(format!(
                    "C{k} out {} {:.6e}",
                    if rng.below(3) == 0 { "in" } else { "0" },
                    rng.decade(1e-15, 1e-9)
                ));
            }
            (netlist_text("gm", &lines), "out".to_string())
        };
        let Some((ss, n, d)) = gain_polys(&text, false, &out) else {
            continue;
        };
        if d.is_zero() {
            continue;
        }
        let sy = sym::unmerged(&ss);
        let x = |p: &Poly| sym::XPoly::from_poly(p, &sy.class, sy.syms.len()).unwrap();
        for (num, den) in [(&n, &d), (&d, &d)] {
            let Some(st) = structure::structure(&x(num), &x(den), &sy.syms) else {
                continue;
            };
            structured += 1;
            for _ in 0..3 {
                let vals: Vec<f64> = ss.params.iter().map(|_| rng.decade(0.1, 10.0)).collect();
                let mna: Vec<f64> = ss
                    .params
                    .iter()
                    .zip(&vals)
                    .map(|(p, v)| if p.inverted { 1.0 / v } else { *v })
                    .collect();
                let s = Complex64::new(rng.unit() - 0.5, rng.unit() * 3.0);
                let want = eval_poly(num, &mna, ss.reactive_mask, s) / eval_poly(den, &mna, ss.reactive_mask, s);
                let got = st.eval(&sy.syms, &vals, s);
                assert!(
                    (got - want).norm() <= 1e-9 * want.norm(),
                    "{} : {got} vs {want}\n{text}",
                    st.latex
                );
            }
        }
    }
    assert!(structured > CASES / 4, "structure applied only {structured} times");
}

#[test]
fn poles_are_roots_of_the_denominator() {
    let mut rng = Rng::new(18);
    for _ in 0..CASES {
        let c = linear(&mut rng, false, true);
        let mut lines = c.lines.clone();
        lines.push("VIN n1 0 AC 1".into());
        let text = netlist_text("poles", &lines);
        let Some((ss, n, d)) = gain_polys(&text, false, "n1") else {
            continue;
        };
        let sy = sym::unmerged(&ss);
        let x = |p: &Poly| sym::XPoly::from_poly(p, &sy.class, sy.syms.len()).unwrap();
        let e = render::Expr::from_mna(&x(&n), &x(&d), &sy.syms);
        let (_, dc) = e.s_coeffs();
        for p in roots::roots(&dc) {
            let (mut v, mut scale) = (Complex64::new(0.0, 0.0), 0.0);
            for (k, c) in dc.iter().enumerate() {
                v += c * p.powu(k as u32);
                scale += (c * p.powu(k as u32)).norm();
            }
            assert!(v.norm() <= 1e-7 * scale, "D({p}) = {v} (scale {scale})\n{text}");
        }
    }
}

// ---- Transistor circuits ----------------------------------------------------

/// A biased one- or two-transistor stage with random values. Returns the
/// netlist lines with polarity `pol` (+1 NMOS/NPN, −1 PMOS/PNP): every DC
/// voltage and every model polarity flips, so the small-signal circuit is the
/// same.
fn stage(rng: &mut Rng, pol: f64, kind: usize, vals: &[f64]) -> Vec<String> {
    let v = |x: f64| format!("{:.17e}", pol * x);
    let (m, q) = if pol > 0.0 { ("mn", "qn") } else { ("mp", "qp") };
    let _ = rng;
    let mut l = vec![
        format!("VDD vdd 0 {}", v(vals[0])),
        format!(
            ".model mn nmos (kp={:.6e} vto=0.5 lambda={:.4} gamma={:.4})",
            vals[4], vals[5], vals[6]
        ),
        format!(
            ".model mp pmos (kp={:.6e} vto=-0.5 lambda={:.4} gamma={:.4})",
            vals[4], vals[5], vals[6]
        ),
        ".model qn npn (is=1e-15 bf=120 vaf=60)".into(),
        ".model qp pnp (is=1e-15 bf=120 vaf=60)".into(),
    ];
    match kind {
        // Common source with degeneration and load cap.
        0 => l.extend([
            format!("VIN in 0 DC {} AC 1", v(vals[1])),
            format!("RD vdd out {:.6e}", vals[2]),
            format!("M1 out in s 0 {m} W=10u L=1u"),
            format!("RS s 0 {:.6e}", vals[3] * 0.05),
            "CL out 0 1p".into(),
        ]),
        // Source follower with body effect.
        1 => l.extend([
            format!("VIN in 0 DC {} AC 1", v(vals[1] + 0.6)),
            format!("M1 vdd in out 0 {m} W=10u L=1u"),
            format!("RL out 0 {:.6e}", vals[3]),
        ]),
        // Cascode.
        2 => l.extend([
            format!("VIN in 0 DC {} AC 1", v(vals[1])),
            format!("VB vb 0 {}", v(vals[1] + 0.5)),
            "M1 x in 0 0 MOD W=10u L=1u".replace("MOD", m),
            "M2 out vb x 0 MOD W=10u L=1u".replace("MOD", m),
            format!("RD vdd out {:.6e}", vals[2]),
        ]),
        // BJT common emitter with degeneration.
        _ => l.extend([
            format!("VIN in 0 DC {} AC 1", v(0.62 + 0.08 * vals[7])),
            format!("RC vdd out {:.6e}", vals[2] * 0.3),
            format!("Q1 out in e {q}"),
            format!("RE e 0 {:.6e}", vals[3] * 0.002),
            "CL out 0 1p".into(),
        ]),
    }
    l
}

/// Every MOSFET saturated (and not reversed), every BJT forward-active: the
/// regions symbolic mode assumes. ("saturation" is the right region for a
/// MOSFET but the wrong one for a BJT.)
fn region_ok(r: &Value) -> bool {
    r["op"]["devices"].as_object().is_some_and(|d| {
        d.values().all(|d| match d["type"].as_str() {
            Some("npn") | Some("pnp") => d["region"] == "forward-active",
            _ => d["region"] == "saturation" && d["reversed"] != true,
        })
    })
}

#[test]
fn nmos_and_pmos_mirror_images_agree() {
    let mut rng = Rng::new(19);
    let mut compared = 0;
    for _ in 0..CASES {
        let kind = rng.below(4);
        let vals = [
            1.5 + rng.unit() * 2.0,
            0.55 + rng.unit() * 0.4,
            rng.decade(1e3, 1e5),
            rng.decade(1e3, 1e5),
            rng.decade(50e-6, 500e-6),
            rng.unit() * 0.1,
            rng.unit() * 0.5,
            rng.unit(),
        ];
        let n = netlist_text("n", &stage(&mut rng, 1.0, kind, &vals));
        let p = netlist_text("p", &stage(&mut rng, -1.0, kind, &vals));
        let req = req_json(
            serde_json::json!({ "input": "VIN", "output": "out", "freqs": FREQS, "rin": true, "rout": true, "verify": true }),
        );
        let (rn, rp) = (run(&n, &req), run(&p, &req));
        assert_eq!(region_ok(&rn), region_ok(&rp), "regions differ\n{n}\n{p}");
        for (dn, dp) in rn["op"]["devices"]
            .as_object()
            .unwrap()
            .values()
            .zip(rp["op"]["devices"].as_object().unwrap().values())
        {
            for k in ["gm", "gds", "gmb", "gpi", "go"] {
                if let (Some(a), Some(b)) = (dn[k].as_f64(), dp[k].as_f64()) {
                    assert!(
                        (a - b).abs() <= 1e-9 * a.abs().max(b.abs()) + 1e-18,
                        "{k}: {a} vs {b}\n{n}"
                    );
                }
            }
        }
        for (i, f) in FREQS.iter().enumerate() {
            for q in ["gain", "rin", "rout"] {
                let (a, b) = (value(&rn, q, i), value(&rp, q, i));
                if a.0.is_finite() || b.0.is_finite() {
                    assert!(close(a, b, 1e-8), "{q} @{f}: {a:?} vs {b:?}\n{n}\n{p}");
                }
            }
        }
        compared += 1;
    }
    assert_eq!(compared, CASES);
}

#[test]
fn symbolic_mode_at_the_operating_point_equals_numeric_mode() {
    let mut rng = Rng::new(20);
    let mut compared = 0;
    for _ in 0..CASES {
        let kind = rng.below(4);
        let vals = [
            1.5 + rng.unit() * 2.0,
            0.55 + rng.unit() * 0.4,
            rng.decade(1e3, 1e5),
            rng.decade(1e3, 1e5),
            rng.decade(50e-6, 500e-6),
            0.01 + rng.unit() * 0.1,
            rng.unit() * 0.5,
            rng.unit(),
        ];
        let text = netlist_text("sym", &stage(&mut rng, 1.0, kind, &vals));
        let r = run(&text, &request("VIN", "out"));
        if !region_ok(&r) {
            continue;
        }
        let (nss, nn, nd) = gain_polys(&text, false, "out").unwrap();
        let (sss, sn, sd) = gain_polys(&text, true, "out").unwrap();
        // Symbolic parameters take the operating-point values by name; one
        // the numeric model omits (zero conductance) is 0 in MNA form.
        let mna_of = |name: &str| -> f64 {
            nss.params
                .iter()
                .find(|p| p.name == name)
                .map(|p| p.mna_value())
                .unwrap_or(0.0)
        };
        let svals: Vec<f64> = sss
            .params
            .iter()
            .map(|p| {
                if p.value.is_nan() {
                    mna_of(&p.name)
                } else {
                    p.mna_value()
                }
            })
            .collect();
        let nvals: Vec<f64> = nss.params.iter().map(|p| p.mna_value()).collect();
        for &f in &FREQS {
            let s = Complex64::new(0.0, 2.0 * std::f64::consts::PI * f);
            let want = eval_poly(&nn, &nvals, nss.reactive_mask, s) / eval_poly(&nd, &nvals, nss.reactive_mask, s);
            let got = eval_poly(&sn, &svals, sss.reactive_mask, s) / eval_poly(&sd, &svals, sss.reactive_mask, s);
            assert!(
                (got - want).norm() <= 1e-9 * want.norm(),
                "f={f}: {got} vs {want}\n{text}"
            );
        }
        compared += 1;
    }
    assert!(compared > CASES / 2, "only {compared} biased correctly");
}

#[test]
fn transistor_stages_pass_every_self_check() {
    let mut rng = Rng::new(21);
    for _ in 0..CASES {
        let kind = rng.below(4);
        let vals = [
            1.5 + rng.unit() * 2.0,
            0.3 + rng.unit() * 1.2,
            rng.decade(1e2, 1e6),
            rng.decade(1e2, 1e6),
            rng.decade(10e-6, 1e-3),
            rng.unit() * 0.2,
            rng.unit() * 0.8,
            rng.unit() * 3.0,
        ];
        let pol = if rng.below(2) == 0 { 1.0 } else { -1.0 };
        let text = netlist_text("st", &stage(&mut rng, pol, kind, &vals));
        let r = run(
            &text,
            &req_json(
                serde_json::json!({ "input": "VIN", "output": "out", "freqs": FREQS, "rin": true, "rout": true, "verify": true }),
            ),
        );
        assert_eq!(r["verify"]["kcl"], true, "{text}");
        for q in ["gain", "rin", "rout"] {
            if r[q]["infinite"] != true {
                assert_eq!(r[q]["check"]["ok"], true, "{q}\n{text}");
            }
        }
    }
}

#[test]
fn reordering_lines_finds_the_same_operating_point() {
    let mut rng = Rng::new(22);
    for _ in 0..CASES {
        let kind = rng.below(4);
        let vals = [
            1.5 + rng.unit() * 2.0,
            0.3 + rng.unit() * 1.2,
            rng.decade(1e2, 1e6),
            rng.decade(1e2, 1e6),
            rng.decade(10e-6, 1e-3),
            rng.unit() * 0.2,
            rng.unit() * 0.8,
            rng.unit() * 3.0,
        ];
        let mut lines = stage(&mut rng, 1.0, kind, &vals);
        let a = run(&netlist_text("a", &lines), &request("VIN", "out"));
        for i in (1..lines.len()).rev() {
            let j = rng.below(i + 1);
            lines.swap(i, j);
        }
        let b = run(&netlist_text("b", &lines), &request("VIN", "out"));
        for (k, va) in a["op"]["nodes"].as_object().unwrap() {
            let (x, y) = (va.as_f64().unwrap(), b["op"]["nodes"][k].as_f64().unwrap());
            assert!(
                (x - y).abs() <= 1e-9 * x.abs().max(1.0),
                "node {k}: {x} vs {y}\n{lines:?}"
            );
        }
    }
}

// ---- Two-source drive and matching ------------------------------------------

/// v_out = A_d·(v₊ − v₋) + A_cm·(v₊ + v₋)/2, so with single-source gains G₊ and
/// G₋: A_d = (G₊ − G₋)/2 and A_cm = G₊ + G₋.
#[test]
fn differential_and_common_mode_follow_superposition() {
    let mut rng = Rng::new(31);
    let mut compared = 0;
    for _ in 0..CASES {
        let controlled = rng.below(2) == 0;
        let c = linear(&mut rng, controlled, true);
        let k = 2 + rng.below(c.nodes.max(2) - 1);
        let mut lines = c.lines.clone();
        lines.push("VIN n1 0 AC 1".into());
        lines.push(format!("VIN2 n{k} 0 AC 1"));
        let net = netlist_text("two", &lines);
        let out = format!("n{}", 1 + rng.below(c.nodes));
        let q = |extra: Value| {
            let mut base = serde_json::json!({ "input": "VIN", "output": out, "freqs": FREQS });
            base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            try_run(&net, &req_json(base))
        };
        let (Some(gp), Some(gn)) = (q(serde_json::json!({})), q(serde_json::json!({ "input": "VIN2" }))) else {
            continue;
        };
        let (Some(dm), Some(cm)) = (
            q(serde_json::json!({ "inputNeg": "VIN2" })),
            q(serde_json::json!({ "inputNeg": "VIN2", "mode": "common" })),
        ) else {
            continue;
        };
        for i in 0..FREQS.len() {
            let (p, n) = (value(&gp, "gain", i), value(&gn, "gain", i));
            let ad = ((p.0 - n.0) / 2.0, (p.1 - n.1) / 2.0);
            let acm = (p.0 + n.0, p.1 + n.1);
            let scale = (p.0.hypot(p.1) + n.0.hypot(n.1)).max(1e-300);
            let near = |a: (f64, f64), b: (f64, f64)| (a.0 - b.0).hypot(a.1 - b.1) <= 1e-9 * scale;
            assert!(near(value(&dm, "gain", i), ad), "A_d\n{net}");
            assert!(near(value(&cm, "gain", i), acm), "A_cm\n{net}");
            assert_eq!(dm["gain"]["check"]["ok"], true, "{net}");
        }
        compared += 1;
    }
    assert!(compared > CASES / 3, "only {compared} compared");
}

/// Symmetric stages with random values: merging every reported candidate
/// leaves every value unchanged and passes the cross-check.
#[test]
fn matching_candidates_never_changes_values() {
    let mut rng = Rng::new(32);
    let mut merged = 0;
    for _ in 0..CASES {
        let (vdd, vcm) = (1.5 + rng.unit() * 1.5, 0.8 + rng.unit() * 0.4);
        let (rd, w, l, kp, lam) = (
            rng.decade(1e3, 5e4),
            rng.decade(2e-6, 50e-6),
            rng.decade(0.2e-6, 2e-6),
            rng.decade(50e-6, 400e-6),
            rng.unit() * 0.15,
        );
        let tail = rng.decade(10e-6, 300e-6);
        let mos_load = rng.below(2) == 0;
        let load = if mos_load {
            format!("M3 o1 o1 vdd vdd mp W={w:.4e} L={l:.4e}\nM4 o2 o1 vdd vdd mp W={w:.4e} L={l:.4e}\n")
        } else {
            format!("RD1 vdd o1 {rd:.6e}\nRD2 vdd o2 {rd:.6e}\nCL1 o1 0 1p\nCL2 o2 0 1p\n")
        };
        let net = format!(
            "pair\nVDD vdd 0 {vdd}\nVIP inp 0 DC {vcm} AC 1\nVINN inn 0 DC {vcm}\nIT tail 0 {tail:.6e}\n\
             M1 o1 inp tail 0 mn W={w:.4e} L={l:.4e}\nM2 o2 inn tail 0 mn W={w:.4e} L={l:.4e}\n{load}\
             .model mn nmos (kp={kp:.6e} vto=0.5 lambda={lam:.4} gamma=0.3)\n.model mp pmos (kp={kp:.6e} vto=-0.5 lambda={lam:.4})\n"
        );
        let base =
            serde_json::json!({ "input": "VIP", "inputNeg": "VINN", "output": "o2", "freqs": FREQS, "rout": true });
        let Some(plain) = try_run(&net, &req_json(base.clone())) else {
            continue;
        };
        let groups: Vec<Value> = plain["matchCandidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["elements"].clone())
            .collect();
        if groups.is_empty() {
            continue;
        }
        let mut with = base.clone();
        with["match"] = Value::Array(groups);
        let m = run(&net, &req_json(with));
        assert!(
            m["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .all(|w| !w.as_str().unwrap().contains("not merged")),
            "{}",
            m["warnings"]
        );
        for q in ["gain", "rout"] {
            for i in 0..FREQS.len() {
                assert!(close(value(&plain, q, i), value(&m, q, i), 1e-9), "{q}\n{net}");
            }
            assert_eq!(m[q]["check"]["ok"], true, "{q}\n{net}");
        }
        assert!(m["params"].as_array().unwrap().len() < plain["params"].as_array().unwrap().len());
        merged += 1;
    }
    assert!(merged > CASES / 2, "only {merged} merged");
}
