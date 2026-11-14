import type { PoolClient } from 'pg';

export async function resolveReservation(
  client: PoolClient, taskId: string, day: string, amount: string, settled: boolean,
) {
  const spent = settled ? amount : '0';
  const task = await client.query(
    'UPDATE research_tasks SET reserved = reserved - $2, spent = spent + $3 WHERE id = $1',
    [taskId, amount, spent],
  );
  const daily = await client.query(
    'UPDATE daily_spend SET reserved = reserved - $3, spent = spent + $4 WHERE task_id = $1 AND day = $2',
    [taskId, day, amount, spent],
  );
  if (task.rowCount !== 1 || daily.rowCount !== 1) throw new Error('Reservation counters are missing');
}
