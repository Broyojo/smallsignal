// The browser Agent runtime (its hosts, session and the Agent adapter) is a
// separate chunk, absent from the editor's first load (#1673). It loads
// when a page needs the Agent at once (a saved session to resume,
// automation pairing) or when a person asks for a connection.
import { agentPairingRequested } from "./headless-pairing";
import { PUBLIC_AGENT_UI_ENABLED } from "./public-agent-ui";
import { hasAgentSessionRecovery } from "./session-recovery-presence";

export type AgentRuntime = typeof import("./agent-runtime");

let loaded: AgentRuntime | null = null;
let loading: Promise<AgentRuntime> | null = null;

/** The runtime, once a load has finished; a provider reads it as it mounts. */
export function loadedAgentRuntime(): AgentRuntime | null {
  return loaded;
}

/** Loads the runtime once; a failed load is retried by the next request. */
export function loadAgentRuntime(): Promise<AgentRuntime> {
  loading ??= import("./agent-runtime").then(
    (module) => (loaded = module),
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/**
 * Whether this page needs the Agent as it opens: a saved session to resume,
 * or automation pairing with `?agent=pair` (#1523). Every other connection
 * starts from Connect Agent.
 */
export function agentRuntimeNeededOnLoad(
  page: Pick<Window, "location" | "sessionStorage"> = window,
): boolean {
  if (agentPairingRequested(page.location.search)) return true;
  try {
    return hasAgentSessionRecovery(page.sessionStorage);
  } catch {
    // Storage the page may not read holds no session to resume.
    return false;
  }
}

/** Starts the load as a page opens, on a page that offers Agent connections. */
export function loadAgentRuntimeNeededOnLoad(): Promise<AgentRuntime> | null {
  return PUBLIC_AGENT_UI_ENABLED && agentRuntimeNeededOnLoad()
    ? loadAgentRuntime()
    : null;
}
