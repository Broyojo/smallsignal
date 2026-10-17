//! Exact multivariate polynomial GCD over the integers, to cancel common
//! factors of a numerator and denominator. Matching creates them: a matched
//! diff pair's gain is −g_m r_o R_D (1 + (g_m + g_mb) r_o) / ((r_o + R_D)
//! (1 + (g_m + g_mb) r_o)) until the shared factor cancels.
//!
//! Recursive: content in one variable at a time, then a primitive
//! pseudo-remainder sequence. Every step is exact; a work budget (and i128
//! overflow) ends the attempt, in which case nothing is cancelled.
//!
//! Internally a polynomial is a vector of terms sorted by exponent vector
//! (the order of `MPoly`'s keys), and an exponent vector is a fixed-size
//! array when the variables fit, so the arithmetic does not allocate per
//! term. For nonzero coefficients (as `XPoly` keeps them) the result, the
//! work charged and every overflow check are those of the plain `MPoly`
//! arithmetic, term for term. `mul_terms` is `XPoly::mul` done the same way.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};
use std::hash::{BuildHasherDefault, Hash, Hasher};

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

/// An exponent vector of `n` variables, ordered as the `Vec<u8>` of them.
trait Exp: Clone + Ord + Hash {
    fn from_slice(e: &[u8]) -> Self;
    fn to_vec(&self, n: usize) -> Vec<u8>;
    fn zero(n: usize) -> Self;
    fn get(&self, x: usize) -> u8;
    fn set(&mut self, x: usize, v: u8);
    /// Exponent-wise sum, None if any exponent overflows.
    fn checked_add(&self, o: &Self) -> Option<Self>;
    /// Exponent-wise sum, wrapping.
    fn wrapping_add(&self, o: &Self) -> Self;
    /// Some exponent of self is below o's.
    fn any_below(&self, o: &Self) -> bool;
    /// Exponent-wise difference; every exponent of o is at most self's.
    fn minus(&self, o: &Self) -> Self;
    /// Exponent-wise bitwise or: nonzero where either is.
    fn or(&self, o: &Self) -> Self;
    fn is_zero(&self) -> bool;
}

/// Up to `ARR` variables, zero-padded.
#[derive(Clone, Copy)]
struct Arr([u8; ARR]);

impl Arr {
    fn words(&self) -> impl Iterator<Item = u64> + '_ {
        self.0.as_chunks::<8>().0.iter().map(|&c| u64::from_be_bytes(c))
    }
}

impl PartialEq for Arr {
    fn eq(&self, o: &Self) -> bool {
        self.words().zip(o.words()).all(|(a, b)| a == b)
    }
}

impl Eq for Arr {}

impl Ord for Arr {
    fn cmp(&self, o: &Self) -> Ordering {
        // Big-endian words compare as their bytes do, lexicographically.
        for (a, b) in self.words().zip(o.words()) {
            if a != b {
                return a.cmp(&b);
            }
        }
        Ordering::Equal
    }
}

