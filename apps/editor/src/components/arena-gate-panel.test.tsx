import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ArenaGateView } from "./arena-gate-panel";
import type { ArenaGateState } from "./arena-gate";

/** The dialog's markup, read with a few small queries: no DOM is needed. */
function render(
  state: ArenaGateState,
  { required = 5, saved = true }: { required?: number; saved?: boolean } = {},
) {
  const markup = renderToStaticMarkup(
    <ArenaGateView
      state={state}
      required={required}
      saved={saved}
      nudged={false}
      onClose={() => {}}
    />,
  );
  const attribute = (tag: string, name: string) =>
    new RegExp(`\\s${name}="([^"]*)"`, "u").exec(tag)?.[1] ?? null;
  const dots = /data-testid="arena-gate-count">(.*?)<\/div>/u.exec(markup)?.[1];
  return {
    attribute,
    frame: /<iframe[^>]*>/u.exec(markup)?.[0] ?? "",
    title: /<h2[^>]*>(.*?)<\/h2>/u.exec(markup)?.[1],
    /** Each dot shown, filled or not; null without the progress row. */
    dots: dots
      ? [...dots.matchAll(/<span aria-hidden="true"([^>]*)>/gu)].map((dot) =>
          dot[1]!.includes("data-filled"),
        )
      : null,
    spoken: /aria-live="polite">([^<]*)</u.exec(markup)?.[1],
    /** Each link and button: its text and aria-disabled. */
    controls: [...markup.matchAll(/<(a|button)([^>]*)>([^<]*)<\/\1>/gu)].map(
      (control) => [control[3], attribute(control[2]!, "aria-disabled")],
    ),
    links: [...markup.matchAll(/<a[^>]*>/gu)].map((link) =>
      attribute(link[0], "href"),
    ),
    text: markup.replace(/<[^>]*>/gu, " ").replaceAll("&#x27;", "'"),
  };
}

describe("the Arena gate's dialog (#1683)", () => {
  it("shows Chip Arena's animated Battle, taking no pointer or focus", () => {
    const { frame, attribute } = render({
      status: "voting",
      voted: 0,
      required: 5,
    });
    // Framed from chip-arena.com itself: Arena's code never runs on Analog
    // Canvas's origin.
    expect(attribute(frame, "src")).toBe(
      "https://chip-arena.com/schematic/preview",
    );
    expect(attribute(frame, "style")).toMatch(/pointer-events:\s*none/u);
    expect(attribute(frame, "tabindex")).toBe("-1");
    expect(attribute(frame, "aria-hidden")).toBe("true");
    expect(attribute(frame, "title")).toBe("A Battle in the Schematic Arena");
    expect(attribute(frame, "sandbox")).toBe("allow-scripts allow-same-origin");
    expect(attribute(frame, "referrerPolicy")).toBe("no-referrer");
  });

  it("holds the title, a dot per Vote asked for with the new ones filled, Start voting and Close", () => {
    const dialog = render({ status: "voting", voted: 2, required: 5 });
    expect(dialog.title).toBe("Vote on 5 Battles to continue");
    expect(dialog.dots).toEqual([true, true, false, false, false]);
    // Readers hear the count the dots show.
    expect(dialog.spoken).toBe("Voted 2 of 5");
    expect(dialog.controls).toEqual([
      ["Start voting →", null],
      ["Close", "true"],
    ]);
    expect(dialog.links).toEqual(["/schematic?from=canvas-gate"]);
    // At most one short line; the old sentence is gone.
    expect(dialog.text).toContain("Your work is saved.");
    expect(dialog.text).not.toMatch(/Close unlocks|to go|Your work is safe/u);
  });

  it("asks for fewer Votes when fewer Battles are left, and says nothing of a save on a shelf opening", () => {
    const dialog = render(
      { status: "voting", voted: 0, required: 1 },
      { required: 1, saved: false },
    );
    expect(dialog.title).toBe("Vote on 1 Battle to continue");
    expect(dialog.dots).toEqual([false]);
    expect(dialog.text).not.toContain("Your work is saved.");
  });

  it("unlocks at the last Vote, with Close and no Start voting", () => {
    const dialog = render({ status: "voting", voted: 5, required: 5 });
    expect(dialog.dots).toEqual([true, true, true, true, true]);
    expect(dialog.controls).toEqual([["Close", "false"]]);
  });

  it("says why only when it lets the person go before the Votes are in", () => {
    const dialog = render({ status: "free", reason: "unavailable" });
    expect(dialog.text).toContain("Arena can't be reached right now.");
    expect(dialog.dots).toBeNull();
    expect(dialog.controls).toEqual([["Close", "false"]]);
  });
});
