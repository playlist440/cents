// Tags (DESIGN §3): list of tags with totals; "+" makes a new tag (name + emoji + colour).
// Also exports the tag edit sheet and delete-with-undo used by the tag detail (tag.js).

import { html, useEffect, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useQuery, useStore, invalidate } from '../store.js';
import { navigate } from '../router.js';
import { openSheet } from '../router.js';
import { money, plural, shortDate } from '../format.js';
import { Screen, NavButton } from '../components/Screen.js';
import { List, ListRow } from '../components/List.js';
import { Skeleton, EmptyState } from '../components/Feedback.js';
import { Sheet, SheetButton } from '../components/Sheet.js';
import { TextField } from '../components/Fields.js';
import { EmojiPicker, ColorPicker } from '../components/Pickers.js';
import { Button } from '../components/Controls.js';
import { toast } from '../components/Toast.js';
import { splitEmoji, nextTagColor } from './_tx.js';
import { useLayout, usePage, isWide } from '../hooks.js';
import { openPopover } from '../components/Menu.js';
import { SettingsSplit } from '../components/SettingsSplit.js';

/** Mac: tags on the left, the chosen tag on the right (System Settings layout). */
export function TagsSplit({ active, children }) {
  const { data } = useQuery('tags:totals', loadTags);
  const hidden = usePendingDeletes();
  const tags = (data || []).filter((t) => !hidden.has(t.id));
  const go = (t) => navigate(`/tags/${t.id}`, { direction: 'none' });
  const row = (t) => ({ id: t.id, label: t.name, emoji: t.emoji || '🏷️', color: t.color, value: t.out_cents ? money(t.out_cents, { whole: true }) : '', dim: t.archived, onClick: () => go(t) });
  const active_ = tags.filter((t) => !t.archived);
  const archived = tags.filter((t) => t.archived);
  return html`<${SettingsSplit} label="Tags" active=${active} items=${[...active_.map(row), ...(archived.length ? ['-', ...archived.map(row)] : [])]}>${children}</${SettingsSplit}>`;
}

const TAG_EMOJI = ['🏷️', '🛁', '🏡', '✈️', '🏖️', '🎂', '🎁', '🎄', '🚗', '🚲', '👶', '🐶', '🎓', '💍', '🩺', '⚽️', '🎸', '🛠️', '🌱', '🍷', '🎉', '📦', '💼', '🧾'];

/* ---------- Delete with undo (commits after the toast) ---------- */

const pending = new Map(); // tag id -> timer
const pendingListeners = new Set();
const notify = () => pendingListeners.forEach((fn) => fn(new Set(pending.keys())));

export function usePendingDeletes() {
  const [ids, setIds] = useState(() => new Set(pending.keys()));
  useEffect(() => { pendingListeners.add(setIds); return () => pendingListeners.delete(setIds); }, []);
  return ids;
}

export function deleteTagWithUndo(tag) {
  const commit = async () => {
    pending.delete(tag.id);
    try { await api.deleteTag(tag.id); } catch (err) { toast({ text: err.message, icon: 'warning' }); }
    notify();
    invalidate();
  };
  pending.set(tag.id, setTimeout(commit, 5400));
  notify();
  toast({
    emoji: tag.emoji || '🏷️',
    text: `${tag.name} verwijderd`,
    action: { label: 'Herstel', onClick: () => { clearTimeout(pending.get(tag.id)); pending.delete(tag.id); notify(); } },
  });
}
// Leaving the page: commit what is pending (best effort).
addEventListener('pagehide', () => { for (const [id, t] of pending) { clearTimeout(t); api.deleteTag(id).catch(() => {}); } pending.clear(); });

/* ---------- List ---------- */

async function loadTags() {
  const tags = await api.tags();
  const totals = await Promise.all(tags.map((t) => api.transactions({ tag_id: t.id, limit: 1 }).catch(() => null)));
  return tags.map((t, i) => ({
    ...t,
    out_cents: totals[i]?.sum_out_cents ?? 0,
    in_cents: totals[i]?.sum_in_cents ?? 0,
    count: totals[i]?.count ?? t.count ?? 0,
    last_date: totals[i]?.items?.[0]?.date || null,
  }));
}

