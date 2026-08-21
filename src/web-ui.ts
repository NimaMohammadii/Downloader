export const WEB_APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Watch or download YouTube videos.">
<meta name="robots" content="index,follow">
<title>Video Downloader</title>
<style>
:root{color-scheme:dark;--bg:#050505;--text:#f5f5f5;--muted:#858585;--line:#222;--panel:#0a0a0a;--metallic-white:linear-gradient(90deg,#cecece 0%,#f3f3f3 12%,#ffffff 24%,#d6d6d6 43%,#ffffff 63%,#eeeeee 79%,#c9c9c9 100%);--metallic-shadow:inset 1px 0 0 rgba(255,255,255,.84),inset -1px 0 0 rgba(0,0,0,.15),0 8px 22px rgba(0,0,0,.3);--card-line:linear-gradient(112deg,rgba(255,255,255,.26) 0%,rgba(255,255,255,.07) 18%,rgba(255,255,255,.13) 48%,rgba(255,255,255,.055) 76%,rgba(255,255,255,.2) 100%);--card-line-focus:linear-gradient(112deg,rgba(255,255,255,.38) 0%,rgba(255,255,255,.11) 18%,rgba(255,255,255,.22) 48%,rgba(255,255,255,.08) 76%,rgba(255,255,255,.3) 100%)}
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
.modeSwitch{position:relative;display:grid;grid-template-columns:1fr 1fr;width:min(100%,390px);height:56px;padding:5px;margin:0 0 18px;border:1px solid rgba(255,255,255,.24);border-radius:19px;background:transparent;-webkit-backdrop-filter:blur(3px) saturate(125%) contrast(1.04);backdrop-filter:blur(3px) saturate(125%) contrast(1.04);box-shadow:inset 0 1px 0 rgba(255,255,255,.22),inset 1px 0 0 rgba(255,255,255,.08),inset 0 -1px 0 rgba(255,255,255,.045);isolation:isolate}
.modeThumb{position:absolute;z-index:0;left:5px;top:5px;width:calc(50% - 5px);height:46px;border-radius:14px;background:var(--metallic-white);box-shadow:var(--metallic-shadow);transition:transform .3s cubic-bezier(.22,.85,.28,1)}
.modeSwitch.watch .modeThumb{transform:translateX(100%)}
.modeButton{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;gap:8px;background:transparent;color:rgba(255,255,255,.54);font-size:13px;font-weight:720;transition:color .2s,transform .16s}
.modeButton.active{color:#080808}.modeButton:active{transform:scale(.98)}.modeButton svg{width:19px;height:19px;stroke-width:2.1}
.inputShell{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;padding:8px;border:1px solid rgba(255,255,255,.24);background:transparent;border-radius:21px;-webkit-backdrop-filter:blur(3px) saturate(125%) contrast(1.04);backdrop-filter:blur(3px) saturate(125%) contrast(1.04);box-shadow:inset 0 1px 0 rgba(255,255,255,.22),inset 1px 0 0 rgba(255,255,255,.08),inset 0 -1px 0 rgba(255,255,255,.045);transition:border-color .18s ease,box-shadow .18s ease}
.inputShell:focus-within{border-color:rgba(255,255,255,.36);background:transparent;box-shadow:inset 0 1px 0 rgba(255,255,255,.28),inset 1px 0 0 rgba(255,255,255,.1),inset 0 -1px 0 rgba(255,255,255,.06)}
.linkIcon{width:42px;height:42px;border-radius:14px;background:transparent;display:grid;place-items:center;color:#aaa;font-size:18px}
.url{min-width:0;width:100%;border:0;outline:0;background:transparent;color:#fff;padding:11px 0;font-size:15px}
.url:focus,.url:focus-visible{border:0;outline:0;box-shadow:none}
.url::placeholder{color:rgba(255,255,255,.44)}
.go{height:46px;padding:0 18px;border-radius:15px;background:var(--metallic-white);box-shadow:var(--metallic-shadow);color:#050505;font-weight:720;transition:transform .16s,opacity .16s,filter .16s}
.go:hover{filter:brightness(1.025)}.go:active{transform:scale(.975)}.go:disabled{opacity:.38;cursor:default;filter:none}
.message{min-height:22px;margin:10px 4px 0;color:#777;font-size:13px;line-height:1.4}.message:empty{min-height:0;margin-top:0}.message.error{color:#e7e7e7}
.workspace{display:none;min-width:0}.workspace.show{display:block}
.result,.progress,.ready,.playerCard{display:none}.result.show,.progress.show,.ready.show{display:block}.playerCard.show{display:block;animation:playerReveal .58s cubic-bezier(.16,1,.3,1) both;transform-origin:50% 24%}
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
.playerCard{padding:0}.playerShell{position:relative;width:100%;aspect-ratio:16/9;border-radius:22px;overflow:hidden;background:#000;border:1px solid rgba(255,255,255,.13);box-shadow:0 18px 54px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.05);touch-action:manipulation;isolation:isolate}
.playerShell video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
.playerShade{position:absolute;inset:0;background:linear-gradient(to bottom,rgba(0,0,0,.16) 0%,transparent 30%,transparent 54%,rgba(0,0,0,.72) 100%);pointer-events:none}
.seekFeedback{position:absolute;z-index:8;left:25%;top:50%;display:flex;align-items:center;gap:7px;color:#fff;opacity:0;pointer-events:none;transform:translate(-50%,-50%) scale(.78);text-shadow:0 2px 18px rgba(0,0,0,.5)}.seekFeedback.right{left:75%}.seekFeedback svg{width:23px;height:23px}.seekFeedback.right svg{transform:scaleX(-1)}.seekFeedbackValue{font-size:14px;font-weight:760;line-height:1;letter-spacing:-.03em}.seekFeedback.show{animation:seekFeedbackPulse .62s cubic-bezier(.16,1,.3,1)}
.playerCenter{position:absolute;z-index:5;left:50%;top:50%;transform:translate(-50%,-50%);width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:rgba(6,6,8,.44);color:#fff;border:0;-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);box-shadow:0 8px 24px rgba(0,0,0,.24);transition:opacity .28s ease,transform .2s,background .2s;transition-delay:0s}
.playerCenter:active{transform:translate(-50%,-50%) scale(.91)}.playerCenter svg{width:18px;height:18px}.playerShell.playing .playerCenter{opacity:0;pointer-events:none;transition-delay:.65s}
.playerLoading{position:absolute;z-index:6;left:50%;top:50%;width:40px;height:40px;margin:-20px;border:2px solid rgba(255,255,255,.13);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;opacity:0;pointer-events:none;transition:opacity .18s}
.playerShell.loading .playerLoading{opacity:1}.playerShell.loading .playerCenter{opacity:0}
.playerSettings{position:absolute;z-index:10;right:10px;top:10px;width:38px;height:38px;display:grid;place-items:center;background:transparent;color:#fff;border:0;box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none;transition:transform .18s}
.playerSettings:active{transform:scale(.92)}.playerSettings svg{width:21px;height:21px;transition:transform .34s cubic-bezier(.16,1,.3,1)}.playerShell.settingsOpen .playerSettings svg{transform:rotate(45deg)}
.qualityMenu{position:absolute;z-index:11;right:10px;top:54px;width:138px;padding:6px;border:1px solid rgba(255,255,255,.13);border-radius:14px;background:rgba(8,8,11,.62);-webkit-backdrop-filter:blur(14px) saturate(125%);backdrop-filter:blur(14px) saturate(125%);box-shadow:0 14px 38px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.08);opacity:0;transform:translateY(-7px) scale(.96);transform-origin:100% 0;pointer-events:none;transition:opacity .18s,transform .24s cubic-bezier(.16,1,.3,1)}
.playerShell.settingsOpen .qualityMenu{opacity:1;transform:none;pointer-events:auto}.qualityMenu.busy{pointer-events:none;opacity:.62}
.qualityOption{width:100%;min-height:34px;padding:0 10px;border-radius:9px;display:flex;align-items:center;justify-content:space-between;gap:8px;background:transparent;color:rgba(255,255,255,.7);font-size:12px;font-weight:620;text-align:left;transition:background .16s,color .16s,transform .14s}.qualityOption:active{transform:scale(.97)}.qualityOption:hover{background:rgba(255,255,255,.06);color:#fff}.qualityOption.active{background:rgba(255,255,255,.1);color:#fff}.qualityDetail{color:rgba(255,255,255,.38);font-size:10px;font-variant-numeric:tabular-nums}.qualityCheck{width:5px;height:5px;border-radius:50%;background:#fff;box-shadow:0 0 0 3px rgba(255,255,255,.08)}
.playerControls{position:absolute;z-index:7;left:0;right:0;bottom:0;padding:24px 14px 7px;background:linear-gradient(to top,rgba(0,0,0,.88),rgba(0,0,0,.34) 46%,transparent);transition:opacity .2s,transform .2s}
.playerShell.controlsHidden:not(.settingsOpen) .playerControls{opacity:0;transform:translateY(7px);pointer-events:none}
.seekWrap{position:relative;height:31px;display:flex;align-items:flex-end}.seekBase{position:absolute;left:2px;right:2px;bottom:1px;height:15px;border-radius:99px;background:rgba(255,255,255,.17);overflow:hidden;transition:background .18s ease,transform .18s ease}.seekWrap:hover .seekBase,.seekWrap:focus-within .seekBase{height:15px;background:rgba(255,255,255,.23)}.seekWrap:active .seekBase{height:15px;transform:scaleY(1.03)}.bufferedBar,.playedBar{position:absolute;inset:0 auto 0 0;width:0;border-radius:99px}.bufferedBar{background:rgba(255,255,255,.22)}.playedBar{background:#fff;transition:width .1s linear}.seek{position:relative;width:100%;height:31px;margin:0;appearance:none;-webkit-appearance:none;background:transparent}.seek::-webkit-slider-runnable-track{height:15px;background:transparent}.seek::-webkit-slider-thumb{-webkit-appearance:none;width:0;height:0;border:0;border-radius:0;background:transparent;box-shadow:none;opacity:0}.seek::-moz-range-track{height:15px;background:transparent}.seek::-moz-range-thumb{width:0;height:0;border:0;border-radius:0;background:transparent;box-shadow:none;opacity:0}
.controlRow{display:flex;align-items:center;gap:0;margin-top:-4px}.controlButton{width:46px;height:46px;flex:0 0 auto;border-radius:11px;display:grid;place-items:center;background:transparent;color:#fff;transition:transform .16s,opacity .16s}.controlButton:hover{background:transparent}.controlButton:active{transform:scale(.93);background:transparent}.controlButton svg{width:28px;height:28px;overflow:visible}.playButton{width:46px;height:46px;margin:0}.playButton svg{width:28px;height:28px}.muteButton svg{transform:translateX(4px)}.fullscreenButton svg{transform:translateX(-4px)}.iconMorph{transform-origin:center;animation:iconMorphIn .24s cubic-bezier(.16,1,.3,1)}
.playerTime{margin-left:3px;color:#d5d5d5;font-size:17px;font-variant-numeric:tabular-nums;white-space:nowrap}.controlSpacer{flex:1}
.watchMeta{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:17px 4px 0}.watchTitle{font-size:14px;font-weight:600;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.watchBadge{flex:0 0 auto;padding:5px 8px;border-radius:99px;background:#eee;color:#080808;font-size:10px;font-weight:700;letter-spacing:.07em}
.playerShell:fullscreen{border:0;border-radius:0}.playerShell:fullscreen .playerControls{padding-bottom:max(7px,env(safe-area-inset-bottom))}.playerShell:fullscreen .playerSettings{top:max(10px,env(safe-area-inset-top));right:max(10px,env(safe-area-inset-right))}.playerShell:fullscreen .qualityMenu{top:calc(max(10px,env(safe-area-inset-top)) + 44px);right:max(10px,env(safe-area-inset-right))}
@keyframes playerReveal{0%{opacity:0;transform:translateY(22px) scale(.975);filter:blur(9px)}55%{opacity:1}100%{opacity:1;transform:none;filter:blur(0)}}
@keyframes iconMorphIn{0%{opacity:.2;transform:scale(.72)}100%{opacity:1;transform:scale(1)}}
@keyframes seekFeedbackPulse{0%{opacity:0;transform:translate(-50%,-50%) scale(.72)}18%{opacity:1;transform:translate(-50%,-50%) scale(1.08)}58%{opacity:1;transform:translate(-50%,-50%) scale(1)}100%{opacity:0;transform:translate(-50%,-50%) scale(.94)}}
@keyframes spin{to{transform:rotate(360deg)}}@keyframes scan{0%{transform:translateX(-120%)}100%{transform:translateX(390%)}}
@media(min-width:44rem){.formats{grid-template-columns:repeat(3,minmax(0,1fr))}.resultHead{padding:22px 26px}.resultBody{padding:22px 26px 26px}}
@media(min-width:56rem){.layout.hasOutput{grid-template-columns:minmax(310px,.82fr) minmax(460px,1.18fr);gap:clamp(28px,4vw,50px);align-items:start}.layout.hasOutput .intro{width:100%;margin:0;position:sticky;top:clamp(24px,4vw,46px)}.layout.hasOutput .workspace{min-width:0}.layout.hasOutput .formats{grid-template-columns:repeat(2,minmax(0,1fr))}.playerShell{max-height:70vh}}
@media(max-width:29rem){.page{padding-left:13px;padding-right:13px}.inputShell{grid-template-columns:auto minmax(0,1fr);gap:8px}.go{grid-column:1/-1;width:100%}.formats{grid-template-columns:repeat(2,minmax(0,1fr))}.controlButton,.playButton{width:46px;height:46px}.playerTime{margin-left:2px;font-size:17px}.playerControls{padding-left:8px;padding-right:8px;padding-bottom:6px}.playerSettings{right:8px;top:8px}.qualityMenu{right:8px;top:52px}.watchMeta{padding-top:15px}}
@media(any-pointer:coarse){.modeButton,.go,.primary,.save,.format{min-height:48px}.controlButton,.playButton{width:46px;height:46px}.url{min-height:48px}.seekWrap,.seek{height:31px}}
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
          <div id="seekFeedback" class="seekFeedback" aria-hidden="true"><svg viewBox="0 0 28 28" fill="none"><path d="M8.3 8.1H4.8V4.6M5 8.2a10 10 0 1 1-1 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="seekFeedbackValue">10</span></div>
          <button id="centerPlay" class="playerCenter" type="button" aria-label="Play">
            <svg id="centerPlayIcon" viewBox="0 0 24 24" fill="none"><g class="iconMorph"><path d="M9.2 7.15c0-.92 1.02-1.48 1.8-.98l6.4 4.08c.72.46.72 1.54 0 2l-6.4 4.08c-.78.5-1.8-.06-1.8-.98V7.15Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g></svg>
          </button>
          <button id="playerSettings" class="playerSettings" type="button" aria-label="Video quality" aria-expanded="false">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z" stroke="currentColor" stroke-width="1.8"/><path d="M19.1 13.1c.05-.36.08-.73.08-1.1s-.03-.74-.08-1.1l2-1.56-1.9-3.28-2.47 1a8.25 8.25 0 0 0-1.9-1.1L14.48 3h-3.8l-.36 2.96a8.25 8.25 0 0 0-1.9 1.1l-2.47-1-1.9 3.28 2 1.56c-.05.36-.08.73-.08 1.1s.03.74.08 1.1l-2 1.56 1.9 3.28 2.47-1c.58.45 1.22.82 1.9 1.1l.36 2.96h3.8l.36-2.96a8.25 8.25 0 0 0 1.9-1.1l2.47 1 1.9-3.28-2-1.56Z" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div id="qualityMenu" class="qualityMenu" role="menu" aria-label="Video quality"></div>
          <div class="playerControls">
            <div class="seekWrap"><div class="seekBase"><div id="bufferedBar" class="bufferedBar"></div><div id="playedBar" class="playedBar"></div></div><input id="seek" class="seek" type="range" min="0" max="100" value="0" step="0.05" aria-label="Seek video"></div>
            <div class="controlRow">
              <button id="playPause" class="controlButton playButton" type="button" aria-label="Play or pause"><svg id="playIcon" viewBox="0 0 24 24" fill="none"><g class="iconMorph"><path d="M9.2 7.15c0-.92 1.02-1.48 1.8-.98l6.4 4.08c.72.46.72 1.54 0 2l-6.4 4.08c-.78.5-1.8-.06-1.8-.98V7.15Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g></svg></button>
              <div id="playerTime" class="playerTime">0:00 / 0:00</div><div class="controlSpacer"></div>
              <button id="mute" class="controlButton muteButton" type="button" aria-label="Mute or unmute"><svg id="muteIcon" viewBox="0 0 24 24" fill="none"><g class="iconMorph"><path d="M5 10v4h4l4 4V6L9 10H5Z" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 9.2a4 4 0 0 1 0 5.6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></g></svg></button>
              <button id="fullscreen" class="controlButton fullscreenButton" type="button" aria-label="Fullscreen"><svg viewBox="0 0 24 24" fill="none"><path d="M8 4H5.8A1.8 1.8 0 0 0 4 5.8V8M16 4h2.2A1.8 1.8 0 0 1 20 5.8V8M8 20H5.8A1.8 1.8 0 0 1 4 18.2V16M16 20h2.2a1.8 1.8 0 0 0 1.8-1.8V16" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
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
var mode='download',current=null,selected=null,prepared=null,pollToken=0,controlsTimer=null,tapTimer=null,lastTapAt=0,lastTapSide='';
var watchQualities=[],watchRequestedQuality=null,watchActualQuality=null,pendingResume=null,qualityBusy=false;
var tabId=(crypto.randomUUID?crypto.randomUUID().replace(/-/g,''):String(Date.now())+Math.random().toString(36).slice(2));
var layout=$('layout'),workspace=$('workspace'),modeSwitch=$('modeSwitch'),modeDownload=$('modeDownload'),modeWatch=$('modeWatch'),url=$('url'),analyze=$('analyze'),message=$('message'),result=$('result'),videoTitle=$('videoTitle'),formats=$('formats'),prepare=$('prepare'),progress=$('progress'),progressSub=$('progressSub'),ready=$('ready'),readyMeta=$('readyMeta'),save=$('save'),playerCard=$('playerCard'),playerShell=$('playerShell'),video=$('video'),seekFeedback=$('seekFeedback'),centerPlay=$('centerPlay'),centerPlayIcon=$('centerPlayIcon'),playerSettings=$('playerSettings'),qualityMenu=$('qualityMenu'),playPause=$('playPause'),playIcon=$('playIcon'),seek=$('seek'),bufferedBar=$('bufferedBar'),playedBar=$('playedBar'),playerTime=$('playerTime'),mute=$('mute'),muteIcon=$('muteIcon'),fullscreen=$('fullscreen'),watchTitle=$('watchTitle');
function msg(text,error){message.textContent=text||'';message.classList.toggle('error',!!error)}
function wait(ms){return new Promise(function(resolve){setTimeout(resolve,ms)})}
function size(bytes){if(!bytes)return'File ready';var units=['B','KB','MB','GB'],i=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),3),value=bytes/Math.pow(1024,i);return(value>=100||i===0?Math.round(value):value.toFixed(1))+' '+units[i]}
function showOnly(name){var active=name!=='none';workspace.classList.toggle('show',active);layout.classList.toggle('hasOutput',active);result.classList.toggle('show',name==='result');playerCard.classList.toggle('show',name==='player');progress.classList.toggle('show',name==='progress');ready.classList.toggle('show',name==='ready')}
async function api(path,body){body=Object.assign({},body,{tabId:tabId});var response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-vexa-app':'web'},body:JSON.stringify(body)});var data=await response.json().catch(function(){return{ok:false,message:'Unexpected server response.'}});if(response.status===401)data.message='Your browser session expired. Reload the page.';if(!response.ok)data.ok=false;return data}
function iconPlay(){return '<g class="iconMorph"><path d="M9.2 7.15c0-.92 1.02-1.48 1.8-.98l6.4 4.08c.72.46.72 1.54 0 2l-6.4 4.08c-.78.5-1.8-.06-1.8-.98V7.15Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>'}
function iconPause(){return '<g class="iconMorph"><path d="M8.5 7v10M15.5 7v10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></g>'}
function syncPlayIcons(){var html=video.paused?iconPlay():iconPause();playIcon.innerHTML=html;centerPlayIcon.innerHTML=html;playerShell.classList.toggle('playing',!video.paused)}
function syncMuteIcon(){muteIcon.innerHTML=video.muted?'<g class="iconMorph"><path d="M5 10v4h4l4 4V6L9 10H5Z" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="m17 9 4 6m0-6-4 6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></g>':'<g class="iconMorph"><path d="M5 10v4h4l4 4V6L9 10H5Z" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 9.2a4 4 0 0 1 0 5.6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></g>'}
function fmtTime(value){if(!isFinite(value)||value<0)return'0:00';var total=Math.floor(value),hours=Math.floor(total/3600),minutes=Math.floor((total%3600)/60),seconds=total%60;return hours>0?hours+':'+String(minutes).padStart(2,'0')+':'+String(seconds).padStart(2,'0'):minutes+':'+String(seconds).padStart(2,'0')}
function updateTimeline(){var duration=video.duration||0,currentTime=video.currentTime||0,percent=duration?Math.max(0,Math.min(100,currentTime/duration*100)):0;seek.value=String(percent);playedBar.style.width=percent+'%';playerTime.textContent=fmtTime(currentTime)+' / '+fmtTime(duration);if(video.buffered&&video.buffered.length&&duration){try{bufferedBar.style.width=Math.min(100,video.buffered.end(video.buffered.length-1)/duration*100)+'%'}catch(e){}}}
function settingsOpen(){return playerShell.classList.contains('settingsOpen')}
function setSettingsOpen(open){playerShell.classList.toggle('settingsOpen',!!open);playerSettings.setAttribute('aria-expanded',open?'true':'false');if(open&&controlsTimer){clearTimeout(controlsTimer);controlsTimer=null}if(!open)showControls()}
function showControls(){playerShell.classList.remove('controlsHidden');if(controlsTimer)clearTimeout(controlsTimer);if(!video.paused&&!settingsOpen())controlsTimer=setTimeout(function(){playerShell.classList.add('controlsHidden')},2400)}
function setLoading(on){playerShell.classList.toggle('loading',!!on)}
function showSeekFeedback(delta){seekFeedback.classList.remove('show','right');if(delta>0)seekFeedback.classList.add('right');void seekFeedback.offsetWidth;seekFeedback.classList.add('show')}
function seekBy(delta){if(!video.src)return;setSettingsOpen(false);var duration=Number(video.duration)||0,target=Math.max(0,(Number(video.currentTime)||0)+delta);if(duration&&isFinite(duration))target=Math.min(duration,target);video.currentTime=target;updateTimeline();showSeekFeedback(delta);showControls()}
function handleVideoPointer(event){if(!video.src)return;if(event.pointerType==='mouse'&&event.button!==0)return;var rect=video.getBoundingClientRect(),side=event.clientX<rect.left+rect.width/2?'left':'right',now=performance.now();if(tapTimer&&now-lastTapAt<=300&&side===lastTapSide){clearTimeout(tapTimer);tapTimer=null;lastTapAt=0;lastTapSide='';seekBy(side==='left'?-10:10);return}if(tapTimer){clearTimeout(tapTimer);tapTimer=null}lastTapAt=now;lastTapSide=side;tapTimer=setTimeout(function(){tapTimer=null;lastTapAt=0;lastTapSide='';togglePlay()},300)}
function renderQualityMenu(){qualityMenu.textContent='';var choices=[null].concat(watchQualities);choices.forEach(function(value){var button=document.createElement('button');button.type='button';button.className='qualityOption';button.setAttribute('role','menuitemradio');var active=value===watchRequestedQuality;button.classList.toggle('active',active);button.setAttribute('aria-checked',active?'true':'false');var label=document.createElement('span');label.textContent=value==null?'Auto':value+'p';button.appendChild(label);if(value==null&&watchActualQuality){var detail=document.createElement('span');detail.className='qualityDetail';detail.textContent=watchActualQuality+'p';button.appendChild(detail)}else if(active){var check=document.createElement('span');check.className='qualityCheck';button.appendChild(check)}button.addEventListener('click',function(event){event.stopPropagation();if(!qualityBusy&&value!==watchRequestedQuality)switchWatchQuality(value)});qualityMenu.appendChild(button)});qualityMenu.classList.toggle('busy',qualityBusy)}
function resetPlayer(){if(controlsTimer)clearTimeout(controlsTimer);controlsTimer=null;if(tapTimer)clearTimeout(tapTimer);tapTimer=null;lastTapAt=0;lastTapSide='';seekFeedback.classList.remove('show','right');video.pause();video.removeAttribute('src');video.load();playerShell.classList.remove('playing','loading','controlsHidden','settingsOpen');playerSettings.setAttribute('aria-expanded','false');watchQualities=[];watchRequestedQuality=null;watchActualQuality=null;pendingResume=null;qualityBusy=false;qualityMenu.textContent='';seek.value='0';playedBar.style.width='0%';bufferedBar.style.width='0%';playerTime.textContent='0:00 / 0:00';syncPlayIcons()}
function setMode(next){if(next===mode)return;mode=next;pollToken++;current=null;selected=null;prepared=null;resetPlayer();showOnly('none');modeSwitch.classList.toggle('watch',mode==='watch');modeDownload.classList.toggle('active',mode==='download');modeWatch.classList.toggle('active',mode==='watch');modeDownload.setAttribute('aria-selected',mode==='download'?'true':'false');modeWatch.setAttribute('aria-selected',mode==='watch'?'true':'false');analyze.textContent=mode==='watch'?'Watch':'Analyze';msg('')}
function choose(value,button){selected=value;formats.querySelectorAll('.format').forEach(function(item){item.classList.remove('selected')});button.classList.add('selected');prepare.disabled=false;prepared=null}
function addFormat(name,desc,value){var button=document.createElement('button');button.type='button';button.className='format';button.innerHTML='<span class="formatName"></span><span class="formatDesc"></span>';button.querySelector('.formatName').textContent=name;button.querySelector('.formatDesc').textContent=desc;button.addEventListener('click',function(){choose(value,button)});formats.appendChild(button);return button}
function renderFormats(data){formats.textContent='';selected=null;var preferred=null;(data.qualities||[]).forEach(function(q){var b=addFormat(q+'p',q===360?'Small file':q===480?'Balanced':q===720?'Recommended':'Full HD',{quality:q});if(q===720)preferred=b});if(data.audioAvailable){addFormat('Audio Lite','Smaller M4A',{audioMode:'low'});addFormat('Audio HQ','Best M4A',{audioMode:'hq'})}if(!preferred)preferred=formats.querySelector('.format');if(preferred)preferred.click()}
async function openWatch(data,requestedQuality,resume){qualityBusy=true;qualityMenu.classList.add('busy');setLoading(true);var body={videoId:data.videoId};if(requestedQuality!=null)body.quality=requestedQuality;try{var watch=await api('/web/api/watch',body);if(!watch.ok||!watch.streamUrl)throw new Error(watch.message||'Could not open this stream.');watchTitle.textContent=watch.title||data.title||'YouTube video';watchQualities=Array.isArray(watch.qualities)?watch.qualities.map(Number).filter(function(q){return isFinite(q)}):[];watchRequestedQuality=requestedQuality==null?null:Number(requestedQuality);watchActualQuality=Number(watch.quality)||null;pendingResume=resume||null;if(!playerCard.classList.contains('show'))showOnly('player');video.src=watch.streamUrl;video.load();renderQualityMenu();showControls();msg('')}catch(error){setLoading(false);if(resume&&resume.playing&&video.src){var retry=video.play();if(retry&&retry.catch)retry.catch(function(){})}throw error}finally{qualityBusy=false;qualityMenu.classList.remove('busy');renderQualityMenu()}}
async function switchWatchQuality(nextQuality){if(!current||qualityBusy)return;var previous=watchRequestedQuality,resume={time:Number(video.currentTime)||0,playing:!video.paused};setSettingsOpen(false);video.pause();try{await openWatch(current,nextQuality,resume)}catch(error){watchRequestedQuality=previous;renderQualityMenu();msg(error.message||'Could not change video quality.',true);showControls()}}
async function analyzeLink(){var value=url.value.trim();if(!value)return msg('Paste a YouTube link first.',true);pollToken++;analyze.disabled=true;prepared=null;resetPlayer();showOnly('none');msg('Reading video…');try{var data=await api('/web/api/metadata',{url:value});if(!data.ok)throw new Error(data.message||'Could not read this video.');current=data;if(mode==='watch'){msg('Opening stream…');await openWatch(data,null,null)}else{videoTitle.textContent=data.title||'YouTube video';renderFormats(data);showOnly('result');msg('')}}catch(error){showOnly('none');msg(error.message||'Could not read this video.',true)}finally{analyze.disabled=false}}
async function poll(jobId,token){var started=Date.now();while(token===pollToken){await wait(1500);var data=await api('/web/api/status',{jobId:jobId});if(token!==pollToken)return;if(data.ok&&data.state==='ready'){prepared=data;readyMeta.textContent=size(data.size)+' · '+data.fileName;showOnly('ready');msg('');analyze.disabled=false;return}if(!data.ok||data.state==='error')throw new Error(data.message||'Could not prepare this file.');var seconds=Math.round((Date.now()-started)/1000);progressSub.textContent=seconds>45?'Still preparing…':'Preparing…';if(seconds>1800)throw new Error('This download took too long. Please try again.')}}
async function prepareFile(){if(!current||!selected||mode!=='download')return;var token=++pollToken;prepare.disabled=true;analyze.disabled=true;progressSub.textContent='Preparing…';showOnly('progress');msg('');try{var body={videoId:current.videoId};if(selected.quality)body.quality=selected.quality;else body.audioMode=selected.audioMode;var data=await api('/web/api/start',body);if(!data.ok||!data.jobId)throw new Error(data.message||'Could not start this download.');await poll(data.jobId,token)}catch(error){if(token===pollToken){showOnly('result');prepare.disabled=false;analyze.disabled=false;msg(error.message||'Could not prepare this file.',true)}}}
function saveFile(){if(!prepared||!prepared.downloadUrl)return;var anchor=document.createElement('a');anchor.href=prepared.downloadUrl;anchor.download=prepared.fileName||'';anchor.rel='noopener';document.body.appendChild(anchor);anchor.click();anchor.remove()}
function togglePlay(){if(!video.src)return;setSettingsOpen(false);if(video.paused){var promise=video.play();if(promise&&promise.catch)promise.catch(function(){msg('Tap play again to start the video.',true)})}else video.pause();showControls()}
async function toggleFullscreen(){setSettingsOpen(false);showControls();if(document.fullscreenElement&&document.exitFullscreen){try{await document.exitFullscreen();return}catch(e){}}if(playerShell.requestFullscreen){try{await playerShell.requestFullscreen();return}catch(e){}}if(video.webkitEnterFullscreen){try{video.webkitEnterFullscreen()}catch(e){}}}
modeDownload.addEventListener('click',function(){setMode('download')});modeWatch.addEventListener('click',function(){setMode('watch')});analyze.addEventListener('click',analyzeLink);prepare.addEventListener('click',prepareFile);save.addEventListener('click',saveFile);
url.addEventListener('keydown',function(event){if(event.key==='Enter'){event.preventDefault();analyzeLink()}});url.addEventListener('input',function(){pollToken++;prepared=null;resetPlayer();showOnly('none');msg('')});
centerPlay.addEventListener('click',function(event){event.stopPropagation();togglePlay()});playPause.addEventListener('click',function(event){event.stopPropagation();togglePlay()});
seek.addEventListener('input',function(event){event.stopPropagation();setSettingsOpen(false);if(video.duration)video.currentTime=(Number(seek.value)/100)*video.duration;updateTimeline();showControls()});
mute.addEventListener('click',function(event){event.stopPropagation();setSettingsOpen(false);video.muted=!video.muted;syncMuteIcon();showControls()});fullscreen.addEventListener('click',function(event){event.stopPropagation();toggleFullscreen()});
playerSettings.addEventListener('click',function(event){event.stopPropagation();setSettingsOpen(!settingsOpen());renderQualityMenu();showControls()});qualityMenu.addEventListener('click',function(event){event.stopPropagation()});
video.addEventListener('pointerup',handleVideoPointer);playerShell.addEventListener('mousemove',showControls);playerShell.addEventListener('touchstart',showControls,{passive:true});
video.addEventListener('play',function(){syncPlayIcons();setLoading(false);showControls()});video.addEventListener('pause',function(){syncPlayIcons();showControls()});video.addEventListener('ended',function(){syncPlayIcons();showControls()});
video.addEventListener('timeupdate',updateTimeline);video.addEventListener('progress',updateTimeline);video.addEventListener('durationchange',updateTimeline);video.addEventListener('loadedmetadata',function(){if(pendingResume){var resume=pendingResume;pendingResume=null;if(resume.time>0&&isFinite(video.duration)){try{video.currentTime=Math.min(resume.time,Math.max(0,video.duration-.05))}catch(e){}}if(resume.playing){var promise=video.play();if(promise&&promise.catch)promise.catch(function(){showControls()})}}setLoading(false);updateTimeline();showControls()});video.addEventListener('canplay',function(){setLoading(false)});video.addEventListener('waiting',function(){setLoading(true)});video.addEventListener('playing',function(){setLoading(false)});
video.addEventListener('error',function(){setLoading(false);msg('This stream stopped. Press Watch to reconnect.',true);showControls()});document.addEventListener('fullscreenchange',showControls);
syncPlayIcons();syncMuteIcon();showOnly('none');
})();
</script>
</body>
</html>`;