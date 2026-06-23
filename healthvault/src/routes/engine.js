// /api/engine — 健康數據引擎：抓取步數/心率 → FHIR 轉譯 → 防偽 → 產出 Observation 憑證 → 發幣。
//   POST /sync        即時單筆同步（情境一：上班族；情境二：長者手機背景上傳）
//   POST /batch-sync  社區節點 Kiosk 批次同步（情境二：無手機長者，手環 UID 代同步，以 Bundle 上傳）
import { Router } from 'express';
import { fhir } from '../fhirClient.js';
import { config, SYSTEMS, OBS_CATEGORY, LOINC } from '../config.js';
import { detectAerobic, antiFraudCheck } from '../services/minting.js';
import {
  findAccountByWallet,
  findPatientByWristband,
  patientRefOf,
  recompute,
  createStepCredential,
  mintFromCumulative,
  today,
} from '../services/wallet.js';
import { buildStepObservation, patientView } from '../mappers.js';

const router = Router();

// 即時單筆同步。body: { walletId, steps(當日累計), date?, heartRate?, deviceId?, syncWindowHours? }
router.post('/sync', async (req, res, next) => {
  try {
    const { walletId, steps, date, heartRate, deviceId, syncWindowHours } = req.body || {};
    if (!walletId || steps == null) return res.status(400).json({ error: '需提供 walletId 與 steps（當日累計步數）。' });
    const cumulative = Number(steps);
    if (!(cumulative >= 0)) return res.status(400).json({ error: 'steps 需為非負數。' });

    const account = await findAccountByWallet(walletId);
    if (!account) return res.status(404).json({ error: '查無此錢包。' });
    const patientRef = patientRefOf(account);
    const d = date || today();
    const when = date ? `${d}T${new Date().toISOString().slice(11)}` : new Date().toISOString();

    // 防偽：以本次增量步數與時間窗檢查「步/小時」
    const before = await recompute(patientRef, d);
    const delta = Math.max(0, cumulative - before.dailySteps);
    const af = antiFraudCheck(delta, Number(syncWindowHours));
    if (!af.ok) {
      return res.status(422).json({
        error: `防偽攔截：${af.windowHours} 小時內新增 ${delta} 步（${af.ratePerHour} 步/小時）超過門檻 ${af.threshold} 步/小時，已拒絕。`,
        antiFraud: af,
      });
    }

    const aerobic = detectAerobic(heartRate != null ? Number(heartRate) : null);
    const stepObs = await createStepCredential({
      patientRef,
      steps: cumulative,
      heartRate: heartRate != null ? Number(heartRate) : undefined,
      when,
      idempotencyKey: `step:${patientRef}:${d}:${cumulative}:${deviceId || '-'}`,
      detail: { date: d, deviceId: deviceId || null, delta, aerobic },
    });

    const result = await mintFromCumulative({
      account, patientRef, cumulativeSteps: cumulative, aerobic, date: d, when, stepObsRef: `Observation/${stepObs.id}`,
    });

    res.status(201).json({
      walletId,
      date: d,
      steps: cumulative,
      delta,
      aerobic,
      heartRate: heartRate != null ? Number(heartRate) : null,
      minted: result.minted,
      entitled: result.entitled,
      balance: result.balance,
      dailyEarned: result.dailyEarned,
      dailyEarnCapReached: result.dailyEarned >= config.dailyEarnCap,
      stepObservation: `Observation/${stepObs.id}`,
      ledgerId: result.ledgerId,
      message:
        result.minted > 0
          ? `發出 ${result.minted} ${config.coinUnitLabel}，餘額 ${result.balance}。`
          : `本次無新增可發幣數（今日已發 ${result.dailyEarned}／上限 ${config.dailyEarnCap}）。`,
    });
  } catch (e) {
    next(e);
  }
});

// 批次同步（Kiosk）。body: { nodeId?, date?, items:[{ wristbandUid|walletId, steps, heartRate?, syncWindowHours? }] }
// 步數憑證以單一 transaction Bundle 上傳（示範 Bundle 資源），再逐筆發幣。
router.post('/batch-sync', async (req, res, next) => {
  try {
    const { items, date, nodeId, syncWindowHours } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: '需提供 items 陣列。' });
    const d = date || today();
    const when = `${d}T${new Date().toISOString().slice(11)}`;

    // 先解析每筆對象（手環 UID 或 walletId）並做防偽
    const resolved = [];
    for (const it of items) {
      const r = { input: it };
      try {
        let account = null;
        if (it.walletId) account = await findAccountByWallet(it.walletId);
        else if (it.wristbandUid) {
          const p = await findPatientByWristband(it.wristbandUid);
          if (p) account = await findAccountByWallet(patientView(p).walletId);
        }
        if (!account) { r.error = '查無對應錢包/手環。'; resolved.push(r); continue; }
        r.account = account;
        r.patientRef = patientRefOf(account);
        const before = await recompute(r.patientRef, d);
        r.cumulative = Number(it.steps);
        r.delta = Math.max(0, r.cumulative - before.dailySteps);
        const af = antiFraudCheck(r.delta, Number(it.syncWindowHours ?? syncWindowHours));
        if (!af.ok) { r.error = `防偽攔截（${af.ratePerHour} 步/小時 > ${af.threshold}）`; r.antiFraud = af; }
        r.aerobic = detectAerobic(it.heartRate != null ? Number(it.heartRate) : null);
      } catch (e) {
        r.error = e.message;
      }
      resolved.push(r);
    }

    // 以 transaction Bundle 一次上傳所有通過防偽者的步數憑證
    const minting = resolved.filter((r) => r.account && !r.error);
    if (minting.length) {
      const bundle = await fhir.transaction(
        minting.map((r) => ({
          method: 'POST',
          url: 'Observation',
          resource: buildStepObservation({
            patientRef: r.patientRef,
            steps: r.cumulative,
            heartRate: r.input.heartRate != null ? Number(r.input.heartRate) : undefined,
            when,
            detail: { date: d, nodeId: nodeId || null, batch: true, aerobic: r.aerobic },
          }),
        }))
      );
      // 對應回傳的建立結果，取得 step Observation 參照供 derivedFrom 證據鏈
      const created = bundle?.entry || [];
      minting.forEach((r, i) => {
        const loc = created[i]?.response?.location || (created[i]?.resource ? `Observation/${created[i].resource.id}` : null);
        r.stepObsRef = loc ? loc.replace(/^.*?(Observation\/[^/]+).*$/, '$1') : undefined;
      });
    }

    // 逐筆發幣
    const out = [];
    for (const r of resolved) {
      if (r.error || !r.account) { out.push({ input: r.input, ok: false, error: r.error || '無法處理' }); continue; }
      const m = await mintFromCumulative({
        account: r.account, patientRef: r.patientRef, cumulativeSteps: r.cumulative, aerobic: r.aerobic, date: d, when, stepObsRef: r.stepObsRef,
      });
      const walletId = r.account.identifier?.find((i) => i.system === SYSTEMS.walletId)?.value || null;
      out.push({ input: r.input, ok: true, walletId, steps: r.cumulative, aerobic: r.aerobic, minted: m.minted, balance: m.balance });
    }

    const totalMinted = out.reduce((s, x) => s + (x.minted || 0), 0);
    res.status(201).json({ date: d, nodeId: nodeId || null, count: out.length, totalMinted, results: out });
  } catch (e) {
    next(e);
  }
});

export default router;
