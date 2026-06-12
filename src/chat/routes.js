import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  getUser, saveUser, updateUser, getAllUserEmails, deleteUser, touchLastSeen,
  areFriends, getFriends, addFriend, removeFriend, deleteAllFriends,
  getFriendRequests, hasSentRequest, addFriendRequest, removeFriendRequest, deleteAllFriendRequests,
  getRoom, saveRoom, getRoomMembers, addRoomMember, removeRoomMember,
  getUserRooms, deleteRoom, deleteAllUserRooms,
  getRoomMessages, updateMessage, addInvite, getInvites, removeInvite,
  savePushSub, deletePushSub,
  addLocalDelete, getLocalDeletes,
  deleteAllInvites, deleteAllLocalDeletes,
} from "../db/index.js";
import { onlineMap, sendTo, broadcastOnline, broadcast } from "./ws.js";
import { getVapidPublicKey, sendPush } from "./push.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "nexus_secret_2025";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR  = path.resolve(__dirname, "../../public");
const UPLOAD_DIR  = path.join(PUBLIC_DIR, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_q, _f, cb) => cb(null, UPLOAD_DIR),
    filename: (_q, f, cb) => cb(null, Date.now() + path.extname(f.originalname)),
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

function authMw(req, res, next) {
  const t = (req.headers.authorization ?? "").split(" ")[1] ?? "";
  if (!t) { res.status(401).json({ error: "No token" }); return; }
  try {
    req.user = jwt.verify(t, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}
function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") { res.status(403).json({ error: "Admin only" }); return; }
  next();
}
function me(req) { return req.user; }

const router = Router();

// ── Health ──────────────────────────────────────────────────────
router.get("/api/healthz", (_req, res) => { res.json({ status: "ok" }); });

// ── VAPID public key ────────────────────────────────────────────
router.get("/vapid-key", (_req, res) => res.json({ publicKey: getVapidPublicKey() }));

// ── Upload ──────────────────────────────────────────────────────
router.post("/upload", authMw, upload.single("file"), (req, res) => {
  if (!req.file) { res.status(400).json({ error: "No file" }); return; }
  res.json({
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    size: req.file.size,
    mime: req.file.mimetype,
  });
});

// ── Push subscription ───────────────────────────────────────────
router.post("/push/subscribe", authMw, async (req, res) => {
  try {
    await savePushSub(me(req).email, req.body.subscription);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AUTH ─────────────────────────────────────────────────────────
router.post("/sign-up", async (req, res) => {
  try {
    const { displayName, email, password } = req.body;
    if (!displayName || !email || !password) { res.status(400).json({ error: "Thiếu thông tin" }); return; }
    if (await getUser(email)) { res.status(409).json({ error: "Email đã được đăng ký" }); return; }
    const passwordHash = await bcrypt.hash(password, 10);
    await saveUser({ email, displayName, passwordHash, role: "guest", avatar: null, nameTagColor: "default", createdAt: Date.now() });
    res.json({ message: "OK" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/sign-in", async (req, res) => {
  try {
    const { email, password } = req.body;
    const u = await getUser(email);
    if (!u || !(await bcrypt.compare(password, u.passwordHash))) {
      res.status(401).json({ error: "Sai email hoặc mật khẩu" }); return;
    }
    await touchLastSeen(email);
    const token = jwt.sign({ email, role: u.role, displayName: u.displayName }, JWT_SECRET, { expiresIn: "30d" });
    const { passwordHash, ...safe } = u;
    res.json({ token, user: safe });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/me", authMw, async (req, res) => {
  const u = await getUser(me(req).email);
  if (!u) { res.status(404).json({ error: "Not found" }); return; }
  const { passwordHash, ...safe } = u;
  res.json(safe);
});

router.put("/me/password", authMw, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const u = await getUser(me(req).email);
    if (!u || !(await bcrypt.compare(oldPassword, u.passwordHash))) {
      res.status(400).json({ error: "Mật khẩu cũ không đúng" }); return;
    }
    await updateUser(me(req).email, { passwordHash: await bcrypt.hash(newPassword, 10) });
    res.json({ message: "OK" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put("/me/avatar", authMw, upload.single("avatar"), async (req, res) => {
  try {
    const email = me(req).email;
    let avatar = null;
    if (req.file) {
      avatar = `/uploads/${req.file.filename}`;
    } else if (req.body?.avatarBase64) {
      const b64 = req.body.avatarBase64;
      const ext = b64.startsWith("data:image/png") ? ".png" : ".jpg";
      const fn  = Date.now() + ext;
      fs.writeFileSync(path.join(UPLOAD_DIR, fn), Buffer.from(b64.split(",")[1], "base64"));
      avatar = `/uploads/${fn}`;
    }
    if (avatar) await updateUser(email, { avatar });
    res.json({ avatar });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put("/me/nametag", authMw, async (req, res) => {
  try {
    await updateUser(me(req).email, { nameTagColor: req.body.nameTagColor });
    res.json({ message: "OK" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── USERS ────────────────────────────────────────────────────────
router.get("/users", authMw, async (req, res) => {
  try {
    const q   = (req.query["q"] ?? "").toLowerCase();
    const myEmail = me(req).email;
    const all = await getAllUserEmails();
    const myFriends = new Set(await getFriends(myEmail));
    const myReqs = await getFriendRequests(myEmail);
    const out = [];
    for (const email of all) {
      if (email === myEmail) continue;
      const u = await getUser(email);
      if (!u) continue;
      if (q && !u.displayName.toLowerCase().includes(q) && !email.toLowerCase().includes(q)) continue;
      const theirReqs = await getFriendRequests(email);
      const sentRequest     = theirReqs.some(r => r.fromEmail === myEmail);
      const incomingRequest = myReqs.some(r => r.fromEmail === email);
      const { passwordHash, ...safe } = u;
      out.push({ ...safe, isFriend: myFriends.has(email), sentRequest, incomingRequest });
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FRIENDS ──────────────────────────────────────────────────────
router.get("/friends", authMw, async (req, res) => {
  try {
    const list = await getFriends(me(req).email);
    const out = [];
    for (const email of list) {
      const u = await getUser(email);
      if (u) { const { passwordHash, ...safe } = u; out.push(safe); }
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/friends/requests", authMw, async (req, res) => {
  try {
    const reqs = await getFriendRequests(me(req).email);
    res.json(reqs.map(r => ({ from: r.fromEmail, fromName: r.fromName, fromAvatar: r.fromAvatar, to: r.toEmail, createdAt: r.createdAt })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/friends/suggestions", authMw, async (req, res) => {
  try {
    const myEmail = me(req).email;
    const myFriends = new Set(await getFriends(myEmail));
    const seen = new Set([myEmail, ...myFriends]);
    const sugs = [];
    for (const friendEmail of myFriends) {
      const theirFriends = await getFriends(friendEmail);
      for (const candidate of theirFriends) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        const u = await getUser(candidate);
        if (!u) continue;
        const alreadySent = await hasSentRequest(myEmail, candidate);
        const { passwordHash, ...safe } = u;
        sugs.push({ ...safe, alreadySent, mutualFriend: friendEmail });
      }
    }
    res.json(sugs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/friends/request", authMw, async (req, res) => {
  try {
    const { targetEmail } = req.body;
    const myEmail = me(req).email;
    if (myEmail === targetEmail) { res.status(400).json({ error: "Không thể kết bạn với chính mình" }); return; }
    if (!(await getUser(targetEmail))) { res.status(404).json({ error: "Không tìm thấy người dùng" }); return; }
    if (await areFriends(myEmail, targetEmail)) { res.status(409).json({ error: "Đã là bạn bè" }); return; }
    if (await hasSentRequest(myEmail, targetEmail)) { res.status(409).json({ error: "Đã gửi lời mời" }); return; }
    const meUser = await getUser(myEmail);
    const reqId  = `fr_${Date.now()}`;
    await addFriendRequest({ id: reqId, fromEmail: myEmail, toEmail: targetEmail, fromName: meUser?.displayName, fromAvatar: meUser?.avatar ?? undefined });
    const reqData = { from: myEmail, fromName: meUser?.displayName, fromAvatar: meUser?.avatar, to: targetEmail, createdAt: Date.now() };
    sendTo(targetEmail, "friend_request", reqData);
    await sendPush(targetEmail, { title: `👋 ${meUser?.displayName}`, body: "Gửi lời mời kết bạn" });
    res.json({ message: "Đã gửi lời mời kết bạn" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/friends/respond", authMw, async (req, res) => {
  try {
    const { fromEmail, accept } = req.body;
    const myEmail = me(req).email;
    await removeFriendRequest(fromEmail, myEmail);
    if (accept) {
      await addFriend(myEmail, fromEmail);
      const meUser = await getUser(myEmail);
      // Auto-create DM room
      const roomId = `dm_${[myEmail, fromEmail].sort().join("__")}`;
      let room = await getRoom(roomId);
      if (!room) {
        await saveRoom({ roomId, name: "", type: "dm", creator: myEmail, admins: [], createdAt: Date.now() });
        await addRoomMember(roomId, myEmail);
        await addRoomMember(roomId, fromEmail);
        room = await getRoom(roomId);
      }
      const roomData = room ? { ...room, members: [myEmail, fromEmail] } : null;
      sendTo(fromEmail, "friend_accepted", { by: myEmail, byName: meUser?.displayName, room: roomData });
      sendTo(myEmail,   "new_room", roomData);
      await sendPush(fromEmail, { title: `🎉 ${meUser?.displayName}`, body: "Đã chấp nhận lời mời kết bạn" });
    }
    res.json({ message: accept ? "Đã chấp nhận" : "Đã từ chối" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/friends/:email", authMw, async (req, res) => {
  try {
    const myEmail = me(req).email;
    const target  = req.params["email"];
    await removeFriend(myEmail, target);
    sendTo(target, "friend_removed", { email: myEmail });
    res.json({ message: "Đã xóa bạn bè" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN ────────────────────────────────────────────────────────
router.put("/admin/set-role", authMw, adminOnly, async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!["guest","member","vip","admin"].includes(role)) { res.status(400).json({ error: "Invalid role" }); return; }
    await updateUser(email, { role });
    res.json({ message: "OK" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/admin/user/:email", authMw, adminOnly, async (req, res) => {
  try {
    const target  = req.params["email"];
    const myEmail = me(req).email;
    if (target === myEmail) { res.status(400).json({ error: "Không thể xóa chính mình" }); return; }
    // Cleanup all data
    await deleteAllFriends(target);
    await deleteAllFriendRequests(target);
    await deleteAllInvites(target);
    await deleteAllUserRooms(target);
    await deleteAllLocalDeletes(target);
    await deletePushSub(target);
    await deleteUser(target);
    // Kick socket
    const ws = onlineMap.get(target);
    if (ws) { ws.close(1001, "Account deleted"); onlineMap.delete(target); }
    broadcast("user_deleted", { email: target });
    broadcastOnline();
    res.json({ message: "Đã xóa tài khoản" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/admin/friend", authMw, adminOnly, async (req, res) => {
  try {
    const { email1, email2 } = req.body;
    await removeFriend(email1, email2);
    sendTo(email1, "friend_removed", { email: email2 });
    sendTo(email2, "friend_removed", { email: email1 });
    res.json({ message: "OK" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/admin/group/:roomId", authMw, adminOnly, async (req, res) => {
  try {
    const roomId = req.params["roomId"];
    const room   = await getRoom(roomId);
    if (!room) { res.status(404).json({ error: "Not found" }); return; }
    const members = room.members;
    await deleteRoom(roomId);
    const grpStr = JSON.stringify({ e: "group_deleted", d: { roomId } });
    for (const m of members) {
      const ws = onlineMap.get(m);
      if (ws?.readyState === 1) ws.send(grpStr);
    }
    res.json({ message: "OK" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/admin/groups", authMw, adminOnly, async (req, res) => {
  try {
    const all   = await getAllUserEmails();
    const seen  = new Set();
    const groups = [];
    for (const email of all) {
      const ids = await getUserRooms(email);
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const r = await getRoom(id);
        if (r && r.type === "group") groups.push(r);
      }
    }
    res.json(groups);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ROOMS ────────────────────────────────────────────────────────
router.get("/rooms", authMw, async (req, res) => {
  try {
    const ids = await getUserRooms(me(req).email);
    const rooms = [];
    for (const id of ids) {
      const r = await getRoom(id);
      if (r) rooms.push(r);
    }
    res.json(rooms);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/rooms", authMw, async (req, res) => {
  try {
    const { name, members = [] } = req.body;
    if (!name) { res.status(400).json({ error: "Thiếu tên nhóm" }); return; }
    const creator = me(req).email;
    const all     = [...new Set([creator, ...members])];
    const roomId  = `room_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await saveRoom({ roomId, name, type: "group", creator, admins: [creator], createdAt: Date.now() });
    for (const m of all) await addRoomMember(roomId, m);
    const room = await getRoom(roomId);
    res.json(room);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/rooms/:id", authMw, async (req, res) => {
  try {
    const roomId = req.params["id"];
    const myEmail = me(req).email;
    const room   = await getRoom(roomId);
    if (!room) { res.status(404).json({ error: "Not found" }); return; }
    if (room.type === "group" && (room.creator === myEmail || me(req).role === "admin")) {
      const members = room.members;
      await deleteRoom(roomId);
      const grpStr = JSON.stringify({ e: "group_deleted", d: { roomId } });
      for (const m of members) {
        const ws = onlineMap.get(m);
        if (ws?.readyState === 1) ws.send(grpStr);
      }
    } else {
      await removeRoomMember(roomId, myEmail);
    }
    res.json({ message: "OK" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/rooms/:id/messages", authMw, async (req, res) => {
  try { res.json(await getRoomMessages(req.params["id"])); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/rooms/:id/invite", authMw, async (req, res) => {
  try {
    const { targetEmail } = req.body;
    const roomId = req.params["id"];
    const room   = await getRoom(roomId);
    const myEmail = me(req).email;
    const myUser  = await getUser(myEmail);
    const inv = { id: `inv_${Date.now()}`, roomId, roomName: room?.name ?? roomId, fromEmail: myEmail, fromName: myUser?.displayName, toEmail: targetEmail };
    await addInvite(inv);
    sendTo(targetEmail, "invite", { ...inv, from: myEmail, fromName: myUser?.displayName, to: targetEmail });
    res.json({ message: "OK" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/invites", authMw, async (req, res) => {
  try { res.json(await getInvites(me(req).email)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/invites/respond", authMw, async (req, res) => {
  try {
    const { roomId, accept, inviteId } = req.body;
    const myEmail = me(req).email;
    if (accept) {
      await addRoomMember(roomId, myEmail);
    }
    if (inviteId) await removeInvite(inviteId);
    else {
      const invs = await getInvites(myEmail);
      const inv  = invs.find(i => i.roomId === roomId);
      if (inv) await removeInvite(inv.id);
    }
    const room = accept ? await getRoom(roomId) : null;
    if (accept && room) sendTo(myEmail, "new_room", room);
    res.json({ message: accept ? "OK" : "Declined" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/dm", authMw, async (req, res) => {
  try {
    const { targetEmail } = req.body;
    const myEmail = me(req).email;
    const meUser  = await getUser(myEmail);
    if (meUser?.role !== "admin" && !(await areFriends(myEmail, targetEmail))) {
      res.status(403).json({ error: "Cần kết bạn trước khi nhắn tin" }); return;
    }
    const roomId = `dm_${[myEmail, targetEmail].sort().join("__")}`;
    let room = await getRoom(roomId);
    if (!room) {
      await saveRoom({ roomId, name: "", type: "dm", creator: myEmail, admins: [], createdAt: Date.now() });
      await addRoomMember(roomId, myEmail);
      await addRoomMember(roomId, targetEmail);
      room = await getRoom(roomId);
    }
    res.json(room);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MESSAGES ─────────────────────────────────────────────────────
router.post("/messages/recall", authMw, async (req, res) => {
  try {
    const { roomId, msgId } = req.body;
    const myEmail = me(req).email;
    const msgs = await getRoomMessages(roomId);
    const msg  = msgs.find(m => m.id === msgId);
    if (!msg) { res.status(404).json({ error: "Not found" }); return; }
    if (msg.sender !== myEmail && me(req).role !== "admin") { res.status(403).json({ error: "Không có quyền" }); return; }
    await updateMessage(msgId, { recalled: true, content: "🚫 Tin nhắn đã được thu hồi", recalledAt: Date.now() });
    const members = await getRoomMembers(roomId);
    const recallStr = JSON.stringify({ e: "msg_recalled", d: { roomId, msgId } });
    for (const m of members) {
      const ws = onlineMap.get(m);
      if (ws?.readyState === 1) ws.send(recallStr);
    }
    res.json({ message: "OK" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/messages/delete-local", authMw, async (req, res) => {
  try {
    const { msgId } = req.body;
    await addLocalDelete(me(req).email, msgId);
    res.json({ message: "OK" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/messages/local-deleted", authMw, async (req, res) => {
  try { res.json(await getLocalDeletes(me(req).email)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Last seen info ────────────────────────────────────────────────
router.get("/users/last-seen", authMw, async (req, res) => {
  try {
    const emails = (req.query["emails"] ?? "").split(",").filter(Boolean);
    const out = {};
    for (const email of emails) {
      const u = await getUser(email);
      out[email] = u?.lastSeen ?? null;
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
