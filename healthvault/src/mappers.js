// domain ↔ FHIR 轉換。核心資源：Patient（使用者）、Observation（步數憑證 / 健康幣帳本）、Account（錢包）。
// 隱私（關聯阻斷）：對商戶端只暴露 walletId 與餘額/狀態，真實姓名僅在系統端可解析。

import { SYSTEMS, EXT, OBS_CATEGORY, TXN, LOINC, ACCOUNT_STATUS, config } from './config.js';

const coinQuantity = (value) => ({
  value,
  unit: config.coinUnitLabel,
  system: SYSTEMS.coin,
  code: 'HCOIN',
});

// ── Patient（使用者）──────────────────────────────────────────
export function buildPatient({ name, walletId, wristbandUid }) {
  const identifier = [{ system: SYSTEMS.walletId, value: walletId }];
  if (wristbandUid) identifier.push({ system: SYSTEMS.wristband, value: wristbandUid });
  return {
    resourceType: 'Patient',
    active: true,
    identifier,
    name: name ? [{ text: name }] : undefined,
  };
}

export function patientView(p) {
  return {
    id: p.id,
    name: p.name?.[0]?.text || p.name?.[0]?.family || '',
    walletId: p.identifier?.find((i) => i.system === SYSTEMS.walletId)?.value || null,
    wristbandUid: p.identifier?.find((i) => i.system === SYSTEMS.wristband)?.value || null,
  };
}

// ── Account（健康幣錢包）─────────────────────────────────────
export function buildAccount({ patientRef, walletId, name }) {
  return {
    resourceType: 'Account',
    status: ACCOUNT_STATUS.active,
    type: { coding: [{ system: 'http://healthvault.tw/fhir/account-type', code: 'health-coin-wallet' }], text: '健康幣錢包' },
    name: name ? `${name} 的健康幣錢包` : '健康幣錢包',
    identifier: [{ system: SYSTEMS.walletId, value: walletId }],
    subject: [{ reference: patientRef }],
    extension: [
      { url: EXT.balance, valueDecimal: 0 },
      { url: EXT.dailyEarned, valueDecimal: 0 },
      { url: EXT.dailySpent, valueDecimal: 0 },
      { url: EXT.dailySteps, valueInteger: 0 },
      { url: EXT.dailyDate, valueDate: new Date().toISOString().slice(0, 10) },
    ],
  };
}

const extVal = (res, url) =>
  (res.extension || []).find((e) => e.url === url) || null;

export function accountView(acc) {
  const get = (url) => {
    const e = extVal(acc, url);
    return e ? (e.valueDecimal ?? e.valueInteger ?? e.valueDate ?? e.valueString) : undefined;
  };
  return {
    id: acc.id,
    walletId: acc.identifier?.find((i) => i.system === SYSTEMS.walletId)?.value || null,
    status: acc.status,
    patientRef: acc.subject?.[0]?.reference || null,
    balance: Number(get(EXT.balance) || 0),
    dailyEarned: Number(get(EXT.dailyEarned) || 0),
    dailySpent: Number(get(EXT.dailySpent) || 0),
    dailySteps: Number(get(EXT.dailySteps) || 0),
    dailyDate: get(EXT.dailyDate) || null,
    frozenReason: get(EXT.frozenReason) || null,
  };
}

// 以重算後的數值更新 Account 的快取 extension（餘額/每日計數）。
export function withAccountCache(acc, { balance, dailyEarned, dailySpent, dailySteps, date }) {
  const others = (acc.extension || []).filter(
    (e) => ![EXT.balance, EXT.dailyEarned, EXT.dailySpent, EXT.dailySteps, EXT.dailyDate].includes(e.url)
  );
  return {
    ...acc,
    extension: [
      ...others,
      { url: EXT.balance, valueDecimal: balance },
      { url: EXT.dailyEarned, valueDecimal: dailyEarned },
      { url: EXT.dailySpent, valueDecimal: dailySpent },
      { url: EXT.dailySteps, valueInteger: dailySteps },
      { url: EXT.dailyDate, valueDate: date },
    ],
  };
}

// ── 步數憑證 Observation（健康數據引擎產出）──────────────────
export function buildStepObservation({ patientRef, steps, heartRate, when, idempotencyKey, detail }) {
  const obs = {
    resourceType: 'Observation',
    status: 'final',
    identifier: idempotencyKey ? [{ system: SYSTEMS.idempotency, value: idempotencyKey }] : undefined,
    category: [
      { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: OBS_CATEGORY.step, display: 'Activity' }] },
    ],
    code: { coding: [{ system: 'http://loinc.org', code: LOINC.steps, display: 'Number of steps' }], text: '步數' },
    subject: { reference: patientRef },
    effectiveDateTime: when || new Date().toISOString(),
    valueQuantity: { value: steps, unit: 'steps', system: 'http://unitsofmeasure.org', code: '{steps}' },
  };
  if (heartRate != null) {
    obs.component = [
      {
        code: { coding: [{ system: 'http://loinc.org', code: LOINC.heartRate, display: 'Heart rate' }], text: '心率' },
        valueQuantity: { value: heartRate, unit: 'beats/minute', system: 'http://unitsofmeasure.org', code: '/min' },
      },
    ];
  }
  if (detail) obs.extension = [{ url: EXT.stepDetail, valueString: JSON.stringify(detail) }];
  return obs;
}

// ── 健康幣帳本 Observation（錢包服務流水帳；金額為帶號值，餘額=各筆總和）──
export function buildLedgerObservation({ patientRef, type, signedCoins, when, idempotencyKey, derivedFrom, detail, note }) {
  const obs = {
    resourceType: 'Observation',
    status: 'final',
    identifier: idempotencyKey ? [{ system: SYSTEMS.idempotency, value: idempotencyKey }] : undefined,
    category: [{ coding: [{ system: SYSTEMS.obsCategory, code: OBS_CATEGORY.ledger, display: '健康幣帳本' }] }],
    code: { coding: [{ system: SYSTEMS.txnType, code: type }], text: type === TXN.earn ? '發幣' : type === TXN.spend ? '核銷扣款' : '調整' },
    subject: { reference: patientRef },
    effectiveDateTime: when || new Date().toISOString(),
    valueQuantity: coinQuantity(signedCoins),
  };
  if (Array.isArray(derivedFrom) && derivedFrom.length) obs.derivedFrom = derivedFrom.map((reference) => ({ reference }));
  if (note) obs.note = [{ text: note }];
  if (detail) obs.extension = [{ url: EXT.txnDetail, valueString: JSON.stringify(detail) }];
  return obs;
}

export function ledgerView(o) {
  let detail = null;
  const e = (o.extension || []).find((x) => x.url === EXT.txnDetail);
  if (e?.valueString) { try { detail = JSON.parse(e.valueString); } catch { /* ignore */ } }
  const coins = o.valueQuantity?.value ?? 0;
  return {
    id: o.id,
    type: o.code?.coding?.find((c) => c.system === SYSTEMS.txnType)?.code || (coins >= 0 ? TXN.earn : TXN.spend),
    coins, // 帶號：+ 為入帳、- 為扣款
    when: o.effectiveDateTime || o.meta?.lastUpdated || null,
    note: o.note?.[0]?.text || null,
    derivedFrom: (o.derivedFrom || []).map((d) => d.reference),
    detail,
  };
}