impl PartialOrd for Arr {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

impl Hash for Arr {
    fn hash<H: Hasher>(&self, h: &mut H) {
        for w in self.words() {
            h.write_u64(w);
        }
    }
}

impl Exp for Arr {
    fn from_slice(e: &[u8]) -> Self {
        let mut a = [0; ARR];
        a[..e.len()].copy_from_slice(e);
        Arr(a)
    }
    fn to_vec(&self, n: usize) -> Vec<u8> {
        self.0[..n].to_vec()
    }
    fn zero(_: usize) -> Self {
        Arr([0; ARR])
    }
    fn get(&self, x: usize) -> u8 {
        self.0[x]
    }
    fn set(&mut self, x: usize, v: u8) {
        self.0[x] = v;
    }
    fn checked_add(&self, o: &Self) -> Option<Self> {
        let mut r = [0; ARR];
        let mut over = false;
        for i in 0..ARR {
            let (s, c) = self.0[i].overflowing_add(o.0[i]);
            r[i] = s;
            over |= c;
        }
        (!over).then_some(Arr(r))
    }
    fn wrapping_add(&self, o: &Self) -> Self {
        Arr(std::array::from_fn(|i| self.0[i].wrapping_add(o.0[i])))
    }
    fn any_below(&self, o: &Self) -> bool {
        let mut below = false;
        for i in 0..ARR {
            below |= self.0[i] < o.0[i];
        }
        below
    }
    fn minus(&self, o: &Self) -> Self {
        Arr(std::array::from_fn(|i| self.0[i] - o.0[i]))
    }
    fn or(&self, o: &Self) -> Self {
        Arr(std::array::from_fn(|i| self.0[i] | o.0[i]))
    }
    fn is_zero(&self) -> bool {
        self.words().all(|w| w == 0)
    }
}

/// Any number of variables.
impl Exp for Vec<u8> {
    fn from_slice(e: &[u8]) -> Self {
        e.to_vec()
    }
    fn to_vec(&self, _: usize) -> Vec<u8> {
        self.clone()
    }
    fn zero(n: usize) -> Self {
        vec![0; n]
    }
    fn get(&self, x: usize) -> u8 {
        self[x]
    }
    fn set(&mut self, x: usize, v: u8) {
        self[x] = v;
    }
    fn checked_add(&self, o: &Self) -> Option<Self> {
        self.iter().zip(o).map(|(a, b)| a.checked_add(*b)).collect()
    }
    fn wrapping_add(&self, o: &Self) -> Self {
        self.iter().zip(o).map(|(a, b)| a.wrapping_add(*b)).collect()
    }
    fn any_below(&self, o: &Self) -> bool {
        self.iter().zip(o).any(|(a, b)| a < b)
    }
    fn minus(&self, o: &Self) -> Self {
        self.iter().zip(o).map(|(a, b)| a - b).collect()
    }
    fn or(&self, o: &Self) -> Self {
        self.iter().zip(o).map(|(a, b)| a | b).collect()
    }
    fn is_zero(&self) -> bool {
        self.iter().all(|&x| x == 0)
    }
}

/// FxHash: the term maps are keyed by short exponent vectors.
#[derive(Default)]
struct Fx(u64);

impl Hasher for Fx {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write_u64(&mut self, w: u64) {
        self.0 = (self.0.rotate_left(5) ^ w).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
    fn write(&mut self, bytes: &[u8]) {
        let (words, rest) = bytes.as_chunks::<8>();
        for &w in words {
            self.write_u64(u64::from_le_bytes(w));
        }
        let mut last = [0u8; 8];
        last[..rest.len()].copy_from_slice(rest);
        self.write_u64(u64::from_le_bytes(last));
    }
}

/// Terms sorted by exponent vector, no zero coefficients.
type P<E> = Vec<(E, i128)>;

/// The number of variables, and the work spent.
struct Ctx {
    n: usize,
    w: Work,
}

fn int_gcd(a: i128, b: i128) -> i128 {
    let (mut a, mut b) = (a.unsigned_abs(), b.unsigned_abs());
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a as i128
}

fn add_into<E: Exp>(p: &mut BTreeMap<E, i128>, e: E, c: i128) -> R<()> {
    let v = p.entry(e.clone()).or_insert(0);
    *v = v.checked_add(c).ok_or(())?;
    if *v == 0 {
        p.remove(&e);
    }
    Ok(())
}

/// a·b. Each output coefficient is summed in a's term order, as a map
/// filled by the double loop would, so the same partial sums are checked.
fn pmul<E: Exp>(a: &P<E>, b: &P<E>, w: &mut Work) -> R<P<E>> {
    w.spend(a.len() * b.len())?;
    product(a, b)
}

/// a·b with its work already charged.
fn product<E: Exp>(a: &P<E>, b: &P<E>) -> R<P<E>> {
    // A monomial times a polynomial: no two products share an exponent and
    // their order is the polynomial's.
    if a.len() == 1 || b.len() == 1 {
        let mut out = Vec::with_capacity(a.len() * b.len());
        for (ea, ca) in a {
            for (eb, cb) in b {
                let e = ea.checked_add(eb).ok_or(())?;
                out.push((e, ca.checked_mul(*cb).ok_or(())?));
            }
        }
        return Ok(out);
    }
    let mut acc: HashMap<E, i128, BuildHasherDefault<Fx>> =
        HashMap::with_capacity_and_hasher((a.len() * b.len()).min(1 << 16), Default::default());
    for (ea, ca) in a {
        for (eb, cb) in b {
            let e = ea.checked_add(eb).ok_or(())?;
            let c = ca.checked_mul(*cb).ok_or(())?;
            let v = acc.entry(e).or_insert(0);
            *v = v.checked_add(c).ok_or(())?;
        }
    }
    let mut out: P<E> = acc.into_iter().filter(|(_, c)| *c != 0).collect();
    out.sort_unstable_by(|x, y| x.0.cmp(&y.0));
    Ok(out)
}

/// a − b, merging the sorted terms.
fn psub<E: Exp>(a: &P<E>, b: &P<E>) -> R<P<E>> {
    let mut out = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        let ord = match (a.get(i), b.get(j)) {
            (Some(x), Some(y)) => x.0.cmp(&y.0),
            (Some(_), None) => Ordering::Less,
            _ => Ordering::Greater,
        };
        match ord {
            Ordering::Less => {
                out.push(a[i].clone());
                i += 1;
            }
            Ordering::Greater => {
                out.push((b[j].0.clone(), -b[j].1));
                j += 1;
            }
            Ordering::Equal => {
                let v = a[i].1.checked_add(-b[j].1).ok_or(())?;
                if v != 0 {
                    out.push((a[i].0.clone(), v));
                }
                i += 1;
                j += 1;
            }
        }
    }
    Ok(out)
}

fn unit<E: Exp>(n: usize) -> P<E> {
    vec![(E::zero(n), 1)]
}

fn is_const<E: Exp>(p: &P<E>) -> bool {
    p.iter().all(|(e, _)| e.is_zero())
}

fn deg<E: Exp>(p: &P<E>, x: usize) -> u8 {
    p.iter().map(|(e, _)| e.get(x)).max().unwrap_or(0)
}

/// Coefficients of p as a polynomial in x (each with x's exponent zeroed).
fn coeffs<E: Exp>(p: &P<E>, x: usize) -> Vec<P<E>> {
    let mut cs = vec![Vec::new(); deg(p, x) as usize + 1];
    for (e, c) in p {
        let mut e2 = e.clone();
        let k = e2.get(x) as usize;
        e2.set(x, 0);
        cs[k].push((e2, *c));
    }
    cs
}

/// The terms of p of degree d in x, with x's exponent set to `to`.
fn coeff_at<E: Exp>(p: &P<E>, x: usize, d: u8, to: u8) -> P<E> {
    p.iter()
        .filter(|(e, _)| e.get(x) == d)
        .map(|(e, c)| {
            let mut e2 = e.clone();
            e2.set(x, to);
            (e2, *c)
        })
        .collect()
}

fn div_w<E: Exp>(p: &P<E>, f: &P<E>, w: &mut Work) -> R<Option<P<E>>> {
    let (fe, fc) = match f.last() {
        Some((e, c)) => (e.clone(), *c),
        None => return Ok(None),
    };
    let mut r: BTreeMap<E, i128> = p.iter().cloned().collect();
    let mut q = BTreeMap::new();
    while let Some((re, rc)) = r.last_key_value().map(|(e, c)| (e.clone(), *c)) {
        if rc % fc != 0 || re.any_below(&fe) {
            return Ok(None);
        }
        let te = re.minus(&fe);
        let tc = rc / fc;
        w.spend(f.len())?;
        for (e, c) in f {
            add_into(&mut r, e.wrapping_add(&te), -(c.checked_mul(tc).ok_or(())?))?;
        }
        add_into(&mut q, te, tc)?;
    }
    Ok(Some(q.into_iter().collect()))
}

fn integer_content<E: Exp>(p: &P<E>) -> i128 {
    p.iter().fold(0, |g, &(_, c)| int_gcd(g, c))
}

/// Primitive (integer content 1), leading coefficient positive.
fn normalize<E: Exp>(p: P<E>) -> P<E> {
    let g = integer_content(&p);
    if g <= 1 && p.last().is_none_or(|&(_, c)| c > 0) {
        return p;
    }
    let sign = if p.last().is_some_and(|&(_, c)| c < 0) { -1 } else { 1 };
    p.into_iter().map(|(e, c)| (e, c / g * sign)).collect()
}

/// gcd of the coefficients of p in x: a polynomial free of x.
fn content<E: Exp>(p: &P<E>, x: usize, cx: &mut Ctx) -> R<P<E>> {
    let mut g = Vec::new();
    for c in coeffs(p, x) {
        if c.is_empty() {
            continue;
        }
        g = gcd_w(&g, &c, cx)?;
        if is_const(&g) {
            break;
        }
    }
    Ok(g)
}

/// a·lc(b)^k mod b in x, with b's leading coefficient multiplied in rather
/// than divided out (the sparse pseudo-remainder).
fn prem<E: Exp>(a: &P<E>, b: &P<E>, x: usize, w: &mut Work) -> R<P<E>> {
    let db = deg(b, x);
    let lb = coeff_at(b, x, db, 0);
    let mut r = a.clone();
    while !r.is_empty() && deg(&r, x) >= db {
        let dr = deg(&r, x);
        let shift = coeff_at(&r, x, dr, dr - db);
        // Both products charged first: when the second exhausts the budget,
        // the attempt fails either way, without forming the first.
        w.spend((lb.len() * r.len()).saturating_add(shift.len() * b.len()))?;
        r = psub(&product(&lb, &r)?, &product(&shift, b)?)?;
    }
    Ok(r)
}

fn gcd_w<E: Exp>(a: &P<E>, b: &P<E>, cx: &mut Ctx) -> R<P<E>> {
    if a.is_empty() {
        return Ok(normalize(b.clone()));
    }
    if b.is_empty() {
        return Ok(normalize(a.clone()));
    }
    let n = cx.n;
    if is_const(a) || is_const(b) {
        return Ok(unit(n));
    }
    let used = |p: &P<E>| -> Vec<bool> {
        let u = p.iter().fold(E::zero(n), |u, (e, _)| u.or(e));
        (0..n).map(|x| u.get(x) > 0).collect()
    };
    let (ua, ub) = (used(a), used(b));
    // A variable in only one of them can only be in that one's content.
    if let Some(x) = (0..n).find(|&x| ua[x] != ub[x]) {
        return if ua[x] {
            gcd_w(&content(a, x, cx)?, b, cx)
        } else {
            gcd_w(a, &content(b, x, cx)?, cx)
        };
    }
    let x = (0..n)
        .filter(|&x| ua[x])
        .min_by_key(|&x| deg(a, x).max(deg(b, x)))
        .unwrap();
    let (ca, cb) = (content(a, x, cx)?, content(b, x, cx)?);
    let pa = div_w(a, &ca, &mut cx.w)?.ok_or(())?;
    let pb = div_w(b, &cb, &mut cx.w)?.ok_or(())?;
    let c = gcd_w(&ca, &cb, cx)?;
    let (mut f, mut g) = if deg(&pa, x) >= deg(&pb, x) { (pa, pb) } else { (pb, pa) };
    loop {
        let r = prem(&f, &g, x, &mut cx.w)?;
        if r.is_empty() {
            break;
        }
        if deg(&r, x) == 0 {
            g = unit(n);
            break;
        }
        let cr = content(&r, x, cx)?;
        f = g;
        g = div_w(&r, &cr, &mut cx.w)?.ok_or(())?;
    }
    let pg = if is_const(&g) {
        g
    } else {
        div_w(&g, &content(&g, x, cx)?, &mut cx.w)?.ok_or(())?
    };
    Ok(normalize(pmul(&c, &pg, &mut cx.w)?))
}

fn to_p<E: Exp>(p: &MPoly) -> P<E> {
    p.iter().map(|(e, &c)| (E::from_slice(e), c)).collect()
}

fn to_m<E: Exp>(p: P<E>, n: usize) -> MPoly {
    p.into_iter().map(|(e, c)| (e.to_vec(n), c)).collect()
}

/// The number of variables, and whether every exponent vector has that many.
fn width<'a>(mut keys: impl Iterator<Item = &'a Vec<u8>> + Clone) -> (usize, bool) {
    let n = keys.clone().next().map_or(0, |e| e.len());
    (n, keys.all(|e| e.len() == n))
}

