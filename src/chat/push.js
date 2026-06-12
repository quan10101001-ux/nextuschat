import webpush from "web-push";
import { getPushSub, deletePushSub } from "../db/index.js";
import { logger } from "../lib/logger.js";

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  ?? "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE ?? "UUxI4O8-FbRouAevSmBQ6co62ggea4YFIouBBY0B7f4";
const VAPID_EMAIL   = process.env.VAPID_EMAIL   ?? "mailto:admin@nexus.vn";

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

export function getVapidPublicKey() {
  return VAPID_PUBLIC;
}

export async function sendPush(toEmail, payload) {
  try {
    const sub = await getPushSub(toEmail);
    if (!sub) return;
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch (err) {
    if (err?.statusCode === 410) {
      await deletePushSub(toEmail);
    }
    logger.warn({ toEmail, err: err?.message }, "Push failed");
  }
}
