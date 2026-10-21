# Small-Signal Panel Views

Status: `proposed`

Primary owner: `apps/editor/src/features/small-signal`

What the panel draws besides the formulas: each card's Bode plot, the link
between formula symbols and drawn parts, the operating point on the
drawing and the guide. The solver's numbers and fields are
[crates/README.md](../../crates/README.md#contract); assumptions and the
device menu are [small-signal-assumptions.md](small-signal-assumptions.md).

## Rules

- The panel is the right dock's home: it is open when the editor starts
  and when a circuit or project tab opens. Netlist, Project Code or
  Properties cover it, and closing them shows it again (Properties a
  project panel covered come back once first); only its own toolbar
  button hides it, until the next circuit opens. Analog Simulation clears
  the dock while it is open. Where the dock covers the drawing (compact
  layout), closing a panel shows the drawing.
- Every plotted point is a solver value: the main solve sends `sweep: {}`
  and each card plots its quantity's `sweep` curves as returned, |H| in dB
  (Ω on a log axis for an impedance or a current input's gain) over the
  phase, unwrapped along the sweep. Nothing is fitted or resampled.
- A card plots the full model, the assumed model while assumptions apply,
  and the ≈ form while the card shows one. It marks the full model's
  poles (×) and zeros (○) in the band, a right half-plane one in amber,
  the gain's −3 dB point and, on a dB axis, its unity-gain point (rings
  on the full curve), and a crosshair reads every curve at the nearest
  swept frequency. Within 8 px of a marked point the sweep holds exactly
  it lands on it (the nearest), names it ("Pole 1.1 kHz", "Unity gain …",
  "−3 dB …") and at unity gain gives the phase margin, 180° less the phase
  lost since a 0° or 180° low frequency (none otherwise). Holding Alt reads
  freely, applied as it is pressed or released. No
  plot without a sweep (symbolic, nothing reactive), for an unbounded
  quantity, or for a flat one.
- Formulas are inline SVG whose symbols carry MathJax's `data-latex`. A
  symbol that is in `params` marks its elements' drawn parts (the part in
  the open Cell, or the placed Cell holding it) with a ring, matched
  groups whole; a part hovered on the drawing, or a Bias point row,
  marks every symbol of its elements. One stylesheet does the marking,
  so no formula re-renders. Copying a selection writes each formula as
  `$TeX$`, and a click selects a formula whole.
- Every symbol's value is one gesture away: pointing at a symbol in a
  formula (Distortion's K and V_OD too) shows "C_gs3 = 23.0 fF" beside the
  pointer, kept inside the viewport (a matched symbol also names its
  members; a tap's stays until the next tap); a transistor's or diode's
  device menu lists its small-signal values at the bias (MOS g_m, g_mb,
  r_o or a triode R_on, C_gs, C_gd, C_gb, C_db, C_sb; BJT g_m, r_π, r_o,
  C_π, C_μ, C_cs; diode r_d, C_j), zeros included, each the equations' own
  symbol and the assumed model's value where they use it; and a collapsed
  Parameters section lists every symbol of the equations with its value
  and elements. Without a bias a value is unknown ("—"), never ∞. Bias point stays the compact
  summary. Each Models field shows its unit (m, F/m, F/m², F, V, s, A/V²).
- Each equation line has a copy button at its right edge, outside its
  scroller, writing the whole equation's LaTeX (an "≈" line with its
  symbol); faint until the line is hovered where there is hover. Symbol
  tables have none.
- "=" means exact for the model shown. A form exact but for junction
  leakage too small to see reads "=" with "neglecting junction leakage"
  (once per Distortion section) and no Exact disclosure; Exact appears only
  under an "≈" with an exact form to open onto. An a_n that cancels at the
  bias reads "a_n = 0", "terms cancel at this bias", its general form (the
  nested one where there is one) a click away. An a_n with a `nested`
  form leads with it ("="), its display form a click away as Expanded.
- A re-solve keeps the panel's place: Noise and Distortion keep their
  last result up, dimmed and `aria-busy`, until the new one replaces it;
  Distortion keeps the netlist's devices while an option (Matched)
  re-solves; a formula keeps its drawing until its new one is typeset. A
  chip toggled stays where it was, and what is open stays open.
- A biased transistor or diode's device menu has a Nonlinear switch: the
  Distortion section's button for that part. Turning it on opens
  Distortion.
- Output offers each net and each drawn differential pair (outp/outn,
  out+/out−, vout1/vout2; not c1/c2), read across as V(+) − V(−);
  "Difference of two nets…" picks any two. A differential output shows
  its Output + and Output − below; − set to ground is single-ended again.
  A differential input defaults to a drawn output pair whose name has
  "out".
- Bias point lists every DC value the bias is solved from, editable in
  place: each source's DC (the input first: its signal rides on it), each
  undriven Pin's, and the supply rails'. A drawn source's edit writes the
  drawing. Distortion says its devices are expanded about this bias.
- Bias point's **Show on drawing** labels, while the panel is open, each
  node's DC voltage on one of its wires in the open Cell (ground and
  supply rails aside) and each transistor drawn there with its bias
  region (`sat`, `triode`, `off`, `active`), amber outside the
  amplifying region, where the part (10 px) or wire (28 px) is big enough
  on screen to carry one. The choice is kept per viewer.
