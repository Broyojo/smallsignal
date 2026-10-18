//! Device capacitances at the operating point, as ngspice-47 computes them
//! for AC (the MODEINITSMSIG load): mos1load with DEVqmeyer and mos1temp's
//! junction coefficients, bjtload, dioload. Every temperature factor is 1
//! (the circuit runs at TNOM = 27 °C). Voltages are in the device's
//! normalized frame (multiplied by its type).

use crate::devices::{pn, vt, BjtModel, DiodeModel, MosModel};

/// MOS level-1 charge parameters (ngspice defaults: everything 0, PB 0.8,
/// MJ 0.5, MJSW 0.5, FC 0.5).
#[derive(Clone, Debug)]
pub struct MosCapModel {
    /// Meyer oxide capacitance per area, 3.9ε₀/TOX, or 0 when TOX is absent
    /// or 0 (then there are no Meyer capacitances, as in mos1temp).
    pub cox: f64,
    pub cgso: f64,
    pub cgdo: f64,
    pub cgbo: f64,
    /// CBD, CBS when given: they replace CJ·AD, CJ·AS.
    pub cbd: Option<f64>,
    pub cbs: Option<f64>,
    pub cj: f64,
    pub cjsw: f64,
    pub mj: f64,
    pub mjsw: f64,
    pub pb: f64,
    pub fc: f64,
}

impl Default for MosCapModel {
    fn default() -> Self {
        MosCapModel {
            cox: 0.0,
            cgso: 0.0,
            cgdo: 0.0,
            cgbo: 0.0,
            cbd: None,
            cbs: None,
            cj: 0.0,
            cjsw: 0.0,
            mj: 0.5,
            mjsw: 0.5,
            pb: 0.8,
            fc: 0.5,
        }
    }
}

/// Instance geometry for the bulk junctions (ngspice defaults 0).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MosGeom {
    pub ad: f64,
    pub as_: f64,
    pub pd: f64,
    pub ps: f64,
}

/// Gummel–Poon charge parameters (ngspice defaults).
#[derive(Clone, Debug)]
pub struct BjtCapModel {
    pub cje: f64,
    pub vje: f64,
    /// Limited to 0.999, as bjttemp does.
    pub mje: f64,
    pub tf: f64,
    pub xtf: f64,
    pub vtf: f64,
    pub itf: f64,
    pub cjc: f64,
    pub vjc: f64,
    pub mjc: f64,
    pub xcjc: f64,
    pub tr: f64,
    pub cjs: f64,
    pub vjs: f64,
    pub mjs: f64,
    /// Limited to 0.9999, as bjttemp does.
    pub fc: f64,
    /// +1 vertical (substrate to collector, NPN default), −1 lateral
    /// (substrate to base, PNP default).
    pub subs: f64,
}

impl BjtCapModel {
    pub fn new(ty: f64) -> Self {
        BjtCapModel {
            cje: 0.0,
            vje: 0.75,
            mje: 0.33,
            tf: 0.0,
            xtf: 0.0,
            vtf: 0.0,
            itf: 0.0,
            cjc: 0.0,
            vjc: 0.75,
            mjc: 0.33,
            xcjc: 1.0,
            tr: 0.0,
            cjs: 0.0,
            vjs: 0.75,
            mjs: 0.0,
            fc: 0.5,
            subs: if ty > 0.0 { 1.0 } else { -1.0 },
        }
    }
}

/// Diode charge parameters (ngspice defaults: CJO 0, VJ 1, M 0.5, FC 0.5,
/// TT 0).
#[derive(Clone, Debug)]
pub struct DiodeCapModel {
    pub cjo: f64,
    pub vj: f64,
    pub m: f64,
    pub fc: f64,
    pub tt: f64,
}

impl Default for DiodeCapModel {
    fn default() -> Self {
        DiodeCapModel {
            cjo: 0.0,
            vj: 1.0,
            m: 0.5,
            fc: 0.5,
            tt: 0.0,
        }
    }
}

