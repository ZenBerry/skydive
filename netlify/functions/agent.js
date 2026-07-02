const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const { authorSnapshot, getSessionUser } = require("./lib/users");

const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "ZENBERRY_MAIN";
const collectionName = process.env.MONGODB_COLLECTION || "SKYDIVE_SPACES";
const agentToken = process.env.SKYDIVE_AGENT_TOKEN || "";
const agentAuthMode = (process.env.SKYDIVE_AGENT_AUTH_MODE || "public").trim().toLowerCase();
const agentAuthRequired = agentAuthMode === "token" || agentAuthMode === "private" || agentAuthMode === "required";

const MAX_NODES = 1200;
const MAX_LINES = 3000;
const MAX_OPS = 120;
const MAX_TEXT_LENGTH = 40000;
const MAX_HTML_LENGTH = 80000;
const MAX_COMMAND_STATE_LENGTH = 50000;
const CALC_OPERATIONS = new Set(["+", "-", "*", "÷", "="]);

let collectionPromise = null;
let staticCommandRegistry = { schemaVersion: 1, commands: [] };

try {
  staticCommandRegistry = require("../../commands/registry.json");
} catch (error) {
  console.error("Could not load static command registry:", error);
}

class HttpError extends Error {
  constructor(statusCode, message, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

async function getCollection() {
  if (!mongoUri) {
    throw new HttpError(503, "MONGODB_URI is required for agent space access.");
  }

  if (!collectionPromise) {
    collectionPromise = (async () => {
      const client = new MongoClient(mongoUri);
      await client.connect();
      const collection = client.db(dbName).collection(collectionName);
      await collection.createIndex({ slug: 1 }, { unique: true });
      await collection.createIndex({ updatedAt: -1 });
      return collection;
    })();
  }

  return collectionPromise;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body, null, 2)
  };
}

function getQuery(event) {
  return event.queryStringParameters || {};
}

function getToken(event) {
  const headers = event.headers || {};
  const authHeader = headers.authorization || headers.Authorization || "";
  const bearer = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (bearer) return bearer[1].trim();

  const query = getQuery(event);
  return typeof query.token === "string" ? query.token.trim() : "";
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorized(event) {
  if (!agentAuthRequired) return true;
  if (!agentToken) return false;
  const token = getToken(event);
  return Boolean(token) && timingSafeEqualString(token, agentToken);
}

function requireAuth(event) {
  if (!agentAuthRequired) return;
  if (isAuthorized(event)) return;
  if (!agentToken) {
    throw new HttpError(503, "Agent token mode is enabled, but SKYDIVE_AGENT_TOKEN is not set in Netlify.");
  }
  throw new HttpError(401, "Agent token is required.");
}

function getSlug(value) {
  const slug = typeof value === "string" ? value.trim() : "";
  if (!slug || slug.length > 500 || slug.startsWith("/") || slug.endsWith("/") || slug.includes("//")) return "";
  return slug;
}

function emptyState() {
  return {
    version: 1,
    nodes: [],
    lines: []
  };
}

function cloneJson(value, fallback) {
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return cloned === undefined ? fallback : cloned;
  } catch (error) {
    return fallback;
  }
}

function boundedString(value, maxLength, fieldName, fallback = "") {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") {
    throw new HttpError(400, `${fieldName} must be a string.`);
  }
  if (value.length > maxLength) {
    throw new HttpError(400, `${fieldName} is too long.`, { maxLength });
  }
  return value;
}

function finiteNumber(value, fallback, fieldName) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new HttpError(400, `${fieldName} must be a finite number.`);
  }
  return number;
}

function optionalTimestamp(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const timestamp = typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim())
    ? Date.parse(value)
    : Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new HttpError(400, `${fieldName} must be a positive timestamp.`);
  }
  return Math.round(timestamp);
}

function positiveNumber(value, fallback, fieldName) {
  const number = finiteNumber(value, fallback, fieldName);
  if (number <= 0) {
    throw new HttpError(400, `${fieldName} must be greater than 0.`);
  }
  return number;
}

