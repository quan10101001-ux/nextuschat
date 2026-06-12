/* Nexus Chat — Service Worker v2 (Web Push + Background Notifications) */
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(clients.claim()));

/* ── Web Push (true background notifications) ── */
self.addEventListener('push', e => {
  if (!e.data) return;
  let payload;
  try { payload = e.data.json(); } catch { payload = { title: '💬 Nexus Chat', body: e.data.text() }; }
  const { title = '💬 Nexus Chat', body = '', roomId } = payload;
  e.waitUntil(
    self.registration.showNotification(title, {
      body: body.substring(0, 120),
      icon:    '/nexus-icon.png',
      badge:   '/nexus-icon.png',
      tag:     roomId || 'nexus',
      data:    { roomId },
      vibrate: [200, 100, 200],
      renotify: true,
    })
  );
});

/* ── In-page postMessage (foreground notifications fallback) ── */
self.addEventListener('message', e => {
  if (e.data?.type !== 'SHOW_NOTIF') return;
  const { title, body, roomId, icon } = e.data;
  self.registration.showNotification(title || '💬 Nexus Chat', {
    body:     (body || '').substring(0, 120),
    icon:     icon || '/nexus-icon.png',
    badge:    icon || '/nexus-icon.png',
    tag:      roomId || 'nexus',
    data:     { roomId },
    vibrate:  [200, 100, 200],
    renotify: true,
  });
});

/* ── Notification click → open/focus app ── */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const roomId = e.notification.data?.roomId;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { c.focus(); c.postMessage({ type: 'OPEN_ROOM', roomId }); return; }
      }
      return clients.openWindow(roomId ? `/?r=${roomId}` : '/');
    })
  );
});
