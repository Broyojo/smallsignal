//! Panic-freedom fuzz: garbage, random and mutated netlists with random
//! requests. `analyze_json` must never panic or hang, and must always return
//! a JSON object holding either a result or an `error`.
//!
//! Cases: 100k in release, 2k in debug; override with SMALLSIGNAL_FUZZ_CASES.

mod common;

use common::Rng;
use serde_json::Value;
use smallsignal_core::analyze_json;
use std::panic;
use std::sync::Mutex;
use std::time::{Duration, Instant};

static LAST_PANIC: Mutex<String> = Mutex::new(String::new());

const ALPHABET: &[&str] = &[
    "R", "C", "L", "V", "I", "E", "G", "F", "H", "M", "Q", "D", "X", "r", "m", "q", "1", "2", "0", "9", " ", " ", " ",
    "\n", "\n", "\t", "=", "(", ")", ",", ";", "$", "*", "+", "-", ".", "e", "k", "meg", "u", "p", "f", "µ", "é", "中",
    "🔥", "{", "}", "\\", "^", "_", "&", "#", "%", "~", ".model", ".end", ".options", "nmos", "pmos", "npn", "d",
    "level", "dc", "ac", "sin", "gnd", "out", "in",
];

const VALUES: &[&str] = &[
    "1",
    "10k",
    "1meg",
    "2.2u",
    "1p",
    "0",
    "-1",
    "-10k",
    "1e308",
    "1e-308",
    "1e400",
    "-1e400",
    "1e-400",
    "nan",
    "inf",
    "NaN",
    "1e",
    ".",
    "-",
    "1..2",
    "1e+",
    "0.0000001f",
    "999999999999999999999",
    "1k1k",
    "",
    "=",
    "1.8v",
];

const NODES: &[&str] = &["0", "gnd", "in", "out", "a", "b", "c", "vdd", "x", "OUT", "In", "n_1"];

const SEEDS: &[&str] = &[
    "cs\nVDD vdd 0 1.8\nVIN in 0 DC 0.7 AC 1\nRD vdd out 10k\nM1 out in 0 0 nm W=10u L=1u\nCL out 0 1p\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1)\n.end\n",
    "ce\nVCC vcc 0 5\nVIN in 0 0.65\nRC vcc out 2k\nQ1 out in 0 qn\n.model qn npn is=1e-15 bf=100 vaf=50\n",
    "rlc\nVIN in 0 AC 1\nR1 in a 50\nL1 a out 1u\nC1 out 0 1n\nR2 out 0 1k\n",
    "ctl\nVIN in 0 1\nVS in a 0\nR1 a 0 1k\nF1 out 0 VS 2\nH1 b 0 VS 100\nE1 c 0 b 0 3\nG1 out 0 c 0 1m\nR2 out 0 1k\nR3 b 0 1k\nR4 c 0 1k\n",
    "diode\nVIN in 0 1\nR1 in out 1k\nD1 out 0 dm\n.model dm d is=1e-14 n=1.5\n",
    "pmos\nVDD vdd 0 1.8\nVIN in 0 1.1\nM1 out in vdd vdd pm W=10u L=1u\nRD out 0 10k\n.model pm pmos kp=100u vto=-0.5 lambda=0.05\n",
    "sym\nVIN in 0\nRD vdd out\nM1 out in 0 0\nVDD vdd 0\n",
    "isrc\nIIN 0 in DC 1u AC 1\nR1 in 0 1k\nC1 in out 1p\nR2 out 0 1k\n",
];

fn garbage(rng: &mut Rng) -> String {
    let n = rng.below(200);
    (0..n).map(|_| *rng.pick(ALPHABET)).collect()
}

const GOOD: &[&str] = &[
    "1", "10k", "1meg", "2.2u", "1p", "100", "0.5", "1.8", "3", "47n", "1e-3", "250",
];

fn value(rng: &mut Rng) -> &'static str {
    if rng.below(10) == 0 {
        rng.pick(VALUES)
    } else {
        rng.pick(GOOD)
    }
}

