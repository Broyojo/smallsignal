//! Small-signal linearization and symbolic MNA systems.

use crate::dc::{DevOp, Op};
use crate::devices::MosRegion;
use crate::netlist::{Kind, Netlist};
use crate::poly::{Mono, Poly};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Gm,
    Gmb,
    Gain,
    DeviceR,
    Resistor,
    Capacitor,
    Inductor,
}

#[derive(Clone, Debug)]
pub struct Param {
    /// Plain identifier, e.g. `RD`, `gm_M1`, `ro_M1`.
    pub name: String,
    pub latex: String,
    /// Value of the displayed quantity (Ω for resistances, S for gm, F, H…).
    pub value: f64,
    /// True when the quantity is a resistance, so MNA uses its reciprocal.
    pub inverted: bool,
    /// Capacitors and inductors: each carries one power of s.
    pub reactive: bool,
    pub role: Role,
    pub unit: &'static str,
    pub element: String,
}

impl Param {
    pub fn mna_value(&self) -> f64 {
        if self.inverted {
            1.0 / self.value
        } else {
            self.value
        }
    }
}

#[derive(Clone, Debug)]
pub enum Stamp {
    /// Admittance between two nodes.
    Adm {
        a: usize,
        b: usize,
        p: usize,
    },
    /// Current p·(v_cp − v_cn) flowing from `op` through the source to `on`.
    Vccs {
        op: usize,
        on: usize,
        cp: usize,
        cn: usize,
        p: usize,
    },
    VSrc {
        e: usize,
        a: usize,
        b: usize,
    },
    ISrc {
        e: usize,
        a: usize,
        b: usize,
    },
    Vcvs {
        e: usize,
        a: usize,
        b: usize,
        cp: usize,
        cn: usize,
        p: Option<usize>,
    },
    Cccs {
        a: usize,
        b: usize,
        ctrl: usize,
        p: usize,
    },
    Ccvs {
        e: usize,
        a: usize,
        b: usize,
        ctrl: usize,
        p: Option<usize>,
    },
    Ind {
        e: usize,
        a: usize,
        b: usize,
        p: usize,
    },
}

#[derive(Clone, Debug)]
pub struct SsCircuit {
    pub params: Vec<Param>,
    pub stamps: Vec<Stamp>,
    pub warnings: Vec<String>,
    pub inv_mask: Mono,
    pub reactive_mask: Mono,
}

fn esc(s: &str) -> String {
    s.replace('_', "\\_")
}

/// `R_{D}` from `RD`; `R` alone stays `R`.
fn elem_latex(name: &str) -> String {
    let (head, rest) = name.split_at(1);
    if rest.is_empty() {
        head.to_string()
    } else {
        format!("{}_{{{}}}", head.to_ascii_uppercase(), esc(rest))
    }
}

/// `g_{m1}` for M1, `g_{m,in}` for Min, `g_{m}` for M.
fn dev_latex(base: &str, sub: &str, elem: &str) -> String {
    let rest = &elem[1..];
    if rest.is_empty() {
        format!("{base}_{{{sub}}}")
    } else if rest.chars().all(|c| c.is_ascii_digit()) {
        format!("{base}_{{{sub}{rest}}}")
    } else {
        format!("{base}_{{{sub},{}}}", esc(rest))
    }
}

fn add(
    params: &mut Vec<Param>,
    name: String,
    latex: String,
    value: f64,
    role: Role,
    unit: &'static str,
    elem: &str,
) -> Result<usize, String> {
    if params.len() >= 128 {
        return Err("too many small-signal parameters (limit 128)".to_string());
    }
    let inverted = matches!(role, Role::DeviceR | Role::Resistor);
    let reactive = matches!(role, Role::Capacitor | Role::Inductor);
    params.push(Param {
        name,
        latex,
        value,
        inverted,
        reactive,
        role,
        unit,
        element: elem.to_string(),
    });
    Ok(params.len() - 1)
}

