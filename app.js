(function(){
"use strict";
var TASKS=["Mow","Edge","Trim","Fertilize","Weed control","Fungicide","Insecticide","Water","Aerate","Overseed","Leaves","Supplies","Other"];
var LS="lawnlog-state",LS_TAB="lawnlog-tab";
var DEFAULT_STATE={v:1,updatedAt:0,entries:[],schedules:[{task:"Mow",every:7},{task:"Edge",every:14},{task:"Water",every:14}]};

var state;
try{state=JSON.parse(localStorage.getItem(LS)||"null")}catch(e){state=null}
if(!state||!Array.isArray(state.entries))state=JSON.parse(JSON.stringify(DEFAULT_STATE));
if(!Array.isArray(state.schedules))state.schedules=[];
var tab="home";try{tab=localStorage.getItem(LS_TAB)||"home"}catch(e){}
if(tab==="remind")tab="settings";if(["home","history","products","spend","settings"].indexOf(tab)<0)tab="home";
var histFilter="all",spendYear=new Date().getFullYear(),statusText="",sheetTask=null;

/* ---------- helpers ---------- */
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function pad(n){return String(n).padStart(2,"0")}
function iso(d){return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())}
function todayISO(){return iso(new Date())}
function parse(s){var p=s.split("-").map(Number);return new Date(p[0],p[1]-1,p[2])}
function daysBetween(a,b){return Math.round((parse(b)-parse(a))/86400000)}
function addDays(s,n){var d=parse(s);d.setDate(d.getDate()+n);return iso(d)}
function fmt(s){return parse(s).toLocaleDateString(undefined,{month:"short",day:"numeric"})}
function fmtWeekday(s){return parse(s).toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"})}
function fmtLong(s){var d=parse(s),o={weekday:"long",month:"long",day:"numeric"};if(d.getFullYear()!==new Date().getFullYear())o.year="numeric";return d.toLocaleDateString(undefined,o)}
function money(n){return "$"+Number(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
function pl(n,w){return n===1?w:w+"s"}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,6)}
function sorted(){return state.entries.slice().sort(function(a,b){return a.date<b.date?1:a.date>b.date?-1:0})}
function lastDone(task){var l=null;state.entries.forEach(function(e){if(e.task===task&&e.kind!=="expense"&&(!l||e.date>l))l=e.date});return l}
var toastTimer=null;
function setStatus(t){
  statusText="";var el=document.getElementById("toast");
  if(!el){el=document.createElement("div");el.id="toast";el.setAttribute("role","status");el.setAttribute("aria-live","polite");document.body.appendChild(el)}
  clearTimeout(toastTimer);el.textContent=t||"";el.classList.toggle("show",!!t);
  if(t)toastTimer=setTimeout(function(){el.classList.remove("show")},2600);
}
function persist(){
  state.updatedAt=Date.now();
  try{localStorage.setItem(LS,JSON.stringify(state))}catch(e){setStatus("Couldn\u2019t save. Your phone may be out of storage.")}
  render();
  scheduleNotifications();
  if(ONB&&document.getElementById("onb"))openOnboarding(ONB);
}

/* ---------- photos (stored on this device) ---------- */
var dbP=null;
function idb(){
  if(!dbP)dbP=new Promise(function(res,rej){
    var r=indexedDB.open("lawnlog",1);
    r.onupgradeneeded=function(){r.result.createObjectStore("photos")};
    r.onsuccess=function(){res(r.result)};r.onerror=function(){rej(r.error)};
  });
  return dbP;
}
function photoTx(mode,fn){return idb().then(function(db){return new Promise(function(res,rej){var tx=db.transaction("photos",mode),st=tx.objectStore("photos"),out=fn(st);tx.oncomplete=function(){res(out&&out.result)};tx.onerror=function(){rej(tx.error)}})})}
function photoPut(id,blob){return photoTx("readwrite",function(st){st.put(blob,id)})}
function photoGet(id){return photoTx("readonly",function(st){return st.get(id)})}
function photoDel(id){if(urlCache[id]){URL.revokeObjectURL(urlCache[id]);delete urlCache[id]}return photoTx("readwrite",function(st){st.delete(id)}).catch(function(){})}
var urlCache={};
function photoShared(id,exceptId){return state.entries.some(function(e){return e.id!==exceptId&&(e.photos||[]).indexOf(id)>=0})||(state.soilTests||[]).some(function(t){return t.id!==exceptId&&(t.photos||[]).indexOf(id)>=0})}
function dropPhoto(id,exceptId){if(!photoShared(id,exceptId))photoDel(id)}
function photoURL(id){
  if(urlCache[id])return Promise.resolve(urlCache[id]);
  return photoGet(id).then(function(b){if(!b)return "";urlCache[id]=URL.createObjectURL(b);return urlCache[id]}).catch(function(){return ""});
}
function hydrate(){document.querySelectorAll("img[data-pid]:not([src])").forEach(function(img){photoURL(img.dataset.pid).then(function(u){if(u)img.src=u})})}
function pimg(id,cls,alt){return '<img data-pid="'+esc(id)+'"'+(cls?' class="'+cls+'"':'')+' alt="'+esc(alt||"")+'">'}

/* ---------- weather (U.S. National Weather Service, free open data) ---------- */
var LS_WX="turfdiary-wx",wx=null,wxLoading=false,wxErr="";
try{wx=JSON.parse(localStorage.getItem(LS_WX)||"null")}catch(e){wx=null}
function wxKey(){return state.wxLoc?state.wxLoc.lat+","+state.wxLoc.lon:""}
function saveQuiet(){try{localStorage.setItem(LS,JSON.stringify(state))}catch(e){}}
function nwsJSON(u){
  return fetch(u,{headers:{Accept:"application/geo+json"}}).then(function(r){
    if(r.status===404)throw{code:"notfound"};
    if(!r.ok)throw{code:"http"};
    return r.json();
  });
}
function loadWx(force){
  var loc=state.wxLoc;
  if(!loc||wxLoading)return;
  if(!force&&wx&&wx.key===wxKey()&&Date.now()-wx.fetchedAt<1800000)return;
  wxLoading=true;wxErr="";refreshWxCard();
  var step=loc.forecastUrl&&loc.hourlyUrl!==undefined?Promise.resolve(loc):nwsJSON("https://api.weather.gov/points/"+loc.lat+","+loc.lon).then(function(j){
    var pr=j.properties||{};
    if(!pr.forecast)throw{code:"notfound"};
    var rl=pr.relativeLocation&&pr.relativeLocation.properties;
    loc.forecastUrl=pr.forecast;loc.hourlyUrl=pr.forecastHourly||"";loc.stationsUrl=pr.observationStations||"";loc.place=rl&&rl.city?rl.city+", "+rl.state:"Your area";saveQuiet();
    return loc;
  }).catch(function(e){throw{code:e&&e.code==="notfound"?"outside":"http"}});
  step.then(function(l){
    return nwsJSON(l.forecastUrl).catch(function(e){delete l.forecastUrl;saveQuiet();throw e});
  }).then(function(j){
    var ps=(j.properties&&j.properties.periods)||[];
    if(!ps.length)throw{code:"http"};
    wx={key:wxKey(),fetchedAt:Date.now(),periods:ps.slice(0,14).map(function(p){
      return{name:p.name,start:p.startTime||"",day:!!p.isDaytime,temp:p.temperature,unit:p.temperatureUnit||"F",pop:p.probabilityOfPrecipitation?p.probabilityOfPrecipitation.value:null,short:p.shortForecast||"",wind:p.windSpeed||""};
    })};
    try{localStorage.setItem(LS_WX,JSON.stringify(wx))}catch(e){}
    return loadNow(loc).then(function(nw){if(nw){wx.now=nw;try{localStorage.setItem(LS_WX,JSON.stringify(wx))}catch(e){}}});
  }).catch(function(e){
    wxErr=e&&e.code==="outside"?"Weather is only available for locations in the United States.":"Couldn\u2019t load the forecast right now. The weather service may be busy, so try again in a few minutes.";
  }).then(function(){wxLoading=false;refreshWxCard()});
}
function loadNow(loc){
  /* current temperature: latest reading from the nearest NWS station, or this hour's forecast if that reading is missing or old */
  function fromHourly(){
    if(!loc.hourlyUrl)return Promise.resolve(null);
    return nwsJSON(loc.hourlyUrl).then(function(j){var p=j.properties&&j.properties.periods&&j.properties.periods[0];return p?{temp:p.temperature,text:p.shortForecast||"",src:"hourly"}:null}).catch(function(){return null});
  }
  if(!loc.stationsUrl)return fromHourly();
  var st=loc.stationUrl?Promise.resolve(loc.stationUrl):nwsJSON(loc.stationsUrl).then(function(j){var f=j.features&&j.features[0];if(!f)throw{};loc.stationUrl=f.id;saveQuiet();return f.id});
  return st.then(function(u){return nwsJSON(u+"/observations/latest")}).then(function(j){
    var pr=j.properties||{},c=pr.temperature&&pr.temperature.value,ts=Date.parse(pr.timestamp||"");
    if(c==null||isNaN(ts)||Date.now()-ts>2*3600000)return fromHourly();
    return{temp:Math.round(c*9/5+32),text:pr.textDescription||"",src:"obs"};
  }).catch(fromHourly);
}
function wxNowText(){
  if(!wx||wx.key!==wxKey()||!wx.periods.length)return "";
  if(wx.now&&wx.now.temp!=null)return (wx.now.text?wx.now.text+", ":"")+wx.now.temp+"\u00b0F";
  var p=wx.periods[0];return p.short+", "+p.temp+"\u00b0"+p.unit;
}
function wxTips(ps){
  var tips=[],soon=ps.slice(0,2),rain=null;
  soon.forEach(function(p){if(p.pop!=null&&p.pop>=60&&(!rain||p.pop>rain.pop))rain=p});
  if(rain)tips.push(["Rain likely: "+rain.name+", "+rain.pop+"% chance","You can probably skip watering. Check product labels before applying: some need rain to water them in, and others need a dry day."]);
  var frost=ps.slice(0,3).filter(function(p){return !p.day&&p.unit==="F"&&p.temp<=32})[0];
  if(frost)tips.push(["Frost possible: "+frost.name,"Stay off frosted grass, and wait for it to thaw before mowing."]);
  var hot=ps.slice(0,3).filter(function(p){return p.day&&p.unit==="F"&&p.temp>=90})[0];
  if(hot)tips.push(["Hot day: "+hot.name+", "+hot.temp+"\u00b0F","Mow early or late in the day, and raise the mower height a notch."]);
  return tips;
}
var wxSel=-1;
function wxDays(periods){
  var days=[];
  periods.forEach(function(p,i){
    var last=days[days.length-1];
    if(!p.day&&last&&last.low==null&&last.high!=null){last.low=p.temp;last.night=p.short;last.nightPop=p.pop;if(p.pop!=null)last.pop=Math.max(last.pop==null?0:last.pop,p.pop);return}
    var label=i===0?(p.day?"Today":"Tonight"):p.name,full=i===0?label:p.name;
    if(i>0&&p.start){var dt=new Date(p.start.slice(0,10)+"T12:00:00");if(!isNaN(dt)){label=dt.toLocaleDateString(undefined,{weekday:"short"});full=dt.toLocaleDateString(undefined,{weekday:"long"})}}
    days.push({label:label,full:full,short:p.short,high:p.day?p.temp:null,low:p.day?null:p.temp,pop:p.pop,dayPop:p.day?p.pop:null,nightPop:p.day?null:p.pop,night:p.day?null:p.short});
  });
  return days.slice(0,7);
}
function wxBarDays(periods){return wxDays(periods).slice(1)}
function wxDayText(x){
  if(!x)return "";
  var t=x.full+": "+x.short+(x.night&&wxKind(x.night,true)!==wxKind(x.short,true)&&/rain|shower|drizzle|thunder|snow|sleet/i.test(x.night)?", then "+x.night.toLowerCase()+" at night":"")+".";
  if(x.high!=null)t+=" High "+x.high+"\u00b0";
  if(x.low!=null)t+=(x.high!=null?", low ":" Low ")+x.low+"\u00b0";
  t+=".";
  var pp=[];
  if(x.dayPop!=null)pp.push(x.dayPop+"% during the day");
  if(x.nightPop!=null)pp.push(x.nightPop+"% at night");
  if(pp.length)t+=" Chance of rain: "+pp.join(", ")+".";
  return t;
}
function wxIconText(x){var dk=wxKind(x.short,false);if((dk==="sun"||dk==="partly"||dk==="cloud")&&x.night&&x.pop!=null&&x.pop>=50&&/rain|shower|drizzle|thunder/i.test(x.night))return /thunder/i.test(x.night)?"chance thunderstorms":"chance showers";return x.short}
function wxKind(text,night){
  var t=(text||"").toLowerCase();
  if(/thunder|t-storm|tstorm/.test(t))return "storm";
  if(/snow|flurr|sleet|ice|freezing|wintry/.test(t))return "snow";
  if(/rain|shower|drizzle/.test(t))return /chance|slight|isolated|scattered|then|sunny|partly|am |pm |morning|afternoon/.test(t)?"showers":"rain";
  if(/fog|haze|smoke|mist/.test(t))return "fog";
  if(/partly|mostly sunny|mostly clear|few clouds/.test(t))return night?"partlyNight":"partly";
  if(/cloud|overcast/.test(t))return "cloud";
  if(/sunny|clear|fair/.test(t))return night?"moon":"sun";
  return night?"partlyNight":"partly";
}
function wxIcon(text,night){
  var k=wxKind(text,night),SUN="var(--sun)",RAIN="var(--rain)";
  function sun(cx,cy,r){var rays="";for(var i=0;i<8;i++){var a=i*Math.PI/4,x1=cx+Math.cos(a)*(r+3),y1=cy+Math.sin(a)*(r+3),x2=cx+Math.cos(a)*(r+7),y2=cy+Math.sin(a)*(r+7);rays+='<line x1="'+x1.toFixed(1)+'" y1="'+y1.toFixed(1)+'" x2="'+x2.toFixed(1)+'" y2="'+y2.toFixed(1)+'"/>'}
    return '<g stroke="'+SUN+'" stroke-width="2.6" stroke-linecap="round">'+rays+'</g><circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="'+SUN+'"/>'}
  function moon(cx,cy,r){return '<path d="M'+(cx+r*0.35)+' '+(cy-r)+'a'+r+' '+r+' 0 1 0 '+(r*0.75)+' '+(r*1.55)+'a'+(r*0.85)+' '+(r*0.85)+' 0 0 1 '+(-r*0.75)+' '+(-r*1.55)+'z" fill="var(--moon)"/>'}
  function cloud(tx,ty,sc){return '<g transform="translate('+tx+' '+ty+') scale('+sc+')"><path d="M14 34h21a7.5 7.5 0 0 0 1-15 10.5 10.5 0 0 0-20-2.5A8.5 8.5 0 0 0 14 34z" fill="var(--cloud)" stroke="var(--cloud-edge)" stroke-width="1.6" stroke-linejoin="round"/></g>'}
  function drops(y){return '<g stroke="'+RAIN+'" stroke-width="2.6" stroke-linecap="round"><line x1="18" y1="'+y+'" x2="16" y2="'+(y+6)+'"/><line x1="25" y1="'+y+'" x2="23" y2="'+(y+6)+'"/><line x1="32" y1="'+y+'" x2="30" y2="'+(y+6)+'"/></g>'}
  var g="";
  if(k==="sun")g=sun(24,24,8);
  else if(k==="moon")g=moon(22,24,10);
  else if(k==="partly")g=sun(17,17,6.5)+cloud(4,6,0.9);
  else if(k==="partlyNight")g=moon(16,16,7)+cloud(4,6,0.9);
  else if(k==="cloud")g=cloud(0,2,1);
  else if(k==="rain")g=cloud(0,-4,1)+drops(35);
  else if(k==="showers")g=sun(15,14,5.5)+cloud(3,-1,0.9)+drops(36);
  else if(k==="storm")g=cloud(0,-4,1)+'<path d="M25 30l-6 9h5l-3 8 9-11h-5l3-6z" fill="'+SUN+'" stroke="var(--surface)" stroke-width="1"/>';
  else if(k==="snow")g=cloud(0,-4,1)+'<g fill="'+RAIN+'"><circle cx="17" cy="37" r="2.1"/><circle cx="25" cy="41" r="2.1"/><circle cx="33" cy="37" r="2.1"/><circle cx="21" cy="44.5" r="1.8"/><circle cx="29" cy="44.5" r="1.8"/></g>';
  else if(k==="fog")g='<g stroke="var(--cloud-edge)" stroke-width="3" stroke-linecap="round"><line x1="10" y1="18" x2="38" y2="18"/><line x1="7" y1="25" x2="34" y2="25"/><line x1="12" y1="32" x2="40" y2="32"/></g>';
  return '<svg class="wx-ic" viewBox="0 0 48 48" aria-hidden="true">'+g+'</svg>';
}
function wxCardHTML(){
  var h='<section class="soil" id="wx-card" aria-labelledby="wx-h"><h2 class="soil-h" id="wx-h">Weather</h2>';
  if(!state.wxLoc){
    return h+'<p class="note" style="margin:6px 0 12px">See your local forecast with rain and frost tips. Works for locations in the United States.</p>'+
      '<button class="btn primary" data-act="wx-gps">Use My Location</button>'+(wxErr?'<p class="err" role="alert">'+esc(wxErr)+'</p>':'')+'</section>';
  }
  var d=wx&&wx.key===wxKey()?wx:null;
  if(state.wxLoc.place)h+='<p class="m" style="margin:0">'+esc(state.wxLoc.place)+'</p>';
  if(!d){
    if(wxErr)return h+'<p class="err" role="alert" style="margin-top:10px">'+esc(wxErr)+'</p><button class="btn" data-act="wx-retry">Try again</button></section>';
    return h+'<p class="m" style="margin-top:10px">Loading the forecast\u2026</p></section>';
  }
  var all=wxDays(d.periods),t0=all[0],days=all.slice(1);
  if(wxSel>=days.length)wxSel=-1;
  var isDay=t0.high!=null;
  function tp(night,v,label){return '<span class="wx-pp big'+(v!=null&&v>=20?' wet':'')+'" title="'+label+' rain chance">'+(night?'<i class="pp-moon"></i>':'<i class="pp-sun"></i>')+(v!=null?esc(v)+'%':'\u2013')+'</span>'}
  var now=d.now&&d.now.temp!=null?d.now:null;
  var bigT=now?now.temp:(isDay?t0.high:t0.low);
  var cond=now&&now.text?now.text:(isDay?t0.short:(t0.night||t0.short));
  var dateTxt=new Date().toLocaleDateString(undefined,{weekday:"long",month:"short",day:"numeric"});
  var hl=(isDay&&t0.high!=null?'<span>High <b>'+esc(t0.high)+'\u00b0</b></span>':'')+(t0.low!=null?'<span>Low <b>'+esc(t0.low)+'\u00b0</b></span>':'');
  h+='<div class="wx-today'+(wxSel<0?' sel':'')+'" data-act="wx-day" data-i="-1" role="button" tabindex="0" aria-pressed="'+(wxSel<0)+'" aria-label="Today\u2019s forecast"><div class="wx-today-head"><span class="wx-today-tag">Today</span><span class="wx-today-date">'+esc(dateTxt)+'</span></div>'+
     '<div class="wx-today-body"><div class="wx-today-main">'+
     '<div class="wx-now"><span class="wx-now-t">'+esc(bigT)+'\u00b0</span><span class="wx-now-l">'+(now?"Now":(isDay?"High":"Low"))+'<br><span>'+esc(cond)+'</span></span></div>'+
     (hl?'<div class="wx-hl">'+hl+'</div>':'')+
     '</div>'+
     '<div class="wx-today-ic">'+wxIcon(isDay?t0.short:(t0.night||t0.short),!isDay)+
     '<div class="wx-today-pops" aria-label="Chance of rain'+(isDay?', day '+(t0.dayPop==null?"unknown":t0.dayPop+"%"):'')+(t0.night?', tonight '+(t0.nightPop==null?"unknown":t0.nightPop+"%"):'')+'">'+
     (isDay?tp(false,t0.dayPop,"Day"):'')+(t0.night?tp(true,t0.nightPop,"Tonight"):'')+'</div></div></div></div>';
  h+='<div class="wx-next"><span>Next '+days.length+' days</span><span class="wx-key">Rain: <i class="sw d"></i>Day <i class="sw n"></i>Night</span></div>';
  h+='<div class="wx-strip" style="grid-template-columns:repeat('+days.length+',minmax(0,1fr))" role="group" aria-label="'+days.length+'-day forecast">'+days.map(function(x,i){
    function pp(night,v){return '<span class="wx-pp '+(night?'n':'d')+(v!=null&&v>=20?' wet':'')+'" title="'+(night?'Night':'Day')+' rain chance">'+(v!=null?esc(v)+'<small>%</small>':'\u2013')+'</span>'}
    return '<button type="button" class="wx-day'+(i===wxSel?' sel':'')+'" data-act="wx-day" data-i="'+i+'" aria-pressed="'+(i===wxSel)+'" aria-label="'+esc(wxDayText(x))+'">'+
      '<span class="wx-dname">'+esc(x.label)+'</span>'+wxIcon(wxIconText(x),x.high==null)+
      '<span class="wx-hi">'+(x.high!=null?esc(x.high)+'\u00b0':'\u2013')+'</span>'+
      '<span class="wx-lo">'+(x.low!=null?esc(x.low)+'\u00b0':'')+'</span>'+
      '<span class="wx-pps">'+pp(false,x.dayPop)+pp(true,x.nightPop)+'</span></button>';
  }).join("")+'</div>';
  h+='<p class="wx-detail" id="wx-detail" aria-live="polite">'+esc(wxDayText(wxSel<0?t0:days[wxSel]))+'</p>';
  var tips=wxTips(d.periods);
  if(tips.length)h+='<ul class="soil-tips">'+tips.map(function(t){return '<li><b>'+esc(t[0])+'</b>'+esc(t[1])+'</li>'}).join("")+'</ul>';
  h+='<p class="src">'+(wxLoading?"Updating\u2026 ":"")+'Source: U.S. National Weather Service. Updated '+esc(new Date(d.fetchedAt).toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"}))+'. Forecasts can change.</p>';
  if(wxErr)h+='<p class="err" role="alert">'+esc(wxErr)+'</p>';
  return h+'</section>';
}
function refreshWxCard(){var c=document.getElementById("wx-card");if(c)c.outerHTML=wxCardHTML();var s=document.getElementById("wx-settings");if(s)s.outerHTML=wxSettingsHTML()}
function wxSettingsHTML(){
  return '<div class="settings-block" id="wx-settings"><p>'+(state.wxLoc?'Showing weather for <b>'+esc(state.wxLoc.place||"your location")+'</b>.':'No location set. Weather works for locations in the United States.')+'</p>'+
    '<div class="toolbar" style="justify-content:flex-start"><button class="btn primary" data-act="wx-gps">'+(state.wxLoc?"Update My Location":"Use My Location")+'</button>'+(state.wxLoc?'<button class="btn" data-act="wx-remove">Turn Off Weather</button>':'')+'</div>'+
    (wxErr&&!state.wxLoc?'<p class="err" role="alert" style="margin-top:10px">'+esc(wxErr)+'</p>':'')+
    '<p class="src">Your location is rounded to within about a mile and sent only to the National Weather Service to get your forecast.</p></div>';
}
function wxUseGPS(){
  wxErr="";
  if(!navigator.geolocation){wxErr="This device can\u2019t share its location.";refreshWxCard();return}
  setStatus("Finding your location\u2026");
  navigator.geolocation.getCurrentPosition(function(pos){
    setStatus("");
    state.wxLoc={lat:Math.round(pos.coords.latitude*100)/100,lon:Math.round(pos.coords.longitude*100)/100};
    wx=null;persist();loadWx(true);
  },function(){
    setStatus("");wxErr="Location wasn\u2019t shared. Allow location for TurfDiary in your phone\u2019s settings, then try again.";render();if(ONB===1){onbMsg=wxErr;openOnboarding(1)}
  },{enableHighAccuracy:false,timeout:15000,maximumAge:600000});
}

/* ---------- lawn size (traced on USGS aerial imagery) and saved products ---------- */
function ensureData(){if(!state.lawn||!Array.isArray(state.lawn.areas))state.lawn={areas:[],manual:null};if(!Array.isArray(state.products))state.products=[]}
ensureData();
function lawnSqft(zone){var l=state.lawn||{};if(!zone&&l.manual>0)return l.manual;return (l.areas||[]).reduce(function(t,a){return t+(!zone||a.name===zone?(a.sqft||0):0)},0)}
function zones(){var l=state.lawn||{},out=[];if(l.manual>0)return out;(l.areas||[]).forEach(function(a){if(out.indexOf(a.name)<0)out.push(a.name)});return out}
var sheetAreas=[];
function titleCase(t){return String(t||"").split(" ").map(function(w,i){return (w==="a"||w==="an")&&i>0?w:w.charAt(0).toUpperCase()+w.slice(1)}).join(" ")}
function selAreas(){var zs=zones();return sheetAreas.filter(function(z){return zs.indexOf(z)>=0})}
function areaSqft(){var a=selAreas();return a.length?a.reduce(function(t,z){return t+lawnSqft(z)},0):lawnSqft()}
function areaLabel(list){list=list.map(titleCase);return list.length<3?list.join(" and "):list.slice(0,-1).join(", ")+" and "+list[list.length-1]}
function amtShort(p,sq){if(!hasRate(p)||!(sq>0))return "";if(p.mode==="cover"){var b=sq/p.cover;return fmtAmt(b)+" "+pkgWord(p,b)}var a=p.rate*sq/1000;return fmtAmt(a)+" "+p.unit}
function fmtInt(n){return Math.round(n).toLocaleString()}
function fmtAmt(n){return n>=100?fmtInt(n):(Math.round(n*10)/10).toLocaleString()}
function pkgWord(p,n){var liquid=/fl oz|gal|qt|ml/.test(pkgU(p)||"");return liquid?(n===1?"container":"containers"):(n===1?"bag":"bags")}
function hasRate(p){return p.mode==="cover"?p.cover>0:p.rate>0}
function prodSummary(p,noSize){
  var t=!hasRate(p)?"No application rate saved":p.mode==="cover"?"1 "+pkgWord(p,1)+" covers "+fmtInt(p.cover)+" sq ft":(Math.round(p.rate*100)/100).toLocaleString()+" "+p.unit+" per 1,000 sq ft";
  if(p.pkgSize&&!noSize)t+=", "+fmtAmt(p.pkgSize)+" "+pkgU(p)+" "+pkgWord(p,1);
  if(p.price!=null)t+=", "+money(p.price)+" a "+pkgWord(p,1);
  return t;
}
/* unit conversion: liquids to ml, weights to oz */
var UNIT_BASE={"ml":["v",1],"fl oz":["v",29.5735],"qt":["v",946.353],"gal":["v",3785.41],"oz":["w",1],"lb":["w",16]};
function pkgU(p){return p.pkgUnit||p.unit}
function convertible(a,b){return UNIT_BASE[a]&&UNIT_BASE[b]&&UNIT_BASE[a][0]===UNIT_BASE[b][0]}
function toUnit(x,from,to){if(from===to)return x;if(!convertible(from,to))return null;return x*UNIT_BASE[from][1]/UNIT_BASE[to][1]}
function pkgsNeeded(p,sq){if(!(p.rate>0&&p.pkgSize>0))return null;var amt=toUnit(p.rate*sq/1000,p.unit,pkgU(p));return amt==null?null:amt/p.pkgSize}
function prodCostUsed(p,sq){
  if(p.price==null||!(sq>0))return null;
  if(p.mode==="cover"&&p.cover>0)return Math.round(sq/p.cover*p.price*100)/100;
  var n=pkgsNeeded(p,sq);if(n!=null)return Math.round(n*p.price*100)/100;
  return null;
}
function costButtons(p,target){
  if(!p||p.price==null)return "";
  var used=prodCostUsed(p,areaSqft()),h='<span class="cost-btns">Cost: ';
  if(used!=null)h+='<button type="button" class="chip small" data-act="use-cost" data-v="'+used+'" data-t="'+esc(target)+'">'+money(used)+' used on your lawn</button>';
  h+='<button type="button" class="chip small" data-act="use-cost" data-v="'+p.price+'" data-t="'+esc(target)+'">'+money(p.price)+' whole '+pkgWord(p,1)+'</button></span>';
  return h;
}
var CALC_NOTE="Estimate based on the label rate you entered. Always follow the product label.";
function prodCalc(p,sq){
  if(!p)return "";
  if(!hasRate(p))return "Add this product\u2019s application rate to see how much you need"+(p.spreader?". Spreader setting: "+p.spreader:"")+".";
  if(!(sq>0))return "Measure your lawn in Settings to see how much you need.";
  var t="Suggested per application for your "+fmtInt(sq)+" sq ft: about ";
  function pk(n){return n<1?fmtAmt(n)+" of a "+pkgWord(p,1):fmtAmt(n)+" "+pkgWord(p,n)}
  if(p.mode==="cover"&&p.cover>0){
    var b=sq/p.cover;t+=pk(b);
    if(p.pkgSize)t+=" ("+fmtAmt(b*p.pkgSize)+" "+pkgU(p)+")";
  }else if(p.rate>0){
    var amt=p.rate*sq/1000;t+=fmtAmt(amt)+" "+p.unit;
    var big=p.unit==="fl oz"&&amt>=64?toUnit(amt,"fl oz","gal"):p.unit==="ml"&&amt>=2000?toUnit(amt,"ml","gal"):p.unit==="oz"&&amt>=32?toUnit(amt,"oz","lb"):null;
    if(big!=null)t+=" (about "+fmtAmt(big)+" "+(p.unit==="oz"?"lb":"gal")+")";
    var n=pkgsNeeded(p,sq);if(n!=null)t+=", "+pk(n);
  }else return "";
  if(p.spreader)t+=". Spreader setting: "+p.spreader;
  return t+".";
}
function findProduct(name){name=(name||"").trim().toLowerCase();if(!name)return null;return state.products.find(function(p){return p.name.trim().toLowerCase()===name})||null}
function calcHTML(name,target){
  var n=(name||"").trim();if(!n)return "";
  var p=findProduct(n);
  if(p)return '<span class="calc-ok">'+esc(prodCalc(p,areaSqft()).replace("application for your ",selAreas().length?"application for your "+areaLabel(selAreas())+", ":"application for your "))+'</span><span class="calc-note">'+CALC_NOTE+'</span> <button type="button" class="link small" data-act="prod-edit" data-id="'+esc(p.id)+'">Edit product</button>'+costButtons(p,target||"f");
  return '<button type="button" class="link small" data-act="prod-new" data-name="'+esc(n)+'" data-cat="'+esc(TASK_CAT[target&&target!=="f"?target:sheetTask]||"")+'">Save this product\u2019s rate</button> <span class="m">to calculate how much you need.</span>';
}
function updateCalc(input){
  var box=input.id==="f-product"?document.getElementById("prod-calc"):input.parentNode.querySelector(".mt-calc");
  if(box)box.innerHTML=calcHTML(input.value,input.id==="f-product"?"f":input.dataset.mt);
}
function refreshAllCalcs(){var f=document.getElementById("f-product");if(f)updateCalc(f);document.querySelectorAll('[data-mt][data-f="p"]').forEach(updateCalc)}

/* product editor (opens above other sheets) */
var prodEditId=null,prodMode="cover";
function sheet2(){var d=document.getElementById("sheet2");if(!d){d=document.createElement("div");d.id="sheet2";document.body.appendChild(d)}return d}
function closeSheet2(){sheet2().innerHTML="";fillAfterSave=false}
var upcPrefill="",catPrefill="",skipRate=false;
function prodActionsHTML(existing){return (existing?'<button class="btn ghost" data-act="prod-del" style="margin-right:auto">Delete</button>':'')+'<button class="btn ghost" data-act="prod-close">Cancel</button><button class="btn primary" data-act="prod-save">Save product</button>'}
function openProduct(id,name,upc,cat,tpl,msg){
  upcPrefill=upc||"";catPrefill=cat||(sheetTask&&(TASK_CAT[sheetTask]||(CATS.indexOf(sheetTask)>=0?sheetTask:"")))||"";
  var p=id?state.products.find(function(x){return x.id===id}):null;
  var src=p||tpl||null;
  prodEditId=p?p.id:null;prodMode=src&&src.mode?src.mode:"rate";
  var unitSel=function(v){return ["lb","oz","fl oz","ml","gal"].map(function(u){return '<option'+(u===(v||"lb")?' selected':'')+'>'+u+'</option>'}).join("")};
  sheet2().innerHTML='<div class="scrim" data-act="prod-close"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="p-title"><h2 id="p-title">'+(p?"Edit Product":"Save a Product")+'</h2>'+(msg?'<p class="p-banner">'+esc(msg)+'</p>':'')+
    '<label class="field">Category<select id="p-cat">'+CATS.map(function(c){return '<option'+(c===(src?prodCat(src):(catPrefill||"Fertilizer"))?' selected':'')+' value="'+c+'">'+titleCase(c)+'</option>'}).join("")+'</select></label>'+
    '<label class="field">Product name<input type="text" id="p-name" maxlength="80" autocapitalize="words" data-act="cap-words" value="'+esc(src?src.name:(name||""))+'" placeholder="e.g. LESCO Dimension 19-0-7"></label>'+
    '<fieldset><legend>How does the label list it?</legend><div class="chips"><button type="button" class="chip" data-act="prod-mode" data-mode="rate" aria-pressed="'+(prodMode==="rate")+'">Amount per 1,000 sq ft</button><button type="button" class="chip" data-act="prod-mode" data-mode="cover" aria-pressed="'+(prodMode==="cover")+'">One bag covers an area</button></div></fieldset>'+
    '<div id="p-rate"'+(prodMode==="rate"?'':' hidden')+'><label class="field">Apply this much per 1,000 sq ft<div class="unit-row"><input type="number" id="p-rate-n" inputmode="decimal" step="0.01" min="0" value="'+esc(src&&src.rate||"")+'" placeholder="e.g. 3.85"><select id="p-unit" aria-label="Unit">'+unitSel(src&&src.unit)+'</select></div></label></div>'+
    '<div id="p-cover"'+(prodMode==="cover"?'':' hidden')+'><label class="field">One bag or container covers (sq ft)<input type="number" id="p-cover-n" inputmode="numeric" min="1" value="'+esc(src&&src.cover||"")+'" placeholder="e.g. 5000"></label></div>'+
    '<label class="field">Bag or container size<div class="unit-row"><input type="number" id="p-pkg" inputmode="decimal" step="0.01" min="0" value="'+esc(src&&src.pkgSize||"")+'" placeholder="e.g. 50"><select id="p-unit2" aria-label="Unit">'+unitSel(src&&pkgU(src))+'</select></div></label>'+
    '<label class="field">Price per bag or container<div class="unit-row"><span class="dollar">$</span><input type="number" id="p-price" inputmode="decimal" step="0.01" min="0" value="'+esc(src&&src.price!=null?src.price:"")+'" placeholder="e.g. 57.94"></div></label>'+
    '<label class="field">Barcode (UPC)<div class="unit-row"><input type="text" id="p-upc" inputmode="numeric" maxlength="24" value="'+esc(src&&src.upc||upcPrefill||"")+'" placeholder="Scan or type the number under the barcode"><button type="button" class="btn small" data-act="scan-into-product">Scan</button></div></label>'+
    '<div id="p-spread-wrap"><label class="field">Spreader setting<input type="text" id="p-spread" maxlength="40" value="'+esc(src&&src.spreader||"")+'" placeholder="e.g. 3.5 on my rotary spreader"></label></div>'+
    '<p class="err" id="p-err" role="alert"></p><div class="actions" id="p-actions">'+prodActionsHTML(!!p)+'</div></div>';
  syncSpreader();
  var f=document.getElementById("p-name");if(f&&!f.value)f.focus();
}
function capWords(v){return v.replace(/(^|\s)(\S)/g,function(m,sp,ch){return sp+ch.toUpperCase()})}
function isLiquidUnit(u){return /fl oz|ml|gal|qt/.test(u||"")}
function syncSpreader(){var w=document.getElementById("p-spread-wrap");if(!w)return;var u=(prodMode==="rate"?document.getElementById("p-unit"):document.getElementById("p-unit2"));w.hidden=!!(u&&isLiquidUnit(u.value))}
function saveProduct(){
  var err=document.getElementById("p-err"),name=capWords(document.getElementById("p-name").value.trim());
  if(!name){err.textContent="Give the product a name.";return}
  var pkgUnit=document.getElementById("p-unit2").value,unit=prodMode==="rate"?document.getElementById("p-unit").value:pkgUnit;
  var rec={name:name.slice(0,80),mode:prodMode,unit:unit,spreader:isLiquidUnit(unit)?"":document.getElementById("p-spread").value.trim().slice(0,40)};
  var pkg=parseFloat(document.getElementById("p-pkg").value);rec.pkgSize=pkg>0?pkg:null;
  var rawRate=(prodMode==="cover"?document.getElementById("p-cover-n"):document.getElementById("p-rate-n")).value.trim(),num=parseFloat(rawRate);
  if(rawRate&&!(num>0)){err.textContent=prodMode==="cover"?"Enter how many square feet one bag covers, like 5000.":"Enter the amount per 1,000 sq ft, like 3.85.";return}
  if(!rawRate&&!skipRate){
    err.textContent="";
    document.getElementById("p-actions").innerHTML='<div class="no-rate"><b>Save without an application rate?</b><span>TurfDiary uses the rate to work out how much product your lawn needs and what each application costs. You can add it later by editing the product.</span></div>'+
      '<button class="btn ghost" data-act="prod-add-rate">Add the rate</button><button class="btn primary" data-act="prod-save-norate">Save without it</button>';
    var pa=document.getElementById("p-actions");pa.scrollIntoView({block:"end",behavior:"smooth"});var sb=pa.querySelector('[data-act="prod-save-norate"]');if(sb)sb.focus({preventScroll:true});
    return;
  }
  skipRate=false;
  if(prodMode==="cover"){rec.cover=rawRate?num:null;rec.rate=null}else{rec.rate=rawRate?num:null;rec.cover=null}
  var dup=findProduct(name);if(dup&&dup.id!==prodEditId){err.textContent="You already have a product with that name.";return}
  var upc=normUpc(document.getElementById("p-upc").value);
  if(document.getElementById("p-upc").value.trim()&&!upc){err.textContent="The barcode should be 6 to 14 digits.";return}
  var du=upc?findByUpc(upc):null;if(du&&du.id!==prodEditId){err.textContent="That barcode is already saved for "+du.name+".";return}
  rec.upc=upc||null;rec.pkgUnit=pkgUnit;
  if(prodMode==="rate"&&rec.rate>0&&rec.pkgSize>0&&!convertible(unit,pkgUnit)){err.textContent="The amount is in "+unit+" but the container size is in "+pkgUnit+". One is a liquid and the other a weight, so TurfDiary can\u2019t convert between them. Check the label and pick matching kinds of units.";return}
  rec.cat=document.getElementById("p-cat").value;
  var pr=parseFloat(document.getElementById("p-price").value);
  if(document.getElementById("p-price").value.trim()&&!(pr>=0)){err.textContent="Enter the price as a number, like 57.94.";return}
  rec.price=pr>=0?Math.round(pr*100)/100:null;
  var ex=prodEditId?state.products.find(function(x){return x.id===prodEditId}):null;
  if(ex)Object.assign(ex,rec);else state.products.push(Object.assign({id:"pr_"+uid()},rec));
  if(fillAfterSave){fillAfterSave=false;var np=findProduct(rec.name);if(np&&document.getElementById("f-product")){setTimeout(function(){fillLogProduct(np)},0)}}
  if(rec.upc){if(!state.upcMemory)state.upcMemory={};var mem=Object.assign({},rec);delete mem.id;mem.savedOn=todayISO();state.upcMemory[normUpc(rec.upc)]=mem}
  state.updatedAt=Date.now();saveQuiet();closeSheet2();
  if(document.getElementById("f-product")||document.querySelector("[data-mt]")){refreshAllCalcs();var dl=document.getElementById("prod-list");if(dl)dl.innerHTML=productNames().map(function(n){return '<option value="'+esc(n)+'">'}).join("")}
  else render();
}
function productNames(){var out=state.products.map(function(p){return p.name});recentProducts().forEach(function(n){if(!findProduct(n))out.push(n)});return out}
function lawnHTML(){
  var l=state.lawn,sq=lawnSqft(),h='<div class="settings-block" id="lawn-block">';
  if(sq>0)h+='<p class="lawn-total">'+fmtInt(sq)+' <span>sq ft of lawn'+(l.manual>0?' (entered by hand)':'')+'</span></p>';
  else h+='<p>Trace your lawn on an aerial photo to get its size. TurfDiary then works out how much product you need.</p>';
  if(!(l.manual>0)&&l.areas.length)h+=zones().map(function(z){var idx=[];l.areas.forEach(function(a,i){if(a.name===z)idx.push(i)});return (idx.length>1?'<div class="zone-h"><b>'+esc(titleCase(z))+'</b><span>'+fmtInt(lawnSqft(z))+' sq ft total</span></div>':'')+'<div class="list" style="margin-bottom:10px">'+idx.map(function(i){var a=l.areas[i];return '<div class="item"><div class="grow"><div class="t">'+(idx.length>1?esc(titleCase(z))+' '+(idx.indexOf(i)+1):esc(titleCase(z)))+'</div><div class="m">'+fmtInt(a.sqft)+' sq ft</div></div><div class="row-acts"><button class="btn mini" data-act="lawn-rename" data-i="'+i+'">Rename</button><button class="btn mini ghost" data-act="lawn-del" data-i="'+i+'">Remove</button></div></div>'}).join("")+'</div>'}).join("");
  h+='<div class="toolbar" style="justify-content:flex-start"><button class="btn primary" data-act="lawn-map">'+(l.areas.length?"Edit On Map":"Measure On Map")+'</button><button class="btn" data-act="lawn-manual">Enter Size By Hand</button></div>';
  h+='<p class="src">Aerial imagery: USGS The National Map and USDA NAIP (public domain). Photos may be a year or two old, and trees can hide parts of the lawn, so treat the size as an estimate.</p></div>';
  return h;
}
/* ordered by how often each is typically applied in general lawn care */
var CATS=["Fertilizer","Weed control","Insecticide","Pre-emergent","Grass seed","Fungicide","Biostimulant","Lime","Other"];
/* which product categories each task shows (first one is the default for new products) */
var TASK_CATS={"Fertilize":["Fertilizer","Biostimulant","Lime"],"Weed control":["Weed control","Pre-emergent"],"Fungicide":["Fungicide"],"Insecticide":["Insecticide"],"Overseed":["Grass seed"]};
var TASK_CAT={};Object.keys(TASK_CATS).forEach(function(k){TASK_CAT[k]=TASK_CATS[k][0]});
function catLabel(task){if(sheetMode==="expense"&&EXP_CATS.indexOf(task)>=0)return task.toLowerCase();var cs=TASK_CATS[task];if(!cs)return "";var l=cs.map(function(c){return c.toLowerCase()});return l.length<3?l.join(" and "):l.slice(0,-1).join(", ")+" and "+l[l.length-1]}
function prodCat(p){return CATS.indexOf(p.cat)>=0?p.cat:"Other"}
function productsForTask(task){if(sheetMode==="expense"&&EXP_CATS.indexOf(task)>=0){var ec=task==="Other supplies"?"Other":task;return state.products.filter(function(p){return prodCat(p)===ec})}var cs=TASK_CATS[task];return cs?state.products.filter(function(p){return cs.indexOf(prodCat(p))>=0}):state.products.slice()}
function suggestNames(task){
  var out=productsForTask(task).map(function(p){return p.name});
  recentProducts(task||null).forEach(function(n){if(out.indexOf(n)<0&&(!TASK_CAT[task]||!findProduct(n)))out.push(n)});
  return out;
}
function dlOptions(task){return suggestNames(task).map(function(n){return '<option value="'+esc(n)+'">'}).join("")}
function needText(p,sq){
  if(p.mode==="cover"&&p.cover>0){var b=sq/p.cover;if(p.pkgSize)return fmtAmt(b*p.pkgSize)+" "+pkgU(p);return ""+(b<1?fmtAmt(b)+" of a "+pkgWord(p,1):fmtAmt(b)+" "+pkgWord(p,b))+(p.pkgSize?" ("+fmtAmt(b*p.pkgSize)+" "+pkgU(p)+")":"")}
  var amt=p.rate*sq/1000;return fmtAmt(amt)+" "+p.unit;
}
function needsHTML(p){
  if(!hasRate(p))return '<div class="m">No application rate saved yet.</div>';
  var zs=zones(),rows=[["Whole Yard",lawnSqft()]].concat(zs.length>1?zs.map(function(z){return[z,lawnSqft(z)]}):[]);
  return '<div class="needs"><div class="needs-h">Per application</div>'+rows.map(function(r){return '<div class="need-row"><span>'+esc(titleCase(r[0]))+'</span><b>'+esc(needText(p,r[1]))+'</b></div>'}).join("")+(p.spreader?'<div class="need-row"><span>Spreader setting</span><b>'+esc(p.spreader)+'</b></div>':'')+'</div>';
}
function productsHTML(){
  var sq=lawnSqft();
  if(!state.products.length)return '<div class="settings-block"><p>Save each product\u2019s rate once, from its label. When you log work with that product, TurfDiary shows how much you need for your lawn.</p></div>';
  var h='<div class="prod-groups">'+(sq>0?'<p class="calc-note" style="margin:0 0 10px">Amounts are suggestions based on the label rates you entered. Always follow the product label. TurfDiary is not liable for any under- or over-application of products.</p>':'<p class="note"><button class="link" data-act="tab" data-tab="settings">Measure your lawn in Settings</button> to see how much of each product you need.</p>');
  h+=CATS.filter(function(c){return state.products.some(function(p){return prodCat(p)===c})}).map(function(c){var ps=state.products.filter(function(p){return prodCat(p)===c});return '<h3 class="cat-h">'+esc(c)+' <span>('+ps.length+')</span></h3><div class="list">'+ps.map(function(p){return '<div class="item"><div class="grow"><div class="t">'+esc(p.name)+'</div><div class="m">'+esc(prodSummary(p,true))+'</div>'+'</div><div class="row-acts"><button class="btn small" data-act="prod-edit" data-id="'+esc(p.id)+'" aria-label="Edit '+esc(p.name)+'">Edit</button><button class="btn small ghost" data-act="prod-del-ask" data-id="'+esc(p.id)+'" aria-label="Delete '+esc(p.name)+'">Delete</button></div>'+(sq>0?needsHTML(p):'')+'</div>'}).join("")+'</div>'}).join("");
  return h+'</div>';
}
function openManualLawn(){
  sheet2().innerHTML='<div class="scrim" data-act="prod-close"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="ml-title"><h2 id="ml-title">Lawn size</h2>'+
    '<label class="field">Square feet of lawn<input type="number" id="ml-n" inputmode="numeric" min="0" value="'+esc(state.lawn.manual||"")+'" placeholder="e.g. 6500"></label>'+
    '<p class="note">Leave it empty to use the size you traced on the map instead.</p><div class="actions"><button class="btn ghost" data-act="prod-close">Cancel</button><button class="btn primary" data-act="ml-save">Save</button></div></div>';
  document.getElementById("ml-n").focus();
}

/* the tracing map: one aerial image per view, fetched from the USGS NAIP Plus image service */
var R_EARTH=6378137,MAP=null;
function toMerc(lat,lng){return[R_EARTH*lng*Math.PI/180,R_EARTH*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))]}
function fromMerc(x,y){return[(2*Math.atan(Math.exp(y/R_EARTH))-Math.PI/2)*180/Math.PI,x/R_EARTH*180/Math.PI]}
function usgsImage(b,w,h){return "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage?bbox="+b.join(",")+"&bboxSR=3857&imageSR=3857&size="+w+","+h+"&format=jpg&f=image"}
function polyAreaSqft(pts){
  if(pts.length<3)return 0;
  var lat0=pts.reduce(function(t,p){return t+p[0]},0)/pts.length,k=Math.cos(lat0*Math.PI/180),a=0,m=pts.map(function(p){return toMerc(p[0],p[1])});
  for(var i=0;i<m.length;i++){var j=(i+1)%m.length;a+=m[i][0]*m[j][1]-m[j][0]*m[i][1]}
  return Math.abs(a)/2*k*k*10.7639;
}
function openMap(){
  var el=document.createElement("div");el.id="mapview";el.setAttribute("role","dialog");el.setAttribute("aria-label","Measure your lawn");
  el.innerHTML='<div class="map-top"><button class="btn small" data-act="map-close">Cancel</button><div class="map-read" id="map-read" aria-live="polite">Finding your location\u2026</div><button class="btn small primary" data-act="map-save">Save</button></div>'+
    '<div class="map-box" id="map-box"><div class="map-imgs" id="map-imgs"></div><svg class="map-svg" id="map-svg"></svg>'+
    '<div class="map-zoom"><button class="btn small" data-act="map-zin" aria-label="Zoom in">+</button><button class="btn small" data-act="map-zout" aria-label="Zoom out">\u2212</button><button class="btn small" data-act="map-me" aria-label="Center on my location">\u25CE</button></div>'+
    '<div class="map-mode" role="group" aria-label="Map mode"><button class="mm" data-act="map-mode" data-mode="move" aria-pressed="true">\u270B Move map</button><button class="mm" data-act="map-mode" data-mode="draw" aria-pressed="false">\u270F\uFE0F Outline grass</button></div>'+
    '<div class="map-hint" id="map-hint"></div></div>'+
    '<div class="map-name" id="map-name" hidden></div>'+
    '<div class="map-sections" id="map-sections"></div>'+
    '<div class="map-bottom"><button class="btn small" data-act="map-undo">Undo point</button><button class="btn small" data-act="map-clear">Clear</button><button class="btn small primary" data-act="map-finish">+ Add section</button></div>'+
    '<p class="map-src">Imagery: USGS The National Map / USDA NAIP</p>';
  document.body.appendChild(el);document.body.style.overflow="hidden";
  var box=document.getElementById("map-box");
  MAP={el:el,box:box,cx:0,cy:0,res:0.2,w:box.clientWidth,h:box.clientHeight,imgs:[],pts:[],done:(state.lawn.areas||[]).map(function(a){return{name:a.name,sqft:a.sqft,pts:a.pts||[]}}).filter(function(a){return a.pts.length>2}),ptrs:{},timer:null,moved:false};
  if(MAP.done.length){var a0=MAP.done[0].pts,c0=a0.reduce(function(t,p){return[t[0]+p[0]/a0.length,t[1]+p[1]/a0.length]},[0,0]);setTimeout(function(){if(MAP)setMapCenter(c0[0],c0[1],0.18)},0)}
  var start=state.wxLoc?[state.wxLoc.lat,state.wxLoc.lon]:[39.5,-98.35];
  setMapCenter(start[0],start[1],state.wxLoc?1.2:400);
  MAP.mode="move";MAP.trace=null;
  if(!MAP.done.length)mapLocate(true);else mapRead();
  bindMap(box);setHint();
  if(!state.mapIntroSeen)showMapIntro();
  window.addEventListener("resize",mapResize);
}
function setMapCenter(lat,lng,res){var m=toMerc(lat,lng);MAP.cx=m[0];MAP.cy=m[1];if(res)MAP.res=res;mapDraw();mapLoad()}
function mapLocate(quiet){
  if(!navigator.geolocation){mapRead();return}
  navigator.geolocation.getCurrentPosition(function(p){if(MAP){setMapCenter(p.coords.latitude,p.coords.longitude,0.18);mapRead()}},function(){if(MAP){if(!quiet)document.getElementById("map-hint").textContent="Location wasn\u2019t shared. Drag the map to your yard.";mapRead()}},{enableHighAccuracy:true,timeout:15000,maximumAge:60000});
}
function mapResize(){if(!MAP)return;MAP.w=MAP.box.clientWidth;MAP.h=MAP.box.clientHeight;mapDraw();mapLoad()}
function scr(x,y){return[(x-MAP.cx)/MAP.res+MAP.w/2,(MAP.cy-y)/MAP.res+MAP.h/2]}
function unscr(px,py){return[MAP.cx+(px-MAP.w/2)*MAP.res,MAP.cy-(py-MAP.h/2)*MAP.res]}
function mapLoad(){
  clearTimeout(MAP.timer);
  MAP.timer=setTimeout(function(){
    if(!MAP)return;
    var w=MAP.w,h=MAP.h,dpr=Math.min(window.devicePixelRatio||1,2),k=Math.min(dpr,1400/Math.max(w,h));
    var b=[MAP.cx-w/2*MAP.res,MAP.cy-h/2*MAP.res,MAP.cx+w/2*MAP.res,MAP.cy+h/2*MAP.res];
    var img=new Image();img.alt="";img.className="map-img";img.draggable=false;
    img.onload=function(){if(!MAP)return;MAP.imgs.push({img:img,b:b});document.getElementById("map-imgs").appendChild(img);while(MAP.imgs.length>3){var o=MAP.imgs.shift();o.img.remove()}mapDraw()};
    img.onerror=function(){var hint=document.getElementById("map-hint");if(hint)hint.textContent="Couldn\u2019t load the aerial photo. Check your connection, or enter your lawn size by hand."};
    var W=Math.round(w*k),H=Math.round(h*k);
    img.src=window.__TD_IMAGERY?window.__TD_IMAGERY(b,W,H):usgsImage(b,W,H);
  },250);
}
function mapDraw(){
  if(!MAP)return;
  MAP.imgs.forEach(function(o){var a=scr(o.b[0],o.b[3]),c=scr(o.b[2],o.b[1]);var s=o.img.style;s.left=a[0]+"px";s.top=a[1]+"px";s.width=(c[0]-a[0])+"px";s.height=(c[1]-a[1])+"px"});
  function path(pts,close){return pts.map(function(p,i){var m=toMerc(p[0],p[1]),q=scr(m[0],m[1]);return (i?"L":"M")+q[0].toFixed(1)+" "+q[1].toFixed(1)}).join("")+(close?"Z":"")}
  var svg="";
  MAP.done.forEach(function(a){svg+='<path d="'+path(a.pts,true)+'" class="poly-done"/>';var c=a.pts.reduce(function(t,p){return[t[0]+p[0]/a.pts.length,t[1]+p[1]/a.pts.length]},[0,0]),m=toMerc(c[0],c[1]),q=scr(m[0],m[1]);svg+='<text x="'+q[0]+'" y="'+q[1]+'" class="poly-label">'+esc(fmtInt(a.sqft))+'</text>'});
  if(MAP.pts.length){svg+='<path d="'+path(MAP.pts,MAP.pts.length>2)+'" class="poly-cur"/>';MAP.pts.forEach(function(p){var m=toMerc(p[0],p[1]),q=scr(m[0],m[1]);svg+='<circle cx="'+q[0]+'" cy="'+q[1]+'" r="6" class="poly-pt"/>'})}
  document.getElementById("map-svg").innerHTML=svg;
}
function mapRead(){
  var cur=MAP.pts.length>2?polyAreaSqft(MAP.pts):0,tot=MAP.done.reduce(function(t,a){return t+a.sqft},0);
  document.getElementById("map-read").innerHTML='Total <b>'+fmtInt(tot+cur)+'</b> sq ft<br><span>'+(MAP.pts.length>2?'This section: '+fmtInt(cur)+' sq ft':MAP.pts.length?'Keep outlining\u2026':'No section in progress')+'</span>';
  document.getElementById("map-sections").innerHTML=MAP.done.map(function(a,i){return '<span class="sec-chip">'+esc(a.name)+': '+fmtInt(a.sqft)+' sq ft<button type="button" data-act="map-secdel" data-i="'+i+'" aria-label="Remove '+esc(a.name)+'">\u00d7</button></span>'}).join("")+(function(){var zs=[];MAP.done.forEach(function(a){var z=zs.find(function(x){return x.n===a.name});if(z)z.s+=a.sqft;else zs.push({n:a.name,s:a.sqft})});return zs.length>1?'<span class="sec-sum">'+zs.map(function(z){return esc(z.n)+' '+fmtInt(z.s)}).join(" + ")+' = '+fmtInt(tot)+' sq ft</span>':''})();
}
function bindMap(box){
  box.addEventListener("pointerdown",function(e){if(e.target.closest("button"))return;box.setPointerCapture(e.pointerId);MAP.ptrs[e.pointerId]={x:e.clientX,y:e.clientY,sx:e.clientX,sy:e.clientY};MAP.moved=Object.keys(MAP.ptrs).length>1});
  box.addEventListener("pointermove",function(e){
    var p=MAP.ptrs[e.pointerId];if(!p)return;
    var ids=Object.keys(MAP.ptrs);
    if(ids.length===1){
      var dx=e.clientX-p.x,dy=e.clientY-p.y;if(Math.abs(e.clientX-p.sx)+Math.abs(e.clientY-p.sy)>8)MAP.moved=true;
      if(MAP.moved&&MAP.mode==="move"){MAP.cx-=dx*MAP.res;MAP.cy+=dy*MAP.res;mapDraw()}
      else if(MAP.moved&&MAP.mode==="draw"&&!MAP.multi){
        var r=box.getBoundingClientRect(),px=e.clientX-r.left,py=e.clientY-r.top;
        if(!MAP.trace){MAP.trace={x:p.sx-r.left,y:p.sy-r.top};var m0=unscr(MAP.trace.x,MAP.trace.y);MAP.pts.push(fromMerc(m0[0],m0[1]))}
        if(Math.hypot(px-MAP.trace.x,py-MAP.trace.y)>=14){var m1=unscr(px,py);MAP.pts.push(fromMerc(m1[0],m1[1]));MAP.trace={x:px,y:py};mapDraw();mapRead()}
      }
    }
    else if(ids.length===2){MAP.multi=true;var o=MAP.ptrs[ids[0]===String(e.pointerId)?ids[1]:ids[0]];var d0=Math.hypot(p.x-o.x,p.y-o.y),d1=Math.hypot(e.clientX-o.x,e.clientY-o.y);if(d0>0&&d1>0){MAP.res=Math.min(400,Math.max(0.05,MAP.res*d0/d1))}MAP.cx-=(e.clientX-p.x)/2*MAP.res;MAP.cy+=(e.clientY-p.y)/2*MAP.res;mapDraw()}
    p.x=e.clientX;p.y=e.clientY;
  });
  function up(e){
    var p=MAP&&MAP.ptrs[e.pointerId];if(!p)return;
    delete MAP.ptrs[e.pointerId];
    if(!MAP.moved&&!MAP.multi&&e.type==="pointerup"){
      if(MAP.mode==="draw"){var r=box.getBoundingClientRect(),m=unscr(e.clientX-r.left,e.clientY-r.top);MAP.pts.push(fromMerc(m[0],m[1]));mapDraw();mapRead();setHint()}
      else setHint("You\u2019re in Move map mode. Tap \u201cOutline grass\u201d to start outlining.");
    }
    if(MAP.trace){MAP.trace=null;setHint()}
    if(!Object.keys(MAP.ptrs).length){MAP.multi=false;mapLoad()}
  }
  box.addEventListener("pointerup",up);box.addEventListener("pointercancel",up);
  box.addEventListener("wheel",function(e){e.preventDefault();MAP.res=Math.min(400,Math.max(0.05,MAP.res*(e.deltaY>0?1.25:0.8)));mapDraw();mapLoad()},{passive:false});
}
function setHint(msg){
  var h=document.getElementById("map-hint");if(!h||!MAP)return;
  if(msg){h.textContent=msg;return}
  if(MAP.mode==="move")h.textContent=MAP.pts.length?"Map mode: drag to move, pinch to zoom. Tap Outline grass to keep outlining.":"Drag to move the map and pinch to zoom until your yard fills the screen. Then tap \u201cOutline grass.\u201d";
  else h.textContent=MAP.pts.length<3?"Trace along the edge of the grass with your finger, or tap each corner. Use two fingers to move the map.":"Keep going around the edge. When the shape is closed, tap \u201cAdd section.\u201d";
}
function setMapMode(m){MAP.mode=m;document.querySelectorAll(".mm").forEach(function(b){b.setAttribute("aria-pressed",String(b.dataset.mode===m))});MAP.box.classList.toggle("drawing",m==="draw");setHint()}
function showMapIntro(){
  var d=document.createElement("div");d.className="map-intro";d.id="map-intro";
  d.innerHTML='<div class="mi-card"><h2>How to measure your lawn</h2><ol>'+
    '<li><b>Find your yard.</b> In <b>Move map</b> mode, drag with one finger and pinch to zoom until your yard fills the screen.</li>'+
    '<li><b>Outline the grass.</b> Tap <b>Outline grass</b>, then trace around the edge of the lawn with your finger, or tap each corner. Leave out the house, driveway and beds.</li>'+
    '<li><b>Add the section.</b> Tap <b>Add section</b> and name it, like Front yard or Back yard.</li>'+
    '<li><b>Repeat</b> for each separate part of your yard, then tap <b>Save</b>.</li></ol>'+
    '<button class="btn primary" data-act="map-intro-ok" style="width:100%">Got it</button></div>';
  MAP.el.appendChild(d);
}
function showNameBar(){
  var n=document.getElementById("map-name"),last=MAP.lastName||"";
  var opts=["Front Yard","Back Yard","Side Yard"];zones().concat(MAP.done.map(function(a){return a.name})).forEach(function(z){if(opts.indexOf(z)<0)opts.push(z)});
  n.hidden=false;
  n.innerHTML='<b>Which part of your yard is this?</b><div class="chips">'+opts.map(function(o){return '<button type="button" class="chip'+(o===last?' sel':'')+'" data-act="map-name" data-name="'+esc(o)+'">'+esc(o)+'</button>'}).join("")+'</div>'+
    '<div class="unit-row"><input type="text" id="map-name-in" maxlength="30" placeholder="Or type a name, like Side strip" autocapitalize="words"><button class="btn small primary" data-act="map-name-custom">Use</button></div>'+
    '<p class="m" style="margin:6px 0 0">Sections with the same name are added together, like two parts of the front yard.</p>';
}
function nameSection(name){
  name=(name||"").trim().slice(0,30);if(!name)return;
  MAP.done.push({name:name,sqft:Math.round(polyAreaSqft(MAP.pending)),pts:MAP.pending.map(function(p){return[+p[0].toFixed(6),+p[1].toFixed(6)]})});
  MAP.lastName=name;MAP.pending=null;MAP.pts=[];document.getElementById("map-name").hidden=true;mapDraw();mapRead();
  setHint("Added to "+name+". Outline another part of your yard, or tap Save when you\u2019re done.");
}
function mapFinish(){
  if(MAP.pts.length<3){setHint(MAP.mode==="move"?"Tap \u201cOutline grass\u201d first, then trace around the edge of the lawn.":"Outline at least three corners of the grass first.");return}
  MAP.pending=MAP.pts.slice();showNameBar();
}
function closeMap(){if(!MAP)return;window.removeEventListener("resize",mapResize);MAP.el.remove();MAP=null;document.body.style.overflow=""}
function mapSave(){
  if(MAP.pending){nameSection(MAP.lastName||"Front yard")}
  else if(MAP.pts.length>2){MAP.pending=MAP.pts.slice();nameSection(MAP.lastName||(MAP.done.length?"Back yard":"Front yard"))}
  if(!MAP.done.length&&!state.lawn.areas.length){document.getElementById("map-hint").textContent="Outline at least one section first, then tap Save.";return}
  state.lawn.areas=MAP.done;state.lawn.manual=null;closeMap();persist();
}

/* ---------- barcode scanning (camera stays on the phone; nothing is uploaded) ---------- */
function normUpc(v){var d=String(v||"").replace(/\D/g,"");if(d.length<6||d.length>14)return "";if(d.length===13&&d[0]==="0")d=d.slice(1);return d}
function findByUpc(code){code=normUpc(code);if(!code)return null;return state.products.find(function(p){return p.upc&&normUpc(p.upc)===code})||null}
var SCAN=null;
function loadZXing(){
  if(window.ZXing)return Promise.resolve();
  return new Promise(function(ok,bad){var sc=document.createElement("script");sc.src="https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";sc.onload=ok;sc.onerror=bad;document.head.appendChild(sc)});
}
function openScanner(onCode){
  closeScanner();
  var el=document.createElement("div");el.id="scanview";el.setAttribute("role","dialog");el.setAttribute("aria-label","Scan a barcode");
  el.innerHTML='<div class="map-top"><button class="btn small" data-act="scan-close">Cancel</button><div class="map-read">Scan a barcode</div><span style="width:72px"></span></div>'+
    '<div class="scan-box"><video id="scan-video" playsinline muted></video><div class="scan-frame"></div><div class="map-hint" id="scan-hint">Starting the camera\u2026</div></div>'+
    '<div class="scan-manual"><label class="field" style="margin:0">Or type the number under the barcode<div class="unit-row"><input type="text" id="scan-num" inputmode="numeric" maxlength="24" placeholder="e.g. 032247278557"><button class="btn primary small" data-act="scan-typed">Look up</button></div></label></div>';
  document.body.appendChild(el);document.body.style.overflow="hidden";
  SCAN={el:el,onCode:onCode,stream:null,timer:null,reader:null,done:false};
  var video=document.getElementById("scan-video"),hint=document.getElementById("scan-hint");
  function found(code){if(!SCAN||SCAN.done)return;SCAN.done=true;if(navigator.vibrate)navigator.vibrate(60);var cb=SCAN.onCode;closeScanner();cb(code)}
  function noCam(){hint.textContent="The camera isn\u2019t available here. Type the number under the barcode instead.";var n=document.getElementById("scan-num");if(n)n.focus()}
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){noCam();return}
  if("BarcodeDetector" in window){
    navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false}).then(function(st){
      if(!SCAN){st.getTracks().forEach(function(t){t.stop()});return}
      SCAN.stream=st;video.srcObject=st;video.play();hint.textContent="Point the camera at the barcode.";
      var det=new window.BarcodeDetector({formats:["upc_a","upc_e","ean_13","ean_8"]});
      (function loop(){if(!SCAN||SCAN.done)return;det.detect(video).then(function(c){if(c&&c.length)found(c[0].rawValue);else SCAN.timer=setTimeout(loop,180)}).catch(function(){SCAN.timer=setTimeout(loop,400)})})();
    }).catch(noCam);
  }else{
    loadZXing().then(function(){
      if(!SCAN)return;
      var r=new window.ZXing.BrowserMultiFormatReader();SCAN.reader=r;hint.textContent="Point the camera at the barcode.";
      return r.decodeFromConstraints({video:{facingMode:{ideal:"environment"}}},video,function(res){if(res)found(res.getText())});
    }).catch(noCam);
  }
}
function closeScanner(){
  if(!SCAN)return;
  clearTimeout(SCAN.timer);
  if(SCAN.stream)SCAN.stream.getTracks().forEach(function(t){t.stop()});
  if(SCAN.reader)try{SCAN.reader.reset()}catch(e){}
  SCAN.el.remove();SCAN=null;if(!MAP)document.body.style.overflow="";
}
function showProductCard(p){
  sheet2().innerHTML='<div class="scrim" data-act="prod-close"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="pc-title">'+
    '<p class="pc-match">\u2713 Matches your saved product</p><h2 id="pc-title">'+esc(p.name)+'</h2>'+
    '<p class="m" style="margin:0 0 10px">'+esc(prodSummary(p))+'</p>'+
    '<div class="pc-need">'+esc(prodCalc(p,lawnSqft()))+(p.price!=null?'<div class="pc-cost">'+(prodCostUsed(p,lawnSqft())!=null?'Cost for your lawn: '+money(prodCostUsed(p,lawnSqft()))+'. ':'')+'Price: '+money(p.price)+' a '+pkgWord(p,1)+'.</div>':'')+'<div class="calc-note">'+CALC_NOTE+'</div></div>'+
    '<div class="actions"><button class="btn ghost" data-act="prod-edit" data-id="'+esc(p.id)+'" style="margin-right:auto">Edit</button><button class="btn ghost" data-act="prod-close">Close</button><button class="btn primary" data-act="pc-log" data-name="'+esc(p.name)+'">Log Work With It</button></div></div>';
}
function showUnknownCode(code){
  sheet2().innerHTML='<div class="scrim" data-act="prod-close"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="uc-title"><h2 id="uc-title">New barcode</h2>'+
    '<p class="note">Barcode '+esc(code)+' isn\u2019t saved yet. Add the product\u2019s details from its label once, and next time a scan will show how much you need right away.</p>'+
    '<div class="actions"><button class="btn ghost" data-act="prod-close">Cancel</button><button class="btn primary" data-act="uc-add" data-upc="'+esc(code)+'">Add this product</button></div></div>';
}

