import { SHOP_LOGIN_PASSWORD, passwordMatches } from "./shop-password.js";
import { mountAndroidDownload } from "./android-download.js";
import { attendanceLocation } from "./attendance-location.js";
import { dailyAttendanceHours, totalAttendanceHours } from "./attendance-hours.js";
import express from "express";
import { mountOrganization } from "./organization.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { localPhotoPath } from "./photo-storage.js";
import multer from "multer";
import sharp from "sharp";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import argon2 from "argon2";
import {
  randomBytes,
  createHash,
  createCipheriv,
  randomInt,
  randomUUID,
} from "node:crypto";
import { z } from "zod";
import { DateTime } from "luxon";
import PDFDocument from "pdfkit";
import { pool, transaction } from "./db.js";
import { geocodeAddress } from "./geocode.js";
import { monthBounds, localDate, zone } from "./domain.js";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});
const s3 = new S3Client({ region: process.env.AWS_REGION || "ap-southeast-2" });
export const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: process.env.WEB_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "256kb" }));
export const apiLimiter = rateLimit({ windowMs: 60000, limit: 300 });
app.use(apiLimiter);
const hash = (x) => createHash("sha256").update(x).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const fail = (status, message, code = "REQUEST_FAILED") => {
  throw Object.assign(new Error(message), { status, code });
};
const uuid = z.string().uuid();
const instant = z.iso.datetime({ offset: true });
const backend = ["MANAGER", "GENERAL_MANAGER", "SUPER_MANAGER"];
const companyAdmin = account => ["GENERAL_MANAGER", "SUPER_MANAGER"].includes(account.role);
app.get("/api/v1/health", async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ data: { status: "ok" } });
});
mountAndroidDownload(app);
app.post(
  ["/api/v1/auth/login", "/api/v1/manager/auth/login"],
  rateLimit({ windowMs: 900000, limit: 30 }),
  async (req, res) => {
    const b = z.object({
      password: z.string().min(1), email: z.email().optional(),
      accountId: z.string().regex(/^\d{4}$/).optional(),
    }).refine((body) => !!body.email !== !!body.accountId).parse(req.body);
    const manager = req.path.includes("/manager/");
    const data = await transaction(async (c) => {
    const r = await c.query(
      manager
        ? (b.email ? "SELECT * FROM accounts WHERE lower(email)=$1 AND role IN('MANAGER','GENERAL_MANAGER','SUPER_MANAGER') ORDER BY id FOR SHARE" : "SELECT * FROM accounts WHERE login_code=$1 AND role IN('MANAGER','GENERAL_MANAGER','SUPER_MANAGER') ORDER BY id FOR SHARE")
        : b.email
          ? "SELECT * FROM accounts WHERE lower(email)=$1 AND role IN('WORKER','MANAGER','GENERAL_MANAGER','SUPER_MANAGER') ORDER BY id FOR SHARE"
          : "SELECT * FROM accounts WHERE login_code=$1 AND role IN('SHOP','WORKER','MANAGER','GENERAL_MANAGER') FOR SHARE",
      [b.email?.toLowerCase() || b.accountId],
    );
    const matches = [];
    for (const account of r.rows) {
      if ((account.status === "ACTIVE" || (!manager && account.role === "WORKER" && account.status === "PENDING" && account.requires_manager_approval)) && await passwordMatches(account, b.password))
        matches.push(account);
    }
    if (!matches.length) fail(401, "Invalid credentials", "INVALID_CREDENTIALS");
    if (matches.length > 1) fail(422, "Multiple accounts match. Use your four-digit employee ID or contact an administrator.", "AMBIGUOUS_ACCOUNT");
    const a = matches[0];
    const t = token();
    const expiry = new Date(
      Date.now() + Number(process.env.SESSION_HOURS || 12) * 3600000,
    );
    await c.query(
      "INSERT INTO sessions(account_id,token_hash,expires_at) VALUES($1,$2,$3)",
      [a.id, hash(t), expiry],
    );
    return { sessionToken: t, expiresAt: expiry, account: await accountInfo(a, c) };
    });
    res.json({ data });
  },
);
app.post("/api/v1/auth/password-links/consume", async (req, res) => {
  const b = z
    .object({
      token: z.string().min(20),
      newPassword: z.string().min(6).max(128),
    })
    .parse(req.body);
  const pw = await argon2.hash(b.newPassword);
  const data = await transaction(async (c) => {
    const r = await c.query(
      "SELECT p.*,a.status,a.requires_manager_approval,a.approved_at FROM password_links p JOIN accounts a ON a.id=p.account_id WHERE token_hash=$1 FOR UPDATE OF p,a",
      [hash(b.token)],
    );
    const p = r.rows[0];
    if (
      !p ||
      p.used_at ||
      p.revoked_at ||
      new Date(p.expires_at) <= new Date() ||
      p.status === "DISABLED" ||
      (p.purpose === "FIRST_SETUP" && p.status !== "PENDING") ||
      (p.purpose === "PASSWORD_RESET" && p.status !== "ACTIVE")
    )
      fail(422, "Link invalid or expired", "INVALID_LINK");
    const awaitingManagerApproval = p.requires_manager_approval && !p.approved_at;
    await c.query(
      "UPDATE accounts SET password_hash=$1,status=$3 WHERE id=$2",
      [pw, p.account_id, awaitingManagerApproval ? "PENDING" : "ACTIVE"],
    );
    await c.query("UPDATE password_links SET used_at=now() WHERE id=$1", [
      p.id,
    ]);
    await c.query(
      "UPDATE password_links SET revoked_at=now() WHERE account_id=$1 AND used_at IS NULL AND revoked_at IS NULL",
      [p.account_id],
    );
    await c.query(
      "UPDATE sessions SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL",
      [p.account_id],
    );
    return { activated: !awaitingManagerApproval, awaitingManagerApproval };
  });
  res.json({ data });
});
app.post(
  "/api/v1/auth/password-links",
  rateLimit({ windowMs: 900000, limit: 10 }),
  async (req, res) => {
    const b = z
      .object({
        accountId: z
          .string()
          .regex(/^\d{4}$/)
          .optional(),
        email: z.email().optional(),
      })
      .refine((b) => !!b.accountId !== !!b.email)
      .parse(req.body);
    await transaction(async (c) => {
      const matches = (await c.query(
        b.accountId
          ? "SELECT * FROM accounts WHERE login_code=$1 AND role IN('WORKER','MANAGER','GENERAL_MANAGER') AND status='ACTIVE' ORDER BY id FOR UPDATE"
          : "SELECT * FROM accounts WHERE lower(email)=$1 AND role IN('WORKER','MANAGER','GENERAL_MANAGER','SUPER_MANAGER') AND status='ACTIVE' ORDER BY id FOR UPDATE",
        [b.accountId || b.email.toLowerCase()],
      )).rows;
      for (const account of matches) await invite(c, account, "PASSWORD_RESET");
    });
    res.json({ data: { accepted: true } });
  },
);
app.post("/api/v1/auth/register", rateLimit({ windowMs: 900000, limit: 10 }), async (req, res) => {
  const email = z.email().max(254).transform(v => v.toLowerCase());
  const b = z.object({ email, confirmEmail: email }).strict()
    .refine(v => v.email === v.confirmEmail, "Email addresses must match").parse(req.body);
  await transaction(async c => {
    // Use the same code-allocation lock as administrator-created employee accounts.
    await c.query("SELECT pg_advisory_xact_lock(820013)");
    const matches = (await c.query("SELECT * FROM accounts WHERE lower(email)=$1 ORDER BY id FOR UPDATE", [b.email])).rows;
    let account = matches.find(a => a.role === "WORKER");
    if (matches.length && (!account || account.status !== "PENDING")) return;
    if (!account) {
      account = (await c.query("INSERT INTO accounts(role,email,name,requires_manager_approval) VALUES('WORKER',$1,$1,true) RETURNING *",
        [b.email])).rows[0];
      await c.query("INSERT INTO workers(account_id,contact,address) VALUES($1,'','')", [account.id]);
      await audit(c, { id: account.id }, "SELF_REGISTRATION", account.id);
    }
    const recent = await c.query("SELECT 1 FROM password_links WHERE account_id=$1 AND purpose='FIRST_SETUP' AND used_at IS NULL AND revoked_at IS NULL AND expires_at>now()+interval '6 days 23 hours 55 minutes'", [account.id]);
    if (!recent.rowCount) await invite(c, account);
  });
  // Do not expose whether this address already belongs to an account.
  res.status(202).json({ data: { accepted: true } });
});
app.use("/api/v1", async (req, res, next) => {
  try {
    const t = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!t) fail(401, "Please sign in");
    const r = await pool.query(
      "SELECT a.* FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND (a.status='ACTIVE' OR (a.role='WORKER' AND a.status='PENDING' AND a.requires_manager_approval AND a.password_hash IS NOT NULL))",
      [hash(t)],
    );
    if (!r.rowCount) fail(401, "Session expired");
    req.account = r.rows[0];
    req.sessionHash = hash(t);
    next();
  } catch (e) {
    next(e);
  }
});
app.use(["/api/v1/attendance", "/api/v1/attendance-adjustments", "/api/v1/photos"], (req, res, next) => {
  if (req.method === "POST" && req.account.role === "WORKER" && req.account.status !== "ACTIVE")
    return next(Object.assign(new Error("Manager approval is required before recording attendance"),
      { status: 403, code: "MANAGER_APPROVAL_REQUIRED" }));
  next();
});
app.post("/api/v1/auth/logout", async (req, res) => {
  await pool.query("UPDATE sessions SET revoked_at=now() WHERE token_hash=$1", [
    req.sessionHash,
  ]);
  res.json({ data: { loggedOut: true } });
});
app.post("/api/v1/me/password", rateLimit({ windowMs: 900000, limit: 10 }), async (req, res) => {
  if (req.account.role === "SHOP") fail(403, "Shop accounts use the fixed login password", "SHOP_FIXED_PASSWORD");
  const body = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(6).max(128) }).strict().parse(req.body);
  await transaction(async (c) => {
    const account = (await c.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [req.account.id])).rows[0];
    if (!account.password_hash || !await argon2.verify(account.password_hash, body.currentPassword))
      fail(422, "Current password is incorrect", "CURRENT_PASSWORD_INCORRECT");
    if (body.currentPassword === body.newPassword) fail(422, "Choose a different password", "PASSWORD_UNCHANGED");
    await c.query("UPDATE accounts SET password_hash=$1 WHERE id=$2", [await argon2.hash(body.newPassword), req.account.id]);
    await c.query("UPDATE sessions SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL", [req.account.id]);
    await c.query("UPDATE password_links SET revoked_at=now() WHERE account_id=$1 AND used_at IS NULL AND revoked_at IS NULL", [req.account.id]);
    await audit(c, req.account, "PASSWORD_CHANGE", req.account.id);
  });
  res.json({ data: { changed: true, requiresLogin: true } });
});
async function accountInfo(account, c = pool) {
  const preferred = account.preferred_shop_id ? (await c.query(
    "SELECT sa.login_code FROM shops s JOIN accounts sa ON sa.id=s.account_id WHERE s.id=$1",
    [account.preferred_shop_id],
  )).rows[0]?.login_code : null;
  return { id: account.id, accountId: account.login_code || null, role: account.role, name: account.name, attendanceEnabled: account.status === "ACTIVE", preferredShopId: preferred || null };
}
app.get("/api/v1/me", async (req, res) =>
  res.json({ data: await accountInfo(req.account) }),
);
app.post("/api/v1/me/preferences", async (req, res) => {
  const body = z.object({ preferredShopId: z.string().regex(/^\d{4}$/).nullable() }).parse(req.body);
  const data = await transaction(async (c) => {
    let shop = null;
    if (body.preferredShopId !== null) {
      shop = (await c.query(
        "SELECT s.id FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=$1",
        [body.preferredShopId],
      )).rows[0];
      if (!shop) fail(422, "Unknown preferred shop");
      if (!["WORKER", ...backend].includes(req.account.role)) await assertShop(c, req.account, shop.id);
    }
    await c.query("UPDATE accounts SET preferred_shop_id=$1,profile_version=profile_version+1 WHERE id=$2", [shop?.id || null, req.account.id]);
    return { preferredShopId: body.preferredShopId };
  });
  res.json({ data });
});
async function profileInfo(account, c = pool) {
  return { ...await accountInfo(account, c), email: account.email || "", firstName: account.first_name || account.name,
    lastName: account.last_name || "", address: account.profile_address, phone: account.profile_phone,
    version: account.profile_version };
}
app.get("/api/v1/me/stores", async (req, res) => {
  if (!["WORKER", ...backend].includes(req.account.role)) fail(403, "Personal account required");
  const data = (await pool.query('SELECT s.id,s.name,a.login_code AS "shopId" FROM shops s JOIN accounts a ON a.id=s.account_id ORDER BY s.name')).rows;
  res.json({ data });
});
app.get("/api/v1/me/profile", async (req, res) => res.json({ data: await profileInfo(req.account) }));
app.post("/api/v1/me/profile", async (req, res) => {
  const body = z.object({
    operationId: uuid, expectedVersion: z.number().int().positive(),
    firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().max(100),
    address: z.string().trim().max(500), phone: z.string().trim().max(50),
    preferredShopId: z.string().regex(/^\d{4}$/).nullable(),
  }).strict().parse(req.body);
  const data = await transaction((c) => idem(c, req.account, body, "PROFILE", async () => {
    const previous = (await c.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [req.account.id])).rows[0];
    if (previous.profile_version !== body.expectedVersion) fail(409, "Profile changed; reload before saving", "PROFILE_CHANGED");
    let preferred = null;
    if (body.preferredShopId !== null) {
      preferred = (await c.query("SELECT s.id FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=$1", [body.preferredShopId])).rows[0];
      if (!preferred) fail(422, "Unknown preferred shop");
      if (!["WORKER", ...backend].includes(req.account.role)) await assertShop(c, req.account, preferred.id);
    }
    const name = [body.firstName, body.lastName].filter(Boolean).join(" ");
    const updated = (await c.query(
      "UPDATE accounts SET first_name=$1,last_name=$2,profile_address=$3,profile_phone=$4,name=$5,preferred_shop_id=$6,profile_version=profile_version+1 WHERE id=$7 RETURNING *",
      [body.firstName, body.lastName, body.address, body.phone, name, preferred?.id || null, req.account.id],
    )).rows[0];
    await c.query("UPDATE workers SET address=$1,contact=$2 WHERE account_id=$3", [body.address, body.phone, req.account.id]);
    await audit(c, req.account, "PROFILE_UPDATE", req.account.id,
      { firstName: previous.first_name, lastName: previous.last_name, address: previous.profile_address, phone: previous.profile_phone, preferredShopId: previous.preferred_shop_id },
      { firstName: body.firstName, lastName: body.lastName, address: body.address, phone: body.phone, preferredShopId: preferred?.id || null });
    return profileInfo(updated, c);
  }));
  res.json({ data });
});
function manager(req, res, next) {
  if (!backend.includes(req.account.role))
    return next(
      Object.assign(new Error("Manager access required"), { status: 403 }),
    );
  next();
}
app.use("/api/v1/manager", manager);
async function allowed(c, a, shopId) {
  if (companyAdmin(a)) return true;
  if (a.role === "SHOP")
    return !!(
      await c.query("SELECT 1 FROM shops WHERE id=$1 AND account_id=$2", [
        shopId,
        a.id,
      ])
    ).rowCount;
  return !!(
    await c.query(
      "SELECT 1 FROM account_shops WHERE shop_id=$1 AND account_id=$2",
      [shopId, a.id],
    )
  ).rowCount;
}
async function assertShop(c, a, id) {
  if (!(await allowed(c, a, id)))
    fail(403, "Shop outside your scope", "SHOP_FORBIDDEN");
}
async function idem(c, a, b, type, fn) {
  const digest = hash(JSON.stringify({ type, body: b }));
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [a.id]);
  const r = await c.query(
    "SELECT * FROM api_operations WHERE actor_account_id=$1 AND operation_id=$2",
    [a.id, b.operationId],
  );
  if (r.rowCount) {
    if (r.rows[0].request_hash !== digest)
      fail(
        409,
        "Operation ID already used with different data",
        "IDEMPOTENCY_CONFLICT",
      );
    return r.rows[0].response_data;
  }
  const op = (
    await c.query(
      "INSERT INTO api_operations(actor_account_id,operation_id,request_hash) VALUES($1,$2,$3) RETURNING id",
      [a.id, b.operationId, digest],
    )
  ).rows[0];
  const data = await fn(op.id);
  await c.query("UPDATE api_operations SET response_data=$1 WHERE id=$2", [
    data,
    op.id,
  ]);
  return data;
}
async function audit(c, a, action, id, before = null, after = null) {
  await c.query(
    "INSERT INTO audit_logs(actor_account_id,action,resource_id,before_data,after_data) VALUES($1,$2,$3,$4,$5)",
    [a.id, action, id, before, after],
  );
}
async function assertWorker(c, actor, workerId) {
  if (companyAdmin(actor)) return;
  if (!(await c.query("SELECT 1 FROM manager_workers WHERE manager_account_id=$1 AND worker_id=$2", [actor.id, workerId])).rowCount)
    fail(403, "Groomer outside your scope", "WORKER_FORBIDDEN");
}
async function assertRecordScope(c, actor, shopId, workerId) {
  if (backend.includes(actor.role) && (await c.query("SELECT 1 FROM workers WHERE id=$1 AND account_id=$2", [workerId,actor.id])).rowCount) return;
  if (await allowed(c, actor, shopId)) return;
  return assertWorker(c, actor, workerId);
}
const scopeSql =
  "($1 IN('SUPER_MANAGER','GENERAL_MANAGER') OR EXISTS(SELECT 1 FROM account_shops ac WHERE ac.shop_id=s.id AND ac.account_id=$2))";
