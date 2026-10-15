import pg from "pg";
export type Query = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount: number | null }>;
};
export const one = async (q: Query, sql: string, params: any[] = []) =>
  (await q.query(sql, params)).rows[0];
export class Database {
  pool: pg.Pool;
  private clients = new Set<pg.PoolClient>();
  private queue: Promise<unknown> = Promise.resolve();
  private tenantTransactionsOpen = 0;
  constructor(
    url = process.env.DATABASE_URL,
    private options: { serialize?: boolean } = {},
  ) {
    if (!url) throw new Error("DATABASE_URL required");
    this.pool = new pg.Pool({ connectionString: url, max: 12 });
    this.pool.on("connect", (client) => {
      this.clients.add(client);
      client.once("end", () => this.clients.delete(client));
    });
  }
  private guard<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.options.serialize) return fn();
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
  system<T>(fn: (q: Query) => Promise<T>) {
    return this.guard(() => fn(this.pool));
  }
  systemTransaction<T>(fn: (q: Query) => Promise<T>) {
    return this.guard(async () => {
      const c = await this.pool.connect();
      try {
        await c.query("BEGIN");
        const result = await fn(c);
        await c.query("COMMIT");
        return result;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    });
  }
  tenant<T>(id: string, fn: (q: Query) => Promise<T>) {
    return this.guard(async () => {
      const c = await this.pool.connect();
      this.tenantTransactionsOpen += 1;
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE workspace_app");
        await c.query("SELECT set_config('app.tenant_id',$1,true)", [id]);
        const result = await fn(c);
        await c.query("COMMIT");
        return result;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        this.tenantTransactionsOpen -= 1;
        c.release();
      }
    });
  }
  /**
   * W29-P0/A1: how many tenant transactions THIS instance currently holds open.
   * The external-effect acceptance reads it from inside the provider call, so the
   * claim "no provider I/O happens while a tenant transaction is held" is proven
   * from the runtime instead of being asserted in documentation.
   */
  tenantTransactionsInFlight(): number {
    return this.tenantTransactionsOpen;
  }
  async close() {
    await this.queue;
    await this.pool.end();
    // pg-pool can resolve end() before idle clients finish closing their TCP
    // connections. Wait for those ends before teardown or database removal.
    await Promise.all(
      [...this.clients].map(
        (client) => new Promise<void>((resolve) => client.once("end", resolve)),
      ),
    );
  }
}
