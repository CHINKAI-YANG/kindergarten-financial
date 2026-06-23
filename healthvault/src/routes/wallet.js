// /api/wallet — 錢包查詢與家屬防禦（消費者 App / 家屬端）。
//   GET  /:walletId           餘額、狀態、今日計數、近期交易
//   GET  /:walletId/ledger    完整交易帳本
//   GET  /:walletId/alerts    家屬通知（風控攔截／凍結紀錄）
//   POST /:walletId/freeze    一鍵凍結（掛失 → on-hold）
//   POST /:walletId/unfreeze  解除凍結（→ active）
import { Router } from 'express';
import { fhir } from '../fhirClient.js';
import { config, OBS_CATEGORY, ACCOUNT_STATUS } from '../config.js';
import { accountView, ledgerView, patientView } from '../mappers.js';
import { findAccountByWallet, patientRefOf, recompute, setStatus, today } from '../services/wallet.js';
import { pushAlert, getAlerts } from '../services/notify.js';

const router = Router();

async function loadAccount(req, res) {
  const account = await findAccountByWallet(req.params.walletId);
  if (!account) { res.status(404).json({ error: '查無此錢包。' }); return null; }
  return account;
}

// 錢包總覽（消費者數位卡）
router.get('/:walletId', async (req, res, next) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return;
    const v = accountView(account);
    const computed = await recompute(v.patientRef, today());
    let name = '';
    try {
      const pid = v.patientRef?.split('/').pop();
      if (pid) name = patientView(await fhir.read('Patient', pid)).name;
    } catch { /* ignore */ }

    const ledger = await fhir.searchAll('Observation', { subject: v.patientRef, category: OBS_CATEGORY.ledger, _count: 200 });
    const recent = ledger.map(ledgerView).sort((a, b) => String(b.when).localeCompare(String(a.when))).slice(0, 10);

    res.json({
      walletId: v.walletId,
      name,
      status: account.status,
      frozen: account.status === ACCOUNT_STATUS.onHold,
      frozenReason: v.frozenReason,
      balance: computed.balance,
      coinUnit: config.coinUnitLabel,
      today: { date: today(), earned: computed.dailyEarned, spent: computed.dailySpent, steps: computed.dailySteps },
      caps: { dailyEarn: config.dailyEarnCap, dailySpend: config.dailySpendCap },
      recent,
      barcode: v.walletId,
    });
  } catch (e) {
    next(e);
  }
});

// 完整交易帳本
router.get('/:walletId/ledger', async (req, res, next) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return;
    const patientRef = patientRefOf(account);
    const ledger = await fhir.searchAll('Observation', { subject: patientRef, category: OBS_CATEGORY.ledger, _count: 500 });
    res.json(ledger.map(ledgerView).sort((a, b) => String(b.when).localeCompare(String(a.when))));
  } catch (e) {
    next(e);
  }
});

// 家屬通知列表
router.get('/:walletId/alerts', async (req, res) => {
  res.json(getAlerts(req.params.walletId));
});

// 一鍵凍結（掛失）
router.post('/:walletId/freeze', async (req, res, next) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return;
    const reason = req.body?.reason || '家屬掛失凍結';
    const updated = await setStatus(account, ACCOUNT_STATUS.onHold, reason);
    pushAlert(req.params.walletId, { type: 'frozen', message: `帳戶已凍結：${reason}` });
    res.json({ ok: true, status: updated.status, frozen: true });
  } catch (e) {
    next(e);
  }
});

// 解除凍結
router.post('/:walletId/unfreeze', async (req, res, next) => {
  try {
    const account = await loadAccount(req, res);
    if (!account) return;
    const updated = await setStatus(account, ACCOUNT_STATUS.active);
    pushAlert(req.params.walletId, { type: 'unfrozen', message: '帳戶已解除凍結' });
    res.json({ ok: true, status: updated.status, frozen: false });
  } catch (e) {
    next(e);
  }
});

export default router;
