# Model binding and symbol replacement

Preserve exact model identity, parameters, ordered external terminals and Net
membership. A symbol is a presentation, not proof of a simulator model or pin
mapping. Prefer an explicit Project/import mapping or a reviewed exact mapping;
leave an unresolved generic symbol when the required facts are absent.

Structural mapping is not simulation qualification. Obtain supported devices,
corners, engine and dependency identities from the selected Profile's current
capabilities, not a static count of SKY130 wrappers. Model-symbol information,
when advertised, is tied to a dependency digest and section. Do not infer support
for an entire family from one accepted device.

A Profile's `cellLibraries` (capabilities, when the simulator offers them)
each declare the standard-cell library they define and how a deck loads it.
The hosted SKY130 ngspice Profile offers `sky130_fd_sc_hd`, so a Library gate
bound to an HD gate cell (`sky130_fd_sc_hd__nor2_1`) runs there: Prepare
mounts and `.include`s the cell file after the models' `.lib`, and the cell
is called in its own pin order, `VGND VNB VPB VPWR` included. The cells are
built from `nfet_01v8` and `pfet_01v8_hvt` at the continuous library's
`scale=1.0u`. Only the gate cells a Library gate takes are reviewed;
flip-flops, latches and other HD cells use `special_` devices the library
does not define. A cell whose library the Profile does not offer is refused
(`STANDARD_CELL_LIBRARY_UNAVAILABLE`); a cell declared out of its library's
pin order, or one no Library gate takes, is refused
(`STANDARD_CELL_UNSUPPORTED`). Any other definition without a body runs only
when it is a reviewed library interface in its exact pin order or a `.subckt`
of the experiment's files; a loaded dependency alone does not define it
(`MODEL_IMPLEMENTATION_MISSING`).

Use Snapshot external binding and `mosBulk` facts to check hidden body/substrate
pins. Three-terminal artwork does not remove an electrical fourth terminal.
Do not discard an external binding merely to obtain familiar artwork.

A SKY130 NPN's hidden substrate `S` (and a poly resistor's or varactor's `B`,
an inductor's `SUB`) is the p-substrate, the node NMOS bodies sit on. It is
bound when the part is placed: to the Cell's one drawn negative supply (a
supply marker named like `VEE`, `VSS` or `VNEG`) while the Cell's NMOS body
default is unset or ground (a Cell's first ground sets it), else to that
default when it is another Net, else to ground. To put it elsewhere, set the
NMOS default, e.g. `{kind:"set-mos-bulk-default",mos:"nmos",net:"VSUB"}`: the
substrates that followed the old default move with the NMOS bodies, one set
to another Net stays. One bound to ground before the rail was drawn exports
with `PDK_SUBSTRATE_ABOVE_NEGATIVE_SUPPLY`; rebind it alone with
`set_property_terminal_net`, or, with ground the NMOS default, set that
default to the rail. A SKY130 PNP has no substrate pin: its wrapper ties the
substrate to its collector, so it netlists with three nodes.

For `set_instance_symbol`, use an explicit source-to-target pin map when
connected or routed pins change names. The Edit Engine updates the related
terminal and route identities atomically. Duplicate/missing/unknown target pins
are mapping failures, not permission to detach the device. Query exact edit
fields through the selected transport's schema.
