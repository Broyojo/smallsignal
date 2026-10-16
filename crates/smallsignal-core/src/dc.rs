//! DC operating point by Newton–Raphson on the MNA equations, with
//! ngspice-style junction/FET limiting, then gmin and source stepping as
//! fallbacks.

use crate::devices::*;
use crate::linalg::solve_real;
use crate::netlist::{Kind, Netlist};

#[derive(Clone, Debug)]
pub struct MosOp {
    pub ty: f64,
    /// Drain and source swapped roles (vds < 0 in the device frame).
    pub reversed: bool,
    pub region: MosRegion,
    /// Current into the drain terminal.
    pub id: f64,
    pub vgs: f64,
    pub vds: f64,
    pub vbs: f64,
    pub vth: f64,
    pub vdsat: f64,
    pub gm: f64,
    pub gds: f64,
    pub gmb: f64,
    pub gbs: f64,
    pub gbd: f64,
}

#[derive(Clone, Debug)]
pub struct BjtOp {
    pub ty: f64,
    pub region: &'static str,
    pub ic: f64,
    pub ib: f64,
    pub vbe: f64,
    pub vce: f64,
    pub gm: f64,
    pub gpi: f64,
    pub go: f64,
    pub gmu: f64,
}

#[derive(Clone, Debug)]
pub struct DiodeOp {
    pub id: f64,
    pub vd: f64,
    pub gd: f64,
}

#[derive(Clone, Debug)]
pub enum DevOp {
    Mos(MosOp),
    Bjt(BjtOp),
    Diode(DiodeOp),
}

#[derive(Clone, Debug)]
pub struct Op {
    /// Node voltages, index 0 = ground.
    pub v: Vec<f64>,
    /// Branch current per element (V, E, H, L), flowing p → n inside it.
    pub branch: Vec<Option<f64>>,
    pub dev: Vec<Option<DevOp>>,
    pub method: &'static str,
    pub iterations: usize,
}

struct Layout {
    nn: usize,
    branch: Vec<Option<usize>>,
    dim: usize,
}

impl Layout {
    fn new(net: &Netlist) -> Layout {
        let nn = net.nodes.len() - 1;
        let mut dim = nn;
        let branch = net
            .elements
            .iter()
            .map(|e| {
                e.has_branch().then(|| {
                    dim += 1;
                    dim - 1
                })
            })
            .collect();
        Layout { nn, branch, dim }
    }

    fn n(&self, node: usize) -> Option<usize> {
        (node != 0).then(|| node - 1)
    }
}

struct Asm {
    n: usize,
    a: Vec<f64>,
    z: Vec<f64>,
}

impl Asm {
    fn new(n: usize) -> Asm {
        Asm {
            n,
            a: vec![0.0; n * n],
            z: vec![0.0; n],
        }
    }
    fn add(&mut self, r: Option<usize>, c: Option<usize>, v: f64) {
        if let (Some(r), Some(c)) = (r, c) {
            self.a[r * self.n + c] += v;
        }
    }
    fn rhs(&mut self, r: Option<usize>, v: f64) {
        if let Some(r) = r {
            self.z[r] += v;
        }
    }
}

/// Stamps a linearized device current flowing from node `from` through the
/// device into node `to`: I = i0 + Σ g·((v_p − v_q) − v0).
fn stamp_nl(asm: &mut Asm, lay: &Layout, from: usize, to: usize, i0: f64, deps: &[(f64, usize, usize, f64)]) {
    let f = lay.n(from);
    let t = lay.n(to);
    let mut ieq = i0;
    for &(g, p, q, v0) in deps {
        let (pp, qq) = (lay.n(p), lay.n(q));
        asm.add(f, pp, g);
        asm.add(f, qq, -g);
        asm.add(t, pp, -g);
        asm.add(t, qq, g);
        ieq -= g * v0;
    }
    asm.rhs(f, -ieq);
    asm.rhs(t, ieq);
}

#[derive(Clone, Copy, Debug)]
enum St {
    None,
    Mos { vgs: f64, vds: f64, vbs: f64, von: f64 },
    Bjt { vbe: f64, vbc: f64 },
    Dio { vd: f64 },
}

