import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createDecipheriv } from "node:crypto";
import argon2 from "argon2";
import sharp from "sharp";
import { DateTime } from "luxon";
import { access } from "node:fs/promises";
import { processPhotoRetention } from "../src/photo-retention.js";
import { localPhotoPath } from "../src/photo-storage.js";
import { app, apiLimiter } from "../src/app.js";
import { pool } from "../src/db.js";
import { processMail } from "../src/mail.js";
import { processAttendanceExports } from "../src/attendance-export.js";
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
    const password = "abcdef";
    let shopCode, workerCode, managerId, generalId, generalToken;
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
      generalId = (await pool.query("INSERT INTO accounts(role,email,password_hash,status,name) VALUES('GENERAL_MANAGER',$1,$2,'ACTIVE','General manager') RETURNING id", [`general-${run}@test.invalid`, pw])).rows[0].id;
      generalToken = (await post("/manager/auth/login", { email: `general-${run}@test.invalid`, password }, null)).data.data.sessionToken;
      await pool.query("UPDATE accounts SET login_code='9999' WHERE id=$1",[generalId]);
      await assert.rejects(pool.query("UPDATE accounts SET login_code='0010' WHERE id=$1",[generalId]), e=>e.code === "23514");
      for (const path of ["/auth/login","/manager/auth/login"]) {
        const numberedGmLogin = await post(path,{accountId:"9999",password},null);
        assert.equal(numberedGmLogin.status,200);
        assert.equal(numberedGmLogin.data.data.account.accountId,"9999");
        assert.equal(numberedGmLogin.data.data.account.role,"GENERAL_MANAGER");
      }


      // Accounts can be invited before any shops exist, with empty or omitted assignments.
      for (const kind of ["workers", "managers"]) {
        for (const assignments of [{ shopIds: [] }, {}]) {
          const unassigned = await post(`/manager/${kind}`, {
            operationId: randomUUID(),
            name: "Unassigned account",
            email: `${kind}-${randomUUID()}@test.invalid`,
            ...assignments,
          });
          assert.equal(unassigned.status, 201);
          assert.equal(unassigned.data.data.activationStatus, "PENDING");
          const links = await pool.query(
            "SELECT * FROM account_shops WHERE account_id=$1",
            [unassigned.data.data.accountId],
          );
          assert.equal(links.rowCount, 0);
          const invitations = await pool.query(
            "SELECT status FROM email_jobs WHERE account_id=$1",
            [unassigned.data.data.accountId],
          );
          assert.equal(invitations.rows[0].status, "QUEUED");
        }
      }
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
      const workerLinks = await pool.query(
        "SELECT * FROM account_shops WHERE account_id=$1",
        [create.data.data.accountId],
      );
      assert.equal(workerLinks.rowCount, 0, "Legacy shopIds must not link workers to shops");
      const people = await get("/manager/workers");
      assert.ok(people.data.data.some((person) => person.accountId === create.data.data.accountId));
      workerCode = create.data.data.workerId;
      const accountId = create.data.data.accountId;
      await pool.query(
        "UPDATE accounts SET status='ACTIVE',password_hash=$1 WHERE id=$2",
        [pw, accountId],
      );
      const appLogin = await post(
        "/auth/login",
        { accountId: shopCode, password: "123456" },
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
      assert.equal(sign.data.data.validationStatus, "SUBMITTED");
      assert.equal((await pool.query("SELECT count(*) FROM attendance_adjustments WHERE record_id=$1", [sign.data.data.recordId])).rows[0].count, "0");
      assert.equal((await post("/attendance-adjustments", { operationId: randomUUID(), action: "UPDATE", recordId: sign.data.data.recordId,
        expectedVersion: 1, occurredAt: signBody.plannedStartAt }, appToken)).status, 201);

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
          expectedRecordVersion: 3,
          occurredAt: "2026-10-07T09:30:00+13:00",
        },
      );
      assert.equal(correction.status, 200);
      assert.equal(correction.data.data.validationStatus, "APPROVED");
      const corrected = (await pool.query("SELECT * FROM attendance_records WHERE id=$1", [sign.data.data.recordId])).rows[0];
      assert.equal(new Date(corrected.confirmed_occurred_at).toISOString(), "2026-10-06T20:30:00.000Z");
      assert.equal((await pool.query("SELECT count(*) FROM attendance_validations WHERE adjustment_id=$1", [correction.data.data.adjustmentId])).rows[0].count, "1");
      const confirmedLocation=await get("/manager/attendance/locations?fromDate=2026-10-07&toDate=2026-10-07");
      assert.equal(confirmedLocation.status,200);
      assert.equal(confirmedLocation.data.data.items.find(r=>r.id===corrected.id).confirmedTime,"2026-10-06T20:30:00.000Z");


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
      const sharedPeople = await get("/manager/workers", ml.data.data.sessionToken);
      assert.equal(sharedPeople.status, 200);
      assert.equal(sharedPeople.data.data.length, 0);
      const sharedInvitations = await get("/manager/invitations", ml.data.data.sessionToken);
      assert.equal(sharedInvitations.status, 200);
      assert.equal(sharedInvitations.data.data.length, 0);
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
      await post("/attendance-adjustments", { operationId: randomUUID(), action: "UPDATE", recordId: late2.data.data.recordId,
        expectedVersion: 1, occurredAt: "2026-10-10T09:00:00+13:00" }, appToken);

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
        await post("/auth/login", { accountId: code2, password: "123456" }, null)
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
      // Employee website uses the same credentials and scoped app endpoints.
      const employeeLogin = await post("/auth/login", { accountId: workerCode, password }, null);
      assert.equal(employeeLogin.status, 200);
      const employeeToken = employeeLogin.data.data.sessionToken;
      const employeeEmail = (await pool.query("SELECT email FROM accounts WHERE id=$1", [accountId])).rows[0].email;
      const emailLogin = await post("/auth/login", { email: employeeEmail.toUpperCase(), password }, null);
      assert.equal(emailLogin.status, 200);
      assert.equal(emailLogin.data.data.account.id, accountId);
      assert.equal(emailLogin.data.data.account.role, "WORKER");
      assert.equal((await get("/manager/workers", emailLogin.data.data.sessionToken)).status, 403);
      assert.equal((await post("/auth/login", { email: employeeEmail, password: "incorrect" }, null)).status, 401);
      assert.equal((await post("/auth/login", { email: employeeEmail, accountId: workerCode, password }, null)).status, 422);
      assert.equal((await post("/auth/login", { email: `${run}@test.invalid`, password }, null)).status, 200);
      const ambiguousManager = (await pool.query(
        "INSERT INTO accounts(role,email,password_hash,status,name) VALUES('MANAGER',$1,$2,'ACTIVE','Same email manager') RETURNING id",
        [employeeEmail, pw])).rows[0];
      const ambiguousLogin = await post("/auth/login", { email: employeeEmail, password }, null);
      assert.equal(ambiguousLogin.status, 422);
      assert.equal(ambiguousLogin.data.error.code, "AMBIGUOUS_ACCOUNT");
      assert.equal((await post("/auth/login", { accountId: workerCode, password }, null)).status, 200);
      await pool.query("UPDATE accounts SET status='DISABLED' WHERE id=$1", [ambiguousManager.id]);

      assert.equal(employeeLogin.data.data.account.preferredShopId, null);
      assert.equal(employeeLogin.data.data.account.accountId, workerCode);
      assert.equal((await post("/me/preferences", { preferredShopId: shopCode }, employeeToken)).status, 200);
      assert.equal((await get("/me", employeeToken)).data.data.preferredShopId, shopCode);
      const preferredLogin = await post("/auth/login", { accountId: workerCode, password }, null);
      assert.equal(preferredLogin.data.data.account.preferredShopId, shopCode);
      assert.equal((await post("/me/preferences", { preferredShopId: "9999" }, employeeToken)).status, 422);
      assert.equal((await post("/me/preferences", { preferredShopId: shopCode }, ml.data.data.sessionToken)).status, 200);
      assert.equal((await post("/me/preferences", { preferredShopId: null }, employeeToken)).status, 200);
      assert.equal((await get("/me", employeeToken)).data.data.preferredShopId, null);

      assert.equal((await get("/me", employeeToken)).data.data.role, "WORKER");
      assert.equal((await get("/manager/workers", employeeToken)).status, 403);
      assert.equal((await get("/shops", employeeToken)).status, 200);
      const employeeQuery = `/attendance?shopId=${shopCode}&fromDate=2026-10-01&toDate=2026-10-31`;
      const ownRecords = await get(employeeQuery, employeeToken);
      assert.equal(ownRecords.status, 200);
      const editable = ownRecords.data.data.items.find((r) => r.id === late2.data.data.recordId);
      assert.ok(editable);
      assert.equal(editable.pending, false);
      const updateBody = { operationId: randomUUID(), action: "UPDATE", recordId: editable.id,
        expectedVersion: editable.version, occurredAt: "2026-10-07T09:45:00+13:00" };
      const employeeUpdate = await post("/attendance-adjustments", updateBody, employeeToken);
      assert.equal(employeeUpdate.status, 201);
      assert.equal(employeeUpdate.data.data.validationStatus, "PENDING");
      const afterEdit = (await get(employeeQuery, employeeToken)).data.data.items.find((r) => r.id === editable.id);
      assert.equal(afterEdit.pending, true);
      assert.equal(afterEdit.original_occurred_at, editable.original_occurred_at);
      assert.equal(afterEdit.confirmed_occurred_at, editable.confirmed_occurred_at);
      assert.equal(new Date(afterEdit.effective_occurred_at).toISOString(), "2026-10-06T20:45:00.000Z");
      assert.equal((await post("/attendance-adjustments", { ...updateBody, operationId: randomUUID(),
        expectedVersion: afterEdit.version }, employeeToken)).status, 201);
      // Real mobile flow: same-day parity, local photo upload and idempotent submission.
      const statusPath = `/attendance/status?shopId=${shopCode}`;
      const initialStatus = await get(statusPath, employeeToken);
      assert.equal(initialStatus.status, 200);
      assert.equal(initialStatus.data.data.dailyCount, 0);
      assert.equal("nextAction" in initialStatus.data.data, false);
      const currentDay = initialStatus.data.data.localDate;
      const clockInAt = DateTime.fromISO(currentDay, { zone: "Pacific/Auckland" }).set({ hour: 9 }).toISO();
      let photoId;
      if (process.env.PHOTO_STORAGE === "local") {
        const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#98b72e" } }).jpeg().toBuffer();
        const photoOperation = randomUUID();
        const upload = async () => {
          const form = new FormData();
          form.set("operationId", photoOperation);
          form.set("file", new Blob([jpeg], { type: "image/jpeg" }), "selfie.jpg");
          const response = await fetch(base + "/photos", { method: "POST", headers: { Authorization: "Bearer " + employeeToken }, body: form });
          return { status: response.status, data: await response.json() };
        };
        const photo = await upload();
        assert.equal(photo.status, 201);
        photoId = photo.data.data.photoId;
        assert.equal((await upload()).data.data.photoId, photoId, "Photo retry returns the original photo ID");
        const file = await fetch(base + `/photos/${photoId}/file`, { headers: { Authorization: "Bearer " + employeeToken } });
        assert.equal(file.status, 200);
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), jpeg);
        assert.equal((await fetch(base + `/photos/${photoId}/file`)).status, 401);
      }
      const todaySign = { operationId: randomUUID(), workerId: workerCode, shopId: shopCode,
        type: "SIGN_IN", occurredAt: clockInAt, plannedStartAt: clockInAt, expectedDailyCount: 0,
        offline: false, cameraStatus: photoId ? "AVAILABLE" : "UNAVAILABLE", ...(photoId ? { photoId } : {}),
        location: { status: "AVAILABLE", latitude: -36.85, longitude: 174.76, accuracyMeters: 8, capturedAt: clockInAt } };
      assert.equal((await post("/attendance", { ...todaySign, location: { status: "AVAILABLE", latitude: 91, longitude: 174.76 } }, employeeToken)).status, 422);
      const posted = await post("/attendance", todaySign, employeeToken);
      assert.equal(posted.status, 201);
      assert.equal(posted.data.data.shopId, shopCode);
      assert.equal(posted.data.data.shopName, "Test shop");
      assert.equal(posted.data.data.type, "SIGN_IN");
      assert.equal(posted.data.data.dailyCount, 1);
      assert.equal(new Date(posted.data.data.occurredAt).toISOString(), new Date(clockInAt).toISOString());
      const savedSign = (await pool.query("SELECT r.*,w.account_id FROM attendance_records r JOIN workers w ON w.id=r.worker_id WHERE r.id=$1", [posted.data.data.recordId])).rows[0];
      assert.equal(savedSign.account_id, accountId);
      assert.equal(savedSign.submitted_by_account_id, accountId);
      assert.equal(savedSign.photo_id, photoId || null);
      assert.equal(savedSign.location.latitude, -36.85);
      assert.equal(savedSign.location.longitude, 174.76);
      assert.equal(savedSign.location.accuracyMeters, 8);
      assert.equal(savedSign.location.capturedAt, clockInAt);
      assert.equal(savedSign.location.status, "IN_RANGE");
      assert.equal(savedSign.location.distanceMeters, 0);
      assert.equal(new Date(savedSign.original_occurred_at).toISOString(), new Date(clockInAt).toISOString());

      assert.deepEqual((await post("/attendance", todaySign, employeeToken)).data, posted.data);
      const afterClockIn = (await get(statusPath, employeeToken)).data.data;
      assert.equal(afterClockIn.dailyCount, 1);
      assert.equal((await post("/attendance", { ...todaySign, operationId: randomUUID() }, employeeToken)).status, 409);
      const clockOut = { operationId: randomUUID(), workerId: workerCode, shopId: shopCode, type: "SIGN_OUT",
        occurredAt: DateTime.fromISO(clockInAt).plus({ hours: 8 }).toISO(), expectedDailyCount: 1,
        offline: false, cameraStatus: "UNAVAILABLE",
        location: { status: "UNAVAILABLE" } };
      const simultaneous = await Promise.all([post("/attendance", clockOut, employeeToken),
        post("/attendance", { ...clockOut, operationId: randomUUID() }, employeeToken)]);
      assert.deepEqual(simultaneous.map((result) => result.status).sort(), [201, 409]);
      const afterClockOut = (await get(statusPath, employeeToken)).data.data;
      assert.equal(afterClockOut.dailyCount, 2);
      const outRecord = (await pool.query("SELECT location FROM attendance_records WHERE worker_id=$1 AND original_occurred_at=$2", [savedSign.worker_id, clockOut.occurredAt])).rows[0];
      assert.equal(outRecord.location.status, "UNAVAILABLE");
      assert.equal(outRecord.location.latitude, undefined);
      assert.equal(outRecord.location.longitude, undefined);
      const outOfRangeSign = { ...clockOut, operationId: randomUUID(), type: "SIGN_IN", expectedDailyCount: 2,
        occurredAt: DateTime.fromISO(clockOut.occurredAt).plus({ hours: 1 }).toISO(),
        location: { status: "AVAILABLE", latitude: -37, longitude: 175 } };
      const outOfRangeResponse = await post("/attendance", outOfRangeSign, employeeToken);
      assert.equal(outOfRangeResponse.status, 201);
      const outOfRangeRecord = (await pool.query("SELECT location FROM attendance_records WHERE id=$1", [outOfRangeResponse.data.data.recordId])).rows[0];
      assert.equal(outOfRangeRecord.location.status, "OUT_OF_RANGE");
      assert.ok(outOfRangeRecord.location.distanceMeters > 500);
      const gpsPath=`/manager/attendance/locations?fromDate=${currentDay}&toDate=${currentDay}`;
      const gpsOwner=await get(gpsPath);
      assert.equal(gpsOwner.status,200);
      assert(gpsOwner.data.data.items.some(r=>r.id===savedSign.id&&r.distanceMeters===0));
      assert.equal(gpsOwner.data.data.items.find(r=>r.id===savedSign.id).photoId,photoId || null);
      assert.equal(gpsOwner.data.data.items.find(r=>r.id===savedSign.id).confirmedTime,null);
      assert(gpsOwner.data.data.items.some(r=>r.id===outOfRangeResponse.data.data.recordId&&r.distanceMeters>500));
      assert(gpsOwner.data.data.items.every(r=>(r.latitude===null&&r.longitude===null&&r.distanceMeters===null)||(Number.isFinite(r.latitude)&&Number.isFinite(r.longitude))));
      assert.equal((await get(gpsPath,generalToken)).status,200);
      assert.equal((await get(gpsPath,ml.data.data.sessionToken)).status,403);
      assert.equal((await get(gpsPath,employeeToken)).status,403);
      const gpsSelected=await get(gpsPath+`&workerIds=${workerCode}&shopIds=${shopCode}`);
      assert.equal(gpsSelected.status,200);
      assert(gpsSelected.data.data.items.every(r=>r.workerId===savedSign.worker_id));
      const withoutGps=gpsSelected.data.data.items.find(r=>r.originalTime===new Date(clockOut.occurredAt).toISOString());
      assert(withoutGps);
      assert.equal(withoutGps.latitude,null);
      assert.equal(withoutGps.longitude,null);
      assert.equal(withoutGps.distanceMeters,null);
      assert.equal(withoutGps.photoId,null);

      const noLocationBody = { ...clockOut, operationId: randomUUID(), expectedDailyCount: 3,
        occurredAt: DateTime.fromISO(clockOut.occurredAt).plus({ hours: 2 }).toISO() };
      delete noLocationBody.location;
      const noLocationResponse = await post("/attendance", noLocationBody, employeeToken);
      assert.equal(noLocationResponse.status, 201);
      const noLocationRecord = (await pool.query("SELECT location FROM attendance_records WHERE id=$1", [noLocationResponse.data.data.recordId])).rows[0];
      assert.deepEqual(noLocationRecord.location, { status: "UNAVAILABLE" });
      // The user selects the type; parity no longer dictates clock-in or clock-out.
      const consecutiveOut = { ...noLocationBody, operationId: randomUUID(), expectedDailyCount: 4,
        occurredAt: DateTime.fromISO(noLocationBody.occurredAt).plus({ minutes: 1 }).toISO() };
      const manualOut = await post("/attendance", consecutiveOut, employeeToken);
      assert.equal(manualOut.status, 201);
      assert.equal(manualOut.data.data.type, "SIGN_OUT");
      const manualIn = { ...consecutiveOut, operationId: randomUUID(), type: "SIGN_IN", expectedDailyCount: 5 };
      assert.equal((await post("/attendance", manualIn, employeeToken)).status, 201);
      const secondIn = { ...manualIn, operationId: randomUUID(), expectedDailyCount: 6 };
      assert.equal((await post("/attendance", secondIn, employeeToken)).status, 201);


      const otherEmployeeCode = String(1000 + Array.from({ length: 9000 }, (_, i) => i)
        .find((i) => !people.data.data.some((person) => person.workerId === String(1000 + i))));
      const otherAccount = (await pool.query(
        "INSERT INTO accounts(role,login_code,password_hash,email,status,name) VALUES('WORKER',$1,$2,$3,'ACTIVE','Other employee') RETURNING id",
        [otherEmployeeCode, pw, `other-${run}@test.invalid`])).rows[0];
      await pool.query("INSERT INTO workers(account_id) VALUES($1)", [otherAccount.id]);
      const otherLogin = await post("/auth/login", { accountId: otherEmployeeCode, password }, null);
      const otherToken = otherLogin.data.data.sessionToken;
      const emptyRecords = await get(employeeQuery, otherToken);
      assert.equal(emptyRecords.status, 200);
      assert.deepEqual(emptyRecords.data.data.items, []);
      if (photoId) assert.equal((await get(`/photos/${photoId}`, otherToken)).status, 403);

      assert.equal((await get(employeeQuery + `&workerId=${workerCode}`, otherToken)).status, 403);
      assert.equal((await post("/attendance-adjustments", { ...updateBody, operationId: randomUUID(),
        expectedVersion: afterEdit.version }, otherToken)).status, 403);
      const initialProfile = await get("/me/profile", employeeToken);
      assert.equal(initialProfile.status, 200);
      assert.equal(initialProfile.data.data.id, accountId);
      assert.equal(initialProfile.data.data.firstName, "Test groomer");
      assert.ok(initialProfile.data.data.email);
      const profileBody = { operationId: randomUUID(), expectedVersion: initialProfile.data.data.version,
        firstName: "Mobile", lastName: "Employee", address: "1 Test Road", phone: "+64 21 1234567", preferredShopId: shopCode };
      const savedProfile = await post("/me/profile", profileBody, employeeToken);
      assert.equal(savedProfile.status, 200);
      assert.equal(savedProfile.data.data.name, "Mobile Employee");
      assert.equal(savedProfile.data.data.email, initialProfile.data.data.email);
      assert.equal(savedProfile.data.data.preferredShopId, shopCode);
      assert.equal(savedProfile.data.data.version, initialProfile.data.data.version + 1);
      assert.deepEqual((await post("/me/profile", profileBody, employeeToken)).data, savedProfile.data);
      const reloadedProfile = (await get("/me/profile", employeeToken)).data.data;
      assert.equal(reloadedProfile.firstName, "Mobile");
      assert.equal(reloadedProfile.lastName, "Employee");
      assert.equal(reloadedProfile.address, "1 Test Road");
      assert.equal(reloadedProfile.phone, "+64 21 1234567");
      const profileLogin = await post("/auth/login", { accountId: workerCode, password }, null);
      assert.equal(profileLogin.data.data.account.name, "Mobile Employee");
      assert.equal(profileLogin.data.data.account.preferredShopId, shopCode);
      assert.equal((await post("/me/profile", { ...profileBody, operationId: randomUUID() }, employeeToken)).status, 409);
      for (const forbidden of [{ email: "changed@test.invalid" }, { role: "SUPER_MANAGER" }, { accountId: owner.id }]) {
        assert.equal((await post("/me/profile", { ...profileBody, ...forbidden, operationId: randomUUID(),
          expectedVersion: reloadedProfile.version }, employeeToken)).status, 422);
      }
      assert.equal((await post("/me/profile", { ...profileBody, firstName: " ", operationId: randomUUID(),
        expectedVersion: reloadedProfile.version }, employeeToken)).status, 422);
      const otherProfile = (await get("/me/profile", otherToken)).data.data;
      assert.equal(otherProfile.name, "Other employee");
      assert.equal(otherProfile.address, "");
      const clearedPreference = await post("/me/profile", { ...profileBody, operationId: randomUUID(),
        expectedVersion: reloadedProfile.version, preferredShopId: null }, employeeToken);
      assert.equal(clearedPreference.status, 200);
      assert.equal(clearedPreference.data.data.preferredShopId, null);
      const legacyWorkerProfile = (await pool.query("SELECT address,contact FROM workers WHERE account_id=$1", [accountId])).rows[0];
      assert.equal(legacyWorkerProfile.address, "1 Test Road");
      assert.equal(legacyWorkerProfile.contact, "+64 21 1234567");
      const emailReset = await post("/auth/password-links", { email: employeeEmail.toUpperCase() }, null);
      assert.equal(emailReset.status, 200);
      const emailResetJobs = await pool.query("SELECT e.id FROM email_jobs e JOIN password_links p ON p.id=e.password_link_id WHERE e.account_id=$1 AND p.purpose='PASSWORD_RESET' AND p.used_at IS NULL AND p.revoked_at IS NULL", [accountId]);
      assert.equal(emailResetJobs.rowCount, 1);
      const unknownEmailReset = await post("/auth/password-links", { email: `unknown-${run}@test.invalid` }, null);
      assert.deepEqual(unknownEmailReset.data, emailReset.data);
      const extraOtherSession = (await post("/auth/login", { accountId: otherEmployeeCode, password }, null)).data.data.sessionToken;
      const resetLink = (await pool.query("INSERT INTO password_links(account_id,purpose,token_hash,expires_at) VALUES($1,'PASSWORD_RESET',$2,now()+interval '1 day') RETURNING id", [otherAccount.id, randomUUID()])).rows[0];
      const newPassword = "Ab1!@#";
      const incorrectPassword = await post("/me/password", { currentPassword: "incorrect", newPassword }, otherToken);
      assert.equal(incorrectPassword.status, 422);
      assert.equal(incorrectPassword.data.error.code, "CURRENT_PASSWORD_INCORRECT");
      assert.equal((await get("/me", otherToken)).status, 200);
      assert.equal((await post("/me/password", { currentPassword: password, newPassword: "short" }, otherToken)).status, 422);
      assert.equal((await post("/me/password", { currentPassword: password, newPassword: password }, otherToken)).data.error.code, "PASSWORD_UNCHANGED");
      const changedPassword = await post("/me/password", { currentPassword: password, newPassword }, otherToken);
      assert.equal(changedPassword.status, 200);
      assert.equal(changedPassword.data.data.requiresLogin, true);
      assert.equal((await get("/me", otherToken)).status, 401);
      assert.equal((await get("/me", extraOtherSession)).status, 401);
      assert.equal((await post("/auth/login", { accountId: otherEmployeeCode, password }, null)).status, 401);
      const otherRelogin = await post("/auth/login", { accountId: otherEmployeeCode, password: newPassword }, null);
      assert.equal(otherRelogin.status, 200);
      assert.ok((await pool.query("SELECT revoked_at FROM password_links WHERE id=$1", [resetLink.id])).rows[0].revoked_at);
      assert.equal((await get("/me", employeeToken)).status, 200, "Other accounts remain signed in");
      const passwordAudit = (await pool.query("SELECT before_data,after_data FROM audit_logs WHERE resource_id=$1 AND action='PASSWORD_CHANGE'", [otherAccount.id])).rows[0];
      assert.equal(passwordAudit.before_data, null);
      assert.equal(passwordAudit.after_data, null);
      // Removal is reversible soft state. Only the owner lists retained removal rows.
      await pool.query("INSERT INTO account_shops(account_id,shop_id) SELECT $1,s.id FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=$2 ON CONFLICT DO NOTHING", [managerId, shopCode]);
      await pool.query("INSERT INTO manager_workers(manager_account_id,worker_id) SELECT $1,id FROM workers WHERE account_id=$2 ON CONFLICT DO NOTHING", [managerId, accountId]);

      const beforeRemoval = (await pool.query("SELECT * FROM attendance_records WHERE id=$1", [posted.data.data.recordId])).rows[0];
      const removeBody = { operationId: randomUUID(), action: "DELETE", recordId: beforeRemoval.id, expectedVersion: beforeRemoval.version };
      assert.equal((await post("/attendance-adjustments", removeBody, otherRelogin.data.data.sessionToken)).status, 403);
      const removed = await post("/attendance-adjustments", removeBody, employeeToken);
      assert.equal(removed.status, 201);
      assert.equal(removed.data.data.recordStatus, "removal");
      assert.deepEqual((await post("/attendance-adjustments", removeBody, employeeToken)).data, removed.data);
      let retained = (await pool.query("SELECT * FROM attendance_records WHERE id=$1", [beforeRemoval.id])).rows[0];
      assert.equal(retained.record_status, "removal");
      assert.equal(retained.original_occurred_at.toISOString(), beforeRemoval.original_occurred_at.toISOString());
      assert.equal(retained.photo_id, beforeRemoval.photo_id);
      assert.equal(retained.confirmed_deleted, false, "Removal awaits approval");
      const removedQuery = `/attendance?shopId=${shopCode}&fromDate=${currentDay}&toDate=${currentDay}`;
      assert.ok((await get(removedQuery, employeeToken)).data.data.items.some((r) => r.id === retained.id));
      const ownerListPath = `/manager/attendance?shopId=${shopCode}&month=${currentDay.slice(0, 7)}&limit=100`;
      const ownerRemoved = (await get(ownerListPath)).data.data.items.find((r) => r.id === retained.id);
      assert.equal(ownerRemoved.record_status, "removal");
      assert.ok(!(await get(ownerListPath, ml.data.data.sessionToken)).data.data.items.some((r) => r.id === retained.id));
      assert.equal((await post(`/manager/attendance/${retained.id}/corrections`, {
        operationId: randomUUID(), expectedRecordVersion: retained.version, occurredAt: clockInAt })).status, 200);
      assert.equal((await post("/manager/validations/" + removed.data.data.adjustmentId + "/decision", {
        operationId: randomUUID(), decision: "REJECT", expectedRecordVersion: retained.version })).status, 409);
      retained = (await pool.query("SELECT * FROM attendance_records WHERE id=$1", [retained.id])).rows[0];
      assert.equal(retained.record_status, "active");
      assert.ok((await get(removedQuery, employeeToken)).data.data.items.some((r) => r.id === retained.id));
      const finalRemoval = await post("/manager/attendance-adjustments", { ...removeBody, operationId: randomUUID(), expectedVersion: retained.version }, ml.data.data.sessionToken);
      assert.equal(finalRemoval.status, 201);
      const managerRemovalAudit = (await pool.query("SELECT source,actor_account_id FROM attendance_adjustments WHERE id=$1", [finalRemoval.data.data.adjustmentId])).rows[0];
      assert.equal(managerRemovalAudit.source, "MANAGER_EDIT");
      assert.equal(managerRemovalAudit.actor_account_id, managerId);
      retained = (await pool.query("SELECT * FROM attendance_records WHERE id=$1", [retained.id])).rows[0];
      assert.equal((await post("/manager/validations/" + finalRemoval.data.data.adjustmentId + "/decision", {
        operationId: randomUUID(), decision: "APPROVE", expectedRecordVersion: retained.version })).status, 409);
      const finalRetained = (await pool.query("SELECT * FROM attendance_records WHERE id=$1", [retained.id])).rows[0];
      assert.equal(finalRetained.record_status, "removal");
      assert.equal(finalRetained.confirmed_deleted, true);
      assert.equal(finalRetained.photo_id, beforeRemoval.photo_id);
      assert.equal((await get(`/manager/attendance/${retained.id}/history`)).status, 200);
      if (photoId) assert.equal((await get(`/photos/${photoId}`)).status, 200);
      // Manual entries use the same actor/scope checks and require approval.
      const addBody = { operationId: randomUUID(), action: "ADD", shopId: shopCode, type: "SIGN_IN",
        occurredAt: DateTime.fromISO(currentDay, { zone: "Pacific/Auckland" }).set({ hour: 8 }).toISO() };
      const added = await post("/attendance-adjustments", addBody, employeeToken);
      assert.equal(added.status, 201);
      assert.deepEqual((await post("/attendance-adjustments", addBody, employeeToken)).data, added.data);
      const addedRow = (await pool.query("SELECT * FROM attendance_records WHERE id=$1", [added.data.data.recordId])).rows[0];
      assert.equal(addedRow.record_status, "active");
      assert.equal(addedRow.worker_id, savedSign.worker_id);
      assert.equal(addedRow.source, "MANUAL_ADD");
      assert.equal(addedRow.camera_status, "NOT_APPLICABLE");
      assert.equal(addedRow.photo_id, null);
      assert.equal(addedRow.confirmed_occurred_at, null);
      assert.equal((await post("/manager/attendance-adjustments", { ...addBody, operationId: randomUUID(), workerId: workerCode }, employeeToken)).status, 403);
      assert.equal((await post("/manager/attendance-adjustments", { ...addBody, operationId: randomUUID(), workerId: workerCode, shopId: code2 }, ml.data.data.sessionToken)).status, 201);
      const managerAdd = await post("/manager/attendance-adjustments", { ...addBody, operationId: randomUUID(), workerId: workerCode }, ml.data.data.sessionToken);
      assert.equal(managerAdd.status, 201);
      const managerRecordId = managerAdd.data.data.recordId;
      const managerRecord = () => pool.query("SELECT * FROM attendance_records WHERE id=$1", [managerRecordId]).then(r => r.rows[0]);
      let edited = await managerRecord();
      assert.equal((await post("/manager/validations/" + managerAdd.data.data.adjustmentId + "/decision", {
        operationId: randomUUID(), expectedRecordVersion: edited.version, decision: "APPROVE",
      })).status, 409);
      edited = await managerRecord();
      const typeCorrection = { operationId: randomUUID(), expectedRecordVersion: edited.version,
        occurredAt: edited.effective_occurred_at, type: "SIGN_OUT" };
      assert.equal((await post(`/manager/attendance/${edited.id}/corrections`, typeCorrection, employeeToken)).status, 403);
      const typeChanged = await post(`/manager/attendance/${edited.id}/corrections`, typeCorrection, ml.data.data.sessionToken);
      assert.equal(typeChanged.status, 200);
      assert.equal(typeChanged.data.data.validationStatus, "APPROVED");
      assert.deepEqual((await post(`/manager/attendance/${edited.id}/corrections`, typeCorrection, ml.data.data.sessionToken)).data, typeChanged.data);
      const correctedType = await managerRecord();
      assert.equal(correctedType.sign_type, "SIGN_OUT");
      assert.equal(correctedType.original_sign_type, "SIGN_IN");
      assert.equal(correctedType.original_occurred_at.toISOString(), edited.original_occurred_at.toISOString());
      assert.equal((await pool.query("SELECT count(*) FROM attendance_adjustments WHERE record_id=$1 AND status='PENDING'", [edited.id])).rows[0].count, "0");
      const typeHistory = (await pool.query("SELECT * FROM attendance_adjustments WHERE id=$1", [typeChanged.data.data.adjustmentId])).rows[0];
      assert.equal(typeHistory.before_type, "SIGN_IN");
      assert.equal(typeHistory.after_type, "SIGN_OUT");
      assert.equal((await post(`/manager/attendance/${edited.id}/corrections`, { ...typeCorrection, operationId: randomUUID() }, ml.data.data.sessionToken)).status, 409);
      assert.equal((await post(`/manager/attendance/${edited.id}/corrections`, { ...typeCorrection, operationId: randomUUID(), expectedRecordVersion: correctedType.version, type: "INVALID" }, ml.data.data.sessionToken)).status, 422);
      assert.equal((await post("/manager/attendance-adjustments", { operationId: randomUUID(), action: "UPDATE", recordId: edited.id,
        expectedVersion: correctedType.version, occurredAt: edited.effective_occurred_at, type: "SIGN_IN" }, ml.data.data.sessionToken)).data.data.validationStatus, "APPROVED");
      assert.equal((await managerRecord()).sign_type, "SIGN_IN");
      const lockedRecord = await managerRecord();
      for (const action of ["UPDATE", "DELETE"]) assert.equal((await post("/attendance-adjustments", {
        operationId: randomUUID(), action, recordId: lockedRecord.id, expectedVersion: lockedRecord.version,
        occurredAt: lockedRecord.effective_occurred_at, type: "SIGN_OUT" }, employeeToken)).status, 403);
      const typeDraftResponse = await post("/attendance-adjustments", { ...addBody, operationId: randomUUID() }, employeeToken);
      const typeDraftId = typeDraftResponse.data.data.recordId;
      const typeDraftRecord = () => pool.query("SELECT * FROM attendance_records WHERE id=$1", [typeDraftId]).then(r => r.rows[0]);
      // Employee type changes remain proposals until a manager approves them.
      for (const decision of ["REJECT", "APPROVE"]) {
        const beforeTypeRequest = await typeDraftRecord();
        const changeTypeBody = { operationId: randomUUID(), action: "UPDATE", recordId: typeDraftId,
          expectedVersion: beforeTypeRequest.version, occurredAt: beforeTypeRequest.effective_occurred_at, type: "SIGN_OUT" };
        const typeRequest = await post("/attendance-adjustments", changeTypeBody, employeeToken);
        assert.equal(typeRequest.status, 201);
        assert.equal(typeRequest.data.data.validationStatus, "PENDING");
        assert.deepEqual((await post("/attendance-adjustments", changeTypeBody, employeeToken)).data, typeRequest.data);
        assert.equal((await typeDraftRecord()).sign_type, "SIGN_IN");
        const firstProposal = (await get(employeeQuery, employeeToken)).data.data.items.find(r => r.id === typeDraftId);
        for (const action of ["UPDATE", "DELETE", "UPDATE"]) {
          const currentProposal = await typeDraftRecord();
          const revised = await post("/attendance-adjustments", { operationId: randomUUID(), action, recordId: typeDraftId,
            expectedVersion: currentProposal.version, occurredAt: beforeTypeRequest.effective_occurred_at,
            type: action === "UPDATE" ? "SIGN_OUT" : undefined }, employeeToken);
          assert.equal(revised.status, 201);
          assert.equal(revised.data.data.adjustmentId, typeRequest.data.data.adjustmentId);
          assert.equal((await pool.query("SELECT count(*) FROM attendance_adjustments WHERE record_id=$1 AND status='PENDING'", [typeDraftId])).rows[0].count, "1");
        }
        assert.equal((await post(`/manager/validations/${typeRequest.data.data.adjustmentId}/decision`, {
          operationId: randomUUID(), expectedRecordVersion: firstProposal.version, decision: "APPROVE",
        })).status, 409);
        const queryPending = (await get(employeeQuery, employeeToken)).data.data.items.find(r => r.id === typeDraftId);
        assert.equal(queryPending.pending_sign_type, "SIGN_OUT");
        assert.equal((await post(`/manager/validations/${typeRequest.data.data.adjustmentId}/decision`, {
          operationId: randomUUID(), expectedRecordVersion: queryPending.version, decision,
        })).status, 200);
        const afterTypeDecision = await typeDraftRecord();
        assert.equal(afterTypeDecision.sign_type, decision === "APPROVE" ? "SIGN_OUT" : "SIGN_IN");
        assert.equal(afterTypeDecision.original_sign_type, "SIGN_IN");
        assert.equal(afterTypeDecision.original_occurred_at.toISOString(), beforeTypeRequest.original_occurred_at.toISOString());
      }


      assert.equal((await pool.query("SELECT source FROM attendance_adjustments WHERE id=$1", [managerAdd.data.data.adjustmentId])).rows[0].source, "MANAGER_EDIT");
      const exportedRecord = await typeDraftRecord();
      for (const action of ["UPDATE", "DELETE"]) assert.equal((await post("/attendance-adjustments", {
        operationId: randomUUID(), action, recordId: exportedRecord.id, expectedVersion: exportedRecord.version,
        occurredAt: exportedRecord.effective_occurred_at }, employeeToken)).status, 403);

      const exportBody = { operationId: randomUUID(), shopId: shopCode, fromDate: "2026-10-01", toDate: "2026-10-31",
        records: [{ id: exportedRecord.id, version: exportedRecord.version }] };
      assert.equal((await post("/attendance/exports", exportBody, ml.data.data.sessionToken)).status, 409);
      assert.equal((await post("/attendance/exports", exportBody, otherRelogin.data.data.sessionToken)).status, 409);
      assert.equal((await post("/attendance/exports", { ...exportBody, recipientEmail: "attacker@test.invalid" }, employeeToken)).status, 422);
      assert.equal((await post("/attendance/exports", { ...exportBody, records: [{ id: exportedRecord.id, version: exportedRecord.version - 1 }] }, employeeToken)).status, 409);
      assert.equal((await post("/attendance/exports", { ...exportBody, toDate: "2026-12-01" }, employeeToken)).status, 422);
      const queuedExport = await post("/attendance/exports", exportBody, employeeToken);
      assert.equal(queuedExport.status, 202);
      assert.equal(queuedExport.data.data.status, "QUEUED");
      assert.equal(queuedExport.data.data.recipientEmail, employeeEmail);
      assert.deepEqual((await post("/attendance/exports", exportBody, employeeToken)).data, queuedExport.data);
      assert.equal((await pool.query("SELECT count(*) FROM attendance_export_jobs")).rows[0].count, "1");
      const exportJob = (await pool.query("SELECT * FROM attendance_export_jobs WHERE id=$1", [queuedExport.data.data.exportId])).rows[0];
      const exportShopName = (await pool.query("SELECT name FROM shops WHERE id=$1", [exportedRecord.shop_id])).rows[0].name;
      assert.equal(exportJob.subject, `Pawhub ${exportShopName} 2026-10-01 - 2026-10-31 attendence record`);
      assert.equal(exportJob.snapshot_data.records.length, 1);
      assert.equal(exportJob.snapshot_data.records[0].sign_type, "SIGN_OUT");
      // Inject a local mail transport: no real emails are sent by integration tests.
      let delivered;
      await processAttendanceExports({ sendMail: async mail => { delivered = mail; } });
      assert.ok(delivered, JSON.stringify((await pool.query("SELECT status,last_error_code FROM attendance_export_jobs WHERE id=$1", [exportJob.id])).rows));
      assert.equal(delivered.to, employeeEmail);
      assert.equal(delivered.subject, exportJob.subject);
      assert.equal(delivered.attachments[0].content.subarray(0, 4).toString(), "%PDF");
      assert.ok(delivered.attachments[0].content.length > 1000);
      assert.equal((await pool.query("SELECT status FROM attendance_export_jobs WHERE id=$1", [exportJob.id])).rows[0].status, "SENT");
      await processAttendanceExports({ sendMail: async () => { assert.fail("A sent export must not send again"); } });
      const retryExport = await post("/attendance/exports", { ...exportBody, operationId: randomUUID() }, employeeToken);
      await processAttendanceExports({ sendMail: async () => { throw Object.assign(new Error("Test SMTP failure"), { code: "ECONNECTION" }); } });
      const retryJob = (await pool.query("SELECT * FROM attendance_export_jobs WHERE id=$1", [retryExport.data.data.exportId])).rows[0];
      assert.equal(retryJob.status, "QUEUED");
      assert.equal(retryJob.last_error_code, "ECONNECTION");
      assert.equal(retryJob.attempt_count, 1);
      const registrationEmail = `registration-${run}@test.invalid`;
      assert.equal((await post("/auth/register", { email: "not-an-email", confirmEmail: "not-an-email" }, null)).status, 422);
      assert.equal((await post("/auth/register", { email: registrationEmail, confirmEmail: "other@test.invalid" }, null)).status, 422);
      assert.equal((await post("/auth/register", { email: registrationEmail, confirmEmail: registrationEmail, role: "SUPER_MANAGER" }, null)).status, 422);
      const registration = await post("/auth/register", { email: registrationEmail.toUpperCase(), confirmEmail: registrationEmail }, null);
      assert.equal(registration.status, 202);
      assert.equal(registration.data.data.accepted, true);
      const registered = (await pool.query("SELECT * FROM accounts WHERE email=$1", [registrationEmail])).rows[0];
      assert.equal(registered.role, "WORKER");
      assert.equal(registered.status, "PENDING");
      assert.equal(registered.requires_manager_approval, true);
      assert.equal((await post(`/manager/accounts/${registered.id}/approve`, { operationId: randomUUID() }, employeeToken)).status, 403);
      assert.equal((await post(`/manager/accounts/${registered.id}/approve`, { operationId: randomUUID() }, ml.data.data.sessionToken)).status, 403);

      assert.equal(registered.login_code, null);
      assert.equal((await pool.query("SELECT count(*) FROM workers WHERE account_id=$1", [registered.id])).rows[0].count, "1");
      assert.equal((await post("/auth/login", { email: registrationEmail, password }, null)).status, 401);
      assert.equal((await post("/auth/register", { email: registrationEmail, confirmEmail: registrationEmail }, null)).status, 202);
      const registrationJobs = (await pool.query("SELECT * FROM email_jobs WHERE account_id=$1", [registered.id])).rows;
      assert.equal(registrationJobs.length, 1);
      assert.equal(registrationJobs[0].recipient_email, registrationEmail);
      const [registerIv, registerTag, registerPayload] = registrationJobs[0].encrypted_payload.split(".").map(x => Buffer.from(x, "base64"));
      const registerDecipher = createDecipheriv("aes-256-gcm", Buffer.from(process.env.MAIL_ENCRYPTION_KEY, "hex"), registerIv);
      registerDecipher.setAuthTag(registerTag);
      const registrationToken = JSON.parse(Buffer.concat([registerDecipher.update(registerPayload), registerDecipher.final()]).toString()).token;
      const passwordSetup = await post("/auth/password-links/consume", { token: registrationToken, newPassword: "abc123" }, null);
      assert.equal(passwordSetup.status, 200);
      assert.equal(passwordSetup.data.data.activated, false);
      assert.equal(passwordSetup.data.data.awaitingManagerApproval, true);
      assert.equal((await pool.query("SELECT status FROM accounts WHERE id=$1", [registered.id])).rows[0].status, "PENDING");
      const unapprovedLogin = await post("/auth/login", { email: registrationEmail, password: "abc123" }, null);
      assert.equal(unapprovedLogin.status, 200);
      assert.equal(unapprovedLogin.data.data.account.attendanceEnabled, false);
      assert.equal(unapprovedLogin.data.data.account.accountId, null);
      assert.equal((await pool.query("SELECT login_code FROM accounts WHERE id=$1", [registered.id])).rows[0].login_code, null);
      const unapprovedToken = unapprovedLogin.data.data.sessionToken;
      assert.equal((await get("/me", unapprovedToken)).status, 200);
      assert.equal((await get("/me", unapprovedToken)).data.data.attendanceEnabled, false);
      assert.equal((await get("/me/profile", unapprovedToken)).status, 200);
      for (const path of ["/attendance", "/attendance-adjustments", "/photos"]) {
        const restricted = await post(path, {}, unapprovedToken);
        assert.equal(restricted.status, 403);
        assert.equal(restricted.data.error.code, "MANAGER_APPROVAL_REQUIRED");
      }

      await pool.query("INSERT INTO manager_workers(manager_account_id,worker_id) SELECT $1,id FROM workers WHERE account_id=$2", [managerId, registered.id]);
      const approvalRow = (await get("/manager/workers", ml.data.data.sessionToken)).data.data.find(w => w.accountId === registered.id);
      assert.equal(approvalRow.password_set, true);
      assert.equal(approvalRow.requires_manager_approval, true);
      const activationBody = { operationId: randomUUID() };
      const activationApproval = await post(`/manager/accounts/${registered.id}/approve`, activationBody, generalToken);
      assert.equal(activationApproval.status, 200);
      // The existing pending-user session becomes attendance-enabled without another login.
      assert.equal((await get("/me", unapprovedToken)).data.data.attendanceEnabled, true);
      assert.equal((await get(`/attendance/status?shopId=${shopCode}`, unapprovedToken)).data.data.attendanceEnabled, true);

      assert.deepEqual((await post(`/manager/accounts/${registered.id}/approve`, activationBody, generalToken)).data, activationApproval.data);
      assert.equal((await post("/auth/login", { email: registrationEmail, password: "abc123" }, null)).status, 200);
      const approvedAccount = (await pool.query("SELECT * FROM accounts WHERE id=$1", [registered.id])).rows[0];
      assert.equal(approvedAccount.approved_by_account_id, generalId);
      assert.ok(approvedAccount.approved_at);
      assert.match(approvedAccount.login_code, /^[1-9]\d{3}$/);
      assert.equal(activationApproval.data.data.workerId, approvedAccount.login_code);
      assert.equal((await get("/me", unapprovedToken)).data.data.accountId, approvedAccount.login_code);
      assert.equal((await post("/auth/login", { accountId: approvedAccount.login_code, password: "abc123" }, null)).status, 200);
      const confirmationJobs = (await pool.query("SELECT * FROM email_jobs WHERE account_id=$1 AND kind='ACCOUNT_APPROVED'", [registered.id])).rows;
      assert.equal(confirmationJobs.length, 1);
      assert.equal(confirmationJobs[0].recipient_email, registrationEmail);


      assert.equal((await post("/auth/register", { email: registrationEmail, confirmEmail: registrationEmail }, null)).status, 202);
      assert.equal((await pool.query("SELECT count(*) FROM email_jobs WHERE account_id=$1", [registered.id])).rows[0].count, "2");
      assert.equal((await post("/auth/register", { email: `${run}@test.invalid`, confirmEmail: `${run}@test.invalid` }, null)).status, 202);
      assert.equal((await pool.query("SELECT count(*) FROM accounts WHERE email=$1 AND role='WORKER'", [`${run}@test.invalid`])).rows[0].count, "0");
      const concurrentEmail = `register-concurrent-${run}@test.invalid`;
      const concurrentRegistration = await Promise.all([1, 2].map(() => post("/auth/register", { email: concurrentEmail, confirmEmail: concurrentEmail }, null)));
      assert.deepEqual(concurrentRegistration.map(r => r.status), [202, 202]);
      assert.equal((await pool.query("SELECT count(*) FROM accounts WHERE email=$1", [concurrentEmail])).rows[0].count, "1");
      assert.equal((await pool.query("SELECT count(*) FROM email_jobs WHERE recipient_email=$1", [concurrentEmail])).rows[0].count, "1");
      // Isolate the approval email for a simulated SMTP delivery; no real email is sent.
      await pool.query("UPDATE email_jobs SET status='CANCELLED' WHERE id<>$1 AND status='QUEUED'", [confirmationJobs[0].id]);
      await processMail({ sendMail: async () => { throw Object.assign(new Error("Test failure"), { code: "ECONNECTION" }); } });
      assert.equal((await pool.query("SELECT status FROM email_jobs WHERE id=$1", [confirmationJobs[0].id])).rows[0].status, "QUEUED");
      await pool.query("UPDATE email_jobs SET next_attempt_at=now() WHERE id=$1", [confirmationJobs[0].id]);
      let confirmationMail;
      await processMail({ sendMail: async mail => { confirmationMail = mail; } });
      assert.equal(confirmationMail.to, registrationEmail);
      assert.ok(confirmationMail.subject.includes(approvedAccount.login_code));
      assert.ok(confirmationMail.text.includes(approvedAccount.login_code));
      assert.ok(confirmationMail.text.includes("已激活"));
      assert.equal(confirmationMail.text.includes("abc123"), false);
      assert.equal((await pool.query("SELECT status FROM email_jobs WHERE id=$1", [confirmationJobs[0].id])).rows[0].status, "SENT");
      await processMail({ sendMail: async () => assert.fail("Do not deliver a confirmation twice") });

      // People CRUD shares exactly the Android profile fields and preserves attendance on deletion.
      const peopleEdit = { operationId: randomUUID(), expectedVersion: approvedAccount.profile_version,
        firstName: "People", lastName: "Updated", address: "42 Pawhub Street", phone: "+64 21 9876543", preferredShopId: shopCode };
      assert.equal((await post(`/manager/accounts/${registered.id}/profile`, peopleEdit, employeeToken)).status, 403);
      const peopleUpdated = await post(`/manager/accounts/${registered.id}/profile`, peopleEdit, ml.data.data.sessionToken);
      assert.equal(peopleUpdated.status, 200);
      assert.deepEqual((await post(`/manager/accounts/${registered.id}/profile`, peopleEdit, ml.data.data.sessionToken)).data, peopleUpdated.data);
      const androidAfterManagerEdit = (await get("/me/profile", unapprovedToken)).data.data;
      assert.equal(androidAfterManagerEdit.firstName, "People");
      assert.equal(androidAfterManagerEdit.lastName, "Updated");
      assert.equal(androidAfterManagerEdit.phone, peopleEdit.phone);
      assert.equal(androidAfterManagerEdit.address, peopleEdit.address);
      assert.equal(androidAfterManagerEdit.preferredShopId, shopCode);
      assert.equal(androidAfterManagerEdit.email, registrationEmail);
      assert.equal((await pool.query("SELECT contact,address FROM workers WHERE account_id=$1", [registered.id])).rows[0].contact, peopleEdit.phone);
      const peopleRow = (await get("/manager/workers", ml.data.data.sessionToken)).data.data.find(p => p.accountId === registered.id);
      assert.equal(peopleRow.firstName, "People");
      assert.equal(peopleRow.lastName, "Updated");
      assert.equal(peopleRow.phone, peopleEdit.phone);
      assert.equal(peopleRow.address, peopleEdit.address);
      assert.equal(peopleRow.preferredShopId, shopCode);
      assert.equal(peopleRow.version, androidAfterManagerEdit.version);
      assert.equal((await post(`/manager/accounts/${registered.id}/profile`, { ...peopleEdit, operationId: randomUUID() }, ml.data.data.sessionToken)).status, 409);
      assert.equal((await post(`/manager/accounts/${registered.id}/profile`, { ...peopleEdit, operationId: randomUUID(), expectedVersion: peopleRow.version, email: "change@test.invalid" }, ml.data.data.sessionToken)).status, 422);
      assert.equal((await post(`/manager/accounts/${managerId}/profile`, { ...peopleEdit, operationId: randomUUID(), expectedVersion: 1 }, ml.data.data.sessionToken)).status, 403);
      assert.equal((await post(`/manager/accounts/${managerId}/remove`, { operationId: randomUUID(), expectedVersion: 1 }, ml.data.data.sessionToken)).status, 403);
      const ownerSelf = (await get("/me")).data.data;
      assert.equal((await post(`/manager/accounts/${ownerSelf.id}/remove`, { operationId: randomUUID(), expectedVersion: 1 })).status, 404);
      const richPerson = await post("/manager/workers", { operationId: randomUUID(), name: "Rich Profile", firstName: "Rich", lastName: "Profile",
        email: `rich-${run}@test.invalid`, address: "New Address", phone: "+64 22 1111111", preferredShopId: shopCode }, ml.data.data.sessionToken);
      assert.equal(richPerson.status, 201);
      const richRow = (await get("/manager/workers", ml.data.data.sessionToken)).data.data.find(p => p.accountId === richPerson.data.data.accountId);
      assert.equal(richRow.firstName, "Rich");
      assert.equal(richRow.lastName, "Profile");
      assert.equal(richRow.phone, "+64 22 1111111");
      assert.equal(richRow.address, "New Address");
      assert.equal(richRow.preferredShopId, shopCode);
      const pendingNoId = (await pool.query("SELECT * FROM accounts WHERE email=$1", [concurrentEmail])).rows[0];
      assert.equal(pendingNoId.login_code, null);
      assert.equal((await post(`/manager/accounts/${pendingNoId.id}/remove`, { operationId: randomUUID(), expectedVersion: pendingNoId.profile_version }, generalToken)).status, 200);
      assert.equal((await pool.query("SELECT status FROM accounts WHERE id=$1", [pendingNoId.id])).rows[0].status, "DISABLED");
      const beforeWorkerRemoval = (await pool.query("SELECT * FROM accounts WHERE id=$1", [accountId])).rows[0];
      const historicalCount = (await pool.query("SELECT count(*) FROM attendance_records r JOIN workers w ON w.id=r.worker_id WHERE w.account_id=$1", [accountId])).rows[0].count;
      const removePersonBody = { operationId: randomUUID(), expectedVersion: beforeWorkerRemoval.profile_version };
      assert.equal((await post(`/manager/accounts/${accountId}/remove`, removePersonBody, employeeToken)).status, 403);
      const removedPerson = await post(`/manager/accounts/${accountId}/remove`, removePersonBody, ml.data.data.sessionToken);
      assert.equal(removedPerson.status, 200);
      assert.deepEqual((await post(`/manager/accounts/${accountId}/remove`, removePersonBody, ml.data.data.sessionToken)).data, removedPerson.data);
      assert.equal((await get("/me", employeeToken)).status, 401);
      assert.equal((await post("/auth/login", { accountId: workerCode, password }, null)).status, 401);
      assert.equal((await pool.query("SELECT count(*) FROM attendance_records r JOIN workers w ON w.id=r.worker_id WHERE w.account_id=$1", [accountId])).rows[0].count, historicalCount);
      assert.equal((await pool.query("SELECT status FROM accounts WHERE id=$1", [accountId])).rows[0].status, "DISABLED");
      // Organization: independent singleton GM, many-to-many assignments and store OR groomer access.
      const orgPath = "/manager/organization";
      const organizationVersion = async () => (await get(orgPath)).data.data.version;
      assert.equal((await get(orgPath, ml.data.data.sessionToken)).status, 403);
      assert.equal((await get(orgPath, generalToken)).status, 200);
      const assignedGroomerId = (await pool.query("SELECT id FROM workers WHERE account_id=$1", [registered.id])).rows[0].id;
      const store2 = (await pool.query("SELECT s.* FROM shops s JOIN accounts a ON a.id=s.account_id WHERE a.login_code=$1", [code2])).rows[0];
      const setPermissions = async (id, shopIds, workerIds, actor = generalToken) => post(orgPath + "/permissions", {
        operationId: randomUUID(), expectedVersion: await organizationVersion(), managerId: id, shopIds, workerIds,
      }, actor);
      assert.equal((await setPermissions(managerId, [], [assignedGroomerId], ml.data.data.sessionToken)).status, 403);
      assert.equal((await setPermissions(managerId, [], [assignedGroomerId])).status, 200);
      assert.equal((await get("/manager/shops", ml.data.data.sessionToken)).data.data.length, 0);
      assert.deepEqual((await get("/manager/workers", ml.data.data.sessionToken)).data.data.map(p => p.accountId), [registered.id]);
      assert.ok((await get("/manager/attendance/stores", ml.data.data.sessionToken)).data.data.some(s => s.shopId === code2));
      const orgAttendance = await post("/attendance", { operationId: randomUUID(), workerId: approvedAccount.login_code, shopId: code2,
        type: "SIGN_OUT", occurredAt: clockInAt, offline: false, cameraStatus: "UNAVAILABLE" }, unapprovedToken);
      assert.equal(orgAttendance.status, 201);
      const staffList = await get("/manager/staff-attendance/staff", ml.data.data.sessionToken);
      assert(staffList.data.data.some(r=>r.id===assignedGroomerId));
      assert(staffList.data.data.some(r=>r.workerId==='__self__'));
      assert.equal((await get("/manager/staff-attendance/staff",unapprovedToken)).status,403);
      const staffQuery = `/manager/staff-attendance?fromDate=${currentDay}&toDate=${currentDay}`;
      const staffResult = await get(staffQuery,ml.data.data.sessionToken);
      assert.equal(staffResult.status,200);
      assert(staffResult.data.data.items.some(r=>r.id===orgAttendance.data.data.recordId));
      assert(staffResult.data.data.items.every(r=>r.worker_id===assignedGroomerId));
      assert(staffResult.data.data.dailyHours.every(r=>r.workerId===assignedGroomerId));
      const dailyRow=staffResult.data.data.dailyHours[0];
      assert(dailyRow.shopCode && dailyRow.shopId && dailyRow.shopName && dailyRow.workerCode);
      const drilled=await get(`/manager/staff-attendance?fromDate=${dailyRow.date}&toDate=${dailyRow.date}&shopIds=${dailyRow.shopCode}&workerIds=${dailyRow.workerCode}`,ml.data.data.sessionToken);
      assert.equal(drilled.status,200);
      assert(drilled.data.data.items.length>0);
      assert(drilled.data.data.items.every(r=>r.worker_id===dailyRow.workerId && r.shop_id===dailyRow.shopId));

      assert.equal((await get(staffQuery+`&workerId=${workerCode}`,ml.data.data.sessionToken)).status,403);
      const selectedStaff = await get(staffQuery+`&workerId=${approvedAccount.login_code}`,ml.data.data.sessionToken);
      assert.equal(selectedStaff.status,200);
      const multiStaff=await get(staffQuery+`&workerIds=${approvedAccount.login_code},__self__&shopIds=${shopCode},${code2}`,ml.data.data.sessionToken);
      assert.equal(multiStaff.status,200);
      assert(multiStaff.data.data.items.every(r=>r.worker_id===assignedGroomerId));
      assert.equal((await get(staffQuery+`&workerIds=${approvedAccount.login_code},${workerCode}`,ml.data.data.sessionToken)).status,403);
      assert.equal((await get(staffQuery+"&shopIds=9999",ml.data.data.sessionToken)).status,422);
      const multiExport=await post("/manager/staff-attendance/exports",{operationId:randomUUID(),workerIds:[approvedAccount.login_code,"__self__"],shopIds:[shopCode,code2],fromDate:currentDay,toDate:currentDay,records:multiStaff.data.data.items.map(r=>({id:r.id,version:r.version}))},ml.data.data.sessionToken);
      assert.equal(multiExport.status,202);

      const staffExportBody={operationId:randomUUID(),fromDate:currentDay,toDate:currentDay,records:staffResult.data.data.items.map(r=>({id:r.id,version:r.version}))};
      const staffExport=await post("/manager/staff-attendance/exports",staffExportBody,ml.data.data.sessionToken);
      assert.equal(staffExport.status,202);
      const staffJob=(await pool.query("SELECT * FROM attendance_export_jobs WHERE id=$1",[staffExport.data.data.exportId])).rows[0];
      assert.equal(staffJob.snapshot_data.staffMode,true);
      assert(staffJob.snapshot_data.records.every(r=>r.worker_id===assignedGroomerId));

      const orgRecordId = orgAttendance.data.data.recordId;
      assert.equal((await get(`/manager/attendance/${orgRecordId}/history`, ml.data.data.sessionToken)).status, 200);
      const orgReportBody = { operationId: randomUUID(), month: currentDay.slice(0, 7), shopId: code2, workerId: approvedAccount.login_code, reportType: "ATTENDANCE" };
      assert.equal((await post("/manager/reports/pdf", orgReportBody, ml.data.data.sessionToken)).status, 200);
      const editStoreBody = { operationId: randomUUID(), expectedVersion: store2.profile_version, name: "Scoped store update", address: store2.address };
      assert.equal((await post(`/manager/shops/${store2.id}/profile`, editStoreBody, ml.data.data.sessionToken)).status, 403);
      const secondManager = (await pool.query("INSERT INTO accounts(role,email,password_hash,status,name) VALUES('MANAGER',$1,$2,'ACTIVE','Shared manager') RETURNING *", [`shared-manager-${run}@test.invalid`, pw])).rows[0];
      const secondManagerToken = (await post("/manager/auth/login", { email: secondManager.email, password }, null)).data.data.sessionToken;
      assert.equal((await setPermissions(secondManager.id, [], [assignedGroomerId])).status, 200);
      assert.equal((await pool.query("SELECT count(*) FROM manager_workers WHERE worker_id=$1", [assignedGroomerId])).rows[0].count, "2");
      assert.equal((await get(`/manager/attendance/${orgRecordId}/history`, secondManagerToken)).status, 200);
      assert.equal((await setPermissions(managerId, [store2.id], [])).status, 200);
      assert.equal((await get("/manager/staff-attendance/staff",ml.data.data.sessionToken)).data.data.length,1);
      assert.equal((await get(staffQuery,ml.data.data.sessionToken)).data.data.items.length,0);
      const issuesForReview=(await get(`/manager/validations?month=${currentDay.slice(0,7)}`,ml.data.data.sessionToken)).data.data;
      const reviewIssue=issuesForReview.find(r=>r.item_type==='RECORD_ERROR'&&r.worker_id===assignedGroomerId&&r.shop_code===code2);
      assert(reviewIssue);
      assert.match(reviewIssue.local_date,/^\d{4}-\d{2}-\d{2}$/);
      const reviewedRecords=await get(`/manager/staff-attendance?fromDate=${reviewIssue.local_date}&toDate=${reviewIssue.local_date}&workerIds=${reviewIssue.worker_code}&shopIds=${reviewIssue.shop_code}`,ml.data.data.sessionToken);
      assert.equal(reviewedRecords.status,200);
      assert(reviewedRecords.data.data.items.length>0);
      assert(reviewedRecords.data.data.items.every(r=>r.worker_id===assignedGroomerId&&r.shop_id===store2.id));

      assert.equal((await post("/manager/staff-attendance/exports",staffExportBody,ml.data.data.sessionToken)).status,403);

      assert.equal((await get("/manager/workers", ml.data.data.sessionToken)).data.data.length, 0);
      assert.equal((await get(`/manager/attendance/${orgRecordId}/history`, ml.data.data.sessionToken)).status, 200);
      const scopedStoreEdit = await post(`/manager/shops/${store2.id}/profile`, editStoreBody, ml.data.data.sessionToken);
      assert.equal(scopedStoreEdit.status, 200);
      assert.deepEqual((await post(`/manager/shops/${store2.id}/profile`, editStoreBody, ml.data.data.sessionToken)).data, scopedStoreEdit.data);
      assert.equal((await get(`/manager/attendance/${retained.id}/history`, ml.data.data.sessionToken)).status, 403);
      const requestedRecord = (await pool.query("SELECT * FROM attendance_records WHERE id=$1", [orgRecordId])).rows[0];
      const scopedChange = await post("/attendance-adjustments", { operationId: randomUUID(), action: "UPDATE", recordId: orgRecordId,
        expectedVersion: requestedRecord.version, occurredAt: DateTime.fromISO(clockInAt).plus({ minutes: 5 }).toISO() }, unapprovedToken);
      assert.equal(scopedChange.status, 201);
      const storeManagerQueue = (await get(`/manager/validations?month=${currentDay.slice(0, 7)}`, ml.data.data.sessionToken)).data.data;
      assert.ok(storeManagerQueue.some(j => j.id === scopedChange.data.data.adjustmentId));
      const groomerManagerQueue = (await get(`/manager/validations?month=${currentDay.slice(0, 7)}`, secondManagerToken)).data.data;
      assert.ok(groomerManagerQueue.some(j => j.id === scopedChange.data.data.adjustmentId));
      assert.equal((await post(`/manager/validations/${scopedChange.data.data.adjustmentId}/decision`, { operationId: randomUUID(), decision: "APPROVE", expectedRecordVersion: requestedRecord.version + 1 }, ml.data.data.sessionToken)).status, 200);
      const noProfileScope = { ...peopleEdit, operationId: randomUUID(), expectedVersion: peopleRow.version };
      assert.equal((await post(`/manager/accounts/${registered.id}/profile`, noProfileScope, ml.data.data.sessionToken)).status, 403);
      const staleOrgVersion = await organizationVersion();
      assert.equal((await setPermissions(managerId, [], [])).status, 200);
      assert.equal((await post(orgPath + "/permissions", { operationId: randomUUID(), expectedVersion: staleOrgVersion, managerId, shopIds: [], workerIds: [] }, generalToken)).status, 409);
      assert.equal((await get(`/manager/attendance/${orgRecordId}/history`, ml.data.data.sessionToken)).status, 403);
      assert.equal((await post("/manager/reports/pdf", orgReportBody, ml.data.data.sessionToken)).status, 403);
      const pendingManager = await post("/manager/managers", { operationId: randomUUID(), name: "Pending manager", email: `pending-manager-${run}@test.invalid` }, generalToken);
      assert.equal(pendingManager.status, 201);
      const managerJob = (await pool.query("SELECT * FROM email_jobs WHERE account_id=$1", [pendingManager.data.data.accountId])).rows[0];
      const [managerIv, managerTag, managerEncrypted] = managerJob.encrypted_payload.split(".").map(x => Buffer.from(x, "base64"));
      const managerDecipher = createDecipheriv("aes-256-gcm", Buffer.from(process.env.MAIL_ENCRYPTION_KEY, "hex"), managerIv);
      managerDecipher.setAuthTag(managerTag);
      const managerSetupToken = JSON.parse(Buffer.concat([managerDecipher.update(managerEncrypted), managerDecipher.final()]).toString()).token;
      assert.equal((await post("/auth/password-links/consume", { token: managerSetupToken, newPassword: "abcdef" }, null)).data.data.awaitingManagerApproval, true);
      assert.equal((await post(`/manager/accounts/${pendingManager.data.data.accountId}/approve`, { operationId: randomUUID() })).status, 403);
      assert.equal((await post(`/manager/accounts/${pendingManager.data.data.accountId}/approve`, { operationId: randomUUID() }, secondManagerToken)).status, 403);
      const generalQueue = (await get(`/manager/validations?month=${currentDay.slice(0, 7)}`, generalToken)).data.data;
      assert.ok(generalQueue.some(j => j.item_type === "PERSON_APPROVAL" && j.account_id === pendingManager.data.data.accountId));
      const approvedManager = await post(`/manager/accounts/${pendingManager.data.data.accountId}/approve`, { operationId: randomUUID() }, generalToken);
      assert.equal(approvedManager.status, 200);
      assert.equal(approvedManager.data.data.workerId, null);
      assert.equal((await pool.query("SELECT status FROM accounts WHERE id=$1", [pendingManager.data.data.accountId])).rows[0].status, "ACTIVE");
      const appointment = { operationId: randomUUID(), expectedVersion: await organizationVersion(), accountId: secondManager.id };
      assert.equal((await post(orgPath + "/general-manager", appointment, generalToken)).status, 403);
      assert.equal((await post(orgPath + "/general-manager", appointment)).status, 200);
      assert.equal((await pool.query("SELECT count(*) FROM accounts WHERE role='GENERAL_MANAGER' AND status<>'DISABLED'")).rows[0].count, "1");
      assert.equal((await pool.query("SELECT role FROM accounts WHERE id=$1", [generalId])).rows[0].role, "MANAGER");
      assert.equal((await get("/me", generalToken)).status, 401);
      assert.equal((await get("/me", secondManagerToken)).status, 401);
      const newGeneralLogin = await post("/manager/auth/login", { email: secondManager.email, password }, null);
      assert.equal(newGeneralLogin.status, 200);
      assert.equal(newGeneralLogin.data.data.account.role, "GENERAL_MANAGER");
      const newGeneralToken = newGeneralLogin.data.data.sessionToken;
      await assert.rejects(pool.query("INSERT INTO accounts(role,email,password_hash,status,name) VALUES('GENERAL_MANAGER',$1,$2,'ACTIVE','Duplicate GM')", [`duplicate-gm-${run}@test.invalid`, pw]), e => e.code === "23505");
      const demoteManager = await post(orgPath + "/role", { operationId: randomUUID(), expectedVersion: await organizationVersion(), accountId: managerId, role: "WORKER" }, newGeneralToken);
      assert.equal(demoteManager.status, 200);
      const demotedManager = (await pool.query("SELECT * FROM accounts WHERE id=$1", [managerId])).rows[0];
      assert.equal(demotedManager.role, "WORKER");
      assert.match(demotedManager.login_code, /^[1-9]\d{3}$/);
      assert.equal((await get("/me", ml.data.data.sessionToken)).status, 401);
      assert.equal((await post(orgPath + "/role", { operationId: randomUUID(), expectedVersion: await organizationVersion(), accountId: managerId, role: "MANAGER" }, newGeneralToken)).status, 200);
      assert.equal((await pool.query("SELECT login_code FROM accounts WHERE id=$1", [managerId])).rows[0].login_code, demotedManager.login_code);
      assert.equal((await post(orgPath + "/role", { operationId: randomUUID(), expectedVersion: await organizationVersion(), accountId: owner.id, role: "WORKER" }, newGeneralToken)).status, 422);
      apiLimiter.resetKey("127.0.0.1"); // Start a fresh quota for this independent workflow section.
      // Every personal workspace uses the same profile/query/export APIs, independent of management scope.
      const managerAgain = (await post("/manager/auth/login", { email: (await pool.query("SELECT email FROM accounts WHERE id=$1", [managerId])).rows[0].email, password }, null)).data.data.sessionToken;
      const personalIdentities = [[ownerToken, owner.id], [newGeneralToken, secondManager.id], [managerAgain, managerId]];
      for (const [personalToken, accountId] of personalIdentities) {
        assert.equal((await get("/me/stores", personalToken)).status, 200);
        const p = (await get("/me/profile", personalToken)).data.data;
        const saved = await post("/me/profile", { operationId: randomUUID(), expectedVersion: p.version, firstName: "Personal", lastName: "Account", address: "My address", phone: "021123456", preferredShopId: shopCode }, personalToken);
        assert.equal(saved.status, 200);
        assert.equal(saved.data.data.preferredShopId, shopCode);
        const added = await post("/attendance-adjustments", { operationId: randomUUID(), action: "ADD", shopId: shopCode, type: "SIGN_IN", occurredAt: `${currentDay}T01:00:00Z` }, personalToken);
        assert.equal(added.status, 201, JSON.stringify(added.data));
        assert.equal(added.data.data.validationStatus,"APPROVED");
        const ownRecord = (await pool.query("SELECT r.*,w.account_id FROM attendance_records r JOIN workers w ON w.id=r.worker_id WHERE r.id=$1", [added.data.data.recordId])).rows[0];
        assert.equal(ownRecord.account_id, accountId);
        const day = DateTime.fromISO(`${currentDay}T01:00:00Z`).setZone("Pacific/Auckland").toISODate();
        const queried = await get(`/attendance?shopId=${shopCode}&fromDate=${day}&toDate=${day}`, personalToken);
        assert.equal(queried.status, 200);
        assert(queried.data.data.items.some(r => r.id === ownRecord.id));
        assert.equal(queried.data.data.dailyHours[0].valid, false);
        assert.equal(queried.data.data.dailyHours[0].hours, null);
        const exportResult = await post("/attendance/exports", { operationId: randomUUID(), shopId: shopCode, fromDate: day, toDate: day, records: [{id: ownRecord.id, version: ownRecord.version}] }, personalToken);
        assert.equal(exportResult.status, 202);
        const job = (await pool.query("SELECT * FROM attendance_export_jobs WHERE id=$1", [exportResult.data.data.exportId])).rows[0];
        assert.equal(job.recipient_email, p.email);
        const secondStoreAdd = await post("/attendance-adjustments", {operationId:randomUUID(),action:"ADD",shopId:code2,type:"SIGN_OUT",occurredAt:`${currentDay}T02:00:00Z`}, personalToken);
        assert.equal(secondStoreAdd.status,201);
        const allStores = await get(`/attendance?fromDate=${day}&toDate=${day}`,personalToken);
        assert.equal(allStores.status,200);
        assert.equal(allStores.data.data.items.length,2);
        assert.equal(new Set(allStores.data.data.items.map(r => r.shop_id)).size,2);
        const multiStores=await get(`/attendance?fromDate=${day}&toDate=${day}&shopIds=${shopCode},${code2}`,personalToken);
        assert.equal(multiStores.status,200);
        assert.equal(multiStores.data.data.items.length,2);
        assert.equal(multiStores.data.data.dailyHours.length,2);
        assert.equal(new Set(multiStores.data.data.dailyHours.map(day=>day.shopCode)).size,2);
        const oneStore=await get(`/attendance?fromDate=${day}&toDate=${day}&shopIds=${shopCode}`,personalToken);
        assert.equal(oneStore.data.data.items.length,1);
        const multiStoreExport=await post("/attendance/exports",{operationId:randomUUID(),shopIds:[shopCode,code2],fromDate:day,toDate:day,records:multiStores.data.data.items.map(r=>({id:r.id,version:r.version}))},personalToken);
        assert.equal(multiStoreExport.status,202);

        assert.equal(allStores.data.data.dailyHours[0].valid,false); // Cannot pair across stores.
        assert(allStores.data.data.items.every(r => r.shop_name && r.shop_code));
        const allExport = await post("/attendance/exports",{operationId:randomUUID(),fromDate:day,toDate:day,records:allStores.data.data.items.map(r => ({id:r.id,version:r.version}))},personalToken);
        assert.equal(allExport.status,202);
        const allJob = (await pool.query("SELECT * FROM attendance_export_jobs WHERE id=$1",[allExport.data.data.exportId])).rows[0];
        assert.equal(allJob.snapshot_data.shopName,"All stores");
        assert.equal(allJob.snapshot_data.records.length,2);
        assert.equal(allJob.recipient_email,p.email);

        const foreignEdit = await post("/attendance-adjustments", { operationId: randomUUID(), action: "DELETE", recordId: orgRecordId, expectedVersion: 1 }, personalToken);
        assert.equal(foreignEdit.status, 403);
        assert.equal((await get(`/attendance?shopId=${shopCode}&workerId=${(await pool.query("SELECT a.login_code FROM accounts a JOIN workers w ON w.account_id=a.id WHERE w.id=$1", [assignedGroomerId])).rows[0].login_code}&fromDate=${day}&toDate=${day}`, personalToken)).status, 403);
        const selfQuery=await get(`/manager/staff-attendance?fromDate=${day}&toDate=${day}&workerId=${p.accountId || "__self__"}`,personalToken);
        assert.equal(selfQuery.status,200);
        assert(selfQuery.data.data.items.some(r=>r.id===ownRecord.id));
        const selfChanged=await post(`/manager/attendance/${ownRecord.id}/corrections`,{operationId:randomUUID(),expectedRecordVersion:ownRecord.version,occurredAt:ownRecord.effective_occurred_at,type:"SIGN_OUT"},personalToken);
        assert.equal(selfChanged.status,200);
        const selfChangedAgain=await post("/attendance-adjustments",{operationId:randomUUID(),action:"UPDATE",recordId:ownRecord.id,expectedVersion:selfChanged.data.data.version,occurredAt:ownRecord.effective_occurred_at,type:"SIGN_IN"},personalToken);
        assert.equal(selfChangedAgain.status,201);
        assert.equal(selfChangedAgain.data.data.validationStatus,"APPROVED");
        const selfDeleted=await post("/manager/attendance-adjustments",{operationId:randomUUID(),action:"DELETE",recordId:ownRecord.id,expectedVersion:selfChangedAgain.data.data.version},personalToken);
        assert.equal(selfDeleted.status,201);
        assert.equal(selfDeleted.data.data.validationStatus,"APPROVED");
        assert.equal((await pool.query("SELECT count(*) FROM attendance_adjustments WHERE record_id=$1 AND status='PENDING'",[ownRecord.id])).rows[0].count,"0");
        assert.equal((await pool.query("SELECT confirmed_deleted FROM attendance_records WHERE id=$1",[ownRecord.id])).rows[0].confirmed_deleted,true);
        const ownHistory=await get(`/manager/attendance/${ownRecord.id}/history`,personalToken);
        assert.equal(ownHistory.status,200);
        assert(ownHistory.data.data.history.length>=4);

      }
      // Retention removes files, never attendance evidence or photo references.
      const storageKey = id => `photos/${owner.id}/${id}.jpeg`;
      const oldCloudId=randomUUID(), recentCloudId=randomUUID(), missingLocalId=randomUUID();
      await pool.query("INSERT INTO photos(id,uploaded_by_account_id,storage_key,status,created_at) VALUES($1,$2,$3,'READY',now()-interval '4 months'),($4,$2,$5,'READY',now()-interval '2 months'),($6,$2,$7,'READY',now()-interval '4 months')",[oldCloudId,owner.id,storageKey(oldCloudId),recentCloudId,storageKey(recentCloudId),missingLocalId,'local:'+storageKey(missingLocalId)]);
      let existingPhoto, links;
      if(photoId){
        existingPhoto=(await pool.query("SELECT * FROM photos WHERE id=$1",[photoId])).rows[0];
        await access(localPhotoPath(existingPhoto.storage_key));
        links=(await pool.query("SELECT id,photo_id,original_occurred_at FROM attendance_records WHERE photo_id=$1",[photoId])).rows;
        await pool.query("UPDATE photos SET created_at=now()-interval '4 months' WHERE id=$1",[photoId]);
      }
      const failedRetention=await processPhotoRetention({bucket:'fake-photo-bucket',s3Client:{send:async()=>{throw Object.assign(new Error('Simulated storage failure'),{code:'TEST_STORAGE_FAILURE'});}}});
      assert.equal(failedRetention.failed,1);
      assert.equal((await pool.query("SELECT status FROM photos WHERE id=$1",[oldCloudId])).rows[0].status,'READY');
      assert.equal((await pool.query("SELECT status FROM photos WHERE id=$1",[recentCloudId])).rows[0].status,'READY');
      assert.equal((await pool.query("SELECT status FROM photos WHERE id=$1",[missingLocalId])).rows[0].status,'EXPIRED');
      if(photoId){
        await assert.rejects(access(localPhotoPath(existingPhoto.storage_key)),e=>e.code==='ENOENT');
        const expired=(await pool.query("SELECT status,deleted_at FROM photos WHERE id=$1",[photoId])).rows[0];
        assert.equal(expired.status,'EXPIRED');assert(expired.deleted_at);
        assert.deepEqual((await pool.query("SELECT id,photo_id,original_occurred_at FROM attendance_records WHERE photo_id=$1",[photoId])).rows,links);
        assert.equal((await get(`/photos/${photoId}`)).status,410);
      }
      const deletedObjects=[];
      const cloud={send:async command=>{deletedObjects.push(command.input);await new Promise(resolve=>setTimeout(resolve,25));return {};}};
      const parallelRetention=await Promise.all([processPhotoRetention({bucket:'fake-photo-bucket',s3Client:cloud}),processPhotoRetention({bucket:'fake-photo-bucket',s3Client:cloud})]);
      assert.equal(parallelRetention.reduce((sum,r)=>sum+r.deleted,0),1);
      assert.deepEqual(deletedObjects,[{Bucket:'fake-photo-bucket',Key:storageKey(oldCloudId)}]);
      assert.equal((await pool.query("SELECT count(*) FROM audit_logs WHERE action='PHOTO_EXPIRED' AND resource_id=$1",[oldCloudId])).rows[0].count,'1');
      assert.equal((await processPhotoRetention({bucket:'fake-photo-bucket',s3Client:cloud})).deleted,0);
    } finally {
      await new Promise((r) => server.close(r));
      await pool.end();
    }
  },
);
