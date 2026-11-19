// In-browser mock of the complete SPEC §10 API. Mutations live in memory until reload.
// Calculations follow SPEC §8–9 closely enough to exercise every screen; they are not the
// reference implementation (the backend is).
//
// Start states (URL): ?mock=1 (logged in, 18 months of data), ?mock=login, ?mock=setup,
// ?mock=empty (logged in, no data; importing any .csv/.xml file loads the demo household).
// Mock password: demo1234. Latency: ?latency=ms (default 90–220 ms random).

import { generate } from './data.js';
import { addDays, daysBetween, parseISO, shiftPeriod, monthLabel, todayISO, MONTHS, money, euros } from '../format.js';

const VERSION = '0.1.0-mock';
const PASSWORD = 'demo1234';

let db;
let auth;
let version = 0; // bumps on every mutation, invalidates caches
const memo = new Map();
const cached = (key, fn) => {
  const k = version + ':' + key;
  if (!memo.has(k)) { if (memo.size > 400) memo.clear(); memo.set(k, fn()); }
  return memo.get(k);
};
const touch = () => { version++; };

export function createMockHandler({ state = '1', latency = null } = {}) {
  const today = todayISO();
  db = generate({ today, empty: state === 'empty' || state === 'setup' });
  auth = { setup_required: state === 'setup', authenticated: state === '1' || state === 'empty' || state === 'true' || state === '' };
  return async (req) => {
    const delay = latency != null ? Number(latency) : 90 + Math.random() * 130;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      return handle(req);
    } catch (e) {
      if (e && e.status) return { status: e.status, data: { error: { code: e.code, message: e.message } } };
      console.error('[mock]', e);
      return { status: 500, data: { error: { code: 'internal', message: 'Er ging iets mis.' } } };
    }
  };
}

const fail = (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; };
const ok = (data, status = 200) => ({ status, data });

/* ======================================================================================
   Lookups
   ====================================================================================== */

const catById = (id) => db.categories.find((c) => c.id === id);
const catByKey = (key) => db.categories.find((c) => c.key === key);
const accById = (id) => db.accounts.find((a) => a.id === id);
const tagIdsOf = (txId) => db.tx_tags.filter(([t]) => t === txId).map(([, g]) => g);

function isCashflow(tx) {
  const a = accById(tx.account_id);
  if (!a) return false;
  return a.type === 'checking' || (a.type === 'credit' && tx.manual);
}

function serializeTx(tx) {
  return {
    id: tx.id, account_id: tx.account_id, date: tx.date, amount_cents: tx.amount_cents,
    merchant_name: tx.merchant_name, merchant_key: tx.merchant_key, counterparty_iban: tx.counterparty_iban,
    description: tx.description, method: tx.method, city: tx.city, category_id: tx.category_id,
    category_source: tx.category_source, kind: tx.kind, transfer_account_id: tx.transfer_account_id,
    tag_ids: tagIdsOf(tx.id), goal_id: tx.goal_id, note: tx.note, manual: tx.manual,
    balance_after_cents: tx.balance_after_cents, book_date: tx.book_date ?? null,
    spread_months: possessionLinks().get(tx.id)?.role === 'purchase' ? null : tx.spread_months ?? null,
    possession: possessionLinks().get(tx.id) || null,
  };
}

/* ======================================================================================
   Periods (SPEC §8)
   ====================================================================================== */

const startDay = () => db.settings.month_start_day || 1;

function periodStart(id) {
  const sd = startDay();
  const startMonth = sd <= 15 ? id : shiftPeriod(id, -1);
  return `${startMonth}-${String(sd).padStart(2, '0')}`;
}
function periodOf(date) {
  const sd = startDay();
  const day = Number(date.slice(8, 10));
  const startMonth = day >= sd ? date.slice(0, 7) : shiftPeriod(date.slice(0, 7), -1);
  return sd <= 15 ? startMonth : shiftPeriod(startMonth, 1);
}
function periodBounds(id) {
  const from = periodStart(id);
  const to = addDays(periodStart(shiftPeriod(id, 1)), -1);
  return { from, to };
}
function dataToday() {
  const last = db.transactions.reduce((m, t) => (t.date > m ? t.date : m), '0000');
  if (last === '0000') return db.today;
  const d = addDays(last, 3);
  return d < db.today ? d : db.today;
}
function firstPeriod() {
  const first = db.transactions.reduce((m, t) => (t.date < m ? t.date : m), '9999');
  return first === '9999' ? periodOf(db.today) : periodOf(first);
}
const currentPeriod = () => periodOf(db.today);

function periodObj(id) {
  const { from, to } = periodBounds(id);
  const cur = currentPeriod();
  const days_total = daysBetween(from, to) + 1;
  const is_current = id === cur;
  const day_index = is_current ? daysBetween(from, db.today) + 1 : days_total;
  const first = firstPeriod();
  return {
    id, label: monthLabel(id), from, to, is_current, day_index, days_total,
    prev: id > first ? shiftPeriod(id, -1) : null,
    next: id < cur ? shiftPeriod(id, 1) : null,
  };
}

/** Complete periods before `id` that have data, most recent first (max n). */
function previousComplete(id, n = 6) {
  const first = firstPeriod();
  const out = [];
  let p = shiftPeriod(id, -1);
  const cur = currentPeriod();
  while (p >= first && out.length < n) {
    if (p < cur) out.push(p);
    p = shiftPeriod(p, -1);
  }
  // The first period is usually partial; skip it when it is the oldest.
  return out.filter((x) => x !== first || out.length <= 1);
}

/* ======================================================================================
   Cash flow (SPEC §7, §9)
   ====================================================================================== */

function settlementUnexplained() {
  return cached('settle', () => {
    const map = new Map();
    let outstanding = 0;
    const list = db.transactions
      .filter((t) => (accById(t.account_id)?.type === 'credit' && t.manual) || t.kind === 'settlement')
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const t of list) {
      if (t.kind === 'settlement') {
        const pay = -t.amount_cents;
        const explained = Math.min(pay, Math.max(0, outstanding));
        outstanding -= explained;
        map.set(t.id, pay - explained);
      } else {
        outstanding += -t.amount_cents;
      }
    }
    return { map, outstanding };
  });
}

/* Costs over time (SPEC §7.4; services/spread.py): spread payments and possessions */
const pIndex = (pid) => { const [y, m] = pid.split('-').map(Number); return y * 12 + m - 1; };
function spreadAmounts(total, months, keep = 0) {
  const base = Math.max(0, total - Math.max(0, Math.min(keep || 0, total)));
  const q = Math.floor(base / months); const r = base % months;
  return Array.from({ length: months }, (_, i) => q + (i < r ? 1 : 0));
}
function possessionLinks() {
  return cached('poss:links', () => {
    const m = new Map();
    for (const a of db.assets) if (a.kind === 'possession') {
      if (a.tx_id) m.set(a.tx_id, { asset_id: a.id, name: a.name, role: 'purchase' });
      if (a.sale_tx_id) m.set(a.sale_tx_id, { asset_id: a.id, name: a.name, role: 'sale' });
    }
    return m;
  });
}
function possessionPlan(a) {
  const sale = a.sale_tx_id ? db.transactions.find((t) => t.id === a.sale_tx_id) : null;
  return { months: a.life_months || 96, total: a.price_cents || 0, keep: a.residual_cents || 0, start: a.start_date,
    sale_date: sale ? sale.date : a.sale_date || null, sale_cents: sale ? sale.amount_cents : a.sale_cents ?? null };
}
function spreadSchedule(plan, startPid) {
  const parts = spreadAmounts(plan.total, plan.months, plan.keep);
  const saleK = plan.sale_date && plan.sale_cents != null ? Math.max(0, pIndex(periodOf(plan.sale_date)) - pIndex(startPid)) : null;
  const upto = saleK == null ? parts.length : Math.min(saleK, parts.length);
  const out = [];
  for (let k = 0; k < upto; k++) out.push({ pid: shiftPeriod(startPid, k), k, cents: parts[k], role: 'part' });
  if (saleK != null) out.push({ pid: shiftPeriod(startPid, saleK), k: saleK, role: 'sale', cents: plan.total - parts.slice(0, upto).reduce((s, v) => s + v, 0) - plan.sale_cents });
  return out;
}
const isSpread = (t) => t.spread_months > 1 && t.amount_cents < 0 && !possessionLinks().has(t.id);
function periodParts(pid) {
  return cached('parts:' + pid, () => {
    const out = [];
    for (const t of db.transactions) {
      if (!isSpread(t) || !isCashflow(t) || !['fixed', 'daily'].includes(catById(t.category_id)?.grp)) continue;
      for (const s of spreadSchedule({ months: t.spread_months, total: -t.amount_cents, keep: 0 }, periodOf(t.date))) {
        if (s.pid === pid) out.push({ kind: 'spread', index: s.k + 1, months: t.spread_months, role: s.role, cents: s.cents, total_cents: -t.amount_cents,
          name: t.merchant_name, asset_id: null, tx_id: t.id, date: s.k === 0 ? t.date : periodBounds(pid).from, period: pid, category_id: t.category_id });
      }
    }
    for (const a of db.assets) {
      if (a.kind !== 'possession') continue;
      const plan = possessionPlan(a);
      if (!plan.start || !plan.total) continue;
      const cat = catById(a.category_id) && ['fixed', 'daily'].includes(catById(a.category_id).grp) ? a.category_id : catByKey('unsorted').id;
      for (const s of spreadSchedule(plan, periodOf(plan.start))) {
        if (s.pid === pid) out.push({ kind: 'possession', index: s.k + 1, months: plan.months, role: s.role, cents: s.cents, total_cents: plan.total,
          name: a.name, asset_id: a.id, tx_id: a.tx_id || -a.id, date: s.role === 'sale' ? plan.sale_date : s.k === 0 ? plan.start : periodBounds(pid).from,
          period: pid, category_id: cat });
      }
    }
    return out;
  });
}
function possessionValue(a, day) {
  const plan = possessionPlan(a);
  if (!plan.start || day < plan.start) return null;
  if (plan.sale_date && day >= plan.sale_date) return 0;
  const parts = spreadAmounts(plan.total, plan.months, plan.keep);
  const p = periodOf(day);
  const k = pIndex(p) - pIndex(periodOf(plan.start));
  if (k >= parts.length) return plan.total - parts.reduce((s, v) => s + v, 0);
  const { from, to } = periodBounds(p);
  const begin = k === 0 ? plan.start : from;
  const frac = daysBetween(begin, day) / Math.max(1, daysBetween(begin, addDays(to, 1)));
  return plan.total - parts.slice(0, k).reduce((s, v) => s + v, 0) - Math.round(parts[k] * frac);
}
function spreadInfo(t) {
  const link = possessionLinks().get(t.id);
  if (link) {
    const a = db.assets.find((x) => x.id === link.asset_id);
    const plan = possessionPlan(a);
    const first = periodOf(plan.start);
    return { kind: 'possession', role: link.role, asset_id: a.id, name: a.name, emoji: a.emoji, months: plan.months, residual_cents: plan.keep,
      price_cents: plan.total, monthly_cents: spreadAmounts(plan.total, plan.months, plan.keep)[0], value_cents: possessionValue(a, db.today),
      from: first, to: shiftPeriod(first, plan.months - 1), sold: !!plan.sale_date, sale_date: plan.sale_date, sale_cents: plan.sale_cents, category_id: a.category_id };
  }
  if (!isSpread(t)) return null;
  const first = periodOf(t.date);
  return { kind: 'spread', months: t.spread_months, monthly_cents: spreadAmounts(-t.amount_cents, t.spread_months)[0], from: first, to: shiftPeriod(first, t.spread_months - 1) };
}

function flows(pid) {
  return cached('flows:' + pid, () => {
    const { from, to } = periodBounds(pid);
    const splits = allSplits();
    const res = { income: 0, fixed: 0, daily: 0, saved: 0, repaid: 0, card: 0, spreadFixed: 0, spreadDaily: 0, cats: new Map(), incomeCats: new Map(), dailyByDay: new Map(), repaidCats: new Map() };
    const unexplained = settlementUnexplained().map;
    const ccCat = catByKey('creditcard');
    const addCat = (map, id, cents) => {
      const e = map.get(id) || { cents: 0, count: 0 };
      e.cents += cents; e.count += 1; map.set(id, e);
    };
    const links = possessionLinks();
    for (const p of periodParts(pid)) {
      const c = catById(p.category_id);
      if (c.grp === 'fixed') { res.fixed += p.cents; res.spreadFixed += p.cents; } else { res.daily += p.cents; res.spreadDaily += p.cents; res.dailyByDay.set(p.date, (res.dailyByDay.get(p.date) || 0) + p.cents); }
      addCat(res.cats, c.id, p.cents);
    }
    for (const t of db.transactions) {
      if (t.date < from || t.date > to) continue;
      // interest on a savings or investment account is income (services/ledger.py bucket)
      const acc = accById(t.account_id);
      if (acc && (acc.type === 'savings' || acc.type === 'investment') && !acc.hidden && t.method === 'interest' && t.amount_cents > 0) {
        const c = catById(t.category_id);
        const ic = c?.grp === 'income' ? c : catByKey('inkomen-overig');
        res.income += t.amount_cents; addCat(res.incomeCats, ic.id, t.amount_cents);
        continue;
      }
      if (!isCashflow(t)) continue;
      if (links.has(t.id) || isSpread(t)) continue;
      const amt = t.amount_cents;
      if (t.kind === 'settlement') {
        const u = unexplained.get(t.id) || 0;
        if (u > 0) { res.daily += u; res.card += u; addCat(res.cats, ccCat.id, u); res.dailyByDay.set(t.date, (res.dailyByDay.get(t.date) || 0) + u); }
        continue;
      }
      const c = catById(t.category_id) || catByKey('unsorted');
      if (c.grp === 'internal') continue;
      if (c.key === 'unsorted' && amt > 0) { res.income += amt; addCat(res.incomeCats, c.id, amt); continue; }
      if (c.grp === 'income') { res.income += amt; addCat(res.incomeCats, c.id, amt); }
      else if (c.grp === 'fixed') {
        // Mortgage and linked debts (SPEC §7.2, §7.3): the repaid share of the linked payment counts as saved.
        const share = amt < 0 && accById(t.account_id)?.type === 'checking' ? splits.get(t.merchant_key) : 0;
        const rep = share ? Math.round(-amt * share) : 0;
        res.fixed += -amt - rep; addCat(res.cats, c.id, -amt - rep);
        if (rep) { res.saved += rep; res.repaid += rep; res.repaidCats.set(c.id, (res.repaidCats.get(c.id) || 0) + rep); }
      }
      else if (c.grp === 'daily') {
        res.daily -= amt; addCat(res.cats, c.id, -amt);
        res.dailyByDay.set(t.date, (res.dailyByDay.get(t.date) || 0) - amt);
      } else if (c.grp === 'saving') res.saved -= amt;
    }
    return res;
  });
}

function cumulativeDaily(pid, upToIndex = null) {
  const p = periodObj(pid);
  const f = flows(pid);
  const out = [];
  let sum = 0;
  const n = upToIndex ?? p.days_total;
  for (let i = 0; i < n; i++) {
    sum += f.dailyByDay.get(addDays(p.from, i)) || 0;
    out.push(sum);
  }
  return out;
}

/* ======================================================================================
   Recurring detection (SPEC §9, simplified: card/atm payments are never recurring here)
   ====================================================================================== */

const WINDOWS = [
  ['weekly', 5, 9, 52 / 12], ['2-weekly', 12, 16, 26 / 12], ['monthly', 24, 38, 1], ['quarterly', 80, 102, 1 / 3],
  ['half-year', 165, 200, 1 / 6], ['yearly', 340, 390, 1 / 12],
];
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const PER_YEAR = { weekly: 52, '2-weekly': 26, '4-weekly': 13, monthly: 12, quarterly: 4, 'half-year': 2, yearly: 1 };
let recTx = new Map(); // item key -> its payments (oldest first), filled by recurringItems()