/* ---------- reminder notifications ----------
   Settings are saved now. Notifications are actually delivered by the Play Store (Capacitor) build,
   using the phone's own scheduler (@capacitor/local-notifications). Nothing is sent to a server.
   Play Store build to-do: install @capacitor/local-notifications, then this code turns on by itself
   because window.Capacitor.Plugins.LocalNotifications exists. See SETUP.md. */
function notifyCfg(){if(!state.notify)state.notify={on:false,time:"08:00",lead:"before",tasks:null};return state.notify}
function nativeNotify(){var c=window.Capacitor;return c&&c.Plugins&&c.Plugins.LocalNotifications?c.Plugins.LocalNotifications:null}
function notifyTaskOn(task){var n=notifyCfg();return !n.tasks||n.tasks.indexOf(task)>=0}
function upcomingNotifications(){
  var n=notifyCfg(),out=[];if(!n.on)return out;
  var hm=(n.time||"08:00").split(":"),now=Date.now();
  state.schedules.forEach(function(s,i){
    if(!notifyTaskOn(s.task))return;
    var last=lastDone(s.task),base=dueBase(s);if(!base)return;
    var due=addDays(base,Math.max(1,+s.every||7)),fire=n.lead==="before"?addDays(due,-1):due;
    var d=parse(fire);d.setHours(+hm[0]||8,+hm[1]||0,0,0);
    if(d.getTime()<=now)return;
    var lp=lastProduct(s.task);
    out.push({id:1000+i,at:d,title:"TurfDiary: "+s.task+(n.lead==="before"?" is due tomorrow":" is due today"),
      body:(last?"Last done "+fmt(last)+(lp?" with "+lp:"")+". ":"")+"Every "+s.every+" "+pl(+s.every,"day")+"."});
  });
  return out;
}
var notifySig="";
function scheduleNotifications(){
  var LN=nativeNotify();if(!LN)return;
  var list=upcomingNotifications(),sig=JSON.stringify(list.map(function(x){return[x.id,+x.at,x.title]}));
  if(sig===notifySig)return;notifySig=sig;
  LN.getPending().then(function(p){var ids=(p&&p.notifications||[]).filter(function(x){return x.id>=1000&&x.id<2000}).map(function(x){return{id:x.id}});return ids.length?LN.cancel({notifications:ids}):null})
    .then(function(){if(!list.length)return;return LN.schedule({notifications:list.map(function(x){return{id:x.id,title:x.title,body:x.body,schedule:{at:x.at,allowWhileIdle:true}}})})})
    .catch(function(){});
}
function notifyHTML(){
  var n=notifyCfg(),ready=!!nativeNotify();
  var h='<div class="settings-block" id="notify-block"><label class="switch-row"><span><b>Remind me before work is due</b><br><span class="m">Get a notification for your reminders.</span></span><input type="checkbox" class="switch" data-act="notify-on"'+(n.on?' checked':'')+' aria-label="Turn on reminder notifications"></label>';
  if(n.on){
    h+='<div class="notify-opts"><label class="field" style="margin-top:12px">Time of day<input type="time" data-act="notify-time" value="'+esc(n.time||"08:00")+'"></label>'+
      '<fieldset><legend>When</legend><div class="chips"><button type="button" class="chip" data-act="notify-lead" data-v="before" aria-pressed="'+(n.lead==="before")+'">The day before</button><button type="button" class="chip" data-act="notify-lead" data-v="day" aria-pressed="'+(n.lead!=="before")+'">On the due day</button></div></fieldset>';
    if(state.schedules.length)h+='<fieldset><legend>Which reminders</legend><div class="chips">'+state.schedules.map(function(s){return '<button type="button" class="chip" data-act="notify-task" data-task="'+esc(s.task)+'" aria-pressed="'+notifyTaskOn(s.task)+'">'+esc(s.task)+'</button>'}).join("")+'</div></fieldset>';
    h+='</div>';
  }
  h+='<p class="src">'+(ready?'Notifications are scheduled on this phone. Nothing is sent to a server.':'Your choices are saved. Notifications will start working in the TurfDiary app from the Google Play Store.')+'</p></div>';
  return h;
}

