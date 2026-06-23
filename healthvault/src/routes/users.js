// /api/users — 發卡與使用者管理（管理端，需密碼授權）。
// 註冊一位使用者＝建立 Patient（真實身分主體）＋ Account（健康幣錢包，含虛擬 walletId）。
// 關聯阻斷：walletId 為對外識別，商戶端只見 walletId，不見真實姓名。
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { fhir } from '../fhirClient.js';
import { buildPatient, buildAccount, patientView, accountView } from '../mappers.js';
import { recompute } from '../services/wallet.js';

const router = Router();

// 註冊使用者並發給錢包
router.post('/', async (req, res, next) => {
  try {
    const { name, wristbandUid } = req.body || {};
    if (!name) return res.status(400).json({ error: '需提供使用者姓名 name。' });

    // 手環 UID 去重（同一手環不重複建檔）
    if (wristbandUid) {
      const dup = await fhir.search('Patient', { identifier: `http://healthvault.tw/fhir/wristband-uid|${wristbandUid}` });
      if (dup.length) return res.status(409).json({ error: `手環 UID ${wristbandUid} 已綁定其他使用者。` });
    }

    const walletId = randomUUID();
    const patient = await fhir.create('Patient', buildPatient({ name, walletId, wristbandUid }));
    const account = await fhir.create('Account', buildAccount({ patientRef: `Patient/${patient.id}`, walletId, name }));

    res.status(201).json({
      ...patientView(patient),
      accountId: account.id,
      status: account.status,
      balance: 0,
      barcode: walletId, // 數位卡 / 實體卡 / 靜態條碼之載具內容
    });
  } catch (e) {
    next(e);
  }
});

// 管理總覽：列出所有錢包（含即時重算餘額）。供發卡端 / 營運稽核使用。
router.get('/', async (req, res, next) => {
  try {
    const accounts = await fhir.searchAll('Account', { _count: 300 });
    const out = [];
    for (const acc of accounts) {
      const v = accountView(acc);
      const computed = await recompute(v.patientRef, undefined);
      let name = '';
      try {
        const pid = v.patientRef?.split('/').pop();
        if (pid) name = patientView(await fhir.read('Patient', pid)).name;
      } catch { /* ignore */ }
      out.push({ ...v, name, balance: computed.balance });
    }
    out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hant'));
    res.json(out);
  } catch (e) {
    next(e);
  }
});

export default router;
