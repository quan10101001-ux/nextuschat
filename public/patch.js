/* ================================================================
   Nexus Chat — Client Patch (injected by server)
   Replaces socket.io with native WebSocket + adds new features.
   Does NOT modify HTML structure or CSS.
================================================================ */
(function() {
'use strict';

// ── 1. Fix: allow any string as email (remove browser type=email enforcement) ──
document.addEventListener('DOMContentLoaded', () => {
  ['rem','lem'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.setAttribute('type', 'text');
  });
});

// ── 2. Override window.io with native WebSocket wrapper ──────────
window.io = function(url, opts) {
  const handlers = {};
  let ws = null;
  let reconnTimer = null;
  let reconnDelay = 1000;
  let closed = false;

  const token = opts?.auth?.token ?? '';

  function getWsUrl() {
    const base = url.replace(/^http/, 'ws');
    return base.replace(/\/$/, '') + '/ws?token=' + encodeURIComponent(token);
  }

  const sock = {
    id: Math.random().toString(36).slice(2),
    connected: false,

    on(event, cb) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(cb);
      return sock;
    },

    emit(event, data) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ e: event, d: data }));
      }
      return sock;
    },

    disconnect() {
      closed = true;
      clearTimeout(reconnTimer);
      if (ws) ws.close();
    },
  };

  function fire(event, ...args) {
    (handlers[event] || []).forEach(cb => { try { cb(...args); } catch(e) { console.warn('handler err', event, e); } });
  }

  function connect() {
    if (closed) return;
    try { ws = new WebSocket(getWsUrl()); } catch(e) { scheduleReconn(); return; }

    ws.onopen = () => {
      sock.connected = true;
      reconnDelay = 1000;
      fire('connect');
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      fire(msg.e, msg.d);
    };

    ws.onclose = () => {
      sock.connected = false;
      fire('disconnect');
      scheduleReconn();
    };

    ws.onerror = (err) => {
      fire('connect_error', err);
    };
  }

  function scheduleReconn() {
    if (closed) return;
    clearTimeout(reconnTimer);
    reconnTimer = setTimeout(() => { if (!closed) connect(); }, reconnDelay);
    reconnDelay = Math.min(reconnDelay * 1.5, 15000);
  }

  connect();
  return sock;
};

// ── 3. Web Push subscription ────────────────────────────────────
async function setupWebPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const { publicKey } = await fetch('/vapid-key').then(r => r.json());
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    const tok = localStorage.getItem('nx_tok');
    if (tok && sub) {
      await fetch('/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
        body: JSON.stringify({ subscription: sub }),
      });
    }
  } catch(e) { console.warn('Push setup:', e.message); }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// ── 4. Patch: home list shows name + email below ────────────────
const _origRenderRooms = window.renderRooms;
function patchedRenderRooms() {
  if (typeof renderRooms !== 'function') return;
  // We'll hook the RL element after the original renders
  const orig = window.renderRooms;
  window.renderRooms = function() {
    orig.call(this);
    // Now patch each .ri-inf to show email below name for DMs
    if (!window.me || !window.rooms) return;
    const rl = document.getElementById('RL');
    if (!rl) return;
    rl.querySelectorAll('.ri').forEach(ri => {
      const roomId = ri.dataset.room;
      const room = (window.rooms || []).find(r => r.roomId === roomId);
      if (!room || room.type !== 'dm') return;
      const other = (room.members || []).find(m => m !== window.me?.email);
      if (!other) return;
      const rnEl = ri.querySelector('.rn');
      if (!rnEl) return;
      // Check if email already shown
      if (ri.querySelector('.ri-email')) return;
      const emailEl = document.createElement('div');
      emailEl.className = 'ri-email';
      emailEl.style.cssText = 'font-size:10px;color:var(--tx3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px';
      emailEl.textContent = other;
      const rl2 = ri.querySelector('.rl2');
      if (rl2) rl2.parentNode.insertBefore(emailEl, rl2);
    });
  };
}

