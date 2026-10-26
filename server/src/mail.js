import nodemailer from "nodemailer";
import { createDecipheriv } from "node:crypto";
import { pool, transaction } from "./db.js";
export async function processMail(transport) {
  if (!transport && (
    !process.env.SMTP_HOST ||
    !process.env.MAIL_FROM ||
    !process.env.WEB_ORIGIN ||
    !process.env.MAIL_ENCRYPTION_KEY
  ))
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
    if (job.kind !== "ACCOUNT_APPROVED" && (
      !p ||
      p.used_at ||
      p.revoked_at ||
      new Date(p.expires_at) <= new Date()
    )) {
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
    let subject, text;
    if (job.kind === "ACCOUNT_APPROVED") {
      const account = (await pool.query("SELECT status,login_code FROM accounts WHERE id=$1", [job.account_id])).rows[0];
      if (!account || account.status !== "ACTIVE" || account.login_code !== payload.employeeCode) {
        await pool.query("UPDATE email_jobs SET status='CANCELLED',encrypted_payload=NULL WHERE id=$1", [job.id]);
        return;
      }
      const label = payload.role === "GENERAL_MANAGER" ? "General manager" : payload.role === "MANAGER" ? "Manager" : "Groomer";
      subject = "Pawhub registration confirmed" + (payload.employeeCode ? " - employee ID " + payload.employeeCode : " - " + label);
      text = `Hello ${payload.name},\nYour Pawhub registration has been approved.\nRole: ${label}\n${payload.employeeCode ? "Your employee ID: " + payload.employeeCode + "\n" : ""}Sign in with your registered email and the password you already set.\n\n您的注册已确认，账号已激活。\n角色：${label}\n${payload.employeeCode ? "您的四位员工号：" + payload.employeeCode + "\n" : ""}请使用注册邮箱和自行设置的密码登录。`;

    } else {
      const url = new URL(process.env.WEB_ORIGIN);
      url.hash = "activate=" + payload.token;
      subject = "Pawhub account invitation";
      text = `Hello ${payload.name},\nSet your password: ${url}\nThis link expires in seven days and can be used once.`;
    }
    await (transport || smtpTransport()).sendMail({
      from: process.env.MAIL_FROM, to: job.recipient_email, subject, text,
      messageId: `<pawhub-${job.id}@pawhub.local>`,
      disableFileAccess: true, disableUrlAccess: true,
    });
    await pool.query(
      "UPDATE email_jobs SET status='SENT',sent_at=now(),encrypted_payload=NULL WHERE id=$1",
      [job.id],
    );
  } catch (e) {
    await pool.query(
      "UPDATE email_jobs SET status=$2,last_error_code=$3,next_attempt_at=now()+interval '5 minutes',encrypted_payload=CASE WHEN $2='FAILED' THEN NULL ELSE encrypted_payload END WHERE id=$1",
      [job.id, job.attempt_count >= 4 ? "FAILED" : "QUEUED", e.code || e.name],
    );
  }
}

export function smtpTransport() {
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = process.env.SMTP_SECURE === "true" ||
      (process.env.SMTP_SECURE === undefined && port === 465);
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      requireTLS: !secure,
      auth: process.env.SMTP_USER ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
}
