// 健康物資白名單（特約商店可核銷之品項）。
// 企劃書〈6.3 封閉型點數之合規定位〉：僅限白名單健康物資核銷，
// 不可兌換現金、菸酒或遊戲點數。價格以健康幣計。
//
// 可由環境變數 CATALOG_JSON 覆寫（JSON 陣列）。

const DEFAULT_CATALOG = [
  { code: 'VITD', name: '維生素 D3 補充品', price: 8, category: '營養品' },
  { code: 'PROTEIN', name: '乳清蛋白', price: 20, category: '營養品' },
  { code: 'FISHOIL', name: '魚油 Omega-3', price: 12, category: '營養品' },
  { code: 'BPCUFF', name: '電子血壓計', price: 60, category: '醫療輔具' },
  { code: 'GLUCOSE', name: '血糖試紙（盒）', price: 25, category: '醫療輔具' },
  { code: 'CANE', name: '伸縮手杖', price: 30, category: '醫療輔具' },
  { code: 'MASK', name: '醫療口罩（盒）', price: 5, category: '健康物資' },
  { code: 'THERMO', name: '額溫槍', price: 35, category: '醫療輔具' },
];

let catalog = DEFAULT_CATALOG;
if (process.env.CATALOG_JSON) {
  try { catalog = JSON.parse(process.env.CATALOG_JSON); } catch { /* 維持預設 */ }
}

export function listCatalog() {
  return catalog.map((i) => ({ ...i }));
}

// 查白名單品項；找不到代表非白名單（風控應攔截）。
export function findItem(code) {
  return catalog.find((i) => i.code === code) || null;
}
