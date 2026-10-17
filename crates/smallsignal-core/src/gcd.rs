//! Exact multivariate polynomial GCD over the integers, to cancel common
//! factors of a numerator and denominator. Matching creates them: a matched
//! diff pair's gain is −g_m r_o R_D (1 + (g_m + g_mb) r_o) / ((r_o + R_D)
//! (1 + (g_m + g_mb) r_o)) until the shared factor cancels.
//!
//! Recursive: content in one variable at a time, then a primitive
//! pseudo-remainder sequence. Every step is exact; a work budget (and i128
//! overflow) ends the attempt, in which case nothing is cancelled.

use std::collections::BTreeMap;

pub type MPoly = BTreeMap<Vec<u8>, i128>;

/// Term products allowed per cancellation attempt.
const BUDGET: u64 = 2_000_000;

struct Work(u64);

type R<T> = Result<T, ()>;

impl Work {
    fn spend(&mut self, n: usize) -> R<()> {
        self.0 = self.0.saturating_add(n as u64);
        if self.0 > BUDGET {
            Err(())
        } else {
            Ok(())
        }
    }
}

fn int_gcd(a: i128, b: i128) -> i128 {
    let (mut a, mut b) = (a.unsigned_abs(), b.unsigned_abs());
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a as i128
}

fn add_into(p: &mut MPoly, e: Vec<u8>, c: i128) -> R<()> {
    let v = p.entry(e.clone()).or_insert(0);
    *v = v.checked_add(c).ok_or(())?;
    if *v == 0 {
        p.remove(&e);
    }
    Ok(())
}

fn mul(a: &MPoly, b: &MPoly, w: &mut Work) -> R<MPoly> {
    w.spend(a.len() * b.len())?;
    let mut out = MPoly::new();
    for (ea, ca) in a {
        for (eb, cb) in b {
            let e: Vec<u8> = ea
                .iter()
                .zip(eb)
                .map(|(x, y)| x.checked_add(*y).ok_or(()))
                .collect::<R<_>>()?;
            add_into(&mut out, e, ca.checked_mul(*cb).ok_or(())?)?;
        }
    }
    Ok(out)
}

fn sub(a: &MPoly, b: &MPoly) -> R<MPoly> {
    let mut out = a.clone();
    for (e, c) in b {
        add_into(&mut out, e.clone(), -c)?;
    }
    Ok(out)
}

fn constant(c: i128, n: usize) -> MPoly {
    let mut p = MPoly::new();
    if c != 0 {
        p.insert(vec![0; n], c);
    }
    p
}

fn is_constant(p: &MPoly) -> bool {
    p.keys().all(|e| e.iter().all(|&x| x == 0))
}

fn deg(p: &MPoly, x: usize) -> u8 {
    p.keys().map(|e| e[x]).max().unwrap_or(0)
}

/// Coefficients of p as a polynomial in x (each with x's exponent zeroed).
fn coeffs(p: &MPoly, x: usize) -> Vec<MPoly> {
    let mut cs = vec![MPoly::new(); deg(p, x) as usize + 1];
    for (e, &c) in p {
        let mut e2 = e.clone();
        let k = e2[x] as usize;
        e2[x] = 0;
        cs[k].insert(e2, c);
    }
    cs
}

/// Exact quotient p / f, or None when f does not divide p.
pub fn div_exact(p: &MPoly, f: &MPoly) -> Option<MPoly> {
    let mut w = Work(0);
    div_w(p, f, &mut w).ok().flatten()
}

fn div_w(p: &MPoly, f: &MPoly, w: &mut Work) -> R<Option<MPoly>> {
    let (fe, fc) = match f.iter().next_back() {
        Some((e, c)) => (e.clone(), *c),
        None => return Ok(None),
    };
    let mut r = p.clone();
    let mut q = MPoly::new();
    while let Some((re, rc)) = r.iter().next_back().map(|(e, c)| (e.clone(), *c)) {
        if rc % fc != 0 || re.iter().zip(&fe).any(|(a, b)| a < b) {
            return Ok(None);
        }
        let te: Vec<u8> = re.iter().zip(&fe).map(|(a, b)| a - b).collect();
        let tc = rc / fc;
        w.spend(f.len())?;
        for (e, c) in f {
            let e2: Vec<u8> = e.iter().zip(&te).map(|(a, b)| a + b).collect();
            add_into(&mut r, e2, -(c.checked_mul(tc).ok_or(())?))?;
        }
        add_into(&mut q, te, tc)?;
    }
    Ok(Some(q))
}

fn integer_content(p: &MPoly) -> i128 {
    p.values().fold(0, |g, &c| int_gcd(g, c))
}

/// Primitive (integer content 1), leading coefficient positive.
fn normalize(p: MPoly) -> MPoly {
    let g = integer_content(&p);
    if g <= 1 && p.iter().next_back().is_none_or(|(_, &c)| c > 0) {
        return p;
    }
    let sign = if p.iter().next_back().is_some_and(|(_, &c)| c < 0) {
        -1
    } else {
        1
    };
    p.into_iter().map(|(e, c)| (e, c / g * sign)).collect()
}

