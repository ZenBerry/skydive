const { MongoClient } = require("mongodb");

const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "ZENBERRY_MAIN";
const collectionName = process.env.MONGODB_BOOKS_COLLECTION || "SKYDIVE_BOOKS";
const MAX_NAME_LENGTH = 500;
const MAX_HIGHLIGHTS = 500;
const MAX_MARK_HISTORY = 80;

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
      "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
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
  return book ? {
    id: book.id,
    src: book.src,
    name: book.name || "Book",
    position: normalizePosition(book.position),
    highlights: normalizeHighlights(book.highlights),
    markHistory: normalizeMarkHistory(book.markHistory)
  } : null;
}

function normalizePosition(value) {
  if (!value || typeof value !== "object") return { pageIndex: 0 };
  const pageIndex = Number(value.pageIndex);
  return {
    pageIndex: Number.isInteger(pageIndex) && pageIndex >= 0 ? Math.min(pageIndex, 100000) : 0,
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : Date.now()
  };
}

function normalizeColor(value) {
  const color = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : "";
}

function normalizeHighlights(value) {
  const list = Array.isArray(value) ? value : [];
  return list.slice(-MAX_HIGHLIGHTS).map((highlight) => {
    if (!highlight || typeof highlight !== "object") return null;
    const id = String(highlight.id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    const start = Number(highlight.start);
    const end = Number(highlight.end);
    const color = normalizeColor(highlight.color);
    if (!id || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || !color) return null;
    return {
      id,
      start: Math.min(start, 20000000),
      end: Math.min(end, 20000000),
      color,
      text: String(highlight.text || "").replace(/\s+/g, " ").trim().slice(0, 500)
    };
  }).filter(Boolean);
}

function normalizeMarkHistory(value) {
  const list = Array.isArray(value) ? value : [];
  return list.slice(-MAX_MARK_HISTORY).map((message) => {
    if (!message || typeof message !== "object") return null;
    const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "";
    const content = String(message.content || "").trim().slice(0, 12000);
    if (!role || !content) return null;
    return { role, content };
  }).filter(Boolean);
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

function getSessionBookId(payload) {
  const id = Number(payload.id);
  return Number.isInteger(id) && id >= 1 ? id : 0;
}

async function updateBookSession(collection, id, payload) {
  const set = { sessionUpdatedAt: Date.now() };
  if (Object.prototype.hasOwnProperty.call(payload, "position")) set.position = normalizePosition(payload.position);
  if (Object.prototype.hasOwnProperty.call(payload, "highlights")) set.highlights = normalizeHighlights(payload.highlights);
  if (Object.prototype.hasOwnProperty.call(payload, "markHistory")) set.markHistory = normalizeMarkHistory(payload.markHistory);
  const book = await collection.findOneAndUpdate(
    { kind: "book", id },
    { $set: set },
    { returnDocument: "after", projection: { _id: 0, id: 1, src: 1, name: 1, position: 1, highlights: 1, markHistory: 1 } }
  );
  if (!book) return { error: json(404, { error: "Book not found." }) };
  return { book };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});

  try {
    if (event.httpMethod === "GET") {
      const id = Number(event.queryStringParameters && event.queryStringParameters.id);
      if (!Number.isInteger(id) || id < 1) return json(400, { error: "A valid book id is required." });
      const collection = await getCollection();
      const book = await collection.findOne(
        { kind: "book", id },
        { projection: { _id: 0, id: 1, src: 1, name: 1, position: 1, highlights: 1, markHistory: 1 } }
      );
      if (!book) return json(404, { error: "Book not found." });
      return json(200, { book: publicBook(book) });
    }

    if (event.httpMethod === "POST") {
      const payload = event.body ? JSON.parse(event.body) : {};
      if (Object.prototype.hasOwnProperty.call(payload, "id")) {
        const id = getSessionBookId(payload);
        if (!id) return json(400, { error: "A valid book id is required." });
        const collection = await getCollection();
        const result = await updateBookSession(collection, id, payload);
        if (result.error) return result.error;
        return json(200, { book: publicBook(result.book) });
      }
      const src = normalizeUrl(payload.src);
      if (!src) return json(400, { error: "A valid book URL is required." });
      const collection = await getCollection();
      const book = await registerBook(collection, src, normalizeName(payload.name));
      return json(200, { book: publicBook(book) });
    }

    if (event.httpMethod === "PATCH") {
      const payload = event.body ? JSON.parse(event.body) : {};
      const id = getSessionBookId(payload);
      if (!id) return json(400, { error: "A valid book id is required." });
      const collection = await getCollection();
      const result = await updateBookSession(collection, id, payload);
      if (result.error) return result.error;
      return json(200, { book: publicBook(result.book) });
    }

    return json(405, { error: "Method not allowed." });
  } catch (error) {
    console.error(error);
    return json(500, { error: "Server error." });
  }
};
