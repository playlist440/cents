// Deterministic fictitious Dutch household for the mock API: 18 months up to "today",
// ~1,500 transactions. Every name, IBAN and amount is invented.

import { addDays, parseISO, toISO, shiftPeriod, todayISO } from '../format.js';

export const CATEGORY_TABLE = [
  ['salaris', 'Salaris', '💼', 'income', 'green'],
  ['toeslagen', 'Toeslagen & uitkeringen', '🏛️', 'income', 'mint'],
  ['inkomen-overig', 'Overig inkomen', '💶', 'income', 'teal'],
  ['wonen', 'Wonen', '🏠', 'fixed', 'indigo'],
  ['energie', 'Energie & water', '⚡', 'fixed', 'yellow'],
  ['verzekeringen', 'Verzekeringen', '🛡️', 'fixed', 'blue'],
  ['telecom', 'Internet, tv & bellen', '📶', 'fixed', 'cyan'],
  ['abonnementen', 'Abonnementen', '🔁', 'fixed', 'purple'],
  ['belastingen', 'Belastingen & gemeente', '🧾', 'fixed', 'brown'],
  ['opvang-school', 'Opvang & school', '🎒', 'fixed', 'orange'],
  ['leningen', 'Leningen', '🏦', 'fixed', 'gray'],
  ['boodschappen', 'Boodschappen', '🛒', 'daily', 'green'],
  ['uit-eten', 'Uit eten & bezorgen', '🍽️', 'daily', 'orange'],
  ['vervoer', 'Auto & vervoer', '🚗', 'daily', 'blue'],
  ['huis-tuin', 'Huis & tuin', '🛠️', 'daily', 'brown'],
  ['kleding', 'Kleding', '👕', 'daily', 'pink'],
  ['verzorging', 'Gezondheid & verzorging', '💊', 'daily', 'red'],
  ['kinderen', 'Kinderen', '🧸', 'daily', 'yellow'],
  ['vrije-tijd', 'Vrije tijd', '🎟️', 'daily', 'purple'],
  ['vakantie', 'Vakantie', '✈️', 'daily', 'cyan'],
  ['cadeaus', 'Cadeaus & goede doelen', '🎁', 'daily', 'pink'],
  ['huisdieren', 'Huisdieren', '🐾', 'daily', 'mint'],
  ['winkelen', 'Winkelen', '🛍️', 'daily', 'indigo'],
  ['contant', 'Contant', '💵', 'daily', 'gray'],
  ['overig', 'Overig', '📦', 'daily', 'gray'],
  ['sparen', 'Sparen', '🐷', 'saving', 'teal'],
  ['beleggen', 'Beleggen', '📈', 'saving', 'indigo'],
  ['intern', 'Eigen rekeningen', '🔄', 'internal', 'gray'],
  ['creditcard', 'Creditcard', '💳', 'internal', 'gray'],
  ['unsorted', 'Nog te sorteren', '❔', 'daily', 'gray'],
];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CITY = 'Amersfoort';
const ACC = { checking: 1, savings: 2, invest: 3, credit: 4 };
const IBAN = { checking: 'NL91ASNB0707070701', savings: 'NL38ASNB0707070702' };

function fakeIban(seedText) {
  let h = 7;
  for (const ch of seedText) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const banks = ['INGB', 'RABO', 'ABNA', 'TRIO', 'BUNQ'];
  return `NL${String(10 + (h % 89)).padStart(2, '0')}${banks[h % 5]}0${String(h % 1e9).padStart(9, '0')}`;
}

