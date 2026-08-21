const WEB_VIEWPORT_STYLE = `
:root{
  --mesh-overscroll-base:#0d0616;
  --mesh-overscroll-deep:#5b21b6;
  --mesh-overscroll-mid:#b66cff;
  --mesh-overscroll-high:#f2e7ff;
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
    radial-gradient(82% 58% at 16% 2%,rgba(182,108,255,.72) 0%,rgba(91,33,182,.34) 42%,rgba(13,6,22,0) 72%),
    radial-gradient(82% 58% at 84% 98%,rgba(182,108,255,.68) 0%,rgba(91,33,182,.32) 42%,rgba(13,6,22,0) 72%),
    radial-gradient(56% 42% at 54% 48%,rgba(242,231,255,.18) 0%,rgba(91,33,182,.13) 46%,rgba(13,6,22,0) 76%),
    linear-gradient(180deg,#5b21b6 0%,#250e48 22%,#0d0616 50%,#250e48 78%,#5b21b6 100%)!important;
  background-size:100% 100vh!important;
  background-repeat:repeat-y!important;
  background-position:center top!important;
}
@supports (height:100dvh){
  html{background-size:100% 100dvh!important}
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
    radial-gradient(68% 44% at 18% 8%,rgba(182,108,255,.68) 0%,rgba(91,33,182,.30) 48%,rgba(13,6,22,0) 76%),
    radial-gradient(70% 46% at 82% 92%,rgba(182,108,255,.64) 0%,rgba(91,33,182,.28) 48%,rgba(13,6,22,0) 76%),
    radial-gradient(52% 36% at 50% 50%,rgba(242,231,255,.14) 0%,rgba(91,33,182,.11) 48%,rgba(13,6,22,0) 78%),
    linear-gradient(180deg,#5b21b6 0%,#250e48 24%,#0d0616 50%,#250e48 76%,#5b21b6 100%)!important;
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
