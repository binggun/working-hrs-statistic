import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createDecipheriv } from "node:crypto";
import argon2 from "argon2";
import sharp from "sharp";
import { DateTime } from "luxon";
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
      assert.equal(correction.data.data.validationStatus, "PENDING");
      const pendingCorrection = (await pool.query("SELECT * FROM attendance_records WHERE id=$1", [sign.data.data.recordId])).rows[0];
      assert.notEqual(new Date(pendingCorrection.confirmed_occurred_at).toISOString(), "2026-10-06T20:30:00.000Z");
      assert.equal((await pool.query("SELECT count(*) FROM attendance_validations WHERE adjustment_id=$1", [correction.data.data.adjustmentId])).rows[0].count, "0");
      assert.equal((await post("/manager/validations/" + correction.data.data.adjustmentId + "/decision", {
        operationId: randomUUID(), expectedRecordVersion: pendingCorrection.version, decision: "APPROVE",
      })).status, 200);

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
      assert.ok(sharedPeople.data.data.some((person) => person.accountId === accountId));
      const sharedInvitations = await get("/manager/invitations", ml.data.data.sessionToken);
      assert.equal(sharedInvitations.status, 200);
      assert.ok(sharedInvitations.data.data.some((invitation) =>
        people.data.data.some((person) => person.accountId === invitation.accountId)
      ));
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
      assert.equal((await post("/me/preferences", { preferredShopId: shopCode }, ml.data.data.sessionToken)).status, 403);
      assert.equal((await post("/me/preferences", { preferredShopId: null }, employeeToken)).status, 200);
      assert.equal((await get("/me", employeeToken)).data.data.preferredShopId, null);

      assert.equal((await get("/me", employeeToken)).data.data.role, "WORKER");
      assert.equal((await get("/manager/workers", employeeToken)).status, 403);
      assert.equal((await get("/shops", employeeToken)).status, 200);
      const employeeQuery = `/attendance?shopId=${shopCode}&fromDate=2026-10-01&toDate=2026-10-31`;
      const ownRecords = await get(employeeQuery, employeeToken);
      assert.equal(ownRecords.status, 200);
      const editable = ownRecords.data.data.items.find((r) => r.id === sign.data.data.recordId);
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
        expectedVersion: afterEdit.version }, employeeToken)).status, 409);
      // Real mobile flow: same-day parity, local photo upload and idempotent submission.
      const statusPath = `/attendance/status?shopId=${shopCode}`;
      const initialStatus = await get(statusPath, employeeToken);
      assert.equal(initialStatus.status, 200);
      assert.equal(initialStatus.data.data.dailyCount, 0);
      assert.equal(initialStatus.data.data.nextAction, "SIGN_IN");
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
      assert.equal(afterClockIn.nextAction, "SIGN_OUT");
      assert.equal((await post("/attendance", { ...todaySign, operationId: randomUUID() }, employeeToken)).status, 409);
      const clockOut = { operationId: randomUUID(), workerId: workerCode, shopId: shopCode, type: "SIGN_OUT",
        occurredAt: DateTime.fromISO(clockInAt).plus({ hours: 8 }).toISO(), expectedDailyCount: 1,
        offline: false, cameraStatus: "UNAVAILABLE",
        location: { status: "UNAVAILABLE" } };
      assert.equal((await post("/attendance", { ...clockOut, type: "SIGN_IN" }, employeeToken)).status, 409);
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
      const noLocationBody = { ...clockOut, operationId: randomUUID(), expectedDailyCount: 3,
        occurredAt: DateTime.fromISO(clockOut.occurredAt).plus({ hours: 2 }).toISO() };
      delete noLocationBody.location;
      const noLocationResponse = await post("/attendance", noLocationBody, employeeToken);
      assert.equal(noLocationResponse.status, 201);
      const noLocationRecord = (await pool.query("SELECT location FROM attendance_records WHERE id=$1", [noLocationResponse.data.data.recordId])).rows[0];
      assert.deepEqual(noLocationRecord.location, { status: "UNAVAILABLE" });

      assert.equal(afterClockOut.nextAction, "SIGN_IN");
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
      const newPassword = "updated-test-password-" + run;
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
      assert.ok(!(await get(removedQuery, employeeToken)).data.data.items.some((r) => r.id === retained.id));
      const ownerListPath = `/manager/attendance?shopId=${shopCode}&month=${currentDay.slice(0, 7)}&limit=100`;
      const ownerRemoved = (await get(ownerListPath)).data.data.items.find((r) => r.id === retained.id);
      assert.equal(ownerRemoved.record_status, "removal");
      assert.ok(!(await get(ownerListPath, ml.data.data.sessionToken)).data.data.items.some((r) => r.id === retained.id));
      assert.equal((await post(`/manager/attendance/${retained.id}/corrections`, {
        operationId: randomUUID(), expectedRecordVersion: retained.version, occurredAt: clockInAt })).status, 409);
      assert.equal((await post("/manager/validations/" + removed.data.data.adjustmentId + "/decision", {
        operationId: randomUUID(), decision: "REJECT", expectedRecordVersion: retained.version })).status, 200);
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
        operationId: randomUUID(), decision: "APPROVE", expectedRecordVersion: retained.version })).status, 200);
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
      assert.equal((await post("/manager/attendance-adjustments", { ...addBody, operationId: randomUUID(), workerId: workerCode, shopId: code2 }, ml.data.data.sessionToken)).status, 403);
      const managerAdd = await post("/manager/attendance-adjustments", { ...addBody, operationId: randomUUID(), workerId: workerCode }, ml.data.data.sessionToken);
      assert.equal(managerAdd.status, 201);
      assert.equal((await pool.query("SELECT source FROM attendance_adjustments WHERE id=$1", [managerAdd.data.data.adjustmentId])).rows[0].source, "MANAGER_EDIT");
    } finally {
      await new Promise((r) => server.close(r));
      await pool.end();
    }
  },
);
