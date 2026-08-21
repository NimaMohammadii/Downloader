const WEB_VIEWPORT_STYLE = `
html{
  width:100%;
  height:100%;
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
  top:var(--web-vv-top,0px)!important;
  bottom:auto!important;
  height:var(--web-vv-height,100%)!important;
}
@supports (overflow:clip){
  body,.page{overflow:clip!important}
}
`;

const WEB_KEYBOARD_SCRIPT = `(function(){
var root=document.documentElement;
var vv=window.visualViewport||null;
var activeEditable=null;
function isEditable(node){
  if(!node||node.nodeType!==1)return false;
  if(node.isContentEditable)return true;
  var tag=node.tagName;
  if(tag==='TEXTAREA')return true;
  if(tag!=='INPUT')return false;
  var type=(node.type||'text').toLowerCase();
  return type!=='button'&&type!=='checkbox'&&type!=='color'&&type!=='file'&&type!=='hidden'&&type!=='image'&&type!=='radio'&&type!=='range'&&type!=='reset'&&type!=='submit';
}
function clearViewportVars(){
  root.removeAttribute('data-web-keyboard');
  root.style.removeProperty('--web-vv-top');
  root.style.removeProperty('--web-vv-height');
}
function syncKeyboardViewport(){
  if(!activeEditable){clearViewportVars();return}
  root.setAttribute('data-web-keyboard','true');
  if(vv){
    root.style.setProperty('--web-vv-top',Math.max(0,vv.offsetTop||0)+'px');
    root.style.setProperty('--web-vv-height',Math.max(1,vv.height||window.innerHeight)+'px');
  }
  if(window.scrollX||window.scrollY)window.scrollTo(0,0);
}
function settleKeyboardViewport(){
  syncKeyboardViewport();
  requestAnimationFrame(syncKeyboardViewport);
  setTimeout(syncKeyboardViewport,80);
  setTimeout(syncKeyboardViewport,320);
}
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
    clearViewportVars();
    if(window.scrollX||window.scrollY)window.scrollTo(0,0);
  },0);
},true);
function blurOnOutsidePress(event){
  var current=document.activeElement;
  if(!isEditable(current))return;
  if(event.target===current)return;
  current.blur();
}
if(window.PointerEvent){
  document.addEventListener('pointerdown',blurOnOutsidePress,true);
}else{
  document.addEventListener('touchstart',blurOnOutsidePress,{capture:true,passive:true});
}
document.addEventListener('touchmove',function(event){
  if(!activeEditable)return;
  if(event.target===activeEditable)return;
  event.preventDefault();
},{capture:true,passive:false});
if(vv){
  vv.addEventListener('resize',syncKeyboardViewport,{passive:true});
  vv.addEventListener('scroll',syncKeyboardViewport,{passive:true});
}
window.addEventListener('scroll',function(){
  if(activeEditable&&(window.scrollX||window.scrollY))window.scrollTo(0,0);
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
        element.append(`<script>${WEB_KEYBOARD_SCRIPT}</script>`, { html: true });
      },
    })
    .transform(response);
}
