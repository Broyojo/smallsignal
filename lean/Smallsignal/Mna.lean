import Mathlib

/-!
# The MNA stamps of `smallsignal` are exactly KCL plus the branch equations

`crates/smallsignal-core/src/ss.rs` (`system`) builds the small-signal matrix
by `put(r, c, v)` calls, where a position is a node column, a branch column,
or ground (`None`, which `put` skips). This file models those calls
literally (`Entry`, with the same skip conditions) and proves that
`A · x = b` holds iff

* KCL holds at every non-ground node: the currents leaving each node through
  its elements equal the currents injected there, and
* every branch element's defining equation holds (V source, VCVS, CCVS,
  inductor).

Unknowns are indexed by `N ⊕ B` (node voltages, then branch currents), as
in the Rust code, which numbers node columns first and then branch columns.
The Rust code also merges the nodes of zeroed V sources (union–find) before
stamping; that rewrite is not covered here.
-/

namespace Smallsignal

open Matrix

set_option linter.unusedSectionVars false

variable {N B K : Type*} [Fintype N] [Fintype B] [DecidableEq N] [DecidableEq B] [Field K]

/-- A matrix position; `none` is ground, which `put` skips. -/
abbrev Pos (N B : Type*) := Option (N ⊕ B)

/-- Column of a node (`none` = ground). -/
def node (a : Option N) : Pos N B := a.map Sum.inl

/-- Column of a branch current. -/
def br (j : B) : Pos N B := some (Sum.inr j)

/-- One `put(r, c, v)` call. -/
structure Entry (N B K : Type*) where
  r : Pos N B
  c : Pos N B
  v : K

/-- The matrix with a single `put`. -/
def Entry.mat (e : Entry N B K) : Matrix (N ⊕ B) (N ⊕ B) K :=
  fun i j => if e.r = some i ∧ e.c = some j then e.v else 0

/-- The matrix built by a sequence of `put`s. -/
def toMatrix (es : List (Entry N B K)) : Matrix (N ⊕ B) (N ⊕ B) K :=
  (es.map Entry.mat).sum

/-- Elements stamped into KCL rows only (their current enters the node equations). -/
inductive CElem (N B K : Type*)
  /-- Admittance `y` between `a` and `b` (resistor, capacitor `sC`, `g_o`, …). -/
  | adm (a b : Option N) (y : K)
  /-- Current `g·(v_cp − v_cn)` flowing from `op` through the source to `on`. -/
  | vccs (op on cp cn : Option N) (g : K)
  /-- Current `f·i_ctrl` from `a` through the source to `b`. -/
  | cccs (a b : Option N) (ctrl : B) (f : K)

/-- Elements that own a branch-current unknown and a branch equation. -/
inductive BElem (N B K : Type*)
  /-- `v_a − v_b = val` (`val` is the excitation: 1 for the input, 0 otherwise). -/
  | vsrc (a b : Option N) (val : K)
  /-- `v_a − v_b = e·(v_cp − v_cn)`. -/
  | vcvs (a b cp cn : Option N) (e : K)
  /-- `v_a − v_b = h·i_ctrl`. -/
  | ccvs (a b : Option N) (ctrl : B) (h : K)
  /-- `v_a − v_b = z·i` with `z = s·L`. -/
  | ind (a b : Option N) (z : K)

namespace CElem

/-- The `put`s `ss.rs` makes for each element (same skip conditions). -/
def stamps : CElem N B K → List (Entry N B K)
  | adm a b y =>
    if a = b then []
    else [⟨node a, node a, y⟩, ⟨node b, node b, y⟩, ⟨node a, node b, -y⟩, ⟨node b, node a, -y⟩]
  | vccs op on cp cn g =>
    if op = on ∨ cp = cn then []
    else [⟨node op, node cp, g⟩, ⟨node op, node cn, -g⟩, ⟨node on, node cp, -g⟩, ⟨node on, node cn, g⟩]
  | cccs a b k f => [⟨node a, br k, f⟩, ⟨node b, br k, -f⟩]

end CElem

namespace BElem

def a : BElem N B K → Option N
  | vsrc a _ _ | vcvs a _ _ _ _ | ccvs a _ _ _ | ind a _ _ => a

def b : BElem N B K → Option N
  | vsrc _ b _ | vcvs _ b _ _ _ | ccvs _ b _ _ | ind _ b _ => b

