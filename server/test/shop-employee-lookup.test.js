import test from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { pool } from '../src/db.js';
import { app } from '../src/app.js';

test('Shop employee lookup requires the owning shop and an active approved worker', {skip: !process.env.TEST_DATABASE_URL}, async () => {
  assert.ok(new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test'));
  await pool.query('TRUNCATE accounts CASCADE');
  const hash = await argon2.hash('lookup-test-password');
  const shop = (await pool.query("INSERT INTO accounts(role,login_code,name,password_hash,status) VALUES('SHOP','0001','Lookup shop',$1,'ACTIVE') RETURNING id", [hash])).rows[0];
  await pool.query("INSERT INTO shops(account_id,name,address,latitude,longitude) VALUES($1,'Lookup shop','Test',0,0)", [shop.id]);
  const worker = (await pool.query("INSERT INTO accounts(role,login_code,name,email,password_hash,status,requires_manager_approval) VALUES('WORKER','1234','Real Employee','lookup-worker@test.invalid',$1,'ACTIVE',false) RETURNING id", [hash])).rows[0];
  await pool.query('INSERT INTO workers(account_id) VALUES($1)', [worker.id]);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function get(path, token) {
    return fetch(base + path, {headers: token ? {Authorization: `Bearer ${token}`} : {}});
  }
  try {
    assert.equal((await get('/shops/0001/employees/1234')).status, 401);
    const login = await fetch(base + '/auth/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({accountId: '0001', password: '123456'})});
    assert.equal(login.status, 200);
    const token = (await login.json()).data.sessionToken;
    const result = await get('/shops/0001/employees/1234', token);
    assert.equal(result.status, 200);
    assert.deepEqual((await result.json()).data, {shopId: '0001', workerId: '1234', name: 'Real Employee'});
    assert.equal((await get('/shops/0001/employees/9999', token)).status, 404);
    assert.equal((await get('/shops/0001/employees/abc', token)).status, 422);
    await pool.query("UPDATE accounts SET status='DISABLED' WHERE id=$1", [worker.id]);
    assert.equal((await get('/shops/0001/employees/1234', token)).status, 404);
    await pool.query("UPDATE accounts SET status='ACTIVE',requires_manager_approval=true WHERE id=$1", [worker.id]);
    assert.equal((await get('/shops/0001/employees/1234', token)).status, 403);
    const other = (await pool.query("INSERT INTO accounts(role,login_code,name,password_hash,status) VALUES('SHOP','0002','Other shop',$1,'ACTIVE') RETURNING id", [hash])).rows[0];
    await pool.query("INSERT INTO shops(account_id,name,address,latitude,longitude) VALUES($1,'Other shop','Test',0,0)", [other.id]);
    assert.equal((await get('/shops/0002/employees/1234', token)).status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
});
