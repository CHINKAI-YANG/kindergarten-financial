// 益民幼兒園 FHIR 智慧行政系統 — Node.js 後端
// 將「排班—打卡—結算—簽核—撥款」全流程操作轉為 FHIR 資源，上傳至 HAPI baseR4。

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import { fhir } from './src/fhirClient.js';

import clockRoutes from './src/routes/clock.js';
import practitionerRoutes from './src/routes/practitioners.js';
import schedulingRoutes from './src/routes/scheduling.js';
import attendanceRoutes from './src/routes/attendance.js';
import claimRoutes from './src/routes/claims.js';
import payoutRoutes from './src/routes/payout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // 提供前端設定（FHIR 伺服器位址、租戶標記、勞健保費率）給畫面顯示與即時試算
  app.get('/api/config', (req, res) => {
    res.json({
      fhirBaseUrl: config.fhirBaseUrl,
      tenantTag: config.tenantTag,
      currency: config.currency,
      laborInsuranceRate: config.laborInsuranceRate,
      healthInsuranceRate: config.healthInsuranceRate,
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

  // 會計室核銷端登入（驗證密碼；前端登入後於後續請求帶 x-admin-key 標頭）
  app.post('/api/admin/login', (req, res) => {
    if (req.body?.password === config.adminPassword) return res.json({ ok: true });
    res.status(401).json({ ok: false, error: '密碼錯誤' });
  });

  // 授權中介層：保護簽核/薪資等管理 API。打卡端與 config/health 不受此限。
  function requireAdmin(req, res, next) {
    if (req.get('x-admin-key') === config.adminPassword) return next();
    res.status(401).json({ error: '需要會計室密碼授權，請先登入核銷端。' });
  }

  // 員工打卡端 API（免登入，櫃檯公用；最小揭露，永不回傳薪資）
  app.use('/api/clock', clockRoutes);

  // 以下為「會計室核銷端」專用 API，一律需密碼授權（打卡端無法存取簽核/薪資）
  app.use('/api/practitioners', requireAdmin, practitionerRoutes);
  app.use('/api/scheduling', requireAdmin, schedulingRoutes);
  app.use('/api/attendance', requireAdmin, attendanceRoutes);
  app.use('/api/claims', requireAdmin, claimRoutes);
  app.use('/api/payout', requireAdmin, payoutRoutes);

  // 靜態前端（兩個 HTML 操作端）
  app.use(express.static(path.join(__dirname, 'public')));

  // 首頁：兩端入口（不額外產生第三個 .html 檔，直接內嵌回應）
  app.get('/', (req, res) => {
    res.type('html').send(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>益民幼兒園 FHIR 智慧行政</title>
<style>body{font-family:system-ui,"Microsoft JhengHei",sans-serif;background:#eef3f0;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.box{background:#fff;padding:40px;border-radius:16px;box-shadow:0 10px 40px rgba(31,107,84,.15);text-align:center;max-width:520px}
h1{color:#1f6b54;margin:0 0 6px}p{color:#5a6b63}
a{display:block;margin:14px 0;padding:18px;border-radius:12px;text-decoration:none;font-size:18px;font-weight:700}
.clock{background:#1f6b54;color:#fff}.admin{background:#e8f0ec;color:#1f3a33}</style>
<div class="box"><h1>益民幼兒園</h1><p>FHIR 智慧行政・出勤打卡與薪資核銷一體化系統</p>
<a class="clock" href="/clock.html">🕒 員工打卡端</a>
<a class="admin" href="/admin.html">📊 會計室核銷端</a>
<p style="font-size:13px">FHIR 伺服器：${config.fhirBaseUrl}</p></div></html>`);
  });

  // 統一錯誤處理：把 FHIR 錯誤轉成 JSON
  app.use((err, req, res, next) => {
    console.error('[ERROR]', err.message);
    res.status(err.status || 500).json({ error: err.message, operationOutcome: err.operationOutcome });
  });

  return app;
}

// 直接執行時啟動伺服器（被測試 import 時則不啟動）
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`\n  益民幼兒園 FHIR 智慧行政系統`);
    console.log(`  ───────────────────────────────`);
    console.log(`  本機服務： http://localhost:${config.port}`);
    console.log(`  員工打卡端：http://localhost:${config.port}/clock.html`);
    console.log(`  會計核銷端：http://localhost:${config.port}/admin.html`);
    console.log(`  FHIR 伺服器：${config.fhirBaseUrl}`);
    console.log(`  租戶標記：  ${config.tenantTag}`);
    if (config.reminderIntervalHours > 0) {
      console.log(`  忘記簽退提醒：每 ${config.reminderIntervalHours} 小時自動檢查${config.smtp.host ? '並寄信' : '（未設 SMTP，乾跑模式）'}`);
    }
    console.log('');
  });

  // 自動檢查「忘記簽退」並寄提醒（僅正式啟動時執行；測試以 createApp 匯入時不會觸發）
  if (config.reminderIntervalHours > 0) {
    setInterval(() => {
      import('./src/services/reminders.js')
        .then((m) => m.remindForgotClockouts())
        .then((r) => { if (r.staleCount) console.log(`[reminder] 忘記簽退 ${r.staleCount} 筆：寄出 ${r.sent}、乾跑 ${r.dryRun}、略過 ${r.skipped}`); })
        .catch((e) => console.warn('[reminder] 檢查失敗：', e.message));
    }, config.reminderIntervalHours * 3600000);
  }
}
