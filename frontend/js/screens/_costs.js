// Kosten over de tijd (SPEC 7.4). Een grote aankoop die je jaren gebruikt hoeft niet één maand
// scheef te trekken:
// - Verdelen (uitsmeren): de betaling telt in gelijke delen mee over 6 maanden tot 10 jaar.
// - Bezitting: iets dat je later terugverkoopt (een auto). De aankoop telt niet als uitgave;
//   elke maand telt het waardeverlies, en de waarde staat bij Vermogen.
// Saldo, buffer en Nog te besteden volgen altijd het echte geld.
//
// CostSection staat in het transactieblad; PossessionSheet is het blad van een bezitting
// (Vermogen); PartRow toont een maanddeel in een bakje.

import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useQuery, invalidate, categoryById, getState } from '../store.js';
import { money, euros, monthLabel, shortDate, longDate, todayISO } from '../format.js';
import { Segmented, Chip, Button, Switch } from '../components/Controls.js';
import { List, ListRow } from '../components/List.js';
import { TextField, AmountField, DateField } from '../components/Fields.js';
import { Sheet, SheetButton } from '../components/Sheet.js';
import { Skeleton } from '../components/Feedback.js';
import { EmojiTile } from '../components/EmojiTile.js';
import { TxRow } from '../components/TxRow.js';
import { openMenu } from '../components/Menu.js';
import { toast } from '../components/Toast.js';
import { openSheet } from '../router.js';
import { openTransaction } from '../shell/actions.js';
import { Icon } from '../icons.js';
import { colorVar } from '../colors.js';

export const SPREAD_CHOICES = [6, 12, 24, 36, 60, 96, 120];
export const LIFE_CHOICES = [36, 60, 96, 120, 180];
// Wat een auto na zoveel jaar grofweg nog oplevert; alleen een startwaarde voor het veld.
const RESIDUAL_SHARE = { 36: 0.5, 60: 0.35, 96: 0.2, 120: 0.15, 180: 0.05 };
/** Vanaf dit bedrag staat "Kosten" open in het transactieblad; daaronder via Details. */
export const COSTS_FROM = 25000;

export function durationLabel(months) {
  if (months % 12 === 0) return months === 12 ? '1 jaar' : `${months / 12} jaar`;
  return `${months} maanden`;
}
const chipLabel = (m) => (m % 12 === 0 ? durationLabel(m) : `${m} mnd`);

/** Het eerste (grootste) maanddeel, zoals de server het rekent. */
export function firstPart(total, months, keep = 0, curve = 'linear') {
  const base = Math.max(0, total - Math.max(0, Math.min(keep || 0, total)));
  if (curve === 'front' && months > 1) return Math.floor((base * months) / ((months * (months + 1)) / 2)) + 1;
  return Math.floor(base / months) + (base % months ? 1 : 0);
}

/** How a possession loses value (services/spread.py amounts, curve). */
const CURVES = [['linear', 'Gelijkmatig'], ['front', 'Sneller in het begin']];   // Segmented: [value, label]
function CurvePick({ value, onChange }) {
  return html`<div class="ps-life">
    <span class="ps-life-label">Waardeverlies</span>
    <${Segmented} value=${value} onChange=${onChange} options=${CURVES} size="small" label="Hoe verliest het waarde" />
    <p class="td-cost-hint is-quiet">${value === 'front' ? 'Zoals bij een auto: de eerste jaren veel, later minder.' : 'Elke maand evenveel.'}</p>
  </div>`;
}

const roundTo = (cents, step) => Math.round(cents / step) * step;
export const suggestedResidual = (price, life) => (price ? roundTo(price * (RESIDUAL_SHARE[life] ?? 0.2), 10000) : null);
const fail = (err) => toast({ text: err.message, icon: 'warning' });

/** Een uitgave van een betaal- of creditcardrekening, in een bakje voor uitgaven. */
export function canSpread(t, account) {
  const cat = categoryById(t.category_id);
  return t.amount_cents < 0 && t.kind === 'normal' && !!cat && ['fixed', 'daily'].includes(cat.grp)
    && cat.key !== 'creditcard' && !!account && ['checking', 'credit'].includes(account.type);
}

/** Iets dat je kocht en later weer kunt verkopen: ook van een spaarrekening. */
export function canPossess(t, account) {
  const cat = categoryById(t.category_id);
  return t.amount_cents < 0 && t.kind === 'normal' && !!account && account.type !== 'investment'
    && (!cat || !['income', 'saving', 'internal'].includes(cat.grp));
}

