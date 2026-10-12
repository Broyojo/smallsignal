// The browser Agent runtime, loaded on demand through agent-runtime-loader
// (#1673): the hosts that serve Agent requests and the session that carries
// them. Nothing on the editor's first load imports this module.
import { memo, useEffect, useLayoutEffect, useState } from "react";
import { createEmptyProject } from "@icm/model";
import { EditorDocumentController } from "../document/document-controller";
import { BrowserAgentHost } from "./browser-agent-host";
import {
  useAgentSession,
  type UseAgentSessionOptions,
  type UseAgentSessionResult,
} from "./use-agent-session";

export { BrowserAgentHost } from "./browser-agent-host";
export { BrowserAgentFileHost } from "./browser-agent-file-host";
export { BrowserAgentSimulationHost } from "./browser-agent-simulation-host";
export { BrowserAgentProjectHost } from "./browser-agent-project-host";
export { createAgentGalleryPublisher } from "./agent-gallery-publish";
export { createAgentSemanticIntentHandler } from "./agent-semantic-intent-handler";

/**
 * The workspace's Agent session. It runs beside the page the workspace
 * provider wraps and hands each state of the session to that provider.
 * Until an editor binds its hosts, the session serves an empty Project, as
 * Gallery does (no circuit is exposed there).
 */
export const AgentSessionRuntime = memo(function AgentSessionRuntime({
  context,
  enabled,
  connectRequested,
  onSession,
  onConnectStarted,
}: {
  context: UseAgentSessionOptions | null;
  enabled: boolean;
  /** Connect Agent was asked for before this runtime had loaded. */
  connectRequested: boolean;
  onSession: (session: UseAgentSessionResult) => void;
  onConnectStarted: () => void;
}) {
  const [empty] = useState(() => {
    const project = createEmptyProject(
      "no-active-project",
      "No active Project",
    );
    const contextRevision = crypto.randomUUID();
    return {
      enabled,
      contextReady: false,
      contextRevision,
      projectSessionId: contextRevision,
      project,
      host: new BrowserAgentHost(new EditorDocumentController(project)),
    };
  });
  const session = useAgentSession({
    ...(context ?? empty),
    enabled: enabled && (context?.enabled ?? empty.enabled),
  });
  // Before paint, so the page never shows a session state older than this.
  useLayoutEffect(() => {
    onSession(session);
  });
  // The click that loaded this runtime connects once the editor is bound,
  // as it would have connected at once had the runtime been here.
  useEffect(() => {
    if (!connectRequested || !context) return;
    onConnectStarted();
    void session.newConnection();
  }, [connectRequested, context, onConnectStarted, session]);
  return null;
});
