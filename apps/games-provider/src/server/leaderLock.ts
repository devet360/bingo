import type { Pool, PoolClient } from 'pg';

export class LeaderLock {
  private client: PoolClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private leader = false;

  constructor(
    private readonly pool: Pool,
    private readonly key = 'games-provider-v2-leader',
    private readonly pollMs = 2_000,
  ) {}

  isLeader(): boolean {
    return this.leader;
  }

  async start(onChange: (leader: boolean) => void): Promise<void> {
    if (this.client) return;
    this.client = await this.pool.connect();
    await this.client.query('LISTEN games_provider_state');
    const probe = async () => {
      if (!this.client) return;
      const result = await this.client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [this.key],
      );
      const acquired = result.rows[0]?.acquired ?? false;
      if (acquired !== this.leader) {
        this.leader = acquired;
        onChange(acquired);
      }
    };
    await probe();
    this.timer = setInterval(() => { void probe(); }, this.pollMs);
  }

  async notifyState(payload: Record<string, unknown>): Promise<void> {
    await this.pool.query('SELECT pg_notify($1, $2)', [
      'games_provider_state',
      JSON.stringify(payload),
    ]);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.client) {
      if (this.leader) await this.client.query('SELECT pg_advisory_unlock(hashtext($1))', [this.key]);
      this.leader = false;
      this.client.release();
      this.client = null;
    }
  }
}
