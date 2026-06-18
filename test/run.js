// 端對端測試：在本地端 mock FHIR 上跑完整流程，驗證計畫書情境 A / B / D 與防錯機制。
// 執行：npm test
import { startMockFhir } from './mock-fhir-server.js';

// 必須在 import 後端程式「之前」設定環境變數（config.js 於載入時讀取）
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
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}
const wt = (code) => ({ system: SYSTEMS.workType, code, display: WORK_TYPES[code].display });
const addEnc = (ref, name, code, start, end) =>
  J('POST', '/api/attendance', { practitionerRef: ref, practitionerName: name, workTypeCoding: wt(code), start, end });

try {
  console.log('\n[健檢]');
  const h = await J('GET', '/api/health');
  ok(h.data.ok === true, '可連線 mock FHIR 伺服器');

  console.log('\n[情境 A] 月薪制導師（本薪42000＋延護12h×280＋加班4h×180−勞930−健1510 = 43640）');
  const a = await J('POST', '/api/practitioners', {
    employeeId: 'T001', name: '王曉明', baseSalary: 42000, hourlyRate: 0,
    afterCareRate: 280, overtimeRate: 180, laborInsurance: 930, healthInsurance: 1510,
    bankCode: '006', bankAccount: '1234567890123',
  });
  ok(a.status === 201 && a.data.salaryMode === 'monthly', '建立月薪制員工，模式自動判定為 monthly');
  const aId = a.data.id;
  await addEnc(`Practitioner/${aId}`, '王曉明', 'aftercare', '2026-06-02T08:00:00', '2026-06-02T20:00:00'); // 12h
  await addEnc(`Practitioner/${aId}`, '王曉明', 'overtime', '2026-06-03T18:00:00', '2026-06-03T22:00:00'); // 4h
  const sa = await J('POST', '/api/claims/settle', { practitionerId: aId, periodStart: '2026-06-01', periodEnd: '2026-06-30' });
  ok(sa.status === 201, '結算成功並建立 Claim');
  ok(sa.data.detail.gross === 46080, `應發合計 = 46080（實得 ${sa.data.detail.gross}）`);
  ok(sa.data.detail.deductions === 2440, `扣款合計 = 2440（實得 ${sa.data.detail.deductions}）`);
  ok(sa.data.detail.net === 43640, `實發 = 43640（實得 ${sa.data.detail.net}）`);

  console.log('\n[情境 B] 純時薪工讀（45.5h × 190 = 8645，且封鎖勞健保）');
  const b = await J('POST', '/api/practitioners', {
    employeeId: 'P001', name: '陳小美', baseSalary: 0, hourlyRate: 190,
    laborInsurance: 0, healthInsurance: 0, bankCode: '006', bankAccount: '9876543210987',
  });
  ok(b.data.salaryMode === 'hourly', '建立純時薪員工，模式自動判定為 hourly');
  const bId = b.data.id;
  await addEnc(`Practitioner/${bId}`, '陳小美', 'regular', '2026-06-02T00:00:00', '2026-06-03T21:30:00'); // 45.5h
  const sb = await J('POST', '/api/claims/settle', { practitionerId: bId, periodStart: '2026-06-01', periodEnd: '2026-06-30' });
  ok(sb.data.detail.net === 8645, `實發 = 8645（實得 ${sb.data.detail.net}）`);
  ok(sb.data.detail.deductions === 0, '純時薪：勞健保代扣為 0（未誤扣）');
  ok(sb.data.detail.lines.length === 1, '純時薪：僅一條工資明細（封鎖津貼）');

  console.log('\n[情境 D] 缺簽退 → 結算阻斷 → 補登 → 重算');
  const z = await J('POST', '/api/practitioners', { employeeId: 'Z001', name: '林小華', baseSalary: 0, hourlyRate: 100, bankCode: '006', bankAccount: '5555555555' });
  const zId = z.data.id;
  const openEnc = await addEnc(`Practitioner/${zId}`, '林小華', 'regular', '2026-06-05T09:00:00', undefined); // 無簽退
  ok(openEnc.data.anomaly === true && openEnc.data.status === 'in-progress', '缺簽退之打卡被標記為異常 in-progress');
  const blocked = await J('POST', '/api/claims/settle', { practitionerId: zId, periodStart: '2026-06-01', periodEnd: '2026-06-30' });
  ok(blocked.status === 409 && blocked.data.anomalies?.length === 1, '結算阻斷：偵測到缺簽退並回報待修正清單');
  const fix = await J('PUT', `/api/attendance/${openEnc.data.id}/clock-out`, { end: '2026-06-05T17:00:00' });
  ok(fix.status === 200 && fix.data.status === 'finished' && fix.data.hours === 8, '補登簽退後狀態 finished，工時自動重算為 8.00');
  const sz = await J('POST', '/api/claims/settle', { practitionerId: zId, periodStart: '2026-06-01', periodEnd: '2026-06-30' });
  ok(sz.status === 201 && sz.data.detail.net === 800, `補登後可結算，實發 = 800（實得 ${sz.data.detail.net}）`);

  console.log('\n[權限分流] 打卡端不得暴露薪資');
  const pub = await J('GET', '/api/clock/practitioners');
  const leak = pub.data.some((p) => 'baseSalary' in p || 'hourlyRate' in p || 'laborInsurance' in p);
  ok(pub.status === 200 && !leak, '打卡端員工清單僅含姓名/編號，無任何薪資欄位');

  console.log('\n[打卡流程] 簽到/重複簽到/簽退/重複簽退');
  const ci1 = await J('POST', '/api/clock/clock-in', { practitionerId: bId, workType: 'regular' });
  ok(ci1.status === 201 && ci1.data.status === 'in-progress', '簽到成功（in-progress）');
  const ci2 = await J('POST', '/api/clock/clock-in', { practitionerId: bId });
  ok(ci2.status === 409, '尚未簽退時再簽到 → 阻擋（409）');
  const co1 = await J('POST', '/api/clock/clock-out', { practitionerId: bId });
  ok(co1.status === 200 && co1.data.status === 'finished' && typeof co1.data.hours === 'number', '簽退成功並換算工時');
  const co2 = await J('POST', '/api/clock/clock-out', { practitionerId: bId });
  ok(co2.status === 404, '無未簽退紀錄時再簽退 → 404');

  console.log('\n[簽核發薪] 核准 Claim → ClaimResponse');
  const list = await J('GET', '/api/claims');
  ok(list.data.length >= 3, `結算單清單可讀取（${list.data.length} 筆）`);
  let approvedCount = 0;
  for (const c of list.data) {
    if (c.detail?.practitioner?.employeeId === 'T001' || c.detail?.practitioner?.employeeId === 'P001') {
      const ap = await J('POST', `/api/claims/${c.id}/approve`);
      if (ap.status === 201 || ap.data.already) approvedCount++;
    }
  }
  ok(approvedCount === 2, '核准情境 A、B 兩張結算單（建立 ClaimResponse）');
  const relist = await J('GET', '/api/claims');
  const approvedNow = relist.data.filter((c) => c.approved).length;
  ok(approvedNow >= 2, '重新查詢顯示已核准狀態');

  console.log('\n[撥款] 合庫媒體檔 salary.txt');
  const prev = await J('GET', '/api/payout/preview?periodStart=2026-06-01&periodEnd=2026-06-30');
  ok(prev.data.count === 2 && prev.data.total === 43640 + 8645, `撥款預覽 2 筆，總額 ${prev.data.total}（應為 52285）`);
  const bf = await fetch(base + '/api/payout/bankfile?periodStart=2026-06-01&periodEnd=2026-06-30');
  const txt = await bf.text();
  const lines = txt.trim().split(/\r?\n/);
  ok(bf.headers.get('content-disposition')?.includes('salary.txt'), '回應為 salary.txt 附件下載');
  ok(lines.length === 3, '媒體檔含 2 筆明細 + 1 筆匯總列');
  ok(txt.includes('王曉明') && txt.includes('陳小美'), '媒體檔包含受款人姓名');
  ok(lines[0].startsWith('006'), '明細列以合庫銀行代碼 006 起首');
  ok(lines[2].startsWith('T') && lines[2].includes('0052285'), '匯總列含總金額 52285');
} catch (e) {
  fail++;
  console.error('\n[例外]', e);
} finally {
  srv.close();
  mock.server.close();
  console.log(`\n=========== 測試結果：通過 ${pass}　失敗 ${fail} ===========\n`);
  process.exit(fail ? 1 : 0);
}
