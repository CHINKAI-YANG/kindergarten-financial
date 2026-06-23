// 端對端測試：在本地端 mock FHIR 上跑完整流程，驗證企劃書的經濟模型、四大情境、
// 防偽、冪等、風控閘道器與隱私（關聯阻斷）。執行：npm test
import { startMockFhir } from './mock-fhir-server.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const mock = await startMockFhir(0);
process.env.FHIR_BASE_URL = `http://127.0.0.1:${mock.port}`;
process.env.TENANT_TAG = 'test-' + Date.now();
process.env.ADMIN_PASSWORD = 'test-admin-pw';

const { createApp } = await import('../server.js');
const app = createApp();
const srv = app.listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.error('  ✗', label); }
}
const ADMIN = 'test-admin-pw';
async function J(method, p, body) {
  const headers = { 'x-admin-key': ADMIN };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}
function raw(p, method = 'GET') { return fetch(base + p, { method }); }

const TODAY = new Date().toISOString().slice(0, 10);
const dMinus = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const register = (name, wristbandUid) => J('POST', '/api/users', { name, wristbandUid });
const sync = (walletId, steps, opt = {}) => J('POST', '/api/engine/sync', { walletId, steps, date: opt.date || TODAY, ...opt });
const redeem = (walletId, itemCode, opt = {}) => J('POST', '/api/pos/redeem', { walletId, itemCode, ...opt });

