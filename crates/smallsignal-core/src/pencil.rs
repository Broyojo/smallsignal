//! Numeric poles and zeros straight from an MNA matrix, without expanding a
//! determinant: the finite roots of det(G + s·C) as eigenvalues. Used when an
//! exact expression is over the term budget.
//!
//! Every entry of the small-signal matrix is affine in s, and each reactive
//! parameter p (a capacitance, or an inductance in its branch row) stamps a
//! rank-one pattern, so C = Σ p·u_p·v_pᵀ with integer u_p, v_p. The columns
//! are reduced exactly to independent ones (C = Ũ·W·Ṽᵀ, so a capacitor loop
//! or two capacitors in parallel cost no spurious root), and for a shift σ
//! where A = G + σC is regular, det(G + sC) = det(A)·det(I + (s − σ)·Ṽᵀ·A⁻¹·Ũ·W).
//! Each eigenvalue λ of M = Ṽᵀ·A⁻¹·Ũ·W gives the root s = σ − 1/λ; λ within
//! rounding of zero is a root at infinity (the degree drops).
//!
//! Whether a determinant vanishes identically is decided exactly, as for the
//! symbolic polynomial: at random parameter values modulo 2⁶¹−1.

use crate::linalg::{LuComplex, PIVOT_TOL};
use crate::poly::Poly;
use crate::ss::{SsCircuit, System};
use num_complex::Complex64;

/// Sparse integer vector: (index, value).
type IntVec = Vec<(usize, i64)>;

/// A square matrix G + s·C, with C kept as integer rank-one stamps.
pub struct Pencil {
    n: usize,
    g: Vec<f64>,
    /// Each reactive parameter's MNA value with its stamp's u and v.
    stamps: Vec<(f64, IntVec, IntVec)>,
}

impl Pencil {
    /// The matrix of `sys` (with `ss`'s values), optionally bordered by
    /// `[[A, b], [wᵀ, 0]]`, whose determinant is −wᵀ·adj(A)·b: the Cramer
    /// numerator of wᵀx. `w` lists (column, weight).
    pub fn new(sys: &System, ss: &SsCircuit, border: Option<&[(usize, i128)]>) -> Option<Pencil> {
        let dim = sys.dim;
        let n = dim + usize::from(border.is_some());
        let mut g = vec![0.0; n * n];
        // Per reactive parameter, its entries (row, column, coefficient).
        type Entries = Vec<(usize, usize, i128)>;
        let mut reactive: Vec<(usize, Entries)> = Vec::new();
        for (r, row) in sys.a.iter().enumerate() {
            for (c, p) in row.iter().enumerate() {
                for (&m, &coef) in &p.terms {
                    if m == 0 {
                        g[r * n + c] += coef as f64;
                        continue;
                    }
                    // Every MNA entry is a sum of single parameters.
                    if m.count_ones() != 1 {
                        return None;
                    }
                    let i = m.trailing_zeros() as usize;
                    if m & ss.reactive_mask == 0 {
                        g[r * n + c] += coef as f64 * ss.params[i].mna_value();
                    } else {
                        match reactive.iter_mut().find(|(k, _)| *k == i) {
                            Some((_, list)) => list.push((r, c, coef)),
                            None => reactive.push((i, vec![(r, c, coef)])),
                        }
                    }
                }
            }
        }
        if let Some(w) = border {
            for (r, &b) in sys.b.iter().enumerate() {
                g[r * n + dim] = b as f64;
            }
            for &(c, x) in w {
                g[dim * n + c] += x as f64;
            }
        }
        let mut stamps = Vec::new();
        for (i, list) in reactive {
            let (r0, c0, k0) = list[0];
            let k0 = i64::try_from(k0).ok()?;
            let col = |c: usize| list.iter().find(|e| e.0 == r0 && e.1 == c).map(|e| e.2);
            let row = |r: usize| list.iter().find(|e| e.1 == c0 && e.0 == r).map(|e| e.2);
            let mut u: Vec<(usize, i64)> = Vec::new();
            let mut v: Vec<(usize, i64)> = Vec::new();
            for &(r, c, _) in &list {
                if c == c0 && !u.iter().any(|x| x.0 == r) {
                    u.push((r, i64::try_from(row(r)?).ok()?));
                }
                if r == r0 && !v.iter().any(|x| x.0 == c) {
                    let k = i64::try_from(col(c)?).ok()?;
                    if k % k0 != 0 {
                        return None;
                    }
                    v.push((c, k / k0));
                }
            }
            // Rank one: every entry is u_r·v_c, and nothing else is there.
            let rank_one = list.len() == u.len() * v.len()
                && list.iter().all(|&(r, c, k)| {
                    let ur = u.iter().find(|x| x.0 == r).map(|x| x.1);
                    let vc = v.iter().find(|x| x.0 == c).map(|x| x.1);
                    matches!((ur, vc), (Some(a), Some(b)) if (a * b) as i128 == k)
                });
            if !rank_one {
                return None;
            }
            stamps.push((ss.params[i].mna_value(), u, v));
        }
        Some(Pencil { n, g, stamps })
    }

