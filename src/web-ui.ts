export const WEB_APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#050505">
<meta name="description" content="Watch or download YouTube videos.">
<meta name="robots" content="index,follow">
<title>Video Downloader</title>
<style>
:root{color-scheme:dark;--bg:#050505;--text:#f5f5f5;--muted:#858585;--line:#222;--panel:#0a0a0a}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text",Inter,system-ui,sans-serif}
body{overflow-x:hidden}
body:before{content:"";position:fixed;inset:-25%;pointer-events:none;background:radial-gradient(circle at 50% 8%,rgba(255,255,255,.055),transparent 28%)}
button,input{font:inherit}
button{border:0;cursor:pointer}
button:focus-visible{outline:2px solid #fff;outline-offset:3px}
.page{width:min(100%,1180px);margin:0 auto;padding:clamp(24px,4vw,52px) clamp(14px,4vw,44px) max(30px,env(safe-area-inset-bottom))}
.layout{display:grid;grid-template-columns:minmax(0,1fr);gap:22px}
.intro{width:min(100%,720px);margin:0 auto}
h1{margin:0 0 24px;font-size:clamp(40px,8vw,68px);line-height:.93;letter-spacing:-.055em;font-weight:680}
.modeSwitch{position:relative;display:grid;grid-template-columns:1fr 1fr;width:min(100%,390px);height:56px;padding:5px;margin:0 0 18px;border:1px solid #242424;border-radius:19px;background:#090909;isolation:isolate}
.modeThumb{position:absolute;z-index:0;left:5px;top:5px;width:calc(50% - 5px);height:46px;border-radius:14px;background:#f2f2f2;box-shadow:0 8px 26px rgba(0,0,0,.28);transition:transform .3s cubic-bezier(.22,.85,.28,1)}
.modeSwitch.watch .modeThumb{transform:translateX(100%)}
.modeButton{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;gap:8px;background:transparent;color:#666;font-size:13px;font-weight:720;transition:color .2s,transform .16s}
.modeButton.active{color:#080808}.modeButton:active{transform:scale(.98)}.modeButton svg{width:19px;height:19px;stroke-width:2.1}
.inputShell{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;padding:8px;background:#0a0a0a;border-radius:21px;transition:transform .2s}
.inputShell:focus-within{transform:translateY(-1px)}
.linkIcon{width:42px;height:42px;border-radius:14px;background:#111;display:grid;place-items:center;color:#aaa;font-size:18px}
.url{min-width:0;width:100%;border:0;outline:0;background:transparent;color:#fff;padding:11px 0;font-size:15px}
.url:focus,.url:focus-visible{border:0;outline:0;box-shadow:none}
.url::placeholder{color:#555}
.go{height:46px;padding:0 18px;border-radius:15px;background:#fff;color:#050505;font-weight:720;transition:transform .16s,opacity .16s}
.go:active{transform:scale(.975)}.go:disabled{opacity:.38;cursor:default}
.message{min-height:22px;margin:10px 4px 0;color:#777;font-size:13px;line-height:1.4}.message:empty{min-height:0;margin-top:0}.message.error{color:#e7e7e7}
.workspace{display:none;min-width:0}.workspace.show{display:block}
.result,.progress,.ready,.playerCard{display:none}.result.show,.progress.show,.ready.show,.playerCard.show{display:block}
.result,.progress,.ready{border:1px solid var(--line);border-radius:24px;background:#0a0a0a;overflow:hidden}
.resultHead{padding:20px 22px;border-bottom:1px solid var(--line)}.videoTitle{font-size:17px;line-height:1.4;font-weight:620;overflow-wrap:anywhere}
.resultBody{padding:20px 22px 22px}.formats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}
.format{text-align:left;padding:14px;border:1px solid #222;border-radius:16px;background:#0d0d0d;color:#ddd;transition:background .18s,border-color .18s,transform .16s}
.format:active{transform:scale(.985)}.format.selected{background:#f1f1f1;color:#080808;border-color:#ededed}
.formatName{display:block;font-size:14px;font-weight:670}.formatDesc{display:block;margin-top:4px;color:#666;font-size:11px}.format.selected .formatDesc{color:#555}
.primary,.save{width:100%;min-height:52px;margin-top:16px;border-radius:16px;background:#fff;color:#050505;font-weight:720;transition:transform .16s,opacity .16s}
.primary:active,.save:active{transform:scale(.98)}.primary:disabled{opacity:.35;cursor:default}
.progress,.ready{padding:22px}.statusRow{display:flex;align-items:center;gap:14px}.orb{position:relative;width:40px;height:40px;border:1px solid #262626;border-radius:50%;flex:0 0 auto}
.orb:before{content:"";position:absolute;inset:5px;border:2px solid transparent;border-top-color:#fff;border-radius:50%;animation:spin .85s linear infinite}
.statusTitle{font-size:15px;font-weight:650}.statusSub,.readyMeta{margin-top:5px;color:#6c6c6c;font-size:12px;line-height:1.45}
.rail{height:2px;margin-top:19px;background:#171717;overflow:hidden}.rail:after{content:"";display:block;width:36%;height:100%;background:#eee;animation:scan 1.25s ease-in-out infinite}
.readyIcon{width:42px;height:42px;border-radius:50%;background:#fff;color:#050505;display:grid;place-items:center;font-size:19px;font-weight:800}
.readyText{min-width:0;flex:1}.readyMeta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.playerCard{padding:0}.playerShell{position:relative;width:100%;aspect-ratio:16/9;border-radius:22px;overflow:hidden;background:#000;border:1px solid #1f1f1f;box-shadow:0 14px 44px rgba(0,0,0,.28);touch-action:manipulation}
.playerShell video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
.playerShade{position:absolute;inset:0;background:linear-gradient(to bottom,transparent 46%,rgba(0,0,0,.66));pointer-events:none}
.playerCenter{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:62px;height:62px;border-radius:50%;display:grid;place-items:center;background:rgba(7,7,7,.66);color:#fff;border:1px solid rgba(255,255,255,.09);backdrop-filter:blur(12px);transition:opacity .2s,transform .16s}
.playerCenter:active{transform:translate(-50%,-50%) scale(.95)}.playerCenter svg{width:29px;height:29px;stroke-width:2}.playerShell.playing .playerCenter{opacity:0;pointer-events:none}
.playerLoading{position:absolute;left:50%;top:50%;width:40px;height:40px;margin:-20px;border:2px solid rgba(255,255,255,.14);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;opacity:0;pointer-events:none}
.playerShell.loading .playerLoading{opacity:1}.playerShell.loading .playerCenter{opacity:0}
.playerControls{position:absolute;left:0;right:0;bottom:0;padding:32px 14px 13px;background:linear-gradient(to top,rgba(0,0,0,.84),rgba(0,0,0,.24),transparent);transition:opacity .2s,transform .2s}
.playerShell.controlsHidden .playerControls{opacity:0;transform:translateY(8px);pointer-events:none}
.seekWrap{position:relative;height:18px;display:flex;align-items:center}.seekBase{position:absolute;left:2px;right:2px;height:4px;border-radius:99px;background:rgba(255,255,255,.16);overflow:hidden}
.bufferedBar,.playedBar{position:absolute;inset:0 auto 0 0;width:0;border-radius:99px}.bufferedBar{background:rgba(255,255,255,.22)}.playedBar{background:#fff}
.seek{position:relative;width:100%;height:18px;margin:0;appearance:none;-webkit-appearance:none;background:transparent}.seek::-webkit-slider-runnable-track{height:4px;background:transparent}
.seek::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.4)}
.seek::-moz-range-track{height:4px;background:transparent}.seek::-moz-range-thumb{width:14px;height:14px;border:0;border-radius:50%;background:#fff}
.controlRow{display:flex;align-items:center;gap:4px;margin-top:5px}.controlButton{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:transparent;color:#fff;transition:background .16s,transform .16s}
.controlButton:active{transform:scale(.93);background:rgba(255,255,255,.08)}.controlButton svg{width:21px;height:21px;stroke-width:2}.skipButton svg{width:22px;height:22px}
.playerTime{margin-left:2px;color:#d5d5d5;font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}.controlSpacer{flex:1}
.watchMeta{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:12px 4px 0}.watchTitle{font-size:14px;font-weight:600;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.watchBadge{flex:0 0 auto;padding:5px 8px;border-radius:99px;background:#eee;color:#080808;font-size:10px;font-weight:700;letter-spacing:.07em}
.playerShell:fullscreen{border:0;border-radius:0}.playerShell:fullscreen .playerControls{padding-bottom:max(14px,env(safe-area-inset-bottom))}
@keyframes spin{to{transform:rotate(360deg)}}@keyframes scan{0%{transform:translateX(-120%)}100%{transform:translateX(390%)}}
@media(min-width:44rem){.formats{grid-template-columns:repeat(3,minmax(0,1fr))}.resultHead{padding:22px 26px}.resultBody{padding:22px 26px 26px}}
@media(min-width:56rem){.layout.hasOutput{grid-template-columns:minmax(310px,.82fr) minmax(460px,1.18fr);gap:clamp(28px,4vw,50px);align-items:start}.layout.hasOutput .intro{width:100%;margin:0;position:sticky;top:clamp(24px,4vw,46px)}.layout.hasOutput .workspace{min-width:0}.layout.hasOutput .formats{grid-template-columns:repeat(2,minmax(0,1fr))}.playerShell{max-height:70vh}}
@media(max-width:29rem){.page{padding-left:13px;padding-right:13px}.inputShell{grid-template-columns:auto minmax(0,1fr);gap:8px}.go{grid-column:1/-1;width:100%}.formats{grid-template-columns:repeat(2,minmax(0,1fr))}.controlButton{width:35px;height:36px}.skipButton{display:none}.playerTime{font-size:10px}}
@media(any-pointer:coarse){.modeButton,.go,.primary,.save,.format,.controlButton{min-height:48px}.controlButton{width:48px}.url{min-height:48px}.seekWrap,.seek{height:24px}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<main class="page">
  <div id="layout" class="layout">
    <section class="intro">
      <h1>Paste.<br>Pick. Save.</h1>
      <div id="modeSwitch" class="modeSwitch" role="tablist" aria-label="Choose action">
        <span class="modeThumb" aria-hidden="true"></span>
        <button id="modeDownload" class="modeButton active" type="button" role="tab" aria-selected="true">
          <svg viewBox="0 0 24 24" fill="none"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 20h14" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Download
        </button>
        <button id="modeWatch" class="modeButton" type="button" role="tab" aria-selected="false">
          <svg viewBox="0 0 24 24" fill="none"><path d="m9 7 8 5-8 5V7Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Watch online
        </button>
      </div>
      <div class="inputShell">
        <div class="linkIcon" aria-hidden="true">↗</div>
        <input id="url" class="url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste YouTube link" aria-label="YouTube link">
        <button id="analyze" class="go" type="button">Analyze</button>
      </div>
      <div id="message" class="message" aria-live="polite"></div>
    </section>

    <section id="workspace" class="workspace" aria-live="polite">
      <div id="result" class="result">
        <div class="resultHead"><div id="videoTitle" class="videoTitle"></div></div>
        <div class="resultBody"><div id="formats" class="formats"></div><button id="prepare" class="primary" type="button" disabled>Prepare download</button></div>
      </div>

      <div id="playerCard" class="playerCard">
        <div id="playerShell" class="playerShell">
          <video id="video" playsinline preload="metadata"></video>
          <div class="playerShade"></div>
          <div class="playerLoading"></div>
          <button id="centerPlay" class="playerCenter" type="button" aria-label="Play">
            <svg id="centerPlayIcon" viewBox="0 0 24 24" fill="none"><path d="m9 6 9 6-9 6V6Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="playerControls">
            <div class="seekWrap"><div class="seekBase"><div id="bufferedBar" class="bufferedBar"></div><div id="playedBar" class="playedBar"></div></div><input id="seek" class="seek" type="range" min="0" max="100" value="0" step="0.05" aria-label="Seek video"></div>
            <div class="controlRow">
              <button id="playPause" class="controlButton" type="button" aria-label="Play or pause"><svg id="playIcon" viewBox="0 0 24 24" fill="none"><path d="m9 6 9 6-9 6V6Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
              <button id="back10" class="controlButton skipButton" type="button" aria-label="Back 10 seconds"><svg viewBox="0 0 24 24" fill="none"><path d="M8 8H4V4M4.5 8.5A8 8 0 1 1 4 14" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.7 11.2v4.6m2.3-4.6h2.1v4.6m0-4.6h-2.1" stroke="currentColor" stroke-linecap="round"/></svg></button>
              <button id="forward10" class="controlButton skipButton" type="button" aria-label="Forward 10 seconds"><svg viewBox="0 0 24 24" fill="none"><path d="M16 8h4V4m-.5 4.5A8 8 0 1 0 20 14" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.7 11.2v4.6m2.3-4.6h2.1v4.6m0-4.6h-2.1" stroke="currentColor" stroke-linecap="round"/></svg></button>
              <div id="playerTime" class="playerTime">0:00 / 0:00</div><div class="controlSpacer"></div>
              <button id="mute" class="controlButton" type="button" aria-label="Mute or unmute"><svg id="muteIcon" viewBox="0 0 24 24" fill="none"><path d="M5 10v4h4l4 4V6L9 10H5Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 9.2a4 4 0 0 1 0 5.6" stroke="currentColor" stroke-linecap="round"/></svg></button>
              <button id="fullscreen" class="controlButton" type="button" aria-label="Fullscreen"><svg viewBox="0 0 24 24" fill="none"><path d="M8 4H4v4M16 4h4v4M8 20H4v-4m12 4h4v-4" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            </div>
          </div>
        </div>
        <div class="watchMeta"><div id="watchTitle" class="watchTitle"></div><span class="watchBadge">ONLINE</span></div>
      </div>

      <div id="progress" class="progress"><div class="statusRow"><div class="orb"></div><div><div class="statusTitle">Preparing your file</div><div id="progressSub" class="statusSub">Starting download…</div></div></div><div class="rail"></div></div>
      <div id="ready" class="ready"><div class="statusRow"><div class="readyIcon">↓</div><div class="readyText"><div class="statusTitle">Ready to save</div><div id="readyMeta" class="readyMeta"></div></div></div><button id="save" class="save" type="button">Download file</button></div>
    </section>
  </div>
</main>
<script>
(function(){
var $=function(id){return document.getElementById(id)};
var mode='download',current=null,selected=null,prepared=null,pollToken=0,controlsTimer=null;
var tabId=(crypto.randomUUID?crypto.randomUUID().replace(/-/g,''):String(Date.now())+Math.random().toString(36).slice(2));
var layout=$('layout'),workspace=$('workspace'),modeSwitch=$('modeSwitch'),modeDownload=$('modeDownload'),modeWatch=$('modeWatch'),url=$('url'),analyze=$('analyze'),message=$('message'),result=$('result'),videoTitle=$('videoTitle'),formats=$('formats'),prepare=$('prepare'),progress=$('progress'),progressSub=$('progressSub'),ready=$('ready'),readyMeta=$('readyMeta'),save=$('save'),playerCard=$('playerCard'),playerShell=$('playerShell'),video=$('video'),centerPlay=$('centerPlay'),centerPlayIcon=$('centerPlayIcon'),playPause=$('playPause'),playIcon=$('playIcon'),back10=$('back10'),forward10=$('forward10'),seek=$('seek'),bufferedBar=$('bufferedBar'),playedBar=$('playedBar'),playerTime=$('playerTime'),mute=$('mute'),muteIcon=$('muteIcon'),fullscreen=$('fullscreen'),watchTitle=$('watchTitle');
function msg(text,error){message.textContent=text||'';message.classList.toggle('error',!!error)}
function wait(ms){return new Promise(function(resolve){setTimeout(resolve,ms)})}
function size(bytes){if(!bytes)return'File ready';var units=['B','KB','MB','GB'],i=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),3),value=bytes/Math.pow(1024,i);return(value>=100||i===0?Math.round(value):value.toFixed(1))+' '+units[i]}
function showOnly(name){var active=name!=='none';workspace.classList.toggle('show',active);layout.classList.toggle('hasOutput',active);result.classList.toggle('show',name==='result');playerCard.classList.toggle('show',name==='player');progress.classList.toggle('show',name==='progress');ready.classList.toggle('show',name==='ready')}
async function api(path,body){body=Object.assign({},body,{tabId:tabId});var response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-vexa-app':'web'},body:JSON.stringify(body)});var data=await response.json().catch(function(){return{ok:false,message:'Unexpected server response.'}});if(response.status===401)data.message='Your browser session expired. Reload the page.';if(!response.ok)data.ok=false;return data}
function iconPlay(){return '<path d="m9 6 9 6-9 6V6Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>'}
function iconPause(){return '<path d="M9 7v10M15 7v10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'}
function syncPlayIcons(){var html=video.paused?iconPlay():iconPause();playIcon.innerHTML=html;centerPlayIcon.innerHTML=html;playerShell.classList.toggle('playing',!video.paused)}
function syncMuteIcon(){muteIcon.innerHTML=video.muted?'<path d="M5 10v4h4l4 4V6L9 10H5Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="m17 9 4 6m0-6-4 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>':'<path d="M5 10v4h4l4 4V6L9 10H5Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 9.2a4 4 0 0 1 0 5.6" stroke="currentColor" stroke-linecap="round"/>'}
function fmtTime(value){if(!isFinite(value)||value<0)return'0:00';var total=Math.floor(value),hours=Math.floor(total/3600),minutes=Math.floor((total%3600)/60),seconds=total%60;return hours>0?hours+':'+String(minutes).padStart(2,'0')+':'+String(seconds).padStart(2,'0'):minutes+':'+String(seconds).padStart(2,'0')}
function updateTimeline(){var duration=video.duration||0,currentTime=video.currentTime||0,percent=duration?Math.max(0,Math.min(100,currentTime/duration*100)):0;seek.value=String(percent);playedBar.style.width=percent+'%';playerTime.textContent=fmtTime(currentTime)+' / '+fmtTime(duration);if(video.buffered&&video.buffered.length&&duration){try{bufferedBar.style.width=Math.min(100,video.buffered.end(video.buffered.length-1)/duration*100)+'%'}catch(e){}}}
function showControls(){playerShell.classList.remove('controlsHidden');if(controlsTimer)clearTimeout(controlsTimer);if(!video.paused)controlsTimer=setTimeout(function(){playerShell.classList.add('controlsHidden')},2400)}
function setLoading(on){playerShell.classList.toggle('loading',!!on)}
function resetPlayer(){if(controlsTimer)clearTimeout(controlsTimer);video.pause();video.removeAttribute('src');video.load();playerShell.classList.remove('playing','loading','controlsHidden');seek.value='0';playedBar.style.width='0%';bufferedBar.style.width='0%';playerTime.textContent='0:00 / 0:00';syncPlayIcons()}
function setMode(next){if(next===mode)return;mode=next;pollToken++;current=null;selected=null;prepared=null;resetPlayer();showOnly('none');modeSwitch.classList.toggle('watch',mode==='watch');modeDownload.classList.toggle('active',mode==='download');modeWatch.classList.toggle('active',mode==='watch');modeDownload.setAttribute('aria-selected',mode==='download'?'true':'false');modeWatch.setAttribute('aria-selected',mode==='watch'?'true':'false');analyze.textContent=mode==='watch'?'Watch':'Analyze';msg('')}
function choose(value,button){selected=value;formats.querySelectorAll('.format').forEach(function(item){item.classList.remove('selected')});button.classList.add('selected');prepare.disabled=false;prepared=null}
function addFormat(name,desc,value){var button=document.createElement('button');button.type='button';button.className='format';button.innerHTML='<span class="formatName"></span><span class="formatDesc"></span>';button.querySelector('.formatName').textContent=name;button.querySelector('.formatDesc').textContent=desc;button.addEventListener('click',function(){choose(value,button)});formats.appendChild(button);return button}
function renderFormats(data){formats.textContent='';selected=null;var preferred=null;(data.qualities||[]).forEach(function(q){var b=addFormat(q+'p',q===360?'Small file':q===480?'Balanced':q===720?'Recommended':'Full HD',{quality:q});if(q===720)preferred=b});if(data.audioAvailable){addFormat('Audio Lite','Smaller M4A',{audioMode:'low'});addFormat('Audio HQ','Best M4A',{audioMode:'hq'})}if(!preferred)preferred=formats.querySelector('.format');if(preferred)preferred.click()}
async function openWatch(data){msg('Opening stream…');var watch=await api('/web/api/watch',{videoId:data.videoId});if(!watch.ok||!watch.streamUrl)throw new Error(watch.message||'Could not open this stream.');watchTitle.textContent=watch.title||data.title||'YouTube video';showOnly('player');setLoading(true);video.src=watch.streamUrl;video.load();showControls();msg('')}
async function analyzeLink(){var value=url.value.trim();if(!value)return msg('Paste a YouTube link first.',true);pollToken++;analyze.disabled=true;prepared=null;resetPlayer();showOnly('none');msg('Reading video…');try{var data=await api('/web/api/metadata',{url:value});if(!data.ok)throw new Error(data.message||'Could not read this video.');current=data;if(mode==='watch'){await openWatch(data)}else{videoTitle.textContent=data.title||'YouTube video';renderFormats(data);showOnly('result');msg('')}}catch(error){showOnly('none');msg(error.message||'Could not read this video.',true)}finally{analyze.disabled=false}}
async function poll(jobId,token){var started=Date.now();while(token===pollToken){await wait(1500);var data=await api('/web/api/status',{jobId:jobId});if(token!==pollToken)return;if(data.ok&&data.state==='ready'){prepared=data;readyMeta.textContent=size(data.size)+' · '+data.fileName;showOnly('ready');msg('');analyze.disabled=false;return}if(!data.ok||data.state==='error')throw new Error(data.message||'Could not prepare this file.');var seconds=Math.round((Date.now()-started)/1000);progressSub.textContent=seconds>45?'Still preparing…':'Preparing…';if(seconds>1800)throw new Error('This download took too long. Please try again.')}}
async function prepareFile(){if(!current||!selected||mode!=='download')return;var token=++pollToken;prepare.disabled=true;analyze.disabled=true;progressSub.textContent='Preparing…';showOnly('progress');msg('');try{var body={videoId:current.videoId};if(selected.quality)body.quality=selected.quality;else body.audioMode=selected.audioMode;var data=await api('/web/api/start',body);if(!data.ok||!data.jobId)throw new Error(data.message||'Could not start this download.');await poll(data.jobId,token)}catch(error){if(token===pollToken){showOnly('result');prepare.disabled=false;analyze.disabled=false;msg(error.message||'Could not prepare this file.',true)}}}
function saveFile(){if(!prepared||!prepared.downloadUrl)return;var anchor=document.createElement('a');anchor.href=prepared.downloadUrl;anchor.download=prepared.fileName||'';anchor.rel='noopener';document.body.appendChild(anchor);anchor.click();anchor.remove()}
function togglePlay(){if(!video.src)return;if(video.paused){var promise=video.play();if(promise&&promise.catch)promise.catch(function(){msg('Tap play again to start the video.',true)})}else video.pause();showControls()}
async function toggleFullscreen(){showControls();if(document.fullscreenElement&&document.exitFullscreen){try{await document.exitFullscreen();return}catch(e){}}if(playerShell.requestFullscreen){try{await playerShell.requestFullscreen();return}catch(e){}}if(video.webkitEnterFullscreen){try{video.webkitEnterFullscreen()}catch(e){}}}
modeDownload.addEventListener('click',function(){setMode('download')});modeWatch.addEventListener('click',function(){setMode('watch')});analyze.addEventListener('click',analyzeLink);prepare.addEventListener('click',prepareFile);save.addEventListener('click',saveFile);
url.addEventListener('keydown',function(event){if(event.key==='Enter'){event.preventDefault();analyzeLink()}});url.addEventListener('input',function(){pollToken++;prepared=null;resetPlayer();showOnly('none');msg('')});
centerPlay.addEventListener('click',function(event){event.stopPropagation();togglePlay()});playPause.addEventListener('click',function(event){event.stopPropagation();togglePlay()});
back10.addEventListener('click',function(event){event.stopPropagation();video.currentTime=Math.max(0,(video.currentTime||0)-10);showControls()});forward10.addEventListener('click',function(event){event.stopPropagation();video.currentTime=Math.min(video.duration||Infinity,(video.currentTime||0)+10);showControls()});
seek.addEventListener('input',function(event){event.stopPropagation();if(video.duration)video.currentTime=(Number(seek.value)/100)*video.duration;updateTimeline();showControls()});
mute.addEventListener('click',function(event){event.stopPropagation();video.muted=!video.muted;syncMuteIcon();showControls()});fullscreen.addEventListener('click',function(event){event.stopPropagation();toggleFullscreen()});
video.addEventListener('click',togglePlay);playerShell.addEventListener('mousemove',showControls);playerShell.addEventListener('touchstart',showControls,{passive:true});
video.addEventListener('play',function(){syncPlayIcons();setLoading(false);showControls()});video.addEventListener('pause',function(){syncPlayIcons();showControls()});video.addEventListener('ended',function(){syncPlayIcons();showControls()});
video.addEventListener('timeupdate',updateTimeline);video.addEventListener('progress',updateTimeline);video.addEventListener('durationchange',updateTimeline);video.addEventListener('loadedmetadata',function(){setLoading(false);updateTimeline();showControls()});video.addEventListener('canplay',function(){setLoading(false)});video.addEventListener('waiting',function(){setLoading(true)});video.addEventListener('stalled',function(){setLoading(true)});video.addEventListener('playing',function(){setLoading(false)});
video.addEventListener('error',function(){setLoading(false);msg('This stream stopped. Press Watch to reconnect.',true);showControls()});document.addEventListener('fullscreenchange',showControls);
syncPlayIcons();syncMuteIcon();showOnly('none');
})();
</script>
</body>
</html>`;