/-- The branch current enters KCL at both terminals, and `v_a − v_b` opens the branch row. -/
def kclPart (j : B) (a b : Option N) : List (Entry N B K) :=
  [⟨node a, br j, 1⟩, ⟨node b, br j, -1⟩, ⟨br j, node a, 1⟩, ⟨br j, node b, -1⟩]

/-- The `put`s `ss.rs` makes for the element owning branch `j`. -/
def stamps (j : B) : BElem N B K → List (Entry N B K)
  | vsrc a b _ => kclPart j a b
  | vcvs a b cp cn e => kclPart j a b ++ [⟨br j, node cp, -e⟩, ⟨br j, node cn, e⟩]
  | ccvs a b k h => kclPart j a b ++ [⟨br j, br k, -h⟩]
  | ind a b z => kclPart j a b ++ [⟨br j, br j, -z⟩]

/-- The excitation `b[k]` of the branch row. -/
def val : BElem N B K → K
  | vsrc _ _ v => v
  | _ => 0

end BElem

/-- A small-signal circuit: KCL-row elements, the element owning each branch,
and independent current injections `(into, outof, i)`. -/
structure Circuit (N B K : Type*) where
  elems : List (CElem N B K)
  branch : B → BElem N B K
  inj : List (Option N × Option N × K)

/-- The MNA matrix, exactly as stamped. -/
def Circuit.A (c : Circuit N B K) : Matrix (N ⊕ B) (N ⊕ B) K :=
  (c.elems.map fun e => toMatrix e.stamps).sum + ∑ j, toMatrix ((c.branch j).stamps j)

/-- Current `i` flowing from `p` to `q` through an element, seen at node `k`:
it leaves at `p` and enters at `q`. -/
def leave (p q : Option N) (k : N) (i : K) : K :=
  (if p = some k then i else 0) - (if q = some k then i else 0)

/-- The right-hand side: injections into `into` (out of `outof`), and the
V-source excitations on their branch rows. -/
def Circuit.rhs (c : Circuit N B K) : N ⊕ B → K
  | .inl k => (c.inj.map fun t => leave t.1 t.2.1 k t.2.2).sum
  | .inr j => (c.branch j).val

/-- Voltage of a node; ground is 0. -/
def vol (x : N ⊕ B → K) : Option N → K
  | none => 0
  | some k => x (.inl k)

/-- The current an element carries, as (from, to, current). -/
def CElem.current (x : N ⊕ B → K) : CElem N B K → Option N × Option N × K
  | .adm a b y => (a, b, y * (vol x a - vol x b))
  | .vccs op on cp cn g => (op, on, g * (vol x cp - vol x cn))
  | .cccs a b k f => (a, b, f * x (.inr k))

/-- KCL at node `k`: the currents leaving through every element (branch
currents flow from `a` to `b`) equal the injected currents. -/
def Circuit.KCL (c : Circuit N B K) (x : N ⊕ B → K) (k : N) : Prop :=
  (c.elems.map fun e => leave (e.current x).1 (e.current x).2.1 k (e.current x).2.2).sum
      + ∑ j, leave (c.branch j).a (c.branch j).b k (x (.inr j))
    = (c.inj.map fun t => leave t.1 t.2.1 k t.2.2).sum

/-- The defining equation of the element owning branch `j`. -/
def Circuit.BranchEq (c : Circuit N B K) (x : N ⊕ B → K) (j : B) : Prop :=
  match c.branch j with
  | .vsrc a b v => vol x a - vol x b = v
  | .vcvs a b cp cn e => vol x a - vol x b = e * (vol x cp - vol x cn)
  | .ccvs a b k h => vol x a - vol x b = h * x (.inr k)
  | .ind a b z => vol x a - vol x b = z * x (.inr j)

/-! ### Proof -/

/-- Value of an unknown at a position; ground is 0. -/
def pos (x : N ⊕ B → K) : Pos N B → K
  | none => 0
  | some i => x i

@[simp] lemma pos_node (x : N ⊕ B → K) (a : Option N) : pos x (node a) = vol x a := by
  cases a <;> rfl

@[simp] lemma pos_br (x : N ⊕ B → K) (j : B) : pos x (br j) = x (.inr j) := rfl

@[simp] lemma node_eq_inl (a : Option N) (k : N) :
    (node a : Pos N B) = some (.inl k) ↔ a = some k := by
  cases a <;> simp [node]

