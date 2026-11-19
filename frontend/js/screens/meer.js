// Meer (iPhone tab, DESIGN §3): inset grouped list of destinations, then Instellingen, and the
// version at the bottom.

import { html } from '../vendor/preact-htm.js';
import { Screen } from '../components/Screen.js';
import { List, ListRow } from '../components/List.js';
import { navigate } from '../router.js';
import { useStore } from '../store.js';
import { openImport } from '../shell/actions.js';

export function Meer() {
  const boot = useStore((s) => s.boot);
  const version = useStore((s) => s.session?.version);
  const n = boot?.unsorted_merchants || 0;
  return html`<${Screen} title="Meer" class="meer">
    <${List}>
      <${ListRow} icon="import" iconColor="green" title="Importeren" chevron onClick=${() => openImport()} />
      <${ListRow} icon="sorteren" iconColor="orange" title="Sorteren" value=${n ? html`<span class="meer-count num">${n}</span>` : null}
        chevron onClick=${() => navigate('/sorteren')} label=${n ? `Sorteren, ${n} winkels` : 'Sorteren'} />
    </${List}>
    <${List}>
      <${ListRow} icon="vaste-lasten" iconColor="indigo" title="Vaste lasten" chevron onClick=${() => navigate('/vaste-lasten')} />
      <${ListRow} icon="euro" iconColor="green" title="Besparen" chevron onClick=${() => navigate('/besparen')} />
      <${ListRow} icon="jaaroverzicht" iconColor="blue" title="Jaaroverzicht" chevron onClick=${() => navigate('/jaaroverzicht')} />
      <${ListRow} icon="clock" iconColor="teal" title="Terugblik" chevron onClick=${() => navigate('/terugblik')} />
      <${ListRow} icon="tag" iconColor="pink" title="Tags" chevron onClick=${() => navigate('/tags')} />
      <${ListRow} icon="bakjes" iconColor="yellow" title="Bakjes" chevron onClick=${() => navigate('/bakjes')} />
    </${List}>
    <${List}>
      <${ListRow} icon="instellingen" iconColor="gray" title="Instellingen" chevron onClick=${() => navigate('/instellingen')} />
    </${List}>
    ${version && html`<p class="meer-version">Cents ${version} · <a href="https://github.com/playlist440/cents" target="_blank" rel="noopener noreferrer">Broncode</a> · AGPL-3.0</p>`}
  </${Screen}>`;
}