function cleanNodeId(value, fieldName = "id") {
  const id = boundedString(value, 128, fieldName).trim();
  if (!id || !/^[a-zA-Z0-9_.:-]+$/.test(id)) {
    throw new HttpError(400, `${fieldName} must contain only letters, numbers, dots, colons, underscores, or hyphens.`);
  }
  return id;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function decodeBasicEntities(value) {
  return String(value)
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function htmlToPlainText(value) {
  return decodeBasicEntities(String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, ""));
}

function createInternalLinkHtml(label, targetId) {
  return `<span class="internal-link" data-target-id="${escapeHtml(targetId)}">${escapeHtml(label)}</span>`;
}

function normalizeCommandState(value) {
  const state = value && typeof value === "object" && !Array.isArray(value) ? cloneJson(value, {}) : {};
  if (JSON.stringify(state).length > MAX_COMMAND_STATE_LENGTH) {
    throw new HttpError(400, "commandState is too large.", { maxLength: MAX_COMMAND_STATE_LENGTH });
  }
  return state;
}

function normalizeCreator(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = boundedString(value.id, 128, "createdBy.id", "").trim();
  const nickname = boundedString(value.nickname, 80, "createdBy.nickname", "").trim();
  return id && nickname ? { id, nickname } : null;
}

function normalizeCalcOperation(value) {
  const operation = String(value || "").trim();
  if (operation === "/") return "÷";
  if (operation.toLowerCase() === "x") return "*";
  return CALC_OPERATIONS.has(operation) ? operation : "";
}

function normalizeNode(entry, seenIds) {
  if (!entry || typeof entry !== "object") {
    throw new HttpError(400, "Every node must be an object.");
  }

  const id = cleanNodeId(entry.id);
  if (seenIds.has(id)) {
    throw new HttpError(400, `Duplicate node id "${id}".`);
  }
  seenIds.add(id);

  const base = {
    id,
    x: finiteNumber(entry.x, 0, `node ${id}.x`),
    y: finiteNumber(entry.y, 0, `node ${id}.y`),
    baseFontSize: positiveNumber(entry.baseFontSize, 28, `node ${id}.baseFontSize`)
  };
  const createdAt = optionalTimestamp(entry.createdAt, `node ${id}.createdAt`);
  const deletedAt = optionalTimestamp(entry.deletedAt, `node ${id}.deletedAt`);
  if (createdAt) base.createdAt = createdAt;
  if (deletedAt) base.deletedAt = deletedAt;
  const createdBy = normalizeCreator(entry.createdBy);
  if (createdBy) base.createdBy = createdBy;

  if (entry.kind === "command") {
    return {
      ...base,
      kind: "command",
      commandId: boundedString(entry.commandId, 128, `node ${id}.commandId`).trim(),
      ...(entry.commandVersion ? { commandVersion: boundedString(entry.commandVersion, 64, `node ${id}.commandVersion`).trim() } : {}),
      commandState: normalizeCommandState(entry.commandState)
    };
  }

  const html = boundedString(entry.html, MAX_HTML_LENGTH, `node ${id}.html`, "");
  const text = boundedString(
    entry.text,
    MAX_TEXT_LENGTH,
    `node ${id}.text`,
    html ? htmlToPlainText(html) : ""
  );

  return {
    ...base,
    kind: "text",
    ...(entry.variable === true ? { variable: true } : {}),
    html: html || escapeHtml(text),
    text
  };
}

function cleanLineId(value, fallback) {
  const id = boundedString(value, 128, "line.id", fallback).trim();
  if (!id || !/^[a-zA-Z0-9_.:-]+$/.test(id)) {
    throw new HttpError(400, "line.id must contain only letters, numbers, dots, colons, underscores, or hyphens.");
  }
  return id;
}

function getLineConnectionKey(from, to) {
  return [from, to].sort().join("\u0000");
}

function normalizeLine(entry, index, nodeIds, seenLineIds, seenConnections) {
  if (!entry || typeof entry !== "object") {
    throw new HttpError(400, "Every line must be an object.");
  }

  const id = cleanLineId(entry.id, `line-${index + 1}`);
  if (seenLineIds.has(id)) {
    throw new HttpError(400, `Duplicate line id "${id}".`);
  }
  seenLineIds.add(id);

  const from = cleanNodeId(entry.from, `line ${id}.from`);
  const to = cleanNodeId(entry.to, `line ${id}.to`);
  if (from === to) {
    throw new HttpError(400, `Line "${id}" must connect two different nodes.`);
  }
  if (!nodeIds.has(from) || !nodeIds.has(to)) {
    throw new HttpError(400, `Line "${id}" references a missing node.`);
  }

  const line = { id, from, to };
  const createdAt = optionalTimestamp(entry.createdAt, `line ${id}.createdAt`);
  const deletedAt = optionalTimestamp(entry.deletedAt, `line ${id}.deletedAt`);
  const operation = normalizeCalcOperation(entry.operation);
  if (createdAt) line.createdAt = createdAt;
  if (deletedAt) line.deletedAt = deletedAt;
  if (operation) line.operation = operation;

  const connectionKey = getLineConnectionKey(from, to);
  if (!deletedAt) {
    if (seenConnections.has(connectionKey)) return null;
    seenConnections.add(connectionKey);
  }
  return line;
}

function normalizeMeta(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const meta = cloneJson(value, {});
  if (JSON.stringify(meta).length > MAX_COMMAND_STATE_LENGTH) {
    throw new HttpError(400, "meta is too large.", { maxLength: MAX_COMMAND_STATE_LENGTH });
  }
  return meta;
}

function normalizeState(rawState) {
  const source = rawState && typeof rawState === "object" ? rawState : emptyState();
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
  const rawLines = Array.isArray(source.lines) ? source.lines : [];
  if (rawNodes.length > MAX_NODES) {
    throw new HttpError(400, "State has too many nodes.", { maxNodes: MAX_NODES });
  }
  if (rawLines.length > MAX_LINES) {
    throw new HttpError(400, "State has too many lines.", { maxLines: MAX_LINES });
  }

  const seenIds = new Set();
  const nodes = rawNodes.map((entry) => normalizeNode(entry, seenIds));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const seenLineIds = new Set();
  const seenConnections = new Set();
  const lines = rawLines
    .map((entry, index) => normalizeLine(entry, index, nodeIds, seenLineIds, seenConnections))
    .filter(Boolean);

  const normalized = {
    version: Number.isFinite(Number(source.version)) ? Number(source.version) : 1,
    nodes,
    lines
  };
  const meta = normalizeMeta(source.meta);
  if (Object.keys(meta).length > 0) normalized.meta = meta;
  return normalized;
}

function getNodeMap(state) {
  return new Map(state.nodes.map((node) => [node.id, node]));
}

function requireNode(state, idValue) {
  const id = cleanNodeId(idValue);
  const node = getNodeMap(state).get(id);
  if (!node) throw new HttpError(404, `Node "${id}" was not found.`);
  return node;
}

function getNextNodeNumber(state) {
  return state.nodes.reduce((next, node) => {
    const match = /^node-(\d+)$/.exec(node.id);
    if (!match) return next;
    const value = Number(match[1]);
    return Number.isFinite(value) ? Math.max(next, value + 1) : next;
  }, 1);
}

function nthIndexOf(source, needle, occurrence) {
  let fromIndex = 0;
  for (let index = 1; index <= occurrence; index += 1) {
    const foundAt = source.indexOf(needle, fromIndex);
    if (foundAt === -1) return -1;
    if (index === occurrence) return foundAt;
    fromIndex = foundAt + needle.length;
  }
  return -1;
}

function applyNodePosition(node, op) {
  if (op.x !== undefined) node.x = finiteNumber(op.x, node.x, "x");
  if (op.y !== undefined) node.y = finiteNumber(op.y, node.y, "y");
}

function applyNodeSize(node, op) {
  if (op.baseFontSize !== undefined) {
    node.baseFontSize = positiveNumber(op.baseFontSize, node.baseFontSize, "baseFontSize");
  }
}

function applyTextUpdate(node, op) {
  if (node.kind !== "text") {
    throw new HttpError(400, `Node "${node.id}" is not a text node.`);
  }

  if (op.text !== undefined) {
    node.text = boundedString(op.text, MAX_TEXT_LENGTH, "text");
    node.html = escapeHtml(node.text);
  }

  if (op.html !== undefined) {
    node.html = boundedString(op.html, MAX_HTML_LENGTH, "html");
    node.text = op.text !== undefined ? node.text : htmlToPlainText(node.html);
  }
}

function applyCommandUpdate(node, op) {
  if (node.kind !== "command") {
    throw new HttpError(400, `Node "${node.id}" is not a command node.`);
  }

  if (op.commandId !== undefined) {
    node.commandId = boundedString(op.commandId, 128, "commandId").trim();
  }
  if (op.commandVersion !== undefined) {
    const version = boundedString(op.commandVersion, 64, "commandVersion").trim();
    if (version) node.commandVersion = version;
    else delete node.commandVersion;
  }
  if (op.commandState !== undefined) {
    node.commandState = normalizeCommandState(op.commandState);
  }
}

function applyAlignNodes(state, op) {
  const ids = Array.isArray(op.ids) ? op.ids.map((id) => cleanNodeId(id, "ids[]")) : [];
  if (ids.length < 2) {
    throw new HttpError(400, "align_nodes requires at least two ids.");
  }

  const nodes = ids.map((id) => requireNode(state, id));
  const alignment = boundedString(op.alignment, 24, "alignment").trim();
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);

  if (alignment === "left") {
    const x = Math.min(...xs);
    nodes.forEach((node) => { node.x = x; });
    return;
  }
  if (alignment === "right") {
    const x = Math.max(...xs);
    nodes.forEach((node) => { node.x = x; });
    return;
  }
  if (alignment === "center") {
    const x = xs.reduce((total, value) => total + value, 0) / xs.length;
    nodes.forEach((node) => { node.x = x; });
    return;
  }
  if (alignment === "top") {
    const y = Math.min(...ys);
    nodes.forEach((node) => { node.y = y; });
    return;
  }
  if (alignment === "bottom") {
    const y = Math.max(...ys);
    nodes.forEach((node) => { node.y = y; });
    return;
  }
  if (alignment === "middle") {
    const y = ys.reduce((total, value) => total + value, 0) / ys.length;
    nodes.forEach((node) => { node.y = y; });
    return;
  }

  throw new HttpError(400, "alignment must be left, right, center, top, bottom, or middle.");
}

