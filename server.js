// Expense Splitter backend
// Run with:  node server.js   then open http://localhost:3000
// On your Mac it uses only what comes with Node.js (version 22.13 or newer).
// Online it stores data in Turso (see db.js and README.md).

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { openDatabase } = require("./db");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const SESSION_DAYS = 30;
const MAX_MEMBERS_PER_GROUP = 50;
const MAX_ITEMS_PER_GROUP = 5000;

// =====================================================================
// Database
// =====================================================================
// All money is stored as whole cents (30000 for $300.00), so there are
// never rounding problems with decimals.
const db = openDatabase();

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  -- A logged-in browser. We store a hash of its token, never the token itself.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY,
    code       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    owner_id   INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memberships (
    group_id  INTEGER NOT NULL REFERENCES groups(id),
    user_id   INTEGER NOT NULL REFERENCES users(id),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id           INTEGER PRIMARY KEY,
    group_id     INTEGER NOT NULL REFERENCES groups(id),
    description  TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    paid_by      INTEGER NOT NULL REFERENCES users(id),
    added_by     INTEGER NOT NULL REFERENCES users(id),
    created_at   INTEGER NOT NULL
  );

  -- Who an expense is split between, and how much each person's part is
  CREATE TABLE IF NOT EXISTS expense_shares (
    expense_id  INTEGER NOT NULL REFERENCES expenses(id),
    user_id     INTEGER NOT NULL REFERENCES users(id),
    share_cents INTEGER NOT NULL,
    PRIMARY KEY (expense_id, user_id)
  );

  -- Money one person paid another to settle up
  CREATE TABLE IF NOT EXISTS payments (
    id           INTEGER PRIMARY KEY,
    group_id     INTEGER NOT NULL REFERENCES groups(id),
    from_user    INTEGER NOT NULL REFERENCES users(id),
    to_user      INTEGER NOT NULL REFERENCES users(id),
    amount_cents INTEGER NOT NULL,
    added_by     INTEGER NOT NULL REFERENCES users(id),
    created_at   INTEGER NOT NULL
  );

  -- Friends. Stored both ways round, so A-B and B-A are two rows.
  CREATE TABLE IF NOT EXISTS friendships (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    friend_id  INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, friend_id)
  );

  CREATE INDEX IF NOT EXISTS memberships_by_user ON memberships (user_id);
  CREATE INDEX IF NOT EXISTS expenses_by_group ON expenses (group_id);
  CREATE INDEX IF NOT EXISTS payments_by_group ON payments (group_id);
  CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions (user_id);
`;

// =====================================================================
// Passwords and logins
// =====================================================================
// scrypt is a slow hash on purpose, so stolen hashes are hard to crack.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return salt.toString("hex") + ":" + hash.toString("hex");
}

function passwordMatches(password, stored) {
  const parts = stored.split(":");
  const salt = Buffer.from(parts[0], "hex");
  const expected = Buffer.from(parts[1], "hex");
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, expected);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function readCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function isHttps(req) {
  return req.socket.encrypted || req.headers["x-forwarded-proto"] === "https";
}

async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  await db.run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [
    sha256(token),
    userId,
    expiresAt,
  ]);
  let cookie =
    "sid=" + token + "; HttpOnly; Path=/; SameSite=Lax; Max-Age=" + SESSION_DAYS * 24 * 60 * 60;
  if (isHttps(req)) cookie = cookie + "; Secure";
  res.setHeader("Set-Cookie", cookie);
}

async function endSession(req, res) {
  const token = readCookies(req).sid;
  if (token) await db.run("DELETE FROM sessions WHERE token_hash = ?", [sha256(token)]);
  res.setHeader("Set-Cookie", "sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
}

// Who is making this request? Gives back the user, or null if not logged in.
async function currentUser(req) {
  const token = readCookies(req).sid;
  if (!token) return null;
  const user = await db.get(
    `SELECT users.id, users.name, users.username
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
    [sha256(token), Date.now()]
  );
  return user || null;
}

