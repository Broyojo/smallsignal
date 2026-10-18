//! Small-signal linearization and symbolic MNA systems.

use crate::dc::{DevOp, Op};
use crate::devices::MosRegion;
use crate::netlist::{Kind, Netlist};
use crate::poly::{Mono, Poly};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    /// Bias currents and Taylor coefficients: symbols outside the MNA
    /// system (noise and distortion expressions).
    Current,
    Coeff,
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
    /// Plain identifier, e.g. `RD`, `gm_M1`, `ro_M1` (`ron_M1` in triode).
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
    /// An output resistance of a device outside saturation (a MOS triode
    /// channel's R_on, a saturated BJT's r_o): small, so hand analysis
    /// keeps it finite.
    pub linear: bool,
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
    /// An assumed short (an element taken to zero impedance): its nodes are
    /// merged, as for a zeroed voltage source.
    Short {
        a: usize,
        b: usize,
    },
}

/// Monomials are `u128` parameter sets, so an exact (symbolic) system holds
/// at most this many parameters; a larger circuit is `wide` and numeric.
pub const MONO_BITS: usize = 128;

/// Parameters a (numeric) small-signal circuit may have at all.
const MAX_PARAMS: usize = 4096;

#[derive(Clone, Debug)]
pub struct SsCircuit {
    pub params: Vec<Param>,
    pub stamps: Vec<Stamp>,
    pub warnings: Vec<String>,
    /// Inverted and reactive parameters as monomial masks (0 when `wide`).
    pub inv_mask: Mono,
    pub reactive_mask: Mono,
    /// Junction conductances (MOS bulk gbs/gbd, BJT gμ) that `analyze` may
    /// prove negligible and omit; see `omit`.
    pub optional: Vec<usize>,
}

/// Escapes TeX specials so a name like `R{x}` or `R\\x` renders as text
/// and can never inject a macro.
pub(crate) fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '_' | '{' | '}' | '$' | '&' | '#' | '%' => {
                out.push('\\');
                out.push(c);
            }
            '\\' => out.push_str("\\backslash "),
            '^' => out.push_str("\\hat{}"),
            '~' => out.push_str("\\sim "),
            _ => out.push(c),
        }
    }
    out
}

/// `R_{D}` from `RD`; `R` alone stays `R`.
pub(crate) fn elem_latex(name: &str) -> String {
    let (head, rest) = name.split_at(1);
    if rest.is_empty() {
        head.to_string()
    } else {
        format!("{}_{{{}}}", head.to_ascii_uppercase(), esc(rest))
    }
}

/// `g_{m1}` for M1, `g_{m,in}` for Min, `g_{m}` for M; `g_{m1,2}` for a
/// merged M1,2 (commas only arise from merging: the parser splits on them).
pub(crate) fn dev_latex_sub(base: &str, sub: &str, elem: &str) -> String {
    dev_latex(base, sub, elem)
}

fn dev_latex(base: &str, sub: &str, elem: &str) -> String {
    let rest = &elem[1..];
    if rest.is_empty() {
        format!("{base}_{{{sub}}}")
    } else if rest.chars().all(|c| c.is_ascii_digit() || c == ',') {
        format!("{base}_{{{sub}{rest}}}")
    } else {
        format!("{base}_{{{sub},{}}}", esc(rest))
    }
}

/// TeX subscript of each device capacitance kind (the parameter name's
/// prefix, `cgs_M1`): C_{gs}, C_{db}, C_{\pi}…
pub(crate) fn cap_sub(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "cgs" => "gs",
        "cgd" => "gd",
        "cgb" => "gb",
        "cbd" => "db",
        "cbs" => "sb",
        "cpi" => "\\pi ",
        "cmu" => "\\mu ",
        "ccs" => "cs",
        "cbsub" => "bs",
        "cx" => "x",
        "cj" => "j",
        _ => return None,
    })
}

