import { describe, expect, it } from "vitest";
import type { SmallSignalElement } from "@icm/small-signal";
import {
  MAX_STORED_CIRCUITS,
  assumptionRequest,
  circuitStorageKey,
  isIgnored,
  isMiller,
  partKey,
  readCircuits,
  readDefaults,
  storeCircuit,
  touchCircuit,
  withDefault,
  withMiller,
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
    expect(partKey(["x1", "m2"])).toBe('["x1","m2"]');
  });

  it("never gives two instance paths one key, whatever their ids hold", () => {
    expect(partKey(["a/b", "c"])).not.toBe(partKey(["a", "b/c"]));
    expect(partKey(['a","b'])).not.toBe(partKey(["a", "b"]));
  });

  it("reads a key stored as joined ids only where it cannot be ambiguous", () => {
    const stored = {
      k: {
        used: 1,
        parts: {
          m1: { region: "triode" },
          "x1/m2": { region: "triode" },
          '["x1","m3"]': { region: "triode" },
          "[1]": { region: "triode" },
        },
      },
    };
    expect(Object.keys(readCircuits(JSON.stringify(stored)).k!.parts)).toEqual([
      partKey(["m1"]),
      partKey(["x1", "m3"]),
    ]);
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
          // Only checked by the solver: no longer offered, so dropped.
          m3: { region: "cutoff" },
          q1: { region: "forward-active" },
          r1: { ignore: { open: true, short: true } },
        },
      },
      b: { used: "5", parts: { m1: { ignore: { ro: true } } } },
      c: { used: 1, parts: [] },
    };
    expect(readCircuits(JSON.stringify(stored))).toEqual({
      a: {
        used: 5,
        parts: {
          [partKey(["m1"])]: { ignore: { ro: true }, region: "triode" },
        },
      },
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

  it("a Miller split excludes neglecting, opening or shorting the capacitance", () => {
    const defaults = { nmos: ["cgd" as const] };
    // Split: kept whatever the default, and sent as a split.
    const split = withMiller({}, "m1", "cgd", true);
    expect(split.m1).toEqual({ ignore: {}, miller: ["cgd"] });
    expect(isMiller("cgd", split.m1)).toBe(true);
    expect(isIgnored("nmos", "cgd", split.m1, defaults)).toBe(false);
    // Neglected again: the split ends.
    const neglected = withTerms(split, "m1", "nmos", ["cgd"], true, defaults);
    expect(neglected.m1).toEqual({ ignore: {} });
    expect(isIgnored("nmos", "cgd", neglected.m1, defaults)).toBe(true);
    // A capacitor: Miller, open or short, one at a time.
    const open = withTerms({}, "c1", "capacitor", ["open"], true, {});
    const miller = withMiller(open, "c1", null, true);
    expect(miller.c1).toEqual({ ignore: {}, miller: [null] });
    expect(isIgnored("capacitor", "open", miller.c1, {})).toBe(false);
    expect(
      withTerms(miller, "c1", "capacitor", ["short"], true, {}).c1,
    ).toEqual({ ignore: { short: true } });
    expect(withMiller(miller, "c1", null, false).c1).toEqual({ ignore: {} });
    // A type default that neglects the term ends each part's split of it.
    const all = withDefault({}, split, "nmos", ["cgd"], true, ["m1"]);
    expect(all.parts.m1).toEqual({ ignore: {} });
    expect(
      withDefault({}, split, "nmos", ["cgd"], false, ["m1"]).parts.m1,
    ).toEqual({ ignore: {}, miller: ["cgd"] });
  });

  it("sets and clears an assumed region", () => {
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
        [partKey(["m1"])]: {
          ignore: { ro: false, gmb: true },
          region: "triode",
        },
        [partKey(["q1"])]: { region: "saturation" },
        [partKey(["r1"])]: { ignore: { short: true } },
        [partKey(["v1"])]: { ignore: { open: true } },
      },
    );
    expect(request).toEqual({
      ignore: [
        { element: "M1", term: "gmb" },
        { element: "M2_X1", term: "ro" },
        { element: "Q1", term: "rpi" },
        { element: "R1", term: "short" },
      ],
      // Only a MOSFET's region is sent: the solver imposes no other.
      regions: [{ element: "M1", region: "triode" }],
    });
  });

  it("sends Miller splits, a capacitor's without a term, and never neglects one", () => {
    const elements: SmallSignalElement[] = [
      ...ELEMENTS,
      { name: "CC", instancePath: ["cc"], kind: "capacitor" },
    ];
    const request = assumptionRequest(
      elements,
      { nmos: ["cgd"] },
      {
        [partKey(["m1"])]: { miller: ["cgd"] },
        [partKey(["cc"])]: { miller: [null] },
        // Not a capacitance of a BJT, nor a resistor's own: never sent.
        [partKey(["q1"])]: { miller: ["cgd"] },
        [partKey(["r1"])]: { miller: [null] },
      },
    );
    expect(request).toEqual({
      ignore: [{ element: "M2_X1", term: "cgd" }],
      miller: [{ element: "M1", term: "cgd" }, { element: "CC" }],
    });
  });
});

