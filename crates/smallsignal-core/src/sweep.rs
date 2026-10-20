//! A dense log-spaced frequency sweep of gain, Zin and Zout, for a Bode plot:
//! the same values as `values`, at more frequencies.

use num_complex::Complex64;
use serde::Deserialize;
use serde_json::{json, Value};
use std::f64::consts::PI;

/// Points per decade unless the request says otherwise.
pub const PER_DECADE: u32 = 20;
/// The widest band a sweep covers, in decades.
pub const MAX_DECADES: f64 = 20.0;
/// The most points per decade a request may ask for.
pub const MAX_PER_DECADE: u32 = 100;
/// The band without any finite nonzero root: the check grid's.
const DEFAULT_BAND: (f64, f64) = (1.0, 1e11);

/// `sweep` in the request: an explicit band, or none (`{}`) for one from the
/// circuit's natural frequencies.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SweepRequest {
    #[serde(default)]
    pub f_low: Option<f64>,
    #[serde(default)]
    pub f_high: Option<f64>,
    #[serde(default)]
    pub per_decade: Option<u32>,
}

/// The swept frequencies: f_k = fLow·10^(k/perDecade) for every k whose
/// f_k is within fHigh, then fHigh itself when the last of those falls
/// short of it (a band that is not whole steps). Never past fHigh.
#[derive(Clone, Debug, PartialEq)]
pub struct Sweep {
    pub f_low: f64,
    pub f_high: f64,
    pub per_decade: u32,
    pub freqs: Vec<f64>,
    /// The gain's unity (0 dB) and −3 dB frequencies, where it has them
    /// (`mark`).
    pub unity: Option<f64>,
    pub bandwidth: Option<f64>,
}

impl SweepRequest {
    /// Checks the request's own fields, before any solve.
    pub fn check(&self) -> Result<(), String> {
        let per = self.per_decade.unwrap_or(PER_DECADE);
        if per == 0 || per > MAX_PER_DECADE {
            return Err(format!("sweep: perDecade must be 1 to {MAX_PER_DECADE}"));
        }
        match (self.f_low, self.f_high) {
            (None, None) => Ok(()),
            (Some(lo), Some(hi)) => {
                if !(lo.is_finite() && hi.is_finite() && lo > 0.0 && hi > lo) {
                    return Err("sweep: needs 0 < fLow < fHigh".to_string());
                }
                if (hi / lo).log10() > MAX_DECADES {
                    return Err(format!("sweep: at most {MAX_DECADES} decades"));
                }
                Ok(())
            }
            _ => Err("sweep: give both fLow and fHigh, or neither".to_string()),
        }
    }

    /// The band: the request's, or whole decades from one below the lowest
    /// natural frequency (Hz) or requested frequency to one above the
    /// highest, at most `MAX_DECADES` from the lowest.
    pub fn resolve(&self, roots_hz: &[f64], freqs: &[f64]) -> Sweep {
        let per_decade = self.per_decade.unwrap_or(PER_DECADE);
        let (f_low, f_high) = match (self.f_low, self.f_high) {
            (Some(lo), Some(hi)) => (lo, hi),
            _ => auto_band(roots_hz, freqs),
        };
        let freqs = grid(f_low, f_high, per_decade);
        Sweep {
            f_low,
            f_high,
            per_decade,
            freqs,
            unity: None,
            bandwidth: None,
        }
    }
}

/// Whole steps up to fHigh (a step a rounding error short of it counts),
/// then fHigh when they end short of it.
fn grid(f_low: f64, f_high: f64, per_decade: u32) -> Vec<f64> {
    let per = per_decade as f64;
    let steps = ((f_high / f_low).log10() * per + 1e-9).floor() as u32;
    let mut freqs: Vec<f64> = (0..=steps).map(|k| f_low * 10f64.powf(k as f64 / per)).collect();
    if freqs.last().is_some_and(|&last| last < f_high * (1.0 - 1e-9)) {
        freqs.push(f_high);
    }
    freqs
}

