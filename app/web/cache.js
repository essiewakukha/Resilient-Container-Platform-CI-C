const { createClient } = require('redis');

let client;

async function getRedisClient() {
  if (client) return client;

  client = createClient({
    socket: {
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
    },
  });

  client.on('error', (err) => console.error('Redis client error', err));
  await client.connect();

  return client;
}

module.exports = { getRedisClient };