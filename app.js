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
function lastDone(task){var l=null;state.entries.forEach(function(e){if(e.task===task&&(!l||e.date>l))l=e.date});return l}
function setStatus(t){statusText=t;var el=document.getElementById("status");if(el)el.textContent=t}
function persist(){
  state.updatedAt=Date.now();
  try{localStorage.setItem(LS,JSON.stringify(state))}catch(e){setStatus("Couldn\u2019t save. Your phone may be out of storage.")}
  render();
  scheduleNotifications();
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
function photoShared(id,exceptId){return state.entries.some(function(e){return e.id!==exceptId&&(e.photos||[]).indexOf(id)>=0})}
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
      '<button class="btn primary" data-act="wx-gps">Use my location</button>'+(wxErr?'<p class="err" role="alert">'+esc(wxErr)+'</p>':'')+'</section>';
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
  h+='<div class="wx-next"><span>Next '+days.length+' days</span><span class="wx-key">Rain: <i class="sw d"></i>day <i class="sw n"></i>night</span></div>';
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
    '<div class="toolbar" style="justify-content:flex-start"><button class="btn primary" data-act="wx-gps">'+(state.wxLoc?"Update my location":"Use my location")+'</button>'+(state.wxLoc?'<button class="btn" data-act="wx-remove">Turn off weather</button>':'')+'</div>'+
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
    setStatus("");wxErr="Location wasn\u2019t shared. Allow location for TurfDiary in your phone\u2019s settings, then try again.";render();
  },{enableHighAccuracy:false,timeout:15000,maximumAge:600000});
}

/* ---------- lawn size (traced on USGS aerial imagery) and saved products ---------- */
function ensureData(){if(!state.lawn||!Array.isArray(state.lawn.areas))state.lawn={areas:[],manual:null};if(!Array.isArray(state.products))state.products=[]}
ensureData();
function lawnSqft(){var l=state.lawn||{};if(l.manual>0)return l.manual;return (l.areas||[]).reduce(function(t,a){return t+(a.sqft||0)},0)}
function fmtInt(n){return Math.round(n).toLocaleString()}
function fmtAmt(n){return n>=100?fmtInt(n):(Math.round(n*10)/10).toLocaleString()}
function pkgWord(p,n){var liquid=/fl oz|gal|qt/.test(p.unit||"");return liquid?(n===1?"container":"containers"):(n===1?"bag":"bags")}
function prodSummary(p){
  var t=p.mode==="cover"?"1 "+pkgWord(p,1)+" covers "+fmtInt(p.cover)+" sq ft":(Math.round(p.rate*100)/100).toLocaleString()+" "+p.unit+" per 1,000 sq ft";
  if(p.pkgSize)t+=", "+fmtAmt(p.pkgSize)+" "+p.unit+" "+pkgWord(p,1);
  if(p.price!=null)t+=", "+money(p.price)+" a "+pkgWord(p,1);
  return t;
}
function prodCostUsed(p,sq){
  if(p.price==null||!(sq>0))return null;
  if(p.mode==="cover"&&p.cover>0)return Math.round(sq/p.cover*p.price*100)/100;
  if(p.rate>0&&p.pkgSize>0)return Math.round(p.rate*sq/1000/p.pkgSize*p.price*100)/100;
  return null;
}
function costButtons(p,target){
  if(!p||p.price==null)return "";
  var used=prodCostUsed(p,lawnSqft()),h='<span class="cost-btns">Cost: ';
  if(used!=null)h+='<button type="button" class="chip small" data-act="use-cost" data-v="'+used+'" data-t="'+esc(target)+'">'+money(used)+' used on your lawn</button>';
  h+='<button type="button" class="chip small" data-act="use-cost" data-v="'+p.price+'" data-t="'+esc(target)+'">'+money(p.price)+' whole '+pkgWord(p,1)+'</button></span>';
  return h;
}
function prodCalc(p,sq){
  if(!p)return "";
  if(!(sq>0))return "Measure your lawn in Settings to see how much you need.";
  var t="For your "+fmtInt(sq)+" sq ft: ";
  if(p.mode==="cover"&&p.cover>0){
    var b=sq/p.cover;t+=fmtAmt(b)+" "+pkgWord(p,b)+" (buy "+Math.ceil(b-0.02)+")";
    if(p.pkgSize)t+=", about "+fmtAmt(b*p.pkgSize)+" "+p.unit;
  }else if(p.rate>0){
    var amt=p.rate*sq/1000;t+=fmtAmt(amt)+" "+p.unit;
    if(p.pkgSize){var n=amt/p.pkgSize;t+=", "+fmtAmt(n)+" "+pkgWord(p,n)+" (buy "+Math.ceil(n-0.02)+")"}
  }else return "";
  if(p.spreader)t+=". Spreader setting: "+p.spreader;
  return t+".";
}
function findProduct(name){name=(name||"").trim().toLowerCase();if(!name)return null;return state.products.find(function(p){return p.name.trim().toLowerCase()===name})||null}
function calcHTML(name,target){
  var n=(name||"").trim();if(!n)return "";
  var p=findProduct(n);
  if(p)return '<span class="calc-ok">'+esc(prodCalc(p,lawnSqft()))+'</span> <button type="button" class="link small" data-act="prod-edit" data-id="'+esc(p.id)+'">Edit product</button>'+costButtons(p,target||"f");
  return '<button type="button" class="link small" data-act="prod-new" data-name="'+esc(n)+'">Save this product\u2019s rate</button> <span class="m">to calculate how much you need.</span>';
}
function updateCalc(input){
  var box=input.id==="f-product"?document.getElementById("prod-calc"):input.parentNode.querySelector(".mt-calc");
  if(box)box.innerHTML=calcHTML(input.value,input.id==="f-product"?"f":input.dataset.mt);
}
function refreshAllCalcs(){var f=document.getElementById("f-product");if(f)updateCalc(f);document.querySelectorAll('[data-mt][data-f="p"]').forEach(updateCalc)}

