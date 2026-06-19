// 會計結算與發薪 API（/api/claims/*）— 會計室核銷端
//   Claim         → 月底結算（工資必須綁定出勤證據，否則阻斷；每筆產生收入流水號）
//   ClaimResponse → 園長簽核發薪（核准後可生成銀行媒體檔）

import { Router } from 'express';
import { fhir } from '../fhirClient.js';
import { config, EXT, SYSTEMS } from '../config.js';
import { practitionerFromFhir, encounterView } from '../mappers.js';
import { computePayroll } from '../services/payroll.js';

const router = Router();

function inPeriod(enc, startDate, endDate) {
  const s = enc.period?.start;
  if (!s) return false;
  const t = new Date(s).getTime();
  return t >= new Date(`${startDate}T00:00:00`).getTime() && t <= new Date(`${endDate}T23:59:59.999`).getTime();
}

function parsePayroll(resource) {
  const e = (resource.extension || []).find((x) => x.url === EXT.payroll);
  if (!e?.valueString) return null;
  try { return JSON.parse(e.valueString); } catch { return null; }
}

// 產生收入流水號：S + 期間年月 + 當月四碼序號（例 S202606-0001）
function nextSerial(periodStart, existingClaims) {
  const ym = String(periodStart).slice(0, 7).replace('-', '');
  const prefix = `S${ym}-`;
  const used = existingClaims
    .map((c) => c.identifier?.find((i) => i.system === SYSTEMS.serial)?.value)
    .filter((v) => v && v.startsWith(prefix));
  return prefix + String(used.length + 1).padStart(4, '0');
}

function buildClaim(p, payroll, startDate, endDate, encounterRefs, serial, patientRef) {
  const detail = {
    serial,
    practitioner: { id: p.id, name: p.name, employeeId: p.employeeId, salaryMode: p.salaryMode, bankCode: p.bankCode, bankAccount: p.bankAccount, bankLabel: p.bankLabel },
    period: { start: startDate, end: endDate },
    ...payroll,
  };
  return {
    resourceType: 'Claim',
    identifier: [
      { system: SYSTEMS.claimId, value: `${p.employeeId}-${startDate}` },
      { system: SYSTEMS.serial, value: serial },
    ],
    status: 'active',
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] },
    use: 'claim',
    // FHIR 規定 Claim.patient 只能指向 Patient，故指向員工對應的「受款人 Patient」
    // （Practitioner 仍為人事主體，兩者以員工編號 identifier 連結）。
    patient: { reference: patientRef, display: p.name },
    billablePeriod: { start: startDate, end: endDate },
    created: new Date().toISOString(),
    provider: { display: '益民幼兒園 會計室' },
    priority: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/processpriority', code: 'normal' }] },
    // 數位證據鏈：請款明確連結到實際出勤（Encounter）
    supportingInfo: encounterRefs.map((ref, i) => ({
      sequence: i + 1,
      category: { text: 'attendance-evidence' },
      valueReference: { reference: ref },
    })),
    item: payroll.lines.map((l, i) => ({
      sequence: i + 1,
      productOrService: { text: l.label },
      net: { value: l.kind === 'deduction' ? -l.amount : l.amount, currency: config.currency },
    })),
    total: { value: payroll.net, currency: config.currency },
    extension: [{ url: EXT.payroll, valueString: JSON.stringify(detail) }],
  };
}

function buildClaimResponse(claim, detail) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    resourceType: 'ClaimResponse',
    identifier: detail.serial ? [{ system: SYSTEMS.serial, value: detail.serial }] : undefined,
    status: 'active',
    type: claim.type,
    use: 'claim',
    patient: claim.patient,
    created: new Date().toISOString(),
    insurer: { display: '益民幼兒園 園長室' },
    requestor: { display: '益民幼兒園 會計室' },
    request: { reference: `Claim/${claim.id}` },
    outcome: 'complete',
    disposition: `核准，准予撥款（流水號 ${detail.serial || '—'}）`,
    payment: {
      type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/ex-paymenttype', code: 'complete' }] },
      amount: { value: detail.net, currency: config.currency },
      date: today,
    },
    total: [{
      category: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/adjudication', code: 'benefit' }] },
      amount: { value: detail.net, currency: config.currency },
    }],
    extension: [{ url: EXT.payroll, valueString: JSON.stringify({ ...detail, approvedAt: new Date().toISOString() }) }],
  };
}

