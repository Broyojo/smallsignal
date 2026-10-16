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