    fn at(&self, sigma: f64) -> Vec<f64> {
        let n = self.n;
        let mut a = self.g.clone();
        if sigma != 0.0 {
            for (p, u, v) in &self.stamps {
                for &(r, x) in u {
                    for &(c, y) in v {
                        a[r * n + c] += sigma * p * (x * y) as f64;
                    }
                }
            }
        }
        a
    }

    /// Trial shifts: 0, then real values of both signs over fourteen decades
    /// up to the circuit's own frequency scale ‖G‖/‖C‖.
    fn shifts(&self) -> Vec<f64> {
        let gmax = self.g.iter().fold(0.0f64, |m, v| m.max(v.abs()));
        let cmax = self.stamps.iter().fold(0.0f64, |m, s| m.max(s.0.abs()));
        let mut out = vec![0.0];
        if cmax > 0.0 && gmax > 0.0 {
            let scale = gmax / cmax;
            for k in -12..=2 {
                let f = 10f64.powi(k);
                out.extend([0.83 * f, -2.9 * f]);
            }
            out.iter_mut().skip(1).for_each(|v| *v *= scale);
        }
        out
    }

    /// Finite roots of det(G + s·C) in rad/s, given its lowest and highest
    /// power of s (`s_orders`): the `hi` eigenvalues farthest from zero are
    /// the finite roots (the rest are at infinity), and the `lo` of those
    /// nearest s = 0 are exactly 0 (then the shift is never 0). None if the
    /// eigenvalue iteration fails or no shift is regular.
    pub fn roots(&self, (lo, hi): (usize, usize)) -> Option<Vec<Complex64>> {
        let n = self.n;
        if hi == 0 {
            return Some(Vec::new());
        }
        let (us, tu) = reduce(n, self.stamps.iter().map(|s| &s.1));
        let (vs, tv) = reduce(n, self.stamps.iter().map(|s| &s.2));
        // W = T_u·D·T_vᵀ (r_u × r_v).
        let (ru, rv) = (us.len(), vs.len());
        let mut w = vec![0.0; ru * rv];
        for (k, s) in self.stamps.iter().enumerate() {
            for i in 0..ru {
                if tu[k][i] == 0.0 {
                    continue;
                }
                for j in 0..rv {
                    w[i * rv + j] += tu[k][i] * s.0 * tv[k][j];
                }
            }
        }
        let red = Reduced {
            us: &us,
            vs: &vs,
            w: &w,
        };
        // Each eigenvalue is accurate to rounding of the largest, so a root
        // whose λ = 1/(σ − root) is small next to it is only roughly placed:
        // of the trial shifts, the one with the least spread among the
        // finite roots' eigenvalues wins (it cannot be 0 when s = 0 is a
        // root); then a shift at their geometric mean, clear of each, may do
        // better still.
        let best = |shifts: Vec<f64>| {
            shifts
                .into_iter()
                .filter(|&s| !(lo > 0 && s == 0.0))
                .filter_map(|sigma| self.pass(sigma, lo, hi, &red))
                .min_by(|a, b| a.1.total_cmp(&b.1))
        };
        let (mut out, mut spread) = best(self.shifts())?;
        let nonzero: Vec<Complex64> = out.iter().skip(lo).copied().collect();
        if !nonzero.is_empty() {
            let mean = (nonzero.iter().map(|r| r.norm().ln()).sum::<f64>() / nonzero.len() as f64).exp();
            let second: Vec<f64> = [0.618, -0.618, 1.618, -1.618, 0.3, -0.3, 3.3, -3.3]
                .into_iter()
                .map(|k| k * mean)
                .filter(|&sg| nonzero.iter().all(|r| (r - sg).norm() >= 0.2 * sg.abs()))
                .collect();
            if let Some((better, sp)) = best(second) {
                if sp < spread {
                    (out, spread) = (better, sp);
                }
            }
        }
        let _ = spread;
        // Then Newton on det refines each root (a conjugate as its partner's
        // conjugate), kept only if it stays in its own basin.
        let rough = out.clone();
        for (i, s) in out.iter_mut().enumerate().skip(lo) {
            let r = rough[i];
            let basin = rough
                .iter()
                .enumerate()
                .filter(|&(j, _)| j != i)
                .map(|(_, q)| (q - r).norm())
                .fold(f64::INFINITY, f64::min)
                .min(r.norm())
                / 2.0;
            let fine = if r.im < 0.0 {
                self.refine(r.conj(), lo, &red).conj()
            } else {
                self.refine(r, lo, &red)
            };
            if (fine - r).norm() < basin {
                *s = fine;
            }
        }
        Some(out)
    }

