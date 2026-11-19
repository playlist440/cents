// Abonnement met de hand: paid by credit card or from a private account, so Cents cannot see it
// in a bank file. Listed in Vaste lasten and in the subscriptions total; never in the budget
// figures (services/manual_subs.py).

import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { invalidate, categoryById } from '../store.js';
import { todayISO, shortDate, money } from '../format.js';
import { Segmented, Button } from '../components/Controls.js';
import { List, ListRow } from '../components/List.js';
import { TextField, AmountField, DateField } from '../components/Fields.js';
import { Sheet, SheetButton } from '../components/Sheet.js';
import { openMenu } from '../components/Menu.js';
import { toast } from '../components/Toast.js';
import { openSheet } from '../router.js';
import { PickBakjeSheet } from './transacties.js';

const FREQS = [['weekly', 'Week'], ['4-weekly', '4 weken'], ['monthly', 'Maand'], ['yearly', 'Jaar']];
const FROM = ['Creditcard', 'Privérekening'];

export function openSubscription(it = null) { openSheet(SubscriptionSheet, { it }); }

function SubscriptionSheet({ close, it }) {
  const [name, setName] = useState(it?.name || '');
  const [cents, setCents] = useState(it ? Math.abs(it.amount_cents) : null);
  const [freq, setFreq] = useState(it?.frequency || 'monthly');
  const [start, setStart] = useState(it?.start_date || todayISO());
  const [catId, setCatId] = useState(it?.category_id ?? null);
  const [from, setFrom] = useState(it?.paid_from || '');
  const [busy, setBusy] = useState(false);
  const ok = name.trim() && cents > 0 && start;
  const cat = catId != null ? categoryById(catId) : null;
  const done = (text) => { invalidate('recurring'); toast({ text, icon: 'check' }); close(); };
  const fail = (err) => { setBusy(false); toast({ text: err.message, icon: 'warning' }); };
  const save = async () => {
    if (!ok || busy) return;
    setBusy(true);
    const body = { name: name.trim(), amount_cents: cents, frequency: freq, start_date: start, category_id: catId, paid_from: from.trim() || null };
    try {
      if (it) await api.updateSubscription(it.id, body); else await api.createSubscription(body);
      done(it ? `${body.name} bijgewerkt` : `${body.name} toegevoegd`);
    } catch (err) { fail(err); }
  };
  const stop = async () => {
    setBusy(true);
    try { await api.updateSubscription(it.id, { end_date: it.end_date ? null : todayISO() }); done(it.end_date ? `${it.name} loopt weer` : `${it.name} opgezegd`); } catch (err) { fail(err); }
  };
  const remove = (e) => openMenu(e.currentTarget, [{ label: 'Verwijder abonnement', icon: 'trash', destructive: true, onSelect: async () => {
    try { await api.deleteSubscription(it.id); done(`${it.name} verwijderd`); } catch (err) { fail(err); }
  } }]);
  return html`<${Sheet} title=${it ? 'Abonnement' : 'Abonnement toevoegen'}
      leading=${html`<${SheetButton} onClick=${close}>Annuleer</${SheetButton}>`}
      trailing=${html`<${SheetButton} bold onClick=${save} disabled=${!ok || busy}>Bewaar</${SheetButton}>`}>
    <${List} footer="Voor abonnementen die Cents niet in je bankbestand ziet, zoals op de creditcard of een privérekening. Ze staan in Vaste lasten en tellen mee in je abonnementen, maar niet in je vaste lasten of Nog te besteden: dat geld is al ergens anders geteld.">
      <${TextField} label="Naam" value=${name} onInput=${setName} placeholder="Bijvoorbeeld Spotify" maxLength=${80} autoFocus=${!it} />
      <${AmountField} label="Bedrag" cents=${cents} onChange=${setCents} />
      <li class="field-row"><${Segmented} value=${freq} onChange=${setFreq} options=${FREQS} label="Hoe vaak" /></li>
      <${DateField} label=${it ? 'Betaaldag (vanaf)' : 'Eerste of laatste betaling'} value=${start} onChange=${setStart} />
    </${List}>
    <${List}>
      <${ListRow} title="Bakje" value=${cat ? `${cat.emoji} ${cat.name}` : 'Geen'} chevron
        onClick=${() => openSheet(PickBakjeSheet, { value: catId, onPick: (c) => setCatId(c.id) })} />
      <${TextField} label="Betaald met" value=${from} onInput=${setFrom} placeholder="Creditcard of Privérekening" maxLength=${60} />
      <li class="field-row">${FROM.map((f) => html`<button type="button" class="section-link" style="margin-right:16px" onClick=${() => setFrom(f)}>${f}</button>`)}</li>
    </${List}>
    ${it && html`<${List}>
      <li class="field-row vm-add-row"><${Button} variant="gray" size="medium" block onClick=${stop} disabled=${busy}>${it.end_date ? 'Loopt weer' : 'Opgezegd'}</${Button}></li>
      <li class="field-row vm-add-row"><${Button} variant="plain" size="medium" block onClick=${remove} disabled=${busy}>Verwijder…</${Button}></li>
    </${List}>`}
  </${Sheet}>`;
}

/* ---------- Markeer als abonnement ---------- */

// Strict on purpose: Cents follows exactly the payments with this name, counter account, amount
// and description (dates, months and numbers left out). The list shows them before saving, so a
// wrong match (a one-off transfer with the same amount) is seen before it counts.
export function openPin(tx) { openSheet(PinSheet, { tx }); }

function PinSheet({ close, tx }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.pinPreview(tx.id).then(setData, setError); }, [tx.id]);
  const save = async () => {
    setBusy(true);
    try {
      await api.pinCreate(tx.id);
      invalidate('recurring'); invalidate('transaction');
      toast({ text: `${tx.merchant_name} is gemarkeerd als abonnement`, icon: 'check' });
      close();
    } catch (err) { setBusy(false); toast({ text: err.message, icon: 'warning' }); }
  };
  const rule = data?.rule;
  return html`<${Sheet} title="Markeer als abonnement" detents=${['medium', 'large']}
      leading=${html`<${SheetButton} onClick=${close}>Annuleer</${SheetButton}>`}
      trailing=${html`<${SheetButton} bold onClick=${save} disabled=${!data || busy}>Bewaar</${SheetButton}>`}>
    ${error && html`<${List} footer=${error.message}></${List}>`}
    ${rule && html`<${List} footer="Cents volgt alleen betalingen die op al deze punten precies gelijk zijn. Datums, maanden en nummers in de omschrijving tellen niet mee. Komt er een ander bedrag, dan vraagt Cents eerst of je het nieuwe bedrag wilt overnemen.">
      <${ListRow} title="Naam" value=${tx.merchant_name} />
      ${rule.iban && html`<${ListRow} title="Tegenrekening" value=${'•• ' + rule.iban.slice(-4)} />`}
      <${ListRow} title="Bedrag" value=${html`<span class="num">${money(rule.amount_cents)}</span>`} />
      <${ListRow} title="Omschrijving" value=${rule.desc_key || '(leeg)'} />
    </${List}>`}
    ${data && html`<${List} header=${`Dit koppelt ${data.count} ${data.count === 1 ? 'betaling' : 'betalingen'}`}
        footer="Staat hier een betaling tussen die geen abonnement is? Bewaar dan niet.">
      ${data.transactions.map((x) => html`<${ListRow} key=${x.id} title=${shortDate(x.date)} subtitle=${x.description || ''}
        value=${html`<span class="num">${money(x.amount_cents)}</span>`} />`)}
    </${List}>`}
  </${Sheet}>`;
}
