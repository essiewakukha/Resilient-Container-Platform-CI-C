const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { createClient } = require('redis');
const { getPool } = require('./db');

const sqs = new SQSClient({});
const QUEUE_URL = process.env.SQS_QUEUE_URL;

let redis;
async function getRedis() {
  if (redis) return redis;
  redis = createClient({
    socket: {
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
    },
  });
  redis.on('error', (err) => console.error('Redis client error', err));
  await redis.connect();
  return redis;
}

// Simulates the "intensive task" work the web tier offloaded to this worker
async function processOrder(order) {
  const workMs = 500 + Math.floor(Math.random() * 1500);
  await new Promise((resolve) => setTimeout(resolve, workMs));
  console.log(`Processed order ${order.orderId} (${order.item} x${order.quantity}) in ${workMs}ms`);
}

async function handleMessage(message) {
  const order = JSON.parse(message.Body);

  await processOrder(order);

  const pool = await getPool();
  await pool.query('UPDATE orders SET status = ? WHERE id = ?', ['processed', order.orderId]);

  const cache = await getRedis();
  await cache.del('orders:all');
  await cache.del(`orders:${order.orderId}`);

  await sqs.send(
    new DeleteMessageCommand({
      QueueUrl: QUEUE_URL,
      ReceiptHandle: message.ReceiptHandle,
    })
  );
}

async function pollLoop() {
  console.log('Worker started, polling SQS for order tasks...');

  while (true) {
    try {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: QUEUE_URL,
          MaxNumberOfMessages: 5,
          WaitTimeSeconds: 20, // long polling
          VisibilityTimeout: 60,
        })
      );

      if (!Messages || Messages.length === 0) continue;

      await Promise.all(
        Messages.map((message) =>
          handleMessage(message).catch((err) =>
            console.error(`Failed to process message ${message.MessageId}`, err)
          )
        )
      );
    } catch (err) {
      console.error('Poll loop error', err);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

pollLoop();