function recurringItems() {
  return cached('recurring', () => {
    recTx = new Map();
    const today = dataToday();
    const groups = new Map();
    for (const t of db.transactions) {
      if (!isCashflow(t) || t.manual || t.method === 'card' || t.method === 'atm' || t.kind === 'settlement') continue;
      const c = catById(t.category_id);
      if (!c || c.grp === 'internal') continue;
      const dir = t.amount_cents < 0 ? 'out' : 'in';
      const k = t.merchant_key + '|' + dir;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    const items = [];
    for (const [, list] of groups) {
      const byAmt = [...list].sort((a, b) => Math.abs(a.amount_cents) - Math.abs(b.amount_cents));
      const clusters = [];
      let cur = [];
      for (const t of byAmt) {
        const a = Math.abs(t.amount_cents);
        if (cur.length && a > Math.abs(cur.at(-1).amount_cents) * 1.15 + 50) { clusters.push(cur); cur = []; }
        cur.push(t);
      }
      if (cur.length) clusters.push(cur);
      for (const cl of clusters) {
        const txs = cl.sort((a, b) => (a.date < b.date ? -1 : 1));
        if (txs.length < 2) continue;
        const gaps = txs.slice(1).map((t, i) => daysBetween(txs[i].date, t.date));
        const mg = median(gaps);
        // Every gap 26–29 days: four-weekly (13 times a year), not monthly (DECISIONS, Analytics review).
        const win = gaps.length >= 2 && gaps.every((g) => g >= 26 && g <= 29)
          ? ['4-weekly', 26, 29, 13 / 12]
          : WINDOWS.find(([, lo, hi]) => mg >= lo && mg <= hi);
        if (!win) continue;
        if (win[0] !== 'yearly' && txs.length < 3) continue;
        const within = gaps.filter((g) => Math.abs(g - mg) <= mg * 0.35).length / gaps.length;
        if (within < 0.7) continue;
        const last6 = txs.slice(-6).map((t) => Math.abs(t.amount_cents));
        let variable = false;
        if (Math.max(...last6) > Math.min(...last6) * 1.25) {
          if (win[0] === 'monthly' && txs.length >= 4) variable = true; else continue;
        }
        // daily bakjes (services/recurring.py): only a stable amount at a subscription rhythm,
        // or every two/four weeks when not paid by card; a yearly card pair is a coincidence
        const grp = catById(txs.at(-1).category_id)?.grp;
        if (grp === 'daily' || catById(txs.at(-1).category_id)?.key === 'unsorted') {
          const byCard = txs.every((t) => t.method === 'card');
          const sorted = catById(txs.at(-1).category_id)?.key !== 'unsorted';
          const rhythm = ['monthly', 'quarterly', 'half-year', 'yearly', ...(sorted && !byCard ? ['2-weekly', '4-weekly'] : [])];
          const whole6 = txs.slice(-6).map((t) => Math.abs(t.amount_cents));
          if (!rhythm.includes(win[0]) || variable || Math.max(...whole6) > Math.min(...whole6) * 1.05) continue;
          if (win[0] === 'yearly' && txs.length === 2 && byCard) continue;
        }
        const last = txs.at(-1);
        const first = txs[0];
        const sinceLast = daysBetween(last.date, today);
        let status = 'active';
        if (daysBetween(first.date, today) < 75) status = 'new';
        if (sinceLast > mg * 1.6) status = 'ended';
        if (status === 'ended' && sinceLast > mg * 1.6 + 92) continue;
        let next = addDays(last.date, Math.round(mg));
        if (win[0] === 'monthly') {
          const day = Number(last.date.slice(8));
          const np = shiftPeriod(last.date.slice(0, 7), 1);
          const dim = new Date(Date.UTC(+np.slice(0, 4), +np.slice(5), 0)).getUTCDate();
          next = `${np}-${String(Math.min(day, dim)).padStart(2, '0')}`;
        }
        const prev3 = txs.slice(-4, -1).map((t) => Math.abs(t.amount_cents));
        let change = null;
        if (prev3.length >= 1) {
          const m = median(prev3);
          const a = Math.abs(last.amount_cents);
          if (Math.abs(a - m) > m * 0.02 && Math.abs(a - m) > 50) change = { from_cents: Math.round(m) * Math.sign(last.amount_cents), to_cents: last.amount_cents, date: last.date };
        }
        const typical = Math.round(median(txs.slice(-6).map((t) => t.amount_cents)));
        // same key as services/recurring.py: merchant|direction|frequency|first amount in euros
        const firstAmount = Math.round(median(txs.slice(0, 3).map((t) => Math.abs(t.amount_cents))) / 100);
        const key = `${last.merchant_key}|${last.amount_cents < 0 ? 'out' : 'in'}|${win[0]}${variable ? '' : `|${firstAmount}`}`;
        if (db.recurring_ignored.includes(key)) continue;
        recTx.set(key, txs);
        items.push({
          key, name: last.merchant_name, merchant_key: last.merchant_key, category_id: last.category_id,
          direction: last.amount_cents < 0 ? 'out' : 'in', amount_cents: last.amount_cents, frequency: win[0],
          per_month_cents: Math.round(Math.abs(variable ? typical : last.amount_cents) * win[3]) * Math.sign(last.amount_cents),
          per_year_cents: Math.abs(variable ? typical : last.amount_cents) * PER_YEAR[win[0]],
          last_date: last.date, next_date: next, status, variable, count: txs.length, change,
        });
      }
    }
    return items.sort((a, b) => Math.abs(b.per_month_cents) - Math.abs(a.per_month_cents));
  });
}

/* ======================================================================================
   Overview, insights, trends
   ====================================================================================== */

function categoryAvg(catId, pid) {
  const prev = previousComplete(pid, 6);
  if (!prev.length) return 0;
  return Math.round(prev.reduce((s, p) => s + (flows(p).cats.get(catId)?.cents || 0), 0) / prev.length);
}

function overview(pid) {
  const p = periodObj(pid);
  const f = flows(pid);
  const prev = previousComplete(pid, 6);
  const last3 = prev.slice(0, 3);
  const avgIncome = last3.length ? Math.round(last3.reduce((s, x) => s + flows(x).income, 0) / last3.length) : 0;
  const rec = recurringItems();
  const dt = dataToday();
  const rest = (it) => it.status !== 'ended' && it.next_date > dt && it.next_date <= p.to;
  const isGrp = (it, g) => catById(it.category_id)?.grp === g;
  const fixedUp = p.is_current ? rec.filter((it) => it.direction === 'out' && isGrp(it, 'fixed') && rest(it)) : [];
  const savingUp = p.is_current ? rec.filter((it) => it.direction === 'out' && isGrp(it, 'saving') && rest(it)) : [];
  const fixed_upcoming_cents = fixedUp.reduce((s, it) => s - it.amount_cents, 0);
  // expected in this period, date passed without showing up: "achterstallig?" (not still to come)
  const overdueUp = p.is_current ? rec.filter((it) => it.direction === 'out' && isGrp(it, 'fixed') && it.status !== 'ended' && it.next_date >= p.from && it.next_date < db.today) : [];
  const fixed_overdue_cents = overdueUp.reduce((s, it) => s - it.amount_cents, 0);
  const incomeItems = rec.filter((it) => it.direction === 'in' && isGrp(it, 'income') && it.status !== 'ended');
  const mainSalary = incomeItems.length ? incomeItems.reduce((x, y) => (y.amount_cents > x.amount_cents ? y : x)) : null;
  const salaryUp = p.is_current && mainSalary && mainSalary.next_date >= p.from && mainSalary.next_date <= p.to ? [mainSalary.next_date] : [];
  const saving_upcoming_cents = savingUp.reduce((s, it) => s - it.amount_cents, 0);
  const expected_income_cents = last3.length ? avgIncome : null;
  const enoughHistory = prev.length >= 2;
  let left = null;
  let perDay = null;
  if (p.is_current && enoughHistory) {
    left = Math.max(f.income, expected_income_cents || 0) - f.fixed - fixed_upcoming_cents - f.saved - saving_upcoming_cents - f.daily;
    const remaining = p.days_total - p.day_index + 1;
    perDay = Math.round(left / Math.max(1, remaining));
  }
  const net = f.income - f.fixed - f.daily - f.saved;

  let pace = null;
  if (prev.length) {
    const typical = [];
    const series = prev.map((x) => cumulativeDaily(x));
    for (let i = 0; i < p.days_total; i++) {
      typical.push(Math.round(median(series.map((arr) => arr[Math.min(i, arr.length - 1)] || 0))));
    }
    const upto = p.is_current ? Math.max(1, daysBetween(p.from, dt) + 1) : p.days_total;
    pace = {
      days: Array.from({ length: p.days_total }, (_, i) => addDays(p.from, i)),
      actual: cumulativeDaily(pid, Math.min(upto, p.days_total)),
      typical,
    };
  }

  const categories = [...f.cats.entries()]
    .map(([category_id, e]) => ({ category_id, spent_cents: e.cents, avg_cents: categoryAvg(category_id, pid), count: e.count }))
    .filter((c) => c.spent_cents !== 0)
    .sort((a, b) => b.spent_cents - a.spent_cents);
  const income = [...f.incomeCats.entries()].map(([category_id, e]) => ({ category_id, cents: e.cents })).sort((a, b) => b.cents - a.cents);
  const upcoming = [...overdueUp, ...fixedUp, ...savingUp]
    .sort((a, b) => (a.next_date < b.next_date ? -1 : 1))
    .map((it) => ({ key: it.key, name: it.name, date: it.next_date, amount_cents: it.amount_cents, category_id: it.category_id, overdue: it.next_date < db.today }));

  const q = sortQueue();
  const unsorted = {
    merchants: q.length,
    transactions: q.reduce((s, x) => s + x.count, 0),
    cents: q.reduce((s, x) => s + x.total_cents, 0),
  };
  const checking = db.accounts.filter((a) => a.type === 'checking').reduce((s, a) => s + (accountBalance(a).balance_cents || 0), 0);
  let expectedEnd = null;
  if (p.is_current && pace) {
    const typicalRest = pace.typical.at(-1) - (pace.typical[pace.actual.length - 1] || 0);
    expectedEnd = checking - fixed_upcoming_cents - saving_upcoming_cents + Math.max(0, (expected_income_cents || 0) - f.income) - typicalRest;
  }

  const result = {
    period: p,
    income_cents: f.income, expected_income_cents, fixed_cents: f.fixed, fixed_upcoming_cents, fixed_overdue_cents,
    salary_expected: salaryUp[0] || null,
    daily_cents: f.daily, saved_cents: f.saved, repaid_cents: f.repaid, saving_upcoming_cents,
    left_cents: left, per_day_left_cents: perDay, net_cents: net, result_cents: f.income - f.fixed - f.daily,
    pace, categories, income, upcoming, insights: [], unsorted,
    balance: { checking_cents: checking, expected_end_cents: expectedEnd },
    free: null, tempo: null, buffer: null, checking_warning: null, health: null,
  };
  if (p.is_current) Object.assign(result, outlook());
  result.insights = insights(result, prev);
  return result;
}

/** GET /overview?period=YYYY: the started periods of a year added up (SPEC §9 "Jaar"). */
function yearOverview(year) {
  const cur = currentPeriod();
  const first = firstPeriod();
  const ids = [];
  for (let m = 1; m <= 12; m++) {
    const id = `${year}-${String(m).padStart(2, '0')}`;
    if (id <= cur) ids.push(id);
  }
  if (!ids.length) return null;
  const sum = (list) => {
    const out = { income: 0, fixed: 0, daily: 0, saved: 0, repaid: 0, cats: new Map(), incomeCats: new Map() };
    for (const id of list) {
      const f = flows(id);
      out.income += f.income; out.fixed += f.fixed; out.daily += f.daily; out.saved += f.saved; out.repaid += f.repaid;
      for (const [k, map] of [['cats', f.cats], ['incomeCats', f.incomeCats]]) {
        for (const [cid, e] of map) {
          const o = out[k].get(cid) || { cents: 0, count: 0 };
          o.cents += e.cents; o.count += e.count; out[k].set(cid, o);
        }
      }
    }
    out.net = out.income - out.fixed - out.daily - out.saved;
    out.result = out.income - out.fixed - out.daily;
    return out;
  };
  const t = sum(ids);
  const prevIds = ids.map((id) => shiftPeriod(id, -12));
  const prev = prevIds[0] > first ? sum(prevIds) : null;
  const ytd = ids.includes(cur);
  const from = periodBounds(ids[0]).from;
  const lastTo = periodBounds(ids.at(-1)).to;
  const to = ytd ? db.today : lastTo;
  const days_total = daysBetween(from, lastTo) + 1;
  const n = Math.max(1, ids.filter((id) => { const f = flows(id); return f.income || f.fixed || f.daily || f.saved; }).length);
  const pm = (v) => Math.round(v / n);
  const q = sortQueue();
  const checking = db.accounts.filter((a) => a.type === 'checking').reduce((s, a) => s + (accountBalance(a).balance_cents || 0), 0);
  return {
    period: {
      id: String(year), kind: 'year', label: ytd ? `${year} tot nu` : String(year), year, from, to,
      is_current: ytd, ytd, months: ids.length, first_period: ids[0], last_period: ids.at(-1),
      day_index: Math.min(days_total, daysBetween(from, to) + 1), days_total,
      prev: `${year - 1}-12` >= first ? String(year - 1) : null,
      next: `${year + 1}-01` <= cur ? String(year + 1) : null,
    },
    income_cents: t.income, expected_income_cents: t.income, fixed_cents: t.fixed, fixed_upcoming_cents: 0,
    daily_cents: t.daily, saved_cents: t.saved, repaid_cents: t.repaid, saving_upcoming_cents: 0,
    fixed_overdue_cents: 0, salary_expected: null,
    left_cents: null, per_day_left_cents: null, net_cents: t.net, result_cents: t.result,
    per_month: { income_cents: pm(t.income), fixed_cents: pm(t.fixed), daily_cents: pm(t.daily), saved_cents: pm(t.saved), repaid_cents: pm(t.repaid), net_cents: pm(t.net), result_cents: pm(t.result) },
    previous_year: prev && { income_cents: prev.income, fixed_cents: prev.fixed, daily_cents: prev.daily, saved_cents: prev.saved, net_cents: prev.net,
      from: periodBounds(prevIds[0]).from, to: periodBounds(prevIds.at(-1)).to },
    months: ids.map((id) => {
      const f = flows(id);
      return { period: id, label: monthLabel(id), income_cents: f.income, fixed_cents: f.fixed, daily_cents: f.daily,
        saved_cents: f.saved, repaid_cents: f.repaid, net_cents: f.income - f.fixed - f.daily - f.saved, result_cents: f.income - f.fixed - f.daily, partial: id === cur };
    }),
    pace: null,
    categories: [...t.cats.entries()]
      .map(([category_id, e]) => ({ category_id, spent_cents: e.cents, avg_cents: prev?.cats.get(category_id)?.cents || 0, count: e.count, per_month_cents: pm(e.cents) }))
      .filter((c) => c.spent_cents !== 0)
      .sort((a, b) => b.spent_cents - a.spent_cents),
    income: [...t.incomeCats.entries()].map(([category_id, e]) => ({ category_id, cents: e.cents })).sort((a, b) => b.cents - a.cents),
    upcoming: [], insights: [],
    unsorted: { merchants: q.length, transactions: q.reduce((s, x) => s + x.count, 0), cents: q.reduce((s, x) => s + x.total_cents, 0) },
    balance: { checking_cents: checking, expected_end_cents: null },
    free: null, tempo: null, buffer: null, checking_warning: null, health: null,
  };
}

/* ---------- Nog te besteden, tempo, buffer, betaalrekening (SPEC §9, services/outlook.py) ---------- */

const OCC_STEP_DAYS = { weekly: 7, '2-weekly': 14, '4-weekly': 28, quarterly: 91, 'half-year': 182, yearly: 365 };

/** Expected dates of a live recurring item in [from, to) (ISO strings). */
function occurrences(it, from, to) {
  if (it.status === 'ended') return [];
  const out = [];
  let d = it.next_date;
  while (d < to && out.length < 10) {
    if (d >= from) out.push(d);
    if (it.frequency === 'monthly') {
      const np = shiftPeriod(d.slice(0, 7), 1);
      const dim = new Date(Date.UTC(+np.slice(0, 4), +np.slice(5), 0)).getUTCDate();
      d = `${np}-${String(Math.min(Number(it.next_date.slice(8)), dim)).padStart(2, '0')}`;
    } else d = addDays(d, OCC_STEP_DAYS[it.frequency] || 30);
  }
  return out;
}

function dayInMonth(ym, day) {
  const dim = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5), 0)).getUTCDate();
  return `${ym}-${String(Math.min(day, dim)).padStart(2, '0')}`;
}

/** Next salary after `base` (the main checking account's balance date, not today: a salary that
 *  is due but not imported yet is still the upcoming payday). */
function payday(rec, base = db.today) {
  const set = assumptionsOut().payday_day.day;
  if (Number.isInteger(set)) {
    let d = dayInMonth(base.slice(0, 7), set);
    if (d <= base) d = dayInMonth(shiftPeriod(base.slice(0, 7), 1), set);
    return [d, 'setting'];
  }
  const income = rec.filter((i) => i.direction === 'in' && i.status !== 'ended' && catById(i.category_id)?.grp === 'income');
  if (income.length) {
    const main = income.reduce((a, b) => (b.amount_cents > a.amount_cents ? b : a));
    const next = occurrences(main, addDays(base, 1), addDays(base, 400))[0];
    if (next) return [next, 'salary'];
  }
  return [addDays(periodObj(currentPeriod()).to, 1), 'period'];
}

const nextMonthDay = (iso, day) => dayInMonth(shiftPeriod(iso.slice(0, 7), 1), day ?? Number(iso.slice(8)));

function outlook() {
  const rec = recurringItems();
  const a = assumptionsOut();
  const grp = (it) => catById(it.category_id)?.grp;
  const due = (from, to, groups, dir = 'out') => rec.filter((it) => it.direction === dir && groups.includes(grp(it)))
    .flatMap((it) => occurrences(it, from, to).map((d) => [it, d]));
  const accs = db.accounts.filter((x) => !x.hidden && (x.type === 'checking' || x.type === 'savings'))
    .map((x) => ({ ...x, ...accountBalance(x) })).filter((x) => x.balance_cents != null);
  const hist = previousComplete(currentPeriod(), 12);
  const net = (pid) => { const f = flows(pid); return f.income - f.fixed - f.daily; };
  const stale = (d) => !!d && daysBetween(d, db.today) > 5;
  const chk = accs.filter((x) => x.type === 'checking')
    .sort((x, y) => db.transactions.filter((t) => t.account_id === y.id).length - db.transactions.filter((t) => t.account_id === x.id).length)[0];
  // typical daily spending per day: median per-day rate of the last six complete periods,
  // without credit-card settlement lumps (estimated separately)
  const rates = hist.slice(0, 6).map((x) => (flows(x).daily - flows(x).spreadDaily - flows(x).card) / periodObj(x).days_total);
  const rate = rates.length ? median(rates) : 0;
  const goals = goalsData().goals;
  const monthlyFixed = monthlyFixedCosts();
  // one buffer (SPEC 9): the target of the buffer potje when it has one, else the assumption
  const pots = goals.filter((g) => /buffer/i.test(g.name));
  const potTarget = pots.reduce((s, g) => s + (g.target_cents || 0), 0);
  const target = potTarget > 0 ? potTarget : assumedBuffer()[0];

  // buffer: a potje named "buffer", else savings outside potjes (at most the target)
  let buffer = null;
  const savingAccs = accs.filter((x) => x.type === 'savings');
  const savingsTotal = savingAccs.reduce((s, x) => s + x.balance_cents, 0);
  {
    const freeSav = Math.max(0, savingsTotal - goals.reduce((s, g) => s + Math.max(0, g.saldo_cents), 0));
    const saved = pots.length ? pots.reduce((s, g) => s + Math.max(0, g.saldo_cents), 0) : target ? Math.min(freeSav, target) : freeSav;
    if (target || saved) {
      buffer = { saved_cents: saved, target_cents: target, source: pots.length ? 'potje' : 'savings',
        target_source: potTarget > 0 ? 'potje' : 'assumption', goal_id: pots[0]?.id ?? null, monthly_fixed_cents: Math.round(monthlyFixed),
        months: monthlyFixed > 0 ? Math.round((saved / monthlyFixed) * 10) / 10 : null,
        target_months: monthlyFixed > 0 ? Math.round((target / monthlyFixed) * 10) / 10 : null };
    }
  }

  // Nog te besteden: the checking account(s) only; savings next to it (services/outlook.py free)
  let free = null;
  const base = chk?.as_of || accs.map((x) => x.as_of).filter(Boolean).sort().at(-1) || db.today;
  const [pay, source] = payday(rec, base < db.today ? base : db.today);
  const checking = accs.filter((x) => x.type === 'checking');
  if (checking.length) {
    const balances = checking.reduce((s, x) => s + x.balance_cents, 0);
    const as_of = checking.map((x) => x.as_of).filter(Boolean).sort()[0] || null;
    const credit = db.accounts.filter((x) => x.type === 'credit' && !x.hidden).reduce((s, x) => s + (accountBalance(x).outstanding_cents || 0), 0);
    const start = as_of ? addDays(as_of, 1) : db.today;
    const fixed = due(start, pay, ['fixed']).reduce((s, [it]) => s - it.amount_cents, 0);
    const periodStart = periodBounds(currentPeriod()).from;
    // paid when any payment to that merchant came from 10 days before the expected day on
    const paidSince = (it) => db.transactions.some((t) => t.merchant_key === it.merchant_key && t.amount_cents < 0 && t.date >= addDays(it.next_date, -10));
    const overdue = rec.filter((it) => it.direction === 'out' && it.status !== 'ended' && grp(it) === 'fixed' && it.next_date >= periodStart && it.next_date < start && !paidSince(it))
      .map((it) => ({ name: it.name, date: it.next_date, cents: -it.amount_cents })).sort((x, y) => (x.date < y.date ? -1 : 1));
    const overdueCents = overdue.reduce((s, x) => s + x.cents, 0);
    const toSavings = Math.max(0, due(start, pay, ['saving']).reduce((s, [it]) => s - it.amount_cents, 0));
    // next credit-card settlement: median unexplained part of the last three, one month on
    const unexpl = settlementUnexplained().map;
    const settles = db.transactions.filter((t) => t.kind === 'settlement' && (unexpl.get(t.id) || 0) > 0).sort((x, y) => (x.date < y.date ? -1 : 1));
    let card = null;
    if (settles.length) {
      const cents = Math.round(median(settles.slice(-3).map((t) => unexpl.get(t.id))));
      const lastDay = settles.at(-1).date;
      let d = nextMonthDay(lastDay);
      while (d < start) d = nextMonthDay(d, Number(lastDay.slice(8)));
      if (cents > 0 && d < pay) card = { date: d, cents };
    }
    const days = Math.max(0, daysBetween(start, pay));
    const daily = Math.round(rate * days);
    const total = balances - fixed - overdueCents - toSavings - credit - (card ? card.cents : 0) - daily;
    const daysLeft = daysBetween(db.today, pay);
    const inGoals = goals.reduce((s, g) => s + Math.max(0, g.saldo_cents), 0);
    const goalsCents = savingsTotal > 0 ? Math.min(inGoals, savingsTotal) : 0;
    const reserved = buffer && buffer.source === 'savings' ? Math.min(buffer.saved_cents, buffer.target_cents || 0, Math.max(0, savingsTotal - goalsCents)) : 0;
    const accJson = (x) => ({ name: x.name, type: x.type, balance_cents: x.balance_cents, as_of: x.as_of, stale: stale(x.as_of) });
    free = {
      total_cents: total, balances_cents: balances, fixed_until_payday_cents: fixed, fixed_overdue_cents: overdueCents, fixed_overdue: overdue,
      saving_until_payday_cents: toSavings, credit_cents: credit,
      card_settlement: card, daily_until_payday_cents: daily, daily_rate_cents: Math.round(rate), daily_days: days,
      days_left: Math.max(0, daysLeft), per_day_cents: daysLeft > 0 ? Math.trunc(total / daysLeft) : null,
      day_budget_cents: daysLeft > 0 ? Math.max(0, Math.round(rate + total / daysLeft)) : null,
      payday: pay, payday_source: source, salary_pending: pay <= db.today, as_of, stale: stale(as_of),
      accounts: checking.map(accJson),
      savings: savingAccs.length ? { balance_cents: savingsTotal, goals_cents: goalsCents, buffer_cents: reserved, free_cents: Math.max(0, savingsTotal - goalsCents - reserved), accounts: savingAccs.map(accJson) } : null,
    };
  }

  let tempo = null;
  if (hist.length >= 2) {
    const recent = hist.slice(0, 3);
    const avg = Math.round(recent.reduce((s, x) => s + net(x), 0) / recent.length);
    let since = recent.at(-1);
    if (avg < 0) {
      const run = [];
      for (const x of hist) { if (net(x) >= 0) break; run.push(x); }
      if (run.length > recent.length) since = run.at(-1);
    }
    tempo = { avg_net_cents: avg, periods: recent.length, since, months: [...hist].reverse().map((x) => ({ period: x, net_cents: net(x) })) };
  }

  let checking_warning = null;
  if (chk && hist.length) {
    const floor = a.checking_floor_cents.cents;
    const start = chk.as_of ? addDays(chk.as_of, 1) : db.today;
    const dueBy = new Map();
    for (const [it, d] of [...due(start, pay, ['fixed', 'saving']), ...due(start, pay, ['income'], 'in')]) dueBy.set(d, (dueBy.get(d) || 0) + it.amount_cents);
    let bal = chk.balance_cents;
    let low = null;
    let lowDay = null;
    for (let d = start; d < pay; d = addDays(d, 1)) {
      bal += (dueBy.get(d) || 0) - rate;
      if (d >= db.today && (low == null || bal < low)) { low = bal; lowDay = d; }
    }
    if (low != null && low < floor) {
      const lowC = Math.floor(low);
      const suggest = Math.ceil((floor - lowC) / 5000) * 5000;
      const sav = accs.filter((x) => x.type === 'savings').reduce((s, x) => s + x.balance_cents, 0);
      checking_warning = { date: lowDay, low_cents: lowC, floor_cents: floor, suggest_cents: sav >= suggest ? suggest : null, account_id: chk.id, payday: pay };
    }
  }
  const h = health(buffer);
  if (h) { const cov = checksData().coverage; h.accounted = cov && { share: cov.share, unknown_cents: cov.unknown_cents, months: cov.months }; }
  return { free, tempo, buffer, checking_warning, health: h };
}

