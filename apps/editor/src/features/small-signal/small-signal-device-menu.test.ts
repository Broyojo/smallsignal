import { describe, expect, it } from "vitest";
import type { AssumableElement, RegionReport } from "@icm/small-signal";
import { partKey } from "./small-signal-assumption-store";
import { menuPlacement, termText } from "./small-signal-device-menu";
import {
  anyAssumed,
  assumptionColumnChange,
  assumptionRows,
  deviceBadge,
  deviceMenuModel,
  passiveChange,
  regionNote,
} from "./small-signal-panel";

const NONE = { defaults: {}, parts: {} };
const assumable: AssumableElement[] = [
  {
    element: "M1",
    type: "nmos",
    terms: ["ro", "gmb", "rbs", "rbd", "cgs", "cgd"],
    miller: ["cgd"],
  },
  {
    element: "M2",
    type: "nmos",
    terms: ["ro", "gmb", "rbs", "rbd", "cgs", "cgd"],
    miller: ["cgd"],
  },
  { element: "M3", type: "pmos", terms: ["ro", "rbd"], miller: [] },
  {
    element: "CC",
    type: "capacitor",
    terms: ["open", "short"],
    miller: [null],
  },
  { element: "D1", type: "diode", terms: ["open", "short", "cj"], miller: [] },
  { element: "Q1", type: "npn", terms: ["ro", "rpi", "rmu"], miller: [] },
];
const elements = [
  { name: "M1", instancePath: ["m1"], kind: "nmos" as const },
  { name: "M2", instancePath: ["m2"], kind: "nmos" as const },
  { name: "M3", instancePath: ["m3"], kind: "pmos" as const },
  { name: "CC", instancePath: ["cc"], kind: "capacitor" as const },
  { name: "D1", instancePath: ["d1"], kind: "diode" as const },
  { name: "Q1", instancePath: ["q1"], kind: "npn" as const },
];
const rowOf = (
  label: string,
  choices = NONE as Parameters<typeof assumptionRows>[3],
  groups: string[][] = [],
) => {
  const row = assumptionRows(assumable, elements, groups, choices).find(
    (candidate) => candidate.label === label,
  );
  if (!row) throw new Error(`no row ${label}`);
  return row;
};

describe("device menu model", () => {
  it("offers what the solver lists, leakage as one, a MOSFET's region", () => {
    const model = deviceMenuModel(rowOf("M1"), "M1", NONE);
    expect(model.neglect.map((item) => item.id)).toEqual([
      "ro",
      "gmb",
      "leakage",
      "cgs",
      "cgd",
    ]);
    expect(model.miller).toEqual([{ term: "cgd", on: false, mixed: false }]);
    expect(model.region).toBe("");
    expect(model.passive).toBeNull();
    expect(model.typeLabel).toBe("NMOS");
    // A BJT has no region to impose.
    expect(deviceMenuModel(rowOf("Q1"), "Q1", NONE).region).toBeNull();
  });

  it("a type default shows as inherited, the part's own choice does not", () => {
    const choices = { defaults: { nmos: ["ro" as const] }, parts: {} };
    const ro = deviceMenuModel(rowOf("M1", choices), "M1", choices).neglect[0];
    expect(ro).toMatchObject({ id: "ro", on: true, inherited: true });
    const own = {
      defaults: {},
      parts: { [partKey(["m1"])]: { ignore: { ro: true } } },
    };
    expect(
      deviceMenuModel(rowOf("M1", own), "M1", own).neglect[0],
    ).toMatchObject({ on: true, inherited: false });
  });

  it("a matched group says so, and a change applies to every member", () => {
    const row = rowOf("M1 = M2", NONE, [["M1", "M2"]]);
    const model = deviceMenuModel(row, "M2", NONE);
    expect(model.matchedWith).toEqual(["M1"]);
    const change = assumptionColumnChange(row, "ro", true, NONE);
    expect(change.parts?.[partKey(["m1"])]?.ignore?.ro).toBe(true);
    expect(change.parts?.[partKey(["m2"])]?.ignore?.ro).toBe(true);
  });

  it("a capacitor offers open, short and Miller; a diode open, short and C_j", () => {
    const cc = deviceMenuModel(rowOf("CC"), "CC", NONE);
    expect(cc.passive).toEqual({
      value: "",
      options: ["", "open", "short", "miller"],
    });
    expect(cc.neglect).toEqual([]);
    const d1 = deviceMenuModel(rowOf("D1"), "D1", NONE);
    expect(d1.passive?.options).toEqual(["", "open", "short"]);
    expect(d1.neglect.map((item) => item.id)).toEqual(["cj"]);
    // Choosing one replaces the other.
    const path = partKey(["cc"]);
    const open = passiveChange({}, path, "capacitor", "open", {});
    expect(open[path]?.ignore).toEqual({ open: true });
    const miller = passiveChange(open, path, "capacitor", "miller", {});
    expect(miller[path]).toEqual({ ignore: {}, miller: [null] });
    const choices = { defaults: {}, parts: miller };
    expect(
      deviceMenuModel(rowOf("CC", choices), "CC", choices).passive?.value,
    ).toBe("miller");
  });
});

