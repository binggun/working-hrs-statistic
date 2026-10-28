import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
function directory(){return process.env.ANDROID_APK_DIR||fileURLToPath(new URL('../data/downloads/',import.meta.url));}
async function current(){
  const metadata=JSON.parse(await readFile(path.join(directory(),'android.json'),'utf8'));
  if(!/^[a-f0-9]{64}$/.test(metadata.sha256))throw Error('Invalid APK metadata');
  const file=path.join(directory(),metadata.sha256+'.apk');
  const info=await stat(file);if(!info.isFile()||info.size!==metadata.sizeBytes)throw Error('APK unavailable');
  return {...metadata,downloadPath:`/api/v1/downloads/android/apk?sha256=${metadata.sha256}`};
}
export function mountAndroidDownload(app){
  app.get('/api/v1/downloads/android',async(req,res)=>{
    res.set('Cache-Control','no-store');
    try{res.json({data:{available:true,...await current()}});}catch{res.json({data:{available:false}});}
  });
  app.get('/api/v1/downloads/android/apk',async(req,res,next)=>{
    try{
      const hash=req.query.sha256||(await current()).sha256;
      if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))return res.status(400).json({error:{message:'Invalid APK version'}});
      const file=path.join(directory(),hash+'.apk');
      if(!(await stat(file)).isFile())throw Error('APK unavailable');
      res.set('Cache-Control','public, max-age=86400');res.type('application/vnd.android.package-archive');
      res.download(file,'pawhub-signin-app.apk',error=>{if(error)next(error);});
    }catch{res.status(404).json({error:{message:'Android APK is not available yet'}});}
  });
}
