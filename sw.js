const CACHE_NAME = 'app-cache-v17';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.map((key) => {
                if (key !== CACHE_NAME) return caches.delete(key);
            }))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    const url = new URL(e.request.url);
    if (url.hostname !== self.location.hostname) return;
    // Network-first for HTML
    if (url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.endsWith('/')) {
        e.respondWith(
            fetch(e.request.url, { cache: 'no-store' }) // no-store: nao reusa HTML stale do CDN/browser
                .then((res) => {
                    if (res && res.status === 200) {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
                    }
                    return res;
                })
                .catch(() => caches.match(e.request))
        );
        return;
    }
    // Cache-first for everything else
    e.respondWith(
        caches.match(e.request).then((cached) =>
            cached || fetch(e.request).then((res) => {
                if (res && res.status === 200) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
                }
                return res;
            })
        )
    );
});

// Notificações push (pedido de acesso / pagamento declarado / resultado de
// jogo fechado) — a Edge Function push-notificar-goals manda um payload
// {title, body, url}; aqui só se mostra a notificação.
self.addEventListener('push', (e) => {
    let data = { title: 'Goals', body: 'Tens uma novidade na app.', url: '/Goals/' };
    try { Object.assign(data, e.data.json()); } catch (err) { /* payload vazio ou não-JSON */ }
    e.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: '/Goals/apple-touch-icon.png',
            badge: '/Goals/apple-touch-icon.png',
            data: { url: data.url || '/Goals/' }
        })
    );
});

// Clique na notificação: foca uma janela já aberta da app, ou abre uma nova.
self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    const url = (e.notification.data && e.notification.data.url) || '/Goals/';
    e.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            for (const c of clients) {
                if (c.url.includes('/Goals/') && 'focus' in c) return c.focus();
            }
            return self.clients.openWindow(url);
        })
    );
});
