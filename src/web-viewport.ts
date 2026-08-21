const WEB_VIEWPORT_STYLE = `
html{
  width:100%;
  height:100%;
  min-height:0;
  overflow:hidden!important;
  overscroll-behavior:none!important;
  background:#0d0616!important;
}
body{
  position:fixed!important;
  inset:0!important;
  width:100%;
  height:100%;
  min-height:0!important;
  overflow:hidden!important;
  overscroll-behavior:none!important;
  background:transparent!important;
}
body::before{
  display:none!important;
}
#meshBackground{
  filter:brightness(.76) saturate(.92);
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
  html,body,.page{overflow:clip!important}
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
