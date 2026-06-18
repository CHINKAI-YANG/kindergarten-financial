// 種子資料：在目標 FHIR 伺服器建立計畫書情境 A / B 的範例資料。
// 執行：npm run seed   （預設寫入 https://hapi.fhir.org/baseR4）
//
// 建立內容：
//   情境 A 王曉明（月薪制）：Schedule + Slot×2 + Appointment + 延護12h + 加班4h 出勤
//   情境 B 陳小美（純時薪）：regular 45.5h 出勤
// 完成後即可在「會計室核銷端 → 月底結算」直接看到 43,640 / 8,645。

import { fhir } from '../src/fhirClient.js';
import { config, SYSTEMS, WORK_TYPES } from '../src/config.js';
import { practitionerToFhir } from '../src/mappers.js';

const now = new Date();
const Y = now.getFullYear();
const M = now.getMonth(); // 0-based
const monthStart = new Date(Y, M, 1).toISOString().slice(0, 10);
const monthEnd = new Date(Y, M + 1, 0).toISOString().slice(0, 10);

// 在本月第 day 天、hh:mm 起、歷時 hours 小時的 ISO 區間
function span(day, hh, mm, hours) {
  const start = new Date(Y, M, day, hh, mm, 0);
  const end = new Date(start.getTime() + hours * 3600000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function encounter(practitionerRef, name, typeCode, start, end) {
  const wt = WORK_TYPES[typeCode];
  return {
    resourceType: 'Encounter',
    status: end ? 'finished' : 'in-progress',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    type: [{ coding: [{ system: SYSTEMS.workType, code: wt.code, display: wt.display }], text: wt.display }],
    participant: [{ individual: { reference: practitionerRef, display: name } }],
    period: { start, end },
  };
}

async function main() {
  console.log(`寫入 FHIR 伺服器：${config.fhirBaseUrl}`);
  console.log(`租戶標記：${config.tenantTag}　期間：${monthStart} ~ ${monthEnd}\n`);

  // ---- 情境 A：月薪制導師 ----
  const A = await fhir.create('Practitioner', practitionerToFhir({
    employeeId: 'T001', name: '王曉明', baseSalary: 42000, hourlyRate: 0,
    afterCareRate: 280, overtimeRate: 180, laborInsurance: 930, healthInsurance: 1510,
    bankCode: '006', bankAccount: '1234567890123',
  }));
  console.log('建立 Practitioner A 王曉明：', A.id);
  const refA = `Practitioner/${A.id}`;

  // 三層排班模型示範：Schedule → Slot → Appointment
  const sched = await fhir.create('Schedule', {
    resourceType: 'Schedule', active: true,
    actor: [{ reference: refA, display: '王曉明' }],
    planningHorizon: { start: monthStart, end: monthEnd }, comment: '每週二、四 16:30–18:30 課後延護',
  });
  const s1 = span(2, 16, 30, 2), s2 = span(4, 16, 30, 2);
  const slot1 = await fhir.create('Slot', { resourceType: 'Slot', schedule: { reference: `Schedule/${sched.id}` }, status: 'free', start: s1.start, end: s1.end });
  await fhir.create('Slot', { resourceType: 'Slot', schedule: { reference: `Schedule/${sched.id}` }, status: 'free', start: s2.start, end: s2.end });
  await fhir.create('Appointment', {
    resourceType: 'Appointment', status: 'booked', start: s1.start, end: s1.end,
    slot: [{ reference: `Slot/${slot1.id}` }],
    participant: [{ actor: { reference: refA, display: '王曉明' }, status: 'accepted' }],
  });
  await fhir.update('Slot', slot1.id, { ...slot1, status: 'busy' });
  console.log('  ↳ 已建立 Schedule / Slot×2 / Appointment（示範三層排班模型）');

  // 延護 12 小時（6 次 × 2h）＋ 加班 4 小時（2 次 × 2h）
  const afterDays = [2, 4, 9, 11, 16, 18];
  for (const d of afterDays) { const { start, end } = span(d, 16, 30, 2); await fhir.create('Encounter', encounter(refA, '王曉明', 'aftercare', start, end)); }
  for (const d of [5, 12]) { const { start, end } = span(d, 18, 0, 2); await fhir.create('Encounter', encounter(refA, '王曉明', 'overtime', start, end)); }
  console.log('  ↳ 已建立 延護 12h + 加班 4h 出勤紀錄');

  // ---- 情境 B：純時薪工讀 ----
  const B = await fhir.create('Practitioner', practitionerToFhir({
    employeeId: 'P001', name: '陳小美', baseSalary: 0, hourlyRate: 190,
    laborInsurance: 0, healthInsurance: 0, bankCode: '006', bankAccount: '9876543210987',
  }));
  console.log('建立 Practitioner B 陳小美：', B.id);
  const refB = `Practitioner/${B.id}`;
  // 45.5 小時：7 天 × 6.5h
  for (const d of [2, 3, 4, 5, 9, 10, 11]) { const { start, end } = span(d, 9, 0, 6.5); await fhir.create('Encounter', encounter(refB, '陳小美', 'regular', start, end)); }
  console.log('  ↳ 已建立 regular 45.5h 出勤紀錄');

  console.log('\n完成！請開啟「會計室核銷端 → 月底結算」執行結算：');
  console.log('  王曉明（月薪制）應得實發 NT$43,640');
  console.log('  陳小美（純時薪）應得實發 NT$8,645');
}

main().catch((e) => { console.error('\n種子資料建立失敗：', e.message); process.exit(1); });