    /// The `hi` finite roots from one shift σ, nearest s = 0 first, the `lo`
    /// nearest set to exactly 0, with the spread max|λ|/min|λ| of their
    /// eigenvalues; None if A(σ) is singular, the eigenvalue iteration
    /// fails, or a finite root's eigenvalue is lost to rounding.
    fn pass(&self, sigma: f64, lo: usize, hi: usize, red: &Reduced) -> Option<(Vec<Complex64>, f64)> {
        let n = self.n;
        let (ru, rv) = (red.us.len(), red.vs.len());
        let lu = ScaledLu::factor(n, self.at(sigma))?;
        // X = A⁻¹·Ũ, one column per independent u.
        let x: Vec<Vec<f64>> = red
            .us
            .iter()
            .map(|&k| {
                let mut b = vec![0.0; n];
                for &(r, val) in &self.stamps[k].1 {
                    b[r] = val as f64;
                }
                lu.solve(&b)
            })
            .collect();
        if x.iter().flatten().any(|v| !v.is_finite()) {
            return None;
        }
        // M = (Ṽᵀ·X)·W.
        let y: Vec<f64> = (0..rv)
            .flat_map(|i| {
                let v = &self.stamps[red.vs[i]].2;
                x.iter()
                    .map(|col| v.iter().map(|&(c, val)| val as f64 * col[c]).sum::<f64>())
                    .collect::<Vec<_>>()
            })
            .collect();
        let mut m = vec![0.0; rv * rv];
        for i in 0..rv {
            for k in 0..ru {
                let yik = y[i * ru + k];
                if yik != 0.0 {
                    for j in 0..rv {
                        m[i * rv + j] += yik * red.w[k * rv + j];
                    }
                }
            }
        }
        let mut eig = eigenvalues(rv, m)?;
        if eig.len() < hi {
            return None;
        }
        eig.sort_by(|a, b| b.norm().total_cmp(&a.norm()));
        let (big, small) = (eig[0].norm(), eig[hi - 1].norm());
        let spread = big / small;
        if !spread.is_finite() || small <= 1e3 * f64::EPSILON * big {
            return None;
        }
        let mut out: Vec<Complex64> = eig[..hi]
            .iter()
            .map(|&lam| {
                let mut s = Complex64::new(sigma, 0.0) - 1.0 / lam;
                if s.im.abs() <= 1e-9 * s.norm() {
                    s.im = 0.0;
                }
                s
            })
            .collect();
        out.sort_by(|a, b| a.norm().total_cmp(&b.norm()));
        for s in out.iter_mut().take(lo) {
            *s = Complex64::new(0.0, 0.0);
        }
        Some((out, spread))
    }

    /// Newton's method on ln det(G + sC) − lo·ln s from s0, whose derivative
    /// is tr(A(s)⁻¹·C) = tr(Ṽᵀ·A(s)⁻¹·Ũ·W). Returns s0 unless it converges
    /// (to 4 eps, or to within 1e-9 where the steps stop shrinking).
    fn refine(&self, s0: Complex64, lo: usize, red: &Reduced) -> Complex64 {
        let n = self.n;
        let (ru, rv) = (red.us.len(), red.vs.len());
        let mut s = s0;
        let mut last = f64::INFINITY;
        for _ in 0..20 {
            let mut a: Vec<Complex64> = self.g.iter().map(|&v| Complex64::new(v, 0.0)).collect();
            for (p, u, v) in &self.stamps {
                for &(r, x) in u {
                    for &(c, y) in v {
                        a[r * n + c] += s * (p * (x * y) as f64);
                    }
                }
            }
            let Some(lu) = LuComplex::factor(n, a) else {
                // Exactly singular: s is the root.
                return s;
            };
            let x: Vec<Vec<Complex64>> = red
                .us
                .iter()
                .map(|&k| {
                    let mut b = vec![Complex64::new(0.0, 0.0); n];
                    for &(r, val) in &self.stamps[k].1 {
                        b[r] = Complex64::new(val as f64, 0.0);
                    }
                    lu.solve(&b)
                })
                .collect();
            let mut tr = Complex64::new(0.0, 0.0);
            for i in 0..rv {
                let v = &self.stamps[red.vs[i]].2;
                for (k, col) in x.iter().enumerate().take(ru) {
                    let y: Complex64 = v.iter().map(|&(c, val)| col[c] * val as f64).sum();
                    tr += y * red.w[k * rv + i];
                }
            }
            if lo > 0 {
                tr -= lo as f64 / s;
            }
            let step = 1.0 / tr;
            if !(step.re.is_finite() && step.im.is_finite()) {
                break;
            }
            // Converged, or down to the rounding of tr: steps stop shrinking.
            let size = step.norm();
            if size <= 4.0 * f64::EPSILON * s.norm() {
                return s - step;
            }
            if size > 0.5 * last && size <= 1e-9 * s.norm() {
                return s;
            }
            last = size;
            s -= step;
        }
        s0
    }
}