// Daily spending templates: [key, name, category, method, perMonth, min, max, opts]
const DAILY = [
  ['albert heijn', 'Albert Heijn', 'boodschappen', 'card', 11, 14, 96, { mcc: '5411' }],
  ['jumbo', 'Jumbo', 'boodschappen', 'card', 5, 9, 72, { mcc: '5411' }],
  ['ah to go', 'AH to go', 'boodschappen', 'card', 3, 3, 12, { mcc: '5411' }],
  ['coffee company', 'Coffee Company', 'uit-eten', 'card', 3, 4, 11, { mcc: '5814' }],
  ['lidl', 'Lidl', 'boodschappen', 'card', 2, 16, 58, { mcc: '5411' }],
  ['bakkerij van rijn', 'Bakkerij Van Rijn', 'boodschappen', 'card', 2.2, 4, 15, { mcc: '5462' }],
  ['shell', 'Shell', 'vervoer', 'card', 1.8, 52, 86, { mcc: '5541' }],
  ['tango', 'Tango', 'vervoer', 'card', 1, 48, 78, { mcc: '5541' }],
  ['ns', 'NS', 'vervoer', 'card', 1.1, 6, 38, { mcc: '4111' }],
  ['q park', 'Q-Park', 'vervoer', 'card', 0.8, 3, 14, { mcc: '7523' }],
  ['thuisbezorgd', 'Thuisbezorgd', 'uit-eten', 'ideal', 1.8, 21, 49, {}],
  ['brasserie de haven', 'Brasserie De Haven', 'uit-eten', 'card', 0.7, 46, 118, { mcc: '5812' }],
  ['la place', 'La Place', 'uit-eten', 'card', 0.8, 11, 32, { mcc: '5814' }],
  ['kruidvat', 'Kruidvat', 'verzorging', 'card', 2.5, 5, 31, { mcc: '5912' }],
  ['etos', 'Etos', 'verzorging', 'card', 0.8, 4, 26, { mcc: '5912' }],
  ['apotheek de linde', 'Apotheek De Linde', 'verzorging', 'card', 0.35, 7, 32, { mcc: '5912' }],
  ['zalando', 'Zalando', 'kleding', 'ideal', 0.6, 29, 124, {}],
  ['h m', 'H&M', 'kleding', 'card', 0.5, 19, 72, { mcc: '5651' }],
  ['praxis', 'Praxis', 'huis-tuin', 'card', 0.6, 12, 118, { mcc: '5200' }],
  ['ikea', 'IKEA', 'huis-tuin', 'card', 0.25, 38, 260, { mcc: '5712' }],
  ['action', 'Action', 'winkelen', 'card', 2.2, 4, 36, { mcc: '5331' }],
  ['bol', 'Bol', 'winkelen', 'ideal', 1.2, 11, 92, {}],
  ['hema', 'HEMA', 'winkelen', 'card', 0.9, 5, 32, { mcc: '5311' }],
  ['intertoys', 'Intertoys', 'kinderen', 'card', 0.35, 14, 64, { mcc: '5945' }],
  ['pathe', 'Pathé', 'vrije-tijd', 'card', 0.45, 24, 48, { mcc: '7832' }],
  ['pets place', 'Pets Place', 'huisdieren', 'card', 0.9, 14, 46, { mcc: '5995' }],
  ['geldautomaat', 'Geldautomaat', 'contant', 'atm', 0.5, 50, 50, { round: true }],
];

// Fixed and recurring: [key, name, category, method, day, amount(€), opts]
//   opts.months: only in these calendar months (1-12); opts.change: [periodOffset, newAmount]
//   opts.since: start offset (months before now); opts.until: stops at offset
const RECURRING = [
  ['florius', 'Florius', 'wonen', 'debit', 1, 1148.22, {}],
  ['zilveren kruis', 'Zilveren Kruis', 'verzekeringen', 'debit', 1, 312.6, { change: [-10, 321.4] }],
  ['kinderopvang het kasteel', 'Kinderopvang Het Kasteel', 'opvang-school', 'debit', 2, 612, {}],
  ['spotify', 'Spotify', 'abonnementen', 'debit', 5, 17.99, {}],
  ['netflix', 'Netflix', 'abonnementen', 'debit', 12, 13.99, { change: [-3, 15.99] }],
  ['duo', 'DUO', 'leningen', 'debit', 15, 96, {}],
  ['odido', 'Odido', 'telecom', 'debit', 18, 27.5, {}],
  ['vitens', 'Vitens', 'energie', 'debit', 20, 21.4, {}],
  ['ziggo', 'Ziggo', 'telecom', 'debit', 23, 67.5, {}],
  ['centraal beheer', 'Centraal Beheer', 'verzekeringen', 'debit', 25, 64.18, {}],
  ['basic fit', 'Basic-Fit', 'abonnementen', 'debit', 27, 29.99, {}],
  ['vattenfall', 'Vattenfall', 'energie', 'debit', 28, 178, { change: [-10, 194] }],
  ['zwemschool de spetter', 'Zwemschool De Spetter', 'kinderen', 'debit', 8, 42.5, {}],
  ['kwf', 'KWF', 'cadeaus', 'debit', 10, 10, {}],
  ['gemeente amersfoort', 'Gemeente Amersfoort', 'belastingen', 'debit', 28, 61.3, { months: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }],
  ['belastingdienst', 'Belastingdienst', 'belastingen', 'debit', 3, 134, { months: [1, 4, 7, 10] }],
  ['anwb', 'ANWB', 'verzekeringen', 'debit', 14, 89, { months: [1] }],
  ['obs de regenboog', 'OBS De Regenboog', 'opvang-school', 'debit', 6, 60, { months: [10] }],
  ['disney plus', 'Disney+', 'abonnementen', 'debit', 9, 10.99, { since: -2 }],
  ['videoland', 'Videoland', 'abonnementen', 'debit', 7, 9.99, { until: -5 }],
];

const INCOME = [
  ['noordhoek techniek', 'Noordhoek Techniek', 'salaris', 24, 3412.18],
  ['stichting eemzorg', 'Stichting Eemzorg', 'salaris', 25, 1986.4],
  ['belastingdienst', 'Belastingdienst', 'toeslagen', 20, 384],
];

