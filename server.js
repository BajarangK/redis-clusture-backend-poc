const express = require('express');
const Redis = require('ioredis');

const PORT = parseInt(process.env.PORT || '5004', 10);
const REDIS_MODE = (process.env.REDIS_MODE || 'cluster').toLowerCase();
const app = express();

app.use(express.json());

function parseNodes() {
  const raw = process.env.REDIS_CLUSTER_NODES || process.env.REDIS_HOST || '127.0.0.1:6379';
  return raw.split(',').map((entry) => {
    const [host, portStr] = entry.trim().split(':');
    return {
      host: host || '127.0.0.1',
      port: parseInt(portStr || process.env.REDIS_PORT || '6379', 10),
    };
  });
}

function loopbackSeedsOnly(nodes) {
  return nodes.every((n) => {
    const h = n.host.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  });
}

function isPrivateOrDockerIpv4(host) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function buildNatMap(nodes) {
  const natHost = process.env.REDIS_CLUSTER_NAT_HOST?.trim();
  if (!natHost || !loopbackSeedsOnly(nodes)) return {};
  console.log(`[redis] natMap: Docker/private IPs -> ${natHost}`);
  return {
    natMap(key) {
      const idx = key.lastIndexOf(':');
      if (idx <= 0) return null;
      const host = key.slice(0, idx);
      const port = Number(key.slice(idx + 1));
      if (!Number.isFinite(port)) return null;
      if (isPrivateOrDockerIpv4(host)) return { host: natHost, port };
      return null;
    },
  };
}

function buildRedisOptions() {
  const opts = {
    connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT || '10000', 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
  if (process.env.REDIS_PASSWORD) opts.password = process.env.REDIS_PASSWORD;
  if (process.env.REDIS_USERNAME) opts.username = process.env.REDIS_USERNAME;
  if (process.env.REDIS_TLS === 'true') opts.tls = {};
  return opts;
}

function createRedisClient() {
  const nodes = parseNodes();
  const redisOptions = buildRedisOptions();

  if (REDIS_MODE === 'standalone') {
    const { host, port } = nodes[0];
    console.log(`[redis] mode=standalone host=${host} port=${port}`);
    return new Redis({ host, port, ...redisOptions });
  }

  console.log(`[redis] mode=cluster nodes=${nodes.map((n) => `${n.host}:${n.port}`).join(',')}`);
  return new Redis.Cluster(nodes, {
    dnsLookup: (address, callback) => callback(null, address),
    ...buildNatMap(nodes),
    redisOptions,
    enableReadyCheck: true,
    enableOfflineQueue: true,
    clusterRetryStrategy(times) {
      if (times > 20) return null;
      return Math.min(times * 200, 5000);
    },
  });
}

const redis = createRedisClient();
let redisReady = false;
let lastRedisError = null;

redis.on('ready', () => {
  redisReady = true;
  lastRedisError = null;
  console.log('[redis] ready');
});

redis.on('error', (err) => {
  lastRedisError = err;
  console.error('[redis] error:', err.message);
});

redis.on('end', () => {
  redisReady = false;
});

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function runSmokeTest() {
  const key = `cluster-test:${Date.now()}`;
  const value = `ok-${Date.now()}`;

  await redis.set(key, value, 'EX', 60);
  const read = await redis.get(key);
  await redis.del(key);

  return { key, written: value, read, match: read === value };
}

app.get('/health', asyncHandler(async (req, res) => {
  const pong = await redis.ping();
  res.json({
    status: 'ok',
    mode: REDIS_MODE,
    redis: pong === 'PONG' ? 'connected' : pong,
    nodes: parseNodes(),
  });
}));

app.get('/status', (req, res) => {
  res.json({
    mode: REDIS_MODE,
    ready: redisReady,
    nodes: parseNodes(),
    lastError: lastRedisError ? lastRedisError.message : null,
  });
});

app.get('/cluster-info', asyncHandler(async (req, res) => {
  if (REDIS_MODE !== 'cluster') {
    return res.status(400).json({
      error: 'REDIS_MODE is not cluster',
      hint: 'Set REDIS_MODE=cluster or use GET /health for standalone',
    });
  }
  const slots = await redis.cluster('slots');
  const nodes = await redis.cluster('nodes');
  res.json({
    slots: typeof slots === 'string' ? slots : slots,
    nodes: typeof nodes === 'string' ? nodes : nodes,
  });
}));

app.get('/test', asyncHandler(async (req, res) => {
  const result = await runSmokeTest();
  res.status(result.match ? 200 : 500).json({
    status: result.match ? 'pass' : 'fail',
    ...result,
  });
}));

app.use((req, res) => {
  res.status(404).json({
    error: 'not found',
    endpoints: {
      'GET /health': 'ping redis',
      'GET /status': 'connection state without calling redis',
      'GET /test': 'set, get, delete a test key',
      'GET /cluster-info': 'CLUSTER SLOTS and CLUSTER NODES (cluster mode only)',
    },
  });
});

app.use((err, req, res, next) => {
  console.error('[http] request failed:', err.message);
  res.status(503).json({
    status: 'error',
    message: err.message,
    hint: getConnectionHint(err.message),
  });
});

function getConnectionHint(message) {
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(message)) {
    return 'Redis is not reachable. Check REDIS_CLUSTER_NODES, firewall, and that Redis is running.';
  }
  if (/slots cache|CLUSTERDOWN|MOVED|not ready/i.test(message)) {
    return 'From host use REDIS_CLUSTER_NODES=127.0.0.1:7001,... and REDIS_CLUSTER_NAT_HOST=127.0.0.1. In Docker use redis-node-* hostnames on redis-enterprise-cluster_redis-cluster-net.';
  }
  if (/NOAUTH|WRONGPASS/i.test(message)) {
    return 'Set REDIS_PASSWORD (and REDIS_USERNAME if using ACLs).';
  }
  return null;
}

const server = app.listen(PORT, () => {
  console.log(`[server] listening on http://0.0.0.0:${PORT}`);
  console.log(`[server] REDIS_MODE=${REDIS_MODE}`);
  console.log(`[server] nodes=${process.env.REDIS_CLUSTER_NODES || '127.0.0.1:6379'}`);
  console.log('[server] GET /status  GET /health  GET /test');
  probeRedisAtStartup();
});

async function probeRedisAtStartup() {
  try {
    await redis.ping();
    console.log('[redis] startup probe: OK');
  } catch (err) {
    console.error('[redis] startup probe failed:', err.message);
    console.error('[redis]', getConnectionHint(err.message) || 'Fix Redis config and restart.');
  }
}

function shutdown() {
  console.log('[server] shutting down...');
  server.close();
  redis.disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
