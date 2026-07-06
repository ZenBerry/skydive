#!/usr/bin/env node

const crypto = require("node:crypto");

const skydiveUrl = cleanBaseUrl(process.env.SKYDIVE_URL || "http://localhost:8888");
const bridgeToken = (process.env.SKYDIVE_OPENCLAW_BRIDGE_TOKEN || "").trim();
const gatewayUrl = (process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789").trim();
const gatewayToken = (process.env.OPENCLAW_GATEWAY_TOKEN || "").trim();
const gatewayPassword = (process.env.OPENCLAW_GATEWAY_PASSWORD || "").trim();
const sessionKey = (process.env.OPENCLAW_SESSION_KEY || "main").trim();
const gatewayTimeoutMs = positiveInteger(process.env.OPENCLAW_BRIDGE_GATEWAY_TIMEOUT_MS, 120000);

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

function gatewayConnectParams() {
  const auth = gatewayToken || gatewayPassword
    ? { ...(gatewayToken ? { token: gatewayToken } : {}), ...(gatewayPassword ? { password: gatewayPassword } : {}) }
    : undefined;
  return {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: "gateway-client",
      displayName: "Skydive",
      version: "dev",
      platform: process.platform,
      mode: "backend",
      instanceId: crypto.randomUUID()
    },
    caps: [],
    role: "operator",
    scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
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

    async function sendConnect() {
      if (connectStarted) return;
      connectStarted = true;
      try {
        await request("connect", gatewayConnectParams());
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
        if (!connected) sendConnect();
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
