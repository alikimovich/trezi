/** Scoped to the inspector shadow root; page styles cannot change its controls. */
export const THREE_D_CSS = `
:host { all:initial; }
* { box-sizing:border-box; }
.workspace { position:absolute;inset:0;background:var(--three-d-background,#f5f5f5); }
.stage { position:absolute;top:var(--three-d-top,52px);bottom:var(--three-d-bottom,92px);left:var(--three-d-left,0px);right:var(--three-d-right,0px);min-height:0;overflow:hidden;perspective:1600px;touch-action:none;background-image:radial-gradient(var(--three-d-grid,#d0d0d0) 1px,transparent 1px);background-size:24px 24px; }
.stage:focus-visible { outline:2px solid var(--three-d-focus,#0066cc);outline-offset:-3px; }
.scene { position:absolute;left:50%;top:50%;width:0;height:0;transform-style:preserve-3d; }
.surface { position:absolute;transform-style:preserve-3d;outline:1px solid var(--three-d-outline,#888888);cursor:default; }
.surface:hover,.surface[data-selected] { outline:2px solid var(--three-d-accent,#0066cc); }
.surface span { pointer-events:none; }
`
