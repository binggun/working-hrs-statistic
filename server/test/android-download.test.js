import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {mountAndroidDownload} from '../src/android-download.js';
test('Public Android download serves pinned APK bytes, metadata and range requests safely',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'pawhub-apk-')),previous=process.env.ANDROID_APK_DIR;
 process.env.ANDROID_APK_DIR=directory;
 const app=express();mountAndroidDownload(app);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${server.address().port}/api/v1/downloads/android`;
 try{
  assert.equal((await (await fetch(base)).json()).data.available,false);
  const apk=Buffer.from('PK-test-android-apk-content'),sha256=createHash('sha256').update(apk).digest('hex');
  await writeFile(path.join(directory,sha256+'.apk'),apk);
  await writeFile(path.join(directory,'android.json'),JSON.stringify({sha256,sizeBytes:apk.length,versionName:'1.0',versionCode:1}));
  const response=await fetch(base),metadata=(await response.json()).data;
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(metadata.available,true);assert.equal(metadata.versionName,'1.0');
  assert.equal(metadata.downloadPath,`/api/v1/downloads/android/apk?sha256=${sha256}`);
  const download=await fetch(base+'/apk?sha256='+sha256);
  assert.equal(download.status,200);assert.match(download.headers.get('content-type'),/application\/vnd.android.package-archive/);
  assert.match(download.headers.get('content-disposition'),/pawhub-signin-app\.apk/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),apk);
  const partial=await fetch(base+'/apk?sha256='+sha256,{headers:{Range:'bytes=0-3'}});
  assert.equal(partial.status,206);assert.deepEqual(Buffer.from(await partial.arrayBuffer()),apk.subarray(0,4));
  assert.equal((await fetch(base+'/apk?sha256=../../.env')).status,400);
  assert.equal((await fetch(base+'/apk?sha256='+'a'.repeat(64))).status,404);
  await writeFile(path.join(directory,'android.json'),JSON.stringify({sha256:'b'.repeat(64),sizeBytes:10}));
  assert.equal((await (await fetch(base)).json()).data.available,false);
  assert.deepEqual(Buffer.from(await (await fetch(base+'/apk?sha256='+sha256)).arrayBuffer()),apk);
 }finally{await new Promise(resolve=>server.close(resolve));if(previous==null)delete process.env.ANDROID_APK_DIR;else process.env.ANDROID_APK_DIR=previous;await rm(directory,{recursive:true,force:true});}
});
