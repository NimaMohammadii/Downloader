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
#pullRefreshIndicator{
  position:fixed;
  left:50%;
  top:calc(env(safe-area-inset-top,0px) + 10px);
  z-index:2147483647;
  width:30px;
  height:30px;
  margin-left:-15px;
  display:grid;
  place-items:center;
  color:rgba(255,255,255,.86);
  opacity:0;
  transform:translate3d(0,-16px,0) scale(.82);
  transition:opacity .16s ease,transform .18s cubic-bezier(.22,.8,.3,1);
  pointer-events:none;
  will-change:opacity,transform;
}
#pullRefreshIndicator.dragging{
  transition:none;
}
#pullRefreshIndicator.visible{
  opacity:.9;
}
#pullRefreshIndicator.ready{
  color:#fff;
}
#pullRefreshIndicator svg{
  width:19px;
  height:19px;
  transform:rotate(var(--pull-rotation,0deg));
  transform-origin:50% 50%;
}
#pullRefreshIndicator.refreshing svg{
  animation:pullRefreshSpin .72s linear infinite;
}
@keyframes pullRefreshSpin{
  to{transform:rotate(360deg)}
}
`;

const WEB_PULL_REFRESH_SCRIPT = `(function(){
var indicator=document.getElementById('pullRefreshIndicator');
if(!indicator)return;
if(!('ontouchstart' in window)&&!(navigator.maxTouchPoints>0))return;
var svg=indicator.querySelector('svg');
var active=false,armed=false,startX=0,startY=0,lastDy=0;
var EDGE_PX=96,THRESHOLD_PX=96,MAX_VISUAL_PX=28;
function clearClasses(){indicator.classList.remove('dragging','visible','ready','refreshing')}
function reset(){
  active=false;armed=false;lastDy=0;
  clearClasses();
  indicator.style.removeProperty('transform');
  if(svg)svg.style.removeProperty('--pull-rotation');
}
function cancelGesture(){
  if(!active)return;
  active=false;armed=false;lastDy=0;
  indicator.classList.remove('dragging','ready');
  indicator.style.removeProperty('transform');
  setTimeout(function(){indicator.classList.remove('visible')},160);
}
document.addEventListener('touchstart',function(event){
  if(event.touches.length!==1)return;
  var touch=event.touches[0];
  var viewportTop=window.visualViewport?window.visualViewport.offsetTop:0;
  var edge=viewportTop+EDGE_PX;
  if(touch.clientY>edge)return;
  active=true;armed=false;lastDy=0;startX=touch.clientX;startY=touch.clientY;
  indicator.classList.remove('ready','refreshing');
},{passive:true,capture:true});
document.addEventListener('touchmove',function(event){
  if(!active||event.touches.length!==1)return;
  var touch=event.touches[0];
  var dx=touch.clientX-startX;
  var dy=touch.clientY-startY;
  if(dy<=0){cancelGesture();return}
  if(Math.abs(dx)>Math.max(18,dy*.75)){cancelGesture();return}
  if(dy<5)return;
  event.preventDefault();
  lastDy=dy;
  var progress=Math.min(dy/THRESHOLD_PX,1);
  var visual=Math.min(MAX_VISUAL_PX,dy*.22);
  armed=dy>=THRESHOLD_PX;
  indicator.classList.add('visible','dragging');
  indicator.classList.toggle('ready',armed);
  indicator.style.transform='translate3d(0,'+visual+'px,0) scale('+(0.82+0.18*progress)+')';
  if(svg)svg.style.setProperty('--pull-rotation',(progress*230)+'deg');
},{passive:false,capture:true});
document.addEventListener('touchend',function(){
  if(!active)return;
  var shouldRefresh=armed&&lastDy>=THRESHOLD_PX;
  active=false;
  indicator.classList.remove('dragging','ready');
  if(!shouldRefresh){
    indicator.style.removeProperty('transform');
    setTimeout(function(){indicator.classList.remove('visible')},160);
    armed=false;lastDy=0;
    return;
  }
  armed=false;lastDy=0;
  indicator.classList.add('visible','refreshing');
  indicator.style.transform='translate3d(0,18px,0) scale(1)';
  setTimeout(function(){window.location.reload()},120);
},{passive:true,capture:true});
document.addEventListener('touchcancel',reset,{passive:true,capture:true});
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
        element.prepend('<div id="pullRefreshIndicator" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></svg></div>', { html: true });
        element.append(`<script>${WEB_PULL_REFRESH_SCRIPT}</script>`, { html: true });
      },
    })
    .transform(response);
}
