// #/_gallery — every component and chart, for visual QA in light and dark. Dev only.

import { html, useState } from '../vendor/preact-htm.js';
import { Screen } from '../components/Screen.js';
import { Section, List, ListRow } from '../components/List.js';
import { Button, Chip, Segmented, Switch, SearchField } from '../components/Controls.js';
import { TextField, AmountField, DateField } from '../components/Fields.js';
import { EmojiPicker, ColorPicker } from '../components/Pickers.js';
import { MonthSwitcher } from '../components/MonthSwitcher.js';
import { EmojiTile } from '../components/EmojiTile.js';
import { Amount } from '../components/Amount.js';
import { Card, Tile } from '../components/Card.js';
import { TxRow } from '../components/TxRow.js';
import { Skeleton, EmptyState, DropZone, ProgressRing } from '../components/Feedback.js';
import { Sheet, SheetButton } from '../components/Sheet.js';
import { openMenu } from '../components/Menu.js';
import { toast } from '../components/Toast.js';
import { StackedCapsule } from '../charts/StackedCapsule.js';
import { RankedBars } from '../charts/RankedBars.js';
import { BarChart } from '../charts/BarChart.js';
import { LineChart } from '../charts/LineChart.js';
import { PaceChart } from '../charts/PaceChart.js';
import { Sparkline } from '../charts/Sparkline.js';
import { Icon, iconNames } from '../icons.js';
import { openSheet } from '../router.js';
import { COLOR_NAMES } from '../colors.js';
import { euros, monthLabel, shiftPeriod, todayISO } from '../format.js';

const MONTHS = Array.from({ length: 12 }, (_, i) => shiftPeriod(todayISO().slice(0, 7), i - 11));
const bars = MONTHS.map((m, i) => ({ label: monthLabel(m), short: monthLabel(m, { short: true, year: false }), value: 30000 + Math.round(Math.sin(i) * 9000 + i * 1200) }));
const stacked = MONTHS.map((m, i) => ({ label: monthLabel(m), short: monthLabel(m, { short: true, year: false }), values: [210000 + i * 900, 140000 + Math.round(Math.cos(i) * 30000), 45000 + (i % 3) * 10000] }));
const income = MONTHS.map((_, i) => 520000 + (i === 4 ? 260000 : 0));
const line = MONTHS.map((m, i) => ({ label: monthLabel(m), value: 2400000 + i * 85000 + Math.round(Math.sin(i * 1.3) * 120000) }));
const typical = Array.from({ length: 30 }, (_, i) => Math.round((i + 1) * 5200 + Math.sin(i / 3) * 4000));
const actual = typical.slice(0, 14).map((v, i) => Math.round(v * 0.86 + i * 300));
const sampleTx = [
  { id: 1, merchant_name: 'Albert Heijn', amount_cents: -4312, category_id: 12, city: 'Amersfoort', tag_ids: [], kind: 'normal', date: todayISO() },
  { id: 2, merchant_name: 'Noordhoek Techniek', amount_cents: 341218, category_id: 1, city: null, tag_ids: [], kind: 'normal', date: todayISO() },
  { id: 3, merchant_name: 'Tegelhandel Van Os', amount_cents: -48900, category_id: 15, city: null, tag_ids: [1], kind: 'normal', date: todayISO() },
  { id: 4, merchant_name: 'Sportcafé De Kuil', amount_cents: -2350, category_id: 30, city: 'Amersfoort', tag_ids: [], kind: 'normal', date: todayISO() },
];

function DemoSheet({ close, detents }) {
  const [name, setName] = useState('');
  return html`<${Sheet} title="Voorbeeld" detents=${detents}
      leading=${html`<${SheetButton} onClick=${close}>Annuleer</${SheetButton}>`}
      trailing=${html`<${SheetButton} bold onClick=${close}>Klaar</${SheetButton}>`}>
    <div class="sheet-pad">
      <${List}><${TextField} label="Naam" value=${name} onInput=${setName} placeholder="Typ iets" /></${List}>
      ${Array.from({ length: detents ? 14 : 3 }, (_, i) => html`<${List}><${ListRow} emoji="🛒" color="green" title=${'Rij ' + (i + 1)} value="€ 12" /></${List}>`)}
    </div>
  </${Sheet}>`;
}

