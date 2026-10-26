import {unlink} from 'node:fs/promises';
import {S3Client,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {pool,transaction} from './db.js';
import {localPhotoPath} from './photo-storage.js';
const s3=new S3Client({region:process.env.AWS_REGION||'ap-southeast-2'});
const due="created_at <= ((now() AT TIME ZONE 'Pacific/Auckland') - interval '3 months') AT TIME ZONE 'Pacific/Auckland'";
export async function processPhotoRetention({batchSize=200,removeLocal=unlink,s3Client=s3,bucket=process.env.PHOTO_BUCKET}={}) {
  const candidates=(await pool.query(`SELECT id FROM photos WHERE status='READY' AND ${due} ORDER BY created_at,id LIMIT $1`,[batchSize])).rows;
  const result={deleted:0,failed:0,skipped:0,scanned:candidates.length};
  for(const candidate of candidates){
    try{
      const deleted=await transaction(async c=>{
        const photo=(await c.query(`SELECT * FROM photos WHERE id=$1 AND status='READY' AND ${due} FOR UPDATE SKIP LOCKED`,[candidate.id])).rows[0];
        if(!photo)return false;
        if(photo.storage_key.startsWith('local:')){
          try{await removeLocal(localPhotoPath(photo.storage_key));}catch(error){if(error.code!=='ENOENT')throw error;}
        }else{
          if(!bucket)throw Object.assign(new Error('Photo bucket not configured'),{code:'PHOTO_BUCKET_MISSING'});
          await s3Client.send(new DeleteObjectCommand({Bucket:bucket,Key:photo.storage_key}));
        }
        await c.query("UPDATE photos SET status='EXPIRED',deleted_at=now() WHERE id=$1",[photo.id]);
        await c.query("INSERT INTO audit_logs(action,resource_id,before_data,after_data) VALUES('PHOTO_EXPIRED',$1,$2,$3)",[photo.id,{status:'READY',createdAt:photo.created_at},{status:'EXPIRED',retentionMonths:3}]);
        return true;
      });
      if(deleted)result.deleted++;else result.skipped++;
    }catch(error){result.failed++;console.error('Photo retention failed',candidate.id,error.code||error.name);}
  }
  return result;
}
