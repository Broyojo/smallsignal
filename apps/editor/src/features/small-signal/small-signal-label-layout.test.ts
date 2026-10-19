import { describe, expect, it } from "vitest";
import {
  devicePlaces,
  placeLabels,
  wirePlaces,
} from "./small-signal-label-layout";

const size = { width: 40, height: 17 };

describe("operating-point labels on the drawing", () => {
  it("takes the first free place, moves one that would cover another, drops one with none", () => {
    const part = { left: 100, top: 100, right: 120, bottom: 130 };
    const places = devicePlaces(part, size);
    const placed = placeLabels([
      { id: "a", ...size, places },
      { id: "b", ...size, places },
      { id: "c", ...size, places: places.slice(0, 1) },
    ]);
    expect(placed.get("a")).toMatchObject(places[0]!);
    expect(placed.get("b")).toMatchObject(places[1]!);
    expect(placed.has("c")).toBe(false);
  });

  it("keeps off the drawing's own text and badges", () => {
    const at = { x: 200, y: 50, vertical: false };
    const [under, above] = wirePlaces(at, size);
    const placed = placeLabels(
      [{ id: "v", ...size, places: [under!, above!] }],
      [{ left: 190, top: 55, width: 30, height: 12 }],
    );
    expect(placed.get("v")).toMatchObject(above!);
  });
});
