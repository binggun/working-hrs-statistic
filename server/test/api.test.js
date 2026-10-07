import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createDecipheriv } from "node:crypto";
import argon2 from "argon2";
import { app } from "../src/app.js";
import { pool } from "../src/db.js";
const enabled = !!process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL workflow: invitations, attendance, approval, scope, PDF and original preservation",
  { skip: !enabled },
  async () => {
    assert.ok(
      new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test"),
      "Use a disposable database ending _test",
    );
    await pool.query("TRUNCATE accounts CASCADE");
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    let ownerToken;
    const run = randomUUID().slice(0, 8);
    const password = "test-password-" + run;
    let shopCode, workerCode, managerId;
    const post = async (path, body, t = ownerToken) => {
      const response = await fetch(base + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(t ? { Authorization: "Bearer " + t } : {}),
        },
        body: JSON.stringify(body),
      });
      const type = response.headers.get("content-type");
      return {
        status: response.status,
        data: type?.includes("json")
          ? await response.json()
          : Buffer.from(await response.arrayBuffer()),
      };
    };
    const get = async (path, t = ownerToken) => {
      const response = await fetch(base + path, {
        headers: { Authorization: "Bearer " + t },
      });
      return { status: response.status, data: await response.json() };
    };
    try {
      const pw = await argon2.hash(password);
      const owner = (
        await pool.query(
          "INSERT INTO accounts(role,email,password_hash,status,name) VALUES('SUPER_MANAGER',$1,$2,'ACTIVE','Test Owner') RETURNING id",
          [`${run}@test.invalid`, pw],
        )
      ).rows[0];
      const login = await post(
        "/manager/auth/login",
        { email: `${run}@test.invalid`, password },
        null,
      );
      assert.equal(login.status, 200);
      ownerToken = login.data.data.sessionToken;
      const used = (
        await pool.query("SELECT login_code FROM accounts WHERE role='SHOP'")
      ).rows.map((r) => r.login_code);
      shopCode = Array.from({ length: 99 }, (_, i) =>
        String(i + 1).padStart(4, "0"),
      ).find((x) => !used.includes(x));
      const shop = await post("/manager/shops", {
        operationId: randomUUID(),
        shopId: shopCode,
        name: "Test shop",
        address: "Test address",
        latitude: -36.85,
        longitude: 174.76,
        password,
      });
      assert.equal(shop.status, 201);
      const create = await post("/manager/workers", {
        operationId: randomUUID(),
        name: "Test groomer",
        email: `worker-${run}@test.invalid`,
        shopIds: [shopCode],
      });
      assert.equal(create.status, 201);
      workerCode = create.data.data.workerId;
      const accountId = create.data.data.accountId;
      await pool.query(
        "UPDATE accounts SET status='ACTIVE',password_hash=$1 WHERE id=$2",
        [pw, accountId],
      );
      const appLogin = await post(
        "/auth/login",
        { accountId: shopCode, password },
        null,
      );
      const appToken = appLogin.data.data.sessionToken;
      assert.ok(appToken);
      const signBody = {
        operationId: randomUUID(),
        workerId: workerCode,
        shopId: shopCode,
        type: "SIGN_IN",
        occurredAt: "2026-10-07T09:10:00+13:00",
        plannedStartAt: "2026-10-07T09:00:00+13:00",
        offline: false,
        cameraStatus: "UNAVAILABLE",
      };
      const sign = await post("/attendance", signBody, appToken);
      assert.equal(sign.status, 201);
      const replay = await post("/attendance", signBody, appToken);
      assert.deepEqual(replay.data, sign.data);
      const changed = await post(
        "/attendance",
        { ...signBody, occurredAt: "2026-10-07T09:11:00+13:00" },
        appToken,
      );
      assert.equal(changed.status, 409);
      assert.equal(
        (
          await post(
            "/attendance",
            {
              operationId: randomUUID(),
              workerId: workerCode,
              shopId: shopCode,
              type: "SIGN_OUT",
              occurredAt: "2026-10-07T17:00:00+13:00",
              offline: false,
              cameraStatus: "UNAVAILABLE",
            },
            appToken,
          )
        ).status,
        201,
      );
      const queue = await get(
        "/manager/validations?month=2026-10&shopId=" + shopCode,
      );
      const j = queue.data.data.find((r) => r.item_type === "ADJUSTMENT");
      assert.ok(j);
      const approval = await post(
        "/manager/validations/" + j.id + "/decision",
        {
          operationId: randomUUID(),
          decision: "APPROVE",
          expectedRecordVersion: j.version,
        },
      );
      assert.equal(approval.status, 200);
      const totals = await get(
        "/manager/attendance/summary?month=2026-10&shopId=" + shopCode,
      );
      assert.equal(totals.data.data.groups[0].confirmedHrs, "8.00");
      const pdf = await post("/manager/reports/pdf", {
        operationId: randomUUID(),
        month: "2026-10",
        shopId: shopCode,
        reportType: "TIMESHEET",
      });
      assert.equal(pdf.status, 200);
      assert.equal(pdf.data.subarray(0, 4).toString(), "%PDF");
      const correction = await post(
        "/manager/attendance/" + sign.data.data.recordId + "/corrections",
        {
          operationId: randomUUID(),
          expectedRecordVersion: 2,
          occurredAt: "2026-10-07T09:30:00+13:00",
        },
      );
      assert.equal(correction.status, 200);
      const h = await get(
        "/manager/attendance/" + sign.data.data.recordId + "/history",
      );
      assert.equal(
        new Date(h.data.data.record.original_occurred_at).toISOString(),
        "2026-10-06T20:10:00.000Z",
      );
      assert.equal(h.data.data.history.length, 2);
      const manager = (
        await pool.query(
          "INSERT INTO accounts(role,email,password_hash,status,name) VALUES('MANAGER',$1,$2,'ACTIVE','No access') RETURNING id",
          [`manager-${run}@test.invalid`, pw],
        )
      ).rows[0];
      managerId = manager.id;
      const ml = await post(
        "/manager/auth/login",
        { email: `manager-${run}@test.invalid`, password },
        null,
      );
      assert.equal(
        (
          await get(
            "/manager/attendance/" + sign.data.data.recordId + "/history",
            ml.data.data.sessionToken,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await post(
            "/manager/managers",
            {
              operationId: randomUUID(),
              name: "Forbidden",
              email: "forbidden@test.invalid",
              shopIds: [shopCode],
            },
            ml.data.data.sessionToken,
          )
        ).status,
        403,
      );
      const overnight = await post(
        "/attendance",
        {
          operationId: randomUUID(),
          workerId: workerCode,
          shopId: shopCode,
          type: "SIGN_IN",
          occurredAt: "2026-10-08T20:00:00+13:00",
          plannedStartAt: "2026-10-08T20:00:00+13:00",
          offline: true,
          cameraStatus: "UNAVAILABLE",
        },
        appToken,
      );
      assert.equal(overnight.status, 201);
      await post(
        "/attendance",
        {
          operationId: randomUUID(),
          workerId: workerCode,
          shopId: shopCode,
          type: "SIGN_OUT",
          occurredAt: "2026-10-09T00:05:00+13:00",
          offline: true,
          cameraStatus: "UNAVAILABLE",
        },
        appToken,
      );
      const errors = await get(
        "/manager/validations?month=2026-10&shopId=" + shopCode,
      );
      assert.ok(
        errors.data.data.some((r) => r.issue_code === "CROSS_MIDNIGHT"),
      );

      const inviteAccount = await post("/manager/workers", {
        operationId: randomUUID(),
        name: "Invitation test",
        email: `invite-${run}@test.invalid`,
        shopIds: [shopCode],
      });
      assert.equal(inviteAccount.status, 201);
      const ej = (
        await pool.query(
          "SELECT encrypted_payload FROM email_jobs WHERE account_id=$1",
          [inviteAccount.data.data.accountId],
        )
      ).rows[0];
      const [iv, tag, enc] = ej.encrypted_payload
        .split(".")
        .map((x) => Buffer.from(x, "base64"));
      const decipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(process.env.MAIL_ENCRYPTION_KEY, "hex"),
        iv,
      );
      decipher.setAuthTag(tag);
      const invitation = JSON.parse(
        Buffer.concat([decipher.update(enc), decipher.final()]).toString(),
      );
      assert.equal(
        (
          await post(
            "/auth/password-links/consume",
            { token: invitation.token, newPassword: password },
            null,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await post(
            "/auth/password-links/consume",
            { token: invitation.token, newPassword: password },
            null,
          )
        ).status,
        422,
      );
      const late2 = await post(
        "/attendance",
        {
          operationId: randomUUID(),
          workerId: workerCode,
          shopId: shopCode,
          type: "SIGN_IN",
          occurredAt: "2026-10-10T09:10:00+13:00",
          plannedStartAt: "2026-10-10T09:00:00+13:00",
          offline: true,
          cameraStatus: "UNAVAILABLE",
        },
        appToken,
      );
      assert.equal(late2.status, 201);
      await post(
        "/attendance",
        {
          operationId: randomUUID(),
          workerId: workerCode,
          shopId: shopCode,
          type: "SIGN_OUT",
          occurredAt: "2026-10-10T17:00:00+13:00",
          offline: true,
          cameraStatus: "UNAVAILABLE",
        },
        appToken,
      );
      const q2 = await get(
        "/manager/validations?month=2026-10&shopId=" + shopCode,
      );
      const j2 = q2.data.data.find(
        (x) => x.record_id === late2.data.data.recordId,
      );
      assert.equal(
        (
          await post("/manager/validations/" + j2.id + "/decision", {
            operationId: randomUUID(),
            decision: "REJECT",
            expectedRecordVersion: j2.version,
          })
        ).status,
        200,
      );
      const h2 = await get(
        "/manager/attendance/" + late2.data.data.recordId + "/history",
      );
      assert.equal(
        new Date(h2.data.data.record.confirmed_occurred_at).toISOString(),
        "2026-10-09T20:10:00.000Z",
      );
      const used2 = (
        await pool.query("SELECT login_code FROM accounts WHERE role='SHOP'")
      ).rows.map((r) => r.login_code);
      const code2 = Array.from({ length: 99 }, (_, i) =>
        String(i + 1).padStart(4, "0"),
      ).find((x) => !used2.includes(x));
      await post("/manager/shops", {
        operationId: randomUUID(),
        shopId: code2,
        name: "Other shop",
        address: "Test",
        latitude: -36.85,
        longitude: 174.76,
        password,
      });
      const token2 = (
        await post("/auth/login", { accountId: code2, password }, null)
      ).data.data.sessionToken;
      await post(
        "/attendance",
        {
          operationId: randomUUID(),
          workerId: workerCode,
          shopId: shopCode,
          type: "SIGN_IN",
          occurredAt: "2026-10-11T09:00:00+13:00",
          plannedStartAt: "2026-10-11T09:00:00+13:00",
          offline: true,
          cameraStatus: "UNAVAILABLE",
        },
        appToken,
      );
      await post(
        "/attendance",
        {
          operationId: randomUUID(),
          workerId: workerCode,
          shopId: code2,
          type: "SIGN_OUT",
          occurredAt: "2026-10-11T17:00:00+13:00",
          offline: true,
          cameraStatus: "UNAVAILABLE",
        },
        token2,
      );
      const ownQueue = await get(
        "/manager/validations?month=2026-10&shopId=" + shopCode,
      );
      const otherQueue = await get(
        "/manager/validations?month=2026-10&shopId=" + code2,
      );
      assert.ok(
        ownQueue.data.data.some((r) => r.issue_code === "MISSING_SIGN_OUT"),
      );
      assert.ok(
        otherQueue.data.data.some((r) => r.issue_code === "MISSING_SIGN_IN"),
      );
      assert.equal(
        (await get("/manager/attendance/summary?month=2026-10&shopId=" + code2))
          .data.data.groups[0].confirmedHrs,
        "0.00",
      );
    } finally {
      await new Promise((r) => server.close(r));
      await pool.end();
    }
  },
);
