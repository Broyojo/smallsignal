import { describe, expect, it } from "vitest";
import {
  formatPlain,
  preferredOutput,
  signalLabel,
} from "./small-signal-panel";

describe("formatPlain", () => {
  it("writes gains as plain numbers, never with SI prefixes", () => {
    expect(formatPlain(-3.8462)).toBe("-3.846");
    expect(formatPlain(1)).toBe("1");
    expect(formatPlain(-8.481e-31)).toBe("-8.481e-31");
    expect(formatPlain(2.5e7)).toBe("2.500e+7");
    expect(formatPlain(0)).toBe("0");
  });
});

describe("signalLabel", () => {
  it("drops a leading v/i from net and source names", () => {
    expect(signalLabel("v", "Vout")).toBe("v_{out}");
    expect(signalLabel("v", "out")).toBe("v_{out}");
    expect(signalLabel("v", "V1")).toBe("v_{1}");
    expect(signalLabel("i", "IIN")).toBe("i_{IN}");
    expect(signalLabel("v", "v")).toBe("v_{v}");
  });

  it("escapes underscores for TeX", () => {
    expect(signalLabel("v", "out_DUT")).toBe("v_{out\\_DUT}");
  });
});

describe("preferredOutput", () => {
  it("never defaults to a supply rail", () => {
    // The drawing that picked VDD: drain net named Vinp, VDD from a symbol.
    expect(
      preferredOutput(["0", "VDD", "Vinp", "net0"], new Set(["net0", "0"]), [
        "VDD",
      ]),
    ).toBe("Vinp");
  });

  it("prefers a net named like an output", () => {
    expect(
      preferredOutput(["0", "a", "vout", "vdd"], new Set(["vdd"]), []),
    ).toBe("vout");
  });
});