/// The independent stamp columns and W of `Pencil::roots`.
struct Reduced<'a> {
    us: &'a [usize],
    vs: &'a [usize],
    w: &'a [f64],
}

/// Real LU with rows, then columns, scaled by powers of two to unit maximum
/// (exact), and partial pivoting; None when a pivot is below PIVOT_TOL, i.e.
/// singular to working precision.
struct ScaledLu {
    n: usize,
    lu: Vec<f64>,
    perm: Vec<usize>,
    row: Vec<f64>,
    col: Vec<f64>,
}

/// 2^−round(log₂ m): scales m to within √2 of 1, exactly.
fn unit_scale(m: f64) -> f64 {
    if m > 0.0 && m.is_finite() {
        (-(m.log2().round())).exp2()
    } else {
        1.0
    }
}

impl ScaledLu {
    fn factor(n: usize, mut a: Vec<f64>) -> Option<ScaledLu> {
        if a.iter().any(|v| !v.is_finite()) {
            return None;
        }
        let row: Vec<f64> = (0..n)
            .map(|r| unit_scale(a[r * n..(r + 1) * n].iter().fold(0.0f64, |m, v| m.max(v.abs()))))
            .collect();
        for r in 0..n {
            for v in &mut a[r * n..(r + 1) * n] {
                *v *= row[r];
            }
        }
        let col: Vec<f64> = (0..n)
            .map(|c| unit_scale((0..n).fold(0.0f64, |m, r| m.max(a[r * n + c].abs()))))
            .collect();
        for r in 0..n {
            for c in 0..n {
                a[r * n + c] *= col[c];
            }
        }
        let mut perm: Vec<usize> = (0..n).collect();
        for k in 0..n {
            let p = (k..n).max_by(|&i, &j| a[i * n + k].abs().total_cmp(&a[j * n + k].abs()))?;
            if a[p * n + k].abs() <= PIVOT_TOL {
                return None;
            }
            if p != k {
                for j in 0..n {
                    a.swap(k * n + j, p * n + j);
                }
                perm.swap(k, p);
            }
            let d = a[k * n + k];
            for i in k + 1..n {
                let f = a[i * n + k] / d;
                a[i * n + k] = f;
                if f != 0.0 {
                    for j in k + 1..n {
                        a[i * n + j] -= f * a[k * n + j];
                    }
                }
            }
        }
        Some(ScaledLu {
            n,
            lu: a,
            perm,
            row,
            col,
        })
    }

    fn solve(&self, b: &[f64]) -> Vec<f64> {
        let n = self.n;
        let mut y: Vec<f64> = self.perm.iter().map(|&p| b[p] * self.row[p]).collect();
        for i in 0..n {
            for j in 0..i {
                y[i] -= self.lu[i * n + j] * y[j];
            }
        }
        for i in (0..n).rev() {
            for j in i + 1..n {
                y[i] -= self.lu[i * n + j] * y[j];
            }
            y[i] /= self.lu[i * n + i];
        }
        y.iter().zip(&self.col).map(|(v, c)| v * c).collect()
    }
}

const P: u128 = (1u128 << 61) - 1;

fn pow_mod(mut b: u128, mut e: u128) -> u128 {
    let mut r = 1u128;
    while e > 0 {
        if e & 1 == 1 {
            r = r * b % P;
        }
        b = b * b % P;
        e >>= 1;
    }
    r
}

fn inv_mod(x: u128) -> u128 {
    pow_mod(x, P - 2)
}

fn eval_mod(p: &Poly, vals: &[u128]) -> u128 {
    let mut acc = 0u128;
    for (&m, &c) in &p.terms {
        let mut v = c.rem_euclid(P as i128) as u128;
        let mut bits = m;
        while bits != 0 {
            let i = bits.trailing_zeros() as usize;
            v = v * vals[i] % P;
            bits &= bits - 1;
        }
        acc = (acc + v) % P;
    }
    acc
}