app.get(["/api/v1/shops", "/api/v1/manager/shops"], async (req, res) => {
  let r;
  if (req.account.role === "SHOP")
    r = await pool.query(
      'SELECT s.*,a.login_code AS "shopId" FROM shops s JOIN accounts a ON a.id=s.account_id WHERE s.account_id=$1',
      [req.account.id],
    );
  else if (req.account.role === "WORKER")
    r = await pool.query(
      'SELECT s.*,a.login_code AS "shopId" FROM shops s JOIN accounts a ON a.id=s.account_id',
    );
  else
    r = await pool.query(
      'SELECT s.*,a.login_code AS "shopId" FROM shops s JOIN accounts a ON a.id=s.account_id WHERE ' +
        scopeSql,
      [req.account.role, req.account.id],
    );
  res.json({ data: r.rows });
});
app.post("/api/v1/manager/shops", async (req, res) => {
  if (!companyAdmin(req.account)) fail(403, "Company administrator required");
  const b = z
    .object({
      operationId: uuid,
      shopId: z
        .string()
        .regex(/^00\d{2}$/)
        .refine((x) => x !== "0000"),
      name: z.string().trim().min(1),
      address: z.string().trim().min(1).max(500),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
    })
    .parse(req.body);
  const pw = await argon2.hash(SHOP_LOGIN_PASSWORD);
  const safe = b;
  const data = await transaction((c) =>
    idem(c, req.account, safe, "SHOP_CREATE", async () => {
      const coordinates = b.latitude !== undefined && b.longitude !== undefined
        ? { latitude: b.latitude, longitude: b.longitude }
        : await geocodeAddress(b.address);
      const a = (
        await c.query(
          "INSERT INTO accounts(role,login_code,name,password_hash,status) VALUES('SHOP',$1,$2,$3,'ACTIVE') RETURNING id",
          [b.shopId, b.name, pw],
        )
      ).rows[0];
      const s = (
        await c.query(
          "INSERT INTO shops(account_id,name,address,latitude,longitude) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [a.id, b.name, b.address, coordinates.latitude, coordinates.longitude],
        )
      ).rows[0];
      await audit(c, req.account, "SHOP_CREATE", s.id);
      return s;
    }),
  );
  res.status(201).json({ data });
});
app.get("/api/v1/manager/attendance/stores", async (req, res) => {
  const result = await pool.query(`SELECT s.id,s.name,a.login_code AS "shopId" FROM shops s JOIN accounts a ON a.id=s.account_id WHERE $1 IN('SUPER_MANAGER','GENERAL_MANAGER') OR EXISTS(SELECT 1 FROM account_shops ac WHERE ac.account_id=$2 AND ac.shop_id=s.id) OR EXISTS(SELECT 1 FROM manager_workers mw WHERE mw.manager_account_id=$2) ORDER BY s.name`, [req.account.role, req.account.id]);
  res.json({ data: result.rows });
});
app.get("/api/v1/manager/attendance/groomers", async (req, res) => {
  const result = await pool.query(`SELECT w.id,a.id AS "accountId",a.name,a.login_code AS "workerId",a.status FROM workers w JOIN accounts a ON a.id=w.account_id WHERE a.role='WORKER' AND a.status='ACTIVE' AND ($1 IN('SUPER_MANAGER','GENERAL_MANAGER') OR EXISTS(SELECT 1 FROM manager_workers mw WHERE mw.manager_account_id=$2 AND mw.worker_id=w.id) OR EXISTS(SELECT 1 FROM account_shops ac WHERE ac.account_id=$2)) ORDER BY a.name`, [req.account.role, req.account.id]);
  res.json({ data: result.rows });
});
app.get("/api/v1/manager/workers", async (req, res) => {
  const r = await pool.query(
    `SELECT w.id,a.id AS "accountId",a.login_code AS "workerId",a.name,a.email,a.status,a.requires_manager_approval,(a.password_hash IS NOT NULL) AS password_set,a.first_name AS "firstName",a.last_name AS "lastName",a.profile_address AS address,a.profile_phone AS phone,a.profile_version AS version,sa.login_code AS "preferredShopId" FROM workers w JOIN accounts a ON a.id=w.account_id LEFT JOIN shops ps ON ps.id=a.preferred_shop_id LEFT JOIN accounts sa ON sa.id=ps.account_id WHERE a.role='WORKER' AND ($1 IN('SUPER_MANAGER','GENERAL_MANAGER') OR EXISTS(SELECT 1 FROM manager_workers mw WHERE mw.manager_account_id=$2 AND mw.worker_id=w.id)) ORDER BY a.name`,
    [req.account.role, req.account.id],
  );
  res.json({ data: r.rows });
});
app.get("/api/v1/manager/managers", async (req, res) => {
  if (!companyAdmin(req.account)) fail(403, "Company administrator required");
  const r = await pool.query(
    `SELECT a.id AS "accountId",a.role,a.name,a.email,a.status,a.first_name AS "firstName",a.last_name AS "lastName",a.profile_address AS address,a.profile_phone AS phone,a.profile_version AS version,sa.login_code AS "preferredShopId" FROM accounts a LEFT JOIN shops ps ON ps.id=a.preferred_shop_id LEFT JOIN accounts sa ON sa.id=ps.account_id WHERE a.role IN('MANAGER','GENERAL_MANAGER') ORDER BY a.name`,
  );
  res.json({ data: r.rows });
});
function encrypt(data) {
  const key = Buffer.from(process.env.MAIL_ENCRYPTION_KEY || "", "hex");
  if (key.length !== 32)
    fail(503, "Mail encryption key not configured", "MAIL_NOT_CONFIGURED");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([
    cipher.update(JSON.stringify(data)),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), enc]
    .map((x) => x.toString("base64"))
    .join(".");
}
async function invite(c, account, purpose = "FIRST_SETUP") {
  const t = token();
  await c.query(
    "UPDATE password_links SET revoked_at=now() WHERE account_id=$1 AND used_at IS NULL AND revoked_at IS NULL",
    [account.id],
  );
  await c.query(
    "UPDATE email_jobs SET status='CANCELLED',encrypted_payload=NULL WHERE account_id=$1 AND kind='PASSWORD_LINK' AND status IN('QUEUED','FAILED')",
    [account.id],
  );
  const p = (
    await c.query(
      "INSERT INTO password_links(account_id,purpose,token_hash,expires_at) VALUES($1,$3,$2,now()+interval '7 days') RETURNING id",
      [account.id, hash(t), purpose],
    )
  ).rows[0];
  await c.query(
    "INSERT INTO email_jobs(account_id,password_link_id,recipient_email,encrypted_payload) VALUES($1,$2,$3,$4)",
    [
      account.id,
      p.id,
      account.email,
      encrypt({ token: t, name: account.name }),
    ],
  );
  return p.id;
}
app.post(
  ["/api/v1/manager/workers", "/api/v1/manager/managers"],
  async (req, res) => {
    const isManager = req.path.endsWith("/managers");
    if (isManager && !companyAdmin(req.account))
      fail(403, "Only owner can add managers");
    const b = z
      .object({
        operationId: uuid,
        name: z.string().trim().min(1),
        email: z.email(),
        shopIds: z.array(z.string().regex(/^00\d{2}$/)).default([]),
        contact: z.string().optional(),
        address: z.string().trim().max(500).optional(),
        firstName: z.string().trim().min(1).max(100).optional(),
        lastName: z.string().trim().max(100).optional(),
        phone: z.string().trim().max(50).optional(),
        preferredShopId: z.string().regex(/^00\d{2}$/).nullable().optional(),
      })
      .parse(req.body);
    const data = await transaction((c) =>
      idem(c, req.account, b, "ACCOUNT_CREATE", async () => {
        const shops = [];
        for (const code of isManager ? [...new Set(b.shopIds)] : []) {
          const s = (
            await c.query(
              "SELECT s.id FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=$1",
              [code],
            )
          ).rows[0];
          if (!s) fail(422, "Shop not found");
          await assertShop(c, req.account, s.id);
          shops.push(s.id);
        }
        let preferred = null;
        if (b.preferredShopId) {
          preferred = (await c.query("SELECT s.id FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=$1", [b.preferredShopId])).rows[0];
          if (!preferred) fail(422, "Unknown preferred shop");
          if (isManager) await assertShop(c, req.account, preferred.id);
        }
        const firstName = b.firstName || b.name;
        const lastName = b.lastName || "";
        const name = [firstName, lastName].filter(Boolean).join(" ");
        let code = null;
        if (!isManager) {
          await c.query("SELECT pg_advisory_xact_lock(820013)");
          const codes = (
            await c.query("SELECT login_code FROM accounts WHERE login_code ~ '^[1-9][0-9]{3}$'")
          ).rows.map((x) => x.login_code);
          const available = [];
          for (let i = 1000; i <= 9999; i++)
            if (!codes.includes(String(i))) available.push(String(i));
          if (!available.length) fail(409, "Worker IDs exhausted");
          code = available[randomInt(available.length)];
        }
        const a = (
          await c.query(
            "INSERT INTO accounts(role,login_code,email,name,first_name,last_name,profile_address,profile_phone,preferred_shop_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
            [
              isManager ? "MANAGER" : "WORKER",
              code,
              b.email.toLowerCase(),
              name, firstName, lastName, b.address || "", b.phone ?? b.contact ?? "", preferred?.id || null,
            ],
          )
        ).rows[0];
        if (!isManager)
          await c.query(
            "INSERT INTO workers(account_id,contact,address) VALUES($1,$2,$3)",
            [a.id, b.phone ?? b.contact ?? "", b.address || ""],
          );
        for (const s of shops)
          await c.query(
            "INSERT INTO account_shops(account_id,shop_id) VALUES($1,$2)",
            [a.id, s],
          );
        const requiresManagerApproval = req.account.role !== "SUPER_MANAGER";
        await c.query("UPDATE accounts SET requires_manager_approval=$2,approved_by_account_id=CASE WHEN $2 THEN NULL ELSE $3::uuid END,approved_at=CASE WHEN $2 THEN NULL ELSE now() END WHERE id=$1", [a.id, requiresManagerApproval, req.account.id]);
        if (!isManager && req.account.role === "MANAGER") await c.query("INSERT INTO manager_workers(manager_account_id,worker_id) SELECT $1,id FROM workers WHERE account_id=$2 ON CONFLICT DO NOTHING", [req.account.id, a.id]);
        const invitationId = await invite(c, a);
        await audit(c, req.account, "ACCOUNT_CREATE", a.id);
        return {
          accountId: a.id,
          workerId: code,
          activationStatus: "PENDING",
          requiresManagerApproval,
          invitationId,
          emailStatus: "QUEUED",
        };
      }),
    );
    res.status(201).json({ data });
  },
);
async function managedPerson(c, actor, accountId) {
  const person = (await c.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [accountId])).rows[0];
  if (!person || !["WORKER", "MANAGER"].includes(person.role)) fail(404, "Person not found");
  if (person.role === "MANAGER" && !companyAdmin(actor)) fail(403, "Only owner can manage managers");
  if (person.role === "WORKER") {
    const worker = (await c.query("SELECT id FROM workers WHERE account_id=$1", [person.id])).rows[0];
    await assertWorker(c, actor, worker.id);
  }
  return person;
}
app.post("/api/v1/manager/accounts/:id/profile", async (req, res) => {
  const accountId = uuid.parse(req.params.id);
  const b = z.object({ operationId: uuid, expectedVersion: z.number().int().positive(),
    firstName: z.string().trim().min(1).max(100), lastName: z.string().trim().max(100),
    address: z.string().trim().max(500), phone: z.string().trim().max(50),
    preferredShopId: z.string().regex(/^00\d{2}$/).nullable(),
  }).strict().parse(req.body);
  const data = await transaction(c => idem(c, req.account, { ...b, accountId }, "MANAGED_PROFILE", async () => {
    const person = await managedPerson(c, req.account, accountId);
    if (person.status === "DISABLED") fail(409, "Account has been deleted");
    if (person.profile_version !== b.expectedVersion) fail(409, "Profile changed; reload before saving", "PROFILE_CHANGED");
    let preferred = null;
    if (b.preferredShopId) {
      preferred = (await c.query("SELECT s.id FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=$1", [b.preferredShopId])).rows[0];
      if (!preferred) fail(422, "Unknown preferred shop");
      if (person.role === "MANAGER") await assertShop(c, req.account, preferred.id);
    }
    const updated = (await c.query("UPDATE accounts SET first_name=$1,last_name=$2,name=$3,profile_address=$4,profile_phone=$5,preferred_shop_id=$6,profile_version=profile_version+1 WHERE id=$7 RETURNING *",
      [b.firstName, b.lastName, [b.firstName, b.lastName].filter(Boolean).join(" "), b.address, b.phone, preferred?.id || null, accountId])).rows[0];
    await c.query("UPDATE workers SET address=$1,contact=$2 WHERE account_id=$3", [b.address, b.phone, accountId]);
    await audit(c, req.account, "MANAGED_PROFILE_UPDATE", accountId,
      { name: person.name, address: person.profile_address, phone: person.profile_phone, preferredShopId: person.preferred_shop_id },
      { name: updated.name, address: b.address, phone: b.phone, preferredShopId: preferred?.id || null });
    return profileInfo(updated, c);
  }));
  res.json({ data });
});
app.post("/api/v1/manager/accounts/:id/remove", async (req, res) => {
  const accountId = uuid.parse(req.params.id);
  const b = z.object({ operationId: uuid, expectedVersion: z.number().int().positive() }).strict().parse(req.body);
  const data = await transaction(c => idem(c, req.account, { ...b, accountId }, "PERSON_REMOVE", async () => {
    const person = await managedPerson(c, req.account, accountId);
    if (person.id === req.account.id) fail(403, "You cannot delete your own account");
    if (person.profile_version !== b.expectedVersion || person.status === "DISABLED") fail(409, "Account changed; reload");
    await c.query("UPDATE accounts SET status='DISABLED',profile_version=profile_version+1 WHERE id=$1", [accountId]);
    await c.query("UPDATE sessions SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL", [accountId]);
    await c.query("UPDATE password_links SET revoked_at=now() WHERE account_id=$1 AND used_at IS NULL", [accountId]);
    await c.query("UPDATE email_jobs SET status='CANCELLED',encrypted_payload=NULL WHERE account_id=$1 AND status IN('QUEUED','FAILED')", [accountId]);
    await c.query("UPDATE attendance_export_jobs SET status='FAILED',last_error_code='ACCOUNT_DISABLED' WHERE account_id=$1 AND status='QUEUED'", [accountId]);
    await audit(c, req.account, "PERSON_REMOVED", accountId, { status: person.status }, { status: "DISABLED" });
    return { accountId, status: "DISABLED" };
  }));
  res.json({ data });
});
app.post("/api/v1/manager/accounts/:id/approve", async (req, res) => {
  if (req.account.role !== "GENERAL_MANAGER") fail(403, "Only the General manager can approve new personnel");
  const accountId = uuid.parse(req.params.id);
  const b = z.object({ operationId: uuid }).strict().parse(req.body);
  const data = await transaction(c => idem(c, req.account, { ...b, accountId }, "ACCOUNT_APPROVAL", async () => {
    await c.query("SELECT pg_advisory_xact_lock(820013)");
    const account = (await c.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [accountId])).rows[0];
    if (!account || !["WORKER", "MANAGER"].includes(account.role)) fail(404, "Personnel account missing");
    if (account.status !== "PENDING" || !account.requires_manager_approval) fail(409, "Account is not awaiting approval");
    if (!account.password_hash) fail(409, "Employee must set a password first");
    const codes = new Set((await c.query("SELECT login_code FROM accounts WHERE login_code ~ '^[1-9][0-9]{3}$'")).rows.map(r => r.login_code));
    const available = [];
    for (let i = 1000; i <= 9999; i++) if (!codes.has(String(i))) available.push(String(i));
    if (account.role === "WORKER" && !account.login_code && !available.length) fail(409, "Employee IDs exhausted");
    const employeeCode = account.role === "WORKER" ? (account.login_code || available[randomInt(available.length)]) : account.login_code;
    await c.query("UPDATE accounts SET status='ACTIVE',login_code=$3,approved_by_account_id=$2,approved_at=now() WHERE id=$1", [accountId, req.account.id, employeeCode]);
    await c.query("INSERT INTO email_jobs(account_id,recipient_email,encrypted_payload,kind) VALUES($1,$2,$3,'ACCOUNT_APPROVED')",
      [accountId, account.email, encrypt({ name: account.name, employeeCode, role: account.role })]);
    await audit(c, req.account, "ACCOUNT_APPROVED", accountId, { status: "PENDING", employeeCode: null }, { status: "ACTIVE", employeeCode });
    return { accountId, workerId: employeeCode, status: "ACTIVE", emailStatus: "QUEUED" };
  }));
  res.json({ data });
});
app.post("/api/v1/manager/accounts/:id/invitations", async (req, res) => {
  const b = z.object({ operationId: uuid }).parse(req.body);
  uuid.parse(req.params.id);
  const data = await transaction((c) =>
    idem(
      c,
      req.account,
      { ...b, accountId: req.params.id },
      "INVITATION",
      async () => {
        const a = (
          await c.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [
            req.params.id,
          ])
        ).rows[0];
        if (!a || a.status !== "PENDING")
          fail(422, "Only pending accounts can be invited");
        if (!companyAdmin(req.account)) {
          if (a.role !== "WORKER") fail(403, "Owner required");
        }
        if (!companyAdmin(req.account)) {
          const worker = (await c.query("SELECT id FROM workers WHERE account_id=$1", [a.id])).rows[0];
          await assertWorker(c, req.account, worker.id);
        }
        const invitationId = await invite(c, a);
        await audit(c, req.account, "INVITATION_RESEND", a.id);
        return { invitationId, emailStatus: "QUEUED" };
      },
    ),
  );
  res.json({ data });
});
app.get("/api/v1/manager/invitations", async (req, res) => {
  const r = await pool.query(
    `SELECT e.id,e.account_id AS "accountId",a.name,e.status,e.last_error_code,e.created_at,p.expires_at,p.used_at FROM email_jobs e JOIN accounts a ON a.id=e.account_id JOIN password_links p ON p.id=e.password_link_id WHERE $1 IN('SUPER_MANAGER','GENERAL_MANAGER') OR EXISTS(SELECT 1 FROM workers w JOIN manager_workers mw ON mw.worker_id=w.id WHERE w.account_id=a.id AND mw.manager_account_id=$2) ORDER BY e.created_at DESC LIMIT 100`,
    [req.account.role, req.account.id],
  );
  res.json({ data: r.rows });
});
export async function rebuild(c, workerId) {
  await c.query("SELECT id FROM workers WHERE id=$1 FOR UPDATE", [workerId]);
  await c.query("DELETE FROM work_segments WHERE worker_id=$1", [workerId]);
  const rows = (
    await c.query(
      `SELECT r.*,EXISTS(SELECT 1 FROM attendance_adjustments j WHERE j.record_id=r.id AND j.status='PENDING') AS pending FROM attendance_records r WHERE worker_id=$1 AND NOT confirmed_deleted ORDER BY COALESCE(confirmed_occurred_at,original_occurred_at),received_at,id`,
      [workerId],
    )
  ).rows;
  const opens = new Map();
  const crossShopUnclosed = new Set();
  const add = async (si, so, issue = null) => {
    const start = si?.confirmed_occurred_at,
      end = so?.confirmed_occurred_at;
    let status = issue
      ? "INVALID"
      : si?.pending || so?.pending || !start || !end
        ? "PENDING"
        : "CONFIRMED";
    if (start && end && localDate(start) !== localDate(end)) {
      issue = "CROSS_MIDNIGHT";
      status = "INVALID";
    }
    if (start && end && new Date(end) < new Date(start)) {
      issue = "REVERSED_TIME";
      status = "INVALID";
    }
    await c.query(
      `INSERT INTO work_segments(worker_id,shop_id,sign_in_record_id,sign_out_record_id,start_at,end_at,status,issue_code,duration_minutes,hrs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $7='CONFIRMED' THEN extract(epoch FROM ($6::timestamptz-$5::timestamptz))/60 END,CASE WHEN $7='CONFIRMED' THEN round(extract(epoch FROM ($6::timestamptz-$5::timestamptz))/3600,2) END)`,
      [
        workerId,
        si?.shop_id || so.shop_id,
        si?.id || null,
        so?.id || null,
        start || null,
        end || null,
        status,
        issue,
      ],
    );
  };
  for (const r of rows) {
    const prev = opens.get(r.shop_id);
    if (r.sign_type === "SIGN_IN") {
      for (const [shop, old] of opens) {
        if (shop !== r.shop_id) {
          await add(old, null, "MISSING_SIGN_OUT");
          opens.delete(shop);
        }
      }
      if (prev) await add(prev, null, "MISSING_SIGN_OUT");
      opens.set(r.shop_id, r);
    } else {
      if (prev) {
        await add(prev, r);
        opens.delete(r.shop_id);
      } else {
        await add(null, r, "MISSING_SIGN_IN");
        for (const [shop, open] of opens)
          if (shop !== r.shop_id) crossShopUnclosed.add(open.id);
      }
    }
  }
  for (const si of opens.values()) {
    const old = localDate(si.original_occurred_at) < localDate(new Date());
    await add(
      si,
      null,
      old || crossShopUnclosed.has(si.id) ? "MISSING_SIGN_OUT" : null,
    );
  }
}
function filters(req) {
  const p = monthBounds(req.query.month);
  return [
    req.account.role,
    req.account.id,
    p.start,
    p.end,
    req.query.shopId || null,
    req.query.workerId || null,
  ];
}
const recordScopeSql = "($1 IN('SUPER_MANAGER','GENERAL_MANAGER') OR w.account_id=$2 OR EXISTS(SELECT 1 FROM account_shops ac WHERE ac.shop_id=s.id AND ac.account_id=$2) OR EXISTS(SELECT 1 FROM manager_workers mw WHERE mw.worker_id=w.id AND mw.manager_account_id=$2))";
const filtered = `FROM attendance_records r JOIN workers w ON w.id=r.worker_id JOIN accounts wa ON wa.id=w.account_id JOIN shops s ON s.id=r.shop_id JOIN accounts sa ON sa.id=s.account_id WHERE ${recordScopeSql} AND r.effective_occurred_at >= $3 AND r.effective_occurred_at < $4 AND ($5::text IS NULL OR sa.login_code=$5) AND ($6::text IS NULL OR wa.login_code=$6)`;
async function records(req, c = pool) {
  const f = filters(req);
  return (
    await c.query(
      `SELECT r.*,(SELECT x.after_type FROM attendance_adjustments x WHERE x.record_id=r.id AND x.status='PENDING' LIMIT 1) AS pending_sign_type,wa.name AS worker_name,wa.login_code AS "workerId",s.name AS shop_name,sa.login_code AS "shopId",EXISTS(SELECT 1 FROM attendance_adjustments x WHERE x.record_id=r.id AND x.status='PENDING') AS pending ${filtered} AND ($1='SUPER_MANAGER' OR NOT r.effective_deleted) ORDER BY r.effective_occurred_at,r.id`,
      f,
    )
  ).rows;
}
async function summary(req, c = pool) {
  const f = filters(req);
  return (
    await c.query(
      `SELECT wa.login_code AS "workerId",wa.name AS worker_name,sa.login_code AS "shopId",s.name AS shop_name,COALESCE(sum(g.hrs) FILTER(WHERE g.status='CONFIRMED'),0)::numeric(12,2)::text AS "confirmedHrs",count(*) FILTER(WHERE g.status='PENDING')::int AS "pendingSegmentCount",count(*) FILTER(WHERE g.status='INVALID')::int AS "invalidSegmentCount" FROM work_segments g JOIN workers w ON w.id=g.worker_id JOIN accounts wa ON wa.id=w.account_id JOIN shops s ON s.id=g.shop_id JOIN accounts sa ON sa.id=s.account_id LEFT JOIN attendance_records rr ON rr.id=COALESCE(g.sign_in_record_id,g.sign_out_record_id) WHERE ${recordScopeSql} AND COALESCE(g.start_at,rr.effective_occurred_at)>=$3 AND COALESCE(g.start_at,rr.effective_occurred_at)<$4 AND ($5::text IS NULL OR sa.login_code=$5) AND ($6::text IS NULL OR wa.login_code=$6) GROUP BY wa.login_code,wa.name,sa.login_code,s.name ORDER BY wa.name`,
      f,
    )
  ).rows;
}
app.get("/api/v1/manager/attendance", async (req, res) => {
  const all = await records(req);
  const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .parse(req.query.limit),
    offset = z.coerce.number().int().min(0).default(0).parse(req.query.cursor);
  res.json({
    data: {
      items: all.slice(offset, offset + limit),
      nextCursor: offset + limit < all.length ? String(offset + limit) : null,
      period: monthBounds(req.query.month),
    },
  });
});
app.get("/api/v1/manager/attendance/summary", async (req, res) =>
  res.json({
    data: { groups: await summary(req), period: monthBounds(req.query.month) },
  }),
);
app.get(
  ["/api/v1/manager/attendance/:id/history", "/api/v1/attendance/:id/history"],
  async (req, res) => {
    uuid.parse(req.params.id);
    const r = (
      await pool.query("SELECT * FROM attendance_records WHERE id=$1", [
        req.params.id,
      ])
    ).rows[0];
    if (!r) fail(404, "Record not found");
    if (req.account.role === "WORKER") {
      const w = (
        await pool.query("SELECT account_id FROM workers WHERE id=$1", [
          r.worker_id,
        ])
      ).rows[0];
      if (w.account_id !== req.account.id) fail(403, "Only your own history");
    } else await assertRecordScope(pool, req.account, r.shop_id, r.worker_id);
    const history = (
      await pool.query(
        "SELECT a.*,v.decision,v.validated_at,u.name AS validator FROM attendance_adjustments a LEFT JOIN attendance_validations v ON v.adjustment_id=a.id LEFT JOIN accounts u ON u.id=v.validated_by_account_id WHERE a.record_id=$1 ORDER BY a.created_at",
        [r.id],
      )
    ).rows;
    res.json({ data: { record: r, history } });
  },
);
app.get("/api/v1/manager/validations", async (req, res) => {
  const f = filters(req);
  const adjustments = (
    await pool.query(
      `SELECT j.*,r.version,r.original_occurred_at,r.confirmed_occurred_at,wa.name AS worker_name,s.name AS shop_name,'ADJUSTMENT' AS item_type ${filtered.replace("FROM attendance_records r", "FROM attendance_adjustments j JOIN attendance_records r ON r.id=j.record_id")} AND j.status='PENDING' ORDER BY j.created_at`,
      f,
    )
  ).rows;
  const issues = (
    await pool.query(
      `SELECT g.id,g.issue_code,g.sign_in_record_id,g.sign_out_record_id,r.version,w.id AS worker_id,COALESCE(wa.login_code,'__worker__'||w.id::text) AS worker_code,sa.login_code AS shop_code,(r.effective_occurred_at AT TIME ZONE 'Pacific/Auckland')::date::text AS local_date,r.original_occurred_at,wa.name AS worker_name,s.name AS shop_name,'RECORD_ERROR' AS item_type ${filtered.replace("FROM attendance_records r", "FROM work_segments g JOIN attendance_records r ON r.id=COALESCE(g.sign_in_record_id,g.sign_out_record_id)")} AND g.status='INVALID'`,
      f,
    )
  ).rows;
  const people = req.account.role === "GENERAL_MANAGER" ? (await pool.query("SELECT id AS account_id,name AS worker_name,email,profile_version AS version,role,'PERSON_APPROVAL' AS item_type,'NEW_PERSON' AS source FROM accounts WHERE status='PENDING' AND requires_manager_approval AND password_hash IS NOT NULL AND role IN('WORKER','MANAGER') ORDER BY created_at")).rows : [];
  res.json({ data: [...people, ...adjustments, ...issues] });
});
app.post("/api/v1/manager/validations/:id/decision", async (req, res) => {
  uuid.parse(req.params.id);
  const b = z
    .object({
      operationId: uuid,
      decision: z.enum(["APPROVE", "REJECT"]),
      expectedRecordVersion: z.number().int().positive(),
    })
    .parse(req.body);
  const data = await transaction((c) =>
    idem(
      c,
      req.account,
      { ...b, adjustmentId: req.params.id },
      "VALIDATION",
      async () => {
        const reference = (await c.query("SELECT record_id FROM attendance_adjustments WHERE id=$1", [req.params.id])).rows[0];
        if (!reference) fail(404, "Adjustment missing");
        const r = (await c.query("SELECT * FROM attendance_records WHERE id=$1 FOR UPDATE", [reference.record_id])).rows[0];
        const j = (await c.query("SELECT * FROM attendance_adjustments WHERE id=$1 FOR UPDATE", [req.params.id])).rows[0];
        await assertRecordScope(c, req.account, r.shop_id, r.worker_id);
        if (r.version !== b.expectedRecordVersion || j.status !== "PENDING")
          fail(409, "Record changed; reload", "VERSION_CONFLICT");
        if (
          (
            await c.query(
              "SELECT 1 FROM attendance_adjustments WHERE record_id=$1 AND status='PENDING' AND id<>$2",
              [r.id, j.id],
            )
          ).rowCount
        )
          fail(409, "Multiple adjustments require manual resolution");
        const t =
          b.decision === "APPROVE" ? j.after_at : r.confirmed_occurred_at;
        const deleted =
          b.decision === "APPROVE"
            ? j.action === "DELETE"
            : r.confirmed_deleted;
        await c.query(
          "UPDATE attendance_adjustments SET status=$1 WHERE id=$2",
          [b.decision === "APPROVE" ? "APPROVED" : "REJECTED", j.id],
        );
        await c.query(
          "INSERT INTO attendance_validations(adjustment_id,validated_by_account_id,decision,previous_confirmed_at,resulting_confirmed_at) VALUES($1,$2,$3,$4,$5)",
          [j.id, req.account.id, b.decision, r.confirmed_occurred_at, t],
        );
        await c.query(
          "UPDATE attendance_records SET confirmed_occurred_at=$1,effective_occurred_at=COALESCE($1,original_occurred_at),confirmed_deleted=$2,effective_deleted=$2,sign_type=$4,manager_confirmed=manager_confirmed OR $5,version=version+1 WHERE id=$3",
          [t, deleted, r.id, b.decision === "APPROVE" ? (j.after_type || r.sign_type) : r.sign_type, b.decision === "APPROVE"],
        );
        await rebuild(c, r.worker_id);
        await audit(c, req.account, "VALIDATION_" + b.decision, r.id);
        return { recordId: r.id, version: r.version + 1 };
      },
    ),
  );
  res.json({ data });
});
app.post("/api/v1/manager/attendance/:id/corrections", async (req, res) => {
  uuid.parse(req.params.id);
  const b = z
    .object({
      operationId: uuid,
      expectedRecordVersion: z.number().int().positive(),
      occurredAt: instant,
      type: z.enum(["SIGN_IN", "SIGN_OUT"]).optional(),
    })
    .parse(req.body);
  req.body = { operationId: b.operationId, action: "UPDATE", recordId: req.params.id,
    expectedVersion: b.expectedRecordVersion, occurredAt: b.occurredAt, type: b.type };
  return attendanceAdjustment(req, res);
});
app.post("/api/v1/attendance", async (req, res) => {
  if (!["SHOP", "WORKER"].includes(req.account.role))
    fail(403, "App account required");
  const b = z
    .object({
      operationId: uuid,
      workerId: z.string().regex(/^[1-9]\d{3}$/),
      shopId: z.string().regex(/^00\d{2}$/),
      type: z.enum(["SIGN_IN", "SIGN_OUT"]),
      occurredAt: instant,
      plannedStartAt: instant.optional(),
      expectedDailyCount: z.number().int().nonnegative().optional(),
      offline: z.boolean(),
      cameraStatus: z.enum(["AVAILABLE", "UNAVAILABLE"]),
      photoId: uuid.optional(),
      location: z
        .object({
          status: z.enum(["AVAILABLE", "UNAVAILABLE"]),
          latitude: z.number().min(-90).max(90).optional(),
          longitude: z.number().min(-180).max(180).optional(),
          accuracyMeters: z.number().nonnegative().max(100000).optional(),
          capturedAt: instant.optional(),
        })
        .optional(),
    })
    .parse(req.body);
  const data = await transaction((c) =>
    idem(c, req.account, b, "ATTENDANCE", async () => {
      const w = (
        await c.query(
          "SELECT w.id,a.id AS account_id FROM workers w JOIN accounts a ON a.id=w.account_id WHERE a.login_code=$1 AND a.status='ACTIVE' FOR UPDATE OF w",
          [b.workerId],
        )
      ).rows[0];
      const s = (
        await c.query(
          "SELECT s.* FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=$1",
          [b.shopId],
        )
      ).rows[0];
      if (!w || (!s && !(allowAllShops && !shopCode && req.account.role !== "SHOP"))) fail(422, "Unknown worker or shop");
      if (req.account.role === "WORKER") {
        if (w.account_id !== req.account.id)
          fail(403, "Cannot sign for another worker");
      } else await assertShop(c, req.account, s.id);
      if (b.expectedDailyCount !== undefined) {
        const day = localDate(b.occurredAt);
        const count = await dailyAttendanceCount(c, w.id, s.id, day);
        if (day !== localDate(new Date()) || count !== b.expectedDailyCount)
          fail(409, "Attendance changed; refresh today's status", "ATTENDANCE_CHANGED");
      }
      if (b.cameraStatus === "AVAILABLE") {
        if (!b.photoId) fail(422, "Photo required");
        const photo = (
          await c.query(
            "SELECT 1 FROM photos WHERE id=$1 AND uploaded_by_account_id=$2 AND status='READY'",
            [b.photoId, req.account.id],
          )
        ).rowCount;
        if (!photo) fail(422, "Photo unavailable");
      } else if (b.photoId)
        fail(422, "Unavailable camera cannot include photo");
      if (
        b.location?.status === "AVAILABLE" &&
        (b.location.latitude === undefined ||
          b.location.longitude === undefined)
      )
        fail(422, "Coordinates required");
      let position = {
        status: req.account.role === "SHOP" ? "NOT_APPLICABLE" : "UNAVAILABLE",
      };
      if (req.account.role === "WORKER" && b.location?.status === "AVAILABLE") {
        const rad = (n) => (n * Math.PI) / 180,
          lat = b.location.latitude,
          lon = b.location.longitude;
        const h =
          Math.sin(rad(lat - Number(s.latitude)) / 2) ** 2 +
          Math.cos(rad(lat)) *
            Math.cos(rad(Number(s.latitude))) *
            Math.sin(rad(lon - Number(s.longitude)) / 2) ** 2;
        const distance =
          6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
        position = {
          ...b.location,
          status: distance <= 500 ? "IN_RANGE" : "OUT_OF_RANGE",
          distanceMeters: distance,
          shopLatitude: Number(s.latitude),
          shopLongitude: Number(s.longitude),
        };
      }
      const day = localDate(b.occurredAt);
      const first = !(
        await c.query(
          "SELECT 1 FROM attendance_records WHERE worker_id=$1 AND sign_type='SIGN_IN' AND (original_occurred_at AT TIME ZONE $2)::date=$3::date",
          [w.id, zone, day],
        )
      ).rowCount;
      if (b.type === "SIGN_OUT" && b.plannedStartAt)
        fail(422, "Sign out cannot include plan");
      if (b.type === "SIGN_IN" && first && !b.plannedStartAt)
        fail(422, "First sign in requires planned time");
      if (b.plannedStartAt && localDate(b.plannedStartAt) !== day)
        fail(422, "Plan must be on sign-in date");
      const effective = b.occurredAt;
      const r = (
        await c.query(
          "INSERT INTO attendance_records(worker_id,shop_id,submitted_by_account_id,sign_type,source,original_occurred_at,planned_start_at,effective_occurred_at,confirmed_occurred_at,offline,camera_status,photo_id,location) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",
          [
            w.id,
            s.id,
            req.account.id,
            b.type,
            req.account.role === "SHOP" ? "SHOP_DEVICE" : "PERSONAL_APP",
            b.occurredAt,
            first ? b.plannedStartAt || null : null,
            effective,
            b.occurredAt,
            b.offline,
            b.cameraStatus,
            b.photoId || null,
            position,
          ],
        )
      ).rows[0];
      await rebuild(c, w.id);
      return {
        recordId: r.id,
        shopId: b.shopId, shopName: s.name, occurredAt: r.original_occurred_at, type: r.sign_type,
        dailyCount: await dailyAttendanceCount(c, w.id, s.id, day),
        syncStatus: "SYNCED",
        validationStatus: "SUBMITTED",
      };
    }),
  );
  res.status(201).json({ data });
});
app.post("/api/v1/manager/reports/pdf", async (req, res) => {
  const b = z
    .object({
      operationId: uuid,
      month: z.string(),
      shopId: z.string().optional(),
      workerId: z.string().optional(),
      reportType: z.enum(["ATTENDANCE", "TIMESHEET"]),
    })
    .parse(req.body);
  monthBounds(b.month);
  const reportReq = { account: req.account, query: b };
  const data = await transaction(async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    return idem(c, req.account, b, "PDF", async () => {
      const snapshot = {
        records: await records(reportReq, c),
        groups: await summary(reportReq, c),
        period: monthBounds(b.month),
        scopeIds: (
          await c.query(
            `SELECT s.id FROM shops s JOIN accounts sa ON sa.id=s.account_id WHERE ${scopeSql} AND ($3::text IS NULL OR sa.login_code=$3)`,
            [req.account.role, req.account.id, b.shopId || null],
          )
        ).rows.map((x) => x.id),
      };
      const r = (
        await c.query(
          "INSERT INTO report_exports(requested_by_account_id,filters,snapshot_data) VALUES($1,$2,$3) RETURNING id",
          [req.account.id, b, snapshot],
        )
      ).rows[0];
      return { reportId: r.id, snapshot };
    });
  });
  for (const record of data.snapshot.records)
    await assertRecordScope(pool, req.account, record.shop_id, record.worker_id);
  for (const group of data.snapshot.groups) {
    const ids = (await pool.query("SELECT w.id AS worker_id,s.id AS shop_id FROM workers w JOIN accounts wa ON wa.id=w.account_id CROSS JOIN shops s JOIN accounts sa ON sa.id=s.account_id WHERE wa.login_code=$1 AND sa.login_code=$2", [group.workerId, group.shopId])).rows[0];
    if (!ids) fail(403, "Report scope unavailable");
    await assertRecordScope(pool, req.account, ids.shop_id, ids.worker_id);
  }
  res.type("pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="Pawhub-${b.month}.pdf"`,
  );
  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(res);
  doc.fontSize(18).text(`Pawhub ${b.reportType} - ${b.month}`);
  doc
    .fontSize(10)
    .text("Timezone: Pacific/Auckland. Pending/invalid periods excluded.");
  for (const g of data.snapshot.groups)
    doc
      .moveDown()
      .text(
        `${g.workerId} | ${g.shopId} | ${g.confirmedHrs} hrs | pending ${g.pendingSegmentCount} | errors ${g.invalidSegmentCount}`,
      );
  if (b.reportType === "ATTENDANCE")
    for (const r of data.snapshot.records)
      doc
        .moveDown()
        .text(
          `${r.workerId} ${r.shopId} ${r.sign_type}\nOriginal: ${DateTime.fromJSDate(new Date(r.original_occurred_at), { zone }).toFormat("yyyy-MM-dd HH:mm:ss")}\nConfirmed: ${r.confirmed_occurred_at ? DateTime.fromJSDate(new Date(r.confirmed_occurred_at), { zone }).toFormat("yyyy-MM-dd HH:mm:ss") : "Pending"}`,
        );
  doc.end();
});
async function appScope(req, c, shopCode, workerCode, allowAllShops = false) {
  if (backend.includes(req.account.role)) await c.query("INSERT INTO workers(account_id,contact,address) VALUES($1,$2,$3) ON CONFLICT(account_id) DO NOTHING", [req.account.id, req.account.profile_phone, req.account.profile_address]);
  const w = (
    await c.query(
      "SELECT w.*,a.login_code FROM workers w JOIN accounts a ON a.id=w.account_id WHERE ($1::text IS NOT NULL AND a.login_code=$1) OR ($1::text IS NULL AND a.id=$2 AND a.role IN('WORKER','MANAGER','GENERAL_MANAGER','SUPER_MANAGER'))",
      [workerCode || null, req.account.id],
    )
  ).rows[0];
  const s = (
    await c.query(
      "SELECT s.* FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=$1",
      [shopCode],
    )
  ).rows[0];
  if (!w || (!s && !(allowAllShops && !shopCode && req.account.role !== "SHOP"))) fail(422, "Unknown worker or shop");
  if (["WORKER", ...backend].includes(req.account.role)) {
    if (w.account_id !== req.account.id) fail(403, "Only your own records");
  } else if (req.account.role === "SHOP")
    await assertShop(c, req.account, s.id);
  else fail(403, "App account required");
  return { w, s };
}
async function dailyAttendanceCount(c, workerId, shopId, day) {
  return Number((await c.query(
    "SELECT count(*)::int AS count FROM attendance_records WHERE worker_id=$1 AND shop_id=$2 AND NOT effective_deleted AND (effective_occurred_at AT TIME ZONE $3)::date=$4::date",
    [workerId, shopId, zone, day],
  )).rows[0].count);
}
app.get("/api/v1/shops/:shopId/employees/:workerId", async (req, res) => {
  if (req.account.role !== "SHOP") fail(403, "Shop account required");
  const { shopId, workerId } = req.params;
  if (!/^[0-9]{4}$/.test(shopId) || !/^[0-9]{4}$/.test(workerId))
    fail(422, "Four-digit shop and employee IDs required");
  const shop = (await pool.query(
    "SELECT s.id FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=$1",
    [shopId],
  )).rows[0];
  if (!shop) fail(404, "Shop not found");
  await assertShop(pool, req.account, shop.id);
  const worker = (await pool.query(
    "SELECT a.login_code AS \"workerId\",a.name,a.requires_manager_approval FROM workers w JOIN accounts a ON a.id=w.account_id WHERE a.login_code=$1 AND a.role='WORKER' AND a.status='ACTIVE'",
    [workerId],
  )).rows[0];
  if (!worker) fail(404, "Employee not found", "EMPLOYEE_NOT_FOUND");
  if (worker.requires_manager_approval) fail(403, "Manager approval required", "MANAGER_APPROVAL_REQUIRED");
  res.json({ data: { shopId, workerId: worker.workerId, name: worker.name } });
});
app.get("/api/v1/attendance/status", async (req, res) => {
  const code = req.query.workerId || req.account.login_code;
  const { w, s } = await appScope(req, pool, req.query.shopId, code);
  const day = localDate(new Date());
  const r = (
    await pool.query(
      "SELECT * FROM attendance_records WHERE worker_id=$1 AND shop_id=$2 AND NOT effective_deleted AND (effective_occurred_at AT TIME ZONE $3)::date=$4::date ORDER BY effective_occurred_at DESC,id DESC LIMIT 1",
      [w.id, s.id, zone, day],
    )
  ).rows[0];
  const any = (
    await pool.query(
      "SELECT 1 FROM attendance_records WHERE worker_id=$1 AND sign_type='SIGN_IN' AND (original_occurred_at AT TIME ZONE $2)::date=$3::date",
      [w.id, zone, day],
    )
  ).rowCount;
  const count = await dailyAttendanceCount(pool, w.id, s.id, day);
  res.json({
    data: {
      localDate: day,
      timezone: zone,
      attendanceEnabled: req.account.status === "ACTIVE",
      serverTime: new Date().toISOString(),
      dailyCount: count,
      requiresPlannedStart: !any,
      latestRecordId: r?.id || null,
    },
  });
});
function selectedCodes(value, pattern) {
  if (value == null || value === "") return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(z.array(z.string().regex(pattern)).max(200).parse(list))];
}
async function attendanceStores(c, value) {
  const codes=selectedCodes(value,/^00\d{2}$/);
  if (!codes.length) return {shopIds:null,s:null};
  const rows=(await c.query("SELECT s.*,a.login_code FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=ANY($1::text[]) ORDER BY s.name",[codes])).rows;
  if(rows.length!==codes.length) fail(422,"Unknown store");
  return {shopIds:rows.map(r=>r.id),s:{name:rows.map(r=>r.name).join(", "),id:rows.length===1?rows[0].id:null}};
}
async function staffAttendanceScope(c, actor, shopCodes, workerCodes) {
  await c.query("INSERT INTO workers(account_id,contact,address) VALUES($1,'','') ON CONFLICT(account_id) DO NOTHING",[actor.id]);
  const codes=selectedCodes(workerCodes,/^(?:[1-9]\d{3}|__self__|__worker__[a-f0-9-]{36})$/);
  const available=(await c.query(`SELECT w.id,a.id AS account_id,a.name,a.login_code FROM workers w JOIN accounts a ON a.id=w.account_id WHERE ($1 IN('GENERAL_MANAGER','SUPER_MANAGER') AND a.role IN('WORKER','MANAGER','GENERAL_MANAGER')) OR (a.role='WORKER' AND EXISTS(SELECT 1 FROM manager_workers mw WHERE mw.manager_account_id=$2 AND mw.worker_id=w.id)) OR a.id=$2 ORDER BY a.name`,[actor.role,actor.id])).rows;
  const chosenShops=selectedCodes(shopCodes,/^00\d{2}$/);
  if(actor.role==='MANAGER' && codes.length && chosenShops.length===1){
    const permitted=(await c.query("SELECT 1 FROM account_shops x JOIN shops s ON s.id=x.shop_id JOIN accounts a ON a.id=s.account_id WHERE x.account_id=$1 AND a.login_code=$2",[actor.id,chosenShops[0]])).rowCount;
    if(permitted){
      const additional=(await c.query("SELECT w.id,a.id AS account_id,a.name,a.login_code FROM workers w JOIN accounts a ON a.id=w.account_id WHERE a.role='WORKER' AND (a.login_code=ANY($1::text[]) OR '__worker__'||w.id::text=ANY($1::text[]))",[codes])).rows;
      for(const row of additional)if(!available.some(r=>r.id===row.id))available.push(row);
    }
  }
  if(codes.some(code=>!available.some(r=>r.login_code===code || code==='__worker__'+r.id || (code==='__self__'&&r.account_id===actor.id)))) fail(403,"Staff outside your managed groomers");
  const staff=codes.length?available.filter(r=>codes.includes(r.login_code)||codes.includes('__worker__'+r.id)||(codes.includes('__self__')&&r.account_id===actor.id)):available;
  return {...await attendanceStores(c,shopCodes),workerIds:staff.map(r=>r.id),staffName:codes.length?staff.map(r=>r.name).join(", "):"All accessible staff",staffCode:staff.length===1?staff[0].login_code:null};
}
async function personalAttendanceScope(c,req,shopCodes,workerCodes) {
  const codes=selectedCodes(workerCodes,/^(?:[1-9]\d{3}|__self__|__worker__[a-f0-9-]{36})$/);
  if(codes.length>1) fail(403,"Only your own records");
  const shops=selectedCodes(shopCodes,/^00\d{2}$/);
  const {w}=await appScope(req,c,req.account.role==='SHOP'?shops[0]:null,codes[0]||req.account.login_code,true);
  const scope=await attendanceStores(c,shops);
  if(req.account.role==='SHOP') for(const id of scope.shopIds||[]) await assertShop(c,req.account,id);
  return {...scope,workerIds:[w.id]};
}
app.get("/api/v1/manager/staff-attendance/staff", async (req, res) => {
  await pool.query("INSERT INTO workers(account_id,contact,address) VALUES($1,'','') ON CONFLICT(account_id) DO NOTHING",[req.account.id]);
  const staff=(await pool.query(`SELECT w.id,a.name,COALESCE(a.login_code,CASE WHEN a.id=$2 THEN '__self__' ELSE '__worker__'||w.id::text END) AS "workerId",a.status FROM workers w JOIN accounts a ON a.id=w.account_id WHERE (($1 IN('GENERAL_MANAGER','SUPER_MANAGER') AND a.role IN('WORKER','MANAGER','GENERAL_MANAGER')) OR (a.role='WORKER' AND EXISTS(SELECT 1 FROM manager_workers mw WHERE mw.manager_account_id=$2 AND mw.worker_id=w.id))) OR a.id=$2 ORDER BY a.name`,[req.account.role,req.account.id])).rows;
  res.json({data:staff});
});
app.get("/api/v1/manager/attendance/locations", async(req,res)=>{
  if(!companyAdmin(req.account))fail(403,"General manager or Owner required");
  const range=z.object({fromDate:z.iso.date(),toDate:z.iso.date()}).parse(req.query);
  if(range.fromDate>range.toDate || new Date(range.toDate)-new Date(range.fromDate)>30*86400000)fail(422,"Date range must be within 31 days");
  const scope=await staffAttendanceScope(pool,req.account,req.query.shopIds,req.query.workerIds);
  const cursor=z.coerce.number().int().min(0).default(0).parse(req.query.cursor);
  const rows=(await pool.query(`SELECT r.id,r.photo_id,r.worker_id,r.shop_id,r.original_occurred_at,r.effective_occurred_at,r.confirmed_occurred_at,r.manager_confirmed,r.sign_type,r.location,wa.name AS worker_name,wa.login_code AS worker_code,s.name AS shop_name,s.latitude AS shop_latitude,s.longitude AS shop_longitude FROM attendance_records r JOIN workers w ON w.id=r.worker_id JOIN accounts wa ON wa.id=w.account_id JOIN shops s ON s.id=r.shop_id WHERE r.worker_id=ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR r.shop_id=ANY($2::uuid[])) AND NOT r.confirmed_deleted AND (r.original_occurred_at AT TIME ZONE $3)::date BETWEEN $4::date AND $5::date ORDER BY r.original_occurred_at,r.id`,[scope.workerIds,scope.shopIds,zone,range.fromDate,range.toDate])).rows;
  const records=rows.map(row=>{const gps=attendanceLocation(row.location,row.shop_latitude,row.shop_longitude);return {id:row.id,photoId:row.photo_id,workerId:row.worker_id,workerName:row.worker_name,workerCode:row.worker_code,shopName:row.shop_name,type:row.sign_type,originalTime:row.original_occurred_at,currentTime:row.effective_occurred_at,confirmedTime:row.manager_confirmed?row.confirmed_occurred_at:null,...(gps||{latitude:null,longitude:null,distanceMeters:null,accuracyMeters:null,capturedAt:null})};});
  res.json({data:{items:records.slice(cursor,cursor+100),total:records.length,nextCursor:cursor+100<records.length?String(cursor+100):null}});
});
function attendanceDays(records, staffMode) {
  const groups = new Map();
  for (const r of records) {
    const key=r.worker_id+":"+r.shop_id;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(r);
  }
  return [...groups.values()].flatMap(rows=>dailyAttendanceHours(rows).map(day=>({...day,workerId:rows[0].worker_id,workerCode:rows[0].worker_code || "__worker__"+rows[0].worker_id,workerName:rows[0].worker_name,shopId:rows[0].shop_id,shopCode:rows[0].shop_code,shopName:rows[0].shop_name}))).sort((a,b)=>a.date.localeCompare(b.date)||a.workerName.localeCompare(b.workerName)||a.shopName.localeCompare(b.shopName));
}
app.get(["/api/v1/attendance", "/api/v1/manager/staff-attendance"], async (req, res) => {
  const staffMode = req.path.startsWith("/api/v1/manager/");
  let scope;
  if (staffMode) scope = await staffAttendanceScope(pool, req.account, req.query.shopIds ?? req.query.shopId, req.query.workerIds ?? req.query.workerId);
  else scope=await personalAttendanceScope(pool,req,req.query.shopIds ?? req.query.shopId,req.query.workerIds ?? req.query.workerId);
  const range = z
    .object({ fromDate: z.iso.date(), toDate: z.iso.date() })
    .parse(req.query);
  if (
    range.fromDate > range.toDate ||
    new Date(range.toDate) - new Date(range.fromDate) > 30 * 86400000
  )
    fail(422, "Date range must be within 31 days");
  const r = await pool.query(
    "SELECT r.*,wa.name AS worker_name,wa.login_code AS worker_code,sh.name AS shop_name,sa.login_code AS shop_code,(SELECT x.after_type FROM attendance_adjustments x WHERE x.record_id=r.id AND x.status='PENDING' LIMIT 1) AS pending_sign_type,EXISTS(SELECT 1 FROM attendance_adjustments x WHERE x.record_id=r.id AND x.status='PENDING') AS pending FROM attendance_records r JOIN workers wr ON wr.id=r.worker_id JOIN accounts wa ON wa.id=wr.account_id JOIN shops sh ON sh.id=r.shop_id JOIN accounts sa ON sa.id=sh.account_id WHERE worker_id=ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR r.shop_id=ANY($2::uuid[])) AND NOT confirmed_deleted AND (NOT effective_deleted OR EXISTS(SELECT 1 FROM attendance_adjustments x WHERE x.record_id=r.id AND x.status='PENDING')) AND (effective_occurred_at AT TIME ZONE $3)::date BETWEEN $4::date AND $5::date ORDER BY effective_occurred_at,id",
    [scope.workerIds, scope.shopIds, zone, range.fromDate, range.toDate],
  );
  const dailyHours = attendanceDays(r.rows, staffMode);
  res.json({ data: { items: r.rows, dailyHours, totalHours: totalAttendanceHours(dailyHours) } });
});
app.post(["/api/v1/attendance/exports", "/api/v1/manager/staff-attendance/exports"], async (req, res) => {
  if (!["WORKER", ...backend].includes(req.account.role)) fail(403, "Personal employee account required");
  const b = z.object({ operationId: uuid, shopId: z.string().regex(/^00\d{2}$/).nullable().optional(),
    workerId: z.union([z.string().regex(/^[1-9]\d{3}$/),z.literal("__self__")]).nullable().optional(),
    shopIds: z.array(z.string().regex(/^00\d{2}$/)).max(200).optional(),
    workerIds: z.array(z.string().regex(/^(?:[1-9]\d{3}|__self__|__worker__[a-f0-9-]{36})$/)).max(200).optional(),
    fromDate: z.iso.date(), toDate: z.iso.date(),
    records: z.array(z.object({ id: uuid, version: z.number().int().positive() })).min(1).max(2000),
  }).strict().parse(req.body);
  if (b.fromDate > b.toDate || new Date(b.toDate) - new Date(b.fromDate) > 30 * 86400000)
    fail(422, "Date range must be within 31 days");
  if (req.path.startsWith("/api/v1/manager/")) {
    const scope = await staffAttendanceScope(pool,req.account,b.shopIds ?? b.shopId,b.workerIds ?? b.workerId);
    const ids = new Set(scope.workerIds);
    const existing = (await pool.query("SELECT worker_id FROM attendance_records WHERE id=ANY($1::uuid[])",[b.records.map(r=>r.id)])).rows;
    if (existing.some(r=>!ids.has(r.worker_id))) fail(403,"Staff outside your managed groomers");
  }
  const data = await transaction(c => idem(c, req.account, b, req.path.startsWith("/api/v1/manager/") ? "STAFF_ATTENDANCE_EMAIL_EXPORT" : "ATTENDANCE_EMAIL_EXPORT", async () => {
    const staffMode = req.path.startsWith("/api/v1/manager/");
    let scope;
    if (staffMode) scope=await staffAttendanceScope(c,req.account,b.shopIds ?? b.shopId,b.workerIds ?? b.workerId);
    else scope=await personalAttendanceScope(c,req,b.shopIds ?? b.shopId,b.workerIds ?? b.workerId);
    const s=scope.s;
    const account = (await c.query("SELECT email,name FROM accounts WHERE id=$1", [req.account.id])).rows[0];
    if (!account.email) fail(422, "Registered email required");
    const result = await c.query("SELECT r.*,wa.name AS worker_name,wa.login_code AS worker_code,sh.name AS shop_name,sa.login_code AS shop_code,(SELECT x.after_type FROM attendance_adjustments x WHERE x.record_id=r.id AND x.status='PENDING' LIMIT 1) AS pending_sign_type,EXISTS(SELECT 1 FROM attendance_adjustments x WHERE x.record_id=r.id AND x.status='PENDING') AS pending FROM attendance_records r JOIN workers wr ON wr.id=r.worker_id JOIN accounts wa ON wa.id=wr.account_id JOIN shops sh ON sh.id=r.shop_id JOIN accounts sa ON sa.id=sh.account_id WHERE worker_id=ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR r.shop_id=ANY($2::uuid[])) AND NOT confirmed_deleted AND (NOT effective_deleted OR EXISTS(SELECT 1 FROM attendance_adjustments x WHERE x.record_id=r.id AND x.status='PENDING')) AND (effective_occurred_at AT TIME ZONE $3)::date BETWEEN $4::date AND $5::date AND r.id=ANY($6::uuid[]) ORDER BY effective_occurred_at,id FOR SHARE OF r",
      [scope.workerIds, scope.shopIds, zone, b.fromDate, b.toDate, b.records.map(r => r.id)]);
    const versions = new Map(b.records.map(r => [r.id, r.version]));
    if (versions.size !== b.records.length || result.rows.length !== versions.size ||
        result.rows.some(r => versions.get(r.id) !== r.version))
      fail(409, "Records changed; query again before exporting");
    const period = b.fromDate === b.toDate ? b.fromDate : `${b.fromDate} - ${b.toDate}`;
    const subject = `Pawhub ${s?.name || "All stores"} ${period} attendence record`.replace(/[\r\n]/g, " ");
    const snapshot = { shopId: b.shopId || (b.shopIds?.length===1?b.shopIds[0]:null), shopIds:b.shopIds || [], shopName: s?.name || "All stores", fromDate: b.fromDate, toDate: b.toDate,
      workerName: staffMode ? scope.staffName : account.name, workerCode: staffMode ? scope.staffCode : req.account.login_code, staffMode, dailyHours:attendanceDays(result.rows,staffMode), records: result.rows };
    const job = (await c.query("INSERT INTO attendance_export_jobs(account_id,recipient_email,subject,snapshot_data) VALUES($1,$2,$3,$4) RETURNING id",
      [req.account.id, account.email, subject, snapshot])).rows[0];
    await audit(c, req.account, "ATTENDANCE_EMAIL_EXPORT", job.id);
    return { exportId: job.id, status: "QUEUED", recipientEmail: account.email };
  }));
  res.status(202).json({ data });
});
app.get("/api/v1/attendance/summary", async (req, res) => {
  const { w, s } = await appScope(
    req,
    pool,
    req.query.shopId,
    req.query.workerId || req.account.login_code,
  );
  const range = z
    .object({ fromDate: z.iso.date(), toDate: z.iso.date() })
    .parse(req.query);
  const r = await pool.query(
    "SELECT status,issue_code,hrs,start_at,end_at FROM work_segments WHERE worker_id=$1 AND shop_id=$2 AND (start_at AT TIME ZONE $3)::date BETWEEN $4::date AND $5::date",
    [w.id, s.id, zone, range.fromDate, range.toDate],
  );
  res.json({ data: { segments: r.rows } });
});
async function attendanceAdjustment(req, res) {
  const managerEndpoint = req.path.includes("/manager/");
  const managerRequest = backend.includes(req.account.role);
  const b = z
    .object({
      operationId: uuid,
      action: z.enum(["ADD", "UPDATE", "DELETE"]),
      recordId: uuid.optional(),
      expectedVersion: z.number().int().positive().optional(),
      occurredAt: instant.optional(),
      workerId: z.string().optional(),
      shopId: z.string().optional(),
      type: z.enum(["SIGN_IN", "SIGN_OUT"]).optional(),
    })
    .parse(req.body);
  const data = await transaction((c) =>
    idem(c, req.account, b, "ADJUSTMENT", async () => {
      let r;
      if (b.action === "ADD") {
        if (!b.occurredAt || !b.type) fail(422, "Time and type required");
        let w, s;
        if (managerEndpoint) {
          w = (await c.query("SELECT w.* FROM workers w JOIN accounts a ON a.id=w.account_id WHERE (a.login_code=$1 OR ($1='__self__' AND a.id=$2) OR $1='__worker__'||w.id::text) AND a.status='ACTIVE'", [b.workerId,req.account.id])).rows[0];
          s = (await c.query("SELECT s.* FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=$1", [b.shopId])).rows[0];
          if (!w || !s) fail(422, "Active employee and store required");
          await assertRecordScope(c, req.account, s.id, w.id);
        } else ({ w, s } = await appScope(req, c, b.shopId, b.workerId || req.account.login_code));
        await c.query("SELECT id FROM workers WHERE id=$1 FOR UPDATE", [w.id]);
        r = (
          await c.query(
            "INSERT INTO attendance_records(worker_id,shop_id,submitted_by_account_id,sign_type,source,original_occurred_at,effective_occurred_at,camera_status) VALUES($1,$2,$3,$4,'MANUAL_ADD',$5,$5,'NOT_APPLICABLE') RETURNING *",
            [w.id, s.id, req.account.id, b.type, b.occurredAt],
          )
        ).rows[0];
      } else {
        if (!b.recordId || !b.expectedVersion)
          fail(422, "Record and version required");
        r = (
          await c.query(
            "SELECT r.*,wa.login_code AS worker_code,sa.login_code AS shop_code FROM attendance_records r JOIN workers w ON w.id=r.worker_id JOIN accounts wa ON wa.id=w.account_id JOIN shops s ON s.id=r.shop_id JOIN accounts sa ON sa.id=s.account_id WHERE r.id=$1 FOR UPDATE OF r",
            [b.recordId],
          )
        ).rows[0];
        if (!r) fail(404, "Record missing");
        if (managerEndpoint) await assertRecordScope(c, req.account, r.shop_id, r.worker_id);
        else {
          const own = (await c.query("SELECT account_id FROM workers WHERE id=$1", [r.worker_id])).rows[0];
          if (req.account.role !== "SHOP" && own.account_id !== req.account.id) fail(403, "Only your own records");
          await appScope(req, c, r.shop_code, r.worker_code);
        }
        if (!managerRequest && r.manager_confirmed) fail(403, "Confirmed records can only be changed by a manager", "RECORD_CONFIRMED");
        if (r.confirmed_deleted) fail(409, "Record is already marked for removal");
        if (r.version !== b.expectedVersion) fail(409, "Record changed");
        if (b.action === "UPDATE" && !b.occurredAt) fail(422, "Time required");
      }
      const pending = (await c.query("SELECT * FROM attendance_adjustments WHERE record_id=$1 AND status='PENDING' FOR UPDATE", [r.id])).rows;
      if (!managerRequest && pending.length > 1) fail(409, "Multiple pending changes require manager resolution");
      if (managerRequest) {
        for (const old of pending) {
          await c.query("UPDATE attendance_adjustments SET status='REJECTED' WHERE id=$1",[old.id]);
          await c.query("INSERT INTO attendance_validations(adjustment_id,validated_by_account_id,decision,previous_confirmed_at,resulting_confirmed_at) VALUES($1,$2,'REJECT',$3,$3)",[old.id,req.account.id,r.confirmed_occurred_at]);
          await audit(c,req.account,"ATTENDANCE_REQUEST_SUPERSEDED",r.id,{adjustmentId:old.id},{reason:"Direct manager change"});
        }
        const deleting=b.action === "DELETE", type=b.type || r.sign_type, after=deleting ? null : b.occurredAt;
        const adjustment=(await c.query("INSERT INTO attendance_adjustments(record_id,actor_account_id,source,action,before_at,after_at,base_version,status,before_type,after_type) VALUES($1,$2,'MANAGER_EDIT',$3,$4,$5,$6,'APPROVED',$7,$8) RETURNING id",[r.id,req.account.id,b.action,b.action==='ADD'?null:r.effective_occurred_at,after,r.version,b.action==='ADD'?null:r.sign_type,deleting?null:type])).rows[0];
        await c.query("INSERT INTO attendance_validations(adjustment_id,validated_by_account_id,decision,previous_confirmed_at,resulting_confirmed_at) VALUES($1,$2,'APPROVE',$3,$4)",[adjustment.id,req.account.id,r.confirmed_occurred_at,after]);
        await c.query("UPDATE attendance_records SET sign_type=$2,effective_occurred_at=COALESCE($3,effective_occurred_at),confirmed_occurred_at=COALESCE($3,confirmed_occurred_at),effective_deleted=$4,confirmed_deleted=$4,manager_confirmed=true,version=version+1 WHERE id=$1",[r.id,type,after,deleting]);
        await rebuild(c,r.worker_id);
        await audit(c,req.account,"ATTENDANCE_MANAGER_"+b.action,r.id,{time:r.effective_occurred_at,type:r.sign_type},{time:after,type:deleting?null:type});
        return {recordId:r.id,adjustmentId:adjustment.id,recordStatus:deleting?"removal":"active",validationStatus:"APPROVED",version:r.version+1};
      }
      const after = b.action === "DELETE" ? null : b.occurredAt;
      const finalType = b.type || pending[0]?.after_type || r.sign_type;
      const j = pending.length
        ? (await c.query("UPDATE attendance_adjustments SET actor_account_id=$2,action=$3,after_at=$4,after_type=$5,base_version=$6 WHERE id=$1 RETURNING id",
            [pending[0].id, req.account.id, b.action, after, b.action === "DELETE" ? null : finalType, r.version])).rows[0]
        : (await c.query(
            "INSERT INTO attendance_adjustments(record_id,actor_account_id,source,action,before_at,after_at,base_version,before_type,after_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
            [r.id, req.account.id, managerRequest ? "MANAGER_EDIT" : "WORKER_EDIT", b.action,
              b.action === "ADD" ? null : r.original_occurred_at, after, r.version,
              b.action === "ADD" ? null : r.sign_type, b.action === "DELETE" ? null : finalType],
          )).rows[0];
      await c.query(
        "UPDATE attendance_records SET effective_occurred_at=COALESCE($1,effective_occurred_at),effective_deleted=$2,version=version+1 WHERE id=$3",
        [after, b.action === "DELETE", r.id],
      );
      await rebuild(c, r.worker_id);
      await audit(c, req.account, "ATTENDANCE_" + (b.action === "DELETE" ? "REMOVAL" : b.action) + "_REQUEST", r.id);
      return {
        recordId: r.id,
        recordStatus: b.action === "DELETE" ? "removal" : "active",
        adjustmentId: j.id,
        validationStatus: "PENDING",
      };
    }),
  );
  res.status(req.path.endsWith("/corrections") ? 200 : 201).json({ data });
}
app.post(["/api/v1/attendance-adjustments", "/api/v1/manager/attendance-adjustments"], attendanceAdjustment);
app.post("/api/v1/photos", upload.single("file"), async (req, res) => {
  if (!["SHOP", "WORKER"].includes(req.account.role))
    fail(403, "App account required");
  if (process.env.PHOTO_STORAGE !== "local" && !process.env.PHOTO_BUCKET) fail(503, "Photo storage not configured");
  const operationId = uuid.parse(req.body.operationId);
  if (!req.file) fail(422, "Photo required");
  const meta = await sharp(req.file.buffer, {
    limitInputPixels: 20000000,
  }).metadata();
  if (!["jpeg", "png", "webp"].includes(meta.format))
    fail(422, "Unsupported image format");
  await sharp(req.file.buffer, { limitInputPixels: 20000000 }).stats();
  const b = { operationId, contentHash: hash(req.file.buffer) };
  const data = await transaction((c) =>
    idem(c, req.account, b, "PHOTO", async () => {
      const id = randomUUID(),
        key = `photos/${req.account.id}/${operationId}.${meta.format}`;
      const storageKey = process.env.PHOTO_STORAGE === "local" ? `local:${key}` : key;
      if (process.env.PHOTO_STORAGE === "local") {
        const file = localPhotoPath(storageKey);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, req.file.buffer, { mode: 0o600 });
      } else {
        await s3.send(new PutObjectCommand({ Bucket: process.env.PHOTO_BUCKET, Key: key,
          Body: req.file.buffer, ContentType: "image/" + meta.format, ServerSideEncryption: "AES256" }));
      }
      await c.query(
        "INSERT INTO photos(id,uploaded_by_account_id,storage_key,status,media_type,byte_size) VALUES($1,$2,$3,'READY',$4,$5)",
        [id, req.account.id, storageKey, meta.format, req.file.size],
      );
      return { photoId: id };
    }),
  );
  res.status(201).json({ data });
});
async function readablePhoto(req) {
  uuid.parse(req.params.id);
  const r = (
    await pool.query(
      "SELECT p.*,r.shop_id,r.worker_id,w.account_id AS worker_account FROM photos p LEFT JOIN attendance_records r ON r.photo_id=p.id LEFT JOIN workers w ON w.id=r.worker_id WHERE p.id=$1",
      [req.params.id],
    )
  ).rows[0];
  if (!r) fail(404, "Photo unavailable");
  if (r.shop_id) {
    if (req.account.role === "WORKER") {
      if (r.worker_account !== req.account.id) fail(403, "Forbidden");
    } else if (r.worker_account !== req.account.id) await assertRecordScope(pool, req.account, r.shop_id, r.worker_id);
  } else if (r.uploaded_by_account_id !== req.account.id)
    fail(403, "Forbidden");
  if (r.status === "EXPIRED") fail(410, "Photo removed after the 3-month retention period", "PHOTO_EXPIRED");
  if (r.status !== "READY") fail(404, "Photo unavailable");
  return r;
}
app.get("/api/v1/photos/:id/file", async (req, res) => {
  const photo = await readablePhoto(req);
  if (!photo.storage_key.startsWith("local:")) fail(404, "Local photo unavailable");
  res.set("Cache-Control", "private, no-store");
  res.type(photo.media_type === "jpeg" ? "image/jpeg" : `image/${photo.media_type}`);
  res.sendFile(localPhotoPath(photo.storage_key));
});
app.get("/api/v1/photos/:id", async (req, res) => {
  const r = await readablePhoto(req);
  if (r.storage_key.startsWith("local:")) return res.json({ data: {
    url: `/api/v1/photos/${r.id}/file`, requiresAuthentication: true,
  } });
  res.json({
    data: {
      url: await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: process.env.PHOTO_BUCKET,
          Key: r.storage_key,
        }),
        { expiresIn: 120 },
      ),
      expiresIn: 120,
    },
  });
});

mountOrganization(app, { z, uuid, pool, transaction, idem, fail, audit, encrypt, randomInt, geocodeAddress, assertShop });
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status =
    err instanceof z.ZodError
      ? 422
      : err instanceof multer.MulterError
        ? 413
        : err.code === "23505"
          ? 409
          : err.status || 500;
  if (status === 500) console.error("API failure:", err.code || err.name);
  res.status(status).json({
    error: {
      code: status === 500 ? "INTERNAL_ERROR" : err.code || "VALIDATION_ERROR",
      message:
        status === 500
          ? "Internal server error"
          : err instanceof z.ZodError
            ? "Invalid request fields"
            : err.message,
      fields: err instanceof z.ZodError ? err.issues : [],
    },
  });
});
