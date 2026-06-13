import { createServer } from "http";
import app from "./app.js";
import { setupWS } from "./chat/ws.js";
import { logger } from "./lib/logger.js";
import { getUser, saveUser } from "./db/index.js";
import bcrypt from "bcryptjs";

const port = Number(process.env.PORT ?? 3000);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT: "${process.env.PORT}"`);

const httpServer = createServer(app);
setupWS(httpServer);

function startListening(retriesLeft) {
  httpServer.listen(port, async () => {
    logger.info({ port }, "Nexus Chat server listening");
    await seedAdmin();
  });
  httpServer.once("error", (err) => {
    if (err.code === "EADDRINUSE" && retriesLeft > 0) {
      logger.warn({ port, retriesLeft }, "Port in use, retrying in 3s…");
      setTimeout(() => {
        httpServer.removeAllListeners("error");
        httpServer.close(() => startListening(retriesLeft - 1));
        // Force-close if close hangs
        setTimeout(() => startListening(retriesLeft - 1), 500);
      }, 3000);
    } else {
      logger.error({ err }, "Server error");
      process.exit(1);
    }
  });
}
startListening(10);

async function seedAdmin() {
  const admins = [
    { email: "admin@nexus.vn",   displayName: "quan5s" },
    { email: "quantri@nexus.vn", displayName: "quan5s" },
  ];
  for (const { email, displayName } of admins) {
    const existing = await getUser(email);
    if (!existing) {
      const passwordHash = await bcrypt.hash("11082012", 10);
      await saveUser({
        email, displayName, passwordHash, role: "admin",
        avatar: null, nameTagColor: "red", createdAt: Date.now()
      });
      logger.info({ email }, "Admin seeded");
    }
  }
}