export function Gallery() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'system');
  const [seg, setSeg] = useState('uit');
  const [sw, setSw] = useState(true);
  const [q, setQ] = useState('');
  const [text, setText] = useState('');
  const [cents, setCents] = useState(1250);
  const [date, setDate] = useState(todayISO());
  const [emoji, setEmoji] = useState('🛒');
  const [color, setColor] = useState('green');
  const [period, setPeriod] = useState(MONTHS[11]);
  const [amt, setAmt] = useState(64000);
  const [sel, setSel] = useState(null);
  const [scrub, setScrub] = useState(null);
  const [chip, setChip] = useState(true);

  const applyTheme = (t) => {
    setTheme(t);
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  };

  return html`<${Screen} title="Componenten" class="gallery">
    <${Segmented} value=${theme} onChange=${applyTheme} label="Weergave"
      options=${[['system', 'Auto'], ['light', 'Licht'], ['dark', 'Donker']]} />

    <${Section} title="Tekst">
      <${Card}>
        <div class="t-largetitle">Large title</div><div class="t-title1">Title 1</div><div class="t-title2">Title 2</div>
        <div class="t-title3">Title 3</div><div class="t-headline">Headline</div><div class="t-body">Body: nog te besteden</div>
        <div class="t-callout">Callout</div><div class="t-subhead c-2">Subhead</div><div class="t-footnote c-2">Footnote</div>
        <div class="t-caption c-2">Caption</div>
      </${Card}>
    </${Section}>

    <${Section} title="Knoppen">
      <div class="g-row">
        <${Button}>Ga verder</${Button}>
        <${Button} variant="tinted">Tinted</${Button}>
        <${Button} variant="gray">Gray</${Button}>
        <${Button} variant="plain">Plain</${Button}>
        <${Button} variant="destructive">Verwijder</${Button}>
        <${Button} disabled>Uit</${Button}>
        <${Button} loading>Laden</${Button}>
      </div>
      <div class="g-row">
        <${Button} size="medium" icon="plus">Potje</${Button}>
        <${Button} size="small">Sorteren</${Button}>
        <${Button} size="small" variant="tinted" icon="copy">Kopieer</${Button}>
      </div>
      <${Button} block>Breed</${Button}>
    </${Section}>

    <${Section} title="Chips, segmented, switch">
      <div class="g-row">
        <${Chip} selected=${chip} onClick=${() => setChip(!chip)}>Bakje</${Chip}>
        <${Chip} onClick=${() => {}}>Tag</${Chip}>
        <${Chip} emoji="🛒" color="green" selected onClick=${() => {}}>Boodschappen</${Chip}>
        <${Chip} emoji="🇫🇷" color="cyan" removable onClick=${() => {}}>Vakantie Frankrijk</${Chip}>
        <span class="mini-chip tone-more">€ 40 meer</span><span class="mini-chip tone-less">€ 25 minder</span>
        <span class="mini-chip tone-warn">Loopt achter</span><span class="mini-chip tone-good">Op schema</span>
      </div>
      <div class="g-row"><${Segmented} value=${seg} onChange=${setSeg} label="Soort" options=${[['uit', 'Uitgaven'], ['in', 'Inkomsten']]} /></div>
      <div class="g-row"><${Segmented} value=${seg} onChange=${setSeg} label="Bereik" size="small" options=${[['uit', '6M'], ['in', '1J'], ['alles', 'Alles']]} /></div>
      <${List}><${ListRow} title="Voor alle van Jumbo" accessory=${html`<${Switch} checked=${sw} onChange=${setSw} label="Voor alle van Jumbo" />`} /></${List}>
      <div class="g-pad"><${SearchField} value=${q} onInput=${setQ} /></div>
    </${Section}>

    <${Section} title="Velden">
      <${List}>
        <${TextField} label="Naam" value=${text} onInput=${setText} placeholder="Vakantie" />
        <${AmountField} label="Doel" cents=${cents} onChange=${setCents} />
        <${DateField} label="Datum" value=${date} onChange=${setDate} />
      </${List}>
      <${AmountField} large cents=${cents} onChange=${setCents} />
      <div class="g-pad"><${TextField} boxed placeholder="Wachtwoord" type="password" value="" onInput=${() => {}} /></div>
    </${Section}>

    <${Section} title="Emoji en kleur">
      <${Card}><${EmojiPicker} value=${emoji} onChange=${setEmoji} color=${color} /></${Card}>
      <div class="g-gap"></div>
      <${Card}><${ColorPicker} value=${color} onChange=${setColor} /></${Card}>
      <div class="g-row g-tiles">${COLOR_NAMES.map((c) => html`<${EmojiTile} emoji=${emoji} color=${c} size=${40} />`)}<${EmojiTile} dashed size=${40} /></div>
    </${Section}>

    <${Section} title="Maand">
      <div class="g-row"><${MonthSwitcher} value=${period} first=${MONTHS[0]} last=${MONTHS[11]} onChange=${setPeriod} /></div>
    </${Section}>

    <${Section} title="Lijsten">
      <${List} header="Groep" footer="Voetnoot onder een groep.">
        <${ListRow} emoji="🛒" color="green" title="Boodschappen" value="€ 412" chevron onClick=${() => {}} />
        <${ListRow} icon="import" title="Importeren" chevron onClick=${() => {}} />
        <${ListRow} title="Twee regels" subtitle="tweede regel · Amersfoort" value="€ 9,99" />
        <${ListRow} title="Gekozen" selected onClick=${() => {}} />
        <${ListRow} title="Verwijder" destructive onClick=${() => {}} />
      </${List}>
      <ul class="inset">${sampleTx.map((tx) => html`<${TxRow} tx=${tx} onClick=${() => {}} />`)}</ul>
    </${Section}>

    <${Section} title="Kaarten en tegels">
      <div class="tiles">
        <${Tile} label="Inkomen" icon="euro" color="green" cents=${541800} progress=${0.8} sub="van € 5.780" onClick=${() => {}} />
        <${Tile} label="Vaste lasten" icon="vaste-lasten" color="indigo" cents=${214000} progress=${0.92} sub="nog € 180" onClick=${() => {}} />
        <${Tile} label="Dagelijks" icon="creditcard" color="blue" cents=${112300} sub="normaal € 1.240" onClick=${() => {}} />
        <${Tile} label="Gespaard" icon="piggy" color="teal" cents=${45000} onClick=${() => {}} />
      </div>
      <div class="g-gap"></div>
      <${Card}>
        <div class="hero-amount rounded"><${Amount} cents=${amt} whole animate /></div>
        <div class="g-row"><${Button} size="small" variant="tinted" onClick=${() => setAmt(Math.round(Math.random() * 200000))}>Ander bedrag</${Button}>
          <${Amount} cents=${-4120} /> <${Amount} cents=${341218} signed /></div>
      </${Card}>
    </${Section}>

    <${Section} title="Ringen">
      <${Card} class="g-rings">
        <${ProgressRing} value=${0.62} color="cyan" size=${120} emoji="✈️" label="Vakantie 62 procent" />
        <${ProgressRing} value=${0.25} color="orange" size=${88} emoji="🚲" />
        <${ProgressRing} value=${1.18} color="teal" size=${88} emoji="🛟" />
        <${ProgressRing} value=${1} color="red" size=${64} stroke=${8} emoji="🎄" />
      </${Card}>
    </${Section}>

    <${Section} title="Grafieken">
      <${Card}><${StackedCapsule} segments=${[
        { value: 41200, color: 'green', label: 'Boodschappen' }, { value: 18000, color: 'orange', label: 'Uit eten' },
        { value: 22000, color: 'blue', label: 'Vervoer' }, { value: 9000, color: 'pink', label: 'Kleding' }, { value: 6000, color: 'gray', label: 'Overig' }]} /></${Card}>
      <div class="g-gap"></div>
      <${RankedBars} rows=${[
        { emoji: '🛒', color: 'green', label: 'Boodschappen', value: 41200, chip: { text: '€ 40 meer', tone: 'more' }, onClick: () => {} },
        { emoji: '🚗', color: 'blue', label: 'Auto & vervoer', value: 22000, onClick: () => {} },
        { emoji: '🍽️', color: 'orange', label: 'Uit eten & bezorgen', value: 18000, chip: { text: '€ 25 minder', tone: 'less' }, onClick: () => {} },
        { dashed: true, color: 'gray', label: 'Nog te sorteren', value: 4300 }]} />
      <div class="g-gap"></div>
      <${Card}>
        <div class="bc-value rounded num">${sel != null ? euros(bars[sel].value) : euros(bars[11].value)}</div>
        <div class="bc-label">${sel != null ? bars[sel].label : 'deze maand'}</div>
        <${BarChart} data=${bars} average=${36000} selected=${sel} onSelect=${setSel} highlight=${11} label="Uitgaven per maand" />
      </${Card}>
      <div class="g-gap"></div>
      <${Card}>
        <div class="legend"><span><i style=${{ background: 'var(--indigo)' }}></i>Vast</span><span><i style=${{ background: 'var(--blue)' }}></i>Dagelijks</span><span><i style=${{ background: 'var(--teal)' }}></i>Gespaard</span><span><i class="is-line" style=${{ background: 'var(--tint)' }}></i>Inkomen</span></div>
        <${BarChart} data=${stacked} series=${[{ name: 'Vast', color: 'var(--indigo)' }, { name: 'Dagelijks', color: 'var(--blue)' }, { name: 'Gespaard', color: 'var(--teal)' }]}
          line=${{ name: 'Inkomen', color: 'var(--tint)', values: income }} height=${200} label="Jaaroverzicht" />
      </${Card}>
      <div class="g-gap"></div>
      <${Card}>
        <div class="bc-value rounded num">${euros((scrub != null ? line[scrub] : line.at(-1)).value)}</div>
        <div class="bc-label">${scrub != null ? line[scrub].label : 'Vermogen'}</div>
        <${LineChart} points=${line} onScrub=${setScrub} scrub=${scrub} label="Vermogen per maand" />
      </${Card}>
      <div class="g-gap"></div>
      <${Card}><${PaceChart} actual=${actual} typical=${typical} label="Tempo" /></${Card}>
      <div class="g-gap"></div>
      <${List}><${ListRow} title="Spaarrekening" subtitle="NL•• 0702" value="€ 8.412"
        accessory=${html`<${Sparkline} values=${[3, 4, 3.5, 5, 6, 5.8, 7]} label="Stijgend" />`} /></${List}>
    </${Section}>

    <${Section} title="Feedback">
      <${Card}><${Skeleton} w="40%" h=${15} /><${Skeleton} w="70%" h=${30} style=${{ margin: '10px 0' }} /><${Skeleton} h=${60} /></${Card}>
      <${EmptyState} emoji="🎉" title="Alles gesorteerd" action=${{ label: 'Klaar', onClick: () => {} }} />
      <${DropZone} onFiles=${(f) => toast({ text: f.length + ' bestand(en)' })} />
      <div class="g-row">
        <${Button} size="medium" variant="tinted" onClick=${(e) => openMenu(e.currentTarget, [
          { label: 'Bankbestand importeren', icon: 'import', onSelect: () => toast('Importeren') },
          { label: 'Uitgave toevoegen', icon: 'creditcard', onSelect: () => toast('Toevoegen') }, '-',
          { label: 'Verwijder', icon: 'trash', destructive: true, onSelect: () => toast('Weg') }])}>Menu</${Button}>
        <${Button} size="medium" variant="tinted" onClick=${() => toast({ text: '12 betalingen naar Boodschappen', emoji: '🛒', action: { label: 'Herstel', onClick: () => toast('Hersteld') } })}>Toast</${Button}>
        <${Button} size="medium" variant="tinted" onClick=${() => openSheet(DemoSheet, {})}>Sheet</${Button}>
        <${Button} size="medium" variant="tinted" onClick=${() => openSheet(DemoSheet, { detents: ['medium', 'large'] })}>Sheet met detents</${Button}>
      </div>
    </${Section}>

    <${Section} title="Iconen">
      <${Card} class="g-icons">${iconNames.map((n) => html`<span class="g-icon" title=${n}><${Icon} name=${n} size=${26} /><small>${n}</small></span>`)}</${Card}>
    </${Section}>
  </${Screen}>`;
}