describe("Miller splits the solver no longer offers", () => {
  const elements: SmallSignalElement[] = [
    { name: "M1", instancePath: ["m1"], kind: "nmos" },
    { name: "CC", instancePath: ["cc"], kind: "capacitor" },
  ];
  const parts = {
    [partKey(["m1"])]: { miller: ["cgd" as const] },
    [partKey(["cc"])]: { miller: [null] },
  };
  const offered = (cc: (null | "cgd")[], m1: ("cgd" | null)[]) => [
    { element: "CC", type: "capacitor" as const, terms: [], miller: cc },
    {
      element: "M1",
      type: "nmos" as const,
      terms: ["cgd" as const],
      miller: m1 as "cgd"[],
    },
  ];

  it("are not sent, and the part acts as without them", () => {
    // CC now ends at ground, M1's C_gd at a supply: neither is offered.
    expect(
      assumptionRequest(elements, { nmos: ["cgd"] }, parts, offered([], [])),
    ).toEqual({ ignore: [{ element: "M1", term: "cgd" }] });
    expect(assumptionRequest(elements, {}, parts, offered([null], []))).toEqual(
      { miller: [{ element: "CC" }] },
    );
  });

  it("are sent while offered, or before the circuit has an answer", () => {
    const both = {
      miller: [{ element: "M1", term: "cgd" }, { element: "CC" }],
    };
    expect(
      assumptionRequest(elements, {}, parts, offered([null], ["cgd"])),
    ).toEqual(both);
    expect(assumptionRequest(elements, {}, parts)).toEqual(both);
    expect(assumptionRequest(elements, {}, parts, null)).toEqual(both);
  });
});

describe("Miller splits in storage", () => {
  it("keeps known splits, drops unknown ones and those the part also neglects", () => {
    const stored = {
      k: {
        used: 1,
        parts: {
          '["m1"]': { miller: ["cgd", "cgd", "cmu", "ro", 3] },
          '["m2"]': { ignore: { cgd: true }, miller: ["cgd"] },
          '["c1"]': { ignore: { open: true }, miller: [null] },
          '["c2"]': { miller: [null] },
          '["c3"]': { miller: "cgd" },
        },
      },
    };
    expect(readCircuits(JSON.stringify(stored)).k!.parts).toEqual({
      '["m1"]': { miller: ["cgd", "cmu"] },
      '["m2"]': { ignore: { cgd: true } },
      '["c1"]': { ignore: { open: true } },
      '["c2"]': { miller: [null] },
    });
  });

  it("a part with only a split is stored, and one without is dropped", () => {
    const key = circuitStorageKey("p", "main");
    const next = storeCircuit(
      {},
      key,
      { '["c1"]': { miller: [null] }, '["c2"]': { ignore: {}, miller: [] } },
      5,
    );
    expect(next[key]!.parts).toEqual({ '["c1"]': { miller: [null] } });
  });
});
