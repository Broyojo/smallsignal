//! Request → response: the JSON contract shared by the CLI and WASM builds.

use crate::dc::{operating_point, DevOp, Op};
use crate::linalg::LuComplex;
use crate::netlist::{parse, Kind, Netlist};
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
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Single,
    Differential,
    Common,
}

/// Exact LaTeX is emitted only up to this many terms (UI readability).
const LATEX_TERM_LIMIT: usize = 400;
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
    let inputs: Vec<usize> = std::iter::once(input).chain(neg).collect();
    let bound = unknowns_lower_bound(&net, &inputs);
    if bound > MAX_UNKNOWNS {
        return Err(format!(
            "circuit too large for exact analysis: at least {bound} small-signal unknowns (limit {MAX_UNKNOWNS})"
        ));
    }

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
    let symbols = sym::symbols(&net, &ss, &req.matched, symbolic, &mut warnings);
    let x = |p: &Poly| XPoly::from_poly(p, &symbols.class, symbols.syms.len());
    let has_reactive = ss.reactive_mask != 0;
    let q = Quantities {
        ss: &ss,
        sym: &symbols,
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
    resp.insert("params".into(), params_json(&symbols.syms));
    let candidates: Vec<Value> = sym::match_candidates(&net, &ss, op.as_ref())
        .into_iter()
        .map(|(a, b, kind)| json!({ "elements": [a, b], "kind": kind }))
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

    // Gain: input source(s) excited, output voltage per unit input. A
    // differential pair is driven ±1 (so v_id = 2) and the denominator
    // doubled, exactly.
    let excite = match (mode, neg) {
        (Mode::Single, _) | (_, None) => Excite::Source(input),
        (Mode::Differential, Some(n)) => Excite::Sources(vec![(input, 1), (n, -1)]),
        (Mode::Common, Some(n)) => Excite::Sources(vec![(input, 1), (n, 1)]),
    };
    let vid = if mode == Mode::Differential { 2.0 } else { 1.0 };
    let gsys = ss::system(&net, &ss, &excite);
    let d = crate::det::det(&gsys.a, max_terms)?;
    if d.is_zero() {
        return Err("small-signal circuit is singular (floating node or source loop)".to_string());
    }
    let n_out = sub(&node_num(&gsys, out, max_terms)?, &node_num(&gsys, rf, max_terms)?);
    if n_out.is_zero() {
        let at = match &req.reference {
            Some(r) if !r.trim().is_empty() => format!("{} (relative to {})", req.output, r.trim()),
            _ => req.output.clone(),
        };
        warnings.push(format!(
            "no signal reaches {at} from {}: the gain is exactly zero",
            req.input
        ));
    }
    let numeric_gain = |s: Complex64| {
        let (xs, err) = solve_at(&gsys, &ss, s)?;
        let v = (xnode(&gsys, &xs, out) - xnode(&gsys, &xs, rf)) / vid;
        Some((v, 2.0 * err / vid / v.norm()))
    };
    let unit = if input_is_v { "V/V" } else { "V/A" };
    let gain_den = if mode == Mode::Differential {
        x(&d)?.scaled(2)?
    } else {
        x(&d)?
    };
    resp.insert(
        "gain".into(),
        q.json(&x(&n_out)?, &gain_den, unit, numeric_gain, &mut warnings, "gain"),
    );

    if req.rin {
        let e = &net.elements[input];
        let (p, n) = (e.nodes[0], e.nodes[1]);
        match (mode, neg) {
            (Mode::Differential, Some(ng)) => {
                // The port between the two inputs' + nodes, both sources removed.
                let (p2, into) = (net.elements[ng].nodes[0], p);
                let isys = ss::system(
                    &net,
                    &ss,
                    &Excite::InjectOpen {
                        into,
                        outof: p2,
                        open: inputs.clone(),
                    },
                );
                let id = crate::det::det(&isys.a, max_terms)?;
                let inum = sub(&node_num(&isys, into, max_terms)?, &node_num(&isys, p2, max_terms)?);
                let numeric = |s: Complex64| {
                    let (xs, err) = solve_at(&isys, &ss, s)?;
                    let v = xnode(&isys, &xs, into) - xnode(&isys, &xs, p2);
                    Some((v, 2.0 * err / v.norm()))
                };
                resp.insert(
                    "rin".into(),
                    q.json(&x(&inum)?, &x(&id)?, "Ω", numeric, &mut warnings, "rin"),
                );
            }
            (Mode::Common, Some(ng)) if input_is_v => {
                // Both inputs at the same 1 V: Z = 1 / (total current in).
                let (k1, k2) = (gsys.branch_col[&input], gsys.branch_col[&ng]);
                let total = poly_add(&gsys.cramer(k1, max_terms)?, &gsys.cramer(k2, max_terms)?);
                let numeric = |s: Complex64| {
                    let (xs, err) = solve_at(&gsys, &ss, s)?;
                    let i = xs[k1] + xs[k2];
                    Some((Complex64::new(-1.0, 0.0) / i, 2.0 * err / i.norm()))
                };
                resp.insert(
                    "rin".into(),
                    q.json(&x(&d)?, &x(&total.neg())?, "Ω", numeric, &mut warnings, "rin"),
                );
            }
            (Mode::Common, Some(_)) => {
                warnings.push("rin in common mode needs voltage-source inputs".to_string());
            }
            _ => {
                let (num, den) = if input_is_v {
                    // Zin = V / I_into_circuit = 1 / (−I_branch).
                    let k = gsys.branch_col[&input];
                    (d.clone(), gsys.cramer(k, max_terms)?.neg())
                } else {
                    (
                        sub(&node_num(&gsys, n, max_terms)?, &node_num(&gsys, p, max_terms)?),
                        d.clone(),
                    )
                };
                let numeric = |s: Complex64| {
                    let (xs, err) = solve_at(&gsys, &ss, s)?;
                    Some(if input_is_v {
                        let ib = xs[gsys.branch_col[&input]];
                        (Complex64::new(-1.0, 0.0) / ib, err / ib.norm())
                    } else {
                        let v = xnode(&gsys, &xs, n) - xnode(&gsys, &xs, p);
                        (v, 2.0 * err / v.norm())
                    })
                };
                resp.insert(
                    "rin".into(),
                    q.json(&x(&num)?, &x(&den)?, "Ω", numeric, &mut warnings, "rin"),
                );
            }
        }
    }

    if req.rout {
        let osys = ss::system(&net, &ss, &Excite::Inject { into: out, outof: rf });
        let od = crate::det::det(&osys.a, max_terms)?;
        let on = sub(&node_num(&osys, out, max_terms)?, &node_num(&osys, rf, max_terms)?);
        let numeric = |s: Complex64| {
            let (xs, err) = solve_at(&osys, &ss, s)?;
            let v = xnode(&osys, &xs, out) - xnode(&osys, &xs, rf);
            Some((v, 2.0 * err / v.norm()))
        };
        resp.insert(
            "rout".into(),
            q.json(&x(&on)?, &x(&od)?, "Ω", numeric, &mut warnings, "rout"),
        );
    }

    if req.verify {
        // One determinant per unknown: skip (and say so) when that would take
        // far longer than the analysis itself. Never report a skipped check
        // as passed.
        if d.len().saturating_mul(gsys.dim) > VERIFY_WORK_LIMIT {
            resp.insert(
                "verify".into(),
                json!({ "kcl": null, "skipped": "too large for the exact KCL check" }),
            );
        } else {
            let r = crate::verify::kcl(&gsys, ss.params.len(), ss.reactive_mask, max_terms)?;
            if !r.ok {
                warnings.push("KCL identity check FAILED".to_string());
            }
            resp.insert("verify".into(), json!({ "kcl": r.ok, "trials": r.trials }));
        }
    }
    resp.insert("warnings".into(), json!(warnings));
    Ok(Value::Object(resp))
}

