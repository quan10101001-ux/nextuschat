/**
 * db/index.js — PostgreSQL + Redis
 *
 * PostgreSQL  : persistent storage (users, rooms, messages, …)
 * Redis       : fast cache for hot data (lastSeen, push subs, local deletes)
 *
 * Env vars:
 *   DATABASE_URL   postgresql://user:pass@host:5432/dbname
 *   REDIS_URL      redis://host:6379  (default: redis://localhost:6379)
 */

import pg from "pg";
import { createClient } from "redis";
import { logger } from "../lib/logger.js";

// ── PostgreSQL pool ──────────────────────────────────────────────
const { Pool } = pg;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/nexus",
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
pool.on("error", (err) => logger.error({ err }, "PG pool error"));

// ── Redis client ─────────────────────────────────────────────────
export const redis = createClient({
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
});
redis.on("error", (err) => logger.error({ err }, "Redis error"));
await redis.connect();

// ── Schema bootstrap ─────────────────────────────────────────────
await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    email           TEXT PRIMARY KEY,
    "displayName"   TEXT NOT NULL,
    "passwordHash"  TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'guest',
    avatar          TEXT,
    "nameTagColor"  TEXT NOT NULL DEFAULT 'default',
    "lastSeen"      BIGINT,
    "createdAt"     BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS friends (
    "userA" TEXT NOT NULL,
    "userB" TEXT NOT NULL,
    PRIMARY KEY ("userA", "userB")
  );

  CREATE TABLE IF NOT EXISTS friend_requests (
    id            TEXT PRIMARY KEY,
    "fromEmail"   TEXT NOT NULL,
    "toEmail"     TEXT NOT NULL,
    "fromName"    TEXT,
    "fromAvatar"  TEXT,
    "createdAt"   BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    "roomId"    TEXT PRIMARY KEY,
    name        TEXT,
    type        TEXT NOT NULL,
    creator     TEXT,
    admins      TEXT,
    "createdAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS room_members (
    "roomId" TEXT NOT NULL,
    email    TEXT NOT NULL,
    PRIMARY KEY ("roomId", email)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    "roomId"      TEXT NOT NULL,
    sender        TEXT NOT NULL,
    "senderName"  TEXT,
    "senderRole"  TEXT,
    "senderAvatar" TEXT,
    "nameTagColor" TEXT,
    content       TEXT,
    type          TEXT,
    "fileUrl"     TEXT,
    "fileName"    TEXT,
    "fileSize"    BIGINT,
    timestamp     BIGINT,
    recalled      BOOLEAN NOT NULL DEFAULT FALSE,
    "recalledAt"  BIGINT
  );

  CREATE INDEX IF NOT EXISTS messages_roomid_idx ON messages ("roomId", timestamp);

  CREATE TABLE IF NOT EXISTS invites (
    id          TEXT PRIMARY KEY,
    "roomId"    TEXT NOT NULL,
    "roomName"  TEXT,
    "fromEmail" TEXT NOT NULL,
    "fromName"  TEXT,
    "toEmail"   TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL
  );
`);

// ── helpers ──────────────────────────────────────────────────────
function parseJSON(str, fallback) {
  if (str == null) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

/** Map camelCase JS keys ↔ quoted PG columns (identity — PG is case-folding) */
function row(r) {
  if (!r) return null;
  return r;
}

// ── Users ────────────────────────────────────────────────────────
export async function getUser(email) {
  const { rows } = await pool.query(
    `SELECT * FROM users WHERE email = $1`, [email]
  );
  return rows[0] ?? null;
}

export async function saveUser(u) {
  const d = {
    avatar: null, lastSeen: null, role: "guest", nameTagColor: "default", ...u,
  };
  await pool.query(`
    INSERT INTO users (email, "displayName", "passwordHash", role, avatar, "nameTagColor", "lastSeen", "createdAt")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (email) DO UPDATE SET
      "displayName"  = EXCLUDED."displayName",
      "passwordHash" = EXCLUDED."passwordHash",
      role           = EXCLUDED.role,
      avatar         = EXCLUDED.avatar,
      "nameTagColor" = EXCLUDED."nameTagColor",
      "lastSeen"     = EXCLUDED."lastSeen",
      "createdAt"    = EXCLUDED."createdAt"
  `, [d.email, d.displayName, d.passwordHash, d.role, d.avatar, d.nameTagColor, d.lastSeen, d.createdAt]);
}

export async function updateUser(email, patch) {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  const setClause = fields.map((f, i) => `"${f}" = $${i + 2}`).join(", ");
  await pool.query(
    `UPDATE users SET ${setClause} WHERE email = $1`,
    [email, ...Object.values(patch)]
  );
}

export async function getAllUserEmails() {
  const { rows } = await pool.query(`SELECT email FROM users`);
  return rows.map(r => r.email);
}

export async function deleteUser(email) {
  await pool.query(`DELETE FROM users WHERE email = $1`, [email]);
}

/**
 * touchLastSeen: write to Redis (fast) AND PostgreSQL every 60 s.
 * Redis key: lastseen:<email>  (TTL 7 days)
 */
export async function touchLastSeen(email) {
  const now = Date.now();
  const key = `lastseen:${email}`;
  await redis.set(key, String(now), { EX: 7 * 24 * 3600 });

  // Throttle PG write to once per 60 s
  const pgKey = `lastseen_pg:${email}`;
  const last = await redis.get(pgKey);
  if (!last || now - Number(last) > 60_000) {
    await redis.set(pgKey, String(now), { EX: 7 * 24 * 3600 });
    await pool.query(`UPDATE users SET "lastSeen" = $1 WHERE email = $2`, [now, email]);
  }
}

// ── Friends ──────────────────────────────────────────────────────
export async function areFriends(a, b) {
  const [u, v] = [a, b].sort();
  const { rows } = await pool.query(
    `SELECT 1 FROM friends WHERE "userA" = $1 AND "userB" = $2`, [u, v]
  );
  return rows.length > 0;
}

export async function getFriends(email) {
  const { rows } = await pool.query(
    `SELECT "userA", "userB" FROM friends WHERE "userA" = $1 OR "userB" = $1`, [email]
  );
  return rows.map(r => (r.userA === email ? r.userB : r.userA));
}

export async function addFriend(a, b) {
  const [u, v] = [a, b].sort();
  await pool.query(
    `INSERT INTO friends ("userA","userB") VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u, v]
  );
}

