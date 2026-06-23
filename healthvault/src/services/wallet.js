// 錢包服務 — Account（健康幣帳戶）與 Ledger（交易帳本）。
//
// 企劃書〈四、4.3〉與〈七〉的兩條鐵則，在無資料庫交易的 FHIR 環境下以如下方式落實：
//  1) 流水帳先行：餘額一律由「帳本（health-coin-ledger 類 Observation）帶號加總」即時重算，
//     Account 上的 balance/每日計數僅為快取（顯示用），決策不依賴快取。
//  2) 冪等／不重複入帳・不超扣：每筆帳本帶唯一冪等鍵（identifier），寫入前先查重；
//     發幣以「日累計應得 − 今日已發」計算增量；核銷前以重算餘額把關，杜絕超扣。
import { randomUUID } from 'node:crypto';
import { fhir } from '../fhirClient.js';
import { config, SYSTEMS, OBS_CATEGORY, TXN, ACCOUNT_STATUS, EXT } from '../config.js';
import {
  buildStepObservation,
  buildLedgerObservation,
  withAccountCache,
  patientView,
} from '../mappers.js';
import { entitledCoins } from './minting.js';

export const today = () => new Date().toISOString().slice(0, 10);
const dayOf = (iso) => String(iso || '').slice(0, 10);

// ── 解析錢包 ─────────────────────────────────────────────────
export async function findAccountByWallet(walletId) {
  const accs = await fhir.search('Account', { identifier: `${SYSTEMS.walletId}|${walletId}` });
  return accs[0] || null;
}

export async function findPatientByWristband(uid) {
  const ps = await fhir.search('Patient', { identifier: `${SYSTEMS.wristband}|${uid}` });
  return ps[0] || null;
}

// 由錢包帳戶推得其 Patient 參照
export const patientRefOf = (account) => account?.subject?.[0]?.reference || null;

// ── 重算（帳本為準）───────────────────────────────────────────
// 回傳 { balance, dailyEarned, dailySpent, dailySteps }，後三者針對指定日期。
export async function recompute(patientRef, date) {
  const ledger = await fhir.searchAll('Observation', {
    subject: patientRef,
    category: OBS_CATEGORY.ledger,
    _count: 500,
  });
  let balance = 0;
  let dailyEarned = 0;
  let dailySpent = 0;
  for (const o of ledger) {
    const v = Number(o.valueQuantity?.value || 0); // 帶號：+ 入帳 / - 扣款
    balance += v;
    if (date && dayOf(o.effectiveDateTime) === date) {
      if (v >= 0) dailyEarned += v;
      else dailySpent += -v;
    }
  }
  let dailySteps = 0;
  if (date) {
    const steps = await fhir.searchAll('Observation', {
      subject: patientRef,
      category: OBS_CATEGORY.step,
      _count: 500,
    });
    for (const s of steps) {
      if (dayOf(s.effectiveDateTime) === date) {
        dailySteps = Math.max(dailySteps, Number(s.valueQuantity?.value || 0));
      }
    }
  }
  // 浮點修整（加權後一律整數，但 1.2 乘法可能產生 9.999…）
  return {
    balance: Math.round(balance),
    dailyEarned: Math.round(dailyEarned),
    dailySpent: Math.round(dailySpent),
    dailySteps,
  };
}

// 寫一筆帳本（流水帳先行）。idempotencyKey 已存在則回傳既有筆（不重複入帳）。
export async function postLedger({ patientRef, type, signedCoins, when, idempotencyKey, derivedFrom, detail, note }) {
  if (idempotencyKey) {
    const existing = await fhir.search('Observation', { identifier: `${SYSTEMS.idempotency}|${idempotencyKey}` });
    if (existing.length) return { entry: existing[0], duplicate: true };
  }
  const entry = await fhir.create(
    'Observation',
    buildLedgerObservation({ patientRef, type, signedCoins, when, idempotencyKey, derivedFrom, detail, note })
  );
  return { entry, duplicate: false };
}

// 以重算結果更新 Account 快取（顯示用；失敗不影響帳本正確性）。
export async function syncCache(account, computed, date) {
  const updated = withAccountCache(account, { ...computed, date });
  try {
    return await fhir.update('Account', account.id, updated);
  } catch {
    return updated; // 快取更新失敗時，帳本仍為事實來源
  }
}

// 建立步數憑證（健康數據引擎產出的可信 Observation）；idempotencyKey 可避免重送重複建立。
export async function createStepCredential({ patientRef, steps, heartRate, when, idempotencyKey, detail }) {
  if (idempotencyKey) {
    const existing = await fhir.search('Observation', { identifier: `${SYSTEMS.idempotency}|${idempotencyKey}` });
    if (existing.length) return existing[0];
  }
  return fhir.create('Observation', buildStepObservation({ patientRef, steps, heartRate, when, idempotencyKey, detail }));
}

