import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {delimiter,resolve} from 'node:path';
import {writeFile,mkdir} from 'node:fs/promises';
import {LogisimBridge,BridgeError} from '../packages/bridge-client/src/index.js';

async function error(p:Promise<unknown>,code:string) {
  await assert.rejects(p,(e:unknown)=>e instanceof BridgeError && e.code===code,`expected RPC error ${code}`);
}
async function output(b:LogisimBridge,port:string,hex:string,context:unknown) {
  const actual=await b.getOutput(port);
  assert.equal(actual.status,'known',JSON.stringify({context,expected:hex,actual}));
  assert.equal(actual.value,hex,JSON.stringify({context,expected:hex,actual}));
}
test('real original Logisim adder + hierarchy, inspect, sequential cases and batch',async()=>{
  const b=new LogisimBridge();
  try {
    for(const [file,circuit] of [['adder','CombinationalAdder'],['hierarchy','HierarchicalCircuit']]) {
      await b.load(`fixtures/${file}.circ`,circuit);
      const info=await b.inspect();
      assert.equal(info.logisimVersion,'2.7.1'); assert.equal(info.ports.length,3);
      assert.deepEqual(info.ports.map(p=>[p.label,p.direction,p.width]).sort(),[['A','input',8],['B','input',8],['S','output',8]]);
      const aid=info.ports.find(p=>p.label==='A')!.id;
      assert.equal(aid,`${circuit}/pin@${info.ports.find(p=>p.label==='A')!.x},${info.ports.find(p=>p.label==='A')!.y}`);
      for(const [a,v,expected] of [[1,2,'0x03'],[255,1,'0x00'],[127,128,'0xFF']] as const) {
        await b.setInput(aid,'0x'+a.toString(16),8); await b.setInput('B','0x'+v.toString(16),8);
        await b.propagate(); await output(b,'S',expected,{circuit,a,b:v});
      }
      const batch=await b.batch([{op:'setInput',port:'A',value:'0x12'},{op:'setInput',port:'B',value:'0x23'},{op:'propagate'},{op:'getOutput',port:'S'}]);
      assert.equal(batch.completed,true); assert.equal(batch.results.length,4);
      await output(b,'S','0x35','batch');
      const concurrent=await Promise.all(Array.from({length:20},()=>b.getOutput('S')));
      assert.ok(concurrent.every(v=>v.value==='0x35'));
    }
  } finally { await b.close(); }
});
test('register: specified edges, enable hold, multiple writes, reset',async()=>{
 const b=new LogisimBridge();
 try {
  await b.load('fixtures/register.circ','Register'); await output(b,'Q','0x00','initial');
  await b.setInput('CLR','0x0'); await b.setInput('WE','0x1');
  await b.setInput('D','0x42'); await b.propagate(); await output(b,'Q','0x00','no edge');
  await b.tick('CLK'); await output(b,'Q','0x42','rising');
  await b.setInput('D','0x55'); await b.tick('CLK','falling'); await output(b,'Q','0x42','falling does not write');
  await b.setInput('WE','0x0'); await b.tick('CLK'); await output(b,'Q','0x42','disabled');
  await b.setInput('WE','0x1');
  for(const hex of ['0x55','0xAA','0xFF']) { await b.setInput('D',hex); await b.tick('CLK'); await output(b,'Q',hex,{D:hex}); }
  await b.reset(); await output(b,'Q','0x00','reset');
  for(let i=0;i<20;i++) await b.reset();
  await output(b,'Q','0x00','repeated reset');
 } finally { await b.close(); }
});
test('RPC failures preserve process and previous circuit; batch stops on error',async()=>{
 const b=new LogisimBridge();
 try {
  await error(b.inspect(),'NOT_LOADED');
  await error(b.load('fixtures/missing.circ','x'),'INVALID_FILE');
  await error(b.load('fixtures/adder.circ','missing'),'CIRCUIT_NOT_FOUND');
  await b.load('fixtures/adder.circ','CombinationalAdder');
  await error(b.setInput('missing','0x1'),'PORT_NOT_FOUND');
  await error(b.setInput('A','0x100'),'WIDTH_MISMATCH');
  await error(b.setInput('A','0x1',7),'WIDTH_MISMATCH');
  await error(b.setInput('A','-1'),'INVALID_VALUE');
  await error(b.setInput('S','0x1'),'WRONG_DIRECTION');
  await error(b.getOutput('A'),'WRONG_DIRECTION');
  await error(b.tick('A'),'INVALID_CLOCK');
  const result=await b.batch([{op:'setInput',port:'missing',value:'0x1'},{op:'reset'}]);
  assert.equal(result.completed,false); assert.equal(result.results.length,1);
  await mkdir('test-results',{recursive:true});
  await writeFile('test-results/malformed.circ','<project><broken>');
  await error(b.load('test-results/malformed.circ','x'),'INVALID_FILE');
  await writeFile('test-results/library.circ','<project><lib name="0" desc="file#missing.circ"/></project>');
  await error(b.load('test-results/library.circ','x'),'UNSUPPORTED_LIBRARY');
  assert.equal((await b.inspect()).circuit,'CombinationalAdder');
 } finally { await b.close(); await b.close(); }
 await error(b.inspect(),'CLOSED');
});
test('unknown and error bits remain distinguishable from numeric zero',async()=>{
 const b=new LogisimBridge();
 try {
  await b.load('fixtures/logic-values.circ','LogicValues');
  const u=await b.getOutput('U'),e=await b.getOutput('E');
  assert.deepEqual(u,{width:8,value:'0x00',unknownMask:'0xFF',errorMask:'0x00',status:'unknown'});
  assert.deepEqual(e,{width:8,value:'0x00',unknownMask:'0x00',errorMask:'0xFF',status:'error'});
 } finally { await b.close(); }
});
test('32-bit unsigned values and ambiguous labels use stable coordinate IDs',async()=>{
 const b=new LogisimBridge();
 try {
  await mkdir('test-results',{recursive:true});
  await writeFile('test-results/ports.circ',`<project source="2.7.1" version="1.0">
   <lib desc="#Wiring" name="0"/><main name="Ports"/>
   <circuit name="Ports">
    <comp lib="0" name="Pin" loc="(100,100)"><a name="label" val="dup"/><a name="width" val="32"/></comp>
    <comp lib="0" name="Pin" loc="(100,200)"><a name="label" val="dup"/><a name="width" val="32"/></comp>
    <comp lib="0" name="Pin" loc="(200,100)"><a name="label" val="Y"/><a name="width" val="32"/><a name="output" val="true"/></comp>
    <wire from="(100,100)" to="(200,100)"/>
   </circuit></project>`);
  await b.load('test-results/ports.circ','Ports');
  await error(b.setInput('dup','0x1'),'AMBIGUOUS_PORT');
  await b.setInput('Ports/pin@100,100','0xFFFFFFFF',32); await b.propagate();
  await output(b,'Y','0xFFFFFFFF','32-bit unsigned boundary');
  await error(b.setInput('Ports/pin@100,100','0x100000000'),'WIDTH_MISMATCH');
  const before=await b.inspect(); await b.reset(); assert.deepEqual(await b.inspect(),before);
 } finally { await b.close(); }
});
test('oscillation is reported and reset recovers',async()=>{
 const b=new LogisimBridge();
 try {
  await b.load('fixtures/oscillator.circ','Oscillator');
  await b.setInput('EN','0x1'); await error(b.propagate(),'OSCILLATION');
  await b.reset(); await output(b,'Q','0x1','oscillator reset');
 } finally { await b.close(); }
});
test('unexpected exit, startup error, timeout and independent restart',async()=>{
 const b=new LogisimBridge();
 await b.load('fixtures/adder.circ','CombinationalAdder');
 const pending=b.batch(Array.from({length:5000},()=>({op:'inspect' as const})));
 const rejection=assert.rejects(pending,(e:unknown)=>e instanceof BridgeError && e.code==='PROCESS_EXIT');
 process.kill(b.processId!); await rejection; await b.close();
 const restarted=new LogisimBridge();
 try {await restarted.load('fixtures/adder.circ','CombinationalAdder');assert.equal((await restarted.inspect()).ports.length,3);} finally {await restarted.close();}
 const bad=new LogisimBridge({java:resolve('does-not-exist-java')});
 await error(bad.inspect(),'PROCESS_START'); await bad.close();
 const slow=new LogisimBridge({timeoutMs:1});
 await error(slow.load('fixtures/adder.circ','CombinationalAdder'),'TIMEOUT'); await slow.close();
});
test('raw JSON Lines: malformed request, duplicate ID, invalid edge, shutdown',async()=>{
 const child=spawn('java',['-cp',['java-bridge/build/classes','vendor/logisim-generic-2.7.1.jar','vendor/gson-2.11.0.jar'].join(delimiter),'bridge.Main']);
 let stderr=''; child.stderr.on('data',s=>stderr+=s);
 const replies:any[]=[]; const lines=createInterface({input:child.stdout}); lines.on('line',s=>replies.push(JSON.parse(s)));
 const exited=new Promise<void>((done,reject)=>{child.on('error',reject);child.on('close',code=>code===0?done():reject(new Error(stderr)));});
 child.stdin.end(['{broken',JSON.stringify({id:'1',op:'inspect'}),JSON.stringify({id:'1',op:'inspect'}),JSON.stringify({id:'2',op:'unknown'}),JSON.stringify({id:'3',op:'load',path:resolve('fixtures/register.circ'),circuit:'Register'}),JSON.stringify({id:'4',op:'tick',port:'CLK',edge:'both'}),JSON.stringify({id:'5',op:'shutdown'})].join('\n')+'\n');
 await exited;
 assert.deepEqual(replies.map(r=>r.ok?'OK':r.error.code),['INVALID_JSON','NOT_LOADED','DUPLICATE_ID','UNKNOWN_OPERATION','OK','INVALID_CLOCK','OK']);
});
