//! Request → response: the JSON contract shared by the CLI and WASM builds.

use crate::dc::{operating_point, DevOp, Op};
use crate::linalg::LuComplex;
use crate::netlist::{parse, Kind, Netlist};
use crate::pencil::Pencil;
use crate::poly::{sub, Poly};
use crate::render::Expr;
use crate::roots::roots;
use crate::ss::{self, Excite, SsCircuit, System};
use crate::sym::{self, Sym, Symbols, XPoly};
use num_complex::Complex64;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::f64::consts::PI;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub input: String,
    pub output: String,
    #[serde(default, rename = "ref")]
    pub reference: Option<String>,
    #[serde(default)]
    pub freqs: Vec<f64>,
    #[serde(default)]
    pub rin: bool,
    #[serde(default)]
    pub rout: bool,
    /// Target max relative error of the simplified expressions.
    #[serde(default)]
    pub tolerance: Option<f64>,
    /// Run the exact KCL identity check on the solution.
    #[serde(default)]
    pub verify: bool,
    #[serde(default)]
    pub max_terms: Option<usize>,
    /// Purely symbolic analysis (no operating point, no numbers). Implied
    /// when any element has no value.
    #[serde(default)]
    pub symbolic: bool,
    /// Second input source: the analysis drives `input` and `inputNeg` as a
    /// pair (see `mode`).
    #[serde(default)]
    pub input_neg: Option<String>,
    /// "differential" (default with inputNeg: ±1/2, gain per v_in+ − v_in−)
    /// or "common" (both +1, gain per common-mode volt).
    #[serde(default)]
    pub mode: Option<String>,
    /// Groups of matched elements that share one set of symbols.
    #[serde(default, rename = "match")]
    pub matched: Vec<Vec<String>>,
    /// Also match every candidate pair (see `matchCandidates`) in this one
    /// solve, except the pairs listed in `unmatch`.
    #[serde(default)]
    pub match_auto: bool,
    #[serde(default)]
    pub unmatch: Vec<Vec<String>>,
    /// Noise analysis (see `noise`): spectra at `freqs`, contributors, and
    /// the input-referred low-frequency PSD in closed form.
    #[serde(default)]
    pub noise: bool,
    /// [fLow, fHigh] (Hz): also integrate the noise over this band.
    #[serde(default)]
    pub noise_band: Option<[f64; 2]>,
    /// Devices whose DC currents are expanded to `order` (see `distortion`).
    #[serde(default)]
    pub nonlinear: Vec<String>,
    /// 2 or 3 (default 3).
    #[serde(default)]
    pub order: Option<u8>,
    /// Input amplitude for HD2/HD3 (default 10 mV, or 1 µA for a current input).
    #[serde(default)]
    pub amplitude: Option<f64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Single,
    Differential,
    Common,
}

/// Exact LaTeX is emitted only up to this many terms (UI readability).
pub(crate) const LATEX_TERM_LIMIT: usize = 400;
/// The symbolic determinant handles at most 64 unknowns.
const MAX_UNKNOWNS: usize = 64;
const MAX_FREQS: usize = 10_000;
/// Determinant terms × unknowns above which `verify` is skipped.
const VERIFY_WORK_LIMIT: usize = 20_000_000;

/// Unknowns the small-signal system has at least: node classes once every
/// voltage source except the input is shorted, minus ground. Checked before
/// the DC solve so an oversized circuit fails fast.
fn unknowns_lower_bound(net: &Netlist, inputs: &[usize]) -> usize {
    let mut uf: Vec<usize> = (0..net.nodes.len()).collect();
    fn find(uf: &mut [usize], x: usize) -> usize {
        let mut r = x;
        while uf[r] != r {
            r = uf[r];
        }
        uf[x] = r;
        r
    }
    for (ei, e) in net.elements.iter().enumerate() {
        if !inputs.contains(&ei) && matches!(e.kind, Kind::V { .. }) {
            let (a, b) = (find(&mut uf, e.nodes[0]), find(&mut uf, e.nodes[1]));
            uf[a.max(b)] = a.min(b);
        }
    }
    let mut roots: Vec<usize> = (0..net.nodes.len()).map(|n| find(&mut uf, n)).collect();
    roots.sort_unstable();
    roots.dedup();
    roots.len() - 1
}

pub fn analyze_json(netlist: &str, request: &str) -> String {
    let out = serde_json::from_str::<Request>(request)
        .map_err(|e| format!("bad request: {e}"))
        .and_then(|r| analyze(netlist, &r));
    match out {
        Ok(v) => v.to_string(),
        Err(e) => json!({ "error": e }).to_string(),
    }
}