@[simp] lemma node_ne_inr (a : Option N) (j : B) : (node a : Pos N B) ≠ some (.inr j) := by
  cases a <;> simp [node]

@[simp] lemma br_eq_some (j : B) (i : N ⊕ B) : (br j : Pos N B) = some i ↔ i = .inr j := by
  simp [br, eq_comm]

/-- One `put` contributes `v · x_c` to row `r`. -/
lemma Entry.mulVec_mat (e : Entry N B K) (x : N ⊕ B → K) (i : N ⊕ B) :
    (e.mat *ᵥ x) i = if e.r = some i then e.v * pos x e.c else 0 := by
  obtain ⟨r, c, v⟩ := e
  simp only [Entry.mat, Matrix.mulVec, dotProduct]
  by_cases hr : r = some i
  · cases c with
    | none => simp [hr, pos]
    | some c => simp [hr, pos, ite_mul]
  · simp [hr]

/-- Row `i` of a sequence of `put`s. -/
def rowOf (es : List (Entry N B K)) (x : N ⊕ B → K) (i : N ⊕ B) : K :=
  (es.map fun e => if e.r = some i then e.v * pos x e.c else 0).sum

lemma toMatrix_mulVec (es : List (Entry N B K)) (x : N ⊕ B → K) (i : N ⊕ B) :
    (toMatrix es *ᵥ x) i = rowOf es x i := by
  induction es with
  | nil => simp [toMatrix, rowOf]
  | cons e es ih =>
    simp only [toMatrix, List.map_cons, List.sum_cons, Matrix.add_mulVec, Pi.add_apply] at ih ⊢
    rw [ih, Entry.mulVec_mat]
    simp [rowOf]

lemma CElem.row_inl (e : CElem N B K) (x : N ⊕ B → K) (k : N) :
    rowOf e.stamps x (.inl k) = leave (e.current x).1 (e.current x).2.1 k (e.current x).2.2 := by
  cases e with
  | adm a b y =>
    by_cases hab : a = b
    · subst hab; simp [stamps, rowOf, current, leave]
    · simp only [stamps, hab, ite_false, rowOf, List.map_cons, List.map_nil, List.sum_cons,
        List.sum_nil, node_eq_inl, pos_node, current, leave]
      split_ifs <;> simp_all <;> ring
  | vccs op on cp cn g =>
    by_cases h : op = on ∨ cp = cn
    · rcases h with h | h
      · subst h
        simp only [stamps, true_or, ite_true, rowOf, List.map_nil, List.sum_nil, current, leave]
        by_cases hk : op = some k <;> simp [hk]
      · subst h; simp [stamps, rowOf, current, leave]
    · simp only [stamps, h, ite_false, rowOf, List.map_cons, List.map_nil, List.sum_cons,
        List.sum_nil, node_eq_inl, pos_node, current, leave]
      split_ifs <;> simp_all <;> ring
  | cccs a b k' f =>
    simp only [stamps, rowOf, List.map_cons, List.map_nil, List.sum_cons, List.sum_nil,
      node_eq_inl, pos_br, current, leave]
    split_ifs <;> simp_all

lemma CElem.row_inr (e : CElem N B K) (x : N ⊕ B → K) (j : B) :
    rowOf e.stamps x (.inr j) = 0 := by
  cases e with
  | adm a b y => by_cases hab : a = b <;> simp [stamps, rowOf, hab]
  | vccs op on cp cn g => by_cases h : op = on ∨ cp = cn <;> simp [stamps, rowOf, h]
  | cccs a b k f => simp [stamps, rowOf]

lemma BElem.row_inl (e : BElem N B K) (j : B) (x : N ⊕ B → K) (k : N) :
    rowOf (e.stamps j) x (.inl k) = leave e.a e.b k (x (.inr j)) := by
  cases e <;>
  · simp only [stamps, kclPart, rowOf, List.map_cons, List.map_nil, List.map_append,
      List.sum_cons, List.sum_nil, List.sum_append, node_eq_inl, br_eq_some, reduceCtorEq,
      ite_false, pos_br, a, b, leave]
    split_ifs <;> simp_all

