/** LKM-325: what the page itself believes while a select-mode hover should have cleared over a
 *  native island. WebKit's `:hover` follows the last move it processed, so the three answers
 *  tell the causes apart: the heading still `:hover` means the island move never reached the
 *  page; the shield `:hover` with the box still shown is a bug in the preview script; the
 *  point hitting something other than the shield means the cover is not where the host says. */
export type Rect = { x: number; y: number; width: number; height: number }

export function hoverProbeScript(cover: Rect | undefined): string {
  const x = cover ? cover.x + cover.width / 2 : 0
  const y = cover ? cover.y + cover.height / 2 : 0
  return `(() => {
    const host = document.querySelector('[data-trezi-cover]');
    const heading = document.querySelector('#native-title');
    const box = document.querySelector('[data-trezi-overlay]')?.shadowRoot?.querySelector('[data-trezi-hover]');
    const hit = document.elementFromPoint(${x}, ${y});
    return {
      point: { x: ${x}, y: ${y} },
      hitIsShield: !!host && hit === host,
      hit: hit ? hit.tagName + (hit.id ? '#' + hit.id : '') : null,
      shieldHover: !!host?.matches(':hover'),
      headingHover: !!heading?.matches(':hover'),
      hoverBox: box ? box.style.display : null,
      hasFocus: document.hasFocus(),
      visibility: document.visibilityState
    };
  })()`
}