pub fn analyze(text: &str, req: &Request) -> Result<Value, String> {
    let net = parse(text)?;
    let find_source = |name: &str| -> Result<(usize, bool), String> {
        let i = net
            .element(name)
            .ok_or_else(|| format!("input source '{name}' not found"))?;
        match net.elements[i].kind {
            Kind::V { .. } => Ok((i, true)),
            Kind::I { .. } => Ok((i, false)),
            _ => Err(format!("input '{name}' must be an independent V or I source")),
        }
    };
    let (input, input_is_v) = find_source(&req.input)?;
    let neg = match &req.input_neg {
        Some(n) if !n.trim().is_empty() => {
            let (i, v) = find_source(n)?;
            if i == input {
                return Err("input and inputNeg are the same source".to_string());
            }
            if v != input_is_v {
                return Err("input and inputNeg must both be voltage sources or both current sources".to_string());
            }
            Some(i)
        }
        _ => None,
    };
    let mode = match (neg, req.mode.as_deref().map(str::trim)) {
        (None, None | Some("")) => Mode::Single,
        (None, Some(m)) => return Err(format!("mode '{m}' needs inputNeg")),
        (Some(_), None | Some("") | Some("differential")) => Mode::Differential,
        (Some(_), Some("common")) => Mode::Common,
        (Some(_), Some(m)) => return Err(format!("unknown mode '{m}' (use differential or common)")),
    };
    let out = net
        .node(&req.output)
        .ok_or_else(|| format!("output node '{}' not found", req.output))?;
    let rf = match &req.reference {
        Some(r) if !r.trim().is_empty() => net.node(r).ok_or_else(|| format!("reference node '{r}' not found"))?,
        _ => 0,
    };
    if out == rf {
        return Err("output and reference are the same node".to_string());
    }
    let max_terms = req.max_terms.unwrap_or(2_000_000);
    let tol = req.tolerance.unwrap_or(0.05);
    let freqs = if req.freqs.is_empty() {
        vec![1e3]
    } else {
        req.freqs.clone()
    };
    if freqs.len() > MAX_FREQS {
        return Err(format!("too many frequencies ({}; limit {MAX_FREQS})", freqs.len()));
    }
    if let Some(band) = req.noise_band {
        crate::noise::check_band(band)?;
    }
    let inputs: Vec<usize> = std::iter::once(input).chain(neg).collect();
    let bound = unknowns_lower_bound(&net, &inputs);
    if bound > MAX_UNKNOWNS {
        return Err(format!(
            "circuit too large for exact analysis: at least {bound} small-signal unknowns (limit {MAX_UNKNOWNS})"
        ));
    }

    let symbolic = req.symbolic || !net.missing.is_empty();
    let op = if symbolic {
        None
    } else {
        Some(
            operating_point(&net).map_err(|e| match degenerate_junctions(&net).as_slice() {
                [] => e,
                found => format!(
                    "No DC solution. {} {} forced on by a source. Add a series resistor.",
                    found.join(", "),
                    if found.len() == 1 { "is" } else { "are" }
                ),
            })?,
        )
    };
    // Symbolic mode assumes saturation except where the region is known.
    let (linear, region_warnings) = if symbolic {
        symbolic_regions(&net)
    } else {
        (Vec::new(), Vec::new())
    };
    let full = ss::build_with(&net, op.as_ref(), &linear)?;
    let excite = match (mode, neg) {
        (Mode::Single, _) | (_, None) => Excite::Source(input),
        (Mode::Differential, Some(n)) => Excite::Sources(vec![(input, 1), (n, -1)]),
        (Mode::Common, Some(n)) => Excite::Sources(vec![(input, 1), (n, 1)]),
    };
    let (p_in, n_in) = (net.elements[input].nodes[0], net.elements[input].nodes[1]);
    let rin_kind = match (req.rin, mode, neg) {
        (false, ..) => None,
        (true, Mode::Differential, Some(ng)) => Some(RinKind::Ports {
            into: p_in,
            outof: net.elements[ng].nodes[0],
            open: inputs.clone(),
        }),
        (true, Mode::Common, Some(ng)) if input_is_v => Some(RinKind::Common { neg: ng }),
        (true, Mode::Common, Some(_)) => None,
        (true, ..) => Some(RinKind::Single { p: p_in, n: n_in }),
    };
    let probe = Probe {
        net: &net,
        excite: excite.clone(),
        out,
        rf,
        vid: if mode == Mode::Differential { 2.0 } else { 1.0 },
        input,
        input_is_v,
        rin: rin_kind,
        rout: req.rout,
    };
    let grid = check_grid(full.reactive_mask != 0, &freqs);
    // Junction conductances (gbs, gbd, gμ) stay in the exact model unless the
    // full numeric system proves that leaving them out moves no reported
    // value by more than OMIT_REL; symbolic mode leaves them out, as hand
    // analysis does.
    // Matched elements decide together, so twins keep the same parameters.
    // Candidate pairs come from the full model, so the omission proof below
    // cannot make twins look unlike.
    let candidate_pairs = sym::match_candidates(&net, &full, op.as_ref());
    let unmatched = |a: &str, b: &str| {
        req.unmatch.iter().any(|pair| {
            pair.iter().any(|x| x.eq_ignore_ascii_case(a)) && pair.iter().any(|x| x.eq_ignore_ascii_case(b))
        })
    };
    let matched: Vec<Vec<String>> = req
        .matched
        .iter()
        .cloned()
        .chain(
            candidate_pairs
                .iter()
                .filter(|(a, b, _)| req.match_auto && !unmatched(a, b))
                .map(|(a, b, _)| vec![a.clone(), b.clone()]),
        )
        .collect();
    let group_of = element_groups(&net, &matched);
    let (ss, omitted, omit_err) = if symbolic {
        (full.clone(), Vec::new(), 0.0)
    } else {
        prove_omission(&probe, &full, &grid, |p| {
            let kind = p.name.split('_').next().unwrap_or("");
            format!("{kind}:{}", group_of(&p.element))
        })
    };
    let mut warnings: Vec<String> = net
        .warnings
        .iter()
        .chain(&ss.warnings)
        .chain(&region_warnings)
        .cloned()
        .collect();
    // Missing values mean hand analysis: the response's `symbolic` says so,
    // and a warning would only repeat it.
    warnings.extend(wiring_warnings(&net, op.as_ref()));
    if op.is_some() {
        warnings.extend(latch_warnings(&net));
        // A converged point can still be unphysical (an ideal source
        // forcing a junction): say so rather than report its numbers quietly.
        warnings.extend(
            degenerate_junctions(&net)
                .into_iter()
                .map(|d| format!("{d} is forced on by a source. Add a series resistor.")),
        );
    }
    let symbols = sym::symbols(&net, &ss, &matched, symbolic, &mut warnings);
    let x = |p: &Poly| XPoly::from_poly(p, &symbols.class, symbols.syms.len());
    let q = Quantities {
        ss: &ss,
        sym: &symbols,
        freqs: &freqs,
        grid: &grid,
        tol,
        symbolic,
        omit_err,
    };

    let mut resp = Map::new();
    resp.insert("symbolic".into(), json!(symbolic));
    resp.insert(
        "op".into(),
        op.as_ref().map(|op| op_json(&net, op)).unwrap_or(Value::Null),
    );
    resp.insert("params".into(), params_json(&symbols.syms));
    resp.insert("omittedJunctions".into(), json!(omitted));
    resp.insert("omissionError".into(), json!(omit_err));
    let candidates: Vec<Value> = candidate_pairs
        .iter()
        .map(|(a, b, kind)| {
            let applied = matched
                .iter()
                .any(|g| g.iter().any(|x| x.eq_ignore_ascii_case(a)) && g.iter().any(|x| x.eq_ignore_ascii_case(b)));
            json!({ "elements": [a, b], "kind": kind, "applied": applied })
        })
        .collect();
    resp.insert("matchCandidates".into(), json!(candidates));
    resp.insert(
        "mode".into(),
        json!(match mode {
            Mode::Single => "single",
            Mode::Differential => "differential",
            Mode::Common => "common",
        }),
    );

    // The cross-check always solves the FULL model (every junction), so an
    // omission can never hide.
    let fsys = probe.systems(&full);

    // Gain: input source(s) excited, output voltage per unit input. A
    // differential pair is driven ±1 (so v_id = 2) and the denominator
    // doubled, exactly.
    // An exact form over the term budget (or beyond i128 coefficients) leaves
    // its quantity numeric, from the full model; without numbers it fails.
    let numeric = Numeric {
        full: &full,
        freqs: &freqs,
    };
    let gsys = ss::system(&net, &ss, &excite);
    let d = crate::det::det(&gsys.a, max_terms)
        .map(Some)
        .or_else(|e| numeric_if_over_budget(symbolic, e))?;
    let singular = || "small-signal circuit is singular (floating node or source loop)".to_string();
    if d.as_ref().is_some_and(Poly::is_zero) {
        return Err(singular());
    }
    let unit = if input_is_v { "V/V" } else { "V/A" };
    let gain_exact = d
        .as_ref()
        .map(|d| -> Result<(XPoly, XPoly), String> {
            let n_out = fit(
                sub(&node_num(&gsys, out, max_terms)?, &node_num(&gsys, rf, max_terms)?),
                max_terms,
            )?;
            let den = if mode == Mode::Differential {
                x(d)?.scaled(2)?
            } else {
                x(d)?
            };
            Ok((x(&n_out)?, den))
        })
        .transpose()
        .or_else(|e| numeric_if_over_budget(symbolic, e))?;
    let gain_w = numeric.diff(&fsys.gain, out, rf);
    let no_signal = match &gain_exact {
        Some((n, _)) => n.is_zero(),
        None => {
            if numeric.vanishes(&fsys.gain, None) {
                return Err(singular());
            }
            numeric.vanishes(&fsys.gain, Some(&gain_w))
        }
    };
    if no_signal {
        let at = match &req.reference {
            Some(r) if !r.trim().is_empty() => format!("{} − {}", req.output, r.trim()),
            _ => req.output.clone(),
        };
        warnings.push(format!("No signal reaches {at}"));
    }
    resp.insert(
        "gain".into(),
        match &gain_exact {
            Some((n, den)) => q.json(n, den, unit, |s| probe.gain_at(&fsys, &full, s), &mut warnings, "gain"),
            None => numeric.quantity(unit, &fsys.gain, Form::Ratio(gain_w), |s| {
                probe.gain_at(&fsys, &full, s)
            }),
        },
    );

    // The circuit's natural frequencies (the roots of its determinant, every
    // source zeroed), from the full model's MNA matrix when D is over budget.
    let numeric_modes = || -> Vec<Complex64> {
        Pencil::new(&fsys.gain, &full, None)
            .zip(crate::pencil::s_orders(&fsys.gain, &full, None))
            .and_then(|(p, o)| p.roots(o))
            .unwrap_or_default()
    };
    let modes = match &d {
        _ if symbolic => None,
        Some(d) => Some(Err(Expr::from_mna(
            &XPoly::constant(1, symbols.syms.len()),
            &x(d)?,
            &symbols.syms,
        ))),
        None => Some(Ok(numeric_modes())),
    };

    // Stability at this bias.
    let unstable = match &modes {
        None => 0,
        Some(Err(e)) => rhp_poles(e),
        Some(Ok(roots)) => roots.iter().filter(|p| p.re > 1e-6 * p.norm()).count(),
    };
    match unstable {
        0 => {}
        1 => warnings.push("Unstable at this bias: a right-half-plane pole.".to_string()),
        _ => warnings.push("Unstable at this bias: right-half-plane poles.".to_string()),
    }

    if req.noise || req.noise_band.is_some() {
        let poles_hz: Vec<f64> = match &modes {
            None => Vec::new(),
            Some(Err(e)) => roots(&e.s_coeffs().1).iter().map(|p| p.norm() / (2.0 * PI)).collect(),
            Some(Ok(roots)) => roots.iter().map(|p| p.norm() / (2.0 * PI)).collect(),
        };
        // The gain's zeros as reported (Hz), after common factors cancel.
        let zeros_hz: Vec<(f64, f64)> = resp["gain"]["zeros"]
            .as_array()
            .map(|zs| {
                zs.iter()
                    .filter_map(|z| Some((z["re"].as_f64()?, z["im"].as_f64()?)))
                    .collect()
            })
            .unwrap_or_default();
        let full_symbols = || {
            let mut w = Vec::new();
            (sym::symbols(&net, &full, &matched, symbolic, &mut w), w)
        };
        let ctx = crate::noise::Ctx {
            net: &net,
            op: op.as_ref(),
            full: &full,
            ss: &ss,
            symbols: &symbols,
            full_symbols: &full_symbols,
            excite: &excite,
            out,
            rf,
            vid: if mode == Mode::Differential { 2 } else { 1 },
            input_is_v,
            freqs: &freqs,
            band: req.noise_band,
            tol,
            max_terms,
            poles_hz,
            zeros_hz,
        };
        resp.insert("noise".into(), crate::noise::report(&ctx, &mut warnings)?);
    }

    if !req.nonlinear.is_empty() {
        // Symbols of the models distortion may rebuild on: their matching
        // warnings (a match those junctions break) reach the response.
        let rebuild_warnings = std::cell::RefCell::new(Vec::new());
        let full_symbols = || sym::symbols(&net, &full, &matched, symbolic, &mut rebuild_warnings.borrow_mut());
        let noleak_symbols =
            |m: &SsCircuit| sym::symbols(&net, m, &matched, symbolic, &mut rebuild_warnings.borrow_mut());
        let ctx = crate::distortion::Ctx {
            net: &net,
            op: op.as_ref(),
            full: &full,
            ss: &ss,
            symbols: &symbols,
            full_symbols: &full_symbols,
            noleak_symbols: &noleak_symbols,
            excite: &excite,
            out,
            rf,
            vid: if mode == Mode::Differential { 2 } else { 1 },
            input_is_v,
            freqs: &freqs,
            names: &req.nonlinear,
            order: req.order.unwrap_or(3),
            // 10 mV, or 1 µA for a current input (as the panel).
            amplitude: req.amplitude.unwrap_or(if input_is_v { 0.01 } else { 1e-6 }),
            tol,
            max_terms,
        };
        resp.insert("distortion".into(), crate::distortion::report(&ctx, &mut warnings)?);
        for w in rebuild_warnings.into_inner() {
            if !warnings.contains(&w) {
                warnings.push(w);
            }
        }
    }

    if req.rin {
        // Exact when its polynomials fit, else numeric as for the gain; each
        // form expands the gain's circuit, so it is numeric with the gain's D.
        let g = &fsys.gain;
        let rin_at = |s| probe.rin_at(&fsys, &full, s);
        let exact = match &probe.rin {
            Some(RinKind::Ports { into, outof, open }) => {
                // The port between the two inputs' + nodes, both sources removed.
                let isys = ss::system(
                    &net,
                    &ss,
                    &Excite::InjectOpen {
                        into: *into,
                        outof: *outof,
                        open: open.clone(),
                    },
                );
                let r = fsys.rin.as_ref().expect("port system");
                // Its determinant expands the same circuit as D, the inputs
                // removed: numeric with the gain's.
                let form = d.as_ref().ok_or_else(|| too_large(max_terms)).and_then(|_| {
                    let id = crate::det::det(&isys.a, max_terms)?;
                    let inum = fit(
                        sub(
                            &node_num(&isys, *into, max_terms)?,
                            &node_num(&isys, *outof, max_terms)?,
                        ),
                        max_terms,
                    )?;
                    Ok((x(&inum)?, x(&id)?))
                });
                Some((form, r, Form::Ratio(numeric.diff(r, *into, *outof))))
            }
            Some(RinKind::Common { neg: ng }) => {
                // Both inputs at the same 1 V: Z = 1 / (total current in).
                let form = d.as_ref().ok_or_else(|| too_large(max_terms)).and_then(|d| {
                    let (k1, k2) = (gsys.branch_col[&input], gsys.branch_col[ng]);
                    let total = fit(
                        poly_add(&gsys.cramer(k1, max_terms)?, &gsys.cramer(k2, max_terms)?),
                        max_terms,
                    )?;
                    Ok((x(d)?, x(&total.neg())?))
                });
                let cols = vec![(g.branch_col[&input], 1), (g.branch_col[ng], 1)];
                Some((form, g, Form::Reciprocal(cols)))
            }
            None => {
                warnings.push("Common-mode Zin needs voltage-source inputs".to_string());
                None
            }
            Some(RinKind::Single { p, n }) => {
                let form = d.as_ref().ok_or_else(|| too_large(max_terms)).and_then(|d| {
                    let (num, den) = if input_is_v {
                        // Zin = V / I_into_circuit = 1 / (−I_branch).
                        let k = gsys.branch_col[&input];
                        (d.clone(), gsys.cramer(k, max_terms)?.neg())
                    } else {
                        (
                            fit(
                                sub(&node_num(&gsys, *n, max_terms)?, &node_num(&gsys, *p, max_terms)?),
                                max_terms,
                            )?,
                            d.clone(),
                        )
                    };
                    Ok((x(&num)?, x(&den)?))
                });
                Some(if input_is_v {
                    (form, g, Form::Reciprocal(vec![(g.branch_col[&input], 1)]))
                } else {
                    (form, g, Form::Ratio(numeric.diff(g, *n, *p)))
                })
            }
        };
        if let Some((form, sys, numeric_form)) = exact {
            let value = match form.map(Some).or_else(|e| numeric_if_over_budget(symbolic, e))? {
                Some((n, dd)) => q.json(&n, &dd, "Ω", rin_at, &mut warnings, "rin"),
                None => numeric.quantity("Ω", sys, numeric_form, rin_at),
            };
            resp.insert("rin".into(), value);
        }
    }

    if req.rout {
        // Its determinant is the gain's, up to sign.
        let osys = ss::system(&net, &ss, &Excite::Inject { into: out, outof: rf });
        let form = d
            .as_ref()
            .ok_or_else(|| too_large(max_terms))
            .and_then(|_| {
                let od = crate::det::det(&osys.a, max_terms)?;
                let on = fit(
                    sub(&node_num(&osys, out, max_terms)?, &node_num(&osys, rf, max_terms)?),
                    max_terms,
                )?;
                Ok((x(&on)?, x(&od)?))
            })
            .map(Some)
            .or_else(|e| numeric_if_over_budget(symbolic, e))?;
        let rout_at = |s| probe.rout_at(&fsys, &full, s);
        let value = match form {
            Some((n, dd)) => q.json(&n, &dd, "Ω", rout_at, &mut warnings, "rout"),
            None => {
                let r = fsys.rout.as_ref().expect("rout system");
                numeric.quantity("Ω", r, Form::Ratio(numeric.diff(r, out, rf)), rout_at)
            }
        };
        resp.insert("rout".into(), value);
    }

    if req.verify {
        // One determinant per unknown: skip (and say so) when that would take
        // far longer than the analysis itself, or when there is no exact
        // form. Never report a skipped check as passed.
        match &d {
            Some(d) if d.len().saturating_mul(gsys.dim) <= VERIFY_WORK_LIMIT => {
                let r = crate::verify::kcl(&gsys, ss.params.len(), ss.reactive_mask, max_terms)?;
                if !r.ok {
                    warnings.push("Internal check failed (KCL)".to_string());
                }
                resp.insert("verify".into(), json!({ "kcl": r.ok, "trials": r.trials }));
            }
            _ => {
                resp.insert(
                    "verify".into(),
                    json!({ "kcl": null, "skipped": "too large for the exact KCL check" }),
                );
            }
        }
    }
    resp.insert("warnings".into(), json!(warnings));
    Ok(Value::Object(resp))
}

