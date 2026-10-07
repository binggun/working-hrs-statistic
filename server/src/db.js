import "dotenv/config";
import pg from "pg";
export const pool = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
});
export async function transaction(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
