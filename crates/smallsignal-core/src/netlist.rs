//! SPICE netlist subset parser (see plan/contract.md for the dialect).

use crate::caps::{BjtCapModel, DiodeCapModel, MosCapModel, MosGeom};
use crate::devices::{BjtModel, DiodeModel, MosModel, EPS_OX};
use crate::units::parse_value;
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub enum Kind {
    R {
        value: f64,
    },
    C {
        value: f64,
    },
    L {
        value: f64,
    },
    V {
        dc: f64,
        ac: f64,
    },
    I {
        dc: f64,
        ac: f64,
    },
    E {
        gain: f64,
    },
    G {
        gain: f64,
    },
    F {
        ctrl: usize,
        gain: f64,
    },
    H {
        ctrl: usize,
        gain: f64,
    },
    /// `geom`: AD, AS, PD, PS for the bulk junction capacitances.
    M {
        model: MosModel,
        w: f64,
        l: f64,
        mult: f64,
        geom: MosGeom,
    },
    /// `mult` (M=): that many devices in parallel, as ngspice: every
    /// current and conductance, gmin's included, times M. `sub`: the
    /// substrate node (ground when not given, as ngspice), or None when the
    /// named substrate connects to nothing else (its capacitance then leads
    /// nowhere). `float_sub`: a substrate only BJTs share, held (as in
    /// ngspice) by each substrate junction's gmin.
    Q {
        model: BjtModel,
        area: f64,
        mult: f64,
        sub: Option<usize>,
        float_sub: bool,
    },
    /// `mult` (M=): as ngspice, the junction scales with area·M (gmin does
    /// not), and the flicker noise is M devices' sharing the current.
    D {
        model: DiodeModel,
        area: f64,
        mult: f64,
    },
}

/// Node order per kind: R/C/L/V/I/F/H `[p, n]`; E/G `[p, n, cp, cn]`;
/// M `[d, g, s, b]`; Q `[c, b, e]`; D `[a, k]`.
#[derive(Debug, Clone)]
pub struct Element {
    pub name: String,
    pub kind: Kind,
    pub nodes: Vec<usize>,
}

impl Element {
    /// Elements that carry a branch current unknown in MNA.
    pub fn has_branch(&self) -> bool {
        matches!(
            self.kind,
            Kind::V { .. } | Kind::E { .. } | Kind::H { .. } | Kind::L { .. }
        )
    }
}

#[derive(Debug, Clone)]
pub struct Netlist {
    pub title: String,
    pub elements: Vec<Element>,
    /// Node names; index 0 is ground ("0").
    pub nodes: Vec<String>,
    pub gmin: f64,
    pub warnings: Vec<String>,
    /// Elements drawn without a value or model; they make the analysis
    /// purely symbolic (values are NaN).
    pub missing: Vec<String>,
}

impl Netlist {
    pub fn node(&self, name: &str) -> Option<usize> {
        let k = name.trim().to_ascii_lowercase();
        if is_ground(&k) {
            return Some(0);
        }
        self.nodes.iter().position(|n| n.eq_ignore_ascii_case(&k))
    }

    pub fn element(&self, name: &str) -> Option<usize> {
        self.elements
            .iter()
            .position(|e| e.name.eq_ignore_ascii_case(name.trim()))
    }
}

fn is_ground(k: &str) -> bool {
    k == "0" || k == "gnd"
}

struct Line {
    no: usize,
    toks: Vec<String>,
}

fn tokenize(s: &str) -> Vec<String> {
    let mut t = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '(' | ')' | ',' => t.push(' '),
            '=' => t.push_str(" = "),
            _ => t.push(ch),
        }
    }
    let raw: Vec<&str> = t.split_whitespace().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == "=" && !out.is_empty() && i + 1 < raw.len() {
            let k = out.pop().unwrap();
            out.push(format!("{}={}", k, raw[i + 1]));
            i += 2;
        } else {
            out.push(raw[i].to_string());
            i += 1;
        }
    }
    out
}

