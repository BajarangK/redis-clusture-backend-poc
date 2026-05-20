# Redis Cluster POC

Small Express app to verify connectivity to a Redis Cluster after deploy. Uses [ioredis](https://github.com/redis/ioredis) in cluster mode with optional NAT mapping when connecting from the host to Docker-published ports.

## Prerequisites

- Node.js 18+
- A running Redis Cluster (e.g. `redis-node-1` … `redis-node-6` on ports `7001`–`7006`)
- For Docker deploy: cluster network `redis-enterprise-cluster_redis-cluster-net` must exist

Check cluster health:

```bash
redis-cli -p 7001 cluster info | grep cluster_state
# cluster_state:ok
```

## Quick start

### Run on host

Use this when Redis runs in Docker and ports are published to `127.0.0.1:7001`–`7006`.

```bash
npm install
cp .env.example .env
# edit .env if needed

export REDIS_MODE=cluster
export REDIS_CLUSTER_NODES=127.0.0.1:7001,127.0.0.1:7002,127.0.0.1:7003
export REDIS_CLUSTER_NAT_HOST=127.0.0.1
export PORT=5004

npm start
```

`REDIS_CLUSTER_NAT_HOST` maps internal Docker IPs (`172.x.x.x`) to `127.0.0.1` so the client can follow cluster redirects from your machine.

### Run with Docker

Joins the existing cluster network and talks to nodes by container name.

```bash
docker compose up -d --build
```

App listens on port **5004** (host and container mapping). Grafana often uses 3000 locally.

## API

| Endpoint | Description |
|----------|-------------|
| `GET /health` | `PING` Redis |
| `GET /status` | Connection state (no Redis call) |
| `GET /test` | SET / GET / DEL a temporary key |
| `GET /cluster-info` | `CLUSTER SLOTS` and `CLUSTER NODES` |

Examples:

```bash
curl http://localhost:5004/health
curl http://localhost:5004/test
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5004` | HTTP port (`npm start`) |
| `HOST_PORT` | `5004` | Host port for `docker compose` (maps to container `3000`) |
| `REDIS_MODE` | `cluster` | `cluster` or `standalone` |
| `REDIS_CLUSTER_NODES` | `127.0.0.1:6379` | Comma-separated `host:port` seed nodes |
| `REDIS_CLUSTER_NAT_HOST` | — | When using `127.0.0.1` seeds from host, set to `127.0.0.1` |
| `REDIS_PASSWORD` | — | Redis password |
| `REDIS_USERNAME` | — | ACL username |
| `REDIS_TLS` | `false` | Set to `true` for TLS |

### Host vs Docker

| Where the app runs | `REDIS_CLUSTER_NODES` | `REDIS_CLUSTER_NAT_HOST` |
|--------------------|------------------------|---------------------------|
| Host (`npm start`) | `127.0.0.1:7001,127.0.0.1:7002,...` | `127.0.0.1` |
| Docker (`docker compose`) | `redis-node-1:7001,redis-node-2:7002,...` | not needed |

## QA (Kubernetes / Windows)

`Failed to refresh slots cache` on QA usually means the app **can reach the seed node** but **cannot reach the IPs Redis advertises** in `CLUSTER SLOTS` (pod IPs like `10.x.x.x`).

### App runs inside the same K8s cluster

```env
REDIS_CLUSTER_NODES=redis-cluster-0.redis-headless...:6379,redis-cluster-1...,redis-cluster-2...
```

No NAT host needed if pod IPs are routable. Ensure network policy allows TCP **6379** (and cluster bus **16379** if required).

### App runs on Windows (outside cluster)

`*.svc.cluster.local` **does not resolve** from a Windows VM unless you use VPN/split DNS.

**Option A — port-forward (dev/QA test)**

```bash
kubectl port-forward -n redis-cluster svc/redis-cluster 6379:6379
```

```env
REDIS_CLUSTER_NODES=127.0.0.1:6379
REDIS_CLUSTER_NAT_HOST=127.0.0.1
```

**Option B — QA LoadBalancer / hostname**

Use the LB hostname as both seed and NAT target:

```env
REDIS_CLUSTER_NODES=qa-redis.example.com:6379
REDIS_CLUSTER_NAT_HOST=qa-redis.example.com
```

Debug what Redis advertises:

```bash
curl http://localhost:5004/diagnose
```

## Troubleshooting

**`Failed to refresh slots cache` / cluster not ready**

- Run `GET /diagnose` — check `advertisedAddresses` vs what your host can reach
- Set `REDIS_CLUSTER_NAT_HOST` to a **reachable** hostname (LB, `127.0.0.1` with port-forward)
- Local Docker: `REDIS_CLUSTER_NAT_HOST=127.0.0.1` with `127.0.0.1:7001,...` seeds
- In Docker: ensure the app is on `redis-enterprise-cluster_redis-cluster-net`

**`ECONNREFUSED`**

- Wrong host/port or Redis not running
- Inside a container, do not use `127.0.0.1` for Redis on the host — use `redis-node-*` or the host IP

**Port already in use**

- Stop the other process: `lsof -i :5004` then `kill <pid>`
- Or use another host port: `HOST_PORT=5005 docker compose up`

## Project layout

```
server.js           # Express app + Redis client
docker-compose.yml  # Deploy on cluster Docker network
Dockerfile
.env.example
```
