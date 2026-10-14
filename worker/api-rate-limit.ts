import { bearerMatches } from "./bearer";

/** Cloudflare's Workers rate limiting binding (`ratelimits` in wrangler.jsonc). */
type RateLimiterLike = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type ApiRateLimitEnv = {
  API_RATE_LIMITER?: RateLimiterLike;
  GALLERY_BACKUP_TOKEN?: string;
  STORE_BACKUP_TOKEN?: string;
  SIMULATION_SMOKE_TOKEN?: string;
};

/**
 * Refuses an /api request once its client address passes the binding's
 * allowance (wrangler.jsonc). This is flood protection, not a quota: the
 * Gallery's daily opens and the simulation queue limits stay the per-account
 * bounds. The Owner's own jobs, which carry a store or smoke credential, are
 * not counted; neither is a request with no client address (local runs).
 */
export async function refuseApiFlood(
  request: Request,
  env: ApiRateLimitEnv,
): Promise<Response | null> {
  const limiter = env.API_RATE_LIMITER;
  if (!limiter || !new URL(request.url).pathname.startsWith("/api/"))
    return null;
  const address = request.headers.get("cf-connecting-ip");
  if (!address) return null;
  const ownerJob = [
    env.GALLERY_BACKUP_TOKEN,
    env.STORE_BACKUP_TOKEN,
    env.SIMULATION_SMOKE_TOKEN,
  ].some((token) => bearerMatches(request, token));
  if (ownerJob) return null;
  const { success } = await limiter.limit({ key: address });
  if (success) return null;
  return Response.json(
    { error: "rate-limited" },
    {
      status: 429,
      headers: { "cache-control": "no-store", "retry-after": "60" },
    },
  );
}