fn initial_states(net: &Netlist) -> Vec<St> {
    let vt = vt();
    net.elements
        .iter()
        .map(|e| match &e.kind {
            Kind::M { model, .. } => St::Mos {
                vgs: model.ty * model.vto,
                vds: 0.0,
                vbs: -1.0,
                von: model.ty * model.vto,
            },
            Kind::Q { model, area } => St::Bjt {
                vbe: vcrit(model.is * area, vt),
                vbc: 0.0,
            },
            Kind::D { model, area } => St::Dio {
                vd: vcrit(model.is * area, model.n * vt),
            },
            _ => St::None,
        })
        .collect()
}

fn volt(x: &[f64], node: usize) -> f64 {
    if node == 0 {
        0.0
    } else {
        x[node - 1]
    }
}

struct Ctx<'a> {
    net: &'a Netlist,
    lay: Layout,
}

impl Ctx<'_> {
    fn stamp_linear(&self, asm: &mut Asm, scale: f64) {
        let lay = &self.lay;
        for (ei, e) in self.net.elements.iter().enumerate() {
            let nd = |i: usize| lay.n(e.nodes[i]);
            match &e.kind {
                Kind::R { value } => {
                    let g = 1.0 / value;
                    let (p, n) = (nd(0), nd(1));
                    asm.add(p, p, g);
                    asm.add(n, n, g);
                    asm.add(p, n, -g);
                    asm.add(n, p, -g);
                }
                Kind::C { .. } => {}
                Kind::I { dc, .. } => {
                    asm.rhs(nd(0), -scale * dc);
                    asm.rhs(nd(1), scale * dc);
                }
                Kind::G { gain } => {
                    let (p, n, cp, cn) = (nd(0), nd(1), nd(2), nd(3));
                    asm.add(p, cp, *gain);
                    asm.add(p, cn, -gain);
                    asm.add(n, cp, -gain);
                    asm.add(n, cn, *gain);
                }
                Kind::F { ctrl, gain } => {
                    let k = lay.branch[*ctrl];
                    asm.add(nd(0), k, *gain);
                    asm.add(nd(1), k, -gain);
                }
                Kind::V { .. } | Kind::E { .. } | Kind::H { .. } | Kind::L { .. } => {
                    let k = lay.branch[ei];
                    let (p, n) = (nd(0), nd(1));
                    asm.add(p, k, 1.0);
                    asm.add(n, k, -1.0);
                    asm.add(k, p, 1.0);
                    asm.add(k, n, -1.0);
                    match &e.kind {
                        Kind::V { dc, .. } => asm.rhs(k, scale * dc),
                        Kind::E { gain } => {
                            asm.add(k, nd(2), -gain);
                            asm.add(k, nd(3), *gain);
                        }
                        Kind::H { ctrl, gain } => asm.add(k, lay.branch[*ctrl], -gain),
                        _ => {}
                    }
                }
                Kind::M { .. } | Kind::Q { .. } | Kind::D { .. } => {}
            }
        }
    }

    /// One Newton solve from `x`; returns the converged solution and states.
    fn newton(
        &self,
        scale: f64,
        gshunt: f64,
        mut x: Vec<f64>,
        mut st: Vec<St>,
        mut use_init: bool,
    ) -> Result<(Vec<f64>, Vec<St>, usize), String> {
        let net = self.net;
        let lay = &self.lay;
        let gmin = net.gmin;
        let vt = vt();
        let mut polish = 0;
        for iter in 0..300 {
            let mut asm = Asm::new(lay.dim);
            self.stamp_linear(&mut asm, scale);
            if gshunt > 0.0 {
                for i in 0..lay.nn {
                    asm.add(Some(i), Some(i), gshunt);
                }
            }
            let mut limited = false;
            for (ei, e) in net.elements.iter().enumerate() {
                match &e.kind {
                    Kind::M { model, w, l, mult } => {
                        let ty = model.ty;
                        let (d, g, s, b) = (e.nodes[0], e.nodes[1], e.nodes[2], e.nodes[3]);
                        let (vd, vg, vs, vb) = (volt(&x, d), volt(&x, g), volt(&x, s), volt(&x, b));
                        let (mut vgs, mut vds, mut vbs) = (ty * (vg - vs), ty * (vd - vs), ty * (vb - vs));
                        if let St::Mos {
                            vgs: og,
                            vds: od,
                            vbs: ob,
                            von,
                        } = st[ei]
                        {
                            if use_init {
                                (vgs, vds, vbs) = (og, od, ob);
                            } else {
                                let (lg, ld, lb) = limit_mos(vgs, vds, vbs, og, od, ob, von, model.is * mult);
                                if (lg, ld, lb) != (vgs, vds, vbs) {
                                    limited = true;
                                }
                                (vgs, vds, vbs) = (lg, ld, lb);
                            }
                        }
                        let beta = model.kp * w / l * mult;
                        let ev = mos_eval(model, beta, vgs, vds, vbs);
                        let vbd = vbs - vds;
                        let (cbs, gbs) = bulk_junction(model.is * mult, vbs, gmin);
                        let (cbd, gbd) = bulk_junction(model.is * mult, vbd, gmin);
                        let (ed, es, vgs_e, vds_e, vbs_e) = if ev.mode > 0 {
                            (d, s, vgs, vds, vbs)
                        } else {
                            (s, d, vgs - vds, -vds, vbs - vds)
                        };
                        stamp_nl(
                            &mut asm,
                            lay,
                            ed,
                            es,
                            ty * ev.cdrain,
                            &[
                                (ev.gm, g, es, ty * vgs_e),
                                (ev.gds, ed, es, ty * vds_e),
                                (ev.gmbs, b, es, ty * vbs_e),
                            ],
                        );
                        stamp_nl(&mut asm, lay, b, s, ty * cbs, &[(gbs, b, s, ty * vbs)]);
                        stamp_nl(&mut asm, lay, b, d, ty * cbd, &[(gbd, b, d, ty * vbd)]);
                        st[ei] = St::Mos {
                            vgs,
                            vds,
                            vbs,
                            von: ev.von,
                        };
                    }
                    Kind::Q { model, area } => {
                        let ty = model.ty;
                        let (c, bn, en) = (e.nodes[0], e.nodes[1], e.nodes[2]);
                        let (vc, vb, ve) = (volt(&x, c), volt(&x, bn), volt(&x, en));
                        let (mut vbe, mut vbc) = (ty * (vb - ve), ty * (vb - vc));
                        if let St::Bjt { vbe: ob, vbc: oc } = st[ei] {
                            if use_init {
                                (vbe, vbc) = (ob, oc);
                            } else {
                                let vc_ = vcrit(model.is * area, vt);
                                let (lb, lc) = (pnjlim(vbe, ob, vt, vc_), pnjlim(vbc, oc, vt, vc_));
                                if (lb, lc) != (vbe, vbc) {
                                    limited = true;
                                }
                                (vbe, vbc) = (lb, lc);
                            }
                        }
                        let ev = bjt_eval(model, *area, vbe, vbc, gmin);
                        stamp_nl(
                            &mut asm,
                            lay,
                            c,
                            en,
                            ty * ev.cc,
                            &[(ev.dcc_dvbe(), bn, en, ty * vbe), (ev.dcc_dvbc(), bn, c, ty * vbc)],
                        );
                        stamp_nl(
                            &mut asm,
                            lay,
                            bn,
                            en,
                            ty * ev.cb,
                            &[(ev.gpi, bn, en, ty * vbe), (ev.gmu, bn, c, ty * vbc)],
                        );
                        st[ei] = St::Bjt { vbe, vbc };
                    }
                    Kind::D { model, area } => {
                        let (a, k) = (e.nodes[0], e.nodes[1]);
                        let mut vd = volt(&x, a) - volt(&x, k);
                        if let St::Dio { vd: od } = st[ei] {
                            if use_init {
                                vd = od;
                            } else {
                                let vte = model.n * vt;
                                let lv = pnjlim(vd, od, vte, vcrit(model.is * area, vte));
                                if lv != vd {
                                    limited = true;
                                }
                                vd = lv;
                            }
                        }
                        let (id, gd) = diode_eval(model, *area, vd, gmin);
                        stamp_nl(&mut asm, lay, a, k, id, &[(gd, a, k, vd)]);
                        st[ei] = St::Dio { vd };
                    }
                    _ => {}
                }
            }
            let xn = solve_real(lay.dim, asm.a, asm.z).ok_or_else(|| {
                "singular circuit matrix: a node may have no DC path to ground, or voltage sources form a loop"
                    .to_string()
            })?;
            let converged = !use_init
                && !limited
                && xn.iter().zip(&x).enumerate().all(|(i, (a, b))| {
                    let abstol = if i < lay.nn { 1e-12 } else { 1e-15 };
                    (a - b).abs() <= 1e-10 * a.abs().max(b.abs()) + abstol
                });
            x = xn;
            use_init = false;
            if converged || polish > 0 {
                polish += 1;
                if polish > 2 {
                    return Ok((x, st, iter + 1));
                }
            }
        }
        Err("DC operating point did not converge".to_string())
    }
}