fn strip_comment(l: &str) -> &str {
    let mut end = l.len();
    if let Some(p) = l.find(';') {
        end = end.min(p);
    }
    let b = l.as_bytes();
    for i in 0..b.len() {
        if b[i] == b'$' && (i == 0 || b[i - 1].is_ascii_whitespace()) {
            end = end.min(i);
            break;
        }
    }
    &l[..end]
}

fn logical_lines(text: &str) -> (String, Vec<Line>) {
    let mut title = String::new();
    let mut lines: Vec<Line> = Vec::new();
    let mut in_control = false;
    for (i, raw) in text.lines().enumerate() {
        if i == 0 {
            title = raw.trim().to_string();
            continue;
        }
        let l = strip_comment(raw).trim();
        if l.is_empty() || l.starts_with('*') {
            continue;
        }
        let lower = l.to_ascii_lowercase();
        if lower.starts_with(".control") {
            in_control = true;
            continue;
        }
        if in_control {
            if lower.starts_with(".endc") {
                in_control = false;
            }
            continue;
        }
        if let Some(rest) = l.strip_prefix('+') {
            if let Some(last) = lines.last_mut() {
                last.toks.extend(tokenize(rest));
                continue;
            }
        }
        // A line of only separators, e.g. "(" or ",", has no tokens.
        let toks = tokenize(l);
        if !toks.is_empty() {
            lines.push(Line { no: i + 1, toks });
        }
    }
    (title, lines)
}

struct Card {
    kind: String,
    params: HashMap<String, f64>,
}

impl Card {
    fn get(&self, k: &str) -> Option<f64> {
        self.params.get(k).copied()
    }
}

fn split_kv(toks: &[String]) -> (Vec<&str>, HashMap<String, String>) {
    let mut pos = Vec::new();
    let mut kv = HashMap::new();
    for t in toks {
        if let Some((k, v)) = t.split_once('=') {
            kv.insert(k.to_ascii_lowercase(), v.to_string());
        } else {
            pos.push(t.as_str());
        }
    }
    (pos, kv)
}

const MOS_KNOWN: &[&str] = &[
    "level", "kp", "vto", "vt0", "lambda", "gamma", "phi", "is", "tox", "uo", "kf", "af", "cgso", "cgdo", "cgbo",
    "cbd", "cbs", "cj", "cjsw", "mj", "mjsw", "pb", "fc",
];
const BJT_KNOWN: &[&str] = &[
    "is", "bf", "br", "vaf", "va", "kf", "af", "cje", "vje", "pe", "mje", "me", "tf", "xtf", "vtf", "itf", "cjc",
    "vjc", "pc", "mjc", "mc", "xcjc", "tr", "cjs", "ccs", "csub", "vjs", "ps", "mjs", "ms", "fc", "subs",
];
const DIODE_KNOWN: &[&str] = &["is", "n", "kf", "af", "cjo", "cj0", "cj", "vj", "pb", "m", "fc", "tt"];

