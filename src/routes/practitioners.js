// 人事資料（Practitioner）— 會計室核銷端
// 對應計畫書：依本薪自動判定薪資模式

import { Router } from 'express';
import { fhir } from '../fhirClient.js';
import { practitionerToFhir, practitionerFromFhir } from '../mappers.js';
import { EXT } from '../config.js';

const router = Router();

const getDeviceToken = (raw) => (raw.extension || []).find((e) => e.url === EXT.deviceToken)?.valueString || '';

// 列出所有員工（含薪資參數，僅供會計室）
router.get('/', async (req, res, next) => {
  try {
    const list = await fhir.searchAll('Practitioner', { _count: 200 });
    res.json(list.map(practitionerFromFhir));
  } catch (e) {
    next(e);
  }
});

// 讀取單一員工
router.get('/:id', async (req, res, next) => {
  try {
    const r = await fhir.read('Practitioner', req.params.id);
    res.json(practitionerFromFhir(r));
  } catch (e) {
    next(e);
  }
});

// 新增員工
router.post('/', async (req, res, next) => {
  try {
    const created = await fhir.create('Practitioner', practitionerToFhir(req.body));
    res.status(201).json(practitionerFromFhir(created));
  } catch (e) {
    next(e);
  }
});

// 更新員工（保留既有的裝置綁定與綁定開放狀態，避免編輯資料時被清掉）
router.put('/:id', async (req, res, next) => {
  try {
    const existing = await fhir.read('Practitioner', req.params.id);
    const deviceToken = req.body.deviceToken ?? getDeviceToken(existing);
    const bindingOpen = req.body.bindingOpen ?? !!(existing.extension || []).find((e) => e.url === EXT.bindingOpen)?.valueBoolean;
    const updated = await fhir.update('Practitioner', req.params.id, practitionerToFhir({ ...req.body, id: req.params.id, deviceToken, bindingOpen }));
    res.json(practitionerFromFhir(updated));
  } catch (e) {
    next(e);
  }
});

// 開放綁定（會計室授權）：員工下次用手機打卡即可綁定／換綁該手機，綁定後自動上鎖
router.post('/:id/open-binding', async (req, res, next) => {
  try {
    const raw = await fhir.read('Practitioner', req.params.id);
    raw.extension = (raw.extension || []).filter((e) => e.url !== EXT.bindingOpen);
    raw.extension.push({ url: EXT.bindingOpen, valueBoolean: true });
    const updated = await fhir.update('Practitioner', req.params.id, raw);
    res.json(practitionerFromFhir(updated));
  } catch (e) {
    next(e);
  }
});

// 解除裝置綁定（清掉已綁定的手機，並順便開放綁定，方便員工換手機）
router.post('/:id/reset-device', async (req, res, next) => {
  try {
    const raw = await fhir.read('Practitioner', req.params.id);
    raw.extension = (raw.extension || []).filter((e) => e.url !== EXT.deviceToken && e.url !== EXT.bindingOpen);
    raw.extension.push({ url: EXT.bindingOpen, valueBoolean: true });
    const updated = await fhir.update('Practitioner', req.params.id, raw);
    res.json(practitionerFromFhir(updated));
  } catch (e) {
    next(e);
  }
});

// 刪除員工
router.delete('/:id', async (req, res, next) => {
  try {
    await fhir.remove('Practitioner', req.params.id);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
