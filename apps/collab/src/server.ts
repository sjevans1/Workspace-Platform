import {Server,type Document,type Connection} from '@hocuspocus/server';
import * as Y from 'yjs';
import {randomUUID} from 'node:crypto';
import {Database,one} from '../../../packages/database/index.ts';
import {verifyTicket,type Ticket,type Actor} from '../../../packages/auth/index.ts';
import {requireAccess} from '../../../packages/permissions/index.ts';
import {assert,json} from '../../../packages/contracts/index.ts';
import {project} from '../../../packages/editor/server.ts';
import {emit} from '../../../packages/events/index.ts';
type Context={ticket:Ticket;actor:Actor};
export async function createCollab(db:Database,port=1234){
 const lease=await db.pool.connect();
 if(!(await lease.query('SELECT pg_try_advisory_lock(8974434) acquired')).rows[0].acquired){lease.release();throw new Error('Only one collaboration writer is supported');}
 async function authorize(t:Ticket,name:string){
  assert(name===`${t.tenant}/${t.resource}/${t.epoch}`,403,'Room mismatch');
  const a=await db.system(q=>one(q,'SELECT * FROM session_actor($1)',[t.sessionHash])) as Actor;
  assert(a&&a.user_id===t.user&&a.tenant_id===t.tenant&&!a.scopes,403,'Access revoked');
  const level=await db.tenant(t.tenant,async q=>{const n=await requireAccess(q,a,t.resource);const d=await one(q,'SELECT epoch FROM page_documents WHERE resource_id=$1',[t.resource]);assert(d?.epoch===t.epoch,409,'Document restored');return n.effective_permission;});return{actor:a,level};
 }
 async function prune(d:Document){for(const c of d.getConnections()){try{const ctx=c.context as Context;const v=await authorize(ctx.ticket,d.name);c.readOnly=v.level<3;ctx.actor=v.actor;}catch{c.sendStateless(JSON.stringify({type:'reset'}));c.close({code:4403,reason:'Access or document changed'});}}}
 const server=new Server<Context>({port,address:'0.0.0.0',quiet:true,debounce:500,maxDebounce:2000,timeout:15000,
  async onAuthenticate({token,documentName,connectionConfig}){const ticket=verifyTicket(token),v=await authorize(ticket,documentName);connectionConfig.readOnly=v.level<3;return{ticket,actor:v.actor};},
  async onLoadDocument({document,context}){const t=context.ticket;const d=await db.tenant(t.tenant,q=>one(q,'SELECT y_state FROM page_documents WHERE resource_id=$1 AND epoch=$2',[t.resource,t.epoch]));assert(d,409,'Document changed');Y.applyUpdate(document,d.y_state);},
  async beforeHandleMessage({context,documentName,update,connection}){assert(update.byteLength<=1048576,413,'Update too large');const v=await authorize(context.ticket,documentName);connection.readOnly=v.level<3;context.actor=v.actor;},
  async beforeSync({document,connection,type,payload}){await prune(document);if(type!==0&&!connection.readOnly){const copy=new Y.Doc();try{Y.applyUpdate(copy,Y.encodeStateAsUpdate(document));Y.applyUpdate(copy,payload);assert(project(copy).state.length<=8388608,413,'Document too large');}finally{copy.destroy();}}},
  async beforeHandleAwareness({document,context,states}){await prune(document);if(context)for(const state of states.values())if(state)state.user={name:context.actor.name,id:context.actor.user_id,color:'#287661'};},
  async onStoreDocument({document,lastContext,documentName}){
   const [tenant,resource,epoch]=documentName.split('/');const p=project(document),snapshot=Buffer.from(Y.encodeSnapshot(Y.snapshot(document))).toString('base64');
   try{const revision=await db.tenant(tenant,async q=>{const d=await one(q,'SELECT * FROM page_documents WHERE resource_id=$1 FOR UPDATE',[resource]);if(!d||d.epoch!==Number(epoch))return null;if(Buffer.from(d.y_state).equals(p.state))return d.revision;const a=lastContext.actor;await requireAccess(q,a,resource,3);if(!(await one(q,"SELECT 1 FROM page_versions WHERE resource_id=$1 AND created_at>now()-interval '5 minutes' LIMIT 1",[resource])))await q.query('INSERT INTO page_versions(id,tenant_id,resource_id,blocks,y_state,revision,author_id,context) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),tenant,resource,json(d.blocks),d.y_state,d.revision,a.user_id,'autosave']);await q.query('UPDATE page_documents SET blocks=$2,plain_text=$3,y_state=$4,revision=revision+1 WHERE resource_id=$1',[resource,json(p.blocks),p.plain_text,p.state]);await q.query('UPDATE resources SET search_text=$2,updated_at=now(),updated_by=$3 WHERE id=$1',[resource,p.plain_text,a.user_id]);await emit(q,a,'page.updated',resource,d.revision+1);return d.revision+1;});if(revision===null){await prune(document);return;}document.broadcastStateless(JSON.stringify({type:'persisted',snapshot,revision}));}catch(e){document.broadcastStateless(JSON.stringify({type:'persistence-error'}));throw e;}
  },
  async onStateless({connection,payload}){if(payload!=='status')return;const t=(connection.context as Context).ticket;await authorize(t,connection.document.name);const d=await db.tenant(t.tenant,q=>one(q,'SELECT y_state,revision FROM page_documents WHERE resource_id=$1 AND epoch=$2',[t.resource,t.epoch]));if(d){const saved=new Y.Doc();try{Y.applyUpdate(saved,d.y_state);connection.sendStateless(JSON.stringify({type:'persisted',snapshot:Buffer.from(Y.encodeSnapshot(Y.snapshot(saved))).toString('base64'),revision:d.revision}));}finally{saved.destroy();}}}
 });
 await server.listen();let checking=false;const timer=setInterval(async()=>{if(checking)return;checking=true;try{for(const d of server.hocuspocus.documents.values())await prune(d);}catch(e){console.error('Collaboration access check failed',e);}finally{checking=false;}},1000);timer.unref();
 return{server,close:async()=>{clearInterval(timer);await server.destroy();await lease.query('SELECT pg_advisory_unlock(8974434)');lease.release();}};
}
