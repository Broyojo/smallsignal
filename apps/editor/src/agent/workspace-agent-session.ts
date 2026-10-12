import type { UseAgentSessionResult } from "./use-agent-session";

async function nothing(): Promise<void> {}
function ignore(): void {}

/**
 * The workspace's Agent session as the page sees it (#1673). Once the Agent
 * runtime has loaded and published its session, that session. Before then,
 * "not connected", and its Connect asks for the runtime. A connection
 * asked for but not yet started shows as one being prepared; cancelling it
 * then leaves nothing to revoke.
 */
export function workspaceAgentSession({
  published,
  connectRequested,
  loadError,
  requestConnection,
  cancelConnection,
}: {
  published: UseAgentSessionResult | null;
  connectRequested: boolean;
  /** Why the runtime could not load, shown until Connect is tried again. */
  loadError: string | null;
  requestConnection: () => Promise<void>;
  cancelConnection: () => Promise<void>;
}): UseAgentSessionResult {
  if (published && !connectRequested) return published;
  const base: UseAgentSessionResult = published ?? {
    pendingOperation: null,
    status: "idle",
    claimCode: null,
    claimExpiresAt: null,
    scopes: [],
    expiresAt: null,
    expiringSoon: false,
    error: loadError,
    backgroundRequests: false,
    transportDiagnostics: [],
    pause: nothing,
    resume: nothing,
    keepConnected: ignore,
    reconnect: ignore,
    newConnection: requestConnection,
    revoke: nothing,
  };
  return connectRequested
    ? {
        ...base,
        pendingOperation: base.pendingOperation ?? "creating",
        revoke: cancelConnection,
      }
    : base;
}