/* ---------- In het transactieblad ---------- */

export function CostSection({ t, info, account, spreadable = true, anchor, onTx }) {
  const link = t.possession;
  const saved = link?.role === 'purchase' ? 'possession' : t.spread_months > 1 ? 'spread' : 'once';
  const [mode, setMode] = useState(saved);
  const [months, setMonths] = useState(t.spread_months || null);
  useEffect(() => { setMode(saved); setMonths(t.spread_months || null); }, [t.id, saved, t.spread_months]);
  const total = -t.amount_cents;

  if (link) return html`<${LinkedPossession} t=${t} link=${link} info=${info} anchor=${anchor} />`;

  const setSpread = async (m, { undo = true } = {}) => {
    const prev = t.spread_months || null;
    setMonths(m);
    onTx?.({ spread_months: m });
    try {
      await api.updateTransaction(t.id, { spread_months: m });
      invalidate();
      if (!undo) return;
      toast({
        icon: 'check',
        text: m ? `Verdeeld over ${durationLabel(m)} · ${money(firstPart(total, m))} per maand` : 'Telt weer in één keer',
        action: { label: 'Herstel', onClick: () => setSpread(prev, { undo: false }) },
      });
    } catch (err) {
      setMonths(prev);
      onTx?.({ spread_months: prev });
      fail(err);
    }
  };
  const pickMode = (m) => {
    setMode(m);
    if (m === 'once' && saved === 'spread') setSpread(null);
  };

  const hint = mode === 'spread'
    ? 'Voor iets dat je jaren gebruikt, zoals een laptop of keuken. Elke maand telt een deel mee in de overzichten.'
    : mode === 'possession'
      ? 'Voor iets dat je later weer verkoopt, zoals een auto. De aankoop telt niet als uitgave; elke maand telt het waardeverlies, en de waarde staat bij Vermogen.'
      : 'Telt helemaal mee in de maand van betalen.';
  return html`<section class="td-sec" id=${anchor}>
    <h3 class="list-header">Kosten</h3>
    <div class="td-card td-costs">
      <${Segmented} value=${mode} onChange=${pickMode} size="small" label="Hoe telt deze uitgave mee"
        options=${spreadable ? [['once', 'In één keer'], ['spread', 'Verdelen'], ['possession', 'Bezitting']]
          : [['once', 'In één keer'], ['possession', 'Bezitting']]} />
      <p class="td-cost-hint">${hint}</p>
      ${mode === 'spread' && html`
        <div class="td-cost-chips" role="group" aria-label="Verdelen over">
          ${SPREAD_CHOICES.map((m) => html`<${Chip} key=${m} selected=${months === m} onClick=${() => m !== months && setSpread(m)}>${chipLabel(m)}</${Chip}>`)}
        </div>
        ${months > 1 && html`<p class="td-cost-sum num">
          <strong>${money(firstPart(total, months))}</strong> per maand
          ${info?.kind === 'spread' && info.months === months ? html` · ${monthLabel(info.from, { short: true })} t/m ${monthLabel(info.to, { short: true })}` : ''}
        </p>
        <p class="td-cost-hint is-quiet">Je saldo, buffer en Nog te besteden volgen gewoon het echte geld.</p>`}`}
      ${mode === 'possession' && html`<${PossessionForm} key=${t.id} txId=${t.id} price=${total} inline
        onCreated=${(id, name) => {
          invalidate();
          toast({ icon: 'check', text: `${name} staat nu bij Vermogen`, action: { label: 'Bekijk', onClick: () => openSheet(PossessionSheet, { id }) } });
        }} />`}
    </div>
  </section>`;
}