/* ---------- "just mowed" animation: a mower drives up a stripe and leaves a fresh-cut line ---------- */
function playMowAnim(){
  if(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches)return;
  var hero=document.querySelector(".hero");if(!hero||!hero.animate)return;
  var w=hero.clientWidth,h=hero.clientHeight,A=100*Math.PI/180;
  /* geometry of the card's striped background: repeating-linear-gradient(100deg, dark 0-44px, light 44-88px) */
  var d=[Math.sin(A),-Math.cos(A)],perp=[-d[1],d[0]],L=Math.abs(w*Math.sin(A))+Math.abs(h*Math.cos(A));
  var st=[w/2-d[0]*L/2,h/2-d[1]*L/2],pc=L/2;
  var n0=Math.round((pc-66)/88),passes=[];
  [-1,0,1,2].forEach(function(k,i){
    var p=66+88*(n0+k),base=[st[0]+d[0]*p,st[1]+d[1]*p];
    function at(y){var t=(y-base[1])/perp[1];return[base[0]+perp[0]*t,base[1]+perp[1]*t]}
    var B=at(h+44),T=at(-44);
    passes.push(i%2===0?{from:B,to:T,up:true}:{from:T,to:B,up:false});
  });
  var len=h+88,P=820,N=passes.length,total=P*N;
  var under=document.createElement("div");under.className="mow-anim under";under.setAttribute("aria-hidden","true");
  var layer=document.createElement("div");layer.className="mow-anim";layer.setAttribute("aria-hidden","true");
  var mower=document.createElement("div");mower.className="mow-sprite";
  mower.innerHTML='<svg viewBox="0 0 40 52"><rect x="6" y="10" width="28" height="26" rx="7" fill="#F4F6F1" stroke="#1F4526" stroke-width="2"/><rect x="11" y="15" width="18" height="16" rx="5" fill="#CDD6CB"/><rect x="2" y="12" width="5" height="9" rx="2" fill="#26332A"/><rect x="33" y="12" width="5" height="9" rx="2" fill="#26332A"/><rect x="2" y="26" width="5" height="9" rx="2" fill="#26332A"/><rect x="33" y="26" width="5" height="9" rx="2" fill="#26332A"/><path d="M11 36v12h18V36" fill="none" stroke="#1F4526" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="6" r="2" fill="#B8E3A8"/><circle cx="20" cy="3.5" r="1.6" fill="#B8E3A8"/><circle cx="28" cy="6" r="2" fill="#B8E3A8"/></svg>';
  var ease="cubic-bezier(.45,.05,.45,1)";
  passes.forEach(function(ps,i){
    var tr=document.createElement("div");tr.className="mow-trail";tr.style.height=len+"px";
    if(ps.up){tr.style.transformOrigin="50% 100%";tr.style.left=(ps.from[0]-24)+"px";tr.style.top=(ps.from[1]-len)+"px"}
    else{tr.style.transformOrigin="50% 0%";tr.style.left=(ps.from[0]-24)+"px";tr.style.top=ps.from[1]+"px"}
    under.appendChild(tr);
    tr.animate([{transform:"rotate(10deg) scaleY(0)"},{transform:"rotate(10deg) scaleY(1)"}],{duration:P,delay:i*P,easing:ease,fill:"both"});
  });
  var kf=[];
  passes.forEach(function(ps,i){
    var rot=ps.up?10:190;
    function tf(pt){return "translate("+(pt[0]-20)+"px,"+(pt[1]-26)+"px) rotate("+rot+"deg)"}
    kf.push({offset:i/N,transform:tf(ps.from),easing:ease});
    kf.push({offset:Math.max(i/N+.001,(i+1)/N-.002),transform:tf(ps.to)});
  });
  layer.appendChild(mower);hero.insertBefore(under,hero.firstChild);hero.appendChild(layer);
  mower.animate(kf,{duration:total,fill:"forwards"});
  var fade=[{opacity:1},{opacity:1,offset:total/(total+700)},{opacity:0}];
  layer.animate(fade,{duration:total+700,fill:"forwards"}).onfinish=function(){layer.remove()};
  under.animate(fade,{duration:total+700,fill:"forwards"}).onfinish=function(){under.remove()};
}

