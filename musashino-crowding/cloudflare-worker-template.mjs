/**
 * Cloudflare Worker template for a licensed JR East / RT-DIP crowding feed.
 *
 * This file does not scrape JR East apps or Yahoo! Transit.
 * It only proxies a feed that the developer is legally allowed to use.
 *
 * Required environment variables:
 * - LICENSED_FEED_URL: upstream endpoint provided by JR East, RT-DIP, ODPT, or a licensed vendor
 * - LICENSED_FEED_AUTH_HEADER: optional header name, for example "Authorization"
 * - LICENSED_FEED_AUTH_VALUE: optional header value, for example "Bearer ..."
 * - ALLOWED_ORIGIN: optional CORS origin, defaults to "*"
 */

const DIRECTIONS = new Set([
  "higashiurawa-minaminagareyama",
  "minaminagareyama-higashiurawa"
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (url.pathname !== "/feed") {
      return jsonResponse(
        {
          error: "not_found",
          message: "Use /feed?direction=higashiurawa-minaminagareyama"
        },
        404,
        env
      );
    }

    if (!env.LICENSED_FEED_URL) {
      return jsonResponse(
        {
          source: "not configured",
          licensed: false,
          updatedAt: new Date().toISOString(),
          trains: [],
          error: "LICENSED_FEED_URL is not configured"
        },
        503,
        env
      );
    }

    const direction = url.searchParams.get("direction") || "";
    if (direction && !DIRECTIONS.has(direction)) {
      return jsonResponse(
        {
          error: "bad_direction",
          message: "Unknown direction"
        },
        400,
        env
      );
    }

    const upstream = await fetchLicensedFeed(env);
    const normalized = normalizeFeed(upstream, direction);

    return jsonResponse(normalized, 200, env);
  }
};

async function fetchLicensedFeed(env) {
  const headers = new Headers();
  if (env.LICENSED_FEED_AUTH_HEADER && env.LICENSED_FEED_AUTH_VALUE) {
    headers.set(env.LICENSED_FEED_AUTH_HEADER, env.LICENSED_FEED_AUTH_VALUE);
  }

  const response = await fetch(env.LICENSED_FEED_URL, {
    headers,
    cf: { cacheTtl: 15, cacheEverything: false }
  });

  if (!response.ok) {
    throw new Error(`Licensed feed failed: HTTP ${response.status}`);
  }

  return response.json();
}

function normalizeFeed(feed, direction) {
  if (!feed || typeof feed !== "object") {
    return {
      source: "invalid feed",
      licensed: false,
      updatedAt: new Date().toISOString(),
      trains: []
    };
  }

  const trains = Array.isArray(feed.trains) ? feed.trains : [];
  const normalizedTrains = trains
    .map(normalizeTrain)
    .filter((train) => !direction || train.direction === direction);

  return {
    source: feed.source || "licensed upstream feed",
    licensed: feed.licensed === true,
    updatedAt: feed.updatedAt || feed["dc:date"] || new Date().toISOString(),
    trains: normalizedTrains
  };
}

function normalizeTrain(train) {
  const cars = Array.isArray(train.cars)
    ? train.cars
        .filter((car) => car && car.carNumber !== undefined)
        .map((car) => ({
          carNumber: Number(car.carNumber),
          crowdingLevel: Number(car.crowdingLevel),
          note: car.note || ""
        }))
    : [];

  return {
    trainId: train.trainId || train["owl:sameAs"] || "",
    line: train.line || train["odpt:railway"] || "",
    serviceName: train.serviceName || train["odpt:trainType"] || "",
    direction: train.direction || "",
    fromStation: train.fromStation || "",
    toStation: train.toStation || "",
    destination: train.destination || train["odpt:destinationStation"] || "",
    departureTime: train.departureTime || train.departure || "",
    delayMinutes: Number(train.delayMinutes || 0),
    crowdingLevel: train.crowdingLevel === undefined ? undefined : Number(train.crowdingLevel),
    cars
  };
}

function jsonResponse(body, status, env) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders(env),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function corsHeaders(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}
