const WEB_VIEWPORT_STYLE = `
html{
  height:100%;
  overflow-y:auto!important;
  overscroll-behavior-y:auto!important;
}
body{
  height:100%;
  min-height:100%;
  overflow-y:visible!important;
  overscroll-behavior-y:auto!important;
}
@supports (overflow:clip){
  body{overflow-x:clip!important}
}
.page{
  height:100vh!important;
  max-height:100vh!important;
  overflow:hidden!important;
}
@supports (height:100dvh){
  .page{height:100dvh!important;max-height:100dvh!important}
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
