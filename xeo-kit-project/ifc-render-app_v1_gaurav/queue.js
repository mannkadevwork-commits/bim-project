// ==========================================
// SHARED QUEUE CONFIG
// ==========================================
// Single source of truth for the Redis connection + BullMQ Queue instance
// so server.js (producer) and worker.js (consumer) never drift out of sync
// on connection options or queue name.
require('dotenv').config();
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const connection = new IORedis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  // BullMQ requirement: without this, ioredis will throw
  // "maxRetriesPerRequest must be null" errors under blocking commands.
  maxRetriesPerRequest: null,
});

connection.on('error', (err) => {
  console.error('[Redis] Connection error:', err.message);
});

const RENDER_QUEUE_NAME = 'render';

const renderQueue = new Queue(RENDER_QUEUE_NAME, { connection });

module.exports = { connection, renderQueue, RENDER_QUEUE_NAME };
