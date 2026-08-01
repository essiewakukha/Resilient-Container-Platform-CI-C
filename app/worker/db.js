const mysql = require('mysql2/promise');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

let pool;

async function getDbCredentials() {
  const client = new SecretsManagerClient({});
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN })
  );
  return JSON.parse(response.SecretString);
}

async function getPool() {
  if (pool) return pool;

  const { username, password } = await getDbCredentials();

  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: username,
    password,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
  });

  return pool;
}

module.exports = { getPool };