// ── 5. Patch: friend_accepted → also reload rooms + open DM ─────
function patchFriendAccepted() {
  const orig = window.loadFriends;
  // We hook into the socket's friend_accepted event via a patched startApp
  const origStartApp = window.startApp;
  window.startApp = async function() {
    await origStartApp.call(this);
    // Override the friend_accepted handler after socket is set up
    setTimeout(() => {
      if (!window.sk) return;
      const handlers = window.sk._handlers || {};
      // Patch: after friend accepted, also load rooms + open new DM
      window.sk.on('friend_accepted', function(data) {
        if (data && data.room) {
          const room = data.room;
          if (window.rooms && !window.rooms.find(r => r.roomId === room.roomId)) {
            window.rooms.push(room);
          }
          if (typeof window.renderRooms === 'function') window.renderRooms();
          if (typeof window.renderMyG === 'function') window.renderMyG();
        }
      });
      window.sk.on('new_room', function(room) {
        if (!room) return;
        if (window.rooms && !window.rooms.find(r => r.roomId === room.roomId)) {
          window.rooms.push(room);
          if (typeof window.renderRooms === 'function') window.renderRooms();
          if (typeof window.renderMyG === 'function') window.renderMyG();
        }
      });
    }, 500);
    // Setup web push after login
    setTimeout(setupWebPush, 2000);
  };
}

// ── 6. Last online time display ──────────────────────────────────
const lastSeenCache = {};
async function fetchLastSeen(emails) {
  if (!emails.length) return;
  const tok = localStorage.getItem('nx_tok');
  if (!tok) return;
  try {
    const data = await fetch('/users/last-seen?emails=' + emails.join(','), {
      headers: { 'Authorization': 'Bearer ' + tok }
    }).then(r => r.json());
    Object.assign(lastSeenCache, data);
  } catch {}
}

