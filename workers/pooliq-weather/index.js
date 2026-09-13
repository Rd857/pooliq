/**
 * workers/pooliq-weather/index.js
 *
 * Cloudflare Worker: proxies the Ambient Weather /v1/devices endpoint so the
 * PoolIQ front-end never holds real Ambient Weather API keys in the
 * browser. AUTHORED for Phase 1 but NOT deployed — deploying requires:
 *
 *   1. `wrangler login` / a Cloudflare account (not done in this session).
 *   2. `wrangler secret put AMBIENT_API_KEY` and
 *      `wrangler secret put AMBIENT_APP_KEY` with Ryan's real Ambient
 *      Weather API key + application key
 *      (https://ambientweather.net/account -> API Keys).
 *   3. `wrangler deploy` to publish it, then set
 *      REACT_APP_WEATHER_WORKER_URL in the front-end's .env.local to the
 *      resulting workers.dev (or custom domain) URL.
 *
 * Response shape: passes through the raw Ambient Weather /v1/devices JSON
 * array unchanged (each element has a `lastData` object) — see
 * src/lib/ambientWeather.js for how the front-end consumes it.
 *
 * Caching: Ambient Weather's API rate-limits aggressively (a burst of
 * requests — e.g. the dashboard open on the phone + desktop + a dev server
 * at once — returns 429s). The station itself only reports in ~once a
 * minute anyway, so we cache the upstream response at Cloudflare's edge
 * (Workers Cache API) for CACHE_TTL_SECONDS and serve every request within
 * that window from cache without touching the Ambient Weather API at all.
 */

const CACHE_TTL_SECONDS = 60;

export default {
  async fetch(request, env, ctx) {
    // CORS preflight support.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    const cache = caches.default;
    const cacheKey = new Request(new URL(request.url).toString(), request);

    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }

    if (!env.AMBIENT_API_KEY || !env.AMBIENT_APP_KEY) {
      return jsonResponse(
        {
          error:
            "Worker is missing AMBIENT_API_KEY / AMBIENT_APP_KEY secrets. " +
            "Set them with `wrangler secret put` before use.",
        },
        500
      );
    }

    const url = new URL(
      "https://api.ambientweather.net/v1/devices"
    );
    url.searchParams.set("apiKey", env.AMBIENT_API_KEY);
    url.searchParams.set("applicationKey", env.AMBIENT_APP_KEY);
    url.searchParams.set("limit", "1");

    try {
      const upstream = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
      });

      if (!upstream.ok) {
        // Don't cache failures (including 429s) — let the next request
        // retry against Ambient Weather rather than pinning an error.
        return jsonResponse(
          { error: `Ambient Weather API responded with ${upstream.status}` },
          upstream.status
        );
      }

      const data = await upstream.json();
      const response = jsonResponse(data, 200);
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      return jsonResponse(
        { error: `Failed to reach Ambient Weather API: ${err.message}` },
        502
      );
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
      ...(status === 200
        ? { "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}` }
        : { "Cache-Control": "no-store" }),
    },
  });
}
