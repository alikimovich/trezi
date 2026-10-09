/** Scoped to the inspector shadow root; page styles cannot change its controls. */
export const THREE_D_CSS = `
:host { all:initial; color-scheme:dark; }
* { box-sizing:border-box; }
.workspace { position:absolute;inset:0;display:flex;flex-direction:column;background:#171719;color:#f5f5f5;font:600 15px/1.4 system-ui;cursor:default; }
header,footer { display:flex;align-items:center;gap:12px;padding:12px 16px;flex-wrap:wrap;z-index:2;background:#171719; }
header { border-bottom:1px solid #38383b; }
footer { border-top:1px solid #38383b; }
.title { flex:1;min-width:100px;font-weight:600; }
button,select { font:inherit;color:inherit;background:#29292c;border:1px solid #535358;border-radius:7px;padding:6px 10px;cursor:default; }
button:hover { background:#3c3c40; }
button:focus-visible,select:focus-visible,input:focus-visible,.stage:focus-visible { outline:2px solid #fff;outline-offset:2px; }
label { display:flex;align-items:center;gap:8px; }
input { accent-color:#f5f5f5;width:100px; }
.stage { position:relative;flex:1;min-height:120px;overflow:hidden;perspective:1600px;touch-action:none;background-image:radial-gradient(#414145 1px,transparent 1px);background-size:24px 24px; }
.scene { position:absolute;left:50%;top:50%;width:0;height:0;transform-style:preserve-3d; }
.surface { position:absolute;transform-style:preserve-3d;outline:1px solid #8a8a9470;cursor:default; }
.surface:hover { outline:2px solid #fff; }
.surface[data-selected] { outline:2px solid #fff; }
.surface span { pointer-events:none; }
.status { padding:8px 16px;color:#e2e2e5;background:#171719;font-size:15px; }
.layers { max-width:220px;min-width:90px; }
.hint { flex:1;color:#e2e2e5; }
@media(max-width:500px) { header,footer{padding:8px;gap:8px} .hint{display:none} .layers{max-width:145px} input{width:80px} }
`
