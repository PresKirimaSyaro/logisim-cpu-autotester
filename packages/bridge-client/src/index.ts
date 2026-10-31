import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface, type Interface} from 'node:readline';
import {delimiter,resolve} from 'node:path';
import type {LogicValue,CircuitInfo,ComponentInventory,MemoryImage,RegisterValue,BridgeOperation,BatchResult,RpcError} from '../../protocol/src/index.js';
export type {LogicValue,CircuitInfo,ComponentInfo,ComponentInventory,MemoryImage,RegisterValue,BridgeOperation,BatchResult} from '../../protocol/src/index.js';
export class BridgeError extends Error {
  constructor(public readonly code:string,message:string) { super(message); this.name='BridgeError'; }
}
export interface BridgeOptions {
  /** Repository/build root; defaults to current directory. */
  root?:string; java?:string; timeoutMs?:number; onStderr?:(text:string)=>void;
}
export class LogisimBridge {
  private readonly child:ChildProcessWithoutNullStreams;
  private readonly lines:Interface;
  private readonly pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  private seq=0;
  private ended=false;
  private closing=false;
  private closePromise?:Promise<void>;
  private readonly exited:Promise<void>;
  /** Most recent 64 KiB of stderr, including after an unexpected exit. */
  stderr='';
  constructor(private readonly options:BridgeOptions={}) {
    const root=resolve(options.root??process.cwd());
    const cp=['java-bridge/build/classes','vendor/logisim-generic-2.7.1.jar','vendor/gson-2.11.0.jar'].map(p=>resolve(root,p)).join(delimiter);
    this.child=spawn(options.java??process.env.JAVA??'java',['-Djava.awt.headless=true','-cp',cp,'bridge.Main'],{cwd:root,stdio:'pipe',windowsHide:true});
    this.lines=createInterface({input:this.child.stdout});
    this.lines.on('line',line=>{
      try {
        const r=JSON.parse(line) as {id:string;ok:boolean;result:unknown;error:RpcError};
        if(!r || typeof r.id!=='string' || typeof r.ok!=='boolean' ||
          (!r.ok && (!r.error || typeof r.error.code!=='string' || typeof r.error.message!=='string')))
          throw new Error('Malformed response envelope');
        const p=this.pending.get(r.id); if(!p) return;
        this.pending.delete(r.id); clearTimeout(p.timer);
        if(r.ok) p.resolve(r.result); else p.reject(new BridgeError(r.error.code,r.error.message));
      } catch(e) { this.abort(new BridgeError('PROTOCOL_ERROR',`Invalid response: ${line}`)); }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data',(s:string)=>{this.stderr=(this.stderr+s).slice(-65536); options.onStderr?.(s);});
    this.child.stdin.on('error',e=>this.abort(new BridgeError('PROCESS_IO',e.message)));
    this.child.on('error',e=>this.abort(new BridgeError('PROCESS_START',e.message)));
    this.exited=new Promise(done=>this.child.once('close',(code,signal)=>{
      this.ended=true; this.lines.close();
      this.rejectAll(new BridgeError('PROCESS_EXIT',`Java bridge exited: code=${code}, signal=${signal}; stderr=${this.stderr}`)); done();
    }));
  }
  private rejectAll(e:Error) { for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);} this.pending.clear(); }
  private abort(e:Error) { this.ended=true; this.rejectAll(e); this.child.kill(); }
  private request<T>(op:object,shutdown=false):Promise<T> {
    if(this.ended || (this.closing&&!shutdown)) return Promise.reject(new BridgeError('CLOSED','Bridge is closed'));
    const id=String(++this.seq);
    return new Promise<T>((resolve,reject)=>{
      const timer=setTimeout(()=>{
        // A timed-out mutation may still execute. Terminate to avoid ambiguous later state.
        this.abort(new BridgeError('TIMEOUT',`Request ${id} timed out`));
      },this.options.timeoutMs??10000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({...op,id})+'\n',err=>{if(err)this.abort(new BridgeError('PROCESS_IO',err.message));});
    });
  }
  load(path:string,circuit:string) { return this.request<void>({op:'load',path:resolve(path),circuit}); }
  inspect() { return this.request<CircuitInfo>({op:'inspect'}); }
  setInput(port:string,value:string,width?:number) { return this.request<void>({op:'setInput',port,value,width}); }
  propagate() { return this.request<void>({op:'propagate'}); }
  getOutput(port:string) { return this.request<LogicValue>({op:'getOutput',port}); }
  reset() { return this.request<void>({op:'reset'}); }
  tick(port:string,edge:'rising'|'falling'='rising') { return this.request<void>({op:'tick',port,edge}); }
  clockCycle(halfCycles:1|2=2) { return this.request<void>({op:'clockCycle',halfCycles}); }
  readOutputs(ports:string[]) { return this.request<Record<string,LogicValue>>({op:'readOutputs',ports}); }
  inspectComponents(recursive=true) { return this.request<ComponentInventory>({op:'inspectComponents',recursive}); }
  parseHex(text:string) { return this.request<string[]>({op:'parseHex',text}); }
  readMemory(path:string,start?:number,count?:number) { return this.request<MemoryImage>({op:'readMemory',path,start,count}); }
  writeMemory(path:string,start:number,words:string[]) { return this.request<void>({op:'writeMemory',path,start,words}); }
  loadRom(path:string,start:number,words:string[]) { return this.request<void>({op:'loadRom',path,start,words}); }
  readRegister(path:string) { return this.request<RegisterValue>({op:'readRegister',path}); }
  writeRegister(path:string,value:string) { return this.request<void>({op:'writeRegister',path,value}); }
  batch(operations:BridgeOperation[]) { return this.request<BatchResult>({op:'batch',operations}); }
  /** Force process termination; useful when the caller cancels a run. */
  terminate() { this.abort(new BridgeError('TERMINATED','Bridge terminated')); return this.exited; }
  get processId() { return this.child.pid; }
  close():Promise<void> {
    if(this.closePromise) return this.closePromise;
    this.closing=true;
    this.closePromise=(async()=>{
      try { if(!this.ended) await this.request<void>({op:'shutdown'},true); }
      finally {
        this.child.stdin.end();
        const timer=setTimeout(()=>this.child.kill(),2000);
        await this.exited; clearTimeout(timer); this.lines.close();
      }
    })();
    return this.closePromise;
  }
}
