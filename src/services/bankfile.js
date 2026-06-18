// 合作金庫媒體轉帳檔（salary.txt）產生器
//
// 計畫書情境 C：一鍵生成合庫媒體轉帳檔，格式為「銀行代碼＋帳號＋金額＋姓名」，
// 會計可直接另存為 salary.txt 交付銀行批次轉帳。
//
// 此處採固定欄寬格式（簡化版合庫媒體檔），每筆一行：
//   [銀行代碼 3] [帳號 14，右靠補零] [金額 10，右靠補零，整數元] [姓名]
// 並在檔尾附上一行匯總（總筆數、總金額）以利對帳。

function padLeft(str, len, ch = '0') {
  str = String(str).replace(/\D/g, '');
  return str.length >= len ? str.slice(-len) : ch.repeat(len - str.length) + str;
}

/**
 * @param {Array<{bankCode,bankAccount,amount,name}>} rows
 * @returns {string} 媒體檔文字內容
 */
export function buildBankFile(rows) {
  const lines = [];
  let totalAmount = 0;
  for (const r of rows) {
    const bankCode = padLeft(r.bankCode || '006', 3);
    const account = padLeft(r.bankAccount, 14);
    const amount = padLeft(Math.round(r.amount), 10);
    const name = (r.name || '').trim();
    lines.push(`${bankCode}${account}${amount}${name}`);
    totalAmount += Math.round(r.amount);
  }
  // 檔尾匯總列（以 T 起首，方便銀行端核對）
  lines.push(`T${padLeft(rows.length, 6)}${padLeft(totalAmount, 13)}`);
  return lines.join('\r\n') + '\r\n';
}
