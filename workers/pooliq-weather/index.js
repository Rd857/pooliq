/**
 * workers/pooliq-weather/index.js
 *
 * Cloudflare Worker proxying the Ambient Weather API so the PoolIQ front-end
 * never holds the API keys (set with `wrangler secret put AMBIENT_API_KEY` /
 * `AMBIENT_APP_KEY`; deploy with `wrangler deploy`).
 *
 *   GET /                       → current conditions: the raw /v1/devices
 *                                 array (each element has `lastData`).
 *   GET /history?day=YYYY-MM-DD → every station reading for that UTC day,
 *                                 ascending, trimmed to the fields the decay
 *                                 model uses.
 *
 * Caching: Ambient allows 1 request/second per API key and returns 429s on
 * bursts, so responses are cached at Cloudflare's edge. Current conditions
 * live 60 s. A finished day of history never changes, so it's cached for a
 * week — each day is fetched from Ambient about once. Today's partial day
 * refreshes every 5 minutes. Upstream 429s are retried with backoff.
 */

const CURRENT_TTL_SECONDS = 60;
const TODAY_HISTORY_TTL_SECONDS = 300;
const PAST_HISTORY_TTL_SECONDS = 7 * 24 * 3600;
const MAC_TTL_SECONDS = 24 * 3600;

const RATE_LIMIT_GAP_MS = 1100;
const MAX_RETRIES = 3;
const PAGE_LIMIT = 288;
const MAX_PAGES = 6; // 288 × 6 covers even 1-minute reporting
const DAY_MS = 24 * 3600 * 1000;

const HISTORY_FIELDS = [
  "dateutc",
  "uv",
  "solarradiation",
  "tempf",
  "humidity",
  "windspeedmph",
  "hourlyrainin",
  "dailyrainin",
];

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405);
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

    const url = new URL(request.url);
    if (url.pathname === "/history") return handleHistory(url, env, ctx);
    return handleCurrent(url, env, ctx);
  },
};

function handleCurrent(url, env, ctx) {
  return cached(new Request(`${url.origin}/`), ctx, async () => ({
    body: await ambient(devicesUrl(env)),
    ttl: CURRENT_TTL_SECONDS,
  }));
}

function handleHistory(url, env, ctx) {
  const day = url.searchParams.get("day") || "";
  const dayStart = /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? Date.parse(`${day}T00:00:00Z`)
    : NaN;
  if (Number.isNaN(dayStart)) {
    return jsonResponse({ error: "Expected ?day=YYYY-MM-DD (UTC)." }, 400);
  }
  const dayEnd = dayStart + DAY_MS;
  if (dayStart > Date.now()) return jsonResponse([], 200);

  const key = new Request(`${url.origin}/history?day=${day}`);
  return cached(key, ctx, async () => {
    const { mac, calledUpstream } = await getMac(url.origin, env, ctx);

    const byTime = new Map();
    let endDate = Math.min(dayEnd, Date.now());
    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0 || calledUpstream) await sleep(RATE_LIMIT_GAP_MS);
      const batch = await ambient(historyUrl(env, mac, endDate));
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const r of batch) {
        if (r.dateutc >= dayStart && r.dateutc < dayEnd) {
          byTime.set(r.dateutc, pick(r, HISTORY_FIELDS));
        }
      }
      const oldest = batch[batch.length - 1].dateutc; // results descend
      if (batch.length < PAGE_LIMIT || oldest <= dayStart) break;
      endDate = oldest;
    }

    const rows = [...byTime.values()].sort((a, b) => a.dateutc - b.dateutc);
    const finished = Date.now() > dayEnd + 3600 * 1000;
    return {
      body: rows,
      ttl: finished ? PAST_HISTORY_TTL_SECONDS : TODAY_HISTORY_TTL_SECONDS,
    };
  });
}

async function getMac(origin, env, ctx) {
  const cache = caches.default;
  const macKey = new Request(`${origin}/__mac`);
  const hit = await cache.match(macKey);
  if (hit) return { mac: (await hit.json()).mac, calledUpstream: false };

  const currentHit = await cache.match(new Request(`${origin}/`));
  const devices = currentHit
    ? await currentHit.json()
    : await ambient(devicesUrl(env));
  const mac = Array.isArray(devices) && devices[0] && devices[0].macAddress;
  if (!mac) throw httpError(502, "No Ambient Weather device on this account.");
  ctx.waitUntil(cache.put(macKey, jsonResponse({ mac }, 200, MAC_TTL_SECONDS)));
  return { mac, calledUpstream: !currentHit };
}

// Serve from the edge cache, or produce + cache a 200. Errors are never cached.
async function cached(key, ctx, produce) {
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;
  let result;
  try {
    result = await produce();
  } catch (err) {
    return jsonResponse({ error: err.message }, err.status || 502);
  }
  const response = jsonResponse(result.body, 200, result.ttl);
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

async function ambient(url) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { Accept: "application/json" } });
    } catch (err) {
      throw httpError(502, `Failed to reach Ambient Weather API: ${err.message}`);
    }
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await sleep(RATE_LIMIT_GAP_MS * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      throw httpError(res.status, `Ambient Weather API responded with ${res.status}`);
    }
    return res.json();
  }
}

function devicesUrl(env) {
  const u = new URL("https://api.ambientweather.net/v1/devices");
  u.searchParams.set("apiKey", env.AMBIENT_API_KEY);
  u.searchParams.set("applicationKey", env.AMBIENT_APP_KEY);
  u.searchParams.set("limit", "1");
  return u.toString();
}

function historyUrl(env, mac, endDate) {
  const u = new URL(`https://api.ambientweather.net/v1/devices/${mac}`);
  u.searchParams.set("apiKey", env.AMBIENT_API_KEY);
  u.searchParams.set("applicationKey", env.AMBIENT_APP_KEY);
  u.searchParams.set("endDate", String(endDate));
  u.searchParams.set("limit", String(PAGE_LIMIT));
  return u.toString();
}

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body, status, ttlSeconds) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
      "Cache-Control":
        status === 200 && ttlSeconds
          ? `public, max-age=${ttlSeconds}`
          : "no-store",
    },
  });
}