export function Tags() {
  useStore((s) => s.boot);
  const { data, error } = useQuery('tags:totals', loadTags);
  const hidden = usePendingDeletes();
  const add = (e) => openTagEditor(e?.currentTarget?.classList?.contains('navbtn') ? e.currentTarget : null, {});
  const tags = (data || []).filter((t) => !hidden.has(t.id));
  const active = tags.filter((t) => !t.archived);
  const archived = tags.filter((t) => t.archived);
  const desk = useLayout() === 'wide';
  const page = usePage();
  // Mac: open the first tag in the split right away (no empty half screen).
  useEffect(() => {
    if (desk && page.active && active.length) navigate(`/tags/${active[0].id}`, { replace: true, direction: 'none' });
  }, [desk, page.active, active.length]);

  const row = (t) => html`<${ListRow} key=${t.id} emoji=${t.emoji || '🏷️'} color=${t.color} title=${t.name}
    subtitle=${t.count ? `${plural(t.count, 'betaling', 'betalingen')}${t.last_date ? ' · ' + shortDate(t.last_date) : ''}` : 'Nog niets'}
    value=${t.out_cents ? html`<span class="num tg-total">${money(t.out_cents)}</span>` : null}
    chevron onClick=${() => navigate(`/tags/${t.id}`)} />`;

  return html`<${Screen} title="Tags" class="tg-screen" add=${[{ label: 'Nieuwe tag', icon: 'tag', onSelect: add }]} trailing=${html`<${NavButton} icon="plus" label="Nieuwe tag" onClick=${add} />`}>
    ${!data
      ? (error ? html`<${EmptyState} emoji="📡" title="Niet geladen" action=${{ label: 'Opnieuw', variant: 'tinted', onClick: invalidate }} />` : html`<${TagsSkeleton} />`)
      : !tags.length
        ? html`<${EmptyState} emoji="🏷️" title="Nog geen tags" action=${{ label: 'Nieuwe tag', onClick: add }} />`
        : html`
          <${List}>${active.map(row)}</${List}>
          ${archived.length > 0 && html`<${List} header="Gearchiveerd">${archived.map(row)}</${List}>`}`}
  </${Screen}>`;
}

function TagsSkeleton() {
  return html`<div class="inset" aria-busy="true" aria-label="Laden">
    ${[0, 1, 2, 3].map((i) => html`<div class="row has-lead is-two" key=${i}>
      <span class="row-lead"><${Skeleton} w=${32} h=${32} r=${9} /></span>
      <span class="row-main"><${Skeleton} w="45%" h=${15} /><${Skeleton} w="30%" h=${13} style=${{ marginTop: '6px' }} /></span>
      <${Skeleton} w=${60} h=${15} />
    </div>`)}
  </div>`;
}

/* ---------- New / edit sheet ---------- */

/** New / edit tag: a popover anchored to its button on the Mac, a sheet on the phone. */
export function openTagEditor(anchor, props = {}) {
  const el = anchor || document.querySelector('.page:not([hidden]) .tb-add');
  if (isWide() && el) openPopover(el, (close) => html`<${TagSheet} ...${props} close=${close} popover />`, { width: 340, label: props.tag ? 'Wijzig tag' : 'Nieuwe tag' });
  else openSheet(TagSheet, props);
}

export function TagSheet({ tag, close, onDeleted, popover = false }) {
  const [name, setName] = useState(tag?.name || '');
  const [emoji, setEmoji] = useState(tag?.emoji || '🏷️');
  const [color, setColor] = useState(tag?.color || nextTagColor());
  const [busy, setBusy] = useState(false);
  const typed = splitEmoji(name);
  const ready = (typed.name || '').trim() && !busy;

  const save = async () => {
    if (!ready) return;
    setBusy(true);
    const body = { name: typed.name.trim(), emoji: typed.emoji || emoji, color };
    try {
      if (tag) await api.updateTag(tag.id, body);
      else {
        const t = await api.createTag(body);
        close();
        invalidate();
        navigate(`/tags/${t.id}`);
        return;
      }
      invalidate();
      close();
    } catch (err) {
      setBusy(false);
      toast({ text: err.message, icon: 'warning' });
    }
  };

  const remove = () => { close(); onDeleted?.(); deleteTagWithUndo(tag); };

  if (popover) {
    return html`<div class="pop-pad tg-pop">
      <div class="pop-title">${tag ? 'Wijzig tag' : 'Nieuwe tag'}</div>
      <${EmojiPicker} value=${typed.emoji || emoji} onChange=${setEmoji} color=${color} suggestions=${TAG_EMOJI} />
      <${TextField} boxed value=${name} onInput=${setName} onEnter=${save} placeholder="Naam, bijv. Vakantie Italië" maxLength=${60} autoFocus />
      <div class="tg-pop-colors"><${ColorPicker} value=${color} onChange=${setColor} /></div>
      <div class="pop-foot">
        ${tag && html`<${Button} variant="plain" size="small" class="tg-pop-del" onClick=${remove}>Verwijder</${Button}>`}
        <${Button} variant="gray" size="small" onClick=${close}>Annuleer</${Button}>
        <${Button} size="small" onClick=${save} disabled=${!ready}>Bewaar</${Button}>
      </div>
    </div>`;
  }
  return html`<${Sheet} title=${tag ? 'Wijzig tag' : 'Nieuwe tag'}
      leading=${html`<${SheetButton} onClick=${close}>Annuleer</${SheetButton}>`}
      trailing=${html`<${SheetButton} bold onClick=${save} disabled=${!ready}>Bewaar</${SheetButton}>`}>
    <div class="sheet-pad">
      <${EmojiPicker} value=${typed.emoji || emoji} onChange=${setEmoji} color=${color} suggestions=${TAG_EMOJI} />
      <${List}><${TextField} label="Naam" value=${name} onInput=${setName} onEnter=${save} enterkeyhint="done" placeholder="Bijv. Vakantie Italië" maxLength=${60} autoFocus=${!tag} /></${List}>
      <${List} header="Kleur"><li class="field-row is-block"><${ColorPicker} value=${color} onChange=${setColor} /></li></${List}>
      ${tag && html`<div class="tg-delete"><${Button} variant="destructive" block icon="trash" onClick=${remove}>Verwijder tag</${Button}></div>`}
    </div>
  </${Sheet}>`;
}