/** Average monthly fixed costs (services/outlook.py monthly_fixed): with the mortgage repayment,
 *  without spread parts; previous up to six complete periods, else recurring items. */
function monthlyFixedCosts() {
  const live = -recurringItems().filter((it) => it.direction === 'out' && it.status !== 'ended' && catById(it.category_id)?.grp === 'fixed').reduce((s, it) => s + it.per_month_cents, 0);
  if (live > 0) return live;
  const h6 = previousComplete(currentPeriod(), 6);
  return h6.length ? h6.reduce((s, x) => s + flows(x).fixed - flows(x).spreadFixed + flows(x).repaid, 0) / h6.length : 0;
}

/** Average real income and repayment per month over the last up to 12 complete periods
 *  (services/health.py income); null with fewer than two. */
function incomeAvg() {
  const hist = previousComplete(currentPeriod(), 12);
  if (hist.length < 2) return null;
  return { income_cents: Math.round(hist.reduce((s, p) => s + flows(p).income, 0) / hist.length),
    repaid_cents: Math.round(hist.reduce((s, p) => s + flows(p).repaid, 0) / hist.length), months: hist.length };
}

/** [cents, reason] of the `buffer` assumption (services/outlook.py assumed_buffer_target). */
function assumedBuffer() {
  const b = assumptionsOut().buffer;
  if (b.amount_cents != null) return [Math.max(0, b.amount_cents), 'je eigen bedrag'];
  const m = Number(b.months || 0);
  return [Math.max(0, Math.round(monthlyFixedCosts() * m)), `${String(m).replace('.', ',')} ${m === 1 ? 'maand' : 'maanden'} vaste lasten`];
}

/** Zelfcontrole (services/checks.py): verantwoordingsmeter, missing months, balance breaks,
 *  transfers without their other half. */
function checksData() {
  const hist = previousComplete(currentPeriod(), 12);
  let coverage = null;
  if (hist.length) {
    const spent = new Map();
    for (const p of hist) for (const [id, e] of flows(p).cats) spent.set(id, (spent.get(id) || 0) + e.cents);
    const total = [...spent.values()].filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const unknown = ['unsorted', 'contant', 'overig', 'creditcard'].map((key) => {
      const id = catByKey(key)?.id;
      const cents = Math.max(0, spent.get(id) || 0);
      return { key, category_id: id, cents, per_month_cents: Math.round(cents / hist.length), share: total ? Math.round((cents / total) * 10000) / 10000 : 0 };
    }).filter((u) => u.cents).sort((a, b) => b.cents - a.cents);
    const unknown_cents = unknown.reduce((s, u) => s + u.cents, 0);
    coverage = { months: hist.length, spent_cents: total, unknown_cents, share: total ? Math.round(((total - unknown_cents) / total) * 10000) / 10000 : null, unknown };
  }
  const breaksOf = (rows) => {
    const totals = new Map();
    const balanced = new Map();
    for (const r of rows) {
      totals.set(r.date, (totals.get(r.date) || 0) + r.amount_cents);
      if (r.balance_after_cents != null) balanced.set(r.date, [...(balanced.get(r.date) || []), r]);
    }
    const out = [];
    let prev = null;
    for (const day of [...totals.keys()].sort()) {
      const txs = (balanced.get(day) || []).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.id - b.id);
      if (!txs.length) { prev = prev == null ? null : prev + totals.get(day); continue; }
      if (prev == null) { prev = txs.at(-1).balance_after_cents; continue; }
      const expected = prev + totals.get(day);
      if (txs.some((r) => r.balance_after_cents === expected)) { prev = expected; continue; }
      const end = txs.at(-1).balance_after_cents;
      out.push({ date: day, expected_cents: expected, actual_cents: end, difference_cents: end - expected });
      prev = end;
    }
    return out;
  };
  const accounts = db.accounts.filter((a) => !a.hidden && ['checking', 'savings', 'credit'].includes(a.type)).map((a) => {
    const rows = db.transactions.filter((t) => t.account_id === a.id).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (x.seq ?? 0) - (y.seq ?? 0) || x.id - y.id));
    const imp = db.imports.filter((i) => i.account_id === a.id).map((i) => i.imported_at.slice(0, 10)).sort().at(-1) || null;
    const item = { id: a.id, name: a.name, type: a.type, count: rows.length, first_date: rows[0]?.date || null, last_date: rows.at(-1)?.date || null,
      last_import: imp, days_since: rows.length ? daysBetween(rows.at(-1).date, db.today) : null, missing_months: [], breaks: [], breaks_count: 0 };
    if (rows.length && a.type === 'checking') {
      const seen = new Set(rows.map((r) => r.date.slice(0, 7)));
      for (let m = rows[0].date.slice(0, 7); m <= rows.at(-1).date.slice(0, 7); m = shiftPeriod(m, 1)) if (!seen.has(m)) item.missing_months.push(m);
    }
    if (rows.length && a.type !== 'credit') { const b = breaksOf(rows); item.breaks = b.slice(-8); item.breaks_count = b.length; }
    return item;
  });
  const spans = new Map(accounts.filter((a) => a.type !== 'credit' && a.first_date).map((a) => [a.id, [a.first_date, a.last_date]]));
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  const unmatched = db.transactions.filter((t) => t.kind === 'transfer' && t.transfer_account_id != null)
    .filter((t) => { const s = spans.get(t.transfer_account_id); return s && s[0] <= t.date && t.date <= s[1] && names.has(t.account_id); })
    .filter((t) => !db.transactions.some((o) => o.account_id === t.transfer_account_id && o.amount_cents === -t.amount_cents && Math.abs(daysBetween(o.date, t.date)) <= 4))
    .sort((x, y) => (x.date < y.date ? 1 : -1))
    .map((t) => ({ transaction_id: t.id, date: t.date, amount_cents: t.amount_cents, account: names.get(t.account_id), other_account: names.get(t.transfer_account_id) }));
  const transfers = { count: unmatched.length, items: unmatched.slice(0, 8) };
  const issues = accounts.reduce((s, a) => s + a.breaks_count + a.missing_months.length, 0) + transfers.count;
  return { coverage, accounts, transfers, issues };
}

/** Hoe staan we ervoor (services/health.py). */
function health(buffer) {
  const hist = previousComplete(currentPeriod(), 12);
  if (hist.length < 2) return null;
  const n = hist.length;
  if (!hist.some((p) => flows(p).fixed || flows(p).daily)) return null;   // no spending seen yet
  const avg = (fn) => hist.reduce((s, p) => s + fn(flows(p)), 0) / n;
  const income = avg((f) => f.income);
  const fixed = monthlyFixedCosts();
  const repaid = avg((f) => f.repaid);
  const saved = avg((f) => f.saved - f.repaid);
  const housingIds = ['wonen', 'energie', 'belastingen'].map((k) => catByKey(k)?.id).filter(Boolean);
  // without spread parts: the parts are in f.cats too, so take them out per bakje
  const housing = avg((f) => housingIds.reduce((s, id) => s + (f.cats.get(id)?.cents || 0) + (f.repaidCats.get(id) || 0), 0))
    - hist.reduce((s, p) => s + periodParts(p).filter((x) => housingIds.includes(x.category_id)).reduce((a, x) => a + x.cents, 0), 0) / n;
  const share = (x) => (income > 0 ? Math.round((x / income) * 1000) / 1000 : null);
  const nw = networth();
  const debts = [];
  if (nw.home?.debt_cents) debts.push({ kind: 'mortgage', name: 'Hypotheek', cents: nw.home.debt_cents });
  for (const x of nw.assets || []) if (x.kind === 'debt' && (x.value_cents || 0) > 0) debts.push({ kind: 'debt', name: x.name, cents: x.value_cents, id: x.id });
  const r = Math.round;
  return {
    months: n, income_cents: r(income),
    buffer: buffer ? { months: buffer.months, target_months: buffer.target_months, saved_cents: buffer.saved_cents, target_cents: buffer.target_cents, source: buffer.source } : null,
    housing: { cents: r(housing), share: share(housing) },
    fixed: { cents: r(fixed), share: share(fixed), rest_cents: r(income - fixed) },
    saving: { cents: r(saved), share: share(saved), repaid_cents: r(repaid) },
    debts: { known: debts.length > 0, total_cents: debts.reduce((s, d) => s + d.cents, 0), items: debts },
  };
}

// Informational kinds the Overzicht does not show (services/insights.py OVERZICHT_HIDDEN).
const OVERZICHT_HIDDEN = new Set(['fixed_share', 'last_year', 'savings_rate', 'pace', 'buffer', 'goal_reached', 'bank_fees', 'fx_costs']);

function insights(o, prev) {
  const out = [];
  const p = o.period;
  const cat = (id) => catById(id) || {};
  if (o.pace && p.is_current && o.pace.actual.length > 3) {
    const i = o.pace.actual.length - 1;
    const diff = o.pace.actual[i] - o.pace.typical[i];
    if (Math.abs(diff) >= 2500) {
      out.push({ id: 'pace', kind: 'pace', tone: diff < 0 ? 'good' : 'info', emoji: diff < 0 ? '🌱' : '🧭', title: diff < 0 ? `Dagelijkse uitgaven op koers: ${euros(-diff)} onder normaal tot nu toe` : `Dagelijkse uitgaven ${euros(diff)} boven normaal tot nu toe`, value_cents: Math.abs(diff), link: `/transacties?period=${p.id}`, rank: Math.abs(diff) / 100 + 40 });
    }
  }
  let spikes = 0;
  for (const c of o.categories) {
    if (spikes >= 2) break;
    const scale = p.is_current && cat(c.category_id).grp === 'daily' ? p.day_index / p.days_total : 1;
    const normal = c.avg_cents * scale;
    const diff = c.spent_cents - normal;
    if (cat(c.category_id).key === 'unsorted') continue;
    if (c.avg_cents > 0 && diff > 5000 && diff > normal * 0.2 && prev.length >= 3) {
      spikes++;
      out.push({ id: 'spike-' + c.category_id, kind: 'category_spike', tone: 'info', emoji: cat(c.category_id).emoji, title: `${cat(c.category_id).name}: ${euros(diff)} meer dan normaal`, value_cents: Math.round(diff), link: `/overzicht/bakje/${c.category_id}?period=${p.id}`, rank: diff / 100 });
    }
  }
  const rec = recurringItems();
  for (const it of rec) {
    if (it.change && it.direction === 'out' && daysBetween(it.change.date, db.today) < 100 && it.status !== 'ended') {
      const d = Math.abs(it.change.to_cents) - Math.abs(it.change.from_cents);
      out.push({ id: 'price-' + it.key, kind: 'price_change', tone: 'info', emoji: '🏷️', title: d > 0 ? `${it.name} is ${euros(d)} duurder geworden` : `${it.name} is ${euros(-d)} goedkoper geworden`, value_cents: d, link: '/vaste-lasten', rank: 60 + Math.abs(d) / 100 });
    }
    if (it.status === 'new' && it.direction === 'out') {
      out.push({ id: 'new-' + it.key, kind: 'new_recurring', tone: 'info', emoji: '✨', title: `Nieuw: ${it.name}, ${euros(-it.per_month_cents)} per maand`, value_cents: -it.per_month_cents, link: '/vaste-lasten', rank: 55 });
    }
    if (it.status === 'ended' && it.direction === 'out') {
      out.push({ id: 'ended-' + it.key, kind: 'ended_recurring', tone: 'info', emoji: '⏸️', title: `${it.name} is gestopt`, link: '/vaste-lasten', rank: 30 });
    }
    if (it.frequency === 'yearly' && it.direction === 'out' && p.is_current) {
      const d = daysBetween(db.today, it.next_date);
      if (d > 0 && d <= 60) out.push({ id: 'yearly-' + it.key, kind: 'yearly_bill', tone: 'info', emoji: '📅', title: `${it.name} ${euros(-it.amount_cents)} komt eraan in ${MONTHS[Number(it.next_date.slice(5, 7)) - 1]}`, value_cents: -it.amount_cents, link: '/vaste-lasten', rank: 50 });
    }
  }
  if (p.is_current && o.tempo && o.tempo.avg_net_cents <= -2500) {
    out.push({ id: 'tempo:' + o.tempo.since, kind: 'tempo', tone: 'warn', emoji: '📉', title: `Jullie geven sinds ${MONTHS[Number(o.tempo.since.slice(5)) - 1]} gemiddeld ${euros(-o.tempo.avg_net_cents)} per maand meer uit dan er binnenkomt.`, value_cents: o.tempo.avg_net_cents, link: '/jaaroverzicht', rank: 62 });
  }
  if (!p.is_current && o.result_cents >= 5000) {
    // result = income − fixed − daily; a potje only for money not yet saved, never when the month drew on savings
    const unsaved = o.result_cents - o.saved_cents;
    let title = `${euros(o.result_cents)} over in ${MONTHS[Number(p.id.slice(5)) - 1]}`;
    if (o.saved_cents >= 0 && unsaved >= 5000) title += o.saved_cents === 0 ? '. Zet het in een potje?' : `, waarvan ${euros(unsaved)} nog niet gespaard. Zet het in een potje?`;
    else if (o.saved_cents < 0) title += `, met ${euros(-o.saved_cents)} uit je spaargeld`;
    out.push({ id: 'left-' + p.id, kind: 'left_over', tone: 'good', emoji: '🎉', title, value_cents: o.result_cents, link: '/potjes', rank: 80 });
  }
  if (o.income_cents > 0 && !p.is_current) {
    const rate = o.saved_cents / o.income_cents;
    if (rate > 0.05) out.push({ id: 'rate-' + p.id, kind: 'savings_rate', tone: 'good', emoji: '🐷', title: `${Math.round(rate * 100)}% van je inkomen gespaard`, link: '/potjes', rank: 35 });
  }
  const g = goalsData();
  for (const goal of g.goals) {
    if (goal.status === 'behind') out.push({ id: 'goal-' + goal.id, kind: 'goal_behind', tone: 'warn', emoji: goal.emoji, title: `${goal.name} loopt achter`, link: `/potjes/${goal.id}`, rank: 45 });
    if (goal.status === 'reached') out.push({ id: 'goal-' + goal.id, kind: 'goal_reached', tone: 'good', emoji: goal.emoji, title: `${goal.name} is gehaald`, link: `/potjes/${goal.id}`, rank: 42 });
  }
  if (o.unsorted.merchants > 0 && p.is_current) {
    out.push({ id: 'unsorted', kind: 'unsorted', tone: 'info', emoji: '🗂️', title: `${o.unsorted.merchants} winkels wachten op een bakje`, link: '/sorteren', rank: 20 });
  }
  if (p.is_current && Number(db.today.slice(5, 7)) === 4) {
    const year = Number(db.today.slice(0, 4)) - 1;
    if (db.mortgage_parts.length && !db.mortgage_years.some((e) => e.year === year)) {
      out.push({ id: `mortgage:${year}`, kind: 'mortgage', tone: 'info', emoji: '🏠', title: `Jaaropgave hypotheek ${year} invullen?`, link: '/vermogen', rank: 30 });
    } else if (!db.mortgage_parts.length && mortgageCandidates().some((c) => c.likely)) {
      out.push({ id: 'mortgage:setup', kind: 'mortgage', tone: 'info', emoji: '🏠', title: 'Hypotheek toevoegen aan je vermogen?', link: '/vermogen', rank: 30 });
    }
  }
  if (p.is_current && Number(db.today.slice(5, 7)) === 4 && pensionStale()) {
    out.push({ id: `pension:${db.today.slice(0, 4)}`, kind: 'pension', tone: 'info', emoji: '🧓', title: 'Pensioenoverzicht bijwerken?', link: '/vermogen', rank: 29 });
  }
  const stale = daysBetween(db.transactions.reduce((m, t) => (t.date > m ? t.date : m), db.today), db.today);
  if (stale > 10) out.push({ id: 'stale', kind: 'stale', tone: 'warn', emoji: '⏳', title: `Laatste import ${stale} dagen geleden`, link: '/import', rank: 90 });
  // Dismissed ids and muted kinds are left out before ranking (DECISIONS, Insight preferences).
  const dismissed = new Set(db.settings._dismissed_insights || []);
  const muted = new Set(db.settings.muted_insight_kinds || []);
  return out.filter((x) => !dismissed.has(x.id) && !muted.has(x.kind) && !OVERZICHT_HIDDEN.has(x.kind)).sort((a, b) => b.rank - a.rank).slice(0, 5).map(({ rank, link, ...x }) => ({ ...x, link: linkObject(link), href: link }));
}

// Backend shape: link = {screen, params}, href = hash route (see services/insights.py).
function linkObject(href) {
  const [path, qs] = href.split('?');
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  let m;
  if ((m = path.match(/^\/overzicht\/bakje\/(\d+)/))) return { screen: 'category', params: { id: Number(m[1]), ...params } };
  if ((m = path.match(/^\/potjes\/(\d+)/))) return { screen: 'goal', params: { id: Number(m[1]) } };
  const screens = { '/sorteren': 'sort', '/vaste-lasten': 'recurring', '/potjes': 'goals', '/import': 'import', '/vermogen': 'networth', '/jaaroverzicht': 'trends', '/transacties': 'transactions' };
  return { screen: screens[path] || 'goals', params };
}

function trends(n) {
  const cur = currentPeriod();
  const periods = [];
  for (let i = n - 1; i >= 0; i--) {
    const pid = shiftPeriod(cur, -i);
    if (pid < firstPeriod()) continue;
    const f = flows(pid);
    periods.push({ period: pid, label: monthLabel(pid), income_cents: f.income, fixed_cents: f.fixed, daily_cents: f.daily, saved_cents: f.saved, repaid_cents: f.repaid, net_cents: f.income - f.fixed - f.daily - f.saved, result_cents: f.income - f.fixed - f.daily, partial: pid === cur || pid === firstPeriod() });
  }
  const catIds = db.categories.filter((c) => ['fixed', 'daily'].includes(c.grp)).map((c) => c.id);
  const categories = catIds
    .map((id) => ({ category_id: id, cents: periods.map((p) => flows(p.period).cats.get(id)?.cents || 0) }))
    .filter((c) => c.cents.some((x) => x));
  // "top winkels" is always about one year (services/summary.py MERCHANT_MONTHS)
  const year = periods.slice(-12);
  const first = year[0] ? periodBounds(year[0].period).from : db.today;
  const m = new Map();
  for (const t of db.transactions) {
    if (t.date < first || !isCashflow(t) || t.amount_cents >= 0) continue;
    const c = catById(t.category_id);
    if (!c || !['fixed', 'daily'].includes(c.grp)) continue;
    const e = m.get(t.merchant_key) || { merchant_key: t.merchant_key, merchant_name: t.merchant_name, category_id: t.category_id, cents: 0, count: 0 };
    e.cents -= t.amount_cents; e.count++;
    m.set(t.merchant_key, e);
  }
  const top_merchants = [...m.values()].sort((a, b) => b.cents - a.cents).slice(0, 10);
  return { periods, categories, top_merchants, top_merchants_months: year.length };
}