/// det of `sys`'s matrix, bordered as in `Pencil::new`, at parameter values
/// `vals`, modulo P.
fn det_mod(sys: &System, border: Option<&[(usize, i128)]>, vals: &[u128]) -> u128 {
    let dim = sys.dim;
    let n = dim + usize::from(border.is_some());
    let modp = |c: i128| c.rem_euclid(P as i128) as u128;
    let mut a = vec![0u128; n * n];
    for (r, row) in sys.a.iter().enumerate() {
        for (c, p) in row.iter().enumerate() {
            a[r * n + c] = eval_mod(p, vals);
        }
    }
    if let Some(w) = border {
        for (r, &b) in sys.b.iter().enumerate() {
            a[r * n + dim] = modp(b);
        }
        for &(c, k) in w {
            a[dim * n + c] = (a[dim * n + c] + modp(k)) % P;
        }
    }
    let mut det = 1u128;
    for k in 0..n {
        let Some(p) = (k..n).find(|&i| a[i * n + k] != 0) else {
            return 0;
        };
        if p != k {
            for j in 0..n {
                a.swap(k * n + j, p * n + j);
            }
            det = P - det;
        }
        det = det * a[k * n + k] % P;
        let inv = inv_mod(a[k * n + k]);
        for i in k + 1..n {
            let f = a[i * n + k] * inv % P;
            if f != 0 {
                for j in k..n {
                    a[i * n + j] = (a[i * n + j] + P - f * a[k * n + j] % P) % P;
                }
            }
        }
    }
    det % P
}

/// Whether det of `sys`'s matrix (bordered as in `Pencil::new`) is the zero
/// polynomial in the parameters of `ss` (s riding on the reactive ones),
/// or with `dc` its value at s = 0 is: exactly zero at two random points
/// modulo 2⁶¹−1 (a nonzero polynomial passes both with probability below
/// 10⁻³⁰).
pub fn vanishes(sys: &System, ss: &SsCircuit, border: Option<&[(usize, i128)]>, dc: bool) -> bool {
    let mut seed: u64 = 0xD1B5_4A32_D192_ED03;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed as u128) % (P - 2) + 2
    };
    (0..2).all(|_| {
        let vals: Vec<u128> = ss
            .params
            .iter()
            .map(|p| if dc && p.reactive { 0 } else { rnd() })
            .collect();
        det_mod(sys, border, &vals) == 0
    })
}

/// The lowest and highest power of s in det of `sys`'s matrix (bordered as
/// in `Pencil::new`), exactly as in the symbolic polynomial (s rides on the
/// reactive parameters): with every reactive value scaled by t, det is a
/// polynomial in t whose coefficients are recovered by interpolation modulo
/// 2⁶¹−1 at random parameter values, twice (a nonzero coefficient reads as
/// zero with probability below 10⁻¹⁵). None when det is the zero polynomial.
pub fn s_orders(sys: &System, ss: &SsCircuit, border: Option<&[(usize, i128)]>) -> Option<(usize, usize)> {
    let reactive: Vec<bool> = ss.params.iter().map(|p| p.reactive).collect();
    let m = reactive.iter().filter(|&&r| r).count();
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed as u128) % (P - 2) + 2
    };
    let mut orders: Option<(usize, usize)> = None;
    for _ in 0..2 {
        let base: Vec<u128> = reactive.iter().map(|_| rnd()).collect();
        // det at t = 1..=m+1, then the coefficients of the degree-m interpolant.
        let ts: Vec<u128> = (1..=m as u128 + 1).collect();
        let ys: Vec<u128> = ts
            .iter()
            .map(|&t| {
                let vals: Vec<u128> = base
                    .iter()
                    .zip(&reactive)
                    .map(|(&v, &r)| if r { v * t % P } else { v })
                    .collect();
                det_mod(sys, border, &vals)
            })
            .collect();
        let coef = interpolate(&ts, &ys);
        let lo = coef.iter().position(|&c| c != 0);
        let hi = coef.iter().rposition(|&c| c != 0);
        if let (Some(lo), Some(hi)) = (lo, hi) {
            orders = Some(match orders {
                Some((a, b)) => (a.min(lo), b.max(hi)),
                None => (lo, hi),
            });
        }
    }
    orders
}

/// Coefficients (lowest first) of the polynomial through (ts, ys) mod P.
fn interpolate(ts: &[u128], ys: &[u128]) -> Vec<u128> {
    let n = ts.len();
    let mut out = vec![0u128; n];
    for j in 0..n {
        // Π_{k≠j} (t − t_k) / (t_j − t_k)
        let mut basis = vec![1u128];
        let mut denom = 1u128;
        for k in 0..n {
            if k == j {
                continue;
            }
            let mut next = vec![0u128; basis.len() + 1];
            for (i, &b) in basis.iter().enumerate() {
                next[i + 1] = (next[i + 1] + b) % P;
                next[i] = (next[i] + P - b * ts[k] % P) % P;
            }
            basis = next;
            denom = denom * ((ts[j] + P - ts[k]) % P) % P;
        }
        let scale = ys[j] * inv_mod(denom) % P;
        for (o, b) in out.iter_mut().zip(&basis) {
            *o = (*o + b * scale) % P;
        }
    }
    out
}

