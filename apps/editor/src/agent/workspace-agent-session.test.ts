import { describe, expect, it, vi } from "vitest";
import type { UseAgentSessionResult } from "./use-agent-session";
import { workspaceAgentSession } from "./workspace-agent-session";

const callbacks = () => ({
  requestConnection: vi.fn(async () => {}),
  cancelConnection: vi.fn(async () => {}),
});

function runtimeSession(
  patch: Partial<UseAgentSessionResult> = {},
): UseAgentSessionResult {
  return {
    pendingOperation: null,
    status: "idle",
    claimCode: null,
    claimExpiresAt: null,
    scopes: [],
    expiresAt: null,
    expiringSoon: false,
    error: null,
    backgroundRequests: false,
    transportDiagnostics: [],
    pause: async () => {},
    resume: async () => {},
    keepConnected: () => {},
    reconnect: () => {},
    newConnection: async () => {},
    revoke: async () => {},
    ...patch,
  };
}

describe("workspace Agent session before the runtime loads (#1673)", () => {
  it("is not connected, and Connect asks for the runtime", async () => {
    const { requestConnection, cancelConnection } = callbacks();
    const session = workspaceAgentSession({
      published: null,
      connectRequested: false,
      loadError: null,
      requestConnection,
      cancelConnection,
    });
    expect(session).toMatchObject({
      status: "idle",
      pendingOperation: null,
      claimCode: null,
      scopes: [],
      error: null,
    });
    await session.newConnection();
    expect(requestConnection).toHaveBeenCalledOnce();
    // Nothing is connected, so the session controls change nothing.
    await session.revoke();
    await session.pause();
    expect(cancelConnection).not.toHaveBeenCalled();
  });

  it("shows a requested connection as one being prepared, which cancels", async () => {
    const { requestConnection, cancelConnection } = callbacks();
    const session = workspaceAgentSession({
      published: null,
      connectRequested: true,
      loadError: null,
      requestConnection,
      cancelConnection,
    });
    expect(session.status).toBe("idle");
    expect(session.pendingOperation).toBe("creating");
    await session.revoke();
    expect(cancelConnection).toHaveBeenCalledOnce();
  });

  it("reports a runtime that could not load", () => {
    const session = workspaceAgentSession({
      published: null,
      connectRequested: false,
      loadError: "The Agent connection could not load",
      ...callbacks(),
    });
    expect(session.error).toBe("The Agent connection could not load");
    expect(session.status).toBe("idle");
  });
});

describe("workspace Agent session once the runtime loads (#1673)", () => {
  it("is the runtime's session itself", () => {
    const published = runtimeSession({ status: "connected" });
    expect(
      workspaceAgentSession({
        published,
        connectRequested: false,
        loadError: "an earlier failure",
        ...callbacks(),
      }),
    ).toBe(published);
  });

  it("stays in preparation until the requested connection starts", () => {
    const { requestConnection, cancelConnection } = callbacks();
    const published = runtimeSession();
    const waiting = workspaceAgentSession({
      published,
      connectRequested: true,
      loadError: null,
      requestConnection,
      cancelConnection,
    });
    expect(waiting.pendingOperation).toBe("creating");
    expect(waiting.newConnection).toBe(published.newConnection);
    expect(waiting.revoke).toBe(cancelConnection);
    const started = workspaceAgentSession({
      published: runtimeSession({ pendingOperation: "creating" }),
      connectRequested: true,
      loadError: null,
      requestConnection,
      cancelConnection,
    });
    expect(started.pendingOperation).toBe("creating");
  });
});
