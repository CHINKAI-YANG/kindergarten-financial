// 極簡記憶體版 FHIR 伺服器，僅供本地端對端測試（外網被擋時也能跑完整流程）。
// 模仿 R4 的 create / read / update / delete / search 與 transaction Bundle。
import express from 'express';

export function startMockFhir(port = 0) {
  const app = express();
  app.use(express.json({ type: () => true, limit: '2mb' }));

  const store = new Map(); // resourceType -> Map(id -> resource)
  let counter = 1000;
  const col = (rt) => { if (!store.has(rt)) store.set(rt, new Map()); return store.get(rt); };
  const save = (rt, body, version) => {
    const id = body.id || String(++counter);
    const resource = { ...body, resourceType: rt, id, meta: { ...(body.meta || {}), versionId: String(version || 1), lastUpdated: new Date().toISOString() } };
    col(rt).set(id, resource);
    return resource;
  };

  app.get('/metadata', (req, res) => {
    res.json({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', software: { name: 'MockFHIR(test)' }, status: 'active' });
  });

  // transaction Bundle（POST 到 base）
  app.post('/', (req, res) => {
    const b = req.body;
    if (b?.resourceType !== 'Bundle') return res.status(400).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', diagnostics: 'expected Bundle' }] });
    const entry = (b.entry || []).map((e) => {
      const rt = e.request?.url?.split('/')[0] || e.resource?.resourceType;
      const saved = save(rt, e.resource, 1);
      return { response: { status: '201 Created', location: `${rt}/${saved.id}` }, resource: saved };
    });
    res.status(200).json({ resourceType: 'Bundle', type: 'transaction-response', entry });
  });

  // create
  app.post('/:rt', (req, res) => {
    res.status(201).json(save(req.params.rt, req.body, 1));
  });

  // read
  app.get('/:rt/:id', (req, res) => {
    const r = col(req.params.rt).get(req.params.id);
    if (!r) return res.status(404).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', diagnostics: 'not found' }] });
    res.json(r);
  });

  // update
  app.put('/:rt/:id', (req, res) => {
    res.json(save(req.params.rt, { ...req.body, id: req.params.id }, 2));
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
    if (q.identifier) {
      const [sys, val] = String(q.identifier).split('|');
      items = items.filter((r) => (r.identifier || []).some((id) => (!sys || id.system === sys) && (!val || id.value === val)));
    }
    if (q.subject) {
      items = items.filter((r) => {
        const s = r.subject;
        if (Array.isArray(s)) return s.some((x) => x.reference === q.subject); // Account.subject[]
        return s?.reference === q.subject; // Observation.subject
      });
    }
    if (q.patient) items = items.filter((r) => r.subject?.reference === q.patient);
    if (q.category) {
      items = items.filter((r) => (r.category || []).some((c) => (c.coding || []).some((cd) => cd.code === q.category)));
    }
    if (q.code) {
      items = items.filter((r) => (r.code?.coding || []).some((cd) => cd.code === q.code));
    }

    res.json({
      resourceType: 'Bundle', type: 'searchset', total: items.length,
      entry: items.map((r) => ({ resource: r, fullUrl: `/${rt}/${r.id}` })), link: [],
    });
  });

  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve({ server, port: server.address().port, store }));
  });
}