function LinkedPossession({ t, link, info, anchor }) {
  const purchase = link.role === 'purchase';
  const cat = categoryById(info?.category_id);
  const sub = !info ? null : purchase
    ? (info.sold ? `verkocht op ${shortDate(info.sale_date)}` : `nu ${euros(info.value_cents ?? 0)} waard · ${money(info.monthly_cents)} waardeverlies per maand`)
    : `verkocht voor ${money(t.amount_cents)}`;
  return html`<section class="td-sec" id=${anchor}>
    <h3 class="list-header">Kosten</h3>
    <ul class="inset"><li class="row-li">
      <button class="row has-lead is-two is-button" onClick=${() => openSheet(PossessionSheet, { id: link.asset_id })}>
        <span class="row-lead"><${EmojiTile} emoji=${info?.emoji || '🚗'} color="green" size=${34} /></span>
        <span class="row-main">
          <span class="row-title">${purchase ? 'Bezitting' : 'Verkoop'} · ${link.name}</span>
          <span class="row-sub num">${sub || html`<${Skeleton} w=${150} h=${13} />`}</span>
        </span>
        <span class="row-chev"><${Icon} name="chevron-right" size=${14} stroke=${2.6} /></span>
      </button>
    </li></ul>
    <p class="td-cost-hint is-below">${purchase
      ? `Deze betaling telt niet als uitgave. Elke maand telt het waardeverlies mee${cat ? ` in ${cat.name}` : ''}.`
      : 'Deze betaling telt niet als inkomen. Het verschil met wat de bezitting nog waard was, telt één keer mee.'}</p>
  </section>`;
}

/* ---------- Bezitting aanmaken ---------- */

export function PossessionForm({ txId = null, price: initialPrice = null, date: initialDate = null, inline = false, onCreated }) {
  const [name, setName] = useState('Auto');
  const [life, setLife] = useState(96);
  const [curve, setCurve] = useState('front');
  const [price, setPrice] = useState(initialPrice);
  const [residual, setResidual] = useState(suggestedResidual(initialPrice, 96));
  const [own, setOwn] = useState(false);              // verkoopprijs zelf ingevuld
  const [day, setDay] = useState(initialDate || todayISO());
  const [busy, setBusy] = useState(false);
  const pickLife = (m) => { setLife(m); if (!own) setResidual(suggestedResidual(price, m)); };
  const typePrice = (c) => { setPrice(c); if (!own) setResidual(suggestedResidual(c, life)); };
  const ok = !!name.trim() && price > 0 && (residual || 0) <= price && (txId || day);
  const create = async () => {
    if (!ok || busy) return;
    setBusy(true);
    try {
      const res = await api.createAsset({ kind: 'possession', name: name.trim(), tx_id: txId, price_cents: price,
        ...(txId ? {} : { start_date: day }), life_months: life, residual_cents: residual || 0, curve });
      onCreated?.(res.id, name.trim());
    } catch (err) { fail(err); }
    setBusy(false);
  };
  const per = price > 0 ? firstPart(price, life, residual || 0, curve) : null;
  return html`<div class=${'ps-form' + (inline ? ' is-inline' : '')}>
    <ul class="list-group inset">
      <${TextField} label="Naam" value=${name} onInput=${setName} placeholder="Auto" maxLength=${60} enterkeyhint="done" />
      <${AmountField} label="Aankoopprijs" cents=${price} onChange=${typePrice} />
      ${!txId && html`<${DateField} label="Gekocht op" value=${day} onChange=${setDay} max=${todayISO()} />`}
      <${AmountField} label="Verwachte verkoopprijs" cents=${residual} onChange=${(c) => { setOwn(true); setResidual(c); }} />
    </ul>
    <div class="ps-life">
      <span class="ps-life-label">Gebruiken tot je het verkoopt</span>
      <div class="td-cost-chips" role="group" aria-label="Gebruiksduur">
        ${LIFE_CHOICES.map((m) => html`<${Chip} key=${m} selected=${life === m} onClick=${() => pickLife(m)}>${chipLabel(m)}</${Chip}>`)}
      </div>
    </div>
    <${CurvePick} value=${curve} onChange=${setCurve} />
    ${per != null && html`<p class="td-cost-sum num"><strong>${money(per)}</strong> waardeverlies ${curve === 'front' ? 'in de eerste maand' : 'per maand'} · na ${durationLabel(life)} nog ${euros(residual || 0)} waard</p>`}
    ${(residual || 0) > (price || 0) && html`<p class="td-cost-hint is-warn">De verkoopprijs is hoger dan de aankoopprijs.</p>`}
    <p class="td-cost-hint is-quiet">Een schatting is genoeg, je kunt het later aanpassen. Ingeruild of deels geleend? Vul dan de hele aankoopprijs in.</p>
    <div class="ps-actions"><${Button} variant=${inline ? 'tinted' : 'filled'} size="medium" block onClick=${create} disabled=${!ok} loading=${busy}>Maak bezitting</${Button}></div>
  </div>`;
}

/* ---------- Blad van een bezitting ---------- */

