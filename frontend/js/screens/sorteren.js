// Sorteren (DESIGN §3): one card per merchant. The suggested bakje is a big button, every other
// bakje a tile below. A tap makes the card fly into the chosen tile while the next card springs
// in; nothing waits for the network (the queue is prefetched, saves run in the background).
// Swipe the card right = suggestion, left = skip (buttons always do the same). Undo via toast,
// the nav-bar button or ⌘Z. Keys: 1 suggestion, 2–9 tiles, space skip, Esc done.

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useStore, categoryById, categoryByKey, invalidate } from '../store.js';
import { navigate, back as routerBack, previousEntry } from '../router.js';
import { usePage, reducedMotion, canHover, isWide } from '../hooks.js';
import { money, plural, shortDate } from '../format.js';
import { Screen, NavButton } from '../components/Screen.js';
import { Button } from '../components/Controls.js';
import { Skeleton } from '../components/Feedback.js';
import { EmojiTile } from '../components/EmojiTile.js';
import { toast } from '../components/Toast.js';
import { colorVar } from '../colors.js';
import { BakjeGrid, METHOD_LABEL } from './_tx.js';
import { useDrawIn, SPRING } from '../anim.js';

export function Sorteren() {
  useStore((s) => s.boot);
  const page = usePage();
  const [s, setS] = useState({ queue: null, i: 0, total: 0, done: 0, txDone: 0, skipped: [], history: [], used: [], error: null });
  const st = useRef(s);
  st.current = s;
  const cardRef = useRef(null);
  const tiles = useRef(new Map());
  const primaryRef = useRef(null);
  const fetching = useRef(false);

  const load = async (append = false) => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const res = await api.sortQueue();
      setS((cur) => {
        if (!append) return { ...cur, queue: res.items, i: 0, total: res.remaining ?? res.items.length, done: 0, txDone: 0, skipped: [], history: [], used: [], error: null };
        const seen = new Set(cur.queue.map((x) => x.merchant_key));
        return { ...cur, queue: cur.queue.concat(res.items.filter((x) => !seen.has(x.merchant_key))) };
      });
    } catch (err) {
      setS((cur) => ({ ...cur, error: err, queue: cur.queue || [] }));
    } finally { fetching.current = false; }
  };

  // Fresh queue every time the flow opens.
  useEffect(() => { if (page.active) load(); }, [page.active]);

  const item = s.queue?.[s.i] || null;
  const sign = item && item.total_cents > 0 ? 'in' : 'out';
  const suggestions = (item?.suggestions || []).map(categoryById).filter((c) => c && c.key !== 'unsorted' && !c.hidden);
  const fallback = categoryByKey(sign === 'in' ? 'inkomen-overig' : 'overig');
  // Persons and payment intermediaries (p: / via:) get no suggested bakje: skipping is the
  // primary action; any tile below still sorts them.
  const person = !!item && (item.is_person || /^(p|via):/.test(item.merchant_key || ''));
  const primary = person ? null : suggestions[0] || fallback;
  const others = suggestions.slice(1).map((c) => c.id);

  // Prefetch more when the local queue runs low (the API returns at most 200 merchants).
  useEffect(() => {
    if (s.queue && s.total > s.queue.length && s.i >= s.queue.length - 5) load(true);
  }, [s.i]);

  /* ---------- Actions ---------- */

  const advance = (patch) => setS((cur) => ({ ...cur, ...patch(cur), i: cur.i + 1 }));

  const pick = (cat, target) => {
    const it = st.current.queue?.[st.current.i];
    if (!it || !cat) return;
    fly(cardRef.current, target || tiles.current.get(cat.id) || primaryRef.current, cat);
    advance((cur) => ({
      done: cur.done + 1,
      txDone: cur.txDone + it.count,
      history: [...cur.history, { kind: 'sort', item: it, index: cur.i, cat }],
      used: cur.used.includes(cat.emoji) ? cur.used : [...cur.used, cat.emoji],
    }));
    api.sort(it.merchant_key, cat.id).then(() => invalidate(), (err) => {
      toast({ text: err.message, icon: 'warning' });
      // Put it back so nothing is lost.
      setS((cur) => ({ ...cur, queue: [...cur.queue.slice(0, cur.i), it, ...cur.queue.slice(cur.i)], done: cur.done - 1, txDone: cur.txDone - it.count, history: cur.history.filter((h) => h.item !== it) }));
    });
    toast({ emoji: cat.emoji, text: `${it.merchant_name} → ${cat.name}`, action: { label: 'Herstel', onClick: () => undoItem(it) }, duration: 6000 });
  };

  const skip = (dir = -1) => {
    const it = st.current.queue?.[st.current.i];
    if (!it) return;
    flyOff(cardRef.current, dir);
    advance((cur) => ({ skipped: [...cur.skipped, it], history: [...cur.history, { kind: 'skip', item: it, index: cur.i }] }));
  };

  function undo() {
    const cur = st.current;
    const last = cur.history[cur.history.length - 1];
    if (!last) return;
    // Undo is "go back one card": anything after it in history is gone too (it is the last one).
    setS((c) => ({
      ...c,
      i: last.index,
      queue: c.queue[last.index] === last.item ? c.queue : [...c.queue.slice(0, last.index), last.item, ...c.queue.slice(last.index)],
      history: c.history.slice(0, -1),
      done: last.kind === 'sort' ? c.done - 1 : c.done,
      txDone: last.kind === 'sort' ? c.txDone - last.item.count : c.txDone,
      skipped: last.kind === 'skip' ? c.skipped.filter((x) => x !== last.item) : c.skipped,
    }));
    if (last.kind === 'sort') {
      const unsorted = categoryByKey('unsorted');
      api.sort(last.item.merchant_key, unsorted.id).then(() => invalidate(), (err) => toast({ text: err.message, icon: 'warning' }));
      toast({ icon: 'undo', text: `${last.item.merchant_name} terug`, duration: 1800 });
    }
  }

  /** Undo one specific sort (from its toast): that merchant becomes the current card again. */
  function undoItem(it) {
    const cur = st.current;
    const h = cur.history.find((x) => x.kind === 'sort' && x.item === it);
    if (!h) return;
    setS((c) => {
      const rest = c.queue.filter((x, k) => !(x === it && k < c.i));
      const removedBefore = c.queue.slice(0, c.i).includes(it) ? 1 : 0;
      const i = c.i - removedBefore;
      return {
        ...c,
        queue: [...rest.slice(0, i), it, ...rest.slice(i)],
        i,
        history: c.history.filter((x) => x !== h),
        done: c.done - 1,
        txDone: c.txDone - it.count,
      };
    });
    const unsorted = categoryByKey('unsorted');
    api.sort(it.merchant_key, unsorted.id).then(() => invalidate(), (err) => toast({ text: err.message, icon: 'warning' }));
  }

  const again = () => setS((cur) => ({ ...cur, queue: cur.skipped, i: 0, skipped: [], history: [], total: cur.skipped.length + cur.done }));
  // "Klaar" goes back to where you came from (Controle, Overzicht, …), else to Overzicht.
  const close = () => {
    invalidate();
    if (previousEntry()) routerBack();
    else navigate('/overzicht', { replace: true, direction: isWide() ? 'tab' : 'uncover' });
  };

  /* ---------- Keyboard ---------- */
  useEffect(() => {
    if (!page.active) return;
    const onKey = (e) => {
      if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName) || document.querySelector('.sheet-layer')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (!st.current.queue?.[st.current.i]) return;
      if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); skip(); return; }
      if (/^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const n = Number(e.key);
        if (n === 1) { if (primaryRef.current?.__cat) pick(primaryRef.current.__cat, primaryRef.current); else skip(); return; }
        const el = cardRef.current?.closest('.so')?.querySelectorAll('.so-grid .bk-tile')[n - 2];
        if (el) el.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page.active]);

  /* ---------- Render ---------- */
  const finished = s.queue && !item;
  const position = Math.min(s.total, s.done + s.skipped.length + 1);
  const progress = s.total ? (s.done + s.skipped.length) / s.total : 0;
  const hints = canHover();

  const titleView = s.queue && !finished
    ? html`<span class="so-count num" aria-live="polite">${position} van ${s.total}</span>`
    : html`<span class="so-count">Sorteren</span>`;

  return html`<${Screen} title="Sorteren" large=${false} back=${false} titleView=${titleView} class="so-screen"
      leading=${s.history.length > 0 && !finished ? html`<${NavButton} icon="undo" label="Herstel vorige" onClick=${undo} />` : null}
      trailing=${html`<${NavButton} text="Klaar" bold onClick=${close} />`}>
    <div class="so-progress" aria-hidden="true"><span style=${{ transform: `scaleX(${finished ? 1 : progress})` }}></span></div>
    ${!s.queue
      ? html`<${SortSkeleton} />`
      : finished
        ? html`<${Finished} done=${s.done} txDone=${s.txDone} skipped=${s.skipped.length} used=${s.used} onAgain=${again} onClose=${close} error=${s.error} />`
        : html`<div class="so">
            <${Card} key=${item.merchant_key} item=${item} cardRef=${cardRef} primary=${primary}
              onAccept=${() => (primary ? pick(primary, primaryRef.current) : skip(1))} onSkip=${() => skip(-1)} />
            <div class="so-actions">
              ${primary
                ? html`<button class="so-primary" ref=${(el) => { primaryRef.current = el; if (el) el.__cat = primary; }}
                    style=${{ '--c': colorVar(primary?.color) }} onClick=${(e) => pick(primary, e.currentTarget)}>
                    <span class="so-primary-emoji" aria-hidden="true">${primary?.emoji}</span>
                    <span class="so-primary-name">${primary?.name}</span>
                    ${hints && html`<kbd class="so-key" aria-hidden="true">1</kbd>`}
                  </button>
                  <button class="so-skip" onClick=${() => skip(-1)}>
                    Sla over${hints ? html`<kbd class="so-key" aria-hidden="true">spatie</kbd>` : ''}
                  </button>`
                : html`<button class="so-primary is-skip" ref=${(el) => { primaryRef.current = el; if (el) el.__cat = null; }} onClick=${() => skip(-1)}>
                    <span class="so-primary-name">Sla over</span>
                    ${hints && html`<kbd class="so-key" aria-hidden="true">spatie</kbd>`}
                  </button>`}
            </div>
            <div class="so-grid">
              <${BakjeGrid} sign=${sign} first=${others} exclude=${primary ? [primary.id] : []} hints=${hints} size=${46}
                label="Ander bakje" onPick=${(c, el) => pick(c, el)} tileRef=${(id, el) => { if (el) tiles.current.set(id, el); else tiles.current.delete(id); }} />
            </div>
          </div>`}
  </${Screen}>`;
}