export async function removeFriend(a, b) {
  const [u, v] = [a, b].sort();
  await pool.query(
    `DELETE FROM friends WHERE "userA" = $1 AND "userB" = $2`, [u, v]
  );
}

export async function deleteAllFriends(email) {
  await pool.query(`DELETE FROM friends WHERE "userA" = $1 OR "userB" = $1`, [email]);
}

// ── Friend Requests ──────────────────────────────────────────────
export async function getFriendRequests(toEmail) {
  const { rows } = await pool.query(
    `SELECT * FROM friend_requests WHERE "toEmail" = $1 ORDER BY "createdAt"`, [toEmail]
  );
  return rows;
}

export async function hasSentRequest(fromEmail, toEmail) {
  const { rows } = await pool.query(
    `SELECT 1 FROM friend_requests WHERE "fromEmail" = $1 AND "toEmail" = $2`, [fromEmail, toEmail]
  );
  return rows.length > 0;
}

export async function addFriendRequest(req) {
  const d = { fromName: null, fromAvatar: null, ...req, createdAt: Date.now() };
  await pool.query(`
    INSERT INTO friend_requests (id, "fromEmail", "toEmail", "fromName", "fromAvatar", "createdAt")
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT DO NOTHING
  `, [d.id, d.fromEmail, d.toEmail, d.fromName, d.fromAvatar, d.createdAt]);
}

export async function removeFriendRequest(fromEmail, toEmail) {
  await pool.query(
    `DELETE FROM friend_requests WHERE "fromEmail" = $1 AND "toEmail" = $2`, [fromEmail, toEmail]
  );
}

export async function deleteAllFriendRequests(email) {
  await pool.query(
    `DELETE FROM friend_requests WHERE "fromEmail" = $1 OR "toEmail" = $1`, [email]
  );
}

// ── Rooms ─────────────────────────────────────────────────────────
export async function getRoom(roomId) {
  const { rows } = await pool.query(`SELECT * FROM rooms WHERE "roomId" = $1`, [roomId]);
  if (!rows[0]) return null;
  const r = rows[0];
  const members = await getRoomMembers(roomId);
  return { ...r, admins: parseJSON(r.admins, []), members };
}

export async function saveRoom(r) {
  await pool.query(`
    INSERT INTO rooms ("roomId", name, type, creator, admins, "createdAt")
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT ("roomId") DO UPDATE SET
      name       = EXCLUDED.name,
      type       = EXCLUDED.type,
      creator    = EXCLUDED.creator,
      admins     = EXCLUDED.admins,
      "createdAt"= EXCLUDED."createdAt"
  `, [r.roomId, r.name ?? "", r.type, r.creator ?? null, JSON.stringify(r.admins ?? []), r.createdAt]);
}

export async function getRoomMembers(roomId) {
  const { rows } = await pool.query(
    `SELECT email FROM room_members WHERE "roomId" = $1`, [roomId]
  );
  return rows.map(r => r.email);
}

