const { MongoClient } = require("mongodb");
const { authorSnapshot, getSessionUserWithRefresh } = require("./lib/users");

const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "ZENBERRY_MAIN";
const collectionName = process.env.MONGODB_TEMPLATES_COLLECTION || "SKYDIVE_TEMPLATES";

const MAX_TEMPLATE_NODES = 120;
const MAX_TEMPLATE_LINES = 300;
const MAX_TEMPLATE_PAYLOAD_BYTES = 300000;
const COMMAND_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;

let collectionPromise = null;
let staticCommandRegistry = { commands: [] };

try {
  staticCommandRegistry = require("../../commands/registry.json");
} catch (error) {
  console.error("Could not load static command registry:", error);
}

async function getCollection() {
  if (!mongoUri) throw new Error("MONGODB_URI is required.");

  if (!collectionPromise) {
    collectionPromise = (async () => {
      const client = new MongoClient(mongoUri);
      await client.connect();
      const collection = client.db(dbName).collection(collectionName);
      await collection.createIndex({ ownerId: 1, id: 1 }, { unique: true });
      await collection.createIndex({ ownerId: 1, updatedAt: -1 });
      return collection;
    })();
  }

  return collectionPromise;
}

function json(statusCode, body, cookies = []) {
  const response = {
    statusCode,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
  if (cookies.length) response.multiValueHeaders = { "Set-Cookie": cookies };
  return response;
}

function normalizeTemplateId(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/[-_]{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

function getStaticCommandIds() {
  const commands = Array.isArray(staticCommandRegistry.commands) ? staticCommandRegistry.commands : [];
  return new Set(commands.flatMap((command) => [
    command && command.id,
    ...(Array.isArray(command && command.aliases) ? command.aliases : [])
  ]).map((value) => String(value || "").toLowerCase()).filter(Boolean));
}

function cloneJson(value, fallback) {
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return cloned === undefined ? fallback : cloned;
  } catch (error) {
    return fallback;
  }
}

function normalizeTemplatePayload(value) {
  const payload = value && typeof value === "object" ? value : {};
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  if (nodes.length === 0) return null;
  if (nodes.length > MAX_TEMPLATE_NODES || lines.length > MAX_TEMPLATE_LINES) return null;

  const normalized = {
    version: 1,
    origin: payload.origin && typeof payload.origin === "object"
      ? cloneJson(payload.origin, {})
      : { x: 0, y: 0 },
    nodes: cloneJson(nodes, []),
    lines: cloneJson(lines, [])
  };

  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_TEMPLATE_PAYLOAD_BYTES) return null;
  return normalized;
}

function publicTemplate(template) {
  return {
    id: template.id,
    name: template.name,
    payload: template.payload,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    createdBy: template.createdBy || null
  };
}

exports.handler = async (event) => {
  try {
    const { user: viewer, cookies } = await getSessionUserWithRefresh(event);
    if (!viewer || !viewer.id) {
      return event.httpMethod === "GET"
        ? json(200, { templates: [], viewer: null }, cookies)
        : json(401, { error: "Please log in before saving global templates." }, cookies);
    }

    const collection = await getCollection();

    if (event.httpMethod === "GET") {
      const templates = await collection.find(
        { ownerId: viewer.id },
        { projection: { _id: 0, ownerId: 0 } }
      ).sort({ updatedAt: -1, name: 1 }).limit(200).toArray();
      return json(200, { templates: templates.map(publicTemplate), viewer }, cookies);
    }

    if (event.httpMethod === "POST") {
      const body = event.body ? JSON.parse(event.body) : {};
      const id = normalizeTemplateId(body.id || body.name);
      const name = String(body.name || "").normalize("NFKC").replace(/\s+/g, " ").trim();
      if (!name || !COMMAND_ID_PATTERN.test(id)) {
        return json(400, { error: "Choose a short command-style name." }, cookies);
      }
      if (getStaticCommandIds().has(id)) {
        return json(409, { error: `/${id} is already a command.` }, cookies);
      }

      const payload = normalizeTemplatePayload(body.payload);
      if (!payload) {
        return json(400, { error: "Choose at least one reasonably sized template item." }, cookies);
      }

      const now = Date.now();
      const template = {
        ownerId: viewer.id,
        id,
        name,
        payload,
        createdBy: authorSnapshot(viewer),
        createdAt: now,
        updatedAt: now
      };

      try {
        await collection.insertOne(template);
      } catch (error) {
        if (error && error.code === 11000) {
          return json(409, { error: `/${id} already exists in your templates.` }, cookies);
        }
        throw error;
      }

      return json(201, { template: publicTemplate(template), viewer }, cookies);
    }

    return json(405, { error: "Method not allowed." }, cookies);
  } catch (error) {
    console.error(error);
    return json(500, { error: "Server error." });
  }
};
