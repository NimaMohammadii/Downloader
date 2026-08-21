import { WEB_APP_HTML } from "./web-ui";

const TELEGRAM_SDK = '<script src="https://telegram.org/js/telegram-web-app.js?63"></script>';

function replaceOnce(source: string, current: string, replacement: string): string {
  return source.includes(current) ? source.replace(current, replacement) : source;
}

let html = WEB_APP_HTML;
html = replaceOnce(html, "</head>", `${TELEGRAM_SDK}\n</head>`);
html = replaceOnce(
  html,
  "var tabId=(crypto.randomUUID?crypto.randomUUID().replace(/-/g,''):String(Date.now())+Math.random().toString(36).slice(2));",
  "var tg=window.Telegram&&window.Telegram.WebApp?window.Telegram.WebApp:null;var sessionId=(crypto.randomUUID?crypto.randomUUID().replace(/-/g,''):String(Date.now())+Math.random().toString(36).slice(2));function initData(){return tg&&tg.initData?tg.initData:''}",
);
html = replaceOnce(
  html,
  "async function api(path,body){body=Object.assign({},body,{tabId:tabId});var response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-vexa-app':'web'},body:JSON.stringify(body)});var data=await response.json().catch(function(){return{ok:false,message:'Unexpected server response.'}});if(response.status===401)data.message='Your browser session expired. Reload the page.';if(!response.ok)data.ok=false;return data}",
  "async function api(path,body){if(!initData())return{ok:false,message:'Open this Mini App from Telegram.'};path=path.replace(/^\\/web\\//,'/mini-app/');body=Object.assign({},body,{initData:initData(),sessionId:sessionId});var response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});var data=await response.json().catch(function(){return{ok:false,message:'Unexpected server response.'}});if(response.status===401)data.message='Open this Mini App from Telegram.';if(!response.ok)data.ok=false;return data}",
);
html = replaceOnce(
  html,
  "function saveFile(){if(!prepared||!prepared.downloadUrl)return;var anchor=document.createElement('a');anchor.href=prepared.downloadUrl;anchor.download=prepared.fileName||'';anchor.rel='noopener';document.body.appendChild(anchor);anchor.click();anchor.remove()}",
  "function saveFile(){if(!prepared||!prepared.downloadUrl)return;if(tg&&typeof tg.downloadFile==='function'){tg.downloadFile({url:prepared.downloadUrl,file_name:prepared.fileName||''},function(ok){msg(ok?'Download started.':'Telegram did not start the download. Tap Download again.',!ok)});return}if(tg&&typeof tg.openLink==='function'){tg.openLink(prepared.downloadUrl);return}location.href=prepared.downloadUrl}",
);
html = replaceOnce(
  html,
  "syncPlayIcons();syncMuteIcon();showOnly('none');",
  "if(tg){try{tg.ready();tg.expand();tg.setHeaderColor&&tg.setHeaderColor('#050505');tg.setBackgroundColor&&tg.setBackgroundColor('#050505');tg.setBottomBarColor&&tg.setBottomBarColor('#050505')}catch(e){}}else msg('Open this Mini App from Telegram.',true);syncPlayIcons();syncMuteIcon();showOnly('none');",
);

export const MINI_APP_HTML = html;
