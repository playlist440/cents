// Slimme aannames (SPEC §13, #/instellingen/aannames): everything the app assumed, each on one
// row with a switch or an undo action. Salary series, account soorten (import or own choice),
// suggested month start day, Nog te besteden (salarisdag, buffer, ondergrens betaalrekening), the
// small-amount split at fuel stations, ignored vaste lasten,
// learned potje links, insight kinds, automatic prices of funds, and a link to Geleerde regels.
// iPhone: a pushed screen; Mac: a section of the Instellingen split.

import { html, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useQuery, useStore, invalidate } from '../store.js';
import { navigate } from '../router.js';
import { money, euros, freqLabel, plural, shortDate } from '../format.js';
import { Screen } from '../components/Screen.js';
import { List, ListRow } from '../components/List.js';
import { Button, Switch } from '../components/Controls.js';
import { Skeleton, EmptyState } from '../components/Feedback.js';
import { openMenu } from '../components/Menu.js';
import { toast } from '../components/Toast.js';
import { Icon } from '../icons.js';
import { useLayout } from '../hooks.js';
import { commitLater, usePending } from './_kit.js';
import { InstSplit } from './instellingen.js';

const TYPE_LABEL = { checking: 'Betaalrekening', savings: 'Spaarrekening', investment: 'Beleggingen', credit: 'Creditcard' };
const FLOOR_STEPS = [0, 5000, 10000, 25000, 50000, 100000, 150000, 200000];
const BUFFER_MONTHS = [0, 1, 2, 3, 4, 6, 9, 12];
const BUFFER_AMOUNTS = [100000, 250000, 500000, 1000000];
const FUEL_STEPS = [100, 200, 300, 500, 750, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000];

// Plain-language names for a few insight kinds (the server labels are kept for the rest).
const KIND_LABEL = { stale: 'Herinner me aan importeren', duplicate: 'Twee keer afgeschreven' };

const fail = (err) => toast({ text: err.message, icon: 'warning' });

export function Aannames() {
  const desk = useLayout() === 'wide';
  const a = useQuery('assumptions', () => api.assumptions());
  const st = useQuery('settings', () => api.settings());
  const pending = usePending();
  const body = !a.data
    ? (a.error ? html`<${EmptyState} emoji="🧠" title="Laadt niet" subtitle=${a.error.message} action=${{ label: 'Probeer opnieuw', variant: 'tinted', onClick: () => a.reload() }} />`
      : html`<div class="inset" aria-busy="true" aria-label="Laden">${[0, 1, 2, 3].map(() => html`<div class="row"><span class="row-main"><${Skeleton} w="50%" h=${15} /></span></div>`)}</div>`)
    : html`<${Content} a=${a.data} settings=${st.data} pending=${pending} />`;
  return html`<${Screen} title="Slimme aannames" back=${desk ? false : { to: '/instellingen', label: 'Terug' }} class="inst sa">
    ${desk ? html`<${InstSplit} active="aannames">${body}</${InstSplit}>` : body}
  </${Screen}>`;
}