// Slow down password guessing: 10 tries per username every 15 minutes
const loginTries = new Map();
function tooManyTries(username) {
  const key = username.toLowerCase();
  const now = Date.now();
  const entry = loginTries.get(key);
  if (!entry || entry.resetAt < now) {
    loginTries.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  entry.count = entry.count + 1;
  return entry.count > 10;
}

// =====================================================================
// Money: balances and the fewest payments to settle up
// =====================================================================
// A positive balance means the group owes you; negative means you owe.
async function groupBalances(groupId) {
  const balances = new Map();
  const members = await db.all("SELECT user_id FROM memberships WHERE group_id = ?", [groupId]);
  for (const member of members) balances.set(member.user_id, 0);

  function add(userId, cents) {
    balances.set(userId, (balances.get(userId) || 0) + cents);
  }

  // Whoever paid for an expense is owed it; everyone in the split owes their part
  for (const e of await db.all(
    "SELECT paid_by, amount_cents FROM expenses WHERE group_id = ?",
    [groupId]
  )) {
    add(e.paid_by, e.amount_cents);
  }
  for (const s of await db.all(
    `SELECT expense_shares.user_id, expense_shares.share_cents
     FROM expense_shares JOIN expenses ON expenses.id = expense_shares.expense_id
     WHERE expenses.group_id = ?`,
    [groupId]
  )) {
    add(s.user_id, -s.share_cents);
  }

  // A payment from A to B reduces what A owes and what B is owed
  for (const p of await db.all(
    "SELECT from_user, to_user, amount_cents FROM payments WHERE group_id = ?",
    [groupId]
  )) {
    add(p.from_user, p.amount_cents);
    add(p.to_user, -p.amount_cents);
  }

  return balances;
}

function suggestPayments(balances) {
  const debtors = [];
  const creditors = [];
  for (const [userId, cents] of balances) {
    if (cents < 0) debtors.push({ userId: userId, cents: -cents });
    if (cents > 0) creditors.push({ userId: userId, cents: cents });
  }
  // Biggest amounts first keeps the number of payments small
  debtors.sort(function (a, b) {
    return b.cents - a.cents;
  });
  creditors.sort(function (a, b) {
    return b.cents - a.cents;
  });

  const payments = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const cents = Math.min(debtors[d].cents, creditors[c].cents);
    payments.push({ from: debtors[d].userId, to: creditors[c].userId, cents: cents });
    debtors[d].cents = debtors[d].cents - cents;
    creditors[c].cents = creditors[c].cents - cents;
    if (debtors[d].cents === 0) d++;
    if (creditors[c].cents === 0) c++;
  }
  return payments;
}

// Split cents as evenly as possible: $100.00 between 3 is 33.34, 33.33, 33.33
function splitEvenly(totalCents, userIds) {
  const base = Math.floor(totalCents / userIds.length);
  let leftOver = totalCents - base * userIds.length;
  const shares = [];
  for (const userId of userIds) {
    let share = base;
    if (leftOver > 0) {
      share = share + 1;
      leftOver = leftOver - 1;
    }
    shares.push({ userId: userId, cents: share });
  }
  return shares;
}

// =====================================================================
// Reading a group
// =====================================================================
async function findGroup(code) {
  return db.get("SELECT id, code, name, owner_id FROM groups WHERE code = ?", [code]);
}

async function isMember(groupId, userId) {
  const row = await db.get(
    "SELECT 1 AS yes FROM memberships WHERE group_id = ? AND user_id = ?",
    [groupId, userId]
  );
  return row !== undefined;
}

async function groupMembers(groupId) {
  return db.all(
    `SELECT users.id, users.name, users.username
     FROM memberships JOIN users ON users.id = memberships.user_id
     WHERE memberships.group_id = ?
     ORDER BY memberships.joined_at, users.id`,
    [groupId]
  );
}

