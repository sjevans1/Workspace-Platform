import {Database} from '../../../packages/database/index.ts';import {createCollab} from './server.ts';
const db=new Database(),collab=await createCollab(db,Number(process.env.COLLAB_PORT||1234));for(const sig of ['SIGTERM','SIGINT'])process.on(sig,async()=>{await collab.close();await db.close();process.exit(0);});
