// Bakjes (Meer → Bakjes): simple management without reordering. Lists per group, edit name /
// emoji / colour, show or hide, add a custom bakje (soort vast / dagelijks / inkomen), delete
// custom ones (with undo; their payments go back to "Nog te sorteren").

import { html, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useStore, invalidate } from '../store.js';
import { openSheet } from '../router.js';
import { Screen, NavButton } from '../components/Screen.js';
import { List, ListRow } from '../components/List.js';
import { Segmented, Switch } from '../components/Controls.js';
import { Sheet, SheetButton } from '../components/Sheet.js';
import { TextField } from '../components/Fields.js';
import { EmojiPicker, ColorPicker } from '../components/Pickers.js';
import { EmojiTile } from '../components/EmojiTile.js';
import { openMenu } from '../components/Menu.js';
import { toast } from '../components/Toast.js';
import { commitLater, usePending } from './_kit.js';
import { useLayout } from '../hooks.js';
import { InstSplit } from './instellingen.js';

const GROUPS = [
  { grp: 'income', title: 'Inkomen' },
  { grp: 'fixed', title: 'Vaste lasten' },
  { grp: 'daily', title: 'Dagelijks' },
  { grp: 'saving', title: 'Sparen' },
];
const SOORT = [['fixed', 'Vast'], ['daily', 'Dagelijks'], ['income', 'Inkomen']];
// System bakjes the user cannot meaningfully edit here.
const SKIP = new Set(['unsorted', 'intern', 'creditcard']);

export function Bakjes() {
  const cats = useStore((s) => s.boot?.categories) || [];
  const pending = usePending();
  const visible = cats.filter((c) => !SKIP.has(c.key) && !pending.has('cat:' + c.id));
  const add = () => openSheet(BakjeSheet, {});
  const desk = useLayout() === 'wide';
  const body = GROUPS.map((g) => {
      const list = visible.filter((c) => c.grp === g.grp).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id - b.id);
      if (!list.length) return null;
      return html`<${List} key=${g.grp} header=${g.title}>
        ${list.map((c) => html`<${ListRow} key=${c.id}
          leading=${html`<span class=${c.hidden ? 'bk-dim' : ''}><${EmojiTile} emoji=${c.emoji} color=${c.color} size=${32} /></span>`}
          title=${html`<span class=${c.hidden ? 'bk-dim' : ''}>${c.name}</span>`}
          value=${c.hidden ? 'Verborgen' : !c.builtin ? 'Eigen' : null}
          chevron onClick=${() => openSheet(BakjeSheet, { cat: c })} label=${c.name + (c.hidden ? ', verborgen' : '')} />`)}
      </${List}>`;
    });
  return html`<${Screen} title="Bakjes" class="bk" back=${desk ? false : undefined} add=${[{ label: 'Nieuw bakje', icon: 'bakjes', onSelect: add }]} trailing=${html`<${NavButton} icon="plus" label="Nieuw bakje" onClick=${add} />`}>
    ${desk ? html`<${InstSplit} active="bakjes">${body}</${InstSplit}>` : body}
  </${Screen}>`;
}

function BakjeSheet({ close, cat = null }) {
  const isNew = !cat;
  const [name, setName] = useState(cat?.name || '');
  const [emoji, setEmoji] = useState(cat?.emoji || '📦');
  const [color, setColor] = useState(cat?.color || 'blue');
  const [grp, setGrp] = useState(cat?.grp || 'daily');
  const [shown, setShown] = useState(!cat?.hidden);
  const [busy, setBusy] = useState(false);
  const custom = isNew || !cat.builtin;

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (isNew) {
        await api.createCategory({ name: name.trim(), emoji, color, grp });
        toast({ emoji, text: `${name.trim()} toegevoegd` });
      } else {
        const changes = { name: name.trim(), emoji, color, hidden: !shown };
        if (custom && grp !== cat.grp) changes.grp = grp;
        await api.updateCategory(cat.id, changes);
      }
      invalidate();
      close();
    } catch (err) {
      setBusy(false);
      toast({ text: err.message, icon: 'warning' });
    }
  };

  const remove = (e) => openMenu(e.currentTarget, [{
    label: `Verwijder ${cat.name}`, icon: 'trash', destructive: true, onSelect: () => {
      const undo = commitLater('cat:' + cat.id, () => api.deleteCategory(cat.id));
      close();
      toast({ emoji: cat.emoji, text: `${cat.name} verwijderd`, action: { label: 'Herstel', onClick: undo } });
    },
  }]);

  return html`<${Sheet} title=${isNew ? 'Nieuw bakje' : 'Wijzig bakje'} detents=${['large']}
      leading=${html`<${SheetButton} onClick=${close}>Annuleer</${SheetButton}>`}
      trailing=${html`<${SheetButton} bold onClick=${save} disabled=${!name.trim() || busy}>${isNew ? 'Voeg toe' : 'Klaar'}</${SheetButton}>`}>
    <div class="sheet-pad">
      <${EmojiPicker} value=${emoji} onChange=${setEmoji} color=${color} />
      <${List}>
        <${TextField} label="Naam" value=${name} onInput=${setName} placeholder="Sport" maxLength=${60} onEnter=${save} enterkeyhint="done" />
      </${List}>
      ${custom && html`<${List} header="Soort">
        <li class="field-row is-block bk-seg"><${Segmented} value=${grp} onChange=${setGrp} options=${SOORT} label="Soort" /></li>
      </${List}>`}
      <${List} header="Kleur"><li class="field-row is-block"><${ColorPicker} value=${color} onChange=${setColor} /></li></${List}>
      ${!isNew && html`<${List} footer=${shown ? null : 'Verborgen bakjes staan niet in de keuzelijsten. Betalingen blijven meetellen.'}>
        <li class="field-row">
          <label class="field-label bk-grow" for="bk-shown">Tonen</label>
          <${Switch} id="bk-shown" checked=${shown} onChange=${setShown} label="Tonen" />
        </li>
      </${List}>`}
      ${!isNew && custom && html`<${List}><${ListRow} title="Verwijder bakje" destructive onClick=${remove} /></${List}>`}
    </div>
  </${Sheet}>`;
}