/// Mostly well-formed circuits (right arity, plausible values) with an
/// occasional absurd value, so the solver itself gets exercised.
fn random_netlist(rng: &mut Rng) -> String {
    let mut s = String::from("random\n");
    let mut vsrc: Vec<String> = Vec::new();
    let n = 1 + rng.below(10);
    let node = |rng: &mut Rng| *rng.pick(NODES);
    for i in 0..n {
        let i = if rng.below(8) == 0 {
            format!("{i}{}", rng.pick(&["{x}", "\\a", "^2", "_b", "$c", "}{", "&#%~"]))
        } else {
            i.to_string()
        };
        let line = match rng.below(13) {
            0..=2 => format!("R{i} {} {} {}", node(rng), node(rng), value(rng)),
            3 => format!("C{i} {} {} {}", node(rng), node(rng), value(rng)),
            4 => format!("L{i} {} {} {}", node(rng), node(rng), value(rng)),
            5 | 6 => {
                vsrc.push(format!("V{i}"));
                format!("V{i} {} {} DC {} AC 1", node(rng), node(rng), value(rng))
            }
            7 => format!("I{i} {} {} DC {}", node(rng), node(rng), value(rng)),
            8 => format!(
                "E{i} {} {} {} {} {}",
                node(rng),
                node(rng),
                node(rng),
                node(rng),
                value(rng)
            ),
            9 => format!(
                "G{i} {} {} {} {} {}",
                node(rng),
                node(rng),
                node(rng),
                node(rng),
                value(rng)
            ),
            10 if !vsrc.is_empty() => {
                let c = rng.pick(&vsrc).clone();
                format!(
                    "{}{i} {} {} {c} {}",
                    rng.pick(&["F", "H"]),
                    node(rng),
                    node(rng),
                    value(rng)
                )
            }
            10 | 11 => format!(
                "M{i} {} {} {} {} m{} W={} L={}",
                node(rng),
                node(rng),
                node(rng),
                node(rng),
                rng.pick(&["nmos", "pmos"]),
                value(rng),
                value(rng)
            ),
            _ => match rng.below(2) {
                0 => format!(
                    "Q{i} {} {} {} m{}",
                    node(rng),
                    node(rng),
                    node(rng),
                    rng.pick(&["npn", "pnp"])
                ),
                _ => format!("D{i} {} {} md", node(rng), node(rng)),
            },
        };
        s.push_str(&line);
        s.push('\n');
    }
    // Usually give every node a DC path so more circuits solve.
    if rng.below(3) != 0 {
        for (k, nd) in NODES.iter().enumerate().skip(2) {
            if s.contains(&format!(" {nd} ")) || s.contains(&format!(" {nd}\n")) {
                s.push_str(&format!("RG{k} {nd} 0 1meg\n"));
            }
        }
    }
    let p = |rng: &mut Rng, good: &'static str| if rng.below(15) == 0 { *rng.pick(VALUES) } else { good };
    s.push_str(&format!(
        ".model mnmos nmos (kp={} vto={} lambda={} gamma={})\n",
        p(rng, "200u"),
        p(rng, "0.5"),
        p(rng, "0.05"),
        p(rng, "0.3")
    ));
    s.push_str(&format!(
        ".model mpmos pmos (kp={} vto={} lambda={})\n",
        p(rng, "100u"),
        p(rng, "-0.5"),
        p(rng, "0.05")
    ));
    s.push_str(&format!(
        ".model mnpn npn (is={} bf={} vaf={})\n",
        p(rng, "1e-15"),
        p(rng, "100"),
        p(rng, "50")
    ));
    s.push_str(&format!(
        ".model mpnp pnp (is={} bf={})\n",
        p(rng, "1e-15"),
        p(rng, "50")
    ));
    s.push_str(&format!(".model md d (is={} n={})\n", p(rng, "1e-14"), p(rng, "1")));
    s
}

