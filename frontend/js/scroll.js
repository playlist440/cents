// Document scroll helpers. The document scrolls (not an inner div) so iOS keeps
// status-bar-tap-to-top and native momentum. While a sheet is open the body is pinned with
// position:fixed (the only reliable iOS scroll lock); scrollY() still reports the real offset.

let locks = 0;
let lockedAt = 0;

export function scrollY() {
  return locks > 0 ? lockedAt : window.scrollY;
}

export function lockScroll() {
  if (locks++ > 0) return;
  lockedAt = window.scrollY;
  const b = document.body;
  b.style.top = `-${lockedAt}px`;
  b.classList.add('is-locked');
}

export function unlockScroll() {
  if (locks === 0 || --locks > 0) return;
  const b = document.body;
  b.classList.remove('is-locked');
  b.style.top = '';
  window.scrollTo(0, lockedAt);
}

/** Scroll the document, also while locked (applies when the lock is released). */
export function setScrollY(y) {
  if (locks > 0) { lockedAt = y; document.body.style.top = `-${y}px`; return; }
  window.scrollTo(0, y);
}

export const isScrollLocked = () => locks > 0;
