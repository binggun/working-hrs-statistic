import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createDecipheriv} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import argon2 from 'argon2';
import {pool} from '../src/db.js';
import {app} from '../src/app.js';

test('Owner invitations activate without a GM; other creators and self-registration still require approval', {skip:!process.env.TEST_DATABASE_URL}, async()=>{
  assert.ok(new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test'));
  await pool.query('TRUNCATE accounts CASCADE');
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/v1`;
  const password='owner-test-password';
  async function request(path,body,token){
    const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:(await response.json()).data};
  }
  async function setup(accountId){
    const job=(await pool.query('SELECT encrypted_payload FROM email_jobs WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1',[accountId])).rows[0];
    const [iv,tag,payload]=job.encrypted_payload.split('.').map(v=>Buffer.from(v,'base64'));
    const decipher=createDecipheriv('aes-256-gcm',Buffer.from(process.env.MAIL_ENCRYPTION_KEY,'hex'),iv);
    decipher.setAuthTag(tag);
    const token=JSON.parse(Buffer.concat([decipher.update(payload),decipher.final()]).toString()).token;
    return request('/auth/password-links/consume',{token,newPassword:password});
  }
  try {
    const owner=(await pool.query("INSERT INTO accounts(role,email,name,password_hash,status) VALUES('SUPER_MANAGER','owner@test.invalid','Owner',$1,'ACTIVE') RETURNING id",[await argon2.hash(password)])).rows[0];
    const login=await request('/manager/auth/login',{email:'owner@test.invalid',password});
    assert.equal(login.status,200);
    const token=login.data.sessionToken;
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM accounts WHERE role='GENERAL_MANAGER'")).rows[0].n,0);
    let managerId;
    for(const kind of ['managers','workers']){
      const email=kind+'@test.invalid';
      const created=await request('/manager/'+kind,{operationId:randomUUID(),name:'Owner invited '+kind,email},token);
      assert.equal(created.status,201);
      assert.equal(created.data.requiresManagerApproval,false);
      const before=(await pool.query('SELECT * FROM accounts WHERE id=$1',[created.data.accountId])).rows[0];
      assert.equal(before.status,'PENDING');
      assert.equal(before.requires_manager_approval,false);
      assert.equal(before.approved_by_account_id,owner.id);
      const activated=await setup(before.id);
      assert.equal(activated.status,200);
      assert.equal(activated.data.activated,true);
      assert.equal(activated.data.awaitingManagerApproval,false);
      const signedIn=await request('/'+(kind==='managers'?'manager/':'')+'auth/login',{email,password});
      assert.equal(signedIn.status,200);
      assert.equal(signedIn.data.account.attendanceEnabled,true);
      if(kind==='managers')managerId=before.id;
    }
    // The Owner can appoint the newly activated manager without an existing GM.
    const org=await request('/manager/organization',null,token);
    const appointed=await request('/manager/organization/general-manager',{operationId:randomUUID(),expectedVersion:org.data.version,accountId:managerId},token);
    assert.equal(appointed.status,200);
    const gmLogin=await request('/manager/auth/login',{email:'managers@test.invalid',password});
    assert.equal(gmLogin.data.account.role,'GENERAL_MANAGER');
    for(const kind of ['workers','managers']){
      const result=await request('/manager/'+kind,{operationId:randomUUID(),name:'GM invite',email:'gm-'+kind+'@test.invalid'},gmLogin.data.sessionToken);
      assert.equal(result.status,201);
      assert.equal(result.data.requiresManagerApproval,true);
      const setupResult=await setup(result.data.accountId);
      assert.equal(setupResult.data.awaitingManagerApproval,true);
      assert.equal((await pool.query('SELECT status FROM accounts WHERE id=$1',[result.data.accountId])).rows[0].status,'PENDING');
    }
    const self=await request('/auth/register',{email:'self@test.invalid',confirmEmail:'self@test.invalid'});
    assert.equal(self.status,202);
    const selfAccount=(await pool.query("SELECT * FROM accounts WHERE email='self@test.invalid'")).rows[0];
    assert.equal(selfAccount.requires_manager_approval,true);
    const forged=await request('/manager/workers',{operationId:randomUUID(),name:'Forged exemption',email:'forged@test.invalid',requiresManagerApproval:false},gmLogin.data.sessionToken);
    assert.equal(forged.status,201);
    assert.equal(forged.data.requiresManagerApproval,true);
    assert.equal((await pool.query('SELECT requires_manager_approval FROM accounts WHERE id=$1',[forged.data.accountId])).rows[0].requires_manager_approval,true);
    // Repair historical Owner invitations without affecting self-registrations.
    const legacy=await request('/manager/managers',{operationId:randomUUID(),name:'Legacy owner invitation',email:'legacy@test.invalid'},token);
    await setup(legacy.data.accountId);
    await pool.query("UPDATE accounts SET status='PENDING',requires_manager_approval=true,approved_at=NULL,approved_by_account_id=NULL WHERE id=$1",[legacy.data.accountId]);
    await pool.query(await readFile(new URL('../migrations/017.sql',import.meta.url),'utf8'));
    const repaired=(await pool.query('SELECT * FROM accounts WHERE id=$1',[legacy.data.accountId])).rows[0];
    assert.equal(repaired.status,'ACTIVE');
    assert.equal(repaired.requires_manager_approval,false);
    assert.equal(repaired.approved_by_account_id,owner.id);
    assert.equal((await pool.query('SELECT requires_manager_approval FROM accounts WHERE id=$1',[selfAccount.id])).rows[0].requires_manager_approval,true);
  } finally {await new Promise(resolve=>server.close(resolve));await pool.end();}
});
