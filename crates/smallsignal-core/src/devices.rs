//! Device equations, following ngspice's mos1load / bjtload / dioload so the
//! operating point (and hence every gm, ro, rπ) matches the simulator.
//! Voltages here are in the device's normalized frame: multiplied by `ty`
//! (+1 for NMOS/NPN, -1 for PMOS/PNP).

/// ngspice constants (CONSTboltz, CHARGE) at the default 27 °C.
pub const BOLTZ: f64 = 1.38064852e-23;
pub const CHARGE: f64 = 1.6021766208e-19;
pub const TEMP: f64 = 300.15;
const MAX_EXP_ARG: f64 = 709.0;

pub fn vt() -> f64 {
    BOLTZ * TEMP / CHARGE
}

#[derive(Clone, Debug)]
pub struct MosModel {
    pub name: String,
    pub ty: f64,
    pub kp: f64,
    pub vto: f64,
    pub lambda: f64,
    pub gamma: f64,
    pub phi: f64,
    /// Bulk junction saturation current.
    pub is: f64,
    /// Oxide capacitance per area (F/m²) from TOX (default 1e-7 m); used by
    /// the flicker noise model only.
    pub cox: f64,
    /// Flicker noise coefficient and exponent (ngspice KF, AF).
    pub kf: f64,
    pub af: f64,
    pub caps: crate::caps::MosCapModel,
}

#[derive(Clone, Debug)]
pub struct BjtModel {
    pub name: String,
    pub ty: f64,
    pub is: f64,
    pub bf: f64,
    pub br: f64,
    /// Forward Early voltage; 0 means infinite.
    pub vaf: f64,
    pub kf: f64,
    pub af: f64,
    pub caps: crate::caps::BjtCapModel,
}

#[derive(Clone, Debug)]
pub struct DiodeModel {
    pub name: String,
    pub is: f64,
    pub n: f64,
    pub kf: f64,
    pub af: f64,
    pub caps: crate::caps::DiodeCapModel,
}

/// Permittivity of SiO₂ (ngspice CONSTepsSiO2 = 3.9·ε₀).
pub const EPS_OX: f64 = 3.9 * 8.854214871e-12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MosRegion {
    Cutoff,
    Triode,
    Saturation,
}