/* ======================================================================================
   Sorting
   ====================================================================================== */

function sortQueue() {
  return cached('queue', () => {
    const unsorted = catByKey('unsorted').id;
    const m = new Map();
    for (const t of db.transactions) {
      if (t.category_id !== unsorted || t.kind !== 'normal') continue;
      const e = m.get(t.merchant_key) || { merchant_key: t.merchant_key, merchant_name: t.merchant_name, count: 0, total_cents: 0, last_date: t.date, method: t.method, city: t.city, sample_description: t.raw_description || t.description, is_person: t.merchant_key.startsWith('p:') || t.merchant_key.startsWith('via:'), suggestions: db.unsortedSuggestions?.[t.merchant_key] || [] };
      e.count++; e.total_cents += t.amount_cents;
      if (t.date > e.last_date) e.last_date = t.date;
      m.set(t.merchant_key, e);
    }
    return [...m.values()].sort((a, b) => Math.abs(b.total_cents) - Math.abs(a.total_cents));
  });
}

function applyCategoryToMerchant(merchant_key, category_id) {
  const r = db.rules.find((x) => x.merchant_key === merchant_key);
  if (r) r.category_id = category_id;
  else db.rules.push({ id: ++db.seq.rule, merchant_key, category_id, tag_id: null, below_cents: null, below_category_id: null, created_at: db.today });
  return applyRule(merchant_key);
}

/** Re-apply a merchant's rule (main bakje, and the amount threshold when set). Returns changed count. */
function applyRule(merchant_key, { onlyBelow = false } = {}) {
  const r = db.rules.find((x) => x.merchant_key === merchant_key);
  if (!r) return 0;
  let n = 0;
  for (const t of db.transactions) {
    if (t.merchant_key !== merchant_key || t.category_source === 'user' || t.kind === 'transfer' || t.kind === 'settlement') continue;
    const below = r.below_cents != null && r.below_category_id != null && Math.abs(t.amount_cents) < r.below_cents;
    if (onlyBelow && !below) continue;
    const cat = below ? r.below_category_id : r.category_id;
    if (cat == null) continue;
    t.category_id = cat; t.category_source = 'rule'; n++;
  }
  return n;
}

/** Why a transaction has its bakje (category_reason + Dutch label), see docs/DECISIONS.md. */
function categoryReason(t) {
  const name = t.merchant_name;
  if (t.kind === 'transfer' || t.kind === 'settlement') return ['transfer', 'Eigen rekening'];
  if (t.category_source === 'user') return ['user', 'Jouw keuze'];
  if (t.category_source === 'rule') {
    const r = db.rules.find((x) => x.merchant_key === t.merchant_key);
    if (r?.below_cents != null && r.below_category_id === t.category_id && Math.abs(t.amount_cents) < r.below_cents) {
      return ['rule:below', `${name} · onder ${euros(r.below_cents)}`];
    }
    return ['rule', `Jouw keuze voor ${name}`];
  }
  if (t.category_source === 'merchant') return [`merchant:${t.merchant_key}`, `Bekende winkel: ${name}`];
  if (t.category_source === 'mcc') return [`mcc:${t.mcc}`, 'Soort winkel'];
  if (t.category_source === 'keyword') return ['keyword', 'Woord in de omschrijving'];
  if (t.category_source === 'bank') return [`bank:${t.bank_category || ''}`, 'Categorie van de bank'];
  if (t.category_source === 'heuristic') return ['heuristic', 'Herkend patroon'];
  return [null, null];
}

/* ======================================================================================
   Goals (SPEC §9)
   ====================================================================================== */

function monthsUntil(date) {
  const a = parseISO(db.today);
  const b = parseISO(date);
  const m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  return Math.max(1, m);
}

function goalsData() {
  return cached('goals', () => {
    const cur = currentPeriod();
    const last3 = [1, 2, 3].map((i) => shiftPeriod(cur, -i));
    const all = db.goals.slice().sort((a, b) => a.sort - b.sort).map((g) => {
      const entries = db.goal_entries.filter((e) => e.goal_id === g.id).sort((a, b) => (a.date < b.date ? 1 : -1));
      const saldo = entries.reduce((s, e) => s + e.amount_cents, 0);
      const avg = Math.round(entries.filter((e) => last3.includes(periodOf(e.date)) && e.kind !== 'adjust').reduce((s, e) => s + e.amount_cents, 0) / 3);
      const months_left = g.target_date ? monthsUntil(g.target_date) : null;
      const remaining = Math.max(0, g.target_cents - saldo);
      const advice = g.target_date ? Math.ceil(remaining / months_left / 500) * 500 : 0;
      let status = 'no_date';
      if (saldo >= g.target_cents) status = 'reached';
      else if (g.target_date && g.target_date < db.today && g.repeat !== 'yearly') status = 'overdue';
      else if (g.target_date) status = avg >= advice * 0.9 ? 'on_track' : 'behind';
      const projected = avg > 0 && remaining > 0 ? shiftPeriod(cur, Math.ceil(remaining / avg)) + '-01' : null;
      return {
        id: g.id, name: g.name, emoji: g.emoji, color: g.color, target_cents: g.target_cents, target_date: g.target_date,
        repeat: g.repeat, code: g.code, keywords: g.keywords, saldo_cents: saldo,
        progress: g.target_cents > 0 ? Math.min(1, Math.max(0, saldo / g.target_cents)) : 0,
        monthly_advice_cents: status === 'overdue' ? remaining : advice, months_left: status === 'overdue' ? 0 : months_left, catch_up_cents: status === 'behind' ? advice : null,
        projected_date: projected, status, avg_contribution_cents: avg,
        entries: entries.slice(0, 20).map(({ goal_id, ...e }) => e), archived: !!g.archived, sort: g.sort,
      };
    });
    const goals = all.filter((g) => !g.archived);
    const archived_goals = all.filter((g) => g.archived);
    const assigned = new Set(db.goal_entries.map((e) => e.transaction_id).filter(Boolean));
    const unassigned = db.transactions
      .filter((t) => t.account_id === 1 && t.kind === 'transfer' && catById(t.category_id)?.key === 'sparen' && !assigned.has(t.id) && t.date >= addDays(db.today, -120))
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map((t) => ({ transaction_id: t.id, date: t.date, amount_cents: -t.amount_cents, description: t.description }));
    const total_advice_cents = goals.reduce((s, g) => s + (g.status === 'reached' ? 0 : g.monthly_advice_cents), 0);
    const prev = previousComplete(cur, 3);
    const room = prev.length
      ? (() => {
        // real money left over (services/goals.py room_for): the full mortgage payment, no spread
        // parts, minus investing that is set up to repeat
        const n = prev.length;
        const avg = (fn) => prev.reduce((s, p) => s + fn(flows(p)), 0) / n;
        const income = avg((f) => f.income);
        const fixed = avg((f) => f.fixed - f.spreadFixed + f.repaid);
        const daily = avg((f) => f.daily - f.spreadDaily);
        const repaid = avg((f) => f.repaid);
        const investing = Math.max(0, recurringItems().filter((it) => it.direction === 'out' && it.status !== 'ended' && catById(it.category_id)?.key === 'beleggen').reduce((s, it) => s - it.per_month_cents, 0));
        const avg_over_cents = Math.round(income - fixed - daily - investing);
        return { avg_over_cents, fits: avg_over_cents >= total_advice_cents, difference_cents: avg_over_cents - total_advice_cents,
          income_cents: Math.round(income), fixed_cents: Math.round(fixed), daily_cents: Math.round(daily), repaid_cents: Math.round(repaid), investing_cents: Math.round(investing), months: n };
      })()
      : null;
    const savings = db.accounts.filter((a) => a.type === 'savings');
    const savings_balance_cents = savings.length ? savings.reduce((s, a) => s + (accountBalance(a).balance_cents || 0), 0) : null;
    const inGoals = goals.reduce((s, g) => s + g.saldo_cents, 0);
    const suggestions = [];
    if (prev.length && !goals.some((g) => /buffer/i.test(g.name))) {
      // the same buffer as the buffer bar and Slimme aannames (outlook assumedBuffer)
      const [cents, reason] = assumedBuffer();
      const target = Math.ceil(cents / 10000) * 10000;
      if (target > 0) suggestions.push({ kind: 'buffer', name: 'Buffer', emoji: '🛟', target_cents: target, target_date: null, reason });
    }
    const yearly = recurringItems().filter((it) => it.frequency === 'yearly' && it.direction === 'out');
    if (yearly.length && !goals.some((g) => /jaarlijks/i.test(g.name))) {
      const sum = yearly.reduce((s, it) => s - it.amount_cents, 0);
      suggestions.push({ kind: 'yearly_bills', name: 'Jaarlijkse rekeningen', emoji: '📅', target_cents: sum, target_date: null, reason: `${euros(Math.round(sum / 12))} per maand` });
    }
    return { goals, archived_goals, unassigned, total_advice_cents, room, savings_balance_cents, unallocated_cents: savings_balance_cents == null ? null : savings_balance_cents - inGoals, suggestions };
  });
}

/* ======================================================================================
   Accounts and net worth
   ====================================================================================== */

function goalOut(id) { const d = goalsData(); return [...d.goals, ...d.archived_goals].find((x) => x.id === id) || null; }

function accountBalance(a) {
  const txs = db.transactions.filter((t) => t.account_id === a.id);
  if (a.type === 'checking' || a.type === 'savings') {
    const last = txs.filter((t) => t.balance_after_cents != null).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.seq - y.seq)).at(-1);
    if (last) return { balance_cents: last.balance_after_cents, as_of: last.date };
    return { balance_cents: a.manual_balance_cents, as_of: a.manual_balance_date };
  }
  if (a.type === 'investment' && (db.trades || []).some((t) => t.account_id === a.id)) {
    const h = holdingsOut(a.id);
    return { balance_cents: h.value_cents, as_of: h.price_date, invested_cents: h.invested_cents, result_cents: h.result_cents, result_pct: h.result_pct,
      price_result_cents: h.price_result_cents, market_value_cents: h.market_value_cents, cash_cents: h.cash_cents, dividends_cents: h.dividends_cents,
      costs_cents: h.costs_cents, price_stale: h.price_stale, has_holdings: true,
      bonds_cents: h.holdings.filter((x) => /%|\b(bond|govt|treasury|aggregate)\b/i.test(x.name || '')).reduce((t, x) => t + x.value_cents, 0),
      stocks_cents: h.holdings.filter((x) => !/%|\b(bond|govt|treasury|aggregate)\b/i.test(x.name || '')).reduce((t, x) => t + x.value_cents, 0),
      holdings_count: h.holdings.filter((x) => x.quantity > 0).length, values: [] };
  }
  if (a.type === 'investment') {
    const vals = db.account_values.filter((v) => v.account_id === a.id).sort((x, y) => (x.date < y.date ? -1 : 1));
    const invested = db.transactions.filter((t) => t.transfer_account_id === a.id && t.account_id !== a.id).reduce((s, t) => s - t.amount_cents, 0);
    const last = vals.at(-1);
    return { balance_cents: last ? last.value_cents : invested, as_of: last?.date || null, invested_cents: invested, result_cents: last ? last.value_cents - invested : 0, values: vals.map(({ account_id, ...v }) => v) };
  }
  if (a.type === 'credit') {
    const s = settlementUnexplained();
    const unexplained = [...s.map.values()].reduce((x, y) => x + y, 0);
    return { balance_cents: -Math.max(0, s.outstanding), as_of: db.today, outstanding_cents: Math.max(0, s.outstanding), unexplained_cents: unexplained };
  }
  return { balance_cents: 0, as_of: null };
}

function networth() {
  const accounts = db.accounts.filter((a) => !a.hidden).map((a) => ({ id: a.id, name: a.name, type: a.type, iban: a.iban, locked: !!a.locked, ...accountBalance(a) }));
  const total_cents = accounts.reduce((s, a) => s + (a.balance_cents || 0), 0);
  const home = homeOut();
  const counted = db.assets.filter((a) => a.include);
  const series = [];
  const first = firstPeriod();
  const cur = currentPeriod();
  for (let p = first; p <= cur; p = shiftPeriod(p, 1)) {
    const end = p === cur ? db.today : addDays(`${shiftPeriod(p, 1)}-01`, -1);
    const row = { month: p, checking_cents: 0, savings_cents: 0, investment_cents: 0, credit_cents: 0, total_cents: 0 };
    for (const a of db.accounts) {
      if (a.hidden) continue; // like the backend: hidden accounts are not in the series either
      let v = 0;
      if (a.type === 'credit') {
        // the current month uses the same value as the account list (backend: acc_day 9999-12-31);
        // earlier months: the mock keeps no card timeline, so 0
        v = p === cur ? accountBalance(a).balance_cents || 0 : 0;
      } else if (a.type === 'checking' || a.type === 'savings') {
        const last = db.transactions.filter((t) => t.account_id === a.id && t.date <= end && t.balance_after_cents != null).at(-1);
        v = last ? last.balance_after_cents : 0;
      } else if (a.type === 'investment' && (db.trades || []).some((t) => t.account_id === a.id)) {
        v = holdingsValueAt(a.id, end);
      } else if (a.type === 'investment') {
        const vals = db.account_values.filter((x) => x.account_id === a.id && x.date <= end);
        const invested = db.transactions.filter((t) => t.transfer_account_id === a.id && t.date <= end).reduce((s, t) => s - t.amount_cents, 0);
        v = vals.length ? Math.max(vals.at(-1).value_cents, invested) : invested;
      }
      row[`${a.type}_cents`] += v;
    }
    row.total_cents = row.checking_cents + row.savings_cents + row.investment_cents + row.credit_cents;
    if (home?.included) { row.home_cents = homeEquityAt(end); row.total_cents += row.home_cents; }
    if (counted.length) { row.assets_cents = counted.reduce((s, a) => s + assetSigned(a, end), 0); row.total_cents += row.assets_cents; }
    series.push(row);
  }
  const assets = assetsNetworth();
  const excluded = assets.filter((a) => a.kind === 'pension' && !a.include && a.value_cents != null);
  return { total_cents: total_cents + (home?.included ? home.equity_cents : 0) + assets.filter((a) => a.include).reduce((s, a) => s + a.signed_cents, 0),
    accounts, series, home, assets, pension_excluded_cents: excluded.length ? excluded.reduce((s, a) => s + (a.value_cents || 0), 0) : null };
}

/* ======================================================================================
   Mortgage (SPEC §7.2; services/mortgage.py)
   ====================================================================================== */

function mortgageLatestYear() { return db.mortgage_years.reduce((m, e) => Math.max(m, e.year), 0) || null; }
function mortgageShare() {
  const y = mortgageLatestYear();
  if (!y) return null;
  const es = db.mortgage_years.filter((e) => e.year === y);
  const rep = es.reduce((s, e) => s + e.repaid_cents, 0);
  const tot = rep + es.reduce((s, e) => s + e.interest_cents, 0);
  return tot > 0 ? rep / tot : 0;
}
function mortgageCandidates() {
  const m = new Map();
  for (const t of db.transactions) {
    const c = catById(t.category_id);
    if (c?.key !== 'wonen' || t.amount_cents >= 0 || accById(t.account_id)?.type !== 'checking' || !t.merchant_key) continue;
    const e = m.get(t.merchant_key) || { merchant_key: t.merchant_key, merchant_name: t.merchant_name, amount_cents: t.amount_cents, count: 0, last_date: t.date, description: t.description || '' };
    e.count += 1;
    if (t.date >= e.last_date) { e.last_date = t.date; e.amount_cents = t.amount_cents; }
    m.set(t.merchant_key, e);
  }
  return [...m.values()].map((e) => ({ ...e, likely: `${e.merchant_key} ${e.merchant_name} ${e.description}`.toLowerCase().includes('hypothe') }))
    .sort((a, b) => (b.likely - a.likely) || (b.count - a.count) || (a.amount_cents - b.amount_cents));
}
function mortgageLinked() {
  const chosen = db.settings.mortgage_merchant_key;
  if (chosen !== undefined && chosen !== null) return { key: chosen || null, auto: false };
  const c = mortgageCandidates();
  const found = c.find((x) => x.likely) || c.find((x) => x.count >= 3);
  return { key: found?.merchant_key || null, auto: true };
}
function mortgageSplit() {
  if (!db.mortgage_parts.length) return null;
  const share = mortgageShare();
  const { key } = mortgageLinked();
  return key && share ? { key, share } : null;
}
/* Pension, debt, other possessions (SPEC §7.3; services/assets.py) */
const ASSET_INCLUDE = { pension: false, debt: true, other: true, possession: true };
function assetEntries(id) { return db.asset_entries.filter((e) => e.asset_id === id).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id)); }
function assetRatio(es) {
  for (const e of [...es].reverse()) { const r = e.repaid_cents || 0; const i = e.interest_cents || 0; if (r + i > 0) return r / (r + i); }
  return null;
}
function allSplits() {
  return cached('splits', () => {
    const m = new Map();
    for (const a of db.assets) if (a.kind === 'debt' && a.merchant_key) { const sh = assetRatio(assetEntries(a.id)); if (sh && !m.has(a.merchant_key)) m.set(a.merchant_key, sh); }
    const sp = mortgageSplit();
    if (sp) m.set(sp.key, sp.share);
    return m;
  });
}
function assetCandidates() {
  return cached('asset:cands', () => {
    const m = new Map();
    for (const t of db.transactions) {
      if (catById(t.category_id)?.grp !== 'fixed' || t.amount_cents >= 0 || accById(t.account_id)?.type !== 'checking' || !t.merchant_key) continue;
      const e = m.get(t.merchant_key) || { merchant_key: t.merchant_key, merchant_name: t.merchant_name, amount_cents: t.amount_cents, count: 0, last: t.date };
      e.count += 1;
      if (t.date >= e.last) { e.last = t.date; e.amount_cents = t.amount_cents; }
      m.set(t.merchant_key, e);
    }
    return [...m.values()].map(({ last, ...e }) => ({ ...e, likely: /\bduo\b/.test(`${e.merchant_key} ${e.merchant_name}`.toLowerCase()) }))
      .sort((a, b) => (b.likely - a.likely) || (b.count - a.count));
  });
}
function assetEvents(a, share) {
  if (!a.merchant_key || !share) return [];
  return db.transactions.filter((t) => t.merchant_key === a.merchant_key && t.amount_cents < 0 && accById(t.account_id)?.type === 'checking' && catById(t.category_id)?.grp === 'fixed')
    .map((t) => [t.date, Math.round(-t.amount_cents * allSplits().get(a.merchant_key))]);
}
function assetValue(a, day) {
  if (a.kind === 'possession') return possessionValue(a, day);
  const es = assetEntries(a.id);
  if (!es.length) return null;
  const known = es.filter((e) => e.date <= day);
  if (a.kind !== 'debt') return known.length ? known.at(-1).value_cents : null;
  const ev = assetEvents(a, assetRatio(es));
  const between = (x, y) => ev.reduce((s, [d, v]) => s + (d > x && d <= y ? v : 0), 0);
  return Math.max(0, known.length ? known.at(-1).value_cents - between(known.at(-1).date, day) : es[0].value_cents + between(day, es[0].date));
}
const assetSigned = (a, day) => (a.kind === 'debt' ? -1 : 1) * (assetValue(a, day) || 0);
function assetsNetworth() {
  return db.assets.map((a) => {
    const es = assetEntries(a.id);
    const base = { id: a.id, kind: a.kind, name: a.name, debt_kind: a.debt_kind, include: a.include, value_cents: assetValue(a, db.today), signed_cents: assetSigned(a, db.today), as_of: es.at(-1)?.date || null, emoji: a.emoji || null };
    if (a.kind !== 'possession') return base;
    const plan = possessionPlan(a);
    return { ...base, as_of: db.today, monthly_cents: spreadAmounts(plan.total, plan.months, plan.keep)[0], sold: !!plan.sale_date, sale_date: plan.sale_date };
  });
}
function assetsOut() {
  const cands = assetCandidates();
  return {
    items: db.assets.map((a) => {
      if (a.kind === 'possession') return possessionOut(a);
      const es = assetEntries(a.id);
      const share = a.kind === 'debt' ? assetRatio(es) : null;
      const last = es.at(-1);
      const since = last ? assetEvents(a, share).reduce((s, [d, v]) => s + (d > last.date && d <= db.today ? v : 0), 0) : 0;
      return { ...assetsNetworth().find((x) => x.id === a.id), estimated: since > 0, repaid_since_cents: since,
        repaid_share: share == null ? null : Math.round(share * 10000) / 10000,
        payment: a.merchant_key ? { merchant_key: a.merchant_key, merchant_name: cands.find((c) => c.merchant_key === a.merchant_key)?.merchant_name || a.merchant_key } : null,
        entries: [...es].reverse().map(({ asset_id, ...e }) => e) };
    }),
    candidates: cands.slice(0, 12),
    purchase_candidates: purchaseCandidates(),
  };
}
const txBrief = (id) => { const t = id && db.transactions.find((x) => x.id === id); return t ? { id: t.id, date: t.date, amount_cents: t.amount_cents, merchant_name: t.merchant_name, category_id: t.category_id } : null; };
function possessionOut(a) {
  const plan = possessionPlan(a);
  const first = periodOf(plan.start);
  const value = possessionValue(a, db.today);
  const sale = plan.sale_date ? spreadSchedule(plan, first).find((s) => s.role === 'sale') : null;
  const taken = new Set(db.assets.map((x) => x.sale_tx_id).filter(Boolean));
  return { id: a.id, kind: 'possession', name: a.name, emoji: a.emoji, include: a.include, value_cents: value, signed_cents: value || 0,
    as_of: db.today, estimated: false, repaid_since_cents: 0, repaid_share: null, payment: null, debt_kind: null, entries: [],
    price_cents: plan.total, start_date: plan.start, life_months: plan.months, residual_cents: plan.keep, category_id: a.category_id,
    monthly_cents: spreadAmounts(plan.total, plan.months, plan.keep)[0], lost_cents: value != null && !plan.sale_date ? plan.total - value : null,
    end_period: shiftPeriod(first, plan.months - 1), purchase: txBrief(a.tx_id),
    sale: plan.sale_date ? { date: plan.sale_date, cents: plan.sale_cents, tx: txBrief(a.sale_tx_id), result_cents: sale?.cents ?? null } : null,
    sale_candidates: plan.sale_date ? undefined : db.transactions.filter((t) => t.amount_cents >= 10000 && t.kind === 'normal' && t.date >= plan.start && !taken.has(t.id)
        && db.transactions.filter((x) => x.merchant_key === t.merchant_key && x.amount_cents > 0).length < 3)
      .sort((x, y) => (x.date < y.date ? 1 : -1)).slice(0, 15).map((t) => ({ id: t.id, date: t.date, amount_cents: t.amount_cents, merchant_name: t.merchant_name })) };
}
function purchaseCandidates() {
  const since = shiftPeriod(db.today.slice(0, 7), -36) + '-01';
  const taken = new Set(db.assets.map((x) => x.tx_id).filter(Boolean));
  const big = db.transactions.filter((t) => t.amount_cents <= -50000 && t.kind === 'normal' && t.date >= since && ['fixed', 'daily'].includes(catById(t.category_id)?.grp || 'daily'))
    .sort((x, y) => x.amount_cents - y.amount_cents);
  const count = new Map();
  big.forEach((t) => count.set(t.merchant_key, (count.get(t.merchant_key) || 0) + 1));
  const seen = new Set();
  return big.filter((t) => {
    if (taken.has(t.id) || seen.has(t.merchant_key) || count.get(t.merchant_key) >= 3) return false;
    seen.add(t.merchant_key); return true;
  }).slice(0, 15).map((t) => ({ id: t.id, date: t.date, amount_cents: t.amount_cents, merchant_name: t.merchant_name, category_id: t.category_id }));
}
function checkAssetMerchant(key, id) {
  if (!db.transactions.some((t) => t.merchant_key === key)) fail(422, 'unknown_merchant', 'Deze betaling ken ik niet.');
  if (db.assets.some((a) => a.merchant_key === key && a.id !== id) || (db.mortgage_parts.length && mortgageLinked().key === key)) fail(409, 'merchant_linked', 'Deze betaling hoort al bij een andere lening.');
}
function pensionStale() {
  const d = new Date(db.today + 'T12:00:00'); d.setMonth(d.getMonth() - 11);
  const cutoff = d.toISOString().slice(0, 10);
  return db.assets.some((a) => a.kind === 'pension' && !(assetEntries(a.id).at(-1)?.date >= cutoff));
}

