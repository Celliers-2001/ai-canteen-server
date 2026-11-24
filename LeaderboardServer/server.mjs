import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const address = process.env.CANTEEN_RANKINGS_HOST || "127.0.0.1";
const port = Number(process.env.CANTEEN_RANKINGS_PORT || "18766");
const databasePath = resolve(process.env.CANTEEN_RANKINGS_DB || "leaderboard.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec(
  "PRAGMA journal_mode = WAL;" +
  "PRAGMA busy_timeout = 5000;" +
  "CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL);" +
  "CREATE TABLE IF NOT EXISTS restaurants (" +
  "  owner TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL," +
  "  reviews INTEGER NOT NULL, days_open INTEGER NOT NULL, profit_days INTEGER NOT NULL," +
  "  total_profit INTEGER NOT NULL, overall REAL NOT NULL, service REAL NOT NULL, food REAL NOT NULL," +
  "  PRIMARY KEY (owner, id)" +
  ");" +
  "CREATE TABLE IF NOT EXISTS removed (owner TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (owner, id));" +
  "CREATE TABLE IF NOT EXISTS profiles (owner TEXT NOT NULL, slot TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '', PRIMARY KEY (owner, slot));" +
  "CREATE TABLE IF NOT EXISTS reviews (" +
  "  owner TEXT NOT NULL, slot TEXT NOT NULL, id TEXT NOT NULL, guest_id TEXT NOT NULL, guest TEXT NOT NULL," +
  "  date TEXT NOT NULL, evaluation TEXT NOT NULL, overall INTEGER NOT NULL, service INTEGER NOT NULL," +
  "  food INTEGER NOT NULL, offline INTEGER NOT NULL, PRIMARY KEY (owner, slot, id)" +
  ");" +
  "CREATE INDEX IF NOT EXISTS reviews_by_date ON reviews(owner, slot, date DESC, id DESC);"
);

const findOwner = db.prepare("SELECT token_hash FROM owners WHERE id = ?");
const addOwner = db.prepare("INSERT INTO owners (id, token_hash) VALUES (?, ?)");
const removeStore = db.prepare("DELETE FROM restaurants WHERE owner = ? AND id = ?");
const removeProfile = db.prepare("DELETE FROM profiles WHERE owner = ? AND slot = ?");
const removeReviews = db.prepare("DELETE FROM reviews WHERE owner = ? AND slot = ?");
const markRemoved = db.prepare("INSERT OR IGNORE INTO removed (owner, id) VALUES (?, ?)");
const isRemoved = db.prepare("SELECT 1 FROM removed WHERE owner = ? AND id = ?");
const upsertStore = db.prepare(
  "INSERT INTO restaurants (owner, id, name, reviews, days_open, profit_days, total_profit, overall, service, food) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT (owner, id) DO UPDATE SET name = excluded.name, reviews = excluded.reviews, " +
  "days_open = excluded.days_open, profit_days = excluded.profit_days, total_profit = excluded.total_profit, " +
  "overall = excluded.overall, service = excluded.service, food = excluded.food"
);

const identityPattern = /^[a-f0-9]{32}$/;
const slotPattern = /^(?:legacy|[a-f0-9]{32})$/;
const tokenPattern = /^Bearer ([a-f0-9]{64})$/;
const pageSize = 50;
const ranges = { all: [0, 1_000_000], first: [1, 3], week: [3, 7], month: [7, 30] };
const metrics = {
  overall: "CASE WHEN reviews > 0 THEN overall END",
  service: "CASE WHEN reviews > 0 THEN service END",
  food: "CASE WHEN reviews > 0 THEN food END",
  dailyProfit: "CASE WHEN profit_days > 0 THEN 1.0 * total_profit / profit_days END",
  totalProfit: "CASE WHEN profit_days > 0 THEN total_profit END",
};
const avatarColumn = "COALESCE((SELECT avatar FROM profiles WHERE owner = restaurants.owner AND slot = restaurants.id), '') AS avatar";
const getRestaurant = db.prepare(
  "SELECT owner || ':' || id AS id, name AS restaurantName, reviews, days_open AS daysOpen, " +
  "profit_days AS profitDays, total_profit AS totalProfit, overall, service, food, " + avatarColumn +
  " FROM restaurants WHERE owner = ? AND id = ?"
);
const setAvatar = db.prepare(
  "INSERT INTO profiles (owner, slot, avatar) VALUES (?, ?, ?) ON CONFLICT (owner, slot) DO UPDATE SET avatar = excluded.avatar"
);
const addReview = db.prepare(
  "INSERT OR IGNORE INTO reviews (owner, slot, id, guest_id, guest, date, evaluation, overall, service, food, offline) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
);
const countReviews = db.prepare(
  "SELECT COUNT(*) AS total, COUNT(DISTINCT CASE WHEN guest_id = '' THEN guest ELSE guest_id END) AS participants " +
  "FROM reviews WHERE owner = ? AND slot = ?"
);
const listReviews = db.prepare(
  "SELECT id, guest_id AS guestId, guest, date, evaluation, overall, service, food, offline " +
  "FROM reviews WHERE owner = ? AND slot = ? ORDER BY date DESC, id DESC LIMIT ? OFFSET ?"
);

