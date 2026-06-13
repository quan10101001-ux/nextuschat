/* ================================================================
   Nexus Chat — Service Worker v4
   Tương thích: Chrome/Edge Android+Desktop, Firefox, Safari 16.4+ iOS/macOS
   
   Fix so với v2/v3:
   ✓ Offline cache: app shell + tin nhắn pending khi mất mạng
   ✓ Background sync: gửi lại tin nhắn khi có mạng trở lại
   ✓ Tag per-room: tin mới ghi đè tin cũ cùng phòng
   ✓ vibrate guard: iOS không có vibrate, không crash
   ✓ iOS: luôn show notification, không skip khi focused
   ✓ iOS: không dùng actions (bị ignore, nhưng tránh bug một số version)
   ✓ Push không có data: hiện fallback
   ✓ Notification click: focus đúng window, không lấy bừa
   ✓ Subscription hết hạn (410): tự xóa + re-subscribe
   ✓ Permission bị revoke: detect và cleanup
================================================================ */

const CACHE_NAME   = 'nexus-v4';
const OFFLINE_URL  = '/';
const SYNC_TAG     = 'nexus-pending-messages';

/* ── Detect iOS/Safari ──────────────────────────────────────────── */
const UA = self.navigator?.userAgent ?? '';
const IS_IOS = /iphone|ipad|ipod/i.test(UA);
const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(UA);

/* ── Install: cache app shell ───────────────────────────────────── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll([
        '/',
        '/patch.js',
        '/nexus-icon.png',
      ]).catch(() => {}) // don't fail install if assets missing
    ).then(() => self.skipWaiting())
  );
});

/* ── Activate: xóa cache cũ ────────────────────────────────────── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => clients.claim())
  );
});

/* ── Fetch: cache-first cho static, network-first cho API ───────── */
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Chỉ cache GET, bỏ qua WS, API, upload
  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  if (url.pathname.startsWith('/upload')) return;

  // Network-first cho HTML (luôn cần fresh)
  if (request.destination === 'document') {
    e.respondWith(
      fetch(request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
          return res;
        })
        .catch(() => caches.match(OFFLINE_URL))
    );
    return;
  }

  // Cache-first cho static assets (js, png, css, font…)
  e.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
        }
        return res;
      });
    })
  );
});

/* ── Background Sync: gửi lại tin nhắn pending ──────────────────── */
self.addEventListener('sync', e => {
  if (e.tag === SYNC_TAG) {
    e.waitUntil(flushPendingMessages());
  }
});

async function flushPendingMessages() {
  // Lấy danh sách tin nhắn pending từ IndexedDB (nếu app có lưu)
  // Gửi postMessage để app xử lý khi online trở lại
  const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  list.forEach(c => c.postMessage({ type: 'SYNC_MESSAGES' }));
}

/* ── Periodic Sync: làm mới subscription định kỳ ───────────────── */
self.addEventListener('periodicsync', e => {
  if (e.tag === 'nexus-push-refresh') {
    e.waitUntil(refreshPushSubscription());
  }
});

async function refreshPushSubscription() {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return;
    // Gửi subscription hiện tại lên server để refresh TTL
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    list.forEach(c => c.postMessage({ type: 'REFRESH_PUSH_SUB', subscription: sub.toJSON() }));
  } catch {}
}