/// (1 − v/pb)^(−m), with mos1load's square-root case for m = 0.5.
fn grading(arg: f64, m: f64) -> f64 {
    if m == 0.5 {
        1.0 / arg.sqrt()
    } else {
        (-m * arg.ln()).exp()
    }
}

/// DEVqmeyer: half of each voltage-dependent Meyer capacitance (gs, gd,
/// gb), from the gate voltages of the effective frame (gs and gd swapped by
/// the caller in reverse mode), the threshold, V_DSAT, φ and the total
/// oxide capacitance Cox·W·L.
pub fn qmeyer(vgs: f64, vgd: f64, von: f64, vdsat: f64, phi: f64, cox: f64) -> (f64, f64, f64) {
    const MAGIC_VDS: f64 = 0.025;
    let vgst = vgs - von;
    let vdsat = vdsat.max(MAGIC_VDS);
    if vgst <= -phi {
        (0.0, 0.0, cox / 2.0)
    } else if vgst <= -phi / 2.0 {
        (0.0, 0.0, -vgst * cox / (2.0 * phi))
    } else if vgst <= 0.0 {
        let cgb = -vgst * cox / (2.0 * phi);
        let cgs = vgst * cox / (1.5 * phi) + cox / 3.0;
        let vds = vgs - vgd;
        if vds >= vdsat {
            (cgs, 0.0, cgb)
        } else {
            let vddif = 2.0 * vdsat - vds;
            let vddif1 = vdsat - vds;
            let vddif2 = vddif * vddif;
            let cgd = cgs * (1.0 - vdsat * vdsat / vddif2);
            (cgs * (1.0 - vddif1 * vddif1 / vddif2), cgd, cgb)
        }
    } else {
        let vds = vgs - vgd;
        if vdsat <= vds {
            (cox / 3.0, 0.0, 0.0)
        } else {
            let vddif = 2.0 * vdsat - vds;
            let vddif1 = vdsat - vds;
            let vddif2 = vddif * vddif;
            let cgd = cox * (1.0 - vdsat * vdsat / vddif2) / 3.0;
            let cgs = cox * (1.0 - vddif1 * vddif1 / vddif2) / 3.0;
            (cgs, cgd, 0.0)
        }
    }
}

/// MOSFET capacitances (F) between its physical terminals.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MosCaps {
    pub cgs: f64,
    pub cgd: f64,
    pub cgb: f64,
    pub cbd: f64,
    pub cbs: f64,
}

/// A bulk junction's capacitance at v (mos1load): czb·(1 − v/PB)^−MJ +
/// czbsw·(1 − v/PB)^−MJSW below FC·PB, and mos1temp's linear extension
/// f2 + f3·v above it.
fn bulk_cap(c: &MosCapModel, czb: f64, czbsw: f64, v: f64) -> f64 {
    if czb == 0.0 && czbsw == 0.0 {
        return 0.0;
    }
    if v < c.fc * c.pb {
        let arg = 1.0 - v / c.pb;
        czb * grading(arg, c.mj) + czbsw * grading(arg, c.mjsw)
    } else {
        let arg = 1.0 - c.fc;
        let sarg = (-c.mj * arg.ln()).exp();
        let sargsw = (-c.mjsw * arg.ln()).exp();
        let f2 = czb * (1.0 - c.fc * (1.0 + c.mj)) * sarg / arg + czbsw * (1.0 - c.fc * (1.0 + c.mjsw)) * sargsw / arg;
        let f3 = czb * c.mj * sarg / arg / c.pb + czbsw * c.mjsw * sargsw / arg / c.pb;
        f2 + f3 * v
    }
}

/// Zero-bias junction capacitances (drain, drain sidewall, source, source
/// sidewall) of one instance, as mos1temp.
pub fn mos_zero_bias(c: &MosCapModel, mult: f64, g: &MosGeom) -> (f64, f64, f64, f64) {
    let czbd = match c.cbd {
        Some(cbd) => cbd * mult,
        None => c.cj * mult * g.ad,
    };
    let czbs = match c.cbs {
        Some(cbs) => cbs * mult,
        None => c.cj * g.as_ * mult,
    };
    (czbd, c.cjsw * g.pd * mult, czbs, c.cjsw * g.ps * mult)
}

