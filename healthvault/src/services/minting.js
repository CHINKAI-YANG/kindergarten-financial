// 發幣規則（健康數據引擎）— 企劃書 6.1 與〈附錄：規則速查〉的純函式實作。
//   1,000 步 = 1 幣（無條件捨去）；有氧達標 ×1.2（取整）；單日上限 50 幣；
//   單次同步 > 15,000 步/小時 判為異常並拒絕。
import { config } from '../config.js';

// 以平均心率判定是否落在有氧區間（需心率佐證）
export function detectAerobic(heartRate) {
  return heartRate != null && heartRate >= config.aerobicHrMin && heartRate <= config.aerobicHrMax;
}

// 依「當日累計步數」計算今天「應得」的健康幣總額（含加權與單日上限）。
// 採「日累計 → 應得總額」模型，再扣掉今天已發的部分（見 wallet.mintForSync），
// 天然支援「每日步數快照、只發增量」且杜絕同日重複發幣。
export function entitledCoins(cumulativeSteps, aerobic) {
  const base = Math.floor(Math.max(0, cumulativeSteps) / config.stepsPerCoin); // 1000 步 = 1 幣，無條件捨去
  const weight = aerobic ? config.aerobicWeight : 1; // 有氧加權（上限 1.2）
  const weighted = Math.floor(base * weight); // 取整（floor(8×1.2)=9）
  return Math.min(weighted, config.dailyEarnCap); // 單日發幣上限 50
}

// 防偽：單位時間步數上限。windowHours 未提供時用保守預設（即時手機同步）。
export function antiFraudCheck(deltaSteps, windowHours) {
  const hrs = windowHours && windowHours > 0 ? windowHours : config.defaultSyncWindowHours;
  const rate = deltaSteps / hrs; // 步/小時
  return {
    ok: rate <= config.antiFraudStepsPerHour,
    ratePerHour: Math.round(rate),
    threshold: config.antiFraudStepsPerHour,
    windowHours: hrs,
  };
}