const UNSORTED = [
  ['sportcafe de kuil', 'Sportcafé De Kuil', 'card', [3, 4], 14, 46, ['uit-eten', 'vrije-tijd']],
  ['tuinderij zonnehoeve', 'Tuinderij Zonnehoeve', 'card', [3], 8, 24, ['boodschappen', 'huis-tuin']],
  ['speeltuin het wilgje', 'Speeltuin Het Wilgje', 'card', [2], 6, 18, ['kinderen', 'vrije-tijd']],
  ['kringloop de ruil', 'Kringloop De Ruil', 'card', [2], 5, 38, ['winkelen', 'huis-tuin']],
  ['muziekschool eemland', 'Muziekschool Eemland', 'debit', [1], 38, 38, ['kinderen', 'vrije-tijd']],
  ['cafetaria t hoekje', "Cafetaria 't Hoekje", 'card', [4], 9, 27, ['uit-eten']],
  ['viswinkel klaas', 'Viswinkel Klaas', 'card', [2], 11, 29, ['boodschappen', 'uit-eten']],
  ['boekhandel van dijk', 'Boekhandel Van Dijk', 'card', [2], 12, 34, ['winkelen', 'vrije-tijd', 'cadeaus']],
  ['fietsenmaker snel', 'Fietsenmaker Snel', 'card', [1], 24, 89, ['vervoer']],
  ['ijssalon venezia', 'IJssalon Venezia', 'card', [2], 6, 15, ['uit-eten']],
  ['parkeren centrum', 'Parkeren Centrum', 'card', [2], 3, 8, ['vervoer']],
  ['p:m jansen', 'M. Jansen', 'transfer', [2], 15, 60, []],
  ['p:a visser', 'A. Visser', 'transfer', [1], 25, 25, []],
  ['bloemenkiosk flora', 'Bloemenkiosk Flora', 'card', [2], 8, 22, ['cadeaus', 'huis-tuin']],
  ['via:tikkie', 'Tikkie', 'ideal', [2], 6, 28, []],
];

export const TAGS = [
  { id: 1, name: 'Verbouwing badkamer', emoji: '🛁', color: 'blue' },
  { id: 2, name: 'Vakantie Frankrijk', emoji: '🇫🇷', color: 'cyan' },
  { id: 3, name: 'Verjaardag Sem', emoji: '🎂', color: 'pink' },
  { id: 4, name: 'Sinterklaas', emoji: '🎁', color: 'red' },
];

