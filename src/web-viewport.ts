const WEB_SCROLL_STYLE = `
html{
  overflow-y:auto!important;
  overscroll-behavior-y:auto!important;
}
`;

const WEB_SCROLL_SCRIPT = `(function(){
var originX=Number(window.scrollX)||0;
var originY=Number(window.scrollY)||0;
var settleTimer=0;
var restoreAttempt=0;
function isAtOrigin(){
  return Math.abs((Number(window.scrollX)||0)-originX)<0.5&&Math.abs((Number(window.scrollY)||0)-originY)<0.5;
}
function restoreOrigin(){
  clearTimeout(settleTimer);
  if(isAtOrigin()){
    restoreAttempt=0;
    return;
  }
  window.scrollTo({left:originX,top:originY,behavior:restoreAttempt?'auto':'smooth'});
  restoreAttempt++;
  settleTimer=setTimeout(restoreOrigin,480);
}
window.addEventListener('scroll',function(){
  clearTimeout(settleTimer);
  settleTimer=setTimeout(restoreOrigin,220);
},{passive:true});
})();`;

export function applyWebViewport(response: Response): Response {
  return new HTMLRewriter()
    .on("head", {
      element(element) {
        element.append(`<style>${WEB_SCROLL_STYLE}</style>`, { html: true });
      },
    })
    .on("body", {
      element(element) {
        element.append(`<script>${WEB_SCROLL_SCRIPT}</script>`, { html: true });
      },
    })
    .transform(response);
}
