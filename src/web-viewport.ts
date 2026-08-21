const WEB_VIEWPORT_STYLE = `
html{
  width:100%;
  height:100%;
  max-height:100%;
  min-height:0;
  overflow-x:hidden!important;
  overflow-y:auto!important;
  overscroll-behavior-x:none!important;
  overscroll-behavior-y:auto!important;
  background:#0d0616!important;
}
body{
  position:fixed!important;
  inset:0!important;
  width:100%;
  height:100%;
  max-height:100%;
  min-height:0!important;
  overflow:hidden!important;
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
html[data-web-keyboard="true"] .page{
  top:0!important;
  bottom:auto!important;
  height:var(--web-vv-height,100%)!important;
  transform:translate3d(0,var(--web-vv-top,0px),0)!important;
}
@supports (overflow:clip){
  body,.page{overflow:clip!important}
}
`;

const WEB_KEYBOARD_SCRIPT = `(function(){
var root=document.documentElement;
var vv=window.visualViewport||null;
var activeEditable=null;
var settleTimers=[];
var originX=Number(window.scrollX)||0;
var originY=Number(window.scrollY)||0;
var originReady=false;
var returningToOrigin=false;
var returnTimer=0;
var scrollIdleTimer=0;
function isEditable(node){
  if(!node||node.nodeType!==1)return false;
  if(node.isContentEditable)return true;
  var tag=node.tagName;
  if(tag==='TEXTAREA')return true;
  if(tag!=='INPUT')return false;
  var type=(node.type||'text').toLowerCase();
  return type!=='button'&&type!=='checkbox'&&type!=='color'&&type!=='file'&&type!=='hidden'&&type!=='image'&&type!=='radio'&&type!=='range'&&type!=='reset'&&type!=='submit';
}
function clearTimers(){
  while(settleTimers.length)clearTimeout(settleTimers.pop());
}
function clearViewportVars(){
  root.removeAttribute('data-web-keyboard');
  root.style.removeProperty('--web-vv-top');
  root.style.removeProperty('--web-vv-height');
}
function viewportTop(){
  if(!vv)return 0;
  var offsetTop=Number(vv.offsetTop)||0;
  var pageTop=Number(vv.pageTop)||0;
  var scrollY=Number(window.scrollY)||0;
  return Math.max(0,offsetTop,pageTop-scrollY);
}
function syncKeyboardViewport(){
  if(!activeEditable){clearViewportVars();return}
  root.setAttribute('data-web-keyboard','true');
  if(vv){
    root.style.setProperty('--web-vv-top',viewportTop()+'px');
    root.style.setProperty('--web-vv-height',Math.max(1,Number(vv.height)||window.innerHeight)+'px');
  }
}
function settleKeyboardViewport(){
  clearTimers();
  syncKeyboardViewport();
  requestAnimationFrame(syncKeyboardViewport);
  settleTimers.push(setTimeout(syncKeyboardViewport,80));
  settleTimers.push(setTimeout(syncKeyboardViewport,320));
}
function captureOrigin(){
  if(originReady)return;
  originX=Number(window.scrollX)||0;
  originY=Number(window.scrollY)||0;
  originReady=true;
}
function isAtOrigin(){
  return Math.abs((Number(window.scrollX)||0)-originX)<0.5&&Math.abs((Number(window.scrollY)||0)-originY)<0.5;
}
function restoreOrigin(){
  if(!originReady)captureOrigin();
  if(isAtOrigin()){
    returningToOrigin=false;
    return;
  }
  returningToOrigin=true;
  clearTimeout(returnTimer);
  try{
    window.scrollTo({left:originX,top:originY,behavior:'smooth'});
  }catch(error){
    window.scrollTo(originX,originY);
  }
  returnTimer=setTimeout(function(){
    if(!isAtOrigin())window.scrollTo(originX,originY);
    returningToOrigin=false;
    if(activeEditable)settleKeyboardViewport();
  },360);
}
function settleAfterGesture(){
  restoreOrigin();
  if(activeEditable)settleKeyboardViewport();
}
if(document.readyState==='complete')requestAnimationFrame(captureOrigin);
else window.addEventListener('pageshow',function(){requestAnimationFrame(captureOrigin)},{once:true,passive:true});
document.addEventListener('focusin',function(event){
  if(!isEditable(event.target))return;
  activeEditable=event.target;
  settleKeyboardViewport();
},true);
document.addEventListener('focusout',function(event){
  if(!isEditable(event.target))return;
  setTimeout(function(){
    var next=document.activeElement;
    if(isEditable(next)){
      activeEditable=next;
      settleKeyboardViewport();
      return;
    }
    activeEditable=null;
    clearTimers();
    clearViewportVars();
    restoreOrigin();
  },0);
},true);
document.addEventListener('touchend',function(){setTimeout(settleAfterGesture,32)},{capture:true,passive:true});
document.addEventListener('touchcancel',function(){setTimeout(settleAfterGesture,32)},{capture:true,passive:true});
if('onscrollend' in document){
  document.addEventListener('scrollend',function(){
    if(!returningToOrigin)settleAfterGesture();
  },{passive:true});
}else{
  window.addEventListener('scroll',function(){
    if(returningToOrigin)return;
    clearTimeout(scrollIdleTimer);
    scrollIdleTimer=setTimeout(settleAfterGesture,96);
  },{passive:true});
}
if(vv){
  vv.addEventListener('resize',syncKeyboardViewport,{passive:true});
  vv.addEventListener('scroll',syncKeyboardViewport,{passive:true});
}
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
        element.append(`<script>${WEB_KEYBOARD_SCRIPT}</script>`, { html: true });
      },
    })
    .transform(response);
}
