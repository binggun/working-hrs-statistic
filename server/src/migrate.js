import { pool, transaction } from "./db.js";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const directory = new URL("../migrations/", import.meta.url);
await transaction(async (c) => {
  await c.query("SELECT pg_advisory_xact_lock(820012)");
  await c.query(
    "CREATE TABLE IF NOT EXISTS migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now(),checksum text)",
  );
  await c.query(
    "ALTER TABLE migrations ADD COLUMN IF NOT EXISTS checksum text",
  );
  for (const file of (await readdir(directory))
    .filter((x) => /^\d+\.sql$/.test(x))
    .sort()) {
    const name = file.slice(0, -4),
      sql = await readFile(new URL(file, directory), "utf8"),
      checksum = createHash("sha256").update(sql).digest("hex");
    const previous = (
      await c.query("SELECT checksum FROM migrations WHERE name=$1", [name])
    ).rows[0];
    if (previous) {
      if (previous.checksum && previous.checksum !== checksum)
        throw Error(`Applied migration ${name} changed`);
      if (!previous.checksum)
        await c.query("UPDATE migrations SET checksum=$1 WHERE name=$2", [
          checksum,
          name,
        ]);
      continue;
    }
    await c.query(sql);
    await c.query("INSERT INTO migrations(name,checksum) VALUES($1,$2)", [
      name,
      checksum,
    ]);
  }
});
await pool.end();
