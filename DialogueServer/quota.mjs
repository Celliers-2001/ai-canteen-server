import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openQuotaStore() {
  const path = resolve(
    process.env.CANTEEN_DIALOGUE_USAGE_DB || process.env.CANTEEN_INVITE_DB || "dialogue-invites.sqlite"
  );
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;" +
    "CREATE TABLE IF NOT EXISTS minute_usage (slot INTEGER NOT NULL, id TEXT NOT NULL, " +
      "count INTEGER NOT NULL, PRIMARY KEY (slot, id));" +
    "CREATE TABLE IF NOT EXISTS daily_usage (day TEXT NOT NULL, id TEXT NOT NULL, " +
      "count INTEGER NOT NULL, PRIMARY KEY (day, id));"
  );
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
    reserve(id, now, limits) {
      const slot = Math.floor(now / 60000);
      const day = new Date(now).toISOString().slice(0, 10);
      db.exec("BEGIN IMMEDIATE");
      try {
        let error;
        if ((selectMinute.get(slot, id)?.count ?? 0) >= limits.minute) error = "dialogue_minute_limit";
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
