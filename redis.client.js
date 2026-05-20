/**
 * Redis cluster client — app-side only (no Redis cluster config changes).
 * Set REDIS_CLUSTER_NODES + REDIS_CLUSTER_NAT_HOST when cluster returns unreachable private IPs.
 */
require('dotenv').config();

const Redis = require('ioredis');

function parseNodes() {
  const raw = process.env.REDIS_CLUSTER_NODES || '127.0.0.1:6379';
  return raw.split(',').map((entry) => {
    const [host, portStr] = entry.trim().split(':');
    return { host: host || '127.0.0.1', port: parseInt(portStr || '6379', 10) };
  });
}

function isPrivateIp(host) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function redisOptions() {
  const opts = { connectTimeout: 10000, maxRetriesPerRequest: null, enableReadyCheck: true };
  if (process.env.REDIS_PASSWORD) opts.password = process.env.REDIS_PASSWORD;
  if (process.env.REDIS_USERNAME) opts.username = process.env.REDIS_USERNAME;
  if (process.env.REDIS_TLS === 'true') opts.tls = {};
  return opts;
}

function createRedisClient() {
  const nodes = parseNodes();
  const opts = redisOptions();
  const natHost = process.env.REDIS_CLUSTER_NAT_HOST?.trim();

  if ((process.env.REDIS_MODE || 'cluster').toLowerCase() === 'standalone') {
    const { host, port } = nodes[0];
    return new Redis({ host, port, ...opts });
  }

  return new Redis.Cluster(nodes, {
    dnsLookup: (address, cb) => cb(null, address),
    natMap: natHost
      ? (key) => {
          const i = key.lastIndexOf(':');
          const host = key.slice(0, i);
          const port = Number(key.slice(i + 1));
          if (isPrivateIp(host)) return { host: natHost, port };
          return null;
        }
      : undefined,
    redisOptions: opts,
    enableOfflineQueue: true,
    slotsRefreshTimeout: 15000,
  });
}

module.exports = { createRedisClient, parseNodes, redisOptions };
