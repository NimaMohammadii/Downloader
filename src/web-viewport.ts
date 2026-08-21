const WEB_VIEWPORT_STYLE = `
html{
  width:100%;
  height:100%;
  min-height:0;
  overflow-x:hidden!important;
  overflow-y:auto!important;
  overscroll-behavior-y:auto!important;
}
body{
  width:100%;
  height:100%;
  min-height:0!important;
  overflow-x:hidden!important;
  overflow-y:auto!important;
  overscroll-behavior-y:auto!important;
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
