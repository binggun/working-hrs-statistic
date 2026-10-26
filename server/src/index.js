import { app, rebuild } from "./app.js";
import { pool, transaction } from "./db.js";
import { processAttendanceExports } from "./attendance-export.js";
import { processPhotoRetention } from "./photo-retention.js";
import { processMail } from "./mail.js";
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, "0.0.0.0", () =>
  console.log(`Pawhub API listening on ${port}`),
);
const maintenance = setInterval(async () => {
  try {
    const workers = (await pool.query("SELECT id FROM workers")).rows;
    for (const w of workers) await transaction((c) => rebuild(c, w.id));
    await processMail();
    await processAttendanceExports();
  } catch (e) {
    console.error("Maintenance failure", e.code || e.name);
  }
}, 60000);
maintenance.unref();
let retentionRunning=false;
async function cleanPhotos(){
  if(retentionRunning)return;
  retentionRunning=true;
  try{const result=await processPhotoRetention();if(result.deleted)console.log("Expired photos removed:",result.deleted);}
  catch(error){console.error("Photo retention failure",error.code||error.name);}
  finally{retentionRunning=false;}
}
const photoRetention=setInterval(cleanPhotos,15*60000);
photoRetention.unref();
void cleanPhotos();
process.on("SIGTERM", () => {
  clearInterval(maintenance);
  clearInterval(photoRetention);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});
