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

/// The swept frequencies: f_k = fLow·10^(k/perDecade), k = 0…n, n the
/// decades times perDecade rounded.
#[derive(Clone, Debug, PartialEq)]
pub struct Sweep {
    pub f_low: f64,
    pub f_high: f64,
    pub per_decade: u32,
    pub freqs: Vec<f64>,
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
        let n = ((f_high / f_low).log10() * per_decade as f64).round().max(1.0) as u32;
        let freqs = (0..=n)
            .map(|k| f_low * 10f64.powf(k as f64 / per_decade as f64))
            .collect();
        Sweep {
            f_low,
            f_high,
            per_decade,
            freqs,
        }
    }
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

impl Sweep {
    pub fn json(&self) -> Value {
        json!({
            "fLow": self.f_low, "fHigh": self.f_high,
            "perDecade": self.per_decade, "f": self.freqs,
        })
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
    fn auto_band_spans_the_roots_a_decade_either_side() {
        let s = SweepRequest::default().resolve(&[16.7e3, 46e6], &[1e3]);
        assert_eq!((s.f_low, s.f_high), (100.0, 1e9));
        let none = SweepRequest::default().resolve(&[0.0], &[1e3]);
        assert_eq!((none.f_low, none.f_high), DEFAULT_BAND);
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
