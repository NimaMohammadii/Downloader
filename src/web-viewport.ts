const WEB_SCROLL_STYLE = `
html{
  overflow-y:auto!important;
  overscroll-behavior-y:auto!important;
}
`;

const WEB_SCROLL_SCRIPT = `(function(){
var originX=Number(window.scrollX)||0;
var originY=Number(window.scrollY)||0;
var originReady=false;
var idleTimer=0;
function captureOrigin(){
  originX=Number(window.scrollX)||0;
  originY=Number(window.scrollY)||0;
  originReady=true;
}
function restoreOrigin(){
  if(!originReady)return;
  var x=Number(window.scrollX)||0;
  var y=Number(window.scrollY)||0;
  if(Math.abs(x-originX)<0.5&&Math.abs(y-originY)<0.5)return;
  window.scrollTo({left:originX,top:originY,behavior:'smooth'});
}
requestAnimationFrame(captureOrigin);
window.addEventListener('scroll',function(){
  if(!originReady)return;
  clearTimeout(idleTimer);
  idleTimer=setTimeout(restoreOrigin,96);
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
