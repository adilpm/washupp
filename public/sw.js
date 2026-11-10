self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  if(event.request.mode==='navigate')event.respondWith(fetch(event.request).catch(()=>new Response('Washupp needs an internet connection.',{headers:{'Content-Type':'text/plain'}})));
});