fn mutate(rng: &mut Rng, base: &str) -> String {
    let mut lines: Vec<String> = base.lines().map(str::to_string).collect();
    for _ in 0..1 + rng.below(4) {
        if lines.is_empty() {
            break;
        }
        let i = rng.below(lines.len());
        match rng.below(8) {
            0 => {
                lines.remove(i);
            }
            1 => {
                let l = lines[i].clone();
                lines.insert(i, l);
            }
            2 => {
                let j = rng.below(lines.len());
                lines.swap(i, j);
            }
            3 => {
                let mut toks: Vec<String> = lines[i].split_whitespace().map(str::to_string).collect();
                if !toks.is_empty() {
                    let k = rng.below(toks.len());
                    toks[k] = rng.pick(VALUES).to_string();
                }
                lines[i] = toks.join(" ");
            }
            4 => {
                let mut toks: Vec<String> = lines[i].split_whitespace().map(str::to_string).collect();
                if !toks.is_empty() {
                    toks.truncate(rng.below(toks.len()));
                }
                lines[i] = toks.join(" ");
            }
            5 => lines.insert(i, garbage(rng)),
            6 => {
                let chars: Vec<char> = lines[i].chars().collect();
                let k = rng.below(chars.len() + 1);
                lines[i] = chars[..k].iter().collect();
            }
            _ => {
                let mut toks: Vec<String> = lines[i].split_whitespace().map(str::to_string).collect();
                let k = rng.below(toks.len() + 1);
                toks.insert(k, rng.pick(NODES).to_string());
                lines[i] = toks.join(" ");
            }
        }
    }
    lines.join("\n")
}

fn huge(rng: &mut Rng) -> String {
    // A long resistor ladder: exercises the size guards.
    let n = 50 + rng.below(400);
    let mut s = String::from("ladder\nVIN n0 0 1\n");
    for i in 0..n {
        s.push_str(&format!("R{i}a n{i} n{} 1k\nR{i}b n{} 0 1k\n", i + 1, i + 1));
    }
    s
}

fn request(rng: &mut Rng, net: &str) -> String {
    let names: Vec<&str> = net
        .lines()
        .skip(1)
        .filter(|l| !l.starts_with('.'))
        .filter_map(|l| l.split_whitespace().next())
        .collect();
    let sources: Vec<&str> = names
        .iter()
        .copied()
        .filter(|n| n.starts_with(['V', 'I', 'v', 'i']))
        .collect();
    let input = match rng.below(10) {
        0..=6 if !sources.is_empty() => rng.pick(&sources).to_string(),
        0..=7 if !names.is_empty() => rng.pick(&names).to_string(),
        _ => rng.pick(&["V1", "VIN", "IIN", "R1", "", "nope"]).to_string(),
    };
    let used: Vec<&str> = net
        .lines()
        .skip(1)
        .filter(|l| !l.starts_with('.'))
        .flat_map(|l| l.split_whitespace().skip(1).take(4))
        .filter(|t| NODES.contains(t))
        .collect();
    let output = if !used.is_empty() && rng.below(5) != 0 {
        *rng.pick(&used)
    } else {
        *rng.pick(NODES)
    };
    let reference = match rng.below(4) {
        0 => format!(",\"ref\":\"{}\"", rng.pick(NODES)),
        1 => ",\"ref\":null".to_string(),
        _ => String::new(),
    };
    let freqs = *rng.pick(&["[]", "[1000]", "[0, 1e3, 1e9]", "[-5, 1e300]", "[1e-300]"]);
    let tol = *rng.pick(&["0.05", "0", "-1", "1e9", "1"]);
    let flag = |rng: &mut Rng| if rng.below(2) == 0 { "true" } else { "false" };
    let (rin, rout) = (flag(rng), flag(rng));
    let verify = if rng.below(10) == 0 { "true" } else { "false" };
    let symbolic = if rng.below(8) == 0 { "true" } else { "false" };
    let input = serde_json::to_string(&input).unwrap();
    let output = serde_json::to_string(&output).unwrap();
    format!(
        "{{\"input\":{input},\"output\":{output}{reference},\"freqs\":{freqs},\"rin\":{rin},\"rout\":{rout},\
         \"tolerance\":{tol},\"verify\":{verify},\"symbolic\":{symbolic}}}"
    )
}

