import SolverWorker from "./worker.js?worker";
import type { SmallSignalRequest, SmallSignalResponse } from "./types.js";
import type { SolverWorkerReply, SolverWorkerRequest } from "./worker.js";

export interface SmallSignalClient {
  analyze(
    netlist: string,
    request: SmallSignalRequest,
  ): Promise<SmallSignalResponse>;
  dispose(): void;
}

/** One solver worker; requests answer in order of their own ids. */
export function createSmallSignalClient(): SmallSignalClient {
  const worker = new SolverWorker();
  let nextId = 0;
  const pending = new Map<number, (response: SmallSignalResponse) => void>();
  worker.onmessage = (event: MessageEvent<SolverWorkerReply>) => {
    const resolve = pending.get(event.data.id);
    if (!resolve) return;
    pending.delete(event.data.id);
    try {
      resolve(JSON.parse(event.data.response) as SmallSignalResponse);
    } catch {
      resolve({ error: "The solver returned unreadable output" });
    }
  };
  worker.onerror = (event) => {
    for (const resolve of pending.values())
      resolve({ error: event.message || "The solver worker failed" });
    pending.clear();
  };
  return {
    analyze(netlist, request) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        worker.postMessage({
          id,
          netlist,
          request: JSON.stringify(request),
        } satisfies SolverWorkerRequest);
      });
    },
    dispose() {
      worker.terminate();
      pending.clear();
    },
  };
}
