// "Uitgave toevoegen" (DESIGN §3): large amount, wat, bakje tiles, datum, rekening (the credit
// card when there is one), tags. Saves as a manual transaction; undo removes it again.
// Props: { close, account_id? }

import { html, useState } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { useStore, invalidate } from '../store.js';
import { todayISO, money } from '../format.js';
import { Sheet, SheetButton } from '../components/Sheet.js';
import { List } from '../components/List.js';
import { TextField, AmountField, DateField } from '../components/Fields.js';
import { openMenu } from '../components/Menu.js';
import { toast } from '../components/Toast.js';
import { Icon } from '../icons.js';
import { BakjeGrid, TagEditor, emitTxChange } from './_tx.js';

export function UitgaveSheet({ close, account_id }) {
  const boot = useStore((s) => s.boot);
  const accounts = boot.accounts.filter((a) => !a.hidden && a.type !== 'investment');
  const card = accounts.find((a) => a.type === 'credit');
  const [cents, setCents] = useState(null);
  const [what, setWhat] = useState('');
  const [cat, setCat] = useState(null);
  const [date, setDate] = useState(todayISO());
  const [acc, setAcc] = useState(account_id || card?.id || accounts.find((a) => a.type === 'checking')?.id || accounts[0]?.id);
  const [tags, setTags] = useState([]);
  const [busy, setBusy] = useState(false);
  const account = accounts.find((a) => a.id === acc);
  const ready = cents > 0 && what.trim() && date && acc && !busy;

  const save = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const res = await api.createTransaction({
        account_id: acc, date, amount_cents: -Math.abs(cents), merchant_name: what.trim(),
        category_id: cat?.id ?? null, tag_ids: tags, note: null,
      });
      const tx = res?.transaction || res;
      invalidate();
      close();
      toast({
        emoji: cat?.emoji, icon: cat ? undefined : 'check',
        text: `${money(-Math.abs(cents))} · ${what.trim()}`,
        action: {
          label: 'Herstel',
          onClick: async () => {
            try { await api.deleteTransaction(tx.id); emitTxChange({ ids: [tx.id], removed: true }); invalidate(); } catch (err) { toast({ text: err.message, icon: 'warning' }); }
          },
        },
      });
    } catch (err) {
      setBusy(false);
      toast({ text: err.message, icon: 'warning' });
    }
  };

  const pickAccount = (e) => openMenu(e.currentTarget, accounts.map((a) => ({ label: a.name, checked: a.id === acc, onSelect: () => setAcc(a.id) })));

  return html`<${Sheet} title="Nieuwe uitgave" detents=${['large']}
      leading=${html`<${SheetButton} onClick=${close}>Annuleer</${SheetButton}>`}
      trailing=${html`<${SheetButton} bold disabled=${!ready} onClick=${save}>Voeg toe</${SheetButton}>`}>
    <div class="sheet-pad ug">
      <${AmountField} cents=${cents} onChange=${setCents} large autoFocus label="Bedrag" />
      <${List}>
        <${TextField} label="Wat" value=${what} onInput=${setWhat} placeholder="Bijv. Bakker" enterkeyhint="done" maxLength=${200} />
        <${DateField} value=${date} onChange=${setDate} max=${todayISO()} />
        ${accounts.length > 1 && html`<li class="row-li"><button class="row is-button ug-account" onClick=${pickAccount}>
          <span class="row-main"><span class="row-title">Rekening</span></span>
          <span class="row-value">${account?.name}</span>
          <span class="row-chev"><${Icon} name="chevron-up-down" size=${16} stroke=${2.2} /></span>
        </button></li>`}
      </${List}>
      <section class="ug-sec">
        <h3 class="list-header">Bakje</h3>
        <div class="td-card"><${BakjeGrid} value=${cat?.id} onPick=${(c) => setCat(cat?.id === c.id ? null : c)} /></div>
      </section>
      <section class="ug-sec">
        <h3 class="list-header">Tags</h3>
        <div class="td-card"><${TagEditor} tagIds=${tags} onChange=${(ids) => setTags(ids)} /></div>
      </section>
    </div>
  </${Sheet}>`;
}
