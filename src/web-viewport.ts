const WEB_VIEWPORT_STYLE = `
:root{
  --mesh-overscroll-base:#03120e;
  --mesh-overscroll-deep:#0e7c5a;
  --mesh-overscroll-mid:#7ce577;
  --mesh-overscroll-high:#f4ffc7;
}
html{
  width:100%;
  height:100%;
  min-height:0;
  overflow-x:hidden!important;
  overflow-y:auto!important;
  overscroll-behavior-y:auto!important;
  background-color:var(--mesh-overscroll-base)!important;
  background-image:
    radial-gradient(82% 58% at 16% 2%,rgba(124,229,119,.72) 0%,rgba(14,124,90,.34) 42%,rgba(3,18,14,0) 72%),
    radial-gradient(82% 58% at 84% 98%,rgba(124,229,119,.68) 0%,rgba(14,124,90,.32) 42%,rgba(3,18,14,0) 72%),
    radial-gradient(56% 42% at 54% 48%,rgba(244,255,199,.18) 0%,rgba(14,124,90,.13) 46%,rgba(3,18,14,0) 76%),
    linear-gradient(180deg,#0e7c5a 0%,#063326 22%,#03120e 50%,#063326 78%,#0e7c5a 100%)!important;
  background-size:100% 100vh!important;
  background-repeat:repeat-y!important;
  background-position:center top!important;
}
body{
  width:100%;
  height:100%;
  min-height:0!important;
  overflow-x:hidden!important;
  overflow-y:auto!important;
  overscroll-behavior-y:auto!important;
  background:transparent!important;
}
body::before{
  content:""!important;
  display:block!important;
  position:fixed!important;
  inset:-38vh -10vw!important;
  z-index:-1!important;
  pointer-events:none!important;
  background:
    radial-gradient(68% 44% at 18% 8%,rgba(124,229,119,.68) 0%,rgba(14,124,90,.30) 48%,rgba(3,18,14,0) 76%),
    radial-gradient(70% 46% at 82% 92%,rgba(124,229,119,.64) 0%,rgba(14,124,90,.28) 48%,rgba(3,18,14,0) 76%),
    radial-gradient(52% 36% at 50% 50%,rgba(244,255,199,.14) 0%,rgba(14,124,90,.11) 48%,rgba(3,18,14,0) 78%),
    linear-gradient(180deg,#0e7c5a 0%,#063326 24%,#03120e 50%,#063326 76%,#0e7c5a 100%)!important;
  transform:translateZ(0);
}
.page{
  position:fixed!important;
  inset:0!important;
  height:auto!important;
  min-height:0!important;
  max-height:none!important;
  overflow:hidden!important;
}
@supports (overflow:clip){
  .page{overflow:clip!important}
}
`;

export function applyWebViewport(response: Response): Response {
  return new HTMLRewriter()
    .on("head", {
      element(element) {
        element.append(`<style>${WEB_VIEWPORT_STYLE}</style>`, { html: true });
      },
    })
    .transform(response);
}