// 依「日累計步數」發幣（增量 = 應得 − 今日已發）。回傳發出的幣數與重算後餘額。
export async function mintFromCumulative({ account, patientRef, cumulativeSteps, aerobic, date, when, stepObsRef, idempotencyKey }) {
  const before = await recompute(patientRef, date);
  const entitled = entitledCoins(cumulativeSteps, aerobic); // 含 ×1.2 加權與單日上限 50
  const toMint = Math.max(0, entitled - before.dailyEarned); // 只發增量、不超過單日上限

  let ledgerId = null;
  let duplicate = false;
  if (toMint > 0) {
    const key = idempotencyKey || `earn:${patientRef}:${date}:${cumulativeSteps}`;
    const r = await postLedger({
      patientRef,
      type: TXN.earn,
      signedCoins: toMint, // 正值＝入帳
      when,
      idempotencyKey: key,
      derivedFrom: stepObsRef ? [stepObsRef] : undefined,
      detail: { kind: 'earn', cumulativeSteps, aerobic, weight: aerobic ? config.aerobicWeight : 1, entitled, minted: toMint, date },
      note: `走路發幣：累計 ${cumulativeSteps} 步${aerobic ? '（有氧加權 ×' + config.aerobicWeight + '）' : ''} → +${toMint} ${config.coinUnitLabel}`,
    });
    ledgerId = r.entry.id;
    duplicate = r.duplicate;
  }

  const after = await recompute(patientRef, date);
  await syncCache(account, after, date);
  return { minted: toMint, entitled, duplicate, ledgerId, ...after };
}

// 核銷扣款（特約店 POS）。內含風控閘道器；回傳結構化結果供路由決定 HTTP 狀態與家屬通知。
export async function spend({ account, item, qty = 1, posId, idempotencyKey, date }) {
  const patientRef = patientRefOf(account);
  const d = date || today();

  // 冪等：同一筆核銷重送（同 idempotencyKey）→ 回既有收據，不重複扣款
  if (idempotencyKey) {
    const existing = await fhir.search('Observation', { identifier: `${SYSTEMS.idempotency}|${idempotencyKey}` });
    if (existing.length) {
      const after = await recompute(patientRef, d);
      return { ok: true, duplicate: true, ledgerId: existing[0].id, cost: -Number(existing[0].valueQuantity?.value || 0), balance: after.balance, ...after };
    }
  }

  // 風控 1：帳戶須為 active（凍結 on-hold 一律拒絕）
  if (account.status !== ACCOUNT_STATUS.active) {
    return { ok: false, reason: 'frozen', message: '帳戶已凍結（掛失），無法核銷。' };
  }
  // 風控 2：品項須在白名單（非白名單＝盜刷攔截點）
  if (!item) {
    return { ok: false, reason: 'not-whitelisted', message: '品項不在健康物資白名單，已拒絕。' };
  }
  const cost = item.price * qty;
  if (!(cost > 0)) return { ok: false, reason: 'invalid', message: '核銷金額不正確。' };

  const before = await recompute(patientRef, d);
  // 風控 3：餘額須足夠（杜絕超扣）
  if (before.balance < cost) {
    return { ok: false, reason: 'insufficient', message: `餘額不足（餘額 ${before.balance}，需 ${cost}）。`, balance: before.balance };
  }
  // 風控 4：不得超過單日消費上限（靜態載具止損線）
  if (before.dailySpent + cost > config.dailySpendCap) {
    return {
      ok: false,
      reason: 'daily-limit',
      message: `超過單日消費上限 ${config.dailySpendCap}（今日已用 ${before.dailySpent}，本次 ${cost}）。`,
      balance: before.balance,
      dailySpent: before.dailySpent,
    };
  }

  // 通過 → 流水帳先行：寫扣款帳本，再更新快取
  const key = idempotencyKey || `spend:${patientRef}:${posId || 'pos'}:${randomUUID()}`;
  const detail = { kind: 'spend', itemCode: item.code, itemName: item.name, qty, unitPrice: item.price, cost, posId: posId || null, date: d };
  const r = await postLedger({
    patientRef,
    type: TXN.spend,
    signedCoins: -cost, // 負值＝扣款
    idempotencyKey: key,
    detail,
    note: `核銷 ${item.name} ×${qty} → -${cost} ${config.coinUnitLabel}`,
  });
  const after = await recompute(patientRef, d);
  await syncCache(account, after, d);
  return { ok: true, ledgerId: r.entry.id, cost, receipt: { ...detail, serial: r.entry.id }, balance: after.balance, ...after };
}

// 凍結 / 解凍（family 一鍵）。回傳更新後的 Account。
export async function setStatus(account, status, reason) {
  const others = (account.extension || []).filter((e) => e.url !== EXT.frozenReason);
  const ext = status === ACCOUNT_STATUS.onHold && reason
    ? [...others, { url: EXT.frozenReason, valueString: reason }]
    : others;
  return fhir.update('Account', account.id, { ...account, status, extension: ext });
}

// 對外（系統端）解析：回傳 { account, patientRef, name }。商戶端請勿使用 name。
export async function resolveWallet(walletId) {
  const account = await findAccountByWallet(walletId);
  if (!account) return null;
  const patientRef = patientRefOf(account);
  let name = '';
  try {
    const pid = patientRef?.split('/').pop();
    if (pid) name = patientView(await fhir.read('Patient', pid)).name;
  } catch { /* 名稱非必要 */ }
  return { account, patientRef, name, walletId };
}
