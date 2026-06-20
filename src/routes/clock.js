// 員工打卡端 API（/api/clock/*）— 對應 FHIR Encounter
// 設計原則（權限分流）：本端點一律不回傳任何薪資、保費或他人財務資料。
// 防代簽：打卡綁定個人裝置——首次打卡綁定該手機，之後僅限同一裝置（會計室可重設）。

import { Router } from 'express';
import { fhir } from '../fhirClient.js';
import { practitionerPublic, encounterView } from '../mappers.js';
import { WORK_TYPES, SYSTEMS, EXT } from '../config.js';

const router = Router();

const getDeviceToken = (raw) => (raw.extension || []).find((e) => e.url === EXT.deviceToken)?.valueString || '';
const getBindingOpen = (raw) => !!(raw.extension || []).find((e) => e.url === EXT.bindingOpen)?.valueBoolean;
function setDeviceToken(raw, token) {
  raw.extension = (raw.extension || []).filter((e) => e.url !== EXT.deviceToken);
  raw.extension.push({ url: EXT.deviceToken, valueString: token });
  return raw;
}
function setBindingOpen(raw, val) {
  raw.extension = (raw.extension || []).filter((e) => e.url !== EXT.bindingOpen);
  raw.extension.push({ url: EXT.bindingOpen, valueBoolean: val });
  return raw;
}

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

// 取得可打卡的員工清單（最小揭露：僅 id / 員工編號 / 姓名 / 是否已綁定裝置）
router.get('/practitioners', async (req, res, next) => {
  try {
    const list = await fhir.searchAll('Practitioner', { _count: 200 });
    res.json(list.map(practitionerPublic));
  } catch (e) {
    next(e);
  }
});

// 查詢某員工在「本裝置」的綁定狀態（none=未綁定任何裝置；this=綁定本機；other=綁定其他手機）
router.get('/device-status', async (req, res, next) => {
  try {
    const { practitionerId, deviceId } = req.query;
    if (!practitionerId) return res.status(400).json({ error: '缺少 practitionerId' });
    const raw = await fhir.read('Practitioner', practitionerId);
    const bound = getDeviceToken(raw);
    const state = !bound ? 'none' : (bound === deviceId ? 'this' : 'other');
    res.json({ bound: !!bound, state, open: getBindingOpen(raw) });
  } catch (e) {
    next(e);
  }
});

// 找出某員工目前「未簽退」的打卡（in-progress）
async function findOpenEncounter(practitionerId) {
  const list = await fhir.searchAll('Encounter', { practitioner: `Practitioner/${practitionerId}`, status: 'in-progress', _count: 100 });
  return list.find(
    (e) => e.status === 'in-progress' && (e.participant || []).some((p) => p.individual?.reference === `Practitioner/${practitionerId}`)
  );
}

// 驗證裝置綁定。綁定授權在會計室：需先「開放綁定」，員工下次打卡才會綁定此手機並自動上鎖。
// 回傳 { ok, justBound, error }
async function ensureDevice(rawPractitioner, deviceId) {
  if (!deviceId) return { ok: false, error: '缺少裝置識別，請以手機開啟打卡頁面後再操作。' };
  const bound = getDeviceToken(rawPractitioner);

  // 已綁定且就是這支手機 → 直接放行
  if (bound && bound === deviceId) return { ok: true, justBound: false };

  // 需要綁定（首次）或換綁（換手機）：一律需會計室已開放
  if (!getBindingOpen(rawPractitioner)) {
    return {
      ok: false,
      error: bound
        ? '此手機未綁定本人帳號。若要更換手機，請先請會計室「開放綁定」。'
        : '本人尚未綁定打卡手機，請先請會計室「開放綁定」後再打卡。',
    };
  }

  // 會計已開放 → 綁定目前這支手機，並自動上鎖（消耗本次開放）
  setDeviceToken(rawPractitioner, deviceId);
  setBindingOpen(rawPractitioner, false);
  await fhir.update('Practitioner', rawPractitioner.id, rawPractitioner);
  return { ok: true, justBound: true };
}

// 簽到
router.post('/clock-in', async (req, res, next) => {
  try {
    const { practitionerId, workType = 'regular', deviceId } = req.body;
    if (!practitionerId) return res.status(400).json({ error: '缺少 practitionerId' });

    const practitioner = await fhir.read('Practitioner', practitionerId);
    const dev = await ensureDevice(practitioner, deviceId);
    if (!dev.ok) return res.status(403).json({ error: dev.error });

    const open = await findOpenEncounter(practitionerId);
    if (open) {
      return res.status(409).json({ error: '尚有未簽退的打卡，請先簽退。', encounter: encounterView(open) });
    }
    const created = await fhir.create('Encounter', buildEncounter(practitioner, workType, new Date().toISOString()));
    res.status(201).json({ ...encounterView(created), deviceJustBound: dev.justBound });
  } catch (e) {
    next(e);
  }
});

// 簽退（將最近一筆 in-progress 設為 finished 並補上結束時間，自動換算工時）
// end 可選：用於補登「跨日未簽退」之實際離開時間；未給則用現在時間。
router.post('/clock-out', async (req, res, next) => {
  try {
    const { practitionerId, deviceId, end } = req.body;
    if (!practitionerId) return res.status(400).json({ error: '缺少 practitionerId' });

    const practitioner = await fhir.read('Practitioner', practitionerId);
    const bound = getDeviceToken(practitioner);
    if (bound && deviceId && bound !== deviceId) {
      return res.status(403).json({ error: '此手機未綁定本人帳號，無法簽退，請改用已綁定的手機。' });
    }

    const open = await findOpenEncounter(practitionerId);
    if (!open) return res.status(404).json({ error: '查無未簽退的打卡紀錄，無法簽退。' });

    open.status = 'finished';
    open.period = { ...(open.period || {}), end: end ? new Date(end).toISOString() : new Date().toISOString() };
    const updated = await fhir.update('Encounter', open.id, open);
    res.json(encounterView(updated));
  } catch (e) {
    next(e);
  }
});

// 跨日未簽退提醒（隔天立即處理）：回傳本人所有「跨日仍未簽退」的紀錄
router.get('/reminders', async (req, res, next) => {
  try {
    const { practitionerId } = req.query;
    if (!practitionerId) return res.status(400).json({ error: '缺少 practitionerId' });
    const list = await fhir.searchAll('Encounter', { practitioner: `Practitioner/${practitionerId}`, status: 'in-progress', _count: 100 });
    const stale = list
      .filter((e) => (e.participant || []).some((p) => p.individual?.reference === `Practitioner/${practitionerId}`))
      .map(encounterView)
      .filter((v) => v.stale);
    res.json(stale);
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
