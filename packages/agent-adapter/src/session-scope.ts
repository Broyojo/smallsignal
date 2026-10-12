/**
 * Web-session permission scopes, on their own subpath
 * (`@icm/agent-adapter/session-scope`) so the browser can validate a saved
 * Agent recovery record without loading the Agent adapter.
 */
import { z } from "zod";

/**
 * Web-session permission scopes carried by an `agentToken`. They map to
 * `AgentPermissions` as documented in the spec. `circuit.snapshot` is the
 * sole circuit read scope.
 */
export const AgentSessionScopeSchema = z.enum([
  "circuit.snapshot",
  "circuit.render",
  "circuit.source-spans",
  "circuit.edit.geometry",
  "circuit.edit.connectivity",
  "circuit.edit.presentation",
  "editor.semantic-control",
  "project.download",
  "project.import",
  "visual.download",
  /**
   * Compile and execute one structured simulation. Granted through the same
   * human claim flow as the file scopes and, like them, independent of every
   * edit scope: authorizing an Agent to draw a circuit is not authorizing it
   * to spend a deployment's simulator time.
   */
  "simulation.run",
  /**
   * Publish or update Community Gallery entries as the signed-in Editor
   * account. Like simulation, independent of every edit scope: authorizing
   * an Agent to draw a circuit is not authorizing it to publish one.
   */
  "gallery.publish",
  /** Publish or update User Components as the signed-in Editor principal. */
  "components.publish",
]);

/** Single runtime scope guard for browser recovery and relay consumers. */
export function isAgentSessionScope(
  value: unknown,
): value is AgentSessionScope {
  return AgentSessionScopeSchema.safeParse(value).success;
}

export type AgentSessionScope = z.infer<typeof AgentSessionScopeSchema>;
