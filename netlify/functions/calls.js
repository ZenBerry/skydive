const { MongoClient } = require("mongodb");

const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "ZENBERRY_MAIN";
const collectionName = process.env.MONGODB_CALLS_COLLECTION || "SKYDIVE_CALLS";
const MAX_SIGNAL_BYTES = 120000;
const PARTICIPANT_TTL_MS = 15000;
const MESSAGE_TTL_MS = 45000;
const PARTICIPANT_ROLES = new Set(["publisher", "viewer"]);

let collectionPromise = null;

async function getCollection() {
  if (!mongoUri) throw new Error("MONGODB_URI is required.");
  if (!collectionPromise) {
    collectionPromise = (async () => {
      const client = new MongoClient(mongoUri);
      await client.connect();
      const collection = client.db(dbName).collection(collectionName);
      await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      await collection.createIndex({ kind: 1, space: 1, room: 1, peer: 1 });
      await collection.createIndex({ kind: 1, space: 1, room: 1, to: 1, createdAt: 1 });
      return collection;
    })();
  }
  return collectionPromise;
}

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

function getParam(event, name) {
  const value = event.queryStringParameters && event.queryStringParameters[name];
  return typeof value === "string" ? decodeURIComponent(value).trim() : "";
}

function isSafeToken(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && /^[a-zA-Z0-9._:/-]+$/.test(value);
}

function isSafeSpace(value) {
  return typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 500 &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("//");
}

function getSignalRoom(event, payload = {}) {
  const space = payload.space || getParam(event, "space");
  const room = payload.room || getParam(event, "room");
  const peer = payload.peer || getParam(event, "peer");
  if (!isSafeSpace(space)) return null;
  if (!isSafeToken(room, 140) || !isSafeToken(peer, 140)) return null;
  return { space, room, peer };
}

function getParticipantRole(event, payload = {}) {
  const role = typeof payload.role === "string" && payload.role.trim()
    ? payload.role.trim()
    : getParam(event, "role");
  return PARTICIPANT_ROLES.has(role) ? role : "viewer";
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  const raw = JSON.stringify(payload);
  if (Buffer.byteLength(raw, "utf8") > MAX_SIGNAL_BYTES) {
    throw new Error("Signal payload is too large.");
  }
  return JSON.parse(raw);
}

async function heartbeat(collection, roomInfo, role, now) {
  await collection.updateOne(
    { kind: "participant", space: roomInfo.space, room: roomInfo.room, peer: roomInfo.peer },
    {
      $set: {
        kind: "participant",
        space: roomInfo.space,
        room: roomInfo.room,
        peer: roomInfo.peer,
        role,
        lastSeenAt: now,
        expiresAt: new Date(now + PARTICIPANT_TTL_MS)
      },
      $setOnInsert: { joinedAt: now }
    },
    { upsert: true }
  );
}

exports.handler = async (event) => {
  try {
    const collection = await getCollection();
    const now = Date.now();

    if (event.httpMethod === "GET") {
      const roomInfo = getSignalRoom(event);
      if (!roomInfo) return json(400, { error: "A valid space, room, and peer are required." });
      const role = getParticipantRole(event);

      await heartbeat(collection, roomInfo, role, now);
      await collection.deleteMany({ expiresAt: { $lte: new Date(now) } });

      const after = Math.max(0, Number(getParam(event, "after")) || 0);
      const participants = await collection.find({
        kind: "participant",
        space: roomInfo.space,
        room: roomInfo.room,
        expiresAt: { $gt: new Date(now) }
      }, {
        projection: { _id: 0, peer: 1, role: 1, joinedAt: 1, lastSeenAt: 1 }
      }).sort({ joinedAt: 1 }).toArray();

      const rawMessages = await collection.find({
        kind: "message",
        space: roomInfo.space,
        room: roomInfo.room,
        from: { $ne: roomInfo.peer },
        createdAt: { $gt: after },
        expiresAt: { $gt: new Date(now) },
        $or: [{ to: roomInfo.peer }, { to: "*" }]
      }, {
        projection: { from: 1, to: 1, type: 1, payload: 1, createdAt: 1 }
      }).sort({ createdAt: 1 }).limit(100).toArray();
      const messages = rawMessages.map((message) => ({
        id: String(message._id),
        from: message.from,
        to: message.to,
        type: message.type,
        payload: message.payload,
        createdAt: message.createdAt
      }));

      return json(200, { now, participants, messages });
    }

    if (event.httpMethod === "POST") {
      const payload = event.body ? JSON.parse(event.body) : {};
      const roomInfo = getSignalRoom(event, payload);
      if (!roomInfo) return json(400, { error: "A valid space, room, and peer are required." });
      const role = getParticipantRole(event, payload);

      await heartbeat(collection, roomInfo, role, now);
      if (payload.type === "leave") {
        await collection.deleteOne({ kind: "participant", space: roomInfo.space, room: roomInfo.room, peer: roomInfo.peer });
        return json(200, { ok: true, now });
      }

      const type = typeof payload.type === "string" ? payload.type.trim() : "";
      const to = typeof payload.to === "string" && payload.to.trim() ? payload.to.trim() : "*";
      if (!["offer", "answer", "ice"].includes(type) || (!(to === "*") && !isSafeToken(to, 140))) {
        return json(400, { error: "A valid signal message is required." });
      }

      await collection.insertOne({
        kind: "message",
        space: roomInfo.space,
        room: roomInfo.room,
        from: roomInfo.peer,
        to,
        type,
        payload: normalizePayload(payload.payload),
        createdAt: now,
        expiresAt: new Date(now + MESSAGE_TTL_MS)
      });

      return json(200, { ok: true, now });
    }

    return json(405, { error: "Method not allowed." });
  } catch (error) {
    console.error(error);
    return json(500, { error: "Server error." });
  }
};
