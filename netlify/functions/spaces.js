const { MongoClient } = require("mongodb");
const { authorSnapshot, getSessionUserWithRefresh } = require("./lib/users");

const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "ZENBERRY_MAIN";
const collectionName = process.env.MONGODB_COLLECTION || "SKYDIVE_SPACES";

let collectionPromise = null;

async function getCollection() {
  if (!mongoUri) {
    throw new Error("MONGODB_URI is required.");
  }

  if (!collectionPromise) {
    collectionPromise = (async () => {
      const client = new MongoClient(mongoUri);
      await client.connect();
      const collection = client.db(dbName).collection(collectionName);
      await collection.createIndex({ slug: 1 }, { unique: true });
      return collection;
    })();
  }

  return collectionPromise;
}

function json(statusCode, body, cookies = []) {
  const response = {
    statusCode,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
  if (cookies.length) response.multiValueHeaders = { "Set-Cookie": cookies };
  return response;
}

function getSlug(event) {
  const slug = event.queryStringParameters && event.queryStringParameters.slug
    ? decodeURIComponent(event.queryStringParameters.slug).trim()
    : "";

  if (!slug || slug.length > 500 || slug.startsWith("/") || slug.endsWith("/") || slug.includes("//")) {
    return "";
  }

  return slug;
}

function stripViewportState(state) {
  const nextState = { ...state };
  delete nextState.camera;
  return nextState;
}

function attributeNewNodes(state, currentState, viewer) {
  const nextState = JSON.parse(JSON.stringify(state));
  const existingNodes = currentState && Array.isArray(currentState.nodes) ? currentState.nodes : [];
  const existingById = new Map(existingNodes.map((node) => [String(node.id || ""), node]));
  const creator = authorSnapshot(viewer);
  if (!Array.isArray(nextState.nodes)) return nextState;

  nextState.nodes = nextState.nodes.map((node) => {
    if (!node || typeof node !== "object") return node;
    const existing = existingById.get(String(node.id || ""));
    if (existing && existing.createdBy) return { ...node, createdBy: existing.createdBy };
    if (existing) {
      const copy = { ...node };
      delete copy.createdBy;
      return copy;
    }
    if (creator) return { ...node, createdBy: creator };
    const copy = { ...node };
    delete copy.createdBy;
    return copy;
  });
  return nextState;
}

exports.handler = async (event) => {
  const slug = getSlug(event);
  if (!slug) {
    return json(400, { error: "A valid slug is required." });
  }

  try {
    const collection = await getCollection();
    const { user: viewer, cookies } = await getSessionUserWithRefresh(event);
    const creator = authorSnapshot(viewer);

    if (event.httpMethod === "GET") {
      const now = Date.now();
      await collection.updateOne(
        { slug },
        { $setOnInsert: { slug, state: null, revision: 0, createdAt: now, updatedAt: now, createdBy: creator } },
        { upsert: true }
      );
      await collection.updateOne(
        { slug, "state.camera": { $exists: true } },
        { $unset: { "state.camera": "" } }
      );

      const space = await collection.findOne(
        { slug },
        { projection: { _id: 0, slug: 1, state: 1, updatedAt: 1, revision: 1, createdBy: 1 } }
      );

      return json(200, { ...space, viewer }, cookies);
    }

    if (event.httpMethod === "PUT") {
      const payload = event.body ? JSON.parse(event.body) : {};
      if (!payload.state || typeof payload.state !== "object") {
        return json(400, { error: "A state object is required." });
      }

      const now = Date.now();
      const current = await collection.findOne({ slug }, { projection: { _id: 0, state: 1 } });
      const state = attributeNewNodes(stripViewportState(payload.state), current && current.state, viewer);
      await collection.updateOne(
        { slug },
        {
          $set: { slug, state, updatedAt: now },
          $inc: { revision: 1 },
          $setOnInsert: { createdAt: now, createdBy: creator }
        },
        { upsert: true }
      );

      return json(200, { slug, updatedAt: now, viewer }, cookies);
    }

    return json(405, { error: "Method not allowed." });
  } catch (error) {
    console.error(error);
    return json(500, { error: "Server error." });
  }
};