async function getGroupState(group, me) {
  const sharesByExpense = new Map();
  for (const s of await db.all(
    `SELECT expense_shares.expense_id, expense_shares.user_id, expense_shares.share_cents
     FROM expense_shares JOIN expenses ON expenses.id = expense_shares.expense_id
     WHERE expenses.group_id = ?
     ORDER BY expense_shares.user_id`,
    [group.id]
  )) {
    if (!sharesByExpense.has(s.expense_id)) sharesByExpense.set(s.expense_id, []);
    sharesByExpense.get(s.expense_id).push({ userId: s.user_id, cents: s.share_cents });
  }

  const expenseRows = await db.all(
    `SELECT id, description, amount_cents, paid_by, added_by, created_at
     FROM expenses WHERE group_id = ? ORDER BY created_at DESC, id DESC`,
    [group.id]
  );
  const expenses = expenseRows.map(function (e) {
    return {
      id: e.id,
      description: e.description,
      cents: e.amount_cents,
      paidBy: e.paid_by,
      addedBy: e.added_by,
      createdAt: e.created_at,
      shares: sharesByExpense.get(e.id) || [],
    };
  });

  const paymentRows = await db.all(
    `SELECT id, from_user, to_user, amount_cents, added_by, created_at
     FROM payments WHERE group_id = ? ORDER BY created_at DESC, id DESC`,
    [group.id]
  );
  const payments = paymentRows.map(function (p) {
    return {
      id: p.id,
      from: p.from_user,
      to: p.to_user,
      cents: p.amount_cents,
      addedBy: p.added_by,
      createdAt: p.created_at,
    };
  });

  const balances = await groupBalances(group.id);
  const balanceList = [];
  for (const [userId, cents] of balances) balanceList.push({ userId: userId, cents: cents });

  return {
    group: { code: group.code, name: group.name, isOwner: group.owner_id === me.id },
    me: me,
    members: await groupMembers(group.id),
    expenses: expenses,
    payments: payments,
    balances: balanceList,
    settleUp: suggestPayments(balances),
  };
}

async function myGroups(me) {
  const groups = await db.all(
    `SELECT groups.id, groups.code, groups.name,
            (SELECT COUNT(*) FROM memberships m WHERE m.group_id = groups.id) AS member_count
     FROM memberships JOIN groups ON groups.id = memberships.group_id
     WHERE memberships.user_id = ?
     ORDER BY groups.created_at DESC`,
    [me.id]
  );

  const list = [];
  for (const g of groups) {
    const balances = await groupBalances(g.id);
    list.push({
      code: g.code,
      name: g.name,
      memberCount: g.member_count,
      myBalance: balances.get(me.id) || 0,
    });
  }
  return list;
}

// =====================================================================
// Friends
// =====================================================================
async function friendsOf(userId) {
  return db.all(
    `SELECT users.id, users.name, users.username
     FROM friendships JOIN users ON users.id = friendships.friend_id
     WHERE friendships.user_id = ?
     ORDER BY users.name COLLATE NOCASE`,
    [userId]
  );
}

async function areFriends(userId, otherId) {
  const row = await db.get(
    "SELECT 1 AS yes FROM friendships WHERE user_id = ? AND friend_id = ?",
    [userId, otherId]
  );
  return row !== undefined;
}

// Usernames that start with what was typed. Up to 10 people, shortest first.
async function searchUsers(me, text) {
  // % and _ mean "anything" in LIKE, so escape them to search for them as they are
  const escaped = text.replace(/[\\%_]/g, function (sign) {
    return "\\" + sign;
  });
  const rows = await db.all(
    `SELECT id, name, username,
            EXISTS (SELECT 1 FROM friendships
                    WHERE user_id = ? AND friend_id = users.id) AS is_friend
     FROM users
     WHERE username LIKE ? ESCAPE '\\' AND id != ?
     ORDER BY length(username), username
     LIMIT 10`,
    [me.id, escaped + "%", me.id]
  );
  return rows.map(function (u) {
    return { id: u.id, name: u.name, username: u.username, isFriend: Number(u.is_friend) === 1 };
  });
}

