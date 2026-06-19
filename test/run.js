// 端對端測試：在本地端 mock FHIR 上跑完整流程，驗證計畫書情境與後續加入的需求：
//   勞健保自動計算＋手動覆寫、收入流水號、跨日未簽退提醒、打卡綁定裝置、帳號清楚。
// 執行：npm test
import { startMockFhir } from './mock-fhir-server.js';

const mock = await startMockFhir(0);
process.env.FHIR_BASE_URL = `http://127.0.0.1:${mock.port}`;
process.env.TENANT_TAG = 'test-' + Date.now();

const { createApp } = await import('../server.js');
const { SYSTEMS, WORK_TYPES } = await import('../src/config.js');

const app = createApp();
const srv = app.listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.error('  ✗', label); }
}
async function J(method, path, body) {
  const r = await fetch(base + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}
const wt = (code) => ({ system: SYSTEMS.workType, code, display: WORK_TYPES[code].display });
const addEnc = (ref, name, code, start, end) =>
  J('POST', '/api/attendance', { practitionerRef: ref, practitionerName: name, workTypeCoding: wt(code), start, end });
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

try {
  console.log('\n[健檢]');
  ok((await J('GET', '/api/health')).data.ok === true, '可連線 mock FHIR 伺服器');

  console.log('\n[情境 A] 月薪制導師（手動勞健保 930/1510 → 實發 43,640）');
  const a = await J('POST', '/api/practitioners', {
    employeeId: 'T001', name: '王曉明', baseSalary: 42000, afterCareRate: 280, overtimeRate: 180,
    insuredSalary: 42000, autoInsurance: false, laborInsurance: 930, healthInsurance: 1510,
    bankCode: '006', bankAccount: '1234567890123',
  });
  ok(a.data.salaryMode === 'monthly', '本薪>0 自動判定為月薪制');
  ok(a.data.autoInsurance === false && a.data.laborInsurance === 930 && a.data.healthInsurance === 1510, '手動覆寫勞健保 930/1510 生效');
  ok(a.data.bankLabel.includes('合作金庫'), '帳號清楚：銀行代碼 006 標示為合作金庫');
  const aId = a.data.id;
  await addEnc(`Practitioner/${aId}`, '王曉明', 'aftercare', '2026-06-02T08:00:00', '2026-06-02T20:00:00'); // 12h
  await addEnc(`Practitioner/${aId}`, '王曉明', 'overtime', '2026-06-03T18:00:00', '2026-06-03T22:00:00'); // 4h
  const sa = await J('POST', '/api/claims/settle', { practitionerId: aId, periodStart: '2026-06-01', periodEnd: '2026-06-30' });
  ok(sa.status === 201, '結算成功（未被 HAPI-0931 參照型別擋下）');
  ok(sa.data.detail.net === 43640, `實發 = 43,640（實得 ${sa.data.detail.net}）`);
  ok(/^S\d{6}-\d{4}$/.test(sa.data.detail.serial), `產生收入流水號 ${sa.data.detail.serial}`);
  ok(sa.data.claim.patient.reference.startsWith('Patient/'), 'Claim.patient 指向 Patient（修正 HAPI-0931，非 Practitioner）');

  console.log('\n[勞健保自動計算] 投保薪資 30000 × 自付費率 → 勞保720 健保465');
  const ac = await J('POST', '/api/practitioners', {
    employeeId: 'M002', name: '李大方', baseSalary: 30000, insuredSalary: 30000, autoInsurance: true,
    bankCode: '013', bankAccount: '0220987654321',
  });
  ok(ac.data.autoInsurance === true && ac.data.laborInsurance === 720 && ac.data.healthInsurance === 465, '自動計算勞保 720、健保 465（30000×2.4% / 1.55%）');
  const sac = await J('POST', '/api/claims/settle', { practitionerId: ac.data.id, periodStart: '2026-06-01', periodEnd: '2026-06-30' });
  ok(sac.data.detail.net === 30000 - 720 - 465, `自動勞健保套入結算，實發 = 28,815（實得 ${sac.data.detail.net}）`);

  console.log('\n[情境 B] 純時薪工讀（45.5h × 190 = 8645，封鎖勞健保）');
  const b = await J('POST', '/api/practitioners', {
    employeeId: 'P001', name: '陳小美', baseSalary: 0, hourlyRate: 190, autoInsurance: true, bankCode: '006', bankAccount: '9876543210987',
  });
  ok(b.data.salaryMode === 'hourly', '本薪=0 自動判定為純時薪');
  const bId = b.data.id;
  await addEnc(`Practitioner/${bId}`, '陳小美', 'regular', '2026-06-02T00:00:00', '2026-06-03T21:30:00'); // 45.5h
  const sb = await J('POST', '/api/claims/settle', { practitionerId: bId, periodStart: '2026-06-01', periodEnd: '2026-06-30' });
  ok(sb.data.detail.net === 8645, `實發 = 8,645（實得 ${sb.data.detail.net}）`);
  ok(sb.data.detail.deductions === 0, '純時薪：勞健保未誤扣（即使有投保設定）');

  console.log('\n[情境 D] 缺簽退 → 結算阻斷 → 補登 → 重算');
  const z = await J('POST', '/api/practitioners', { employeeId: 'Z001', name: '林小華', baseSalary: 0, hourlyRate: 100, bankCode: '006', bankAccount: '5555555555' });
  const zId = z.data.id;
  const openEnc = await addEnc(`Practitioner/${zId}`, '林小華', 'regular', '2026-06-05T09:00:00', undefined);
  ok(openEnc.data.anomaly === true, '缺簽退之打卡被標記為異常 in-progress');
  const blocked = await J('POST', '/api/claims/settle', { practitionerId: zId, periodStart: '2026-06-01', periodEnd: '2026-06-30' });
  ok(blocked.status === 409 && blocked.data.anomalies?.length === 1, '結算阻斷：偵測缺簽退並回報待修正');
  const fix = await J('PUT', `/api/attendance/${openEnc.data.id}/clock-out`, { end: '2026-06-05T17:00:00' });
  ok(fix.data.status === 'finished' && fix.data.hours === 8, '補登簽退後狀態 finished，工時重算為 8.00');
  ok((await J('POST', '/api/claims/settle', { practitionerId: zId, periodStart: '2026-06-01', periodEnd: '2026-06-30' })).data.detail.net === 800, '補登後可結算，實發 = 800');

  console.log('\n[跨日未簽退提醒] 隔天提醒立即處理');
  const rr = await J('POST', '/api/practitioners', { employeeId: 'R001', name: '黃小強', baseSalary: 0, hourlyRate: 150, bankCode: '700', bankAccount: '00112233445' });
  const staleEnc = await addEnc(`Practitioner/${rr.data.id}`, '黃小強', 'regular', daysAgo(3), undefined); // 3天前未簽退
  ok(staleEnc.data.stale === true, '跨日未簽退被標記為 stale');
  const rem = await J('GET', `/api/clock/reminders?practitionerId=${rr.data.id}`);
  ok(rem.status === 200 && rem.data.length === 1, '打卡端提醒 API 回報 1 筆需立即處理');

  console.log('\n[權限分流] 打卡端不得暴露薪資');
  const pub = await J('GET', '/api/clock/practitioners');
  const leak = pub.data.some((p) => 'baseSalary' in p || 'hourlyRate' in p || 'laborInsurance' in p);
  ok(!leak && 'deviceBound' in pub.data[0], '打卡端清單僅含姓名/編號/綁定狀態，無任何薪資欄位');

  console.log('\n[打卡綁定裝置] 首次綁定 → 限同裝置 → 會計重設');
  const c = await J('POST', '/api/practitioners', { employeeId: 'D001', name: '吳小安', baseSalary: 0, hourlyRate: 160, bankCode: '006', bankAccount: '6677889900' });
  const cId = c.data.id;
  ok((await J('POST', '/api/clock/clock-in', { practitionerId: cId, workType: 'regular' })).status === 403, '未帶裝置識別 → 拒絕打卡（403）');
  const ci = await J('POST', '/api/clock/clock-in', { practitionerId: cId, deviceId: 'phone-1' });
  ok(ci.status === 201 && ci.data.deviceJustBound === true, '首次以 phone-1 打卡 → 自動綁定該裝置');
  await J('POST', '/api/clock/clock-out', { practitionerId: cId, deviceId: 'phone-1' });
  ok((await J('POST', '/api/clock/clock-in', { practitionerId: cId, deviceId: 'phone-2' })).status === 403, '改用 phone-2 → 拒絕（非綁定裝置）');
  const st1 = await J('GET', `/api/clock/device-status?practitionerId=${cId}&deviceId=phone-1`);
  const st2 = await J('GET', `/api/clock/device-status?practitionerId=${cId}&deviceId=phone-2`);
  ok(st1.data.state === 'this' && st2.data.state === 'other', '裝置狀態查詢：phone-1=this、phone-2=other');
  await J('POST', `/api/practitioners/${cId}/reset-device`);
  ok((await J('POST', '/api/clock/clock-in', { practitionerId: cId, deviceId: 'phone-2' })).data.deviceJustBound === true, '會計重設綁定後，phone-2 可重新綁定');

  console.log('\n[打卡流程] 簽到/重複簽到/簽退/重複簽退');
  const ci1 = await J('POST', '/api/clock/clock-in', { practitionerId: bId, deviceId: 'devB', workType: 'regular' });
  ok(ci1.status === 201, '簽到成功（in-progress）');
  ok((await J('POST', '/api/clock/clock-in', { practitionerId: bId, deviceId: 'devB' })).status === 409, '尚未簽退再簽到 → 阻擋（409）');
  ok((await J('POST', '/api/clock/clock-out', { practitionerId: bId, deviceId: 'devB' })).data.status === 'finished', '簽退成功並換算工時');
  ok((await J('POST', '/api/clock/clock-out', { practitionerId: bId, deviceId: 'devB' })).status === 404, '無未簽退紀錄再簽退 → 404');

  console.log('\n[簽核發薪] 核准 A、B → ClaimResponse');
  const list = await J('GET', '/api/claims');
  let approved = 0;
  for (const c2 of list.data) {
    const eid = c2.detail?.practitioner?.employeeId;
    if (eid === 'T001' || eid === 'P001') {
      const ap = await J('POST', `/api/claims/${c2.id}/approve`);
      if (ap.status === 201 || ap.data.already) approved++;
    }
  }
  ok(approved === 2, '核准情境 A、B 兩張結算單');

  console.log('\n[撥款] 合庫媒體檔 salary.txt（含流水號）');
  const prev = await J('GET', '/api/payout/preview?periodStart=2026-06-01&periodEnd=2026-06-30');
  ok(prev.data.count === 2 && prev.data.total === 52285, `撥款預覽 2 筆，總額 52,285（實得 ${prev.data.total}）`);
  ok(prev.data.rows.every((r) => /^S\d{6}-\d{4}$/.test(r.serial)), '每筆撥款皆有流水號');
  const bf = await fetch(base + '/api/payout/bankfile?periodStart=2026-06-01&periodEnd=2026-06-30');
  const txt = await bf.text();
  const lines = txt.trim().split(/\r?\n/);
  ok(bf.headers.get('content-disposition')?.includes('salary.txt'), '回應為 salary.txt 附件下載');
  ok(lines.length === 3, '媒體檔含 2 筆明細 + 1 筆匯總列');
  ok(lines[0].startsWith('S2026') && lines[0].slice(12, 15) === '006', '明細列：流水號(12碼)＋合庫代碼006');
  ok(txt.includes('王曉明') && txt.includes('陳小美'), '媒體檔包含受款人姓名');
  ok(lines[2].startsWith('T') && lines[2].includes('0052285'), '匯總列含總金額 52285');

  console.log('\n[受款 Patient 去重] 重複結算不重複建立 Patient');
  const ptBefore = mock.store.get('Patient').size;
  const sa3 = await J('POST', '/api/claims/settle', { practitionerId: aId, periodStart: '2026-06-01', periodEnd: '2026-06-30' });
  ok(sa3.data.claim.patient.reference === sa.data.claim.patient.reference, '重複結算重用同一受款 Patient');
  ok(mock.store.get('Patient').size === ptBefore, '未重複建立 Patient（以員工編號去重）');
} catch (e) {
  fail++;
  console.error('\n[例外]', e);
} finally {
  srv.close();
  mock.server.close();
  console.log(`\n=========== 測試結果：通過 ${pass}　失敗 ${fail} ===========\n`);
  process.exit(fail ? 1 : 0);
}
