import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import argon2 from 'argon2';
import sharp from 'sharp';
import {pool} from '../src/db.js';
import {app} from '../src/app.js';

test('Store selfie upload, attendance, retry and real record query stay scoped to the signed-in store', {skip:!process.env.TEST_DATABASE_URL}, async()=>{
 assert.ok(new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test'));
 await pool.query('TRUNCATE accounts CASCADE');
 const password=await argon2.hash('test-worker-password');
 for(const [code,name] of [['0001','Store A'],['0002','Store B']]){
  const a=(await pool.query("INSERT INTO accounts(role,login_code,name,password_hash,status) VALUES('SHOP',$1,$2,$3,'ACTIVE') RETURNING id",[code,name,password])).rows[0];
  await pool.query("INSERT INTO shops(account_id,name,address,latitude,longitude) VALUES($1,$2,'Test',0,0)",[a.id,name]);
 }
 const worker=(await pool.query("INSERT INTO accounts(role,login_code,email,name,password_hash,status,requires_manager_approval) VALUES('WORKER','1234','store-worker@test.invalid','Store Worker',$1,'ACTIVE',false) RETURNING id",[password])).rows[0];
 await pool.query('INSERT INTO workers(account_id) VALUES($1)',[worker.id]);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}/api/v1`;
 let token;
 async function request(path,body){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};}
 try{
  const login=await request('/auth/login',{accountId:'0001',password:'123456'});assert.equal(login.status,200);token=login.data.data.sessionToken;
  const status=(await request('/attendance/status?shopId=0001&workerId=1234')).data.data;
  assert.equal(status.dailyCount,0);assert.equal(status.requiresPlannedStart,true);
  const png=await sharp({create:{width:16,height:16,channels:3,background:'#88aa99'}}).png().toBuffer();
  const photoOperation=randomUUID();
  async function upload(){const form=new FormData();form.set('operationId',photoOperation);form.set('file',new Blob([png],{type:'image/png'}),'selfie.png');const response=await fetch(base+'/photos',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form});assert.equal(response.status,201);return (await response.json()).data.photoId;}
  const photoId=await upload();assert.equal(await upload(),photoId);
  const body={operationId:randomUUID(),shopId:'0001',workerId:'1234',type:'SIGN_IN',occurredAt:status.serverTime,plannedStartAt:status.serverTime,expectedDailyCount:0,offline:false,cameraStatus:'AVAILABLE',photoId};
  const signed=await request('/attendance',body);assert.equal(signed.status,201,JSON.stringify(signed.data));assert.equal(signed.data.data.dailyCount,1);
  assert.equal((await request('/attendance',body)).data.data.recordId,signed.data.data.recordId);
  const query=await request(`/attendance?shopId=0001&workerId=1234&fromDate=${status.localDate}&toDate=${status.localDate}`);
  assert.equal(query.status,200);assert.equal(query.data.data.items.length,1);assert.equal(query.data.data.items[0].photo_id,photoId);assert.equal(query.data.data.items[0].source,'SHOP_DEVICE');
  assert.equal((await request('/attendance',{...body,operationId:randomUUID(),shopId:'0002'})).status,403);
  assert.equal((await request('/attendance',{...body,operationId:randomUUID(),shopId:'0099'})).status,422);
  assert.equal((await request('/attendance',{...body,operationId:randomUUID(),type:'SIGN_OUT',plannedStartAt:undefined})).status,409);
  assert.equal((await request('/attendance',{...body,operationId:randomUUID(),expectedDailyCount:1,photoId:undefined})).status,422);
  const edit=await request('/attendance-adjustments',{operationId:randomUUID(),action:'UPDATE',recordId:signed.data.data.recordId,expectedVersion:1,type:'SIGN_IN',occurredAt:status.serverTime});
  assert.equal(edit.status,201,JSON.stringify(edit.data));assert.equal(edit.data.data.validationStatus,'PENDING');
  const changed=await request(`/attendance?shopId=0001&workerId=1234&fromDate=${status.localDate}&toDate=${status.localDate}`);assert.equal(changed.data.data.items[0].pending,true);
 }finally{await new Promise(r=>server.close(r));await pool.end();}
});
