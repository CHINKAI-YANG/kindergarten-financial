// 寄信服務（忘記簽退提醒）
// 已設定 SMTP 時以 nodemailer 真的寄出；未設定時走「乾跑」模式（只在主控台記錄、不寄出），
// 讓系統在沒有郵件伺服器的情況下也能展示完整流程。

import { config } from '../config.js';

let transporter;
let initialised = false;

async function getTransport() {
  if (initialised) return transporter;
  initialised = true;
  if (!config.smtp.host) { transporter = null; return null; } // 未設定 → 乾跑
  try {
    const nodemailer = (await import('nodemailer')).default;
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  } catch (e) {
    console.warn('[mailer] 無法載入 nodemailer，改用乾跑模式：', e.message);
    transporter = null;
  }
  return transporter;
}

/**
 * 寄送一封純文字信。
 * @returns {{sent:boolean, dryRun:boolean, to:string, subject:string}}
 */
export async function sendMail({ to, subject, text }) {
  const t = await getTransport();
  if (!t) {
    console.log(`[mailer:乾跑] 寄給 ${to}｜${subject}\n${text}\n`);
    return { sent: false, dryRun: true, to, subject };
  }
  await t.sendMail({ from: config.mailFrom, to, subject, text });
  return { sent: true, dryRun: false, to, subject };
}
