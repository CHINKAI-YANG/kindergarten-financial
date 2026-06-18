// 系統設定與 FHIR 命名常數
// 所有可調參數皆可由環境變數覆寫（見 .env.example）

export const config = {
  // 後端服務埠
  port: Number(process.env.PORT || 3000),

  // 目標 FHIR 伺服器：預設為 HAPI 公開測試伺服器
  // 在自己的電腦執行 `npm start` 即可直接上傳到此伺服器。
  fhirBaseUrl: (process.env.FHIR_BASE_URL || 'https://hapi.fhir.org/baseR4').replace(/\/+$/, ''),

  // 幣別
  currency: process.env.CURRENCY || 'TWD',

  // 合作金庫銀行代碼（媒體轉帳檔用）
  defaultBankCode: process.env.BANK_CODE || '006',

  // 租戶標記：HAPI 為公眾共用伺服器，所有資源都會貼上這個 meta.tag，
  // 之後搜尋一律以 _tag 過濾，確保只讀寫「本園」的資料。
  // 若多人共用同一公開伺服器，請把 TENANT_TAG 改成獨一無二的字串以免互相干擾。
  tenantTag: process.env.TENANT_TAG || 'morninglight-kg-demo',
};

// FHIR 命名系統（identifier / coding / extension 的 system URL）
export const SYSTEMS = {
  tenant: 'http://morninglight.kindergarten/fhir/tenant',
  employeeId: 'http://morninglight.kindergarten/fhir/employee-id',
  workType: 'http://morninglight.kindergarten/fhir/work-type',
  claimId: 'http://morninglight.kindergarten/fhir/settlement-id',
};

// Practitioner 上承載薪資/保費/銀行資訊的自訂 extension
export const EXT = {
  baseSalary: 'http://morninglight.kindergarten/fhir/ext/base-salary',
  hourlyRate: 'http://morninglight.kindergarten/fhir/ext/hourly-rate',
  afterCareRate: 'http://morninglight.kindergarten/fhir/ext/aftercare-rate',
  overtimeRate: 'http://morninglight.kindergarten/fhir/ext/overtime-rate',
  laborInsurance: 'http://morninglight.kindergarten/fhir/ext/labor-insurance',
  healthInsurance: 'http://morninglight.kindergarten/fhir/ext/health-insurance',
  bankCode: 'http://morninglight.kindergarten/fhir/ext/bank-code',
  bankAccount: 'http://morninglight.kindergarten/fhir/ext/bank-account',
  payroll: 'http://morninglight.kindergarten/fhir/ext/payroll-detail',
};

// 出勤工作類別（影響月薪制的加給計算）
export const WORK_TYPES = {
  regular: { code: 'regular', display: '正常班' },
  aftercare: { code: 'aftercare', display: '課後延護' },
  overtime: { code: 'overtime', display: '行政加班' },
};