/// Exact rational with i128 parts (the reductions only see small integers).
#[derive(Clone, Copy, PartialEq)]
struct Q(i128, i128);

impl Q {
    fn new(n: i128, d: i128) -> Q {
        let g = gcd(n.abs(), d.abs()).max(1);
        let s = if d < 0 { -1 } else { 1 };
        Q(s * n / g, s * d / g)
    }
    fn zero() -> Q {
        Q(0, 1)
    }
    fn is_zero(self) -> bool {
        self.0 == 0
    }
    fn sub(self, o: Q) -> Q {
        Q::new(self.0 * o.1 - o.0 * self.1, self.1 * o.1)
    }
    fn mul(self, o: Q) -> Q {
        Q::new(self.0 * o.0, self.1 * o.1)
    }
    fn div(self, o: Q) -> Q {
        Q::new(self.0 * o.1, self.1 * o.0)
    }
    fn f64(self) -> f64 {
        self.0 as f64 / self.1 as f64
    }
}

fn gcd(a: i128, b: i128) -> i128 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

/// Independent columns among `cols` (exact elimination, in order) and, for
/// each column, its coefficients over them: col_k = Σ_i t[k][i]·col_{sel[i]}.
fn reduce<'a>(n: usize, cols: impl Iterator<Item = &'a Vec<(usize, i64)>>) -> (Vec<usize>, Vec<Vec<f64>>) {
    let mut sel: Vec<usize> = Vec::new();
    // Each basis vector b (reduced) with b = Σ comb_i·col_{sel[i]}, its pivot.
    let mut basis: Vec<(usize, Vec<Q>, Vec<Q>)> = Vec::new();
    let mut coeffs: Vec<Vec<Q>> = Vec::new();
    for (k, col) in cols.enumerate() {
        let mut v = vec![Q::zero(); n];
        for &(r, x) in col {
            v[r] = Q::new(x as i128, 1);
        }
        // v = col_k + Σ comb_i·col_{sel[i]}
        let mut comb = vec![Q::zero(); sel.len()];
        for (p, b, bc) in &basis {
            if v[*p].is_zero() {
                continue;
            }
            let f = v[*p].div(b[*p]);
            for (x, y) in v.iter_mut().zip(b) {
                if !y.is_zero() {
                    *x = x.sub(f.mul(*y));
                }
            }
            for (x, y) in comb.iter_mut().zip(bc) {
                if !y.is_zero() {
                    *x = x.sub(f.mul(*y));
                }
            }
        }
        match v.iter().position(|x| !x.is_zero()) {
            None => coeffs.push(comb.iter().map(|q| Q::zero().sub(*q)).collect()),
            Some(p) => {
                sel.push(k);
                comb.push(Q(1, 1));
                let mut t = vec![Q::zero(); sel.len()];
                t[sel.len() - 1] = Q(1, 1);
                coeffs.push(t);
                basis.push((p, v, comb));
            }
        }
    }
    let r = sel.len();
    let t = coeffs
        .into_iter()
        .map(|c| (0..r).map(|i| c.get(i).map_or(0.0, |q| q.f64())).collect())
        .collect();
    (sel, t)
}

/// Eigenvalues of a real n×n matrix (row-major): balancing, reduction to
/// Hessenberg form and the shifted QR iteration (EISPACK balanc, elmhes, hqr).
/// None if the iteration does not converge.
pub fn eigenvalues(n: usize, mut a: Vec<f64>) -> Option<Vec<Complex64>> {
    if n == 0 {
        return Some(Vec::new());
    }
    if a.iter().any(|v| !v.is_finite()) {
        return None;
    }
    balance(n, &mut a);
    hessenberg(n, &mut a);
    hqr(n, a)
}

fn balance(n: usize, a: &mut [f64]) {
    const RADIX: f64 = 2.0;
    let sqrdx = RADIX * RADIX;
    let mut done = false;
    while !done {
        done = true;
        for i in 0..n {
            let (mut r, mut c) = (0.0, 0.0);
            for j in 0..n {
                if j != i {
                    c += a[j * n + i].abs();
                    r += a[i * n + j].abs();
                }
            }
            if c != 0.0 && r != 0.0 {
                let mut g = r / RADIX;
                let mut f = 1.0;
                let s = c + r;
                while c < g {
                    f *= RADIX;
                    c *= sqrdx;
                }
                g = r * RADIX;
                while c > g {
                    f /= RADIX;
                    c /= sqrdx;
                }
                if (c + r) / f < 0.95 * s {
                    done = false;
                    let g = 1.0 / f;
                    for j in 0..n {
                        a[i * n + j] *= g;
                    }
                    for j in 0..n {
                        a[j * n + i] *= f;
                    }
                }
            }
        }
    }
}

