// 忘記簽退提醒服務
// 找出「跨日仍未簽退」的出勤，寄 email 提醒對應員工；每筆只寄一次（標記 reminded）。

import { fhir } from '../fhirClient.js';
import { EXT } from '../config.js';
import { practitionerFromFhir, isStale } from '../mappers.js';
import { sendMail } from './mailer.js';

const isReminded = (enc) => !!(enc.extension || []).find((e) => e.url === EXT.reminded)?.valueBoolean;
function markReminded(enc) {
  enc.extension = (enc.extension || []).filter((e) => e.url !== EXT.reminded);
  enc.extension.push({ url: EXT.reminded, valueBoolean: true });
  return enc;
}

/**
 * 檢查所有跨日未簽退並寄送提醒。
 * @param {{force?:boolean}} opts force=true 時連已提醒過的也重寄
 */
export async function remindForgotClockouts({ force = false } = {}) {
  const encs = await fhir.searchAll('Encounter', { status: 'in-progress', _count: 300 });
  const stale = encs.filter(isStale);

  const practs = await fhir.searchAll('Practitioner', { _count: 300 });
  const byId = new Map(practs.map((p) => [p.id, practitionerFromFhir(p)]));

  const items = [];
  let sent = 0, dryRun = 0, skipped = 0, noEmail = 0;

  for (const enc of stale) {
    if (!force && isReminded(enc)) { skipped++; continue; }
    const ref = enc.participant?.[0]?.individual?.reference || '';
    const p = byId.get(ref.split('/').pop());
    const name = p?.name || enc.participant?.[0]?.individual?.display || '員工';
    const date = (enc.period?.start || '').slice(0, 10);

    if (!p?.email) { noEmail++; items.push({ name, email: null, date, status: '無 email，未寄送' }); continue; }

    const subject = `【益民幼兒園】出勤提醒：您 ${date} 忘記簽退`;
    const text = `${name} 您好：\n\n`
      + `系統偵測到您在 ${date} 有「簽到、但尚未簽退」的出勤紀錄。\n`
      + `請儘速至打卡系統補簽退，以免影響本月薪資結算。\n\n`
      + `（此信由益民幼兒園 FHIR 智慧行政系統自動寄送，請勿直接回覆）`;

    const r = await sendMail({ to: p.email, subject, text });
    if (r.dryRun) dryRun++; else sent++;
    items.push({ name, email: p.email, date, status: r.dryRun ? '乾跑（未設定 SMTP）' : '已寄出' });

    try { await fhir.update('Encounter', enc.id, markReminded(enc)); } catch { /* 標記失敗不影響寄送 */ }
  }

  return { staleCount: stale.length, sent, dryRun, skipped, noEmail, items };
}
