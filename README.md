# Nexus Chat — Standalone Node.js Server

Server chat (Express 5 + WebSocket + SQLite) đã được tách khỏi monorepo pnpm
workspace gốc, không còn phụ thuộc `@workspace/db`, `@workspace/api-zod`,
esbuild, hay TypeScript. Chạy trực tiếp bằng Node, không cần bước build.

## Cài đặt

```bash
npm install
```

## Chạy

```bash
npm start
# hoặc khi phát triển (tự restart khi sửa file):
npm run dev
```

Mặc định lắng nghe ở `PORT=3000` (đặt biến môi trường `PORT` để đổi).

## Biến môi trường (tùy chọn)

| Biến            | Mặc định                              | Ý nghĩa                          |
|-----------------|----------------------------------------|-----------------------------------|
| `PORT`          | `3000`                                  | Cổng HTTP/WS                      |
| `JWT_SECRET`    | `nexus_secret_2025`                     | Khóa ký JWT                       |
| `DB_FILE`       | `data/nexus.db`                         | Đường dẫn file SQLite             |
| `VAPID_PUBLIC`  | (key mẫu sẵn có)                        | Web Push public key               |
| `VAPID_PRIVATE` | (key mẫu sẵn có)                        | Web Push private key              |
| `VAPID_EMAIL`   | `mailto:admin@nexus.vn`                 | Email liên hệ VAPID               |
| `LOG_LEVEL`     | `info`                                  | Mức log pino                      |
| `NODE_ENV`      | (none)                                  | `production` để tắt log màu       |

## Cấu trúc

```
src/
  index.js        # entrypoint: tạo HTTP server, WS, seed admin
  app.js          # Express app: middleware + static + routes
  db/index.js     # lớp dữ liệu SQLite (better-sqlite3), thay cho @workspace/db
  lib/logger.js   # pino logger
  chat/
    routes.js     # toàn bộ REST API (auth, friends, rooms, messages, admin)
    ws.js         # WebSocket server (chat realtime, gọi điện WebRTC)
    push.js       # Web Push notifications
public/
  index.html      # UI gốc
  patch.js        # script vá lỗi phía client (được tự động chèn vào index.html)
  sw.js           # service worker cho push
```

## Tài khoản admin mặc định

Khi server khởi động lần đầu, hai tài khoản admin sẽ được tạo tự động:

- `admin@nexus.vn`
- `quantri@nexus.vn`

Mật khẩu: `11082012` — **nên đổi ngay sau khi đăng nhập lần đầu** (qua
`PUT /me/password`).

## Database

Dữ liệu lưu trong file SQLite tại `data/nexus.db` (tự tạo khi chạy lần đầu).
Không cần cài đặt database server riêng.
