#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const skydiveUrl = cleanBaseUrl(process.env.SKYDIVE_URL || "http://localhost:8888");
const bridgeToken = (process.env.SKYDIVE_OPENCLAW_BRIDGE_TOKEN || "").trim();
const gatewayUrl = (process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789").trim();
const openClawConfigPath = process.env.OPENCLAW_CONFIG ||
  path.join(os.homedir(), ".openclaw", "openclaw.json");
const gatewayAuth = loadOpenClawGatewayAuth(openClawConfigPath);
const gatewayToken = (process.env.OPENCLAW_GATEWAY_TOKEN || gatewayAuth.token || "").trim();
const gatewayPassword = (process.env.OPENCLAW_GATEWAY_PASSWORD || gatewayAuth.password || "").trim();
const sessionKey = (process.env.OPENCLAW_SESSION_KEY || "main").trim();
const gatewayTimeoutMs = positiveInteger(process.env.OPENCLAW_BRIDGE_GATEWAY_TIMEOUT_MS, 120000);
const deviceIdentityPath = process.env.SKYDIVE_OPENCLAW_DEVICE_IDENTITY ||
  path.join(os.homedir(), ".skydive", "openclaw-bridge-device.json");

if (!bridgeToken) {
  console.error("SKYDIVE_OPENCLAW_BRIDGE_TOKEN is required.");
  process.exit(1);
}

if (typeof WebSocket !== "function") {
  console.error("This bridge needs Node.js with WebSocket support. Use Node 22 or newer.");
  process.exit(1);
}

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadOpenClawGatewayAuth(filePath) {
  try {
    const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const auth = config && config.gateway && config.gateway.auth && typeof config.gateway.auth === "object"
      ? config.gateway.auth
      : {};
    return {
      token: typeof auth.token === "string" ? auth.token : "",
      password: typeof auth.password === "string" ? auth.password : ""
    };
  } catch (error) {
    return { token: "", password: "" };
  }
}

function requestHeaders() {
  return {
    Authorization: `Bearer ${bridgeToken}`,
    "Content-Type": "application/json"
  };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    return { error: text || "Unreadable response." };
  }
}

async function fetchJob() {
  const response = await fetch(`${skydiveUrl}/api/openclaw/bridge/jobs`, {
    method: "GET",
    headers: requestHeaders()
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(data.error || `Skydive returned HTTP ${response.status}.`);
  return data.job || null;
}

async function postResult(jobId, result) {
  const response = await fetch(`${skydiveUrl}/api/openclaw/bridge/results`, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({ jobId, ...result })
  });
  const data = await readJson(response);
  if (!response.ok) throw new Error(data.error || `Skydive returned HTTP ${response.status}.`);
}

function latestUserMessage(messages) {
  const entry = [...(Array.isArray(messages) ? messages : [])].reverse().find((message) => message.role === "user");
  return entry && typeof entry.content === "string" ? entry.content.trim() : "";
}

function extractText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (typeof value.text === "string") return value.text;
  if (Array.isArray(value.content)) return extractText(value.content);
  if (typeof value.content === "string") return value.content;
  if (typeof value.message === "string") return value.message;
  if (value.message) return extractText(value.message);
  return "";
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem) {
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return spki.length === prefix.length + 32 && spki.subarray(0, prefix.length).equals(prefix)
    ? spki.subarray(prefix.length)
    : spki;
}

function fingerprintPublicKey(publicKeyPem) {
  return crypto.createHash("sha256").update(derivePublicKeyRaw(publicKeyPem)).digest("hex");
}

function generateDeviceIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { deviceId: fingerprintPublicKey(publicKeyPem), publicKeyPem, privateKeyPem };
}

function loadOrCreateDeviceIdentity(filePath = deviceIdentityPath) {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && parsed.version === 1 && parsed.publicKeyPem && parsed.privateKeyPem) {
        const deviceId = fingerprintPublicKey(parsed.publicKeyPem);
        return { deviceId, publicKeyPem: parsed.publicKeyPem, privateKeyPem: parsed.privateKeyPem };
      }
    }
  } catch (error) {
    // Fall through and create a fresh local bridge identity.
  }

  const identity = generateDeviceIdentity();
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, ...identity, createdAtMs: Date.now() }, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    // Best effort on platforms without chmod semantics.
  }
  return identity;
}

function buildDeviceAuthPayload(params) {
  const version = params.nonce ? "v2" : "v1";
  const base = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token || ""
  ];
  if (version === "v2") base.push(params.nonce || "");
  return base.join("|");
}

function signDevicePayload(privateKeyPem, payload) {
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), crypto.createPrivateKey(privateKeyPem)));
}

