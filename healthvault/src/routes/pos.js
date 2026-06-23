// /api/pos — 特約店核銷端（商戶面）。
// 關聯阻斷：商戶端一律只見 walletId 與餘額/狀態，永不回傳真實姓名（系統端可追溯、商戶端匿名）。
//   GET  /catalog          健康物資白名單
//   GET  /lookup/:walletId 帳戶狀態與餘額（核銷前查詢）
//   POST /redeem           核銷扣款（內含風控閘道器 + 家屬即時通知）
import { Router } from 'express';
import { config } from '../config.js';
import { listCatalog, findItem } from '../services/catalog.js';
import { findAccountByWallet, recompute, patientRefOf, spend, today } from '../services/wallet.js';
import { pushAlert } from '../services/notify.js';

const router = Router();

// 健康物資白名單（特約店品項表）
router.get('/catalog', (req, res) => {
  res.json({ coinUnit: config.coinUnitLabel, dailySpendCap: config.dailySpendCap, items: listCatalog() });
});

// 核銷前查詢（匿名：只回 walletId / 狀態 / 餘額）
router.get('/lookup/:walletId', async (req, res, next) => {
  try {
    const account = await findAccountByWallet(req.params.walletId);
    if (!account) return res.status(404).json({ error: '查無此錢包。' });
    const computed = await recompute(patientRefOf(account), today());
    res.json({
      walletId: req.params.walletId,
      status: account.status,
      redeemable: account.status === 'active',
      balance: computed.balance,
      dailySpent: computed.dailySpent,
      dailySpendCap: config.dailySpendCap,
    });
  } catch (e) {
    next(e);
  }
});

// 核銷扣款。body: { walletId, itemCode, qty?, posId?, idempotencyKey? }
router.post('/redeem', async (req, res, next) => {
  try {
    const { walletId, itemCode, qty, posId, idempotencyKey } = req.body || {};
    if (!walletId || !itemCode) return res.status(400).json({ error: '需提供 walletId 與 itemCode。' });

    const account = await findAccountByWallet(walletId);
    if (!account) return res.status(404).json({ error: '查無此錢包。' });

    const item = findItem(itemCode); // 不在白名單 → null（風控攔截）
    const result = await spend({ account, item, qty: Number(qty) || 1, posId, idempotencyKey, date: today() });

    if (result.ok) {
      return res.status(result.duplicate ? 200 : 201).json({
        ok: true,
        duplicate: !!result.duplicate,
        walletId,
        receipt: result.receipt,
        cost: result.cost,
        balance: result.balance,
        coinUnit: config.coinUnitLabel,
        message: `核銷成功，扣 ${result.cost} ${config.coinUnitLabel}，餘額 ${result.balance}。`,
      });
    }

    // 風控攔截：非白名單／超過單日上限／凍結 → 即時通知家屬
    if (['not-whitelisted', 'daily-limit', 'frozen'].includes(result.reason)) {
      pushAlert(walletId, { type: `blocked:${result.reason}`, message: result.message, itemCode, posId: posId || null });
    }
    const status = result.reason === 'frozen' ? 423 : result.reason === 'not-whitelisted' ? 403 : 409;
    res.status(status).json({ ok: false, walletId, reason: result.reason, message: result.message, balance: result.balance });
  } catch (e) {
    next(e);
  }
});

export default router;
