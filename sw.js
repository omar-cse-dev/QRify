const CACHE_NAME='qrify-app-v1';
const APP_SHELL=['./','./index.html','./style.css','./script.js','./favicon.svg','./192x192.png','./512x512.png','./apple-touch-icon.png','./og-image.png','./manifest.webmanifest'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(APP_SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);
  if(u.origin===self.location.origin){
    e.respondWith(caches.match(r).then(cached=>{
      const net=fetch(r).then(resp=>{if(resp&&resp.ok){const copy=resp.clone();caches.open(CACHE_NAME).then(c=>c.put(r,copy));}return resp;}).catch(()=>cached||caches.match('./index.html'));
      return cached||net;
    }));return;
  }
  if(u.protocol==='https:'){
    e.respondWith(fetch(r).then(resp=>{if(resp&&(resp.ok||resp.type==='opaque')){const copy=resp.clone();caches.open(CACHE_NAME).then(c=>c.put(r,copy));}return resp;}).catch(()=>caches.match(r)));
  }
});