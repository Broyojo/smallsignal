//! Dense LU solves with partial pivoting (the systems here are small).

use num_complex::Complex64;

/// Below this (rows scaled to unit max), a pivot is treated as zero: the
/// matrix is singular to working precision, and a "solution" from it would
/// depend on rounding (and so on the order of the netlist lines).
pub const PIVOT_TOL: f64 = 1e-13;

/// Solves A·x = b, rows equilibrated, partial pivoting. None when A is
/// singular to working precision.
pub fn solve_real(n: usize, mut a: Vec<f64>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    for r in 0..n {
        let m = a[r * n..(r + 1) * n].iter().fold(0.0f64, |m, v| m.max(v.abs()));
        if m == 0.0 || !m.is_finite() {
            return None;
        }
        for v in &mut a[r * n..(r + 1) * n] {
            *v /= m;
        }
        b[r] /= m;
    }
    for k in 0..n {
        let p = (k..n).max_by(|&i, &j| a[i * n + k].abs().total_cmp(&a[j * n + k].abs()))?;
        let piv = a[p * n + k].abs();
        if piv.is_nan() || piv <= PIVOT_TOL {
            return None;
        }
        if p != k {
            for j in 0..n {
                a.swap(k * n + j, p * n + j);
            }
            b.swap(k, p);
        }
        let piv = a[k * n + k];
        for i in k + 1..n {
            let f = a[i * n + k] / piv;
            if f != 0.0 {
                for j in k..n {
                    a[i * n + j] -= f * a[k * n + j];
                }
                b[i] -= f * b[k];
            }
        }
    }
    let mut x = vec![0.0; n];
    for k in (0..n).rev() {
        let mut s = b[k];
        for j in k + 1..n {
            s -= a[k * n + j] * x[j];
        }
        x[k] = s / a[k * n + k];
    }
    x.iter().all(|v| v.is_finite()).then_some(x)
}

/// Complex LU factorization, kept so the cross-check can also estimate the
/// condition number ‖A‖₁‖A⁻¹‖₁.
pub struct LuComplex {
    n: usize,
    lu: Vec<Complex64>,
    piv: Vec<usize>,
    norm1: f64,
}

impl LuComplex {
    pub fn factor(n: usize, mut a: Vec<Complex64>) -> Option<LuComplex> {
        let norm1 = (0..n)
            .map(|c| (0..n).map(|r| a[r * n + c].norm()).sum::<f64>())
            .fold(0.0, f64::max);
        let mut piv: Vec<usize> = (0..n).collect();
        for k in 0..n {
            let p = (k..n).max_by(|&i, &j| a[i * n + k].norm().total_cmp(&a[j * n + k].norm()))?;
            if a[p * n + k].norm() == 0.0 {
                return None;
            }
            if p != k {
                for j in 0..n {
                    a.swap(k * n + j, p * n + j);
                }
                piv.swap(k, p);
            }
            let d = a[k * n + k];
            for i in k + 1..n {
                let f = a[i * n + k] / d;
                a[i * n + k] = f;
                if f.norm() != 0.0 {
                    for j in k + 1..n {
                        let t = a[k * n + j];
                        a[i * n + j] -= f * t;
                    }
                }
            }
        }
        Some(LuComplex { n, lu: a, piv, norm1 })
    }

    pub fn solve(&self, b: &[Complex64]) -> Vec<Complex64> {
        let n = self.n;
        let mut x: Vec<Complex64> = self.piv.iter().map(|&p| b[p]).collect();
        for i in 0..n {
            for j in 0..i {
                let t = self.lu[i * n + j] * x[j];
                x[i] -= t;
            }
        }
        for i in (0..n).rev() {
            for j in i + 1..n {
                let t = self.lu[i * n + j] * x[j];
                x[i] -= t;
            }
            x[i] /= self.lu[i * n + i];
        }
        x
    }

    /// κ₁(A) computed exactly from A⁻¹ (the systems here are small).
    pub fn cond1(&self) -> f64 {
        let n = self.n;
        let mut inv_norm = 0.0f64;
        for c in 0..n {
            let mut e = vec![Complex64::new(0.0, 0.0); n];
            e[c] = Complex64::new(1.0, 0.0);
            inv_norm = inv_norm.max(self.solve(&e).iter().map(|v| v.norm()).sum());
        }
        self.norm1 * inv_norm
    }
}
