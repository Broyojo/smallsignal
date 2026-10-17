# Lean verification

Two kinds of machine-checked statements about the solver (Lean 4 + Mathlib,
`lean-toolchain`):

1. **`Smallsignal/Mna.lean` — the stamps are exactly the circuit equations.**
   `Smallsignal.mna_iff`: for any circuit built from admittances (R, sC, gₒ,
   rπ, …), VCCS (gm, gmb), CCCS, V sources, VCVS, CCVS, inductors (sL) and
   independent current injections, over any field, and any assignment `x` of
   node voltages and branch currents,

   ```
   c.A *ᵥ x = c.rhs  ↔  (∀ k, c.KCL x k) ∧ (∀ j, c.BranchEq x j)
   ```

   where `c.A` / `c.rhs` are built by the same `put(r, c, v)` calls (same
   ground skipping, same skip conditions) as `system` in
   `crates/smallsignal-core/src/ss.rs`, and `KCL` / `BranchEq` are the
   physical equations: the currents leaving each non-ground node equal the
   currents injected there, and each branch element's defining equation.
   No `sorry`; the only axioms are Lean's standard ones (`propext`,
   `Classical.choice`, `Quot.sound`).

2. **`Certs/*.lean` — per-circuit certificates (generated).**
   `gen_cert.py` turns `smallsignal analyze --certificate` output into a file
   that states the circuit's small-signal element list and proves, for
   symbolic parameters over any field with the determinant ≠ 0, that the
   solver's exact solution `N_j / D` satisfies KCL at every node and every
   branch equation (`kcl`, `branchEq`), hence solves the MNA system Lean stamps
   itself (`solves`, via `mna_iff`). The matrix the Rust code builds is not
   used.

```sh
lean/check_all.sh            # regenerate + check every oracle/corpus circuit
lean/check_all.sh nmos_cs    # selected circuits
```

A sidecar's `assume` (or `NAME@M1:ro`) certifies the assumed element list;
circuits marked `tooLarge` have no exact form and no certificate.

## What this does and does not establish

Certified: the solver's symbolic solution is an *exact* solution of the
small-signal circuit equations for the element list it reports — no
determinant/Cramer bug, sign error or dropped term can survive.

Trust base: the Lean kernel and Mathlib; `gen_cert.py` and
`certificate.rs` transcribing the solver's element list faithfully (the
element list itself is checked against physics by `mna_iff`, not trusted).

Not covered here (covered by the ngspice oracle in `oracle/` instead):
device models and linearization (gm, ro, …, from the operating point), the
DC operating point, the netlist parser and editor translation, merging the
nodes of zeroed V sources, and the display layer (simplification, ∥
notation, which are checked numerically at run time). Certificates are for
the symbolic-mode parameter set (every transistor saturated /
forward-active); `gen_cert.py --numeric` uses the operating point's set.
