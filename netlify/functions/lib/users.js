const crypto = require("crypto");
const { promisify } = require("util");
const { MongoClient } = require("mongodb");

const mongoUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "ZENBERRY_MAIN";
const usersCollectionName = process.env.MONGODB_USERS_COLLECTION || "SKYDIVE_USERS";
const sessionsCollectionName = process.env.MONGODB_USER_SESSIONS_COLLECTION || "SKYDIVE_USER_SESSIONS";
const SESSION_COOKIE = "skydive_session";
const FLOW_COOKIE = "skydive_mark_flow";
const DAY_SECONDS = 60 * 60 * 24;
const SESSION_SECONDS = positiveInteger(process.env.SKYDIVE_SESSION_SECONDS, DAY_SECONDS * 400);
const SESSION_REFRESH_SECONDS = positiveInteger(process.env.SKYDIVE_SESSION_REFRESH_SECONDS, DAY_SECONDS);
const FLOW_SECONDS = 60 * 10;
const scrypt = promisify(crypto.scrypt);

let collectionsPromise = null;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function getCollections() {
  if (!mongoUri) throw new Error("MONGODB_URI is required for user access.");
  if (!collectionsPromise) {
    collectionsPromise = (async () => {
      const client = new MongoClient(mongoUri);
      await client.connect();
      const db = client.db(dbName);
      const users = db.collection(usersCollectionName);
      const sessions = db.collection(sessionsCollectionName);
      await Promise.all([
        users.createIndex({ nicknameKey: 1 }, { unique: true }),
        sessions.createIndex({ tokenHash: 1 }, { unique: true }),
        sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        sessions.createIndex({ userId: 1 })
      ]);
      return { users, sessions };
    })();
  }
  return collectionsPromise;
}

function parseCookies(event) {
  const headers = event.headers || {};
  const raw = headers.cookie || headers.Cookie || "";
  return Object.fromEntries(raw.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      return [key, decodeURIComponent(value)];
    } catch (error) {
      return [key, value];
    }
  }).filter(([key]) => key));
}

function secureCookie(event) {
  const headers = event.headers || {};
  const protocol = headers["x-forwarded-proto"] || "https";
  return protocol === "https" ? "; Secure" : "";
}

