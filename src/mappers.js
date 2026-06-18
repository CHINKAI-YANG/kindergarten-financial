// domain 物件 <-> FHIR 資源 的轉換工具

import { EXT, SYSTEMS, WORK_TYPES, BANKS, config } from './config.js';

// ---- extension 讀寫工具 ----
function extVal(resource, url) {
  const e = (resource.extension || []).find((x) => x.url === url);
  if (!e) return undefined;
  return e.valueDecimal ?? e.valueInteger ?? e.valueString ?? e.valueBoolean;
}
const decimalExt = (url, value) => ({ url, valueDecimal: Number(value) || 0 });
const stringExt = (url, value) => ({ url, valueString: value == null ? '' : String(value) });
const boolExt = (url, value) => ({ url, valueBoolean: !!value });

const round = (n) => Math.round(n);

// 銀行代碼 → 清楚標示（含中文行名）
export function bankLabel(code) {
  const c = String(code || '').trim();
  return BANKS[c] ? `${BANKS[c]}（${c}）` : `銀行代碼 ${c}`;
}

// ---- Practitioner ----
// domain: { id, employeeId, name, baseSalary, hourlyRate, afterCareRate, overtimeRate,
//   insuredSalary, autoInsurance, laborInsurance(手動), healthInsurance(手動),
//   bankCode, bankAccount, deviceToken }

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
      decimalExt(EXT.insuredSalary, p.insuredSalary),
      // 預設自動計算勞健保（autoInsurance 未明確給 false 即視為 true）
      boolExt(EXT.autoInsurance, p.autoInsurance !== false),
      decimalExt(EXT.laborInsurance, p.laborInsurance),   // 手動覆寫金額
      decimalExt(EXT.healthInsurance, p.healthInsurance), // 手動覆寫金額
      stringExt(EXT.bankCode, p.bankCode || config.defaultBankCode),
      stringExt(EXT.bankAccount, p.bankAccount),
    ],
  };
  // 打卡綁定之裝置（僅在有值時寫入，避免編輯時被清掉）
  if (p.deviceToken) resource.extension.push(stringExt(EXT.deviceToken, p.deviceToken));
  if (p.id) resource.id = p.id;
  return resource;
}

export function practitionerFromFhir(r) {
  const baseSalary = Number(extVal(r, EXT.baseSalary) || 0);
  const insuredSalary = Number(extVal(r, EXT.insuredSalary) || 0);
  const autoInsurance = extVal(r, EXT.autoInsurance);
  const auto = autoInsurance === undefined ? true : !!autoInsurance;
  const laborManual = Number(extVal(r, EXT.laborInsurance) || 0);
  const healthManual = Number(extVal(r, EXT.healthInsurance) || 0);

  // 自動計算：投保薪資 × 員工自付費率
  const laborComputed = round(insuredSalary * config.laborInsuranceRate);
  const healthComputed = round(insuredSalary * config.healthInsuranceRate);

  // 生效金額（payroll 使用）：自動模式取計算值，手動模式取覆寫值
  const laborEffective = auto ? laborComputed : laborManual;
  const healthEffective = auto ? healthComputed : healthManual;

  const deviceToken = extVal(r, EXT.deviceToken) || '';
  const bankCode = extVal(r, EXT.bankCode) || config.defaultBankCode;
  const bankAccount = extVal(r, EXT.bankAccount) || '';

  return {
    id: r.id,
    employeeId: r.identifier?.find((i) => i.system === SYSTEMS.employeeId)?.value || '',
    name: r.name?.[0]?.text || r.name?.[0]?.family || '(未命名)',
    baseSalary,
    hourlyRate: Number(extVal(r, EXT.hourlyRate) || 0),
    afterCareRate: Number(extVal(r, EXT.afterCareRate) || 0),
    overtimeRate: Number(extVal(r, EXT.overtimeRate) || 0),
    // 勞健保
    insuredSalary,
    autoInsurance: auto,
    laborInsuranceManual: laborManual,
    healthInsuranceManual: healthManual,
    laborInsuranceComputed: laborComputed,
    healthInsuranceComputed: healthComputed,
    // 生效值（供 payroll 直接取用）
    laborInsurance: laborEffective,
    healthInsurance: healthEffective,
    laborInsuranceRate: config.laborInsuranceRate,
    healthInsuranceRate: config.healthInsuranceRate,
    // 銀行
    bankCode,
    bankAccount,
    bankLabel: bankLabel(bankCode),
    // 裝置綁定
    deviceToken,
    deviceBound: !!deviceToken,
    // 由本薪自動判定薪資模式（核心防錯機制之一）
    salaryMode: baseSalary > 0 ? 'monthly' : 'hourly',
  };
}

// 給打卡端用的「最小揭露」版本：只有姓名、識別碼與是否已綁定裝置；不含任何薪資/保費資料（權限分流）
export function practitionerPublic(r) {
  return {
    id: r.id,
    employeeId: r.identifier?.find((i) => i.system === SYSTEMS.employeeId)?.value || '',
    name: r.name?.[0]?.text || r.name?.[0]?.family || '(未命名)',
    deviceBound: !!extVal(r, EXT.deviceToken),
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

// 跨日未簽退：狀態 in-progress 且簽到日期早於今天 → 需「隔天立即處理」
function isStale(encounter) {
  if (encounter.status !== 'in-progress' || !encounter.period?.start) return false;
  const d = new Date(encounter.period.start);
  const today = new Date();
  const ymd = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  return ymd(d) !== ymd(today) && d.getTime() < today.getTime();
}

export function encounterView(r) {
  const code = workTypeOf(r);
  return {
    id: r.id,
    practitionerRef: r.participant?.[0]?.individual?.reference || '',
    practitionerName: r.participant?.[0]?.individual?.display || '',
    status: r.status, // in-progress = 缺簽退；finished = 正常
    workType: code,
    workTypeDisplay: WORK_TYPES[code]?.display || code,
    start: r.period?.start || null,
    end: r.period?.end || null,
    hours: encounterHours(r),
    anomaly: r.status === 'in-progress', // 缺簽退即時標記
    stale: isStale(r),                    // 跨日未簽退（隔天提醒立即處理）
  };
}