/// Capacitances of a level-1 MOSFET at (vgs, vds, vbs), normalized frame:
/// Cgs = 2·qmeyer_gs + CGSO·M·W, Cgd = 2·qmeyer_gd + CGDO·M·W, Cgb =
/// 2·qmeyer_gb + CGBO·M·L (mos1acld), and the bulk junctions.
pub fn mos_caps(m: &MosModel, w: f64, l: f64, mult: f64, g: &MosGeom, (vgs, vds, vbs): (f64, f64, f64)) -> MosCaps {
    let c = &m.caps;
    let ev = crate::devices::mos_eval(m, 1.0, vgs, vds, vbs);
    let vgd = vgs - vds;
    let oxide = c.cox * l * mult * w;
    let (hs, hd, hb) = if ev.mode > 0 {
        qmeyer(vgs, vgd, ev.von, ev.vdsat, m.phi, oxide)
    } else {
        let (d, s, b) = qmeyer(vgd, vgs, ev.von, ev.vdsat, m.phi, oxide);
        (s, d, b)
    };
    let (czbd, czbdsw, czbs, czbssw) = mos_zero_bias(c, mult, g);
    MosCaps {
        cgs: 2.0 * hs + c.cgso * mult * w,
        cgd: 2.0 * hd + c.cgdo * mult * w,
        cgb: 2.0 * hb + c.cgbo * mult * l,
        cbd: bulk_cap(c, czbd, czbdsw, vbs - vds),
        cbs: bulk_cap(c, czbs, czbssw, vbs),
    }
}

/// BJT capacitances (F) at the operating point.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BjtCaps {
    /// b–e: TF diffusion (TF·∂I_F/∂v_BE with XTF/VTF/ITF) plus depletion.
    pub cpi: f64,
    /// b–c: TR diffusion plus depletion, both parts of CJC (XCJC to the
    /// internal base, the rest to the external one, the same node here).
    pub cmu: f64,
    /// Substrate junction, to the collector (vertical) or base (lateral).
    pub csub: f64,
    /// ∂Q_BE/∂v_BC (bjtload's geqcb): the diffusion charge's dependence on
    /// v_BC through q_b (VAF) and VTF. A transcapacitance: the b–e branch
    /// carries s·geqcb·v_BC.
    pub geqcb: f64,
}

/// Depletion capacitance czb·(1 − v/p)^−m below fc·p, else bjtload's
/// czb/f2·(f3 + m·v/p).
fn depletion(czb: f64, p: f64, m: f64, fc: f64, v: f64) -> f64 {
    if v < fc * p {
        let arg = 1.0 - v / p;
        czb * (-m * arg.ln()).exp()
    } else {
        let xfc = (1.0 - fc).ln();
        let f2 = ((1.0 + m) * xfc).exp();
        let f3 = 1.0 - fc * (1.0 + m);
        czb / f2 * (f3 + m * v / p)
    }
}

