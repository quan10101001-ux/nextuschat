import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { logger } from "./lib/logger.js";
import chatRouter from "./chat/routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");

const app = express();

app.use(pinoHttp({
  logger,
  serializers: {
    req(req) { return { id: req.id, method: req.method, url: req.url?.split("?")[0] }; },
    res(res) { return { statusCode: res.statusCode }; },
  },
}));
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ── Static files (except index.html — served with injection) ────
app.use("/uploads", express.static(path.join(PUBLIC_DIR, "uploads")));
app.use("/sw.js",   (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "sw.js")));
app.use("/patch.js",(_req, res) => res.sendFile(path.join(PUBLIC_DIR, "patch.js")));

// ── All chat API routes ──────────────────────────────────────────
app.use(chatRouter);

// ── Serve index.html with injected patch script ──────────────────
app.get("/{*path}", (_req, res) => {
  const htmlPath = path.join(PUBLIC_DIR, "index.html");
  if (!fs.existsSync(htmlPath)) {
    res.status(404).send("index.html not found in public/");
    return;
  }
  let html = fs.readFileSync(htmlPath, "utf-8");
  // Inject patch.js before </body> — respects "don't touch HTML" constraint
  html = html.replace("</body>", `<script src="/patch.js"></script>\n</body>`);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

export default app;
