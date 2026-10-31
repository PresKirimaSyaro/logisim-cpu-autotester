import {spawnSync} from 'node:child_process';
import {mkdirSync,readdirSync} from 'node:fs';
import {delimiter,join,resolve} from 'node:path';
mkdirSync('java-bridge/build/classes',{recursive:true});
const sourceRoot='java-bridge/src/main/java';
const files=readdirSync(sourceRoot,{recursive:true})
  .filter(f=>f.endsWith('.java'))
  .map(f=>join(sourceRoot,f));
const r=spawnSync(process.env.JAVAC??'javac',['--release','17','-encoding','UTF-8','-cp',['vendor/logisim-generic-2.7.1.jar','vendor/gson-2.11.0.jar'].map(p=>resolve(p)).join(delimiter),'-d','java-bridge/build/classes',...files],{stdio:'inherit'});
if(r.error) console.error(r.error);
process.exit(r.status??1);
