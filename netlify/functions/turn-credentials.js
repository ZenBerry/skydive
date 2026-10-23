const TURN_CREDENTIAL_TTL_SECONDS = 86400;
const CLOUDFLARE_TURN_URL = "https://rtc.live.cloudflare.com/v1/turn/keys";

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function normalizeIceServers(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((server) => {
    if (!server || typeof server !== "object") return [];
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
      .filter((url) => typeof url === "string" && /^(?:stun|turn|turns):/i.test(url))
      .filter((url) => !/:53(?:\?|$)/.test(url));
    if (urls.length === 0) return [];
    const normalized = { urls };
    if (typeof server.username === "string") normalized.username = server.username;
    if (typeof server.credential === "string") normalized.credential = server.credential;
    return [normalized];
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed." });

  const keyId = (process.env.CLOUDFLARE_TURN_KEY_ID || "").trim();
  const apiToken = (process.env.CLOUDFLARE_TURN_API_TOKEN || "").trim();
  if (!keyId || !apiToken) return json(503, { error: "TURN relay is not configured." });

  try {
    const response = await fetch(
      `${CLOUDFLARE_TURN_URL}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS })
      }
    );
    if (!response.ok) throw new Error(`Cloudflare TURN request failed: ${response.status}`);
    const payload = await response.json();
    const iceServers = normalizeIceServers(payload && payload.iceServers);
    if (iceServers.length === 0) throw new Error("Cloudflare TURN returned no usable ICE servers.");
    return json(200, {
      iceServers,
      expiresAt: Date.now() + TURN_CREDENTIAL_TTL_SECONDS * 1000
    });
  } catch (error) {
    console.error(error);
    return json(502, { error: "TURN relay is unavailable." });
  }
};

exports.normalizeIceServers = normalizeIceServers;