function applyDistributeNodes(state, op) {
  const ids = Array.isArray(op.ids) ? op.ids.map((id) => cleanNodeId(id, "ids[]")) : [];
  if (ids.length < 3) {
    throw new HttpError(400, "distribute_nodes requires at least three ids.");
  }

  const direction = boundedString(op.direction, 24, "direction").trim();
  const axis = direction === "vertical" ? "y" : direction === "horizontal" ? "x" : "";
  if (!axis) throw new HttpError(400, "direction must be horizontal or vertical.");

  const nodes = ids.map((id) => requireNode(state, id)).sort((left, right) => left[axis] - right[axis]);
  const first = nodes[0][axis];
  const last = nodes[nodes.length - 1][axis];
  const step = (last - first) / (nodes.length - 1);
  nodes.forEach((node, index) => {
    node[axis] = first + step * index;
  });
}

function applyLinkText(state, op) {
  const source = requireNode(state, op.sourceId);
  const target = requireNode(state, op.targetId);
  if (source.kind !== "text") {
    throw new HttpError(400, "link_text sourceId must point to a text node.");
  }

  const sourceText = source.text || htmlToPlainText(source.html);
  const needle = boundedString(op.text, MAX_TEXT_LENGTH, "text");
  const label = boundedString(op.label, MAX_TEXT_LENGTH, "label", needle);
  const occurrence = Math.max(1, Math.floor(finiteNumber(op.occurrence, 1, "occurrence")));
  const start = nthIndexOf(sourceText, needle, occurrence);
  if (!needle || start === -1) {
    throw new HttpError(400, `Could not find text "${needle}" in node "${source.id}".`);
  }

  const before = sourceText.slice(0, start);
  const after = sourceText.slice(start + needle.length);
  source.text = sourceText;
  source.html = `${escapeHtml(before)}${createInternalLinkHtml(label, target.id)}${escapeHtml(after)}`;
}

