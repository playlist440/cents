// Abonnement met de hand: paid by credit card or from a private account, so Cents cannot see it
// in a bank file. Listed in Vaste lasten and in the subscriptions total; never in the budget
// figures (services/manual_subs.py).

import { html, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { invalidate, categoryById } from '../store.js';
import { todayISO } from '../format.js';
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
