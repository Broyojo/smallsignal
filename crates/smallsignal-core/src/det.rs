//! Division-free symbolic determinants by Laplace expansion with memoized
//! minors: row `r` extends every reachable minor of rows `0..r` by one column.
//! Only column sets that can still be completed are kept, and a reverse
//! Cuthill–McKee ordering keeps the reachable sets near the band.

use crate::poly::{MonoMap, Poly};

/// Upper bound on term products per determinant (a few seconds of work), so
/// a dense matrix fails cleanly instead of running away before the per-row
/// term check sees it.
pub const MAX_WORK: u64 = 50_000_000;

/// A row whose minors reach this many times the term budget before
/// cancellation fails at once: cancellation within a row removes far less
/// (at most about a quarter, measured), so finishing it would only cost time
/// and memory.
const ROW_TOUCHED_FACTOR: usize = 2;

/// The over-budget error, which leaves a quantity numeric.
pub fn too_large(max_terms: usize) -> String {
    format!("exact expression too large (over {max_terms} terms); simplify the circuit or analyze a smaller block")
}

/// The determinant; a wide system (rows without entries: more parameters
/// than a monomial holds) is over budget.
pub fn det(a: &[Vec<Poly>], max_terms: usize) -> Result<Poly, String> {
    let n = a.len();
    if a.iter().any(|r| r.len() != n) {
        return Err(too_large(max_terms));
    }
    if n == 0 {
        return Ok(Poly::one());
    }
    if n > 64 {
        return Err(format!("circuit too large: {n} unknowns (limit 64)"));
    }
    let perm = rcm(a);
    let rows: Vec<Vec<(usize, &Poly)>> = (0..n)
        .map(|r| {
            (0..n)
                .filter_map(|c| {
                    let p = &a[perm[r]][perm[c]];
                    (!p.is_zero()).then_some((c, p))
                })
                .collect()
        })
        .collect();
    let mut last = vec![usize::MAX; n];
    for (r, row) in rows.iter().enumerate() {
        for &(c, _) in row {
            last[c] = r;
        }
    }
    if last.contains(&usize::MAX) {
        return Ok(Poly::zero());
    }
    // must[r]: columns with no nonzero below row r, so a minor of rows 0..=r
    // has to contain them already.
    let mut must = vec![0u64; n];
    for (c, &r) in last.iter().enumerate() {
        must[r] |= 1u64 << c;
    }
    for r in 1..n {
        must[r] |= must[r - 1];
    }

    let too_large = || too_large(max_terms);
    let mut work: u64 = 0;
    let mut cur: MonoMap<Poly> = MonoMap::default();
    cur.insert(0, Poly::one());
    let row_cap = max_terms.saturating_mul(ROW_TOUCHED_FACTOR);
    for (r, row) in rows.iter().enumerate() {
        let mut next: MonoMap<Poly> = MonoMap::default();
        let mut touched = 0usize;
        for (&set, minor) in &cur {
            let set = set as u64;
            for &(c, entry) in row {
                if set >> c & 1 == 1 {
                    continue;
                }
                let ns = set | 1u64 << c;
                if ns & must[r] != must[r] {
                    continue;
                }
                let pos = (set & ((1u64 << c) - 1)).count_ones() as usize;
                let sign = if (r + pos).is_multiple_of(2) { 1 } else { -1 };
                work += (entry.len() * minor.len()) as u64 + 1;
                if work > MAX_WORK {
                    return Err(too_large());
                }
                let target = next.entry(ns as u128).or_default();
                let before = target.len();
                target
                    .mul_acc(entry, minor, sign)
                    .map_err(|_| "coefficient overflow in determinant".to_string())?;
                touched += target.len() - before;
                if touched > row_cap {
                    return Err(too_large());
                }
            }
        }
        let mut total = 0;
        next.retain(|_, p| {
            p.prune();
            total += p.len();
            !p.is_zero()
        });
        if total > max_terms {
            return Err(too_large());
        }
        cur = next;
    }
    let full: u64 = if n == 64 { u64::MAX } else { (1u64 << n) - 1 };
    Ok(cur.remove(&(full as u128)).unwrap_or_default())
}

/// Reverse Cuthill–McKee order of the symmetrized sparsity pattern; returns
/// `perm[new] = old`.
fn rcm(a: &[Vec<Poly>]) -> Vec<usize> {
    let n = a.len();
    let adj: Vec<Vec<usize>> = (0..n)
        .map(|i| {
            (0..n)
                .filter(|&j| j != i && (!a[i][j].is_zero() || !a[j][i].is_zero()))
                .collect()
        })
        .collect();
    let mut seen = vec![false; n];
    let mut order = Vec::with_capacity(n);
    while order.len() < n {
        let start = (0..n).filter(|&i| !seen[i]).min_by_key(|&i| adj[i].len()).unwrap();
        seen[start] = true;
        let mut head = order.len();
        order.push(start);
        while head < order.len() {
            let v = order[head];
            head += 1;
            let mut nb: Vec<usize> = adj[v].iter().copied().filter(|&j| !seen[j]).collect();
            nb.sort_by_key(|&j| adj[j].len());
            for j in nb {
                seen[j] = true;
                order.push(j);
            }
        }
    }
    order.reverse();
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    fn var(i: u32) -> Poly {
        let mut p = Poly::zero();
        p.add_term(1u128 << i, 1);
        p
    }

    #[test]
    fn two_by_two() {
        // [[a, b], [c, d]] → ad - bc
        let m = vec![vec![var(0), var(1)], vec![var(2), var(3)]];
        let d = det(&m, 1 << 20).unwrap();
        let mut want = Poly::zero();
        want.add_term(0b1001, 1);
        want.add_term(0b0110, -1);
        assert_eq!(d, want);
    }

    #[test]
    fn nodal_matrix_cancels_squares() {
        // Two resistors in series to ground at node 1: G1 between 1-2, G2 2-gnd,
        // plus G0 1-gnd. det = (G0+G1)(G1+G2) - G1² = G0G1 + G0G2 + G1G2.
        let g = |i| var(i);
        let mut a11 = g(0);
        a11.add_scaled(&g(1), 1);
        let mut a22 = g(1);
        a22.add_scaled(&g(2), 1);
        let m = vec![vec![a11, g(1).neg()], vec![g(1).neg(), a22]];
        let d = det(&m, 1 << 20).unwrap();
        let mut want = Poly::zero();
        want.add_term(0b011, 1);
        want.add_term(0b101, 1);
        want.add_term(0b110, 1);
        assert_eq!(d, want);
    }
}
