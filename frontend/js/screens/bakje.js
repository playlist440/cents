// Bakje detail (push from Overzicht): emoji tile, name, this month vs normaal, 12-month bars
// with scrubbing, top winkels, the month's payments. "Wijzig": name, emoji, colour.

import { html, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useStore, useQuery, categoryById, invalidate } from '../store.js';
import { euros, money, monthLabel, monthSmart, plural } from '../format.js';
import { Screen, NavButton } from '../components/Screen.js';
import { EmojiTile } from '../components/EmojiTile.js';
import { Card } from '../components/Card.js';
import { Section, List, ListRow } from '../components/List.js';
import { TxRow } from '../components/TxRow.js';
import { Skeleton } from '../components/Feedback.js';
import { Sheet, SheetButton } from '../components/Sheet.js';
import { TextField } from '../components/Fields.js';
import { EmojiPicker, ColorPicker } from '../components/Pickers.js';
import { BarChart } from '../charts/BarChart.js';
import { openSheet } from '../router.js';
import { openTransaction } from '../shell/actions.js';
import { toast } from '../components/Toast.js';
import { colorVar } from '../colors.js';

export function Bakje({ params, query }) {
  const id = Number(params.id);
  const boot = useStore((s) => s.boot);
  const cat = categoryById(id);
  const period = query.period || boot.periods.current;
  const { data } = useQuery(`category:${id}:${period}`, () => api.categorySummary(id, period));
  const [sel, setSel] = useState(null);

  if (!cat) return html`<${Screen} title="Bakje" large=${false}></${Screen}>`;
  const isCurrent = period === boot.periods.current;
  const income = cat.grp === 'income';
  const series = data?.series || [];
  const scrub = sel != null ? series[sel] : null;
  const head = scrub
    ? { cents: scrub.cents, label: monthLabel(scrub.period) }
    : { cents: data?.spent_cents, label: isCurrent ? 'deze maand' : monthLabel(period) };

  const edit = () => openSheet(EditBakjeSheet, { cat });

  const header = html`<header class="bakje-head">
    <${EmojiTile} emoji=${cat.emoji} color=${cat.color} size=${72} />
    <h1 class="bakje-name">${cat.name}</h1>
  </header>`;

  return html`<${Screen} title=${cat.name} header=${header} class="bakje"
      trailing=${html`<${NavButton} text="Wijzig" onClick=${edit} />`}>
    <${Card} class="bakje-chart" style=${{ '--c': colorVar(cat.color) }}>
      <div class="bc-head">
        <div>
          <div class="bc-value rounded num">${data ? euros(head.cents || 0) : html`<${Skeleton} w=${110} h=${30} />`}</div>
          <div class="bc-label">${head.label}${!scrub && data?.avg_cents ? html` · normaal <span class="num">${euros(data.avg_cents)}</span>` : ''}</div>
        </div>
      </div>
      ${data
        ? html`<${BarChart} height=${170} color=${colorVar(cat.color)}
            data=${series.map((s) => ({ label: monthLabel(s.period), short: monthLabel(s.period, { short: true, year: false }), value: s.cents }))}
            average=${data.avg_cents} highlight=${series.length - 1} selected=${sel} onSelect=${setSel}
            label=${`${cat.name} per maand, normaal ${euros(data.avg_cents)}`} />`
        : html`<${Skeleton} h=${170} r=${10} />`}
    </${Card}>

    ${data?.merchants?.length > 0 && html`<${Section} title=${income ? 'Van wie' : 'Top winkels'}>
      <${List}>
        ${data.merchants.slice(0, 5).map((m) => html`<${ListRow} key=${m.merchant_key} title=${m.merchant_name}
          subtitle=${plural(m.count, 'betaling', 'betalingen')} value=${html`<span class="num">${money(m.cents)}</span>`} />`)}
      </${List}>
    </${Section}>`}

    ${data && html`<${Section} title=${isCurrent ? 'Deze maand' : monthSmart(period)[0].toUpperCase() + monthSmart(period).slice(1)}>
      ${data.transactions.length
        ? html`<ul class="inset">${data.transactions.map((tx) => html`<${TxRow} key=${tx.id} tx=${tx} hideCategory date
            onClick=${() => openTransaction(tx)} />`)}</ul>`
        : html`<p class="quiet">Geen betalingen</p>`}
    </${Section}>`}
  </${Screen}>`;
}

function EditBakjeSheet({ cat, close }) {
  const [name, setName] = useState(cat.name);
  const [emoji, setEmoji] = useState(cat.emoji);
  const [color, setColor] = useState(cat.color);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.updateCategory(cat.id, { name: name.trim() || cat.name, emoji, color });
      invalidate();
      close();
    } catch (err) {
      setBusy(false);
      toast({ text: err.message, icon: 'warning' });
    }
  };
  return html`<${Sheet} title="Wijzig bakje"
      leading=${html`<${SheetButton} onClick=${close}>Annuleer</${SheetButton}>`}
      trailing=${html`<${SheetButton} bold onClick=${save} disabled=${busy || !name.trim()}>Klaar</${SheetButton}>`}>
    <div class="sheet-pad">
      <${EmojiPicker} value=${emoji} onChange=${setEmoji} color=${color} />
      <${List}><${TextField} label="Naam" value=${name} onInput=${setName} onEnter=${save} enterkeyhint="done" /></${List}>
      <${List} header="Kleur"><li class="field-row is-block"><${ColorPicker} value=${color} onChange=${setColor} /></li></${List}>
    </div>
  </${Sheet}>`;
}
