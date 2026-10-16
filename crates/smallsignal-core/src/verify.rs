//! Exact self-check of a symbolic solution: with every unknown's Cramer
//! numerator N_j and the determinant D, the identity A·N = b·D must hold as
//! polynomials. It is tested at random points modulo the prime 2⁶¹−1
//! (Schwartz–Zippel: a wrong solution passes a trial with probability at
//! most deg/p, about 10⁻¹⁷ here).

use crate::poly::Poly;
use crate::ss::System;

const P: u128 = (1u128 << 61) - 1;

fn mulm(a: u128, b: u128) -> u128 {
    a * b % P
}

fn coeff_mod(c: i128) -> u128 {
    c.rem_euclid(P as i128) as u128
}

fn eval_mod(p: &Poly, vals: &[u128], s: u128, reactive: u128) -> u128 {
    let mut acc = 0u128;
    for (&m, &c) in &p.terms {
        let mut v = coeff_mod(c);
        let mut bits = m;
        while bits != 0 {
            let i = bits.trailing_zeros() as usize;
            v = mulm(v, vals[i]);
            bits &= bits - 1;
        }
        for _ in 0..(m & reactive).count_ones() {
            v = mulm(v, s);
        }
        acc = (acc + v) % P;
    }
    acc
}

pub struct Report {
    pub ok: bool,
    pub trials: usize,
}

pub fn kcl(sys: &System, nparams: usize, reactive: u128, max_terms: usize) -> Result<Report, String> {
    let d = crate::det::det(&sys.a, max_terms)?;
    let nums: Vec<Poly> = (0..sys.dim)
        .map(|j| sys.cramer(j, max_terms))
        .collect::<Result<_, _>>()?;
    let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed as u128) % (P - 2) + 2
    };
    let trials = 3;
    for _ in 0..trials {
        let vals: Vec<u128> = (0..nparams).map(|_| rnd()).collect();
        let s = rnd();
        let dv = eval_mod(&d, &vals, s, reactive);
        let nv: Vec<u128> = nums.iter().map(|n| eval_mod(n, &vals, s, reactive)).collect();
        for r in 0..sys.dim {
            let mut lhs = 0u128;
            for (j, n) in nv.iter().enumerate() {
                if !sys.a[r][j].is_zero() {
                    lhs = (lhs + mulm(eval_mod(&sys.a[r][j], &vals, s, reactive), *n)) % P;
                }
            }
            if lhs != mulm(coeff_mod(sys.b[r]), dv) {
                return Ok(Report { ok: false, trials });
            }
        }
    }
    Ok(Report { ok: true, trials })
}
