// 撥款 API（/api/payout/*）— 會計室核銷端
// 對應計畫書情境 C：由已核准的 ClaimResponse 一鍵生成合庫媒體轉帳檔，
// 杜絕手工繕打帳號金額之誤（撥款檔自動生成）。

import { Router } from 'express';
import { fhir } from '../fhirClient.js';
import { EXT } from '../config.js';
import { buildBankFile } from '../services/bankfile.js';

const router = Router();

function parsePayroll(resource) {
  const e = (resource.extension || []).find((x) => x.url === EXT.payroll);
  if (!e?.valueString) return null;
  try { return JSON.parse(e.valueString); } catch { return null; }
}

function inPeriod(detail, startDate, endDate) {
  if (!startDate || !endDate) return true;
  const ps = detail?.period?.start;
  return ps && ps >= startDate && ps <= endDate;
}

// 取得期間內所有已核准的撥款明細（供畫面預覽撥款清冊）
router.get('/preview', async (req, res, next) => {
  try {
    const { periodStart, periodEnd } = req.query;
    const responses = await fhir.searchAll('ClaimResponse', { _count: 300 });
    const rows = responses
      .map(parsePayroll)
      .filter(Boolean)
      .filter((d) => inPeriod(d, periodStart, periodEnd))
      .map((d) => ({
        name: d.practitioner?.name,
        employeeId: d.practitioner?.employeeId,
        bankCode: d.practitioner?.bankCode,
        bankAccount: d.practitioner?.bankAccount,
        amount: d.net,
      }));
    res.json({ count: rows.length, total: rows.reduce((s, r) => s + (r.amount || 0), 0), rows });
  } catch (e) {
    next(e);
  }
});

// 一鍵下載合庫媒體轉帳檔 salary.txt
router.get('/bankfile', async (req, res, next) => {
  try {
    const { periodStart, periodEnd } = req.query;
    const responses = await fhir.searchAll('ClaimResponse', { _count: 300 });
    const rows = responses
      .map(parsePayroll)
      .filter(Boolean)
      .filter((d) => inPeriod(d, periodStart, periodEnd))
      .map((d) => ({
        bankCode: d.practitioner?.bankCode,
        bankAccount: d.practitioner?.bankAccount,
        amount: d.net,
        name: d.practitioner?.name,
      }));

    if (rows.length === 0) {
      return res.status(404).json({ error: '此期間查無已核准的撥款資料，無法產生媒體檔。' });
    }

    const content = buildBankFile(rows);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="salary.txt"');
    res.send(content);
  } catch (e) {
    next(e);
  }
});

export default router;
