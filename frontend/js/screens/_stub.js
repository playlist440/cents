// Placeholder used by screens that are not built yet. Replace the screen module's contents;
// do not import this from finished screens.

import { html } from '../vendor/preact-htm.js';
import { Screen } from '../components/Screen.js';
import { EmptyState } from '../components/Feedback.js';

export function Stub({ title, emoji = '🚧', large = true, children }) {
  return html`<${Screen} title=${title} large=${large}>
    <${EmptyState} emoji=${emoji} title=${title} subtitle="Komt eraan" />
    ${children}
  </${Screen}>`;
}
