const crypto = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");
const { getSessionUserWithRefresh } = require("./lib/users");

const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "ZENBERRY_MAIN";
const devicesCollectionName = process.env.SKYDIVE_OPENCLAW_DEVICES_COLLECTION || "SKYDIVE_OPENCLAW_DEVICES";
const jobsCollectionName = process.env.SKYDIVE_OPENCLAW_JOBS_COLLECTION || "SKYDIVE_OPENCLAW_JOBS";

const MAX_HISTORY_MESSAGES = 24;
const MAX_MESSAGE_LENGTH = 8000;
const MAX_REQUEST_LENGTH = 120000;
const MAX_REPLY_LENGTH = 80000;
const CHAT_WAIT_MS = 45000;
const BRIDGE_POLL_MS = 25000;
const JOB_TTL_SECONDS = 60 * 60 * 24;
const DEVICE_STALE_MS = 1000 * 60 * 2;

let collectionsPromise = null;

class HttpError extends Error {
  constructor(statusCode, message, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

async function getCollections() {
  if (!mongoUri) throw new HttpError(503, "MONGODB_URI is required for OpenClaw access.");
  if (!collectionsPromise) {
    collectionsPromise = (async () => {
      const client = new MongoClient(mongoUri);
      await client.connect();
      const db = client.db(dbName);
      const devices = db.collection(devicesCollectionName);
      const jobs = db.collection(jobsCollectionName);
      await Promise.all([
        devices.createIndex({ tokenHash: 1 }, { unique: true }),
        devices.createIndex({ userId: 1, revokedAt: 1, updatedAt: -1 }),
        jobs.createIndex({ userId: 1, status: 1, createdAt: -1 }),
        jobs.createIndex({ deviceId: 1, status: 1, createdAt: 1 }),
        jobs.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
      ]);
      return { devices, jobs };
    })();
  }
  return collectionsPromise;
}

function json(statusCode, body, cookies = []) {
  const response = {
    statusCode,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(body)
  };
  if (cookies.length) response.multiValueHeaders = { "Set-Cookie": cookies };
  return response;
}

function randomToken(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("base64url");
}

function getBearer(event) {
  const headers = event.headers || {};
  const authHeader = headers.authorization || headers.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  return match ? match[1].trim() : "";
}

function cleanMessages(value) {
  if (!Array.isArray(value)) throw new HttpError(400, "messages must be an array.");
  const messages = value.slice(-MAX_HISTORY_MESSAGES).map((entry) => {
    const role = entry && entry.role === "assistant" ? "assistant" : "user";
    const content = typeof (entry && entry.content) === "string" ? entry.content.trim() : "";
    if (!content) throw new HttpError(400, "Every message needs content.");
    if (content.length > MAX_MESSAGE_LENGTH) {
      throw new HttpError(400, `Messages can be at most ${MAX_MESSAGE_LENGTH} characters.`);
    }
    return { role, content };
  });
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    throw new HttpError(400, "The final message must be from the user.");
  }
  return messages;
}

function cleanTimeZone(value, fallback = "UTC") {
  const timeZone = typeof value === "string" && value.trim() ? value.trim() : fallback;
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
    return timeZone;
  } catch (error) {
    return fallback;
  }
}

function publicDevice(device) {
  if (!device) return null;
  const lastSeenAt = Number(device.lastSeenAt) || 0;
  return {
    id: String(device._id),
    name: device.name || "OpenClaw bridge",
    connected: Boolean(lastSeenAt && Date.now() - lastSeenAt < DEVICE_STALE_MS),
    lastSeenAt,
    createdAt: Number(device.createdAt) || 0
  };
}

async function requireViewer(event) {
  const { user, cookies } = await getSessionUserWithRefresh(event);
  if (!user || !user.id) {
    throw new HttpError(401, "Log in to Skydive before connecting OpenClaw.");
  }
  return { user, cookies };
}

async function getActiveDevice(devices, userId) {
  return devices.findOne(
    { userId, revokedAt: { $exists: false } },
    { sort: { lastSeenAt: -1, updatedAt: -1, createdAt: -1 } }
  );
}

async function status(event) {
  const { user, cookies } = await requireViewer(event);
  const { devices, jobs } = await getCollections();
  const device = await getActiveDevice(devices, user.id);
  const pendingJobs = await jobs.countDocuments({ userId: user.id, status: { $in: ["queued", "running"] } });
  return json(200, { user, device: publicDevice(device), pendingJobs }, cookies);
}

async function pair(event) {
  const { user, cookies } = await requireViewer(event);
  const { devices } = await getCollections();
  const payload = event.body ? JSON.parse(event.body) : {};
  const name = typeof payload.name === "string" && payload.name.trim()
    ? payload.name.trim().slice(0, 80)
    : "OpenClaw bridge";
  const bridgeToken = randomToken("skoc");
  const now = Date.now();
  const result = await devices.insertOne({
    userId: user.id,
    name,
    tokenHash: tokenHash(bridgeToken),
    scopes: ["chat", "skydive-agent-interface"],
    createdAt: now,
    updatedAt: now,
    lastSeenAt: 0
  });
  return json(200, {
    user,
    device: { id: String(result.insertedId), name, connected: false, lastSeenAt: 0, createdAt: now },
    bridgeToken,
    bridgeEndpoint: "/api/openclaw/bridge/jobs",
    resultEndpoint: "/api/openclaw/bridge/results"
  }, cookies);
}

