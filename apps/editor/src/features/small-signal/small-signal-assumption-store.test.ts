import { describe, expect, it } from "vitest";
import type { SmallSignalElement } from "@icm/small-signal";
import {
  MAX_STORED_CIRCUITS,
  assumptionRequest,
  circuitStorageKey,
  isIgnored,
  partKey,
  readCircuits,
  readDefaults,
  storeCircuit,
  touchCircuit,
  withDefault,
  withRegion,
  withTerms,
  type StoredAssumptions,
} from "./small-signal-assumption-store";

const ELEMENTS: SmallSignalElement[] = [
  { name: "M1", instancePath: ["m1"], kind: "nmos" },
  { name: "M2_X1", instancePath: ["x1", "m2"], kind: "nmos" },
  { name: "Q1", instancePath: ["q1"], kind: "npn" },
  { name: "R1", instancePath: ["r1"], kind: "resistor" },
  { name: "V1", instancePath: ["v1"], kind: "voltage-source" },
];

describe("keys", () => {
  it("names a circuit by project and root Cell, a part by its instance path", () => {
    expect(circuitStorageKey("project-1", "main")).toBe("project-1/main");
    expect(partKey(["x1", "m2"])).toBe("x1/m2");
  });
});

describe("readDefaults", () => {
  it("keeps only the terms each transistor type accepts", () => {
    expect(
      readDefaults(
        JSON.stringify({
          nmos: ["ro", "rpi", "gmb", 3],
          npn: ["rpi"],
          resistor: ["open"],
          pmos: "ro",
        }),
      ),
    ).toEqual({ nmos: ["ro", "gmb"], npn: ["rpi"] });
  });

  it("reads nothing from missing or malformed storage", () => {
    expect(readDefaults(null)).toEqual({});
    expect(readDefaults("{")).toEqual({});
    expect(readDefaults("[1]")).toEqual({});
  });
});

describe("readCircuits", () => {
  it("drops unknown terms, regions and malformed circuits", () => {
    const stored = {
      a: {
        used: 5,
        parts: {
          m1: { ignore: { ro: true, cgx: true, gmb: "yes" }, region: "triode" },
          m2: { region: "linear" },
          r1: { ignore: { open: true, short: true } },
        },
      },
      b: { used: "5", parts: { m1: { ignore: { ro: true } } } },
      c: { used: 1, parts: [] },
    };
    expect(readCircuits(JSON.stringify(stored))).toEqual({
      a: { used: 5, parts: { m1: { ignore: { ro: true }, region: "triode" } } },
    });
    expect(readCircuits("not json")).toEqual({});
  });

  it(`keeps the ${MAX_STORED_CIRCUITS} most recently used`, () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_STORED_CIRCUITS + 5 }, (_, i) => [
        `c${i}`,
        { used: i, parts: { m1: { ignore: { ro: true } } } },
      ]),
    );
    const read = readCircuits(JSON.stringify(many));
    expect(Object.keys(read)).toHaveLength(MAX_STORED_CIRCUITS);
    expect(read.c4).toBeUndefined();
    expect(read.c5).toBeDefined();
  });
});

describe("storeCircuit", () => {
  const part = { ignore: { ro: true } };

  it("marks the circuit used and prunes parts no longer drawn", () => {
    const next = storeCircuit(
      {},
      "p/main",
      { m1: part, gone: part, m3: { ignore: {} } },
      42,
      new Set(["m1", "m3"]),
    );
    expect(next).toEqual({ "p/main": { used: 42, parts: { m1: part } } });
  });

  it("forgets a circuit with nothing left, and the oldest past the limit", () => {
    expect(
      storeCircuit({ k: { used: 1, parts: { m1: part } } }, "k", {}, 2),
    ).toEqual({});
    const full: StoredAssumptions = Object.fromEntries(
      Array.from({ length: MAX_STORED_CIRCUITS }, (_, i) => [
        `c${i}`,
        { used: i + 1, parts: { m1: part } },
      ]),
    );
    const next = storeCircuit(full, "new", { m1: part }, 1e6);
    expect(Object.keys(next)).toHaveLength(MAX_STORED_CIRCUITS);
    expect(next.new).toBeDefined();
    expect(next.c0).toBeUndefined();
    // Opening an old circuit keeps it past the next eviction.
    const touched = touchCircuit(full, "c0", 1e6);
    expect(storeCircuit(touched, "new", { m1: part }, 2e6).c0).toBeDefined();
  });
});