- Everything the panel puts on the drawing (assumption badges, node
  voltages, regions) is one kind of tag, placed by one layout in view: a
  badge over its part's top right corner (else another corner), a voltage
  on its wire (centred on it, clear of its ends), a region against its
  part; where that is taken, a voltage or region a leader's length away
  draws a line to it, and with no free place is left off (a badge, a
  control, keeps its corner). No tag covers another, a part or the
  drawing's own text. Placed in turn: badges, an off or triode device,
  node voltages, amplifying devices. Pointing at a tag marks what it
  belongs to (rings the part and marks its symbols, or marks the net's
  wires), also when the tag moves under a still pointer; a part pointed
  at, in a formula or a table marks its tags. They follow pans and zooms.
- How to use: five numbered lines naming the panel's controls. It is the
  whole panel while nothing is drawn (with the 5T OTA example to place),
  sits under Input and Output when no source can drive the circuit, and
  shows above the results until a viewer closes it; **?** in the header
  reopens it.
- Under assumptions a form exact for the assumed model is written "=" with
  "Assumed model, 2.1% from full model"; "≈" marks only a form that drops
  something. A relative distance of twice the value or more reads as a
  multiple: "181× from full model", "18,000×".

## Contract

- `localStorage`: `smallsignal.biasOnDrawing` (`"1"` shown) and
  `smallsignal.guideDismissed` (`"1"` closed). Unreadable storage leaves
  both off, as on a first visit.

## Acceptance criteria

- Plot data against direct evaluation (the full and assumed curves
  against `values`, the ≈ curve against its `num`/`den` at `params`),
  unwrapping and ticks:
  `apps/editor/src/features/small-signal/small-signal-bode.test.ts`; the
  sweep's fields: `packages/small-signal/src/end-to-end.test.ts`.
- Symbol keys, highlight rules and the hover store:
  `small-signal-link.test.ts`.
- In the browser (`apps/editor/e2e/small-signal.spec.ts`): the two-stage
  OTA's plot with its poles, RHP zero and a readout equal to the card's
  1 kHz value; no plot without capacitors; g_m1 ringing M1, M1 marking
  its symbols, a copy writing TeX; the balanced inverter's a₂ = 0, a₁ in
  ∥, its menu's Nonlinear switch and a copy button; Show on drawing on the inverter; the
  "×" cost; the bias table at phone width; Esc in the device menu; R1's
  value edited in its menu re-solving, M1's W and L, the DC values; the
  guide; the dock returning to the panel; on the CS stage, diff pair, 5T
  OTA, two-stage OTA and CMOS inverter every tag on the drawing touching
  or led to its net or part, covering nothing, and marking its target
  when pointed at; tag placement: `small-signal-label-layout.test.ts`.
