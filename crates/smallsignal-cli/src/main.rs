//! `smallsignal analyze <netlist> --input VIN --output out[:ref] [--freq 1,1k]
//! [--rin] [--rout] [--noise] [--noise-band 1,1meg] [--ignore M1:ro] [--region M3:triode] [--suggest gain:0.01] [--tol 0.05]
//! [--verify] [--pretty]`

use smallsignal_core::{analyze, Request};
use std::process::ExitCode;

const USAGE: &str = "usage: smallsignal analyze <netlist> --input <source> --output <node>[:<ref>] \
[--input-neg <source>] [--mode differential|common] [--match M1,M2;M3,M4] [--match-auto] \
[--freq f1,f2,...] [--rin] [--rout] [--noise] [--noise-band fLow,fHigh] [--nonlinear M1,Q2] [--order 2|3] [--amplitude a] \
[--ignore M1:ro,C1:short] [--region M3:triode] [--suggest gain|rin|rout[:threshold]] [--tol x] [--verify] [--symbolic] [--max-terms n] [--certificate] [--pretty]";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            println!("{}", serde_json::json!({ "error": e }));
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("analyze") || args.len() < 2 {
        return Err(USAGE.to_string());
    }
    let path = &args[1];
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let mut req: Request = serde_json::from_value(serde_json::json!({ "input": "", "output": "" })).unwrap();
    let mut pretty = false;
    let mut certificate = false;
    let mut it = args[2..].iter();
    let value =
        |it: &mut std::slice::Iter<String>, flag: &str| it.next().cloned().ok_or(format!("{flag} needs a value"));
    while let Some(a) = it.next() {
        match a.as_str() {
            "--input" => req.input = value(&mut it, a)?,
            "--output" => {
                let v = value(&mut it, a)?;
                match v.split_once(':') {
                    Some((o, r)) => {
                        req.output = o.to_string();
                        req.reference = Some(r.to_string());
                    }
                    None => req.output = v,
                }
            }
            "--freq" => {
                for f in value(&mut it, a)?.split(',') {
                    req.freqs
                        .push(smallsignal_core::units::parse_value(f).ok_or(format!("bad frequency '{f}'"))?);
                }
            }
            "--tol" => req.tolerance = Some(value(&mut it, a)?.parse().map_err(|_| "bad --tol")?),
            "--max-terms" => req.max_terms = Some(value(&mut it, a)?.parse().map_err(|_| "bad --max-terms")?),
            "--rin" => req.rin = true,
            "--rout" => req.rout = true,
            "--verify" => req.verify = true,
            "--symbolic" => req.symbolic = true,
            "--input-neg" => req.input_neg = Some(value(&mut it, a)?),
            "--mode" => req.mode = Some(value(&mut it, a)?),
            "--match-auto" => req.match_auto = true,
            "--match" => {
                for group in value(&mut it, a)?.split(';') {
                    let names: Vec<String> = group
                        .split(',')
                        .map(|n| n.trim().to_string())
                        .filter(|n| !n.is_empty())
                        .collect();
                    if !names.is_empty() {
                        req.matched.push(names);
                    }
                }
            }
            "--noise" => req.noise = true,
            "--noise-band" => {
                let v = value(&mut it, a)?;
                let parts: Vec<f64> = v
                    .split(',')
                    .map(|f| smallsignal_core::units::parse_value(f).ok_or(format!("bad frequency '{f}'")))
                    .collect::<Result<_, _>>()?;
                let [lo, hi] = parts[..] else {
                    return Err("--noise-band needs fLow,fHigh".to_string());
                };
                req.noise = true;
                req.noise_band = Some([lo, hi]);
            }
            "--nonlinear" => {
                req.nonlinear = value(&mut it, a)?
                    .split(',')
                    .map(|n| n.trim().to_string())
                    .filter(|n| !n.is_empty())
                    .collect()
            }
            "--order" => req.order = Some(value(&mut it, a)?.parse().map_err(|_| "bad --order")?),
            "--amplitude" => {
                let v = value(&mut it, a)?;
                req.amplitude = Some(smallsignal_core::units::parse_value(&v).ok_or(format!("bad amplitude '{v}'"))?);
            }
            // ELEMENT:TERM pairs: terms neglected, and regions expected.
            "--ignore" | "--region" => {
                let assume = req.assume.get_or_insert_with(Default::default);
                for item in value(&mut it, a)?.split(',').map(str::trim).filter(|x| !x.is_empty()) {
                    let (element, what) = item.split_once(':').ok_or(format!(
                        "{a} needs ELEMENT:{}",
                        if a == "--ignore" { "TERM" } else { "REGION" }
                    ))?;
                    let (element, what) = (element.to_string(), what.to_string());
                    if a == "--ignore" {
                        assume
                            .ignore
                            .push(smallsignal_core::assume::IgnoreRequest { element, term: what });
                    } else {
                        assume
                            .regions
                            .push(smallsignal_core::assume::RegionRequest { element, region: what });
                    }
                }
            }
            // QUANTITY[:THRESHOLD]: further assumptions within the threshold.
            "--suggest" => {
                let v = value(&mut it, a)?;
                let (quantity, threshold) = match v.split_once(':') {
                    Some((q, t)) => (
                        q,
                        Some(t.trim().parse().map_err(|_| format!("bad --suggest threshold '{t}'"))?),
                    ),
                    None => (v.as_str(), None),
                };
                req.suggest = Some(smallsignal_core::suggest::SuggestRequest {
                    quantity: quantity.trim().to_string(),
                    threshold,
                    time_limit: None,
                    max_candidates: None,
                });
            }
            "--pretty" => pretty = true,
            "--certificate" => certificate = true,
            other => return Err(format!("unknown flag {other}\n{USAGE}")),
        }
    }
    if req.input.is_empty() || req.output.is_empty() {
        return Err(USAGE.to_string());
    }
    // --certificate: the gain system's elements and exact solution, for the
    // Lean checker (lean/gen_cert.py).
    let v = if certificate {
        smallsignal_core::certificate::certificate(&text, &req)?
    } else {
        analyze(&text, &req)?
    };
    if pretty {
        println!("{}", serde_json::to_string_pretty(&v).unwrap());
    } else {
        println!("{v}");
    }
    Ok(())
}
