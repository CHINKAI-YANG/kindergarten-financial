// 出勤稽核 API（/api/attendance/*）— 會計室核銷端
// 對應計畫書情境 D：忘記刷退之自動攔截與勾稽、補登簽退後自動重算工時。

import { Router } from 'express';
import { fhir } from '../fhirClient.js';
import { encounterView } from '../mappers.js';
import { remindForgotClockouts } from '../services/reminders.js';

const router = Router();

// 寄送「忘記簽退」email 提醒（跨日未簽退者，每筆只寄一次；force=true 可重寄）
router.post('/remind', async (req, res, next) => {
  try {
    res.json(await remindForgotClockouts({ force: req.body?.force === true }));
  } catch (e) {
    next(e);
  }
});

// 列出全部出勤（可選 practitionerId 過濾），含異常標記
router.get('/', async (req, res, next) => {
  try {
    const { practitionerId } = req.query;
    const params = { _count: 300, _sort: '-date' };
    if (practitionerId) params.practitioner = `Practitioner/${practitionerId}`;
    const list = await fhir.searchAll('Encounter', params);
    const views = list
      .filter((e) => !practitionerId || (e.participant || []).some((p) => p.individual?.reference === `Practitioner/${practitionerId}`))
      .map(encounterView)
      .sort((a, b) => String(b.start).localeCompare(String(a.start)));
    res.json(views);
  } catch (e) {
    next(e);
  }
});

// 補登簽退（會計查證後補上結束時間）→ 狀態改 finished，工時自動重算
router.put('/:id/clock-out', async (req, res, next) => {
  try {
    const { end } = req.body; // ISO 字串；未給則用現在時間
    const enc = await fhir.read('Encounter', req.params.id);
    enc.status = 'finished';
    enc.period = { ...(enc.period || {}), end: end || new Date().toISOString() };
    const updated = await fhir.update('Encounter', req.params.id, enc);
    res.json(encounterView(updated));
  } catch (e) {
    next(e);
  }
});

// 手動新增/補登一筆完整出勤（會計補登用）
router.post('/', async (req, res, next) => {
  try {
    const { practitionerRef, practitionerName, workTypeCoding, start, end } = req.body;
    const enc = {
      resourceType: 'Encounter',
      status: end ? 'finished' : 'in-progress',
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
      type: workTypeCoding ? [{ coding: [workTypeCoding], text: workTypeCoding.display }] : undefined,
      participant: [{ individual: { reference: practitionerRef, display: practitionerName } }],
      period: { start, end },
    };
    const created = await fhir.create('Encounter', enc);
    res.status(201).json(encounterView(created));
  } catch (e) {
    next(e);
  }
});

export default router;