/// Exponent vectors of up to this many variables are fixed-size arrays (one
/// size: each one compiles the arithmetic again, about 70 kB of WebAssembly).
const ARR: usize = 64;

/// Calls `$go::<E>(args.., n)` with the exponent type for n variables, where
/// `$w` = (n, every exponent vector has n).
macro_rules! dispatch {
    ($w:expr, $go:ident($($arg:expr),*)) => {{
        let (n, same) = $w;
        if same && n <= ARR {
            $go::<Arr>($($arg,)* n)
        } else {
            $go::<Vec<u8>>($($arg,)* n)
        }
    }};
}

/// Exact quotient p / f, or None when f does not divide p.
pub fn div_exact(p: &MPoly, f: &MPoly) -> Option<MPoly> {
    fn go<E: Exp>(p: &MPoly, f: &MPoly, n: usize) -> Option<MPoly> {
        let mut w = Work(0);
        let q = div_w(&to_p::<E>(p), &to_p::<E>(f), &mut w).ok().flatten()?;
        Some(to_m(q, n))
    }
    dispatch!(width(p.keys().chain(f.keys())), go(p, f))
}

/// The greatest common divisor of a and b (primitive, positive leading
/// coefficient), or None if the work budget ran out.
pub fn gcd(a: &MPoly, b: &MPoly) -> Option<MPoly> {
    fn go<E: Exp>(a: &MPoly, b: &MPoly, n: usize) -> Option<MPoly> {
        let mut cx = Ctx { n, w: Work(0) };
        let g = gcd_w(&to_p::<E>(a), &to_p::<E>(b), &mut cx).ok()?;
        Some(to_m(g, n))
    }
    dispatch!(width(a.keys().chain(b.keys())), go(a, b))
}