/* ---------- receipt scanning: read on the phone, match saved products, learn for next time ---------- */
var EXP_CATS=["Fertilizer","Weed control","Insecticide","Pre-emergent","Grass seed","Fungicide","Biostimulant","Lime","Fuel & oil","Tools & parts","Other supplies"];
function expCat(p){var c=prodCat(p);return c==="Other"?"Other supplies":c}
var CAT_TASK={"Fertilizer":"Fertilize","Biostimulant":"Fertilize","Lime":"Fertilize","Weed control":"Weed control","Pre-emergent":"Weed control","Fungicide":"Fungicide","Insecticide":"Insecticide","Grass seed":"Overseed","Other":"Supplies"};
function rcNorm(t){return String(t||"").toUpperCase().replace(/\$?\d+[.,]\d{2}.*$/,"").replace(/\b\d{6,14}\b/g,"").replace(/[^A-Z0-9]+/g," ").trim()}
function loadTesseract(){
  if(window.Tesseract)return Promise.resolve();
  return new Promise(function(ok,bad){var sc=document.createElement("script");sc.src="https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";sc.onload=ok;sc.onerror=bad;document.head.appendChild(sc)});
}
function ocrReceipt(blob,progress){
  if(window.__TD_OCR)return window.__TD_OCR(blob);
  return loadTesseract().then(function(){
    return window.Tesseract.createWorker("eng",1,{langPath:"https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int",logger:function(m){if(m&&m.status==="recognizing text"&&progress)progress(m.progress)}});
  }).then(function(w){return w.recognize(blob).then(function(r){var txt=r.data.text;w.terminate();return txt})});
}
function parseReceipt(text){
  var lines=String(text||"").split(/\r?\n/).map(function(l){return l.replace(/\s+/g," ").trim()}).filter(Boolean);
  var priceRe=/(-?)\$?\s?(\d{1,5}[.,]\d{2})\s*[A-Z*]{0,2}\s*$/,skip=/\b(sub ?total|tax|change|cash|visa|mastercard|amex|discover|debit|credit|card|payment|tender|balance|savings|you saved|discount|coupon|auth|approval|ref|account)\b/i,totRe=/\b(total|amount due|balance due)\b/i;
  var out={store:lines[0]?lines[0].slice(0,40):"",date:null,total:null,tax:null,items:[]},claimed={};
  var dm=String(text).match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  if(dm){var yy=+dm[3];if(yy<100)yy+=2000;var mm=+dm[1],dd=+dm[2];if(mm>=1&&mm<=12&&dd>=1&&dd<=31)out.date=yy+"-"+pad(mm)+"-"+pad(dd)}
  lines.forEach(function(l,i){
    var m=l.match(priceRe);if(!m)return;
    var val=parseFloat(m[2].replace(",","."))*(m[1]?-1:1);
    if(totRe.test(l)&&!/sub ?total/i.test(l)){out.total=val;return}
    if(/\btax\b/i.test(l)&&!/sub ?total/i.test(l)){out.tax=(out.tax||0)+val;return}
    if(skip.test(l)||val<=0||/^\d+\s*@/.test(l))return;
    var upc=null;[[l,i],[lines[i+1]||"",i+1]].some(function(x,k){if(k&&(priceRe.test(x[0])&&!/^\d{11,13}\s*$/.test(x[0])))return false;if(claimed[x[1]])return false;var u=x[0].match(/\b(\d{11,13})\b/);if(u){upc=u[1];claimed[x[1]]=1;return true}return false});
    var unit=null,q=l.match(/(\d+)\s*@\s*\$?(\d+[.,]\d{2})/)||(lines[i+1]||"").match(/(\d+)\s*@\s*\$?(\d+[.,]\d{2})/);if(q)unit=parseFloat(q[2].replace(",","."));
    var label=l.replace(priceRe,"").replace(/\b\d{11,13}\b/,"").replace(/\s+/g," ").trim();
    if(label.length<2)label=(lines[i-1]||"").replace(/\b\d{6,14}\b/g,"").trim()||label;
    out.items.push({label:label.slice(0,60),price:val,unit:unit,upc:upc});
  });
  return out;
}
function rcMatch(item){
  var p=item.upc?findByUpc(item.upc):null;if(p)return{p:p,how:"barcode"};
  var al=state.receiptAliases||{},k=rcNorm(item.label);
  if(al[k]){p=state.products.find(function(x){return x.id===al[k]});if(p)return{p:p,how:"learned"}}
  var lt=k.toLowerCase().split(" ").filter(Boolean),best=null,bs=0;
  state.products.forEach(function(pr){
    var nt=pr.name.toLowerCase().replace(/[^a-z0-9]+/g," ").trim().split(" ").filter(function(t){return t.length>=2});if(!nt.length)return;
    var hit=0;nt.forEach(function(t){if(lt.some(function(x){return x===t||(x.length>=3&&t.indexOf(x)===0)||(t.length>=3&&x.indexOf(t.slice(0,4))===0)}))hit++});
    var sc=hit/nt.length;if(hit>=Math.min(2,nt.length)&&sc>bs){bs=sc;best=pr}
  });
  return best&&bs>=0.6?{p:best,how:"name"}:null;
}
var RC=null;
function openReceipt(){
  closeSheet();
  RC={photo:null,data:null,rows:[]};
  document.getElementById("sheet").innerHTML='<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="rc-title"><h2 id="rc-title">Scan a receipt</h2>'+
    '<p class="note">Take a flat, well-lit photo of the whole receipt. TurfDiary reads it on your phone, picks out your products and prices, and learns your store\u2019s wording so the next scan is faster. Emailed receipts work too: pick the PDF, or share it to TurfDiary from your email app.</p>'+
    '<div class="toolbar" style="justify-content:flex-start"><label class="btn primary file-btn">Take photo<input type="file" accept="image/*" capture="environment" class="vh" data-act="rc-file" aria-label="Take a photo of your receipt"></label><label class="btn file-btn">From gallery or PDF<input type="file" accept="image/*,application/pdf,.pdf" class="vh" data-act="rc-file" aria-label="Choose a receipt photo or PDF"></label></div>'+
    '<p class="err" id="rc-msg" role="status"></p><div class="actions"><button class="btn ghost" data-act="close-sheet">Cancel</button></div></div>';
  document.addEventListener("keydown",onKey);
}
function rcFile(file){
  var msg=document.getElementById("rc-msg");if(!file||!msg)return;
  msg.style.color="var(--muted)";msg.textContent="Reading your receipt\u2026 The first scan downloads the text reader, so it can take a little longer.";
  var pid="p_"+uid(),isPdf=/pdf/i.test(file.type||"")||/\.pdf$/i.test(file.name||"");
  (isPdf?pdfToImage(file):Promise.resolve(file)).then(function(f){return shrink(f)}).then(function(b){return photoPut(pid,b).then(function(){RC.photo=pid;newUploads.push(pid);return ocrReceipt(b,function(p){msg.textContent="Reading your receipt\u2026 "+Math.round(p*100)+"%"})})})
  .then(function(text){var d=parseReceipt(text);if(!d.items.length&&d.total==null){msg.style.color="";msg.textContent="Couldn\u2019t find any prices. Try a flatter, brighter photo, or add the expense by hand.";return}d.store=cleanStore(d.store);RC.data=d;RC.rows=d.items.map(function(it){var m=rcMatch(it);return{it:it,pid:m?m.p.id:"__supplies",how:m?m.how:"",upd:true}});showReceipt()})
  .catch(function(){msg.style.color="";msg.textContent="Couldn\u2019t read the receipt. Check your connection the first time you scan, then try again."});
}
function showReceipt(){
  var d=RC.data;
  var opts=function(sel){return '<option value="__supplies"'+(sel==="__supplies"?' selected':'')+'>Not a saved product (log as Other supplies)</option><option value="__skip"'+(sel==="__skip"?' selected':'')+'>Skip this line</option>'+
    CATS.filter(function(c){return state.products.some(function(p){return prodCat(p)===c})}).map(function(c){return '<optgroup label="'+esc(c)+'">'+state.products.filter(function(p){return prodCat(p)===c}).map(function(p){return '<option value="'+esc(p.id)+'"'+(sel===p.id?' selected':'')+'>'+esc(p.name)+'</option>'}).join("")+'</optgroup>'}).join("")};
  var matched=RC.rows.filter(function(r){return r.how}).length;
  var h='<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="rc-title"><h2 id="rc-title">Review your receipt</h2>'+
    '<div class="rc-head"><div><label class="rc-store">Store<input type="text" id="rc-store" maxlength="40" value="'+esc(d.store||"")+'" placeholder="Store name"></label><span>'+esc(d.date?fmtLong(d.date):"Date not found, using today")+'</span></div>'+(d.total!=null?'<div class="rc-total">'+money(d.total)+'<span>total</span></div>':'')+'</div>'+
    '<p class="m" style="margin:8px 0 10px">'+(matched?matched+' of '+RC.rows.length+' '+pl(RC.rows.length,"line")+' matched to your products. ':'')+'Check each line, then save. Lines you match by hand are remembered for next time.</p>'+
    '<div class="rc-list">'+RC.rows.map(function(r,i){
      var p=state.products.find(function(x){return x.id===r.pid});
      var priceChange=p&&p.price!=null&&Math.abs(p.price-(r.it.unit||r.it.price))>0.004;
      return '<div class="rc-row'+(r.how?' ok':'')+'"><div class="rc-line"><span class="rc-txt">'+esc(r.it.label)+'</span><span class="rc-price">'+money(r.it.price)+'</span></div>'+
        (r.how?'<div class="rc-how">\u2713 '+esc(p.name)+' <span>('+(r.how==="barcode"?"matched by barcode":r.how==="learned"?"remembered from a past receipt":"matched by name")+')</span></div>':'')+
        '<select data-act="rc-pick" data-i="'+i+'" aria-label="Product for '+esc(r.it.label)+'">'+opts(r.pid)+'</select>'+
        (p&&(p.price==null||priceChange)?'<label class="rc-upd"><input type="checkbox" data-act="rc-upd" data-i="'+i+'"'+(r.upd?' checked':'')+'> Update saved price to '+money(r.it.unit||r.it.price)+(p.price!=null?' (was '+money(p.price)+')':'')+'</label>':'')+
        '</div>';
    }).join("")+'</div>'+
    (d.tax>0?'<label class="rc-upd" style="margin:0 0 12px"><input type="checkbox" data-act="rc-tax"'+(RC.tax!==false?' checked':'')+'> Add sales tax ('+money(d.tax)+') as its own expense</label>':'')+
    '<div class="actions" style="flex-wrap:wrap">'+(d.total!=null?'<button class="btn ghost" data-act="rc-total" style="margin-right:auto">Use total only</button>':'')+'<button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn primary" data-act="rc-save">Save expenses</button></div></div>';
  document.getElementById("sheet").innerHTML=h;
}
function rcSave(totalOnly){
  var se=document.getElementById("rc-store");if(se)RC.data.store=se.value.trim().slice(0,40);
  var d=RC.data,date=d.date||todayISO(),photos=RC.photo?[RC.photo]:[],n=0;
  if(!state.receiptAliases)state.receiptAliases={};
  if(totalOnly){state.entries.push({id:uid(),kind:"expense",date:date,task:"Other supplies",cost:Math.round(d.total*100)/100,product:"",note:"Receipt total",store:d.store,photos:photos});n=1}
  else RC.rows.forEach(function(r,i){
    if(r.pid==="__skip")return;
    var p=state.products.find(function(x){return x.id===r.pid});
    if(p){
      if(!r.how||r.how==="name")state.receiptAliases[rcNorm(r.it.label)]=p.id;
      if(r.it.upc&&!p.upc&&!findByUpc(r.it.upc))p.upc=normUpc(r.it.upc);
      if(r.upd&&(p.price==null||Math.abs(p.price-(r.it.unit||r.it.price))>0.004))p.price=Math.round((r.it.unit||r.it.price)*100)/100;
    }
    state.entries.push({id:uid()+i,kind:"expense",date:date,task:p?expCat(p):"Other supplies",cost:Math.round(r.it.price*100)/100,product:p?p.name:r.it.label,note:"From receipt",store:d.store,photos:photos.slice()});n++;
  });
  if(!totalOnly&&d.tax>0&&RC.tax!==false&&n){state.entries.push({id:uid()+"t",kind:"expense",date:date,task:"Other supplies",cost:Math.round(d.tax*100)/100,product:"Sales tax",note:"From receipt",store:d.store,photos:photos.slice()})}
  newUploads=[];closeSheet();
  if(!n){setStatus("Nothing to save");return}
  persist();setStatus(n+" "+pl(n,"expense")+" saved from your receipt");
  if(!totalOnly){var newOnes=RC.rows.filter(function(r){return r.pid==="__supplies"}).map(function(r){var lbl=r.it.label;return{name:lbl===lbl.toUpperCase()?titleCase(lbl.toLowerCase()):lbl,cat:"Other supplies",price:r.it.unit||r.it.price,upc:r.it.upc}});if(newOnes.length)setTimeout(function(){promptNewProducts(newOnes)},300)}
}

/* ---------- quicker logging helpers ---------- */
function lastCostFor(task,product){var best=null;state.entries.forEach(function(e){if(e.task===task&&e.kind!=="expense"&&e.product===product&&e.cost>0&&(!best||e.date>best.date))best=e});return best?best.cost:null}
function costGuess(task,product){if(!product)return null;var p=findProduct(product),c=p?prodCostUsed(p,areaSqft()):null;return c!=null?c:lastCostFor(task,product)}
function autoFill(){
  if(editId||sheetMode==="expense")return;
  var fp=document.getElementById("f-product"),fc=document.getElementById("f-cost"),note=document.getElementById("auto-note");if(!fp)return;
  var t=sheetTasks.length===1?sheetTasks[0]:null,lp=t?lastProduct(t):"";
  if(fp.value===""||fp.dataset.auto==="1"){fp.value=lp||"";fp.dataset.auto=lp?"1":""}
  if(fc&&(fc.value===""||fc.dataset.auto==="1")){var c=fp.dataset.auto==="1"?costGuess(t,fp.value):null;fc.value=c!=null?c:"";fc.dataset.auto=c!=null?"1":""}
  if(note)note.innerHTML=fp.dataset.auto==="1"?'Filled in from your last '+esc(t.toLowerCase())+'. <button type="button" class="link small" data-act="auto-clear">Clear</button>':"";
  updateCalc(fp);updateMoreSum();
}
function updateMoreSum(){
  var el=document.getElementById("more-sum");if(!el)return;
  var parts=[],fc=document.getElementById("f-cost"),fn=document.getElementById("f-note"),fs=document.getElementById("f-soil");
  if(fc&&fc.value&&sheetMode!=="expense"&&!(sheetTasks.length>1))parts.push(money(+fc.value));
  if(fs&&fs.value)parts.push("soil "+fs.value+"\u00b0");
  if(formPhotos.length)parts.push(formPhotos.length+" "+pl(formPhotos.length,"photo"));
  if(fn&&fn.value.trim())parts.push("note");
  el.textContent=parts.length?": "+parts.join(", "):" (optional)";
}

/* ---------- first-time setup ---------- */
var ONB=0,onbMsg="";
var ONB_TASKS=[["Mow",7],["Edge",14],["Fertilize",42],["Weed control",30],["Water",7],["Insecticide",180]];
function backupBanner(){
  if(state.entries.length<5)return "";
  var now=Date.now(),first=state.entries.reduce(function(m,e){return e.date<m?e.date:m},"9999");
  var ref=state.lastBackup||parse(first).getTime(),days=Math.floor((now-ref)/86400000);
  if(days<30||(state.backupSnooze&&now<state.backupSnooze))return "";
  return '<section class="backup-banner" role="status"><div><b>Back Up Your Diary</b><span>'+(state.lastBackup?'It\u2019s been '+days+' days since your last backup.':'You haven\u2019t saved a backup yet.')+' Your diary is stored only on this phone.</span></div>'+
    '<div class="bb-acts"><button class="btn small ghost" data-act="backup-later">Later</button><button class="btn small primary" data-act="export">Save Backup</button></div></section>';
}
function openOnboarding(step){
  ONB=step;var h='<div class="scrim" data-act="close-sheet"></div><div class="sheet onb" id="onb" role="dialog" aria-modal="true" aria-labelledby="onb-title">';
  h+='<div class="onb-steps" aria-hidden="true">'+[1,2,3].map(function(i){return '<i class="'+(i<=step?"on":"")+'"></i>'}).join("")+'</div><p class="m" style="margin:0">Step '+step+' of 3</p>';
  if(step===1){
    h+='<h2 id="onb-title">Welcome to TurfDiary</h2><p class="note">Let\u2019s set up three things so the app can help from day one. You can change any of them later in Settings.</p>'+
      '<h3 class="sub-h">Local weather</h3><p class="note" style="margin-top:0">See today\u2019s conditions, the week ahead, and rain and frost tips for planning yard work.</p>'+
      (state.wxLoc?'<p class="onb-ok">\u2713 Weather is set'+(state.wxLoc.place?' for '+esc(state.wxLoc.place):'')+'</p>':'<button class="btn primary" data-act="onb-wx">Use My Location</button>')+
      (onbMsg?'<p class="err" role="alert">'+esc(onbMsg)+'</p>':'');
  }else if(step===2){
    var sq=lawnSqft();
    h+='<h2 id="onb-title">Your lawn size</h2><p class="note">TurfDiary uses it to tell you how much product to buy and what each application costs.</p>'+
      (sq>0?'<p class="onb-ok">\u2713 '+fmtInt(sq)+' sq ft of lawn</p>':'')+
      '<div class="toolbar" style="justify-content:flex-start"><button class="btn '+(sq>0?'':'primary')+'" data-act="lawn-map">'+(sq>0?"Measure Again":"Measure On Map")+'</button><button class="btn" data-act="lawn-manual">Enter Size By Hand</button></div>';
  }else{
    var have={};state.schedules.forEach(function(x){have[x.task]=x.every});
    h+='<h2 id="onb-title">Reminders</h2><p class="note">Pick the jobs you want reminders for. TurfDiary counts from the last time you log each one.</p><div class="list onb-list">'+
      ONB_TASKS.map(function(t){var on=have[t[0]]!=null;return '<label class="item onb-row"><input type="checkbox" data-onb-task="'+esc(t[0])+'"'+(on?' checked':'')+'><span class="grow t">'+esc(t[0])+'</span><span class="every">every <input type="number" min="1" max="365" inputmode="numeric" data-onb-days="'+esc(t[0])+'" value="'+(on?have[t[0]]:t[1])+'" aria-label="Days between '+esc(t[0])+'"> days</span></label>'}).join("")+'</div>';
  }
  h+='<div class="actions" style="margin-top:16px">'+(step>1?'<button class="btn ghost" data-act="onb-back" style="margin-right:auto">Back</button>':'<button class="btn ghost" data-act="onb-skip" style="margin-right:auto">Skip setup</button>')+
    (step<3?(function(){var done=(step===1&&state.wxLoc)||(step===2&&lawnSqft()>0);return '<button class="btn '+(done?'primary':'ghost')+'" data-act="onb-next">'+(done?"Next":"Skip this step")+'</button>'})():'<button class="btn primary" data-act="onb-done">Finish</button>')+'</div></div>';
  document.getElementById("sheet").innerHTML=h;document.addEventListener("keydown",onKey);
}
function finishOnboarding(){
  var keep=state.schedules.filter(function(x){return !ONB_TASKS.some(function(t){return t[0]===x.task})}),sel=[];
  document.querySelectorAll("[data-onb-task]").forEach(function(cb){if(cb.checked){var d=parseInt(document.querySelector('[data-onb-days="'+cb.dataset.onbTask+'"]').value,10);sel.push({task:cb.dataset.onbTask,every:d>=1&&d<=365?d:7})}});
  state.schedules=sel.concat(keep);state.onboarded=true;ONB=0;
  document.getElementById("sheet").innerHTML="";persist();setStatus("You\u2019re all set");
}

/* ---------- Diary search ---------- */
var diaryQ="";
function diaryListHTML(){
  var list=sorted();if(histFilter!=="all")list=list.filter(function(e){return e.task===histFilter});
  var words=diaryQ.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if(words.length)list=list.filter(function(e){var hay=[e.task,e.product,e.note,e.store,e.weather,e.kind==="expense"?"purchase expense":""].join(" ").toLowerCase();return words.every(function(w){return hay.indexOf(w)>=0})});
  if(!list.length)return words.length?'<p class="empty" style="margin-top:16px">Nothing in your diary matches \u201c'+esc(diaryQ.trim())+'\u201d.</p>':'<p class="empty" style="margin-top:16px">Your diary is empty. Everything you log shows up here, newest first.</p>';
  var h=words.length?'<p class="m" style="margin:12px 0 0">'+list.length+' '+pl(list.length,"entry").replace("entrys","entries")+' found</p>':"";
  var groups={},order=[];
  list.forEach(function(e){var k=e.date.slice(0,7);if(!groups[k]){groups[k]=[];order.push(k)}groups[k].push(e)});
  order.forEach(function(k){
    var d=parse(k+"-01"),tot=groups[k].reduce(function(s,e){return s+(e.cost||0)},0);
    h+='<div class="month-h">'+esc(d.toLocaleDateString(undefined,{month:"long",year:"numeric"}))+(tot?'<b>'+money(tot)+'</b>':'')+'</div>';
    h+='<div class="list">'+groups[k].map(function(e){return entryRow(e,true)}).join("")+'</div>';
  });
  return h;
}

