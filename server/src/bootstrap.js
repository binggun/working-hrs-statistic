import { pool } from "./db.js";
import argon2 from "argon2";
const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (!ADMIN_EMAIL || !ADMIN_PASSWORD || (ADMIN_PASSWORD.length < 6 || ADMIN_PASSWORD.length > 128))
  throw Error("Set ADMIN_EMAIL and ADMIN_PASSWORD (6–128 characters)");
await pool.query(
  "INSERT INTO accounts(role,email,password_hash,status,name) VALUES('SUPER_MANAGER',$1,$2,'ACTIVE','Owner') ON CONFLICT DO NOTHING",
  [ADMIN_EMAIL.trim().toLowerCase(), await argon2.hash(ADMIN_PASSWORD)],
);
console.log("Owner bootstrap complete (existing account preserved)");
await pool.end();