/// A term list as `XPoly` keeps it: sorted by exponent vector, distinct.
pub type Terms = Vec<(Vec<u8>, i128)>;

/// `XPoly::mul` on term lists: the same product, or the same error at the
/// same point (exponent or coefficient overflow in the term loop, or more
/// than `max_terms` exponents after one of a's terms).
pub fn mul_terms(a: &Terms, b: &Terms, max_terms: usize) -> Result<Terms, String> {
    fn go<E: Exp>(a: &Terms, b: &Terms, max_terms: usize, n: usize) -> Result<Terms, String> {
        let (a, b): (P<E>, P<E>) = (
            a.iter().map(|(e, c)| (E::from_slice(e), *c)).collect(),
            b.iter().map(|(e, c)| (E::from_slice(e), *c)).collect(),
        );
        let too_large = || format!("expression too large (over {max_terms} terms)");
        let distinct = |p: &P<E>| p.windows(2).all(|w| w[0].0 < w[1].0);
        let mut out: P<E>;
        if b.len() == 1 && distinct(&a) {
            // Each of a's terms adds one new exponent, in a's order.
            out = Vec::with_capacity(a.len());
            for (ea, ca) in &a {
                let e = ea.checked_add(&b[0].0).ok_or("exponent overflow")?;
                out.push((e, ca.checked_mul(b[0].1).ok_or("coefficient overflow")?));
                if out.len() > max_terms {
                    return Err(too_large());
                }
            }
        } else {
            let mut acc: HashMap<E, i128, BuildHasherDefault<Fx>> =
                HashMap::with_capacity_and_hasher((a.len() * b.len()).min(1 << 12), Default::default());
            for (ea, ca) in &a {
                for (eb, cb) in &b {
                    let e = ea.checked_add(eb).ok_or("exponent overflow")?;
                    let c = ca.checked_mul(*cb).ok_or("coefficient overflow")?;
                    let v = acc.entry(e).or_insert(0);
                    *v = v.checked_add(c).ok_or("coefficient overflow")?;
                }
                if acc.len() > max_terms {
                    return Err(too_large());
                }
            }
            out = acc.into_iter().collect();
            out.sort_unstable_by(|x, y| x.0.cmp(&y.0));
        }
        Ok(out
            .into_iter()
            .filter(|&(_, c)| c != 0)
            .map(|(e, c)| (e.to_vec(n), c))
            .collect())
    }
    dispatch!(width(a.iter().chain(b).map(|(e, _)| e)), go(a, b, max_terms))
}

/// The plain `MPoly` product (for the tests).
#[cfg(test)]
fn mul(a: &MPoly, b: &MPoly, w: &mut Work) -> R<MPoly> {
    Ok(to_m(pmul(&to_p::<Vec<u8>>(a), &to_p::<Vec<u8>>(b), w)?, 0))
}

#[cfg(test)]
fn constant(c: i128, n: usize) -> MPoly {
    let mut p = MPoly::new();
    if c != 0 {
        p.insert(vec![0; n], c);
    }
    p
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
