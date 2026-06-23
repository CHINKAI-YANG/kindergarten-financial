// 與 FHIR 伺服器（R4）溝通的薄封裝層，使用 Node 18+ 內建的全域 fetch，無額外相依。
//
// 重點：
//  - 統一帶上 application/fhir+json 標頭
//  - 建立/更新時自動貼上租戶 meta.tag（命名空間隔離）
//  - 搜尋一律加上 _tag 過濾，只取得本平台資料
//  - 支援 transaction Bundle（Kiosk 批次同步以單一 Bundle 上傳步數憑證）
//  - 錯誤時拋出帶有 status 與 OperationOutcome 的 Error

import { config, SYSTEMS } from './config.js';

const TENANT_TAG = { system: SYSTEMS.tenant, code: config.tenantTag };

function ensureTenantTag(resource) {
  const r = { ...resource };
  r.meta = r.meta ? { ...r.meta } : {};
  const tags = Array.isArray(r.meta.tag) ? [...r.meta.tag] : [];
  const exists = tags.some((t) => t.system === TENANT_TAG.system && t.code === TENANT_TAG.code);
  if (!exists) tags.push({ ...TENANT_TAG });
  r.meta.tag = tags;
  return r;
}

async function request(method, path, body) {
  // path 為空字串時 POST 到 base（transaction Bundle）
  const url = path.startsWith('http') ? path : path ? `${config.fhirBaseUrl}/${path}` : config.fhirBaseUrl;
  const headers = { Accept: 'application/fhir+json' };
  if (body !== undefined) headers['Content-Type'] = 'application/fhir+json';

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkErr) {
    const e = new Error(`無法連線 FHIR 伺服器 (${config.fhirBaseUrl})：${networkErr.message}`);
    e.status = 502;
    throw e;
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  if (!res.ok) {
    const detail = json?.issue?.map((i) => i.diagnostics || i.details?.text).filter(Boolean).join('; ');
    const e = new Error(`FHIR ${method} ${path || '(base)'} 失敗 (HTTP ${res.status})${detail ? '：' + detail : ''}`);
    e.status = res.status;
    e.operationOutcome = json;
    throw e;
  }
  return json;
}

export const fhir = {
  /** 建立資源，回傳含 id 的伺服器版本 */
  create(resourceType, resource) {
    return request('POST', resourceType, ensureTenantTag({ ...resource, resourceType }));
  },

  /** 以 id 讀取單一資源 */
  read(resourceType, id) {
    return request('GET', `${resourceType}/${id}`);
  },

  /** 以 id 更新（PUT）資源 */
  update(resourceType, id, resource) {
    return request('PUT', `${resourceType}/${id}`, ensureTenantTag({ ...resource, resourceType, id }));
  },

  /** 刪除資源 */
  remove(resourceType, id) {
    return request('DELETE', `${resourceType}/${id}`);
  },

  /**
   * 搜尋資源；自動加上租戶 _tag 過濾。回傳 entry 陣列（已展開 resource）。
   * params 例：{ subject: 'Patient/1', category: 'health-coin-ledger', _count: 200 }
   */
  async search(resourceType, params = {}) {
    const qs = new URLSearchParams();
    qs.set('_tag', `${SYSTEMS.tenant}|${config.tenantTag}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const bundle = await request('GET', `${resourceType}?${qs.toString()}`);
    return (bundle?.entry || []).map((e) => e.resource).filter(Boolean);
  },

  /** 搜尋並自動跟隨 next 連結，匯總所有頁面（上限 pageLimit 頁） */
  async searchAll(resourceType, params = {}, pageLimit = 20) {
    const qs = new URLSearchParams();
    qs.set('_tag', `${SYSTEMS.tenant}|${config.tenantTag}`);
    qs.set('_count', String(params._count || 200));
    for (const [k, v] of Object.entries(params)) {
      if (k === '_count') continue;
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    let url = `${config.fhirBaseUrl}/${resourceType}?${qs.toString()}`;
    const all = [];
    for (let page = 0; page < pageLimit && url; page++) {
      const bundle = await request('GET', url);
      for (const e of bundle?.entry || []) if (e.resource) all.push(e.resource);
      const next = bundle?.link?.find((l) => l.relation === 'next');
      url = next?.url || null;
    }
    return all;
  },

  /**
   * 以 transaction Bundle 一次建立多筆資源（Kiosk 批次同步用）。
   * entries：[{ method, url, resource }]，回傳伺服器的 transaction-response Bundle。
   */
  transaction(entries) {
    const bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: entries.map((e) => ({
        resource: ensureTenantTag({ ...e.resource }),
        request: { method: e.method || 'POST', url: e.url },
      })),
    };
    return request('POST', '', bundle);
  },

  /** 取得伺服器 CapabilityStatement（用於連線健檢） */
  metadata() {
    return request('GET', 'metadata?_summary=true');
  },
};

export { TENANT_TAG };
