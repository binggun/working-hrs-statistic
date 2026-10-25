import express from "express";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
app.use(rateLimit({ windowMs: 60000, limit: 300 }));
const hash = (x) => createHash("sha256").update(x).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const fail = (status, message, code = "REQUEST_FAILED") => {
  throw Object.assign(new Error(message), { status, code });
};
const uuid = z.string().uuid();
const instant = z.iso.datetime({ offset: true });
const backend = ["MANAGER", "SUPER_MANAGER"];
app.get("/api/v1/health", async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ data: { status: "ok" } });
});
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
        ? "SELECT * FROM accounts WHERE lower(email)=$1 AND role IN('MANAGER','SUPER_MANAGER') ORDER BY id FOR SHARE"
        : b.email
          ? "SELECT * FROM accounts WHERE lower(email)=$1 AND role IN('WORKER','MANAGER','SUPER_MANAGER') ORDER BY id FOR SHARE"
          : "SELECT * FROM accounts WHERE login_code=$1 AND role IN('SHOP','WORKER') FOR SHARE",
      [b.email?.toLowerCase() || b.accountId],
    );
    const matches = [];
    for (const account of r.rows) {
      if (account.status === "ACTIVE" && account.password_hash && await argon2.verify(account.password_hash, b.password))
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
      newPassword: z.string().min(12).max(128),
    })
    .parse(req.body);
  const pw = await argon2.hash(b.newPassword);
  await transaction(async (c) => {
    const r = await c.query(
      "SELECT p.*,a.status FROM password_links p JOIN accounts a ON a.id=p.account_id WHERE token_hash=$1 FOR UPDATE OF p,a",
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
    await c.query(
      "UPDATE accounts SET password_hash=$1,status='ACTIVE' WHERE id=$2",
      [pw, p.account_id],
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
  });
  res.json({ data: { activated: true } });
});
app.post(
  "/api/v1/auth/password-links",
  rateLimit({ windowMs: 900000, limit: 10 }),
  async (req, res) => {
    const b = z
      .object({
        accountId: z
          .string()
          .regex(/^[1-9]\d{3}$/)
          .optional(),
        email: z.email().optional(),
      })
      .refine((b) => !!b.accountId !== !!b.email)
      .parse(req.body);
    await transaction(async (c) => {
      const matches = (await c.query(
        b.accountId
          ? "SELECT * FROM accounts WHERE login_code=$1 AND role='WORKER' AND status='ACTIVE' ORDER BY id FOR UPDATE"
          : "SELECT * FROM accounts WHERE lower(email)=$1 AND role IN('WORKER','MANAGER','SUPER_MANAGER') AND status='ACTIVE' ORDER BY id FOR UPDATE",
        [b.accountId || b.email.toLowerCase()],
      )).rows;
      for (const account of matches) await invite(c, account, "PASSWORD_RESET");
    });
    res.json({ data: { accepted: true } });
  },
);
app.use("/api/v1", async (req, res, next) => {
  try {
    const t = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!t) fail(401, "Please sign in");
    const r = await pool.query(
      "SELECT a.* FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND a.status='ACTIVE'",
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
app.post("/api/v1/auth/logout", async (req, res) => {
  await pool.query("UPDATE sessions SET revoked_at=now() WHERE token_hash=$1", [
    req.sessionHash,
  ]);
  res.json({ data: { loggedOut: true } });
});
app.post("/api/v1/me/password", rateLimit({ windowMs: 900000, limit: 10 }), async (req, res) => {
  const body = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(12).max(128) }).strict().parse(req.body);
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
  return { id: account.id, accountId: account.login_code || null, role: account.role, name: account.name, preferredShopId: preferred || null };
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
      if (req.account.role !== "WORKER") await assertShop(c, req.account, shop.id);
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
      if (req.account.role !== "WORKER") await assertShop(c, req.account, preferred.id);
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
  if (a.role === "SUPER_MANAGER") return true;
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
const scopeSql =
  "($1='SUPER_MANAGER' OR EXISTS(SELECT 1 FROM account_shops ac WHERE ac.shop_id=s.id AND ac.account_id=$2))";
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
  if (req.account.role !== "SUPER_MANAGER") fail(403, "Owner required");
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
      password: z.string().min(12).max(128),
    })
    .parse(req.body);
  const pw = await argon2.hash(b.password);
  const safe = { ...b, password: hash(b.password) };
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
app.get("/api/v1/manager/workers", async (req, res) => {
  const r = await pool.query(
    `SELECT w.id,a.id AS "accountId",a.login_code AS "workerId",a.name,a.email,a.status FROM workers w JOIN accounts a ON a.id=w.account_id ORDER BY a.name`,
  );
  res.json({ data: r.rows });
});
app.get("/api/v1/manager/managers", async (req, res) => {
  if (req.account.role !== "SUPER_MANAGER") fail(403, "Owner required");
  const r = await pool.query(
    "SELECT id AS \"accountId\",name,email,status FROM accounts WHERE role='MANAGER' ORDER BY name",
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
    "UPDATE email_jobs SET status='CANCELLED',encrypted_payload=NULL WHERE account_id=$1 AND status IN('QUEUED','FAILED')",
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
    if (isManager && req.account.role !== "SUPER_MANAGER")
      fail(403, "Only owner can add managers");
    const b = z
      .object({
        operationId: uuid,
        name: z.string().trim().min(1),
        email: z.email(),
        shopIds: z.array(z.string().regex(/^00\d{2}$/)).default([]),
        contact: z.string().optional(),
        address: z.string().optional(),
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
        let code = null;
        if (!isManager) {
          await c.query("SELECT pg_advisory_xact_lock(820013)");
          const codes = (
            await c.query("SELECT login_code FROM accounts WHERE role='WORKER'")
          ).rows.map((x) => x.login_code);
          const available = [];
          for (let i = 1000; i <= 9999; i++)
            if (!codes.includes(String(i))) available.push(String(i));
          if (!available.length) fail(409, "Worker IDs exhausted");
          code = available[randomInt(available.length)];
        }
        const a = (
          await c.query(
            "INSERT INTO accounts(role,login_code,email,name) VALUES($1,$2,$3,$4) RETURNING *",
            [
              isManager ? "MANAGER" : "WORKER",
              code,
              b.email.toLowerCase(),
              b.name,
            ],
          )
        ).rows[0];
        if (!isManager)
          await c.query(
            "INSERT INTO workers(account_id,contact,address) VALUES($1,$2,$3)",
            [a.id, b.contact || "", b.address || ""],
          );
        for (const s of shops)
          await c.query(
            "INSERT INTO account_shops(account_id,shop_id) VALUES($1,$2)",
            [a.id, s],
          );
        const invitationId = await invite(c, a);
        await audit(c, req.account, "ACCOUNT_CREATE", a.id);
        return {
          accountId: a.id,
          workerId: code,
          activationStatus: "PENDING",
          invitationId,
          emailStatus: "QUEUED",
        };
      }),
    );
    res.status(201).json({ data });
  },
);
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
        if (req.account.role !== "SUPER_MANAGER") {
          if (a.role !== "WORKER") fail(403, "Owner required");
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
    `SELECT e.id,e.account_id AS "accountId",a.name,e.status,e.last_error_code,e.created_at,p.expires_at,p.used_at FROM email_jobs e JOIN accounts a ON a.id=e.account_id JOIN password_links p ON p.id=e.password_link_id WHERE $1='SUPER_MANAGER' OR a.role='WORKER' ORDER BY e.created_at DESC LIMIT 100`,
    [req.account.role],
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
const filtered = `FROM attendance_records r JOIN workers w ON w.id=r.worker_id JOIN accounts wa ON wa.id=w.account_id JOIN shops s ON s.id=r.shop_id JOIN accounts sa ON sa.id=s.account_id WHERE ${scopeSql} AND r.effective_occurred_at >= $3 AND r.effective_occurred_at < $4 AND ($5::text IS NULL OR sa.login_code=$5) AND ($6::text IS NULL OR wa.login_code=$6)`;
async function records(req, c = pool) {
  const f = filters(req);
  return (
    await c.query(
      `SELECT r.*,wa.name AS worker_name,wa.login_code AS "workerId",s.name AS shop_name,sa.login_code AS "shopId",EXISTS(SELECT 1 FROM attendance_adjustments x WHERE x.record_id=r.id AND x.status='PENDING') AS pending ${filtered} AND ($1='SUPER_MANAGER' OR NOT r.effective_deleted) ORDER BY r.effective_occurred_at,r.id`,
      f,
    )
  ).rows;
}
async function summary(req, c = pool) {
  const f = filters(req);
  return (
    await c.query(
      `SELECT wa.login_code AS "workerId",wa.name AS worker_name,sa.login_code AS "shopId",s.name AS shop_name,COALESCE(sum(g.hrs) FILTER(WHERE g.status='CONFIRMED'),0)::numeric(12,2)::text AS "confirmedHrs",count(*) FILTER(WHERE g.status='PENDING')::int AS "pendingSegmentCount",count(*) FILTER(WHERE g.status='INVALID')::int AS "invalidSegmentCount" FROM work_segments g JOIN workers w ON w.id=g.worker_id JOIN accounts wa ON wa.id=w.account_id JOIN shops s ON s.id=g.shop_id JOIN accounts sa ON sa.id=s.account_id LEFT JOIN attendance_records rr ON rr.id=COALESCE(g.sign_in_record_id,g.sign_out_record_id) WHERE ${scopeSql} AND COALESCE(g.start_at,rr.effective_occurred_at)>=$3 AND COALESCE(g.start_at,rr.effective_occurred_at)<$4 AND ($5::text IS NULL OR sa.login_code=$5) AND ($6::text IS NULL OR wa.login_code=$6) GROUP BY wa.login_code,wa.name,sa.login_code,s.name ORDER BY wa.name`,
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
    } else await assertShop(pool, req.account, r.shop_id);
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
      `SELECT g.id,g.issue_code,g.sign_in_record_id,g.sign_out_record_id,r.version,wa.name AS worker_name,s.name AS shop_name,'RECORD_ERROR' AS item_type ${filtered.replace("FROM attendance_records r", "FROM work_segments g JOIN attendance_records r ON r.id=COALESCE(g.sign_in_record_id,g.sign_out_record_id)")} AND g.status='INVALID'`,
      f,
    )
  ).rows;
  res.json({ data: [...adjustments, ...issues] });
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
        const j = (
          await c.query(
            "SELECT * FROM attendance_adjustments WHERE id=$1 FOR UPDATE",
            [req.params.id],
          )
        ).rows[0];
        if (!j) fail(404, "Adjustment missing");
        const r = (
          await c.query(
            "SELECT * FROM attendance_records WHERE id=$1 FOR UPDATE",
            [j.record_id],
          )
        ).rows[0];
        await assertShop(c, req.account, r.shop_id);
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
            : j.action === "ADD"
              ? true
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
          "UPDATE attendance_records SET confirmed_occurred_at=$1,effective_occurred_at=COALESCE($1,original_occurred_at),confirmed_deleted=$2,effective_deleted=$2,version=version+1 WHERE id=$3",
          [t, deleted, r.id],
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
    })
    .parse(req.body);
  req.body = { operationId: b.operationId, action: "UPDATE", recordId: req.params.id,
    expectedVersion: b.expectedRecordVersion, occurredAt: b.occurredAt };
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
      if (!w || !s) fail(422, "Unknown worker or shop");
      if (req.account.role === "WORKER") {
        if (w.account_id !== req.account.id)
          fail(403, "Cannot sign for another worker");
      } else await assertShop(c, req.account, s.id);
      if (b.expectedDailyCount !== undefined) {
        const day = localDate(b.occurredAt);
        const count = await dailyAttendanceCount(c, w.id, s.id, day);
        if (day !== localDate(new Date()) || count !== b.expectedDailyCount ||
            b.type !== (count % 2 === 0 ? "SIGN_IN" : "SIGN_OUT"))
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
      const late =
        first &&
        b.type === "SIGN_IN" &&
        new Date(b.occurredAt) > new Date(b.plannedStartAt);
      const formal =
        first && b.type === "SIGN_IN" && !late
          ? b.plannedStartAt
          : b.occurredAt;
      const effective = late ? b.plannedStartAt : b.occurredAt;
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
            formal,
            b.offline,
            b.cameraStatus,
            b.photoId || null,
            position,
          ],
        )
      ).rows[0];
      if (late)
        await c.query(
          "INSERT INTO attendance_adjustments(record_id,actor_account_id,source,action,before_at,after_at,base_version) VALUES($1,$2,'PLANNED_START','UPDATE',$3,$4,1)",
          [r.id, req.account.id, b.occurredAt, b.plannedStartAt],
        );
      await rebuild(c, w.id);
      return {
        recordId: r.id,
        shopId: b.shopId, shopName: s.name, occurredAt: r.original_occurred_at, type: r.sign_type,
        dailyCount: await dailyAttendanceCount(c, w.id, s.id, day),
        syncStatus: "SYNCED",
        validationStatus: late ? "PENDING" : "CONFIRMED",
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
  for (const shopId of data.snapshot.scopeIds)
    await assertShop(pool, req.account, shopId);
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
async function appScope(req, c, shopCode, workerCode) {
  const w = (
    await c.query(
      "SELECT w.*,a.login_code FROM workers w JOIN accounts a ON a.id=w.account_id WHERE a.login_code=$1",
      [workerCode],
    )
  ).rows[0];
  const s = (
    await c.query(
      "SELECT s.* FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=$1",
      [shopCode],
    )
  ).rows[0];
  if (!w || !s) fail(422, "Unknown worker or shop");
  if (req.account.role === "WORKER") {
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
      serverTime: new Date().toISOString(),
      dailyCount: count,
      nextAction: count % 2 === 0 ? "SIGN_IN" : "SIGN_OUT",
      requiresPlannedStart: !any,
      latestRecordId: r?.id || null,
    },
  });
});
app.get("/api/v1/attendance", async (req, res) => {
  const { w, s } = await appScope(
    req,
    pool,
    req.query.shopId,
    req.query.workerId || req.account.login_code,
  );
  const range = z
    .object({ fromDate: z.iso.date(), toDate: z.iso.date() })
    .parse(req.query);
  if (
    range.fromDate > range.toDate ||
    new Date(range.toDate) - new Date(range.fromDate) > 30 * 86400000
  )
    fail(422, "Date range must be within 31 days");
  const r = await pool.query(
    "SELECT r.*,EXISTS(SELECT 1 FROM attendance_adjustments x WHERE x.record_id=r.id AND x.status='PENDING') AS pending FROM attendance_records r WHERE worker_id=$1 AND shop_id=$2 AND NOT effective_deleted AND (effective_occurred_at AT TIME ZONE $3)::date BETWEEN $4::date AND $5::date ORDER BY effective_occurred_at,id",
    [w.id, s.id, zone, range.fromDate, range.toDate],
  );
  res.json({ data: { items: r.rows } });
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
  const managerRequest = req.path.includes("/manager/");
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
        if (managerRequest) {
          w = (await c.query("SELECT w.* FROM workers w JOIN accounts a ON a.id=w.account_id WHERE a.login_code=$1 AND a.status='ACTIVE'", [b.workerId])).rows[0];
          s = (await c.query("SELECT s.* FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=$1", [b.shopId])).rows[0];
          if (!w || !s) fail(422, "Active employee and store required");
          await assertShop(c, req.account, s.id);
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
        if (managerRequest) await assertShop(c, req.account, r.shop_id);
        else await appScope(req, c, r.shop_code, r.worker_code);
        if (r.effective_deleted) fail(409, "Record is already marked for removal");
        if (r.version !== b.expectedVersion) fail(409, "Record changed");
        if (b.action === "UPDATE" && !b.occurredAt) fail(422, "Time required");
      }
      if (
        (
          await c.query(
            "SELECT 1 FROM attendance_adjustments WHERE record_id=$1 AND status='PENDING'",
            [r.id],
          )
        ).rowCount
      )
        fail(409, "Resolve pending change before another adjustment");
      const after = b.action === "DELETE" ? null : b.occurredAt;
      const j = (
        await c.query(
          "INSERT INTO attendance_adjustments(record_id,actor_account_id,source,action,before_at,after_at,base_version) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
          [
            r.id,
            req.account.id,
            managerRequest ? "MANAGER_EDIT" : "WORKER_EDIT",
            b.action,
            b.action === "ADD" ? null : r.effective_occurred_at,
            after,
            r.version,
          ],
        )
      ).rows[0];
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
function localPhotoPath(key) {
  if (!/^local:photos\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(jpeg|png|webp)$/.test(key))
    fail(422, "Invalid photo storage key");
  const directory = process.env.PHOTO_LOCAL_DIR || fileURLToPath(new URL("../data/photos/", import.meta.url));
  return path.resolve(directory, key.slice("local:photos/".length));
}
async function readablePhoto(req) {
  uuid.parse(req.params.id);
  const r = (
    await pool.query(
      "SELECT p.*,r.shop_id,w.account_id AS worker_account FROM photos p LEFT JOIN attendance_records r ON r.photo_id=p.id LEFT JOIN workers w ON w.id=r.worker_id WHERE p.id=$1",
      [req.params.id],
    )
  ).rows[0];
  if (!r || r.status !== "READY") fail(404, "Photo unavailable");
  if (r.shop_id) {
    if (req.account.role === "WORKER") {
      if (r.worker_account !== req.account.id) fail(403, "Forbidden");
    } else await assertShop(pool, req.account, r.shop_id);
  } else if (r.uploaded_by_account_id !== req.account.id)
    fail(403, "Forbidden");
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
