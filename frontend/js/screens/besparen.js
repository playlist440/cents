// Besparen (SPEC 9 Bespaarlijst): "waar kunnen we besparen?" in one list. Cents does not know
// prices elsewhere, so it shows what costs money every year and what changed, never a promise:
// abonnementen, prijsstijgingen, contracten om te vergelijken, bank- en koerskosten, bakjes
// boven vorig jaar and achteraf betalen. Every row opens where the money goes.

import { html } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useQuery, categoryById } from '../store.js';
import { navigate } from '../router.js';
import { euros, money, shortDate, monthLabel, plural } from '../format.js';
import { Screen } from '../components/Screen.js';
import { List, ListRow } from '../components/List.js';
import { EmptyState, Skeleton } from '../components/Feedback.js';
import { useLayout } from '../hooks.js';

const perYear = (c) => html`<span class="num">${euros(c)} p/j</span>`;
const emojiOf = (id) => categoryById(id)?.emoji || '📦';
const colorOf = (id) => categoryById(id)?.color || 'gray';
const recurring = (it) => navigate('/transacties', { query: { merchant_key: it.merchant_key } });

export function Besparen() {
  const { data, error, reload } = useQuery('besparen', () => api.besparen());
  const desk = useLayout() === 'wide';
  return html`<${Screen} title="Besparen" back=${desk ? false : { to: '/meer', label: 'Meer' }} class="bsp">
    ${!data && (error
      ? html`<${EmptyState} emoji="💡" title="Besparen laadt niet" subtitle=${error.message} action=${{ label: 'Probeer opnieuw', variant: 'tinted', onClick: () => reload() }} />`
      : html`<div class="inset" aria-busy="true" aria-label="Laden">${[0, 1, 2].map(() => html`<div class="row"><span class="row-main"><${Skeleton} w="60%" h=${15} /></span></div>`)}</div>`)}
    ${data && html`<${Content} b=${data} />`}
  </${Screen}>`;
}

function Content({ b }) {
  if (!b.count) {
    return html`<${EmptyState} emoji="🌱" title="Niets opvallends" subtitle="Geen prijsstijgingen, geen bakjes boven vorig jaar en geen bankkosten. Kijk na een volgende import nog eens." />`;
  }
  const subs = b.subscriptions;
  const rises = b.price_rises;
  const contracts = b.contracts;
  const fees = b.fees;
  return html`
    <p class="bsp-intro">Hier staat waar elk jaar geld naartoe gaat en wat duurder werd. Wat je kunt schrappen of goedkoper kunt regelen, weet jij het best.</p>

    ${b.higher.items.length > 0 && html`<${List} header="Meer dan vorig jaar" footer="Gemiddeld per maand over de laatste zes maanden, tegenover dezelfde maanden een jaar eerder.">
      ${b.higher.items.map((x) => {
        const cat = categoryById(x.category_id) || { name: 'Bakje' };
        return html`<${ListRow} key=${x.category_id} emoji=${emojiOf(x.category_id)} color=${colorOf(x.category_id)} title=${cat.name}
          subtitle=${`${euros(x.now_cents)} per maand, was ${euros(x.then_cents)}`} value=${html`<span class="num">+ ${euros(x.extra_per_year_cents)} p/j</span>`}
          chevron onClick=${() => navigate(`/overzicht/bakje/${x.category_id}`)} />`;
      })}
    </${List}>`}

    ${rises.items.length > 0 && html`<${List} header="Duurder geworden" footer="In de afgelopen twaalf maanden. Soms loont opzeggen of overstappen.">
      ${rises.items.map((it) => html`<${ListRow} key=${it.key} emoji=${emojiOf(it.category_id)} color=${colorOf(it.category_id)} title=${it.name}
        subtitle=${`${money(it.from_cents)} → ${money(it.to_cents)} sinds ${shortDate(it.since)}`} value=${html`<span class="num">+ ${euros(it.extra_per_year_cents)} p/j</span>`}
        chevron onClick=${() => recurring(it)} />`)}
    </${List}>`}

    ${subs.items.length > 0 && html`<${List} header=${`Abonnementen · ${euros(subs.per_year_cents)} per jaar`} footer="Abonnementen en internet, tv en bellen. Gebruik je ze allemaal nog?">
      ${subs.items.map((it) => html`<${ListRow} key=${it.key} emoji=${emojiOf(it.category_id)} color=${colorOf(it.category_id)} title=${it.name}
        subtitle=${`${money(Math.abs(it.per_month_cents))} per maand${it.new ? ' · nieuw' : ''}`} value=${perYear(it.per_year_cents)}
        chevron onClick=${() => recurring(it)} />`)}
    </${List}>`}

    ${contracts.items.length > 0 && html`<${List} header="Contracten om te vergelijken" footer="Energie, verzekeringen en telecom die al langer dan een jaar lopen. Een vergelijkingssite laat zien of het goedkoper kan.">
      ${contracts.items.map((it) => html`<${ListRow} key=${it.key} emoji=${emojiOf(it.category_id)} color=${colorOf(it.category_id)} title=${it.name}
        subtitle=${`sinds ${monthLabel(it.since.slice(0, 7))}`} value=${perYear(it.per_year_cents)} chevron onClick=${() => recurring(it)} />`)}
    </${List}>`}

    ${fees.per_year_cents > 0 && html`<${List} header="Kosten" footer="In de afgelopen twaalf maanden.">
      ${fees.bank_cents > 0 && html`<${ListRow} icon="creditcard" iconColor="gray" title="Bankkosten" value=${html`<span class="num">${euros(fees.bank_cents)}</span>`}
        chevron onClick=${() => navigate('/transacties', { query: { method: 'fee', from: fees.since } })} />`}
      ${fees.fx_cents > 0 && html`<${ListRow} icon="euro" iconColor="gray" title="Wisselkoerskosten" subtitle="Bij betalen in een andere munt" value=${html`<span class="num">${euros(fees.fx_cents)}</span>`}
        chevron onClick=${() => navigate('/transacties', { query: { q: 'koers', from: fees.since } })} />`}
    </${List}>`}

    ${b.later.items.length > 0 && html`<${List} header="Achteraf betalen" footer="Wat je achteraf betaalt, is al uitgegeven maar nog niet betaald. Zet een openstaand bedrag bij Vermogen als schuld, dan telt het mee.">
      ${b.later.items.map((x) => html`<${ListRow} key=${x.name} icon="clock" iconColor="orange" title=${x.name}
        subtitle=${`${plural(x.count, 'betaling', 'betalingen')} in drie maanden, laatst ${shortDate(x.last_date)}`} value=${html`<span class="num">${euros(x.cents)}</span>`}
        chevron onClick=${() => navigate('/transacties', { query: { q: x.name.split(' ')[0] } })} />`)}
    </${List}>`}
  `;
}
