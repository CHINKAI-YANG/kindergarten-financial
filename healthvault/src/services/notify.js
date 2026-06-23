// 家屬即時通知（企劃書情境四：風險阻斷）。
// 風控閘道器攔截「非白名單品項」或「超過單日上限」時，以及帳戶被凍結/解凍時，
// 推送通知給家屬。此處以記憶體環形緩衝 + console 紀錄示意；
// 正式環境可改接推播 / SMS / Email。

const MAX_PER_WALLET = 50;
const store = new Map(); // walletId -> alerts[]

export function pushAlert(walletId, alert) {
  if (!walletId) return;
  const list = store.get(walletId) || [];
  const entry = { ...alert, at: new Date().toISOString() };
  list.unshift(entry);
  if (list.length > MAX_PER_WALLET) list.length = MAX_PER_WALLET;
  store.set(walletId, list);
  console.log(`[notify] 家屬通知 wallet=${walletId} type=${alert.type} ${alert.message || ''}`);
  return entry;
}

export function getAlerts(walletId) {
  return [...(store.get(walletId) || [])];
}