/// Largest relative error the `display` form may have from dropping junction
/// leakage; beyond it the display form keeps the junctions.
pub(crate) const LEAKAGE_REL: f64 = 1e-3;

/// Largest relative change of any reported value that omitting junction
/// conductances may cause (absolute floors: 1e-12 for gains, 1e-9 Ω).
const OMIT_REL: f64 = 1e-9;

enum RinKind {
    Single {
        p: usize,
        n: usize,
    },
    /// Between two + nodes, the listed sources removed.
    Ports {
        into: usize,
        outof: usize,
        open: Vec<usize>,
    },
    /// Both voltage inputs at 1 V: 1 / total input current.
    Common {
        neg: usize,
    },
}

/// What the analysis reports, as numbers on a given small-signal model:
/// shared by the omission proof and the cross-check.
struct Probe<'a> {
    net: &'a Netlist,
    excite: Excite,
    out: usize,
    rf: usize,
    vid: f64,
    input: usize,
    input_is_v: bool,
    rin: Option<RinKind>,
    rout: bool,
}

struct Systems {
    gain: System,
    rin: Option<System>,
    rout: Option<System>,
}

impl Probe<'_> {
    fn systems(&self, ss: &SsCircuit) -> Systems {
        Systems {
            gain: ss::system(self.net, ss, &self.excite),
            rin: match &self.rin {
                Some(RinKind::Ports { into, outof, open }) => Some(ss::system(
                    self.net,
                    ss,
                    &Excite::InjectOpen {
                        into: *into,
                        outof: *outof,
                        open: open.clone(),
                    },
                )),
                _ => None,
            },
            rout: self.rout.then(|| {
                ss::system(
                    self.net,
                    ss,
                    &Excite::Inject {
                        into: self.out,
                        outof: self.rf,
                    },
                )
            }),
        }
    }

    fn gain_at(&self, sy: &Systems, ss: &SsCircuit, s: Complex64) -> Option<(Complex64, f64)> {
        let g = &sy.gain;
        let (xs, err) = solve_at(g, ss, s)?;
        let v = (xnode(g, &xs, self.out) - xnode(g, &xs, self.rf)) / self.vid;
        Some((v, 2.0 * err / self.vid / v.norm()))
    }

    fn rin_at(&self, sy: &Systems, ss: &SsCircuit, s: Complex64) -> Option<(Complex64, f64)> {
        let g = &sy.gain;
        match self.rin.as_ref()? {
            RinKind::Ports { into, outof, .. } => {
                let r = sy.rin.as_ref()?;
                let (xs, err) = solve_at(r, ss, s)?;
                let v = xnode(r, &xs, *into) - xnode(r, &xs, *outof);
                Some((v, 2.0 * err / v.norm()))
            }
            RinKind::Common { neg } => {
                let (k1, k2) = (g.branch_col[&self.input], g.branch_col[neg]);
                let (xs, err) = solve_at(g, ss, s)?;
                let i = xs[k1] + xs[k2];
                Some((Complex64::new(-1.0, 0.0) / i, 2.0 * err / i.norm()))
            }
            RinKind::Single { p, n } => {
                let (xs, err) = solve_at(g, ss, s)?;
                Some(if self.input_is_v {
                    let ib = xs[g.branch_col[&self.input]];
                    (Complex64::new(-1.0, 0.0) / ib, err / ib.norm())
                } else {
                    let v = xnode(g, &xs, *n) - xnode(g, &xs, *p);
                    (v, 2.0 * err / v.norm())
                })
            }
        }
    }

    fn rout_at(&self, sy: &Systems, ss: &SsCircuit, s: Complex64) -> Option<(Complex64, f64)> {
        let r = sy.rout.as_ref()?;
        let (xs, err) = solve_at(r, ss, s)?;
        let v = xnode(r, &xs, self.out) - xnode(r, &xs, self.rf);
        Some((v, 2.0 * err / v.norm()))
    }

    /// Every reported value on the grid, with its absolute floor.
    fn values(&self, ss: &SsCircuit, grid: &[f64]) -> Vec<(Option<Complex64>, f64)> {
        let sy = self.systems(ss);
        let mut out = Vec::new();
        for &f in grid {
            let s = jw(f);
            out.push((self.gain_at(&sy, ss, s).map(|v| v.0), 1e-12));
            if self.rin.is_some() {
                out.push((self.rin_at(&sy, ss, s).map(|v| v.0), 1e-9));
            }
            if self.rout {
                out.push((self.rout_at(&sy, ss, s).map(|v| v.0), 1e-9));
            }
        }
        out
    }
}

