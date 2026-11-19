// Uitleg: the words Cents uses, each in one or two plain sentences (usability test 2026-11:
// "bakje", "potje", "netto gespaard" and "aflossing" were not clear to people without a
// financial background). Reachable from Meer and from Hoe staan we ervoor.

import { html } from '../vendor/preact-htm.js';
import { Screen } from '../components/Screen.js';
import { List } from '../components/List.js';
import { useLayout } from '../hooks.js';

const WORDS = [
  ['Bakje', 'Een soort uitgave of inkomen, zoals Boodschappen of Wonen. Elke betaling komt in één bakje; zo zie je waar het geld heen gaat.'],
  ['Sorteren', 'Een bakje kiezen voor betalingen die Cents niet herkende. Wat je één keer kiest, onthoudt Cents voor die winkel.'],
  ['Potje', 'Geld dat je opzij zet voor een doel, zoals een vakantie. Het blijft gewoon op je spaarrekening staan; Cents houdt bij welk deel van wie is.'],
  ['Vaste lasten', 'Wat elke maand of elk jaar terugkomt en lastig te schrappen is: wonen, energie, verzekeringen, abonnementen.'],
  ['Dagelijks', 'Uitgaven die je zelf kiest en die wisselen: boodschappen, uit eten, kleding. Het onregelmatige deel (vakantie, kleding, cadeaus, huis & tuin) komt een paar keer per jaar.'],
  ['Normaal', 'Wat een bakje in een gewone maand kost: het middelste bedrag van de afgelopen zes maanden. Halverwege de maand vergelijkt Cents met een gewone maand tot dezelfde dag.'],
  ['Over of tekort', 'Inkomen min vaste lasten en dagelijkse uitgaven. Wat je spaart is geen uitgave: dat zit in wat er over is.'],
  ['Nog te besteden', 'Wat er op de betaalrekening overblijft tot je salaris, als je in je normale tempo uitgeeft. Is het negatief, dan heet het Tekort. Het is een bestedingsbudget: creditcardaankopen tellen al mee, ook als ze pas na je salaris worden afgeschreven.'],
  ['Sparen min opnemen', 'Geld tussen je eigen rekeningen is nooit inkomen of een uitgave. Voor Nog te besteden telt wat tot je salaris nog naar je spaarrekening gaat, min wat terugkomt, zoals wekelijks terugstorten uit een potje.'],
  ['Geld dat binnenkomt zonder bakje', 'Een tikkie, terugbetaling of verkoop zonder bakje maakt je dagelijkse uitgaven lager; het is geen inkomen. Vanaf € 500 telt Cents het wel als inkomen, tot je het sorteert.'],
  ['Vaste lasten als deel van je inkomen', 'Zonder aflossing: dat deel van je hypotheek maakt je schuld kleiner en is sparen, net als bij Over of tekort. De buffer rekent wel met de hele betaling, want die moet je echt betalen.'],
  ['Vrij spaargeld', 'Je spaargeld min de potjes en de buffer: wat je zonder plan opzij hebt staan. Heb je geen buffer-potje, dan vult je vrije spaargeld eerst de buffer; pas wat daarboven zit is vrij.'],
  ['Buffer', 'Spaargeld voor onverwachte uitgaven, zoals een kapotte wasmachine. Cents telt het in maanden vaste lasten.'],
  ['Aflossing', 'Het deel van je hypotheek- of leningbetaling waarmee de schuld kleiner wordt. Cents telt het als sparen, niet als kosten: je vermogen groeit erdoor.'],
  ['Gespaard', 'Wat naar sparen en beleggen ging, min wat je eraf haalde, plus de aflossing.'],
  ['Rente, dividend en koers', 'Rente op je spaarrekening telt als inkomen. Dividend en koerswinst blijven in je beleggingen en zie je terug in je vermogen, niet als inkomen.'],
  ['Creditcard in je vermogen', 'Cents kent de openstaande creditcardschuld alleen van aankopen die je zelf invult in het creditcard-bestand. Zonder die regels zie je de schuld pas bij de afschrijving.'],
  ['Extra aflossen', 'Heb je in een jaar zelf extra afgelost? Vul dat in bij de jaaropgave (Waarvan extra afgelost). Dan rekent Cents het gewone maandbedrag goed uit in aflossing en rente.'],
  ['Verantwoord', 'Het deel van je uitgaven dat in een bakje zit dat zegt waarvoor het was. Contant geld en "Overig" tellen als onbekend.'],
  ['Verdelen en bezitting', 'Een grote aankoop die je jaren gebruikt, kun je over maanden verdelen. Iets dat je later verkoopt, zoals een auto, wordt een bezitting: elke maand telt het waardeverlies.'],
];

export function Uitleg() {
  const desk = useLayout() === 'wide';
  return html`<${Screen} title="Uitleg" back=${desk ? false : undefined} class="uitleg">
    <${List}>
      ${WORDS.map(([word, text]) => html`<li class="row-li" key=${word}><div class="row is-two uitleg-row">
        <span class="row-main"><span class="row-title">${word}</span><span class="row-sub">${text}</span></span>
      </div></li>`)}
    </${List}>
  </${Screen}>`;
}