function repaidEvents() {
  return cached('mortgage:events', () => {
    const sp = mortgageSplit();
    if (!sp) return [];
    return db.transactions.filter((t) => t.merchant_key === sp.key && t.amount_cents < 0 && accById(t.account_id)?.type === 'checking' && catById(t.category_id)?.grp === 'fixed')
      .map((t) => [t.date, Math.round(-t.amount_cents * sp.share)]);
  });
}
function partDebt(partId, day) {
  const years = db.mortgage_years.filter((e) => e.part_id === partId).map((e) => e.year).sort((a, b) => a - b);
  if (!years.length) return null;
  const y = mortgageLatestYear();
  const latest = db.mortgage_years.filter((e) => e.year === y);
  const totRep = latest.reduce((s, e) => s + e.repaid_cents, 0);
  const w = totRep > 0 ? (latest.find((e) => e.part_id === partId)?.repaid_cents || 0) / totRep : 0;
  const entry = (yr) => db.mortgage_years.find((e) => e.year === yr && e.part_id === partId);
  const between = (a, b) => repaidEvents().reduce((s, [d, v]) => s + (d > a && d <= b ? v : 0), 0);
  const before = years.filter((yr) => `${yr}-12-31` <= day);
  const debt = before.length
    ? entry(before.at(-1)).debt_end_cents - w * between(`${before.at(-1)}-12-31`, day)
    : entry(years[0]).debt_end_cents + w * between(day, `${years[0]}-12-31`);
  return Math.max(0, Math.round(debt));
}
function debtAt(day) {
  const ds = db.mortgage_parts.map((p) => partDebt(p.id, day)).filter((d) => d != null);
  return ds.length ? ds.reduce((s, d) => s + d, 0) : null;
}
function homeAt(day) {
  const hv = [...db.home_values].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!hv.length) return null;
  return (hv.filter((h) => h.date <= day).at(-1) || hv[0]).value_cents;
}
function homeEquityAt(day) { const h = homeAt(day); return h == null ? 0 : h - (debtAt(day) || 0); }
function homeOut() {
  if (!db.mortgage_parts.length && !db.home_values.length) return null;
  const home = homeAt(db.today);
  const debt = debtAt(db.today);
  let original = 0;
  for (const p of db.mortgage_parts) {
    const first = db.mortgage_years.filter((e) => e.part_id === p.id).sort((a, b) => a.year - b.year)[0];
    if (first) original += first.principal_cents != null ? first.principal_cents : first.debt_end_cents + (first.repaid_cents || 0);
  }
  original = original || null;
  return { home_cents: home, debt_cents: debt, equity_cents: home == null ? null : home - (debt || 0),
    original_cents: original, repaid_pct: original && debt != null ? Math.max(0, original - debt) / original : null,
    included: db.settings.mortgage_include_home !== false && home != null };
}
function partOriginal(id) {
  const first = db.mortgage_years.filter((e) => e.part_id === id).sort((a, b) => a.year - b.year)[0];
  return first ? (first.principal_cents != null ? first.principal_cents : first.debt_end_cents + (first.repaid_cents || 0)) : null;
}
function mortgageOut() {
  const year = Number(db.today.slice(0, 4));
  const years = [...new Set(db.mortgage_years.map((e) => e.year))].sort((a, b) => b - a);
  const { key, auto } = mortgageLinked();
  const cands = mortgageCandidates();
  const linked = cands.find((c) => c.merchant_key === key);
  const home = homeAt(db.today);
  const debt = debtAt(db.today);
  const share = mortgageShare();
  return {
    exists: db.mortgage_parts.length > 0,
    parts: db.mortgage_parts.map((p) => ({ id: p.id, name: p.name, debt_cents: partDebt(p.id, db.today), original_cents: partOriginal(p.id),
      years: db.mortgage_years.filter((e) => e.part_id === p.id).sort((a, b) => b.year - a.year).map(({ part_id, ...e }) => e) })),
    years, latest_year: mortgageLatestYear(), form_year: year - 1,
    missing_year: db.mortgage_parts.length && !years.includes(year - 1) ? year - 1 : null,
    repaid_share: share == null ? null : Math.round(share * 10000) / 10000, debt_cents: debt,
    repaid_this_year_cents: repaidEvents().reduce((s, [d, v]) => s + (d >= `${year}-01-01` ? v : 0), 0),
    home_cents: home, home_values: [...db.home_values].sort((a, b) => (a.date < b.date ? -1 : 1)),
    equity_cents: home == null ? null : home - (debt || 0),
    original_cents: homeOut()?.original_cents ?? null, repaid_pct: homeOut()?.repaid_pct ?? null,
    include_in_networth: db.settings.mortgage_include_home !== false,
    payment: key ? { merchant_key: key, merchant_name: linked?.merchant_name || key, amount_cents: linked?.amount_cents ?? null, auto } : null,
    candidates: cands.slice(0, 8).map(({ description, ...c }) => c),
  };
}

/* ======================================================================================
   Payment calendar, recap (SPEC §14; DECISIONS "Calendar, yearly cost, recap")
   ====================================================================================== */

const CAL_TOL = { weekly: 3, '2-weekly': 6, '4-weekly': 10, monthly: 12, quarterly: 20, 'half-year': 25, yearly: 30 };
const STEP_DAYS = { weekly: 7, '2-weekly': 14, '4-weekly': 28 };
const STEP_MONTHS = { quarterly: 3, 'half-year': 6, yearly: 12 };

function addMonthsISO(iso, n, day = null) {
  const ym = shiftPeriod(iso.slice(0, 7), n);
  const dim = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5), 0)).getUTCDate();
  return `${ym}-${String(Math.min(day ?? Number(iso.slice(8)), dim)).padStart(2, '0')}`;
}

/** Expected dates of an item between lo and hi (inclusive). */
function itemSlots(it, txs, lo, hi) {
  const last = txs.at(-1).date;
  const out = [];
  if (it.frequency === 'monthly') {
    const day = Math.round(median(txs.slice(-6).map((t) => Number(t.date.slice(8)))));
    for (let m = shiftPeriod(lo.slice(0, 7), -1); m <= shiftPeriod(hi.slice(0, 7), 1); m = shiftPeriod(m, 1)) {
      const d = addMonthsISO(`${m}-01`, 0, day);
      if (d >= lo && d <= hi) out.push(d);
    }
    return out;
  }
  if (STEP_DAYS[it.frequency]) {
    const step = STEP_DAYS[it.frequency];
    let d = last;
    while (d > lo) d = addDays(d, -step);
    for (; d <= hi; d = addDays(d, step)) if (d >= lo) out.push(d);
    return out;
  }
  const sm = STEP_MONTHS[it.frequency] || 12;
  for (let k = -30; k <= 30; k++) {
    const d = addMonthsISO(last, k * sm);
    if (d >= lo && d <= hi) out.push(d);
  }
  return out;
}

function calendar(pid) {
  if (!/^\d{4}-\d{2}$/.test(pid)) fail(400, 'bad_period', 'Onbekende maand.');
  const cur = currentPeriod();
  if (pid > shiftPeriod(cur, 12)) fail(400, 'bad_period', 'Zo ver vooruit kijkt de kalender niet.');
  const period = periodObj(pid);
  const { from, to } = periodBounds(pid);
  const today = dataToday();
  const days = new Map();
  const out = { paid_cents: 0, expected_cents: 0, missed_cents: 0 };
  const inn = { paid_cents: 0, expected_cents: 0 };
  const emit = (date, it, status, amount, txId) => {
    if (!days.has(date)) days.set(date, []);
    days.get(date).push({ key: it.key, name: it.name, merchant_key: it.merchant_key, category_id: it.category_id, direction: it.direction, amount_cents: amount, status, transaction_id: txId });
    const a = Math.abs(amount);
    if (it.direction === 'out') out[status + '_cents'] += a;
    else if (status !== 'missed') inn[status + '_cents'] += a;
  };
  for (const it of recurringItems()) {
    const grp = catById(it.category_id)?.grp;
    if (!['fixed', 'income', 'saving'].includes(grp)) continue;
    const txs = recTx.get(it.key) || [];
    if (!txs.length) continue;
    if (it.status === 'ended' && from > txs.at(-1).date) continue;
    const tol = CAL_TOL[it.frequency] || 12;
    const lo = addDays(from, -tol);
    const hi = addDays(to, tol);
    let slots = itemSlots(it, txs, lo, hi).filter((d) => d >= addDays(txs[0].date, -tol));
    if (it.status === 'ended') slots = slots.filter((d) => d <= addDays(txs.at(-1).date, tol));
    const used = new Set();
    const pays = txs.filter((t) => t.date >= lo && t.date <= hi);
    for (const t of pays) {
      let best = -1;
      let bestGap = Infinity;
      slots.forEach((d, i) => {
        if (used.has(i)) return;
        const g = Math.abs(daysBetween(d, t.date));
        if (g <= tol && g < bestGap) { best = i; bestGap = g; }
      });
      if (best >= 0) used.add(best);
      if (t.date < from || t.date > to) continue;
      if (best < 0 && pays.some((o) => o !== t && Math.abs(daysBetween(o.date, t.date)) <= 3 && o.date < t.date)) continue;
      emit(t.date, it, 'paid', t.amount_cents, t.id);
    }
    slots.forEach((d, i) => {
      if (used.has(i) || d < from || d > to) return;
      const status = d < addDays(today, -5) ? 'missed' : 'expected';
      emit(d, it, status, it.amount_cents, null);
    });
  }
  return {
    period,
    days: [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, items]) => ({ date, items })),
    out, in: inn,
  };
}

function recapRange({ period, year }) {
  const cur = currentPeriod();
  const first = firstPeriod();
  if (period) {
    if (!/^\d{4}-\d{2}$/.test(period) || period > cur) fail(400, 'bad_period', 'Deze maand is er nog niet.');
    if (period < first) fail(404, 'not_found', 'Geen gegevens voor deze maand.');
    const { from, to } = periodBounds(period);
    return { kind: 'period', id: period, label: monthLabel(period), short: monthLabel(period, { year: false }), from, to, periods: [period], complete: period < cur };
  }
  const y = String(year);
  if (!/^\d{4}$/.test(y) || y > cur.slice(0, 4)) fail(400, 'bad_year', 'Dit jaar is er nog niet.');
  const periods = [];
  for (let m = 1; m <= 12; m++) {
    const pid = `${y}-${String(m).padStart(2, '0')}`;
    if (pid >= first && pid <= cur) periods.push(pid);
  }
  if (!periods.length) fail(404, 'not_found', 'Geen gegevens voor dit jaar.');
  return {
    kind: 'year', id: y, label: y, short: y, from: periodBounds(`${y}-01`).from, to: periodBounds(`${y}-12`).to, periods,
    complete: `${y}-12` < cur && `${y}-01` >= first,
  };
}

function rangeTotals(periods) {
  const t = { income_cents: 0, fixed_cents: 0, daily_cents: 0, saved_cents: 0, repaid_cents: 0, result_cents: 0, net_cents: 0 };
  const cats = new Map();
  for (const p of periods) {
    const f = flows(p);
    t.income_cents += f.income; t.fixed_cents += f.fixed; t.daily_cents += f.daily; t.saved_cents += f.saved; t.repaid_cents += f.repaid;
    for (const [id, e] of f.cats) cats.set(id, (cats.get(id) || 0) + e.cents);
  }
  // over / tekort is the one result (SPEC 9): saving is not spending
  t.result_cents = t.income_cents - t.fixed_cents - t.daily_cents;
  t.net_cents = t.result_cents - t.saved_cents;
  return { t, cats };
}

const pctNl = (x) => `${Math.round(x * 100)} %`;

function recap(q) {
  const r = recapRange(q);
  const { t: totals, cats } = rangeTotals(r.periods);
  let prev = null;
  try {
    const pr = r.kind === 'period' ? recapRange({ period: shiftPeriod(r.id, -1) }) : recapRange({ year: Number(r.id) - 1 });
    if (pr.complete) prev = { range: pr, ...rangeTotals(pr.periods) };
  } catch { prev = null; }
  const spent = [...cats.values()].reduce((s, x) => s + Math.max(0, x), 0) || 1;
  const categories = [...cats.entries()].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1])
    .map(([category_id, cents]) => ({ category_id, cents, previous_cents: prev ? (prev.cats.get(category_id) || 0) : null, share: Math.round((cents / spent) * 10000) / 10000 }));
  const unsorted = catByKey('unsorted')?.id;
  let movers = { up: [], down: [] };
  if (prev) {
    const ids = new Set([...cats.keys(), ...prev.cats.keys()]);
    const diffs = [...ids].filter((id) => id !== unsorted).map((id) => ({ category_id: id, cents: Math.max(0, cats.get(id) || 0), previous_cents: Math.max(0, prev.cats.get(id) || 0) }))
      .map((m) => ({ ...m, d: m.cents - m.previous_cents })).filter((m) => Math.abs(m.d) >= 1000);
    const strip = ({ d, ...m }) => m;
    movers = { up: diffs.filter((m) => m.d > 0).sort((a, b) => b.d - a.d).slice(0, 3).map(strip), down: diffs.filter((m) => m.d < 0).sort((a, b) => a.d - b.d).slice(0, 3).map(strip) };
  }
  const items = recurringItems();
  const recKeys = new Set(items.map((i) => i.merchant_key));
  const inRange = db.transactions.filter((tx) => tx.date >= r.from && tx.date <= r.to && isCashflow(tx));
  const spendTx = inRange.filter((tx) => tx.amount_cents < 0 && ['fixed', 'daily'].includes(catById(tx.category_id)?.grp));
  const mer = new Map();
  for (const tx of spendTx) {
    const e = mer.get(tx.merchant_key) || { merchant_key: tx.merchant_key, merchant_name: tx.merchant_name, category_id: tx.category_id, cents: 0, count: 0 };
    e.cents -= tx.amount_cents; e.count++;
    mer.set(tx.merchant_key, e);
  }
  const merchants = [...mer.values()].sort((a, b) => b.cents - a.cents).slice(0, 10);
  const largest = spendTx.filter((tx) => !recKeys.has(tx.merchant_key)).sort((a, b) => a.amount_cents - b.amount_cents).slice(0, 5).map(serializeTx);
  const counted = inRange.filter((tx) => catById(tx.category_id)?.grp !== 'internal');
  const firstDay = db.transactions.reduce((m, tx) => (tx.date < m ? tx.date : m), '9999');
  const start = r.from > firstDay ? r.from : firstDay;
  const end = r.to < dataToday() ? r.to : dataToday();
  const spendDays = new Set();
  for (const p of r.periods) for (const [d, c] of flows(p).dailyByDay) if (c > 0) spendDays.add(d);
  let dws = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) if (!spendDays.has(d)) dws++;
  const fixedItems = items.filter((i) => i.direction === 'out' && catById(i.category_id)?.grp === 'fixed');
  const recurring = {
    per_month_cents: fixedItems.filter((i) => (recTx.get(i.key) || []).some((tx) => tx.date >= r.from && tx.date <= r.to)).reduce((s, i) => s + Math.abs(i.per_month_cents), 0),
    new: fixedItems.filter((i) => { const f = (recTx.get(i.key) || [])[0]?.date; return f && f >= r.from && f <= r.to && daysBetween(firstDay, f) >= 75; }),
    ended: items.filter((i) => i.status === 'ended' && i.last_date >= r.from && i.last_date <= r.to),
    changed: items.filter((i) => i.change && i.change.date >= r.from && i.change.date <= r.to),
  };
  const goals = db.goals.map((g) => {
    const es = db.goal_entries.filter((e) => e.goal_id === g.id && e.date <= r.to);
    if (!es.length) return null;
    const saldo = es.reduce((s, e) => s + e.amount_cents, 0);
    const added = es.filter((e) => e.date >= r.from && e.kind !== 'adjust').reduce((s, e) => s + e.amount_cents, 0);
    return { id: g.id, name: g.name, emoji: g.emoji, added_cents: added, saldo_cents: saldo, target_cents: g.target_cents, reached: saldo >= g.target_cents };
  }).filter(Boolean);
  const savings = { saved_cents: totals.saved_cents, rate: totals.income_cents > 0 ? Math.round((totals.saved_cents / totals.income_cents) * 10000) / 10000 : 0, goals };
  const series = networth().series;
  const startRow = series.find((x) => x.month === shiftPeriod(r.from.slice(0, 7), -1));
  const endRow = series.find((x) => x.month === r.to.slice(0, 7)) || series.at(-1);
  const nw = startRow && endRow ? { start_cents: startRow.total_cents, end_cents: endRow.total_cents } : null;
  const months = r.kind === 'year' ? r.periods.map((p) => { const f = flows(p); return { period: p, label: monthLabel(p), income_cents: f.income, fixed_cents: f.fixed, daily_cents: f.daily, saved_cents: f.saved, repaid_cents: f.repaid, result_cents: f.income - f.fixed - f.daily, net_cents: f.income - f.fixed - f.daily - f.saved }; }) : null;

  const vs = r.kind === 'period' ? 'vorige maand' : 'vorig jaar';
  const hl = [];
  if (counted.length) {
    hl.push(totals.result_cents >= 0 ? { emoji: '🎉', title: `${euros(totals.result_cents)} over in ${r.short}`, detail: null } : { emoji: '🧾', title: `${euros(-totals.result_cents)} meer uitgegeven dan er binnenkwam`, detail: null });
    const top = categories[0] && catById(categories[0].category_id);
    if (top) hl.push({ emoji: top.emoji, title: `${top.name} was het grootste bakje: ${euros(categories[0].cents)} (${pctNl(categories[0].share)})`, detail: null });
    const up = movers.up[0] && catById(movers.up[0].category_id);
    if (up) hl.push({ emoji: '📈', title: `${up.name}: ${euros(movers.up[0].cents - movers.up[0].previous_cents)} meer dan ${vs}`, detail: null });
    if (totals.saved_cents > 0 && totals.income_cents > 0) hl.push({ emoji: '🐷', title: `${pctNl(savings.rate)} van je inkomen gespaard (${euros(totals.saved_cents)})`, detail: null });
    const reached = goals.find((g) => g.reached && g.added_cents > 0);
    if (reached) hl.push({ emoji: '🎯', title: `${reached.name} is gehaald`, detail: null });
    const down = movers.down[0] && catById(movers.down[0].category_id);
    if (down) hl.push({ emoji: '📉', title: `${down.name}: ${euros(movers.down[0].previous_cents - movers.down[0].cents)} minder dan ${vs}`, detail: null });
    const visits = [...mer.values()].filter((m) => !m.merchant_key.startsWith('p:')).sort((a, b) => b.count - a.count)[0];
    if (visits && visits.count >= 3) hl.push({ emoji: '🛒', title: `Het vaakst bij ${visits.merchant_name}: ${visits.count} keer`, detail: null });
    if (hl.length < 3) hl.push({ emoji: '🧾', title: `${counted.length} betalingen bij ${new Set(counted.map((x) => x.merchant_key)).size} winkels`, detail: null });
  }
  return {
    kind: r.kind, label: r.label, from: r.from, to: r.to, complete: r.complete, totals,
    previous: prev ? { label: prev.range.label, ...prev.t } : null,
    categories, movers, merchants, largest,
    counts: { payments: counted.length, merchants: new Set(counted.map((x) => x.merchant_key)).size, days_without_spending: dws },
    recurring, savings, networth: nw, months, highlights: hl.slice(0, 6),
  };
}