function cookie(event, name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie(event)}`;
}

function clearCookie(event, name) {
  return cookie(event, name, "", 0);
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("base64url");
}

function normalizeNickname(value) {
  const nickname = String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!nickname || nickname.length > 80 || /[\u0000-\u001f\u007f]/.test(nickname)) return null;
  return { nickname, nicknameKey: nickname.toLocaleLowerCase("en-US") };
}

function publicUser(user) {
  if (!user) return null;
  return { id: String(user.userId || user.id || user._id || ""), nickname: String(user.nickname || "") };
}

function authorSnapshot(user) {
  const visible = publicUser(user);
  return visible && visible.id && visible.nickname ? visible : null;
}

async function getSessionRecord(event) {
  const token = parseCookies(event)[SESSION_COOKIE];
  if (!token) return null;
  const { sessions } = await getCollections();
  return sessions.findOne({
    kind: "session",
    tokenHash: tokenHash(token),
    expiresAt: { $gt: new Date() }
  });
}

async function getSessionUser(event) {
  const session = await getSessionRecord(event);
  return session ? publicUser(session) : null;
}

async function refreshSession(event) {
  const token = parseCookies(event)[SESSION_COOKIE];
  if (!token) return [];

  const { sessions } = await getCollections();
  const now = new Date();
  const hash = tokenHash(token);
  const session = await sessions.findOne({
    kind: "session",
    tokenHash: hash,
    expiresAt: { $gt: now }
  });
  if (!session) return [];

  const lastRefresh = session.refreshedAt || session.createdAt || new Date(0);
  const ageMs = now.getTime() - new Date(lastRefresh).getTime();
  const remainingMs = new Date(session.expiresAt).getTime() - now.getTime();
  const shouldRefresh = ageMs >= SESSION_REFRESH_SECONDS * 1000 ||
    remainingMs < (SESSION_SECONDS - SESSION_REFRESH_SECONDS) * 1000;
  if (!shouldRefresh) return [];

  await sessions.updateOne(
    { _id: session._id, kind: "session", tokenHash: hash },
    {
      $set: {
        refreshedAt: now,
        expiresAt: new Date(now.getTime() + SESSION_SECONDS * 1000)
      }
    }
  );
  return [cookie(event, SESSION_COOKIE, token, SESSION_SECONDS)];
}

async function getSessionUserWithRefresh(event) {
  const session = await getSessionRecord(event);
  if (!session) return { user: null, cookies: [] };
  return {
    user: publicUser(session),
    cookies: await refreshSession(event)
  };
}

async function deleteTokenRecord(event, cookieName) {
  const token = parseCookies(event)[cookieName];
  if (!token) return;
  const { sessions } = await getCollections();
  await sessions.deleteOne({ tokenHash: tokenHash(token) });
}

async function createSession(event, user) {
  const { sessions } = await getCollections();
  await deleteTokenRecord(event, SESSION_COOKIE);
  const token = randomToken();
  await sessions.insertOne({
    kind: "session",
    tokenHash: tokenHash(token),
    userId: String(user._id),
    nickname: user.nickname,
    createdAt: new Date(),
    refreshedAt: new Date(),
    expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000)
  });
  return cookie(event, SESSION_COOKIE, token, SESSION_SECONDS);
}

async function createFlow(event, action, data = {}) {
  const { sessions } = await getCollections();
  await deleteTokenRecord(event, FLOW_COOKIE);
  const token = randomToken();
  await sessions.insertOne({
    kind: "flow",
    tokenHash: tokenHash(token),
    action,
    data,
    attempts: 0,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + FLOW_SECONDS * 1000)
  });
  return cookie(event, FLOW_COOKIE, token, FLOW_SECONDS);
}

async function getFlow(event) {
  const token = parseCookies(event)[FLOW_COOKIE];
  if (!token) return null;
  const { sessions } = await getCollections();
  return sessions.findOne({
    kind: "flow",
    tokenHash: tokenHash(token),
    expiresAt: { $gt: new Date() }
  });
}

async function clearFlow(event) {
  await deleteTokenRecord(event, FLOW_COOKIE);
  return clearCookie(event, FLOW_COOKIE);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(String(password), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt: salt.toString("base64url"), hash: derived.toString("base64url") };
}

async function verifyPassword(password, stored) {
  if (!stored || !stored.salt || !stored.hash) return false;
  const derived = await scrypt(String(password), Buffer.from(stored.salt, "base64url"), 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  });
  const expected = Buffer.from(stored.hash, "base64url");
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

function accountReply(reply, options = {}) {
  return {
    direct: true,
    reply,
    secretInput: options.secretInput === true,
    cookies: options.cookies || [],
    user: options.user || null
  };
}

async function beginRegistration(event) {
  const current = await getSessionUser(event);
  if (current) return accountReply(`You’re already logged in as ${current.nickname}. Log out first if you’d like a different account.`, { user: current });
  return accountReply("Sure! What nickname would you prefer?", {
    cookies: [await createFlow(event, "register_nickname")]
  });
}

async function beginLogin(event) {
  const current = await getSessionUser(event);
  if (current) return accountReply(`You’re already logged in as ${current.nickname}.`, { user: current });
  return accountReply("Of course. What’s your nickname?", {
    cookies: [await createFlow(event, "login_nickname")]
  });
}

async function logout(event) {
  const current = await getSessionUser(event);
  await Promise.all([deleteTokenRecord(event, SESSION_COOKIE), deleteTokenRecord(event, FLOW_COOKIE)]);
  return accountReply(current ? `Logged out ${current.nickname}. See you around! ^_^` : "You’re already logged out.", {
    cookies: [clearCookie(event, SESSION_COOKIE), clearCookie(event, FLOW_COOKIE)]
  });
}

async function status(event) {
  const current = await getSessionUser(event);
  return accountReply(current ? `You’re logged in as ${current.nickname}.` : "You’re not logged in right now.", { user: current });
}

async function beginPasswordChange(event) {
  const current = await getSessionUser(event);
  if (!current) return accountReply("Please log in first, then I can save a password for you.");
  return accountReply("Type your new password. I’ve hidden the input; tap the eye if you want to peek.", {
    secretInput: true,
    user: current,
    cookies: [await createFlow(event, "set_password", { userId: current.id })]
  });
}

async function removePassword(event) {
  const current = await getSessionUser(event);
  if (!current) return accountReply("Please log in first.");
  const { users } = await getCollections();
  await users.updateOne({ _id: current.id }, { $unset: { password: "" }, $set: { updatedAt: new Date() } });
  return accountReply("Password removed. You’re still logged in, and future logins only need your nickname.", { user: current });
}

async function beginRename(event) {
  const current = await getSessionUser(event);
  if (!current) return accountReply("Please log in first.");
  return accountReply("What should I call you instead?", {
    user: current,
    cookies: [await createFlow(event, "rename_nickname", { userId: current.id })]
  });
}

async function beginDeletion(event) {
  const current = await getSessionUser(event);
  if (!current) return accountReply("There’s no logged-in account to delete.");
  return accountReply(`I can permanently delete ${current.nickname}. Say “yes, delete it” to confirm—or anything else to cancel.`, {
    user: current,
    cookies: [await createFlow(event, "delete_confirm", { userId: current.id, nickname: current.nickname })]
  });
}

async function runAccountAction(event, name) {
  if (name === "user_begin_registration") return beginRegistration(event);
  if (name === "user_begin_login") return beginLogin(event);
  if (name === "user_logout") return logout(event);
  if (name === "user_status") return status(event);
  if (name === "user_begin_password_change") return beginPasswordChange(event);
  if (name === "user_remove_password") return removePassword(event);
  if (name === "user_begin_rename") return beginRename(event);
  if (name === "user_begin_deletion") return beginDeletion(event);
  return null;
}

function matchAccountIntent(content) {
  const text = String(content || "").toLocaleLowerCase("en-US");
  if (/\b(log(?:\s+me)?\s*out|logout|sign\s*out)\b/.test(text)) return "user_logout";
  if (/\b(register|sign\s*up|create (?:me )?(?:an? )?(?:user|account))\b/.test(text)) return "user_begin_registration";
  if (/\b(log\s*in|login|sign\s*in)\b/.test(text)) return "user_begin_login";
  if (/\b(who am i|am i logged in|account status|current user)\b/.test(text)) return "user_status";
  if (/\b(remove|clear|delete)\b[\s\S]*\bpassword\b/.test(text)) return "user_remove_password";
  if (/\b(set|change|add|update)\b[\s\S]*\bpassword\b/.test(text)) return "user_begin_password_change";
  if (/\b(rename (?:me|my account)|change my (?:name|nickname))\b/.test(text)) return "user_begin_rename";
  if (/\b(delete|remove)\b[\s\S]*\b(my )?(?:user|account|profile)\b/.test(text)) return "user_begin_deletion";
  return null;
}

async function handleActiveFlow(event, content, secret) {
  const flow = await getFlow(event);
  if (!flow) {
    if (secret) return accountReply("I wasn’t expecting hidden input, so I didn’t send or save it anywhere.", { secretInput: false });
    return null;
  }

  const { users, sessions } = await getCollections();
  const cookies = [];
  const simpleReply = String(content).trim();
  if (/^(?:cancel|never mind|nevermind|stop)$/i.test(simpleReply)) {
    cookies.push(await clearFlow(event));
    return accountReply("Cancelled. Nothing was changed.", { cookies, user: await getSessionUser(event) });
  }
  if (flow.action === "register_nickname") {
    const normalized = normalizeNickname(content);
    if (!normalized) return accountReply("That nickname didn’t come through clearly. Try another one—anything readable is fine.");
    const now = new Date();
    const user = { _id: crypto.randomUUID(), ...normalized, createdAt: now, updatedAt: now };
    try {
      await users.insertOne(user);
    } catch (error) {
      if (error && error.code === 11000) {
        return accountReply(`${normalized.nickname} already exists. Pick another nickname, or say “cancel” and ask me to log in.`);
      }
      throw error;
    }
    cookies.push(await createSession(event, user));
    cookies.push(await createFlow(event, "set_password", { userId: user._id }));
    return accountReply(`Just created ${user.nickname} and logged you in! Would you like a password? It’s optional. I’ve hidden the input; tap the eye to peek, or say “skip”.`, {
      secretInput: true,
      cookies,
      user: publicUser(user)
    });
  }

  if (flow.action === "login_nickname") {
    const normalized = normalizeNickname(content);
    if (!normalized) return accountReply("Tell me the nickname you registered with.");
    const user = await users.findOne({ nicknameKey: normalized.nicknameKey });
    if (!user) return accountReply(`I couldn’t find ${normalized.nickname}. Try another nickname, or say “cancel”.`);
    if (!user.password) {
      cookies.push(await createSession(event, user), await clearFlow(event));
      return accountReply(`Welcome back, ${user.nickname}! You’re logged in.`, { cookies, user: publicUser(user) });
    }
    cookies.push(await createFlow(event, "login_password", { userId: user._id }));
    return accountReply(`Found ${user.nickname}. What’s the password? I’ve hidden the input.`, {
      secretInput: true,
      cookies
    });
  }

  if (flow.action === "login_password") {
    const user = await users.findOne({ _id: flow.data && flow.data.userId });
    const valid = user && await verifyPassword(content, user.password);
    if (!valid) {
      const attempts = Number(flow.attempts) + 1;
      if (attempts >= 5) {
        cookies.push(await clearFlow(event));
        return accountReply("That password wasn’t right, and I’ve closed this login attempt. Ask me to log in when you’d like to retry.", { cookies });
      }
      await sessions.updateOne({ _id: flow._id }, { $set: { attempts } });
      return accountReply("That password wasn’t right. Try again, or say “cancel”.", { secretInput: true });
    }
    cookies.push(await createSession(event, user), await clearFlow(event));
    return accountReply(`Welcome back, ${user.nickname}! You’re logged in.`, { cookies, user: publicUser(user) });
  }

  if (flow.action === "set_password") {
    const current = await getSessionUser(event);
    if (!current || current.id !== String(flow.data && flow.data.userId || "")) {
      cookies.push(await clearFlow(event));
      return accountReply("That password request expired. Please log in and ask me to set it again.", { cookies });
    }
    if (/^(?:skip|no|nope|not now)$/i.test(String(content).trim())) {
      cookies.push(await clearFlow(event));
      return accountReply("Okeydoke—no password. You’re still logged in. Enjoy! ^_^", { cookies, user: current });
    }
    const password = await hashPassword(content);
    await users.updateOne({ _id: current.id }, { $set: { password, updatedAt: new Date() } });
    cookies.push(await clearFlow(event));
    return accountReply("Okeydoke! Password saved, and you’re still logged in. Enjoy! ^_^", { cookies, user: current });
  }

  if (flow.action === "rename_nickname") {
    const current = await getSessionUser(event);
    const normalized = normalizeNickname(content);
    if (!current || current.id !== String(flow.data && flow.data.userId || "")) {
      cookies.push(await clearFlow(event));
      return accountReply("That rename request expired.", { cookies });
    }
    if (!normalized) return accountReply("Try another nickname—anything readable is fine.");
    try {
      await users.updateOne({ _id: current.id }, { $set: { ...normalized, updatedAt: new Date() } });
    } catch (error) {
      if (error && error.code === 11000) return accountReply(`${normalized.nickname} is already taken. Try another one.`);
      throw error;
    }
    await sessions.updateMany({ kind: "session", userId: current.id }, { $set: { nickname: normalized.nickname } });
    cookies.push(await clearFlow(event));
    return accountReply(`Done—I'll call you ${normalized.nickname}.`, {
      cookies,
      user: { id: current.id, nickname: normalized.nickname }
    });
  }

  if (flow.action === "delete_confirm") {
    const current = await getSessionUser(event);
    const confirmed = /\b(?:yes|confirm)\b[\s\S]*\bdelete\b|^delete it$/i.test(String(content).trim());
    if (!current || current.id !== String(flow.data && flow.data.userId || "") || !confirmed) {
      cookies.push(await clearFlow(event));
      return accountReply("Cancelled. Nothing was deleted.", { cookies, user: current });
    }
    await Promise.all([
      users.deleteOne({ _id: current.id }),
      sessions.deleteMany({ userId: current.id })
    ]);
    cookies.push(clearCookie(event, SESSION_COOKIE), clearCookie(event, FLOW_COOKIE));
    return accountReply(`Deleted ${current.nickname} and logged you out.`, { cookies });
  }

  cookies.push(await clearFlow(event));
  return accountReply("That account conversation expired. Nothing was changed.", { cookies });
}

module.exports = {
  authorSnapshot,
  getSessionUser,
  getSessionUserWithRefresh,
  handleActiveFlow,
  matchAccountIntent,
  refreshSession,
  runAccountAction
};
