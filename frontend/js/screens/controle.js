// Controle ("Kloppen je gegevens?", SPEC 9 Zelfcontrole): the verantwoordingsmeter (how much of
// the spending sits in a bakje that says what it was for), per account the last import, missing
// months and balances that do not follow on, and transfers whose other half is missing. Runs on
// the household's own server; every row links to where it can be fixed.

import { html } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useQuery, categoryById } from '../store.js';
import { navigate } from '../router.js';
import { euros, money, monthLabel, plural, shortDate, relativeDays } from '../format.js';
import { Screen } from '../components/Screen.js';
import { List, ListRow } from '../components/List.js';
import { EmptyState, Skeleton, ProgressRing } from '../components/Feedback.js';
import { Button } from '../components/Controls.js';
import { useLayout } from '../hooks.js';
import { InstSplit } from './instellingen.js';
import { openImport } from '../shell/actions.js';
import { Iban } from '../components/Iban.js';

const UNKNOWN = {
  unsorted: { text: 'Nog niet gesorteerd', to: () => '/sorteren' },
  contant: { text: 'Opgenomen bij de geldautomaat: waar het aan op ging, ziet Cents niet' },
  overig: { text: 'In het bakje Overig' },
  creditcard: { text: 'Deel van de creditcardrekening dat Cents niet kan uitsplitsen' },
};
const TYPE = { checking: 'Betaalrekening', savings: 'Spaarrekening', credit: 'Creditcard' };
const pct = (x) => `${Math.round(x * 100)} %`;

export function Controle() {
  const { data, error, reload } = useQuery('checks', () => api.checks());
  const nw = useQuery('networth', () => api.networth());
  const desk = useLayout() === 'wide';
  const body = !data
    ? (error ? html`<${EmptyState} emoji="🔎" title="Controle laadt niet" subtitle=${error.message} action=${{ label: 'Probeer opnieuw', variant: 'tinted', onClick: () => reload() }} />`
      : html`<div class="inset" aria-busy="true" aria-label="Laden">${[0, 1, 2].map(() => html`<div class="row"><span class="row-main"><${Skeleton} w="60%" h=${15} /></span></div>`)}</div>`)
    : html`<${Content} c=${data} balances=${nw.data?.accounts || []} />`;
  return html`<${Screen} title="Controle" back=${desk ? false : { to: '/instellingen', label: 'Terug' }} class="inst ctl">
    ${desk ? html`<${InstSplit} active="controle">${body}</${InstSplit}>` : body}
  </${Screen}>`;
}

function Content({ c, balances }) {
  const cov = c.coverage;
  const issues = c.issues;
  const balanceOf = (id) => balances.find((a) => a.id === id);
  return html`
    <section class="ctl-head" aria-label="Samenvatting">
      ${cov?.share != null && html`<${ProgressRing} value=${cov.share} size=${76} stroke=${8} color=${cov.share >= 0.9 ? 'green' : 'orange'}
        label=${`${pct(cov.share)} verantwoord`}><span class="ctl-ring num">${pct(cov.share)}</span></${ProgressRing}>`}
      <div class="ctl-head-text">
        <h2 class="ctl-title">${issues ? `${plural(issues, 'punt', 'punten')} om na te kijken` : 'Je gegevens lijken compleet'}</h2>
        <p class="ctl-sub">${cov?.share != null
          ? `Van je uitgaven in de afgelopen ${plural(cov.months, 'maand', 'maanden')} zit ${pct(cov.share)} in een bakje dat zegt waarvoor het was.`
          : 'Na een volle maand gegevens zie je hier hoeveel van je uitgaven verantwoord is.'}</p>
      </div>
    </section>

    ${cov?.unknown?.length > 0 && html`<${List} header="Niet verantwoord" footer="Sorteer wat kan; contant geld kun je zelf als uitgave toevoegen, dan telt het in het goede bakje.">
      ${cov.unknown.map((u) => {
        const cat = categoryById(u.category_id) || {};
        const info = UNKNOWN[u.key] || { text: cat.name };
        const to = info.to ? info.to() : `/overzicht/bakje/${u.category_id}`;
        return html`<${ListRow} key=${u.key} emoji=${cat.emoji || '❔'} color=${cat.color || 'gray'} title=${cat.name || u.key}
          subtitle=${info.text} value=${html`<span class="num">${euros(u.per_month_cents)} p/m</span>`} chevron onClick=${() => navigate(to)} />`;
      })}
    </${List}>`}

    <${List} header="Rekeningen" footer="Klopt het saldo met wat je bank laat zien? Zo niet, dan mist er waarschijnlijk een import.">
      ${c.accounts.map((a) => {
        const b = balanceOf(a.id);
        const sub = a.last_date ? `t/m ${shortDate(a.last_date)}${a.last_import ? ` · geïmporteerd ${relativeDays(a.last_import)}` : ''}` : 'Nog geen betalingen';
        const value = b?.balance_cents != null ? html`<span class="num">${money(b.balance_cents, { negative: true })}</span>` : null;
        return html`
          <${ListRow} key=${'a' + a.id} icon=${a.type === 'credit' ? 'creditcard' : a.type === 'savings' ? 'piggy' : 'wallet'} iconColor=${a.type === 'savings' ? 'teal' : 'blue'}
            title=${a.iban ? html`${a.name} <${Iban} iban=${a.iban} class="ctl-iban" />` : a.name} subtitle=${a.name === TYPE[a.type] ? sub : `${TYPE[a.type] || ''} · ${sub}`} value=${value} />
          ${a.missing_months.length > 0 && html`<${ListRow} key=${'m' + a.id} class="ctl-issue" icon="warning" iconColor="orange"
            title=${`Geen betalingen in ${a.missing_months.slice(0, 3).map((m) => monthLabel(m)).join(', ')}${a.missing_months.length > 3 ? ` en ${a.missing_months.length - 3} meer` : ''}`}
            subtitle="Importeer die maanden voor deze rekening" chevron onClick=${() => openImport()} />`}
          ${a.breaks.slice(-3).map((x) => html`<${ListRow} key=${'b' + a.id + x.date} class="ctl-issue" icon="warning" iconColor="orange"
            title=${`Saldo sluit niet aan op ${shortDate(x.date)}`}
            subtitle=${`${euros(Math.abs(x.difference_cents))} verschil: daarvoor mist waarschijnlijk een import`} chevron onClick=${() => openImport()} />`)}
          ${a.breaks_count > 3 && html`<${ListRow} key=${'bx' + a.id} class="ctl-issue" title=${`En nog ${a.breaks_count - 3} keer eerder`} />`}`;
      })}
    </${List}>

    ${c.transfers.count > 0 && html`<${List} header="Overboekingen zonder tegenboeking" footer="De andere rekening heeft rond die datum geen betaling van hetzelfde bedrag. Importeer die rekening over die periode.">
      ${c.transfers.items.map((t) => html`<${ListRow} key=${t.transaction_id} icon="arrow" iconColor="gray"
        title=${`${t.account} → ${t.other_account}`} subtitle=${shortDate(t.date)}
        value=${html`<span class="num">${money(t.amount_cents, { negative: true })}</span>`} />`)}
      ${c.transfers.count > c.transfers.items.length && html`<${ListRow} title=${`En nog ${c.transfers.count - c.transfers.items.length}`} />`}
    </${List}>`}

    ${issues > 0 && html`<div class="ctl-actions"><${Button} variant="tinted" onClick=${() => openImport()}>Importeren</${Button}></div>`}
  `;
}
