/// <reference lib="webworker" />
// Runs the Rust solver (crates/smallsignal-wasm, built by wasm-pack into
// ../wasm) off the main thread. Without that build the worker answers every
// request with an error, so the editor still loads.

interface SolverModule {
  default: (input?: unknown) => Promise<unknown>;
  analyze: (netlist: string, request: string) => string;
}

// A glob, not an import: a checkout without the WASM build still bundles.
const builds = import.meta.glob<SolverModule>("../wasm/smallsignal_wasm.js");

let solver: Promise<SolverModule | null> | null = null;
function loadSolver(): Promise<SolverModule | null> {
  solver ??= (async () => {
    const load = Object.values(builds)[0];
    if (!load) return null;
    const module = await load();
    await module.default();
    return module;
  })();
  return solver;
}

export interface SolverWorkerRequest {
  id: number;
  netlist: string;
  request: string;
}

export interface SolverWorkerReply {
  id: number;
  response: string;
}

self.onmessage = async (event: MessageEvent<SolverWorkerRequest>) => {
  const { id, netlist, request } = event.data;
  let response: string;
  try {
    const module = await loadSolver();
    response = module
      ? module.analyze(netlist, request)
      : JSON.stringify({
          error:
            "The small-signal solver is not built (run wasm-pack on crates/smallsignal-wasm).",
        });
  } catch (error) {
    response = JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    });
  }
  self.postMessage({ id, response } satisfies SolverWorkerReply);
};