export async function addRoomMember(roomId, email) {
  await pool.query(
    `INSERT INTO room_members ("roomId", email) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [roomId, email]
  );
}

export async function removeRoomMember(roomId, email) {
  await pool.query(
    `DELETE FROM room_members WHERE "roomId" = $1 AND email = $2`, [roomId, email]
  );
}

export async function isRoomMember(roomId, email) {
  const { rows } = await pool.query(
    `SELECT 1 FROM room_members WHERE "roomId" = $1 AND email = $2`, [roomId, email]
  );
  return rows.length > 0;
}

export async function getUserRooms(email) {
  const { rows } = await pool.query(
    `SELECT "roomId" FROM room_members WHERE email = $1`, [email]
  );
  return rows.map(r => r.roomId);
}

export async function deleteRoom(roomId) {
  await pool.query(`DELETE FROM messages    WHERE "roomId" = $1`, [roomId]);
  await pool.query(`DELETE FROM room_members WHERE "roomId" = $1`, [roomId]);
  await pool.query(`DELETE FROM rooms        WHERE "roomId" = $1`, [roomId]);
}

export async function deleteAllUserRooms(email) {
  const roomIds = await getUserRooms(email);
  await pool.query(`DELETE FROM room_members WHERE email = $1`, [email]);
  for (const roomId of roomIds) {
    const remaining = await getRoomMembers(roomId);
    if (remaining.length === 0) {
      await pool.query(`DELETE FROM messages WHERE "roomId" = $1`, [roomId]);
      await pool.query(`DELETE FROM rooms    WHERE "roomId" = $1`, [roomId]);
    }
  }
}

// ── Messages ──────────────────────────────────────────────────────
const MSG_TTL = {
  admin: null, vip: null,
  member: 30 * 24 * 3600 * 1000,
  guest:   7 * 24 * 3600 * 1000,
};

export async function addMessage(msg) {
  const d = {
    senderName: null, senderRole: null, senderAvatar: null, nameTagColor: null,
    fileUrl: null, fileName: null, fileSize: null, recalledAt: null, recalled: false,
    ...msg,
  };
  await pool.query(`
    INSERT INTO messages
      (id, "roomId", sender, "senderName", "senderRole", "senderAvatar", "nameTagColor",
       content, type, "fileUrl", "fileName", "fileSize", timestamp, recalled, "recalledAt")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
  `, [
    d.id, d.roomId, d.sender, d.senderName, d.senderRole, d.senderAvatar, d.nameTagColor,
    d.content, d.type, d.fileUrl, d.fileName, d.fileSize, d.timestamp, d.recalled, d.recalledAt,
  ]);
}

export async function getRoomMessages(roomId) {
  const now = Date.now();
  const { rows } = await pool.query(
    `SELECT * FROM messages WHERE "roomId" = $1 ORDER BY timestamp`, [roomId]
  );
  return rows.filter(m => {
    if (m.recalled) return true;
    const ttl = MSG_TTL[m.senderRole ?? "guest"];
    if (ttl === null || ttl === undefined) return true;
    return now - (m.timestamp ?? 0) < ttl;
  });
}

export async function updateMessage(msgId, patch) {
  const fields = Object.keys(patch);
  if (fields.length) {
    const setClause = fields.map((f, i) => `"${f}" = $${i + 2}`).join(", ");
    await pool.query(
      `UPDATE messages SET ${setClause} WHERE id = $1`,
      [msgId, ...Object.values(patch)]
    );
  }
  const { rows } = await pool.query(`SELECT * FROM messages WHERE id = $1`, [msgId]);
  return rows[0] ?? null;
}

// ── Invites ───────────────────────────────────────────────────────
export async function getInvites(toEmail) {
  const { rows } = await pool.query(
    `SELECT * FROM invites WHERE "toEmail" = $1`, [toEmail]
  );
  return rows;
}

export async function addInvite(inv) {
  const d = { roomName: null, fromName: null, ...inv, createdAt: Date.now() };
  await pool.query(`
    INSERT INTO invites (id, "roomId", "roomName", "fromEmail", "fromName", "toEmail", "createdAt")
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT DO NOTHING
  `, [d.id, d.roomId, d.roomName, d.fromEmail, d.fromName, d.toEmail, d.createdAt]);
}

export async function removeInvite(id) {
  await pool.query(`DELETE FROM invites WHERE id = $1`, [id]);
}

export async function deleteAllInvites(email) {
  await pool.query(
    `DELETE FROM invites WHERE "toEmail" = $1 OR "fromEmail" = $1`, [email]
  );
}

// ── Push subscriptions — stored in Redis ─────────────────────────
// Key: push:<email>   Value: JSON string   TTL: 90 days
const PUSH_TTL = 90 * 24 * 3600;

export async function savePushSub(email, subscription) {
  await redis.set(`push:${email}`, JSON.stringify(subscription), { EX: PUSH_TTL });
}

export async function getPushSub(email) {
  const val = await redis.get(`push:${email}`);
  return parseJSON(val, null);
}

export async function deletePushSub(email) {
  await redis.del(`push:${email}`);
}

// ── Local deletes — stored in Redis ──────────────────────────────
// Key: localdeletes:<email>   Type: Redis Set   TTL: 30 days
const LD_TTL = 30 * 24 * 3600;

export async function addLocalDelete(email, msgId) {
  const key = `localdeletes:${email}`;
  await redis.sAdd(key, msgId);
  await redis.expire(key, LD_TTL);
}

export async function getLocalDeletes(email) {
  return redis.sMembers(`localdeletes:${email}`);
}

export async function deleteAllLocalDeletes(email) {
  await redis.del(`localdeletes:${email}`);
}