export function PossessionSheet({ close, id = null }) {
  const [itemId, setItemId] = useState(id);
  const [pick, setPick] = useState(undefined);       // undefined = nog niet gekozen, null = niet in Cents
  const { data, reload } = useQuery('assets', () => api.assets());
  const item = data?.items.find((x) => x.id === itemId);
  const done = () => { invalidate(); reload?.(); };
  return html`<${Sheet} title=${item ? item.name : 'Bezitting'} detents=${['large']}
      leading=${!itemId ? html`<${SheetButton} onClick=${pick !== undefined ? () => setPick(undefined) : close}>${pick !== undefined ? 'Terug' : 'Annuleer'}</${SheetButton}>` : null}
      trailing=${itemId ? html`<${SheetButton} bold onClick=${close}>Klaar</${SheetButton}>` : null}>
    <div class="sheet-pad">
      ${itemId
        ? (!item ? html`<${Skeleton} h=${160} r=${12} />` : html`<${PossessionDetail} a=${item} onChange=${done} close=${close} />`)
        : pick === undefined
          ? html`<${PurchasePicker} list=${data?.purchase_candidates} onPick=${setPick} />`
          : html`<${PossessionForm} txId=${pick?.id ?? null} price=${pick ? -pick.amount_cents : null} date=${pick?.date}
              onCreated=${(newId) => { setItemId(newId); done(); }} />`}
    </div>
  </${Sheet}>`;
}

function PurchasePicker({ list, onPick }) {
  if (!list) return html`<${Skeleton} h=${160} r=${12} />`;
  return html`
    <p class="ps-intro">Een bezitting is iets dat je later weer verkoopt, zoals een auto. Elke maand telt het waardeverlies als kosten, niet de aankoop.</p>
    <${List} header="Welke betaling was de aankoop?" footer=${list.length ? 'Grote betalingen van de afgelopen drie jaar.' : null}>
      ${list.map((c) => html`<${ListRow} key=${c.id} emoji=${categoryById(c.category_id)?.emoji} color=${categoryById(c.category_id)?.color}
        title=${c.merchant_name} subtitle=${longDate(c.date)} value=${html`<span class="num">${money(c.amount_cents)}</span>`}
        chevron onClick=${() => onPick(c)} />`)}
      <${ListRow} icon="pencil" title="Staat niet in Cents" subtitle="Eerder gekocht of contant betaald" chevron onClick=${() => onPick(null)} />
    </${List}>`;
}

