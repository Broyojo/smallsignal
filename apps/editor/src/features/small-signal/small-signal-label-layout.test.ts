import { describe, expect, it } from "vitest";
import {
  badgePlaces,
  devicePlaces,
  leaderLine,
  placeLabels,
  wirePlaces,
} from "./small-signal-label-layout";

const size = { width: 40, height: 17 };

describe("labels on the drawing", () => {
  it("takes the first free place, moves one that would cover another, drops one with none", () => {
    const part = { left: 100, top: 100, right: 120, bottom: 130 };
    const places = devicePlaces(part, size);
    const placed = placeLabels([
      { id: "a", ...size, places },
      { id: "b", ...size, places },
      { id: "c", ...size, places: places.slice(0, 1) },
    ]);
    expect(placed.get("a")).toMatchObject(places[0]!);
    // The right side's top corner overlaps the first: its left side.
    expect(placed.get("b")).toMatchObject(places[2]!);
    expect(placed.has("c")).toBe(false);
  });

  it("sets a part's label against it, touching its own part but no other", () => {
    const part = { left: 100, top: 100, right: 120, bottom: 130 };
    const target = { left: 100, top: 100, width: 20, height: 30 };
    const other = { id: "M2", left: 123, top: 90, width: 30, height: 50 };
    const placed = placeLabels(
      [
        {
          id: "M1",
          ...size,
          target,
          own: "M1",
          places: devicePlaces(part, size),
        },
      ],
      [{ id: "M1", ...target }, other],
    ).get("M1")!;
    // Not right (M2 is there): its left side, flush with the part.
    expect(placed.left + placed.width).toBe(98);
    expect(placed.leader).toBe(false);
  });

  it("puts a node voltage on its wire, clear of the ends, and off it with a leader when the wire is taken", () => {
    const a = { x: 0, y: 50 };
    const b = { x: 200, y: 50 };
    const { on, off } = wirePlaces(a, b, size);
    // Centred on the wire, the middle first.
    expect(on[0]).toMatchObject({ left: 80, top: 50 - 8.5 });
    for (const place of on) {
      expect(place.left).toBeGreaterThanOrEqual(6);
      expect(place.left + 40).toBeLessThanOrEqual(194);
    }
    const placed = placeLabels(
      [{ id: "v", ...size, places: [...on, ...off] }],
      // The drawing's text over the whole wire.
      [{ left: -10, top: 40, width: 220, height: 20 }],
    ).get("v")!;
    expect(placed.leader).toBe(true);
    const [from, to] = leaderLine(placed, placed.target);
    expect(to).toEqual({ x: 100, y: 50 });
    expect(from.y === placed.top || from.y === placed.top + 17).toBe(true);
  });

  it("has no place on a wire too short for the label", () => {
    expect(wirePlaces({ x: 0, y: 0 }, { x: 0, y: 20 }, size).on).toEqual([]);
  });

  it("moves a badge off another badge, and keeps one with no free place at its corner", () => {
    const part = { left: 100, top: 100, right: 120, bottom: 130 };
    const target = { left: 100, top: 100, width: 20, height: 30 };
    const places = badgePlaces(part, size);
    const placed = placeLabels([
      { id: "a", ...size, target, force: true, places },
      { id: "b", ...size, target, force: true, places },
      { id: "c", ...size, target, force: true, places: places.slice(0, 1) },
    ]);
    expect(placed.get("a")).toMatchObject(places[0]!);
    // Its part is narrower than two badges: past the part's top left.
    expect(placed.get("b")).toMatchObject(places[3]!);
    expect(placed.get("c")).toMatchObject(places[0]!);
  });
});