/// Saturated MOSFET with symbolic gm, ro and (when the body is not tied to
/// the source) gmb.
fn add_mos_symbolic(
    params: &mut Vec<Param>,
    stamps: &mut Vec<Stamp>,
    nm: &str,
    d: usize,
    g: usize,
    s: usize,
    b: usize,
) -> Result<(), String> {
    let p = add(
        params,
        format!("gm_{nm}"),
        dev_latex("g", "m", nm),
        f64::NAN,
        Role::Gm,
        "S",
        nm,
    )?;
    stamps.push(Stamp::Vccs {
        op: d,
        on: s,
        cp: g,
        cn: s,
        p,
    });
    let p = add(
        params,
        format!("ro_{nm}"),
        dev_latex("r", "o", nm),
        f64::NAN,
        Role::DeviceR,
        "Ω",
        nm,
    )?;
    stamps.push(Stamp::Adm { a: d, b: s, p });
    if b != s {
        let p = add(
            params,
            format!("gmb_{nm}"),
            dev_latex("g", "mb", nm),
            f64::NAN,
            Role::Gmb,
            "S",
            nm,
        )?;
        stamps.push(Stamp::Vccs {
            op: d,
            on: s,
            cp: b,
            cn: s,
            p,
        });
    }
    Ok(())
}