function publicKeyRawBase64UrlFromPem(publicKeyPem) {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function gatewayConnectParams(nonce = "") {
  const identity = loadOrCreateDeviceIdentity();
  const clientId = "gateway-client";
  const clientMode = "backend";
  const role = "operator";
  const scopes = ["operator.admin", "operator.approvals", "operator.pairing"];
  const signedAtMs = Date.now();
  const authToken = gatewayToken || "";
  const auth = gatewayToken || gatewayPassword
    ? { ...(gatewayToken ? { token: gatewayToken } : {}), ...(gatewayPassword ? { password: gatewayPassword } : {}) }
    : undefined;
  const payload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId,
    clientMode,
    role,
    scopes,
    signedAtMs,
    token: authToken || null,
    nonce
  });
  return {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: clientId,
      displayName: "Skydive",
      version: "dev",
      platform: process.platform,
      mode: clientMode,
      instanceId: crypto.randomUUID()
    },
    caps: [],
    role,
    scopes,
    device: {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      signature: signDevicePayload(identity.privateKeyPem, payload),
      signedAt: signedAtMs,
      ...(nonce ? { nonce } : {})
    },
    ...(auth ? { auth } : {})
  };
}

async function runOpenClaw(message) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(gatewayUrl);
    const pending = new Map();
    const runId = crypto.randomUUID();
    let connectStarted = false;
    let connected = false;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`OpenClaw did not finish within ${gatewayTimeoutMs}ms.`));
    }, gatewayTimeoutMs);

    function cleanup() {
      clearTimeout(timer);
      pending.clear();
      try {
        ws.close();
      } catch (error) {
        // Ignore close errors during cleanup.
      }
    }

    function request(method, params) {
      const id = crypto.randomUUID();
      ws.send(JSON.stringify({ type: "req", id, method, params }));
      return new Promise((requestResolve, requestReject) => {
        pending.set(id, { resolve: requestResolve, reject: requestReject });
      });
    }

    async function sendConnect(nonce = "") {
      if (connectStarted) return;
      connectStarted = true;
      try {
        await request("connect", gatewayConnectParams(nonce));
        connected = true;
        await request("chat.send", {
          sessionKey,
          message,
          deliver: false,
          timeoutMs: gatewayTimeoutMs,
          idempotencyKey: runId
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
    }

    ws.addEventListener("open", () => {
      setTimeout(sendConnect, 750);
    });

    ws.addEventListener("message", (event) => {
      let frame;
      try {
        frame = JSON.parse(String(event.data || ""));
      } catch (error) {
        return;
      }

      if (frame.type === "event" && frame.event === "connect.challenge") {
        const payload = frame.payload || {};
        const nonce = typeof payload.nonce === "string" ? payload.nonce : "";
        if (!connected) sendConnect(nonce);
        return;
      }

      if (frame.type === "res") {
        const waiter = pending.get(frame.id);
        if (!waiter) return;
        pending.delete(frame.id);
        if (frame.ok) waiter.resolve(frame.payload || {});
        else waiter.reject(new Error(frame.error && frame.error.message ? frame.error.message : "OpenClaw request failed."));
        return;
      }

      if (frame.type === "event" && frame.event === "chat") {
        const payload = frame.payload || {};
        if (payload.runId !== runId || payload.sessionKey !== sessionKey) return;
        if (payload.state === "final") {
          const reply = extractText(payload.message).trim();
          cleanup();
          resolve(reply || "OpenClaw finished without a visible reply.");
        } else if (payload.state === "error" || payload.state === "aborted") {
          cleanup();
          reject(new Error(payload.errorMessage || `OpenClaw chat ${payload.state}.`));
        }
      }
    });

    ws.addEventListener("error", () => {
      cleanup();
      reject(new Error(`Could not connect to OpenClaw at ${gatewayUrl}.`));
    });

    ws.addEventListener("close", (event) => {
      if (pending.size) {
        cleanup();
        reject(new Error(`OpenClaw gateway closed (${event.code}): ${event.reason || "no reason"}.`));
      }
    });
  });
}

async function handleJob(job) {
  const message = latestUserMessage(job.messages);
  if (!message) {
    await postResult(job.id, { error: "The Skydive job did not contain a user message.", model: "openclaw" });
    return;
  }

  try {
    const reply = await runOpenClaw(message);
    await postResult(job.id, { reply, model: "openclaw" });
  } catch (error) {
    await postResult(job.id, { error: error.message || String(error), model: "openclaw" });
  }
}

async function main() {
  console.log(`Skydive OpenClaw bridge polling ${skydiveUrl}`);
  console.log(`OpenClaw gateway: ${gatewayUrl}`);
  console.log(`OpenClaw session: ${sessionKey}`);

  while (true) {
    try {
      const job = await fetchJob();
      if (job) await handleJob(job);
    } catch (error) {
      console.error(error.message || String(error));
      await delay(3000);
    }
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
