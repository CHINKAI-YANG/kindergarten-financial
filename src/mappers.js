// domain 物件 <-> FHIR 資源 的轉換工具

import { EXT, SYSTEMS, WORK_TYPES, config } from './config.js';

// ---- extension 讀寫工具 ----
function extVal(resource, url) {
  const e = (resource.extension || []).find((x) => x.url === url);
  if (!e) return undefined;
  return e.valueDecimal ?? e.valueInteger ?? e.valueString ?? e.valueBoolean;
}

function decimalExt(url, value) {
  return { url, valueDecimal: Number(value) || 0 };
}
function stringExt(url, value) {
  return { url, valueString: value == null ? '' : String(value) };
}

// ---- Practitioner ----
// domain: { id, employeeId, name, baseSalary, hourlyRate, afterCareRate,
//           overtimeRate, laborInsurance, healthInsurance, bankCode, bankAccount }

export function practitionerToFhir(p) {
  const resource = {
    resourceType: 'Practitioner',
    identifier: [{ system: SYSTEMS.employeeId, value: p.employeeId }],
    active: true,
    name: [{ text: p.name, family: p.name }],
    extension: [
      decimalExt(EXT.baseSalary, p.baseSalary),
      decimalExt(EXT.hourlyRate, p.hourlyRate),
      decimalExt(EXT.afterCareRate, p.afterCareRate),
      decimalExt(EXT.overtimeRate, p.overtimeRate),
      decimalExt(EXT.laborInsurance, p.laborInsurance),
      decimalExt(EXT.healthInsurance, p.healthInsurance),
      stringExt(EXT.bankCode, p.bankCode || config.defaultBankCode),
      stringExt(EXT.bankAccount, p.bankAccount),
    ],
  };
  if (p.id) resource.id = p.id;
  return resource;
}

export function practitionerFromFhir(r) {
  const baseSalary = Number(extVal(r, EXT.baseSalary) || 0);
  return {
    id: r.id,
    employeeId: r.identifier?.find((i) => i.system === SYSTEMS.employeeId)?.value || '',
    name: r.name?.[0]?.text || r.name?.[0]?.family || '(未命名)',
    baseSalary,
    hourlyRate: Number(extVal(r, EXT.hourlyRate) || 0),
    afterCareRate: Number(extVal(r, EXT.afterCareRate) || 0),
    overtimeRate: Number(extVal(r, EXT.overtimeRate) || 0),
    laborInsurance: Number(extVal(r, EXT.laborInsurance) || 0),
    healthInsurance: Number(extVal(r, EXT.healthInsurance) || 0),
    bankCode: extVal(r, EXT.bankCode) || config.defaultBankCode,
    bankAccount: extVal(r, EXT.bankAccount) || '',
    // 由本薪自動判定薪資模式（核心防錯機制之一）
    salaryMode: baseSalary > 0 ? 'monthly' : 'hourly',
  };
}

// 給打卡端用的「最小揭露」版本：只有姓名與識別碼，不含任何薪資/保費資料（權限分流）
export function practitionerPublic(r) {
  return {
    id: r.id,
    employeeId: r.identifier?.find((i) => i.system === SYSTEMS.employeeId)?.value || '',
    name: r.name?.[0]?.text || r.name?.[0]?.family || '(未命名)',
  };
}

// ---- Encounter（打卡）----
export function workTypeOf(encounter) {
  const coding = (encounter.type || [])
    .flatMap((t) => t.coding || [])
    .find((c) => c.system === SYSTEMS.workType);
  return coding?.code || 'regular';
}

// 由打卡時間換算十進位工時（四捨五入到小數第 2 位）；未簽退則為 0
export function encounterHours(encounter) {
  const start = encounter.period?.start;
  const end = encounter.period?.end;
  if (!start || !end) return 0;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!(ms > 0)) return 0;
  return Math.round((ms / 3600000) * 100) / 100;
}

export function encounterView(r) {
  const code = workTypeOf(r);
  return {
    id: r.id,
    practitionerRef: r.participant?.[0]?.individual?.reference || '',
    practitionerName: r.participant?.[0]?.individual?.display || '',
    status: r.status, // in-progress = 缺簽退異常；finished = 正常
    workType: code,
    workTypeDisplay: WORK_TYPES[code]?.display || code,
    start: r.period?.start || null,
    end: r.period?.end || null,
    hours: encounterHours(r),
    anomaly: r.status === 'in-progress', // 缺簽退即時標記
  };
}
