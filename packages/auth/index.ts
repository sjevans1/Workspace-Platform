import {createHash,createHmac,randomBytes,scrypt,timingSafeEqual} from 'node:crypto';import type{Database,Query}from'../database/index.ts';import{one}from'../database/index.ts';import{assert,HttpError}from'../contracts/index.ts';
export type Actor={tenant_id:string;user_id:string;role:'owner'|'admin'|'member'|'guest';name:string;email:string;scopes:string[]|null;expires_at:Date;tokenHash?:string;requestId?:string};
export const hash=(v:string)=>createHash('sha256').update(v).digest('hex'),token=()=>randomBytes(32).toString('base64url');export const equal=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const derive=(p:string,salt:string)=>new Promise<Buffer>((res,rej)=>scrypt(p,salt,64,{N:32768,r:8,p:1,maxmem:67108864},(e,k)=>e?rej(e):res(k)));
export async function passwordHash(p:string){assert(p.length>=12&&p.length<=256,400,'Password must contain 12–256 characters');const salt=randomBytes(16).toString('hex');return`scrypt:${salt}:${(await derive(p,salt)).toString('hex')}`;}
export async function verifyPassword(p:string,h?:string){if(!h||p.length>256)return false;const[,s,k]=h.split(':');return equal((await derive(p,s)).toString('hex'),k);}
export async function createSession(q:Query,t:string,u:string,scopes:string[]|null=null,label:string|null=null){const value=token();await q.query('INSERT INTO sessions(token_hash,tenant_id,user_id,scopes,label,expires_at) VALUES($1,$2,$3,$4,$5,now()+$6::interval)',[hash(value),t,u,scopes,label,scopes?'90 days':'12 hours']);return value;}
export async function authenticate(db:Database,t:string):Promise<Actor>{assert(t&&t.length<200,401,'Sign in required');const a=await db.system(q=>one(q,'SELECT * FROM session_actor($1)',[hash(t)]));assert(a,401,'Session expired or access revoked');return{...a,tokenHash:hash(t)};}
export const csrf=(t:string)=>createHmac('sha256',t).update('workspace-csrf-v1').digest('hex');
export function admin(a:Actor){assert(!a.scopes&&['owner','admin'].includes(a.role),403,'Administrator access required');}
export function scope(a:Actor,s:string){assert(!a.scopes||a.scopes.includes(s),403,`Credential requires ${s}`);}
export const scopes=['workspace.read','workspace.write','pages.read','pages.write','databases.read','databases.write','files.read','files.write','users.read','permissions.read','events.read'] as const;
export type Ticket={tenant:string;user:string;resource:string;epoch:number;sessionHash:string;expires:number};
function sign(v:string){assert(/^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_KEY||''),500,'Invalid encryption configuration');return createHmac('sha256',process.env.ENCRYPTION_KEY!).update(`collab:${v}`).digest('base64url');}
export function issueTicket(v:Omit<Ticket,'expires'>){const p=Buffer.from(JSON.stringify({...v,expires:Date.now()+300000})).toString('base64url');return`${p}.${sign(p)}`;}
export function verifyTicket(v:string):Ticket{const[p,s]=v.split('.');assert(p&&s&&equal(sign(p),s),401,'Invalid ticket');const t=JSON.parse(Buffer.from(p,'base64url').toString());assert(t.expires>Date.now(),401,'Expired ticket');return t;}