/// Largest normalized difference d / (scale + floor/OMIT_REL) between two
/// value lists (≤ OMIT_REL exactly when every pair is within OMIT_REL·scale
/// + floor), or None if a pair is not, or only one of it is finite.
fn within(a: &[(Option<Complex64>, f64)], b: &[(Option<Complex64>, f64)]) -> Option<f64> {
    let finite = |z: &Complex64| z.re.is_finite() && z.im.is_finite();
    let mut worst = 0.0f64;
    for ((x, floor), (y, _)) in a.iter().zip(b) {
        match (x, y) {
            (None, None) => {}
            (Some(x), Some(y)) if !finite(x) && !finite(y) => {}
            (Some(x), Some(y)) if finite(x) && finite(y) => {
                let scale = x.norm().max(y.norm());
                let d = (x - y).norm();
                if d > OMIT_REL * scale + floor {
                    return None;
                }
                worst = worst.max(d / (scale + floor / OMIT_REL));
            }
            _ => return None,
        }
    }
    Some(worst)
}

/// Which junction conductances may be left out of the exact model: all of
/// them if the full numeric system shows no reported value moves by more
/// than OMIT_REL; otherwise they are put back, largest conductance first,
/// until it holds. Returns the model, the omitted parameters' names and the
/// largest relative change the omission causes.
/// Junctions sharing a `unit` key (same kind, same matched group) are kept or
/// omitted together.
fn prove_omission(
    probe: &Probe,
    full: &SsCircuit,
    grid: &[f64],
    unit: impl Fn(&ss::Param) -> String,
) -> (SsCircuit, Vec<String>, f64) {
    if full.optional.is_empty() {
        return (full.clone(), Vec::new(), 0.0);
    }
    let reference = probe.values(full, grid);
    let mut units: Vec<(String, Vec<usize>)> = Vec::new();
    for &p in &full.optional {
        let k = unit(&full.params[p]);
        match units.iter_mut().find(|(u, _)| *u == k) {
            Some((_, ps)) => ps.push(p),
            None => units.push((k, vec![p])),
        }
    }
    // Smallest resistance (largest conductance) first: the first put back.
    let least_r = |ps: &[usize]| ps.iter().map(|&p| full.params[p].value).fold(f64::INFINITY, f64::min);
    units.sort_by(|a, b| least_r(&a.1).total_cmp(&least_r(&b.1)));
    while !units.is_empty() {
        let omitted: Vec<usize> = units.iter().flat_map(|(_, ps)| ps.iter().copied()).collect();
        let cand = full.omit(&omitted);
        if let Some(err) = within(&reference, &probe.values(&cand, grid)) {
            let names = omitted.iter().map(|&p| full.params[p].name.clone()).collect();
            return (cand, names, err);
        }
        units.remove(0);
    }
    (full.clone(), Vec::new(), 0.0)
}

/// Group id of each element name under the requested matches (its own name
/// when unmatched).
fn element_groups(net: &Netlist, groups: &[Vec<String>]) -> impl Fn(&str) -> String {
    let mut of: Vec<(String, String)> = Vec::new();
    for g in groups {
        let names: Vec<String> = g
            .iter()
            .filter_map(|n| net.element(n))
            .map(|i| net.elements[i].name.clone())
            .collect();
        let existing = names
            .iter()
            .find_map(|n| of.iter().find(|(e, _)| e == n).map(|(_, id)| id.clone()));
        let id = existing.unwrap_or_else(|| names.first().cloned().unwrap_or_default());
        for n in names {
            if !of.iter().any(|(e, _)| *e == n) {
                of.push((n, id.clone()));
            }
        }
    }
    move |name: &str| {
        of.iter()
            .find(|(e, _)| e == name)
            .map(|(_, id)| id.clone())
            .unwrap_or_else(|| name.to_string())
    }
}