/* ---------- The card (with swipe) ---------- */

function Card({ item, cardRef, primary, onAccept, onSkip }) {
  const drag = useRef(null);
  const [dx, setDx] = useState(0);
  // The next card springs in (end state is the base style; see anim.js).
  const springIn = useDrawIn([{ opacity: 0, transform: 'translateY(14px) scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 460, easing: SPRING });
  const income = item.total_cents > 0;
  const facts = [
    plural(item.count, 'betaling', 'betalingen'),
    money(item.total_cents, { whole: Math.abs(item.total_cents) >= 10000, signed: true }),
    item.count > 1 ? `laatst ${shortDate(item.last_date)}` : shortDate(item.last_date),
  ];
  const meta = [item.is_person ? 'Persoon' : null, METHOD_LABEL[item.method], item.city].filter(Boolean).join(' · ');

  const down = (e) => {
    if (e.button > 0 || e.target.closest('button')) return;
    drag.current = { x: e.clientX, y: e.clientY, lock: null, id: e.pointerId };
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const x = e.clientX - d.x;
    const y = e.clientY - d.y;
    if (!d.lock && (Math.abs(x) > 8 || Math.abs(y) > 8)) {
      d.lock = Math.abs(x) > Math.abs(y) ? 'x' : 'y';
      if (d.lock === 'x') e.currentTarget.setPointerCapture(d.id);
    }
    if (d.lock === 'x') setDx(x);
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.lock !== 'x') { setDx(0); return; }
    const x = dx;
    if (x > 110) onAccept();
    else if (x < -110) onSkip();
    else setDx(0);
  };

  const t = Math.max(-1, Math.min(1, dx / 140));
  const style = dx ? { transform: `translateX(${dx}px) rotate(${dx / 28}deg)`, transition: 'none' } : null;
  return html`<article class=${'so-card' + (item.is_person ? ' is-person' : '')} ref=${(el) => { if (typeof cardRef === 'function') cardRef(el); else if (cardRef) cardRef.current = el; springIn(el); }} style=${style}
      onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up} aria-label=${item.merchant_name}>
    ${primary && html`<span class="so-badge is-yes" style=${{ opacity: Math.max(0, t), '--c': colorVar(primary.color) }} aria-hidden="true">${primary.emoji} ${primary.name}</span>`}
    <span class="so-badge is-no" style=${{ opacity: Math.max(0, -t) }} aria-hidden="true">Sla over</span>
    <span class="so-avatar" aria-hidden="true">${item.is_person ? '👤' : html`<${EmojiTile} dashed size=${56} />`}</span>
    <h2 class="so-name">${item.merchant_name}</h2>
    <p class=${'so-facts num' + (income ? ' is-income' : '')}>${facts.join(' · ')}</p>
    ${meta && html`<p class="so-meta">${meta}</p>`}
    ${item.sample_description && html`<p class="so-sample">${item.sample_description}</p>`}
  </article>`;
}

/* ---------- Motion ---------- */

function fly(card, target, cat) {
  if (!card) return;
  if (reducedMotion() || !target) { ghost(card, [{ opacity: 1 }, { opacity: 0 }], 160); return; }
  const a = card.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  const tx = b.left + b.width / 2 - (a.left + a.width / 2);
  const ty = b.top + b.height / 2 - (a.top + a.height / 2);
  const s = Math.max(0.08, Math.min(b.width / a.width, 0.3));
  const cur = getComputedStyle(card).transform;
  ghost(card, [
    { transform: cur === 'none' ? 'none' : cur, opacity: 1, borderRadius: '28px' },
    { transform: `translate(${tx * 0.55}px, ${ty * 0.55}px) scale(${(1 + s) / 2})`, opacity: 0.9, offset: 0.5 },
    { transform: `translate(${tx}px, ${ty}px) scale(${s})`, opacity: 0, borderRadius: '60px' },
  ], 420, 'cubic-bezier(.5, 0, .3, 1)');
  // The tile "catches" the card.
  setTimeout(() => {
    target.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.14)' }, { transform: 'scale(1)' }], { duration: 320, easing: 'cubic-bezier(.34,1.56,.64,1)' });
  }, 300);
}

function flyOff(card, dir) {
  if (!card) return;
  if (reducedMotion()) { ghost(card, [{ opacity: 1 }, { opacity: 0 }], 160); return; }
  const cur = getComputedStyle(card).transform;
  ghost(card, [
    { transform: cur === 'none' ? 'none' : cur, opacity: 1 },
    { transform: `translateX(${dir * 120}vw) rotate(${dir * 14}deg)`, opacity: 0.6 },
  ], 320, 'cubic-bezier(.4, 0, .6, 1)');
}

/** Animate a detached copy of the card so the real one can show the next merchant at once. */
function ghost(card, frames, duration, easing = 'linear') {
  const r = card.getBoundingClientRect();
  const g = card.cloneNode(true);
  g.removeAttribute('id');
  g.setAttribute('aria-hidden', 'true');
  g.classList.add('so-ghost');
  Object.assign(g.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', margin: '0', zIndex: '60', pointerEvents: 'none', transition: 'none' });
  document.body.appendChild(g);
  const anim = g.animate(frames, { duration, easing, fill: 'forwards' });
  const done = () => g.remove();
  anim.onfinish = done;
  setTimeout(done, duration + 200);
}

/* ---------- Finished ---------- */

function Finished({ done, txDone, skipped, used, onAgain, onClose, error }) {
  if (error && !done) {
    return html`<div class="so-end">
      <div class="so-end-emoji" aria-hidden="true">📡</div>
      <h2 class="so-end-title">Niet geladen</h2>
      <p class="so-end-sub">${error.message}</p>
      <${Button} size="medium" onClick=${onClose}>Klaar</${Button}>
    </div>`;
  }
  const all = skipped === 0;
  return html`<div class="so-end">
    ${all && html`<div class="so-burst" aria-hidden="true">
      ${used.slice(0, 10).map((em, i) => html`<span style=${{ '--i': i, '--n': Math.min(used.length, 10) }}>${em}</span>`)}
    </div>`}
    <div class=${'so-check' + (all ? '' : ' is-partial')} aria-hidden="true">
      <svg viewBox="0 0 96 96" width="96" height="96">
        <circle class="so-check-ring" cx="48" cy="48" r="44" pathLength="100" />
        ${all ? html`<path class="so-check-mark" d="M30 49.5l12 12 25-26" pathLength="100" />`
          : html`<text x="48" y="58" text-anchor="middle" class="so-check-num">${skipped}</text>`}
      </svg>
    </div>
    <h2 class="so-end-title">${all ? 'Alles gesorteerd' : plural(skipped, 'winkel overgeslagen', 'winkels overgeslagen')}</h2>
    ${done > 0 && html`<p class="so-end-sub">${plural(done, 'winkel', 'winkels')} · ${plural(txDone, 'betaling', 'betalingen')}</p>`}
    <div class="so-end-actions">
      ${!all && html`<${Button} variant="tinted" size="medium" onClick=${onAgain}>Bekijk ze nog eens</${Button}>`}
      <${Button} size="medium" onClick=${onClose}>Klaar</${Button}>
    </div>
  </div>`;
}

function SortSkeleton() {
  return html`<div class="so" aria-busy="true" aria-label="Laden">
    <div class="so-card">
      <${Skeleton} w=${56} h=${56} r=${16} />
      <${Skeleton} w="60%" h=${28} r=${8} style=${{ marginTop: '14px' }} />
      <${Skeleton} w="75%" h=${16} style=${{ marginTop: '10px' }} />
    </div>
    <div class="so-actions"><${Skeleton} h=${56} r=${16} /></div>
  </div>`;
}

