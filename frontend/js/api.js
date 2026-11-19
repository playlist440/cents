// One function per endpoint of SPEC §10. Every function returns the parsed JSON of the response
// or throws an ApiError { status, code, message }. Mutations carry `X-Cents: 1`.
// The transport is either real HTTP or the in-browser mock (see mock/mock.js).

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || 'Er ging iets mis.');
    this.status = status;
    this.code = code || 'error';
  }
}

let transport = httpTransport;
let onUnauthorized = () => {};

/** Swap in the mock: handler({method, path, query, body, form}) -> Promise<{status, data}> */
export function setTransport(handler) { transport = handler; }
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }
export const isMockTransport = () => transport !== httpTransport;

async function httpTransport({ method, path, query, body, form }) {
  const headers = {};
  let payload;
  if (method !== 'GET') headers['X-Cents'] = '1';
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch('/api' + path + qs(query), { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'offline', 'Geen verbinding met Cents.');
  }
  let data = null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function qs(query) {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    p.set(k, v === true ? '1' : String(v));
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

async function request(method, path, opts = {}) {
  const { status, data } = await transport({ method, path, ...opts });
  if (status >= 200 && status < 300) return data;
  const err = data?.error || {};
  if (status === 401 && !['/session', '/login', '/setup', '/password', '/data'].includes(path)) onUnauthorized();
  throw new ApiError(status, err.code, err.message);
}

const get = (path, query) => request('GET', path, { query });
const post = (path, body) => request('POST', path, { body: body ?? {} });
const patch = (path, body) => request('PATCH', path, { body });
const put = (path, body) => request('PUT', path, { body });
const del = (path, query, body) => request('DELETE', path, { query, body });
const upload = (path, files, field = 'files') => {
  const form = new FormData();
  for (const f of files) form.append(field, f, f.name);
  return request('POST', path, { form });
};

/** URL for a download endpoint (CSV export, backup). Mock mode returns a blob: URL. */
async function downloadUrl(path) {
  if (transport === httpTransport) return '/api' + path;
  const { data } = await transport({ method: 'GET', path, download: true });
  return URL.createObjectURL(data);
}

export const api = {
  /* Auth */
  session: () => get('/session'),
  setup: (password) => post('/setup', { password }),
  login: (password) => post('/login', { password }),
  logout: () => post('/logout'),
  changePassword: (current, next) => post('/password', { current, new: next }),

  bootstrap: () => get('/bootstrap'),

  /* Extra read endpoints offered by the backend (docs/DECISIONS.md) */
  categories: () => get('/categories'),
  tags: () => get('/tags'),
  accounts: () => get('/accounts'),
  accountValues: (id) => get(`/accounts/${id}/values`),

  /* Import */
  importFiles: (files) => upload('/import', files),
  imports: () => get('/imports'),
  checks: () => get('/checks'),
  besparen: () => get('/besparen'),
  deleteImport: (id) => del(`/imports/${id}`),

  /* Transactions. params: period, from, to, account_id, category_id, tag_id, merchant_key, q,
     method, kind, unsorted, min_cents, max_cents, limit, cursor */
  transactions: (params = {}) => get('/transactions', params),
  transaction: (id) => get(`/transactions/${id}`),
  /* changes: category_id, apply_scope ('one' | 'merchant' | 'merchant_below') + below_cents,
     apply_to_merchant (older form), tag_ids, tag_always, note, goal_id, manual fields */
  updateTransaction: (id, changes) => patch(`/transactions/${id}`, changes),
  createTransaction: (tx) => post('/transactions', tx),
  deleteTransaction: (id) => del(`/transactions/${id}`),
  bulkUpdate: ({ ids, category_id, add_tag_ids, remove_tag_ids }) =>
    post('/transactions/bulk', { ids, category_id, add_tag_ids, remove_tag_ids }),

  /* Sorting */
  sortQueue: () => get('/sort/queue'),
  sort: (merchant_key, category_id) => post('/sort', { merchant_key, category_id }),

  /* Categories (bakjes) */
  createCategory: ({ name, emoji, color, grp }) => post('/categories', { name, emoji, color, grp }),
  updateCategory: (id, changes) => patch(`/categories/${id}`, changes),
  deleteCategory: (id) => del(`/categories/${id}`),
  categorySummary: (id, period) => get(`/categories/${id}/summary`, { period }),

  /* Tags */
  createTag: ({ name, emoji, color }) => post('/tags', { name, emoji, color }),
  updateTag: (id, changes) => patch(`/tags/${id}`, changes),
  deleteTag: (id) => del(`/tags/${id}`),
  tagSummary: (id) => get(`/tags/${id}/summary`),

  /* Learned rules */
  rules: () => get('/rules'),
  deleteRule: (id) => del(`/rules/${id}`),
  /* changes: { category_id?, below_cents?, below_category_id? } (amount-dependent bakje) */
  updateRule: (id, changes) => patch(`/rules/${id}`, changes),

  /* Overview and trends */
  overview: (period) => get('/overview', { period }),
  trends: (periods = 12) => get('/trends', { periods }),

  /* Calendar and recap (SPEC §14) */
  getCalendar: (period) => get('/calendar', { period }),
  getRecap: ({ period, year } = {}) => get('/recap', year != null ? { year } : { period }),
  getRecapIndex: () => get('/recap/index'),

  /* Recurring (vaste lasten) */
  recurring: () => get('/recurring'),
  pinPreview: (id) => post('/recurring/pins/preview', { transaction_id: id }),
  pinCreate: (id) => post('/recurring/pins', { transaction_id: id }),
  pinAmount: (pid, cents) => post(`/recurring/pins/${pid}/amount`, { amount_cents: cents }),
  pinDelete: (pid) => del(`/recurring/pins/${pid}`),
  createSubscription: (body) => post('/subscriptions', body),
  updateSubscription: (id, body) => patch(`/subscriptions/${id}`, body),
  deleteSubscription: (id) => del(`/subscriptions/${id}`),
  ignoreRecurring: (key) => post('/recurring/ignore', { key }),
  unignoreRecurring: (key) => del('/recurring/ignore', undefined, { key }),

  /* Slimme aannames and insight preferences (SPEC §13) */
  assumptions: () => get('/assumptions'),
  forgetGoalLink: (goal_id, description) => del('/goals/links', undefined, { goal_id, description }),
  dismissInsight: (id) => post('/insights/dismiss', { id }),
  muteInsight: (kind, muted = true) => post('/insights/mute', { kind, muted }),

  /* Goals (potjes) */
  goals: () => get('/goals'),
  createGoal: (goal) => post('/goals', goal),
  updateGoal: (id, changes) => patch(`/goals/${id}`, changes),
  deleteGoal: (id) => del(`/goals/${id}`),
  addGoalEntry: (id, { amount_cents, date, note, transaction_id }) =>
    post(`/goals/${id}/entries`, { amount_cents, date, note, transaction_id }),
  setGoalSaldo: (id, saldo_cents) => post(`/goals/${id}/saldo`, { saldo_cents }),
  deleteGoalEntry: (id) => del(`/goal-entries/${id}`),

  /* Accounts and net worth */
  networth: () => get('/networth'),
  createAccount: ({ name, type, iban, match }) => post('/accounts', { name, type, iban, match }),
  updateAccount: (id, changes) => patch(`/accounts/${id}`, changes),
  deleteAccount: (id, { force = false } = {}) => del(`/accounts/${id}`, { force: force ? 1 : undefined }),
  addAccountValue: (id, { date, value_cents }) => post(`/accounts/${id}/values`, { date, value_cents }),
  deleteAccountValue: (id) => del(`/account-values/${id}`),

  /* Mortgage (SPEC §7.2) */
  mortgage: () => get('/mortgage'),
  createMortgage: (parts) => post('/mortgage', { parts }),
  updateMortgage: (changes) => patch('/mortgage', changes),
  deleteMortgage: () => del('/mortgage'),
  renameMortgagePart: (id, name) => patch(`/mortgage/parts/${id}`, { name }),
  saveMortgageYear: (year, parts) => put(`/mortgage/years/${year}`, { parts }),
  deleteMortgageYear: (year) => del(`/mortgage/years/${year}`),
  addHomeValue: ({ date, value_cents }) => post('/mortgage/home-values', { date, value_cents }),
  deleteHomeValue: (id) => del(`/mortgage/home-values/${id}`),

  /* Pension, debt, other possessions (SPEC §7.3) */
  assets: () => get('/assets'),
  createAsset: (body) => post('/assets', body),
  updateAsset: (id, changes) => patch(`/assets/${id}`, changes),
  deleteAsset: (id) => del(`/assets/${id}`),
  addAssetEntry: (id, body) => post(`/assets/${id}/entries`, body),
  deleteAssetEntry: (id, entryId) => del(`/assets/${id}/entries/${entryId}`),

  /* Holdings of investment accounts and automatic prices (SPEC §7.1) */
  holdings: (id) => get(`/accounts/${id}/holdings`),
  /* trade: { date, isin, name?, side: 'buy'|'sell', quantity, price_cents, fees_cents } */
  addTrade: (id, trade) => post(`/accounts/${id}/trades`, trade),
  deleteTrade: (id) => del(`/trades/${id}`),
  securities: (q = '') => get('/securities', { q }),
  updateSecurity: (isin, changes) => patch(`/securities/${isin}`, changes),
  priceStatus: () => get('/prices/status'),
  refreshPrices: () => post('/prices/refresh'),

  /* Settings and data */
  settings: () => get('/settings'),
  updateSettings: (changes) => patch('/settings', changes),
  exportTransactionsUrl: () => downloadUrl('/export/transactions.csv'),
  backupUrl: () => downloadUrl('/export/backup'),
  cardTemplateUrl: () => downloadUrl('/creditcard/template'),
  restore: (file) => upload('/restore', [file], 'file'),
  reclassify: () => post('/reclassify'),
  deleteData: (password) => del('/data', undefined, { password }),

  healthz: () => get('/healthz'),
};