/// BJT capacitances at (vbe, vbc, vsub), normalized frame, vsub =
/// subs·(v_substrate − v_collector or base). `mult` devices in parallel.
pub fn bjt_caps(m: &BjtModel, area: f64, mult: f64, vbe: f64, vbc: f64, vsub: f64) -> BjtCaps {
    let c = &m.caps;
    let vt = vt();
    let csat = m.is * area;
    let (mut cbe, mut gbe) = pn(csat, vbe, vt);
    let (_, gbc) = pn(csat, vbc, vt);
    let inv_vaf = if m.vaf > 0.0 { 1.0 / m.vaf } else { 0.0 };
    let q1 = 1.0 / (1.0 - inv_vaf * vbc);
    let qb = q1;
    let dqbdve = 0.0;
    let dqbdvc = q1 * qb * inv_vaf;
    let tf = c.tf;
    let ovtf = if c.vtf != 0.0 { 1.0 / (c.vtf * 1.44) } else { 0.0 };
    let xjtf = c.itf * area;
    let mut geqcb = 0.0;
    if tf != 0.0 && vbe > 0.0 {
        let (mut argtf, mut arg2, mut arg3) = (0.0, 0.0, 0.0);
        if c.xtf != 0.0 {
            argtf = c.xtf;
            if ovtf != 0.0 {
                argtf *= (vbc * ovtf).exp();
            }
            arg2 = argtf;
            if xjtf != 0.0 {
                let temp = cbe / (cbe + xjtf);
                argtf = argtf * temp * temp;
                arg2 = argtf * (3.0 - temp - temp);
            }
            arg3 = cbe * argtf * ovtf;
        }
        cbe = cbe * (1.0 + argtf) / qb;
        gbe = (gbe * (1.0 + arg2) - cbe * dqbdve) / qb;
        geqcb = tf * (arg3 - cbe * dqbdvc) / qb;
    }
    let mje = c.mje.min(0.999);
    let mjc = c.mjc.min(0.999);
    let mjs = c.mjs.min(0.999);
    let fc = c.fc.min(0.9999);
    let cpi = tf * gbe + depletion(c.cje * area, c.vje, mje, fc, vbe);
    let ctot = c.cjc * area;
    let czbc = ctot * c.xcjc;
    let czbx = ctot - czbc;
    let cmu = c.tr * gbc + depletion(czbc, c.vjc, mjc, fc, vbc) + depletion(czbx, c.vjc, mjc, fc, vbc);
    let czsub = c.cjs * area;
    let csub = if vsub < 0.0 {
        let arg = 1.0 - vsub / c.vjs;
        czsub * (-mjs * arg.ln()).exp()
    } else {
        czsub * (1.0 + mjs * vsub / c.vjs)
    };
    BjtCaps {
        cpi: mult * cpi,
        cmu: mult * cmu,
        csub: mult * csub,
        geqcb: mult * geqcb,
    }
}

/// Diode capacitance at vd: TT·g_d (g_d with gmin, as dioload) plus the
/// depletion part of CJO·AREA·M.
pub fn diode_cap(m: &DiodeModel, area_mult: f64, vd: f64, gd: f64) -> f64 {
    let c = &m.caps;
    c.tt * gd + depletion(c.cjo * area_mult, c.vj, c.m, c.fc, vd)
}