fn poly_add(a: &Poly, b: &Poly) -> Poly {
    let mut p = a.clone();
    p.add_scaled(b, 1);
    p
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

/// Above this many terms, common-factor cancellation is not attempted.
const GCD_TERM_LIMIT: usize = 1_000;

/// num/den with their greatest common divisor cancelled (exactly; nothing is
/// cancelled if the GCD cannot be found within its budget).
fn cancel(num: &XPoly, den: &XPoly) -> (XPoly, XPoly) {
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
    #[allow(dead_code)]
    ss: &'a SsCircuit,
    sym: &'a Symbols,
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
            // resistance goes to infinity.
            let (ln, ld) = cancel(&sym::leading_order(num, syms), &sym::leading_order(den, syms));
            let lead = Expr::from_mna(&ln, &ld, syms);
            let same = &ln == num && &ld == den;
            let mut simp = if same { ex.clone() } else { text(&lead, &ln, &ld) };
            simp["same"] = json!(same);
            simp["assumption"] = json!("ro ≫ R, 1/gm");
            simp["terms"] = json!({ "num": lead.num.len(), "den": lead.den.len() });
            return json!({ "unit": unit, "exact": ex, "simplified": simp, "values": [], "poles": [], "zeros": [] });
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
                        if diff > 1e-12 + 4.0 * bound + 4.0 * lu_rel + 4.0 * merge {
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
            let cand = exact.prune(eps, syms);
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
        // Text forms only for expressions small enough to read; building them
        // for a huge expression would cost more than the solve.
        let small = exact.term_count() <= LATEX_TERM_LIMIT;
        let simp_small = simplified.term_count() <= LATEX_TERM_LIMIT;
        let same = simplified.term_count() == exact.term_count();
        let exact_json = if small {
            let (en, ed) = exact.plain(syms);
            let expanded = exact.latex(syms);
            let latex = structured(num, den, syms).unwrap_or_else(|| expanded.clone());
            json!({ "latex": latex, "latexExpanded": expanded, "num": en, "den": ed })
        } else {
            json!({ "latex": null, "latexExpanded": null, "num": null, "den": null })
        };
        let simp_json = if same {
            exact_json.clone()
        } else if simp_small {
            let (sn, sd) = simplified.plain(syms);
            let expanded = simplified.latex(syms);
            let (smn, smd) = simplified.to_mna(syms);
            let latex = structured(&smn, &smd, syms).unwrap_or_else(|| expanded.clone());
            json!({ "latex": latex, "latexExpanded": expanded, "num": sn, "den": sd })
        } else {
            json!({ "latex": null, "latexExpanded": null, "num": null, "den": null })
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
            "simplified": with(simp_json, json!({
                // True when nothing was dropped: the simplified form is exact.
                "same": same,
                "maxRelError": simp_err,
                "tolerance": self.tol,
                "terms": { "num": simplified.num.len(), "den": simplified.den.len() },
            })),
            "values": values,
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