fn check_grid(has_reactive: bool, freqs: &[f64]) -> Vec<f64> {
    let mut g: Vec<f64> = vec![0.0];
    if has_reactive {
        g.extend((0..=44).map(|k| 10f64.powf(k as f64 / 4.0)));
    }
    g.extend_from_slice(freqs);
    g
}

/// `p` (a sum or difference of two numerators, up to twice their terms)
/// within the term budget, failing as an over-budget determinant does.
fn fit(p: Poly, max_terms: usize) -> Result<Poly, String> {
    if p.len() > max_terms {
        Err(too_large(max_terms))
    } else {
        Ok(p)
    }
}

fn too_large(max_terms: usize) -> String {
    format!("exact expression too large (over {max_terms} terms); simplify the circuit or analyze a smaller block")
}

/// An exact form past the term budget or i128 coefficients: Ok(None), so the
/// quantity is numeric, when there are numbers to give (not in symbolic mode).
fn numeric_if_over_budget<T>(symbolic: bool, e: String) -> Result<Option<T>, String> {
    if !symbolic && (e.starts_with("exact expression too large") || e.contains("coefficient overflow")) {
        Ok(None)
    } else {
        Err(e)
    }
}

/// Quantities whose exact form is over budget, from the full model alone:
/// values by LU at each frequency, poles and zeros as the
/// finite roots of the MNA determinants (see `pencil`).
struct Numeric<'a> {
    full: &'a SsCircuit,
    freqs: &'a [f64],
}

/// A quantity as wᵀx on one system (x = A⁻¹b), for its poles and zeros:
/// `Ratio(w)` is proportional to wᵀx (numerator the Cramer numerator of wᵀx,
/// denominator det A), `Reciprocal(w)` to 1/wᵀx (a source's impedance from
/// its own current).
enum Form {
    Ratio(Vec<(usize, i128)>),
    Reciprocal(Vec<(usize, i128)>),
}

impl Numeric<'_> {
    /// Columns of node `a` (+1) and node `b` (−1) in `sys`, ground left out.
    fn diff(&self, sys: &System, a: usize, b: usize) -> Vec<(usize, i128)> {
        [(a, 1), (b, -1)]
            .into_iter()
            .filter_map(|(node, w)| sys.node_col[node].map(|c| (c, w)))
            .collect()
    }

    /// Lowest and highest power of s in det A, or with `border` in the
    /// Cramer numerator of wᵀx; None when it is the zero polynomial (all
    /// exactly, as the symbolic form would have them).
    fn orders(&self, sys: &System, border: Option<&[(usize, i128)]>) -> Option<(usize, usize)> {
        crate::pencil::s_orders(sys, self.full, border)
    }

    fn vanishes(&self, sys: &System, border: Option<&[(usize, i128)]>) -> bool {
        self.orders(sys, border).is_none()
    }

    /// `value` gives the quantity at s (the cross-check's LU solve).
    fn quantity(
        &self,
        unit: &str,
        sys: &System,
        form: Form,
        value: impl Fn(Complex64) -> Option<(Complex64, f64)>,
    ) -> Value {
        let (num_border, den_border) = match &form {
            Form::Ratio(w) => (Some(w.as_slice()), None),
            Form::Reciprocal(w) => (None, Some(w.as_slice())),
        };
        let skipped = "too large for the exact closed form";
        let (num_orders, den_orders) = (self.orders(sys, num_border), self.orders(sys, den_border));
        let Some(den_orders) = den_orders else {
            // The denominator vanishes identically (e.g. looking into a gate).
            let values: Vec<Value> = self
                .freqs
                .iter()
                .map(|&f| json!({ "f": f, "re": null, "im": null, "inf": true }))
                .collect();
            return json!({
                "unit": unit, "infinite": true,
                "exact": null, "display": null, "simplified": null, "skipped": skipped,
                "values": values, "poles": [], "zeros": [], "check": null,
            });
        };
        // At DC a vanishing numerator or denominator is known exactly, where
        // LU would leave rounding (an open circuit at DC is ∞, not 1e18 Ω).
        let dc_den_zero = den_orders.0 > 0;
        let dc_num_zero = num_orders.is_none_or(|o| o.0 > 0);
        let values: Vec<Value> = self
            .freqs
            .iter()
            .map(|&f| {
                let h = match f == 0.0 {
                    true if dc_den_zero => None,
                    true if dc_num_zero => Some(Complex64::new(0.0, 0.0)),
                    _ => value(jw(f)).map(|(h, _)| h),
                };
                match h {
                    Some(h) => json!({
                        "f": f, "re": num_or_null(h.re), "im": num_or_null(h.im),
                        "mag": num_or_null(h.norm()), "phaseDeg": num_or_null(h.arg().to_degrees()),
                    }),
                    None => json!({ "f": f, "re": null, "im": null, "mag": null, "phaseDeg": null }),
                }
            })
            .collect();
        let roots = |border: Option<&[(usize, i128)]>, orders: Option<(usize, usize)>| {
            orders
                .and_then(|o| Pencil::new(sys, self.full, border)?.roots(o))
                .unwrap_or_default()
        };
        // No common factor is cancelled, as for an exact form too large for
        // the GCD.
        let (zeros, poles) = (roots(num_border, num_orders), roots(den_border, Some(den_orders)));
        json!({
            "unit": unit,
            "exact": null, "display": null, "simplified": null, "skipped": skipped,
            "values": values,
            "poleCount": poles.len(),
            "zeroCount": zeros.len(),
            "poles": poles.iter().map(hz).collect::<Vec<_>>(),
            "zeros": zeros.iter().map(hz).collect::<Vec<_>>(),
            "check": null,
        })
    }
}

fn poly_add(a: &Poly, b: &Poly) -> Poly {
    let mut p = a.clone();
    p.add_scaled(b, 1);
    p
}

/// Node voltages fixed by ideal sources alone: reached from ground through
/// independent V sources (their DC value) and inductors (0 V at DC).
fn forced_voltages(net: &Netlist) -> Vec<Option<f64>> {
    let mut v: Vec<Option<f64>> = vec![None; net.nodes.len()];
    v[0] = Some(0.0);
    loop {
        let mut changed = false;
        for e in &net.elements {
            let drop = match e.kind {
                Kind::V { dc, .. } => dc,
                Kind::L { .. } => 0.0,
                _ => continue,
            };
            let (p, n) = (e.nodes[0], e.nodes[1]);
            match (v[p], v[n]) {
                (Some(_), Some(_)) | (None, None) => {}
                (Some(vp), None) => {
                    v[n] = Some(vp - drop);
                    changed = true;
                }
                (None, Some(vn)) => {
                    v[p] = Some(vn + drop);
                    changed = true;
                }
            }
        }
        if !changed {
            return v;
        }
    }
}

/// Junctions an ideal source loop forward-biases hard (both ends pinned by
/// sources, > 0.8 V): their current has no physical limit, so DC cannot
/// converge to anything meaningful.
fn degenerate_junctions(net: &Netlist) -> Vec<String> {
    let v = forced_voltages(net);
    let mut out = Vec::new();
    let mut check = |name: &str, what: &str, anode: usize, cathode: usize, polarity: f64| {
        if let (Some(a), Some(k)) = (v[anode], v[cathode]) {
            let fwd = polarity * (a - k);
            if fwd > 0.8 {
                // Kept short for the panel; the bias is in the netlist.
                let _ = fwd;
                out.push(format!("{name} {what} junction"));
            }
        }
    };
    for e in &net.elements {
        let n = &e.nodes;
        match &e.kind {
            Kind::D { .. } => check(&e.name, "diode", n[0], n[1], 1.0),
            Kind::Q { model, .. } => {
                check(&e.name, "base-emitter", n[1], n[2], model.ty);
                check(&e.name, "base-collector", n[1], n[0], model.ty);
            }
            Kind::M { model, .. } => {
                check(&e.name, "bulk-source", n[3], n[2], model.ty);
                check(&e.name, "bulk-drain", n[3], n[0], model.ty);
            }
            _ => {}
        }
    }
    out
}

