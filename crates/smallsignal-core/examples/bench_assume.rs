//! Assumptions on a large circuit: the µA741 (oracle/corpus/ua741.cir)
//! with no assumption, with r_o and r_μ of every BJT ignored, and with r_π
//! ignored too. Prints each quantity's term counts, its distance from the
//! full model, and the time.
//! Run: cargo run --release -p smallsignal-core --example bench_assume [netlist]
use serde_json::{json, Value};
use smallsignal_core::{analyze, Request};
use std::time::Instant;

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/../../oracle/corpus/ua741.cir").to_string());
    let text = std::fs::read_to_string(&path).expect("netlist");
    let bjts: Vec<String> = text
        .lines()
        .filter(|l| l.starts_with(['Q', 'q']))
        .map(|l| l.split_whitespace().next().unwrap().to_string())
        .collect();
    let set = |terms: &[&str]| -> Value {
        let ignore: Vec<Value> = bjts
            .iter()
            .flat_map(|q| terms.iter().map(move |t| json!({ "element": q, "term": t })))
            .collect();
        json!({ "ignore": ignore })
    };
    for (label, assume) in [
        ("none", Value::Null),
        ("ro + rmu", set(&["ro", "rmu"])),
        ("ro + rmu + rpi", set(&["ro", "rmu", "rpi"])),
    ] {
        let req: Request = serde_json::from_value(json!({
            "input": "VINP", "output": "OUT", "freqs": [1, 1e3, 1e6],
            "rin": true, "rout": true, "assume": assume,
        }))
        .unwrap();
        let t = Instant::now();
        let v = analyze(&text, &req);
        let dt = t.elapsed().as_secs_f64();
        println!("{label}: {dt:.2} s");
        let v = match v {
            Ok(v) => v,
            Err(e) => {
                println!("  error: {e}");
                continue;
            }
        };
        println!("  params {}", v["params"].as_array().map(Vec::len).unwrap_or(0));
        for q in ["gain", "rin", "rout"] {
            let g = &v[q];
            let terms = |f: &str| {
                let t = &g[f]["terms"];
                if t.is_null() {
                    "-".to_string()
                } else {
                    format!("{}/{}", t["num"], t["den"])
                }
            };
            let restored: Vec<String> = g["assumed"]["restored"]
                .as_array()
                .map(|r| {
                    r.iter()
                        .map(|x| format!("{}:{}", x["element"].as_str().unwrap(), x["term"].as_str().unwrap()))
                        .collect()
                })
                .unwrap_or_default();
            println!(
                "  {q}: exact {} display {} simplified {} skipped {} fullModelError {} (simplified {}) restored {:?}",
                terms("exact"),
                terms("display"),
                terms("simplified"),
                g["skipped"],
                g["exact"]["fullModelError"],
                g["simplified"]["fullModelError"],
                restored
            );
            if let Some(s) = g["simplified"]["latex"].as_str() {
                println!("    simplified: {s}");
            }
        }
    }
}
