# Canvas EDA Tools

`eda/` exports Canvas circuits and imports them into Aether (`aether.py`, the
vendor PyAether API) or Virtuoso (`virtuoso.py`, reusing the
[virtuoso-bridge-lite](https://github.com/Arcadia-1/virtuoso-bridge-lite)
manifest importer). Hosts, credentials, libraries and PDK paths are external
configuration; neither backend supplies EDA binaries, licenses or PDKs, and the
editor needs neither. Options are in each script's `--help`.

Scripts: `snapshot.mjs` (gallery snapshot export through real Canvas code),
`select_circuits.py` (optional HES eligibility, not proof of Virtuoso
compatibility), `export.py` (offline preparation), `import_one.py` /
`import_batch.py` (import and read back one circuit, or serially all, stopping
on failure), `capture.py` / `report.py` (Aether screenshots and reports).

## Setup

Aether needs only PyAether, run in its Python Console. Virtuoso needs current
Bridge source in the CLI's Python environment
(`python -m pip install -e /work/virtuoso-bridge-lite`), a configured Bridge
connection, and the target library created with its technology.

## Offline export

Linux, a Canvas checkout and a Node runtime with esbuild and Canvas
dependencies; no EDA session is contacted.

```sh
python eda/export.py \
  --canvas-source /work/Analog-Canvas --runtime /work/node-runtime \
  --snapshot /work/gallery-snapshot --circuit gallery-id:ota \
  --backend aether --library canvas_demo --output /work/ota-bundle
```

Use `--selection <file>` for many circuits. `--minimum-dimensions` raises
out-of-range MOS sizes to HES minima and records the changes (not electrical
equivalence). Keep the bundle outside the new native library directory.

Virtuoso uses `--backend virtuoso --process-map <file> --process <pdk>` instead
of `--library`. It writes `source.json` plus Bridge `schematic.json`; the process map
supplies masters, pin offsets and parameter mappings. Internal supply markers,
expanded inverters, unmapped parameters and resizing overrides are rejected,
never dropped.

## Native import

Aether runs inside an existing PyAether Console after the bundle is copied to
that server. Confirm in Design Manager that the new library name is unused, and
run one import/GUI operation at a time per session.

```python
import runpy
runpy.run_path('/work/ota-bundle/import_one.py', run_name='__main__',
    init_globals={'EDA_ARGS': [
        '--backend', 'aether',
        '--input', '/work/ota-bundle/aether_hes_import_spec.json',
        '--cell', 'ota',
        '--library-parent', '/work/native-libraries',
        '--output', '/work/ota-bundle',
    ]})
```

```sh
python eda/import_one.py --backend virtuoso \
  --input /work/virtuoso-bundle/schematic.json --cell ota \
  --process-map /work/process-map.json --process target_pdk \
  --env /secure/bridge.env --profile lab_a --output /work/import-results
```

For a batch, use `import_batch.py` without `--cell`. Each attempt needs a new
library and a bundle without an earlier `import-attempt.json`; that marker
blocks replay after interruption, so inspect the native outcome instead of
deleting it. Results: `execution-status.json`, `import-journal.jsonl`,
`import-result.json`.

## Validation

On Linux with the real Bridge package (and Pillow for report tests):

```sh
PYTHONPATH=eda python -m unittest discover -s eda/tests
node --test eda/tests/analog-canvas-aether-names.test.mjs
python eda/tests/integration.py --canvas-source /work/Analog-Canvas \
  --runtime /work/node-runtime
```

Offline preflight, native readback, EDA netlist export and electrical
equivalence are distinct checks; native acceptance so far covers a few cells
per backend, not simulation equivalence.