#[allow(clippy::too_many_arguments)]
fn limit_mos(vgs: f64, vds: f64, vbs: f64, og: f64, od: f64, ob: f64, von: f64, is: f64) -> (f64, f64, f64) {
    let vt = vt();
    let vgd = vgs - vds;
    let ogd = og - od;
    // Recompose vds = vgs − vgd only when fetlim moved the gate voltage;
    // otherwise rounding would flag every iteration as limited.
    let (vgs, vds) = if od >= 0.0 {
        let lg = fetlim(vgs, og, von);
        let vds = if lg == vgs { vds } else { lg - vgd };
        (lg, limvds(vds, od))
    } else {
        let lgd = fetlim(vgd, ogd, von);
        let vds = if lgd == vgd { vds } else { vgs - lgd };
        let vds = -limvds(-vds, -od);
        (if lgd == vgd && vds == vgs - vgd { vgs } else { lgd + vds }, vds)
    };
    let vc = vcrit(is, vt);
    let vbs = if vds >= 0.0 {
        pnjlim(vbs, ob, vt, vc)
    } else {
        pnjlim(vbs - vds, ob - od, vt, vc) + vds
    };
    (vgs, vds, vbs)
}

pub fn operating_point(net: &Netlist) -> Result<Op, String> {
    let ctx = Ctx {
        net,
        lay: Layout::new(net),
    };
    let dim = ctx.lay.dim;
    let init = initial_states(net);
    let (x, iters, method) = match ctx.newton(1.0, 0.0, vec![0.0; dim], init.clone(), true) {
        Ok((x, _, it)) => (x, it, "newton"),
        Err(first) => match gmin_stepping(&ctx, &init).or_else(|_| source_stepping(&ctx, &init)) {
            Ok((x, it, m)) => (x, it, m),
            Err(_) => return Err(first),
        },
    };
    Ok(finish(net, &ctx.lay, x, method, iters))
}