/// Whether a device has a bias-dependent charge: Meyer gate charge,
/// junction depletion or diffusion charge (overlap capacitances alone are
/// constant, and so is CJS with MJS = 0).
pub fn nonlinear_charge(kind: &crate::netlist::Kind) -> bool {
    use crate::netlist::Kind;
    match kind {
        Kind::M { model, .. } => {
            let c = &model.caps;
            c.cox > 0.0
                || c.cj != 0.0
                || c.cjsw != 0.0
                || c.cbd.is_some_and(|x| x != 0.0)
                || c.cbs.is_some_and(|x| x != 0.0)
        }
        Kind::Q { model, .. } => {
            let c = &model.caps;
            c.cje != 0.0 || c.cjc != 0.0 || c.tf != 0.0 || c.tr != 0.0 || (c.cjs != 0.0 && c.mjs != 0.0)
        }
        Kind::D { model, .. } => model.caps.cjo != 0.0 || model.caps.tt != 0.0,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() <= 1e-14 * a.abs().max(b.abs()).max(1e-30)
    }

    #[test]
    fn meyer_regions_by_hand() {
        let (cox, phi) = (3e-15, 0.6);
        // Accumulation: Cgb = Cox/2 (half), nothing to the channel.
        assert_eq!(qmeyer(-1.0, -1.0, 0.5, 0.0, phi, cox), (0.0, 0.0, cox / 2.0));
        // Depletion, -φ < vgst ≤ -φ/2: Cgb falls linearly.
        let (s, d, b) = qmeyer(0.5 - 0.4, 0.1, 0.5, 0.0, phi, cox);
        assert_eq!((s, d), (0.0, 0.0));
        assert!(close(b, 0.4 * cox / (2.0 * phi)));
        // Weak inversion, -φ/2 < vgst ≤ 0, vds ≥ 25 mV: Cgs rises from 0 to
        // Cox/3 (half), Cgd = 0.
        let (s, d, b) = qmeyer(0.4, 0.4 - 0.5, 0.5, 0.0, phi, cox);
        assert!(close(s, -0.1 * cox / (1.5 * phi) + cox / 3.0));
        assert_eq!(d, 0.0);
        assert!(close(b, 0.1 * cox / (2.0 * phi)));
        // Saturation: Cgs = Cox/3 (half of 2/3), Cgd = Cgb = 0.
        assert_eq!(qmeyer(1.0, 0.0, 0.5, 0.5, phi, cox), (cox / 3.0, 0.0, 0.0));
        // Triode at vds = vdsat/2: vddif = 1.5 vdsat, vddif1 = 0.5 vdsat, so
        // Cgs = Cox/3·(1 − 1/9) and Cgd = Cox/3·(1 − 4/9) (halves).
        let (s, d, b) = qmeyer(1.0, 0.75, 0.5, 0.5, phi, cox);
        assert!(close(s, cox / 3.0 * (8.0 / 9.0)));
        assert!(close(d, cox / 3.0 * (5.0 / 9.0)));
        assert_eq!(b, 0.0);
        // Triode at vds = 0: both halves are Cox/4 (Cgs = Cgd = Cox/2 total).
        let (s, d, _) = qmeyer(1.0, 1.0, 0.5, 0.5, phi, cox);
        assert!(close(s, cox / 4.0) && close(d, cox / 4.0));
    }

    fn mos(ty: f64) -> MosModel {
        MosModel {
            name: "nm".into(),
            ty,
            kp: 200e-6,
            vto: 0.5 * ty,
            lambda: 0.0,
            gamma: 0.0,
            phi: 0.6,
            is: 1e-14,
            cox: crate::devices::EPS_OX / 1e-8,
            kf: 0.0,
            af: 1.0,
            caps: MosCapModel {
                cox: crate::devices::EPS_OX / 1e-8,
                cgso: 1e-10,
                cgdo: 2e-10,
                cgbo: 3e-10,
                ..MosCapModel::default()
            },
        }
    }

    #[test]
    fn mos_saturation_and_reverse_mode() {
        let m = mos(1.0);
        let (w, l) = (10e-6, 1e-6);
        let ox = m.caps.cox * l * w;
        let c = mos_caps(&m, w, l, 1.0, &MosGeom::default(), (1.0, 1.0, 0.0));
        assert!(close(c.cgs, 2.0 / 3.0 * ox + 1e-10 * w));
        assert!(close(c.cgd, 2e-10 * w));
        assert!(close(c.cgb, 3e-10 * l));
        // vds < 0: drain and source swap, so the 2/3·Cox goes to the drain.
        let c = mos_caps(&m, w, l, 1.0, &MosGeom::default(), (0.0, -1.0, 0.0));
        assert!(close(c.cgd, 2.0 / 3.0 * ox + 2e-10 * w));
        assert!(close(c.cgs, 1e-10 * w));
        // Cutoff deep in accumulation: all of Cox to the bulk.
        let c = mos_caps(&m, w, l, 2.0, &MosGeom::default(), (-2.0, 1.0, 0.0));
        assert!(close(c.cgb, 2.0 * ox + 3e-10 * 2.0 * l));
        assert!(close(c.cgs, 1e-10 * 2.0 * w));
    }

    #[test]
    fn bulk_junction_grading_and_fc() {
        let mut m = mos(1.0);
        m.caps.cj = 1e-4;
        m.caps.cjsw = 1e-10;
        m.caps.mjsw = 0.33;
        let g = MosGeom {
            ad: 2e-11,
            as_: 3e-11,
            pd: 2e-5,
            ps: 3e-5,
        };
        // Reverse bias 1 V: CJ·AD·(1 + 1/0.8)^−0.5 + CJSW·PD·(1 + 1/0.8)^−0.33.
        let c = mos_caps(&m, 10e-6, 1e-6, 1.0, &g, (1.0, 1.0, -1.0));
        let a: f64 = 1.0 + 2.0 / 0.8;
        assert!(close(c.cbd, 1e-4 * 2e-11 / a.sqrt() + 1e-10 * 2e-5 * a.powf(-0.33)));
        let a: f64 = 1.0 + 1.0 / 0.8;
        assert!(close(c.cbs, 1e-4 * 3e-11 / a.sqrt() + 1e-10 * 3e-5 * a.powf(-0.33)));
        // Forward bias above FC·PB = 0.4 V: the linear extension, which is
        // continuous with the power law at FC·PB.
        let at = |v: f64| bulk_cap(&m.caps, 1e-15, 2e-15, v);
        let (below, above) = (at(0.4 - 1e-9), at(0.4 + 1e-9));
        assert!((below - above).abs() < 1e-8 * below);
        let slope = (at(0.6) - at(0.5)) / 0.1;
        assert!(((at(0.7) - at(0.6)) / 0.1 - slope).abs() < 1e-9 * slope);
        // CBD given replaces CJ·AD (times M).
        m.caps.cbd = Some(5e-15);
        let c = mos_caps(&m, 10e-6, 1e-6, 2.0, &g, (1.0, 0.0, 0.0));
        assert!(close(c.cbd, 2.0 * 5e-15 + 2.0 * 1e-10 * 2e-5));
    }

    #[test]
    fn bjt_tf_and_depletion() {
        let mut m = BjtModel {
            name: "q".into(),
            ty: 1.0,
            is: 1e-16,
            bf: 100.0,
            br: 1.0,
            vaf: 0.0,
            kf: 0.0,
            af: 1.0,
            caps: BjtCapModel::new(1.0),
        };
        m.caps.tf = 1e-10;
        m.caps.cje = 1e-12;
        m.caps.cjc = 0.5e-12;
        let (vbe, vbc) = (0.7, -2.0);
        let c = bjt_caps(&m, 1.0, 1.0, vbe, vbc, 0.0);
        let gbe = 1e-16 * (vbe / vt()).exp() / vt();
        // Above FC·VJE = 0.375 V the b–e depletion part is linear.
        let f2 = (1.33 * 0.5f64.ln()).exp();
        let dep = 1e-12 / f2 * (1.0 - 0.5 * 1.33 + 0.33 * vbe / 0.75);
        assert!(close(c.cpi, 1e-10 * gbe + dep));
        assert!(close(c.cmu, 0.5e-12 * (1.0 + 2.0 / 0.75f64).powf(-0.33)));
        // No Early effect, no XTF: no transcapacitance.
        assert_eq!(c.geqcb, 0.0);
        // With VAF: geqcb = −TF·(I_F/q_b)·∂q_b/∂v_BC/q_b, and C_π's TF part
        // is TF·g_be/q_b.
        m.vaf = 50.0;
        let c = bjt_caps(&m, 1.0, 1.0, vbe, vbc, 0.0);
        let qb = 1.0 / (1.0 + 2.0 / 50.0);
        let cbe = 1e-16 * ((vbe / vt()).exp() - 1.0) / qb;
        assert!(close(c.geqcb, -1e-10 * cbe * (qb * qb / 50.0) / qb));
        assert!(close(c.cpi, 1e-10 * gbe / qb + dep));
    }

    #[test]
    fn diode_depletion_and_transit_time() {
        let mut d = DiodeModel {
            name: "d".into(),
            is: 1e-14,
            n: 1.0,
            kf: 0.0,
            af: 1.0,
            caps: DiodeCapModel::default(),
        };
        d.caps.cjo = 2e-12;
        d.caps.tt = 1e-9;
        let c = diode_cap(&d, 1.0, -3.0, 1e-12);
        assert!(close(c, 1e-9 * 1e-12 + 2e-12 / 2.0));
    }
}
