const { MongoClient } = require("mongodb");

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

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

function getSlug(event) {
  const slug = event.queryStringParameters && event.queryStringParameters.slug
    ? decodeURIComponent(event.queryStringParameters.slug).trim()
    : "";

  if (!slug || slug.includes("/")) {
    return "";
  }

  return slug;
}

exports.handler = async (event) => {
  const slug = getSlug(event);
  if (!slug) {
    return json(400, { error: "A valid slug is required." });
  }

  try {
    const collection = await getCollection();

    if (event.httpMethod === "GET") {
      const now = Date.now();
      await collection.updateOne(
        { slug },
        { $setOnInsert: { slug, state: null, createdAt: now, updatedAt: now } },
        { upsert: true }
      );

      const space = await collection.findOne(
        { slug },
        { projection: { _id: 0, slug: 1, state: 1, updatedAt: 1 } }
      );

      return json(200, space);
    }

    if (event.httpMethod === "PUT") {
      const payload = event.body ? JSON.parse(event.body) : {};
      if (!payload.state || typeof payload.state !== "object") {
        return json(400, { error: "A state object is required." });
      }

      const now = Date.now();
      await collection.updateOne(
        { slug },
        {
          $set: { slug, state: payload.state, updatedAt: now },
          $setOnInsert: { createdAt: now }
        },
        { upsert: true }
      );

      return json(200, { slug, updatedAt: now });
    }

    return json(405, { error: "Method not allowed." });
  } catch (error) {
    console.error(error);
    return json(500, { error: "Server error." });
  }
};
