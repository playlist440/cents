// THE route table. One entry per screen; each screen lives in its own module in js/screens/.
// To build a screen, replace the contents of its module; do not edit this table unless you
// add a route.
//
// Route fields:
//   path         hash path, ":param" segments become props.params
//   screen       component; receives { params, query }
//   title        used for back-button labels of child screens
//   tab          tab bar item (< 1000 px) it belongs to; null = keep current tab
//   sidebar      sidebar item (≥ 1000 px) it belongs to (default: tab)
//   sidebarRoot  true when it is a top-level sidebar destination (no back button on wide)
//   parent       where the back button goes
//   presentation 'cover' slides up full screen without tab bar (Sorteren; on ≥ 1000 px it is
//                a normal sidebar destination with the sidebar visible)

import { Overzicht } from './screens/overzicht.js';
import { Bakje } from './screens/bakje.js';
import { Transacties } from './screens/transacties.js';
import { Potjes } from './screens/potjes.js';
import { Potje } from './screens/potje.js';
import { Vermogen } from './screens/vermogen.js';
import { Meer } from './screens/meer.js';
import { Sorteren } from './screens/sorteren.js';
import { VasteLasten } from './screens/vaste-lasten.js';
import { Jaaroverzicht } from './screens/jaaroverzicht.js';
import { Tags } from './screens/tags.js';
import { Tag } from './screens/tag.js';
import { Bakjes } from './screens/bakjes.js';
import { Terugblik, TerugblikPeriode, TerugblikJaar } from './screens/terugblik.js';
import { Instellingen, Regels, Imports, Backup } from './screens/instellingen.js';
import { Gallery } from './screens/gallery.js';
import { Aannames } from './screens/aannames.js';
import { Controle } from './screens/controle.js';
import { Besparen } from './screens/besparen.js';
import { Uitleg } from './screens/uitleg.js';
import { ImportSheet } from './screens/import.js';
import { UitgaveSheet } from './screens/uitgave.js';
import { TransactieSheet } from './screens/transactie.js';

