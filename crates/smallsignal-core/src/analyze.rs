//! Request → response: the JSON contract shared by the CLI and WASM builds.

use crate::dc::{operating_point, DevOp, Op};
use crate::linalg::LuComplex;
use crate::netlist::{parse, Kind, Netlist};
use crate::poly::{sub, Poly};
use crate::render::Expr;
use crate::roots::roots;
use crate::ss::{self, Excite, SsCircuit, System};
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
}

/// Exact LaTeX is emitted only up to this many terms (UI readability).
const LATEX_TERM_LIMIT: usize = 400;

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
    let input = net
        .element(&req.input)
        .ok_or_else(|| format!("input source '{}' not found", req.input))?;
    let input_is_v = match net.elements[input].kind {
        Kind::V { .. } => true,
        Kind::I { .. } => false,
        _ => return Err(format!("input '{}' must be an independent V or I source", req.input)),
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

    let symbolic = req.symbolic || !net.missing.is_empty();
    let op = if symbolic { None } else { Some(operating_point(&net)?) };
    let ss = ss::build(&net, op.as_ref())?;
    let mut warnings: Vec<String> = net.warnings.iter().chain(&ss.warnings).cloned().collect();
    if !net.missing.is_empty() {
        warnings.push(format!(
            "symbolic only: no value or model for {} (transistors assumed saturated / forward-active)",
            net.missing.join(", ")
        ));
    }
    warnings.extend(wiring_warnings(&net, op.as_ref()));
    let has_reactive = ss.reactive_mask != 0;
    let q = Quantities {
        ss: &ss,
        freqs: &freqs,
        tol,
        has_reactive,
        symbolic,
    };

    let mut resp = Map::new();
    resp.insert("symbolic".into(), json!(symbolic));
    resp.insert(
        "op".into(),
        op.as_ref().map(|op| op_json(&net, op)).unwrap_or(Value::Null),
    );
    resp.insert("params".into(), params_json(&ss));

    // Gain: input source excited, output voltage per unit input.
    let gsys = ss::system(&net, &ss, &Excite::Source(input));
    let d = crate::det::det(&gsys.a, max_terms)?;
    if d.is_zero() {
        return Err("small-signal circuit is singular (floating node or source loop)".to_string());
    }
    let n_out = sub(&node_num(&gsys, out, max_terms)?, &node_num(&gsys, rf, max_terms)?);
    let numeric_gain = |s: Complex64| {
        let (x, err) = solve_at(&gsys, &ss, s)?;
        let v = xnode(&gsys, &x, out) - xnode(&gsys, &x, rf);
        Some((v, 2.0 * err / v.norm()))
    };
    let unit = if input_is_v { "V/V" } else { "V/A" };
    resp.insert(
        "gain".into(),
        q.json(&n_out, &d, unit, numeric_gain, &mut warnings, "gain"),
    );

    if req.rin {
        let e = &net.elements[input];
        let (num, den) = if input_is_v {
            // Zin = V / I_into_circuit = 1 / (−I_branch).
            let k = gsys.branch_col[&input];
            (d.clone(), gsys.cramer(k, max_terms)?.neg())
        } else {
            let (p, n) = (e.nodes[0], e.nodes[1]);
            (
                sub(&node_num(&gsys, n, max_terms)?, &node_num(&gsys, p, max_terms)?),
                d.clone(),
            )
        };
        let (p, n) = (e.nodes[0], e.nodes[1]);
        let numeric = |s: Complex64| {
            let (x, err) = solve_at(&gsys, &ss, s)?;
            Some(if input_is_v {
                let ib = x[gsys.branch_col[&input]];
                (Complex64::new(-1.0, 0.0) / ib, err / ib.norm())
            } else {
                let v = xnode(&gsys, &x, n) - xnode(&gsys, &x, p);
                (v, 2.0 * err / v.norm())
            })
        };
        resp.insert("rin".into(), q.json(&num, &den, "Ω", numeric, &mut warnings, "rin"));
    }

    if req.rout {
        let osys = ss::system(&net, &ss, &Excite::Inject { into: out, outof: rf });
        let od = crate::det::det(&osys.a, max_terms)?;
        let on = sub(&node_num(&osys, out, max_terms)?, &node_num(&osys, rf, max_terms)?);
        let numeric = |s: Complex64| {
            let (x, err) = solve_at(&osys, &ss, s)?;
            let v = xnode(&osys, &x, out) - xnode(&osys, &x, rf);
            Some((v, 2.0 * err / v.norm()))
        };
        resp.insert("rout".into(), q.json(&on, &od, "Ω", numeric, &mut warnings, "rout"));
    }

    if req.verify {
        let r = crate::verify::kcl(&gsys, ss.params.len(), ss.reactive_mask, max_terms)?;
        if !r.ok {
            warnings.push("KCL identity check FAILED".to_string());
        }
        resp.insert("verify".into(), json!({ "kcl": r.ok, "trials": r.trials }));
    }
    resp.insert("warnings".into(), json!(warnings));
    Ok(Value::Object(resp))
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
            out.push(format!(
                "node {} connects only to {}: that end is open, so {} carries no signal",
                net.nodes[n], users[0], users[0]
            ));
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
                out.push(format!(
                    "{} is on but carries no DC current ({:.1e} A): check that its drain/collector has a DC path",
                    e.name, current
                ));
            }
        }
    }
    out
}