const countStores = db.prepare("SELECT COUNT(*) AS total FROM restaurants WHERE days_open BETWEEN ? AND ?");
const lists = Object.fromEntries(Object.entries(metrics).map(([name, metric]) => [
  name,
  db.prepare(
    "SELECT owner || ':' || id AS id, name AS restaurantName, reviews, days_open AS daysOpen, " +
    "profit_days AS profitDays, total_profit AS totalProfit, overall, service, food, " + avatarColumn + ", " +
    "CASE WHEN (" + metric + ") IS NOT NULL THEN RANK() OVER (ORDER BY (" + metric + ") DESC) ELSE 0 END AS rank " +
    "FROM restaurants WHERE days_open BETWEEN ? AND ? " +
    "ORDER BY (" + metric + ") DESC, name ASC, owner ASC, id ASC LIMIT ? OFFSET ?"
  ),
]));

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const limit = 512 * 1024;
  if (Number(req.headers["content-length"]) > limit) throw new RequestError(413, "Request too large");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, "Request too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "Invalid JSON");
  }
}

function whole(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function validRestaurant(row) {
  return row && typeof row.id === "string" && slotPattern.test(row.id) &&
    typeof row.restaurantName === "string" && row.restaurantName.trim().length > 0 &&
    row.restaurantName.length <= 60 && !/[\u0000-\u001f\u007f]/.test(row.restaurantName) &&
    whole(row.reviews, 0, 1_000_000) && whole(row.daysOpen, 0, 1_000_000) &&
    whole(row.profitDays, 0, row.daysOpen) && whole(row.totalProfit, -1e12, 1e12) &&
    [row.overall, row.service, row.food].every(score => Number.isFinite(score) && score >= 0 && score <= 5);
}

function sync(owner, token, payload) {
  if (!payload || !Array.isArray(payload.stores) || !Array.isArray(payload.deleted) ||
      payload.stores.length > 1000 || payload.deleted.length > 5000 ||
      !payload.stores.every(validRestaurant) ||
      !payload.deleted.every(id => typeof id === "string" && slotPattern.test(id)) ||
      new Set(payload.stores.map(row => row.id)).size !== payload.stores.length) {
    throw new RequestError(400, "Invalid restaurant data");
  }

  transact(() => {
    authorizeOwner(owner, token, true);

    // Keep an explicit removal record so an older upload cannot restore a deleted save.
    for (const id of payload.deleted) {
      markRemoved.run(owner, id);
      removeStore.run(owner, id);
      removeProfile.run(owner, id);
      removeReviews.run(owner, id);
    }
    for (const row of payload.stores) {
      if (isRemoved.get(owner, row.id)) continue;
      upsertStore.run(owner, row.id, row.restaurantName.trim(), row.reviews, row.daysOpen,
        row.profitDays, row.totalProfit, row.overall, row.service, row.food);
    }
  });
}

function authorizeOwner(owner, token, allowNew) {
  const hash = createHash("sha256").update(token).digest();
  const account = findOwner.get(owner);
  if (account) {
    if (!timingSafeEqual(hash, Buffer.from(account.token_hash, "hex"))) {
      throw new RequestError(403, "Invalid owner credentials");
    }
  } else if (allowNew) {
    addOwner.run(owner, hash.toString("hex"));
  } else {
    throw new RequestError(403, "Owner not registered");
  }
}

function transact(operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    operation();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function validReview(review) {
  return review && typeof review.id === "string" && /^[a-f0-9]{64}:[0-9]{1,7}$/.test(review.id) &&
    typeof review.guestId === "string" && review.guestId.length <= 80 &&
    typeof review.guest === "string" && review.guest.length > 0 && review.guest.length <= 100 &&
    typeof review.date === "string" && review.date.length <= 40 &&
    typeof review.evaluation === "string" && review.evaluation.length > 0 && review.evaluation.length <= 2000 &&
    typeof review.offline === "boolean" &&
    [review.overall, review.service, review.food].every(score => whole(score, 0, 10));
}

function publishProfile(owner, slot, token, payload) {
  if (!payload || typeof payload.avatar !== "string" ||
      (payload.avatar !== "" && !/^[A-Za-z0-9+/]{25600}$/.test(payload.avatar)) ||
      !Array.isArray(payload.reviews) || payload.reviews.length > 20 || !payload.reviews.every(validReview)) {
    throw new RequestError(400, "Invalid restaurant profile");
  }

  transact(() => {
    authorizeOwner(owner, token, false);
    if (isRemoved.get(owner, slot)) return;
    if (!getRestaurant.get(owner, slot)) throw new RequestError(404, "Restaurant not found");
    setAvatar.run(owner, slot, payload.avatar);
    for (const review of payload.reviews) {
      addReview.run(owner, slot, review.id, review.guestId, review.guest, review.date, review.evaluation,
        review.overall, review.service, review.food, Number(review.offline));
    }
  });
}

function getProfile(owner, slot, search) {
  const page = Number(search.get("page") || 1);
  if (!whole(page, 1, 1000000)) throw new RequestError(400, "Invalid page");
  const store = getRestaurant.get(owner, slot);
  if (!store) throw new RequestError(404, "Restaurant not found");
  const { total, participants } = countReviews.get(owner, slot);
  const pageSize = 20;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(pages, page);
  const reviews = listReviews.all(owner, slot, pageSize, (current - 1) * pageSize)
    .map(review => ({ ...review, offline: Boolean(review.offline) }));
  return { store, reviews, total, participants, page: current, pages };
}

function getList(search) {
  const sort = search.get("sort") || "overall";
  const filter = search.get("filter") || "all";
  const page = Number(search.get("page") || 1);
  if (!Object.hasOwn(lists, sort) || !Object.hasOwn(ranges, filter) || !whole(page, 1, 1000000)) {
    throw new RequestError(400, "Invalid ranking query");
  }

  const [start, end] = ranges[filter];
  const { total } = countStores.get(start, end);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(pages, page);
  return { stores: lists[sort].all(start, end, pageSize, (current - 1) * pageSize), total, page: current, pages };
}

const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { status: "ok", protocol: 1 });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/rankings") {
      return send(res, 200, getList(url.searchParams));
    }
    const owner = /^\/api\/v1\/owners\/([^/]+)\/restaurants$/.exec(url.pathname)?.[1];
    if (req.method === "PUT" && owner && identityPattern.test(owner)) {
      const token = tokenPattern.exec(req.headers.authorization || "")?.[1];
      if (!token) throw new RequestError(401, "Owner authorization required");
      sync(owner, token, await readJson(req));
      return send(res, 200, { ok: true });
    }
    const publicProfile = /^\/api\/v1\/restaurants\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && publicProfile && identityPattern.test(publicProfile[1]) && slotPattern.test(publicProfile[2])) {
      return send(res, 200, getProfile(publicProfile[1], publicProfile[2], url.searchParams));
    }
    const privateProfile = /^\/api\/v1\/owners\/([^/]+)\/restaurants\/([^/]+)\/profile$/.exec(url.pathname);
    if (req.method === "PUT" && privateProfile && identityPattern.test(privateProfile[1]) && slotPattern.test(privateProfile[2])) {
      const token = tokenPattern.exec(req.headers.authorization || "")?.[1];
      if (!token) throw new RequestError(401, "Owner authorization required");
      publishProfile(privateProfile[1], privateProfile[2], token, await readJson(req));
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "Route not found" });
  } catch (error) {
    if (!(error instanceof RequestError)) console.error("Ranking request failed:", error.message);
    if (!res.headersSent && !res.destroyed) {
      send(res, error.status || 500, { error: error.status ? error.message : "Server unavailable" });
    }
  }
});

server.listen(port, address, () => console.log("AI Canteen rankings listening on " + address + ":" + port));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
