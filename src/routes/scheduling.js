// 排班 API（/api/scheduling/*）— 會計室核銷端
// 採 FHIR 標準三層模型：Schedule（可排範圍）→ Slot（可排時段）→ Appointment（實際預約）
// 對應計畫書：時段佔用狀態 free/busy，避免同一時段重複排班。

import { Router } from 'express';
import { fhir } from '../fhirClient.js';

const router = Router();

// ---- Schedule：定義人員可被排班的時間範圍 ----
router.get('/schedules', async (req, res, next) => {
  try {
    res.json(await fhir.searchAll('Schedule', { _count: 200 }));
  } catch (e) { next(e); }
});

router.post('/schedules', async (req, res, next) => {
  try {
    const { practitionerRef, practitionerName, start, end, comment } = req.body;
    const created = await fhir.create('Schedule', {
      resourceType: 'Schedule',
      active: true,
      actor: [{ reference: practitionerRef, display: practitionerName }],
      planningHorizon: { start, end },
      comment: comment || '可排班範圍',
    });
    res.status(201).json(created);
  } catch (e) { next(e); }
});

// ---- Slot：具體可預約時段，含佔用狀態 ----
router.get('/slots', async (req, res, next) => {
  try {
    const params = { _count: 300 };
    if (req.query.schedule) params.schedule = req.query.schedule;
    res.json(await fhir.searchAll('Slot', params));
  } catch (e) { next(e); }
});

router.post('/slots', async (req, res, next) => {
  try {
    const { scheduleRef, start, end } = req.body;
    const created = await fhir.create('Slot', {
      resourceType: 'Slot',
      schedule: { reference: scheduleRef },
      status: 'free',
      start,
      end,
    });
    res.status(201).json(created);
  } catch (e) { next(e); }
});

// ---- Appointment：實際預約，佔用對應 Slot ----
router.get('/appointments', async (req, res, next) => {
  try {
    res.json(await fhir.searchAll('Appointment', { _count: 300 }));
  } catch (e) { next(e); }
});

router.post('/appointments', async (req, res, next) => {
  try {
    const { slotRef, practitionerRef, practitionerName, start, end } = req.body;

    // 防重複排班：若該 Slot 已被佔用則阻擋
    if (slotRef) {
      const slotId = slotRef.split('/').pop();
      const slot = await fhir.read('Slot', slotId);
      if (slot.status === 'busy') {
        return res.status(409).json({ error: '該時段已被預約（busy），無法重複排班。' });
      }
    }

    const created = await fhir.create('Appointment', {
      resourceType: 'Appointment',
      status: 'booked',
      start,
      end,
      slot: slotRef ? [{ reference: slotRef }] : undefined,
      participant: [{ actor: { reference: practitionerRef, display: practitionerName }, status: 'accepted' }],
    });

    // 將 Slot 標記為 busy
    if (slotRef) {
      const slotId = slotRef.split('/').pop();
      const slot = await fhir.read('Slot', slotId);
      slot.status = 'busy';
      await fhir.update('Slot', slotId, slot);
    }

    res.status(201).json(created);
  } catch (e) { next(e); }
});

export default router;