/// With `op = None` the analysis is purely symbolic: every MOSFET is taken
/// as saturated and every BJT as forward-active, and all values are NaN.
pub fn build(net: &Netlist, op: Option<&Op>) -> Result<SsCircuit, String> {
    let mut params: Vec<Param> = Vec::new();
    let mut stamps = Vec::new();
    let mut warnings = Vec::new();
    for (ei, e) in net.elements.iter().enumerate() {
        let n = &e.nodes;
        let nm = e.name.as_str();
        match &e.kind {
            Kind::R { value } => {
                let p = add(
                    &mut params,
                    nm.to_string(),
                    elem_latex(nm),
                    *value,
                    Role::Resistor,
                    "Ω",
                    nm,
                )?;
                stamps.push(Stamp::Adm { a: n[0], b: n[1], p });
            }
            Kind::C { value } => {
                if *value != 0.0 {
                    let p = add(
                        &mut params,
                        nm.to_string(),
                        elem_latex(nm),
                        *value,
                        Role::Capacitor,
                        "F",
                        nm,
                    )?;
                    stamps.push(Stamp::Adm { a: n[0], b: n[1], p });
                }
            }
            Kind::L { value } => {
                let p = add(
                    &mut params,
                    nm.to_string(),
                    elem_latex(nm),
                    *value,
                    Role::Inductor,
                    "H",
                    nm,
                )?;
                stamps.push(Stamp::Ind {
                    e: ei,
                    a: n[0],
                    b: n[1],
                    p,
                });
            }
            Kind::V { .. } => stamps.push(Stamp::VSrc {
                e: ei,
                a: n[0],
                b: n[1],
            }),
            Kind::I { .. } => stamps.push(Stamp::ISrc {
                e: ei,
                a: n[0],
                b: n[1],
            }),
            Kind::E { gain } => {
                let p = if *gain != 0.0 {
                    Some(add(
                        &mut params,
                        nm.to_string(),
                        elem_latex(nm),
                        *gain,
                        Role::Gain,
                        "V/V",
                        nm,
                    )?)
                } else {
                    None
                };
                stamps.push(Stamp::Vcvs {
                    e: ei,
                    a: n[0],
                    b: n[1],
                    cp: n[2],
                    cn: n[3],
                    p,
                });
            }
            Kind::G { gain } => {
                if *gain != 0.0 {
                    let p = add(&mut params, nm.to_string(), elem_latex(nm), *gain, Role::Gain, "S", nm)?;
                    stamps.push(Stamp::Vccs {
                        op: n[0],
                        on: n[1],
                        cp: n[2],
                        cn: n[3],
                        p,
                    });
                }
            }
            Kind::F { ctrl, gain } => {
                if *gain != 0.0 {
                    let p = add(
                        &mut params,
                        nm.to_string(),
                        elem_latex(nm),
                        *gain,
                        Role::Gain,
                        "A/A",
                        nm,
                    )?;
                    stamps.push(Stamp::Cccs {
                        a: n[0],
                        b: n[1],
                        ctrl: *ctrl,
                        p,
                    });
                }
            }
            Kind::H { ctrl, gain } => {
                let p = if *gain != 0.0 {
                    Some(add(
                        &mut params,
                        nm.to_string(),
                        elem_latex(nm),
                        *gain,
                        Role::Gain,
                        "Ω",
                        nm,
                    )?)
                } else {
                    None
                };
                stamps.push(Stamp::Ccvs {
                    e: ei,
                    a: n[0],
                    b: n[1],
                    ctrl: *ctrl,
                    p,
                });
            }
            Kind::M { .. } => {
                let (d, g, s, b) = (n[0], n[1], n[2], n[3]);
                let Some(op) = op else {
                    add_mos_symbolic(&mut params, &mut stamps, nm, d, g, s, b)?;
                    continue;
                };
                let Some(DevOp::Mos(m)) = &op.dev[ei] else {
                    unreachable!()
                };
                let (ed, es) = if m.reversed { (s, d) } else { (d, s) };
                if m.region == MosRegion::Cutoff {
                    warnings.push(format!("{nm} is in cutoff (no small-signal gain)"));
                }
                if m.gm > 0.0 {
                    let p = add(
                        &mut params,
                        format!("gm_{nm}"),
                        dev_latex("g", "m", nm),
                        m.gm,
                        Role::Gm,
                        "S",
                        nm,
                    )?;
                    stamps.push(Stamp::Vccs {
                        op: ed,
                        on: es,
                        cp: g,
                        cn: es,
                        p,
                    });
                }
                if m.gds > 0.0 {
                    let p = add(
                        &mut params,
                        format!("ro_{nm}"),
                        dev_latex("r", "o", nm),
                        1.0 / m.gds,
                        Role::DeviceR,
                        "Ω",
                        nm,
                    )?;
                    stamps.push(Stamp::Adm { a: ed, b: es, p });
                }
                if m.gmb > 0.0 && b != es {
                    let p = add(
                        &mut params,
                        format!("gmb_{nm}"),
                        dev_latex("g", "mb", nm),
                        m.gmb,
                        Role::Gmb,
                        "S",
                        nm,
                    )?;
                    stamps.push(Stamp::Vccs {
                        op: ed,
                        on: es,
                        cp: b,
                        cn: es,
                        p,
                    });
                }
                if m.gbs.max(m.gbd) > 1e-9 {
                    warnings.push(format!(
                        "{nm}: a bulk junction is forward biased; its conductance is not modeled"
                    ));
                }
                if m.region == MosRegion::Triode {
                    warnings.push(format!("{nm} is in triode; r_o here is its channel resistance"));
                }
            }
            Kind::Q { .. } => {
                let (c, b, em) = (n[0], n[1], n[2]);
                let Some(op) = op else {
                    let p = add(
                        &mut params,
                        format!("gm_{nm}"),
                        dev_latex("g", "m", nm),
                        f64::NAN,
                        Role::Gm,
                        "S",
                        nm,
                    )?;
                    stamps.push(Stamp::Vccs {
                        op: c,
                        on: em,
                        cp: b,
                        cn: em,
                        p,
                    });
                    let p = add(
                        &mut params,
                        format!("rpi_{nm}"),
                        dev_latex("r", "\\pi ", nm),
                        f64::NAN,
                        Role::DeviceR,
                        "Ω",
                        nm,
                    )?;
                    stamps.push(Stamp::Adm { a: b, b: em, p });
                    let p = add(
                        &mut params,
                        format!("ro_{nm}"),
                        dev_latex("r", "o", nm),
                        f64::NAN,
                        Role::DeviceR,
                        "Ω",
                        nm,
                    )?;
                    stamps.push(Stamp::Adm { a: c, b: em, p });
                    continue;
                };
                let Some(DevOp::Bjt(q)) = &op.dev[ei] else {
                    unreachable!()
                };
                if q.region != "forward-active" {
                    warnings.push(format!("{nm} is in {}", q.region));
                }
                if q.gm != 0.0 {
                    let p = add(
                        &mut params,
                        format!("gm_{nm}"),
                        dev_latex("g", "m", nm),
                        q.gm,
                        Role::Gm,
                        "S",
                        nm,
                    )?;
                    stamps.push(Stamp::Vccs {
                        op: c,
                        on: em,
                        cp: b,
                        cn: em,
                        p,
                    });
                }
                if q.gpi > 0.0 {
                    let p = add(
                        &mut params,
                        format!("rpi_{nm}"),
                        dev_latex("r", "\\pi ", nm),
                        1.0 / q.gpi,
                        Role::DeviceR,
                        "Ω",
                        nm,
                    )?;
                    stamps.push(Stamp::Adm { a: b, b: em, p });
                }
                if q.go > 0.0 {
                    let p = add(
                        &mut params,
                        format!("ro_{nm}"),
                        dev_latex("r", "o", nm),
                        1.0 / q.go,
                        Role::DeviceR,
                        "Ω",
                        nm,
                    )?;
                    stamps.push(Stamp::Adm { a: c, b: em, p });
                }
                if q.gmu > 1e-6 * q.gpi {
                    let p = add(
                        &mut params,
                        format!("rmu_{nm}"),
                        dev_latex("r", "\\mu ", nm),
                        1.0 / q.gmu,
                        Role::DeviceR,
                        "Ω",
                        nm,
                    )?;
                    stamps.push(Stamp::Adm { a: b, b: c, p });
                }
            }
            Kind::D { .. } => {
                let rd = match op.map(|o| &o.dev[ei]) {
                    Some(Some(DevOp::Diode(dd))) => 1.0 / dd.gd,
                    _ => f64::NAN,
                };
                let p = add(
                    &mut params,
                    format!("rd_{nm}"),
                    dev_latex("r", "d", nm),
                    rd,
                    Role::DeviceR,
                    "Ω",
                    nm,
                )?;
                stamps.push(Stamp::Adm { a: n[0], b: n[1], p });
            }
        }
    }
    // Disambiguate colliding LaTeX names (e.g. M1 and Q1 both give g_{m1}).
    let mut seen: HashMap<String, usize> = HashMap::new();
    for p in &params {
        *seen.entry(p.latex.clone()).or_default() += 1;
    }
    for p in params.iter_mut() {
        if seen[&p.latex] > 1 && matches!(p.role, Role::Gm | Role::Gmb | Role::DeviceR) {
            let base = p.latex.split('_').next().unwrap_or("x").to_string();
            let sub = p
                .name
                .split('_')
                .next()
                .unwrap_or("")
                .trim_start_matches(['g', 'r'])
                .replace("pi", "\\pi ")
                .replace("mu", "\\mu ");
            p.latex = format!("{base}_{{{sub},{}}}", esc(&p.element));
        }
    }
    let mut inv_mask = 0;
    let mut reactive_mask = 0;
    for (i, p) in params.iter().enumerate() {
        if p.inverted {
            inv_mask |= 1u128 << i;
        }
        if p.reactive {
            reactive_mask |= 1u128 << i;
        }
    }
    Ok(SsCircuit {
        params,
        stamps,
        warnings,
        inv_mask,
        reactive_mask,
    })
}