fn gmin_stepping(ctx: &Ctx, init: &[St]) -> Result<(Vec<f64>, usize, &'static str), String> {
    let mut x = vec![0.0; ctx.lay.dim];
    let mut st = init.to_vec();
    let mut first = true;
    let mut total = 0;
    let mut g = 1e-2;
    while g > 1e-13 {
        let (nx, nst, it) = ctx.newton(1.0, g, x, st, first)?;
        (x, st, first) = (nx, nst, false);
        total += it;
        g /= 10.0;
    }
    let (x, _, it) = ctx.newton(1.0, 0.0, x, st, false)?;
    Ok((x, total + it, "gmin stepping"))
}

fn source_stepping(ctx: &Ctx, init: &[St]) -> Result<(Vec<f64>, usize, &'static str), String> {
    let mut x = vec![0.0; ctx.lay.dim];
    let mut st = init.to_vec();
    let mut total = 0;
    for k in 0..=40 {
        let (nx, nst, it) = ctx.newton(k as f64 / 40.0, 0.0, x, st, k == 0)?;
        (x, st) = (nx, nst);
        total += it;
    }
    Ok((x, total, "source stepping"))
}

fn finish(net: &Netlist, lay: &Layout, x: Vec<f64>, method: &'static str, iterations: usize) -> Op {
    let gmin = net.gmin;
    let mut v = vec![0.0];
    v.extend_from_slice(&x[..lay.nn]);
    let branch = lay.branch.iter().map(|b| b.map(|k| x[k])).collect();
    let dev = net
        .elements
        .iter()
        .map(|e| {
            let nv = |i: usize| v[e.nodes[i]];
            match &e.kind {
                Kind::M { model, w, l, mult } => {
                    let ty = model.ty;
                    let (vgs, vds, vbs) = (nv(1) - nv(2), nv(0) - nv(2), nv(3) - nv(2));
                    let beta = model.kp * w / l * mult;
                    let ev = mos_eval(model, beta, ty * vgs, ty * vds, ty * vbs);
                    let (_, gbs) = bulk_junction(model.is * mult, ty * vbs, gmin);
                    let (cbd, gbd) = bulk_junction(model.is * mult, ty * (vbs - vds), gmin);
                    let ich = if ev.mode > 0 { ev.cdrain } else { -ev.cdrain };
                    Some(DevOp::Mos(MosOp {
                        ty,
                        reversed: ev.mode < 0,
                        region: ev.region,
                        id: ty * (ich - cbd),
                        vgs,
                        vds,
                        vbs,
                        vth: ty * ev.von,
                        vdsat: ty * ev.vdsat,
                        gm: ev.gm,
                        gds: ev.gds,
                        gmb: ev.gmbs,
                        gbs,
                        gbd,
                    }))
                }
                Kind::Q { model, area } => {
                    let ty = model.ty;
                    let (vbe, vbc) = (nv(1) - nv(2), nv(1) - nv(0));
                    let ev = bjt_eval(model, *area, ty * vbe, ty * vbc, gmin);
                    let region = if ty * vbe < 0.4 {
                        "cutoff"
                    } else if ty * vbc > 0.4 {
                        "saturation"
                    } else {
                        "forward-active"
                    };
                    Some(DevOp::Bjt(BjtOp {
                        ty,
                        region,
                        ic: ty * ev.cc,
                        ib: ty * ev.cb,
                        vbe,
                        vce: nv(0) - nv(2),
                        gm: ev.gm,
                        gpi: ev.gpi,
                        go: ev.go,
                        gmu: ev.gmu,
                    }))
                }
                Kind::D { model, area } => {
                    let vd = nv(0) - nv(1);
                    let (id, gd) = diode_eval(model, *area, vd, gmin);
                    Some(DevOp::Diode(DiodeOp { id, vd, gd }))
                }
                _ => None,
            }
        })
        .collect();
    Op {
        v,
        branch,
        dev,
        method,
        iterations,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::netlist::parse;

    #[test]
    fn divider() {
        let n = parse("t\nV1 a 0 10\nR1 a b 1k\nR2 b 0 3k\n").unwrap();
        let op = operating_point(&n).unwrap();
        assert!((op.v[n.node("b").unwrap()] - 7.5).abs() < 1e-12);
        // Current flows + → − inside the source, i.e. −2.5 mA here.
        assert!((op.branch[0].unwrap() + 2.5e-3).abs() < 1e-15);
    }

    #[test]
    fn cs_saturation_matches_square_law() {
        let n = parse(
            "t\nVDD vdd 0 1.8\nVIN in 0 0.7\nRD vdd out 10k\nM1 out in 0 0 nm W=10u L=1u\n.model nm nmos (level=1 kp=200u vto=0.5 lambda=0.1)\n",
        )
        .unwrap();
        let op = operating_point(&n).unwrap();
        let Some(DevOp::Mos(m)) = &op.dev[3] else { panic!() };
        let vout = op.v[n.node("out").unwrap()];
        let beta = 200e-6 * 10.0;
        let id = beta / 2.0 * 0.2f64.powi(2) * (1.0 + 0.1 * vout);
        assert_eq!(m.region, MosRegion::Saturation);
        // The drain-bulk junction leaks gmin·vbd (as in ngspice), hence 1e-6.
        assert!((m.id - id).abs() < 1e-6 * id, "{} vs {}", m.id, id);
        assert!(((1.8 - vout) / 10e3 - m.id).abs() < 1e-15);
    }

    #[test]
    fn bjt_ce_bias() {
        let n = parse("t\nVCC vcc 0 5\nVB b 0 0.65\nRC vcc c 2k\nQ1 c b 0 qn\n.model qn npn is=1e-15 bf=100 vaf=50\n")
            .unwrap();
        let op = operating_point(&n).unwrap();
        let Some(DevOp::Bjt(q)) = &op.dev[3] else { panic!() };
        assert_eq!(q.region, "forward-active");
        assert!((q.ic - q.ib * 100.0 * (1.0 + q.vce / 50.0)).abs() / q.ic < 0.02);
    }
}