fn auto_band(roots_hz: &[f64], freqs: &[f64]) -> (f64, f64) {
    let points: Vec<f64> = roots_hz
        .iter()
        .chain(freqs)
        .copied()
        .filter(|f| f.is_finite() && *f > 0.0)
        .collect();
    let (lo, hi) = points
        .iter()
        .fold((f64::INFINITY, 0.0f64), |(lo, hi), &f| (lo.min(f), hi.max(f)));
    if points.is_empty() || roots_hz.iter().all(|r| !(r.is_finite() && *r > 0.0)) {
        // No natural frequency to centre on: the check grid's band, widened
        // to the requested frequencies.
        let lo = DEFAULT_BAND.0.min(10f64.powf(lo.log10().floor()));
        let hi = DEFAULT_BAND.1.max(10f64.powf(hi.log10().ceil()));
        return clamp(lo, hi);
    }
    clamp(
        10f64.powf(lo.log10().floor() - 1.0),
        10f64.powf(hi.log10().ceil() + 1.0),
    )
}

fn clamp(lo: f64, hi: f64) -> (f64, f64) {
    let lo = lo.max(1e-6);
    let hi = hi.min(lo * 10f64.powf(MAX_DECADES)).min(1e18);
    (lo, hi.max(lo * 10.0))
}

/// Natural frequencies (rad/s) as Hz magnitudes.
pub fn roots_hz(roots: &[Complex64]) -> Vec<f64> {
    roots.iter().map(|r| r.norm() / (2.0 * PI)).collect()
}

/// One curve: `[re, im]` per swept frequency, null where it is not finite.
pub fn points(values: impl Iterator<Item = Option<Complex64>>) -> Value {
    Value::Array(
        values
            .map(|h| match h {
                Some(z) if z.re.is_finite() && z.im.is_finite() => json!([z.re, z.im]),
                _ => Value::Null,
            })
            .collect(),
    )
}

/// Bisection steps on log f for a crossing: far below f64's resolution.
const CROSSING_STEPS: u32 = 64;

impl Sweep {
    pub fn json(&self) -> Value {
        json!({
            "fLow": self.f_low, "fHigh": self.f_high,
            "perDecade": self.per_decade, "f": self.freqs,
            "unity": self.unity, "bandwidth": self.bandwidth,
        })
    }