/// Conventional (∥) notation for num/den, kept only if it is the same
/// function: checked at random parameter values and random complex s.
fn structured(num: &Poly, den: &Poly, ss: &SsCircuit) -> Option<String> {
    let st = crate::structure::structure(num, den, &ss.params, ss.reactive_mask)?;
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        0.5 + (seed % 1_000_000) as f64 / 1_000_000.0
    };
    for _ in 0..4 {
        let vals: Vec<f64> = ss.params.iter().map(|_| rnd()).collect();
        let s = Complex64::new(rnd() - 1.0, rnd());
        let ev = |p: &Poly| {
            let mut acc = Complex64::new(0.0, 0.0);
            for (&m, &c) in &p.terms {
                let mut v = c as f64;
                for (i, p) in ss.params.iter().enumerate() {
                    if m >> i & 1 == 1 {
                        v *= if p.inverted { 1.0 / vals[i] } else { vals[i] };
                    }
                }
                acc += v * s.powu((m & ss.reactive_mask).count_ones());
            }
            acc
        };
        let want = ev(num) / ev(den);
        let got = st.eval(&ss.params, &vals, s);
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
fn solve_at(sys: &System, ss: &SsCircuit, s: Complex64) -> Option<(Vec<Complex64>, f64)> {
    let n = sys.dim;
    let mut a = vec![Complex64::new(0.0, 0.0); n * n];
    for r in 0..n {
        for c in 0..n {
            if !sys.a[r][c].is_zero() {
                a[r * n + c] = eval_poly(&sys.a[r][c], ss, s);
            }
        }
    }
    let b: Vec<Complex64> = sys.b.iter().map(|&v| Complex64::new(v as f64, 0.0)).collect();
    let lu = LuComplex::factor(n, a)?;
    let x = lu.solve(&b);
    let xmax = x.iter().map(|v| v.norm()).fold(0.0, f64::max);
    let err = lu.cond1() * f64::EPSILON * xmax;
    Some((x, err))
}

struct Quantities<'a> {
    ss: &'a SsCircuit,
    freqs: &'a [f64],
    tol: f64,
    has_reactive: bool,
    symbolic: bool,
}