/// A device capacitance `kind` of element `nm` between `a` and `b` (a VCCS
/// s·C·(v_cp − v_cn) from `a` to `b` when `ctrl` is given). Zero values,
/// and a capacitance with both ends on one node, are not stamped; NaN is
/// the symbolic value.
#[allow(clippy::too_many_arguments)]
fn add_cap(
    params: &mut Vec<Param>,
    stamps: &mut Vec<Stamp>,
    nm: &str,
    kind: &str,
    a: usize,
    b: usize,
    ctrl: Option<(usize, usize)>,
    value: f64,
) -> Result<(), String> {
    if value == 0.0 || (ctrl.is_none() && a == b) || ctrl.is_some_and(|(cp, cn)| cp == cn || a == b) {
        return Ok(());
    }
    let sub = cap_sub(kind).expect("capacitance kind");
    let p = add(
        params,
        format!("{kind}_{nm}"),
        dev_latex("C", sub, nm),
        value,
        Role::Capacitor,
        "F",
        nm,
    )?;
    stamps.push(match ctrl {
        None => Stamp::Adm { a, b, p },
        Some((cp, cn)) => Stamp::Vccs {
            op: a,
            on: b,
            cp,
            cn,
            p,
        },
    });
    Ok(())
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
    if params.len() >= MAX_PARAMS {
        return Err(format!("too many small-signal parameters (limit {MAX_PARAMS})"));
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
        linear: false,
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

/// Adds every nonzero junction conductance (MOS bulk junctions, BJT gμ) to
/// the model and returns their parameters. Which of them may be left out is
/// not decided here by a heuristic: `analyze` proves it on the full numeric
/// system (see there), so a junction that matters is never dropped.
fn add_junctions(
    net: &Netlist,
    params: &mut Vec<Param>,
    stamps: &mut Vec<Stamp>,
    junctions: &[(usize, usize, usize, f64, &str, &str)],
) -> Result<Vec<usize>, String> {
    let mut out = Vec::new();
    for &(ei, x, y, gj, which, sub) in junctions {
        if gj.is_nan() || gj <= 0.0 || x == y {
            continue;
        }
        let nm = &net.elements[ei].name;
        let p = add(
            params,
            format!("r{which}_{nm}"),
            dev_latex("r", sub, nm),
            1.0 / gj,
            Role::DeviceR,
            "Ω",
            nm,
        )?;
        stamps.push(Stamp::Adm { a: x, b: y, p });
        out.push(p);
    }
    Ok(out)
}

fn mult_of(kind: &Kind) -> f64 {
    match kind {
        Kind::Q { mult, .. } | Kind::M { mult, .. } | Kind::D { mult, .. } => *mult,
        _ => 1.0,
    }
}

/// A device capacitance at the operating point: `kind` (the parameter
/// name's prefix) between `a` and `b`, or with `ctrl` a transcapacitance
/// s·value·(v_cp − v_cn) from `a` to `b`. Zero values included.
pub struct DevCap {
    pub kind: &'static str,
    pub a: usize,
    pub b: usize,
    pub ctrl: Option<(usize, usize)>,
    pub value: f64,
}

/// Every capacitance of device `ei` at `op`, as ngspice's AC load stamps
/// them (see `caps`): MOS gs, gd, gb, db, sb; BJT π, μ, substrate, and the
/// transcapacitance C_x = −geqcb (s·geqcb·v_bc from base to emitter, so
/// C_x·s·v_bc from emitter to base, positive in forward bias); diode j.
pub fn device_caps(e: &crate::netlist::Element, op: &Op, ei: usize) -> Vec<DevCap> {
    let n = &e.nodes;
    let v = |k: usize| op.v[k];
    let cap = |kind, a, b, value| DevCap {
        kind,
        a,
        b,
        ctrl: None,
        value,
    };
    match (&e.kind, &op.dev[ei]) {
        (
            Kind::M {
                model,
                w,
                l,
                mult,
                geom,
            },
            Some(DevOp::Mos(m)),
        ) => {
            let (d, g, s, b) = (n[0], n[1], n[2], n[3]);
            let ty = model.ty;
            let c = crate::caps::mos_caps(model, *w, *l, *mult, geom, (ty * m.vgs, ty * m.vds, ty * m.vbs));
            vec![
                cap("cgs", g, s, c.cgs),
                cap("cgd", g, d, c.cgd),
                cap("cgb", g, b, c.cgb),
                cap("cbd", b, d, c.cbd),
                cap("cbs", b, s, c.cbs),
            ]
        }
        (
            Kind::Q {
                model, area, mult, sub, ..
            },
            Some(DevOp::Bjt(_)),
        ) => {
            let (c, b, em) = (n[0], n[1], n[2]);
            let (ty, cm) = (model.ty, &model.caps);
            let sub_con = if cm.subs > 0.0 { c } else { b };
            let vsub = sub.map_or(0.0, |sn| ty * cm.subs * (v(sn) - v(sub_con)));
            let bc = crate::caps::bjt_caps(model, *area, *mult, ty * (v(b) - v(em)), ty * (v(b) - v(c)), vsub);
            let mut out = vec![cap("cpi", b, em, bc.cpi), cap("cmu", b, c, bc.cmu)];
            if let Some(sn) = sub {
                out.push(cap(if cm.subs > 0.0 { "ccs" } else { "cbsub" }, *sn, sub_con, bc.csub));
            }
            out.push(DevCap {
                kind: "cx",
                a: em,
                b,
                ctrl: Some((b, c)),
                value: 0.0 - bc.geqcb,
            });
            out
        }
        (Kind::D { model, area, mult }, Some(DevOp::Diode(dd))) => {
            vec![cap(
                "cj",
                n[0],
                n[1],
                crate::caps::diode_cap(model, area * mult, dd.vd, dd.gd),
            )]
        }
        _ => Vec::new(),
    }
}

/// With `op = None` the analysis is purely symbolic: every MOSFET is taken
/// as saturated and every BJT as forward-active, and all values are NaN.
pub fn build(net: &Netlist, op: Option<&Op>) -> Result<SsCircuit, String> {
    build_with(net, op, &[])
}

/// `build`, with `linear` the elements known (in symbolic mode) not to be
/// saturated or forward-active: their r_o is marked `linear`.
pub fn build_with(net: &Netlist, op: Option<&Op>, linear: &[usize]) -> Result<SsCircuit, String> {
    let mut params: Vec<Param> = Vec::new();
    let mut stamps = Vec::new();
    let mut warnings = Vec::new();
    // MOS bulk junctions (element, bulk, other terminal, conductance, which),
    // added after the other elements once node conductances are known.
    let mut junctions: Vec<(usize, usize, usize, f64, &str, &str)> = Vec::new();
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
            Kind::M { model, mult, geom, .. } => {
                let (d, g, s, b) = (n[0], n[1], n[2], n[3]);
                let Some(op) = op else {
                    add_mos_symbolic(&mut params, &mut stamps, nm, d, g, s, b)?;
                    let lin = linear.contains(&ei);
                    if lin {
                        // Known to be in triode: its channel resistance.
                        let ro = format!("ro_{nm}");
                        for p in params.iter_mut().filter(|p| p.name == ro) {
                            p.name = format!("ron_{nm}");
                            p.latex = dev_latex("R", "on", nm);
                            p.linear = true;
                        }
                    }
                    // The capacitances the card can give a saturated device
                    // (a triode one when its region is known): Meyer C_gd and
                    // C_gb vanish in saturation, so only overlap remains.
                    let c = &model.caps;
                    let (czbd, czbdsw, czbs, czbssw) = crate::caps::mos_zero_bias(c, *mult, geom);
                    let some = |x: bool| if x { f64::NAN } else { 0.0 };
                    let meyer = c.cox > 0.0;
                    for (kind, x, y, present) in [
                        ("cgs", g, s, meyer || c.cgso != 0.0),
                        ("cgd", g, d, (meyer && lin) || c.cgdo != 0.0),
                        ("cgb", g, b, c.cgbo != 0.0),
                        ("cbd", b, d, czbd != 0.0 || czbdsw != 0.0),
                        ("cbs", b, s, czbs != 0.0 || czbssw != 0.0),
                    ] {
                        add_cap(&mut params, &mut stamps, nm, kind, x, y, None, some(present))?;
                    }
                    continue;
                };
                let Some(DevOp::Mos(m)) = &op.dev[ei] else {
                    unreachable!()
                };
                let (ed, es) = if m.reversed { (s, d) } else { (d, s) };
                if m.region == MosRegion::Cutoff {
                    warnings.push(format!("{nm} is off"));
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
                    // In triode the output conductance is the channel's own:
                    // R_on, the same 1/g_ds.
                    let triode = m.region == MosRegion::Triode;
                    let (name, latex) = if triode {
                        (format!("ron_{nm}"), dev_latex("R", "on", nm))
                    } else {
                        (format!("ro_{nm}"), dev_latex("r", "o", nm))
                    };
                    let p = add(&mut params, name, latex, 1.0 / m.gds, Role::DeviceR, "Ω", nm)?;
                    params[p].linear = triode;
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
                junctions.push((ei, b, s, m.gbs, "bs", "bs"));
                junctions.push((ei, b, d, m.gbd, "bd", "bd"));
                if m.gbs.max(m.gbd) > 1e-6 {
                    warnings.push(format!("{nm} bulk junction is forward biased"));
                }
                if m.region == MosRegion::Triode {
                    warnings.push(format!("{nm} is in triode"));
                }
                for c in device_caps(e, op, ei) {
                    add_cap(&mut params, &mut stamps, nm, c.kind, c.a, c.b, c.ctrl, c.value)?;
                }
            }
            Kind::Q {
                model, sub, float_sub, ..
            } => {
                let (c, b, em) = (n[0], n[1], n[2]);
                let cm = &model.caps;
                // The substrate junction ends at the collector (vertical) or
                // the base (lateral).
                let sub_con = if cm.subs > 0.0 { c } else { b };
                let sub_kind = if cm.subs > 0.0 { "ccs" } else { "cbsub" };
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
                    params[p].linear = linear.contains(&ei);
                    stamps.push(Stamp::Adm { a: c, b: em, p });
                    // Forward-active: C_π from CJE and TF, C_μ from CJC. The
                    // transcapacitance (TF with VAF) is left out, as hand
                    // analysis does.
                    let some = |x: bool| if x { f64::NAN } else { 0.0 };
                    add_cap(
                        &mut params,
                        &mut stamps,
                        nm,
                        "cpi",
                        b,
                        em,
                        None,
                        some(cm.cje != 0.0 || cm.tf != 0.0),
                    )?;
                    add_cap(
                        &mut params,
                        &mut stamps,
                        nm,
                        "cmu",
                        b,
                        c,
                        None,
                        some(cm.cjc != 0.0 || cm.tr != 0.0),
                    )?;
                    if let (Some(sn), false) = (sub, float_sub) {
                        add_cap(
                            &mut params,
                            &mut stamps,
                            nm,
                            sub_kind,
                            *sn,
                            sub_con,
                            None,
                            some(cm.cjs != 0.0),
                        )?;
                    }
                    continue;
                };
                let Some(DevOp::Bjt(q)) = &op.dev[ei] else {
                    unreachable!()
                };
                if q.region != "forward-active" {
                    let state = if q.region == "cutoff" {
                        "is off".to_string()
                    } else {
                        format!("is in {}", q.region)
                    };
                    warnings.push(format!("{nm} {state}"));
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
                    params[p].linear = q.region == "saturation";
                    stamps.push(Stamp::Adm { a: c, b: em, p });
                }
                junctions.push((ei, b, c, q.gmu, "mu", "\\mu "));
                if let (Some(sn), true) = (sub, float_sub) {
                    // The substrate junction's gmin holds a floating substrate.
                    junctions.push((ei, *sn, sub_con, mult_of(&e.kind) * net.gmin, "sub", "sub"));
                }
                for c in device_caps(e, op, ei) {
                    add_cap(&mut params, &mut stamps, nm, c.kind, c.a, c.b, c.ctrl, c.value)?;
                }
            }
            Kind::D { model, .. } => {
                let (rd, cj) = match op {
                    Some(op) => {
                        let rd = match &op.dev[ei] {
                            Some(DevOp::Diode(dd)) => 1.0 / dd.gd,
                            _ => f64::NAN,
                        };
                        (rd, device_caps(e, op, ei).first().map_or(0.0, |c| c.value))
                    }
                    None => (
                        f64::NAN,
                        if model.caps.cjo != 0.0 || model.caps.tt != 0.0 {
                            f64::NAN
                        } else {
                            0.0
                        },
                    ),
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
                add_cap(&mut params, &mut stamps, nm, "cj", n[0], n[1], None, cj)?;
            }
        }
    }
    let optional = add_junctions(net, &mut params, &mut stamps, &junctions)?;
    // Disambiguate colliding LaTeX names (e.g. M1 and Q1 both give g_{m1}).
    let mut seen: HashMap<String, usize> = HashMap::new();
    for p in &params {
        *seen.entry(p.latex.clone()).or_default() += 1;
    }
    for p in params.iter_mut() {
        let kind = p.name.split('_').next().unwrap_or("");
        if seen[&p.latex] > 1 && p.role == Role::Capacitor && p.name != p.element {
            if let Some(sub) = cap_sub(kind) {
                p.latex = format!("C_{{{sub},{}}}", esc(&p.element));
            }
            continue;
        }
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
    let (inv_mask, reactive_mask) = masks(&params);
    Ok(SsCircuit {
        params,
        stamps,
        warnings,
        inv_mask,
        reactive_mask,
        optional,
    })
}

/// Inverted and reactive masks; both 0 for a wide circuit (no monomials).
pub(crate) fn masks(params: &[Param]) -> (Mono, Mono) {
    let (mut inv_mask, mut reactive_mask) = (0, 0);
    if params.len() > MONO_BITS {
        return (0, 0);
    }
    for (i, p) in params.iter().enumerate() {
        if p.inverted {
            inv_mask |= 1u128 << i;
        }
        if p.reactive {
            reactive_mask |= 1u128 << i;
        }
    }
    (inv_mask, reactive_mask)
}

impl SsCircuit {
    /// Over `MONO_BITS` parameters: no exact form exists, only the numeric
    /// system (`System::terms`).
    pub fn wide(&self) -> bool {
        self.params.len() > MONO_BITS
    }

    /// Whether any parameter carries s.
    pub fn has_reactive(&self) -> bool {
        self.params.iter().any(|p| p.reactive)
    }

    fn param_of(st: &Stamp) -> Option<usize> {
        match *st {
            Stamp::Adm { p, .. } | Stamp::Vccs { p, .. } | Stamp::Cccs { p, .. } | Stamp::Ind { p, .. } => Some(p),
            Stamp::Vcvs { p, .. } | Stamp::Ccvs { p, .. } => p,
            Stamp::VSrc { .. } | Stamp::ISrc { .. } | Stamp::Short { .. } => None,
        }
    }

    /// The same circuit without the given parameters (and their stamps),
    /// parameters renumbered.
    pub fn omit(&self, drop: &[usize]) -> SsCircuit {
        let mut index = vec![usize::MAX; self.params.len()];
        let mut params = Vec::new();
        for (i, p) in self.params.iter().enumerate() {
            if !drop.contains(&i) {
                index[i] = params.len();
                params.push(p.clone());
            }
        }
        let remap = |p: usize| index[p];
        let stamps = self
            .stamps
            .iter()
            .filter(|st| Self::param_of(st).is_none_or(|p| !drop.contains(&p)))
            .map(|st| {
                let mut st = st.clone();
                match &mut st {
                    Stamp::Adm { p, .. } | Stamp::Vccs { p, .. } | Stamp::Cccs { p, .. } | Stamp::Ind { p, .. } => {
                        *p = remap(*p)
                    }
                    Stamp::Vcvs { p, .. } | Stamp::Ccvs { p, .. } => {
                        if let Some(q) = p {
                            *q = remap(*q)
                        }
                    }
                    Stamp::VSrc { .. } | Stamp::ISrc { .. } | Stamp::Short { .. } => {}
                }
                st
            })
            .collect();
        let (inv_mask, reactive_mask) = masks(&params);
        SsCircuit {
            params,
            stamps,
            warnings: self.warnings.clone(),
            inv_mask,
            reactive_mask,
            optional: self
                .optional
                .iter()
                .filter(|p| !drop.contains(p))
                .map(|&p| remap(p))
                .collect(),
        }
    }
}

#[derive(Clone, Debug)]
pub enum Excite {
    /// AC unit excitation of an independent source (V: 1 V, I: 1 A).
    Source(usize),
    /// Several independent sources at once, each with an integer weight
    /// (differential: +1/−1, common mode: +1/+1).
    Sources(Vec<(usize, i128)>),
    /// 1 A test current into `into`, returning from `outof`.
    Inject { into: usize, outof: usize },
    /// A test current as in `Inject`, with the listed voltage sources
    /// removed (open) rather than shorted: the port between two inputs.
    InjectOpen {
        into: usize,
        outof: usize,
        open: Vec<usize>,
    },
}

pub struct System {
    pub dim: usize,
    /// The matrix over the parameters; rows are empty when the circuit is
    /// wide (`det` then reports it over budget).
    pub a: Vec<Vec<Poly>>,
    /// Every stamp entry (row, column, parameter or None for a constant,
    /// coefficient): the numeric matrix, for any number of parameters.
    pub terms: Vec<Term>,
    pub b: Vec<i128>,
    /// Column of each netlist node (None for ground, or merged into ground).
    pub node_col: Vec<Option<usize>>,
    pub branch_col: HashMap<usize, usize>,
}

/// One stamp entry of the MNA matrix: coef·p (·s when p is reactive) at
/// (row, col), or the constant coef when p is None.
#[derive(Clone, Copy, Debug)]
pub struct Term {
    pub row: usize,
    pub col: usize,
    pub param: Option<usize>,
    pub coef: i128,
}

impl System {
    /// The value of each term at s (`ss` the circuit the system was built
    /// from).
    pub fn term_value(&self, t: &Term, ss: &SsCircuit, s: num_complex::Complex64) -> num_complex::Complex64 {
        match t.param {
            None => num_complex::Complex64::new(t.coef as f64, 0.0),
            Some(p) => {
                let v = t.coef as f64 * ss.params[p].mna_value();
                if ss.params[p].reactive {
                    s * v
                } else {
                    num_complex::Complex64::new(v, 0.0)
                }
            }
        }
    }
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
/// source; independent I sources other than an excited one are open. An
/// assumed short merges its nodes too.
pub fn system(net: &Netlist, ss: &SsCircuit, ex: &Excite) -> System {
    let nnodes = net.nodes.len();
    let mut controllers: Vec<usize> = Vec::new();
    for s in &ss.stamps {
        if let Stamp::Cccs { ctrl, .. } | Stamp::Ccvs { ctrl, .. } = s {
            controllers.push(*ctrl);
        }
    }
    let excited: Vec<(usize, i128)> = match ex {
        Excite::Source(e) => vec![(*e, 1)],
        Excite::Sources(list) => list.clone(),
        _ => Vec::new(),
    };
    let opened: &[usize] = match ex {
        Excite::InjectOpen { open, .. } => open,
        _ => &[],
    };
    let kept_v = |e: usize| excited.iter().any(|&(x, _)| x == e) || controllers.contains(&e);

    let mut uf: Vec<usize> = (0..nnodes).collect();
    for s in &ss.stamps {
        let merged = match s {
            Stamp::VSrc { e, a, b } if !kept_v(*e) && !opened.contains(e) => Some((*a, *b)),
            Stamp::Short { a, b } => Some((*a, *b)),
            _ => None,
        };
        if let Some((a, b)) = merged {
            let (ra, rb) = (find(&mut uf, a), find(&mut uf, b));
            // Keep ground (0) as the representative.
            let (lo, hi) = if ra < rb { (ra, rb) } else { (rb, ra) };
            uf[hi] = lo;
        }
    }
    let mut col_of_rep: HashMap<usize, usize> = HashMap::new();
    let mut node_col = vec![None; nnodes];
    let mut dim = 0;
    for (n, col) in node_col.iter_mut().enumerate().skip(1) {
        let r = find(&mut uf, n);
        if r == 0 {
            continue;
        }
        let c = *col_of_rep.entry(r).or_insert_with(|| {
            dim += 1;
            dim - 1
        });
        *col = Some(c);
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
    let wide = ss.wide();
    let mut a = if wide {
        vec![Vec::new(); dim]
    } else {
        vec![vec![Poly::zero(); dim]; dim]
    };
    let mut terms: Vec<Term> = Vec::new();
    let nc = |n: usize| node_col[n];
    let mut put = |r: Option<usize>, c: Option<usize>, param: Option<usize>, coef: i128| {
        if let (Some(r), Some(c)) = (r, c) {
            if !wide {
                a[r][c].add_term(param.map_or(0, |p| 1u128 << p), coef);
            }
            terms.push(Term {
                row: r,
                col: c,
                param,
                coef,
            });
        }
    };
    let bit = |p: usize| Some(p);
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
                    put(cx, Some(k), None, 1);
                    put(cy, Some(k), None, -1);
                    put(Some(k), cx, None, 1);
                    put(Some(k), cy, None, -1);
                }
            }
            Stamp::ISrc { .. } | Stamp::Short { .. } => {}
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
                put(cx, k, None, 1);
                put(cy, k, None, -1);
                put(k, cx, None, 1);
                put(k, cy, None, -1);
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
                put(cx, k, None, 1);
                put(cy, k, None, -1);
                put(k, cx, None, 1);
                put(k, cy, None, -1);
                if let Some(p) = p {
                    put(k, branch_col.get(&ctrl).copied(), bit(p), -1);
                }
            }
            Stamp::Ind { e, a: x, b: y, p } => {
                let k = Some(branch_col[&e]);
                let (cx, cy) = (nc(x), nc(y));
                put(cx, k, None, 1);
                put(cy, k, None, -1);
                put(k, cx, None, 1);
                put(k, cy, None, -1);
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
    let mut branch_b: Vec<(usize, i128)> = Vec::new();
    let mut inject_v = |k: usize, w: i128| branch_b.push((k, w));
    match ex {
        Excite::Source(_) | Excite::Sources(_) => {
            for &(e, w) in &excited {
                match &net.elements[e].kind {
                    Kind::V { .. } => inject_v(branch_col[&e], w),
                    Kind::I { .. } => {
                        // SPICE current flows from n+ through the source to n−.
                        let n = &net.elements[e].nodes;
                        for _ in 0..w.unsigned_abs() {
                            if w > 0 {
                                inject(nc(n[1]), nc(n[0]));
                            } else {
                                inject(nc(n[0]), nc(n[1]));
                            }
                        }
                    }
                    _ => unreachable!(),
                }
            }
        }
        Excite::Inject { into, outof } | Excite::InjectOpen { into, outof, .. } => inject(nc(*into), nc(*outof)),
    }
    for (k, w) in branch_b {
        b[k] += w;
    }
    System {
        dim,
        a,
        terms,
        b,
        node_col,
        branch_col,
    }
}

impl System {
    /// Cramer numerator for unknown `col`: det with that column replaced by b.
    pub fn cramer(&self, col: usize, max_terms: usize) -> Result<Poly, String> {
        if self.a.iter().any(|r| r.len() != self.dim) {
            return Err(crate::det::too_large(max_terms));
        }
        let mut a = self.a.clone();
        for (r, row) in a.iter_mut().enumerate() {
            row[col] = Poly::constant(self.b[r]);
        }
        crate::det::det(&a, max_terms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_escaped_for_tex() {
        assert_eq!(elem_latex("RD"), "R_{D}");
        assert_eq!(elem_latex("R_load"), "R_{\\_load}");
        assert_eq!(elem_latex("R{x}"), "R_{\\{x\\}}");
        assert_eq!(elem_latex("R\\href"), "R_{\\backslash href}");
        assert_eq!(elem_latex("R$1^2"), "R_{\\$1\\hat{}2}");
        assert_eq!(dev_latex("g", "m", "M1"), "g_{m1}");
        assert_eq!(dev_latex("g", "m", "Min"), "g_{m,in}");
        assert_eq!(dev_latex("g", "m", "M{"), "g_{m,\\{}");
    }
}