/* ---------- optional app lock: PIN on the web, fingerprint or face in the Play Store app ---------- */
var LS_LOCK="turfdiary-lock",lockCfg=null,locked=false,lockPin="",lockFails=0,lockUntil=0,hiddenAt=0;
try{lockCfg=JSON.parse(localStorage.getItem(LS_LOCK)||"null")}catch(e){lockCfg=null}
function pinHash(pin,salt){return crypto.subtle.importKey("raw",new TextEncoder().encode(pin),"PBKDF2",false,["deriveBits"]).then(function(k){return crypto.subtle.deriveBits({name:"PBKDF2",salt:unb64(salt),iterations:150000,hash:"SHA-256"},k,256)}).then(b64)}
function bioPlugin(){var c=window.Capacitor;return c&&c.Plugins&&c.Plugins.NativeBiometric?c.Plugins.NativeBiometric:null}
function showLock(){
  if(!lockCfg)return;locked=true;lockPin="";
  var el=document.getElementById("lockview");if(!el){el=document.createElement("div");el.id="lockview";el.setAttribute("role","dialog");el.setAttribute("aria-modal","true");el.setAttribute("aria-label","TurfDiary is locked");document.body.appendChild(el)}
  drawLock("");
  var bio=bioPlugin();if(bio&&lockCfg.bio)tryBio();
}
function drawLock(msg){
  var el=document.getElementById("lockview");if(!el)return;
  var keys=["1","2","3","4","5","6","7","8","9","","0","del"];
  el.innerHTML='<div class="lock-in"><div class="lock-logo" aria-hidden="true">'+ICONS.history+'</div><h2>TurfDiary is locked</h2><p class="m">Enter your 4-digit PIN</p>'+
    '<div class="pin-dots" aria-label="'+lockPin.length+' of 4 digits entered">'+[0,1,2,3].map(function(i){return '<i class="'+(i<lockPin.length?"on":"")+'"></i>'}).join("")+'</div>'+
    '<p class="err lock-msg" role="alert">'+esc(msg||"")+'</p>'+
    '<div class="pin-pad">'+keys.map(function(k){return k===""?(bioPlugin()&&lockCfg.bio?'<button class="pin-k small" data-act="lock-bio" aria-label="Use fingerprint or face">'+ICONS.finger+'</button>':'<span></span>'):k==="del"?'<button class="pin-k small" data-act="lock-del" aria-label="Delete last digit">\u232B</button>':'<button class="pin-k" data-act="lock-key" data-k="'+k+'">'+k+'</button>'}).join("")+'</div>'+
    '<button class="link small" data-act="lock-forgot">Forgot your PIN?</button></div>';
}
function lockKey(k){
  if(Date.now()<lockUntil){drawLock("Too many tries. Wait "+Math.ceil((lockUntil-Date.now())/1000)+" seconds.");return}
  if(lockPin.length>=4)return;lockPin+=k;drawLock("");
  if(lockPin.length===4){
    var tryPin=lockPin;
    pinHash(tryPin,lockCfg.salt).then(function(h){
      if(h===lockCfg.hash){unlockApp()}
      else{lockFails++;lockPin="";if(lockFails>=5){lockUntil=Date.now()+30000;lockFails=0;drawLock("Too many tries. Wait 30 seconds.")}else drawLock("Wrong PIN. Try again.");var pd=document.querySelector(".pin-dots");if(pd&&pd.animate)pd.animate([{transform:"translateX(0)"},{transform:"translateX(-10px)"},{transform:"translateX(10px)"},{transform:"translateX(0)"}],{duration:300})}
    });
  }
}
function unlockApp(){locked=false;lockFails=0;lockPin="";var el=document.getElementById("lockview");if(el)el.remove();if(pendingLaunch){var pa=pendingLaunch;pendingLaunch=null;setTimeout(function(){doLaunch(pa)},200)}}
function tryBio(){var bio=bioPlugin();if(!bio)return;bio.verifyIdentity({reason:"Unlock TurfDiary",title:"Unlock TurfDiary"}).then(unlockApp).catch(function(){})}
function lockHTML(){
  if(!lockCfg)return '<div class="settings-block"><p>Ask for a PIN each time TurfDiary opens, so nobody else using this phone can see your diary or spending.'+(bioPlugin()?" You can also unlock with your fingerprint or face.":"")+'</p><button class="btn primary" data-act="lock-setup">Turn On App Lock</button></div>';
  return '<div class="settings-block"><p><b>App lock is on.</b> TurfDiary asks for your PIN when it opens and after you\u2019ve been away for a minute.</p>'+
    (bioPlugin()?'<label class="switch-row" style="margin-bottom:10px"><span>Unlock with fingerprint or face</span><input type="checkbox" class="switch" data-act="lock-bio-toggle"'+(lockCfg.bio?' checked':'')+'></label>':'')+
    '<div class="toolbar" style="justify-content:flex-start"><button class="btn" data-act="lock-change">Change PIN</button><button class="btn" data-act="lock-off">Turn off</button></div></div>';
}
var lockMode="",lockStep=0,lockFirst="";
function openLockSetup(mode){
  lockMode=mode;lockStep=mode==="setup"?1:0;lockFirst="";
  var title=mode==="setup"?"Choose a PIN":mode==="change"?"Change your PIN":"Turn off app lock";
  var intro=lockStep===0?"Enter your current PIN.":"Pick 4 digits you\u2019ll remember. If you forget it, the only way back in is to erase the app\u2019s data on this phone, so keep a backup.";
  document.getElementById("sheet").innerHTML='<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="pin-title"><h2 id="pin-title">'+title+'</h2>'+
    '<p class="note" id="pin-intro">'+esc(intro)+'</p><label class="field"><span id="pin-label">'+(lockStep===0?"Current PIN":"New PIN")+'</span><input type="password" id="pin-in" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" class="pin-input"></label>'+
    '<p class="err" id="pin-err" role="alert"></p><div class="actions"><button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn primary" data-act="pin-next">Next</button></div></div>';
  document.addEventListener("keydown",onKey);document.getElementById("pin-in").focus();
}
function pinNext(){
  var inp=document.getElementById("pin-in"),v=inp.value,err=document.getElementById("pin-err");
  if(!/^\d{4}$/.test(v)){err.textContent="Enter exactly 4 digits.";return}
  if(lockStep===0){
    pinHash(v,lockCfg.salt).then(function(h){
      if(h!==lockCfg.hash){err.textContent="That\u2019s not your current PIN.";inp.value="";return}
      if(lockMode==="off"){lockCfg=null;try{localStorage.removeItem(LS_LOCK)}catch(e){}closeSheet();render();setStatus("App lock is off");return}
      lockStep=1;inp.value="";err.textContent="";document.getElementById("pin-label").textContent="New PIN";document.getElementById("pin-intro").textContent="Pick 4 new digits.";
    });return;
  }
  if(lockStep===1){lockFirst=v;lockStep=2;inp.value="";err.textContent="";document.getElementById("pin-label").textContent="Type the same PIN again";return}
  if(v!==lockFirst){err.textContent="Those PINs don\u2019t match. Start again.";lockStep=1;lockFirst="";inp.value="";document.getElementById("pin-label").textContent="New PIN";return}
  var salt=b64(crypto.getRandomValues(new Uint8Array(16)));
  pinHash(v,salt).then(function(h){
    lockCfg={salt:salt,hash:h,bio:lockCfg?!!lockCfg.bio:!!bioPlugin()};
    try{localStorage.setItem(LS_LOCK,JSON.stringify(lockCfg))}catch(e){}
    closeSheet();render();setStatus(lockMode==="setup"?"App lock is on":"PIN changed");
  });
}
function lockForgot(){
  drawLock("");var el=document.querySelector("#lockview .lock-in");if(!el)return;
  el.innerHTML='<h2>Forgot your PIN?</h2><p class="m" style="max-width:300px">For your privacy, the PIN can\u2019t be recovered. To get back in, erase TurfDiary\u2019s data on this phone, then restore a backup if you have one.</p>'+
    '<label class="field" style="width:100%;max-width:300px">Type ERASE to confirm<input type="text" id="erase-in" autocomplete="off"></label>'+
    '<div class="actions" style="justify-content:center"><button class="btn ghost" data-act="lock-back">Back</button><button class="btn danger" data-act="lock-erase">Erase and start over</button></div>';
}

/* ---------- launch shortcuts, Share to TurfDiary, and calendar export ---------- */
var pendingLaunch=null;
function launchAction(){
  var q=new URLSearchParams(location.search),a=q.get("action");if(!a)return;
  try{history.replaceState(null,"",location.pathname)}catch(e){}
  if(locked){pendingLaunch=a;return}
  doLaunch(a);
}
function doLaunch(a){
  if(a==="mow"){
    tab="home";render();var t=todayISO();
    if(state.entries.some(function(e){return e.task==="Mow"&&e.date===t&&e.kind!=="expense"})){setStatus("Mow is already logged for today");return}
    state.entries.push({id:uid(),date:t,task:"Mow",cost:0,note:"",product:"",photos:[],quick:true,weather:wxNowText()});setStatus("Mow logged for today");persist();setTimeout(playMowAnim,60);
  }else if(a==="receipt")openReceipt();
  else if(a==="log")openSheet();
  else if(a==="shared"){
    if(!window.caches){return}
    caches.open("turfdiary-share").then(function(c){return c.match("./shared-receipt").then(function(r){if(!r)return null;return r.blob().then(function(b){c.delete("./shared-receipt");return b})})})
      .then(function(b){if(!b){setStatus("Nothing was shared");return}openReceipt();rcFile(b)});
  }
}
function loadPdfJs(){
  if(window.pdfjsLib)return Promise.resolve();
  return new Promise(function(ok,bad){var sc=document.createElement("script");sc.src="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js";sc.onload=function(){window.pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";ok()};sc.onerror=bad;document.head.appendChild(sc)});
}
function pdfToImage(blob){
  return Promise.all([loadPdfJs(),blob.arrayBuffer()]).then(function(r){return window.pdfjsLib.getDocument({data:r[1]}).promise}).then(function(doc){return doc.getPage(1)}).then(function(pg){
    var vp=pg.getViewport({scale:2.2}),c=document.createElement("canvas");c.width=vp.width;c.height=vp.height;
    var ctx=c.getContext("2d");ctx.fillStyle="#fff";ctx.fillRect(0,0,c.width,c.height);
    return pg.render({canvasContext:ctx,viewport:vp}).promise.then(function(){return new Promise(function(ok){c.toBlob(ok,"image/jpeg",0.92)})});
  });
}
function nextDue(s){var t=todayISO(),last=dueBase(s),every=Math.max(1,+s.every||7),d=last?addDays(last,every):t;return d<t?t:d}
function gcalUrl(s){
  var d=nextDue(s).replace(/-/g,""),e=addDays(nextDue(s),1).replace(/-/g,"");
  return "https://calendar.google.com/calendar/render?action=TEMPLATE&text="+encodeURIComponent("TurfDiary: "+s.task)+"&dates="+d+"/"+e+
    "&details="+encodeURIComponent("Repeats every "+s.every+" days. Log it in TurfDiary when it's done.")+"&recur="+encodeURIComponent("RRULE:FREQ=DAILY;INTERVAL="+s.every);
}
function icsFile(){
  var now=new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d+/,""),L=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//TurfDiary//Reminders//EN","CALSCALE:GREGORIAN"];
  state.schedules.forEach(function(s,i){var d=nextDue(s);L.push("BEGIN:VEVENT","UID:turfdiary-"+i+"-"+d+"@turfdiary.github.io","DTSTAMP:"+now,"DTSTART;VALUE=DATE:"+d.replace(/-/g,""),"DTEND;VALUE=DATE:"+addDays(d,1).replace(/-/g,""),"RRULE:FREQ=DAILY;INTERVAL="+s.every,"SUMMARY:TurfDiary: "+s.task,"DESCRIPTION:Repeats every "+s.every+" days. Log it in TurfDiary when it's done.","BEGIN:VALARM","ACTION:DISPLAY","DESCRIPTION:"+s.task+" is due today","TRIGGER:PT8H","END:VALARM","END:VEVENT")});
  L.push("END:VCALENDAR");return L.join("\r\n")+"\r\n";
}
function openCalendar(){
  if(!state.schedules.length){setStatus("Add a reminder first");return}
  document.getElementById("sheet").innerHTML='<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="cal-title"><h2 id="cal-title">Add reminders to your calendar</h2>'+
    '<p class="note">Each reminder repeats on its schedule, starting from its next due date. Calendar events won\u2019t shift if you mow early or late, so Coming up in TurfDiary stays the most accurate.</p>'+
    '<h3 class="sub-h">Google Calendar</h3><div class="list">'+state.schedules.map(function(s){return '<div class="item"><div class="grow"><div class="t">'+esc(s.task)+'</div><div class="m">Every '+esc(s.every)+' days, starting '+esc(fmtWeekday(nextDue(s)))+'</div></div><a class="btn small" href="'+esc(gcalUrl(s))+'" target="_blank" rel="noopener">Add</a></div>'}).join("")+'</div>'+
    '<h3 class="sub-h">Apple, Outlook or other calendars</h3><p class="note" style="margin-top:0">Download one file with all your reminders, then open it to add them.</p><button class="btn primary" data-act="cal-ics">Download calendar file</button>'+
    '<div class="actions" style="margin-top:14px"><button class="btn ghost" data-act="close-sheet">Done</button></div></div>';
  document.addEventListener("keydown",onKey);
}
function downloadIcs(){
  var a=document.createElement("a");a.href=URL.createObjectURL(new Blob([icsFile()],{type:"text/calendar"}));a.download="turfdiary-reminders.ics";document.body.appendChild(a);a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},2000);setStatus("Calendar file saved to your downloads");
}

/* ---------- soil tests: store exactly what's on the lab report ---------- */
var SOIL_FIELDS=[
  {g:"Soil",k:"ph",l:"pH"},{g:"Soil",k:"bph",l:"Buffer pH"},{g:"Soil",k:"om",l:"Organic matter",u:"%"},{g:"Soil",k:"cec",l:"CEC",u:"meq/100 g"},
  {g:"Major nutrients",k:"p",l:"Phosphorus (P)",n:1},{g:"Major nutrients",k:"k",l:"Potassium (K)",n:1},{g:"Major nutrients",k:"ca",l:"Calcium (Ca)",n:1},{g:"Major nutrients",k:"mg",l:"Magnesium (Mg)",n:1},{g:"Major nutrients",k:"s",l:"Sulfur (S)",n:1},
  {g:"Micronutrients",k:"fe",l:"Iron (Fe)",n:1},{g:"Micronutrients",k:"mn",l:"Manganese (Mn)",n:1},{g:"Micronutrients",k:"zn",l:"Zinc (Zn)",n:1},{g:"Micronutrients",k:"cu",l:"Copper (Cu)",n:1},{g:"Micronutrients",k:"b",l:"Boron (B)",n:1},
  {g:"Other",k:"na",l:"Sodium (Na)",n:1},{g:"Other",k:"ss",l:"Soluble salts",u:"mmhos/cm"}
];
var soilView="products",soilEdit=null,soilPhotos=[];
function soilTests(){if(!Array.isArray(state.soilTests))state.soilTests=[];return state.soilTests}
function soilUnit(f,t){return f.n?(t.unit||"ppm"):(f.u||"")}
function soilVal(f,t){var v=t.vals&&t.vals[f.k];return v==null||v===""?null:v}
function prevSoil(t){var ts=soilTests().filter(function(x){return x.id!==t.id&&(x.area||"")===(t.area||"")&&x.date<t.date}).sort(function(a,b){return a.date<b.date?1:-1});return ts[0]||null}
function soilListHTML(){
  var ts=soilTests().slice().sort(function(a,b){return a.date<b.date?1:-1});
  if(!ts.length)return '<div class="settings-block"><p>Keep each soil test from your lab here: pH, organic matter, nutrients and the lab\u2019s recommendations, plus a photo of the report. Over the years, you\u2019ll see how your soil is changing.</p></div>';
  return '<div class="list">'+ts.map(function(t){
    var keys=["ph","om","p","k"].map(function(k){var f=SOIL_FIELDS.find(function(x){return x.k===k}),v=soilVal(f,t);return v==null?"":'<span class="soil-chip"><b>'+esc(f.k==="om"?"OM":f.k==="ph"?"pH":f.k.toUpperCase())+'</b> '+esc(v)+(f.n||f.u==="%"?(f.u==="%"?"%":" "+esc(soilUnit(f,t))):"")+'</span>'}).join("");
    return '<button class="item soil-item" data-act="soil-view" data-id="'+esc(t.id)+'"><div class="date"><span>'+parse(t.date).getDate()+'</span><small>'+esc(parse(t.date).toLocaleDateString(undefined,{month:"short",year:"2-digit"}))+'</small></div><div class="grow"><div class="t">'+esc(t.area||"Whole lawn")+(t.lab?' <span class="m" style="font-weight:500">'+esc(t.lab)+'</span>':'')+'</div><div class="soil-chips">'+(keys||'<span class="m">Tap to view</span>')+'</div></div><span class="chev">\u203A</span></button>';
  }).join("")+'</div>';
}
function openSoilForm(id){
  var t=id?soilTests().find(function(x){return x.id===id}):null;soilEdit=t?t.id:null;soilPhotos=t&&t.photos?t.photos.slice():[];
  var zs=zones(),groups=[];SOIL_FIELDS.forEach(function(f){if(groups.indexOf(f.g)<0)groups.push(f.g)});
  var h='<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="st-title"><h2 id="st-title">'+(t?"Edit Soil Test":"Add a Soil Test")+'</h2>'+
    '<p class="note">Fill in only what\u2019s printed on your report. Empty boxes are left off.</p>'+
    '<div class="two-col"><label class="field">Date sampled<input type="date" id="st-date" value="'+esc(t?t.date:todayISO())+'"></label>'+
    '<label class="field">Lab (optional)<input type="text" id="st-lab" maxlength="40" autocapitalize="words" value="'+esc(t&&t.lab||"")+'" placeholder="e.g. UT Soil Lab"></label></div>'+
    (zs.length?'<label class="field">Part of the yard<select id="st-area"><option value="">Whole Lawn</option>'+zs.map(function(z){return '<option'+(t&&t.area===z?' selected':'')+' value="'+esc(z)+'">'+esc(titleCase(z))+'</option>'}).join("")+'</select></label>':'')+
    '<div class="field" style="margin-bottom:10px">Photo of the report (optional)<div class="thumbs" id="st-photos"></div></div>'+
    '<label class="field">Nutrient units on your report<select id="st-unit"><option value="ppm"'+(!t||t.unit!=="lb/acre"?' selected':'')+'>ppm (parts per million)</option><option value="lb/acre"'+(t&&t.unit==="lb/acre"?' selected':'')+'>lb/acre</option></select></label>';
  groups.forEach(function(g){
    h+='<h3 class="sub-h">'+esc(g)+'</h3><div class="soil-grid">'+SOIL_FIELDS.filter(function(f){return f.g===g}).map(function(f){var v=t?soilVal(f,t):null;return '<label class="field">'+esc(f.l)+(f.u?' <span class="m">('+esc(f.u)+')</span>':'')+'<input type="number" step="any" inputmode="decimal" data-soil="'+f.k+'" value="'+esc(v==null?"":v)+'"></label>'}).join("")+'</div>';
  });
  h+='<h3 class="sub-h">Lab recommendations</h3><label class="field">Lime<input type="text" id="st-lime" maxlength="120" value="'+esc(t&&t.lime||"")+'" placeholder="e.g. 50 lb per 1,000 sq ft"></label>'+
    '<label class="field">Fertilizer<input type="text" id="st-fert" maxlength="160" value="'+esc(t&&t.fert||"")+'" placeholder="e.g. 1 lb N per 1,000 sq ft in Sept and Nov"></label>'+
    '<label class="field">Other notes<textarea id="st-notes" rows="2" maxlength="400">'+esc(t&&t.notes||"")+'</textarea></label>'+
    '<p class="err" id="st-err" role="alert"></p><div class="actions">'+(t?'<button class="btn ghost" data-act="soil-del" data-id="'+esc(t.id)+'" style="margin-right:auto">Delete</button>':'')+'<button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn primary" data-act="soil-save">Save soil test</button></div></div>';
  document.getElementById("sheet").innerHTML=h;document.addEventListener("keydown",onKey);renderSoilPhotos();
}
function renderSoilPhotos(){
  var box=document.getElementById("st-photos");if(!box)return;
  box.innerHTML=soilPhotos.map(function(id,i){return '<span class="thumb-wrap">'+pimg(id,"thumb","Report photo "+(i+1))+'<button type="button" class="thumb-x" data-act="soil-photo-x" data-i="'+i+'" aria-label="Remove photo">\u00d7</button></span>'}).join("")+
    (soilPhotos.length<4?'<label class="thumb thumb-add">Take photo<input type="file" accept="image/*" capture="environment" class="vh" data-act="soil-photo" aria-label="Photograph the report"></label><label class="thumb thumb-add">From gallery<input type="file" accept="image/*" class="vh" data-act="soil-photo" aria-label="Choose a report photo"></label>':'');
  hydrate();
}
function addSoilPhoto(file){var id="p_"+uid();shrink(file).then(function(b){return photoPut(id,b)}).then(function(){soilPhotos.push(id);newUploads.push(id);renderSoilPhotos()}).catch(function(){var e=document.getElementById("st-err");if(e)e.textContent="Couldn\u2019t add that photo."})}
function saveSoil(){
  var vals={},any=false,err=document.getElementById("st-err");
  document.querySelectorAll("[data-soil]").forEach(function(inp){var v=inp.value.trim();if(v!==""){var n=parseFloat(v);if(!isNaN(n)){vals[inp.dataset.soil]=n;any=true}}});
  var lime=document.getElementById("st-lime").value.trim(),fert=document.getElementById("st-fert").value.trim(),notes=document.getElementById("st-notes").value.trim();
  if(!any&&!lime&&!fert&&!notes&&!soilPhotos.length){err.textContent="Enter at least one result from your report, or add a photo of it.";return}
  var ar=document.getElementById("st-area"),rec={date:document.getElementById("st-date").value||todayISO(),lab:document.getElementById("st-lab").value.trim(),area:ar?ar.value:"",unit:document.getElementById("st-unit").value,vals:vals,lime:lime,fert:fert,notes:notes,photos:soilPhotos.slice()};
  var ex=soilEdit?soilTests().find(function(x){return x.id===soilEdit}):null;
  if(ex){(ex.photos||[]).forEach(function(id){if(rec.photos.indexOf(id)<0)dropPhoto(id,ex.id)});Object.assign(ex,rec)}else soilTests().push(Object.assign({id:"st_"+uid()},rec));
  newUploads=[];closeSheet();soilView="soil";persist();setStatus("Soil test saved");
}
function showSoil(id){
  var t=soilTests().find(function(x){return x.id===id});if(!t)return;
  var prev=prevSoil(t),groups=[],h="";SOIL_FIELDS.forEach(function(f){if(groups.indexOf(f.g)<0)groups.push(f.g)});
  groups.forEach(function(g){
    var rows=SOIL_FIELDS.filter(function(f){return f.g===g&&soilVal(f,t)!=null});if(!rows.length)return;
    h+='<h3 class="sub-h">'+esc(g)+'</h3><div class="list">'+rows.map(function(f){
      var v=soilVal(f,t),pv=prev?soilVal(f,prev):null,ch="";
      if(pv!=null&&(prev.unit||"ppm")===(t.unit||"ppm")){var d=Math.round((v-pv)*100)/100;ch=d===0?'<span class="soil-ch">same as last test</span>':'<span class="soil-ch">'+(d>0?"\u25B2 up ":"\u25BC down ")+Math.abs(d)+' since '+esc(parse(prev.date).toLocaleDateString(undefined,{month:"short",year:"numeric"}))+'</span>'}
      return '<div class="item"><div class="grow"><div class="t">'+esc(f.l)+'</div>'+ch+'</div><div class="soil-v">'+esc(v)+' <span>'+esc(soilUnit(f,t))+'</span></div></div>';
    }).join("")+'</div>';
  });
  var recs=[["Lime",t.lime],["Fertilizer",t.fert],["Notes",t.notes]].filter(function(r){return r[1]});
  if(recs.length)h+='<h3 class="sub-h">Lab recommendations</h3><div class="settings-block">'+recs.map(function(r){return '<p><b>'+r[0]+':</b> '+esc(r[1])+'</p>'}).join("")+'</div>';
  if(t.photos&&t.photos.length)h+='<h3 class="sub-h">Report</h3><div class="row-thumbs big">'+t.photos.map(function(pid){return '<button class="rthumb" data-act="soil-photo-view" data-id="'+esc(pid)+'" aria-label="View report photo">'+pimg(pid)+'</button>'}).join("")+'</div>';
  document.getElementById("sheet").innerHTML='<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sv-title"><h2 id="sv-title">Soil test: '+esc(fmtLong(t.date))+'</h2><p class="m" style="margin:0 0 6px">'+esc((t.area||"Whole lawn")+(t.lab?", "+t.lab:""))+'</p>'+(h||'<p class="note">No results entered.</p>')+
    '<div class="actions" style="margin-top:14px"><button class="btn ghost" data-act="close-sheet" style="margin-right:auto">Close</button><button class="btn primary" data-act="soil-edit" data-id="'+esc(t.id)+'">Edit</button></div></div>';
  document.addEventListener("keydown",onKey);hydrate();
}

/* ---------- add a product: scan first, reuse what was entered last time ---------- */
function openAddProduct(cat){
  sheet2().innerHTML='<div class="scrim" data-act="prod-close"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="ap-title"><h2 id="ap-title" style="text-align:center">Add a Product</h2>'+
    '<p class="note" style="text-align:center">Scan the barcode first. If you\u2019ve entered this product before, TurfDiary fills in the application rate and the rest for you.</p>'+
    '<button class="btn primary big-btn" data-act="ap-scan" data-cat="'+esc(cat||"")+'">'+ICONS.barcode+'Scan the barcode</button>'+
    '<button class="btn big-btn" data-act="ap-type" data-cat="'+esc(cat||"")+'">Type it in instead</button>'+
    '<div class="actions" style="justify-content:center;margin-top:6px"><button class="btn ghost" data-act="prod-close">Cancel</button></div></div>';
}
function rememberProduct(p){if(!p||!p.upc)return;if(!state.upcMemory)state.upcMemory={};var m=Object.assign({},p);delete m.id;m.savedOn=m.savedOn||todayISO();state.upcMemory[normUpc(p.upc)]=m}
function addByBarcode(code,cat){
  var u=normUpc(code)||String(code||""),p=findByUpc(u);
  if(p){
    sheet2().innerHTML='<div class="scrim" data-act="prod-close"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="ap2-title"><p class="pc-match">\u2713 Already in your products</p><h2 id="ap2-title">'+esc(p.name)+'</h2>'+
      '<div class="pc-need"><div><b>Application rate:</b> '+esc(!hasRate(p)?"not entered yet":p.mode==="cover"?"1 "+pkgWord(p,1)+" covers "+fmtInt(p.cover)+" sq ft":(Math.round(p.rate*100)/100).toLocaleString()+" "+p.unit+" per 1,000 sq ft")+'</div>'+(p.pkgSize?'<div><b>Size:</b> '+esc(fmtAmt(p.pkgSize)+" "+pkgU(p))+'</div>':'')+(p.price!=null?'<div><b>Last price:</b> '+money(p.price)+'</div>':'')+(p.spreader?'<div><b>Spreader setting:</b> '+esc(p.spreader)+'</div>':'')+'</div>'+
      '<div class="actions" style="flex-wrap:wrap"><button class="btn ghost" data-act="prod-close" style="margin-right:auto">Done</button><button class="btn" data-act="prod-edit" data-id="'+esc(p.id)+'">Update details</button><button class="btn primary" data-act="pc-log" data-name="'+esc(p.name)+'">Log Work With It</button></div></div>';
    return;
  }
  var mem=state.upcMemory&&state.upcMemory[u];
  if(mem){openProduct(null,"",u,cat,mem,"Filled in from the last time you saved this product"+(mem.savedOn?" ("+fmt(mem.savedOn)+")":"")+". Check the label if anything has changed, then save.");return}
  openProduct(null,"",u,cat,null,"New barcode. Enter the application rate from the label once, and next time a scan fills it in for you.");
}