export function generate({ today = todayISO(), empty = false } = {}) {
  const r = rng(20261114);
  const between = (a, b) => a + r() * (b - a);
  const cents = (a, b, round) => (round ? Math.round(between(a, b) / 10) * 1000 : Math.round(between(a, b) * 100));
  const pick = (arr) => arr[Math.floor(r() * arr.length)];

  const categories = CATEGORY_TABLE.map(([key, name, emoji, grp, color], i) => ({
    id: i + 1, key, name, emoji, color, grp, sort: i + 1, hidden: 0, builtin: 1,
  }));
  const cat = Object.fromEntries(categories.map((c) => [c.key, c.id]));

  const db = {
    today,
    settings: { month_start_day: 1, household_name: 'Gezin' },
    categories,
    tags: TAGS.map((t) => ({ ...t, archived: 0, created_at: '2025-06-01' })),
    accounts: [],
    transactions: [],
    tx_tags: [],
    rules: [],
    goals: [],
    goal_entries: [],
    account_values: [],
    securities: [],
    trades: [],
    cash_events: [],
    prices: [],
    prices_status: { last_ok: null, error: null },
    imports: [],
    recurring_ignored: empty ? [] : ['kwf|out|monthly|10'],
    mortgage_parts: [],
    mortgage_years: [],
    home_values: [],
    assets: [], // pension, debt, other possessions (SPEC §7.3): none by default, added via +
    asset_entries: [],
    seq: { tx: 0, rule: 0, goal: 0, entry: 0, value: 0, import: 0, trade: 0, account: 5, category: categories.length, tag: TAGS.length },
  };
  if (empty) return db;

  db.accounts = [
    { id: 1, iban: IBAN.checking, name: 'Betaalrekening', type: 'checking', match: [], manual_balance_cents: null, manual_balance_date: null, hidden: 0, sort: 1, created_at: '2025-05-02' },
    { id: 2, iban: IBAN.savings, name: 'Spaarrekening', type: 'savings', match: ['spaarrekening'], manual_balance_cents: null, manual_balance_date: null, hidden: 0, sort: 2, created_at: '2025-05-02' },
    { id: 3, iban: null, name: 'Beleggen', type: 'investment', match: ['meesman'], manual_balance_cents: null, manual_balance_date: null, hidden: 0, sort: 3, created_at: '2025-06-10' },
    { id: 4, iban: null, name: 'Creditcard', type: 'credit', match: ['international card services', 'ics'], manual_balance_cents: null, manual_balance_date: null, hidden: 0, sort: 4, created_at: '2025-06-10' },
    { id: 5, iban: null, name: 'DEGIRO', type: 'investment', match: ['degiro', 'flatex'], manual_balance_cents: null, manual_balance_date: null, hidden: 0, sort: 5, created_at: '2025-06-10' },
  ];

  const nowPeriod = today.slice(0, 7);
  const firstPeriod = shiftPeriod(nowPeriod, -17);
  const lastDataDay = addDays(today, -2);
  const txs = [];

  const add = (t) => {
    if (t.date > lastDataDay) return null;
    const tx = {
      id: 0, account_id: ACC.checking, date: t.date, value_date: t.date, amount_cents: t.amount,
      balance_after_cents: null, merchant_name: t.name, merchant_key: t.key,
      counterparty_name: t.counterparty ?? (t.method === 'card' || t.method === 'atm' ? null : t.name),
      counterparty_iban: t.iban ?? (t.method === 'card' || t.method === 'atm' ? null : fakeIban(t.key)),
      description: t.description ?? t.name, raw_description: t.raw ?? null,
      method: t.method, city: t.city ?? (t.method === 'card' ? CITY : null),
      category_id: cat[t.cat], category_source: t.source ?? 'merchant',
      kind: t.kind ?? 'normal', transfer_account_id: t.transfer ?? null, goal_id: t.goal ?? null,
      note: t.note ?? null, manual: t.manual ?? 0, mcc: t.mcc ?? null, tags: t.tags ?? [],
      pay_type: t.method === 'card' ? 'BEA' : t.method === 'ideal' ? 'IDE' : t.method === 'debit' ? 'EIC' : 'OVS',
      bank_code: null, wallet: t.method === 'card' && r() < 0.6 ? 'Apple Pay' : null,
      bank_category: null, mandate_id: t.method === 'debit' ? 'M' + fakeIban(t.key).slice(-8) : null,
      import_id: null,
    };
    if (t.account) tx.account_id = t.account;
    if (!tx.raw_description) tx.raw_description = rawFor(tx);
    txs.push(tx);
    return tx;
  };

  const rawFor = (tx) => {
    const d = parseISO(tx.date);
    const dd = `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
    if (tx.method === 'card') return `${tx.merchant_name.toUpperCase()} >${(tx.city || CITY).toUpperCase()} ${dd} ${10 + (tx.amount_cents % 11)}U${String(Math.abs(tx.amount_cents) % 60).padStart(2, '0')} KV002 MCC:${tx.mcc || '5999'} ${tx.wallet ? tx.wallet + ' betaling' : 'Contactloos'}   NLNEDERLAND`;
    if (tx.method === 'debit') return `Europese incasso: ${tx.merchant_name} termijn ${dd.slice(3)}-Incassant ID: NL00ZZZ${fakeIban(tx.merchant_key).slice(-12)}-Kenmerk Machtiging: ${tx.mandate_id}`;
    if (tx.method === 'ideal') return `${Math.abs(tx.amount_cents) * 7 % 100000000} ${tx.merchant_name} bestelling ${Math.abs(tx.amount_cents) % 9999} Referentie: ${dd} ${tx.merchant_key.length}`;
    return tx.description;
  };

  const monthDays = (period) => {
    const [y, m] = period.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  };
  const dateIn = (period, day) => `${period}-${String(Math.min(day, monthDays(period))).padStart(2, '0')}`;

  for (let off = -17; off <= 0; off++) {
    const period = shiftPeriod(nowPeriod, off);
    const month = Number(period.slice(5));
    const nDays = monthDays(period);
    const summer = month === 7 || month === 8;
    const december = month === 12;

    // Income
    for (const [key, name, c, day, amount] of INCOME) {
      const a = Math.round(amount * 100) + (c === 'salaris' ? Math.round(between(-1200, 1200)) : 0);
      add({ date: dateIn(period, day), amount: a, name, key, cat: c, method: 'transfer', description: c === 'salaris' ? `Salaris ${period}` : 'Kinderopvangtoeslag' });
    }
    if (month === 5) {
      add({ date: dateIn(period, 24), amount: 260412, name: 'Noordhoek Techniek', key: 'noordhoek techniek', cat: 'salaris', method: 'transfer', description: 'Vakantiegeld' });
    }
    if ([1, 4, 7, 10].includes(month)) {
      add({ date: dateIn(period, 4), amount: 57436, name: 'SVB', key: 'svb', cat: 'toeslagen', method: 'transfer', description: 'Kinderbijslag' });
    }
    if (r() < 0.25) {
      add({ date: dateIn(period, 3 + Math.floor(r() * 24)), amount: cents(15, 120), name: 'Marktplaats', key: 'marktplaats', cat: 'inkomen-overig', method: 'transfer', description: 'Verkoop Marktplaats' });
    }

    // Fixed / recurring
    for (const [key, name, c, method, day, amount, o] of RECURRING) {
      if (o.months && !o.months.includes(month)) continue;
      if (o.since !== undefined && off < o.since) continue;
      if (o.until !== undefined && off > o.until) continue;
      const amt = o.change && off >= o.change[0] ? o.change[1] : amount;
      add({ date: dateIn(period, day), amount: -Math.round(amt * 100), name, key, cat: c, method, description: `${name} ${period}` });
    }

    // Daily spending
    for (const [key, name, c, method, perMonth, min, max, o] of DAILY) {
      let rate = perMonth;
      if (summer && (c === 'uit-eten' || c === 'vrije-tijd')) rate *= 1.5;
      if (december && (c === 'winkelen' || c === 'kinderen')) rate *= 2;
      const n = Math.floor(rate) + (r() < rate % 1 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const day = 1 + Math.floor(r() * nDays);
        add({ date: dateIn(period, day), amount: -cents(min, max, o.round), name, key, cat: c, method, mcc: o.mcc, source: o.mcc && r() < 0.3 ? 'mcc' : 'merchant' });
      }
    }

    // Seasonal
    if (month === 7) {
      add({ date: dateIn(period, 2), amount: -124900, name: 'Camping Les Pins', key: 'camping les pins', cat: 'vakantie', method: 'ideal', tags: [2], city: null });
      for (let i = 0; i < 6; i++) {
        add({ date: dateIn(period, 12 + i * 2), amount: -cents(18, 92), name: pick(['Carrefour', 'Boulangerie Martin', 'Le Petit Port', 'TotalEnergies']), key: 'fr ' + i % 4, cat: 'vakantie', method: 'card', city: 'Bordeaux', tags: [2], mcc: '5812' });
      }
    }
    if (month === 3) add({ date: dateIn(period, 11), amount: -48600, name: 'Booking.com', key: 'booking com', cat: 'vakantie', method: 'ideal' });
    if (month === 12) {
      add({ date: dateIn(period, 3), amount: -cents(60, 140), name: 'Intertoys', key: 'intertoys', cat: 'cadeaus', method: 'card', tags: [4], mcc: '5945' });
      add({ date: dateIn(period, 18), amount: -cents(80, 160), name: 'Bol', key: 'bol', cat: 'cadeaus', method: 'ideal' });
    }
    if (month === 9) {
      add({ date: dateIn(period, 14), amount: -cents(40, 90), name: 'Intertoys', key: 'intertoys', cat: 'kinderen', method: 'card', tags: [3], mcc: '5945' });
      add({ date: dateIn(period, 15), amount: -cents(30, 70), name: 'HEMA', key: 'hema', cat: 'kinderen', method: 'card', tags: [3], mcc: '5311' });
    }
    // Bathroom renovation 4-6 months ago
    if (off >= -6 && off <= -4) {
      add({ date: dateIn(period, 6 + Math.floor(r() * 5)), amount: -cents(180, 640), name: 'Praxis', key: 'praxis', cat: 'huis-tuin', method: 'card', tags: [1], mcc: '5200' });
      add({ date: dateIn(period, 14 + Math.floor(r() * 8)), amount: -cents(240, 980), name: 'Tegelhandel Van Os', key: 'tegelhandel van os', cat: 'huis-tuin', method: 'ideal', tags: [1] });
    }

    // Savings and investments
    add({ date: dateIn(period, 26), amount: -30000, name: 'Spaarrekening', key: 'spaarrekening', cat: 'sparen', method: 'internal', kind: 'transfer', transfer: ACC.savings, iban: IBAN.savings, description: 'Vakantie 48213', counterparty: 'Spaarrekening' });
    add({ date: dateIn(period, 26), amount: -15000, name: 'Spaarrekening', key: 'spaarrekening', cat: 'sparen', method: 'internal', kind: 'transfer', transfer: ACC.savings, iban: IBAN.savings, description: 'Buffer 61735', counterparty: 'Spaarrekening' });
    if (off >= -9) add({ date: dateIn(period, 27), amount: -15000, name: 'Meesman Indexbeleggen', key: 'meesman', cat: 'beleggen', method: 'transfer', kind: 'transfer', transfer: ACC.invest, description: 'Inleg Meesman' });
    if (month === 7) add({ date: dateIn(period, 1), amount: 80000, name: 'Spaarrekening', key: 'spaarrekening', cat: 'sparen', method: 'internal', kind: 'transfer', transfer: ACC.savings, iban: IBAN.savings, description: 'Vakantie 48213 terug', counterparty: 'Spaarrekening' });
    if (off >= -5 && off % 2 === 0) add({ date: dateIn(period, 12), amount: -5000, name: 'Spaarrekening', key: 'spaarrekening', cat: 'sparen', method: 'internal', kind: 'transfer', transfer: ACC.savings, iban: IBAN.savings, description: 'Fiets', counterparty: 'Spaarrekening' });

    // Credit card: manual purchases and the monthly settlement
    const ccPurchases = [];
    if (off >= -12) {
      const n = 2 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) {
        const [name, key, c] = pick([['Amazon', 'amazon', 'winkelen'], ['Booking.com', 'booking com', 'vakantie'], ['Coolblue', 'coolblue', 'huis-tuin'], ['Uber', 'uber', 'vervoer'], ['Apple', 'apple', 'abonnementen']]);
        const tx = add({ date: dateIn(period, 2 + Math.floor(r() * 25)), amount: -cents(9, 140), name, key, cat: c, method: 'card', account: ACC.credit, manual: 1, source: 'user', city: null });
        if (tx) ccPurchases.push(tx);
      }
    }
    if (off >= -11) {
      const prev = shiftPeriod(period, -1);
      const prevSum = txs.filter((t) => t.account_id === ACC.credit && t.date.startsWith(prev)).reduce((s, t) => s + t.amount_cents, 0);
      add({ date: dateIn(period, 24), amount: prevSum - cents(20, 60), name: 'International Card Services', key: 'international card services', cat: 'creditcard', method: 'debit', kind: 'settlement', transfer: ACC.credit, description: 'ICS creditcard incasso', source: 'rule' });
    }

    // Unsorted merchants appear in the last three months
    if (off >= -2) {
      for (const [key, name, method, counts, min, max] of UNSORTED) {
        const n = counts[0] - (off === -2 ? 1 : 0);
        for (let i = 0; i < n; i++) {
          const amount = key.startsWith('p:') && r() < 0.4 ? cents(min, max) : -cents(min, max);
          add({ date: dateIn(period, 1 + Math.floor(r() * nDays)), amount, name, key, cat: 'unsorted', method, source: 'none', mcc: method === 'card' ? '5999' : null, description: key.startsWith('p:') || key.startsWith('via:') ? 'Tikkie ' + pick(['etentje', 'kado', 'uitje', 'bioscoop']) : name });
        }
      }
    }
  }

  // Every two weeks (window cleaner) and every four weeks (cleaning help): the 2-weekly and
  // 4-weekly frequencies. Fixed amounts, no random draws (keeps the rest of the data stable).
  for (let d = `${firstPeriod}-04`, i = 0; d <= lastDataDay; d = addDays(d, 14), i++) {
    add({ date: d, amount: -2250, name: 'Glazenwasser Brink', key: 'glazenwasser brink', cat: 'huis-tuin', method: 'transfer', description: 'Glazenwassen' });
    if (i % 2 === 0) add({ date: addDays(d, 3), amount: -8400, name: 'Schoonmaakhulp Anja', key: 'schoonmaakhulp anja', cat: 'huis-tuin', method: 'transfer', description: 'Schoonmaak 4 weken' });
  }

  // Sort chronologically, assign ids and bank sequence, compute checking balances.
  txs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.amount_cents - b.amount_cents));
  let bal = 240000;
  let monthEnd = null;
  const extra = [];
  for (const tx of txs) {
    if (tx.account_id !== ACC.checking) continue;
    const p = tx.date.slice(0, 7);
    if (monthEnd && p !== monthEnd && bal > 420000) {
      // Month rollover: sweep surplus to savings (left unassigned to any potje).
      const sweep = Math.floor((bal - 280000) / 10000) * 10000;
      bal -= sweep;
      extra.push({ date: addDays(`${p}-01`, -1), amount: -sweep, bal });
    }
    monthEnd = p;
    bal += tx.amount_cents;
    tx.balance_after_cents = bal;
  }
  for (const e of extra) {
    const tx = add({ date: e.date, amount: e.amount, name: 'Spaarrekening', key: 'spaarrekening', cat: 'sparen', method: 'internal', kind: 'transfer', transfer: ACC.savings, iban: IBAN.savings, description: 'Overboeking naar spaarrekening', counterparty: 'Spaarrekening' });
    if (tx) tx.balance_after_cents = e.bal;
  }

  // Mirror transfers on the savings account (+ quarterly interest).
  const mirrors = [];
  for (const tx of txs) {
    if (tx.transfer_account_id === ACC.savings && tx.account_id === ACC.checking) {
      mirrors.push({ ...tx, account_id: ACC.savings, amount_cents: -tx.amount_cents, transfer_account_id: ACC.checking, counterparty_iban: IBAN.checking, counterparty_name: 'Betaalrekening', merchant_name: 'Betaalrekening', merchant_key: 'betaalrekening', category_id: cat.intern, tags: [], balance_after_cents: null });
    }
  }
  txs.push(...mirrors);
  for (let off = -17; off <= 0; off++) {
    const period = shiftPeriod(nowPeriod, off);
    if (['01', '04', '07', '10'].includes(period.slice(5))) {
      const tx = add({ date: `${period}-01`, amount: 1200 + Math.round(r() * 1800), name: 'Rente', key: 'rente', cat: 'inkomen-overig', method: 'interest', account: ACC.savings, description: 'Rente spaarrekening', source: 'heuristic', counterparty: null, iban: null });
      if (tx) tx.counterparty_iban = null;
    }
  }

  txs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let sbal = 310000;
  txs.forEach((t, i) => {
    t.id = i + 1;
    t.seq = i + 1;
    if (t.account_id === ACC.savings) { sbal += t.amount_cents; t.balance_after_cents = sbal; }
  });
  db.seq.tx = txs.length;
  db.transactions = txs;
  db.tx_tags = txs.flatMap((t) => t.tags.map((tag) => [t.id, tag]));
  txs.forEach((t) => delete t.tags);

  // Imports: one ASN CSV per month, the latest two days ago.
  for (let off = -17; off <= 0; off++) {
    const period = shiftPeriod(nowPeriod, off);
    const id = ++db.seq.import;
    const inMonth = txs.filter((t) => t.account_id !== ACC.credit && t.date.startsWith(period));
    inMonth.forEach((t) => { t.import_id = id; });
    const last = off === 0 ? lastDataDay : addDays(`${shiftPeriod(period, 1)}-01`, 1);
    db.imports.push({ id, filename: `asn-${period}.csv`, format: 'asn_csv', imported_at: `${last}T20:14:00`, account_id: 1, n_new: inMonth.length, n_duplicate: off === 0 ? 0 : 3, n_enriched: 0, date_from: `${period}-01`, date_to: inMonth.at(-1)?.date || `${period}-01` });
  }

  // Goals and their entries
  const goal = (g) => { db.goals.push({ id: ++db.seq.goal, archived: 0, sort: db.seq.goal, created_at: firstPeriod + '-15', keywords: [], ...g }); return db.seq.goal; };
  const gVak = goal({ name: 'Vakantie 2027', emoji: '✈️', color: 'cyan', target_cents: 300000, target_date: '2027-07-01', repeat: 'none', code: '48213' });
  const gBuf = goal({ name: 'Buffer', emoji: '🛟', color: 'teal', target_cents: 930000, target_date: null, repeat: 'none', code: '61735' });
  const gFiets = goal({ name: 'Nieuwe fiets', emoji: '🚲', color: 'orange', target_cents: 145000, target_date: '2027-03-01', repeat: 'none', code: '27450', keywords: ['fiets'] });
  const gKerst = goal({ name: 'Kerst', emoji: '🎄', color: 'red', target_cents: 40000, target_date: `${today.slice(0, 4)}-12-15`, repeat: 'yearly', code: '39018' });
  // A potje whose date passed before it was full (status "overdue").
  const gRij = goal({ name: 'Rijbewijs', emoji: '🚗', color: 'indigo', target_cents: 180000, target_date: `${shiftPeriod(nowPeriod, -1)}-01`, repeat: 'none', code: '73306' });
  const entry = (goal_id, date, amount_cents, kind, transaction_id = null, note = null) =>
    db.goal_entries.push({ id: ++db.seq.entry, goal_id, date, amount_cents, kind, note, transaction_id });

  let vakSaldo = 0;
  for (const t of txs) {
    if (t.account_id !== ACC.checking || t.transfer_account_id !== ACC.savings) continue;
    const amt = -t.amount_cents;
    if (/48213/.test(t.description)) {
      // the vacation potje restarts after last summer
      entry(gVak, t.date, amt, 'auto', t.id); t.goal_id = gVak; vakSaldo += amt;
    } else if (/61735/.test(t.description)) { entry(gBuf, t.date, amt, 'auto', t.id); t.goal_id = gBuf; }
    else if (/fiets/i.test(t.description)) { entry(gFiets, t.date, amt, 'auto', t.id); t.goal_id = gFiets; }
  }
  entry(gVak, `${shiftPeriod(nowPeriod, -4)}-01`, -Math.max(0, vakSaldo - 105000), 'adjust', null, 'Na de zomer opnieuw begonnen');
  entry(gBuf, `${firstPeriod}-15`, 300000, 'manual', null, 'Startbedrag');
  entry(gFiets, `${shiftPeriod(nowPeriod, -6)}-02`, 20000, 'manual');
  entry(gKerst, `${shiftPeriod(nowPeriod, -8)}-02`, 25000, 'manual');
  entry(gKerst, `${shiftPeriod(nowPeriod, -2)}-02`, 15000, 'manual');
  entry(gRij, `${shiftPeriod(nowPeriod, -7)}-05`, 90000, 'manual', null, 'Verjaardagsgeld');
  entry(gRij, `${shiftPeriod(nowPeriod, -3)}-05`, 40000, 'manual');

  // Investment valuations
  const investIn = txs.filter((t) => t.transfer_account_id === ACC.invest);
  let invested = 0;
  for (let off = -9; off <= 0; off += 3) {
    const period = shiftPeriod(nowPeriod, off);
    invested = investIn.filter((t) => t.date <= `${period}-28`).reduce((s, t) => s - t.amount_cents, 0);
    if (invested > 0) db.account_values.push({ id: ++db.seq.value, account_id: ACC.invest, date: `${period}-28` > lastDataDay ? lastDataDay : `${period}-28`, value_cents: Math.round(invested * (1.02 + (off + 9) * 0.009)) });
  }

  // DEGIRO holdings (fictitious export): monthly buys of two broad ETFs, daily-ish prices
  degiroHoldings(db, nowPeriod, lastDataDay);

  // A few learned rules
  for (const key of ['albert heijn', 'thuisbezorgd', 'international card services', 'zwemschool de spetter']) {
    const t = txs.find((x) => x.merchant_key === key);
    if (t) db.rules.push({ id: ++db.seq.rule, merchant_key: key, category_id: t.category_id, tag_id: null, created_at: '2025-08-01' });
  }

  db.suggestions = [{ key: 'savings:NL55ASNB0707074417', type: 'savings', iban: 'NL55ASNB0707074417', name: 'Kinderrekening' }];
  db.unsortedSuggestions = Object.fromEntries(UNSORTED.map((u) => [u[0], u[6].map((k) => cat[k])]));
  // Fictitious mortgage (SPEC §7.2): two parts, the statement of last year (the only one a
  // household has before spring), one WOZ value. The monthly payment to Florius is the linked direct debit.
  const y = Number(today.slice(0, 4));
  db.mortgage_parts = [{ id: 1, name: 'Deel 1 – annuïtair', sort: 0 }, { id: 2, name: 'Deel 2 – aflossingsvrij', sort: 1 }];
  db.mortgage_years = [
    { part_id: 1, year: y - 1, debt_end_cents: 23814600, interest_cents: 602000, repaid_cents: 541000 },
    { part_id: 2, year: y - 1, debt_end_cents: 6000000, interest_cents: 234000, repaid_cents: 0 },
  ];
  db.home_values = [{ id: 1, date: `${y}-01-01`, value_cents: 43100000 }];
  db.seq.home = 1;
  db.seq.part = 2;
  return db;
}

/* DEGIRO demo: public ISINs of two broad ETFs, made-up quantities and prices. */
function degiroHoldings(db, nowPeriod, lastDataDay) {
  const funds = [
    { isin: 'IE00B3RBWM25', name: 'VANGUARD FTSE ALL-WORLD UCITS ETF', base: 108, drift: 0.0075, amp: 0.035, every: 1, qty: 2 },
    { isin: 'IE00B4L5Y983', name: 'ISHARES CORE MSCI WORLD UCITS ETF', base: 86, drift: 0.008, amp: 0.04, every: 3, qty: 3 },
  ];
  const start = shiftPeriod(nowPeriod, -14);
  const priceAt = (f, iso) => {
    const days = (parseISO(iso) - parseISO(`${start}-01`)) / 86400000;
    return Math.round(f.base * (1 + f.drift * days / 30.4) * (1 + f.amp * Math.sin(days / 23) + 0.012 * Math.sin(days / 3.1)) * 100) / 100;
  };
  for (const f of funds) {
    db.securities.push({ isin: f.isin, name: f.name, symbol: null, currency: 'EUR', exchange: 'EAM', price_symbol: null });
    for (let off = -14; off <= 0; off += f.every) {
      const day = `${shiftPeriod(nowPeriod, off)}-0${f.every === 1 ? 5 : 6}`;
      if (day > lastDataDay) continue;
      const price = priceAt(f, day);
      db.trades.push({ id: ++db.seq.trade, account_id: 5, date: day, isin: f.isin, quantity: f.qty, price, currency: 'EUR', value_eur_cents: -Math.round(f.qty * price * 100), fees_cents: f.every === 1 ? 100 : 200, manual: false });
    }
    for (let d = `${start}-01`; d <= lastDataDay; d = addDays(d, 1)) {
      const wd = parseISO(d).getDay();
      if (wd === 0 || wd === 6) continue;
      db.prices.push({ isin: f.isin, date: d, close_eur: priceAt(f, d), source: 'yahoo' });
    }
  }
  for (let off = -12; off <= 0; off += 3) {
    const day = `${shiftPeriod(nowPeriod, off)}-20`;
    if (day > lastDataDay) continue;
    db.cash_events.push({ id: db.cash_events.length + 1, account_id: 5, date: day, isin: 'IE00B3RBWM25', kind: 'dividend', amount_cents: 600 + (off + 12) * 40, description: 'Dividend' });
    db.cash_events.push({ id: db.cash_events.length + 1, account_id: 5, date: day, isin: 'IE00B3RBWM25', kind: 'dividend_tax', amount_cents: -Math.round((600 + (off + 12) * 40) * 0.15), description: 'Dividendbelasting' });
  }
  db.cash_events.push({ id: db.cash_events.length + 1, account_id: 5, date: `${nowPeriod.slice(0, 4)}-01-02`, isin: null, kind: 'fee', amount_cents: -250, description: 'DEGIRO Aansluitingskosten' });
  db.prices_status = { last_ok: `${lastDataDay}T17:45:00Z`, error: null };
}