describe("choices against the defaults", () => {
  it("a part follows its type's default unless it says otherwise", () => {
    const defaults = { nmos: ["ro" as const] };
    expect(isIgnored("nmos", "ro", undefined, defaults)).toBe(true);
    expect(isIgnored("pmos", "ro", undefined, defaults)).toBe(false);
    expect(isIgnored("nmos", "ro", { ignore: { ro: false } }, defaults)).toBe(
      false,
    );
    expect(isIgnored("resistor", "open", undefined, defaults)).toBe(false);
  });

  it("stores a part's choice only where it differs from the default", () => {
    const defaults = { nmos: ["ro" as const] };
    const kept = withTerms({}, "m1", "nmos", ["ro"], false, defaults);
    expect(kept.m1).toEqual({ ignore: { ro: false } });
    const back = withTerms(kept, "m1", "nmos", ["ro"], true, defaults);
    expect(back.m1).toEqual({ ignore: {} });
    expect(
      withTerms({}, "m1", "nmos", ["rbs", "rbd"], true, defaults).m1,
    ).toEqual({ ignore: { rbs: true, rbd: true } });
  });

  it("a passive is open or shorted, never both", () => {
    const open = withTerms({}, "r1", "resistor", ["open"], true, {});
    const short = withTerms(open, "r1", "resistor", ["short"], true, {});
    expect(short.r1).toEqual({ ignore: { short: true } });
    expect(
      withTerms(short, "r1", "resistor", ["open", "short"], false, {}).r1,
    ).toEqual({ ignore: {} });
  });

  it("a type default applies to every member, clearing their own choices", () => {
    const parts = {
      m1: { ignore: { ro: false, gmb: true } },
      m2: { ignore: { ro: true } },
    };
    const next = withDefault({ npn: ["rpi"] }, parts, "nmos", ["ro"], true, [
      "m1",
      "m2",
    ]);
    expect(next.defaults).toEqual({ npn: ["rpi"], nmos: ["ro"] });
    expect(next.parts).toEqual({
      m1: { ignore: { gmb: true } },
      m2: { ignore: {} },
    });
    const off = withDefault(
      next.defaults,
      next.parts,
      "nmos",
      ["ro"],
      false,
      [],
    );
    expect(off.defaults).toEqual({ npn: ["rpi"] });
  });

  it("sets and clears an expected region", () => {
    const set = withRegion(
      { m1: { ignore: { ro: true } } },
      ["m1", "m2"],
      "triode",
    );
    expect(set).toEqual({
      m1: { ignore: { ro: true }, region: "triode" },
      m2: { region: "triode" },
    });
    expect(withRegion(set, ["m1"], null).m1).toEqual({ ignore: { ro: true } });
  });
});

describe("assumptionRequest", () => {
  it("is null with nothing assumed", () => {
    expect(assumptionRequest(ELEMENTS, {}, {})).toBeNull();
  });

  it("names parts as the netlist does, defaults and own choices merged", () => {
    const request = assumptionRequest(
      ELEMENTS,
      { nmos: ["ro"], npn: ["rpi"] },
      {
        m1: { ignore: { ro: false, gmb: true }, region: "triode" },
        "x1/m2": { region: "forward-active" },
        r1: { ignore: { short: true } },
        v1: { ignore: { open: true } },
      },
    );
    expect(request).toEqual({
      ignore: [
        { element: "M1", term: "gmb" },
        { element: "M2_X1", term: "ro" },
        { element: "Q1", term: "rpi" },
        { element: "R1", term: "short" },
      ],
      // A BJT region on a MOSFET is never sent.
      regions: [{ element: "M1", region: "triode" }],
    });
  });
});