/// Similarity reduction to upper Hessenberg form by stabilized elementary
/// transformations; entries below the subdiagonal are zeroed.
fn hessenberg(n: usize, a: &mut [f64]) {
    for m in 1..n.saturating_sub(1) {
        let mut x = 0.0f64;
        let mut i = m;
        for j in m..n {
            if a[j * n + m - 1].abs() > x.abs() {
                x = a[j * n + m - 1];
                i = j;
            }
        }
        if i != m {
            for j in (m - 1)..n {
                a.swap(i * n + j, m * n + j);
            }
            for j in 0..n {
                a.swap(j * n + i, j * n + m);
            }
        }
        if x != 0.0 {
            for i in (m + 1)..n {
                let mut y = a[i * n + m - 1];
                if y != 0.0 {
                    y /= x;
                    a[i * n + m - 1] = y;
                    for j in m..n {
                        a[i * n + j] -= y * a[m * n + j];
                    }
                    for j in 0..n {
                        a[j * n + m] += y * a[j * n + i];
                    }
                }
            }
        }
    }
    for i in 0..n {
        for j in 0..i.saturating_sub(1) {
            a[i * n + j] = 0.0;
        }
    }
}

/// Eigenvalues of an upper Hessenberg matrix by the Francis double-shift QR
/// iteration (Numerical Recipes hqr, here with 1-based indices into `h`).
fn hqr(n: usize, h0: Vec<f64>) -> Option<Vec<Complex64>> {
    let w1 = n + 1;
    let mut a = vec![0.0; w1 * w1];
    for i in 0..n {
        for j in 0..n {
            a[(i + 1) * w1 + j + 1] = h0[i * n + j];
        }
    }
    let ix = |i: usize, j: usize| i * w1 + j;
    let sign = |a: f64, b: f64| if b >= 0.0 { a.abs() } else { -a.abs() };
    let mut wr = vec![0.0; w1];
    let mut wi = vec![0.0; w1];
    let mut anorm = 0.0;
    for i in 1..=n {
        for j in (i.max(2) - 1)..=n {
            anorm += a[ix(i, j)].abs();
        }
    }
    let mut nn = n;
    let mut t = 0.0;
    let (mut p, mut q, mut r): (f64, f64, f64);
    let (mut x, mut y, mut z, mut w): (f64, f64, f64, f64);
    while nn >= 1 {
        let mut its = 0;
        loop {
            let mut l = nn;
            while l >= 2 {
                let mut s = a[ix(l - 1, l - 1)].abs() + a[ix(l, l)].abs();
                if s == 0.0 {
                    s = anorm;
                }
                if a[ix(l, l - 1)].abs() + s == s {
                    a[ix(l, l - 1)] = 0.0;
                    break;
                }
                l -= 1;
            }
            x = a[ix(nn, nn)];
            if l == nn {
                wr[nn] = x + t;
                wi[nn] = 0.0;
                nn -= 1;
                break;
            }
            y = a[ix(nn - 1, nn - 1)];
            w = a[ix(nn, nn - 1)] * a[ix(nn - 1, nn)];
            if l == nn - 1 {
                p = 0.5 * (y - x);
                q = p * p + w;
                z = q.abs().sqrt();
                x += t;
                if q >= 0.0 {
                    z = p + sign(z, p);
                    wr[nn - 1] = x + z;
                    wr[nn] = x + z;
                    if z != 0.0 {
                        wr[nn] = x - w / z;
                    }
                    wi[nn - 1] = 0.0;
                    wi[nn] = 0.0;
                } else {
                    wr[nn - 1] = x + p;
                    wr[nn] = x + p;
                    wi[nn - 1] = -z;
                    wi[nn] = z;
                }
                nn = nn.saturating_sub(2);
                break;
            }
            if its == 60 {
                return None;
            }
            if its == 10 || its == 20 || its == 40 {
                t += x;
                for i in 1..=nn {
                    a[ix(i, i)] -= x;
                }
                let s = a[ix(nn, nn - 1)].abs() + a[ix(nn - 1, nn - 2)].abs();
                x = 0.75 * s;
                y = x;
                w = -0.4375 * s * s;
            }
            its += 1;
            let mut m = nn - 2;
            loop {
                z = a[ix(m, m)];
                r = x - z;
                let s0 = y - z;
                p = (r * s0 - w) / a[ix(m + 1, m)] + a[ix(m, m + 1)];
                q = a[ix(m + 1, m + 1)] - z - r - s0;
                r = a[ix(m + 2, m + 1)];
                let s = p.abs() + q.abs() + r.abs();
                p /= s;
                q /= s;
                r /= s;
                if m == l {
                    break;
                }
                let u = a[ix(m, m - 1)].abs() * (q.abs() + r.abs());
                let v = p.abs() * (a[ix(m - 1, m - 1)].abs() + z.abs() + a[ix(m + 1, m + 1)].abs());
                if u + v == v {
                    break;
                }
                m -= 1;
            }
            for i in (m + 2)..=nn {
                a[ix(i, i - 2)] = 0.0;
                if i != m + 2 {
                    a[ix(i, i - 3)] = 0.0;
                }
            }
            let mut k = m;
            while k < nn {
                if k != m {
                    p = a[ix(k, k - 1)];
                    q = a[ix(k + 1, k - 1)];
                    r = 0.0;
                    if k != nn - 1 {
                        r = a[ix(k + 2, k - 1)];
                    }
                    x = p.abs() + q.abs() + r.abs();
                    if x != 0.0 {
                        p /= x;
                        q /= x;
                        r /= x;
                    }
                }
                let s = sign((p * p + q * q + r * r).sqrt(), p);
                if s != 0.0 {
                    if k == m {
                        if l != m {
                            a[ix(k, k - 1)] = -a[ix(k, k - 1)];
                        }
                    } else {
                        a[ix(k, k - 1)] = -s * x;
                    }
                    p += s;
                    x = p / s;
                    y = q / s;
                    z = r / s;
                    q /= p;
                    r /= p;
                    for j in k..=nn {
                        p = a[ix(k, j)] + q * a[ix(k + 1, j)];
                        if k != nn - 1 {
                            p += r * a[ix(k + 2, j)];
                            a[ix(k + 2, j)] -= p * z;
                        }
                        a[ix(k + 1, j)] -= p * y;
                        a[ix(k, j)] -= p * x;
                    }
                    let mmin = if nn < k + 3 { nn } else { k + 3 };
                    for i in l..=mmin {
                        p = x * a[ix(i, k)] + y * a[ix(i, k + 1)];
                        if k != nn - 1 {
                            p += z * a[ix(i, k + 2)];
                            a[ix(i, k + 2)] -= p * r;
                        }
                        a[ix(i, k + 1)] -= p * q;
                        a[ix(i, k)] -= p;
                    }
                }
                k += 1;
            }
            if l >= nn - 1 {
                break;
            }
        }
    }
    Some((1..=n).map(|i| Complex64::new(wr[i], wi[i])).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(mut v: Vec<Complex64>) -> Vec<Complex64> {
        v.sort_by(|a, b| a.re.total_cmp(&b.re).then(a.im.total_cmp(&b.im)));
        v
    }

    #[test]
    fn eigenvalues_real_and_complex() {
        // Companion of (x − 1)(x − 2)(x² + 2x + 5): roots 1, 2, −1 ± 2j.
        // x⁴ − x² ... expand: (x² − 3x + 2)(x² + 2x + 5) = x⁴ − x³ + x² − 11x + 10.
        let c = [10.0, -11.0, 1.0, -1.0];
        let n = 4;
        let mut a = vec![0.0; n * n];
        for i in 1..n {
            a[i * n + i - 1] = 1.0;
        }
        for i in 0..n {
            a[i * n + n - 1] = -c[i];
        }
        let e = sorted(eigenvalues(n, a).unwrap());
        let want = [
            Complex64::new(-1.0, -2.0),
            Complex64::new(-1.0, 2.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(2.0, 0.0),
        ];
        for (g, w) in e.iter().zip(want) {
            assert!((g - w).norm() < 1e-12, "{e:?}");
        }
    }

    #[test]
    fn eigenvalues_widely_spread() {
        // Upper triangular with a nonnormal coupling: eigenvalues are the
        // diagonal, nine decades apart.
        let n = 3;
        let a = vec![1e-3, 5.0, 0.0, 0.0, 1.0, 7.0, 0.0, 0.0, 1e6];
        let e = sorted(eigenvalues(n, a).unwrap());
        for (g, w) in e.iter().zip([1e-3, 1.0, 1e6]) {
            assert!((g.re - w).abs() <= 1e-12 * w && g.im == 0.0, "{e:?}");
        }
    }

    #[test]
    fn reduce_finds_dependent_columns() {
        // Three capacitors in a loop a–b–c: u3 = −(u1 + u2).
        let cols = [vec![(0, 1), (1, -1)], vec![(1, 1), (2, -1)], vec![(2, 1), (0, -1)]];
        let (sel, t) = reduce(3, cols.iter());
        assert_eq!(sel, vec![0, 1]);
        assert_eq!(t[2], vec![-1.0, -1.0]);
    }
}