// 取得（或建立）員工對應的「受款人 Patient」。
// FHIR 的 Claim.patient / ClaimResponse.patient 僅允許指向 Patient（真實 HAPI 會驗證型別），
// 故為每位 Practitioner 建立一個以相同員工編號識別的 Patient，並可重複使用（去重）。
async function ensurePayeePatient(p) {
  if (p.employeeId) {
    const found = await fhir.search('Patient', { identifier: `${SYSTEMS.employeeId}|${p.employeeId}` });
    if (found.length) return `Patient/${found[0].id}`;
  }
  const created = await fhir.create('Patient', {
    resourceType: 'Patient',
    active: true,
    identifier: p.employeeId ? [{ system: SYSTEMS.employeeId, value: p.employeeId }] : undefined,
    name: [{ text: p.name, family: p.name }],
  });
  return `Patient/${created.id}`;
}

// 結算：建立 Claim（含缺簽退阻斷 + 收入流水號）
router.post('/settle', async (req, res, next) => {
  try {
    const { practitionerId, periodStart, periodEnd } = req.body;
    if (!practitionerId || !periodStart || !periodEnd) {
      return res.status(400).json({ error: '需提供 practitionerId、periodStart、periodEnd' });
    }

    const pRes = await fhir.read('Practitioner', practitionerId);
    const p = practitionerFromFhir(pRes);

    const all = await fhir.searchAll('Encounter', { practitioner: `Practitioner/${practitionerId}`, _count: 300 });
    const mine = all.filter((e) => (e.participant || []).some((x) => x.individual?.reference === `Practitioner/${practitionerId}`));
    const periodEncs = mine.filter((e) => inPeriod(e, periodStart, periodEnd));

    // 結算阻斷：期間內若有缺簽退（in-progress）即阻斷，並回報待修正清單
    const anomalies = periodEncs.filter((e) => e.status === 'in-progress').map(encounterView);
    if (anomalies.length > 0) {
      return res.status(409).json({
        error: '發現缺簽退之異常出勤，已阻斷結算。請先於出勤稽核補登簽退時間。',
        anomalies,
      });
    }

    const finished = periodEncs.filter((e) => e.status === 'finished');
    const payroll = computePayroll(p, finished);
    const encounterRefs = finished.map((e) => `Encounter/${e.id}`);

    // 取現有 Claim 以產生流水號
    const existingClaims = await fhir.searchAll('Claim', { _count: 300 });
    const serial = nextSerial(periodStart, existingClaims);

    // 取得/建立受款人 Patient（Claim.patient 必須指向 Patient）
    const payeePatientRef = await ensurePayeePatient(p);

    const claim = await fhir.create('Claim', buildClaim(p, payroll, periodStart, periodEnd, encounterRefs, serial, payeePatientRef));
    res.status(201).json({ claim, detail: parsePayroll(claim) });
  } catch (e) {
    next(e);
  }
});

// 列出所有結算單，附帶是否已核准
router.get('/', async (req, res, next) => {
  try {
    const [claims, responses] = await Promise.all([
      fhir.searchAll('Claim', { _count: 300 }),
      fhir.searchAll('ClaimResponse', { _count: 300 }),
    ]);
    const approvedClaimIds = new Set(
      responses.map((r) => r.request?.reference?.split('/').pop()).filter(Boolean)
    );
    const out = claims.map((c) => ({
      id: c.id,
      created: c.created,
      period: c.billablePeriod,
      detail: parsePayroll(c),
      approved: approvedClaimIds.has(c.id),
    }));
    out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    res.json(out);
  } catch (e) {
    next(e);
  }
});

// 園長核准 → 建立 ClaimResponse
router.post('/:id/approve', async (req, res, next) => {
  try {
    const claim = await fhir.read('Claim', req.params.id);
    const detail = parsePayroll(claim);
    if (!detail) return res.status(400).json({ error: '結算單缺少薪資明細，無法核准。' });

    // 避免重複核准
    const existing = await fhir.searchAll('ClaimResponse', { request: `Claim/${claim.id}`, _count: 10 });
    const dup = existing.find((r) => r.request?.reference === `Claim/${claim.id}`);
    if (dup) return res.status(200).json({ claimResponse: dup, detail: parsePayroll(dup), already: true });

    const cr = await fhir.create('ClaimResponse', buildClaimResponse(claim, detail));
    res.status(201).json({ claimResponse: cr, detail: parsePayroll(cr) });
  } catch (e) {
    next(e);
  }
});

export default router;