function attributeReplacementNodes(nextState, currentState, creator) {
  const currentById = new Map(currentState.nodes.map((node) => [node.id, node]));
  nextState.nodes = nextState.nodes.map((node) => {
    const current = currentById.get(node.id);
    if (current && current.createdBy) return { ...node, createdBy: current.createdBy };
    if (current) {
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

function applyOps(currentState, ops, viewer = null) {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new HttpError(400, "ops must be a non-empty array.");
  }
  if (ops.length > MAX_OPS) {
    throw new HttpError(400, "Too many ops.", { maxOps: MAX_OPS });
  }

  let state = normalizeState(currentState);
  const creator = authorSnapshot(viewer);
  const allocatedIds = new Set(state.nodes.map((node) => node.id));
  let nextNodeNumber = getNextNodeNumber(state);

  function allocateNodeId(requested) {
    if (requested !== undefined && requested !== null && requested !== "") {
      const id = cleanNodeId(requested);
      if (allocatedIds.has(id)) throw new HttpError(409, `Node "${id}" already exists.`);
      allocatedIds.add(id);
      return id;
    }

    let id = `node-${nextNodeNumber}`;
    while (allocatedIds.has(id)) {
      nextNodeNumber += 1;
      id = `node-${nextNodeNumber}`;
    }
    nextNodeNumber += 1;
    allocatedIds.add(id);
    return id;
  }

  for (const op of ops) {
    if (!op || typeof op !== "object") {
      throw new HttpError(400, "Every op must be an object.");
    }

    const opName = boundedString(op.op, 64, "op").trim();
    if (opName === "replace_state") {
      state = attributeReplacementNodes(normalizeState(op.state), state, creator);
      allocatedIds.clear();
      state.nodes.forEach((node) => allocatedIds.add(node.id));
      nextNodeNumber = getNextNodeNumber(state);
      continue;
    }

    if (opName === "create_text_node") {
      const text = boundedString(op.text, MAX_TEXT_LENGTH, "text", "");
      const html = op.html === undefined ? escapeHtml(text) : boundedString(op.html, MAX_HTML_LENGTH, "html");
      state.nodes.push({
        id: allocateNodeId(op.id),
        kind: "text",
        x: finiteNumber(op.x, 0, "x"),
        y: finiteNumber(op.y, 0, "y"),
        baseFontSize: positiveNumber(op.baseFontSize, 28, "baseFontSize"),
        createdAt: Date.now(),
        ...(creator ? { createdBy: creator } : {}),
        text: op.text === undefined ? htmlToPlainText(html) : text,
        html
      });
      continue;
    }

    if (opName === "create_command_node") {
      const commandVersion = boundedString(op.commandVersion, 64, "commandVersion", "").trim();
      state.nodes.push({
        id: allocateNodeId(op.id),
        kind: "command",
        x: finiteNumber(op.x, 0, "x"),
        y: finiteNumber(op.y, 0, "y"),
        baseFontSize: positiveNumber(op.baseFontSize, 28, "baseFontSize"),
        createdAt: Date.now(),
        ...(creator ? { createdBy: creator } : {}),
        commandId: boundedString(op.commandId, 128, "commandId").trim(),
        ...(commandVersion ? { commandVersion } : {}),
        commandState: normalizeCommandState(op.commandState)
      });
      continue;
    }

    if (opName === "update_node" || opName === "edit_node") {
      const node = requireNode(state, op.id);
      applyNodePosition(node, op);
      applyNodeSize(node, op);
      if (op.text !== undefined || op.html !== undefined) applyTextUpdate(node, op);
      if (op.commandId !== undefined || op.commandVersion !== undefined || op.commandState !== undefined) {
        applyCommandUpdate(node, op);
      }
      continue;
    }

    if (opName === "move_node") {
      applyNodePosition(requireNode(state, op.id), op);
      continue;
    }

    if (opName === "resize_node") {
      applyNodeSize(requireNode(state, op.id), op);
      continue;
    }

    if (opName === "delete_node") {
      const id = cleanNodeId(op.id);
      const node = state.nodes.find((entry) => entry.id === id);
      const deletedAt = Date.now();
      if (node) node.deletedAt = deletedAt;
      state.lines.forEach((line) => {
        if (line.deletedAt || (line.from !== id && line.to !== id)) return;
        line.deletedAt = deletedAt;
      });
      if (!node) throw new HttpError(404, `Node "${id}" was not found.`);
      continue;
    }

    if (opName === "align_nodes") {
      applyAlignNodes(state, op);
      continue;
    }

    if (opName === "distribute_nodes") {
      applyDistributeNodes(state, op);
      continue;
    }

    if (opName === "link_text") {
      applyLinkText(state, op);
      continue;
    }

    throw new HttpError(400, `Unknown op "${opName}".`);
  }

  return normalizeState(state);
}

async function ensureSpace(collection, slug, viewer = null) {
  const now = Date.now();
  const creator = authorSnapshot(viewer);
  await collection.updateOne(
    { slug },
    { $setOnInsert: { slug, state: null, revision: 0, createdAt: now, updatedAt: now, createdBy: creator } },
    { upsert: true }
  );
  await collection.updateOne(
    { slug, "state.camera": { $exists: true } },
    { $unset: { "state.camera": "" } }
  );
  return collection.findOne(
    { slug },
    { projection: { _id: 0, slug: 1, state: 1, updatedAt: 1, revision: 1, createdBy: 1 } }
  );
}

function buildManifest(event) {
  const authed = isAuthorized(event);
  return {
    name: "Skydive Agent Interface",
    schemaVersion: 1,
    access: agentAuthRequired ? "token" : "public",
    authenticated: authed,
    auth: {
      required: agentAuthRequired,
      requiredFor: agentAuthRequired ? ["list_spaces", "read_space", "apply_ops"] : [],
      header: "Authorization: Bearer <SKYDIVE_AGENT_TOKEN>",
      queryFallback: "token=<SKYDIVE_AGENT_TOKEN>",
      privateMode: "Set SKYDIVE_AGENT_AUTH_MODE=token and SKYDIVE_AGENT_TOKEN to require auth."
    },
    endpoints: {
      manifest: "GET /api/agent?manifest=1",
      listSpaces: "GET /api/agent?spaces=1",
      readSpace: "GET /api/agent?space=<slug>",
      applyOps: "POST /api/agent"
    },
    stateShape: {
      version: "number",
      nodes: [
        {
          kind: "text",
          id: "string",
          x: "number",
          y: "number",
          baseFontSize: "number",
          createdAt: "optional number",
          deletedAt: "optional number",
          createdBy: "optional { id, nickname } assigned from the active Skydive session",
          variable: "optional boolean for read-only calculation result nodes",
          text: "string",
          html: "string"
        },
        {
          kind: "command",
          id: "string",
          x: "number",
          y: "number",
          baseFontSize: "number",
          createdAt: "optional number",
          deletedAt: "optional number",
          createdBy: "optional { id, nickname } assigned from the active Skydive session",
          commandId: "string",
          commandVersion: "optional string",
          commandState: "object"
        }
      ],
      lines: [
        {
          id: "string",
          from: "node id",
          to: "node id",
          operation: "optional one of +, -, *, ÷, =",
          createdAt: "optional number",
          deletedAt: "optional number"
        }
      ],
      meta: "optional object"
    },
    operations: [
      "create_text_node",
      "create_command_node",
      "update_node",
      "move_node",
      "resize_node",
      "delete_node",
      "align_nodes",
      "distribute_nodes",
      "link_text",
      "replace_state"
    ],
    commands: {
      staticCommands: true,
      dynamicCommandDefinitions: false,
      definitionSchemaVersion: staticCommandRegistry.schemaVersion || 1,
      definitions: Array.isArray(staticCommandRegistry.commands) ? staticCommandRegistry.commands : [],
      futureRuntimeNote: "Command nodes already preserve commandVersion. Dynamic executable definitions can later be added as another registry source without changing space nodes."
    },
    limits: {
      maxOps: MAX_OPS,
      maxNodes: MAX_NODES,
      maxLines: MAX_LINES,
      maxTextLength: MAX_TEXT_LENGTH,
      maxHtmlLength: MAX_HTML_LENGTH
    }
  };
}

async function listSpaces(collection) {
  const spaces = await collection.find(
    {},
    { projection: { _id: 0, slug: 1, updatedAt: 1, revision: 1, createdBy: 1 } }
  ).sort({ updatedAt: -1 }).limit(500).toArray();

  return spaces.map((space) => ({
    slug: space.slug,
    updatedAt: Number(space.updatedAt) || 0,
    revision: Number(space.revision) || 0,
    createdBy: space.createdBy || null
  }));
}

async function applySpaceOps(collection, payload, viewer = null) {
  const slug = getSlug(payload.space);
  if (!slug) throw new HttpError(400, "A valid space slug is required.");

  const current = await ensureSpace(collection, slug, viewer);
  const currentRevision = Number(current.revision) || 0;
  if (payload.baseRevision !== undefined && Number(payload.baseRevision) !== currentRevision) {
    throw new HttpError(409, "Space revision changed before ops could be applied.", {
      expectedRevision: payload.baseRevision,
      currentRevision,
      space: {
        slug,
        revision: currentRevision,
        updatedAt: Number(current.updatedAt) || 0,
        state: normalizeState(current.state)
      }
    });
  }

  const state = applyOps(current.state, payload.ops, viewer);
  const now = Date.now();
  const revisionFilter = current.revision === undefined
    ? { $or: [{ revision: { $exists: false } }, { revision: 0 }] }
    : { revision: currentRevision };
  const result = await collection.updateOne(
    { slug, ...revisionFilter },
    {
      $set: { slug, state, updatedAt: now },
      $inc: { revision: 1 },
      $setOnInsert: { createdAt: now, createdBy: authorSnapshot(viewer) }
    },
    { upsert: false }
  );

  if (result.matchedCount !== 1) {
    throw new HttpError(409, "Space changed while ops were being saved. Read it again and retry.");
  }

  return {
    slug,
    revision: currentRevision + 1,
    updatedAt: now,
    appliedOps: payload.ops.length,
    state
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return json(204, {});
  }

  try {
    const query = getQuery(event);
    if (event.httpMethod === "GET" && (query.manifest || (!query.spaces && !query.space))) {
      return json(200, buildManifest(event));
    }

    if (event.httpMethod === "GET" && query.spaces) {
      requireAuth(event);
      const collection = await getCollection();
      return json(200, { spaces: await listSpaces(collection) });
    }

    if (event.httpMethod === "GET" && query.space) {
      requireAuth(event);
      const collection = await getCollection();
      const viewer = await getSessionUser(event);
      const slug = getSlug(query.space);
      if (!slug) return json(400, { error: "A valid space slug is required." });
      const space = await ensureSpace(collection, slug, viewer);
      return json(200, {
        slug,
        revision: Number(space.revision) || 0,
        updatedAt: Number(space.updatedAt) || 0,
        createdBy: space.createdBy || null,
        state: normalizeState(space.state)
      });
    }

    if (event.httpMethod === "POST") {
      requireAuth(event);
      const collection = await getCollection();
      const viewer = await getSessionUser(event);
      const payload = event.body ? JSON.parse(event.body) : {};
      return json(200, await applySpaceOps(collection, payload, viewer));
    }

    return json(405, { error: "Method not allowed." });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return json(400, { error: "Request body must be valid JSON." });
    }
    if (error instanceof HttpError) {
      return json(error.statusCode, {
        error: error.message,
        ...(error.details ? { details: error.details } : {})
      });
    }
    console.error(error);
    return json(500, { error: "Server error." });
  }
};