function formatLastSeen(ts) {
  if (!ts) return 'Chưa rõ';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 2)  return 'Vừa xong';
  if (mins < 60) return `${mins} phút trước`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs} giờ trước`;
  const days = Math.floor(hrs / 24);
  if (days < 7)  return `${days} ngày trước`;
  return new Date(ts).toLocaleDateString('vi');
}

// ── 7. File attachment ───────────────────────────────────────────
function injectAttachButton() {
  const inb = document.querySelector('.inb');
  if (!inb || document.getElementById('nx-attach')) return;
  const btn = document.createElement('button');
  btn.id = 'nx-attach';
  btn.title = 'Đính kèm file';
  btn.style.cssText = 'width:44px;height:44px;border-radius:50%;flex-shrink:0;background:var(--bg2);border:1.5px solid var(--bdr);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:var(--shsm);order:-1';
  btn.textContent = '📎';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'nx-file-inp';
  fileInput.accept = 'image/*,video/*,.pdf,.doc,.docx,.zip,.txt,.xlsx,.pptx,.mp3,.wav';
  fileInput.style.display = 'none';
  fileInput.multiple = false;
  fileInput.onchange = handleFileAttach;
  btn.onclick = () => fileInput.click();
  inb.insertBefore(fileInput, inb.firstChild);
  inb.insertBefore(btn, inb.firstChild);
}

async function handleFileAttach(evt) {
  const file = evt.target.files[0];
  if (!file || !window.curR) return;
  evt.target.value = '';
  const tok = localStorage.getItem('nx_tok');
  if (!tok) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const progressEl = showUploadProgress(file.name);
    const res = await fetch('/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd });
    if (progressEl) progressEl.remove();
    if (!res.ok) { alert('Upload thất bại'); return; }
    const { url, name, size, mime } = await res.json();
    const type = mime?.startsWith('image/') ? 'image' : mime?.startsWith('video/') ? 'video' : 'file';
    if (window.sk) {
      window.sk.emit('send_message', { roomId: window.curR, content: null, type, fileUrl: url, fileName: name, fileSize: size });
    }
  } catch(e) { alert('Lỗi upload: ' + e.message); }
}

function showUploadProgress(name) {
  const ms = document.getElementById('MS');
  if (!ms) return null;
  const el = document.createElement('div');
  el.style.cssText = 'padding:8px 12px;background:var(--bg2);border-radius:8px;font-size:12px;color:var(--tx2);margin:4px 0';
  el.textContent = `⏳ Đang tải lên ${name}…`;
  ms.appendChild(el);
  ms.scrollTop = ms.scrollHeight;
  return el;
}

// ── 8. Patch appendMsg to render images/videos/files ────────────
function patchAppendMsg() {
  const origAppendMsg = window.appendMsg;
  if (!origAppendMsg) return;
  window.appendMsg = function(msg) {
    if (!msg.type || msg.type === 'text') {
      origAppendMsg.call(this, msg);
      return;
    }
    // Render file/image/video message
    const el = document.getElementById('MS');
    if (!el) return;
    const isMe = msg.sender === window.me?.email;
    const time = new Date(msg.timestamp).toLocaleTimeString('vi', { hour: '2-digit', minute: '2-digit' });
    const col = window.COLS ? window.COLS[Math.abs(hashStr(msg.sender)) % window.COLS.length] : '#4575e8';
    const ava = msg.senderAvatar
      ? `<img src="${msg.senderAvatar}" onerror="this.outerHTML='${(msg.senderName||'?')[0].toUpperCase()}'"/>`
      : (msg.senderName || '?')[0].toUpperCase();

    let mediaHtml = '';
    if (msg.type === 'image' && msg.fileUrl) {
      mediaHtml = `<a href="${msg.fileUrl}" target="_blank"><img src="${msg.fileUrl}" style="max-width:220px;max-height:180px;border-radius:10px;display:block;cursor:pointer" loading="lazy"/></a>`;
    } else if (msg.type === 'video' && msg.fileUrl) {
      mediaHtml = `<video src="${msg.fileUrl}" controls style="max-width:220px;max-height:160px;border-radius:10px;display:block"></video>`;
    } else if (msg.fileUrl) {
      mediaHtml = `<a href="${msg.fileUrl}" target="_blank" style="display:flex;align-items:center;gap:6px;text-decoration:none;color:inherit">📎 <span style="font-size:13px;text-decoration:underline">${escapeHtml(msg.fileName || 'Tệp đính kèm')}</span></a>`;
    }

    const d = document.createElement('div');
    d.className = 'mg' + (isMe ? ' me' : '');
    d.dataset.mid = msg.id;
    d.innerHTML = `<div class="ma" style="background:${col}">${ava}</div>
      <div class="mc">
        ${!isMe ? `<div class="msr">${escapeHtml(msg.senderName || '')}</div>` : ''}
        <div class="mb" id="mb-${msg.id}"
          ontouchstart="tStart(event,'${msg.id}',${isMe})"
          ontouchend="tEnd()"
          oncontextmenu="showCtx(event,'${msg.id}',${isMe});return false"
        >${mediaHtml}</div>
        <div class="mt">${time}</div>
      </div>`;
    el.appendChild(d);
  };
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 9. Calling feature ───────────────────────────────────────────
let peerConn = null;
let localStream = null;
let callPartner = null;
let callRoom = null;
const CALL_ROLES = ['admin', 'vip'];

function injectCallUI() {
  if (document.getElementById('nx-call-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'nx-call-overlay';
  overlay.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:99000;flex-direction:column;align-items:center;justify-content:center;gap:20px';
  overlay.innerHTML = `
    <div style="color:#fff;font-size:22px;font-weight:700" id="nx-call-status">Đang gọi…</div>
    <div style="color:rgba(255,255,255,.7);font-size:14px" id="nx-call-name"></div>
    <div style="display:flex;gap:20px;margin-top:16px">
      <button id="nx-call-mute" onclick="nxToggleMute()" style="width:56px;height:56px;border-radius:50%;border:none;background:rgba(255,255,255,.2);color:#fff;font-size:22px;cursor:pointer">🎤</button>
      <button id="nx-call-end" onclick="nxEndCall()" style="width:64px;height:64px;border-radius:50%;border:none;background:#e8414a;color:#fff;font-size:24px;cursor:pointer">📵</button>
    </div>
    <div id="nx-call-timer" style="color:rgba(255,255,255,.5);font-size:13px"></div>
  `;
  document.body.appendChild(overlay);

  // Incoming call dialog
  const incoming = document.createElement('div');
  incoming.id = 'nx-incoming-call';
  incoming.style.cssText = 'display:none;position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#fff;border-radius:20px;padding:20px 24px;box-shadow:0 8px 32px rgba(0,0,0,.2);z-index:99001;text-align:center;min-width:260px;border:2px solid var(--a)';
  incoming.innerHTML = `
    <div style="font-size:30px;margin-bottom:6px">📞</div>
    <div style="font-size:15px;font-weight:700;margin-bottom:3px" id="nx-caller-name">Ai đó đang gọi</div>
    <div style="font-size:12px;color:var(--tx2);margin-bottom:14px">Cuộc gọi thoại</div>
    <div style="display:flex;gap:12px;justify-content:center">
      <button onclick="nxAcceptCall()" style="padding:10px 20px;border-radius:30px;border:none;background:var(--grn);color:#fff;font-size:14px;font-weight:700;cursor:pointer">✓ Nghe</button>
      <button onclick="nxRejectCall()" style="padding:10px 20px;border-radius:30px;border:none;background:var(--red);color:#fff;font-size:14px;font-weight:700;cursor:pointer">✕ Từ chối</button>
    </div>
  `;
  document.body.appendChild(incoming);
}

function injectCallButton() {
  const ch = document.querySelector('.ch');
  if (!ch || document.getElementById('nx-call-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'nx-call-btn';
  btn.style.cssText = 'width:32px;height:32px;border-radius:var(--rsm);border:1.5px solid var(--bdr);background:var(--bg2);cursor:pointer;display:none;align-items:center;justify-content:center;font-size:14px;box-shadow:var(--shsm);flex-shrink:0';
  btn.textContent = '📞';
  btn.title = 'Gọi thoại';
  btn.onclick = nxStartCall;
  const btnGroup = ch.querySelector('div[style*="display:flex"]');
  if (btnGroup) btnGroup.insertBefore(btn, btnGroup.firstChild);
  else ch.appendChild(btn);
}

function updateCallBtn() {
  const btn = document.getElementById('nx-call-btn');
  if (!btn || !window.curR || !window.rooms || !window.me) return;
  const room = window.rooms.find(r => r.roomId === window.curR);
  if (!room || room.type !== 'dm') { btn.style.display = 'none'; return; }
  const other = (room.members || []).find(m => m !== window.me.email);
  const myRole = window.me.role;
  if (!CALL_ROLES.includes(myRole)) { btn.style.display = 'none'; return; }
  if (!other || !window.online?.has(other)) { btn.style.display = 'none'; return; }
  btn.style.display = 'flex';
  btn.dataset.target = other;
}

async function nxStartCall() {
  const btn = document.getElementById('nx-call-btn');
  const toEmail = btn?.dataset.target;
  if (!toEmail || !window.curR) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    peerConn = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));
    peerConn.onicecandidate = e => {
      if (e.candidate && window.sk) window.sk.emit('ice_candidate', { toEmail, candidate: e.candidate });
    };
    peerConn.ontrack = e => {
      const audio = document.getElementById('nx-remote-audio') || (() => {
        const a = document.createElement('audio'); a.id = 'nx-remote-audio'; a.autoplay = true; document.body.appendChild(a); return a;
      })();
      audio.srcObject = e.streams[0];
    };
    const offer = await peerConn.createOffer();
    await peerConn.setLocalDescription(offer);
    callPartner = toEmail;
    callRoom = window.curR;
    if (window.sk) window.sk.emit('call_offer', { toEmail, offer: peerConn.localDescription, roomId: window.curR });
    showCallOverlay('Đang gọi…', toEmail);
    startCallTimer();
  } catch(e) { alert('Lỗi: ' + e.message); nxCleanup(); }
}

window.nxStartCall = nxStartCall;

let _callTimer = null, _callSeconds = 0;
function startCallTimer() {
  _callSeconds = 0;
  _callTimer = setInterval(() => {
    _callSeconds++;
    const m = String(Math.floor(_callSeconds/60)).padStart(2,'0');
    const s = String(_callSeconds%60).padStart(2,'0');
    const el = document.getElementById('nx-call-timer');
    if (el) el.textContent = m + ':' + s;
  }, 1000);
}

function showCallOverlay(status, name) {
  const ov = document.getElementById('nx-call-overlay');
  if (!ov) return;
  ov.style.display = 'flex';
  document.getElementById('nx-call-status').textContent = status;
  document.getElementById('nx-call-name').textContent = name;
}
function hideCallOverlay() {
  const ov = document.getElementById('nx-call-overlay');
  if (ov) ov.style.display = 'none';
}
function showIncomingCall(name) {
  const ic = document.getElementById('nx-incoming-call');
  if (!ic) return;
  ic.style.display = 'block';
  document.getElementById('nx-caller-name').textContent = name;
}
function hideIncomingCall() {
  const ic = document.getElementById('nx-incoming-call');
  if (ic) ic.style.display = 'none';
}

window.nxEndCall = function() {
  if (callPartner && window.sk) window.sk.emit('call_end', { toEmail: callPartner });
  nxCleanup();
};
window.nxToggleMute = function() {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (track) { track.enabled = !track.enabled; document.getElementById('nx-call-mute').textContent = track.enabled ? '🎤' : '🔇'; }
};

let _incomingOffer = null, _incomingFrom = null;
window.nxAcceptCall = async function() {
  hideIncomingCall();
  if (!_incomingOffer || !_incomingFrom) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    peerConn = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));
    peerConn.onicecandidate = e => {
      if (e.candidate && window.sk) window.sk.emit('ice_candidate', { toEmail: _incomingFrom, candidate: e.candidate });
    };
    peerConn.ontrack = e => {
      const audio = document.getElementById('nx-remote-audio') || (() => {
        const a = document.createElement('audio'); a.id = 'nx-remote-audio'; a.autoplay = true; document.body.appendChild(a); return a;
      })();
      audio.srcObject = e.streams[0];
    };
    await peerConn.setRemoteDescription(new RTCSessionDescription(_incomingOffer));
    const answer = await peerConn.createAnswer();
    await peerConn.setLocalDescription(answer);
    callPartner = _incomingFrom;
    if (window.sk) window.sk.emit('call_answer', { toEmail: _incomingFrom, answer: peerConn.localDescription });
    showCallOverlay('Đang trong cuộc gọi', _incomingFrom);
    startCallTimer();
  } catch(e) { alert('Lỗi: ' + e.message); nxCleanup(); }
};
window.nxRejectCall = function() {
  hideIncomingCall();
  if (_incomingFrom && window.sk) window.sk.emit('call_reject', { toEmail: _incomingFrom });
  _incomingOffer = null; _incomingFrom = null;
};

function nxCleanup() {
  clearInterval(_callTimer); _callTimer = null; _callSeconds = 0;
  hideCallOverlay(); hideIncomingCall();
  if (peerConn) { peerConn.close(); peerConn = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  callPartner = null; callRoom = null;
  _incomingOffer = null; _incomingFrom = null;
  const audio = document.getElementById('nx-remote-audio');
  if (audio) audio.remove();
}

// ── 10. Hook WS events for calling + room updates ────────────────
function hookSocketEvents() {
  if (!window.sk) { setTimeout(hookSocketEvents, 300); return; }
  window.sk.on('incoming_call', ({ fromEmail, fromName, offer }) => {
    _incomingOffer = offer; _incomingFrom = fromEmail;
    showIncomingCall(fromName || fromEmail);
    if (typeof window.fireNotif === 'function') window.fireNotif('📞 Cuộc gọi đến', fromName + ' đang gọi cho bạn', null);
  });
  window.sk.on('call_answered', async ({ answer }) => {
    if (peerConn) { try { await peerConn.setRemoteDescription(new RTCSessionDescription(answer)); } catch {} }
    showCallOverlay('Đang trong cuộc gọi', callPartner || '');
  });
  window.sk.on('call_rejected', () => { hideCallOverlay(); nxCleanup(); alert('Cuộc gọi bị từ chối'); });
  window.sk.on('call_ended',   () => { nxCleanup(); });
  window.sk.on('call_error',   ({ message }) => { hideCallOverlay(); nxCleanup(); alert(message); });
  window.sk.on('ice_candidate', async ({ candidate }) => {
    if (peerConn && candidate) { try { await peerConn.addIceCandidate(new RTCIceCandidate(candidate)); } catch {} }
  });
  window.sk.on('online', (list) => {
    // Update call button visibility after online list changes
    setTimeout(updateCallBtn, 100);
  });
}

// ── 11. Patch openRoom to update call button + inject UI ─────────
function patchOpenRoom() {
  const orig = window.openRoom;
  if (!orig) { setTimeout(patchOpenRoom, 200); return; }
  window.openRoom = async function(roomId) {
    await orig.call(this, roomId);
    injectCallButton();
    injectAttachButton();
    updateCallBtn();
  };
}

// ── 12. Patch grantNotif to also setup web push ───────────────────
function patchGrantNotif() {
  const orig = window.grantNotif;
  if (!orig) return;
  window.grantNotif = async function() {
    await orig.call(this);
    setTimeout(setupWebPush, 500);
  };
}

// ── 13. Add CSS for last-seen display in chat header ─────────────
const extraCSS = document.createElement('style');
extraCSS.textContent = `
  #nx-call-overlay { display: none; }
  #nx-incoming-call { display: none; }
  .ri-email { font-size: 10px !important; color: var(--tx3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
  #nx-attach:active { background: var(--a); color: #fff; }
`;
document.head.appendChild(extraCSS);

// ── 14. Patch renderRooms to also show emails ─────────────────────
function applyAllPatches() {
  if (typeof window.renderRooms === 'function') {
    const origRR = window.renderRooms;
    window.renderRooms = function() {
      origRR.call(this);
      // Add email row under name for DM rooms
      const rl = document.getElementById('RL');
      if (!rl || !window.me || !window.rooms) return;
      rl.querySelectorAll('.ri').forEach(ri => {
        if (ri.querySelector('.ri-email')) return;
        const roomId = ri.dataset.room;
        const room = (window.rooms || []).find(r => r.roomId === roomId);
        if (!room || room.type !== 'dm') return;
        const other = (room.members || []).find(m => m !== window.me.email);
        if (!other) return;
        const rl2 = ri.querySelector('.rl2');
        if (!rl2) return;
        const emailEl = document.createElement('div');
        emailEl.className = 'ri-email';
        emailEl.textContent = other;
        rl2.parentNode.insertBefore(emailEl, rl2);
      });
    };
  }

  if (typeof window.appendMsg === 'function') patchAppendMsg();
  if (typeof window.grantNotif === 'function') patchGrantNotif();
  patchOpenRoom();

  // Inject call UI elements into DOM
  injectCallUI();

  // Start hooking socket events once socket is created
  hookSocketEvents();
}

// ── 15. Patch startApp to run our setup ──────────────────────────
const origStartApp = window.startApp;
if (origStartApp) {
  window.startApp = async function() {
    await origStartApp.call(this);
    applyAllPatches();
    setTimeout(setupWebPush, 3000);
  };
} else {
  // Fallback: wait for startApp to be defined
  let startAppWait = setInterval(() => {
    if (typeof window.startApp === 'function' && window.startApp !== window.startApp) {
      clearInterval(startAppWait);
    }
  }, 100);
  document.addEventListener('DOMContentLoaded', () => {
    const _origSA = window.startApp;
    if (_origSA) {
      window.startApp = async function() {
        await _origSA.call(this);
        applyAllPatches();
        setTimeout(setupWebPush, 3000);
      };
    }
  });
}

})(); // end IIFE
