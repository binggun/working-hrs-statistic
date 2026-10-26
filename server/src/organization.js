export function mountOrganization(app, { z, uuid, pool, transaction, idem, fail, audit, encrypt, randomInt, geocodeAddress, assertShop }) {
  const admin = req => { if (!["SUPER_MANAGER", "GENERAL_MANAGER"].includes(req.account.role)) fail(403, "Company administrator required"); };
  async function revision(c, expected) {
    const row = (await c.query("SELECT version FROM organization_state WHERE id=true FOR UPDATE")).rows[0];
    if (row.version !== expected) fail(409, "Organization changed; reload before saving");
  }
  async function finish(c, req, action, id, data) {
    const row = (await c.query("UPDATE organization_state SET version=version+1 WHERE id=true RETURNING version")).rows[0];
    await audit(c, req.account, action, id, null, data);
    return { ...data, version: row.version };
  }
  app.get("/api/v1/manager/organization", async (req, res) => {
    admin(req);
    const data = await transaction(async c => {
      await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const people = (await c.query(`SELECT a.id,a.role,a.name,a.email,a.status,a.login_code AS "employeeCode",(a.password_hash IS NOT NULL) AS "passwordSet",w.id AS "workerId" FROM accounts a LEFT JOIN workers w ON w.account_id=a.id WHERE a.role IN('WORKER','MANAGER','GENERAL_MANAGER') ORDER BY a.name`)).rows;
    const shops = (await c.query(`SELECT s.id,s.name,a.login_code AS code FROM shops s JOIN accounts a ON a.id=s.account_id ORDER BY s.name`)).rows;
    const assignments = (await c.query(`SELECT a.id AS "managerId",ARRAY(SELECT shop_id FROM account_shops WHERE account_id=a.id) AS "shopIds",ARRAY(SELECT worker_id FROM manager_workers WHERE manager_account_id=a.id) AS "workerIds" FROM accounts a WHERE a.role='MANAGER' AND a.status<>'DISABLED'`)).rows;
    return { people, shops, assignments, version: (await c.query("SELECT version FROM organization_state WHERE id=true")).rows[0].version };
    });
    res.json({ data });
  });
  app.post("/api/v1/manager/organization/permissions", async (req, res) => {
    admin(req);
    const b = z.object({ operationId: uuid, expectedVersion: z.number().int().positive(), managerId: uuid,
      shopIds: z.array(uuid).max(100), workerIds: z.array(uuid).max(9000) }).strict().parse(req.body);
    const data = await transaction(c => idem(c, req.account, b, "ORGANIZATION_PERMISSIONS", async () => {
      await revision(c, b.expectedVersion);
      const manager = (await c.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [b.managerId])).rows[0];
      if (!manager || manager.role !== "MANAGER" || manager.status === "DISABLED") fail(422, "Choose a manager");
      const shopIds = [...new Set(b.shopIds)], workerIds = [...new Set(b.workerIds)];
      if ((await c.query("SELECT id FROM shops WHERE id=ANY($1::uuid[])", [shopIds])).rowCount !== shopIds.length) fail(422, "Unknown store");
      if ((await c.query("SELECT w.id FROM workers w JOIN accounts a ON a.id=w.account_id WHERE w.id=ANY($1::uuid[]) AND a.role='WORKER'", [workerIds])).rowCount !== workerIds.length) fail(422, "Unknown groomer");
      await c.query("DELETE FROM account_shops WHERE account_id=$1", [b.managerId]);
      await c.query("INSERT INTO account_shops(account_id,shop_id) SELECT $1,unnest($2::uuid[])", [b.managerId, shopIds]);
      await c.query("DELETE FROM manager_workers WHERE manager_account_id=$1", [b.managerId]);
      await c.query("INSERT INTO manager_workers(manager_account_id,worker_id) SELECT $1,unnest($2::uuid[])", [b.managerId, workerIds]);
      return finish(c, req, "MANAGER_PERMISSIONS_CHANGED", b.managerId, { managerId: b.managerId, shopIds, workerIds });
    }));
    res.json({ data });
  });
  app.post("/api/v1/manager/organization/general-manager", async (req, res) => {
    if (req.account.role !== "SUPER_MANAGER") fail(403, "Only Owner can appoint the General manager");
    const b = z.object({ operationId: uuid, expectedVersion: z.number().int().positive(), accountId: uuid }).strict().parse(req.body);
    const data = await transaction(c => idem(c, req.account, b, "GENERAL_MANAGER_APPOINTMENT", async () => {
      await revision(c, b.expectedVersion);
      const person = (await c.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [b.accountId])).rows[0];
      if (!person || !["MANAGER", "GENERAL_MANAGER"].includes(person.role) || person.status === "DISABLED" || !person.password_hash) fail(422, "The selected manager must set a password first");
      const old = (await c.query("UPDATE accounts SET role='MANAGER' WHERE role='GENERAL_MANAGER' AND id<>$1 RETURNING id", [person.id])).rows;
      await c.query("UPDATE accounts SET role='GENERAL_MANAGER',status='ACTIVE',approved_at=COALESCE(approved_at,now()),approved_by_account_id=COALESCE(approved_by_account_id,$2) WHERE id=$1", [person.id, req.account.id]);
      await c.query("UPDATE sessions SET revoked_at=now() WHERE account_id=ANY($1::uuid[]) AND revoked_at IS NULL", [[person.id, ...old.map(r => r.id)]]);
      if (person.status === "PENDING") await c.query("INSERT INTO email_jobs(account_id,recipient_email,encrypted_payload,kind) VALUES($1,$2,$3,'ACCOUNT_APPROVED')", [person.id, person.email, encrypt({ name: person.name, role: "GENERAL_MANAGER", employeeCode: person.login_code })]);
      return finish(c, req, "GENERAL_MANAGER_APPOINTED", person.id, { accountId: person.id });
    }));
    res.json({ data });
  });
  app.post("/api/v1/manager/organization/role", async (req, res) => {
    admin(req);
    const b = z.object({ operationId: uuid, expectedVersion: z.number().int().positive(), accountId: uuid, role: z.enum(["MANAGER", "WORKER"]) }).strict().parse(req.body);
    const data = await transaction(c => idem(c, req.account, b, "ORGANIZATION_ROLE", async () => {
      await revision(c, b.expectedVersion);
      await c.query("SELECT pg_advisory_xact_lock(820013)");
      const person = (await c.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [b.accountId])).rows[0];
      if (!person || !["MANAGER", "WORKER"].includes(person.role) || person.status === "DISABLED") fail(422, "Choose a manager or groomer");
      let code = person.login_code;
      if (b.role === "WORKER") {
        if ((!code || !/^[1-9][0-9]{3}$/.test(code)) && person.status === "ACTIVE") {
          const used = new Set((await c.query("SELECT login_code FROM accounts WHERE login_code ~ '^[1-9][0-9]{3}$'")).rows.map(r => r.login_code));
          const available = Array.from({ length: 9000 }, (_, i) => String(i + 1000)).filter(v => !used.has(v));
          if (!available.length) fail(409, "Employee IDs exhausted");
          code = available[randomInt(available.length)];
        }
        if (person.status !== "ACTIVE" && code && !/^[1-9][0-9]{3}$/.test(code)) code = null;
        await c.query("INSERT INTO workers(account_id,contact,address) VALUES($1,$2,$3) ON CONFLICT(account_id) DO NOTHING", [person.id, person.profile_phone, person.profile_address]);
        await c.query("DELETE FROM account_shops WHERE account_id=$1", [person.id]);
        await c.query("DELETE FROM manager_workers WHERE manager_account_id=$1", [person.id]);
      } else await c.query("DELETE FROM manager_workers WHERE worker_id IN(SELECT id FROM workers WHERE account_id=$1)", [person.id]);
      await c.query("UPDATE accounts SET role=$2,login_code=$3,profile_version=profile_version+1 WHERE id=$1", [person.id, b.role, code]);
      await c.query("UPDATE sessions SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL", [person.id]);
      return finish(c, req, "PERSON_ROLE_CHANGED", person.id, { accountId: person.id, role: b.role });
    }));
    res.json({ data });
  });
  app.post("/api/v1/manager/shops/:id/profile", async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = z.object({ operationId: uuid, expectedVersion: z.number().int().positive(), name: z.string().trim().min(1).max(200), address: z.string().trim().min(1).max(500) }).strict().parse(req.body);
    await assertShop(pool, req.account, id);
    const data = await transaction(c => idem(c, req.account, { ...b, id }, "SHOP_PROFILE", async () => {
      await assertShop(c, req.account, id);
      const shop = (await c.query("SELECT * FROM shops WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!shop) fail(404, "Store not found");
      if (shop.profile_version !== b.expectedVersion) fail(409, "Store changed; reload");
      const coordinates = b.address === shop.address ? { latitude: shop.latitude, longitude: shop.longitude } : await geocodeAddress(b.address);
      await c.query("UPDATE shops SET name=$2,address=$3,latitude=$4,longitude=$5,profile_version=profile_version+1 WHERE id=$1", [id, b.name, b.address, coordinates.latitude, coordinates.longitude]);
      await c.query("UPDATE accounts SET name=$2 WHERE id=$1", [shop.account_id, b.name]);
      await audit(c, req.account, "SHOP_PROFILE_CHANGED", id, { name: shop.name, address: shop.address }, b);
      return { id, version: shop.profile_version + 1 };
    }));
    res.json({ data });
  });
}