function Content({ a, settings, pending }) {
  const boot = useStore((s) => s.boot);
  const fuel = settings?.assumptions?.small_amount_at_fuel || boot?.settings?.assumptions?.small_amount_at_fuel || null;
  const as = settings?.assumptions || boot?.settings?.assumptions || {};
  const payday = as.payday_day || { day: null };
  const buffer = as.buffer || { months: 3, amount_cents: null };
  const goals = useQuery('goals', () => api.goals());
  const floor = as.checking_floor_cents || { cents: 0 };
  const muted = new Set(settings?.muted_insight_kinds || []);
  const kinds = settings?.insight_kinds || [];
  const suggested = a.suggestion?.month_start_day;
  const [showKinds, setShowKinds] = useState(false);
  const links = (a.goal_links || []).filter((l) => !pending.has(`link:${l.goal_id}:${l.description}`));

  const setType = (acc, type) => async () => {
    const before = acc.type;
    try {
      await api.updateAccount(acc.id, { type });
      invalidate();
      toast({ text: `${acc.name} is nu ${TYPE_LABEL[type].toLowerCase()}`, icon: 'check', action: { label: 'Herstel', onClick: async () => { try { await api.updateAccount(acc.id, { type: before }); invalidate(); } catch (err) { fail(err); } } } });
    } catch (err) { fail(err); }
  };
  const useDay = async () => {
    const before = a.month_start_day;
    try {
      await api.updateSettings({ month_start_day: suggested });
      invalidate();
      toast({ text: `Maand begint op de ${suggested}e`, icon: 'calendar', action: { label: 'Herstel', onClick: async () => { try { await api.updateSettings({ month_start_day: before }); invalidate(); } catch (err) { fail(err); } } } });
    } catch (err) { fail(err); }
  };
  const setFuel = async (patch) => {
    try { await api.updateSettings({ assumptions: { small_amount_at_fuel: patch } }); invalidate(); } catch (err) { fail(err); }
  };
  const setAssumption = async (patch) => {
    try { await api.updateSettings({ assumptions: patch }); invalidate(); } catch (err) { fail(err); }
  };
  // One buffer (SPEC 9): the target of a potje "Buffer" wins over this assumption.
  const bufferPots = (goals.data?.goals || []).filter((g) => /buffer/i.test(g.name) && g.target_cents > 0);
  const bufferPot = bufferPots[0];
  const bufferLabel = bufferPot ? euros(bufferPots.reduce((s, g) => s + g.target_cents, 0)) : buffer.amount_cents != null ? euros(buffer.amount_cents)
    : buffer.months ? `${buffer.months} ${buffer.months === 1 ? 'maand' : 'maanden'}` : 'Geen';
  const paydayLabel = payday.day ? `De ${payday.day}e` : 'Automatisch';
  const paydaySub = a.payday?.date ? `Volgende: ${shortDate(a.payday.date)}${!payday.day && a.payday.source === 'period' ? ' · einde maand' : ''}` : '';
  const pickPayday = (e) => openMenu(e.currentTarget, [
    { label: 'Automatisch (van het salaris)', checked: !payday.day, onSelect: () => setAssumption({ payday_day: { day: null } }) },
    '-',
    ...Array.from({ length: 31 }, (_, i) => i + 1).map((d) => ({ label: `De ${d}e`, checked: payday.day === d, onSelect: () => setAssumption({ payday_day: { day: d } }) })),
  ]);
  const pickBuffer = (e) => openMenu(e.currentTarget, [
    ...BUFFER_MONTHS.map((m) => ({ label: m ? `${m} ${m === 1 ? 'maand' : 'maanden'} vaste lasten` : 'Geen buffer', checked: buffer.amount_cents == null && buffer.months === m, onSelect: () => setAssumption({ buffer: { months: m, amount_cents: null } }) })),
    '-',
    ...BUFFER_AMOUNTS.map((c) => ({ label: euros(c), checked: buffer.amount_cents === c, onSelect: () => setAssumption({ buffer: { amount_cents: c } }) })),
  ]);
  const stepFloor = (dir) => {
    const cur = floor.cents ?? 0;
    const i = FLOOR_STEPS.findIndex((x) => x >= cur);
    const n = FLOOR_STEPS[Math.max(0, Math.min(FLOOR_STEPS.length - 1, (i < 0 ? FLOOR_STEPS.length - 1 : i) + dir))];
    if (n !== cur) setAssumption({ checking_floor_cents: { cents: n } });
  };
  const unignore = async (it) => {
    try {
      await api.unignoreRecurring(it.key);
      invalidate();
      toast({ text: `${it.name} is weer een vaste last`, icon: 'check', action: { label: 'Herstel', onClick: async () => { try { await api.ignoreRecurring(it.key); invalidate(); } catch (err) { fail(err); } } } });
    } catch (err) { fail(err); }
  };
  const forget = (l) => {
    const undo = commitLater(`link:${l.goal_id}:${l.description}`, () => api.forgetGoalLink(l.goal_id, l.description));
    toast({ text: `„${l.description}” vergeten`, icon: 'check', action: { label: 'Herstel', onClick: undo } });
  };
  const toggleKind = async (kind, on) => {
    try { await api.muteInsight(kind, !on); invalidate(); } catch (err) { fail(err); }
  };
  const step = (dir) => {
    const cur = fuel?.below_cents ?? 1500;
    const i = FUEL_STEPS.findIndex((x) => x >= cur);
    const n = FUEL_STEPS[Math.max(0, Math.min(FUEL_STEPS.length - 1, (i < 0 ? FUEL_STEPS.length - 1 : i) + dir))];
    if (n !== cur) setFuel({ below_cents: n });
  };

  return html`
    ${(a.salary || []).length > 0 && html`<${List} header="Salaris">
      ${a.salary.map((s) => html`<${ListRow} key=${s.merchant_key} icon="euro" iconColor="green" title=${s.name}
        subtitle=${html`<span class="num">${money(Math.abs(s.amount_cents), { signed: true })} ${freqLabel(s.frequency) || ''}</span>`}
        chevron onClick=${() => navigate('/transacties', { query: { merchant_key: s.merchant_key } })} />`)}
    </${List}>`}

    ${(a.accounts || []).length > 0 && html`<${List} header="Rekeningen">
      ${a.accounts.map((acc) => html`<${ListRow} key=${acc.id} icon="wallet" iconColor="blue" title=${acc.name}
        subtitle=${acc.type_source === 'import' ? 'Uit het bankbestand' : 'Zelf gekozen'}
        value=${html`<span class="sa-pop">${TYPE_LABEL[acc.type] || acc.type}<${Icon} name="chevron-up-down" size=${12} stroke=${2.4} /></span>`}
        onClick=${(e) => openMenu(e.currentTarget, Object.entries(TYPE_LABEL).map(([t, label]) => ({ label, checked: t === acc.type, onSelect: setType(acc, t) })))}
        label=${`${acc.name}: ${TYPE_LABEL[acc.type] || acc.type}. Wijzig soort`} />`)}
    </${List}>`}

    ${suggested && suggested !== a.month_start_day && html`<${List} header="Maand">
      <${ListRow} icon="calendar" iconColor="blue" title=${`Salaris komt meestal op de ${suggested}e`}
        accessory=${html`<${Button} size="small" variant="tinted" onClick=${useDay} aria-label=${`Laat de maand op de ${suggested}e beginnen`}>Gebruik</${Button}>`} />
    </${List}>`}

    <${List} header="Nog te besteden en buffer">
      <${ListRow} icon="calendar" iconColor="green" title="Salarisdag" subtitle=${paydaySub}
        value=${html`<span class="sa-pop">${paydayLabel}<${Icon} name="chevron-up-down" size=${12} stroke=${2.4} /></span>`}
        onClick=${pickPayday} label=${`Salarisdag: ${paydayLabel}. Wijzig`} />
      ${bufferPot
        ? html`<${ListRow} icon="piggy" iconColor="teal" title="Buffer" subtitle=${`Het doel van je potje ${bufferPot.name}`}
            value=${html`<span class="num">${bufferLabel}</span>`} chevron
            onClick=${() => navigate(`/potjes/${bufferPot.id}`)} label=${`Buffer: ${bufferLabel}, het doel van je potje ${bufferPot.name}. Open het potje`} />`
        : html`<${ListRow} icon="piggy" iconColor="teal" title="Buffer" subtitle=${buffer.amount_cents != null ? 'Vast bedrag apart' : 'Vaste lasten apart'}
            value=${html`<span class="sa-pop">${bufferLabel}<${Icon} name="chevron-up-down" size=${12} stroke=${2.4} /></span>`}
            onClick=${pickBuffer} label=${`Buffer: ${bufferLabel}. Wijzig`} />`}
      <li class="field-row"><span class="field-label sa-grow">Betaalrekening niet onder</span>
        <span class="td-stepper">
          <button aria-label="Lager" onClick=${() => stepFloor(-1)} disabled=${(floor.cents ?? 0) <= FLOOR_STEPS[0]}><${Icon} name="minus" size=${16} stroke=${2.4} /></button>
          <span class="td-stepper-value num">${euros(floor.cents ?? 0)}</span>
          <button aria-label="Hoger" onClick=${() => stepFloor(1)} disabled=${(floor.cents ?? 0) >= FLOOR_STEPS.at(-1)}><${Icon} name="plus" size=${16} stroke=${2.4} /></button>
        </span></li>
    </${List}>

    ${fuel && html`<${List} header="Kleine bedragen">
      <li class="field-row"><label class="field-label sa-grow" for="sa-fuel">Apart tonen onder ${euros(fuel.below_cents)}</label>
        <${Switch} id="sa-fuel" checked=${fuel.enabled} onChange=${(on) => setFuel({ enabled: on })} label=${`Kleine bedragen bij tankstations apart tonen onder ${euros(fuel.below_cents)}`} /></li>
      ${fuel.enabled && html`<li class="field-row"><span class="field-label sa-grow">Grens</span>
        <span class="td-stepper">
          <button aria-label="Lager" onClick=${() => step(-1)} disabled=${fuel.below_cents <= FUEL_STEPS[0]}><${Icon} name="minus" size=${16} stroke=${2.4} /></button>
          <span class="td-stepper-value num">${euros(fuel.below_cents)}</span>
          <button aria-label="Hoger" onClick=${() => step(1)} disabled=${fuel.below_cents >= FUEL_STEPS.at(-1)}><${Icon} name="plus" size=${16} stroke=${2.4} /></button>
        </span></li>`}
    </${List}>`}

    <${PricesPart} on=${as.prices_auto?.enabled === true} setAssumption=${setAssumption} />

    <${List} header="Vaste lasten">
      <${ListRow} icon="vaste-lasten" iconColor="indigo" title="Herkend" value=${String(a.recurring_count ?? 0)} chevron onClick=${() => navigate('/vaste-lasten')} />
      ${(a.recurring_ignored || []).map((it) => html`<${ListRow} key=${it.key} title=${it.name} subtitle="Geen vaste last"
        accessory=${html`<${Button} size="small" variant="gray" onClick=${() => unignore(it)}>Zet terug</${Button}>`} />`)}
    </${List}>

    ${links.length > 0 && html`<${List} header="Potjes herkennen">
      ${links.map((l) => html`<${ListRow} key=${l.goal_id + l.description} icon="potjes" iconColor="teal" title=${`„${l.description}”`}
        subtitle=${`${l.goal_name}${l.count ? ' · ' + plural(l.count, 'keer', 'keer') : ''}`}
        accessory=${html`<${Button} size="small" variant="gray" onClick=${() => forget(l)}>Vergeet</${Button}>`} />`)}
    </${List}>`}

    ${kinds.length > 0 && html`<${List}>
      <li class="row-li"><button type="button" class="row has-lead is-button" aria-expanded=${showKinds ? 'true' : 'false'} onClick=${() => setShowKinds(!showKinds)}>
        <span class="row-lead"><span class="row-icon" style=${{ '--c': 'var(--orange)' }}><${Icon} name="info" size=${18} stroke=${1.9} /></span></span>
        <span class="row-main"><span class="row-title">Meldingen</span></span>
        <span class="row-value num">${kinds.length - kinds.filter((k) => muted.has(k.kind)).length} van ${kinds.length} aan</span>
        <span class=${'row-chev sa-chev' + (showKinds ? ' is-open' : '')}><${Icon} name="chevron-right" size=${14} stroke=${2.6} /></span>
      </button></li>
      ${showKinds && kinds.map((k) => html`<li class="field-row" key=${k.kind}><label class="field-label sa-grow" for=${'sa-k-' + k.kind}>${KIND_LABEL[k.kind] || k.label}</label>
        <${Switch} id=${'sa-k-' + k.kind} checked=${!muted.has(k.kind)} onChange=${(on) => toggleKind(k.kind, on)} label=${KIND_LABEL[k.kind] || k.label} /></li>`)}
    </${List}>`}

    <${List}>
      <${ListRow} icon="sparkles" iconColor="purple" title="Geleerde regels" value=${String(a.rules_count ?? '')} chevron onClick=${() => navigate('/instellingen/regels')} />
    </${List}>`;
}

