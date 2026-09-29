import pg from 'pg';
export type Query={query:(sql:string,params?:any[])=>Promise<{rows:any[];rowCount:number|null}>};
export const one=async(q:Query,sql:string,params:any[]=[]) =>(await q.query(sql,params)).rows[0];
export class Database{
 pool:pg.Pool;private queue:Promise<unknown>=Promise.resolve();
 constructor(url=process.env.DATABASE_URL,private options:{serialize?:boolean}={}){if(!url)throw new Error('DATABASE_URL required');this.pool=new pg.Pool({connectionString:url,max:12});}
 private guard<T>(fn:()=>Promise<T>):Promise<T>{if(!this.options.serialize)return fn();const next=this.queue.then(fn,fn);this.queue=next.catch(()=>{});return next;}
 system<T>(fn:(q:Query)=>Promise<T>){return this.guard(()=>fn(this.pool));}
 tenant<T>(id:string,fn:(q:Query)=>Promise<T>){return this.guard(async()=>{const c=await this.pool.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE workspace_app');await c.query("SELECT set_config('app.tenant_id',$1,true)",[id]);const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}});}
 async close(){await this.pool.end();}
}
