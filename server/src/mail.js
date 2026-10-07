import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { createDecipheriv } from "node:crypto";
import { pool, transaction } from "./db.js";
export async function processMail() {
  if (
    !process.env.MAIL_FROM ||
    !process.env.WEB_ORIGIN ||
    !process.env.MAIL_ENCRYPTION_KEY
  )
    return;
  const job = await transaction(async (c) => {
    const r = await c.query(
      "SELECT * FROM email_jobs WHERE (status='QUEUED' AND next_attempt_at<=now()) OR (status='PROCESSING' AND lease_expires_at<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
    );
    if (!r.rowCount) return null;
    await c.query(
      "UPDATE email_jobs SET status='PROCESSING',attempt_count=attempt_count+1,lease_expires_at=now()+interval '5 minutes' WHERE id=$1",
      [r.rows[0].id],
    );
    return r.rows[0];
  });
  if (!job) return;
  try {
    const p = (
      await pool.query("SELECT * FROM password_links WHERE id=$1", [
        job.password_link_id,
      ])
    ).rows[0];
    if (
      !p ||
      p.used_at ||
      p.revoked_at ||
      new Date(p.expires_at) <= new Date()
    ) {
      await pool.query(
        "UPDATE email_jobs SET status='CANCELLED',encrypted_payload=NULL WHERE id=$1",
        [job.id],
      );
      return;
    }
    const [iv, tag, enc] = job.encrypted_payload
      .split(".")
      .map((x) => Buffer.from(x, "base64"));
    const d = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(process.env.MAIL_ENCRYPTION_KEY, "hex"),
      iv,
    );
    d.setAuthTag(tag);
    const payload = JSON.parse(
      Buffer.concat([d.update(enc), d.final()]).toString(),
    );
    const url = new URL(process.env.WEB_ORIGIN);
    url.hash = "activate=" + payload.token;
    await new SESv2Client({
      region: process.env.AWS_REGION || "ap-southeast-2",
    }).send(
      new SendEmailCommand({
        FromEmailAddress: process.env.MAIL_FROM,
        Destination: { ToAddresses: [job.recipient_email] },
        Content: {
          Simple: {
            Subject: { Data: "Pawhub account invitation" },
            Body: {
              Text: {
                Data: `Hello ${payload.name},\nSet your password: ${url}\nThis link expires in seven days and can be used once.`,
              },
            },
          },
        },
      }),
    );
    await pool.query(
      "UPDATE email_jobs SET status='SENT',sent_at=now(),encrypted_payload=NULL WHERE id=$1",
      [job.id],
    );
  } catch (e) {
    await pool.query(
      "UPDATE email_jobs SET status=$2,last_error_code=$3,next_attempt_at=now()+interval '5 minutes',encrypted_payload=CASE WHEN $2='FAILED' THEN NULL ELSE encrypted_payload END WHERE id=$1",
      [job.id, job.attempt_count >= 4 ? "FAILED" : "QUEUED", e.name],
    );
  }
}
