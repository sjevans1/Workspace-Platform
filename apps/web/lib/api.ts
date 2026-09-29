let csrf='';export function setCsrf(v:string){csrf=v;}
export async function api(path:string,method='GET',data?:any){const r=await fetch(`/api/v1${path}`,{method,credentials:'same-origin',headers:{...(data!==undefined&&!(data instanceof FormData)?{'Content-Type':'application/json'}:{}),...(!['GET','HEAD'].includes(method)?{'X-CSRF-Token':csrf}:{})},...(data!==undefined?{body:data instanceof FormData?data:JSON.stringify(data)}:{})});const value=await r.json();if(!r.ok)throw new Error(value.error||'Request failed');return value;}
export function notify(message:string){window.dispatchEvent(new CustomEvent('workspace-notice',{detail:message}));}
export async function run(fn:()=>Promise<any>){try{await fn();}catch(e){notify((e as Error).message);}}
export function changed(){window.dispatchEvent(new Event('workspace-changed'));}
export const icon=(n:any)=>n.icon||(n.kind==='database'?'▦':n.kind==='space'?'◈':n.kind==='workspace'?'⬡':'▤');
export const date=(v:string)=>new Date(v).toLocaleDateString(undefined,{month:'short',day:'numeric'});
export function go(id:string){window.dispatchEvent(new CustomEvent('workspace-open',{detail:id}));}