fn jw(f: f64) -> Complex64 {
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
    fn grid(&self) -> Vec<f64> {
        let mut g: Vec<f64> = if self.has_reactive {
            (0..=44).map(|k| 10f64.powf(k as f64 / 4.0)).collect()
        } else {
            vec![0.0]
        };
        g.extend_from_slice(self.freqs);
        g
    }

    fn json(
        &self,
        num: &Poly,
        den: &Poly,
        unit: &str,
        numeric: impl Fn(Complex64) -> Option<(Complex64, f64)>,
        warnings: &mut Vec<String>,
        what: &str,
    ) -> Value {
        let params = &self.ss.params;
        if den.is_zero() {
            let values: Vec<Value> = self
                .freqs
                .iter()
                .map(|&f| json!({ "f": f, "re": null, "im": null, "inf": true }))
                .collect();
            return json!({ "unit": unit, "infinite": true, "values": values, "exact": { "latex": "\\infty", "num": "1", "den": "0" } });
        }
        let exact = Expr::from_rational(num, den, params, self.ss.inv_mask, self.ss.reactive_mask);
        if self.symbolic {
            let small = exact.term_count() <= LATEX_TERM_LIMIT;
            let (en, ed) = exact.plain(params);
            let expanded = exact.latex(params);
            let latex = structured(num, den, self.ss).unwrap_or_else(|| expanded.clone());
            let ex = json!({
                "latex": if small { json!(latex) } else { Value::Null },
                "latexExpanded": if small { json!(expanded) } else { Value::Null },
                "num": if small { json!(en) } else { Value::Null },
                "den": if small { json!(ed) } else { Value::Null },
                "terms": { "num": exact.num.len(), "den": exact.den.len() },
            });
            return json!({ "unit": unit, "exact": ex, "simplified": Value::Null, "values": [], "poles": [], "zeros": [] });
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
        let grid = self.grid();
        let mut max_diff = 0.0f64;
        let mut check_ok = true;
        if !num.is_zero() {
            for &f in &grid {
                if let Some((hn, lu_rel)) = numeric(jw(f)) {
                    let (h, bound) = exact.eval_with_bound(jw(f));
                    let scale = hn.norm().max(h.norm());
                    if scale > 0.0 {
                        let diff = (h - hn).norm() / scale;
                        max_diff = max_diff.max(diff);
                        if diff > 1e-12 + 4.0 * bound + 4.0 * lu_rel {
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

        // Simplified form: the coarsest pruning whose error stays in budget.
        let hs: Vec<Complex64> = grid.iter().map(|&f| exact.eval(jw(f))).collect();
        let peak = hs.iter().map(|h| h.norm()).fold(0.0, f64::max);
        let floor = 1e-3 * peak;
        let err_of = |e: &Expr| {
            grid.iter()
                .zip(&hs)
                .map(|(&f, h)| (e.eval(jw(f)) - h).norm() / h.norm().max(floor))
                .fold(0.0, f64::max)
        };
        let mut simplified = exact.clone();
        let mut simp_err = 0.0;
        for eps in [1.0, 0.5, 0.3, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001, 1e-4] {
            let cand = exact.prune(eps, params);
            if cand.term_count() >= exact.term_count() {
                break;
            }
            let err = err_of(&cand);
            if err <= self.tol {
                simplified = cand;
                simp_err = err;
                break;
            }
        }

        let (nc, dc) = exact.s_coeffs();
        let poles: Vec<Value> = roots(&dc).iter().map(hz).collect();
        let zeros: Vec<Value> = roots(&nc).iter().map(hz).collect();
        let (en, ed) = exact.plain(params);
        let small = exact.term_count() <= LATEX_TERM_LIMIT;
        let (sn, sd) = simplified.plain(params);
        let expanded = exact.latex(params);
        let exact_latex = structured(num, den, self.ss).unwrap_or_else(|| expanded.clone());
        let same = simplified.term_count() == exact.term_count();
        let simp_expanded = simplified.latex(params);
        let (smn, smd) = simplified.to_mna(self.ss.inv_mask);
        let simp_latex = if same {
            exact_latex.clone()
        } else {
            structured(&smn, &smd, self.ss).unwrap_or_else(|| simp_expanded.clone())
        };
        json!({
            "unit": unit,
            "exact": {
                "latex": if small { json!(exact_latex) } else { Value::Null },
                "latexExpanded": if small { json!(expanded) } else { Value::Null },
                "num": if small { json!(en) } else { Value::Null },
                "den": if small { json!(ed) } else { Value::Null },
                "terms": { "num": exact.num.len(), "den": exact.den.len() },
            },
            "simplified": {
                "latex": simp_latex,
                "latexExpanded": simp_expanded,
                // True when nothing was dropped: the simplified form is exact.
                "same": same,
                "num": sn,
                "den": sd,
                "maxRelError": simp_err,
                "tolerance": self.tol,
                "terms": { "num": simplified.num.len(), "den": simplified.den.len() },
            },
            "values": values,
            "poles": poles,
            "zeros": zeros,
            "check": { "ok": check_ok, "maxRelDiff": max_diff },
        })
    }
}

fn params_json(ss: &SsCircuit) -> Value {
    Value::Array(
        ss.params
            .iter()
            .map(
                |p| json!({ "name": p.name, "latex": p.latex, "value": p.value, "unit": p.unit, "element": p.element }),
            )
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
