import {spawnSync} from 'node:child_process';
import {delimiter} from 'node:path';
const r=spawnSync(process.env.JAVA??'java',['-Djava.awt.headless=true','-cp',['java-bridge/build/classes','vendor/logisim-generic-2.7.1.jar'].join(delimiter),'bridge.Poc'],{stdio:'inherit'});
if(r.error) console.error(r.error);
process.exit(r.status??1);
