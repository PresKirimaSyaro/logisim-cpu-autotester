export interface LogicValue {
  width: number;
  value: string;
  unknownMask: string;
  errorMask: string;
  status: 'known' | 'unknown' | 'error';
}
export interface PortInfo { id: string; label: string; direction: 'input'|'output'; width: number; x: number; y: number }
export interface CircuitInfo { circuit: string; logisimVersion: string; ports: PortInfo[] }

/** Component kinds exposed by {@code inspectComponents}. */
export type ComponentKind = 'rom'|'ram'|'register'|'clock'|'subcircuit'|'other';
export interface ComponentInfo {
  path: string;
  name: string;
  circuit: string;
  x: number;
  y: number;
  label: string | null;
  kind: ComponentKind;
  addressBits?: number;
  dataBits?: number;
  capacity?: number;
  width?: number;
  subcircuit?: string;
}
export interface ComponentInventory { circuit: string; components: ComponentInfo[] }

export interface MemoryImage {
  path: string;
  kind: 'rom'|'ram';
  addressBits: number;
  dataBits: number;
  capacity: number;
  start: number;
  count: number;
  words: string[];
}
export interface RegisterValue { path: string; width: number; initialized: boolean; value: string }

export type BridgeOperation =
  | { op:'load'; path:string; circuit:string }
  | { op:'inspect'|'propagate'|'reset' }
  | { op:'setInput'; port:string; value:string; width?:number }
  | { op:'getOutput'; port:string }
  | { op:'tick'; port:string; edge?:'rising'|'falling' }
  | { op:'clockCycle'; halfCycles?:1|2 }
  | { op:'readOutputs'; ports:string[] }
  | { op:'inspectComponents'; recursive?:boolean }
  | { op:'readMemory'; path:string; start?:number; count?:number }
  | { op:'writeMemory'; path:string; start?:number; words:string[] }
  | { op:'loadRom'; path:string; start?:number; words:string[] }
  | { op:'readRegister'; path:string }
  | { op:'writeRegister'; path:string; value:string };
export interface RpcError { code:string; message:string }
export type OperationResult = {ok:true;result:unknown}|{ok:false;error:RpcError};
export interface BatchResult { completed:boolean; results:OperationResult[] }
