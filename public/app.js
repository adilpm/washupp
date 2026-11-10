const content=document.querySelector('#content');
const message=document.querySelector('#message');
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const money=price=>new Intl.NumberFormat('en-SA',{style:'currency',currency:'SAR',maximumFractionDigits:0}).format(price);
const when=start=>new Intl.DateTimeFormat('en-SA',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Riyadh'}).format(start);
let state, map, marker, pin, watch, dutyPosition, authMode='login', offerId, refreshNumber=0;
const notice=text=>{message.textContent=text;};
async function api(path,data){
  const options=data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{};
  const response=await fetch('/api/'+path,options);
  const result=await response.json();
  if(!response.ok)throw new Error(result.error);
  return result;
}
const fields='<label>Mobile number<input name="phone" type="tel" placeholder="05XXXXXXXX" required></label><label>Password<input name="password" type="password" minlength="8" maxlength="128" required></label>';
function offerForm(offer={}){
  return `<form data-action="offers" class="inline"><input name="id" type="hidden" value="${offer.id??''}"><label>Name<input name="name" value="${escapeHtml(offer.name)}" required maxlength="80"></label><label>Price (SAR)<input name="price" type="number" min="0" value="${offer.price??''}" required></label><label>Minutes<input name="minutes" type="number" min="5" max="900" value="${offer.minutes??''}" required></label><label>Type<select name="kind"><option>Service</option><option ${offer.kind==='Combo'?'selected':''}>Combo</option></select></label><button>${offer.id?'Save':'Add offer'}</button></form>`;
}
function bookings(){
  const {role}=state.user;
  return `<section class="panel"><h2>${role==='admin'?'Dispatch queue':role==='captain'?'Assigned jobs':'My bookings'}</h2><div id="jobs"></div></section>`;
}
function renderJobs(){
  const el=document.querySelector('#jobs');
  if(!el)return;
  const role=state.user.role;
  el.innerHTML=state.jobs.map(job=>{
    const next={Assigned:'On the way','On the way':'Washing',Washing:'Completed'}[job.status];
    const captainOptions=state.captains.map(c=>`<option value="${c.id}" ${job.captain===c.id?'selected':''}>${escapeHtml(c.phone)}</option>`).join('');
    const assign=role==='admin'&&['Pending','Assigned'].includes(job.status)&&captainOptions?`<form data-action="assign" class="inline"><input name="id" type="hidden" value="${job.id}"><label>Captain<select name="captain">${captainOptions}</select></label><button>Assign</button></form>`:'';
    const progress=role==='captain'&&next?`<form data-action="progress"><input name="id" type="hidden" value="${job.id}"><input name="status" type="hidden" value="${next}">${next==='Completed'?'<label>Completion photo<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required></label>':''}<button>${next==='Completed'?'Finish wash':next}</button></form>`:'';
    const review=role==='customer'&&job.status==='Completed'?`<form data-action="review"><input name="id" type="hidden" value="${job.id}"><label>Rating<select name="rating">${[5,4,3,2,1].map(r=>`<option value="${r}" ${r===job.rating?'selected':''}>${r} out of 5</option>`).join('')}</select></label><label>Feedback<textarea name="feedback" maxlength="500">${escapeHtml(job.feedback)}</textarea></label><button>Save feedback</button></form>`:'';
    return `<article class="job"><div class="row"><strong>#${job.id} · ${escapeHtml(job.offer)}</strong><span class="tag">${job.status}</span></div><p>${when(job.start)} · ${money(job.price)}${job.captainPhone?' · Captain '+escapeHtml(job.captainPhone):''}</p>${role==='captain'?'<a href="https://www.openstreetmap.org/?mlat='+job.lat+'&mlon='+job.lon+'#map=17/'+job.lat+'/'+job.lon+'" target="_blank" rel="noopener">Open location</a>':''}${job.hasPhoto?`<a href="/api/photo/${job.id}" target="_blank" rel="noopener"><img class="proof" src="/api/photo/${job.id}" alt="Wash completion photo" loading="lazy"></a>`:''}${assign}${progress}${review}${role==='admin'&&job.rating?`<p>Rating ${job.rating}/5 · ${escapeHtml(job.feedback)}</p>`:''}</article>`;
  }).join('')||'<p class="muted">No bookings yet.</p>';
}
function setPin(lat,lon){
  pin={lat,lon};
  const label=document.querySelector('#pin');
  if(label)label.textContent=`Pin selected · ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  if(map){
    if(marker)marker.setLatLng([lat,lon]);
    else marker=L.marker([lat,lon]).addTo(map);
  }
}
function locate(callback){
  if(!navigator.geolocation)return notice('Location is unavailable in this browser.');
  navigator.geolocation.getCurrentPosition(({coords})=>callback(coords.latitude,coords.longitude),()=>notice('Could not get your location. Check browser permissions.'),{enableHighAccuracy:true,timeout:12000});
}
function render(){
  map?.remove();map=marker=null;
  const user=state.user;
  if(!user){
    content.innerHTML=`<section class="panel auth"><h2>${authMode==='login'?'Sign in':'Create your account'}</h2><form data-action="${authMode}">${fields}<button>${authMode==='login'?'Sign in':'Create account'}</button></form><button class="link" id="toggle-auth">${authMode==='login'?'New to Washupp? Create account':'Already have an account? Sign in'}</button></section>`;
    return;
  }
  const account=`<div class="row account"><span>${escapeHtml(user.phone)} · ${user.role}</span><form data-action="logout"><button class="secondary">Sign out</button></form></div>`;
  if(user.role==='admin'){
    content.innerHTML=account+`<section class="panel"><h2>Services & combos</h2>${state.offers.map(offerForm).join('')}${offerForm()}</section><section class="panel"><h2>Add a captain</h2><form data-action="captains" class="inline">${fields}<button>Add captain</button></form><p class="muted">${state.captains.map(c=>escapeHtml(c.phone)).join(' · ')}</p></section>`+bookings();
  }else if(user.role==='captain'){
    content.innerHTML=account+`<section class="panel"><h2>Captain duty</h2><p>Keep this app open while on duty to share a recent location for dispatch.</p><button id="duty">${watch==null?'Go on duty':'Go off duty'}</button></section>`+bookings();
  }else{
    content.innerHTML=account+`<section class="panel"><h2>Book a wash</h2><form data-action="book"><fieldset><legend>Choose your wash</legend><div class="offers">${state.offers.map((offer,i)=>`<label class="offer"><input type="radio" name="offer" value="${offer.id}" ${(offerId?offer.id===offerId:i===0)?'checked':''} required><span><strong>${escapeHtml(offer.name)}</strong><small>${offer.kind} · ${offer.minutes} min</small></span><b>${money(offer.price)}</b></label>`).join('')}</div></fieldset><fieldset><legend>Where’s the car?</legend><div id="map" aria-label="Pick your location in Dammam"></div><div class="row"><span id="pin">Tap the map to set your pin</span><button class="secondary" type="button" id="locate">Use my location</button></div></fieldset><fieldset><legend>When?</legend><label>Booking type<select id="mode"><option>Wash now</option><option>Schedule a wash</option></select></label><label id="time" hidden>Riyadh time<input name="start" type="datetime-local" disabled></label></fieldset><button>Confirm booking</button><p class="muted">Pay after the wash.</p></form></section>`+bookings();
    if(globalThis.L){
      map=L.map('map').setView([26.42,50.09],12);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(map);
      map.on('click',e=>setPin(e.latlng.lat,e.latlng.lng));
    }else document.querySelector('#map').textContent='Map unavailable. You can still use your current location.';
    if(pin)setPin(pin.lat,pin.lon);
  }
  renderJobs();
}
async function refresh(full=false){
  const number=++refreshNumber;
  const next=await api('state');
  if(number!==refreshNumber)return;
  const previous=state;
  state=next;
  if(full||previous?.user?.id!==next.user?.id)return render();
  if(JSON.stringify(previous.jobs)===JSON.stringify(next.jobs))return;
  if(document.activeElement?.closest('#jobs')){state=previous;return;}
  if(next.user?.role==='customer'&&next.jobs.some(job=>job.status==='Completed'&&previous.jobs.some(old=>old.id===job.id&&old.status!=='Completed')))notice('Your wash is complete. Open My bookings to see the photo and leave feedback.');
  renderJobs();
}
content.addEventListener('change',event=>{
  if(event.target.id!=='mode')return;
  const scheduled=event.target.selectedIndex===1;
  const label=document.querySelector('#time');
  label.hidden=!scheduled;
  label.firstElementChild.disabled=!scheduled;
  label.firstElementChild.required=scheduled;
});
content.addEventListener('click',async event=>{
  try{
    if(event.target.id==='toggle-auth'){authMode=authMode==='login'?'signup':'login';notice('');render();}
    if(event.target.id==='locate')locate((lat,lon)=>{setPin(lat,lon);map?.setView([lat,lon],16);});
    if(event.target.id==='duty'){
      if(watch!=null){navigator.geolocation.clearWatch(watch);watch=null;dutyPosition=null;await api('duty',{active:false});render();return;}
      if(!navigator.geolocation)throw new Error('Location is unavailable in this browser.');
      watch=navigator.geolocation.watchPosition(async({coords})=>{
        dutyPosition={active:true,lat:coords.latitude,lon:coords.longitude}; try{await api('duty',dutyPosition);}catch(error){notice(error.message);}
      },()=>{navigator.geolocation.clearWatch(watch);watch=null;dutyPosition=null;render();notice('Location permission is required for duty.');},{enableHighAccuracy:true});
      render();
    }
  }catch(error){notice(error.message);}
});
content.addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.target;
  const button=form.querySelector('button');
  button.disabled=true;
  const data=Object.fromEntries(new FormData(form));
  const action=form.dataset.action;
  try{
    if(action==='book'){
      if(!pin)throw new Error('Drop a pin or use your current location.');
      Object.assign(data,pin);
      offerId=Number(data.offer);
    }
    if(data.photo instanceof File){
      if(data.photo.size>2_000_000)throw new Error('Choose a photo under 2 MB.');
      data.photo=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(data.photo);});
    }
    if(action==='logout'&&watch!=null){
      navigator.geolocation.clearWatch(watch);watch=null;dutyPosition=null;
      await api('duty',{active:false});
    }
    await api(action,data);
    if(action==='logout'){pin=null;offerId=null;authMode='login';}
    await refresh(true);
    notice(action==='book'?'Booking received. Check My bookings for your assignment.':action==='review'?'Feedback saved.':'Saved.');
  }catch(error){notice(error.message);}finally{button.disabled=false;}
});
refresh(true).catch(error=>notice(error.message));
setInterval(()=>refresh().catch(()=>{}),12000);
setInterval(()=>{if(watch!=null&&dutyPosition)api('duty',dutyPosition).catch(error=>notice(error.message));},60000);
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