describe("canvas badges", () => {
  const member = (label: string) => rowOf(label).members[0]!;
  it("none without a choice, else the region, the passive choice or ≈", () => {
    expect(deviceBadge(member("M1"), NONE, undefined)).toBeNull();
    const parts = {
      [partKey(["m1"])]: {
        ignore: { ro: true },
        region: "saturation" as const,
      },
      [partKey(["cc"])]: { ignore: { open: true } },
      [partKey(["m3"])]: { ignore: { ro: true } },
    };
    const choices = { defaults: {}, parts };
    const report: RegionReport = {
      element: "M1",
      assumed: "saturation",
      actual: "triode",
      effect: "imposed",
      linearized: { gm: 1e-3, gds: 1e-5, gmb: 0 },
    };
    expect(deviceBadge(member("M1"), choices, report)).toEqual({
      instanceId: "m1",
      element: "M1",
      text: "sat",
      description: "M1: saturation assumed, r_o neglected",
      warn: true,
    });
    expect(deviceBadge(member("CC"), choices, undefined)).toMatchObject({
      text: "open",
      warn: false,
    });
    expect(deviceBadge(member("M3"), choices, undefined)).toMatchObject({
      text: "≈",
      description: "M3: r_o neglected",
    });
    // The bias's own region: no warning.
    expect(
      deviceBadge(member("M1"), choices, { ...report, effect: "same" })?.warn,
    ).toBe(false);
  });
});

describe("region labels", () => {
  const imposed = (element: string, assumed: string): RegionReport => ({
    element,
    assumed,
    actual: "triode",
    effect: "imposed",
  });
  it("names imposed regions that differ from the bias, by region", () => {
    expect(regionNote(undefined)).toBeNull();
    expect(
      regionNote([imposed("M1", "saturation"), imposed("M3", "saturation")]),
    ).toBe("M1, M3 assumed saturated");
    // Without a bias, or where it agrees, nothing to say.
    expect(
      regionNote([
        { ...imposed("M1", "saturation"), actual: null },
        { ...imposed("M2", "triode"), effect: "same" },
      ]),
    ).toBeNull();
  });

  it("an imposed region alone makes the forms the assumed model's", () => {
    const report = { applied: [], absent: [], miller: [] };
    expect(anyAssumed({ ...report, regions: [] })).toBe(false);
    expect(
      anyAssumed({ ...report, regions: [imposed("M1", "saturation")] }),
    ).toBe(true);
    expect(
      anyAssumed({
        ...report,
        regions: [{ ...imposed("M1", "triode"), effect: "refused" }],
      }),
    ).toBe(false);
    // Without a bias the region already shaped the full model's forms.
    expect(
      anyAssumed({
        ...report,
        regions: [{ ...imposed("M1", "triode"), actual: null }],
      }),
    ).toBe(false);
  });

  it("writes terms as the equations do", () => {
    expect(["ro", "gmb", "cgd", "cbd", "cmu", "leakage"].map(termText)).toEqual(
      ["r_o", "g_mb", "C_gd", "C_db", "C_μ", "leakage"],
    );
  });
});

describe("menu placement", () => {
  const bounds = { left: 0, top: 0, right: 1000, bottom: 800 };
  const size = { width: 260, height: 300 };
  it("beside the part, on the side with room, kept on screen", () => {
    const part = { left: 100, top: 100, right: 140, bottom: 160 };
    expect(menuPlacement(part, size, bounds)).toEqual({ left: 150, top: 100 });
    const nearRight = { left: 800, top: 100, right: 840, bottom: 160 };
    expect(menuPlacement(nearRight, size, bounds)).toEqual({
      left: 530,
      top: 100,
    });
    const low = { left: 100, top: 700, right: 140, bottom: 760 };
    expect(menuPlacement(low, size, bounds).top).toBe(492);
    // No room either side: inside the bounds anyway.
    const wide = { left: 20, top: 10, right: 980, bottom: 60 };
    const at = menuPlacement(wide, size, bounds);
    expect(at.left).toBeGreaterThanOrEqual(8);
    expect(at.left + size.width).toBeLessThanOrEqual(992);
    expect(at.top).toBe(10);
  });
});
