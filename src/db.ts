import type { Pool, PoolClient } from 'pg';

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let reusable = false;

  try {
    await client.query('BEGIN');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      reusable = true;
      return result;
    } catch (error) {
      await client.query('ROLLBACK').then(() => { reusable = true; }, () => {});
      throw error;
    }
  } finally {
    client.release(!reusable);
  }
}
