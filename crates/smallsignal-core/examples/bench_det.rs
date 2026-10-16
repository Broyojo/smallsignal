//! Determinant timing on random small-signal nodal matrices: n nodes, m
//! MOSFETs (gm, gds, Cgs, Cgd at random terminals) and a conductance from
//! every node to ground. Run: cargo run --release --example bench_det
use smallsignal_core::det::det;
use smallsignal_core::poly::Poly;
use std::time::Instant;

type Put<'a> = &'a mut dyn FnMut(&mut Vec<Vec<Poly>>, Option<usize>, Option<usize>, u32, i128);

fn main() {
    let mut seed: u64 = 42;
    let mut rnd = |k: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % k as u64) as usize
    };
    for (n, m) in [(3, 3), (4, 5), (6, 7), (8, 10), (10, 12)] {
        let mut a = vec![vec![Poly::zero(); n]; n];
        let mut np = 0u32;
        let mut put = |a: &mut Vec<Vec<Poly>>, r: Option<usize>, c: Option<usize>, p: u32, v: i128| {
            if let (Some(r), Some(c)) = (r, c) {
                a[r][c].add_term(1u128 << p, v);
            }
        };
        let node = |k: usize| if k == 0 { None } else { Some(k - 1) };
        let adm = |a: &mut Vec<Vec<Poly>>, x: usize, y: usize, p: u32, put: Put| {
            put(a, node(x), node(x), p, 1);
            put(a, node(y), node(y), p, 1);
            put(a, node(x), node(y), p, -1);
            put(a, node(y), node(x), p, -1);
        };
        for _ in 0..m {
            let d = rnd(n + 1);
            let mut g = rnd(n + 1);
            while g == d {
                g = rnd(n + 1);
            }
            let mut s = rnd(n + 1);
            while s == d || s == g {
                s = rnd(n + 1);
            }
            let gm = np;
            put(&mut a, node(d), node(g), gm, 1);
            put(&mut a, node(d), node(s), gm, -1);
            put(&mut a, node(s), node(g), gm, -1);
            put(&mut a, node(s), node(s), gm, 1);
            adm(&mut a, d, s, np + 1, &mut put);
            adm(&mut a, g, s, np + 2, &mut put);
            adm(&mut a, g, d, np + 3, &mut put);
            np += 4;
        }
        for i in 1..=n {
            adm(&mut a, i, 0, np, &mut put);
            np += 1;
        }
        let t = Instant::now();
        let reps = 5;
        let mut terms = 0;
        for _ in 0..reps {
            terms = det(&a, 50_000_000).unwrap().len();
        }
        println!(
            "{n} nodes, {m} MOSFETs: det {:9.3} ms, {terms} terms",
            t.elapsed().as_secs_f64() * 1e3 / reps as f64
        );
    }
}
