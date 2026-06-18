// 員工打卡端 API（/api/clock/*）— 對應 FHIR Encounter
// 設計原則（權限分流）：本端點一律不回傳任何薪資、保費或他人財務資料。

import { Router } from 'express';
import { fhir } from '../fhirClient.js';
import { practitionerPublic, encounterView } from '../mappers.js';
import { WORK_TYPES, SYSTEMS } from '../config.js';

const router = Router();

function buildEncounter(practitioner, workTypeCode, startIso) {
  const wt = WORK_TYPES[workTypeCode] || WORK_TYPES.regular;
  return {
    resourceType: 'Encounter',
    status: 'in-progress', // 簽到後、尚未簽退 → 缺簽退即時標記之依據
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    type: [{ coding: [{ system: SYSTEMS.workType, code: wt.code, display: wt.display }], text: wt.display }],
    participant: [{
      individual: {
        reference: `Practitioner/${practitioner.id}`,
        display: practitioner.name?.[0]?.text || practitioner.name?.[0]?.family || '',
      },
    }],
    period: { start: startIso },
  };
}

// 取得可打卡的員工清單（最小揭露：僅 id / 員工編號 / 姓名）
router.get('/practitioners', async (req, res, next) => {
  try {
    const list = await fhir.searchAll('Practitioner', { _count: 200 });
    res.json(list.map(practitionerPublic));
  } catch (e) {
    next(e);
  }
});

// 找出某員工目前「未簽退」的打卡（in-progress）
async function findOpenEncounter(practitionerId) {
  const list = await fhir.searchAll('Encounter', { practitioner: `Practitioner/${practitionerId}`, status: 'in-progress', _count: 100 });
  // 不論伺服器是否支援該搜尋參數，皆再以參與者比對一次，確保正確
  return list.find(
    (e) => e.status === 'in-progress' && (e.participant || []).some((p) => p.individual?.reference === `Practitioner/${practitionerId}`)
  );
}

// 簽到
router.post('/clock-in', async (req, res, next) => {
  try {
    const { practitionerId, workType = 'regular' } = req.body;
    if (!practitionerId) return res.status(400).json({ error: '缺少 practitionerId' });

    const open = await findOpenEncounter(practitionerId);
    if (open) {
      return res.status(409).json({ error: '尚有未簽退的打卡，請先簽退。', encounter: encounterView(open) });
    }
    const practitioner = await fhir.read('Practitioner', practitionerId);
    const created = await fhir.create('Encounter', buildEncounter(practitioner, workType, new Date().toISOString()));
    res.status(201).json(encounterView(created));
  } catch (e) {
    next(e);
  }
});

// 簽退（將最近一筆 in-progress 設為 finished 並補上結束時間，自動換算工時）
router.post('/clock-out', async (req, res, next) => {
  try {
    const { practitionerId } = req.body;
    if (!practitionerId) return res.status(400).json({ error: '缺少 practitionerId' });

    const open = await findOpenEncounter(practitionerId);
    if (!open) return res.status(404).json({ error: '查無未簽退的打卡紀錄，無法簽退。' });

    open.status = 'finished';
    open.period = { ...(open.period || {}), end: new Date().toISOString() };
    const updated = await fhir.update('Encounter', open.id, open);
    res.json(encounterView(updated));
  } catch (e) {
    next(e);
  }
});

// 查詢本人出勤（僅限本人，不含薪資）
router.get('/my-attendance', async (req, res, next) => {
  try {
    const { practitionerId } = req.query;
    if (!practitionerId) return res.status(400).json({ error: '缺少 practitionerId' });
    const list = await fhir.searchAll('Encounter', { practitioner: `Practitioner/${practitionerId}`, _count: 200 });
    const mine = list
      .filter((e) => (e.participant || []).some((p) => p.individual?.reference === `Practitioner/${practitionerId}`))
      .map(encounterView)
      .sort((a, b) => String(b.start).localeCompare(String(a.start)));
    res.json(mine);
  } catch (e) {
    next(e);
  }
});

export default router;