export const routes = [
  { path: '/overzicht', screen: Overzicht, title: 'Overzicht', tab: 'overzicht', sidebarRoot: true },
  { path: '/overzicht/bakje/:id', screen: Bakje, title: 'Bakje', tab: 'overzicht', parent: '/overzicht' },
  { path: '/transacties', screen: Transacties, title: 'Transacties', tab: 'transacties', sidebarRoot: true },
  { path: '/potjes', screen: Potjes, title: 'Potjes', tab: 'potjes', sidebarRoot: true },
  { path: '/potjes/:id', screen: Potje, title: 'Potje', tab: 'potjes', parent: '/potjes' },
  { path: '/vermogen', screen: Vermogen, title: 'Vermogen', tab: 'vermogen', sidebarRoot: true },
  { path: '/meer', screen: Meer, title: 'Meer', tab: 'meer', sidebar: 'instellingen' },
  { path: '/sorteren', screen: Sorteren, title: 'Sorteren', tab: null, sidebar: 'sorteren', presentation: 'cover', parent: '/overzicht' },
  { path: '/vaste-lasten', screen: VasteLasten, title: 'Vaste lasten', tab: 'meer', sidebar: 'vaste-lasten', sidebarRoot: true, parent: '/meer' },
  { path: '/uitleg', screen: Uitleg, title: 'Uitleg', tab: 'meer', sidebar: 'instellingen', parent: '/meer' },
  { path: '/besparen', screen: Besparen, title: 'Besparen', tab: 'meer', sidebar: 'besparen', sidebarRoot: true, parent: '/meer' },
  { path: '/jaaroverzicht', screen: Jaaroverzicht, title: 'Jaaroverzicht', tab: 'meer', sidebar: 'jaaroverzicht', sidebarRoot: true, parent: '/meer' },
  { path: '/terugblik', screen: Terugblik, title: 'Terugblik', tab: 'meer', sidebar: 'terugblik', sidebarRoot: true, parent: '/meer' },
  { path: '/terugblik/jaar/:year', screen: TerugblikJaar, title: 'Terugblik', tab: 'meer', sidebar: 'terugblik', parent: '/terugblik' },
  { path: '/terugblik/:period', screen: TerugblikPeriode, title: 'Terugblik', tab: 'meer', sidebar: 'terugblik', parent: '/terugblik' },
  { path: '/tags', screen: Tags, title: 'Tags', tab: 'meer', sidebar: 'tags', sidebarRoot: true, parent: '/meer' },
  { path: '/tags/:id', screen: Tag, title: 'Tag', tab: 'meer', sidebar: 'tags', parent: '/tags' },
  { path: '/bakjes', screen: Bakjes, title: 'Bakjes', tab: 'meer', sidebar: 'instellingen', parent: '/meer' },
  { path: '/instellingen', screen: Instellingen, title: 'Instellingen', tab: 'meer', sidebar: 'instellingen', sidebarRoot: true, parent: '/meer' },
  { path: '/instellingen/aannames', screen: Aannames, title: 'Slimme aannames', tab: 'meer', sidebar: 'instellingen', parent: '/instellingen' },
  { path: '/instellingen/controle', screen: Controle, title: 'Controle', tab: 'meer', sidebar: 'instellingen', parent: '/instellingen' },
  { path: '/instellingen/regels', screen: Regels, title: 'Geleerde regels', tab: 'meer', sidebar: 'instellingen', parent: '/instellingen' },
  { path: '/instellingen/imports', screen: Imports, title: 'Importgeschiedenis', tab: 'meer', sidebar: 'instellingen', parent: '/instellingen' },
  { path: '/instellingen/backup', screen: Backup, title: 'Back-up en export', tab: 'meer', sidebar: 'instellingen', parent: '/instellingen' },
  { path: '/_gallery', screen: Gallery, title: 'Componenten', tab: 'meer', sidebar: 'instellingen', parent: '/meer' },
];

/** iPhone/iPad portrait tab bar. */
export const tabs = [
  { id: 'overzicht', label: 'Overzicht', icon: 'overzicht', path: '/overzicht' },
  { id: 'transacties', label: 'Transacties', icon: 'transacties', path: '/transacties' },
  { id: 'potjes', label: 'Potjes', icon: 'potjes', path: '/potjes' },
  { id: 'vermogen', label: 'Vermogen', icon: 'vermogen', path: '/vermogen' },
  { id: 'meer', label: 'Meer', icon: 'meer', path: '/meer' },
];

/** iPad landscape / Mac sidebar. */
export const sidebar = [
  { id: 'overzicht', label: 'Overzicht', icon: 'overzicht', path: '/overzicht' },
  { id: 'transacties', label: 'Transacties', icon: 'transacties', path: '/transacties' },
  { id: 'potjes', label: 'Potjes', icon: 'potjes', path: '/potjes' },
  { id: 'vermogen', label: 'Vermogen', icon: 'vermogen', path: '/vermogen' },
  { id: 'vaste-lasten', label: 'Vaste lasten', icon: 'vaste-lasten', path: '/vaste-lasten' },
  { id: 'besparen', label: 'Besparen', icon: 'euro', path: '/besparen' },
  { id: 'jaaroverzicht', label: 'Jaaroverzicht', icon: 'jaaroverzicht', path: '/jaaroverzicht' },
  { id: 'tags', label: 'Tags', icon: 'tag', path: '/tags' },
  { id: 'sorteren', label: 'Sorteren', icon: 'sorteren', path: '/sorteren', badge: 'unsorted' },
  { id: 'instellingen', label: 'Instellingen', icon: 'instellingen', path: '/instellingen', bottom: true },
];

/** Sheets opened by name (shell/actions.js). Each is a component rendering <Sheet>. */
export const sheets = {
  import: ImportSheet,
  uitgave: UitgaveSheet,
  transactie: TransactieSheet,
};