/* ---------- scanning a barcode while logging work ---------- */
var CAT_WORK={"Fertilizer":"Fertilize","Biostimulant":"Fertilize","Lime":"Fertilize","Weed control":"Weed control","Pre-emergent":"Weed control","Fungicide":"Fungicide","Insecticide":"Insecticide","Grass seed":"Overseed"};
var fillAfterSave=false;
function pickTaskChip(task){var c=document.querySelector('.sheet [data-act="pick-task"][data-task="'+task+'"]');if(c&&c.getAttribute("aria-pressed")!=="true")c.click()}
function fillLogProduct(p){
  if(!document.getElementById("f-product")){return}
  if(sheetMode==="expense"){var ec=expCat(p);if(!sheetTasks.length)pickTaskChip(ec)}
  else{var t=CAT_WORK[prodCat(p)],had=sheetTasks.length;if(t&&sheetTasks.indexOf(t)<0&&(!had||(had===1&&!document.getElementById("f-product").value))){pickTaskChip(t);if(had)var added=t}}
  if(sheetTasks.length>1){
    readMulti();var t2=CAT_WORK[prodCat(p)],target=sheetTasks.indexOf(t2)>=0?t2:sheetTasks.find(function(x){return !(multiVals[x]&&multiVals[x].p)})||sheetTasks[0];
    multiVals[target]=multiVals[target]||{};multiVals[target].p=p.name;var cg=costGuess(target,p.name);if(cg!=null&&!multiVals[target].c)multiVals[target].c=String(cg);
    var mf=document.getElementById("multi-fields");if(mf)mf.innerHTML="";renderTaskFields();
  }else{
    var fi=document.getElementById("f-product");fi.value=p.name;fi.dataset.auto="";var an=document.getElementById("auto-note");if(an)an.innerHTML="";
    var fc=document.getElementById("f-cost");if(fc&&(!fc.value||fc.dataset.auto==="1")){var g=sheetMode==="expense"?(p.price!=null?p.price:null):costGuess(sheetTasks[0],p.name);fc.value=g!=null?g:"";fc.dataset.auto=g!=null?"1":""}
    updateCalc(fi);updateMoreSum();
  }
  setStatus(typeof added!=="undefined"&&added?"Added "+added+" for "+p.name:"Scanned: "+p.name);
}
function logScanResult(code){
  var u=normUpc(code)||String(code||""),p=findByUpc(u);
  if(p){fillLogProduct(p);return}
  var mem=state.upcMemory&&state.upcMemory[u];fillAfterSave=true;
  if(mem)openProduct(null,"",u,null,mem,"You\u2019ve used this product before. Its details are filled in from last time. Check the label if anything changed, then save.");
  else openProduct(null,"",u,null,null,"New product. Enter its application rate from the label once. Next time, scanning it fills everything in.");
}

