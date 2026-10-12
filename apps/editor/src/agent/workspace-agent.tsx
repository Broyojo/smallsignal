import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { importChunk } from "../components/chunk-import";
import {
  agentRuntimeNeededOnLoad,
  loadAgentRuntime,
  loadedAgentRuntime,
  type AgentRuntime,
} from "./agent-runtime-loader";
import {
  AgentPairing,
  agentPairingRequested,
  exposeAgentPairing,
} from "./headless-pairing";
import { PUBLIC_AGENT_UI_ENABLED } from "./public-agent-ui";
import { workspaceAgentSession } from "./workspace-agent-session";
import type {
  UseAgentSessionOptions,
  UseAgentSessionResult,
} from "./use-agent-session";

const WorkspaceAgent = /* @__PURE__ */ createContext<{
  session: UseAgentSessionResult;
  bind: (context: UseAgentSessionOptions | null) => void;
  /** Whether this page offers Agent connections at all. */
  enabled: boolean;
  /** The Agent runtime, once loaded; editors build their hosts from it. */
  runtime: AgentRuntime | null;
} | null>(null);

/** Connection owner above route-specific Editor hosts. No circuit is exposed in Gallery. */
export function WorkspaceAgentProvider({
  children,
  enabled = PUBLIC_AGENT_UI_ENABLED,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  return useContext(WorkspaceAgent) ? (
    children
  ) : (
    <WorkspaceAgentOwner enabled={enabled}>{children}</WorkspaceAgentOwner>
  );
}

/**
 * Owns the workspace's Agent connection without loading the Agent runtime
 * (#1673). Until the runtime loads, the connection is "not connected", and
 * Connect Agent loads it and connects once an editor is bound. A saved
 * session to resume, or automation pairing, loads it as the page opens.
 */
function WorkspaceAgentOwner({
  children,
  enabled,
}: {
  children: ReactNode;
  enabled: boolean;
}) {
  const [context, bind] = useState<UseAgentSessionOptions | null>(null);
  const [runtime, setRuntime] = useState(loadedAgentRuntime);
  const [neededOnLoad] = useState(
    () =>
      enabled && typeof window !== "undefined" && agentRuntimeNeededOnLoad(),
  );
  const [connectRequested, setConnectRequested] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [published, setPublished] = useState<UseAgentSessionResult | null>(
    null,
  );
  useEffect(() => {
    if (runtime || !(neededOnLoad || connectRequested)) return;
    let current = true;
    importChunk("The Agent connection", loadAgentRuntime).then(
      (module) => {
        if (current) setRuntime(module);
      },
      (error: unknown) => {
        if (!current) return;
        setConnectRequested(false);
        setLoadError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      current = false;
    };
  }, [connectRequested, neededOnLoad, runtime]);
  const onConnectStarted = useCallback(() => setConnectRequested(false), []);
  const requestConnection = useCallback(async () => {
    if (!enabled) return;
    setLoadError(null);
    setConnectRequested(true);
  }, [enabled]);
  const cancelConnection = useCallback(async () => {
    setConnectRequested(false);
  }, []);
  const session = useMemo(
    () =>
      workspaceAgentSession({
        published,
        connectRequested,
        loadError,
        requestConnection,
        cancelConnection,
      }),
    [
      cancelConnection,
      connectRequested,
      loadError,
      published,
      requestConnection,
    ],
  );
  return (
    <WorkspaceAgent.Provider value={{ session, bind, enabled, runtime }}>
      {children}
      {/* After the page, so its effects run after the editor's bind. */}
      {runtime ? (
        <runtime.AgentSessionRuntime
          context={context}
          enabled={enabled}
          connectRequested={connectRequested}
          onSession={setPublished}
          onConnectStarted={onConnectStarted}
        />
      ) : null}
    </WorkspaceAgent.Provider>
  );
}

/** The Agent runtime an editor builds its hosts from; null until it loads. */
export function useWorkspaceAgentRuntime(): AgentRuntime | null {
  return useContext(WorkspaceAgent)?.runtime ?? null;
}

/**
 * Binds an editor's hosts to the workspace session. Null options (the
 * runtime has not loaded, so there are no hosts yet) bind nothing.
 */
export function useEditorAgentSession(
  options: Omit<UseAgentSessionOptions, "contextRevision"> | null,
): UseAgentSessionResult {
  const shared = useContext(WorkspaceAgent);
  if (!shared) throw new Error("Editor requires the workspace Agent provider");
  // A new host is a new context revision.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the host identity is the revision's trigger
  const revision = useMemo(() => crypto.randomUUID(), [options?.host]);
  const latest = useRef(options);
  latest.current = options;
  const { bind } = shared;
  // Automation that opened the editor with ?agent=pair (#1523), on a page
  // that offers Agent connections; elsewhere it finds no handle.
  const [pairing] = useState(() =>
    shared.enabled &&
    typeof window !== "undefined" &&
    agentPairingRequested(window.location.search)
      ? new AgentPairing()
      : null,
  );
  useEffect(
    () => (pairing ? exposeAgentPairing(window, pairing) : undefined),
    [pairing],
  );
  useLayoutEffect(() => {
    if (!options) return;
    bind({
      ...options,
      ...(pairing ? { pairOnLoad: pairing } : {}),
      beforeConnect: async () => latest.current?.beforeConnect?.(),
      contextRevision: revision,
      projectSessionId: revision,
    });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- rebinds on the fields a context is made of, not on every new options object
  }, [
    bind,
    pairing,
    revision,
    options?.enabled,
    options?.project,
    options?.host,
    options?.fileHost,
    options?.simulationHost,
    options?.projectHost,
    options?.recover,
  ]);
  useLayoutEffect(() => () => bind(null), [bind]);
  return shared.session;
}