/// Devices symbolic mode must not take as saturated (their r_o stays finite
/// in the hand-analysis form), each with numeric mode's warning. Symbolic
/// mode has no operating point (the bias is unknown, even where the netlist
/// holds placeholder values), so only the case the wiring decides: two
/// MOSFETs of one type and model on a shared gate, one's drain on the
/// other's source. Whenever the outer one conducts, the inner one has
/// V_DS < V_GS − V_TH (its threshold is no higher), so it is in triode: the
/// pair is one longer device.
fn symbolic_regions(net: &Netlist) -> (Vec<usize>, Vec<String>) {
    let (mut linear, mut warnings) = (Vec::new(), Vec::new());
    for (ei, inner) in net.elements.iter().enumerate() {
        let Kind::M { model: mi, .. } = &inner.kind else {
            continue;
        };
        let (d, g, s) = (inner.nodes[0], inner.nodes[1], inner.nodes[2]);
        let stacked = d != s
            && net.elements.iter().enumerate().any(|(eo, outer)| match &outer.kind {
                Kind::M { model: mo, .. } => {
                    eo != ei && mo.ty == mi.ty && mo.name == mi.name && outer.nodes[1] == g && outer.nodes[2] == d
                }
                _ => false,
            });
        if stacked {
            linear.push(ei);
            warnings.push(format!("{} is in triode", inner.name));
        }
    }
    (linear, warnings)
}

/// Cross-coupled transistor pairs (each one's gate/base on the other's
/// drain/collector): positive feedback, so the circuit may have several DC
/// solutions (a latch). A structural check only: it cannot prove uniqueness.
fn latch_warnings(net: &Netlist) -> Vec<String> {
    let ends = |i: usize| -> Option<(usize, usize)> {
        let e = &net.elements[i];
        match e.kind {
            Kind::M { .. } | Kind::Q { .. } => Some((e.nodes[1], e.nodes[0])),
            _ => None,
        }
    };
    let mut out = Vec::new();
    for i in 0..net.elements.len() {
        let Some((gi, di)) = ends(i) else { continue };
        for j in i + 1..net.elements.len() {
            let Some((gj, dj)) = ends(j) else { continue };
            if gi == dj && gj == di && gi != 0 && gj != 0 {
                out.push(format!(
                    "{} and {} are cross-coupled. The circuit may have another DC state.",
                    net.elements[i].name, net.elements[j].name
                ));
            }
        }
    }
    out
}

/// Wiring that makes a result meaningless even though it solves: a node only
/// one terminal touches (an open end), or a transistor that is on but carries
/// no current (nothing completes its DC path).
fn wiring_warnings(net: &Netlist, op: Option<&Op>) -> Vec<String> {
    let mut out = Vec::new();
    let mut touched: Vec<Vec<&str>> = vec![Vec::new(); net.nodes.len()];
    for e in &net.elements {
        for &n in &e.nodes {
            touched[n].push(&e.name);
        }
    }
    for (n, users) in touched.iter().enumerate().skip(1) {
        if users.len() == 1 {
            out.push(format!("{} has an open end at {}", users[0], net.nodes[n]));
        }
    }
    // A two-terminal element with both ends on one node does nothing.
    for e in &net.elements {
        let two = matches!(
            e.kind,
            Kind::R { .. } | Kind::C { .. } | Kind::L { .. } | Kind::D { .. } | Kind::V { .. } | Kind::I { .. }
        );
        if two && e.nodes[0] == e.nodes[1] {
            out.push(format!("{} has both ends at {}", e.name, net.nodes[e.nodes[0]]));
        }
    }
    if let Some(op) = op {
        for (ei, e) in net.elements.iter().enumerate() {
            let (on, current) = match &op.dev[ei] {
                Some(DevOp::Mos(m)) => (m.region != crate::devices::MosRegion::Cutoff, m.id),
                Some(DevOp::Bjt(b)) => (b.region != "cutoff", b.ic),
                _ => continue,
            };
            if on && current.abs() < 1e-12 {
                let path = if matches!(op.dev[ei], Some(DevOp::Bjt(_))) {
                    "collector"
                } else {
                    "drain"
                };
                out.push(format!("{} carries no current. Check its {path} path.", e.name));
            }
        }
    }
    out
}

/// Above this many terms, common-factor cancellation is not attempted.
const GCD_TERM_LIMIT: usize = 1_000;

/// num/den with their greatest common divisor cancelled (exactly; nothing is
/// cancelled if the GCD cannot be found within its budget).
pub(crate) fn cancel(num: &XPoly, den: &XPoly) -> (XPoly, XPoly) {
    if num.is_zero() || num.terms.len() + den.terms.len() > GCD_TERM_LIMIT {
        return (num.clone(), den.clone());
    }
    let to_m = |p: &XPoly| -> crate::gcd::MPoly { p.terms.iter().cloned().collect() };
    let to_x = |m: crate::gcd::MPoly| XPoly {
        terms: m.into_iter().collect(),
    };
    let (n, d) = (to_m(num), to_m(den));
    let Some(g) = crate::gcd::gcd(&n, &d) else {
        return (num.clone(), den.clone());
    };
    if g.keys().all(|e| e.iter().all(|&x| x == 0)) {
        return (num.clone(), den.clone());
    }
    match (crate::gcd::div_exact(&n, &g), crate::gcd::div_exact(&d, &g)) {
        (Some(qn), Some(qd)) => (to_x(qn), to_x(qd)),
        _ => (num.clone(), den.clone()),
    }
}

/// Roots of `e`'s denominator in the right half-plane (re > 1e-6·|p|, so
/// roundoff on the jω axis does not count), or 0 when the sign of some
/// coefficient is uncertain (its terms cancel below their rounding error).
fn rhp_poles(e: &Expr) -> usize {
    let deg = e.den.iter().map(|t| t.spow).max().unwrap_or(0) as usize;
    if deg == 0 {
        return 0;
    }
    let shift = e.den.iter().map(|t| t.lmag).fold(f64::NEG_INFINITY, f64::max);
    let (mut sum, mut abs) = (vec![0.0; deg + 1], vec![0.0; deg + 1]);
    for t in &e.den {
        let m = (t.lmag - shift).exp();
        sum[t.spow as usize] += t.sign * m;
        abs[t.spow as usize] += m;
    }
    let rounding = (e.den.len() as f64 + 4.0) * f64::EPSILON;
    if sum.iter().zip(&abs).any(|(c, a)| *a > 0.0 && c.abs() <= rounding * a) {
        return 0;
    }
    roots(&sum).iter().filter(|p| p.re > 1e-6 * p.norm()).count()
}

/// Assumption labels of the symbolic hand-analysis forms.
pub(crate) const HAND: &str = "ro ≫ R, 1/gm";
pub(crate) const HAND_BODY: &str = "ro ≫ R, 1/gm and gmb ≪ gm";

/// Symbolic hand analysis of num/den: the leading order as r_o → ∞, then as
/// g_mb → 0 (textbook analysis neglects channel-length modulation and body
/// effect together), cancelled. The body effect stays where neglecting it
/// leaves a pure number: a follower into an ideal current source would read
/// 1 instead of g_m/(g_m + g_mb), which body effect alone sets. Also says
/// whether g_mb was dropped.
pub(crate) fn hand_form(num: &XPoly, den: &XPoly, syms: &[Sym]) -> (XPoly, XPoly, bool) {
    let (ln, ld) = cancel(&sym::leading_order(num, syms), &sym::leading_order(den, syms));
    let (bn, bd) = cancel(&sym::body_order(&ln, syms), &sym::body_order(&ld, syms));
    let number = |p: &XPoly| p.terms.len() == 1 && p.terms[0].0.iter().all(|&x| x == 0);
    if (bn == ln && bd == ld) || (number(&bn) && number(&bd)) {
        (ln, ld, false)
    } else {
        (bn, bd, true)
    }
}

