/** LKM-325: what the page itself believes while a select-mode hover should have cleared over a
 *  native island. WebKit's `:hover` follows the last move it processed, so the three answers
 *  tell the causes apart: the heading still `:hover` means the island move never reached the
 *  page; the shield `:hover` with the box still shown is a bug in the preview script; the
 *  point hitting something other than the shield means the cover is not where the host says.
 *  LKM-330: the first nightly probe had neither `:hover`, so it also reports the innermost
 *  `:hover` element and the pointer events the page saw last (`hoverRecorderScript`). */
export type Rect = { x: number; y: number; width: number; height: number }

const RECORDER = '__treziHoverProbe'

/** Records the last pointer events the preview world sees, in window capture after the
 *  preload's own listeners. Events on the shield host are stopped before this, so a move that
 *  reached the shield is never listed here. Idempotent; `reset` clears the list. */
export function hoverRecorderScript(): string {
  return `(() => {
    const name = ${JSON.stringify(RECORDER)};
    const describe = (n) => n && n.tagName ? n.tagName + (n.id ? '#' + n.id : '') : null;
    if (!window[name]) {
      const events = [];
      window[name] = events;
      for (const type of ['mousemove', 'mouseover', 'mouseout', 'pointermove'])
        window.addEventListener(type, (e) => {
          events.push({ type, target: describe(e.target), related: describe(e.relatedTarget),
            x: e.clientX, y: e.clientY, trusted: e.isTrusted });
          if (events.length > 12) events.shift();
        }, true);
    }
    window[name].length = 0;
    return true;
  })()`
}

export function hoverProbeScript(cover: Rect | undefined): string {
  const x = cover ? cover.x + cover.width / 2 : 0
  const y = cover ? cover.y + cover.height / 2 : 0
  return `(() => {
    const host = document.querySelector('[data-trezi-cover]');
    const heading = document.querySelector('#native-title');
    const box = document.querySelector('[data-trezi-overlay]')?.shadowRoot?.querySelector('[data-trezi-hover]');
    const hit = document.elementFromPoint(${x}, ${y});
    const hovered = [...document.querySelectorAll(':hover')].pop();
    const r = box?.getBoundingClientRect();
    return {
      point: { x: ${x}, y: ${y} },
      hitIsShield: !!host && hit === host,
      hit: hit ? hit.tagName + (hit.id ? '#' + hit.id : '') : null,
      shieldHover: !!host?.matches(':hover'),
      headingHover: !!heading?.matches(':hover'),
      hovered: hovered ? hovered.tagName + (hovered.id ? '#' + hovered.id : '') : null,
      hoverBox: box ? box.style.display : null,
      hoverBoxRect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
      events: window[${JSON.stringify(RECORDER)}] ?? null,
      hasFocus: document.hasFocus(),
      visibility: document.visibilityState
    };
  })()`
}
