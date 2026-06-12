# Nexus Chat Server — PostgreSQL + Redis

Phiên bản này thay thế **SQLite** bằng **PostgreSQL** (lưu trữ chính) và **Redis** (cache nhanh).

## Thay đổi so với bản SQLite

| Thành phần        | Trước          | Sau                    |
|-------------------|----------------|------------------------|
| Database chính    | SQLite (file)  | PostgreSQL             |
| Push subscriptions| SQLite table   | Redis (TTL 90 ngày)    |
| Local deletes     | SQLite table   | Redis Set (TTL 30 ngày)|
| lastSeen          | SQLite update  | Redis (instant) + PG (throttled 60s) |
| Package           | better-sqlite3 | `pg` + `redis`         |

## Biến môi trường

```env
DATABASE_URL=postgresql://user:password@localhost:5432/nexus
REDIS_URL=redis://localhost:6379
PORT=3000
JWT_SECRET=your_secret_here
```

## Khởi động nhanh

### 1. Chạy PostgreSQL + Redis bằng Docker Compose

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: nexus
      POSTGRES_PASSWORD: nexus
      POSTGRES_DB: nexus
    ports:
      - "5432:5432"
    volumes:
      - pg_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  pg_data:
```

```bash
docker compose up -d
```

### 2. Cài dependencies và chạy server

```bash
npm install
DATABASE_URL=postgresql://nexus:nexus@localhost:5432/nexus \
REDIS_URL=redis://localhost:6379 \
npm start
```

Schema PostgreSQL tự động tạo khi server khởi động (CREATE TABLE IF NOT EXISTS).

## Kiến trúc Redis

```
lastseen:<email>         STRING  → timestamp ms, TTL 7 ngày
lastseen_pg:<email>      STRING  → timestamp ms (throttle PG write), TTL 7 ngày
push:<email>             STRING  → JSON subscription, TTL 90 ngày
localdeletes:<email>     SET     → {msgId, …}, TTL 30 ngày
```
