//! DC robustness: random bias points over wide ranges (cutoff, triode,
//! saturation, reverse mode) for common topologies. An operating point
//! always exists for these, so every one must converge and pass the solver's
//! KCL residual check.

mod common;

use common::Rng;
use smallsignal_core::{dc, netlist};

const MODELS: &str = "\
.model mn nmos (kp=200u vto=0.5 lambda=0.05 gamma=0.4)
.model mp pmos (kp=80u vto=-0.6 lambda=0.08 gamma=0.3)
.model qn npn (is=1e-16 bf=150 vaf=40)
.model qp pnp (is=2e-16 bf=60 vaf=30)
.model dd d (is=1e-14 n=1.2)
";

fn circuit(rng: &mut Rng) -> String {
    let vdd = 0.5 + rng.unit() * 11.5;
    let vin = rng.unit() * vdd;
    let r = |rng: &mut Rng| rng.decade(10.0, 1e7);
    let wl = |rng: &mut Rng| {
        format!(
            "W={:.3e} L={:.3e}",
            rng.decade(0.5e-6, 500e-6),
            rng.decade(0.15e-6, 20e-6)
        )
    };
    let body = match rng.below(9) {
        0 => format!("VIN in 0 {vin}\nRD vdd out {}\nM1 out in s 0 mn {}\nRS s 0 {}\n", r(rng), wl(rng), r(rng)),
        1 => format!("VIN in 0 {vin}\nVB vb 0 {}\nM1 x in 0 0 mn {}\nM2 out vb x 0 mn {}\nRD vdd out {}\n", rng.unit() * vdd, wl(rng), wl(rng), r(rng)),
        2 => format!(
            "VIP inp 0 {vin}\nVIN inn 0 {}\nIT tail 0 {:.3e}\nM1 o1 inp tail 0 mn {w1}\nM2 o2 inn tail 0 mn {w1}\nR1 vdd o1 {r1}\nR2 vdd o2 {r1}\n",
            vin + (rng.unit() - 0.5) * 0.2,
            rng.decade(1e-7, 1e-3),
            w1 = wl(rng),
            r1 = r(rng)
        ),
        // Five-transistor OTA with a PMOS mirror load.
        3 => format!(
            "VIP inp 0 {vin}\nVIN inn 0 {vin}\nIT tail 0 {:.3e}\nM1 x inp tail 0 mn {w}\nM2 out inn tail 0 mn {w}\nM3 x x vdd vdd mp {p}\nM4 out x vdd vdd mp {p}\n",
            rng.decade(1e-7, 1e-3),
            w = wl(rng),
            p = wl(rng)
        ),
        // NMOS current mirror with an output resistor.
        4 => format!("IREF vdd d1 {:.3e}\nM1 d1 d1 0 0 mn {w}\nM2 out d1 0 0 mn {w}\nRL vdd out {}\n", rng.decade(1e-8, 1e-3), r(rng), w = wl(rng)),
        // Two-stage: NMOS CS into a PMOS CS.
        5 => format!(
            "VIN in 0 {vin}\nR1 vdd x {}\nM1 x in 0 0 mn {}\nM2 out x vdd vdd mp {}\nR2 out 0 {}\n",
            r(rng),
            wl(rng),
            wl(rng),
            r(rng)
        ),
        // BJT differential pair.
        6 => format!(
            "VIP inp 0 {vin}\nVIN inn 0 {}\nIT tail 0 {:.3e}\nQ1 o1 inp tail qn\nQ2 o2 inn tail qn\nR1 vdd o1 {r1}\nR2 vdd o2 {r1}\n",
            vin + (rng.unit() - 0.5) * 0.1,
            rng.decade(1e-7, 1e-2),
            r1 = r(rng)
        ),
        // PNP common emitter with a diode in the base path.
        7 => format!("VIN in 0 {vin}\nRB in b {}\nD1 b x dd\nRX x vdd {}\nQ1 out b vdd qp\nRC out 0 {}\n", r(rng), r(rng), r(rng)),
        // MOSFET driven backwards (drain below source).
        _ => format!("VIN in 0 {vin}\nRD out 0 {}\nM1 out in vdd 0 mn {}\nRX vdd s2 {}\nM2 s2 in out 0 mn {}\n", r(rng), wl(rng), r(rng), wl(rng)),
    };
    format!("stress\nVDD vdd 0 {vdd}\n{body}{MODELS}")
}

#[test]
fn every_bias_point_converges_and_satisfies_kcl() {
    let cases: usize = std::env::var("SMALLSIGNAL_DC_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(if cfg!(debug_assertions) { 500 } else { 50_000 });
    let mut rng = Rng::new(0xDC);
    let mut failures = Vec::new();
    for _ in 0..cases {
        let text = circuit(&mut rng);
        let net = netlist::parse(&text).unwrap();
        if let Err(e) = dc::operating_point(&net) {
            failures.push(format!("{e}\n{text}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {cases} failed; first:\n{}",
        failures.len(),
        failures.iter().take(3).cloned().collect::<Vec<_>>().join("\n\n")
    );
}
