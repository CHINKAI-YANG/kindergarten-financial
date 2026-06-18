// 人事資料（Practitioner）— 會計室核銷端
// 對應計畫書：依本薪自動判定薪資模式

import { Router } from 'express';
import { fhir } from '../fhirClient.js';
import { practitionerToFhir, practitionerFromFhir } from '../mappers.js';

const router = Router();

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

// 更新員工
router.put('/:id', async (req, res, next) => {
  try {
    const updated = await fhir.update('Practitioner', req.params.id, practitionerToFhir({ ...req.body, id: req.params.id }));
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
