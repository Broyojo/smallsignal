/**
 * Whether a newer deploy than this page is live (2026-10-13): the page's own
 * entry script against the one the editor's address serves now. A deploy
 * keeps the week's earlier assets online (scripts/retain-previous-assets.mjs),
 * so this page keeps working; the notice only says that a reload, once the
 * work is saved, brings the new version.
 */
const LIVE_ENTRY =
  /<script[^>]*\btype="module"[^>]*\bsrc="(\/assets\/[^"]+\.js)"/u;

/** The content-hashed entry this page booted from; null off a built page. */
export function pageEntryScript(
  root: Pick<Document, "querySelector"> = document,
): string | null {
  const src = root
    .querySelector('script[type="module"][src^="/assets/"]')
    ?.getAttribute("src");
  return src ?? null;
}

/** The entry the editor's address serves now; null when it cannot tell. */
export async function liveEntryScript(
  fetchLike: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchLike("/editor", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "text/html" },
    });
    if (!response.ok) return null;
    return LIVE_ENTRY.exec(await response.text())?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Calls `onNewDeploy` once a different entry is live, checking every
 * `everyMs` while the page is visible and on returning to it (at most once
 * a minute). Nothing is checked on a page with no built entry.
 */
export function watchForNewDeploy(
  onNewDeploy: () => void,
  {
    fetchLike = fetch,
    own = pageEntryScript(),
    everyMs = 10 * 60_000,
    target = window,
    visible = () => document.visibilityState === "visible",
  }: {
    fetchLike?: typeof fetch;
    own?: string | null;
    everyMs?: number;
    target?: Pick<Window, "addEventListener" | "removeEventListener">;
    visible?: () => boolean;
  } = {},
): () => void {
  if (!own) return () => undefined;
  let stopped = false;
  let lastCheck = 0;
  const check = async () => {
    const now = Date.now();
    if (stopped || !visible() || now - lastCheck < 60_000) return;
    lastCheck = now;
    const live = await liveEntryScript(fetchLike);
    if (!stopped && live && live !== own) {
      stop();
      onNewDeploy();
    }
  };
  const onFocus = () => void check();
  const timer = setInterval(onFocus, everyMs);
  target.addEventListener("focus", onFocus);
  function stop() {
    stopped = true;
    clearInterval(timer);
    target.removeEventListener("focus", onFocus);
  }
  return stop;
}
