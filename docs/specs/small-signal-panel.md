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
- Each equation line has a copy button at its right edge, outside its
  scroller, writing the whole equation's LaTeX (an "≈" line with its
  symbol); faint until the line is hovered where there is hover. Symbol
  tables have none.
- "=" means exact for the model shown. A form exact but for junction
  leakage too small to see reads "=" with "neglecting junction leakage"
  (once per Distortion section) and no Exact disclosure; Exact appears only
  under an "≈" with an exact form to open onto. An a_n that cancels at the
  bias reads "a_n = 0", "terms cancel at this bias", its general form a
  click away.
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
  node's DC voltage on its longest wire in the open Cell (ground and
  supply rails aside) and each transistor drawn there with its bias
  region (`sat`, `triode`, `off`, `active`), amber outside the
  amplifying region, where the part (10 px) or wire (28 px) is big enough
  on screen to carry one. No label covers another, a badge or the
  drawing's own text: each tries its places in turn (beside a part, along
  its net's longest wires), an off or triode device first, then node
  voltages, then amplifying devices; one with no free place is left off. They follow pans and zooms in the layer of the
  assumption badges. The choice is kept per viewer.
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
  guide; the dock returning to the panel.