/* ---------- views ---------- */
function ordinal(n){var s=["th","st","nd","rd"],v=n%100;return n+(s[(v-20)%10]||s[v]||s[0])}
function tally(e){
  if(e.kind==="expense")return "Purchase"+(e.store?" at "+cleanStore(e.store):"");
  var y=e.date.slice(0,4),idx=state.entries.indexOf(e),n=0,spent=0;
  state.entries.forEach(function(x,i){
    if(x.task!==e.task||x.date.slice(0,4)!==y||x.kind==="expense")return;
    if(x.date<e.date||(x.date===e.date&&i<=idx)){n++;spent+=x.cost||0}
  });
  return ordinal(n)+" "+e.task.toLowerCase()+" in "+y+(spent?", "+money(spent)+" spent so far":"");
}
function entryRow(e,del){
  var d=parse(e.date);
  return '<div class="item"><div class="date"><span>'+d.getDate()+'</span><small>'+esc(d.toLocaleDateString(undefined,{month:"short"}))+'</small></div>'+
    '<div class="grow"><div class="t task-name">'+esc(e.task)+'</div><div class="tally">'+esc(tally(e))+'</div>'+(e.product?'<div class="prod">'+esc(e.product)+'</div>':'')+(e.area?'<div class="m">Area: '+esc(e.areas?areaLabel(e.areas):titleCase(e.area))+'</div>':'')+(e.soilTemp!=null?'<div class="m">Soil '+esc(e.soilTemp)+'\u00b0F</div>':'')+(e.weather?'<div class="m">Weather: '+esc(e.weather)+'</div>':'')+(e.note?'<div class="m">'+esc(e.note)+'</div>':'')+
    (del&&e.kind!=="expense"?'<button class="btn mini again3 again-under" data-act="log-again" data-id="'+esc(e.id)+'" aria-label="Log '+esc(e.task)+' again today">'+ICONS.repeat+'Again</button>':'')+
    (e.photos&&e.photos.length?'<div class="row-thumbs">'+e.photos.map(function(id,i){return '<button class="rthumb" data-act="view-photo" data-id="'+esc(id)+'" aria-label="View '+esc(e.task)+' photo '+(i+1)+'">'+pimg(id)+'</button>'}).join("")+'</div>':'')+'</div>'+
    (e.cost?'<div class="cost">'+money(e.cost)+'</div>':'')+

    (del?'<div class="row-acts"><button class="btn small" data-act="edit-entry" data-id="'+esc(e.id)+'" aria-label="Edit '+esc(e.task)+' on '+esc(fmt(e.date))+'">Edit</button><button class="btn small ghost" data-act="del-entry" data-id="'+esc(e.id)+'" aria-label="Delete '+esc(e.task)+' on '+esc(fmt(e.date))+'">Delete</button></div>':'')+'</div>';
}
function lastProduct(task){var best=null;state.entries.forEach(function(e){if(e.task===task&&e.kind!=="expense"&&(!best||e.date>best.date))best=e});return best&&best.product?best.product:""}
function dueBase(s){var last=lastDone(s.task),sk=s.skip&&s.skip.base;return sk&&(!last||sk>last)?sk:last}
function dueItems(){
  var t=todayISO();
  return state.schedules.map(function(s){
    var every=Math.max(1,+s.every||7),last=lastDone(s.task),base=dueBase(s),diff,label,cls="",meta;
    if(!base){diff=-1e9;label="Not Logged Yet";cls="soon";meta="Every "+every+" "+pl(every,"day")}
    else{
      var due=addDays(base,every);diff=daysBetween(t,due);
      if(diff<0){label=(-diff)+" "+(diff===-1?"Day":"Days")+" Overdue";cls="over"}
      else if(diff===0){label="Due Today";cls="over"}
      else if(diff<=2){label="Due In "+diff+" "+(diff===1?"Day":"Days");cls="soon"}
      else label="Due "+fmtWeekday(due);
      var lp=lastProduct(s.task);
      meta="Every "+every+" "+pl(every,"day")+(last?", last done "+fmt(last)+(lp?" with "+lp:""):"")+(base!==last?" (skipped once)":"");
    }
    return{task:s.task,diff:diff,label:label,cls:cls,meta:meta};
  });
}
function allPhotos(){
  var out=[];
  state.entries.slice().sort(function(a,b){return a.date<b.date?-1:a.date>b.date?1:0}).forEach(function(e){(e.photos||[]).forEach(function(id){out.push({id:id,e:e})})});
  return out;
}
function viewHome(){
  var t=todayISO(),last=lastDone("Mow"),big,sub,yr=t.slice(0,4);
  if(!last){big="Not Yet";sub="No mows logged yet"}
  var bigN="";
  if(last){var n0=daysBetween(last,t);if(n0>1)bigN=String(n0)}
  else{}
  if(last){var n=daysBetween(last,t);big=n<=0?"Today":n===1?"Yesterday":n+" Days Ago";sub=parse(last).toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"})}
  var ms=state.schedules.find(function(x){return x.task==="Mow"}),next="";
  if(ms&&dueBase(ms)){var due=addDays(dueBase(ms),Math.max(1,+ms.every||7)),dd=daysBetween(t,due);next=dd<0?(-dd)+" "+(dd===-1?"Day":"Days")+" Overdue":dd===0?"Next Mow: Today":dd===1?"Next Mow: Tomorrow":"Next Mow: "+fmtWeekday(due)}
  var sq=lawnSqft(),lf=lastDone("Fertilize"),spent=state.entries.reduce(function(a,e){return a+(e.date.slice(0,4)===yr&&e.cost>0?e.cost:0)},0);
  var fd=lf?daysBetween(lf,t):null,fertTxt=lf?(fd<=0?"Today":fd===1?"Yesterday":fd+" Days"):"Not Yet",fertNote=lf?(fd>1?"ago":"")+(lastProduct("Fertilize")?(fd>1?", ":"")+lastProduct("Fertilize"):""):"";
  var qm=state.entries.find(function(e){return e.task==="Mow"&&e.date===t&&e.quick});
  var mowBtn=qm?'<button class="mow-box done" data-act="undo-today" data-id="'+esc(qm.id)+'" aria-label="Undo today\u2019s mow">'+ICONS.mower+'<span>Undo</span></button>'
    :'<button class="mow-box mow-btn" data-act="done-today" data-task="Mow" aria-label="Log a mow for today">'+ICONS.mower+'<span>Mowed<br>Today</span></button>';
  function tile(act,extra,label,value,note){return '<button class="hero-tile" data-act="'+act+'"'+extra+'><span class="ht-l">'+esc(label)+'</span><span class="ht-v">'+esc(value)+'</span>'+(note?'<span class="ht-n">'+esc(note)+'</span>':'')+'</button>'}
  var h='<header class="app-head"><span class="app-name">TurfDiary</span><span class="head-right"><span class="head-date">'+esc(parse(t).toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"}))+'</span><button class="icon-btn" data-act="tab" data-tab="settings" aria-label="Settings">'+ICONS.gear+'</button></span></header>'+
    '<section class="hero"><div class="hero-main"><div class="hero-left"><span class="hero-label">Last Mow</span>'+
    '<div class="big">'+(bigN?'<span class="big-n">'+esc(bigN)+'</span><span class="big-u">Days Ago</span>':'<span class="big-w">'+esc(big)+'</span>')+'</div>'+(ms?'<div class="hero-row">'+(next?'<span class="hero-next'+(/Overdue/.test(next)?' late':'')+'">'+esc(next)+'</span>':'')+'</div>':'')+'</div>'+mowBtn+'</div>'+
    '<div class="hero-tiles">'+
      tile("tab",' data-tab="settings"',"Lawn",sq>0?fmtInt(sq):"Measure",sq>0?"sq ft":"Tap to Start")+
      tile("open-log",' data-task="Fertilize" aria-label="Log fertilizer. Last fertilized: '+esc(fertTxt+(fertNote?" "+fertNote:""))+'"',"Fertilized",fertTxt,fertNote)+
      tile("tab",' data-tab="spend"',"Spent",money(spent),"in "+yr)+
    '</div></section>';
  h=h.replace('</header>','</header>'+backupBanner());
  h+=wxCardHTML();
  h+='<div class="sec-head"><h2>Coming Up</h2><button class="btn mini" data-act="tab" data-tab="settings">Edit Reminders</button></div>';
  var items=dueItems();
  if(!items.length)h+='<p class="empty">No reminders set. <button class="link" data-act="tab" data-tab="settings">Add a reminder</button></p>';
  else h+='<div class="list">'+items.map(function(it){
    return '<div class="item"><button class="grow due-open" data-act="open-log" data-task="'+esc(it.task)+'" aria-label="Log '+esc(it.task)+' with details"><div class="t task-name">'+esc(it.task)+' <span class="chev" aria-hidden="true">\u203A</span></div><div class="s '+it.cls+'">'+esc(it.label)+'</div><div class="m">'+esc(it.meta)+'</div></button>'+
      (function(){var q=state.entries.find(function(e){return e.task===it.task&&e.date===todayISO()&&e.quick});
        var sc=state.schedules.find(function(x){return x.task===it.task}),skipped=sc&&sc.skip&&sc.skip.on===todayISO();
        return '<div class="row-acts">'+(q?'<button class="btn small ghost" data-act="undo-today" data-id="'+esc(q.id)+'" aria-label="Undo '+esc(it.task)+' logged today">Undo</button>':'<button class="btn small" data-act="done-today" data-task="'+esc(it.task)+'">Done Today</button>')+
          (q?'':skipped?'<button class="btn small ghost" data-act="unskip" data-task="'+esc(it.task)+'">Undo Skip</button>':'<button class="btn small ghost" data-act="skip-due" data-task="'+esc(it.task)+'" aria-label="Skip '+esc(it.task)+' this time">Skip</button>')+'</div>'})()+'</div>';
  }).join("")+'</div>';
  h+='<div class="sec-head"><h2>Recent</h2>'+(state.entries.length?'<button class="btn mini" data-act="tab" data-tab="history">See Full Diary</button>':'')+'</div>';
  var rec=sorted().slice(0,4);
  if(!rec.length)h+='<p class="empty">Nothing logged yet. Tap Log Work after your next job in the yard.</p>';
  else h+='<div class="list">'+rec.map(function(e){return entryRow(e,true)}).join("")+'</div>';
  var ph=allPhotos().reverse().slice(0,8);
  if(ph.length)h+='<h2>Progress Photos</h2><div class="row-thumbs big">'+ph.map(function(x){return '<button class="rthumb" data-act="view-photo" data-id="'+esc(x.id)+'" aria-label="View '+esc(x.e.task)+' photo from '+esc(fmt(x.e.date))+'">'+pimg(x.id)+'</button>'}).join("")+'</div>';
  return h;
}
function viewHistory(){
  var used=TASKS.filter(function(t){return state.entries.some(function(e){return e.task===t})});
  var h='<h1 class="page">Diary</h1><input type="search" class="search" data-act="diary-search" placeholder="Search products, notes or stores" aria-label="Search your diary" value="'+esc(diaryQ)+'"><div class="toolbar" style="margin-top:10px"><select data-act="hist-filter" aria-label="Show task"><option value="all">All tasks</option>'+
    used.map(function(t){return '<option'+(t===histFilter?' selected':'')+'>'+esc(t)+'</option>'}).join("")+'</select><button class="btn primary" data-act="open-log">Log Work</button></div>';
  return h+'<div id="diary-list">'+diaryListHTML()+'</div>';
}
function viewSpend(){
  var cy=new Date().getFullYear(),years=[];
  state.entries.forEach(function(e){var y=+e.date.slice(0,4);if(e.cost>0&&years.indexOf(y)<0)years.push(y)});
  if(years.indexOf(cy)<0)years.push(cy);years.sort(function(a,b){return b-a});
  if(years.indexOf(spendYear)<0)spendYear=cy;
  var ye=state.entries.filter(function(e){return e.cost>0&&+e.date.slice(0,4)===spendYear});
  var total=0,months=[0,0,0,0,0,0,0,0,0,0,0,0],byTask={};
  ye.forEach(function(e){total+=e.cost;months[+e.date.slice(5,7)-1]+=e.cost;byTask[e.task]=(byTask[e.task]||0)+e.cost});
  var h='<h1 class="page">Spending</h1><div class="toolbar" style="margin-bottom:10px"><select data-act="spend-year" aria-label="Year">'+
    years.map(function(y){return '<option'+(y===spendYear?' selected':'')+'>'+y+'</option>'}).join("")+'</select></div><div class="btn-pair"><button class="btn primary" data-act="add-expense">'+ICONS.plus+'Add Expense</button><button class="btn" data-act="rc-open">'+ICONS.receipt+'Scan Receipt</button></div>';
  if(!ye.length)return h+'<p class="empty">No costs logged in '+spendYear+'. Tap Add Expense, or add a cost when you log work.</p>';
  var second=spendYear===cy?{v:months[new Date().getMonth()],l:"This month"}:{v:total/12,l:"Average per month"};
  h+='<div class="stats"><div class="stat"><b>'+money(total)+'</b><span>Total in '+spendYear+'</span></div><div class="stat"><b>'+money(second.v)+'</b><span>'+second.l+'</span></div></div>';
  var max=Math.max.apply(null,months)||1;
  h+='<h2>By month</h2><div class="months" role="img" aria-label="Spending by month">'+months.map(function(v){return '<i style="height:'+(v/max*100)+'%" title="'+money(v)+'"></i>'}).join("")+'</div>';
  h+='<div class="mlabels">'+months.map(function(_,i){return '<span>'+esc(new Date(2000,i,1).toLocaleDateString(undefined,{month:"narrow"}))+'</span>'}).join("")+'</div>';
  var tasks=Object.keys(byTask).sort(function(a,b){return byTask[b]-byTask[a]}),tmax=byTask[tasks[0]];
  h+='<h2>By category</h2><div class="list">'+tasks.map(function(t){
    return '<div class="item"><div class="grow"><div style="display:flex;justify-content:space-between;gap:8px"><span class="t">'+esc(t)+'</span><span class="cost">'+money(byTask[t])+'</span></div><div class="bar"><span style="width:'+(byTask[t]/tmax*100)+'%"></span></div></div></div>';
  }).join("")+'</div>';
  h+='<h2>Expenses</h2><div class="list">'+ye.slice().sort(function(a,b){return a.date<b.date?1:a.date>b.date?-1:0}).map(function(e){return entryRow(e,true)}).join("")+'</div>';
  return h;
}
function viewRemind(){
  var h='<h1 class="page">Reminders</h1><p class="note">Set how often each job should happen. Coming up on Home lists them in this order. The home screen counts from the last time you logged it and flags what\u2019s due.</p>';
  if(state.schedules.length)h+='<div class="list">'+state.schedules.map(function(s,i){
    return '<div class="item"><div class="grow"><div class="t">'+esc(s.task)+'</div><label class="every">Every <input type="number" min="1" max="365" inputmode="numeric" value="'+esc(s.every)+'" data-act="sched-every" data-i="'+i+'" aria-label="Days between '+esc(s.task)+'"> days</label></div>'+
      '<button class="btn small ghost" data-act="del-sched" data-i="'+i+'">Remove</button></div>';
  }).join("")+'</div>';
  if(state.schedules.length)h+='<div class="toolbar" style="justify-content:flex-start;margin-top:12px"><button class="btn" data-act="cal-open">'+ICONS.calendar+'Add to My Calendar</button></div>';
  var free=TASKS.filter(function(t){return t!=="Supplies"&&!state.schedules.some(function(s){return s.task===t})});
  if(free.length)h+='<h2>Add a reminder</h2><div class="add"><select id="new-task" aria-label="Task">'+free.map(function(t){return '<option>'+esc(t)+'</option>'}).join("")+
    '</select><span>every</span><input id="new-every" type="number" min="1" max="365" inputmode="numeric" value="14" aria-label="Days"><span>days</span><button class="btn primary" data-act="add-sched">Add</button></div><p class="err" id="sched-err" role="alert"></p>';
  return h;
}
function viewSettings(){
  var h='<h1 class="page">Settings</h1><h2 style="margin-top:0">My lawn</h2>'+lawnHTML()+'<h2>Reminders</h2>'+viewRemind().replace('<h1 class="page">Reminders</h1>','').replace('<h2>Add a reminder</h2>','<h3 class="sub-h">Add a reminder</h3>')+'<h2>Notifications</h2>'+notifyHTML()+'<h2>Weather</h2>'+wxSettingsHTML()+'<h2>App lock</h2>'+lockHTML()+'<h2>Backup</h2><div class="settings-block"><p>Your log and photos are saved only on this phone. Save a backup file now and then, especially before switching phones. You can protect each backup with a password.</p>'+
     '<div class="toolbar" style="justify-content:flex-start"><button class="btn primary" data-act="export">Save Backup</button><label class="btn file-btn">Restore backup<input type="file" accept="application/json,.json" class="vh" data-act="import" aria-label="Choose a backup file to restore"></label></div>'+
     '<p class="err" id="backup-msg" role="status" style="margin-top:10px"></p></div>'+
     '<h2>Setup guide</h2><div class="settings-block"><p>Walk through weather, lawn size and reminders again.</p><button class="btn" data-act="onb-again">Run Setup Again</button></div>';
  return h;
}
var ICONS={
  home:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/></svg>',
  history:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 11.6c3.4-.7 6.6-.2 9.5 1.4 2.9-1.6 6.1-2.1 9.5-1.4v8.6c-3.4-.7-6.6-.2-9.5 1.4-2.9-1.6-6.1-2.1-9.5-1.4z"/><path d="M12 13v8"/><path d="M6.5 11.1c-.6-1.8-1.6-3.1-2.8-4"/><path d="M9.3 11.5c-.2-2.4-.8-4.6-1.8-6.5"/><path d="M12 12.4c.1-3.3-.2-6.4-.9-9.4"/><path d="M14.6 11.6c.5-2.4 1.4-4.6 2.7-6.4"/><path d="M17.4 11.1c.8-1.4 1.9-2.6 3.3-3.4"/></svg>',
  products:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8h12l-1 12H7z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/><path d="M9.5 13.5c1.5 1 3.5 1 5 0"/></svg>',
  spend:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="6" width="17" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M7 9.5v5M17 9.5v5"/></svg>',
  gear:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/></svg>',
  finger:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 11v3a6 6 0 0 1-1 3.3"/><path d="M8.5 9.5A3.5 3.5 0 0 1 15.5 10v2.5c0 2-.4 3.8-1.2 5.5"/><path d="M6 13.5V10a6 6 0 0 1 11.6-2"/><path d="M18 11.5V13c0 1.6-.2 3.1-.6 4.5"/><path d="M5 17c.6-1 1-2.2 1-3.5"/></svg>',
  calendar:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14h2M12 14h2M16 14h0"/></svg>',
  barcode:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6v12M7 6v12M10 6v12M13 6v12M17 6v12M20 6v12"/></svg>',
  repeat:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3l3 3-3 3"/><path d="M4 12V10a4 4 0 0 1 4-4h12"/><path d="M7 21l-3-3 3-3"/><path d="M20 12v2a4 4 0 0 1-4 4H4"/></svg>',
  plus:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  receipt:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21z"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>',
  mower:'<svg viewBox="0 0 32 24" aria-hidden="true"><path d="M17 12.5L27 2.5"/><path d="M25 1.5l3.5 3.5"/><path d="M3.5 17.5v-3.2a2 2 0 0 1 2-2H19l2.5 3v2.2"/><path d="M9 12.3V9.8h6v2.5"/><circle cx="7" cy="19" r="2.6"/><circle cx="18.5" cy="19" r="2.6"/><path d="M9.6 19h6.3"/><path d="M1.5 22.5h29" stroke-dasharray="1.5 2"/></svg>'
};
function viewProducts(){
  var seg='<div class="seg" role="tablist" aria-label="Products or soil tests"><button role="tab" data-act="prod-seg" data-v="products" aria-selected="'+(soilView!=="soil")+'">My Products</button><button role="tab" data-act="prod-seg" data-v="soil" aria-selected="'+(soilView==="soil")+'">Soil Tests'+(soilTests().length?' <span class="chip-sub">('+soilTests().length+')</span>':'')+'</button></div>';
  if(soilView==="soil")return '<h1 class="page">Products</h1>'+seg+'<div class="toolbar" style="justify-content:flex-start;margin:12px 0 10px"><button class="btn primary" data-act="soil-new">'+ICONS.plus+'Add Soil Test</button></div>'+soilListHTML();
  return '<h1 class="page">Products</h1>'+seg+'<div class="btn-pair" style="margin:10px 0 14px"><button class="btn primary" data-act="prod-new">'+ICONS.plus+'Add Product</button><button class="btn" data-act="scan-lookup">'+ICONS.barcode+'Scan Barcode</button></div>'+productsHTML();
}
function openPlus(){
  document.getElementById("sheet").innerHTML='<div class="scrim" data-act="close-sheet"></div><div class="sheet plus-sheet" role="dialog" aria-modal="true" aria-labelledby="plus-title"><h2 id="plus-title">Add</h2>'+
    '<div class="plus-grid"><button class="plus-opt plus-main" data-act="plus-log">'+ICONS.history+'<b>Log Work</b><span>Mowing, fertilizing and other yard jobs</span></button>'+
    '<button class="plus-opt" data-act="plus-prod"><b>Add a Product</b><span>Save its rate, price and barcode</span></button>'+
    '<button class="plus-opt" data-act="plus-scan"><b>Scan a Product</b><span>Check a bag and see how much you need</span></button>'+
    '<button class="plus-opt plus-wide" data-act="plus-exp"><b>Add an Expense</b><span>Supplies, equipment or other costs</span></button></div>'+
    '<div class="actions"><button class="btn ghost" data-act="close-sheet">Cancel</button></div></div>';
  document.addEventListener("keydown",onKey);
  var f=document.querySelector(".plus-opt");if(f)f.focus();
}
function render(){
  ensureData();
  var v=tab==="history"?viewHistory():tab==="spend"?viewSpend():tab==="products"?viewProducts():tab==="settings"?viewSettings():viewHome();
  function tb(id,label){return '<button data-act="tab" data-tab="'+id+'"'+(tab===id?' aria-current="page"':'')+'>'+ICONS[id]+'<span>'+label+'</span></button>'}
  document.getElementById("root").innerHTML='<main>'+v+'</main><nav class="tabs" aria-label="Sections"><div class="in">'+
    tb("home","Home")+tb("history","Diary")+'<button class="plus-btn" data-act="plus" aria-label="Add: log work, a product, a scan or an expense">'+ICONS.plus+'</button>'+tb("products","Products")+tb("spend","Spending")+'</div></nav>';
  hydrate();
}

/* ---------- log sheet ---------- */
function onKey(e){if(e.key==="Escape")closeSheet()}
function recentProducts(task){var seen=[],out=[];sorted().forEach(function(e){if(e.product&&(!task||e.task===task)&&seen.indexOf(e.product.toLowerCase())<0){seen.push(e.product.toLowerCase());out.push(e.product)}});return out}
function updateProductChips(){
  var box=document.getElementById("prod-chips");if(!box)return;
  var c=sheetTask&&(sheetMode==="expense"?(EXP_CATS.indexOf(sheetTask)>=0&&sheetTask):TASK_CAT[sheetTask]),list=sheetTask?suggestNames(sheetTask).slice(0,8):[];
  var dl=document.getElementById("prod-list");if(dl)dl.innerHTML=dlOptions(sheetTask);
  box.innerHTML=list.length?'<span class="m">'+(c?'Your '+esc(catLabel(sheetTask))+' products:':'Used before:')+'</span>'+list.map(function(p){return '<button type="button" class="chip small" data-act="pick-product" data-product="'+esc(p)+'">'+esc(p)+'</button>'}).join(""):(c?'<span class="m">No '+esc(catLabel(sheetTask))+' products saved yet.</span>':"");
}
var sheetTasks=[],multiVals={};
function readMulti(){var mf=document.getElementById("multi-fields");if(!mf)return;mf.querySelectorAll("[data-mt]").forEach(function(inp){var k=inp.dataset.mt;multiVals[k]=multiVals[k]||{};multiVals[k][inp.dataset.f]=inp.value})}
function renderTaskFields(){
  var sp=document.getElementById("single-prod"),sc=document.getElementById("single-cost"),mf=document.getElementById("multi-fields");if(!mf)return;
  var wasMulti=!!mf.innerHTML;readMulti();
  var fp=document.getElementById("f-product"),fc=document.getElementById("f-cost");
  if(sheetTasks.length>1){
    if(!wasMulti){var k=sheetTasks[0];if(fp.value||fc.value)multiVals[k]={p:fp.value,c:fc.value}}
    if(!editId&&sheetMode!=="expense")sheetTasks.forEach(function(t){if(!multiVals[t]){var lp=lastProduct(t),cg=lp?costGuess(t,lp):null;multiVals[t]={p:lp||"",c:cg!=null?String(cg):""}}});
    sp.hidden=true;sc.hidden=true;
    mf.innerHTML='<div class="field">Product and cost for each task (optional)'+sheetTasks.map(function(t){var v=multiVals[t]||{};
      return '<div class="mt-row"><div class="mt-name">'+esc(t)+'</div><datalist id="pl-'+sheetTasks.indexOf(t)+'">'+dlOptions(t)+'</datalist><input type="text" list="pl-'+sheetTasks.indexOf(t)+'" maxlength="80" autocomplete="off" placeholder="Product" aria-label="Product for '+esc(t)+'" data-mt="'+esc(t)+'" data-f="p" value="'+esc(v.p||"")+'"><input type="number" inputmode="decimal" step="0.01" min="0" placeholder="Cost" aria-label="Cost for '+esc(t)+'" data-mt="'+esc(t)+'" data-f="c" value="'+esc(v.c||"")+'"><div class="mt-calc calc">'+calcHTML(v.p||"",t)+'</div></div>';
    }).join("")+'</div>';
  }else{
    if(wasMulti&&sheetTasks.length===1){var v=multiVals[sheetTasks[0]];if(v){fp.value=v.p||"";fc.value=v.c||""}}
    mf.innerHTML="";sp.hidden=false;sc.hidden=false;
  }
  var btn=document.querySelector('[data-act="save-log"]');
  if(btn&&!editId&&sheetMode!=="expense")btn.textContent=sheetTasks.length>1?"Save "+sheetTasks.length+" entries":"Save entry";
}
var editId=null,sheetMode="log",formPhotos=[],origPhotos=[],newUploads=[],uploading=0;
function areaPickerHTML(area){
  var zs=zones();if(zs.length<2)return "";
  var sel=(Array.isArray(area)?area:area?[area]:[]).filter(function(z){return zs.indexOf(z)>=0});
  return '<fieldset><legend>Where in the yard? <span class="m" style="font-weight:500">(pick one or more)</span></legend><div class="chips">'+[""].concat(zs).map(function(z){return '<button type="button" class="chip" data-act="pick-area" data-zone="'+esc(z)+'" aria-pressed="'+(z?sel.indexOf(z)>=0:!sel.length)+'">'+esc(z?titleCase(z):"Whole Lawn")+' <span class="chip-sub">'+fmtInt(z?lawnSqft(z):lawnSqft())+'</span></button>'}).join("")+'</div></fieldset>';
}
function knownStores(){var out=[];state.entries.forEach(function(e){var c=e.store?cleanStore(e.store):"";if(c&&out.indexOf(c)<0)out.push(c)});return out}
function cleanStore(raw){
  var r=String(raw||"").toUpperCase(),known=[["LOWE","Lowe\u2019s"],["HOME DEPOT","The Home Depot"],["WALMART","Walmart"],["WAL-MART","Walmart"],["SITEONE","SiteOne"],["TRACTOR SUPPLY","Tractor Supply"],["ACE HARDWARE","Ace Hardware"],["MENARDS","Menards"],["TARGET","Target"],["COSTCO","Costco"],["SAM'S CLUB","Sam\u2019s Club"],["CO-OP","Co-op"],["AMAZON","Amazon"]];
  for(var i=0;i<known.length;i++)if(r.indexOf(known[i][0])>=0)return known[i][1];
  var t=String(raw||"").trim();return (t===t.toUpperCase()?titleCase(t.toLowerCase()):t).slice(0,40);
}
function openSheet(task,cost,note,product,date,id,mode,photos,soilTemp,area,store){
  sheetAreas=(Array.isArray(area)?area:area?[area]:[]).filter(function(z){return zones().indexOf(z)>=0});
  if(soilTemp===undefined||soilTemp==="")soilTemp=null;
  formPhotos=(photos||[]).slice();origPhotos=formPhotos.slice();newUploads=[];uploading=0;
  editId=id||null;sheetMode=mode||"log";var ex=sheetMode==="expense";
  sheetTask=task||null;sheetTasks=task?[task]:[];multiVals={};
  var multiOK=!editId&&!ex;
  var costHTML='<div id="single-cost"><label class="field">'+(ex?"Amount":"Cost")+'<input type="number" id="f-cost" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="'+esc(cost||"")+'"></label></div>';
  var openMore=!!editId&&!!((cost&&+cost>0)||note||soilTemp!=null||(photos&&photos.length));
  document.getElementById("sheet").innerHTML='<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">'+
    '<h2 id="sheet-title">'+(editId?"Edit Entry":ex?"Add Expense":"Log Work")+'</h2>'+
    (editId?'':'<button type="button" class="btn big-btn scan-top" data-act="scan-into-log">'+ICONS.barcode+'Scan a Product Barcode</button>'+(ex?'<button type="button" class="btn big-btn scan-top" data-act="rc-open">'+ICONS.receipt+'Scan a Receipt</button><p class="m scan-top-note">Scan one product, or a whole receipt to add every item at once.</p>':'<p class="m scan-top-note">Scan the bag or bottle you used. TurfDiary fills in the product, picks the task and shows the amount for your lawn.</p>'))+
    '<fieldset><legend>'+(ex?"What did you buy?":multiOK?"Tasks (pick one or more)":"Task")+'</legend><div class="chips">'+(ex?EXP_CATS.concat(task&&EXP_CATS.indexOf(task)<0?[task]:[]):TASKS).map(function(t){return '<button type="button" class="chip" data-act="pick-task" data-task="'+esc(t)+'" aria-pressed="'+(t===sheetTask)+'">'+esc(t)+'</button>'}).join("")+'</div></fieldset>'+
    (ex?'':areaPickerHTML(area))+
    '<div id="single-prod"><label class="field">'+(ex?"Product name":"Product used (optional)")+'<div class="unit-row"><input type="text" id="f-product" list="prod-list" maxlength="80" autocomplete="off" placeholder="e.g. LESCO Dimension, Kentucky 31 seed" value="'+esc(product||"")+'"><button type="button" class="btn small" data-act="scan-into-log" aria-label="Scan a product barcode">Scan</button></div></label>'+
    '<datalist id="prod-list">'+productNames().map(function(p){return '<option value="'+esc(p)+'">'}).join("")+'</datalist>'+
    '<div class="auto-note" id="auto-note"></div><div class="calc" id="prod-calc"></div><div class="chips prod-chips" id="prod-chips"></div></div><div id="multi-fields"></div>'+
    (ex?'<label class="field">Store<input type="text" id="f-store" list="store-list" maxlength="40" autocapitalize="words" autocomplete="off" placeholder="Where you bought it, like Lowe\u2019s" value="'+esc(store||"")+'"></label><datalist id="store-list">'+knownStores().map(function(x){return '<option value="'+esc(x)+'">'}).join("")+'</datalist>':'')+
    '<label class="field">Date<input type="date" id="f-date" value="'+esc(date||todayISO())+'"></label>'+
    (ex?costHTML:'')+
    '<details class="more" id="more-box"'+(openMore?' open':'')+'><summary>More details<span id="more-sum"></span></summary>'+
    (ex?'':costHTML)+
    (ex?'':'<label class="field">Soil temperature, \u00b0F<input type="number" id="f-soil" inputmode="decimal" step="0.1" min="-20" max="130" placeholder="From your thermometer" value="'+esc(soilTemp==null?"":soilTemp)+'"></label>')+
    '<div id="photo-field"></div>'+
    '<label class="field">Notes<textarea id="f-note" rows="2" maxlength="300" placeholder="Mower height, weather, how it went\u2026">'+esc(note||"")+'</textarea></label></details>'+
    '<p class="err" id="f-err" role="alert"></p><div class="actions"><button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn primary" data-act="save-log">'+(editId?"Save changes":ex?"Save expense":"Save entry")+'</button></div></div>';
  document.addEventListener("keydown",onKey);
  updateProductChips();renderPhotoField();refreshAllCalcs();
  if(task&&!editId&&!ex)autoFill();
  updateMoreSum();
  var f=document.querySelector('.chip[aria-pressed="true"]')||document.querySelector(".chip");if(f)f.focus();
}
function closeSheet(){
  if(ONB){ONB=0;state.onboarded=true;saveQuiet()}
  newUploads.forEach(photoDel);newUploads=[];
  document.getElementById("sheet").innerHTML="";document.removeEventListener("keydown",onKey);
}
function renderPhotoField(){
  var box=document.getElementById("photo-field");if(!box)return;setTimeout(updateMoreSum,0);
  box.innerHTML='<div class="field">Photos<div class="thumbs">'+formPhotos.map(function(id,i){
    return '<span class="thumb-wrap">'+pimg(id,"thumb","Photo "+(i+1))+'<button type="button" class="thumb-x" data-act="remove-photo" data-i="'+i+'" aria-label="Remove photo '+(i+1)+'">\u00d7</button></span>';
  }).join("")+(uploading?'<span class="thumb thumb-busy">Adding\u2026</span>':'')+
  (formPhotos.length+uploading<6?'<label class="thumb thumb-add">Take photo<input type="file" accept="image/*" capture="environment" class="vh" data-act="add-photo" aria-label="Take a photo with your camera"></label><label class="thumb thumb-add">From gallery<input type="file" accept="image/*" multiple class="vh" data-act="add-photo" aria-label="Add photos from your gallery"></label>':'')+'</div></div>';
  hydrate();
}
function shrink(file){
  return new Promise(function(res){
    var url,img=new Image();
    try{url=URL.createObjectURL(file)}catch(e){res(file);return}
    img.onload=function(){
      try{
        var max=1600,w=img.naturalWidth,h=img.naturalHeight,k=Math.min(1,max/Math.max(w,h)),c=document.createElement("canvas");
        c.width=Math.round(w*k);c.height=Math.round(h*k);c.getContext("2d").drawImage(img,0,0,c.width,c.height);
        URL.revokeObjectURL(url);c.toBlob(function(b){res(b||file)},"image/jpeg",0.82);
      }catch(e){res(file)}
    };
    img.onerror=function(){URL.revokeObjectURL(url);res(file)};
    img.src=url;
  });
}
function addPhotos(files){
  var err=document.getElementById("f-err");
  Array.prototype.slice.call(files,0,Math.max(0,6-formPhotos.length-uploading)).forEach(function(f){
    uploading++;renderPhotoField();
    var id="p_"+uid();
    shrink(f).then(function(b){return photoPut(id,b)}).then(function(){
      if(document.getElementById("photo-field")){formPhotos.push(id);newUploads.push(id)}else photoDel(id);
    }).catch(function(){
      if(err)err.textContent="Couldn\u2019t add that photo. Your phone may be low on storage.";
    }).then(function(){uploading--;renderPhotoField()});
  });
}
var viewerList=[],viewerIdx=0;
function openViewer(id){viewerList=allPhotos();var i=-1;viewerList.forEach(function(x,j){if(x.id===id)i=j});if(i>=0)showViewer(i)}
function showViewer(i){
  viewerIdx=i;var it=viewerList[i];
  document.getElementById("sheet").innerHTML='<div class="scrim" data-act="close-sheet"></div><div class="sheet viewer" role="dialog" aria-modal="true" aria-labelledby="v-title">'+
    '<h2 id="v-title">'+esc(it.e.task)+'</h2><p class="m">'+esc(fmtLong(it.e.date)+(it.e.product?", "+it.e.product:""))+'</p>'+
    pimg(it.id,"full",it.e.task+" photo from "+fmtLong(it.e.date))+
    '<div class="actions" style="justify-content:space-between;align-items:center"><button class="btn" data-act="viewer-prev"'+(i===0?' disabled':'')+'>Older</button><span class="m">'+(i+1)+' of '+viewerList.length+'</span><button class="btn" data-act="viewer-next"'+(i===viewerList.length-1?' disabled':'')+'>Newer</button></div>'+
    '<div class="actions" style="margin-top:10px"><button class="btn ghost" data-act="close-sheet">Close</button></div></div>';
  document.addEventListener("keydown",onKey);hydrate();
}
function saveLog(){
  var err=document.getElementById("f-err");
  if(!sheetTasks.length){err.textContent=sheetMode==="expense"?"Pick what you bought, like Fertilizer or Tools & parts.":"Pick a task to save this entry.";return}
  var date=document.getElementById("f-date").value||todayISO();
  var raw=document.getElementById("f-cost").value.trim(),cost=0;
  if(raw){cost=parseFloat(raw);if(isNaN(cost)||cost<0){var mb=document.getElementById("more-box");if(mb)mb.open=true;err.textContent="Enter the cost as a number, like 24.99.";return}}
  if(sheetMode==="expense"&&!(cost>0)){err.textContent="Enter the amount you spent, like 24.99.";return}
  if(uploading){err.textContent="Wait for your photos to finish adding.";return}
  var sEl=document.getElementById("f-soil"),soilV=null;
  if(sEl&&sEl.value.trim()){soilV=parseFloat(sEl.value);if(isNaN(soilV)||soilV<-20||soilV>130){err.textContent="Enter the soil temperature in \u00b0F, like 54.";return}soilV=Math.round(soilV*10)/10}
  if(sheetTasks.length>1){
    readMulti();
    var recs=[],note=document.getElementById("f-note").value.trim().slice(0,300);
    for(var mi=0;mi<sheetTasks.length;mi++){
      var t=sheetTasks[mi],v=multiVals[t]||{},c=0;
      if(v.c&&String(v.c).trim()){c=parseFloat(v.c);if(isNaN(c)||c<0){err.textContent="Enter the cost for "+t+" as a number, like 24.99.";return}}
      recs.push({id:uid()+mi,date:date,task:t,cost:Math.round(c*100)/100,note:note,product:String(v.p||"").trim().slice(0,80),photos:formPhotos.slice(),soilTemp:soilV,areas:selAreas().length?selAreas():undefined,area:selAreas().length?areaLabel(selAreas()):undefined,weather:date===todayISO()?wxNowText():""});
    }
    newUploads=[];
    recs.forEach(function(r){state.entries.push(r)});
    setStatus(recs.length+" tasks logged");closeSheet();persist();return;
  }
  var stEl=document.getElementById("f-store");
  var rec={kind:sheetMode==="expense"?"expense":undefined,store:sheetMode==="expense"&&stEl&&stEl.value.trim()?cleanStore(stEl.value.trim()):undefined,areas:sheetMode!=="expense"&&selAreas().length?selAreas():undefined,area:sheetMode!=="expense"&&selAreas().length?areaLabel(selAreas()):undefined,date:date,task:sheetTask,cost:Math.round(cost*100)/100,note:document.getElementById("f-note").value.trim().slice(0,300),product:document.getElementById("f-product").value.trim().slice(0,80),photos:formPhotos.slice()};
  if(sheetMode!=="expense"){rec.soilTemp=soilV;if(!editId&&date===todayISO()&&wxNowText())rec.weather=wxNowText()}
  origPhotos.forEach(function(id){if(formPhotos.indexOf(id)<0)dropPhoto(id,editId)});
  newUploads=[];
  var ex=editId?state.entries.find(function(x){return x.id===editId}):null;
  if(ex){Object.assign(ex,rec);delete ex.quick}else state.entries.push(Object.assign({id:uid()},rec));
  closeSheet();persist();
  if(rec.kind==="expense"&&!editId&&rec.product)promptNewProducts([{name:rec.product,cat:rec.task,price:rec.cost>0?rec.cost:null}]);
}
/* new purchases: offer to save them to My Products (rates can be added later) */
var NP=[];
function prodCatFromExp(c){return CATS.indexOf(c)>=0&&c!=="Other"?c:"Other"}
function promptNewProducts(items){
  var declined=state.npDeclined||[];
  NP=items.filter(function(it){var n=(it.name||"").trim();return n&&n.toLowerCase()!=="sales tax"&&!findProduct(n)&&!(it.upc&&findByUpc(it.upc))&&declined.indexOf(n.toLowerCase())<0}).map(function(it){return{name:it.name.trim(),cat:prodCatFromExp(it.cat),price:it.price,upc:it.upc||null,on:true}});
  if(!NP.length)return;
  var one=NP.length===1;
  sheet2().innerHTML='<div class="scrim" data-act="np-no"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="np-title"><h2 id="np-title">'+(one?"Add to My Products?":"Add these to My Products?")+'</h2>'+
    '<p class="note">'+(one?'<b>'+esc(NP[0].name)+'</b> isn\u2019t in your products yet.':'These items aren\u2019t in your products yet.')+' Saving '+(one?'it':'them')+' lets TurfDiary match '+(one?'it':'them')+' on future receipts and scans. You can add the application rate and other details later from the Products tab.</p>'+
    (one?'':'<div class="list" style="margin-bottom:12px">'+NP.map(function(it,i){return '<label class="item onb-row"><input type="checkbox" data-np="'+i+'" checked><span class="grow"><span class="t">'+esc(it.name)+'</span><span class="m" style="display:block">'+esc(titleCase(it.cat))+(it.price!=null?", "+money(it.price):"")+'</span></span></label>'}).join("")+'</div>')+
    '<div class="actions" style="flex-wrap:wrap"><button class="btn ghost" data-act="np-no" style="margin-right:auto">Not Now</button>'+(one?'<button class="btn" data-act="np-details">Add Details Now</button>':'')+'<button class="btn primary" data-act="np-yes">'+(one?"Add to My Products":"Add Selected")+'</button></div></div>';
}
function npSave(details){
  var added=0,first=null;
  NP.forEach(function(it,i){var cb=document.querySelector('[data-np="'+i+'"]');if(cb&&!cb.checked)return;
    var rec={id:"pr_"+uid(),name:capWords(it.name),cat:it.cat,mode:"rate",unit:"lb",rate:null,cover:null,pkgSize:null,pkgUnit:"lb",price:it.price!=null?Math.round(it.price*100)/100:null,upc:it.upc?normUpc(it.upc):null,spreader:""};
    if(findProduct(rec.name))return;state.products.push(rec);if(rec.upc)rememberProduct(rec);added++;if(!first)first=rec});
  closeSheet2();saveQuiet();render();
  if(details&&first){openProduct(first.id);return}
  setStatus(added?added+" "+pl(added,"product")+" added. Add rates anytime in Products":"Nothing added");
}



/* ---------- backup ---------- */
function blobToDataURL(b){return new Promise(function(res){var r=new FileReader();r.onload=function(){res(r.result)};r.onerror=function(){res(null)};r.readAsDataURL(b)})}
function backupMsg(t){var m=document.getElementById("backup-msg");if(m)m.textContent=t}
/* ---------- encryption helpers (Web Crypto, all on the phone) ---------- */
function b64(buf){var b=new Uint8Array(buf),s="",i;for(i=0;i<b.length;i+=0x8000)s+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000));return btoa(s)}
function unb64(str){var s=atob(str),b=new Uint8Array(s.length);for(var i=0;i<s.length;i++)b[i]=s.charCodeAt(i);return b}
function deriveKey(pass,salt,iters){var enc=new TextEncoder();return crypto.subtle.importKey("raw",enc.encode(pass),"PBKDF2",false,["deriveKey"]).then(function(k){return crypto.subtle.deriveKey({name:"PBKDF2",salt:salt,iterations:iters,hash:"SHA-256"},k,{name:"AES-GCM",length:256},false,["encrypt","decrypt"])})}
function encryptText(text,pass){
  var salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),iters=210000;
  return deriveKey(pass,salt,iters).then(function(key){return crypto.subtle.encrypt({name:"AES-GCM",iv:iv},key,new TextEncoder().encode(text))})
    .then(function(ct){return JSON.stringify({app:"turfdiary",encrypted:true,v:1,kdf:"PBKDF2-SHA256",iters:iters,salt:b64(salt),iv:b64(iv),data:b64(ct)})});
}
function decryptText(obj,pass){
  return deriveKey(pass,unb64(obj.salt),obj.iters||210000).then(function(key){return crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(obj.iv)},key,unb64(obj.data))}).then(function(pt){return new TextDecoder().decode(pt)});
}
function openBackupSheet(){
  document.getElementById("sheet").innerHTML='<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="bk-title"><h2 id="bk-title">Save a backup</h2>'+
    '<p class="note">The backup file has your whole diary, products, spending and photos. Add a password so nobody else can open it if the file ends up somewhere you didn\u2019t intend.</p>'+
    '<label class="field">Password (recommended)<input type="password" id="bk-pass" autocomplete="new-password" placeholder="At least 6 characters"></label>'+
    '<label class="field">Type it again<input type="password" id="bk-pass2" autocomplete="new-password"></label>'+
    '<p class="m" style="margin-top:-4px">Write it down somewhere safe. Without it, a protected backup can\u2019t be restored, and there\u2019s no way to recover it.</p>'+
    '<p class="err" id="bk-err" role="alert"></p><div class="actions"><button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn primary" data-act="bk-save">Save Backup</button></div></div>';
  document.addEventListener("keydown",onKey);document.getElementById("bk-pass").focus();
}
function bkSave(){
  var p1=document.getElementById("bk-pass").value,p2=document.getElementById("bk-pass2").value,err=document.getElementById("bk-err");
  if(p1||p2){if(p1.length<6){err.textContent="Use at least 6 characters, or leave both boxes empty to save without a password.";return}if(p1!==p2){err.textContent="The two passwords don\u2019t match.";return}}
  else if(!document.getElementById("bk-err").dataset.ok){err.dataset.ok="1";err.textContent="Save without a password? Anyone with the file could open it. Tap Save backup again to continue.";return}
  closeSheet();exportBackup(p1||null);
}
function exportBackup(pass){
  backupMsg("Preparing backup\u2026");setStatus(pass?"Encrypting your backup\u2026":"Preparing backup\u2026");
  var ids=allPhotos().map(function(x){return x.id}),photos={};(state.soilTests||[]).forEach(function(t){(t.photos||[]).forEach(function(id){if(ids.indexOf(id)<0)ids.push(id)})});
  ids.reduce(function(p,id){return p.then(function(){return photoGet(id).then(function(b){return b?blobToDataURL(b):null}).then(function(d){if(d)photos[id]=d})})},Promise.resolve())
  .then(function(){
    var data=JSON.stringify({app:"turfdiary",version:1,exported:new Date().toISOString(),state:state,photos:photos});
    return pass?encryptText(data,pass):data;
  }).then(function(data){
    var a=document.createElement("a");a.href=URL.createObjectURL(new Blob([data],{type:"application/json"}));
    a.download="turfdiary-backup-"+todayISO()+(pass?"-protected":"")+".json";document.body.appendChild(a);a.click();
    setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},2000);
    backupMsg(pass?"Password-protected backup saved to your downloads.":"Backup saved to your downloads.");
    state.lastBackup=Date.now();state.backupSnooze=null;saveQuiet();setStatus(pass?"Protected backup saved":"Backup saved to your downloads");if(tab==="home")render();
  }).catch(function(){backupMsg("Couldn\u2019t create the backup. Try again.");setStatus("Couldn\u2019t create the backup")});
}
var pendingImport=null;
function readImport(file){
  var r=new FileReader();
  r.onload=function(){
    try{
      var j=JSON.parse(r.result);
      if(j&&j.app==="turfdiary"&&j.encrypted){pendingEnc=j;askBackupPass();return}
      showImportConfirm(j);
    }catch(e){backupMsg("That file isn\u2019t a TurfDiary backup.")}
  };
  r.readAsText(file);
}
var pendingEnc=null;
function askBackupPass(msg){
  document.getElementById("sheet").innerHTML='<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="ib-title"><h2 id="ib-title">Password-protected backup</h2>'+
    '<p class="note">Enter the password you used when you saved this backup.</p><label class="field">Password<input type="password" id="ib-pass" autocomplete="current-password"></label>'+
    '<p class="err" id="ib-err" role="alert">'+esc(msg||"")+'</p><div class="actions"><button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn primary" data-act="ib-open">Unlock backup</button></div></div>';
  document.addEventListener("keydown",onKey);document.getElementById("ib-pass").focus();
}
function ibOpen(){
  var pass=document.getElementById("ib-pass").value;if(!pass||!pendingEnc)return;
  document.getElementById("ib-err").textContent="Unlocking\u2026";
  decryptText(pendingEnc,pass).then(function(txt){var j=JSON.parse(txt);pendingEnc=null;showImportConfirm(j)}).catch(function(){askBackupPass("That password didn\u2019t work. Check it and try again.")});
}
function showImportConfirm(j){
    try{
      if(!j||(j.app!=="turfdiary"&&j.app!=="lawn-log")||!j.state||!Array.isArray(j.state.entries))throw new Error();
      pendingImport=j;
      document.getElementById("sheet").innerHTML='<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="i-title"><h2 id="i-title">Restore this backup?</h2>'+
        '<p class="note">It has '+j.state.entries.length+' '+pl(j.state.entries.length,"entry").replace("entrys","entries")+' and '+Object.keys(j.photos||{}).length+' photos. Restoring replaces everything currently in the app.</p>'+
        '<div class="actions"><button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn danger" data-act="confirm-import">Replace and restore</button></div></div>';
      document.addEventListener("keydown",onKey);
    }catch(e){backupMsg("That file isn\u2019t a TurfDiary backup.")}
}
function confirmImport(){
  var j=pendingImport;pendingImport=null;if(!j)return;
  closeSheet();backupMsg("Restoring\u2026");
  var ids=Object.keys(j.photos||{});
  ids.reduce(function(p,id){return p.then(function(){return fetch(j.photos[id]).then(function(r){return r.blob()}).then(function(b){return photoPut(id,b)})})},Promise.resolve())
  .then(function(){
    state=j.state;if(!Array.isArray(state.schedules))state.schedules=[];
    persist();backupMsg("Backup restored.");
  }).catch(function(){backupMsg("Couldn\u2019t restore all photos. Your phone may be low on storage.")});
}