// Koersen (SPEC §7.1): automatic daily prices on/off, last update and source, "Nu bijwerken".
function PricesPart({ on, setAssumption }) {
  const q = useQuery('prices-status', () => api.priceStatus());
  const [busy, setBusy] = useState(false);
  const st = q.data;
  const refresh = async () => {
    setBusy(true);
    try {
      const r = await api.refreshPrices();
      invalidate();
      toast({ text: r.result?.ok ? 'Koersen bijgewerkt' : 'Bijwerken lukte niet', icon: r.result?.ok ? 'check' : 'warning' });
    } catch (err) { fail(err); }
    setBusy(false);
  };
  const last = st?.last_ok ? `Bijgewerkt ${shortDate(st.last_ok.slice(0, 10))} · ${st.source}` : st?.held ? 'Nog niet bijgewerkt' : 'Nog geen fondsen';
  return html`<${List} header="Koersen" footer=${on
    ? `Eén keer per dag na 18:30 haalt Cents de slotkoersen van je fondsen op bij ${st?.source || 'Yahoo Finance'} (alleen de ISIN, geen bedragen), en wisselkoersen bij de ECB.`
    : 'Uit: er gaat niets van je server naar internet. Cents gebruikt de koersen uit je DEGIRO-export of de waarde die je zelf invult.'}>
    <li class="field-row"><label class="field-label sa-grow" for="sa-prices">Koersen automatisch ophalen</label>
      <${Switch} id="sa-prices" checked=${on} onChange=${(v) => setAssumption({ prices_auto: { enabled: v } })} label="Koersen automatisch ophalen" /></li>
    ${on && html`<${ListRow} title=${last} subtitle=${st?.error ? 'Laatste poging lukte niet' : null}
      accessory=${html`<${Button} size="small" variant="tinted" onClick=${refresh} loading=${busy} disabled=${!st?.held}>Nu bijwerken</${Button}>`} />`}
  </${List}>`;
}
