/** Scoped to the capture shadow root; page styles cannot change it. The dialog paints
 * nothing until the host asks for an atlas page on black (`0`) or white (`1`). */
export const THREE_D_CSS = `
:host { all:initial; }
* { box-sizing:border-box; }
dialog::backdrop { background:transparent; }
dialog[data-tone="0"] { background:#000 !important; }
dialog[data-tone="1"] { background:#fff !important; }
.page { position:absolute;inset:0;display:none;pointer-events:none; }
.page[data-shown] { display:block; }
.slot { position:absolute;overflow:hidden;transform-origin:0 0; }
.slot span { pointer-events:none; }
`
