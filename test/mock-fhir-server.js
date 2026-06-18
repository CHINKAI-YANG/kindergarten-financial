// 極簡的記憶體版 FHIR 伺服器，僅供本地端對端測試使用。
// 模仿 HAPI baseR4 的 create / read / update / delete / search 行為，
// 讓我們在沒有外網的情況下也能驗證整條「打卡→結算→簽核→撥款」流程。

import express from 'express';

export function startMockFhir(port = 0) {
  const app = express();
  app.use(express.json({ type: () => true, limit: '2mb' }));

  const store = new Map(); // resourceType -> Map(id -> resource)
  let counter = 1000;
  const col = (rt) => { if (!store.has(rt)) store.set(rt, new Map()); return store.get(rt); };

  app.get('/metadata', (req, res) => {
    res.json({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', software: { name: 'MockFHIR(test)' }, status: 'active' });
  });

  // create
  app.post('/:rt', (req, res) => {
    const rt = req.params.rt;
    const id = String(++counter);
    const resource = { ...req.body, resourceType: rt, id, meta: { ...(req.body.meta || {}), versionId: '1', lastUpdated: new Date().toISOString() } };
    col(rt).set(id, resource);
    res.status(201).json(resource);
  });

  // read
  app.get('/:rt/:id', (req, res) => {
    const r = col(req.params.rt).get(req.params.id);
    if (!r) return res.status(404).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', diagnostics: 'not found' }] });
    res.json(r);
  });

  // update
  app.put('/:rt/:id', (req, res) => {
    const resource = { ...req.body, resourceType: req.params.rt, id: req.params.id, meta: { ...(req.body.meta || {}), versionId: '2', lastUpdated: new Date().toISOString() } };
    col(req.params.rt).set(req.params.id, resource);
    res.json(resource);
  });

  // delete
  app.delete('/:rt/:id', (req, res) => { col(req.params.rt).delete(req.params.id); res.status(204).end(); });

  // search
  app.get('/:rt', (req, res) => {
    const rt = req.params.rt;
    let items = [...col(rt).values()];
    const q = req.query;

    if (q._tag) {
      const [system, code] = String(q._tag).split('|');
      items = items.filter((r) => (r.meta?.tag || []).some((t) => t.system === system && t.code === code));
    }
    if (q.status) items = items.filter((r) => r.status === q.status);
    if (q.practitioner || q.participant) {
      const ref = q.practitioner || q.participant;
      items = items.filter((r) => (r.participant || []).some((p) => p.individual?.reference === ref));
    }
    if (q.schedule) items = items.filter((r) => r.schedule?.reference === q.schedule);
    if (q.request) items = items.filter((r) => r.request?.reference === q.request);

    res.json({
      resourceType: 'Bundle', type: 'searchset', total: items.length,
      entry: items.map((r) => ({ resource: r, fullUrl: `/${rt}/${r.id}` })), link: [],
    });
  });

  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve({ server, port: server.address().port, store }));
  });
}
