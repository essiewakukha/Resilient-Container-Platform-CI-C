const express = require('express');
const { randomUUID } = require('crypto');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { getPool } = require('./db');
const { getRedisClient } = require('./cache');

const app = express();
app.use(express.json());

const sqs = new SQSClient({});
const CACHE_TTL_SECONDS = 30;
const ORDERS_CACHE_KEY = 'orders:all';

// Health check - used by the ALB target group and Route 53 health check
app.get('/', (req, res) => {
  res.status(200).send('ok');
});

// Create an order: write a pending row, then push the processing task to SQS.
// The worker service picks it up asynchronously and marks it processed.
app.post('/orders', async (req, res) => {
  try {
    const { item, quantity } = req.body;
    if (!item || !quantity) {
      return res.status(400).json({ error: 'item and quantity are required' });
    }

    const id = randomUUID();
    const pool = await getPool();
    await pool.query(
      'INSERT INTO orders (id, item, quantity, status) VALUES (?, ?, ?, ?)',
      [id, item, quantity, 'pending']
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        MessageBody: JSON.stringify({ orderId: id, item, quantity }),
      })
    );

    // Invalidate the list cache since the dataset changed
    const redis = await getRedisClient();
    await redis.del(ORDERS_CACHE_KEY);

    res.status(202).json({ id, status: 'pending' });
  } catch (err) {
    console.error('Failed to create order', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// List orders: cache-aside through Redis
app.get('/orders', async (req, res) => {
  try {
    const redis = await getRedisClient();
    const cached = await redis.get(ORDERS_CACHE_KEY);
    if (cached) {
      return res.json({ source: 'cache', orders: JSON.parse(cached) });
    }

    const pool = await getPool();
    const [rows] = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100');

    await redis.set(ORDERS_CACHE_KEY, JSON.stringify(rows), { EX: CACHE_TTL_SECONDS });

    res.json({ source: 'database', orders: rows });
  } catch (err) {
    console.error('Failed to list orders', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Fetch a single order by id: also cache-aside, keyed per order
app.get('/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `orders:${id}`;
    const redis = await getRedisClient();
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json({ source: 'cache', order: JSON.parse(cached) });
    }

    const pool = await getPool();
    const [rows] = await pool.query('SELECT * FROM orders WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'order not found' });
    }

    await redis.set(cacheKey, JSON.stringify(rows[0]), { EX: CACHE_TTL_SECONDS });
    res.json({ source: 'database', order: rows[0] });
  } catch (err) {
    console.error('Failed to fetch order', err);
    res.status(500).json({ error: 'internal error' });
  }
});

const port = process.env.PORT || 80;
app.listen(port, () => console.log(`web app listening on port ${port}`));