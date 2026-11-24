import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const invitePattern = /^[a-f0-9]{64}$/;
const digest = invite => createHash("sha256").update(invite).digest("hex");

export function openInvites() {
  const path = resolve(process.env.CANTEEN_INVITE_DB || "dialogue-invites.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;" +
    "CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, " +
      "label TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);" +
    "CREATE TABLE IF NOT EXISTS minute_usage (slot INTEGER NOT NULL, id TEXT NOT NULL, " +
      "count INTEGER NOT NULL, PRIMARY KEY (slot, id));" +
    "CREATE TABLE IF NOT EXISTS daily_usage (day TEXT NOT NULL, id TEXT NOT NULL, " +
      "count INTEGER NOT NULL, PRIMARY KEY (day, id));"
  );
  const byHash = db.prepare("SELECT id FROM invites WHERE hash = ? AND revoked = 0");
  const validId = db.prepare("SELECT id FROM invites WHERE id = ? AND revoked = 0");
  const add = db.prepare("INSERT INTO invites (id, hash, label) VALUES (?, ?, ?)");
  const revoke = db.prepare("UPDATE invites SET revoked = 1 WHERE id = ? AND revoked = 0");
  const list = db.prepare("SELECT id, label, revoked FROM invites ORDER BY label, id");
  const selectMinute = db.prepare("SELECT count FROM minute_usage WHERE slot = ? AND id = ?");
  const selectDaily = db.prepare("SELECT count FROM daily_usage WHERE day = ? AND id = ?");
  const selectGlobal = db.prepare("SELECT COALESCE(SUM(count), 0) AS count FROM daily_usage WHERE day = ?");
  const incMinute = db.prepare(
    "INSERT INTO minute_usage (slot, id, count) VALUES (?, ?, 1) ON CONFLICT (slot, id) DO UPDATE SET count = count + 1"
  );
  const incDaily = db.prepare(
    "INSERT INTO daily_usage (day, id, count) VALUES (?, ?, 1) ON CONFLICT (day, id) DO UPDATE SET count = count + 1"
  );
  const cleanMinutes = db.prepare("DELETE FROM minute_usage WHERE slot < ?");

  return {
    close: () => db.close(),
    identify: invite => invitePattern.test(invite) ? byHash.get(digest(invite))?.id : undefined,
    list: () => list.all(),
    revoke: id => revoke.run(id).changes !== 0,
    issue(label, file) {
      const invite = randomBytes(32).toString("hex");
      const id = randomUUID();
      db.exec("BEGIN IMMEDIATE");
      try {
        add.run(id, digest(invite), label);
        writeFileSync(file, invite + "\n", { flag: "wx", mode: 0o600 });
        db.exec("COMMIT");
        return id;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    reserve(id, now, limits) {
      const slot = Math.floor(now / 60000);
      const day = new Date(now).toISOString().slice(0, 10);
      db.exec("BEGIN IMMEDIATE");
      try {
        let error;
        if (!validId.get(id)) error = "invalid_invite";
        else if ((selectMinute.get(slot, id)?.count ?? 0) >= limits.minute) error = "invite_minute_limit";
        else if ((selectDaily.get(day, id)?.count ?? 0) >= limits.daily ||
                 selectGlobal.get(day).count >= limits.global) error = "dialogue_quota";
        if (!error) {
          incMinute.run(slot, id);
          incDaily.run(day, id);
          cleanMinutes.run(slot - 2);
        }
        db.exec("COMMIT");
        return error;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, value, file] = process.argv.slice(2);
  const store = openInvites();
  try {
    if (action === "create" && value?.trim() && value.trim().length <= 80 && file) {
      const id = store.issue(value.trim(), file);
      console.log("邀请已写入 " + file + " · 编号 " + id);
    } else if (action === "revoke" && value) {
      if (store.revoke(value)) console.log("已撤销 " + value);
      else { console.error("找不到有效的邀请编号"); process.exitCode = 1; }
    } else if (action === "list") {
      for (const entry of store.list())
        console.log(entry.id + "  " + (entry.revoked ? "已撤销" : "有效") + "  " + JSON.stringify(entry.label));
    } else {
      console.error("用法：node invites.mjs create \"玩家名\" ./CanteenInvite.txt | list | revoke <邀请编号>");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.code === "EEXIST" ? "邀请文件已经存在，请选择新的输出路径。" : "邀请操作失败，请检查数据库和输出路径。");
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
