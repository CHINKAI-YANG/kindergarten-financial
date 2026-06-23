// 健康幣 HealthVault — Node.js 後端。
// 兩個子系統（健康數據引擎 + 錢包服務）對外提供 API，並托管四個操作端（消費者 App / Kiosk / 特約店 POS / 發卡管理）。
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import { fhir } from './src/fhirClient.js';

import usersRoutes from './src/routes/users.js';
import engineRoutes from './src/routes/engine.js';
import walletRoutes from './src/routes/wallet.js';
import posRoutes from './src/routes/pos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // 前端設定（FHIR 位址、租戶、發幣/消費規則）供畫面顯示與試算
  app.get('/api/config', (req, res) => {
    res.json({
      fhirBaseUrl: config.fhirBaseUrl,
      tenantTag: config.tenantTag,
      coinUnit: config.coinUnitLabel,
      stepsPerCoin: config.stepsPerCoin,
      aerobicWeight: config.aerobicWeight,
      aerobicHr: { min: config.aerobicHrMin, max: config.aerobicHrMax },
      dailyEarnCap: config.dailyEarnCap,
      dailySpendCap: config.dailySpendCap,
      antiFraudStepsPerHour: config.antiFraudStepsPerHour,
    });
  });

  // 連線健檢：實際打 FHIR 伺服器的 metadata
  app.get('/api/health', async (req, res) => {
    try {
      const cap = await fhir.metadata();
      res.json({ ok: true, fhirBaseUrl: config.fhirBaseUrl, fhirVersion: cap?.fhirVersion, software: cap?.software?.name });
    } catch (e) {
      res.status(502).json({ ok: false, fhirBaseUrl: config.fhirBaseUrl, error: e.message });
    }
  });

  // 管理／發卡端登入（前端登入後於後續請求帶 x-admin-key）
  app.post('/api/admin/login', (req, res) => {
    if (req.body?.password === config.adminPassword) return res.json({ ok: true });
    res.status(401).json({ ok: false, error: '密碼錯誤' });
  });

  function requireAdmin(req, res, next) {
    if (req.get('x-admin-key') === config.adminPassword) return next();
    res.status(401).json({ error: '需要管理端密碼授權，請先登入發卡管理端。' });
  }

  // 健康數據引擎 + 錢包服務 + 特約店核銷（展示用免登入；發卡管理需授權）
  app.use('/api/engine', engineRoutes);
  app.use('/api/wallet', walletRoutes);
  app.use('/api/pos', posRoutes);
  app.use('/api/users', requireAdmin, usersRoutes);

  // 靜態前端
  app.use(express.static(path.join(__dirname, 'public')));

  // 首頁：四個操作端入口
  app.get('/', (req, res) => {
    res.type('html').send(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>健康幣 HealthVault</title>
<style>
:root{--teal:#0f766e;--teal-d:#0b5b54}
*{box-sizing:border-box}
body{font-family:system-ui,"Microsoft JhengHei",sans-serif;background:linear-gradient(160deg,#e8f5f2,#eef3f0);margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.box{background:#fff;padding:40px;border-radius:20px;box-shadow:0 18px 50px rgba(15,118,110,.18);max-width:560px;width:100%}
h1{color:var(--teal);margin:0 0 4px;font-size:30px}.sub{color:#5a6b63;margin:0 0 24px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
a{display:block;padding:20px;border-radius:14px;text-decoration:none;font-weight:700;color:#fff;background:var(--teal);transition:transform .08s}
a:hover{transform:translateY(-2px)}
a small{display:block;font-weight:400;opacity:.85;font-size:13px;margin-top:6px}
a.alt{background:#e8f0ec;color:#1f3a33}
.foot{margin-top:22px;font-size:12px;color:#8a9a93;text-align:center}
.badge{display:inline-block;background:#d1fae5;color:#065f46;border-radius:999px;padding:2px 10px;font-size:12px;margin-bottom:14px}
</style>
<div class="box">
  <span class="badge">FHIR R4・走路賺幣・以運動換健康資產</span>
  <h1>健康幣 HealthVault</h1>
  <p class="sub">封閉型健康點數平台 — 健康數據引擎 × 錢包服務</p>
  <div class="grid">
    <a href="/app.html">📱 消費者 App<small>數位卡・賺幣・出示條碼・掛失凍結</small></a>
    <a href="/kiosk.html">🏘️ 社區節點 Kiosk<small>無障礙批次同步（手環長者）</small></a>
    <a href="/pos.html">🏪 特約店 POS<small>核銷健康物資・風控攔截</small></a>
    <a class="alt" href="/admin.html">🗂️ 發卡管理端<small>註冊使用者・錢包總覽</small></a>
  </div>
  <p class="foot">FHIR 伺服器：${config.fhirBaseUrl}　｜　租戶：${config.tenantTag}</p>
</div></html>`);
  });

  // 統一錯誤處理
  app.use((err, req, res, next) => {
    console.error('[ERROR]', err.message);
    res.status(err.status || 500).json({ error: err.message, operationOutcome: err.operationOutcome });
  });

  return app;
}

// 直接執行時啟動（被測試 import 時不啟動）
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`\n  健康幣 HealthVault`);
    console.log(`  ───────────────────────────────`);
    console.log(`  本機服務：    http://localhost:${config.port}`);
    console.log(`  消費者 App：  http://localhost:${config.port}/app.html`);
    console.log(`  社區 Kiosk：  http://localhost:${config.port}/kiosk.html`);
    console.log(`  特約店 POS：  http://localhost:${config.port}/pos.html`);
    console.log(`  發卡管理端：  http://localhost:${config.port}/admin.html`);
    console.log(`  FHIR 伺服器： ${config.fhirBaseUrl}`);
    console.log(`  租戶標記：    ${config.tenantTag}`);
    console.log(`  發幣規則：    ${config.stepsPerCoin} 步=1幣・有氧×${config.aerobicWeight}・單日上限 ${config.dailyEarnCap}・消費上限 ${config.dailySpendCap}\n`);
  });
}