/// Outcome label for coverage statistics: "ok" or the error's first words.
fn outcome(out: &Value) -> String {
    match out.get("error").and_then(Value::as_str) {
        None => "ok".to_string(),
        Some(e) => {
            let e = e
                .split_once(": ")
                .map(|(a, b)| if a.starts_with("line") { b } else { e })
                .unwrap_or(e);
            e.split_whitespace().take(4).collect::<Vec<_>>().join(" ")
        }
    }
}

/// Unescaped braces in a TeX string must balance.
fn balanced(tex: &str) -> bool {
    let mut depth = 0i32;
    let mut chars = tex.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                chars.next();
            }
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

fn tex_ok(v: &Value) -> Result<(), String> {
    match v {
        Value::Object(o) => {
            for (k, x) in o {
                if k.starts_with("latex") {
                    if let Some(t) = x.as_str() {
                        if !balanced(t) {
                            return Err(format!("unbalanced TeX in {k}: {t}"));
                        }
                    }
                }
                tex_ok(x)?;
            }
            Ok(())
        }
        Value::Array(a) => a.iter().try_for_each(tex_ok),
        _ => Ok(()),
    }
}

fn check(net: &str, req: &str) -> Result<(Duration, String), String> {
    let t = Instant::now();
    let out = panic::catch_unwind(|| analyze_json(net, req))
        .map_err(|_| format!("panicked: {}", LAST_PANIC.lock().map(|s| s.clone()).unwrap_or_default()))?;
    let elapsed = t.elapsed();
    let v: Value = serde_json::from_str(&out).map_err(|e| format!("invalid JSON ({e}): {out}"))?;
    let obj = v.as_object().ok_or("response is not an object")?;
    if !obj.contains_key("error") && !obj.contains_key("gain") {
        return Err(format!("neither error nor gain: {out}"));
    }
    tex_ok(&v)?;
    Ok((elapsed, outcome(&v)))
}

#[test]
fn analyze_json_never_panics() {
    let cases: usize = std::env::var("SMALLSIGNAL_FUZZ_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(if cfg!(debug_assertions) { 2_000 } else { 100_000 });
    panic::set_hook(Box::new(|info| {
        if let Ok(mut last) = LAST_PANIC.lock() {
            *last = info.to_string();
        }
    }));
    let mut rng = Rng::new(0x5EED_F00D);
    let mut slowest = (Duration::ZERO, String::new());
    let mut failures = Vec::new();
    let mut stats: std::collections::BTreeMap<String, usize> = Default::default();
    for case in 0..cases {
        let net = match rng.below(10) {
            0..=1 => garbage(&mut rng),
            2..=4 => random_netlist(&mut rng),
            5 if case % 50 == 0 => huge(&mut rng),
            5 => String::new(),
            _ => {
                let seed = *rng.pick(SEEDS);
                mutate(&mut rng, seed)
            }
        };
        let req = if rng.below(50) == 0 {
            garbage(&mut rng)
        } else {
            request(&mut rng, &net)
        };
        match check(&net, &req) {
            Ok((t, label)) => {
                *stats.entry(label).or_default() += 1;
                if t > slowest.0 {
                    slowest = (t, net.chars().take(300).collect());
                }
            }
            Err(e) => {
                failures.push(format!(
                    "case {case}: {e}\n--- netlist ---\n{net}\n--- request ---\n{req}"
                ));
                if failures.len() >= 5 {
                    break;
                }
            }
        }
    }
    let _ = panic::take_hook();
    let mut top: Vec<_> = stats.iter().collect();
    top.sort_by(|a, b| b.1.cmp(a.1));
    eprintln!("fuzz outcomes ({cases} cases, slowest {:?}):", slowest.0);
    for (label, n) in top.iter().take(25) {
        eprintln!("  {n:7}  {label}");
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
    assert!(
        slowest.0 < Duration::from_secs(if cfg!(debug_assertions) { 60 } else { 5 }),
        "slowest case took {:?}:\n{}",
        slowest.0,
        slowest.1
    );
}
