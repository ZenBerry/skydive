const { MongoClient } = require("mongodb");

const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "ZENBERRY_MAIN";
const collectionName = process.env.MONGODB_BOOKS_COLLECTION || "SKYDIVE_BOOKS";
const MAX_NAME_LENGTH = 500;

let collectionPromise = null;

async function getCollection() {
  if (!mongoUri) throw new Error("MONGODB_URI is required.");
  if (!collectionPromise) {
    collectionPromise = (async () => {
      const client = new MongoClient(mongoUri);
      await client.connect();
      const collection = client.db(dbName).collection(collectionName);
      await collection.createIndex({ kind: 1, src: 1 }, { unique: true, partialFilterExpression: { kind: "book" } });
      await collection.createIndex({ kind: 1, id: 1 }, { unique: true, partialFilterExpression: { kind: "book" } });
      return collection;
    })();
  }
  return collectionPromise;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

function normalizeUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > 4000) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch (error) {
    return "";
  }
}

function normalizeName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  return (name || "Book").slice(0, MAX_NAME_LENGTH);
}

function publicBook(book) {
  return book ? { id: book.id, src: book.src, name: book.name || "Book" } : null;
}

async function nextBookId(collection) {
  const result = await collection.findOneAndUpdate(
    { kind: "counter", name: "books" },
    { $inc: { seq: 1 }, $setOnInsert: { kind: "counter", name: "books" } },
    { upsert: true, returnDocument: "after" }
  );
  return result.seq;
}

async function registerBook(collection, src, name) {
  const existing = await collection.findOne({ kind: "book", src });
  if (existing) {
    await collection.updateOne(
      { _id: existing._id },
      { $set: { name, openedAt: Date.now() } }
    );
    return { ...existing, name };
  }

  const id = await nextBookId(collection);
  const book = { kind: "book", id, src, name, createdAt: Date.now(), openedAt: Date.now() };
  try {
    await collection.insertOne(book);
    return book;
  } catch (error) {
    if (error && error.code === 11000) {
      return collection.findOne({ kind: "book", src });
    }
    throw error;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});

  try {
    if (event.httpMethod === "GET") {
      const id = Number(event.queryStringParameters && event.queryStringParameters.id);
      if (!Number.isInteger(id) || id < 1) return json(400, { error: "A valid book id is required." });
      const collection = await getCollection();
      const book = await collection.findOne({ kind: "book", id }, { projection: { _id: 0, id: 1, src: 1, name: 1 } });
      if (!book) return json(404, { error: "Book not found." });
      return json(200, { book: publicBook(book) });
    }

    if (event.httpMethod === "POST") {
      const payload = event.body ? JSON.parse(event.body) : {};
      const src = normalizeUrl(payload.src);
      if (!src) return json(400, { error: "A valid book URL is required." });
      const collection = await getCollection();
      const book = await registerBook(collection, src, normalizeName(payload.name));
      return json(200, { book: publicBook(book) });
    }

    return json(405, { error: "Method not allowed." });
  } catch (error) {
    console.error(error);
    return json(500, { error: "Server error." });
  }
};
