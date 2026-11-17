// Form fields. All inputs are ≥ 16 px (no iOS zoom). Use inside a <List> for the inset form
// look, or with `boxed` for a standalone rounded field.
//
//   html`<${List}><${TextField} label="Naam" value=${name} onInput=${setName} /></${List}>`
//   html`<${AmountField} cents=${c} onChange=${setC} large />`        numeric keypad, comma decimal
//   html`<${DateField} label="Datum" value=${iso} onChange=${setIso} />`

import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js';
import { parseAmount, amountInput, typedAmount } from '../format.js';
import { useId } from '../hooks.js';

export function TextField({ label, value, onInput, placeholder, type = 'text', boxed = false, autocomplete = 'off', enterkeyhint, inputmode, autoFocus, onEnter, name, id, invalid = false, maxLength, class: cls = '', inputRef, ...rest }) {
  const auto = useId('tf');
  const fid = id || auto;
  const input = html`<input id=${fid} ref=${inputRef} class="field-input" type=${type} value=${value} placeholder=${placeholder}
    name=${name} autocomplete=${autocomplete} enterkeyhint=${enterkeyhint} inputmode=${inputmode} maxLength=${maxLength}
    autocapitalize=${type === 'text' ? 'sentences' : 'off'} autofocus=${autoFocus} aria-invalid=${invalid ? 'true' : null}
    aria-label=${label ? null : placeholder}
    onInput=${(e) => onInput?.(e.currentTarget.value)}
    onKeyDown=${(e) => { if (e.key === 'Enter' && onEnter && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); onEnter(); } }} ...${rest} />`;
  if (boxed) return html`<div class=${'field-boxed ' + (invalid ? 'is-invalid ' : '') + cls}>${input}</div>`;
  return html`<li class=${'field-row ' + cls}>
    ${label && html`<label class="field-label" for=${fid}>${label}</label>`}
    ${input}
  </li>`;
}

/** Amount in cents. Shows Dutch decimals ("12,50"); the keypad is the decimal one. */
export function AmountField({ cents, onChange, label, placeholder = '0', large = false, autoFocus = false, sign = '' }) {
  const [text, setText] = useState(amountInput(cents));
  const fid = useId('amt');
  const last = useRef(cents);
  useEffect(() => {
    if (cents !== last.current) { setText(amountInput(cents)); last.current = cents; }
  }, [cents]);
  const onInput = (e) => {
    const v = typedAmount(e.currentTarget.value);
    if (v !== e.currentTarget.value) e.currentTarget.value = v;
    setText(v);
    const c = parseAmount(v);
    last.current = c;
    onChange(c);
  };
  const input = html`<input id=${fid} class="field-input amount-input" type="text" inputmode="decimal" enterkeyhint="done"
    size=${Math.max(large ? 2 : 3, (text || placeholder).length + 1)}
    autocomplete="off" placeholder=${placeholder} value=${text} onInput=${onInput} autofocus=${autoFocus}
    aria-label=${label || 'Bedrag'} />`;
  if (large) {
    return html`<div class="amount-large">
      <span class="amount-large-cur" aria-hidden="true">${sign}€</span>${input}
    </div>`;
  }
  return html`<li class="field-row">
    ${label && html`<label class="field-label" for=${fid}>${label}</label>`}
    <span class="amount-prefix" aria-hidden="true">€</span>${input}
  </li>`;
}

export function DateField({ label = 'Datum', value, onChange, min, max, optional = false }) {
  const fid = useId('date');
  return html`<li class="field-row">
    <label class="field-label" for=${fid}>${label}</label>
    <input id=${fid} class="field-input date-input" type="date" value=${value || ''} min=${min} max=${max}
      required=${!optional} onChange=${(e) => onChange(e.currentTarget.value || null)} onInput=${(e) => onChange(e.currentTarget.value || null)} />
  </li>`;
}
