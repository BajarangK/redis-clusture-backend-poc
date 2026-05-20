const express = require('express');
const { createRedisClient, parseNodes } = require('./redis.client');

const PORT = parseInt(process.env.PORT || '5004', 10);
const REDIS_MODE = (process.env.REDIS_MODE || 'cluster').toLowerCase();
const app = express();

app.use(express.json());

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
redis.on('end', () => { redisReady = false; });

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
  res.json({ status: 'ok', mode: REDIS_MODE, redis: pong, nodes: parseNodes() });
}));

app.get('/status', (req, res) => {
  res.json({
    mode: REDIS_MODE,
    ready: redisReady,
    nodes: parseNodes(),
    natHost: process.env.REDIS_CLUSTER_NAT_HOST || null,
    lastError: lastRedisError?.message || null,
  });
});

app.get('/test', asyncHandler(async (req, res) => {
  const result = await runSmokeTest();
  res.status(result.match ? 200 : 500).json({ status: result.match ? 'pass' : 'fail', ...result });
}));

app.get('/cluster-info', asyncHandler(async (req, res) => {
  if (REDIS_MODE !== 'cluster') return res.status(400).json({ error: 'REDIS_MODE is not cluster' });
  res.json({
    slots: await redis.cluster('slots'),
    nodes: await redis.cluster('nodes'),
  });
}));

app.use((req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, req, res, next) => {
  console.error('[http]', err.message);
  res.status(503).json({
    status: 'error',
    message: err.message,
    hint: /slots cache/i.test(err.message)
      ? 'Set REDIS_CLUSTER_NAT_HOST to reachable host (no Redis cluster config change needed)'
      : null,
  });
});

const server = app.listen(PORT, async () => {
  console.log(`[server] http://0.0.0.0:${PORT}`);
  try {
    await redis.ping();
    console.log('[redis] startup probe: OK');
  } catch (err) {
    console.error('[redis] startup probe failed:', err.message);
  }
});

function shutdown() {
  server.close();
  redis.disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