pub fn parse(text: &str) -> Result<Netlist, String> {
    let (title, lines) = logical_lines(text);
    let mut warnings = Vec::new();
    let mut gmin = 1e-12;

    // Pass 1: model cards.
    let mut cards: HashMap<String, Card> = HashMap::new();
    for line in &lines {
        let head = line.toks[0].to_ascii_lowercase();
        if head != ".model" {
            continue;
        }
        if line.toks.len() < 3 {
            return Err(format!("line {}: .model needs a name and a type", line.no));
        }
        let name = line.toks[1].to_ascii_lowercase();
        let kind = line.toks[2].to_ascii_lowercase();
        let mut params = HashMap::new();
        for t in &line.toks[3..] {
            let (k, v) = t
                .split_once('=')
                .ok_or_else(|| format!("line {}: expected key=value in .model, got '{t}'", line.no))?;
            let val =
                parse_value(v).ok_or_else(|| format!("line {}: bad value '{v}' for model parameter {k}", line.no))?;
            params.insert(k.to_ascii_lowercase(), val);
        }
        let known: &[&str] = match kind.as_str() {
            "nmos" | "pmos" => MOS_KNOWN,
            "npn" | "pnp" => BJT_KNOWN,
            "d" => DIODE_KNOWN,
            other => return Err(format!("line {}: unsupported model type '{other}'", line.no)),
        };
        let mut ignored: Vec<&String> = params.keys().filter(|k| !known.contains(&k.as_str())).collect();
        ignored.sort();
        if !ignored.is_empty() {
            let list: Vec<&str> = ignored.iter().map(|s| s.as_str()).collect();
            warnings.push(format!("Model {name} ignores {}", list.join(", ")));
        }
        cards.insert(name, Card { kind, params });
    }

    let mut nodes: Vec<String> = vec!["0".to_string()];
    let mut node_index: HashMap<String, usize> = HashMap::new();
    let mut node_of = |name: &str| -> usize {
        let k = name.to_ascii_lowercase();
        if is_ground(&k) {
            return 0;
        }
        *node_index.entry(k).or_insert_with(|| {
            nodes.push(name.to_string());
            nodes.len() - 1
        })
    };
    let mut names: HashMap<String, usize> = HashMap::new();

    // Pass 2: elements. F/H controls resolve after all elements are known.
    let mut elements: Vec<Element> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let mut pending_ctrl: Vec<(usize, String, usize)> = Vec::new();
    // BJT substrates named on the element line: (element, node name).
    let mut pending_sub: Vec<(usize, String)> = Vec::new();
    for line in &lines {
        let t = &line.toks;
        let head = t[0].to_ascii_lowercase();
        let no = line.no;
        if head.starts_with('.') {
            match head.as_str() {
                ".model" | ".op" | ".ac" | ".dc" | ".tran" | ".noise" | ".tf" | ".save" | ".print" | ".plot"
                | ".probe" | ".temp" | ".title" | ".global" | ".ic" | ".nodeset" | ".meas" | ".measure" => {}
                ".end" => break,
                ".option" | ".options" | ".opt" => {
                    for tok in &t[1..] {
                        if let Some((k, v)) = tok.split_once('=') {
                            if k.eq_ignore_ascii_case("gmin") {
                                gmin = parse_value(v).ok_or_else(|| format!("line {no}: bad gmin '{v}'"))?;
                            }
                        }
                    }
                }
                ".include" | ".inc" | ".lib" => warnings.push(format!("Line {no}: {head} is not supported")),
                ".subckt" | ".ends" => return Err(format!("line {no}: subcircuits (.subckt) are not supported yet")),
                ".param" | ".func" => return Err(format!("line {no}: {head} is not supported yet")),
                other => warnings.push(format!("Line {no}: {other} ignored")),
            }
            continue;
        }
        let name = t[0].clone();
        let key = name.to_ascii_lowercase();
        if names.insert(key.clone(), elements.len()).is_some() {
            return Err(format!("line {no}: duplicate element name {name}"));
        }
        let letter = key.chars().next().unwrap();
        let (pos, kv) = split_kv(&t[1..]);
        let need = |n: usize| -> Result<(), String> {
            if pos.len() < n {
                Err(format!("line {no}: {name} needs at least {n} fields"))
            } else {
                Ok(())
            }
        };
        let val = |s: Option<&&str>, what: &str| -> Result<f64, String> {
            let s = s.ok_or_else(|| format!("line {no}: {name} is missing its {what}"))?;
            parse_value(s).ok_or_else(|| format!("line {no}: bad {what} '{s}' for {name}"))
        };
        let model_card = |mname: &str| -> Result<&Card, String> {
            cards
                .get(&mname.to_ascii_lowercase())
                .ok_or_else(|| format!("line {no}: unknown model '{mname}' for {name}"))
        };
        let (kind, node_names): (Kind, Vec<&str>) = match letter {
            'r' | 'c' | 'l' => {
                need(2)?;
                let value = match (pos.get(2), kv.get(&key[..1])) {
                    (Some(v), _) => val(Some(v), "value")?,
                    (None, Some(v)) => val(Some(&v.as_str()), "value")?,
                    (None, None) => {
                        missing.push(name.clone());
                        f64::NAN
                    }
                };
                let kind = match letter {
                    'r' => {
                        if value == 0.0 {
                            return Err(format!("line {no}: {name} has zero resistance"));
                        }
                        Kind::R { value }
                    }
                    'c' => Kind::C { value },
                    _ => Kind::L { value },
                };
                (kind, pos[..2].to_vec())
            }
            'v' | 'i' => {
                need(2)?;
                let (dc, ac) = source_spec(&pos[2..], no)?;
                let kind = if letter == 'v' {
                    Kind::V { dc, ac }
                } else {
                    Kind::I { dc, ac }
                };
                (kind, pos[..2].to_vec())
            }
            'e' | 'g' => {
                if pos.iter().any(|p| p.eq_ignore_ascii_case("poly")) || kv.contains_key("value") {
                    return Err(format!(
                        "line {no}: {name}: only linear controlled sources are supported"
                    ));
                }
                need(4)?;
                let gain = match pos.get(4) {
                    Some(g) => val(Some(g), "gain")?,
                    None => {
                        missing.push(name.clone());
                        f64::NAN
                    }
                };
                let kind = if letter == 'e' {
                    Kind::E { gain }
                } else {
                    Kind::G { gain }
                };
                (kind, pos[..4].to_vec())
            }
            'f' | 'h' => {
                need(3)?;
                let gain = match pos.get(3) {
                    Some(g) => val(Some(g), "gain")?,
                    None => {
                        missing.push(name.clone());
                        f64::NAN
                    }
                };
                pending_ctrl.push((elements.len(), pos[2].to_string(), no));
                let kind = if letter == 'f' {
                    Kind::F { ctrl: usize::MAX, gain }
                } else {
                    Kind::H { ctrl: usize::MAX, gain }
                };
                (kind, pos[..2].to_vec())
            }
            'm' if pos.len() == 4 => {
                // Drawn without a model: symbolic only (NMOS and PMOS have the
                // same small-signal model).
                missing.push(name.clone());
                let model = MosModel {
                    name: String::new(),
                    ty: 1.0,
                    kp: f64::NAN,
                    vto: 0.0,
                    lambda: 0.0,
                    gamma: 0.0,
                    phi: 0.6,
                    is: 0.0,
                    cox: EPS_OX / 1e-7,
                    kf: 0.0,
                    af: 1.0,
                    caps: MosCapModel::default(),
                };
                (
                    Kind::M {
                        model,
                        w: f64::NAN,
                        l: f64::NAN,
                        mult: 1.0,
                        geom: MosGeom::default(),
                    },
                    pos[..4].to_vec(),
                )
            }
            'q' if pos.len() == 3 => {
                missing.push(name.clone());
                let model = BjtModel {
                    name: String::new(),
                    ty: 1.0,
                    is: f64::NAN,
                    bf: f64::NAN,
                    br: 1.0,
                    vaf: 0.0,
                    kf: 0.0,
                    af: 1.0,
                    caps: BjtCapModel::new(1.0),
                };
                (
                    Kind::Q {
                        model,
                        area: 1.0,
                        mult: 1.0,
                        sub: None,
                        float_sub: false,
                    },
                    pos[..3].to_vec(),
                )
            }
            'd' if pos.len() == 2 => {
                missing.push(name.clone());
                (
                    Kind::D {
                        model: DiodeModel {
                            name: String::new(),
                            is: f64::NAN,
                            n: 1.0,
                            kf: 0.0,
                            af: 1.0,
                            caps: DiodeCapModel::default(),
                        },
                        area: 1.0,
                        mult: 1.0,
                    },
                    pos[..2].to_vec(),
                )
            }
            'm' => {
                need(5)?;
                let card = model_card(pos[4])?;
                let ty = match card.kind.as_str() {
                    "nmos" => 1.0,
                    "pmos" => -1.0,
                    _ => return Err(format!("line {no}: {name} needs an NMOS/PMOS model")),
                };
                let level = card.get("level").unwrap_or(1.0);
                if level != 1.0 {
                    return Err(format!(
                        "line {no}: model {} is LEVEL={level}; only LEVEL=1 is supported",
                        pos[4]
                    ));
                }
                // As mos1temp: TOX (default 1e-7 m) sets Cox; when TOX is
                // given and KP is not, KP = UO·Cox (UO in cm²/V·s, default 600).
                let tox = card.get("tox").filter(|&t| t > 0.0);
                let cox = EPS_OX / tox.unwrap_or(1e-7);
                let kp = match (card.get("kp"), tox) {
                    (Some(kp), _) => kp,
                    (None, Some(_)) => card.get("uo").unwrap_or(600.0) * 1e-4 * cox,
                    (None, None) => 2e-5,
                };
                let model = MosModel {
                    name: pos[4].to_string(),
                    ty,
                    kp,
                    vto: card.get("vto").or(card.get("vt0")).unwrap_or(0.0),
                    lambda: card.get("lambda").unwrap_or(0.0),
                    gamma: card.get("gamma").unwrap_or(0.0),
                    phi: card.get("phi").unwrap_or(0.6),
                    is: card.get("is").unwrap_or(1e-14),
                    cox,
                    kf: card.get("kf").unwrap_or(0.0),
                    af: card.get("af").unwrap_or(1.0),
                    caps: mos_caps_model(card, tox),
                };
                let kvf = |k: &str, d: f64| -> Result<f64, String> {
                    match kv.get(k) {
                        Some(v) => parse_value(v).ok_or_else(|| format!("line {no}: bad {k} '{v}' for {name}")),
                        None => Ok(d),
                    }
                };
                let w = kvf("w", 100e-6)?;
                let l = kvf("l", 100e-6)?;
                let mult = kvf("m", 1.0)?;
                if l <= 0.0 || w <= 0.0 {
                    return Err(format!("line {no}: {name} needs positive W and L"));
                }
                let geom = MosGeom {
                    ad: kvf("ad", 0.0)?,
                    as_: kvf("as", 0.0)?,
                    pd: kvf("pd", 0.0)?,
                    ps: kvf("ps", 0.0)?,
                };
                (
                    Kind::M {
                        model,
                        w,
                        l,
                        mult,
                        geom,
                    },
                    pos[..4].to_vec(),
                )
            }
            'q' => {
                need(4)?;
                // Q c b e [substrate] model [area]
                let (mi, rest) = if cards.contains_key(&pos[3].to_ascii_lowercase()) {
                    (3, 4)
                } else {
                    need(5)?;
                    (4, 5)
                };
                let card = model_card(pos[mi])?;
                let ty = match card.kind.as_str() {
                    "npn" => 1.0,
                    "pnp" => -1.0,
                    _ => return Err(format!("line {no}: {name} needs an NPN/PNP model")),
                };
                let model = BjtModel {
                    name: pos[mi].to_string(),
                    ty,
                    is: card.get("is").unwrap_or(1e-16),
                    bf: card.get("bf").unwrap_or(100.0),
                    br: card.get("br").unwrap_or(1.0),
                    vaf: card.get("vaf").or(card.get("va")).unwrap_or(0.0),
                    kf: card.get("kf").unwrap_or(0.0),
                    af: card.get("af").unwrap_or(1.0),
                    caps: bjt_caps_model(card, ty),
                };
                let area = match (pos.get(rest), kv.get("area")) {
                    (Some(a), _) => val(Some(a), "area")?,
                    (None, Some(a)) => val(Some(&a.as_str()), "area")?,
                    _ => 1.0,
                };
                let mult = match kv.get("m") {
                    Some(v) => parse_value(v)
                        .filter(|m| *m > 0.0)
                        .ok_or_else(|| format!("line {no}: bad m '{v}' for {name}"))?,
                    None => 1.0,
                };
                if mi == 4 {
                    pending_sub.push((elements.len(), pos[3].to_ascii_lowercase()));
                }
                (
                    Kind::Q {
                        model,
                        area,
                        mult,
                        sub: Some(0),
                        float_sub: false,
                    },
                    pos[..3].to_vec(),
                )
            }
            'd' => {
                need(3)?;
                let card = model_card(pos[2])?;
                if card.kind != "d" {
                    return Err(format!("line {no}: {name} needs a D model"));
                }
                let model = DiodeModel {
                    name: pos[2].to_string(),
                    is: card.get("is").unwrap_or(1e-14),
                    n: card.get("n").unwrap_or(1.0),
                    kf: card.get("kf").unwrap_or(0.0),
                    af: card.get("af").unwrap_or(1.0),
                    caps: DiodeCapModel {
                        cjo: card.get("cjo").or(card.get("cj0")).or(card.get("cj")).unwrap_or(0.0),
                        vj: card.get("vj").or(card.get("pb")).unwrap_or(1.0),
                        m: card.get("m").unwrap_or(0.5),
                        fc: card.get("fc").unwrap_or(0.5),
                        tt: card.get("tt").unwrap_or(0.0),
                    },
                };
                let area = match (pos.get(3), kv.get("area")) {
                    (Some(a), _) => val(Some(a), "area")?,
                    (None, Some(a)) => val(Some(&a.as_str()), "area")?,
                    _ => 1.0,
                };
                let mult = match kv.get("m") {
                    Some(v) => parse_value(v)
                        .filter(|m| *m > 0.0)
                        .ok_or_else(|| format!("line {no}: bad m '{v}' for {name}"))?,
                    None => 1.0,
                };
                (Kind::D { model, area, mult }, pos[..2].to_vec())
            }
            'x' => {
                return Err(format!(
                    "line {no}: {name}: subcircuit instances are not supported yet (use M/Q devices with .model cards)"
                ))
            }
            _ => return Err(format!("line {no}: unsupported element '{name}'")),
        };
        let nodes_idx = node_names.iter().map(|n| node_of(n)).collect();
        elements.push(Element {
            name,
            kind,
            nodes: nodes_idx,
        });
    }

    for (ei, ctrl, no) in pending_ctrl {
        let ci = *names
            .get(&ctrl.to_ascii_lowercase())
            .ok_or_else(|| format!("line {no}: controlling source '{ctrl}' not found"))?;
        if !elements[ci].has_branch() {
            return Err(format!(
                "line {no}: '{ctrl}' must be a voltage source (V, E, H or L) to control a current"
            ));
        }
        match &mut elements[ei].kind {
            Kind::F { ctrl, .. } | Kind::H { ctrl, .. } => *ctrl = ci,
            _ => unreachable!(),
        }
    }

    // A named substrate is a node when something else connects to it. One
    // only BJTs share floats, held by each substrate junction's gmin (as in
    // ngspice), and couples their collectors (bases, when lateral) through
    // the substrate capacitances; one only a single BJT names carries
    // nothing, so it is left out.
    let shared = |name: &str| pending_sub.iter().filter(|(_, n)| n == name).count() > 1;
    let mut floating: Vec<(String, usize)> = Vec::new();
    for (ei, sname) in &pending_sub {
        let (node, float) = if is_ground(sname) {
            (Some(0), false)
        } else if let Some(&k) = node_index.get(sname) {
            (Some(k), false)
        } else if shared(sname) {
            let k = match floating.iter().find(|(n, _)| n == sname) {
                Some(&(_, k)) => k,
                None => {
                    nodes.push(sname.clone());
                    floating.push((sname.clone(), nodes.len() - 1));
                    nodes.len() - 1
                }
            };
            (Some(k), true)
        } else {
            (None, false)
        };
        if let Kind::Q { sub, float_sub, .. } = &mut elements[*ei].kind {
            *sub = node;
            *float_sub = float;
        }
    }

    if elements.is_empty() {
        return Err("netlist has no elements (the first line is the title)".to_string());
    }
    Ok(Netlist {
        title,
        elements,
        nodes,
        gmin,
        warnings,
        missing,
    })
}