function recapIndex() {
  const cur = currentPeriod();
  const first = firstPeriod();
  if (!db.transactions.length) return { periods: [], years: [] };
  const periods = [];
  for (let p = shiftPeriod(cur, -1); p >= first; p = shiftPeriod(p, -1)) periods.push({ id: p, label: monthLabel(p) });
  const years = [];
  for (let y = Number(cur.slice(0, 4)); y >= Number(first.slice(0, 4)); y--) years.push(y);
  return { periods, years };
}

/* ======================================================================================
   Transactions
   ====================================================================================== */

function filterTransactions(q) {
  let list = db.transactions;
  let from = q.from;
  let to = q.to;
  if (q.period) ({ from, to } = periodBounds(q.period));
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const text = (q.q || '').trim().toLowerCase();
  let amountQ = null;
  if (/^[\d.,]+$/.test(text)) amountQ = Math.round(Number(text.replace(/\./g, '').replace(',', '.')) * 100);
  const tagNames = new Map(db.tags.map((t) => [t.id, t.name.toLowerCase()]));
  list = list.filter((t) => {
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
    if (num(q.account_id) != null && t.account_id !== num(q.account_id)) return false;
    if (num(q.category_id) != null && t.category_id !== num(q.category_id)) return false;
    if (num(q.tag_id) != null && !tagIdsOf(t.id).includes(num(q.tag_id))) return false;
    if (q.merchant_key && t.merchant_key !== q.merchant_key) return false;
    if (q.method && t.method !== q.method) return false;
    if (q.kind && t.kind !== q.kind) return false;
    if (q.unsorted && q.unsorted !== '0' && catById(t.category_id)?.key !== 'unsorted') return false;
    // Like the backend: min/max compare absolute amounts.
    if (num(q.min_cents) != null && Math.abs(t.amount_cents) < num(q.min_cents)) return false;
    if (num(q.max_cents) != null && Math.abs(t.amount_cents) > num(q.max_cents)) return false;
    if (text) {
      if (amountQ != null && Math.abs(t.amount_cents) === amountQ) return true;
      const hay = `${t.merchant_name} ${t.description} ${t.note || ''} ${tagIdsOf(t.id).map((id) => tagNames.get(id)).join(' ')}`.toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });
  return [...list].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
}

function txDetail(t) {
  const same = db.transactions.filter((x) => x.merchant_key === t.merchant_key);
  const yearAgo = addDays(db.today, -365);
  const rec = recurringItems().find((it) => it.merchant_key === t.merchant_key) || null;
  const mccLabels = { 5411: 'Supermarkt', 5541: 'Tankstation', 5812: 'Restaurant', 5814: 'Fastfood', 5912: 'Drogisterij', 5200: 'Bouwmarkt', 5331: 'Warenhuis', 5311: 'Warenhuis', 5945: 'Speelgoed', 5995: 'Dierenwinkel', 4111: 'Openbaar vervoer', 7523: 'Parkeren', 7832: 'Bioscoop', 5651: 'Kleding', 5712: 'Meubels', 5462: 'Bakkerij', 5999: 'Winkel' };
  return {
    ...serializeTx(t),
    raw_description: t.raw_description, counterparty_name: t.counterparty_name, pay_type: t.pay_type,
    bank_code: t.bank_code, mcc: t.mcc, mcc_label: t.mcc ? mccLabels[t.mcc] || null : null, wallet: t.wallet,
    bank_category: t.bank_category, mandate_id: t.mandate_id,
    category_reason: categoryReason(t)[0], category_reason_label: categoryReason(t)[1],
    spread: spreadInfo(t),
    merchant: {
      count: same.length,
      total_12m_cents: same.filter((x) => x.date >= yearAgo).reduce((s, x) => s + x.amount_cents, 0),
      typical_cents: Math.round(median(same.map((x) => x.amount_cents))),
      recurring: rec,
    },
  };
}

function setTags(txId, ids) {
  db.tx_tags = db.tx_tags.filter(([t]) => t !== txId).concat(ids.map((g) => [txId, g]));
}

function syncGoalEntry(t, goal_id) {
  db.goal_entries = db.goal_entries.filter((e) => e.transaction_id !== t.id);
  t.goal_id = goal_id || null;
  if (goal_id) db.goal_entries.push({ id: ++db.seq.entry, goal_id, date: t.date, amount_cents: -t.amount_cents, kind: 'auto', note: null, transaction_id: t.id });
}

const merchantKeyOf = (name) => name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/* ======================================================================================
   Router
   ====================================================================================== */

function handle({ method, path, query = {}, body = {}, form, download }) {
  const open = ['/session', '/setup', '/login', '/healthz'];
  if (!open.includes(path) && !auth.authenticated) fail(401, 'unauthorized', 'Log opnieuw in.');
  if (method !== 'GET') touch();
  for (const [m, re, fn] of ROUTES) {
    if (m !== method) continue;
    const match = path.match(re);
    if (match) {
      const res = fn({ params: match.slice(1).map((x) => (/^\d+$/.test(x) ? Number(x) : x)), query, body: body || {}, form, download });
      if (method !== 'GET') touch();
      return res;
    }
  }
  fail(404, 'not_found', 'Niet gevonden.');
}

const need = (x, msg = 'Niet gevonden.') => { if (!x) fail(404, 'not_found', msg); return x; };

const ROUTES = [
  /* Auth */
  ['GET', /^\/session$/, () => ok({ setup_required: auth.setup_required, authenticated: auth.authenticated, version: VERSION })],
  ['POST', /^\/setup$/, ({ body }) => {
    if (!auth.setup_required) fail(409, 'already_setup', 'Er is al een wachtwoord.');
    if (!body.password || body.password.length < 8) fail(400, 'too_short', 'Kies minimaal 8 tekens.');
    auth = { setup_required: false, authenticated: true };
    return ok({ ok: true });
  }],
  ['POST', /^\/login$/, ({ body }) => {
    if (body.password !== PASSWORD) fail(401, 'wrong_password', 'Dat wachtwoord klopt niet.');
    auth.authenticated = true;
    return ok({ ok: true });
  }],
  ['POST', /^\/logout$/, () => { auth.authenticated = false; return ok({ ok: true }); }],
  ['POST', /^\/password$/, ({ body }) => {
    if (body.current !== PASSWORD) fail(401, 'wrong_password', 'Je huidige wachtwoord klopt niet.');
    if (!body.new || body.new.length < 8) fail(400, 'too_short', 'Kies minimaal 8 tekens.');
    return ok({ ok: true });
  }],
  ['GET', /^\/healthz$/, () => ok({ ok: true })],

  ['GET', /^\/bootstrap$/, () => {
    const has = db.transactions.length > 0;
    const cur = currentPeriod();
    return ok({
      settings: { ...db.settings },
      accounts: db.accounts.map((a) => ({ ...a })),
      categories: db.categories.map((c) => ({ ...c })),
      tags: db.tags.map((t) => ({ ...t })),
      periods: { first: has ? firstPeriod() : cur, last: cur, current: cur },
      has_data: has,
      unsorted_merchants: sortQueue().length,
      suggestions: { accounts: has ? (db.suggestions || []).filter((x) => !(db.settings.dismissed_suggestions || []).includes(x.key)) : [] },
    });
  }],

  /* Extra read endpoints the backend offers (docs/DECISIONS.md, backend core) */
  ['GET', /^\/categories$/, () => ok(db.categories.map((c) => ({ ...c })))],
  ['GET', /^\/tags$/, () => ok(db.tags.map((t) => ({ ...t, count: db.tx_tags.filter(([, g]) => g === t.id).length })))],
  ['GET', /^\/accounts$/, () => ok(db.accounts.map((a) => { const own = db.transactions.filter((t) => t.account_id === a.id); return { ...a, n_transactions: own.length, n_imported: own.filter((t) => !t.manual).length }; }))],
  ['GET', /^\/accounts\/(\d+)\/values$/, ({ params: [id] }) => ok(db.account_values.filter((v) => v.account_id === id).map(({ account_id, ...v }) => v))],

  /* Import */
  ['POST', /^\/import$/, ({ form }) => {
    const files = form ? form.getAll('files') : [];
    const wasEmpty = db.transactions.length === 0;
    const results = [];
    let loaded = false;
    for (const f of files) {
      const name = f.name || 'bestand';
      const format = /\.xml$/i.test(name) ? 'camt053' : /\.(csv|txt)$/i.test(name) ? 'asn_csv' : null;
      if (!format) { results.push({ filename: name, format: null, ok: false, error: 'Dit bestand herken ik niet.', account_id: null, account_name: null, is_new_account: false, new: 0, duplicates: 0, enriched: 0, date_from: null, date_to: null }); continue; }
      if (wasEmpty && !loaded) {
        const fresh = generate({ today: db.today });
        Object.assign(db, fresh);
        loaded = true;
        results.push({ filename: name, format, ok: true, error: null, import_id: db.imports.at(-1)?.id ?? null, new_accounts: db.accounts.map((a) => ({ id: a.id, name: a.name, type: a.type })), account_id: 1, account_name: 'Betaalrekening', is_new_account: true, new: db.transactions.length, duplicates: 0, enriched: 0, date_from: db.transactions[0].date, date_to: db.transactions.at(-1).date });
      } else {
        results.push({ filename: name, format, ok: true, error: null, import_id: null, new_accounts: [], account_id: 1, account_name: 'Betaalrekening', is_new_account: false, new: 0, duplicates: 42, enriched: 3, date_from: addDays(db.today, -32), date_to: addDays(db.today, -2) });
      }
    }
    const totals = results.reduce((t, r) => ({ new: t.new + r.new, duplicates: t.duplicates + r.duplicates, enriched: t.enriched + r.enriched }), { new: 0, duplicates: 0, enriched: 0 });
    touch();
    return ok({ files: results, totals, unsorted_merchants: sortQueue().length });
  }],
  ['GET', /^\/imports$/, () => ok([...db.imports].sort((a, b) => b.id - a.id))],
  ['DELETE', /^\/imports\/(\d+)$/, ({ params: [id] }) => {
    need(db.imports.find((i) => i.id === id));
    const gone = new Set(db.transactions.filter((t) => t.import_id === id).map((t) => t.id));
    db.transactions = db.transactions.filter((t) => !gone.has(t.id));
    db.tx_tags = db.tx_tags.filter(([t]) => !gone.has(t));
    db.goal_entries = db.goal_entries.filter((e) => !gone.has(e.transaction_id));
    db.imports = db.imports.filter((i) => i.id !== id);
    return ok({ ok: true, removed: gone.size });
  }],

  /* Transactions */
  ['GET', /^\/transactions$/, ({ query }) => {
    const all = filterTransactions(query);
    const limit = Math.min(1000, Number(query.limit) || 100); // backend: 1..1000
    const start = Number(query.cursor) || 0;
    const items = all.slice(start, start + limit).map(serializeTx);
    return ok({
      items, next_cursor: start + limit < all.length ? String(start + limit) : null, count: all.length,
      sum_in_cents: all.reduce((s, t) => s + Math.max(0, t.amount_cents), 0),
      sum_out_cents: all.reduce((s, t) => s + Math.min(0, t.amount_cents), 0),
    });
  }],
  ['GET', /^\/transactions\/(\d+)$/, ({ params: [id] }) => ok(txDetail(need(db.transactions.find((t) => t.id === id))))],
  ['PATCH', /^\/transactions\/(\d+)$/, ({ params: [id], body }) => {
    const t = need(db.transactions.find((x) => x.id === id));
    if (body.book_date !== undefined) t.book_date = body.book_date && body.book_date !== t.date ? body.book_date : null;
    if (body.spread_months !== undefined) {
      const m = body.spread_months > 1 ? body.spread_months : null;
      if (m && (t.amount_cents >= 0 || !['fixed', 'daily'].includes(catById(t.category_id)?.grp))) fail(400, 'spread_not_spending', 'Alleen een uitgave kun je over maanden verdelen.');
      if (m && possessionLinks().has(t.id)) fail(400, 'spread_possession', 'Deze betaling hoort bij een bezitting.');
      t.spread_months = m;
      touch();
    }
    let updated = 1;
    const scope = body.apply_scope || (body.apply_to_merchant === false ? 'one' : 'merchant');
    if (body.category_id !== undefined && scope === 'merchant_below' && !t.manual) {
      need(catById(body.category_id), 'Dit bakje bestaat niet.');
      if (!(body.below_cents > 0)) fail(400, 'bad_below', 'Kies een bedrag.');
      let r = db.rules.find((x) => x.merchant_key === t.merchant_key);
      if (!r) { r = { id: ++db.seq.rule, merchant_key: t.merchant_key, category_id: null, tag_id: null, created_at: db.today }; db.rules.push(r); }
      r.below_cents = body.below_cents;
      r.below_category_id = body.category_id;
      if (t.category_source === 'user') t.category_source = 'rule';
      updated = applyRule(t.merchant_key, { onlyBelow: true });
    } else if (body.category_id !== undefined && body.category_id !== t.category_id) {
      need(catById(body.category_id), 'Dit bakje bestaat niet.');
      if (scope === 'merchant' && !t.manual) {
        updated = applyCategoryToMerchant(t.merchant_key, body.category_id);
        if (t.category_source === 'user') { t.category_id = body.category_id; }
      } else { t.category_id = body.category_id; t.category_source = 'user'; }
    }
    if (body.tag_ids) {
      setTags(t.id, body.tag_ids);
      if (body.tag_always) {
        const added = body.tag_ids[0] ?? null;
        for (const x of db.transactions) if (x.merchant_key === t.merchant_key && added) { const cur = tagIdsOf(x.id); if (!cur.includes(added)) setTags(x.id, [...cur, added]); }
        const r = db.rules.find((x) => x.merchant_key === t.merchant_key);
        if (r) r.tag_id = added; else db.rules.push({ id: ++db.seq.rule, merchant_key: t.merchant_key, category_id: null, tag_id: added, created_at: db.today });
      }
    }
    if (body.note !== undefined) t.note = body.note || null;
    if (body.goal_id !== undefined) syncGoalEntry(t, body.goal_id);
    if (t.manual) {
      for (const k of ['date', 'amount_cents', 'merchant_name', 'account_id']) if (body[k] !== undefined) t[k] = body[k];
      if (body.merchant_name) t.merchant_key = merchantKeyOf(body.merchant_name);
    }
    t.updated_at = db.today;
    return ok({ transaction: serializeTx(t), updated_count: updated });
  }],
  ['POST', /^\/transactions$/, ({ body }) => {
    if (!body.amount_cents || !body.merchant_name || !body.date) fail(400, 'invalid', 'Vul bedrag, wat en datum in.');
    need(accById(body.account_id), 'Deze rekening bestaat niet.');
    const id = ++db.seq.tx;
    const t = {
      id, account_id: body.account_id, date: body.date, value_date: body.date, amount_cents: body.amount_cents,
      balance_after_cents: null, merchant_name: body.merchant_name, merchant_key: merchantKeyOf(body.merchant_name),
      counterparty_name: null, counterparty_iban: null, description: body.merchant_name, raw_description: null,
      method: 'other', city: null, category_id: body.category_id ?? catByKey('unsorted').id,
      category_source: body.category_id ? 'user' : 'none', kind: 'normal', transfer_account_id: null, goal_id: null,
      note: body.note || null, manual: 1, mcc: null, pay_type: null, bank_code: null, wallet: null, bank_category: null,
      mandate_id: null, import_id: null, seq: id,
    };
    db.transactions.push(t);
    if (body.tag_ids) setTags(id, body.tag_ids);
    return ok({ transaction: serializeTx(t), updated_count: 1 }); // backend shape
  }],
  ['DELETE', /^\/transactions\/(\d+)$/, ({ params: [id] }) => {
    const t = need(db.transactions.find((x) => x.id === id));
    if (!t.manual) fail(400, 'not_manual', 'Alleen zelf toegevoegde uitgaven kun je verwijderen.');
    db.transactions = db.transactions.filter((x) => x.id !== id);
    db.tx_tags = db.tx_tags.filter(([x]) => x !== id);
    return ok({ ok: true });
  }],
  ['POST', /^\/transactions\/bulk$/, ({ body }) => {
    const ids = new Set(body.ids || []);
    let n = 0;
    for (const t of db.transactions) {
      if (!ids.has(t.id)) continue;
      n++;
      if (body.category_id) { t.category_id = body.category_id; t.category_source = 'user'; }
      if (body.add_tag_ids?.length || body.remove_tag_ids?.length) {
        const cur = new Set(tagIdsOf(t.id));
        (body.add_tag_ids || []).forEach((x) => cur.add(x));
        (body.remove_tag_ids || []).forEach((x) => cur.delete(x));
        setTags(t.id, [...cur]);
      }
    }
    return ok({ updated_count: n });
  }],

  /* Sorting */
  ['GET', /^\/sort\/queue$/, () => { const items = sortQueue(); return ok({ items, remaining: items.length }); }],
  ['POST', /^\/sort$/, ({ body }) => {
    need(catById(body.category_id), 'Dit bakje bestaat niet.');
    const n = applyCategoryToMerchant(body.merchant_key, body.category_id);
    touch();
    return ok({ updated_count: n, remaining: sortQueue().length });
  }],

  /* Categories */
  ['POST', /^\/categories$/, ({ body }) => {
    if (!body.name) fail(400, 'invalid', 'Geef het bakje een naam.');
    const id = ++db.seq.category;
    const c = { id, key: `custom-${id}`, name: body.name, emoji: body.emoji || '📦', color: body.color || 'gray', grp: ['fixed', 'daily', 'income', 'saving'].includes(body.grp) ? body.grp : 'daily', sort: id, hidden: 0, builtin: 0 };
    db.categories.push(c);
    return ok(c, 201);
  }],
  ['PATCH', /^\/categories\/(\d+)$/, ({ params: [id], body }) => {
    const c = need(catById(id));
    for (const k of ['name', 'emoji', 'color', 'hidden', 'sort']) if (body[k] !== undefined) c[k] = body[k];
    if (body.grp && !c.builtin) c.grp = body.grp;
    return ok({ ...c });
  }],
  ['DELETE', /^\/categories\/(\d+)$/, ({ params: [id] }) => {
    const c = need(catById(id));
    if (c.builtin) fail(400, 'builtin', 'Dit bakje kun je alleen verbergen.');
    const u = catByKey('unsorted').id;
    db.transactions.forEach((t) => { if (t.category_id === id) { t.category_id = u; t.category_source = 'none'; } });
    db.categories = db.categories.filter((x) => x.id !== id);
    return ok({ ok: true });
  }],
  ['GET', /^\/categories\/(\d+)\/summary$/, ({ params: [id], query }) => {
    const c = need(catById(id));
    const pid = query.period || currentPeriod();
    const f = flows(pid);
    const series = [];
    for (let i = 11; i >= 0; i--) { const p = shiftPeriod(pid, -i); series.push({ period: p, cents: flows(p).cats.get(id)?.cents || 0 }); }
    const { from, to } = periodBounds(pid);
    const txs = db.transactions.filter((t) => t.category_id === id && t.date >= from && t.date <= to && isCashflow(t)
        && !isSpread(t) && !possessionLinks().has(t.id))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
    const parts = periodParts(pid).filter((p) => p.category_id === id);
    const m = new Map();
    for (const t of txs) {
      const e = m.get(t.merchant_key) || { merchant_key: t.merchant_key, merchant_name: t.merchant_name, cents: 0, count: 0 };
      e.cents -= t.amount_cents; e.count++;
      m.set(t.merchant_key, e);
    }
    const income = c.grp === 'income';
    return ok({
      spent_cents: income ? (f.incomeCats.get(id)?.cents || 0) : (f.cats.get(id)?.cents || 0),
      avg_cents: categoryAvg(id, pid), count: txs.length + parts.length, parts,
      series: income ? series.map((s) => ({ period: s.period, cents: flows(s.period).incomeCats.get(id)?.cents || 0 })) : series,
      merchants: [...m.values()].map((x) => (income ? { ...x, cents: -x.cents } : x)).sort((a, b) => b.cents - a.cents).slice(0, 8),
      transactions: txs.map(serializeTx),
    });
  }],

  /* Tags */
  ['POST', /^\/tags$/, ({ body }) => {
    if (!body.name) fail(400, 'invalid', 'Geef de tag een naam.');
    if (db.tags.some((t) => t.name.toLowerCase() === body.name.toLowerCase())) fail(409, 'exists', 'Deze tag bestaat al.');
    const t = { id: ++db.seq.tag, name: body.name, emoji: body.emoji || null, color: body.color || 'blue', archived: 0, created_at: db.today };
    db.tags.push(t);
    return ok(t, 201);
  }],
  ['PATCH', /^\/tags\/(\d+)$/, ({ params: [id], body }) => {
    const t = need(db.tags.find((x) => x.id === id));
    for (const k of ['name', 'emoji', 'color', 'archived']) if (body[k] !== undefined) t[k] = body[k];
    return ok({ ...t });
  }],
  ['DELETE', /^\/tags\/(\d+)$/, ({ params: [id] }) => {
    need(db.tags.find((x) => x.id === id));
    db.tags = db.tags.filter((x) => x.id !== id);
    db.tx_tags = db.tx_tags.filter(([, g]) => g !== id);
    return ok({ ok: true });
  }],
  ['GET', /^\/tags\/(\d+)\/summary$/, ({ params: [id] }) => {
    need(db.tags.find((x) => x.id === id));
    const ids = new Set(db.tx_tags.filter(([, g]) => g === id).map(([t]) => t));
    const txs = db.transactions.filter((t) => ids.has(t.id)).sort((a, b) => (a.date < b.date ? 1 : -1));
    const byCat = new Map();
    const byMonth = new Map();
    for (const t of txs) {
      if (t.amount_cents < 0) {
        byCat.set(t.category_id, (byCat.get(t.category_id) || 0) - t.amount_cents);
        byMonth.set(t.date.slice(0, 7), (byMonth.get(t.date.slice(0, 7)) || 0) - t.amount_cents);
      }
    }
    return ok({
      total_out_cents: txs.reduce((s, t) => s + Math.min(0, t.amount_cents), 0),
      total_in_cents: txs.reduce((s, t) => s + Math.max(0, t.amount_cents), 0),
      count: txs.length, first_date: txs.at(-1)?.date || null, last_date: txs[0]?.date || null,
      by_category: [...byCat.entries()].map(([category_id, cents]) => ({ category_id, cents })).sort((a, b) => b.cents - a.cents),
      by_month: [...byMonth.entries()].map(([month, cents]) => ({ month, cents })).sort((a, b) => (a.month < b.month ? -1 : 1)),
      transactions: txs.map(serializeTx),
    });
  }],

  /* Rules */
  ['GET', /^\/rules$/, () => ok(db.rules.map((r) => {
    const txs = db.transactions.filter((t) => t.merchant_key === r.merchant_key);
    return { id: r.id, merchant_key: r.merchant_key, merchant_name: txs[0]?.merchant_name || r.merchant_key, category_id: r.category_id, tag_id: r.tag_id, below_cents: r.below_cents ?? null, below_category_id: r.below_category_id ?? null, count: txs.length };
  }))],
  ['PATCH', /^\/rules\/(\d+)$/, ({ params: [id], body }) => {
    const r = need(db.rules.find((x) => x.id === id));
    for (const k of ['category_id', 'below_cents', 'below_category_id']) if (body[k] !== undefined) r[k] = body[k];
    if (r.below_cents == null || r.below_category_id == null) {
      // Threshold removed: the small payments follow the main bakje again.
      r.below_cents = null; r.below_category_id = null;
    }
    applyRule(r.merchant_key);
    return ok({ id: r.id, merchant_key: r.merchant_key, category_id: r.category_id, tag_id: r.tag_id, below_cents: r.below_cents, below_category_id: r.below_category_id });
  }],
  ['DELETE', /^\/rules\/(\d+)$/, ({ params: [id] }) => { need(db.rules.find((r) => r.id === id)); db.rules = db.rules.filter((r) => r.id !== id); return ok({ ok: true }); }],

  /* Overview and trends */
  ['GET', /^\/overview$/, ({ query }) => {
    if (/^\d{4}$/.test(query.period || '')) {
      const y = yearOverview(Number(query.period));
      return y ? ok(y) : fail(400, 'future_year', 'Dat jaar is nog niet begonnen.');
    }
    return ok(overview(query.period || currentPeriod()));
  }],
  ['GET', /^\/trends$/, ({ query }) => ok(trends(Number(query.periods) || 12))],
  ['GET', /^\/calendar$/, ({ query }) => ok(calendar(query.period || currentPeriod()))],
  ['GET', /^\/recap\/index$/, () => ok(recapIndex())],
  ['GET', /^\/checks$/, () => ok(checksData())],
  ['GET', /^\/recap$/, ({ query }) => ok(query.year ? recap({ year: Number(query.year) }) : recap({ period: query.period || currentPeriod() }))],

  /* Recurring */
  ['GET', /^\/recurring$/, () => {
    const items = recurringItems();
    const active = items.filter((i) => i.status !== 'ended');
    const out = active.filter((i) => i.direction === 'out' && catById(i.category_id)?.grp === 'fixed'); // backend: fixed bakjes only
    const monthly_out_cents = out.reduce((s, i) => s - i.per_month_cents, 0);
    const subs = active.filter((i) => i.direction === 'out' && ['abonnementen', 'telecom'].includes(catById(i.category_id)?.key));
    const subscriptions = { per_month_cents: subs.reduce((s, i) => s - i.per_month_cents, 0), per_year_cents: subs.reduce((s, i) => s + i.per_year_cents, 0), count: subs.length };
    const inc = incomeAvg();
    return ok({ income_cents: inc ? inc.income_cents : null, repaid_cents: inc ? inc.repaid_cents : 0,
      share_of_income: inc && inc.income_cents > 0 && monthly_out_cents > 0 ? Math.round((monthly_out_cents / inc.income_cents) * 1000) / 1000 : null,
      monthly_out_cents, monthly_in_cents: active.filter((i) => i.direction === 'in' && catById(i.category_id)?.grp === 'income').reduce((s, i) => s + i.per_month_cents, 0), yearly_out_cents: monthly_out_cents * 12, subscriptions, items });
  }],
  ['DELETE', /^\/recurring\/ignore$/, ({ body }) => { db.recurring_ignored = db.recurring_ignored.filter((k) => k !== String(body.key || '').trim()); return ok({ ok: true }); }],
  ['GET', /^\/assumptions$/, () => ok(assumptionsList())],
  ['DELETE', /^\/goals\/links$/, ({ body }) => {
    db.goal_links = goalLinks().filter((l) => !(l.goal_id === body.goal_id && l.description === body.description));
    return ok({ ok: true });
  }],
  ['POST', /^\/insights\/dismiss$/, ({ body }) => {
    const ids = (db.settings._dismissed_insights || []).filter((x) => x !== body.id);
    ids.push(body.id);
    db.settings._dismissed_insights = ids.slice(-500);
    return ok({ ok: true });
  }],
  ['POST', /^\/insights\/mute$/, ({ body }) => {
    if (!INSIGHT_KINDS[body.kind]) fail(400, 'unknown_kind', 'Dit soort melding bestaat niet.');
    const set = new Set(db.settings.muted_insight_kinds || []);
    if (body.muted) set.add(body.kind); else set.delete(body.kind);
    db.settings.muted_insight_kinds = [...set];
    return ok({ ok: true, muted_insight_kinds: db.settings.muted_insight_kinds });
  }],
  ['POST', /^\/recurring\/ignore$/, ({ body }) => { if (!db.recurring_ignored.includes(body.key)) db.recurring_ignored.push(body.key); return ok({ ok: true }); }],

  /* Goals */
  ['GET', /^\/goals$/, () => ok(goalsData())],
  ['POST', /^\/goals$/, ({ body }) => {
    if (!body.name || !body.target_cents) fail(400, 'invalid', 'Geef een naam en een doelbedrag.');
    let code;
    do code = String(10000 + Math.floor(Math.random() * 90000)); while (db.goals.some((g) => g.code === code));
    const g = { id: ++db.seq.goal, name: body.name, emoji: body.emoji || '🎯', color: body.color || 'teal', target_cents: body.target_cents, target_date: body.target_date || null, repeat: body.repeat || 'none', code, keywords: body.keywords || [], archived: 0, sort: db.seq.goal, created_at: db.today };
    db.goals.push(g);
    touch();
    return ok(goalsData().goals.find((x) => x.id === g.id), 201);
  }],
  ['PATCH', /^\/goals\/(\d+)$/, ({ params: [id], body }) => {
    const g = need(db.goals.find((x) => x.id === id));
    for (const k of ['name', 'emoji', 'color', 'target_cents', 'target_date', 'repeat', 'keywords', 'archived', 'sort']) if (body[k] !== undefined) g[k] = body[k];
    touch();
    const d = goalsData(); return ok([...d.goals, ...d.archived_goals].find((x) => x.id === id) || { ...g });
  }],
  ['DELETE', /^\/goals\/(\d+)$/, ({ params: [id] }) => {
    need(db.goals.find((x) => x.id === id));
    db.goals = db.goals.filter((g) => g.id !== id);
    db.goal_entries = db.goal_entries.filter((e) => e.goal_id !== id);
    db.transactions.forEach((t) => { if (t.goal_id === id) t.goal_id = null; });
    return ok({ ok: true });
  }],
  ['POST', /^\/goals\/(\d+)\/entries$/, ({ params: [id], body }) => {
    need(db.goals.find((x) => x.id === id));
    if (body.transaction_id) {
      const t = need(db.transactions.find((x) => x.id === body.transaction_id));
      syncGoalEntry(t, id);
      touch();
      return ok({ entry: db.goal_entries.at(-1), goal: goalOut(id) }, 201);
    }
    const e = { id: ++db.seq.entry, goal_id: id, date: body.date || db.today, amount_cents: body.amount_cents, kind: 'manual', note: body.note || null, transaction_id: null };
    db.goal_entries.push(e);
    touch();
    return ok({ entry: e, goal: goalOut(id) }, 201);
  }],
  ['POST', /^\/goals\/(\d+)\/saldo$/, ({ params: [id], body }) => {
    need(db.goals.find((x) => x.id === id));
    const saldo = db.goal_entries.filter((e) => e.goal_id === id).reduce((s, e) => s + e.amount_cents, 0);
    if (body.saldo_cents === saldo) return ok({ entry: null, goal: goalOut(id) });
    const e = { id: ++db.seq.entry, goal_id: id, date: db.today, amount_cents: body.saldo_cents - saldo, kind: 'adjust', note: null, transaction_id: null };
    db.goal_entries.push(e);
    touch();
    return ok({ entry: e, goal: goalOut(id) });
  }],
  ['DELETE', /^\/goal-entries\/(\d+)$/, ({ params: [id] }) => {
    const e = need(db.goal_entries.find((x) => x.id === id));
    if (e.transaction_id) { const t = db.transactions.find((x) => x.id === e.transaction_id); if (t) t.goal_id = null; }
    db.goal_entries = db.goal_entries.filter((x) => x.id !== id);
    return ok({ ok: true });
  }],

  /* Accounts */
  ['GET', /^\/networth$/, () => ok(networth())],
  ['GET', /^\/assets$/, () => ok(assetsOut())],
  ['POST', /^\/assets$/, ({ body }) => {
    if (!['pension', 'debt', 'other', 'possession'].includes(body.kind)) fail(422, 'invalid', 'Onbekende soort.');
    const name = String(body.name || '').trim();
    if (!name) fail(422, 'invalid', 'Geef een naam.');
    if (body.kind === 'possession') {
      const tx = body.tx_id ? need(db.transactions.find((t) => t.id === body.tx_id && t.amount_cents < 0), 'Kies de betaling waarmee je het kocht.') : null;
      const price = body.price_cents || (tx ? -tx.amount_cents : null);
      const start = body.start_date || tx?.date;
      if (!price || !start) fail(422, 'invalid', 'Vul de aankoopprijs en de datum in.');
      if ((body.residual_cents || 0) > price) fail(422, 'residual_too_high', 'De verwachte verkoopprijs is hoger dan de aankoopprijs.');
      const txCat = tx && catById(tx.category_id);
      const emoji = [['motor', '🏍️'], ['camper', '🚐'], ['caravan', '🚐'], ['boot', '⛵'], ['fiets', '🚲']].find(([w]) => name.toLowerCase().includes(w))?.[1] || '🚗';
      db.seq.asset = (db.seq.asset || 0) + 1;
      db.assets.push({ id: db.seq.asset, kind: 'possession', name, include: true, merchant_key: null, debt_kind: null, tx_id: tx?.id || null,
        price_cents: price, start_date: start, life_months: body.life_months || 96, residual_cents: body.residual_cents || 0,
        category_id: body.category_id ?? (txCat && ['fixed', 'daily'].includes(txCat.grp) && txCat.key !== 'unsorted' ? txCat.id : catByKey('vervoer')?.id),
        emoji, sale_tx_id: null, sale_date: null, sale_cents: null });
      if (tx) tx.spread_months = null;
      touch();
      return ok({ ...assetsOut(), id: db.seq.asset });
    }
    let key = null;
    if (body.kind === 'debt') {
      if ('merchant_key' in body) { key = body.merchant_key || null; if (key) checkAssetMerchant(key, 0); }
      else if (body.debt_kind === 'studieschuld') {
        const duo = assetCandidates().find((c) => c.likely);
        if (duo) { try { checkAssetMerchant(duo.merchant_key, 0); key = duo.merchant_key; } catch { key = null; } }
      }
    }
    db.seq.asset = (db.seq.asset || 0) + 1;
    db.assets.push({ id: db.seq.asset, kind: body.kind, name, debt_kind: body.kind === 'debt' ? (body.debt_kind || 'overig') : null,
      include: body.include ?? ASSET_INCLUDE[body.kind], merchant_key: key });
    touch();
    return ok({ ...assetsOut(), id: db.seq.asset });
  }],
  ['PATCH', /^\/assets\/(\d+)$/, ({ params: [id], body }) => {
    const a = need(db.assets.find((x) => x.id === id), 'Dit onderdeel bestaat niet (meer).');
    if (body.name) a.name = String(body.name).trim();
    if (body.include != null) a.include = !!body.include;
    if (a.kind === 'possession') {
      for (const f of ['price_cents', 'life_months', 'residual_cents', 'category_id', 'emoji', 'start_date']) if (body[f] != null) a[f] = body[f];
      if ((a.residual_cents || 0) > a.price_cents) fail(422, 'residual_too_high', 'De verwachte verkoopprijs is hoger dan de aankoopprijs.');
      if ('sale_tx_id' in body || 'sale_date' in body) {
        if (body.sale_tx_id) { a.sale_tx_id = body.sale_tx_id; a.sale_date = null; a.sale_cents = null; }
        else if (body.sale_date && body.sale_cents != null) { a.sale_tx_id = null; a.sale_date = body.sale_date; a.sale_cents = body.sale_cents; }
        else { a.sale_tx_id = null; a.sale_date = null; a.sale_cents = null; }
      }
    }
    if (a.kind === 'debt') {
      if (body.debt_kind) a.debt_kind = body.debt_kind;
      if ('merchant_key' in body) { if (body.merchant_key) checkAssetMerchant(body.merchant_key, id); a.merchant_key = body.merchant_key || null; }
    }
    touch();
    return ok(assetsOut());
  }],
  ['DELETE', /^\/assets\/(\d+)$/, ({ params: [id] }) => {
    need(db.assets.find((x) => x.id === id), 'Dit onderdeel bestaat niet (meer).');
    db.assets = db.assets.filter((x) => x.id !== id); db.asset_entries = db.asset_entries.filter((e) => e.asset_id !== id);
    touch();
    return ok(assetsOut());
  }],
  ['POST', /^\/assets\/(\d+)\/entries$/, ({ params: [id], body }) => {
    const a = need(db.assets.find((x) => x.id === id), 'Dit onderdeel bestaat niet (meer).');
    if (body.date > db.today) fail(422, 'future_date', 'Deze datum ligt in de toekomst.');
    db.seq.assetEntry = (db.seq.assetEntry || 0) + 1;
    const debt = a.kind === 'debt';
    db.asset_entries.push({ id: db.seq.assetEntry, asset_id: id, date: body.date || db.today, value_cents: body.value_cents || 0,
      interest_cents: debt ? body.interest_cents ?? null : null, repaid_cents: debt ? body.repaid_cents ?? null : null, note: (body.note || '').trim() || null });
    touch();
    return ok(assetsOut());
  }],
  ['DELETE', /^\/assets\/(\d+)\/entries\/(\d+)$/, ({ params: [id, eid] }) => {
    need(db.asset_entries.find((e) => e.id === eid && e.asset_id === id), 'Deze waarde bestaat niet (meer).');
    db.asset_entries = db.asset_entries.filter((e) => e.id !== eid);
    touch();
    return ok(assetsOut());
  }],
  ['GET', /^\/mortgage$/, () => ok(mortgageOut())],
  ['POST', /^\/mortgage$/, ({ body }) => {
    if (db.mortgage_parts.length) fail(409, 'exists', 'Er is al een hypotheek.');
    db.seq.part = db.seq.part || 0;
    db.mortgage_parts = (body.parts || []).map((x, i) => ({ id: ++db.seq.part, name: String(x.name || '').trim() || `Deel ${i + 1}`, sort: i }));
    return ok(mortgageOut());
  }],
  ['PATCH', /^\/mortgage$/, ({ body }) => {
    if (body.include_in_networth != null) db.settings.mortgage_include_home = !!body.include_in_networth;
    if ('merchant_key' in body) {
      if (body.merchant_key === null) delete db.settings.mortgage_merchant_key;
      else {
        if (body.merchant_key && db.assets.some((a) => a.merchant_key === body.merchant_key)) fail(409, 'merchant_linked', 'Deze betaling hoort al bij een andere lening.');
        db.settings.mortgage_merchant_key = body.merchant_key;
      }
    }
    return ok(mortgageOut());
  }],
  ['DELETE', /^\/mortgage$/, () => {
    db.mortgage_parts = []; db.mortgage_years = []; db.home_values = [];
    delete db.settings.mortgage_merchant_key; delete db.settings.mortgage_include_home;
    return ok({ ok: true });
  }],
  ['PATCH', /^\/mortgage\/parts\/(\d+)$/, ({ params: [id], body }) => { need(db.mortgage_parts.find((p) => p.id === id)).name = String(body.name || '').trim(); return ok(mortgageOut()); }],
  ['PUT', /^\/mortgage\/years\/(\d+)$/, ({ params: [year], body }) => {
    if (year >= Number(db.today.slice(0, 4))) fail(422, 'year_not_finished', `De jaaropgave over ${year} komt pas na afloop van dat jaar.`);
    const ids = (body.parts || []).map((x) => x.part_id);
    if (new Set(ids).size !== ids.length) fail(422, 'duplicate_part', 'Elk leningdeel mag maar één keer in de jaaropgave.');
    db.mortgage_years = db.mortgage_years.filter((e) => e.year !== year);
    for (const x of body.parts || []) db.mortgage_years.push({ part_id: x.part_id, year, debt_end_cents: x.debt_end_cents || 0, interest_cents: x.interest_cents || 0, repaid_cents: x.repaid_cents || 0, principal_cents: x.principal_cents ?? null });
    return ok(mortgageOut());
  }],
  ['DELETE', /^\/mortgage\/years\/(\d+)$/, ({ params: [year] }) => { db.mortgage_years = db.mortgage_years.filter((e) => e.year !== year); return ok(mortgageOut()); }],
  ['POST', /^\/mortgage\/home-values$/, ({ body }) => { db.seq.home = (db.seq.home || 0) + 1; db.home_values.push({ id: db.seq.home, date: body.date, value_cents: body.value_cents }); return ok(mortgageOut()); }],
  ['DELETE', /^\/mortgage\/home-values\/(\d+)$/, ({ params: [id] }) => { db.home_values = db.home_values.filter((h) => h.id !== id); return ok(mortgageOut()); }],
  ['GET', /^\/accounts\/(\d+)\/holdings$/, ({ params: [id] }) => {
    const a = need(db.accounts.find((x) => x.id === id));
    if (a.type !== 'investment') fail(422, 'not_investment', 'Dit is geen beleggingsrekening.');
    return ok({ ...holdingsOut(id), chart: holdingsChart(id), prices: priceStatus() });
  }],
  ['POST', /^\/accounts\/(\d+)\/trades$/, ({ params: [id], body }) => {
    need(db.accounts.find((x) => x.id === id && x.type === 'investment'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || '')) fail(422, 'bad_date', 'Geef een datum.');
    const isin = String(body.isin || '').toUpperCase();
    if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) fail(422, 'bad_isin', 'Deze ISIN klopt niet.');
    if (!db.securities.find((s) => s.isin === isin)) {
      if (!body.name) fail(422, 'name_required', 'Geef het fonds een naam.');
      db.securities.push({ isin, name: body.name, symbol: null, currency: 'EUR', exchange: null, price_symbol: null });
    }
    const q = body.side === 'sell' ? -body.quantity : body.quantity;
    if (q < 0) {
      const held = db.trades.filter((t) => t.account_id === id && t.isin === isin).reduce((s, t) => s + t.quantity, 0);
      if (-q > held + 1e-6) fail(422, 'too_many', 'Zoveel heb je niet van dit fonds.');
    }
    const t = { id: ++db.seq.trade, account_id: id, date: body.date, isin, quantity: q, price: body.price_cents / 100, currency: 'EUR', value_eur_cents: -Math.round(q * body.price_cents), fees_cents: body.fees_cents || 0, manual: true };
    db.trades.push(t);
    return ok({ id: t.id });
  }],
  ['DELETE', /^\/trades\/(\d+)$/, ({ params: [id] }) => {
    const t = need(db.trades.find((x) => x.id === id));
    if (!t.manual) fail(409, 'imported', 'Geïmporteerde transacties verwijder je via de import.');
    db.trades = db.trades.filter((x) => x.id !== id);
    return ok({ ok: true });
  }],
  ['GET', /^\/securities$/, ({ query }) => {
    const q = String(query?.q || '').toLowerCase();
    return ok(db.securities.filter((s) => !q || s.name.toLowerCase().includes(q) || s.isin.toLowerCase().includes(q)));
  }],
  ['GET', /^\/prices\/status$/, () => ok(priceStatus())],
  ['POST', /^\/prices\/refresh$/, () => {
    if (!assumptionsOut().prices_auto.enabled) fail(409, 'disabled', 'Koersen ophalen staat uit.');
    db.prices_status = { last_ok: new Date().toISOString(), error: null };
    return ok({ ...priceStatus(), result: { ok: true, updated: 0 } });
  }],
  ['POST', /^\/accounts$/, ({ body }) => {
    if (!body.name || !['checking', 'savings', 'credit', 'investment'].includes(body.type)) fail(400, 'invalid', 'Geef een naam en soort.');
    const a = { id: ++db.seq.account, iban: body.iban || null, name: body.name, type: body.type, match: body.match || [], manual_balance_cents: null, manual_balance_date: null, hidden: 0, sort: db.seq.account, created_at: db.today };
    db.accounts.push(a);
    if (body.iban) db.suggestions = (db.suggestions || []).filter((s) => s.iban !== body.iban);
    return ok(a, 201);
  }],
  ['PATCH', /^\/accounts\/(\d+)$/, ({ params: [id], body }) => {
    const a = need(accById(id));
    for (const k of ['name', 'type', 'match', 'manual_balance_cents', 'manual_balance_date', 'hidden', 'locked', 'sort', 'iban']) if (body[k] !== undefined) a[k] = body[k];
    return ok({ ...a });
  }],
  ['DELETE', /^\/accounts\/(\d+)$/, ({ params: [id], query }) => {
    need(accById(id));
    const has = db.transactions.some((t) => t.account_id === id && t.import_id);
    if (has && !query.force) fail(409, 'has_transactions', 'Deze rekening heeft geïmporteerde betalingen.');
    db.accounts = db.accounts.filter((a) => a.id !== id);
    db.transactions = db.transactions.filter((t) => t.account_id !== id);
    return ok({ ok: true });
  }],
  ['POST', /^\/accounts\/(\d+)\/values$/, ({ params: [id], body }) => {
    need(accById(id));
    const v = { id: ++db.seq.value, account_id: id, date: body.date || db.today, value_cents: body.value_cents };
    db.account_values.push(v);
    return ok(v, 201);
  }],
  ['DELETE', /^\/account-values\/(\d+)$/, ({ params: [id] }) => { need(db.account_values.find((v) => v.id === id)); db.account_values = db.account_values.filter((v) => v.id !== id); return ok({ ok: true }); }],

  /* Settings and data */
  ['GET', /^\/settings$/, () => ok(settingsOut())],
  ['PATCH', /^\/settings$/, ({ body }) => {
    if (body.month_start_day !== undefined) {
      const d = Number(body.month_start_day);
      if (!(d >= 1 && d <= 28)) fail(400, 'invalid', 'Kies een dag van 1 tot en met 28.');
      db.settings.month_start_day = d;
    }
    if (body.household_name !== undefined) db.settings.household_name = body.household_name;
    if (body.dismissed_suggestions !== undefined) db.settings.dismissed_suggestions = body.dismissed_suggestions;
    if (body.muted_insight_kinds !== undefined) db.settings.muted_insight_kinds = body.muted_insight_kinds;
    if (body.assumptions !== undefined) {
      const cur = assumptionsOut();
      for (const [k, v] of Object.entries(body.assumptions || {})) {
        if (!cur[k] || typeof v !== 'object') fail(422, 'invalid', 'Deze instelling bestaat niet.');
        if ('enabled' in v && typeof v.enabled !== 'boolean') fail(422, 'invalid', 'Kies aan of uit.');
        if ('below_cents' in v && !(Number.isInteger(v.below_cents) && v.below_cents >= 100 && v.below_cents <= 10000)) fail(422, 'invalid', 'Kies een bedrag tussen € 1 en € 100.');
        if ('day' in v && v.day !== null && !(Number.isInteger(v.day) && v.day >= 1 && v.day <= 31)) fail(422, 'invalid', 'Kies een dag tussen 1 en 31.');
        if ('months' in v && !(typeof v.months === 'number' && v.months >= 0 && v.months <= 24)) fail(422, 'invalid', 'Kies tussen 0 en 24 maanden.');
        if ('amount_cents' in v && v.amount_cents !== null && !(Number.isInteger(v.amount_cents) && v.amount_cents >= 0)) fail(422, 'invalid', 'Kies een geldig bedrag.');
        if ('cents' in v && !Number.isInteger(v.cents)) fail(422, 'invalid', 'Kies een geldig bedrag.');
        cur[k] = { ...cur[k], ...v };
      }
      db.settings.assumptions = cur;
    }
    return ok(settingsOut());
  }],
  ['GET', /^\/export\/transactions\.csv$/, () => {
    const rows = [['datum', 'rekening', 'bedrag', 'wat', 'bakje', 'omschrijving', 'notitie']];
    for (const t of filterTransactions({})) rows.push([t.date, accById(t.account_id)?.name, (t.amount_cents / 100).toFixed(2).replace('.', ','), t.merchant_name, catById(t.category_id)?.name, t.description, t.note || '']);
    const csv = rows.map((r) => r.map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
    return ok(new Blob([csv], { type: 'text/csv' }));
  }],
  ['GET', /^\/export\/backup$/, () => ok(new Blob([JSON.stringify({ mock: true, exported: db.today })], { type: 'application/octet-stream' }))],
  ['POST', /^\/restore$/, () => ok({ ok: true })],
  ['POST', /^\/reclassify$/, () => ok({ updated_count: 0 })],
  ['DELETE', /^\/data$/, ({ body }) => {
    if (body.password !== PASSWORD) fail(401, 'wrong_password', 'Dat wachtwoord klopt niet.');
    Object.assign(db, generate({ today: db.today, empty: true }));
    return ok({ ok: true });
  }],
];

/* ---------- Slimme aannames (SPEC §13) ---------- */

const INSIGHT_KINDS = {
  pace: 'Dagelijkse uitgaven tot nu toe', category_spike: 'Meer dan normaal in een bakje', price_change: 'Prijsstijgingen',
  new_recurring: 'Nieuwe vaste lasten', ended_recurring: 'Gestopte vaste lasten', duplicate: 'Dubbele afschrijvingen',
  large: 'Grote eenmalige uitgaven', savings_rate: 'Hoeveel je spaart', buffer: 'Buffer', left_over: 'Geld over',
  unsorted: 'Nog te sorteren', yearly_bill: 'Jaarlijkse rekeningen', goal_behind: 'Potjes die achterlopen',
  goal_reached: 'Gehaalde potjes', stale: 'Importherinnering', fixed_share: 'Aandeel vaste lasten', last_year: 'Vergelijking met vorig jaar',
  tempo: 'Meer uit dan erin', mortgage: 'Jaaropgave hypotheek', pension: 'Pensioenoverzicht',
};

function assumptionsOut() {
  const a = db.settings.assumptions || {};
  return {
    small_amount_at_fuel: { enabled: true, below_cents: 1500, ...(a.small_amount_at_fuel || {}) },
    payday_day: { day: null, ...(a.payday_day || {}) },
    buffer: { months: 3, amount_cents: null, ...(a.buffer || {}) },
    checking_floor_cents: { cents: 0, ...(a.checking_floor_cents || {}) },
    prices_auto: { enabled: false, ...(a.prices_auto || {}) },
  };
}

function settingsOut() {
  const { _dismissed_insights, ...pub } = db.settings;
  return {
    ...pub,
    muted_insight_kinds: db.settings.muted_insight_kinds || [],
    insight_kinds: Object.entries(INSIGHT_KINDS).map(([kind, label]) => ({ kind, label })),
    assumptions: assumptionsOut(),
  };
}

/** Learned description → potje links (seeded with one, like a manual assignment would). */
function goalLinks() {
  if (!db.goal_links) {
    const fiets = db.goals.find((g) => /fiets/i.test(g.name));
    db.goal_links = fiets ? [{ goal_id: fiets.id, description: 'Fiets', count: db.goal_entries.filter((e) => e.goal_id === fiets.id && e.kind === 'auto').length }] : [];
  }
  return db.goal_links;
}

function assumptionsList() {
  const rec = recurringItems();
  const salaris = db.categories.find((c) => c.key === 'salaris');
  const nameOf = (key) => db.transactions.find((t) => t.merchant_key === key.split('|')[0])?.merchant_name || key.split('|')[0];
  return {
    salary: rec.filter((i) => i.direction === 'in' && i.category_id === salaris?.id && i.status !== 'ended')
      .map((i) => ({ merchant_key: i.merchant_key, name: i.name, amount_cents: i.amount_cents, frequency: i.frequency })),
    accounts: db.accounts.filter((a) => !a.hidden).map((a) => ({
      id: a.id, name: a.name, type: a.type,
      type_source: a.iban && db.transactions.some((t) => t.account_id === a.id && !t.manual) ? 'import' : 'user',
    })),
    recurring_ignored: db.recurring_ignored.map((key) => ({ key, name: nameOf(key) })),
    recurring_count: rec.filter((i) => i.status !== 'ended').length,
    rules_count: db.rules.length,
    goal_links: goalLinks().map((l) => ({ ...l, goal_name: db.goals.find((g) => g.id === l.goal_id)?.name || 'Potje' })),
    month_start_day: startDay(),
    suggestion: { month_start_day: startDay() === 1 && rec.some((i) => i.category_id === salaris?.id) ? 24 : null },
    payday: (([date, source]) => ({ date, source }))(payday(rec)),
  };
}

// Exposed for the console: window.__centsMock.db
export const debug = { get db() { return db; }, money };

/** Dev tool (tools/mock_parity.py): the demo data and this mock's answers to GET requests, so the
 *  backend can compute the same from the same data and both can be compared. */
export function parityDump(requests) {
  const outputs = {};
  for (const [key, path, query] of requests) {
    try { outputs[key] = handle({ method: 'GET', path, query: query || {} }).data; } catch (e) { outputs[key] = { error: String(e.message || e) }; }
  }
  return { db, outputs };
}

/* ======================================================================================
   Holdings of investment accounts (SPEC §7.1), same rules as services/investments.py
   ====================================================================================== */

function priceStatus() {
  const last = (db.prices || []).filter((p) => p.source === 'yahoo').reduce((m, p) => (p.date > m ? p.date : m), '');
  return { enabled: assumptionsOut().prices_auto.enabled, source: 'Yahoo Finance', source_key: 'yahoo', last_run: db.prices_status?.last_ok || null,
    last_ok: db.prices_status?.last_ok || null, error: db.prices_status?.error || null, last_price_date: last || null, running: false,
    held: new Set((db.trades || []).map((t) => t.isin)).size };
}

function mockPriceAt(isin, day) {
  let best = null;
  for (const p of db.prices) if (p.isin === isin && p.date <= day && (!best || p.date >= best.date)) best = p;
  const trade = db.trades.filter((t) => t.isin === isin && t.date <= day).at(-1);
  if (trade && (!best || trade.date > best.date)) return { close_eur: Math.abs(trade.value_eur_cents) / 100 / Math.abs(trade.quantity), date: trade.date, source: 'trade' };
  return best;
}

function holdingsValueAt(accountId, day) {
  const qty = {};
  for (const t of db.trades) if (t.account_id === accountId && t.date <= day) qty[t.isin] = (qty[t.isin] || 0) + t.quantity;
  let v = 0;
  for (const [isin, q] of Object.entries(qty)) if (q > 1e-9) v += Math.round(q * (mockPriceAt(isin, day)?.close_eur || 0) * 100);
  return v;
}

function holdingsOut(accountId) {
  const trades = db.trades.filter((t) => t.account_id === accountId).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  const events = db.cash_events.filter((e) => e.account_id === accountId);
  const st = {};
  for (const t of trades) {
    const s = st[t.isin] ||= { quantity: 0, cost: 0, cost_ex: 0, realised: 0, realised_ex: 0, fees: 0, bought: 0, sold: 0 };
    const amount = Math.abs(t.value_eur_cents);
    s.fees += t.fees_cents;
    if (t.quantity > 0) { s.cost += amount + t.fees_cents; s.cost_ex += amount; s.quantity += t.quantity; s.bought += amount + t.fees_cents; }
    else {
      const share = s.quantity > 0 ? Math.min(1, -t.quantity / s.quantity) : 0;
      const part = Math.round(s.cost * share); const partEx = Math.round(s.cost_ex * share);
      s.realised += amount - t.fees_cents - part; s.realised_ex += amount - partEx;
      s.cost -= part; s.cost_ex -= partEx; s.quantity += t.quantity; s.sold += amount - t.fees_cents;
    }
  }
  const divBy = {};
  for (const e of events) if (e.isin && e.kind !== 'fee') divBy[e.isin] = (divBy[e.isin] || 0) + e.amount_cents;
  let market = 0; let oldest = null;
  const holdings = Object.entries(st).map(([isin, s]) => {
    const sec = db.securities.find((x) => x.isin === isin) || { name: isin };
    const p = mockPriceAt(isin, db.today);
    const value = p && s.quantity > 0 ? Math.round(s.quantity * p.close_eur * 100) : 0;
    if (s.quantity > 0) { market += value; if (p && (!oldest || p.date < oldest)) oldest = p.date; }
    return { isin, name: sec.name, symbol: null, price_symbol: null, currency: 'EUR', quantity: Math.round(s.quantity * 1e6) / 1e6,
      avg_price_cents: s.quantity > 0 ? Math.round(s.cost / s.quantity) : null, price_cents: p ? Math.round(p.close_eur * 100) : null,
      price_date: p?.date || null, price_source: p?.source || null, value_cents: value, cost_cents: s.cost, realised_cents: s.realised,
      result_cents: value - s.cost + s.realised + (divBy[isin] || 0), price_result_cents: value - s.cost_ex + s.realised_ex,
      dividends_cents: divBy[isin] || 0, fees_cents: s.fees,
      trades: trades.filter((t) => t.isin === isin).reverse().map(({ id, date, quantity, price, currency, value_eur_cents, fees_cents, manual }) => ({ id, date, quantity, price, currency, value_eur_cents, fees_cents, manual: !!manual })) };
  }).sort((a, b) => (b.quantity > 0) - (a.quantity > 0) || b.value_cents - a.value_cents);
  const dividends = events.filter((e) => e.kind === 'dividend').reduce((s, e) => s + e.amount_cents, 0);
  const tax = -events.filter((e) => e.kind === 'dividend_tax').reduce((s, e) => s + e.amount_cents, 0);
  const feeEv = -events.filter((e) => e.kind === 'fee').reduce((s, e) => s + e.amount_cents, 0);
  const tradeFees = Object.values(st).reduce((s, x) => s + x.fees, 0);
  const netBought = Object.values(st).reduce((s, x) => s + x.bought - x.sold, 0);
  const priceResult = holdings.reduce((s, h) => s + h.price_result_cents, 0);
  const invested = netBought + feeEv;
  const result = priceResult + dividends - tax - tradeFees - feeEv;
  return { account_id: accountId, holdings, market_value_cents: market, cash_cents: 0, value_cents: market, invested_cents: invested,
    invested_source: 'trades', net_bought_cents: netBought, result_cents: result, result_pct: invested > 0 ? Math.round(result / invested * 1e4) / 1e4 : null,
    price_result_cents: priceResult, price_result_pct: invested > 0 ? Math.round(priceResult / invested * 1e4) / 1e4 : null,
    dividends_cents: dividends - tax, dividend_tax_cents: tax, costs_cents: tradeFees + feeEv, price_date: oldest,
    price_stale: !!oldest && daysBetween(oldest, db.today) > 4,
    events: events.map(({ id, date, isin, kind, amount_cents, description }) => ({ id, date, isin, kind, amount_cents, description })).reverse() };
}

function holdingsChart(accountId) {
  const trades = db.trades.filter((t) => t.account_id === accountId);
  if (!trades.length) return [];
  const first = trades.reduce((m, t) => (t.date < m ? t.date : m), trades[0].date);
  const out = [];
  for (let d = first; ; d = addDays(d, 7)) {
    const day = d > db.today ? db.today : d;
    const inv = trades.filter((t) => t.date <= day).reduce((s, t) => s - t.value_eur_cents + t.fees_cents, 0);
    out.push({ date: day, value_cents: holdingsValueAt(accountId, day), invested_cents: inv });
    if (day === db.today) break;
  }
  return out;
}