/// Value of an MNA-form symbol polynomial with displayed symbol values
/// `vals` (resistances as R).
fn xeval(p: &XPoly, syms: &[Sym], vals: &[f64], s: Complex64) -> Complex64 {
    let mut acc = Complex64::new(0.0, 0.0);
    for (e, c) in &p.terms {
        let mut v = *c as f64;
        for (k, &x) in e.iter().enumerate() {
            if x > 0 {
                let m = if syms[k].inverted { 1.0 / vals[k] } else { vals[k] };
                v *= m.powi(x as i32);
            }
        }
        acc += v * s.powu(sym::spow(e, syms));
    }
    acc
}

/// Conventional (∥) notation for num/den, kept only if it is the same
/// function: checked at random symbol values and random complex s.
fn structured(num: &XPoly, den: &XPoly, syms: &[Sym]) -> Option<String> {
    let st = crate::structure::structure(num, den, syms)?;
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        0.5 + (seed % 1_000_000) as f64 / 1_000_000.0
    };
    for _ in 0..4 {
        let vals: Vec<f64> = syms.iter().map(|_| rnd()).collect();
        let s = Complex64::new(rnd() - 1.0, rnd());
        let want = xeval(num, syms, &vals, s) / xeval(den, syms, &vals, s);
        let got = st.eval(syms, &vals, s);
        if (got - want).norm() > 1e-10 * want.norm().max(1e-300) {
            return None;
        }
    }
    Some(st.latex)
}

fn node_num(sys: &System, node: usize, max_terms: usize) -> Result<Poly, String> {
    match sys.node_col[node] {
        Some(c) => sys.cramer(c, max_terms),
        None => Ok(Poly::zero()),
    }
}

fn xnode(sys: &System, x: &[Complex64], node: usize) -> Complex64 {
    sys.node_col[node].map(|c| x[c]).unwrap_or_default()
}

fn eval_poly(p: &Poly, ss: &SsCircuit, s: Complex64) -> Complex64 {
    let mut acc = Complex64::new(0.0, 0.0);
    for (&m, &c) in &p.terms {
        let mut v = c as f64;
        let mut bits = m;
        while bits != 0 {
            let i = bits.trailing_zeros() as usize;
            v *= ss.params[i].mna_value();
            bits &= bits - 1;
        }
        acc += v * s.powu((m & ss.reactive_mask).count_ones());
    }
    acc
}

/// Independent numeric solve of the same system (complex LU), used to
/// cross-check every symbolic result. Returns the solution and its normwise
/// forward-error bound κ₁(A)·eps·‖x‖ (an absolute bound on each component).
pub(crate) fn matrix_at(sys: &System, ss: &SsCircuit, s: Complex64) -> Vec<Complex64> {
    let n = sys.dim;
    let mut a = vec![Complex64::new(0.0, 0.0); n * n];
    for r in 0..n {
        for c in 0..n {
            if !sys.a[r][c].is_zero() {
                a[r * n + c] = eval_poly(&sys.a[r][c], ss, s);
            }
        }
    }
    a
}

fn solve_at(sys: &System, ss: &SsCircuit, s: Complex64) -> Option<(Vec<Complex64>, f64)> {
    let n = sys.dim;
    let a = matrix_at(sys, ss, s);
    let b: Vec<Complex64> = sys.b.iter().map(|&v| Complex64::new(v as f64, 0.0)).collect();
    let lu = LuComplex::factor(n, a)?;
    let x = lu.solve(&b);
    let xmax = x.iter().map(|v| v.norm()).fold(0.0, f64::max);
    let err = lu.cond1() * f64::EPSILON * xmax;
    Some((x, err))
}

struct Quantities<'a> {
    #[allow(dead_code)]
    ss: &'a SsCircuit,
    sym: &'a Symbols,
    freqs: &'a [f64],
    grid: &'a [f64],
    tol: f64,
    symbolic: bool,
    /// Largest relative change from proven-negligible junction omissions.
    omit_err: f64,
}

pub(crate) fn jw(f: f64) -> Complex64 {
    Complex64::new(0.0, 2.0 * PI * f)
}

fn num_or_null(v: f64) -> Value {
    if v.is_finite() {
        json!(v)
    } else {
        Value::Null
    }
}

fn hz(r: &Complex64) -> Value {
    json!({ "re": r.re / (2.0 * PI), "im": r.im / (2.0 * PI) })
}

