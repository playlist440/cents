// Dutch formatting: money, dates, periods, plurals. All money is integer cents.

const eurCents = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const eurWhole = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0, minimumFractionDigits: 0 });
const numFmt = new Intl.NumberFormat('nl-NL');
const MINUS = '−';

/**
 * money(cents, opts)
 *  whole:  round to whole euros (tiles, charts, hero)
 *  signed: show "+" for money in, "−" never unless negative:true
 *  negative: show "−" for negative values (e.g. "Tekort", balances). Default: expenses unsigned.
 */
export function money(cents, { whole = false, signed = false, negative = false } = {}) {
  if (cents == null || Number.isNaN(cents)) return '';
  const abs = Math.abs(cents) / 100;
  const value = whole ? Math.round(abs) : abs;
  const text = (whole ? eurWhole : eurCents).format(value);
  if (cents > 0 && signed) return '+' + text;
  if (cents < 0 && negative && Math.round(abs) !== 0) return MINUS + text;
  return text;
}

/** Whole euros, the format for tiles, charts and hero numbers. */
export const euros = (cents, opts = {}) => money(cents, { ...opts, whole: true });

/** Compact axis label: "€ 1,2k" style is un-Dutch; use "€ 1.200" and "€ 12k" only above 10k. */
export function axisMoney(cents) {
  const e = Math.round(cents / 100);
  if (Math.abs(e) >= 10000) return '€ ' + numFmt.format(Math.round(e / 1000)) + 'k';
  return '€ ' + numFmt.format(e);
}

/** Split for Stocks-style hero: { main: "€ 1.234", frac: ",56" } */
export function moneyParts(cents) {
  const text = eurCents.format(Math.abs(cents) / 100);
  const i = text.lastIndexOf(',');
  return i === -1 ? { main: text, frac: '' } : { main: text.slice(0, i), frac: text.slice(i) };
}

export const number = (n) => numFmt.format(n);
export const percent = (fraction) => Math.round(fraction * 100) + '%';

/** Parse a Dutch amount the user typed ("12,50", "1.234", "€ 7") into cents, or null. */
export function parseAmount(text) {
  if (text == null) return null;
  let s = String(text).replace(/[€\s ]/g, '').replace(MINUS, '-');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Format cents for an editable field: 1250 -> "12,50", 1590000 -> "15.900". */
export function amountInput(cents) {
  if (cents == null) return '';
  const abs = Math.abs(cents);
  const [int, dec] = (abs % 100 === 0 ? String(abs / 100) : (abs / 100).toFixed(2)).split('.');
  return groupThousands(int) + (dec ? ',' + dec : '');
}

const groupThousands = (int) => int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/**
 * Normalise what someone types into an amount field: thousands get dots ("15.900"), a dot that is
 * not a thousands group is the decimal comma ("12.5" → "12,5"), at most two decimals.
 */
export function typedAmount(value) {
  let raw = String(value || '').replace(/[^\d,.]/g, '');
  // Only a last dot followed by at most two digits is a decimal; other dots are thousands groups.
  if (!raw.includes(',')) raw = raw.replace(/\.(\d{0,2})$/, ',$1');
  raw = raw.replace(/\./g, '');
  const [int = '', ...rest] = raw.split(',');
  const intFmt = groupThousands(int.replace(/^0+(?=\d)/, ''));
  return raw.includes(',') ? `${intFmt || '0'},${rest.join('').slice(0, 2)}` : intFmt;
}

/* ---------- Dates ---------- */

const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const MONTHS_SHORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const DAYS_SHORT = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const DAYS = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];

export { MONTHS, MONTHS_SHORT };

/** Today as ISO date in Europe/Amsterdam. */
export function todayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts; // en-CA yields YYYY-MM-DD
}

/** Parse "YYYY-MM-DD" into a UTC-noon Date (no timezone surprises). */
export function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d || 1, 12));
}
export function toISO(date) {
  return date.toISOString().slice(0, 10);
}
export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}
export function daysBetween(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}

/** "Vandaag", "Gisteren", "Morgen", "ma 3 nov", or "ma 3 nov 2025" in another year. */
export function dayLabel(iso, { today = todayISO(), long = false } = {}) {
  const diff = daysBetween(today, iso);
  if (diff === 0) return 'Vandaag';
  if (diff === -1) return 'Gisteren';
  if (diff === 1) return 'Morgen';
  const d = parseISO(iso);
  const sameYear = d.getUTCFullYear() === parseISO(today).getUTCFullYear();
  const base = long
    ? `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
    : `${DAYS_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
  return sameYear ? base : `${base} ${d.getUTCFullYear()}`;
}

/** "3 nov" (+ year when not this year). */
export function shortDate(iso, { today = todayISO() } = {}) {
  if (!iso) return '';
  const d = parseISO(iso);
  const s = `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === parseISO(today).getUTCFullYear() ? s : `${s} ${d.getUTCFullYear()}`;
}

/** "3 november 2026" */
export function longDate(iso) {
  if (!iso) return '';
  const d = parseISO(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Period id "2026-11" -> "november 2026"; {year:false} -> "november"; {short:true} -> "nov". */
export function monthLabel(periodId, { year = true, short = false } = {}) {
  const [y, m] = periodId.split('-').map(Number);
  const name = short ? MONTHS_SHORT[m - 1] : MONTHS[m - 1];
  return year ? `${name} ${y}` : name;
}

/** Month name without year when it is in the current year. */
export function monthSmart(periodId, today = todayISO()) {
  return monthLabel(periodId, { year: periodId.slice(0, 4) !== today.slice(0, 4) });
}

/** "juli 2027" from an ISO date. */
export function monthOfDate(iso) {
  return monthLabel(iso.slice(0, 7));
}

export function shiftPeriod(periodId, n) {
  const [y, m] = periodId.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

/** "over 3 dagen", "vandaag", "3 dagen geleden", "over 2 maanden". */
export function relativeDays(iso, today = todayISO()) {
  const diff = daysBetween(today, iso);
  if (diff === 0) return 'vandaag';
  if (diff === 1) return 'morgen';
  if (diff === -1) return 'gisteren';
  const abs = Math.abs(diff);
  const unit = abs >= 60 ? plural(Math.round(abs / 30), 'maand', 'maanden') : plural(abs, 'dag', 'dagen');
  return diff > 0 ? `over ${unit}` : `${unit} geleden`;
}

/** plural(3, 'winkel', 'winkels') -> "3 winkels". {bare:true} drops the number. */
export function plural(n, one, many, { bare = false } = {}) {
  const word = n === 1 ? one : many;
  return bare ? word : `${number(n)} ${word}`;
}

export function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/* ---------- Recurring frequencies (unknown values never break a screen) ---------- */

const FREQ = {
  weekly: ['per week', 'elke week'],
  '2-weekly': ['per 2 weken', 'elke 2 weken'],
  '4-weekly': ['per 4 weken', 'elke 4 weken'],
  monthly: ['per maand', 'elke maand'],
  quarterly: ['per kwartaal', 'elk kwartaal'],
  'half-year': ['per half jaar', 'elk half jaar'],
  yearly: ['per jaar', 'elk jaar'],
};

/** "per 2 weken" (style 'per') or "elke 2 weken" (style 'every'); null for unknown values. */
export function freqLabel(f, style = 'per') {
  const e = FREQ[f];
  if (!e) return null;
  return style === 'every' ? e[1] : e[0];
}