function PossessionDetail({ a, onChange, close }) {
  const [editing, setEditing] = useState(false);
  const [selling, setSelling] = useState(false);
  const cat = categoryById(a.category_id);
  const sold = !!a.sale;
  const save = (changes, msg) => api.updateAsset(a.id, changes).then(() => { onChange(); if (msg) toast({ icon: 'check', text: msg }); }, fail);
  const spendingCats = (getState().boot?.categories || []).filter((c) => ['fixed', 'daily'].includes(c.grp) && !c.hidden && !['unsorted', 'creditcard'].includes(c.key));
  const pickCat = (e) => openMenu(e.currentTarget, spendingCats.map((c) => ({
    label: `${c.emoji} ${c.name}`, checked: c.id === a.category_id, onSelect: () => save({ category_id: c.id }, `Waardeverlies telt in ${c.name}`) })));
  const remove = (e) => openMenu(e.currentTarget, [{
    label: `Verwijder ${a.name}`, icon: 'trash', destructive: true, onSelect: async () => {
      try {
        await api.deleteAsset(a.id);
        invalidate();
        close();
        toast({ text: a.purchase ? `${a.name} verwijderd. De aankoop telt weer als uitgave.` : `${a.name} verwijderd`, icon: 'trash' });
      } catch (err) { fail(err); }
    } }]);

  const head = sold ? euros(a.sale.cents) : euros(a.value_cents ?? 0);
  const sub = sold ? `verkocht op ${longDate(a.sale.date)}` : `nu waard · gekocht voor ${euros(a.price_cents)} op ${longDate(a.start_date)}`;
  const result = a.sale?.result_cents;
  return html`
    <div class="vm-sheet-head">
      <div class="ps-emoji" aria-hidden="true">${a.emoji || '🚗'}</div>
      <div class="vm-sheet-amount rounded num">${head}</div>
      <div class="vm-sheet-sub">${sub}</div>
      ${!sold && a.price_cents > 0 && html`<div class="vm-meter ps-meter" style=${{ '--c': colorVar('green') }}>
        <div class="vm-meter-bar" role="img" aria-label=${`Nog ${euros(a.value_cents ?? 0)} van ${euros(a.price_cents)}`}>
          <span style=${{ width: `${Math.max(0, Math.min(100, ((a.value_cents ?? 0) / a.price_cents) * 100))}%` }}></span>
          ${a.residual_cents > 0 && html`<i style=${{ left: `${(a.residual_cents / a.price_cents) * 100}%` }}></i>`}
        </div>
        <div class="vm-meter-label num">${euros(a.lost_cents || 0)} waardeverlies tot nu${a.residual_cents > 0 ? ' · streepje = verwachte verkoopprijs' : ''}</div>
      </div>`}
    </div>

    <${List} header="Kosten" footer=${sold ? null : `Deze kosten tellen mee in je overzichten. Je saldo en buffer volgen gewoon het echte geld.`}>
      ${!sold && html`<${ListRow} title="Waardeverlies" value=${html`<span class="num">${money(a.monthly_cents)} per maand</span>`} />`}
      ${!sold && html`<${ListRow} title="Tot en met" value=${a.end_period ? monthLabel(a.end_period) : '—'} />`}
      <${ListRow} title="Telt in bakje" value=${cat ? `${cat.emoji} ${cat.name}` : 'Kies'} chevron onClick=${pickCat} />
      ${a.purchase && html`<${ListRow} title="Aankoop" subtitle=${`${a.purchase.merchant_name} · ${shortDate(a.purchase.date)}`}
        value=${html`<span class="num">${money(a.purchase.amount_cents)}</span>`} chevron onClick=${() => openTransaction(a.purchase.id)} />`}
    </${List}>

    ${editing
      ? html`<${PossessionEdit} a=${a} onSave=${(changes) => save(changes, 'Bewaard').then(() => setEditing(false))} onCancel=${() => setEditing(false)} />`
      : html`<${List} header="Gegevens">
          <${ListRow} title="Aankoopprijs" value=${html`<span class="num">${money(a.price_cents)}</span>`} />
          <${ListRow} title="Gebruiksduur" value=${durationLabel(a.life_months)} />
          <${ListRow} title="Verwachte verkoopprijs" value=${html`<span class="num">${money(a.residual_cents)}</span>`} />
          <${ListRow} title="Wijzig…" tint onClick=${() => setEditing(true)} />
        </${List}>`}

    ${sold
      ? html`<${List} header="Verkocht" footer=${result == null ? null : result > 0
          ? `${euros(result)} minder dan de waarde in Cents. Dat telt één keer als kosten in ${monthLabel(a.sale.date.slice(0, 7))}.`
          : result < 0 ? `${euros(-result)} meer dan de waarde in Cents. Dat telt één keer als meevaller in ${monthLabel(a.sale.date.slice(0, 7))}.` : 'Precies de waarde in Cents.'}>
          <${ListRow} title=${a.sale.tx ? a.sale.tx.merchant_name : 'Ingeruild of zonder betaling'} subtitle=${longDate(a.sale.date)}
            value=${html`<span class="num">${money(a.sale.cents)}</span>`} />
          <${ListRow} title="Toch niet verkocht" tint onClick=${() => save({ sale_tx_id: null, sale_date: null, sale_cents: null }, 'Verkoop weggehaald')} />
        </${List}>`
      : selling
        ? html`<${SalePicker} a=${a} onPick=${(changes) => save(changes, `${a.name} verkocht`).then(() => setSelling(false))} onCancel=${() => setSelling(false)} />`
        : html`<${List}><${ListRow} title="Verkocht of ingeruild…" tint onClick=${() => setSelling(true)} /></${List}>`}

    <${List}>
      <li class="field-row"><label class="field-label sa-grow" for=${'ps-inc-' + a.id}>Meetellen in vermogen</label>
        <${Switch} id=${'ps-inc-' + a.id} checked=${a.include} label="Meetellen in vermogen"
          onChange=${(on) => save({ include: on })} /></li>
    </${List}>
    <${List}><${ListRow} title="Verwijder" destructive onClick=${remove} /></${List}>`;
}

