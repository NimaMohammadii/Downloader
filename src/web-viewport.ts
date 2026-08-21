const WEB_VIEWPORT_STYLE = `
html{
  width:100%;
  min-height:100%;
  overflow-x:hidden!important;
  overflow-y:auto!important;
  overscroll-behavior-x:none!important;
  overscroll-behavior-y:auto!important;
  background:#0d0616!important;
}
body{
  width:100%;
  min-height:100%;
  background:transparent!important;
}
body::before{
  display:none!important;
}
#meshBackground{
  filter:brightness(.76) saturate(.92);
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
  try{
    window.scrollTo({left:originX,top:originY,behavior:'smooth'});
  }catch(error){
    window.scrollTo(originX,originY);
  }
}
requestAnimationFrame(captureOrigin);
window.addEventListener('scroll',function(){
  if(!originReady)return;
  clearTimeout(idleTimer);
  idleTimer=setTimeout(restoreOrigin,120);
},{passive:true});
})();`;

export function applyWebViewport(response: Response): Response {
  return new HTMLRewriter()
    .on("head", {
      element(element) {
        element.append(`<style>${WEB_VIEWPORT_STYLE}</style>`, { html: true });
      },
    })
    .on("body", {
      element(element) {
        element.append(`<script>${WEB_SCROLL_SCRIPT}</script>`, { html: true });
      },
    })
    .transform(response);
}