// =====================================================================
// Small helpers for requests and answers
// =====================================================================
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message, extra) {
  sendJson(res, status, Object.assign({ error: message }, extra || {}));
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return null;
  const cents = Math.round(amount * 100);
  return cents >= 1 ? cents : null;
}

function isUniqueError(error) {
  return /UNIQUE/i.test(String(error && error.message));
}

class BadRequest extends Error {}

// Read the JSON a browser sent us in the request body
function readBody(req) {
  // Only accept JSON. Other websites can't send JSON to us from a
  // logged-in browser without the browser asking us first.
  const type = req.headers["content-type"] || "";
  if (!type.startsWith("application/json")) {
    return Promise.reject(new BadRequest("Send the request as JSON."));
  }
  return new Promise(function (resolve, reject) {
    let text = "";
    req.on("data", function (chunk) {
      text = text + chunk;
      if (text.length > 20000) {
        reject(new BadRequest("Request is too large."));
        req.destroy();
      }
    });
    req.on("end", function () {
      try {
        const body = text === "" ? {} : JSON.parse(text);
        resolve(body && typeof body === "object" ? body : {});
      } catch (error) {
        reject(new BadRequest("Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

// =====================================================================
// API routes
// =====================================================================
async function handleApi(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;

  // For the hosting service to check the app is up
  if (method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, { ok: true });
  }

  // ---------- Accounts ----------
  if (method === "POST" && pathname === "/api/signup") {
    const body = await readBody(req);
    const name = cleanText(body.name);
    const username = cleanText(body.username);
    const password = typeof body.password === "string" ? body.password : "";

    if (name === "") return sendError(res, 400, "Enter your name.");
    if (name.length > 40) return sendError(res, 400, "Your name is too long.");
    if (!/^[A-Za-z0-9_.]{3,20}$/.test(username)) {
      return sendError(res, 400, "Usernames are 3 to 20 letters, numbers, dots or underscores.");
    }
    if (password.length < 8) return sendError(res, 400, "Use a password of at least 8 characters.");
    if (password.length > 200) return sendError(res, 400, "That password is too long.");

    const taken = await db.get("SELECT id FROM users WHERE username = ?", [username]);
    if (taken) return sendError(res, 409, "That username is taken. Try another.");

    let userId;
    try {
      const result = await db.run(
        "INSERT INTO users (username, name, password_hash, created_at) VALUES (?, ?, ?, ?)",
        [username, name, hashPassword(password), Date.now()]
      );
      userId = result.lastId;
    } catch (error) {
      // Two people signing up with the same name at the same moment
      if (isUniqueError(error)) return sendError(res, 409, "That username is taken. Try another.");
      throw error;
    }
    await startSession(req, res, userId);
    return sendJson(res, 201, { me: { id: userId, name: name, username: username } });
  }

  if (method === "POST" && pathname === "/api/login") {
    const body = await readBody(req);
    const username = cleanText(body.username);
    const password = typeof body.password === "string" ? body.password : "";

    if (username === "" || password === "") {
      return sendError(res, 400, "Enter your username and password.");
    }
    if (tooManyTries(username)) {
      return sendError(res, 429, "Too many tries. Wait 15 minutes, then try again.");
    }

    const user = await db.get(
      "SELECT id, name, username, password_hash FROM users WHERE username = ?",
      [username]
    );
    if (!user || !passwordMatches(password, user.password_hash)) {
      return sendError(res, 401, "That username and password don't match.");
    }

    loginTries.delete(username.toLowerCase());
    await startSession(req, res, user.id);
    return sendJson(res, 200, { me: { id: user.id, name: user.name, username: user.username } });
  }

  if (method === "POST" && pathname === "/api/logout") {
    await endSession(req, res);
    return sendJson(res, 200, { loggedOut: true });
  }

  // Everything below needs someone logged in
  const me = await currentUser(req);
  if (!me) return sendError(res, 401, "Log in first.", { needLogin: true });

  if (method === "GET" && pathname === "/api/me") {
    return sendJson(res, 200, { me: me });
  }

  // ---------- Finding people and friends ----------
  // GET /api/users?q=pur  ->  people whose username starts with "pur"
  if (method === "GET" && pathname === "/api/users") {
    const text = cleanText(url.searchParams.get("q")).replace(/^@/, "");
    if (text.length < 2 || text.length > 20) return sendJson(res, 200, { users: [] });
    return sendJson(res, 200, { users: await searchUsers(me, text) });
  }

  if (method === "GET" && pathname === "/api/friends") {
    return sendJson(res, 200, { friends: await friendsOf(me.id) });
  }

  // POST /api/friends  { userId }  ->  you both become friends
  if (method === "POST" && pathname === "/api/friends") {
    const body = await readBody(req);
    const other = await db.get("SELECT id, name FROM users WHERE id = ?", [Number(body.userId)]);

    if (!other) return sendError(res, 404, "That person wasn't found.");
    if (other.id === me.id) return sendError(res, 400, "You can't add yourself as a friend.");

    const now = Date.now();
    await db.transaction(async function (tx) {
      const add = "INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)";
      await tx.run(add, [me.id, other.id, now]);
      await tx.run(add, [other.id, me.id, now]);
    });
    return sendJson(res, 201, { friends: await friendsOf(me.id) });
  }

  // DELETE /api/friends/<id>  ->  no longer friends (groups stay as they are)
  const friendMatch = pathname.match(/^\/api\/friends\/(\d+)$/);
  if (method === "DELETE" && friendMatch) {
    const otherId = Number(friendMatch[1]);
    await db.transaction(async function (tx) {
      const remove = "DELETE FROM friendships WHERE user_id = ? AND friend_id = ?";
      await tx.run(remove, [me.id, otherId]);
      await tx.run(remove, [otherId, me.id]);
    });
    return sendJson(res, 200, { friends: await friendsOf(me.id) });
  }

  // ---------- Your groups ----------
  if (method === "GET" && pathname === "/api/groups") {
    return sendJson(res, 200, { me: me, groups: await myGroups(me) });
  }

  if (method === "POST" && pathname === "/api/groups") {
    const body = await readBody(req);
    const name = cleanText(body.name);
    if (name === "") return sendError(res, 400, "Enter a group name.");
    if (name.length > 40) return sendError(res, 400, "Group name is too long.");

    const code = crypto.randomBytes(8).toString("base64url");
    const now = Date.now();
    await db.transaction(async function (tx) {
      const result = await tx.run(
        "INSERT INTO groups (code, name, owner_id, created_at) VALUES (?, ?, ?, ?)",
        [code, name, me.id, now]
      );
      await tx.run("INSERT INTO memberships (group_id, user_id, joined_at) VALUES (?, ?, ?)", [
        result.lastId,
        me.id,
        now,
      ]);
    });
    return sendJson(res, 201, { code: code, name: name });
  }

  // ---------- One group ----------
  //   /api/groups/<code>                 GET, DELETE
  //   /api/groups/<code>/join            POST
  //   /api/groups/<code>/members         POST  (add one of your friends)
  //   /api/groups/<code>/expenses        POST     /expenses/<id>   DELETE
  //   /api/groups/<code>/payments        POST     /payments/<id>   DELETE
  const match = pathname.match(
    /^\/api\/groups\/([A-Za-z0-9_-]{6,32})(?:\/(join|members|expenses|payments)(?:\/(\d+))?)?$/
  );
  if (!match) return sendError(res, 404, "Not found.");

  const group = await findGroup(match[1]);
  if (!group) return sendError(res, 404, "This group doesn't exist. It may have been deleted.");

  const part = match[2];
  const id = match[3] ? Number(match[3]) : null;
  const member = await isMember(group.id, me.id);

  // Opening a group: members get everything; others with the link get a preview to join
  if (method === "GET" && !part) {
    if (member) return sendJson(res, 200, await getGroupState(group, me));
    const members = await groupMembers(group.id);
    return sendJson(res, 200, {
      me: me,
      preview: {
        name: group.name,
        memberNames: members.map(function (m) {
          return m.name;
        }),
      },
    });
  }

  if (method === "POST" && part === "join" && id === null) {
    if (!member) {
      if ((await groupMembers(group.id)).length >= MAX_MEMBERS_PER_GROUP) {
        return sendError(res, 400, "This group is full.");
      }
      await db.run(
        "INSERT OR IGNORE INTO memberships (group_id, user_id, joined_at) VALUES (?, ?, ?)",
        [group.id, me.id, Date.now()]
      );
    }
    return sendJson(res, 200, await getGroupState(group, me));
  }

  // Everything else is for members only
  if (!member) return sendError(res, 403, "Join this group first.");

  if (method === "DELETE" && !part) {
    if (group.owner_id !== me.id) {
      return sendError(res, 403, "Only the person who made the group can delete it.");
    }
    await db.transaction(async function (tx) {
      await tx.run(
        "DELETE FROM expense_shares WHERE expense_id IN (SELECT id FROM expenses WHERE group_id = ?)",
        [group.id]
      );
      await tx.run("DELETE FROM expenses WHERE group_id = ?", [group.id]);
      await tx.run("DELETE FROM payments WHERE group_id = ?", [group.id]);
      await tx.run("DELETE FROM memberships WHERE group_id = ?", [group.id]);
      await tx.run("DELETE FROM groups WHERE id = ?", [group.id]);
    });
    return sendJson(res, 200, { deleted: true });
  }

  // Add one of your friends to this group
  if (method === "POST" && part === "members" && id === null) {
    const body = await readBody(req);
    const friend = await db.get("SELECT id, name FROM users WHERE id = ?", [Number(body.userId)]);

    if (!friend || !(await areFriends(me.id, friend.id))) {
      return sendError(res, 400, "You can only add your friends. Add them as a friend first.");
    }
    if (await isMember(group.id, friend.id)) {
      return sendError(res, 409, friend.name + " is already in this group.");
    }
    if ((await groupMembers(group.id)).length >= MAX_MEMBERS_PER_GROUP) {
      return sendError(res, 400, "This group is full.");
    }
    await db.run(
      "INSERT OR IGNORE INTO memberships (group_id, user_id, joined_at) VALUES (?, ?, ?)",
      [group.id, friend.id, Date.now()]
    );
    return sendJson(res, 201, await getGroupState(group, me));
  }

  const counted = await db.get(
    `SELECT (SELECT COUNT(*) FROM expenses WHERE group_id = ?) +
            (SELECT COUNT(*) FROM payments WHERE group_id = ?) AS n`,
    [group.id, group.id]
  );
  const itemCount = Number(counted.n);

  // Add an expense
  if (method === "POST" && part === "expenses" && id === null) {
    const body = await readBody(req);
    const description = cleanText(body.description);
    const cents = toCents(body.amount);
    const paidBy = Number(body.paidBy);
    const splitWith = Array.isArray(body.splitWith) ? body.splitWith.map(Number) : [];

    if (description === "") return sendError(res, 400, "Enter what the expense was for.");
    if (description.length > 100) return sendError(res, 400, "Description is too long.");
    if (cents === null) return sendError(res, 400, "Enter an amount above 0.");
    if (!(await isMember(group.id, paidBy))) return sendError(res, 400, "Choose who paid.");

    const uniqueSplit = Array.from(new Set(splitWith)).sort(function (a, b) {
      return a - b;
    });
    if (uniqueSplit.length === 0) return sendError(res, 400, "Choose who to split it between.");
    for (const userId of uniqueSplit) {
      if (!(await isMember(group.id, userId))) {
        return sendError(res, 400, "Everyone in the split must be in the group.");
      }
    }
    if (itemCount >= MAX_ITEMS_PER_GROUP) {
      return sendError(res, 400, "This group has reached its limit.");
    }

    await db.transaction(async function (tx) {
      const result = await tx.run(
        `INSERT INTO expenses (group_id, description, amount_cents, paid_by, added_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [group.id, description, cents, paidBy, me.id, Date.now()]
      );
      for (const share of splitEvenly(cents, uniqueSplit)) {
        await tx.run(
          "INSERT INTO expense_shares (expense_id, user_id, share_cents) VALUES (?, ?, ?)",
          [result.lastId, share.userId, share.cents]
        );
      }
    });
    return sendJson(res, 201, await getGroupState(group, me));
  }

  // Record a payment (settling up)
  if (method === "POST" && part === "payments" && id === null) {
    const body = await readBody(req);
    const from = Number(body.from);
    const to = Number(body.to);
    const cents = toCents(body.amount);

    if (!(await isMember(group.id, from))) return sendError(res, 400, "Choose who paid.");
    if (!(await isMember(group.id, to))) return sendError(res, 400, "Choose who they paid.");
    if (from === to) return sendError(res, 400, "Someone can't pay themselves. Choose two people.");
    if (cents === null) return sendError(res, 400, "Enter an amount above 0.");
    if (itemCount >= MAX_ITEMS_PER_GROUP) {
      return sendError(res, 400, "This group has reached its limit.");
    }

    await db.run(
      `INSERT INTO payments (group_id, from_user, to_user, amount_cents, added_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [group.id, from, to, cents, me.id, Date.now()]
    );
    return sendJson(res, 201, await getGroupState(group, me));
  }

  // Delete an expense or a payment
  if (method === "DELETE" && part === "expenses" && id !== null) {
    const deleted = await db.transaction(async function (tx) {
      const expense = await tx.get("SELECT id FROM expenses WHERE id = ? AND group_id = ?", [
        id,
        group.id,
      ]);
      if (!expense) return 0;
      // The shares point at the expense, so they go first
      await tx.run("DELETE FROM expense_shares WHERE expense_id = ?", [id]);
      await tx.run("DELETE FROM expenses WHERE id = ?", [id]);
      return 1;
    });
    if (deleted === 0) {
      return sendError(res, 404, "That was already deleted. Refresh to see the latest.");
    }
    return sendJson(res, 200, await getGroupState(group, me));
  }

  if (method === "DELETE" && part === "payments" && id !== null) {
    const result = await db.run("DELETE FROM payments WHERE id = ? AND group_id = ?", [
      id,
      group.id,
    ]);
    if (result.changes === 0) {
      return sendError(res, 404, "That was already deleted. Refresh to see the latest.");
    }
    return sendJson(res, 200, await getGroupState(group, me));
  }

  return sendError(res, 404, "Not found.");
}

// =====================================================================
// Serving the page (files in the public folder)
// =====================================================================
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function serveFile(res, pathname) {
  // The home page and every group page use the same index.html.
  // app.js looks at the address to decide what to show.
  if (pathname === "/" || /^\/g\/[A-Za-z0-9_-]+\/?$/.test(pathname)) {
    pathname = "/index.html";
  }

  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch (error) {
    return sendError(res, 400, "Bad address.");
  }

  const filePath = path.join(PUBLIC_DIR, relative);

  // Never serve anything outside the public folder
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendError(res, 404, "Not found.");
  }

  fs.readFile(filePath, function (error, content) {
    if (error) return sendError(res, 404, "Not found.");
    const type = CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(content);
  });
}

// =====================================================================
// The server
// =====================================================================
const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  try {
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else if (req.method === "GET") {
      serveFile(res, pathname);
    } else {
      sendError(res, 404, "Not found.");
    }
  } catch (error) {
    if (res.headersSent) return;
    if (error instanceof BadRequest) {
      sendError(res, 400, error.message);
    } else {
      console.error(error);
      sendError(res, 500, "Something went wrong on the server. Try again.");
    }
  }
});

async function start() {
  await db.exec(SCHEMA);
  server.listen(PORT, function () {
    console.log("Expense Splitter is running at http://localhost:" + PORT);
    console.log("Data is stored in: " + db.kind);
    console.log("Press Ctrl+C to stop it.");
  });
}

start().catch(function (error) {
  console.error("Could not start the server:", error.message);
  process.exit(1);
});