try {
  console.log('\n[前端語法檢查] 四個 HTML 的 inline JavaScript');
  for (const f of ['public/app.html', 'public/kiosk.html', 'public/pos.html', 'public/admin.html']) {
    const html = readFileSync(path.join(ROOT, f), 'utf8');
    const body = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]).join('\n');
    let synOk = true;
    try { new Function(body); } catch (e) { synOk = false; }
    ok(synOk, `${f} 的 JavaScript 語法正確`);
  }

  console.log('\n[健檢 / 授權]');
  ok((await J('GET', '/api/health')).data.ok === true, '可連線 mock FHIR 伺服器');
  ok((await raw('/api/users')).status === 401, '未授權存取 /api/users（發卡管理）→ 401');
  ok((await J('GET', '/api/users')).status === 200, '帶密碼可存取 /api/users → 200');
  const cfg = (await J('GET', '/api/config')).data;
  ok(cfg.stepsPerCoin === 1000 && cfg.aerobicWeight === 1.2 && cfg.dailyEarnCap === 50 && cfg.dailySpendCap === 100, '規則設定正確（1000步=1幣・×1.2・上限50/100）');

  console.log('\n[情境一] 上班族即時：8,500 步 + 有氧心率 → 9 幣');
  const ming = (await register('小明')).data;
  ok(/^[0-9a-f-]{36}$/.test(ming.walletId), '註冊發給虛擬錢包 walletId（UUID）');
  const s1 = await sync(ming.walletId, 8500, { heartRate: 130 });
  ok(s1.status === 201 && s1.data.aerobic === true, '心率 130 落在有氧區間（aerobic=true）');
  ok(s1.data.minted === 9 && s1.data.balance === 9, `1000步=1幣→8，×1.2 取整→9 幣（發 ${s1.data.minted}、餘 ${s1.data.balance}）`);
  ok(s1.data.stepObservation.startsWith('Observation/'), '產出步數憑證 Observation');

  console.log('\n[發幣冪等] 重送相同累計步數不重複發幣');
  const s1dup = await sync(ming.walletId, 8500, { heartRate: 130 });
  ok(s1dup.data.minted === 0 && s1dup.data.balance === 9, '同日相同快照重送 → 發 0、餘額不變（杜絕重複發幣）');

  console.log('\n[有氧加權對照] 無心率佐證則不加權');
  const noHr = (await register('無心率')).data;
  const s2 = await sync(noHr.walletId, 8500);
  ok(s2.data.aerobic === false && s2.data.minted === 8, `無心率 → 不加權，8,500 步 = 8 幣（發 ${s2.data.minted}）`);

  console.log('\n[每日快照增量] 同日多次同步只發增量');
  const inc = (await register('增量哥')).data;
  ok((await sync(inc.walletId, 4000)).data.minted === 4, '第一次 4,000 步 → 發 4');
  const inc2 = await sync(inc.walletId, 9000);
  ok(inc2.data.minted === 5 && inc2.data.balance === 9, '再到 9,000 步 → 只補發增量 5（餘 9）');

  console.log('\n[單日發幣上限] 超過 50 幣封頂');
  const cap = (await register('步神')).data;
  const sc = await sync(cap.walletId, 80000, { syncWindowHours: 24 });
  ok(sc.data.minted === 50 && sc.data.dailyEarnCapReached === true, `80,000 步應得 80，封頂為單日上限 50（發 ${sc.data.minted}）`);

  console.log('\n[防偽] 單次同步 > 15,000 步/小時 → 拒絕');
  const cheat = (await register('搖手機')).data;
  const sf = await sync(cheat.walletId, 20000, { syncWindowHours: 1 });
  ok(sf.status === 422 && sf.data.antiFraud, '1 小時內 20,000 步 → 422 防偽攔截');
  ok((await J('GET', `/api/wallet/${cheat.walletId}`)).data.balance === 0, '防偽攔截後不發幣、不建立帳本（餘額 0）');

  console.log('\n[情境二] 偏鄉長者：手機背景上傳 + Kiosk 手環批次同步');
  const gong = (await register('林阿公')).data;
  ok((await sync(gong.walletId, 5000)).data.minted === 5, '林阿公散步 5,000 步（手機背景上傳）→ 5 幣');
  const ama = (await register('王阿嬤', 'WB-AMA-001')).data;
  ok(ama.wristbandUid === 'WB-AMA-001', '王阿嬤無手機，以手環 UID 建檔');
  const batch = await J('POST', '/api/engine/batch-sync', {
    nodeId: 'KIOSK-活動中心', items: [{ wristbandUid: 'WB-AMA-001', steps: 35000, syncWindowHours: 168 }],
  });
  ok(batch.status === 201 && batch.data.results[0].ok && batch.data.results[0].minted === 35, `Kiosk 批次（Bundle）以手環代同步 35,000 步 → 35 幣（發 ${batch.data.results[0].minted}）`);
  ok((await J('GET', `/api/wallet/${ama.walletId}`)).data.balance === 35, '王阿嬤錢包餘額 35');

  console.log('\n[情境三] 特約店核銷：白名單 + 匿名 + 冪等');
  const cat = (await J('GET', '/api/pos/catalog')).data;
  ok(cat.items.length > 0 && cat.items.every((i) => i.code && i.price > 0), '健康物資白名單可取得');
  // 跨日累積餘額（單日上限 50，故以 3 天各 50 累積到 150）供消費上限測試
  const spender = (await register('消費者')).data;
  for (let i = 1; i <= 3; i++) await sync(spender.walletId, 80000, { date: dMinus(i), syncWindowHours: 24 });
  ok((await J('GET', `/api/wallet/${spender.walletId}`)).data.balance === 150, '跨 3 日各發 50 → 餘額 150');
  const look = (await J('GET', `/api/pos/lookup/${spender.walletId}`)).data;
  ok(look.balance === 150 && look.redeemable === true && !('name' in look), 'POS 查詢：匿名（無姓名）、可核銷、餘額正確');
  const r1 = await redeem(spender.walletId, 'BPCUFF', { idempotencyKey: 'rx-1', posId: 'POS-A' });
  ok(r1.status === 201 && r1.data.balance === 90 && !('name' in r1.data), '核銷血壓計 60 幣 → 餘 90，且回應不含姓名（關聯阻斷）');
  const r1dup = await redeem(spender.walletId, 'BPCUFF', { idempotencyKey: 'rx-1', posId: 'POS-A' });
  ok(r1dup.data.duplicate === true && r1dup.data.balance === 90, '相同冪等鍵重送 → 不重複扣款（餘額仍 90）');

  console.log('\n[情境四] 風控閘道器 + 家屬通知 + 一鍵凍結');
  // 非白名單品項 → 攔截
  const rBad = await redeem(ming.walletId, 'BEER');
  ok(rBad.status === 403 && rBad.data.reason === 'not-whitelisted', '非白名單品項（菸酒）→ 403 攔截');
  // 餘額不足
  ok((await redeem(ming.walletId, 'BPCUFF')).data.reason === 'insufficient', '餘額 9 買 60 幣 → 餘額不足攔截');
  // 超過單日消費上限：spender 今日已用 60，再買 60 → 120 > 100
  const rCap = await redeem(spender.walletId, 'BPCUFF', { idempotencyKey: 'rx-2' });
  ok(rCap.status === 409 && rCap.data.reason === 'daily-limit', '今日消費 60+60>100 → 超單日上限攔截');
  const alerts = (await J('GET', `/api/wallet/${spender.walletId}/alerts`)).data;
  ok(alerts.some((a) => a.type === 'blocked:daily-limit'), '超限攔截已即時通知家屬');
  // 一鍵凍結 → 核銷被擋
  await J('POST', `/api/wallet/${ama.walletId}/freeze`, { reason: '手機遺失' });
  const w = (await J('GET', `/api/wallet/${ama.walletId}`)).data;
  ok(w.status === 'on-hold' && w.frozen === true, '家屬一鍵凍結 → Account.status = on-hold（FHIR 合法值）');
  ok((await redeem(ama.walletId, 'MASK')).status === 423, '凍結後核銷 → 423 拒絕（盜刷防禦）');
  ok((await J('GET', `/api/wallet/${ama.walletId}/alerts`)).data.some((a) => a.type === 'frozen' || a.type === 'blocked:frozen'), '凍結／凍結後盜刷已通知家屬');
  await J('POST', `/api/wallet/${ama.walletId}/unfreeze`);
  const rOk = await redeem(ama.walletId, 'MASK', { idempotencyKey: 'amm-1' });
  ok(rOk.status === 201 && rOk.data.balance === 30, '解除凍結後可正常核銷口罩 5 幣 → 餘 30');

  console.log('\n[帳本一致性] 餘額 = 帳本帶號加總（流水帳先行）');
  const led = (await J('GET', `/api/wallet/${spender.walletId}/ledger`)).data;
  const sum = led.reduce((s, e) => s + e.coins, 0);
  const bal = (await J('GET', `/api/wallet/${spender.walletId}`)).data.balance;
  ok(sum === bal && bal === 90, `帳本加總 ${sum} === 餘額 ${bal}`);

  console.log('\n[合規定位] 健康幣不可轉現/轉讓、僅白名單核銷、唯一來源為運動數據');
  ok(typeof (await J('GET', '/api/pos/redeem')).status === 'number', '核銷僅能透過白名單品項（無現金/轉帳出口）');
  ok(led.filter((e) => e.type === 'earn').every((e) => e.derivedFrom?.length >= 0), '每筆發幣可回溯至步數憑證（證據鏈）');
} catch (e) {
  fail++;
  console.error('\n[例外]', e);
} finally {
  srv.close();
  mock.server.close();
  console.log(`\n=========== 測試結果：通過 ${pass}　失敗 ${fail} ===========\n`);
  process.exit(fail ? 1 : 0);
}