impl Quantities<'_> {
    fn json(
        &self,
        num: &XPoly,
        den: &XPoly,
        unit: &str,
        numeric: impl Fn(Complex64) -> Option<(Complex64, f64)>,
        warnings: &mut Vec<String>,
        what: &str,
    ) -> Value {
        let syms = &self.sym.syms;
        let (num, den) = &cancel(num, den);
        if den.is_zero() {
            let values: Vec<Value> = self
                .freqs
                .iter()
                .map(|&f| json!({ "f": f, "re": null, "im": null, "inf": true }))
                .collect();
            return json!({ "unit": unit, "infinite": true, "values": values, "exact": { "latex": "\\infty", "num": "1", "den": "0" } });
        }
        let exact = Expr::from_mna(num, den, syms);
        if self.symbolic {
            let terms = json!({ "num": exact.num.len(), "den": exact.den.len() });
            let text = |e: &Expr, n: &XPoly, d: &XPoly| {
                if e.term_count() <= LATEX_TERM_LIMIT {
                    let (en, ed) = e.plain(syms);
                    let expanded = e.latex(syms);
                    let latex = structured(n, d, syms).unwrap_or_else(|| expanded.clone());
                    json!({ "latex": latex, "latexExpanded": expanded, "num": en, "den": ed })
                } else {
                    json!({ "latex": null, "latexExpanded": null, "num": null, "den": null })
                }
            };
            let mut ex = text(&exact, num, den);
            ex["terms"] = terms;
            // Hand-analysis form: the leading order as every device output
            // resistance goes to infinity, then as g_mb → 0.
            let (ln, ld, body) = hand_form(num, den, syms);
            let lead = Expr::from_mna(&ln, &ld, syms);
            let same = &ln == num && &ld == den;
            let mut simp = if same { ex.clone() } else { text(&lead, &ln, &ld) };
            simp["same"] = json!(same);
            simp["assumption"] = json!(if body { HAND_BODY } else { HAND });
            simp["terms"] = json!({ "num": lead.num.len(), "den": lead.den.len() });
            // No junction leakage in symbolic mode: the display form is exact.
            let mut display = ex.clone();
            display["same"] = json!(true);
            display["maxRelError"] = Value::Null;
            display["leakageMatters"] = json!(false);
            // No values, so no roots, but their number: the degree in s.
            let degree = |ts: &[crate::render::Term]| ts.iter().map(|t| t.spow).max().unwrap_or(0);
            return json!({
                "unit": unit, "exact": ex, "display": display, "simplified": simp,
                "values": [], "poles": [], "zeros": [],
                "poleCount": degree(&exact.den), "zeroCount": degree(&exact.num),
            });
        }
        let values: Vec<Value> = self
            .freqs
            .iter()
            .map(|&f| {
                let h = exact.eval(jw(f));
                json!({
                    "f": f, "re": num_or_null(h.re), "im": num_or_null(h.im),
                    "mag": num_or_null(h.norm()), "phaseDeg": num_or_null(h.arg().to_degrees()),
                })
            })
            .collect();

        // Cross-check against a direct numeric solve. A point fails only if
        // the two disagree by more than floating-point error can explain:
        // the symbolic sum's cancellation bound plus the LU forward-error
        // bound (both relative).
        // (An exactly zero numerator is certified by the KCL identity.)
        let grid = self.grid;
        let mut max_diff = 0.0f64;
        let mut check_ok = true;
        if !num.is_zero() {
            for &f in grid {
                if let Some((hn, lu_rel)) = numeric(jw(f)) {
                    let (h, bound) = exact.eval_with_bound(jw(f));
                    let finite = |z: Complex64| z.re.is_finite() && z.im.is_finite();
                    // A NaN/inf symbolic value where the direct solve is finite
                    // is a failure, never a skipped point.
                    if !finite(h) {
                        if finite(hn) {
                            check_ok = false;
                            max_diff = f64::INFINITY;
                        }
                        continue;
                    }
                    let scale = hn.norm().max(h.norm());
                    if scale > 0.0 {
                        let diff = (h - hn).norm() / scale;
                        max_diff = max_diff.max(diff);
                        // Merged matched symbols take the first member's value;
                        // members agree to `mismatch`, which moves the result by at
                        // most that per merged factor, amplified by cancellation.
                        let merge = self.sym.mismatch * exact.max_degree() as f64 * exact.cancellation(jw(f));
                        // The cross-check solves the full model; a proven
                        // omission accounts for at most omit_err.
                        // In relative terms a proven omission may move this
                        // point by omit_err·(1 + floor/(OMIT_REL·scale)).
                        let floor = if unit == "Ω" { 1e-9 } else { 1e-12 };
                        let omit = self.omit_err * (1.0 + floor / (OMIT_REL * scale));
                        if diff > 1e-12 + 4.0 * bound + 4.0 * lu_rel + 4.0 * merge + 2.0 * omit {
                            check_ok = false;
                        }
                    }
                }
            }
        }
        if !check_ok {
            warnings.push(format!(
                "{what}: symbolic and numeric solutions differ beyond floating-point error ({max_diff:.2e})"
            ));
        }

        // Reference: the exact expression, which is the full model (every
        // junction) to within the proven omission error, and evaluates more
        // accurately than an LU solve of the same system. Errors below are
        // against the full model: measured against this, plus omit_err.
        let finite = |z: &Complex64| z.re.is_finite() && z.im.is_finite();
        let refs: Vec<Complex64> = grid.iter().map(|&f| exact.eval(jw(f))).collect();
        let peak = refs.iter().filter(|h| finite(h)).map(|h| h.norm()).fold(0.0, f64::max);
        let floor = 1e-3 * peak;
        // Worst relative error against the reference, with a floor at 1e-3 of
        // the peak (−60 dB) so zeros of the response do not dominate.
        let err_of = |e: &Expr| {
            let measured = grid
                .iter()
                .zip(&refs)
                .map(|(&f, h)| {
                    let v = e.eval(jw(f));
                    match (finite(&v), finite(h)) {
                        (true, true) => (v - h).norm() / h.norm().max(floor),
                        (false, false) => 0.0,
                        _ => f64::INFINITY,
                    }
                })
                .fold(0.0, f64::max);
            measured + self.omit_err
        };

        // Display form: the exact expression in the limit of zero junction
        // leakage (r_bs, r_bd, r_μ → ∞: their conductance monomials dropped),
        // unless that moves a value by more than LEAKAGE_REL.
        let leak: Vec<bool> = syms.iter().map(|s| s.leakage).collect();
        let leaky = |e: &[u8]| e.iter().zip(&leak).any(|(&x, &l)| l && x > 0);
        // (An exactly zero quantity has nothing to show differently.)
        let leak_present = !num.is_zero() && num.terms.iter().chain(&den.terms).any(|(e, _)| leaky(e));
        let drop_leak = |p: &XPoly| XPoly {
            terms: p.terms.iter().filter(|(e, _)| !leaky(e)).cloned().collect(),
        };
        let mut leakage_matters = false;
        let display = if leak_present {
            let (dn, dd) = cancel(&drop_leak(num), &drop_leak(den));
            let cand = (!dd.is_zero()).then(|| Expr::from_mna(&dn, &dd, syms));
            match cand {
                Some(c) if err_of(&c) <= LEAKAGE_REL => c,
                _ => {
                    leakage_matters = true;
                    exact.clone()
                }
            }
        } else {
            exact.clone()
        };
        let display_same = !leak_present || leakage_matters;
        let display_err = err_of(&display);

        // Simplified form: the coarsest pruning of the display form whose
        // error (against the full model) stays in budget, with no single
        // coefficient moved by more than the tolerance.
        let mut simplified = display.clone();
        let mut simp_err = display_err;
        for eps in Expr::prune_levels(self.tol) {
            let cand = display.prune(eps, syms);
            if cand.term_count() >= display.term_count() {
                break;
            }
            let err = err_of(&cand);
            if err <= self.tol {
                simplified = cand.cancelled(syms);
                simp_err = err;
                break;
            }
        }

        let (nc, dc) = exact.s_coeffs();
        let poles: Vec<Value> = roots(&dc).iter().map(hz).collect();
        let zeros: Vec<Value> = roots(&nc).iter().map(hz).collect();
        // Text forms only for expressions small enough to read; building them
        // for a huge expression would cost more than the solve.
        let text = |e: &Expr| {
            if e.term_count() <= LATEX_TERM_LIMIT {
                let (n, d) = e.plain(syms);
                let expanded = e.latex(syms);
                let (mn, md) = e.to_mna(syms);
                let latex = structured(&mn, &md, syms).unwrap_or_else(|| expanded.clone());
                json!({ "latex": latex, "latexExpanded": expanded, "num": n, "den": d })
            } else {
                json!({ "latex": null, "latexExpanded": null, "num": null, "den": null })
            }
        };
        let exact_json = text(&exact);
        let same = display_same && simplified.term_count() == exact.term_count();
        let display_json = if display_same {
            exact_json.clone()
        } else {
            text(&display)
        };
        let simp_json = if same {
            exact_json.clone()
        } else if simplified.term_count() == display.term_count() {
            display_json.clone()
        } else {
            text(&simplified)
        };
        let with = |mut v: Value, extra: Value| {
            if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
                o.extend(e.clone());
            }
            v
        };
        json!({
            "unit": unit,
            "exact": with(exact_json, json!({ "terms": { "num": exact.num.len(), "den": exact.den.len() } })),
            "display": with(display_json, json!({
                // True when the display form is the exact one (no leakage
                // parameters, or leakage that matters).
                "same": display_same,
                "maxRelError": display_err,
                "leakageMatters": leakage_matters,
                "terms": { "num": display.num.len(), "den": display.den.len() },
            })),
            "simplified": with(simp_json, json!({
                // True when nothing was dropped: the simplified form is exact.
                "same": same,
                "maxRelError": simp_err,
                "tolerance": self.tol,
                "terms": { "num": simplified.num.len(), "den": simplified.den.len() },
            })),
            "values": values,
            "poleCount": poles.len(),
            "zeroCount": zeros.len(),
            "poles": poles,
            "zeros": zeros,
            "check": { "ok": check_ok, "maxRelDiff": max_diff },
        })
    }
}

fn params_json(syms: &[Sym]) -> Value {
    Value::Array(
        syms.iter()
            .map(|p| {
                json!({
                    "name": p.name, "latex": p.latex, "value": p.value, "unit": p.unit,
                    "element": p.elements[0], "elements": p.elements,
                })
            })
            .collect(),
    )
}

fn op_json(net: &Netlist, op: &Op) -> Value {
    let mut nodes = Map::new();
    for (i, n) in net.nodes.iter().enumerate().skip(1) {
        nodes.insert(n.clone(), json!(op.v[i]));
    }
    let mut sources = Map::new();
    let mut devices = Map::new();
    for (ei, e) in net.elements.iter().enumerate() {
        if let Some(i) = op.branch[ei] {
            sources.insert(e.name.clone(), json!(i));
        }
        let d = match &op.dev[ei] {
            Some(DevOp::Mos(m)) => json!({
                "type": if m.ty > 0.0 { "nmos" } else { "pmos" }, "region": m.region.as_str(),
                "id": m.id, "vgs": m.vgs, "vds": m.vds, "vbs": m.vbs, "vth": m.vth, "vdsat": m.vdsat,
                "gm": m.gm, "gds": m.gds, "gmb": m.gmb, "reversed": m.reversed,
            }),
            Some(DevOp::Bjt(b)) => json!({
                "type": if b.ty > 0.0 { "npn" } else { "pnp" }, "region": b.region,
                "ic": b.ic, "ib": b.ib, "vbe": b.vbe, "vce": b.vce,
                "gm": b.gm, "gpi": b.gpi, "go": b.go, "gmu": b.gmu,
            }),
            Some(DevOp::Diode(dd)) => json!({ "type": "diode", "id": dd.id, "vd": dd.vd, "gd": dd.gd }),
            None => continue,
        };
        devices.insert(e.name.clone(), d);
    }
    json!({ "nodes": nodes, "sources": sources, "devices": devices, "method": op.method, "iterations": op.iterations })
}