function PossessionEdit({ a, onSave, onCancel }) {
  const [name, setName] = useState(a.name);
  const [price, setPrice] = useState(a.price_cents);
  const [residual, setResidual] = useState(a.residual_cents);
  const [life, setLife] = useState(a.life_months);
  const [curve, setCurve] = useState(a.curve || 'linear');
  const [day, setDay] = useState(a.start_date);
  const ok = !!name.trim() && price > 0 && (residual || 0) <= price;
  const per = price > 0 ? firstPart(price, life, residual || 0, curve) : null;
  return html`<div class="ps-form">
    <ul class="list-group inset">
      <${TextField} label="Naam" value=${name} onInput=${setName} maxLength=${60} />
      <${AmountField} label="Aankoopprijs" cents=${price} onChange=${setPrice} />
      ${!a.purchase && html`<${DateField} label="Gekocht op" value=${day} onChange=${setDay} max=${todayISO()} />`}
      <${AmountField} label="Verwachte verkoopprijs" cents=${residual} onChange=${setResidual} />
    </ul>
    <div class="ps-life">
      <span class="ps-life-label">Gebruiken tot je het verkoopt</span>
      <div class="td-cost-chips" role="group" aria-label="Gebruiksduur">
        ${[...new Set([...LIFE_CHOICES, a.life_months])].sort((x, y) => x - y).map((m) => html`<${Chip} key=${m} selected=${life === m} onClick=${() => setLife(m)}>${chipLabel(m)}</${Chip}>`)}
      </div>
    </div>
    <${CurvePick} value=${curve} onChange=${setCurve} />
    ${per != null && html`<p class="td-cost-sum num"><strong>${money(per)}</strong> waardeverlies ${curve === 'front' ? 'in de eerste maand' : 'per maand'}</p>`}
    <div class="ps-actions is-row">
      <${Button} variant="plain" size="medium" onClick=${onCancel}>Annuleer</${Button}>
      <${Button} variant="filled" size="medium" disabled=${!ok}
        onClick=${() => onSave({ name: name.trim(), price_cents: price, residual_cents: residual || 0, life_months: life, curve, ...(a.purchase ? {} : { start_date: day }) })}>Bewaar</${Button}>
    </div>
  </div>`;
}

function SalePicker({ a, onPick, onCancel }) {
  const [manual, setManual] = useState(false);
  const [day, setDay] = useState(todayISO());
  const [cents, setCents] = useState(null);
  const list = a.sale_candidates || [];
  if (manual) {
    return html`<${List} header="Ingeruild of zonder betaling" footer="Bij inruilen: vul in wat je voor de oude kreeg.">
      <${DateField} label="Datum" value=${day} onChange=${setDay} min=${a.start_date} max=${todayISO()} />
      <${AmountField} label="Opbrengst" cents=${cents} onChange=${setCents} />
      <li class="field-row ps-actions is-row">
        <${Button} variant="plain" size="medium" onClick=${() => setManual(false)}>Terug</${Button}>
        <${Button} variant="filled" size="medium" disabled=${cents == null || !day} onClick=${() => onPick({ sale_date: day, sale_cents: cents })}>Bewaar</${Button}>
      </li>
    </${List}>`;
  }
  return html`<${List} header="Welke betaling was de verkoop?" footer=${list.length ? 'Geld dat binnenkwam na de aankoop.' : null}>
    ${list.map((c) => html`<${ListRow} key=${c.id} title=${c.merchant_name} subtitle=${longDate(c.date)}
      value=${html`<span class="num is-income">${money(c.amount_cents, { signed: true })}</span>`} chevron onClick=${() => onPick({ sale_tx_id: c.id })} />`)}
    <${ListRow} icon="pencil" title="Ingeruild of zonder betaling" chevron onClick=${() => setManual(true)} />
    <${ListRow} title="Annuleer" tint onClick=${onCancel} />
  </${List}>`;
}

/* ---------- Een maanddeel in een bakje ---------- */

export function partSub(p) {
  if (p.kind === 'spread') return `${shortDate(p.date)} · deel ${p.index} van ${p.months} · ${euros(p.total_cents)} in totaal`;
  if (p.role === 'sale') return `${shortDate(p.date)} · verkocht, verschil met de waarde`;
  return `waardeverlies · maand ${p.index} van ${p.months}`;
}

export function PartRow({ p }) {
  const tx = { id: `part-${p.tx_id}-${p.index}`, merchant_name: p.name, amount_cents: -p.cents, category_id: p.category_id,
    date: p.date, kind: 'normal', tag_ids: [] };
  const open = () => (p.kind === 'possession' ? openSheet(PossessionSheet, { id: p.asset_id }) : openTransaction(p.tx_id));
  return html`<${TxRow} tx=${tx} sub=${partSub(p)} onClick=${open} />`;
}
