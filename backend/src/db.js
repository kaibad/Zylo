const { Pool } = require("pg");

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT, 10),
  database: process.env.DB_NAME,
});

async function initDB() {
  const client = await pool.connect();
  try {
    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Posts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        author VARCHAR(100) NOT NULL DEFAULT 'Anonymous',
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        is_private BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Migrate existing posts table (add columns if they don't exist)
    await client.query(
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;`,
    );
    await client.query(
      `ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;`,
    );

    // Comments table
    await client.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
        author VARCHAR(100) NOT NULL DEFAULT 'Anonymous',
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Migrate existing columns to timestamptz to fix local timezone offset parsing bugs
    await client.query(
      `ALTER TABLE users ALTER COLUMN created_at TYPE TIMESTAMPTZ;`,
    );
    await client.query(
      `ALTER TABLE posts ALTER COLUMN created_at TYPE TIMESTAMPTZ;`,
    );
    await client.query(
      `ALTER TABLE posts ALTER COLUMN updated_at TYPE TIMESTAMPTZ;`,
    );
    await client.query(
      `ALTER TABLE comments ALTER COLUMN created_at TYPE TIMESTAMPTZ;`,
    );

    console.log("Database tables initialized");
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