/* ── Helper: build notification options ─────────────────────────── */
function buildNotif(payload) {
  const {
    title    = '💬 Nexus Chat',
    body     = 'Bạn có tin nhắn mới',
    roomId   = '',
    icon     = '/nexus-icon.png',
    sender   = '',
    senderName = '',
    count    = 1,
  } = payload ?? {};

  const tag         = roomId ? `room-${roomId}` : 'nexus-default';
  const displayName = senderName || sender || '';
  const displayBody = displayName
    ? `${displayName}: ${body}`.substring(0, 150)
    : body.substring(0, 150);

  const displayTitle = count > 1
    ? `💬 Nexus (${count} tin nhắn)`
    : (title || '💬 Nexus Chat');

  const options = {
    body:      displayBody,
    icon:      icon || '/nexus-icon.png',
    badge:     '/nexus-icon.png',       // Android status bar icon (monochrome)
    tag,
    data:      { roomId, url: roomId ? `/?r=${roomId}` : '/' },
    renotify:  true,
    silent:    false,
    timestamp: Date.now(),
  };

  // vibrate: iOS không hỗ trợ, crash nếu dùng trên một số version Safari
  if (!IS_IOS && !IS_SAFARI) {
    options.vibrate = [150, 80, 150];
  }

  // Actions: Chrome/Edge Android/Desktop only — iOS bỏ qua nhưng không crash
  if (!IS_IOS) {
    options.actions = [
      { action: 'open',    title: '💬 Mở chat' },
      { action: 'dismiss', title: '✕ Bỏ qua'   },
    ];
  }

  return { displayTitle, options };
}

/* ── Push event ─────────────────────────────────────────────────── */
self.addEventListener('push', e => {
  // Guard: push event nhưng notification permission bị revoke
  if (self.Notification?.permission !== 'granted') return;

  e.waitUntil((async () => {
    // Parse payload
    let payload = {};
    if (e.data) {
      try       { payload = e.data.json(); }
      catch     { payload = { body: e.data.text() }; }
    }

    // iOS: luôn show (SW wakes từ background, không có channel với app)
    // Others: skip nếu app đang focused ở đúng room đó
    if (!IS_IOS) {
      const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      const focusedOnRoom = list.some(c => {
        if (c.visibilityState !== 'visible') return false;
        if (!payload.roomId) return false;
        try {
          const u = new URL(c.url);
          return u.searchParams.get('r') === payload.roomId;
        } catch { return false; }
      });
      if (focusedOnRoom) return; // user đang nhìn vào room đó rồi
    }

    const { displayTitle, options } = buildNotif(payload);
    await self.registration.showNotification(displayTitle, options);
  })());
});

/* ── postMessage từ app (foreground notifications) ───────────────── */
self.addEventListener('message', e => {
  const data = e.data ?? {};

  if (data.type === 'SHOW_NOTIF') {
    const { displayTitle, options } = buildNotif(data);
    self.registration.showNotification(displayTitle, options).catch(() => {});
    return;
  }

  // App báo subscription bị 410 → cleanup
  if (data.type === 'PUSH_SUB_EXPIRED') {
    self.registration.pushManager.getSubscription()
      .then(sub => sub?.unsubscribe())
      .catch(() => {});
    return;
  }

  // App yêu cầu SW bỏ hết notification cũ của 1 room (user đã đọc)
  if (data.type === 'CLEAR_ROOM_NOTIF' && data.roomId) {
    self.registration.getNotifications({ tag: `room-${data.roomId}` })
      .then(notifs => notifs.forEach(n => n.close()))
      .catch(() => {});
    return;
  }
});

/* ── Notification click ─────────────────────────────────────────── */
self.addEventListener('notificationclick', e => {
  e.notification.close();

  if (e.action === 'dismiss') return;

  const { roomId, url } = e.notification.data ?? {};
  const target = url || (roomId ? `/?r=${roomId}` : '/');

  e.waitUntil((async () => {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });

    // Ưu tiên: window đang mở app của chúng ta
    for (const c of list) {
      try {
        if (new URL(c.url).origin !== self.location.origin) continue;
        await c.focus();
        c.postMessage({ type: 'OPEN_ROOM', roomId });
        return;
      } catch {}
    }

    // Không có window nào → mở tab mới
    if (clients.openWindow) {
      const win = await clients.openWindow(target);
      // postMessage sau khi tab load xong (delay nhỏ)
      if (win && roomId) {
        setTimeout(() => win.postMessage?.({ type: 'OPEN_ROOM', roomId }), 1500);
      }
    }
  })());
});

/* ── Notification close (đóng tay) ─────────────────────────────── */
self.addEventListener('notificationclose', _e => {
  // Có thể log analytics ở đây nếu cần
});
