const { createReadStream, statSync } = require("fs");
const { createServer } = require("http");
const { MongoClient } = require("mongodb");
const { extname, isAbsolute, join, normalize, relative } = require("path");

const root = __dirname;
const port = Number(process.env.PORT) || 8000;
const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "ZENBERRY_MAIN";
const collectionName = process.env.MONGODB_COLLECTION || "SKYDIVE_SPACES";
let collectionPromise = null;

const types = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json"
};

async function getCollection() {
  if (!mongoUri) {
    throw new Error("MONGODB_URI is required for shared spaces.");
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

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) {
        request.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function getSpaceSlug(pathname) {
  if (!pathname.startsWith("/api/spaces/")) return "";
  const slug = decodeURIComponent(pathname.slice("/api/spaces/".length)).trim();
  if (!slug || slug.includes("/")) return "";
  return slug;
}

async function handleApi(request, response, url) {
  const slug = getSpaceSlug(url.pathname);
  if (!slug) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  const collection = await getCollection();

  if (request.method === "GET") {
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
    sendJson(response, 200, space);
    return;
  }

  if (request.method === "PUT") {
    const body = await readJson(request);
    if (!body.state || typeof body.state !== "object") {
      sendJson(response, 400, { error: "A state object is required." });
      return;
    }

    const now = Date.now();
    await collection.updateOne(
      { slug },
      {
        $set: { slug, state: body.state, updatedAt: now },
        $setOnInsert: { createdAt: now }
      },
      { upsert: true }
    );
    sendJson(response, 200, { slug, updatedAt: now });
    return;
  }

  sendJson(response, 405, { error: "Method not allowed" });
}

function getFilePath(url) {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const requested = normalize(join(root, pathname));
  const relativePath = relative(root, requested);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return join(root, "index.html");
  }

  try {
    if (statSync(requested).isFile()) return requested;
  } catch {}

  return join(root, "index.html");
}

createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    void handleApi(request, response, url).catch((error) => {
      console.error(error);
      sendJson(response, 500, { error: "Server error" });
    });
    return;
  }

  const filePath = getFilePath(request.url);
  response.setHeader("Content-Type", types[extname(filePath)] || "application/octet-stream");
  createReadStream(filePath).pipe(response);
}).listen(port, () => {
  console.log(`Skydive is running at http://localhost:${port}`);
});
