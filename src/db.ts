import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { config } from './config';

export const pool = new Pool({ connectionString: config.databaseUrl, max: 20 });

export async function q<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const r = await pool.query(text, params);
  return r.rows as T[];
}
export async function one<T = any>(text: string, params: any[] = []): Promise<T | null> {
  return (await q<T>(text, params))[0] ?? null;
}

export async function migrate() {
  const dir = path.join(__dirname, 'migrations');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      console.log(`[migrate] applying ${f}`);
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}
