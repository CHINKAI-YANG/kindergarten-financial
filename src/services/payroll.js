// 薪資裁決服務
// 依人員身分（本薪是否為 0）自動套用「月薪制完整裁決」或「純計時裁決」。
// 對應計畫書情境 A（專任導師月薪制）與情境 B（兼職工讀生純時薪制）。

import { encounterHours, workTypeOf } from '../mappers.js';

const round = (n) => Math.round(n);

/**
 * 彙整某期間內、某人員的出勤工時（僅計入已簽退 finished 的紀錄）。
 */
export function summariseHours(encounters) {
  const sum = { total: 0, regular: 0, aftercare: 0, overtime: 0, count: 0 };
  for (const e of encounters) {
    if (e.status !== 'finished') continue; // 異常（in-progress）不計入
    const h = encounterHours(e);
    const type = workTypeOf(e);
    sum.total += h;
    sum[type] = (sum[type] || 0) + h;
    sum.count += 1;
  }
  // 修正浮點誤差
  for (const k of ['total', 'regular', 'aftercare', 'overtime']) {
    sum[k] = Math.round(sum[k] * 100) / 100;
  }
  return sum;
}

/**
 * 計算薪資明細。
 * @param {object} p     domain 形式的 Practitioner（含薪資/保費參數與 salaryMode）
 * @param {array}  encs  該期間內的 Encounter 陣列
 * @returns {object} { mode, hours, lines[], gross, deductions, net }
 *  - lines[].kind: 'earning' | 'deduction'
 */
export function computePayroll(p, encs) {
  const hours = summariseHours(encs);
  const lines = [];

  if (p.salaryMode === 'monthly') {
    // 月薪制完整裁決：本薪 + 課後延護費 + 行政加班費 − 勞保 − 健保
    lines.push({ kind: 'earning', label: '本薪（月薪）', qty: null, rate: null, amount: round(p.baseSalary) });

    const afterCarePay = round(hours.aftercare * p.afterCareRate);
    if (hours.aftercare > 0 || p.afterCareRate > 0) {
      lines.push({ kind: 'earning', label: '課後延護費', qty: hours.aftercare, rate: p.afterCareRate, amount: afterCarePay });
    }
    const overtimePay = round(hours.overtime * p.overtimeRate);
    if (hours.overtime > 0 || p.overtimeRate > 0) {
      lines.push({ kind: 'earning', label: '行政加班費', qty: hours.overtime, rate: p.overtimeRate, amount: overtimePay });
    }
    if (p.laborInsurance > 0) {
      lines.push({ kind: 'deduction', label: '勞保自付額', qty: null, rate: null, amount: round(p.laborInsurance) });
    }
    if (p.healthInsurance > 0) {
      lines.push({ kind: 'deduction', label: '健保自付額', qty: null, rate: null, amount: round(p.healthInsurance) });
    }
  } else {
    // 純計時裁決：全月工時 × 時薪；封鎖專任津貼與勞健保代扣（避免工讀生被誤扣）
    lines.push({
      kind: 'earning',
      label: '時薪工資',
      qty: hours.total,
      rate: p.hourlyRate,
      amount: round(hours.total * p.hourlyRate),
    });
  }

  const gross = lines.filter((l) => l.kind === 'earning').reduce((s, l) => s + l.amount, 0);
  const deductions = lines.filter((l) => l.kind === 'deduction').reduce((s, l) => s + l.amount, 0);
  const net = gross - deductions;

  return { mode: p.salaryMode, hours, lines, gross, deductions, net };
}