/* ---------- events ---------- */
document.addEventListener("click",function(ev){
  var el=ev.target.closest("[data-act]");if(!el)return;var a=el.dataset.act;
  if(a==="tab"){tab=el.dataset.tab;try{localStorage.setItem(LS_TAB,tab)}catch(e){}render();window.scrollTo(0,0)}
  else if(a==="add-expense")openSheet(null,"","","","",null,"expense");
  else if(a==="open-log")openSheet(el.dataset.task);
  else if(a==="close-sheet")closeSheet();
  else if(a==="pick-task"){
    var tk=el.dataset.task;
    if(!editId&&sheetMode!=="expense"){var ti=sheetTasks.indexOf(tk);if(ti>=0)sheetTasks.splice(ti,1);else sheetTasks.push(tk)}
    else sheetTasks=[tk];
    sheetTask=sheetTasks[0]||null;
    document.querySelectorAll('[data-act="pick-task"]').forEach(function(c){c.setAttribute("aria-pressed",String(sheetTasks.indexOf(c.dataset.task)>=0))});
    document.getElementById("f-err").textContent="";updateProductChips();renderTaskFields();autoFill();
  }
  else if(a==="pick-product"){var pi=document.getElementById("f-product");if(pi){pi.value=el.dataset.product;updateCalc(pi);pi.focus()}}
  else if(a==="save-log")saveLog();
  else if(a==="done-today"){
    var task=el.dataset.task,t=todayISO();
    if(state.entries.some(function(e){return e.task===task&&e.date===t})){setStatus(task+" is already logged for today");return}
    state.entries.push({id:uid(),date:t,task:task,cost:0,note:"",product:"",photos:[],quick:true,weather:wxNowText()});setStatus(task+" logged for today");persist();
    if(el.classList.contains("mow-btn"))playMowAnim();
  }
  else if(a==="edit-entry"){var en=state.entries.find(function(x){return x.id===el.dataset.id});if(en)openSheet(en.task,en.cost||"",en.note,en.product,en.date,en.id,en.kind==="expense"?"expense":null,en.photos,en.soilTemp,en.areas||en.area,en.store)}
  else if(a==="view-photo")openViewer(el.dataset.id);
  else if(a==="viewer-prev"){if(viewerIdx>0)showViewer(viewerIdx-1)}
  else if(a==="viewer-next"){if(viewerIdx<viewerList.length-1)showViewer(viewerIdx+1)}
  else if(a==="remove-photo"){
    var ri=+el.dataset.i,rid=formPhotos[ri];formPhotos.splice(ri,1);
    var ni=newUploads.indexOf(rid);if(ni>=0){newUploads.splice(ni,1);photoDel(rid)}
    renderPhotoField();
  }
  else if(a==="del-entry"){
    var id=el.dataset.id,e=state.entries.find(function(x){return x.id===id});
    if(e){
      document.getElementById("sheet").innerHTML='<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="d-title"><h2 id="d-title">Delete this entry?</h2>'+
        '<p class="note">'+esc(e.task+(e.product?", "+e.product:"")+" on "+fmtLong(e.date))+'. This can\u2019t be undone.</p>'+
        '<div class="actions"><button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn danger" data-act="confirm-del" data-id="'+esc(id)+'">Delete</button></div></div>';
      document.addEventListener("keydown",onKey);
      var db=document.querySelector('[data-act="confirm-del"]');if(db)db.focus();
    }
  }
  else if(a==="confirm-del"){var did=el.dataset.id,de=state.entries.find(function(x){return x.id===did});if(de&&de.photos)de.photos.forEach(function(pid){dropPhoto(pid,did)});state.entries=state.entries.filter(function(x){return x.id!==did});closeSheet();persist()}
  else if(a==="undo-today"){var uid2=el.dataset.id,ue=state.entries.find(function(x){return x.id===uid2});if(ue){if(ue.photos)ue.photos.forEach(function(pid){dropPhoto(pid,uid2)});state.entries=state.entries.filter(function(x){return x.id!==uid2});setStatus(ue.task+" removed");persist()}}
  else if(a==="del-sched"){state.schedules.splice(+el.dataset.i,1);persist()}
  else if(a==="add-sched"){
    var n=parseInt(document.getElementById("new-every").value,10);
    if(!(n>=1&&n<=365)){var se=document.getElementById("sched-err");if(se)se.textContent="Enter a number of days from 1 to 365.";return}
    state.schedules.push({task:document.getElementById("new-task").value,every:n});persist();
  }
  else if(a==="export")openBackupSheet();
  else if(a==="bk-save")bkSave();
  else if(a==="lock-key")lockKey(el.dataset.k);
  else if(a==="lock-del"){lockPin=lockPin.slice(0,-1);drawLock("")}
  else if(a==="lock-bio")tryBio();
  else if(a==="lock-forgot")lockForgot();
  else if(a==="lock-back")drawLock("");
  else if(a==="lock-erase"){var ei=document.getElementById("erase-in");if(ei&&ei.value.trim().toUpperCase()==="ERASE"){try{localStorage.clear()}catch(e){}try{indexedDB.deleteDatabase("lawnlog")}catch(e){}location.reload()}}
  else if(a==="lock-setup")openLockSetup("setup");
  else if(a==="lock-change")openLockSetup("change");
  else if(a==="lock-off")openLockSetup("off");
  else if(a==="pin-next")pinNext();
  else if(a==="ib-open")ibOpen();
  else if(a==="backup-later"){state.backupSnooze=Date.now()+7*86400000;saveQuiet();render()}
  else if(a==="auto-clear"){var fp2=document.getElementById("f-product"),fc2=document.getElementById("f-cost");if(fp2){fp2.value="";fp2.dataset.auto=""}if(fc2&&fc2.dataset.auto==="1"){fc2.value="";fc2.dataset.auto=""}var an=document.getElementById("auto-note");if(an)an.innerHTML="";if(fp2)updateCalc(fp2);updateMoreSum()}
  else if(a==="log-again"){var src=state.entries.find(function(x){return x.id===el.dataset.id}),td=todayISO();if(src){if(state.entries.some(function(x){return x.task===src.task&&x.date===td&&(x.product||"")===(src.product||"")&&x.kind!=="expense"})){setStatus(src.task+" is already logged for today");return}state.entries.push({id:uid(),date:td,task:src.task,cost:src.cost||0,product:src.product||"",note:"",photos:[],weather:wxNowText()});persist();setStatus(src.task+" logged again for today")}}
  else if(a==="onb-wx"){onbMsg="";wxUseGPS()}
  else if(a==="onb-next")openOnboarding(ONB+1);
  else if(a==="onb-back")openOnboarding(ONB-1);
  else if(a==="onb-skip"){ONB=0;state.onboarded=true;saveQuiet();document.getElementById("sheet").innerHTML=""}
  else if(a==="onb-done")finishOnboarding();
  else if(a==="onb-again"){openOnboarding(1)}
  else if(a==="rc-open")openReceipt();
  else if(a==="np-yes")npSave(false);
  else if(a==="np-details")npSave(true);
  else if(a==="np-no"){if(!state.npDeclined)state.npDeclined=[];NP.forEach(function(it){var k=it.name.toLowerCase();if(state.npDeclined.indexOf(k)<0)state.npDeclined.push(k)});saveQuiet();closeSheet2()}
  else if(a==="skip-due"){var sk=state.schedules.find(function(x){return x.task===el.dataset.task});if(sk){var b0=dueBase(sk),ev=Math.max(1,+sk.every||7),cur=b0?addDays(b0,ev):todayISO();if(cur<todayISO())cur=todayISO();sk.skip={base:cur,on:todayISO(),prev:sk.skip||null};persist();setStatus(sk.task+" skipped. Next due "+fmtWeekday(addDays(cur,ev)))}}
  else if(a==="unskip"){var su=state.schedules.find(function(x){return x.task===el.dataset.task});if(su&&su.skip){su.skip=su.skip.prev||null;persist();setStatus("Skip undone")}}
  else if(a==="prod-seg"){soilView=el.dataset.v;render()}
  else if(a==="soil-new")openSoilForm(null);
  else if(a==="soil-edit")openSoilForm(el.dataset.id);
  else if(a==="soil-view")showSoil(el.dataset.id);
  else if(a==="soil-save")saveSoil();
  else if(a==="soil-photo-x"){var si=+el.dataset.i,sid=soilPhotos[si];soilPhotos.splice(si,1);var nx=newUploads.indexOf(sid);if(nx>=0){newUploads.splice(nx,1);photoDel(sid)}renderSoilPhotos()}
  else if(a==="soil-photo-view"){var im=document.querySelector('[data-act="soil-photo-view"][data-id="'+el.dataset.id+'"] img');if(im&&im.src)window.open(im.src,"_blank")}
  else if(a==="soil-del"){var did3=el.dataset.id;document.getElementById("sheet").innerHTML='<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sd-title"><h2 id="sd-title">Delete this soil test?</h2><p class="note">Are you sure? Its results and report photos will be removed. This can\u2019t be undone.</p><div class="actions"><button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn danger" data-act="soil-del-yes" data-id="'+esc(did3)+'">Delete</button></div></div>'}
  else if(a==="soil-del-yes"){var did4=el.dataset.id,tt=soilTests().find(function(x){return x.id===did4});if(tt)(tt.photos||[]).forEach(function(pid){dropPhoto(pid,did4)});state.soilTests=soilTests().filter(function(x){return x.id!==did4});closeSheet();persist();setStatus("Soil test deleted")}
  else if(a==="cal-open")openCalendar();
  else if(a==="cal-ics")downloadIcs();
  else if(a==="rc-save")rcSave(false);
  else if(a==="rc-total")rcSave(true);
  else if(a==="notify-lead"){notifyCfg().lead=el.dataset.v;persist()}
  else if(a==="notify-task"){var nc=notifyCfg(),all=state.schedules.map(function(x){return x.task}),cur=nc.tasks?nc.tasks.slice():all.slice(),ix=cur.indexOf(el.dataset.task);if(ix>=0)cur.splice(ix,1);else cur.push(el.dataset.task);nc.tasks=cur.length===all.length?null:cur;persist()}
  else if(a==="prod-del-ask"){var dp=state.products.find(function(x){return x.id===el.dataset.id});if(dp){sheet2().innerHTML='<div class="scrim" data-act="prod-close"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="pd-title"><h2 id="pd-title">Delete this product?</h2><p class="note">Are you sure you want to delete <b>'+esc(dp.name)+'</b>? Its rate, price and barcode will be removed. This can\u2019t be undone. Work you already logged with it stays in your diary.</p><div class="actions"><button class="btn ghost" data-act="prod-close">Cancel</button><button class="btn danger" data-act="prod-del-yes" data-id="'+esc(dp.id)+'">Delete</button></div></div>';var cb2=document.querySelector('#sheet2 [data-act="prod-close"].btn');if(cb2)cb2.focus()}}
  else if(a==="prod-del-yes"){var did2=el.dataset.id;rememberProduct(state.products.find(function(x){return x.id===did2}));state.products=state.products.filter(function(x){return x.id!==did2});closeSheet2();persist()}
  else if(a==="hist-task"){histFilter=state.entries.some(function(e){return e.task===el.dataset.task})?el.dataset.task:"all";tab="history";try{localStorage.setItem(LS_TAB,tab)}catch(e){}render();window.scrollTo(0,0)}
  else if(a==="plus")openPlus();
  else if(a==="plus-log"){closeSheet();openSheet()}
  else if(a==="plus-prod"){closeSheet();openProduct(null)}
  else if(a==="plus-scan"){closeSheet();openScanner(function(code){var p=findByUpc(code);if(p)showProductCard(p);else showUnknownCode(normUpc(code)||code)})}
  else if(a==="plus-exp"){closeSheet();openSheet(null,"","","","",null,"expense")}
  else if(a==="scan-lookup")openScanner(function(code){var p=findByUpc(code);if(p)showProductCard(p);else showUnknownCode(normUpc(code)||code)});
  else if(a==="scan-close")closeScanner();
  else if(a==="use-cost"){var tg=el.dataset.t,inp=tg==="f"?document.getElementById("f-cost"):Array.prototype.find.call(document.querySelectorAll('[data-mt][data-f="c"]'),function(x){return x.dataset.mt===tg});if(inp){inp.value=el.dataset.v;inp.dispatchEvent(new Event("input",{bubbles:true}))}}
  else if(a==="scan-typed"){var tn=normUpc(document.getElementById("scan-num").value);if(!tn){document.getElementById("scan-hint").textContent="Enter the 6 to 14 digit number under the barcode.";return}var cbk=SCAN.onCode;closeScanner();cbk(tn)}
  else if(a==="scan-into-product")openScanner(function(code){var u=document.getElementById("p-upc");if(u)u.value=normUpc(code)||code;var ex2=findByUpc(code);var e2=document.getElementById("p-err");if(ex2&&ex2.id!==prodEditId&&e2)e2.textContent="That barcode is already saved for "+ex2.name+"."});
  else if(a==="scan-into-log")openScanner(function(code){logScanResult(code)});
  else if(a==="pc-log"){var nm=el.dataset.name;closeSheet2();openSheet(null,"","",nm)}
  else if(a==="uc-add"){var up=el.dataset.upc;closeSheet2();addByBarcode(up)}
  else if(a==="prod-new")openProduct(null,el.dataset.name,null,el.dataset.cat);
  else if(a==="ap-type"){openProduct(null,"",null,el.dataset.cat||null)}
  else if(a==="ap-scan"){var apc=el.dataset.cat||null;closeSheet2();openScanner(function(code){addByBarcode(code,apc)})}
  else if(a==="prod-edit")openProduct(el.dataset.id);
  else if(a==="prod-close")closeSheet2();
  else if(a==="prod-save")saveProduct();
  else if(a==="prod-save-norate"){skipRate=true;saveProduct()}
  else if(a==="prod-add-rate"){var pa=document.getElementById("p-actions");if(pa)pa.innerHTML=prodActionsHTML(!!prodEditId);var rf=document.getElementById(prodMode==="cover"?"p-cover-n":"p-rate-n");if(rf){rf.scrollIntoView({block:"center"});rf.focus()}}
  else if(a==="prod-mode"){prodMode=el.dataset.mode;document.querySelectorAll('[data-act="prod-mode"]').forEach(function(c){c.setAttribute("aria-pressed",String(c===el))});document.getElementById("p-cover").hidden=prodMode!=="cover";document.getElementById("p-rate").hidden=prodMode!=="rate";syncSpreader()}
  else if(a==="prod-del"){if(prodEditId){rememberProduct(state.products.find(function(x){return x.id===prodEditId}));state.products=state.products.filter(function(x){return x.id!==prodEditId});saveQuiet();closeSheet2();if(document.getElementById("f-product"))refreshAllCalcs();else render()}}
  else if(a==="lawn-map")openMap();
  else if(a==="lawn-manual")openManualLawn();
  else if(a==="ml-save"){var mv=parseFloat(document.getElementById("ml-n").value);state.lawn.manual=mv>0?Math.round(mv):null;closeSheet2();persist()}
  else if(a==="lawn-del"){state.lawn.areas.splice(+el.dataset.i,1);persist()}
  else if(a==="map-close")closeMap();
  else if(a==="map-mode")setMapMode(el.dataset.mode);
  else if(a==="map-intro-ok"){state.mapIntroSeen=true;saveQuiet();var mi=document.getElementById("map-intro");if(mi)mi.remove()}
  else if(a==="map-name")nameSection(el.dataset.name);
  else if(a==="map-name-custom"){var ni=document.getElementById("map-name-in");if(ni)nameSection(ni.value)}
  else if(a==="lawn-rename"){var li=+el.dataset.i,cur=state.lawn.areas[li];sheet2().innerHTML='<div class="scrim" data-act="prod-close"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="rn-title"><h2 id="rn-title">Rename section</h2><div class="chips" style="margin-bottom:12px">'+["Front Yard","Back Yard","Side Yard"].map(function(o){return '<button type="button" class="chip" data-act="rn-pick" data-name="'+o+'">'+o+'</button>'}).join("")+'</div><label class="field">Name<input type="text" id="rn-in" maxlength="30" value="'+esc(cur.name)+'" autocapitalize="words"></label><p class="m">Sections with the same name are added together.</p><div class="actions"><button class="btn ghost" data-act="prod-close">Cancel</button><button class="btn primary" data-act="rn-save" data-i="'+li+'">Save</button></div></div>'}
  else if(a==="rn-pick"){var rin=document.getElementById("rn-in");if(rin)rin.value=el.dataset.name}
  else if(a==="rn-save"){var nv=(document.getElementById("rn-in").value||"").trim().slice(0,30);if(nv){state.lawn.areas[+el.dataset.i].name=nv;closeSheet2();persist()}}
  else if(a==="pick-area"){var zz=el.dataset.zone||"";if(!zz)sheetAreas=[];else{var zi=sheetAreas.indexOf(zz);if(zi>=0)sheetAreas.splice(zi,1);else sheetAreas.push(zz);if(sheetAreas.length===zones().length)sheetAreas=[]}var sa=selAreas();document.querySelectorAll('[data-act="pick-area"]').forEach(function(c){var z=c.dataset.zone||"";c.setAttribute("aria-pressed",String(z?sa.indexOf(z)>=0:!sa.length))});var fc3=document.getElementById("f-cost");if(fc3&&fc3.dataset.auto==="1"){var fp3=document.getElementById("f-product"),g3=costGuess(sheetTasks[0],fp3?fp3.value:"");fc3.value=g3!=null?g3:"";updateMoreSum()}refreshAllCalcs()}
  else if(a==="map-save")mapSave();
  else if(a==="map-finish")mapFinish();
  else if(a==="map-undo"){MAP.pts.pop();mapDraw();mapRead()}
  else if(a==="map-clear"){MAP.pts=[];mapDraw();mapRead()}
  else if(a==="map-secdel"){MAP.done.splice(+el.dataset.i,1);mapDraw();mapRead()}
  else if(a==="map-zin"){MAP.res=Math.max(0.05,MAP.res/1.6);mapDraw();mapLoad()}
  else if(a==="map-zout"){MAP.res=Math.min(400,MAP.res*1.6);mapDraw();mapLoad()}
  else if(a==="map-me")mapLocate(false);
  else if(a==="wx-gps")wxUseGPS();
  else if(a==="wx-retry")loadWx(true);
  else if(a==="wx-day"){wxSel=+el.dataset.i;document.querySelectorAll(".wx-day").forEach(function(b,i){b.classList.toggle("sel",i===wxSel);b.setAttribute("aria-pressed",String(i===wxSel))});var tp=document.querySelector(".wx-today");if(tp){tp.classList.toggle("sel",wxSel<0);tp.setAttribute("aria-pressed",String(wxSel<0))}var dd=document.getElementById("wx-detail");if(dd&&wx)dd.textContent=wxDayText(wxDays(wx.periods)[wxSel+1])}
  else if(a==="wx-remove"){state.wxLoc=null;wx=null;wxErr="";try{localStorage.removeItem(LS_WX)}catch(e){}persist()}
  else if(a==="confirm-import")confirmImport();
});
document.addEventListener("input",function(ev){var t=ev.target;
  if(t.id==="f-product"||t.id==="f-cost"){if(t.dataset.auto==="1"){t.dataset.auto="";var an2=document.getElementById("auto-note");if(an2)an2.innerHTML=""}}
  if(t.id==="f-cost"||t.id==="f-note"||t.id==="f-soil")updateMoreSum();
  if(t.dataset&&t.dataset.act==="diary-search"){diaryQ=t.value;var dl2=document.getElementById("diary-list");if(dl2)dl2.innerHTML=diaryListHTML();return}
  if(t.dataset&&t.dataset.act==="cap-words"){var pos=t.selectionStart,nv=capWords(t.value);if(nv!==t.value){t.value=nv;try{t.setSelectionRange(pos,pos)}catch(e){}}}if(t.id==="f-product"||(t.dataset&&t.dataset.mt&&t.dataset.f==="p"))updateCalc(t)});
document.addEventListener("keydown",function(ev){
  if(locked){if(/^\d$/.test(ev.key)){ev.preventDefault();lockKey(ev.key)}else if(ev.key==="Backspace"){ev.preventDefault();lockPin=lockPin.slice(0,-1);drawLock("")}return}
  if(ev.key==="Enter"&&(ev.target.id==="pin-in"||ev.target.id==="bk-pass2"||ev.target.id==="ib-pass")){ev.preventDefault();var b2=document.querySelector(ev.target.id==="pin-in"?'[data-act="pin-next"]':ev.target.id==="ib-pass"?'[data-act="ib-open"]':'[data-act="bk-save"]');if(b2)b2.click();return}
  if(ev.key==="Enter"&&ev.target.id==="map-name-in"){ev.preventDefault();nameSection(ev.target.value);return}
  if(ev.key==="Enter"&&ev.target.id==="scan-num"){ev.preventDefault();var b=document.querySelector('[data-act="scan-typed"]');if(b)b.click();return}if((ev.key==="Enter"||ev.key===" ")&&ev.target.classList&&ev.target.classList.contains("wx-today")){ev.preventDefault();ev.target.click()}});
document.addEventListener("change",function(ev){
  var el=ev.target,a=el.dataset&&el.dataset.act;
  if(a==="add-photo"){addPhotos(el.files);el.value="";return}
  if(a==="rc-file"){rcFile(el.files[0]);el.value="";return}
  if(a==="soil-photo"){if(el.files[0])addSoilPhoto(el.files[0]);el.value="";return}
  if(el.id==="p-unit"){var u2=document.getElementById("p-unit2"),pk=document.getElementById("p-pkg");if(u2&&(!pk||!pk.value)&&!convertible(el.value,u2.value))u2.value=el.value==="fl oz"||el.value==="ml"?"gal":el.value==="oz"?"lb":el.value;syncSpreader();return}
  if(el.id==="p-unit2"){syncSpreader();return}
  if(a==="rc-pick"){var rr=RC.rows[+el.dataset.i];rr.pid=el.value;rr.how="";var sh=document.querySelector("#sheet .sheet"),keep=sh?sh.scrollTop:0;showReceipt();sh=document.querySelector("#sheet .sheet");if(sh)sh.scrollTop=keep;return}
  if(a==="rc-upd"){RC.rows[+el.dataset.i].upd=el.checked;return}
  if(a==="rc-tax"){RC.tax=el.checked;return}
  if(a==="notify-on"){var nc2=notifyCfg();nc2.on=el.checked;var LN2=nativeNotify();if(el.checked&&LN2){LN2.requestPermissions().then(function(r){if(r&&r.display!=="granted"){nc2.on=false;setStatus("Notifications are blocked. Allow them for TurfDiary in your phone\u2019s settings.")}persist()}).catch(function(){persist()})}else persist();return}
  if(a==="notify-time"){notifyCfg().time=el.value||"08:00";persist();return}
  if(a==="lock-bio-toggle"){lockCfg.bio=el.checked;try{localStorage.setItem(LS_LOCK,JSON.stringify(lockCfg))}catch(e){}return}
  if(a==="import"){if(el.files[0])readImport(el.files[0]);el.value="";return}
  if(a==="sched-every"){var n=parseInt(el.value,10);if(n>=1&&n<=365){state.schedules[+el.dataset.i].every=n;persist()}else render()}
  else if(a==="hist-filter"){histFilter=el.value;render()}
  else if(a==="spend-year"){spendYear=+el.value;render()}
});

render();
window.tdToast=setStatus;
if(lockCfg)showLock();
setTimeout(launchAction,350);
document.addEventListener("visibilitychange",function(){if(!lockCfg)return;if(document.visibilityState==="hidden")hiddenAt=Date.now();else if(hiddenAt&&Date.now()-hiddenAt>60000&&!locked)showLock()});
scheduleNotifications();
if(!state.onboarded){if(!state.entries.length&&!state.wxLoc&&!lawnSqft())setTimeout(function(){openOnboarding(1)},300);else{state.onboarded=true;saveQuiet()}}
(function(){
  /* keep the page behind sheets from scrolling (also on iPhone) */
  var locked=false,y=0;
  function check(){
    var open=!!(document.querySelector("#sheet .sheet")||document.querySelector("#sheet2 .sheet")||document.getElementById("mapview")||document.getElementById("scanview"));
    if(open&&!locked){y=window.scrollY;document.body.style.position="fixed";document.body.style.top=(-y)+"px";document.body.style.left="0";document.body.style.right="0";locked=true}
    else if(!open&&locked){document.body.style.position="";document.body.style.top="";document.body.style.left="";document.body.style.right="";window.scrollTo(0,y);locked=false}
  }
  new MutationObserver(check).observe(document.body,{childList:true,subtree:true});
})();
loadWx(false);
document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible")loadWx(false)});
if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().catch(function(){});
})();