fn source_spec(t: &[&str], no: usize) -> Result<(f64, f64), String> {
    let mut dc = 0.0;
    let mut ac = 0.0;
    let mut i = 0;
    let mut skipping = false;
    let num = |s: Option<&&str>| -> Result<f64, String> {
        let s = s.ok_or_else(|| format!("line {no}: missing source value"))?;
        parse_value(s).ok_or_else(|| format!("line {no}: bad source value '{s}'"))
    };
    while i < t.len() {
        let w = t[i].to_ascii_lowercase();
        match w.as_str() {
            "dc" => {
                dc = num(t.get(i + 1))?;
                i += 2;
                skipping = false;
            }
            "ac" => {
                ac = num(t.get(i + 1))?;
                i += 2;
                if i < t.len() && parse_value(t[i]).is_some() {
                    i += 1;
                }
                skipping = false;
            }
            "sin" | "pulse" | "pwl" | "exp" | "sffm" | "am" | "distof1" | "distof2" => {
                skipping = true;
                i += 1;
            }
            _ => {
                if !skipping && i == 0 {
                    if let Some(v) = parse_value(&w) {
                        dc = v;
                    }
                }
                i += 1;
            }
        }
    }
    Ok((dc, ac))
}

/// MOS level-1 charge parameters of a card. `tox`: TOX when given and
/// positive (TOX = 0 or absent means no Meyer capacitances, as mos1temp).
fn mos_caps_model(card: &Card, tox: Option<f64>) -> MosCapModel {
    let d = MosCapModel::default();
    MosCapModel {
        cox: tox.map(|t| EPS_OX / t).unwrap_or(0.0),
        cgso: card.get("cgso").unwrap_or(0.0),
        cgdo: card.get("cgdo").unwrap_or(0.0),
        cgbo: card.get("cgbo").unwrap_or(0.0),
        cbd: card.get("cbd"),
        cbs: card.get("cbs"),
        cj: card.get("cj").unwrap_or(0.0),
        cjsw: card.get("cjsw").unwrap_or(0.0),
        mj: card.get("mj").unwrap_or(d.mj),
        mjsw: card.get("mjsw").unwrap_or(d.mjsw),
        pb: card.get("pb").unwrap_or(d.pb),
        fc: card.get("fc").unwrap_or(d.fc),
    }
}

