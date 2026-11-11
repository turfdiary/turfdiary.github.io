(function(){
"use strict";
var TASKS=["Mow","Edge","Trim","Fertilize","Weed control","Water","Aerate","Overseed","Leaves","Supplies","Other"];
var LS="lawnlog-state",LS_TAB="lawnlog-tab";
var DEFAULT_STATE={v:1,updatedAt:0,entries:[],schedules:[{task:"Mow",every:7},{task:"Edge",every:14},{task:"Water",every:14}]};

var state;
try{state=JSON.parse(localStorage.getItem(LS)||"null")}catch(e){state=null}
if(!state||!Array.isArray(state.entries))state=JSON.parse(JSON.stringify(DEFAULT_STATE));
if(!Array.isArray(state.schedules))state.schedules=[];
var tab="home";try{tab=localStorage.getItem(LS_TAB)||"home"}catch(e){}
if(["home","history","spend","remind","settings"].indexOf(tab)<0)tab="home";
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
  var step=loc.forecastUrl?Promise.resolve(loc):nwsJSON("https://api.weather.gov/points/"+loc.lat+","+loc.lon).then(function(j){
    var pr=j.properties||{};
    if(!pr.forecast)throw{code:"notfound"};
    var rl=pr.relativeLocation&&pr.relativeLocation.properties;
    loc.forecastUrl=pr.forecast;loc.place=rl&&rl.city?rl.city+", "+rl.state:"Your area";saveQuiet();
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
  }).catch(function(e){
    wxErr=e&&e.code==="outside"?"Weather is only available for locations in the United States.":"Couldn\u2019t load the forecast right now. The weather service may be busy, so try again in a few minutes.";
  }).then(function(){wxLoading=false;refreshWxCard()});
}
function wxNowText(){
  if(!wx||wx.key!==wxKey()||!wx.periods.length)return "";
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
var wxSel=0;
function wxDays(periods){
  var days=[];
  periods.forEach(function(p,i){
    var last=days[days.length-1];
    if(!p.day&&last&&last.low==null&&last.high!=null){last.low=p.temp;last.night=p.short;if(p.pop!=null)last.pop=Math.max(last.pop==null?0:last.pop,p.pop);return}
    var label=i===0?(p.day?"Today":"Tonight"):p.name,full=i===0?label:p.name;
    if(i>0&&p.start){var dt=new Date(p.start.slice(0,10)+"T12:00:00");if(!isNaN(dt)){label=dt.toLocaleDateString(undefined,{weekday:"short"});full=dt.toLocaleDateString(undefined,{weekday:"long"})}}
    days.push({label:label,full:full,short:p.short,high:p.day?p.temp:null,low:p.day?null:p.temp,pop:p.pop});
  });
  return days.slice(0,7);
}
function wxDayText(x){
  if(!x)return "";
  var t=x.full+": "+x.short+(x.night&&wxKind(x.night,true)!==wxKind(x.short,true)&&/rain|shower|drizzle|thunder|snow|sleet/i.test(x.night)?", then "+x.night.toLowerCase()+" at night":"")+".";
  if(x.high!=null)t+=" High "+x.high+"\u00b0";
  if(x.low!=null)t+=(x.high!=null?", low ":" Low ")+x.low+"\u00b0";
  if(x.pop!=null)t+=", "+x.pop+"% chance of rain";
  return t+".";
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
  var n=d.periods[0],days=wxDays(d.periods),t0=days[0];
  if(wxSel>=days.length)wxSel=0;
  var rainTxt=t0&&t0.pop!=null?t0.pop+"% chance of rain "+(t0.high!=null&&t0.low!=null?"today or tonight":t0.high!=null?"today":"tonight"):"";
  h+='<div class="soil-top" style="margin-top:10px"><div><div class="soil-now">'+esc(n.temp)+'\u00b0'+esc(n.unit)+'</div><div class="m">'+esc((t0?t0.label:n.name)+": "+n.short)+'</div></div>'+
     (rainTxt?'<div class="soil-deep">'+esc(rainTxt)+'</div>':'')+'</div>';
  h+='<div class="wx-strip" role="group" aria-label="7-day forecast">'+days.map(function(x,i){
    return '<button type="button" class="wx-day'+(i===wxSel?' sel':'')+'" data-act="wx-day" data-i="'+i+'" aria-pressed="'+(i===wxSel)+'" aria-label="'+esc(wxDayText(x))+'">'+
      '<span class="wx-dname">'+esc(x.label)+'</span>'+wxIcon(wxIconText(x),x.high==null)+
      '<span class="wx-dpop'+(x.pop!=null&&x.pop>=20?' wet':'')+'">'+(x.pop!=null?esc(x.pop)+'%':'\u2013')+'</span>'+
      '<span class="wx-hi">'+(x.high!=null?esc(x.high)+'\u00b0':'\u2013')+'</span>'+
      '<span class="wx-lo">'+(x.low!=null?esc(x.low)+'\u00b0':'')+'</span></button>';
  }).join("")+'</div>';
  h+='<p class="wx-detail" id="wx-detail" aria-live="polite">'+esc(wxDayText(days[wxSel]))+'</p>';
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
  var t=todayISO(),last=lastDone("Mow"),big,sub;
  if(!last){big="Not yet";sub="Log a mow to start the count."}
  else{var n=daysBetween(last,t);big=n<=0?"Today":n===1?"Yesterday":n+" days ago";sub=fmtLong(last)}
  var h='<section class="hero"><div class="hero-top"><span>Last mow</span><span class="status-text" id="status" aria-live="polite">'+esc(statusText)+'</span></div>'+
    '<div class="big">'+esc(big)+'</div><div class="hero-sub">'+esc(sub)+'</div><button class="btn" data-act="open-log">Log work</button></section>';
  h+=wxCardHTML();
  h+='<h2>Coming up</h2>';
  var items=dueItems();
  if(!items.length)h+='<p class="empty">No reminders set. <button class="link" data-act="tab" data-tab="remind">Add a reminder</button></p>';
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
  var h='<h1 class="page">Settings</h1><h2 style="margin-top:0">Weather</h2>'+wxSettingsHTML()+'<h2>Backup</h2><div class="settings-block"><p>Your log and photos are saved only on this phone. Save a backup file now and then, especially before switching phones.</p>'+
     '<div class="toolbar" style="justify-content:flex-start"><button class="btn primary" data-act="export">Save backup</button><label class="btn file-btn">Restore backup<input type="file" accept="application/json,.json" class="vh" data-act="import" aria-label="Choose a backup file to restore"></label></div>'+
     '<p class="err" id="backup-msg" role="status" style="margin-top:10px"></p></div>';
  return h;
}
function render(){
  var v=tab==="history"?viewHistory():tab==="spend"?viewSpend():tab==="remind"?viewRemind():tab==="settings"?viewSettings():viewHome();
  var tabs=[["home","Home"],["history","History"],["spend","Spending"],["remind","Reminders"],["settings","Settings"]];
  document.getElementById("root").innerHTML='<main>'+v+'</main><nav class="tabs" aria-label="Sections"><div class="in">'+
    tabs.map(function(t){return '<button data-act="tab" data-tab="'+t[0]+'"'+(tab===t[0]?' aria-current="page"':'')+'>'+t[1]+'</button>'}).join("")+'</div></nav>';
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
      return '<div class="mt-row"><div class="mt-name">'+esc(t)+'</div><input type="text" list="prod-list" maxlength="80" autocomplete="off" placeholder="Product" aria-label="Product for '+esc(t)+'" data-mt="'+esc(t)+'" data-f="p" value="'+esc(v.p||"")+'"><input type="number" inputmode="decimal" step="0.01" min="0" placeholder="Cost" aria-label="Cost for '+esc(t)+'" data-mt="'+esc(t)+'" data-f="c" value="'+esc(v.c||"")+'"></div>';
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
    '<div id="single-prod"><label class="field">'+(ex?"What you bought (optional)":"Product used (optional)")+'<input type="text" id="f-product" list="prod-list" maxlength="80" autocomplete="off" placeholder="e.g. LESCO Dimension, Kentucky 31 seed" value="'+esc(product||"")+'"></label>'+
    '<datalist id="prod-list">'+recentProducts().map(function(p){return '<option value="'+esc(p)+'">'}).join("")+'</datalist>'+
    '<div class="chips prod-chips" id="prod-chips"></div></div><div id="multi-fields"></div>'+
    '<label class="field">Date<input type="date" id="f-date" value="'+esc(date||todayISO())+'"></label>'+
    '<div id="single-cost"><label class="field">'+(ex?"Amount":"Cost (optional)")+'<input type="number" id="f-cost" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="'+esc(cost||"")+'"></label></div>'+
    (ex?'':'<label class="field">Soil temperature, \u00b0F (optional)<input type="number" id="f-soil" inputmode="decimal" step="0.1" min="-20" max="130" placeholder="From your thermometer" value="'+esc(soilTemp==null?"":soilTemp)+'"></label>')+
    '<div id="photo-field"></div>'+
    '<label class="field">Notes (optional)<textarea id="f-note" rows="2" maxlength="300" placeholder="Mower height, weather, how it went\u2026">'+esc(note||"")+'</textarea></label>'+
    '<p class="err" id="f-err" role="alert"></p><div class="actions"><button class="btn ghost" data-act="close-sheet">Cancel</button><button class="btn primary" data-act="save-log">'+(editId?"Save changes":ex?"Save expense":"Save entry")+'</button></div></div>';
  document.addEventListener("keydown",onKey);
  updateProductChips();renderPhotoField();
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
  else if(a==="pick-product"){var pi=document.getElementById("f-product");if(pi){pi.value=el.dataset.product;pi.focus()}}
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
  else if(a==="wx-gps")wxUseGPS();
  else if(a==="wx-retry")loadWx(true);
  else if(a==="wx-day"){wxSel=+el.dataset.i;document.querySelectorAll(".wx-day").forEach(function(b,i){b.classList.toggle("sel",i===wxSel);b.setAttribute("aria-pressed",String(i===wxSel))});var dd=document.getElementById("wx-detail");if(dd&&wx)dd.textContent=wxDayText(wxDays(wx.periods)[wxSel])}
  else if(a==="wx-remove"){state.wxLoc=null;wx=null;wxErr="";try{localStorage.removeItem(LS_WX)}catch(e){}persist()}
  else if(a==="confirm-import")confirmImport();
});
document.addEventListener("change",function(ev){
  var el=ev.target,a=el.dataset&&el.dataset.act;
  if(a==="add-photo"){addPhotos(el.files);el.value="";return}
  if(a==="import"){if(el.files[0])readImport(el.files[0]);el.value="";return}
  if(a==="sched-every"){var n=parseInt(el.value,10);if(n>=1&&n<=365){state.schedules[+el.dataset.i].every=n;persist()}else render()}
  else if(a==="hist-filter"){histFilter=el.value;render()}
  else if(a==="spend-year"){spendYear=+el.value;render()}
});

render();
loadWx(false);
document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible")loadWx(false)});
if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().catch(function(){});
})();
