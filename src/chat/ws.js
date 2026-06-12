import { WebSocketServer, WebSocket } from "ws";
import jwt from "jsonwebtoken";
import {
  getUser, touchLastSeen, isRoomMember, getUserRooms, addMessage,
  updateMessage, getRoomMessages, getRoomMembers,
} from "../db/index.js";
import { sendPush } from "./push.js";
import { logger } from "../lib/logger.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "nexus_secret_2025";

// email → WebSocket
export const onlineMap = new Map();

function send(ws, event, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ e: event, d: data }));
  }
}

export function broadcast(event, data) {
  const msg = JSON.stringify({ e: event, d: data });
  for (const ws of onlineMap.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

export function sendTo(email, event, data) {
  const ws = onlineMap.get(email);
  if (ws) send(ws, event, data);
}

export function broadcastOnline() {
  const list = [...onlineMap.keys()];
  broadcast("online", list);
}

export function setupWS(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token") ?? "";

    let user;
    try {
      user = jwt.verify(token, JWT_SECRET);
    } catch {
      ws.close(1008, "Auth failed");
      return;
    }

    const { email } = user;

    // Kick old connection
    const old = onlineMap.get(email);
    if (old && old !== ws && old.readyState === WebSocket.OPEN) {
      old.close(1001, "Replaced");
    }
    onlineMap.set(email, ws);
    broadcastOnline();
    await touchLastSeen(email);

    logger.info({ email }, "WS connected");

    ws.on("message", async (raw) => {
      let parsed;
      try { parsed = JSON.parse(raw.toString()); }
      catch { return; }
      const { e: event, d: data } = parsed;

      switch (event) {
        case "send_message": {
          const { roomId, content, type = "text", fileUrl, fileName, fileSize } = data ?? {};
          if (!content && !fileUrl) return;
          if (!(await isRoomMember(roomId, email))) return;
          const u = await getUser(email);
          if (!u) return;
          const msgId = `m${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
          const msg = {
            id: msgId, roomId, sender: email,
            senderName: u.displayName, senderRole: u.role, senderAvatar: u.avatar,
            nameTagColor: u.nameTagColor,
            content: content ?? (type === "image" ? "📷 Ảnh" : type === "video" ? "🎬 Video" : `📎 ${fileName ?? "Tệp"}`),
            type, fileUrl: fileUrl ?? null, fileName: fileName ?? null, fileSize: fileSize ?? null,
            timestamp: Date.now(), recalled: false, recalledAt: null,
          };
          await addMessage(msg);

          const roomMembers = await getRoomMembers(roomId);
          const msgStr = JSON.stringify({ e: "new_msg", d: msg });
          for (const m of roomMembers) {
            const mws = onlineMap.get(m);
            if (mws?.readyState === WebSocket.OPEN) mws.send(msgStr);
            else if (m !== email) {
              await sendPush(m, {
                title: `💬 ${u.displayName}`,
                body: msg.content?.substring(0, 100) ?? "",
                roomId
              });
            }
          }
          break;
        }

        case "recall_msg": {
          const { roomId, msgId } = data ?? {};
          const msgs = await getRoomMessages(roomId);
          const msg = msgs.find(m => m.id === msgId);
          if (!msg) return;
          if (msg.sender !== email && user.role !== "admin") return;
          await updateMessage(msgId, { recalled: true, content: "🚫 Tin nhắn đã được thu hồi", recalledAt: Date.now() });
          const roomMembers = await getRoomMembers(roomId);
          const recallStr = JSON.stringify({ e: "msg_recalled", d: { roomId, msgId } });
          for (const m of roomMembers) {
            const mws = onlineMap.get(m);
            if (mws?.readyState === WebSocket.OPEN) mws.send(recallStr);
          }
          break;
        }

        case "typing": {
          const { roomId } = data ?? {};
          const roomMembers = await getRoomMembers(roomId);
          const typStr = JSON.stringify({ e: "typing", d: { email, roomId } });
          for (const m of roomMembers) {
            if (m === email) continue;
            const mws = onlineMap.get(m);
            if (mws?.readyState === WebSocket.OPEN) mws.send(typStr);
          }
          break;
        }

        case "join_room": {
          // No socket rooms needed with ws — just verify membership
          break;
        }

        // ── WebRTC calling ────────────────────────────────────────
        case "call_offer": {
          const { toEmail, offer, roomId } = data ?? {};
          const caller = await getUser(email);
          const callee = await getUser(toEmail);
          if (!caller || !callee) return;
          const allowed = ["admin", "vip"];
          if (!allowed.includes(caller.role) || !allowed.includes(callee.role)) {
            send(ws, "call_error", { message: "Tính năng gọi điện chỉ dành cho Admin và VIP" });
            return;
          }
          if (!onlineMap.has(toEmail)) {
            send(ws, "call_error", { message: "Người dùng không online" });
            return;
          }
          sendTo(toEmail, "incoming_call", {
            fromEmail: email, fromName: caller.displayName,
            fromAvatar: caller.avatar, offer, roomId
          });
          break;
        }

        case "call_answer": {
          const { toEmail, answer } = data ?? {};
          sendTo(toEmail, "call_answered", { answer, fromEmail: email });
          break;
        }

        case "call_reject": {
          const { toEmail } = data ?? {};
          sendTo(toEmail, "call_rejected", { fromEmail: email });
          break;
        }

        case "ice_candidate": {
          const { toEmail, candidate } = data ?? {};
          sendTo(toEmail, "ice_candidate", { candidate, fromEmail: email });
          break;
        }

        case "call_end": {
          const { toEmail } = data ?? {};
          sendTo(toEmail, "call_ended", { fromEmail: email });
          break;
        }
      }
    });

    ws.on("close", async () => {
      if (onlineMap.get(email) === ws) {
        onlineMap.delete(email);
        await touchLastSeen(email);
        broadcastOnline();
      }
      logger.info({ email }, "WS disconnected");
    });

    ws.on("error", (err) => logger.warn({ email, err: err.message }, "WS error"));
  });

  logger.info("WebSocket server ready on /ws");
}