    /// Adds the points a plot's readout lands on, so each reads a solved
    /// value rather than an interpolation: the poles' and zeros' |p| (Hz)
    /// within the band, then the gain's first fall through 1 (`unity`, for
    /// a unitless gain) and through 1/√2 of its value at fLow (`bandwidth`,
    /// −3 dB), each found by bisection on log f between the points so far.
    /// The roots go in first: a sharp notch or peak falls between grid
    /// points but sits at its root, so its crossings are bracketed there.
    /// `gain` is |H| at f.
    pub fn mark(&mut self, roots_hz: &[f64], gain: impl Fn(f64) -> Option<f64>, unitless: bool) {
        let (lo, hi) = (self.f_low, self.f_high);
        let inside = |f: &f64| f.is_finite() && *f >= lo && *f <= hi;
        self.add(roots_hz.iter().copied().filter(inside));
        let mags: Vec<Option<f64>> = self.freqs.iter().map(|&f| gain(f)).collect();
        // The first fall through `level` between swept points, refined.
        let fall = |level: f64| -> Option<f64> {
            let k = (1..self.freqs.len()).find(|&k| match (mags[k - 1], mags[k]) {
                (Some(a), Some(b)) => a >= level && b < level,
                _ => false,
            })?;
            let (mut lo, mut hi) = (self.freqs[k - 1].ln(), self.freqs[k].ln());
            for _ in 0..CROSSING_STEPS {
                let mid = 0.5 * (lo + hi);
                if gain(mid.exp())? >= level {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            Some((0.5 * (lo + hi)).exp())
        };
        self.bandwidth = mags
            .first()
            .copied()
            .flatten()
            .filter(|m| m.is_finite() && *m > 0.0)
            .and_then(|m| fall(m / std::f64::consts::SQRT_2));
        self.unity = if unitless { fall(1.0) } else { None };
        let crossings: Vec<f64> = self.unity.iter().chain(self.bandwidth.iter()).copied().collect();
        self.add(crossings.into_iter());
    }

    /// Adds frequencies, ascending; one within rounding of another is that
    /// one.
    fn add(&mut self, extra: impl Iterator<Item = f64>) {
        self.freqs.extend(extra);
        self.freqs.sort_by(f64::total_cmp);
        self.freqs.dedup_by(|b, a| (*b / *a - 1.0).abs() < 1e-12);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_band_is_log_spaced_and_closed() {
        let s = SweepRequest {
            f_low: Some(10.0),
            f_high: Some(1e4),
            per_decade: Some(4),
        }
        .resolve(&[], &[]);
        assert_eq!(s.freqs.len(), 13);
        assert_eq!(s.freqs[0], 10.0);
        assert!((s.freqs[12] / 1e4 - 1.0).abs() < 1e-12);
        assert!((s.freqs[1] / (10.0 * 10f64.powf(0.25)) - 1.0).abs() < 1e-15);
    }

    #[test]
    fn a_band_of_part_steps_ends_at_fhigh_not_past_it() {
        let at = |lo, hi, per| {
            SweepRequest {
                f_low: Some(lo),
                f_high: Some(hi),
                per_decade: Some(per),
            }
            .resolve(&[], &[])
            .freqs
        };
        assert_eq!(at(10.0, 15.0, 1), vec![10.0, 15.0]);
        let f = at(1.0, 50.0, 2);
        assert_eq!(f.len(), 5);
        assert!((f[3] / 10f64.powf(1.5) - 1.0).abs() < 1e-15);
        assert_eq!(f[4], 50.0);
        // Whole steps keep their own last point, fHigh to rounding.
        let f = at(100.0, 1e10, 10);
        assert_eq!(f.len(), 81);
        assert!((f[80] / 1e10 - 1.0).abs() < 1e-12);
        for (lo, hi, per) in [(10.0, 15.0, 1), (1.0, 50.0, 2), (3.0, 7e5, 7)] {
            assert!(at(lo, hi, per).iter().all(|&x| x >= lo && x <= hi * (1.0 + 1e-12)));
        }
    }

    #[test]
    fn auto_band_spans_the_roots_a_decade_either_side() {
        let s = SweepRequest::default().resolve(&[16.7e3, 46e6], &[1e3]);
        assert_eq!((s.f_low, s.f_high), (100.0, 1e9));
        let none = SweepRequest::default().resolve(&[0.0], &[1e3]);
        assert_eq!((none.f_low, none.f_high), DEFAULT_BAND);
    }

    #[test]
    fn marks_land_on_the_crossings_and_roots() {
        // A one-pole gain of 100 at 1 kHz: −3 dB at about 1 kHz, unity near
        // 100 kHz.
        let band = SweepRequest {
            f_low: Some(10.0),
            f_high: Some(1e7),
            per_decade: None,
        };
        let mut s = band.resolve(&[], &[]);
        let gain = |f: f64| Some(100.0 / (1.0 + (f / 1e3).powi(2)).sqrt());
        s.mark(&[1e3, 5e4], gain, true);
        let bw = s.bandwidth.unwrap();
        let unity = s.unity.unwrap();
        // −3 dB from the gain at fLow (10 Hz), a hair above the pole.
        let want = 1e3 * (2.0 * (1.0 + 1e-4) - 1.0f64).sqrt();
        assert!((bw / want - 1.0).abs() < 1e-9, "{bw}");
        assert!((unity / (1e3 * (1e4f64 - 1.0).sqrt()) - 1.0).abs() < 1e-9, "{unity}");
        for f in [bw, unity, 5e4] {
            assert!(s.freqs.contains(&f), "{f}");
        }
        assert!(s.freqs.windows(2).all(|w| w[0] < w[1]));
        // A notch at 3.3 kHz, deep and narrow between grid points: its
        // zero brackets the fall through 1.
        let mut n = band.resolve(&[], &[]);
        let f0 = 3.3e3;
        let notch = |f: f64| Some(10.0 * (1.0 - (f / f0).powi(2)).abs().max(1e-3 * f / f0).min(1.0) + 0.0);
        n.mark(&[f0], notch, true);
        let u = n.unity.expect("a crossing at the notch");
        assert!(u < f0 && u > 0.9 * f0, "{u}");
        // An impedance has no unity crossing.
        let mut z = band.resolve(&[], &[]);
        z.mark(&[], gain, false);
        assert_eq!(z.unity, None);
    }

    #[test]
    fn bad_requests_are_refused() {
        let bad = |lo, hi, per| {
            SweepRequest {
                f_low: lo,
                f_high: hi,
                per_decade: per,
            }
            .check()
            .is_err()
        };
        assert!(bad(Some(10.0), None, None));
        assert!(bad(Some(10.0), Some(1.0), None));
        assert!(bad(Some(0.0), Some(1.0), None));
        assert!(bad(Some(1.0), Some(1e30), None));
        assert!(bad(None, None, Some(0)));
        assert!(!bad(None, None, None));
    }
}