/* product editor (opens above other sheets) */
var prodEditId=null,prodMode="cover";
function sheet2(){var d=document.getElementById("sheet2");if(!d){d=document.createElement("div");d.id="sheet2";document.body.appendChild(d)}return d}
function closeSheet2(){sheet2().innerHTML=""}
var upcPrefill="";
function openProduct(id,name,upc){
  upcPrefill=upc||"";
  var p=id?state.products.find(function(x){return x.id===id}):null;
  prodEditId=p?p.id:null;prodMode=p?p.mode:"cover";
  var unitSel=function(v){return ["lb","oz","fl oz","gal"].map(function(u){return '<option'+(u===(v||"lb")?' selected':'')+'>'+u+'</option>'}).join("")};
  sheet2().innerHTML='<div class="scrim" data-act="prod-close"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="p-title"><h2 id="p-title">'+(p?"Edit product":"Save a product")+'</h2>'+
    '<label class="field">Product name<input type="text" id="p-name" maxlength="80" value="'+esc(p?p.name:(name||""))+'" placeholder="e.g. LESCO Dimension 19-0-7"></label>'+
    '<fieldset><legend>How does the label list it?</legend><div class="chips"><button type="button" class="chip" data-act="prod-mode" data-mode="cover" aria-pressed="'+(prodMode==="cover")+'">One bag covers an area</button><button type="button" class="chip" data-act="prod-mode" data-mode="rate" aria-pressed="'+(prodMode==="rate")+'">Amount per 1,000 sq ft</button></div></fieldset>'+
    '<div id="p-cover"'+(prodMode==="cover"?'':' hidden')+'><label class="field">One bag or container covers (sq ft)<input type="number" id="p-cover-n" inputmode="numeric" min="1" value="'+esc(p&&p.cover||"")+'" placeholder="e.g. 5000"></label></div>'+
    '<div id="p-rate"'+(prodMode==="rate"?'':' hidden')+'><label class="field">Apply this much per 1,000 sq ft<div class="unit-row"><input type="number" id="p-rate-n" inputmode="decimal" step="0.01" min="0" value="'+esc(p&&p.rate||"")+'" placeholder="e.g. 3.85"><select id="p-unit" aria-label="Unit">'+unitSel(p&&p.unit)+'</select></div></label></div>'+
    '<label class="field">Bag or container size (optional)<div class="unit-row"><input type="number" id="p-pkg" inputmode="decimal" step="0.01" min="0" value="'+esc(p&&p.pkgSize||"")+'" placeholder="e.g. 50"><select id="p-unit2" aria-label="Unit">'+unitSel(p&&p.unit)+'</select></div></label>'+
    '<label class="field">Price per bag or container (optional)<div class="unit-row"><span class="dollar">$</span><input type="number" id="p-price" inputmode="decimal" step="0.01" min="0" value="'+esc(p&&p.price!=null?p.price:"")+'" placeholder="e.g. 57.94"></div></label>'+
    '<label class="field">Barcode (UPC, optional)<div class="unit-row"><input type="text" id="p-upc" inputmode="numeric" maxlength="24" value="'+esc(p&&p.upc||upcPrefill||"")+'" placeholder="Scan or type the number under the barcode"><button type="button" class="btn small" data-act="scan-into-product">Scan</button></div></label>'+
    '<label class="field">Spreader setting (optional)<input type="text" id="p-spread" maxlength="40" value="'+esc(p&&p.spreader||"")+'" placeholder="e.g. 3.5 on my rotary spreader"></label>'+
    '<p class="err" id="p-err" role="alert"></p><div class="actions">'+(p?'<button class="btn ghost" data-act="prod-del" style="margin-right:auto">Delete</button>':'')+'<button class="btn ghost" data-act="prod-close">Cancel</button><button class="btn primary" data-act="prod-save">Save product</button></div></div>';
  var f=document.getElementById("p-name");if(f&&!f.value)f.focus();
}
function saveProduct(){
  var err=document.getElementById("p-err"),name=document.getElementById("p-name").value.trim();
  if(!name){err.textContent="Give the product a name.";return}
  var unit=prodMode==="rate"?document.getElementById("p-unit").value:document.getElementById("p-unit2").value;
  var rec={name:name.slice(0,80),mode:prodMode,unit:unit,spreader:document.getElementById("p-spread").value.trim().slice(0,40)};
  var pkg=parseFloat(document.getElementById("p-pkg").value);rec.pkgSize=pkg>0?pkg:null;
  if(prodMode==="cover"){var cv=parseFloat(document.getElementById("p-cover-n").value);if(!(cv>0)){err.textContent="Enter how many square feet one bag covers, like 5000.";return}rec.cover=cv;rec.rate=null}
  else{var r=parseFloat(document.getElementById("p-rate-n").value);if(!(r>0)){err.textContent="Enter the amount per 1,000 sq ft, like 3.85.";return}rec.rate=r;rec.cover=null}
  var dup=findProduct(name);if(dup&&dup.id!==prodEditId){err.textContent="You already have a product with that name.";return}
  var upc=normUpc(document.getElementById("p-upc").value);
  if(document.getElementById("p-upc").value.trim()&&!upc){err.textContent="The barcode should be 6 to 14 digits.";return}
  var du=upc?findByUpc(upc):null;if(du&&du.id!==prodEditId){err.textContent="That barcode is already saved for "+du.name+".";return}
  rec.upc=upc||null;
  var pr=parseFloat(document.getElementById("p-price").value);
  if(document.getElementById("p-price").value.trim()&&!(pr>=0)){err.textContent="Enter the price as a number, like 57.94.";return}
  rec.price=pr>=0?Math.round(pr*100)/100:null;
  var ex=prodEditId?state.products.find(function(x){return x.id===prodEditId}):null;
  if(ex)Object.assign(ex,rec);else state.products.push(Object.assign({id:"pr_"+uid()},rec));
  state.updatedAt=Date.now();saveQuiet();closeSheet2();
  if(document.getElementById("f-product")||document.querySelector("[data-mt]")){refreshAllCalcs();var dl=document.getElementById("prod-list");if(dl)dl.innerHTML=productNames().map(function(n){return '<option value="'+esc(n)+'">'}).join("")}
  else render();
}
function productNames(){var out=state.products.map(function(p){return p.name});recentProducts().forEach(function(n){if(!findProduct(n))out.push(n)});return out}
function lawnHTML(){
  var l=state.lawn,sq=lawnSqft(),h='<div class="settings-block" id="lawn-block">';
  if(sq>0)h+='<p class="lawn-total">'+fmtInt(sq)+' <span>sq ft of lawn'+(l.manual>0?' (entered by hand)':'')+'</span></p>';
  else h+='<p>Trace your lawn on an aerial photo to get its size. TurfDiary then works out how much product you need.</p>';
  if(!(l.manual>0)&&l.areas.length)h+='<div class="list" style="margin-bottom:10px">'+l.areas.map(function(a,i){return '<div class="item"><div class="grow"><div class="t">'+esc(a.name)+'</div><div class="m">'+fmtInt(a.sqft)+' sq ft</div></div><button class="btn small ghost" data-act="lawn-del" data-i="'+i+'">Remove</button></div>'}).join("")+'</div>';
  h+='<div class="toolbar" style="justify-content:flex-start"><button class="btn primary" data-act="lawn-map">'+(l.areas.length?"Edit on map":"Measure on map")+'</button><button class="btn" data-act="lawn-manual">Enter size by hand</button></div>';
  h+='<p class="src">Aerial imagery: USGS The National Map and USDA NAIP (public domain). Photos may be a year or two old, and trees can hide parts of the lawn, so treat the size as an estimate.</p></div>';
  return h;
}
function productsHTML(){
  var sq=lawnSqft(),h='<div class="settings-block">';
  if(!state.products.length)h+='<p>Save each product\u2019s rate once, from its label. When you log work with that product, TurfDiary shows how much you need for your lawn.</p>';
  else h+='<div class="list">'+state.products.map(function(p){return '<div class="item"><div class="grow"><div class="t">'+esc(p.name)+'</div><div class="m">'+esc(prodSummary(p))+'</div><div class="calc-ok small">'+esc(prodCalc(p,sq))+'</div>'+(p.upc?'<div class="m small">Barcode '+esc(p.upc)+'</div>':'')+'</div><div class="row-acts"><button class="btn small" data-act="prod-edit" data-id="'+esc(p.id)+'" aria-label="Edit '+esc(p.name)+'">Edit</button><button class="btn small ghost" data-act="prod-del-ask" data-id="'+esc(p.id)+'" aria-label="Delete '+esc(p.name)+'">Delete</button></div></div>'}).join("")+'</div>';
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
    '<div class="map-hint" id="map-hint">Outline one section of lawn at a time. Tap its corners, then tap Add section. TurfDiary adds the sections together.</div></div>'+
    '<div class="map-sections" id="map-sections"></div>'+
    '<div class="map-bottom"><button class="btn small" data-act="map-undo">Undo point</button><button class="btn small" data-act="map-clear">Clear</button><button class="btn small primary" data-act="map-finish">+ Add section</button></div>'+
    '<p class="map-src">Imagery: USGS The National Map / USDA NAIP</p>';
  document.body.appendChild(el);document.body.style.overflow="hidden";
  var box=document.getElementById("map-box");
  MAP={el:el,box:box,cx:0,cy:0,res:0.2,w:box.clientWidth,h:box.clientHeight,imgs:[],pts:[],done:(state.lawn.areas||[]).map(function(a){return{name:a.name,sqft:a.sqft,pts:a.pts||[]}}).filter(function(a){return a.pts.length>2}),ptrs:{},timer:null,moved:false};
  if(MAP.done.length){var a0=MAP.done[0].pts,c0=a0.reduce(function(t,p){return[t[0]+p[0]/a0.length,t[1]+p[1]/a0.length]},[0,0]);setTimeout(function(){if(MAP)setMapCenter(c0[0],c0[1],0.18)},0)}
  var start=state.wxLoc?[state.wxLoc.lat,state.wxLoc.lon]:[39.5,-98.35];
  setMapCenter(start[0],start[1],state.wxLoc?1.2:400);
  if(!MAP.done.length)mapLocate(true);else mapRead();
  bindMap(box);
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
  document.getElementById("map-read").innerHTML='Total <b>'+fmtInt(tot+cur)+'</b> sq ft<br><span>'+(MAP.pts.length>2?'This section: '+fmtInt(cur)+' sq ft':MAP.pts.length?'Keep tapping corners\u2026':'Tap to start a section')+'</span>';
  document.getElementById("map-sections").innerHTML=MAP.done.map(function(a,i){return '<span class="sec-chip">'+esc(a.name)+': '+fmtInt(a.sqft)+' sq ft<button type="button" data-act="map-secdel" data-i="'+i+'" aria-label="Remove '+esc(a.name)+'">\u00d7</button></span>'}).join("")+(MAP.done.length>1||(MAP.done.length&&MAP.pts.length>2)?'<span class="sec-sum">= '+fmtInt(tot+cur)+' sq ft</span>':'');
}
function bindMap(box){
  box.addEventListener("pointerdown",function(e){if(e.target.closest("button"))return;box.setPointerCapture(e.pointerId);MAP.ptrs[e.pointerId]={x:e.clientX,y:e.clientY,sx:e.clientX,sy:e.clientY};MAP.moved=Object.keys(MAP.ptrs).length>1});
  box.addEventListener("pointermove",function(e){
    var p=MAP.ptrs[e.pointerId];if(!p)return;
    var ids=Object.keys(MAP.ptrs);
    if(ids.length===1){var dx=e.clientX-p.x,dy=e.clientY-p.y;if(Math.abs(e.clientX-p.sx)+Math.abs(e.clientY-p.sy)>8)MAP.moved=true;if(MAP.moved){MAP.cx-=dx*MAP.res;MAP.cy+=dy*MAP.res;mapDraw()}}
    else if(ids.length===2){var o=MAP.ptrs[ids[0]===String(e.pointerId)?ids[1]:ids[0]];var d0=Math.hypot(p.x-o.x,p.y-o.y),d1=Math.hypot(e.clientX-o.x,e.clientY-o.y);if(d0>0&&d1>0){MAP.res=Math.min(400,Math.max(0.05,MAP.res*d0/d1));mapDraw()}}
    p.x=e.clientX;p.y=e.clientY;
  });
  function up(e){
    var p=MAP&&MAP.ptrs[e.pointerId];if(!p)return;
    delete MAP.ptrs[e.pointerId];
    if(!MAP.moved&&e.type==="pointerup"){var r=box.getBoundingClientRect(),m=unscr(e.clientX-r.left,e.clientY-r.top);MAP.pts.push(fromMerc(m[0],m[1]));mapDraw();mapRead()}
    if(!Object.keys(MAP.ptrs).length)mapLoad();
  }
  box.addEventListener("pointerup",up);box.addEventListener("pointercancel",up);
  box.addEventListener("wheel",function(e){e.preventDefault();MAP.res=Math.min(400,Math.max(0.05,MAP.res*(e.deltaY>0?1.25:0.8)));mapDraw();mapLoad()},{passive:false});
}
function mapFinish(){
  if(MAP.pts.length<3){document.getElementById("map-hint").textContent="Tap at least three corners to make a section.";return}
  var n=1;while(MAP.done.some(function(a){return a.name==="Section "+n}))n++;
  MAP.done.push({name:"Section "+n,sqft:Math.round(polyAreaSqft(MAP.pts)),pts:MAP.pts.map(function(p){return[+p[0].toFixed(6),+p[1].toFixed(6)]})});
  MAP.pts=[];mapDraw();mapRead();document.getElementById("map-hint").textContent="Section added. Outline the next section of lawn, or tap Save when you\u2019re done.";
}
function closeMap(){if(!MAP)return;window.removeEventListener("resize",mapResize);MAP.el.remove();MAP=null;document.body.style.overflow=""}
function mapSave(){
  if(MAP.pts.length>2)mapFinish();
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
    '<p class="m" style="margin:0 0 10px">'+esc(prodSummary(p))+(p.upc?'. Barcode '+esc(p.upc):'')+'</p>'+
    '<div class="pc-need">'+esc(prodCalc(p,lawnSqft()))+(p.price!=null?'<div class="pc-cost">'+(prodCostUsed(p,lawnSqft())!=null?'Cost for your lawn: '+money(prodCostUsed(p,lawnSqft()))+'. ':'')+'Price: '+money(p.price)+' a '+pkgWord(p,1)+'.</div>':'')+'</div>'+
    '<div class="actions"><button class="btn ghost" data-act="prod-edit" data-id="'+esc(p.id)+'" style="margin-right:auto">Edit</button><button class="btn ghost" data-act="prod-close">Close</button><button class="btn primary" data-act="pc-log" data-name="'+esc(p.name)+'">Log work with it</button></div></div>';
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
    var last=lastDone(s.task);if(!last)return;
    var due=addDays(last,Math.max(1,+s.every||7)),fire=n.lead==="before"?addDays(due,-1):due;
    var d=parse(fire);d.setHours(+hm[0]||8,+hm[1]||0,0,0);
    if(d.getTime()<=now)return;
    var lp=lastProduct(s.task);
    out.push({id:1000+i,at:d,title:"TurfDiary: "+s.task+(n.lead==="before"?" is due tomorrow":" is due today"),
      body:"Last done "+fmt(last)+(lp?" with "+lp:"")+". Every "+s.every+" "+pl(+s.every,"day")+"."});
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

/* ---------- views ---------- */
function ordinal(n){var s=["th","st","nd","rd"],v=n%100;return n+(s[(v-20)%10]||s[v]||s[0])}
function tally(e){
  var y=e.date.slice(0,4),idx=state.entries.indexOf(e),n=0,spent=0;
  state.entries.forEach(function(x,i){
    if(x.task!==e.task||x.date.slice(0,4)!==y)return;
    if(x.date<e.date||(x.date===e.date&&i<=idx)){n++;spent+=x.cost||0}
  });
  return ordinal(n)+" "+e.task.toLowerCase()+" in "+y+(spent?", "+money(spent)+" spent so far":"");
}
function entryRow(e,del){
  var d=parse(e.date);
  return '<div class="item"><div class="date"><span>'+d.getDate()+'</span><small>'+esc(d.toLocaleDateString(undefined,{month:"short"}))+'</small></div>'+
    '<div class="grow"><div class="t">'+esc(e.task)+'</div><div class="tally">'+esc(tally(e))+'</div>'+(e.product?'<div class="prod">'+esc(e.product)+'</div>':'')+(e.soilTemp!=null?'<div class="m">Soil '+esc(e.soilTemp)+'\u00b0F</div>':'')+(e.weather?'<div class="m">Weather: '+esc(e.weather)+'</div>':'')+(e.note?'<div class="m">'+esc(e.note)+'</div>':'')+
    (e.photos&&e.photos.length?'<div class="row-thumbs">'+e.photos.map(function(id,i){return '<button class="rthumb" data-act="view-photo" data-id="'+esc(id)+'" aria-label="View '+esc(e.task)+' photo '+(i+1)+'">'+pimg(id)+'</button>'}).join("")+'</div>':'')+'</div>'+
    (e.cost?'<div class="cost">'+money(e.cost)+'</div>':'')+
    (del?'<div class="row-acts"><button class="btn small" data-act="edit-entry" data-id="'+esc(e.id)+'" aria-label="Edit '+esc(e.task)+' on '+esc(fmt(e.date))+'">Edit</button><button class="btn small ghost" data-act="del-entry" data-id="'+esc(e.id)+'" aria-label="Delete '+esc(e.task)+' on '+esc(fmt(e.date))+'">Delete</button></div>':'')+'</div>';
}
function lastProduct(task){var best=null;state.entries.forEach(function(e){if(e.task===task&&(!best||e.date>best.date))best=e});return best&&best.product?best.product:""}
function dueItems(){
  var t=todayISO();
  return state.schedules.map(function(s){
    var every=Math.max(1,+s.every||7),last=lastDone(s.task),diff,label,cls="",meta;
    if(!last){diff=-1e9;label="Not logged yet";cls="soon";meta="Every "+every+" "+pl(every,"day")}
    else{
      var due=addDays(last,every);diff=daysBetween(t,due);
      if(diff<0){label=(-diff)+" "+pl(-diff,"day")+" overdue";cls="over"}
      else if(diff===0){label="Due today";cls="over"}
      else if(diff<=2){label="Due in "+diff+" "+pl(diff,"day");cls="soon"}
      else label="Due "+fmtWeekday(due);
      var lp=lastProduct(s.task);
      meta="Every "+every+" "+pl(every,"day")+", last done "+fmt(last)+(lp?" with "+lp:"");
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
  var mows=state.entries.filter(function(e){return e.task==="Mow"&&e.date.slice(0,4)===yr}).length;
  if(!last){big="Not yet";sub="Log a mow to start the count."}
  else{var n=daysBetween(last,t);big=n<=0?"Today":n===1?"Yesterday":n+" days ago";sub=fmtLong(last)+(mows?". "+mows+" "+pl(mows,"mow")+" this year":"")}
  var ms=state.schedules.find(function(x){return x.task==="Mow"}),next="";
  if(ms&&last){var due=addDays(last,Math.max(1,+ms.every||7)),dd=daysBetween(t,due);next=dd<0?"Mowing is "+(-dd)+" "+pl(-dd,"day")+" overdue":dd===0?"Next mow: today":dd===1?"Next mow: tomorrow":"Next mow: "+fmtWeekday(due)+" (in "+dd+" days)"}
  var sq=lawnSqft(),lf=lastDone("Fertilize"),spent=state.entries.reduce(function(a,e){return a+(e.date.slice(0,4)===yr&&e.cost>0?e.cost:0)},0);
  var fd=lf?daysBetween(lf,t):null,fertTxt=lf?(fd<=0?"Today":fd===1?"Yesterday":fd+" days"):"Not yet",fertNote=lf?(fd>1?"ago":"")+(lastProduct("Fertilize")?(fd>1?", ":"")+lastProduct("Fertilize"):""):"";
  function tile(act,extra,label,value,note){return '<button class="hero-tile" data-act="'+act+'"'+extra+'><span class="ht-l">'+esc(label)+'</span><span class="ht-v">'+esc(value)+'</span>'+(note?'<span class="ht-n">'+esc(note)+'</span>':'')+'</button>'}
  var h='<header class="app-head"><span class="app-name">TurfDiary</span><button class="icon-btn" data-act="tab" data-tab="settings" aria-label="Settings">'+ICONS.gear+'</button></header>'+
    '<section class="hero"><div class="hero-top"><span>Last mow</span><span class="status-text" id="status" aria-live="polite">'+esc(statusText)+'</span></div>'+
    '<div class="big">'+esc(big)+'</div><div class="hero-sub">'+esc(sub)+'</div>'+(next?'<div class="hero-next">'+esc(next)+'</div>':'')+
    '<div class="hero-tiles">'+
      tile("tab",' data-tab="settings"',"Lawn",sq>0?fmtInt(sq):"Measure",sq>0?"sq ft":"tap to start")+
      tile("open-log",' data-task="Fertilize" aria-label="Log fertilizer. Last fertilized: '+esc(fertTxt+(fertNote?" "+fertNote:""))+'"',"Fertilized",fertTxt,fertNote)+
      tile("tab",' data-tab="spend"',"Spent",money(spent),"in "+yr)+
    '</div></section>';
  h+=wxCardHTML();
  h+='<div class="sec-head"><h2>Coming up</h2><button class="link small" data-act="tab" data-tab="settings">Edit reminders</button></div>';
  var items=dueItems();
  if(!items.length)h+='<p class="empty">No reminders set. <button class="link" data-act="tab" data-tab="settings">Add a reminder</button></p>';
  else h+='<div class="list">'+items.map(function(it){
    return '<div class="item"><div class="grow"><div class="t">'+esc(it.task)+'</div><div class="s '+it.cls+'">'+esc(it.label)+'</div><div class="m">'+esc(it.meta)+'</div></div>'+
      (function(){var q=state.entries.find(function(e){return e.task===it.task&&e.date===todayISO()&&e.quick});
        return q?'<button class="btn small ghost" data-act="undo-today" data-id="'+esc(q.id)+'" aria-label="Undo '+esc(it.task)+' logged today">Undo</button>':'<button class="btn small" data-act="done-today" data-task="'+esc(it.task)+'">Done today</button>'})()+'</div>';
  }).join("")+'</div>';
  h+='<h2>Recent</h2>';
  var rec=sorted().slice(0,4);
  if(!rec.length)h+='<p class="empty">Nothing logged yet. Tap Log work after your next job in the yard.</p>';
  else h+='<div class="list">'+rec.map(function(e){return entryRow(e,true)}).join("")+'</div><p><button class="link" data-act="tab" data-tab="history">See all history</button></p>';
  var ph=allPhotos().reverse().slice(0,8);
  if(ph.length)h+='<h2>Progress photos</h2><div class="row-thumbs big">'+ph.map(function(x){return '<button class="rthumb" data-act="view-photo" data-id="'+esc(x.id)+'" aria-label="View '+esc(x.e.task)+' photo from '+esc(fmt(x.e.date))+'">'+pimg(x.id)+'</button>'}).join("")+'</div>';
  return h;
}
function viewHistory(){
  var used=TASKS.filter(function(t){return state.entries.some(function(e){return e.task===t})});
  var h='<h1 class="page">History</h1><div class="toolbar"><select data-act="hist-filter" aria-label="Show task"><option value="all">All tasks</option>'+
    used.map(function(t){return '<option'+(t===histFilter?' selected':'')+'>'+esc(t)+'</option>'}).join("")+'</select><button class="btn primary" data-act="open-log">Log work</button></div>';
  var list=sorted();if(histFilter!=="all")list=list.filter(function(e){return e.task===histFilter});
  if(!list.length)return h+'<p class="empty" style="margin-top:16px">No entries yet. Logged work shows up here, newest first.</p>';
  var groups={},order=[];
  list.forEach(function(e){var k=e.date.slice(0,7);if(!groups[k]){groups[k]=[];order.push(k)}groups[k].push(e)});
  order.forEach(function(k){
    var d=parse(k+"-01"),tot=groups[k].reduce(function(s,e){return s+(e.cost||0)},0);
    h+='<div class="month-h">'+esc(d.toLocaleDateString(undefined,{month:"long",year:"numeric"}))+(tot?'<b>'+money(tot)+'</b>':'')+'</div>';
    h+='<div class="list">'+groups[k].map(function(e){return entryRow(e,true)}).join("")+'</div>';
  });
  return h;
}
function viewSpend(){
  var cy=new Date().getFullYear(),years=[];
  state.entries.forEach(function(e){var y=+e.date.slice(0,4);if(e.cost>0&&years.indexOf(y)<0)years.push(y)});
  if(years.indexOf(cy)<0)years.push(cy);years.sort(function(a,b){return b-a});
  if(years.indexOf(spendYear)<0)spendYear=cy;
  var ye=state.entries.filter(function(e){return e.cost>0&&+e.date.slice(0,4)===spendYear});
  var total=0,months=[0,0,0,0,0,0,0,0,0,0,0,0],byTask={};
  ye.forEach(function(e){total+=e.cost;months[+e.date.slice(5,7)-1]+=e.cost;byTask[e.task]=(byTask[e.task]||0)+e.cost});
  var h='<h1 class="page">Spending</h1><div class="toolbar" style="margin-bottom:14px"><select data-act="spend-year" aria-label="Year">'+
    years.map(function(y){return '<option'+(y===spendYear?' selected':'')+'>'+y+'</option>'}).join("")+'</select><button class="btn primary" data-act="add-expense">Add expense</button></div>';
  if(!ye.length)return h+'<p class="empty">No costs logged in '+spendYear+'. Tap Add expense, or add a cost when you log work.</p>';
  var second=spendYear===cy?{v:months[new Date().getMonth()],l:"This month"}:{v:total/12,l:"Average per month"};
  h+='<div class="stats"><div class="stat"><b>'+money(total)+'</b><span>Total in '+spendYear+'</span></div><div class="stat"><b>'+money(second.v)+'</b><span>'+second.l+'</span></div></div>';
  var max=Math.max.apply(null,months)||1;
  h+='<h2>By month</h2><div class="months" role="img" aria-label="Spending by month">'+months.map(function(v){return '<i style="height:'+(v/max*100)+'%" title="'+money(v)+'"></i>'}).join("")+'</div>';
  h+='<div class="mlabels">'+months.map(function(_,i){return '<span>'+esc(new Date(2000,i,1).toLocaleDateString(undefined,{month:"narrow"}))+'</span>'}).join("")+'</div>';
  var tasks=Object.keys(byTask).sort(function(a,b){return byTask[b]-byTask[a]}),tmax=byTask[tasks[0]];
  h+='<h2>By task</h2><div class="list">'+tasks.map(function(t){
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
  var free=TASKS.filter(function(t){return t!=="Supplies"&&!state.schedules.some(function(s){return s.task===t})});
  if(free.length)h+='<h2>Add a reminder</h2><div class="add"><select id="new-task" aria-label="Task">'+free.map(function(t){return '<option>'+esc(t)+'</option>'}).join("")+
    '</select><span>every</span><input id="new-every" type="number" min="1" max="365" inputmode="numeric" value="14" aria-label="Days"><span>days</span><button class="btn primary" data-act="add-sched">Add</button></div><p class="err" id="sched-err" role="alert"></p>';
  return h;
}
function viewSettings(){
  var h='<h1 class="page">Settings</h1><h2 style="margin-top:0">My lawn</h2>'+lawnHTML()+'<h2>Reminders</h2>'+viewRemind().replace('<h1 class="page">Reminders</h1>','').replace('<h2>Add a reminder</h2>','<h3 class="sub-h">Add a reminder</h3>')+'<h2>Notifications</h2>'+notifyHTML()+'<h2>Weather</h2>'+wxSettingsHTML()+'<h2>Backup</h2><div class="settings-block"><p>Your log and photos are saved only on this phone. Save a backup file now and then, especially before switching phones.</p>'+
     '<div class="toolbar" style="justify-content:flex-start"><button class="btn primary" data-act="export">Save backup</button><label class="btn file-btn">Restore backup<input type="file" accept="application/json,.json" class="vh" data-act="import" aria-label="Choose a backup file to restore"></label></div>'+
     '<p class="err" id="backup-msg" role="status" style="margin-top:10px"></p></div>';
  return h;
}
var ICONS={
  home:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/></svg>',
  history:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  products:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8h12l-1 12H7z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/><path d="M9.5 13.5c1.5 1 3.5 1 5 0"/></svg>',
  spend:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="6" width="17" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M7 9.5v5M17 9.5v5"/></svg>',
  gear:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/></svg>',
  plus:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'
};
function viewProducts(){
  return '<h1 class="page">Products</h1><div class="toolbar" style="justify-content:flex-start;margin-bottom:6px"><button class="btn primary" data-act="prod-new">Add a product</button><button class="btn" data-act="scan-lookup">Scan a barcode</button></div>'+
    '<h2>My products</h2>'+productsHTML();
}
function openPlus(){
  document.getElementById("sheet").innerHTML='<div class="scrim" data-act="close-sheet"></div><div class="sheet plus-sheet" role="dialog" aria-modal="true" aria-labelledby="plus-title"><h2 id="plus-title">Add</h2>'+
    '<div class="plus-grid"><button class="plus-opt" data-act="plus-log"><b>Log work</b><span>Mowing, fertilizing and other yard jobs</span></button>'+
    '<button class="plus-opt" data-act="plus-prod"><b>Add a product</b><span>Save its rate, price and barcode</span></button>'+
    '<button class="plus-opt" data-act="plus-scan"><b>Scan a product</b><span>Check a bag and see how much you need</span></button>'+
    '<button class="plus-opt" data-act="plus-exp"><b>Add an expense</b><span>Supplies, equipment or other costs</span></button></div>'+
    '<div class="actions"><button class="btn ghost" data-act="close-sheet">Cancel</button></div></div>';
  document.addEventListener("keydown",onKey);
  var f=document.querySelector(".plus-opt");if(f)f.focus();
}
function render(){
  ensureData();
  var v=tab==="history"?viewHistory():tab==="spend"?viewSpend():tab==="products"?viewProducts():tab==="settings"?viewSettings():viewHome();
  function tb(id,label){return '<button data-act="tab" data-tab="'+id+'"'+(tab===id?' aria-current="page"':'')+'>'+ICONS[id]+'<span>'+label+'</span></button>'}
  document.getElementById("root").innerHTML='<main>'+v+'</main><nav class="tabs" aria-label="Sections"><div class="in">'+
    tb("home","Home")+tb("history","History")+'<button class="plus-btn" data-act="plus" aria-label="Add: log work, a product, a scan or an expense">'+ICONS.plus+'</button>'+tb("products","Products")+tb("spend","Spending")+'</div></nav>';
  hydrate();
}

/* ---------- log sheet ---------- */
function onKey(e){if(e.key==="Escape")closeSheet()}
function recentProducts(task){var seen=[],out=[];sorted().forEach(function(e){if(e.product&&(!task||e.task===task)&&seen.indexOf(e.product.toLowerCase())<0){seen.push(e.product.toLowerCase());out.push(e.product)}});return out}
function updateProductChips(){
  var box=document.getElementById("prod-chips");if(!box)return;
  var list=sheetTask?recentProducts(sheetTask).slice(0,6):[];
  box.innerHTML=list.length?'<span class="m">Used before:</span>'+list.map(function(p){return '<button type="button" class="chip small" data-act="pick-product" data-product="'+esc(p)+'">'+esc(p)+'</button>'}).join(""):"";
}
var sheetTasks=[],multiVals={};
function readMulti(){var mf=document.getElementById("multi-fields");if(!mf)return;mf.querySelectorAll("[data-mt]").forEach(function(inp){var k=inp.dataset.mt;multiVals[k]=multiVals[k]||{};multiVals[k][inp.dataset.f]=inp.value})}
function renderTaskFields(){
  var sp=document.getElementById("single-prod"),sc=document.getElementById("single-cost"),mf=document.getElementById("multi-fields");if(!mf)return;
  var wasMulti=!!mf.innerHTML;readMulti();
  var fp=document.getElementById("f-product"),fc=document.getElementById("f-cost");
  if(sheetTasks.length>1){
    if(!wasMulti){var k=sheetTasks[0];if(fp.value||fc.value)multiVals[k]={p:fp.value,c:fc.value}}
    sp.hidden=true;sc.hidden=true;
    mf.innerHTML='<div class="field">Product and cost for each task (optional)'+sheetTasks.map(function(t){var v=multiVals[t]||{};
      return '<div class="mt-row"><div class="mt-name">'+esc(t)+'</div><input type="text" list="prod-list" maxlength="80" autocomplete="off" placeholder="Product" aria-label="Product for '+esc(t)+'" data-mt="'+esc(t)+'" data-f="p" value="'+esc(v.p||"")+'"><input type="number" inputmode="decimal" step="0.01" min="0" placeholder="Cost" aria-label="Cost for '+esc(t)+'" data-mt="'+esc(t)+'" data-f="c" value="'+esc(v.c||"")+'"><div class="mt-calc calc">'+calcHTML(v.p||"",t)+'</div></div>';
    }).join("")+'</div>';
  }else{
    if(wasMulti&&sheetTasks.length===1){var v=multiVals[sheetTasks[0]];if(v){fp.value=v.p||"";fc.value=v.c||""}}
    mf.innerHTML="";sp.hidden=false;sc.hidden=false;
  }
  var btn=document.querySelector('[data-act="save-log"]');
  if(btn&&!editId&&sheetMode!=="expense")btn.textContent=sheetTasks.length>1?"Save "+sheetTasks.length+" entries":"Save entry";
}
var editId=null,sheetMode="log",formPhotos=[],origPhotos=[],newUploads=[],uploading=0;
function openSheet(task,cost,note,product,date,id,mode,photos,soilTemp){
  if(soilTemp===undefined||soilTemp==="")soilTemp=null;
  formPhotos=(photos||[]).slice();origPhotos=formPhotos.slice();newUploads=[];uploading=0;
  editId=id||null;sheetMode=mode||"log";var ex=sheetMode==="expense";
  sheetTask=task||null;sheetTasks=task?[task]:[];multiVals={};
  var multiOK=!editId&&!ex;
  document.getElementById("sheet").innerHTML='<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">'+
    '<h2 id="sheet-title">'+(editId?"Edit entry":ex?"Add expense":"Log work")+'</h2>'+
    '<fieldset><legend>'+(ex?"What it was for":multiOK?"Tasks (pick one or more)":"Task")+'</legend><div class="chips">'+TASKS.map(function(t){return '<button type="button" class="chip" data-act="pick-task" data-task="'+esc(t)+'" aria-pressed="'+(t===sheetTask)+'">'+esc(t)+'</button>'}).join("")+'</div></fieldset>'+
    '<div id="single-prod"><label class="field">'+(ex?"What you bought (optional)":"Product used (optional)")+'<div class="unit-row"><input type="text" id="f-product" list="prod-list" maxlength="80" autocomplete="off" placeholder="e.g. LESCO Dimension, Kentucky 31 seed" value="'+esc(product||"")+'"><button type="button" class="btn small" data-act="scan-into-log" aria-label="Scan a product barcode">Scan</button></div></label>'+
    '<datalist id="prod-list">'+productNames().map(function(p){return '<option value="'+esc(p)+'">'}).join("")+'</datalist>'+
    '<div class="calc" id="prod-calc"></div><div class="chips prod-chips" id="prod-chips"></div></div><div id="multi-fields"></div>'+
    '<label class="field">Date<input type="date" id="f-date" value="'+esc(date||todayISO())+'"></label>'+
    '<div id="single-cost"><label class="field">'+(ex?"Amount":"Cost (optional)")+'<input type="number" id="f-cost" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="'+esc(cost||"")+'"></label></div>'+
    (ex?'':'<label class="field">Soil temperature, \u00b0F (optional)<input type="number" id="f-soil" inputmode="decimal" step="0.1" min="-20" max="130" placeholder="From your thermometer" value="'+esc(soilTemp==null?"":soilTemp)+'"></label>')+
    '<div id="photo-field"></div>'+
    '<label class="field">Notes (optional)<textarea id="f-note" rows="2" maxlength="300" placeholder="Mower height, weather, how it went\u2026">'+esc(note||"")+'</textarea></label>'+
    '<p class="err" id="f-err" role="alert"></p><div class="actions"><button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn primary" data-act="save-log">'+(editId?"Save changes":ex?"Save expense":"Save entry")+'</button></div></div>';
  document.addEventListener("keydown",onKey);
  updateProductChips();renderPhotoField();refreshAllCalcs();
  var f=document.querySelector('.chip[aria-pressed="true"]')||document.querySelector(".chip");if(f)f.focus();
}
function closeSheet(){
  newUploads.forEach(photoDel);newUploads=[];
  document.getElementById("sheet").innerHTML="";document.removeEventListener("keydown",onKey);
}
function renderPhotoField(){
  var box=document.getElementById("photo-field");if(!box)return;
  box.innerHTML='<div class="field">Photos (optional)<div class="thumbs">'+formPhotos.map(function(id,i){
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
  if(!sheetTasks.length){err.textContent="Pick a task to save this entry.";return}
  var date=document.getElementById("f-date").value||todayISO();
  var raw=document.getElementById("f-cost").value.trim(),cost=0;
  if(raw){cost=parseFloat(raw);if(isNaN(cost)||cost<0){err.textContent="Enter the cost as a number, like 24.99.";return}}
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
      recs.push({id:uid()+mi,date:date,task:t,cost:Math.round(c*100)/100,note:note,product:String(v.p||"").trim().slice(0,80),photos:formPhotos.slice(),soilTemp:soilV,weather:date===todayISO()?wxNowText():""});
    }
    newUploads=[];
    recs.forEach(function(r){state.entries.push(r)});
    setStatus(recs.length+" tasks logged");closeSheet();persist();return;
  }
  var rec={date:date,task:sheetTask,cost:Math.round(cost*100)/100,note:document.getElementById("f-note").value.trim().slice(0,300),product:document.getElementById("f-product").value.trim().slice(0,80),photos:formPhotos.slice()};
  if(sheetMode!=="expense"){rec.soilTemp=soilV;if(!editId&&date===todayISO()&&wxNowText())rec.weather=wxNowText()}
  origPhotos.forEach(function(id){if(formPhotos.indexOf(id)<0)dropPhoto(id,editId)});
  newUploads=[];
  var ex=editId?state.entries.find(function(x){return x.id===editId}):null;
  if(ex){Object.assign(ex,rec);delete ex.quick}else state.entries.push(Object.assign({id:uid()},rec));
  closeSheet();persist();
}

/* ---------- backup ---------- */
function blobToDataURL(b){return new Promise(function(res){var r=new FileReader();r.onload=function(){res(r.result)};r.onerror=function(){res(null)};r.readAsDataURL(b)})}
function backupMsg(t){var m=document.getElementById("backup-msg");if(m)m.textContent=t}
function exportBackup(){
  backupMsg("Preparing backup\u2026");
  var ids=allPhotos().map(function(x){return x.id}),photos={};
  ids.reduce(function(p,id){return p.then(function(){return photoGet(id).then(function(b){return b?blobToDataURL(b):null}).then(function(d){if(d)photos[id]=d})})},Promise.resolve())
  .then(function(){
    var data=JSON.stringify({app:"turfdiary",version:1,exported:new Date().toISOString(),state:state,photos:photos});
    var a=document.createElement("a");a.href=URL.createObjectURL(new Blob([data],{type:"application/json"}));
    a.download="turfdiary-backup-"+todayISO()+".json";document.body.appendChild(a);a.click();
    setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},2000);
    backupMsg("Backup saved to your downloads.");
  }).catch(function(){backupMsg("Couldn\u2019t create the backup. Try again.")});
}
var pendingImport=null;
function readImport(file){
  var r=new FileReader();
  r.onload=function(){
    try{
      var j=JSON.parse(r.result);
      if(!j||(j.app!=="turfdiary"&&j.app!=="lawn-log")||!j.state||!Array.isArray(j.state.entries))throw new Error();
      pendingImport=j;
      document.getElementById("sheet").innerHTML='<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="i-title"><h2 id="i-title">Restore this backup?</h2>'+
        '<p class="note">It has '+j.state.entries.length+' '+pl(j.state.entries.length,"entry").replace("entrys","entries")+' and '+Object.keys(j.photos||{}).length+' photos. Restoring replaces everything currently in the app.</p>'+
        '<div class="actions"><button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn danger" data-act="confirm-import">Replace and restore</button></div></div>';
      document.addEventListener("keydown",onKey);
    }catch(e){backupMsg("That file isn\u2019t a TurfDiary backup.")}
  };
  r.readAsText(file);
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
  else if(a==="add-expense")openSheet("Supplies","","","","",null,"expense");
  else if(a==="open-log")openSheet(el.dataset.task);
  else if(a==="close-sheet")closeSheet();
  else if(a==="pick-task"){
    var tk=el.dataset.task;
    if(!editId&&sheetMode!=="expense"){var ti=sheetTasks.indexOf(tk);if(ti>=0)sheetTasks.splice(ti,1);else sheetTasks.push(tk)}
    else sheetTasks=[tk];
    sheetTask=sheetTasks[0]||null;
    document.querySelectorAll('[data-act="pick-task"]').forEach(function(c){c.setAttribute("aria-pressed",String(sheetTasks.indexOf(c.dataset.task)>=0))});
    document.getElementById("f-err").textContent="";updateProductChips();renderTaskFields();
  }
  else if(a==="pick-product"){var pi=document.getElementById("f-product");if(pi){pi.value=el.dataset.product;updateCalc(pi);pi.focus()}}
  else if(a==="save-log")saveLog();
  else if(a==="done-today"){
    var task=el.dataset.task,t=todayISO();
    if(state.entries.some(function(e){return e.task===task&&e.date===t})){setStatus(task+" is already logged for today");return}
    state.entries.push({id:uid(),date:t,task:task,cost:0,note:"",product:"",photos:[],quick:true,weather:wxNowText()});setStatus(task+" logged for today");persist();
  }
  else if(a==="edit-entry"){var en=state.entries.find(function(x){return x.id===el.dataset.id});if(en)openSheet(en.task,en.cost||"",en.note,en.product,en.date,en.id,null,en.photos,en.soilTemp)}
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
  else if(a==="export")exportBackup();
  else if(a==="notify-lead"){notifyCfg().lead=el.dataset.v;persist()}
  else if(a==="notify-task"){var nc=notifyCfg(),all=state.schedules.map(function(x){return x.task}),cur=nc.tasks?nc.tasks.slice():all.slice(),ix=cur.indexOf(el.dataset.task);if(ix>=0)cur.splice(ix,1);else cur.push(el.dataset.task);nc.tasks=cur.length===all.length?null:cur;persist()}
  else if(a==="prod-del-ask"){var dp=state.products.find(function(x){return x.id===el.dataset.id});if(dp){sheet2().innerHTML='<div class="scrim" data-act="prod-close"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="pd-title"><h2 id="pd-title">Delete this product?</h2><p class="note">Are you sure you want to delete <b>'+esc(dp.name)+'</b>? Its rate, price and barcode will be removed. This can\u2019t be undone. Work you already logged with it stays in your history.</p><div class="actions"><button class="btn ghost" data-act="prod-close">Cancel</button><button class="btn danger" data-act="prod-del-yes" data-id="'+esc(dp.id)+'">Delete</button></div></div>';var cb2=document.querySelector('#sheet2 [data-act="prod-close"].btn');if(cb2)cb2.focus()}}
  else if(a==="prod-del-yes"){var did2=el.dataset.id;state.products=state.products.filter(function(x){return x.id!==did2});closeSheet2();persist()}
  else if(a==="hist-task"){histFilter=state.entries.some(function(e){return e.task===el.dataset.task})?el.dataset.task:"all";tab="history";try{localStorage.setItem(LS_TAB,tab)}catch(e){}render();window.scrollTo(0,0)}
  else if(a==="plus")openPlus();
  else if(a==="plus-log"){closeSheet();openSheet()}
  else if(a==="plus-prod"){closeSheet();openProduct(null)}
  else if(a==="plus-scan"){closeSheet();openScanner(function(code){var p=findByUpc(code);if(p)showProductCard(p);else showUnknownCode(normUpc(code)||code)})}
  else if(a==="plus-exp"){closeSheet();openSheet("Supplies","","","","",null,"expense")}
  else if(a==="scan-lookup")openScanner(function(code){var p=findByUpc(code);if(p)showProductCard(p);else showUnknownCode(normUpc(code)||code)});
  else if(a==="scan-close")closeScanner();
  else if(a==="use-cost"){var tg=el.dataset.t,inp=tg==="f"?document.getElementById("f-cost"):Array.prototype.find.call(document.querySelectorAll('[data-mt][data-f="c"]'),function(x){return x.dataset.mt===tg});if(inp){inp.value=el.dataset.v;inp.dispatchEvent(new Event("input",{bubbles:true}))}}
  else if(a==="scan-typed"){var tn=normUpc(document.getElementById("scan-num").value);if(!tn){document.getElementById("scan-hint").textContent="Enter the 6 to 14 digit number under the barcode.";return}var cbk=SCAN.onCode;closeScanner();cbk(tn)}
  else if(a==="scan-into-product")openScanner(function(code){var u=document.getElementById("p-upc");if(u)u.value=normUpc(code)||code;var ex2=findByUpc(code);var e2=document.getElementById("p-err");if(ex2&&ex2.id!==prodEditId&&e2)e2.textContent="That barcode is already saved for "+ex2.name+"."});
  else if(a==="scan-into-log")openScanner(function(code){var p=findByUpc(code),fi=document.getElementById("f-product");if(p&&fi){fi.value=p.name;updateCalc(fi)}else openProduct(null,fi?fi.value:"",normUpc(code)||code)});
  else if(a==="pc-log"){var nm=el.dataset.name;closeSheet2();openSheet(null,"","",nm)}
  else if(a==="uc-add"){var up=el.dataset.upc;closeSheet2();openProduct(null,"",up)}
  else if(a==="prod-new")openProduct(null,el.dataset.name);
  else if(a==="prod-edit")openProduct(el.dataset.id);
  else if(a==="prod-close")closeSheet2();
  else if(a==="prod-save")saveProduct();
  else if(a==="prod-mode"){prodMode=el.dataset.mode;document.querySelectorAll('[data-act="prod-mode"]').forEach(function(c){c.setAttribute("aria-pressed",String(c===el))});document.getElementById("p-cover").hidden=prodMode!=="cover";document.getElementById("p-rate").hidden=prodMode!=="rate"}
  else if(a==="prod-del"){if(prodEditId){state.products=state.products.filter(function(x){return x.id!==prodEditId});saveQuiet();closeSheet2();if(document.getElementById("f-product"))refreshAllCalcs();else render()}}
  else if(a==="lawn-map")openMap();
  else if(a==="lawn-manual")openManualLawn();
  else if(a==="ml-save"){var mv=parseFloat(document.getElementById("ml-n").value);state.lawn.manual=mv>0?Math.round(mv):null;closeSheet2();persist()}
  else if(a==="lawn-del"){state.lawn.areas.splice(+el.dataset.i,1);persist()}
  else if(a==="map-close")closeMap();
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
document.addEventListener("input",function(ev){var t=ev.target;if(t.id==="f-product"||(t.dataset&&t.dataset.mt&&t.dataset.f==="p"))updateCalc(t)});
document.addEventListener("keydown",function(ev){if(ev.key==="Enter"&&ev.target.id==="scan-num"){ev.preventDefault();var b=document.querySelector('[data-act="scan-typed"]');if(b)b.click();return}if((ev.key==="Enter"||ev.key===" ")&&ev.target.classList&&ev.target.classList.contains("wx-today")){ev.preventDefault();ev.target.click()}});
document.addEventListener("change",function(ev){
  var el=ev.target,a=el.dataset&&el.dataset.act;
  if(a==="add-photo"){addPhotos(el.files);el.value="";return}
  if(a==="notify-on"){var nc2=notifyCfg();nc2.on=el.checked;var LN2=nativeNotify();if(el.checked&&LN2){LN2.requestPermissions().then(function(r){if(r&&r.display!=="granted"){nc2.on=false;setStatus("Notifications are blocked. Allow them for TurfDiary in your phone\u2019s settings.")}persist()}).catch(function(){persist()})}else persist();return}
  if(a==="notify-time"){notifyCfg().time=el.value||"08:00";persist();return}
  if(a==="import"){if(el.files[0])readImport(el.files[0]);el.value="";return}
  if(a==="sched-every"){var n=parseInt(el.value,10);if(n>=1&&n<=365){state.schedules[+el.dataset.i].every=n;persist()}else render()}
  else if(a==="hist-filter"){histFilter=el.value;render()}
  else if(a==="spend-year"){spendYear=+el.value;render()}
});

render();
scheduleNotifications();
loadWx(false);
document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible")loadWx(false)});
if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().catch(function(){});
})();