impl MosRegion {
    pub fn as_str(self) -> &'static str {
        match self {
            MosRegion::Cutoff => "cutoff",
            MosRegion::Triode => "triode",
            MosRegion::Saturation => "saturation",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct MosEval {
    /// +1 normal, -1 when vds < 0 (drain and source swap roles).
    pub mode: i8,
    pub region: MosRegion,
    /// Channel current into the effective drain, normalized frame.
    pub cdrain: f64,
    pub gm: f64,
    pub gds: f64,
    pub gmbs: f64,
    /// Threshold voltage (normalized).
    pub von: f64,
    pub vdsat: f64,
}

/// Level-1 (Shichman–Hodges) channel current; `beta` = KP·W/L·M.
pub fn mos_eval(m: &MosModel, beta: f64, vgs: f64, vds: f64, vbs: f64) -> MosEval {
    level1(m, beta, vgs, vds, vbs, None)
}

/// Why a region cannot be imposed at a bias.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// V_GS ≤ V_TH (effective frame): no channel to linearize.
    Off,
    /// Triode asked with V_DS ≥ V_GS − V_TH: the triode current falls
    /// there, so its g_ds is no channel resistance.
    Saturated,
}

/// `mos_eval` with `region` (saturation or triode) imposed: that region's
/// level-1 equations at the same voltages, in the same effective frame
/// (drain and source swapped when vds < 0), λ included. Refused when the
/// channel is off, and for triode when V_DS ≥ V_GS − V_TH.
pub fn mos_eval_in(
    m: &MosModel,
    beta: f64,
    vgs: f64,
    vds: f64,
    vbs: f64,
    region: MosRegion,
) -> Result<MosEval, Refusal> {
    let ev = level1(m, beta, vgs, vds, vbs, Some(region));
    match ev.region {
        MosRegion::Cutoff => Err(Refusal::Off),
        r if r != region => Err(Refusal::Saturated),
        _ => Ok(ev),
    }
}

fn level1(m: &MosModel, beta: f64, vgs: f64, vds: f64, vbs: f64, imposed: Option<MosRegion>) -> MosEval {
    let (mode, vgs, vds, vbs) = if vds >= 0.0 {
        (1, vgs, vds, vbs)
    } else {
        (-1, vgs - vds, -vds, vbs - vds)
    };
    let sqphi = m.phi.sqrt();
    let sarg = if vbs <= 0.0 {
        (m.phi - vbs).sqrt()
    } else {
        (sqphi - vbs / (2.0 * sqphi)).max(0.0)
    };
    let von = m.ty * m.vto - m.gamma * sqphi + m.gamma * sarg;
    let vgst = vgs - von;
    let vdsat = vgst.max(0.0);
    let arg = if sarg <= 0.0 { 0.0 } else { m.gamma / (2.0 * sarg) };
    if vgst <= 0.0 {
        return MosEval {
            mode,
            region: MosRegion::Cutoff,
            cdrain: 0.0,
            gm: 0.0,
            gds: 0.0,
            gmbs: 0.0,
            von,
            vdsat,
        };
    }
    let betap = beta * (1.0 + m.lambda * vds);
    // Triode only where its equations hold (V_DS < V_GS − V_TH); past that
    // the bias's region comes back, which `mos_eval_in` refuses.
    if imposed == Some(MosRegion::Saturation) || vgst <= vds {
        let gm = betap * vgst;
        MosEval {
            mode,
            region: MosRegion::Saturation,
            cdrain: betap * vgst * vgst * 0.5,
            gm,
            gds: m.lambda * beta * vgst * vgst * 0.5,
            gmbs: gm * arg,
            von,
            vdsat,
        }
    } else {
        let gm = betap * vds;
        MosEval {
            mode,
            region: MosRegion::Triode,
            cdrain: betap * vds * (vgst - 0.5 * vds),
            gm,
            gds: betap * (vgst - vds) + m.lambda * beta * vds * (vgst - 0.5 * vds),
            gmbs: gm * arg,
            von,
            vdsat,
        }
    }
}

/// ∂I_D/∂v_BS of the DC current (effective frame) where it differs from
/// `gmbs`: for vbs > 0 the threshold is linear in vbs (slope γ/(2√φ), 0
/// once sarg clamps at 0), but ngspice's gmbs uses γ/(2·sarg). None for
/// vbs ≤ 0, where gmbs is the derivative.
pub fn mos_gmbs_dc(m: &MosModel, gm: f64, vbs: f64) -> Option<f64> {
    if vbs <= 0.0 {
        return None;
    }
    let sqphi = m.phi.sqrt();
    Some(if sqphi - vbs / (2.0 * sqphi) <= 0.0 {
        0.0
    } else {
        gm * (m.gamma / (2.0 * sqphi))
    })
}

/// MOS bulk junction diode (mos1load): current and conductance.
pub fn bulk_junction(is: f64, v: f64, gmin: f64) -> (f64, f64) {
    let vt = vt();
    if v <= -3.0 * vt {
        (gmin * v - is, gmin)
    } else {
        let e = (v / vt).min(MAX_EXP_ARG).exp();
        (is * (e - 1.0) + gmin * v, is * e / vt + gmin)
    }
}

/// Junction current with ngspice's cubic tail below -3·vte (no gmin).
pub fn pn(csat: f64, v: f64, vte: f64) -> (f64, f64) {
    if v >= -3.0 * vte {
        let e = (v / vte).min(MAX_EXP_ARG).exp();
        (csat * (e - 1.0), csat * e / vte)
    } else {
        let a = 3.0 * vte / (v * std::f64::consts::E);
        let a = a * a * a;
        (-csat * (1.0 + a), csat * 3.0 * a / v)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct BjtEval {
    /// Collector and base currents (into the terminals), normalized frame.
    pub cc: f64,
    pub cb: f64,
    pub gpi: f64,
    pub gmu: f64,
    pub gm: f64,
    pub go: f64,
}

impl BjtEval {
    pub fn dcc_dvbe(&self) -> f64 {
        self.gm + self.go
    }
    pub fn dcc_dvbc(&self) -> f64 {
        -self.go - self.gmu
    }
}

/// Gummel–Poon with IS, BF, BR, VAF (no high injection, no leakage terms,
/// no parasitic resistances); `mult` devices in parallel (ngspice's M scales
/// every current and conductance, gmin's included).
pub fn bjt_eval(m: &BjtModel, area: f64, mult: f64, vbe: f64, vbc: f64, gmin: f64) -> BjtEval {
    let vt = vt();
    let csat = m.is * area;
    let (cbe, gbe) = pn(csat, vbe, vt);
    let (cbc, gbc) = pn(csat, vbc, vt);
    let (cben, gben) = (gmin * vbe, gmin);
    let (cbcn, gbcn) = (gmin * vbc, gmin);
    let inv_vaf = if m.vaf > 0.0 { 1.0 / m.vaf } else { 0.0 };
    let q1 = 1.0 / (1.0 - inv_vaf * vbc);
    let qb = q1;
    let dqbdve = 0.0;
    let dqbdvc = q1 * qb * inv_vaf;
    let cc = (cbe - cbc) / qb - cbc / m.br - cbcn;
    let cb = cbe / m.bf + cben + cbc / m.br + cbcn;
    let gpi = gbe / m.bf + gben;
    let gmu = gbc / m.br + gbcn;
    let go = (gbc + (cbe - cbc) * dqbdvc / qb) / qb;
    let gm = (gbe - (cbe - cbc) * dqbdve / qb) / qb - go;
    BjtEval {
        cc: mult * cc,
        cb: mult * cb,
        gpi: mult * gpi,
        gmu: mult * gmu,
        gm: mult * gm,
        go: mult * go,
    }
}

/// Diode current and conductance (dioload, no breakdown).
pub fn diode_eval(m: &DiodeModel, area: f64, vd: f64, gmin: f64) -> (f64, f64) {
    let (i, g) = pn(m.is * area, vd, m.n * vt());
    (i + gmin * vd, g + gmin)
}

pub fn vcrit(is: f64, vte: f64) -> f64 {
    vte * (vte / (std::f64::consts::SQRT_2 * is)).ln()
}

/// DEVpnjlim (ngspice): limit junction voltage steps during Newton iteration.
/// Forward steps above vcrit grow logarithmically; a reverse step may reach
/// at most −vold − 1 from a forward-biased junction, else 2·vold − 1, so an
/// iterate thrown far negative cannot swing back past the exponential.
pub fn pnjlim(vnew: f64, vold: f64, vte: f64, vcrit: f64) -> f64 {
    if vnew > vcrit && (vnew - vold).abs() > vte + vte {
        if vold > 0.0 {
            let arg = 1.0 + (vnew - vold) / vte;
            if arg > 0.0 {
                vold + vte * arg.ln()
            } else {
                vcrit
            }
        } else {
            vte * (vnew / vte).ln()
        }
    } else if vnew < 0.0 {
        let floor = if vold > 0.0 { -vold - 1.0 } else { 2.0 * vold - 1.0 };
        vnew.max(floor)
    } else {
        vnew
    }
}

/// DEVfetlim: limit gate-voltage steps around the threshold.
pub fn fetlim(vnew: f64, vold: f64, vto: f64) -> f64 {
    let vtsthi = (2.0 * (vold - vto)).abs() + 2.0;
    let vtstlo = vtsthi / 2.0 + 2.0;
    let vtox = vto + 3.5;
    let delv = vnew - vold;
    let mut v = vnew;
    if vold >= vto {
        if vold >= vtox {
            if delv <= 0.0 {
                if vnew >= vtox {
                    if -delv > vtstlo {
                        v = vold - vtstlo;
                    }
                } else {
                    v = vnew.max(vto + 2.0);
                }
            } else if delv >= vtsthi {
                v = vold + vtsthi;
            }
        } else if delv <= 0.0 {
            v = vnew.max(vto - 0.5);
        } else {
            v = vnew.min(vto + 4.0);
        }
    } else if delv <= 0.0 {
        if -delv > vtsthi {
            v = vold - vtsthi;
        }
    } else {
        let vtemp = vto + 0.5;
        if vnew <= vtemp {
            if delv > vtstlo {
                v = vold + vtstlo;
            }
        } else {
            v = vtemp;
        }
    }
    v
}

/// DEVlimvds: limit drain-source voltage steps.
pub fn limvds(vnew: f64, vold: f64) -> f64 {
    if vold >= 3.5 {
        if vnew > vold {
            vnew.min(3.0 * vold + 2.0)
        } else if vnew < 3.5 {
            vnew.max(2.0)
        } else {
            vnew
        }
    } else if vnew > vold {
        vnew.min(4.0)
    } else {
        vnew.max(-0.5)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pnjlim_limits_reverse_steps_as_ngspice() {
        let vt = vt();
        let vc = vcrit(1e-15, vt);
        // From a forward-biased junction a reverse step stops at −vold − 1,
        assert_eq!(pnjlim(-500.0, 0.7, vt, vc), -1.7);
        // from a reverse-biased one at 2·vold − 1.
        assert_eq!(pnjlim(-500.0, -3.0, vt, vc), -7.0);
        // Steps within those bounds pass unchanged.
        assert_eq!(pnjlim(-1.0, 0.7, vt, vc), -1.0);
        assert_eq!(pnjlim(-5.0, -3.0, vt, vc), -5.0);
        // A forward step past vcrit still grows only logarithmically.
        let v = pnjlim(5.0, 0.7, vt, vc);
        assert!(v > 0.7 && v < 0.7 + 10.0 * vt, "{v}");
    }
}
