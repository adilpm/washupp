import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {mkdirSync,readFileSync} from 'node:fs';

const dataDirectory=process.env.DATA_DIR||'data';
mkdirSync(dataDirectory,{recursive:true});
const db=new DatabaseSync(dataDirectory+'/washupp.sqlite');
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, phone TEXT UNIQUE, password TEXT, role TEXT, lat REAL, lon REAL, seen INTEGER);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user INTEGER, expires INTEGER);
CREATE TABLE IF NOT EXISTS offers(id INTEGER PRIMARY KEY, name TEXT, price INTEGER, minutes INTEGER, kind TEXT);
CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY, customer INTEGER, captain INTEGER, offer TEXT, price INTEGER, minutes INTEGER, start INTEGER, lat REAL, lon REAL, status TEXT, photo TEXT, rating INTEGER, feedback TEXT);
INSERT OR IGNORE INTO offers VALUES(1,'Exterior wash',35,30,'Service'),(2,'Inside + outside',65,60,'Combo');
`);
const one=(sql,...args)=>db.prepare(sql).get(...args);
const all=(sql,...args)=>db.prepare(sql).all(...args);
const run=(sql,...args)=>db.prepare(sql).run(...args);
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const phoneOf=value=>String(value??'').replace(/[\s-]/g,'').replace(/^05/,'+9665');
const digest=(value,salt)=>scryptSync(value,salt,64);
function addUser(phone,password,role){
  if(!/^\+9665\d{8}$/.test(phone)||typeof password!=='string'||password.length<8||password.length>128) fail('Use a Saudi mobile number and an 8–128 character password.');
  if(one('SELECT id FROM users WHERE phone=?',phone)) fail('This mobile number already has an account.',409);
  const salt=randomBytes(16).toString('hex');
  return run('INSERT INTO users(phone,password,role) VALUES(?,?,?)',phone,salt+':'+digest(password,salt).toString('hex'),role).lastInsertRowid;
}
if(process.env.ADMIN_PHONE&&process.env.ADMIN_PASSWORD&&!one("SELECT id FROM users WHERE role='admin'"))
  addUser(phoneOf(process.env.ADMIN_PHONE),process.env.ADMIN_PASSWORD,'admin');

const assets={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css'],'/sw.js':['sw.js','text/javascript'],'/manifest.webmanifest':['manifest.webmanifest','application/manifest+json'],'/icon.svg':['icon.svg','image/svg+xml']};
const secure=process.env.NODE_ENV==='production'?'; Secure':'';
function send(res,status,value){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
async function body(req){
  let data='';
  for await(const part of req){data+=part;if(data.length>3_000_000)fail('Photo or request is too large.',413);}
  try{return JSON.parse(data||'{}');}catch{fail('Invalid request.');}
}
function coordinates(lat,lon){
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)fail('Choose a valid location.');
}
function hours(start,minutes){
  const local=new Date(start+3*3600_000);
  const minute=local.getUTCHours()*60+local.getUTCMinutes();
  if(!Number.isFinite(start)||minute<480||minute+minutes>1380)fail('Choose a time that fits between 8 AM and 11 PM Riyadh time.');
}
function available(id,start,minutes){
  return !one("SELECT id FROM jobs WHERE captain=? AND status<>'Completed' AND start<? AND start+minutes*60000>?",id,start+minutes*60000,start);
}
async function dispatch(job){
  const captains=all("SELECT id,lat,lon FROM users WHERE role='captain' AND seen>?",Date.now()-300_000)
    .filter(c=>available(c.id,job.start,job.minutes));
  const key=process.env.OPENROUTESERVICE_API_KEY;
  if(!key||!captains.length)return;
  const locations=[...captains.map(c=>[c.lon,c.lat]),[job.lon,job.lat]];
  try{
    const response=await fetch('https://api.openrouteservice.org/v2/matrix/driving-car',{
      method:'POST',headers:{Authorization:key,'Content-Type':'application/json'},
      body:JSON.stringify({locations,sources:captains.map((_,index)=>index),destinations:[captains.length]}),
      signal:AbortSignal.timeout(5000)
    });
    if(!response.ok)return;
    const {durations}=await response.json();
    const ranked=captains.map((captain,i)=>({id:captain.id,time:durations?.[i]?.[0]}))
      .filter(c=>Number.isFinite(c.time)).sort((a,b)=>a.time-b.time);
    const best=ranked.find(c=>available(c.id,job.start,job.minutes)&&one('SELECT id FROM users WHERE id=? AND seen>?',c.id,Date.now()-300_000));
    if(best)run("UPDATE jobs SET captain=?,status='Assigned' WHERE id=? AND status='Pending'",best.id,job.id);
  }catch{ /* Pending jobs are available for manual assignment. */ }
}
function visibleJobs(user){
  const filter=user.role==='admin'?'':user.role==='captain'?'WHERE j.captain=?':'WHERE j.customer=?';
  return all(`SELECT j.id,j.captain,j.offer,j.price,j.start,j.lat,j.lon,j.status,j.photo IS NOT NULL AS hasPhoto,j.rating,j.feedback,u.phone AS captainPhone FROM jobs j LEFT JOIN users u ON u.id=j.captain ${filter} ORDER BY j.id DESC`,...(filter?[user.id]:[]));
}
const attempts=new Map();
setInterval(()=>{for(const [ip,entry] of attempts)if(entry.until<Date.now())attempts.delete(ip);},60_000).unref();
createServer(async(req,res)=>{
  try{
    const path=new URL(req.url,'http://localhost').pathname;
    if(req.method==='GET'&&assets[path]){
      const [file,type]=assets[path];res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff'});return res.end(readFileSync('public/'+file));
    }
    const token=/\bwashupp=([a-f0-9]{64})/.exec(req.headers.cookie||'')?.[1];
    const user=token&&one('SELECT u.id,u.phone,u.role FROM sessions s JOIN users u ON u.id=s.user WHERE token=? AND expires>?',token,Date.now());
    if(req.method==='GET'&&path==='/api/state')return send(res,200,{
      user,offers:all('SELECT * FROM offers ORDER BY id'),jobs:user?visibleJobs(user):[],
      captains:user?.role==='admin'?all("SELECT id,phone,seen FROM users WHERE role='captain'"):[]});
    const photoMatch=/^\/api\/photo\/(\d+)$/.exec(path);
    if(req.method==='GET'&&photoMatch){
      const job=one('SELECT * FROM jobs WHERE id=?',Number(photoMatch[1]));
      if(!user||!job?.photo||!(user.role==='admin'||job.customer===user.id||job.captain===user.id))fail('Photo unavailable.',404);
      const [,type,content]=/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(job.photo);
      res.writeHead(200,{'Content-Type':type,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});return res.end(Buffer.from(content,'base64'));
    }
    if(req.method!=='POST'||!path.startsWith('/api/'))fail('Page unavailable.',404);
    if(!req.headers['content-type']?.startsWith('application/json'))fail('Expected JSON.',415);
    const input=await body(req);
    if(!input||typeof input!=='object'||Array.isArray(input))fail('Invalid request.');
    if(path==='/api/signup'||path==='/api/login'){
      const ip=req.socket.remoteAddress;
      const previous=attempts.get(ip);
      const entry=previous?.until>Date.now()?previous:{count:0,until:Date.now()+60_000};
      attempts.set(ip,entry);
      if(++entry.count>15)fail('Try again in a minute.',429);
      const phone=phoneOf(input.phone);
      let id;
      if(path==='/api/signup')id=addUser(phone,input.password,'customer');
      else{
        const account=one('SELECT * FROM users WHERE phone=?',phone);
        const [salt,hash]=(account?.password||'missing:'+ '0'.repeat(128)).split(':');
        if(typeof input.password!=='string'||input.password.length>128||!timingSafeEqual(digest(input.password,salt),Buffer.from(hash,'hex'))||!account)fail('Incorrect mobile number or password.',401);
        id=account.id;
      }
      const session=randomBytes(32).toString('hex');
      run('DELETE FROM sessions WHERE expires<? OR token=?',Date.now(),token||'');
      run('INSERT INTO sessions VALUES(?,?,?)',session,id,Date.now()+7*86400_000);
      res.setHeader('Set-Cookie',`washupp=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`);
      return send(res,200,{ok:true});
    }
    if(!user)fail('Sign in to continue.',401);
    if(path==='/api/logout'){
      run('DELETE FROM sessions WHERE token=?',token);
      res.setHeader('Set-Cookie',`washupp=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
    }else if(path==='/api/book'&&user.role==='customer'){
      const offer=one('SELECT * FROM offers WHERE id=?',Number(input.offer));
      if(!offer)fail('Choose a service.');
      const {lat,lon}=input;
      coordinates(lat,lon);
      if(lat<26.29||lat>26.53||lon<49.95||lon>50.22)fail('Baraq currently serves Dammam only.');
      const start=input.start?Date.parse(input.start+'+03:00'):Date.now();
      if(input.start&&start<Date.now())fail('Choose a future time.');
      hours(start,offer.minutes);
      const id=run("INSERT INTO jobs(customer,offer,price,minutes,start,lat,lon,status) VALUES(?,?,?,?,?,?,?,'Pending')",user.id,offer.name,offer.price,offer.minutes,start,lat,lon).lastInsertRowid;
      if(!input.start)await dispatch({id,start,minutes:offer.minutes,lat,lon});
    }else if(path==='/api/duty'&&user.role==='captain'){
      if(input.active){coordinates(input.lat,input.lon);run('UPDATE users SET lat=?,lon=?,seen=? WHERE id=?',input.lat,input.lon,Date.now(),user.id);}
      else run('UPDATE users SET seen=NULL WHERE id=?',user.id);
    }else if(path==='/api/captains'&&user.role==='admin'){
      addUser(phoneOf(input.phone),input.password,'captain');
    }else if(path==='/api/offers'&&user.role==='admin'){
      const name=String(input.name??'').trim(),price=Number(input.price),minutes=Number(input.minutes);
      if(!name||name.length>80||!Number.isInteger(price)||price<0||!Number.isInteger(minutes)||minutes<5||minutes>900||!['Service','Combo'].includes(input.kind))fail('Enter a valid offer, whole SAR price, and duration.');
      if(input.id)run('UPDATE offers SET name=?,price=?,minutes=?,kind=? WHERE id=?',name,price,minutes,input.kind,Number(input.id));
      else run('INSERT INTO offers(name,price,minutes,kind) VALUES(?,?,?,?)',name,price,minutes,input.kind);
    }else if(path==='/api/assign'&&user.role==='admin'){
      const job=one('SELECT * FROM jobs WHERE id=?',Number(input.id));
      const captain=one("SELECT id FROM users WHERE id=? AND role='captain'",Number(input.captain));
      if(!job||!['Pending','Assigned'].includes(job.status)||!captain||(job.captain!==captain.id&&!available(captain.id,job.start,job.minutes)))fail('That job or captain is unavailable.');
      run("UPDATE jobs SET captain=?,status='Assigned' WHERE id=?",captain.id,job.id);
    }else if(path==='/api/progress'&&user.role==='captain'){
      const job=one('SELECT * FROM jobs WHERE id=? AND captain=?',Number(input.id),user.id);
      const status={Assigned:'On the way','On the way':'Washing',Washing:'Completed'}[job?.status];
      if(!status||status!==input.status)fail('This job is no longer at that stage.');
      if(status==='Completed'&&!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(input.photo??''))fail('Upload a JPEG, PNG, or WebP completion photo.');
      run('UPDATE jobs SET status=?,photo=? WHERE id=?',status,status==='Completed'?input.photo:null,job.id);
    }else if(path==='/api/review'&&user.role==='customer'){
      const rating=Number(input.rating),feedback=String(input.feedback??'').trim();
      if(!Number.isInteger(rating)||rating<1||rating>5||feedback.length>500)fail('Choose a rating from 1 to 5 and keep feedback under 500 characters.');
      const result=run("UPDATE jobs SET rating=?,feedback=? WHERE id=? AND customer=? AND status='Completed'",rating,feedback,Number(input.id),user.id);
      if(!result.changes)fail('Completed booking unavailable.',404);
    }else fail('Action unavailable.',403);
    send(res,200,{ok:true});
  }catch(error){
    if(!error.status)console.error(error.message);
    send(res,error.status||500,{error:error.status?error.message:'Something went wrong. Try again.'});
  }
}).listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log('Washupp listening on port '+(process.env.PORT||3000)));
