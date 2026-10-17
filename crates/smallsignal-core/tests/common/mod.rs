//! Shared helpers for the integration tests: a seeded RNG and a JSON helper.
#![allow(dead_code)]

use serde_json::Value;
use smallsignal_core::{analyze, Request};

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed.max(1))
    }

    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }

    pub fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len())]
    }

    /// Uniform in [0, 1).
    pub fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Log-uniform in [lo, hi].
    pub fn decade(&mut self, lo: f64, hi: f64) -> f64 {
        (lo.ln() + self.unit() * (hi.ln() - lo.ln())).exp()
    }
}

/// Built through serde so new optional request fields don't break the tests.
pub fn request(input: &str, output: &str) -> Request {
    serde_json::from_value(serde_json::json!({ "input": input, "output": output, "freqs": [1e3] })).unwrap()
}

pub fn run(net: &str, req: &Request) -> Value {
    match analyze(net, req) {
        Ok(v) => v,
        Err(e) => panic!("analyze failed: {e}\n{net}"),
    }
}

pub fn run_err(net: &str, req: &Request) -> String {
    match analyze(net, req) {
        Ok(v) => panic!("expected an error, got {v}\n{net}"),
        Err(e) => e,
    }
}

/// Complex value of a quantity at the i-th requested frequency.
pub fn value(v: &Value, q: &str, i: usize) -> (f64, f64) {
    let p = &v[q]["values"][i];
    (
        p["re"].as_f64().unwrap_or(f64::NAN),
        p["im"].as_f64().unwrap_or(f64::NAN),
    )
}

pub fn close(a: (f64, f64), b: (f64, f64), rtol: f64) -> bool {
    let d = ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt();
    let s = (a.0.powi(2) + a.1.powi(2))
        .sqrt()
        .max((b.0.powi(2) + b.1.powi(2)).sqrt());
    d <= rtol * s + 1e-300
}

fn complex(p: &Value) -> Option<(f64, f64)> {
    Some((p["re"].as_f64()?, p["im"].as_f64()?))
}

fn dist(a: (f64, f64), b: (f64, f64)) -> f64 {
    (a.0 - b.0).hypot(a.1 - b.1)
}

/// Each exact root matched one-to-one to a numeric one within `rel`; returns
/// the numeric roots left over.
fn match_roots(want: &[Value], got: &[Value], rel: f64) -> Result<Vec<(f64, f64)>, String> {
    let mut left: Vec<(f64, f64)> = got.iter().filter_map(complex).collect();
    let size = |z: (f64, f64)| z.0.hypot(z.1);
    for w in want.iter().filter_map(complex) {
        let best = (0..left.len()).min_by(|&i, &j| dist(left[i], w).total_cmp(&dist(left[j], w)));
        match best {
            Some(i) if dist(left[i], w) <= rel * size(left[i]).max(size(w)) + 1e-9 => {
                left.remove(i);
            }
            _ => return Err(format!("root {w:?} not among {left:?}")),
        }
    }
    Ok(left)
}

/// Compares a response whose quantities took the numeric path (over the term
/// budget) with the exact path's: values within the exact path's own
/// LU-vs-exact difference (the numeric values are that LU solve) plus 1e-8,
/// poles and zeros within `rel`. The exact form's common factors are
/// cancelled (GCD); the numeric roots keep them, as an exact form too large
/// for the GCD does, so extra roots must come in coinciding pole/zero pairs.
/// Returns how many quantities were numeric, and the failures.
pub fn numeric_matches_exact(name: &str, exact: &Value, numeric: &Value, rel: f64) -> (usize, Vec<String>) {
    let mut checked = 0;
    let mut failures = Vec::new();
    for q in ["gain", "rin", "rout"] {
        let (Some(e), Some(n)) = (exact.get(q), numeric.get(q)) else {
            continue;
        };
        if n["skipped"].is_null() {
            // Fits even in the smaller budget (e.g. a lone resistor).
            continue;
        }
        assert!(n["exact"].is_null() && n["simplified"].is_null(), "{name} {q}: {n}");
        checked += 1;
        if e["infinite"] != n["infinite"] {
            failures.push(format!("{name} {q}: infinite {} vs {}", e["infinite"], n["infinite"]));
            continue;
        }
        // Counted as the exact path counts them (the degree in s), here
        // with no common factor cancelled; an infinite quantity has none.
        let counted: &[(&str, &str)] = if n["infinite"] == true {
            &[]
        } else {
            &[("poleCount", "poles"), ("zeroCount", "zeros")]
        };
        for &(count, list) in counted {
            if n[count].as_u64() != n[list].as_array().map(|l| l.len() as u64) {
                failures.push(format!("{name} {q}: {count} {} vs {}", n[count], n[list]));
            }
        }
        let floor = if q == "gain" { 1e-12 } else { 1e-9 };
        let lu = e["check"]["maxRelDiff"].as_f64().unwrap_or(0.0);
        let values = |v: &Value| v["values"].as_array().cloned().unwrap_or_default();
        for (pe, pn) in values(e).iter().zip(&values(n)) {
            match (complex(pe), complex(pn)) {
                (Some(a), Some(b)) => {
                    let scale = a.0.hypot(a.1).max(b.0.hypot(b.1));
                    if dist(a, b) > (1e-8 + 1.01 * lu) * scale + floor {
                        failures.push(format!("{name} {q} at {}: {a:?} vs {b:?}", pe["f"]));
                    }
                }
                (None, None) => {}
                (a, b) => failures.push(format!("{name} {q} at {}: {a:?} vs {b:?}", pe["f"])),
            }
        }
        let list = |v: &Value, k: &str| v[k].as_array().cloned().unwrap_or_default();
        match (
            match_roots(&list(e, "poles"), &list(n, "poles"), rel),
            match_roots(&list(e, "zeros"), &list(n, "zeros"), rel),
        ) {
            (Ok(mut poles), Ok(zeros)) => {
                for z in zeros {
                    match poles
                        .iter()
                        .position(|&p| dist(p, z) <= rel * p.0.hypot(p.1).max(z.0.hypot(z.1)))
                    {
                        Some(i) => {
                            poles.remove(i);
                        }
                        None => failures.push(format!("{name} {q}: extra zero {z:?}")),
                    }
                }
                if !poles.is_empty() {
                    failures.push(format!("{name} {q}: extra poles {poles:?}"));
                }
            }
            (p, z) => failures.push(format!("{name} {q}: poles {p:?} zeros {z:?}")),
        }
    }
    (checked, failures)
}