/-- The branch row of the element owning `j`: `v_a − v_b` minus its control term. -/
lemma BElem.row_inr_self (e : BElem N B K) (j : B) (x : N ⊕ B → K) :
    rowOf (e.stamps j) x (.inr j) =
      match e with
      | .vsrc a b _ => vol x a - vol x b
      | .vcvs a b cp cn g => vol x a - vol x b - g * (vol x cp - vol x cn)
      | .ccvs a b k h => vol x a - vol x b - h * x (.inr k)
      | .ind a b z => vol x a - vol x b - z * x (.inr j) := by
  cases e <;> simp [stamps, kclPart, rowOf] <;> ring

lemma BElem.row_inr_other (e : BElem N B K) (j j' : B) (h : j ≠ j') (x : N ⊕ B → K) :
    rowOf (e.stamps j) x (.inr j') = 0 := by
  have h' : (br j : Pos N B) ≠ some (.inr j') := by simp [br, h]
  cases e <;> simp [stamps, kclPart, rowOf, h']

lemma A_mulVec_inl (c : Circuit N B K) (x : N ⊕ B → K) (k : N) :
    (c.A *ᵥ x) (.inl k) =
      (c.elems.map fun e => leave (e.current x).1 (e.current x).2.1 k (e.current x).2.2).sum
        + ∑ j, leave (c.branch j).a (c.branch j).b k (x (.inr j)) := by
  simp only [Circuit.A, Matrix.add_mulVec, Pi.add_apply, Matrix.sum_mulVec, Finset.sum_apply]
  congr 1
  · induction c.elems with
    | nil => simp
    | cons e es ih =>
      simp only [List.map_cons, List.sum_cons, Matrix.add_mulVec, Pi.add_apply] at ih ⊢
      rw [ih, toMatrix_mulVec, CElem.row_inl]
  · refine Finset.sum_congr rfl fun j _ => ?_
    rw [toMatrix_mulVec, BElem.row_inl]

lemma A_mulVec_inr (c : Circuit N B K) (x : N ⊕ B → K) (j : B) :
    (c.A *ᵥ x) (.inr j) =
      match c.branch j with
      | .vsrc a b _ => vol x a - vol x b
      | .vcvs a b cp cn g => vol x a - vol x b - g * (vol x cp - vol x cn)
      | .ccvs a b k h => vol x a - vol x b - h * x (.inr k)
      | .ind a b z => vol x a - vol x b - z * x (.inr j) := by
  simp only [Circuit.A, Matrix.add_mulVec, Pi.add_apply, Matrix.sum_mulVec, Finset.sum_apply]
  have hc : ((c.elems.map fun e => toMatrix e.stamps).sum *ᵥ x) (.inr j) = 0 := by
    induction c.elems with
    | nil => simp
    | cons e es ih =>
      simp only [List.map_cons, List.sum_cons, Matrix.add_mulVec, Pi.add_apply] at ih ⊢
      rw [ih, toMatrix_mulVec, CElem.row_inr, add_zero]
  rw [hc, zero_add, Finset.sum_eq_single j]
  · rw [toMatrix_mulVec, BElem.row_inr_self]
  · intro j' _ hj'
    rw [toMatrix_mulVec, BElem.row_inr_other _ _ _ hj']
  · simp

/-- **The stamps are exactly KCL plus the branch equations.** For every
assignment of node voltages and branch currents, `A · x = b` iff KCL holds
at every non-ground node and every branch element's equation holds. -/
theorem mna_iff (c : Circuit N B K) (x : N ⊕ B → K) :
    c.A *ᵥ x = c.rhs ↔ (∀ k, c.KCL x k) ∧ (∀ j, c.BranchEq x j) := by
  constructor
  · intro h
    refine ⟨fun k => ?_, fun j => ?_⟩
    · have := congrFun h (.inl k)
      rwa [A_mulVec_inl] at this
    · have := congrFun h (.inr j)
      rw [A_mulVec_inr] at this
      simp only [Circuit.BranchEq, Circuit.rhs] at this ⊢
      cases hb : c.branch j <;> simp only [hb, BElem.val] at this ⊢ <;> linear_combination this
  · rintro ⟨hk, hj⟩
    funext i
    cases i with
    | inl k => rw [A_mulVec_inl]; exact hk k
    | inr j =>
      rw [A_mulVec_inr]
      have := hj j
      simp only [Circuit.BranchEq, Circuit.rhs] at this ⊢
      cases hb : c.branch j <;> simp only [hb, BElem.val] at this ⊢ <;> linear_combination this

end Smallsignal
