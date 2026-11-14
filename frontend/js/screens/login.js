// Login and first run. Centred icon, "Cents", password field(s), "Ga verder". A hidden
// username "gezin" plus autocomplete hints let iCloud Keychain save and fill the password.

import { html, useState, useRef } from '../vendor/preact-htm.js';
import { api } from '../api.js';
import { setState } from '../store.js';
import { Button } from '../components/Controls.js';

export function Login({ setup = false }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const fields = useRef(null);
  const [note, setNote] = useState('');
  const first = useRef(null);
  const second = useRef(null);

  const wobble = (el) => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    fields.current?.animate(
      reduce ? [{ opacity: 1 }, { opacity: 0.4 }, { opacity: 1 }]
        : [0, -12, 10, -8, 6, -3, 0].map((x) => ({ transform: `translateX(${x}px)` })),
      { duration: 420, easing: 'ease-out' },
    );
    el?.select?.();
    el?.focus?.();
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setNote('');
    if (setup) {
      if (pw.length < 8) { setNote('Minimaal 8 tekens'); wobble(first.current); return; }
      if (pw !== pw2) { setNote('De wachtwoorden zijn niet gelijk'); wobble(second.current); return; }
    } else if (!pw) { wobble(first.current); return; }
    setBusy(true);
    try {
      if (setup) await api.setup(pw);
      else await api.login(pw);
      setState({ session: await api.session() });
    } catch (err) {
      setBusy(false);
      if (err.status === 429) setNote('Even wachten en opnieuw proberen');
      else if (err.status === 0) setNote('Geen verbinding');
      else if (err.status !== 401) setNote(err.message);
      wobble(first.current);
    }
  };

  return html`<main class="login">
    <form class="login-card" onSubmit=${submit} autocomplete="on" method="post" action="#">
      <img class="login-icon" src="icons/icon.svg" alt="" width="88" height="88" />
      <h1 class="login-title">${setup ? 'Kies een wachtwoord' : 'Cents'}</h1>
      <input type="text" name="username" value="gezin" autocomplete="username" class="vh" tabindex="-1" aria-hidden="true" readonly />
      <div class="login-fields" ref=${fields}>
        <div class="field-boxed">
          <input ref=${first} class="field-input" type="password" name="password" value=${pw}
            placeholder=${setup ? 'Nieuw wachtwoord' : 'Wachtwoord'} aria-label=${setup ? 'Nieuw wachtwoord' : 'Wachtwoord'}
            autocomplete=${setup ? 'new-password' : 'current-password'} enterkeyhint=${setup ? 'next' : 'go'}
            autofocus onInput=${(e) => setPw(e.currentTarget.value)} />
        </div>
        ${setup && html`<div class="field-boxed">
          <input ref=${second} class="field-input" type="password" name="password2" value=${pw2}
            placeholder="Herhaal wachtwoord" aria-label="Herhaal wachtwoord" autocomplete="new-password" enterkeyhint="go"
            onInput=${(e) => setPw2(e.currentTarget.value)} />
        </div>`}
      </div>
      <p class="login-note" role="alert">${note}</p>
      <${Button} type="submit" block loading=${busy} disabled=${setup ? !pw || !pw2 : !pw}>Ga verder</${Button}>
    </form>
  </main>`;
}
