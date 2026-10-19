import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseProject } from "@icm/project-protocol";
import {
  fieldEdit,
  partFields,
  type PartField,
} from "./small-signal-part-fields";
import { parseSpiceNumber } from "./small-signal-panel";

const project = parseProject(
  readFileSync(
    new URL(
      "../../../../../packages/small-signal/test-fixtures/cs-vdd-pin-wired.icproj.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const top = project.topDocumentId;
const readable = (text: string) => parseSpiceNumber(text) !== null;

describe("a part's values in its menu", () => {
  it("lists the values the netlist reads, as drawn, with units", () => {
    expect(partFields(project, top, "r1")).toEqual([
      expect.objectContaining({ name: "value", unit: "Ω", value: "10k" }),
    ]);
    expect(partFields(project, top, "m1").map((field) => field.name)).toEqual([
      "w",
      "l",
      "m",
    ]);
    // A bare W is microns here: no metre unit beside it.
    expect(partFields(project, top, "m1")[0]?.unit).toBe("");
    expect(partFields(project, top, "v1").map((field) => field.name)).toEqual([
      "dc",
    ]);
    expect(partFields(project, top, "gnd1")).toEqual([]);
  });

  it("sets a number, clears an optional value, refuses the rest", () => {
    const value = partFields(project, top, "r1")[0] as PartField;
    expect(fieldEdit(value, " 20k ", readable)).toEqual({
      set: { value: "20k" },
    });
    expect(fieldEdit(value, "10k", readable)).toBeNull();
    expect(fieldEdit(value, "k10", readable)).toBeNull();
    // Required: an empty value is no edit, not a part with no resistance.
    expect(fieldEdit(value, "", readable)).toBeNull();
    // A Cell parameter passes as written.
    expect(fieldEdit(value, "{rload}", readable)).toEqual({
      set: { value: "{rload}" },
    });
    const m = partFields(project, top, "m1").find(
      (field) => field.name === "m",
    ) as PartField;
    expect(fieldEdit({ ...m, value: "2" }, "", readable)).toEqual({
      unset: ["m"],
    });
  });
});