/// Gummel–Poon charge parameters of a card, with ngspice's aliases (PE, ME,
/// PC, MC, CCS, CSUB, PS, MS) and SUBS (1 vertical, −1 lateral; NPN
/// vertical and PNP lateral by default).
fn bjt_caps_model(card: &Card, ty: f64) -> BjtCapModel {
    let d = BjtCapModel::new(ty);
    let get = |keys: &[&str], dflt: f64| keys.iter().find_map(|k| card.get(k)).unwrap_or(dflt);
    BjtCapModel {
        cje: get(&["cje"], d.cje),
        vje: get(&["vje", "pe"], d.vje),
        mje: get(&["mje", "me"], d.mje),
        tf: get(&["tf"], d.tf),
        xtf: get(&["xtf"], d.xtf),
        vtf: get(&["vtf"], d.vtf),
        itf: get(&["itf"], d.itf),
        cjc: get(&["cjc"], d.cjc),
        vjc: get(&["vjc", "pc"], d.vjc),
        mjc: get(&["mjc", "mc"], d.mjc),
        xcjc: get(&["xcjc"], d.xcjc),
        tr: get(&["tr"], d.tr),
        cjs: get(&["cjs", "ccs", "csub"], d.cjs),
        vjs: get(&["vjs", "ps"], d.vjs),
        mjs: get(&["mjs", "ms"], d.mjs),
        fc: get(&["fc"], d.fc),
        subs: match card.get("subs") {
            Some(v) if v == 1.0 || v == -1.0 => v,
            _ => d.subs,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_source() {
        let n = parse(
            "cs amp\nVDD vdd 0 1.8\nVIN in 0 DC 0.7 AC 1\nRD vdd out 10k\nM1 out in 0 0 nm W=10u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1)\n.end\n",
        )
        .unwrap();
        assert_eq!(n.elements.len(), 4);
        assert_eq!(n.node("OUT"), Some(3));
        match &n.elements[1].kind {
            Kind::V { dc, ac } => assert_eq!((*dc, *ac), (0.7, 1.0)),
            _ => panic!(),
        }
        match &n.elements[3].kind {
            Kind::M { model, w, l, .. } => {
                assert_eq!(model.kp, 200e-6);
                assert_eq!((*w, *l), (10e-6, 1e-6));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn continuation_and_kv_spaces() {
        let n = parse("t\nM1 d g s b nm\n+ W = 2u L=1u\n.model nm nmos kp=1m\n").unwrap();
        match &n.elements[0].kind {
            Kind::M { w, .. } => assert_eq!(*w, 2e-6),
            _ => panic!(),
        }
    }
}
