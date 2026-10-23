const assert = require("assert");

const originalFetch = global.fetch;
const originalKeyId = process.env.CLOUDFLARE_TURN_KEY_ID;
const originalApiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;

async function run() {
  const turnCredentials = require("../netlify/functions/turn-credentials.js");

  delete process.env.CLOUDFLARE_TURN_KEY_ID;
  delete process.env.CLOUDFLARE_TURN_API_TOKEN;
  let response = await turnCredentials.handler({ httpMethod: "GET" });
  assert.strictEqual(response.statusCode, 503);

  process.env.CLOUDFLARE_TURN_KEY_ID = "test-key-id";
  process.env.CLOUDFLARE_TURN_API_TOKEN = "test-api-token";
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 201,
      json: async () => ({
        iceServers: [
          { urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:53?transport=udp"] },
          {
            urls: ["turn:turn.cloudflare.com:443?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
            username: "short-lived-user",
            credential: "short-lived-credential"
          }
        ]
      })
    };
  };

  response = await turnCredentials.handler({ httpMethod: "GET" });
  assert.strictEqual(response.statusCode, 200);
  assert.match(request.url, /\/test-key-id\/credentials\/generate-ice-servers$/);
  assert.strictEqual(request.options.headers.Authorization, "Bearer test-api-token");
  assert.deepStrictEqual(JSON.parse(request.options.body), { ttl: 86400 });
  const payload = JSON.parse(response.body);
  assert.strictEqual(payload.iceServers.length, 2);
  assert.deepStrictEqual(payload.iceServers[0].urls, ["stun:stun.cloudflare.com:3478"]);
  assert.deepStrictEqual(payload.iceServers[1].urls, [
    "turn:turn.cloudflare.com:443?transport=udp",
    "turns:turn.cloudflare.com:443?transport=tcp"
  ]);
  assert.ok(payload.expiresAt > Date.now());
  console.log("PASS: TURN credentials stay server-side and return browser-safe relay configuration");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  global.fetch = originalFetch;
  if (originalKeyId === undefined) delete process.env.CLOUDFLARE_TURN_KEY_ID;
  else process.env.CLOUDFLARE_TURN_KEY_ID = originalKeyId;
  if (originalApiToken === undefined) delete process.env.CLOUDFLARE_TURN_API_TOKEN;
  else process.env.CLOUDFLARE_TURN_API_TOKEN = originalApiToken;
});
