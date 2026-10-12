import { describe, expect, it } from "vitest";
import { agentRuntimeNeededOnLoad } from "./agent-runtime-loader";
import { AGENT_SESSION_RECOVERY_STORAGE_KEY } from "./session-recovery-presence";

function page(search: string, saved: unknown = null) {
  const values = new Map<string, string>();
  if (saved !== null)
    values.set(AGENT_SESSION_RECOVERY_STORAGE_KEY, JSON.stringify(saved));
  return {
    location: { search } as Location,
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
    } as Storage,
  };
}

const savedSession = {
  version: 1,
  sessionId: "session-1",
  editorSecret: "editor-secret",
  projectId: "project-main",
  projectSessionId: "project-main:1",
  scopes: ["circuit.snapshot"],
  expiresAt: 2_000,
};

describe("Agent runtime on page load (#1673)", () => {
  it("is not needed by an ordinary editor visit", () => {
    expect(agentRuntimeNeededOnLoad(page(""))).toBe(false);
    expect(agentRuntimeNeededOnLoad(page("?agent=other"))).toBe(false);
  });

  it("is needed to resume a saved session", () => {
    expect(agentRuntimeNeededOnLoad(page("", savedSession))).toBe(true);
    expect(agentRuntimeNeededOnLoad(page("", { version: 2 }))).toBe(false);
  });

  it("is needed for automation pairing", () => {
    expect(agentRuntimeNeededOnLoad(page("?agent=pair"))).toBe(true);
  });

  it("is not needed when the page cannot read its session storage", () => {
    const blocked = {
      location: { search: "" } as Location,
      get sessionStorage(): Storage {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    expect(agentRuntimeNeededOnLoad(blocked)).toBe(false);
  });
});
