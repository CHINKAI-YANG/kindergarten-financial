// 合作金庫媒體轉帳檔（salary.txt）產生器
//
// 計畫書情境 C：一鍵生成合庫媒體轉帳檔，會計可直接另存為 salary.txt 交付銀行批次轉帳。
//
// 每筆收入皆帶「流水號」，欄位順序（固定欄寬，簡化版合庫媒體檔）：
//   [流水號 12][銀行代碼 3][帳號 14，右靠補零][金額 10，右靠補零，整數元][姓名]
// 並在檔尾附上一行匯總（總筆數、總金額）以利對帳。

function padLeftDigits(str, len, ch = '0') {
  str = String(str).replace(/\D/g, '');
  return str.length >= len ? str.slice(-len) : ch.repeat(len - str.length) + str;
}
function padRight(str, len) {
  str = String(str || '');
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

/**
 * @param {Array<{serial,bankCode,bankAccount,amount,name}>} rows
 * @returns {string} 媒體檔文字內容
 */
export function buildBankFile(rows) {
  const lines = [];
  let totalAmount = 0;
  rows.forEach((r, i) => {
    const serial = padRight(r.serial || `NO-${i + 1}`, 12);
    const bankCode = padLeftDigits(r.bankCode || '006', 3);
    const account = padLeftDigits(r.bankAccount, 14);
    const amount = padLeftDigits(Math.round(r.amount), 10);
    const name = (r.name || '').trim();
    lines.push(`${serial}${bankCode}${account}${amount}${name}`);
    totalAmount += Math.round(r.amount);
  });
  // 檔尾匯總列（以 T 起首，方便銀行端核對）
  lines.push(`T${padLeftDigits(rows.length, 6)}${padLeftDigits(totalAmount, 13)}`);
  return lines.join('\r\n') + '\r\n';
}