async function revoke(event) {
  const { user, cookies } = await requireViewer(event);
  const { devices } = await getCollections();
  await devices.updateMany(
    { userId: user.id, revokedAt: { $exists: false } },
    { $set: { revokedAt: Date.now(), updatedAt: Date.now() } }
  );
  return json(200, { user, device: null }, cookies);
}

async function waitForJob(jobs, jobId, deadline) {
  while (Date.now() < deadline) {
    const job = await jobs.findOne({ _id: jobId }, { projection: { status: 1, reply: 1, error: 1, model: 1 } });
    if (job && job.status === "done") {
      return {
        reply: String(job.reply || "").slice(0, MAX_REPLY_LENGTH),
        model: job.model || "openclaw",
        pending: false
      };
    }
    if (job && job.status === "error") {
      return {
        reply: job.error || "Your local Codex could not answer that request.",
        model: job.model || "openclaw",
        pending: false
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  return {
    reply: "I sent that to your local Codex, but the bridge has not answered yet. Try again in a moment.",
    model: "openclaw",
    pending: true
  };
}

async function chat(event) {
  if ((event.body || "").length > MAX_REQUEST_LENGTH) {
    throw new HttpError(413, "This conversation is too large. Start a fresh chat and try again.");
  }
  const { user, cookies } = await requireViewer(event);
  const { devices, jobs } = await getCollections();
  const device = await getActiveDevice(devices, user.id);
  if (!device) {
    return json(200, {
      user,
      reply: "Codex mode is ready, but no OpenClaw bridge is connected yet. Pair a bridge from this device first.",
      model: "openclaw",
      needsBridge: true
    }, cookies);
  }

  const payload = event.body ? JSON.parse(event.body) : {};
  const messages = cleanMessages(payload.messages);
  const timeZone = cleanTimeZone(payload.timeZone, "UTC");
  const now = Date.now();
  const insert = await jobs.insertOne({
    userId: user.id,
    deviceId: device._id,
    status: "queued",
    messages,
    timeZone,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now + JOB_TTL_SECONDS * 1000)
  });
  const result = await waitForJob(jobs, insert.insertedId, Date.now() + CHAT_WAIT_MS);
  return json(200, { user, jobId: String(insert.insertedId), ...result }, cookies);
}

async function requireBridge(event) {
  const token = getBearer(event);
  if (!token) throw new HttpError(401, "Bridge token is required.");
  const { devices } = await getCollections();
  const device = await devices.findOne({ tokenHash: tokenHash(token), revokedAt: { $exists: false } });
  if (!device) throw new HttpError(401, "Bridge token is invalid or revoked.");
  await devices.updateOne(
    { _id: device._id },
    { $set: { lastSeenAt: Date.now(), updatedAt: Date.now() } }
  );
  return device;
}

async function bridgeJobs(event) {
  const device = await requireBridge(event);
  const { jobs } = await getCollections();
  const deadline = Date.now() + BRIDGE_POLL_MS;

  while (Date.now() < deadline) {
    const now = Date.now();
    const claim = await jobs.findOneAndUpdate(
      { deviceId: device._id, status: "queued" },
      { $set: { status: "running", startedAt: now, updatedAt: now } },
      { sort: { createdAt: 1 }, returnDocument: "after" }
    );
    const job = claim && (claim.value || claim);
    if (job) {
      return json(200, {
        job: {
          id: String(job._id),
          messages: job.messages,
          timeZone: job.timeZone,
          scopes: device.scopes || []
        }
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return json(200, { job: null });
}

async function bridgeResults(event) {
  const device = await requireBridge(event);
  const { jobs } = await getCollections();
  const payload = event.body ? JSON.parse(event.body) : {};
  const jobId = typeof payload.jobId === "string" ? payload.jobId.trim() : "";
  if (!ObjectId.isValid(jobId)) throw new HttpError(400, "A valid jobId is required.");
  const reply = typeof payload.reply === "string" ? payload.reply.trim() : "";
  const error = typeof payload.error === "string" ? payload.error.trim() : "";
  if (!reply && !error) throw new HttpError(400, "reply or error is required.");
  const status = reply ? "done" : "error";
  const now = Date.now();
  const result = await jobs.updateOne(
    { _id: new ObjectId(jobId), deviceId: device._id, status: "running" },
    {
      $set: {
        status,
        reply: reply.slice(0, MAX_REPLY_LENGTH),
        error: error.slice(0, 2000),
        model: typeof payload.model === "string" ? payload.model.slice(0, 120) : "openclaw",
        completedAt: now,
        updatedAt: now
      }
    }
  );
  if (!result.matchedCount) throw new HttpError(404, "No running job matched that id.");
  return json(200, { ok: true });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});

  try {
    const path = event.path || "";
    const payload = event.body ? JSON.parse(event.body) : {};
    if (event.httpMethod === "GET" && /\/bridge\/jobs$/.test(path)) return bridgeJobs(event);
    if (event.httpMethod === "POST" && /\/bridge\/results$/.test(path)) return bridgeResults(event);
    if (event.httpMethod === "GET") return status(event);
    if (event.httpMethod === "POST" && payload.action === "pair") return pair(event);
    if (event.httpMethod === "POST" && payload.action === "revoke") return revoke(event);
    if (event.httpMethod === "POST") return chat(event);
    return json(405, { error: "Method not allowed." });
  } catch (error) {
    if (error instanceof SyntaxError) return json(400, { error: "Request body must be valid JSON." });
    if (error instanceof HttpError) {
      return json(error.statusCode, { error: error.message, ...(error.details ? { details: error.details } : {}) });
    }
    console.error(error);
    return json(500, { error: "Server error." });
  }
};
