// Named token colours used by bakjes, potjes and tags (SPEC §4.1 "color").

export const COLOR_NAMES = ['green', 'mint', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'pink', 'red', 'orange', 'yellow', 'brown', 'gray'];

export const DUTCH_COLOR = {
  green: 'groen', mint: 'mint', teal: 'blauwgroen', cyan: 'lichtblauw', blue: 'blauw', indigo: 'indigo',
  purple: 'paars', pink: 'roze', red: 'rood', orange: 'oranje', yellow: 'geel', brown: 'bruin', gray: 'grijs',
};

/** CSS value for a colour name; unknown names fall back to gray. */
export function colorVar(name) {
  return `var(--${COLOR_NAMES.includes(name) ? name : 'gray'})`;
}

/** Text colour for a colour name (darker in light mode, lighter in dark; ≥ 4.5:1). */
export function colorTextVar(name) {
  return `var(--${COLOR_NAMES.includes(name) ? name : 'gray'}-text)`;
}