/// gcd of the coefficients of p in x: a polynomial free of x.
fn content(p: &MPoly, x: usize, w: &mut Work) -> R<MPoly> {
    let mut g = MPoly::new();
    for c in coeffs(p, x) {
        if c.is_empty() {
            continue;
        }
        g = gcd_w(&g, &c, w)?;
        if is_constant(&g) {
            break;
        }
    }
    Ok(g)
}

/// a·lc(b)^k mod b in x, with b's leading coefficient multiplied in rather
/// than divided out (the sparse pseudo-remainder).
fn prem(a: &MPoly, b: &MPoly, x: usize, w: &mut Work) -> R<MPoly> {
    let db = deg(b, x);
    let lb = coeffs(b, x).pop().unwrap();
    let mut r = a.clone();
    while !r.is_empty() && deg(&r, x) >= db {
        let dr = deg(&r, x);
        let lr = coeffs(&r, x).pop().unwrap();
        let mut shift = lr;
        shift = shift
            .into_iter()
            .map(|(mut e, c)| {
                e[x] += dr - db;
                (e, c)
            })
            .collect();
        r = sub(&mul(&lb, &r, w)?, &mul(&shift, b, w)?)?;
    }
    Ok(r)
}

fn gcd_w(a: &MPoly, b: &MPoly, w: &mut Work) -> R<MPoly> {
    if a.is_empty() {
        return Ok(normalize(b.clone()));
    }
    if b.is_empty() {
        return Ok(normalize(a.clone()));
    }
    let n = a.keys().next().unwrap().len();
    if is_constant(a) || is_constant(b) {
        return Ok(constant(1, n));
    }
    let used = |p: &MPoly| -> Vec<bool> { (0..n).map(|x| p.keys().any(|e| e[x] > 0)).collect() };
    let (ua, ub) = (used(a), used(b));
    // A variable in only one of them can only be in that one's content.
    if let Some(x) = (0..n).find(|&x| ua[x] != ub[x]) {
        return if ua[x] {
            gcd_w(&content(a, x, w)?, b, w)
        } else {
            gcd_w(a, &content(b, x, w)?, w)
        };
    }
    let x = (0..n)
        .filter(|&x| ua[x])
        .min_by_key(|&x| deg(a, x).max(deg(b, x)))
        .unwrap();
    let (ca, cb) = (content(a, x, w)?, content(b, x, w)?);
    let pa = div_w(a, &ca, w)?.ok_or(())?;
    let pb = div_w(b, &cb, w)?.ok_or(())?;
    let c = gcd_w(&ca, &cb, w)?;
    let (mut f, mut g) = if deg(&pa, x) >= deg(&pb, x) { (pa, pb) } else { (pb, pa) };
    loop {
        let r = prem(&f, &g, x, w)?;
        if r.is_empty() {
            break;
        }
        if deg(&r, x) == 0 {
            g = constant(1, n);
            break;
        }
        let cr = content(&r, x, w)?;
        f = g;
        g = div_w(&r, &cr, w)?.ok_or(())?;
    }
    let pg = if is_constant(&g) {
        g
    } else {
        div_w(&g, &content(&g, x, w)?, w)?.ok_or(())?
    };
    Ok(normalize(mul(&c, &pg, w)?))
}

/// The greatest common divisor of a and b (primitive, positive leading
/// coefficient), or None if the work budget ran out.
pub fn gcd(a: &MPoly, b: &MPoly) -> Option<MPoly> {
    let mut w = Work(0);
    gcd_w(a, b, &mut w).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(terms: &[(&[u8], i128)]) -> MPoly {
        terms.iter().map(|(e, c)| (e.to_vec(), *c)).collect()
    }

    #[test]
    fn cancels_a_shared_binomial() {
        // x = [gm, gmb, ro, rd]; a = (ro + rd)(1 + gm ro + gmb ro), b = gm ro rd (1 + gm ro + gmb ro).
        let f = p(&[(&[0, 0, 0, 0], 1), (&[1, 0, 1, 0], 1), (&[0, 1, 1, 0], 1)]);
        let u = p(&[(&[0, 0, 1, 0], 1), (&[0, 0, 0, 1], 1)]);
        let v = p(&[(&[1, 0, 1, 1], -1)]);
        let mut w = Work(0);
        let a = mul(&u, &f, &mut w).unwrap();
        let b = mul(&v, &f, &mut w).unwrap();
        let g = gcd(&a, &b).unwrap();
        assert_eq!(g, f);
        assert_eq!(div_exact(&a, &g).unwrap(), u);
        assert_eq!(div_exact(&b, &g).unwrap(), v);
    }

    #[test]
    fn coprime_and_integer_cases() {
        let a = p(&[(&[1, 0], 1), (&[0, 1], 1)]);
        let b = p(&[(&[1, 0], 1), (&[0, 0], 1)]);
        assert_eq!(gcd(&a, &b).unwrap(), constant(1, 2));
        let a2 = p(&[(&[2, 0], 1), (&[0, 2], -1)]); // x² − y² = (x − y)(x + y)
        let g = gcd(&a2, &a).unwrap();
        assert_eq!(g, a);
        assert!(div_exact(&a2, &p(&[(&[1, 0], 1), (&[0, 0], 1)])).is_none());
    }
}
