import { useEffect, useState } from "react";

import { watchForNewDeploy } from "../app-update";
import { refreshWithRestore } from "./chunk-load-fallback";

/**
 * Says that a newer Analog Canvas is live (2026-10-13). This page keeps
 * working, its earlier assets stay online for a week; the person reloads
 * when the work is saved, and the reload restores the current circuit.
 */
export function NewDeployBanner() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (import.meta.env?.ICM_DESKTOP) return;
    return watchForNewDeploy(() => setShown(true));
  }, []);
  if (!shown) return null;
  return (
    <aside
      className="recovery-banner"
      data-testid="new-deploy-banner"
      role="status"
      aria-label="New version available"
    >
      <p>
        A new version of Analog Canvas is available. Keep working; when your
        work is saved, reload to use it. Your current circuit is restored.
      </p>
      <div>
        <button type="button" onClick={refreshWithRestore}>
          Reload now
        </button>
        <button type="button" onClick={() => setShown(false)}>
          Later
        </button>
      </div>
    </aside>
  );
}
