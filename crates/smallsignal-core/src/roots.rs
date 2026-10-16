//! Polynomial roots (Aberth–Ehrlich) for poles and zeros.

use num_complex::Complex64;

/// Roots of Σ c[k] s^k. Leading and trailing zero coefficients are handled
/// (trailing ones give roots at s = 0).
pub fn roots(c: &[f64]) -> Vec<Complex64> {
    let mut hi = c.len();
    while hi > 0 && c[hi - 1] == 0.0 {
        hi -= 1;
    }
    let mut lo = 0;
    while lo < hi && c[lo] == 0.0 {
        lo += 1;
    }
    let mut out = vec![Complex64::new(0.0, 0.0); lo];
    if hi <= lo + 1 {
        return out;
    }
    let c = &c[lo..hi];
    let n = c.len() - 1;
    // Scale s = σ·t so the roots are near the unit circle; work in logs so
    // the coefficients (often 1e-40 and smaller) stay representable.
    let lsig = (c[0].abs().ln() - c[n].abs().ln()) / n as f64;
    let lead = c[n].abs().ln() + n as f64 * lsig;
    let b: Vec<f64> = c
        .iter()
        .enumerate()
        .map(|(k, &v)| v.signum() * (v.abs().ln() + k as f64 * lsig - lead).exp())
        .collect();
    let b = |k: usize| if b[k].is_finite() { b[k] } else { 0.0 };
    let p = |z: Complex64| -> (Complex64, Complex64) {
        let mut v = Complex64::new(0.0, 0.0);
        let mut d = Complex64::new(0.0, 0.0);
        for k in (0..=n).rev() {
            d = d * z + v;
            v = v * z + b(k);
        }
        (v, d)
    };
    let mut z: Vec<Complex64> = (0..n)
        .map(|k| Complex64::from_polar(1.0, 2.0 * std::f64::consts::PI * (k as f64 + 0.25) / n as f64 + 0.4))
        .collect();
    for _ in 0..500 {
        let mut moved = 0.0f64;
        for i in 0..n {
            let (v, d) = p(z[i]);
            if v.norm() == 0.0 {
                continue;
            }
            let ratio = v / d;
            let mut sum = Complex64::new(0.0, 0.0);
            for j in 0..n {
                if j != i {
                    sum += 1.0 / (z[i] - z[j]);
                }
            }
            let w = ratio / (1.0 - ratio * sum);
            if w.re.is_finite() && w.im.is_finite() {
                z[i] -= w;
                moved = moved.max(w.norm() / z[i].norm().max(1e-300));
            }
        }
        if moved < 1e-14 {
            break;
        }
    }
    let sig = lsig.exp();
    out.extend(z.into_iter().map(|r| {
        let r = r * sig;
        // Snap numerically-real roots onto the real axis.
        if r.im.abs() <= 1e-9 * r.norm() {
            Complex64::new(r.re, 0.0)
        } else {
            r
        }
    }));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_and_complex() {
        // (s + 1e3)(s + 1e6) = s² + 1.001e6 s + 1e9
        let mut r = roots(&[1e9, 1.001e6, 1.0]);
        r.sort_by(|a, b| a.re.total_cmp(&b.re));
        assert!((r[0].re + 1e6).abs() < 1e-3 && (r[1].re + 1e3).abs() < 1e-6);
        // s² + 2s + 5 → -1 ± 2j
        let r = roots(&[5.0, 2.0, 1.0]);
        assert!(r
            .iter()
            .all(|z| (z.re + 1.0).abs() < 1e-9 && (z.im.abs() - 2.0).abs() < 1e-9));
        // s·(s + 1)
        let r = roots(&[0.0, 1.0, 1.0]);
        assert_eq!(r.len(), 2);
    }
}