pub enum Excite {
    /// AC unit excitation of an independent source (V: 1 V, I: 1 A).
    Source(usize),
    /// 1 A test current into `into`, returning from `outof`.
    Inject { into: usize, outof: usize },
}

pub struct System {
    pub dim: usize,
    pub a: Vec<Vec<Poly>>,
    pub b: Vec<i128>,
    /// Column of each netlist node (None for ground, or merged into ground).
    pub node_col: Vec<Option<usize>>,
    pub branch_col: HashMap<usize, usize>,
}

fn find(uf: &mut [usize], x: usize) -> usize {
    let mut r = x;
    while uf[r] != r {
        r = uf[r];
    }
    let mut c = x;
    while uf[c] != r {
        let n = uf[c];
        uf[c] = r;
        c = n;
    }
    r
}

/// Builds the small-signal MNA system. Independent V sources other than an
/// excited one are shorted (their nodes merged) unless they control an F/H
/// source; independent I sources other than an excited one are open.
pub fn system(net: &Netlist, ss: &SsCircuit, ex: &Excite) -> System {
    let nnodes = net.nodes.len();
    let mut controllers: Vec<usize> = Vec::new();
    for s in &ss.stamps {
        if let Stamp::Cccs { ctrl, .. } | Stamp::Ccvs { ctrl, .. } = s {
            controllers.push(*ctrl);
        }
    }
    let excited = match ex {
        Excite::Source(e) => Some(*e),
        _ => None,
    };
    let kept_v = |e: usize| excited == Some(e) || controllers.contains(&e);

    let mut uf: Vec<usize> = (0..nnodes).collect();
    for s in &ss.stamps {
        if let Stamp::VSrc { e, a, b } = s {
            if !kept_v(*e) {
                let (ra, rb) = (find(&mut uf, *a), find(&mut uf, *b));
                // Keep ground (0) as the representative.
                let (lo, hi) = if ra < rb { (ra, rb) } else { (rb, ra) };
                uf[hi] = lo;
            }
        }
    }
    let mut col_of_rep: HashMap<usize, usize> = HashMap::new();
    let mut node_col = vec![None; nnodes];
    let mut dim = 0;
    for n in 1..nnodes {
        let r = find(&mut uf, n);
        if r == 0 {
            continue;
        }
        let c = *col_of_rep.entry(r).or_insert_with(|| {
            dim += 1;
            dim - 1
        });
        node_col[n] = Some(c);
    }
    let mut branch_col = HashMap::new();
    for s in &ss.stamps {
        let e = match s {
            Stamp::VSrc { e, .. } if kept_v(*e) => Some(*e),
            Stamp::Vcvs { e, .. } | Stamp::Ccvs { e, .. } | Stamp::Ind { e, .. } => Some(*e),
            _ => None,
        };
        if let Some(e) = e {
            branch_col.insert(e, dim);
            dim += 1;
        }
    }
    let mut a = vec![vec![Poly::zero(); dim]; dim];
    let nc = |n: usize| node_col[n];
    let mut put = |r: Option<usize>, c: Option<usize>, m: Mono, v: i128| {
        if let (Some(r), Some(c)) = (r, c) {
            a[r][c].add_term(m, v);
        }
    };
    let bit = |p: usize| 1u128 << p;
    for s in &ss.stamps {
        match *s {
            Stamp::Adm { a: x, b: y, p } => {
                let (cx, cy) = (nc(x), nc(y));
                if cx == cy {
                    continue;
                }
                put(cx, cx, bit(p), 1);
                put(cy, cy, bit(p), 1);
                put(cx, cy, bit(p), -1);
                put(cy, cx, bit(p), -1);
            }
            Stamp::Vccs { op, on, cp, cn, p } => {
                let (o1, o2, c1, c2) = (nc(op), nc(on), nc(cp), nc(cn));
                if o1 == o2 || c1 == c2 {
                    continue;
                }
                put(o1, c1, bit(p), 1);
                put(o1, c2, bit(p), -1);
                put(o2, c1, bit(p), -1);
                put(o2, c2, bit(p), 1);
            }
            Stamp::VSrc { e, a: x, b: y } => {
                if let Some(&k) = branch_col.get(&e) {
                    let (cx, cy) = (nc(x), nc(y));
                    put(cx, Some(k), 0, 1);
                    put(cy, Some(k), 0, -1);
                    put(Some(k), cx, 0, 1);
                    put(Some(k), cy, 0, -1);
                }
            }
            Stamp::ISrc { .. } => {}
            Stamp::Vcvs {
                e,
                a: x,
                b: y,
                cp,
                cn,
                p,
            } => {
                let k = Some(branch_col[&e]);
                let (cx, cy) = (nc(x), nc(y));
                put(cx, k, 0, 1);
                put(cy, k, 0, -1);
                put(k, cx, 0, 1);
                put(k, cy, 0, -1);
                if let Some(p) = p {
                    put(k, nc(cp), bit(p), -1);
                    put(k, nc(cn), bit(p), 1);
                }
            }
            Stamp::Cccs { a: x, b: y, ctrl, p } => {
                let k = branch_col.get(&ctrl).copied();
                put(nc(x), k, bit(p), 1);
                put(nc(y), k, bit(p), -1);
            }
            Stamp::Ccvs { e, a: x, b: y, ctrl, p } => {
                let k = Some(branch_col[&e]);
                let (cx, cy) = (nc(x), nc(y));
                put(cx, k, 0, 1);
                put(cy, k, 0, -1);
                put(k, cx, 0, 1);
                put(k, cy, 0, -1);
                if let Some(p) = p {
                    put(k, branch_col.get(&ctrl).copied(), bit(p), -1);
                }
            }
            Stamp::Ind { e, a: x, b: y, p } => {
                let k = Some(branch_col[&e]);
                let (cx, cy) = (nc(x), nc(y));
                put(cx, k, 0, 1);
                put(cy, k, 0, -1);
                put(k, cx, 0, 1);
                put(k, cy, 0, -1);
                put(k, k, bit(p), -1);
            }
        }
    }
    let mut b = vec![0i128; dim];
    let mut inject = |into: Option<usize>, outof: Option<usize>| {
        if let Some(i) = into {
            b[i] += 1;
        }
        if let Some(o) = outof {
            b[o] -= 1;
        }
    };
    match ex {
        Excite::Source(e) => match &net.elements[*e].kind {
            Kind::V { .. } => b[branch_col[e]] = 1,
            Kind::I { .. } => {
                // SPICE current flows from n+ through the source to n−.
                let n = &net.elements[*e].nodes;
                inject(nc(n[1]), nc(n[0]));
            }
            _ => unreachable!(),
        },
        Excite::Inject { into, outof } => inject(nc(*into), nc(*outof)),
    }
    System {
        dim,
        a,
        b,
        node_col,
        branch_col,
    }
}

impl System {
    /// Cramer numerator for unknown `col`: det with that column replaced by b.
    pub fn cramer(&self, col: usize, max_terms: usize) -> Result<Poly, String> {
        let mut a = self.a.clone();
        for (r, row) in a.iter_mut().enumerate() {
            row[col] = Poly::constant(self.b[r]);
        }
        crate::det::det(&a, max_terms)
    }
}
