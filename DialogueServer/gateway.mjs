import { createServer } from "node:http";
import { openInvites } from "./invites.mjs";

const port = setting("CANTEEN_DIALOGUE_GATEWAY_PORT", 18767, 65535);
const localPort = setting("CANTEEN_DIALOGUE_UPSTREAM_PORT", 18765, 65535);
const maxActive = setting("CANTEEN_DIALOGUE_MAX_ACTIVE", 8, 64);
const limits = {
  minute: setting("CANTEEN_DIALOGUE_PER_MINUTE", 16),
  daily: setting("CANTEEN_DIALOGUE_PER_DAY", 180),
  global: setting("CANTEEN_DIALOGUE_GLOBAL_PER_DAY", 800),
};
const store = openInvites();
const active = new Map();
let running = 0;

function setting(name, initial, maximum = 1000000) {
  if (process.env[name] == null) return initial;
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid setting: " + name);
  return value;
}

function send(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function readRequest(req) {
  const max = 512000;
  if (Number(req.headers["content-length"]) > max) return null;
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
  let id;
  let locked = false;
  try {
    if (req.method === "GET" && req.url === "/api/v1/dialogue/health")
      return send(res, 200, { status: "ok" });
    if (req.method !== "POST" || req.url !== "/api/v1/dialogue")
      return send(res, 404, { error: "not_found" });

    const invite = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || "")?.[1];
    id = invite && store.identify(invite);
    if (!id) return send(res, 401, { error: "invalid_invite" });
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || ""))
      return send(res, 415, { error: "invalid_request" });
    if (running >= maxActive || (active.get(id) || 0) >= 2)
      return send(res, 429, { error: "busy" });

    // Restrict authenticated connections before reading their bodies.
    locked = true;
    running++;
    active.set(id, (active.get(id) || 0) + 1);
    const body = await readRequest(req);
    if (body == null) return send(res, 413, { error: "invalid_request" });
    let value;
    try { value = JSON.parse(body); }
    catch { return send(res, 400, { error: "invalid_request" }); }
    if (![9, 10, 11].includes(value?.protocol) ||
        !["arrival", "chat", "served", "review", "cook"].includes(value.event))
      return send(res, 400, { error: "invalid_request" });

    const limit = store.reserve(id, Date.now(), limits);
    if (limit) return send(res, limit === "invalid_invite" ? 401 : 429, { error: limit });

    const disconnected = new AbortController();
    res.on("close", () => { if (!res.writableEnded) disconnected.abort(); });
    if (res.destroyed) return;
    const timeout = AbortSignal.timeout(33000);
    let result;
    try {
      const response = await fetch("http://127.0.0.1:" + localPort + "/reply", {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body,
        signal: AbortSignal.any([disconnected.signal, timeout]),
      });
      result = await response.json();
      return send(res, response.status, result);
    } catch {
      if (!disconnected.signal.aborted)
        send(res, 502, { error: timeout.aborted ? "timeout" : "dialogue_server_unavailable" });
    }
  } catch {
    send(res, 500, { error: "dialogue_server_unavailable" });
  } finally {
    if (locked) {
      running--;
      const count = active.get(id) - 1;
      if (count === 0) active.delete(id);
      else active.set(id, count);
    }
  }
});

server.listen(port, "127.0.0.1", () => console.log("AI Canteen dialogue gateway on 127.0.0.1:" + port));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
}
