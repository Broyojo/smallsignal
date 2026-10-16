//! Sparse multilinear polynomials over the small-signal parameters.
//!
//! Every MNA entry is a sum of rank-one stamps `p · u vᵀ`, one parameter per
//! circuit element, so every minor of the matrix is affine in each parameter.
//! A monomial is therefore a set of parameters (a `u128` bitset); the Laplace
//! variable `s` is implicit, since it only ever multiplies a capacitance or an
//! inductance (its power is the number of reactive parameters present).
//! Products whose factors share a parameter are dropped: such terms cancel
//! exactly in any minor, so dropping them changes nothing.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

pub type Mono = u128;

#[derive(Default)]
pub struct MonoHasher(u64);

impl Hasher for MonoHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0 ^ b as u64).wrapping_mul(0x100000001b3);
        }
    }
    fn write_u128(&mut self, v: u128) {
        let x = (v as u64) ^ ((v >> 64) as u64).rotate_left(29);
        self.0 = (x ^ (x >> 31)).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    }
    fn write_u64(&mut self, v: u64) {
        self.0 = (v ^ (v >> 31)).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    }
}

pub type MonoMap<V> = HashMap<Mono, V, BuildHasherDefault<MonoHasher>>;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Poly {
    pub terms: MonoMap<i128>,
}

#[derive(Debug)]
pub struct Overflow;

impl Poly {
    pub fn zero() -> Self {
        Poly::default()
    }

    pub fn constant(c: i128) -> Self {
        let mut p = Poly::zero();
        p.add_term(0, c);
        p
    }

    pub fn one() -> Self {
        Poly::constant(1)
    }

    pub fn is_zero(&self) -> bool {
        self.terms.is_empty()
    }

    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }

    pub fn len(&self) -> usize {
        self.terms.len()
    }

    pub fn add_term(&mut self, m: Mono, c: i128) {
        if c == 0 {
            return;
        }
        let e = self.terms.entry(m).or_insert(0);
        *e += c;
        if *e == 0 {
            self.terms.remove(&m);
        }
    }

    pub fn add_scaled(&mut self, other: &Poly, sign: i128) {
        for (&m, &c) in &other.terms {
            self.add_term(m, sign * c);
        }
    }

    pub fn neg(&self) -> Poly {
        let mut p = self.clone();
        for c in p.terms.values_mut() {
            *c = -*c;
        }
        p
    }

    /// `self += sign · a · b`, dropping products that repeat a parameter.
    /// Zero coefficients may remain; call `prune` once accumulation ends.
    pub fn mul_acc(&mut self, a: &Poly, b: &Poly, sign: i128) -> Result<(), Overflow> {
        for (&ma, &ca) in &a.terms {
            let ca = ca * sign;
            for (&mb, &cb) in &b.terms {
                if ma & mb != 0 {
                    continue;
                }
                let prod = ca.checked_mul(cb).ok_or(Overflow)?;
                let e = self.terms.entry(ma | mb).or_insert(0);
                *e = e.checked_add(prod).ok_or(Overflow)?;
            }
        }
        Ok(())
    }

    pub fn prune(&mut self) {
        self.terms.retain(|_, c| *c != 0);
    }

    /// Mask of all parameters appearing in any term.
    pub fn support(&self) -> Mono {
        self.terms.keys().fold(0, |acc, &m| acc | m)
    }
}

pub fn sub(a: &Poly, b: &Poly) -> Poly {
    let mut p = a.clone();
    p.add_scaled(b, -1);
    p
}
