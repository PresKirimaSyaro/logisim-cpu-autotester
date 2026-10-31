#!/usr/bin/env node
/**
 * Generate fixtures/cpu.circ: a real single-cycle MIPS CPU built only from the
 * original Logisim 2.7.1 built-in components. The CPU is a *fixture*, not a
 * circuit IR: every gate, register, ROM and RAM is a genuine Logisim instance.
 *
 * Wiring uses Tunnel components keyed by signal name. Each generated tunnel is
 * placed exactly on one component port, so the Logisim wire graph connects the
 * two endpoints without long hand-routed wires.
 */
import {writeFileSync, mkdirSync} from 'node:fs';

const components = [];
const tunnelAt = new Map();

function tunnel(x, y, label, width) {
  const key = `${x},${y}`;
  const existing = tunnelAt.get(key);
  if (existing && existing.label !== label) {
    throw new Error(`Tunnel collision at ${key}: ${existing.label} vs ${label}`);
  }
  if (existing) return;
  tunnelAt.set(key, {label, width});
  const attrs = [];
  if (width !== 1) attrs.push(['width', String(width)]);
  attrs.push(['label', label]);
  components.push({lib: 0, name: 'Tunnel', x, y, attrs});
}

let cell = 0;
function cellLocation() {
  const col = cell % 6;
  const row = Math.floor(cell / 6);
  cell++;
  return {x: 200 + col * 1000, y: 200 + row * 1000};
}

function add(lib, name, location, attrs, ports) {
  components.push({lib, name, x: location.x, y: location.y, attrs});
  for (const port of ports) {
    if (!port.label) continue;
    tunnel(location.x + port.dx, location.y + port.dy, port.label, port.width);
  }
}

function splitterPorts(fanout) {
  const ports = [{dx: 0, dy: 0, label: null}];
  for (let i = 0; i < fanout; i++) {
    ports.push({dx: 20, dy: -10 * fanout + 10 * i, label: null});
  }
  return ports;
}

function splitterAttrs(fanout, incoming, assignments) {
  const attrs = [
    ['fanout', String(fanout)],
    ['incoming', String(incoming)],
  ];
  // Logisim's XML reader writes each bit attribute from the factory default,
  // which is not the usual distribution. Emit every bit explicitly.
  for (let bit = 0; bit < incoming; bit++) attrs.push([`bit${bit}`, String(assignments[bit])]);
  return attrs;
}

function fieldAssignments() {
  const assignments = [];
  for (let bit = 0; bit < 32; bit++) {
    if (bit < 6) assignments.push(0);
    else if (bit < 11) assignments.push(1);
    else if (bit < 16) assignments.push(2);
    else if (bit < 21) assignments.push(3);
    else if (bit < 26) assignments.push(4);
    else assignments.push(5);
  }
  return assignments;
}

function indexAssignments() {
  const assignments = [];
  for (let bit = 0; bit < 32; bit++) assignments.push(bit >= 2 && bit <= 9 ? 0 : 1);
  return assignments;
}

function muxPorts(inputs) {
  if (inputs === 2) {
    return [
      {dx: -30, dy: -10, label: null},
      {dx: -30, dy: 10, label: null},
      {dx: -20, dy: 20, label: null},
      {dx: 0, dy: 0, label: null},
    ];
  }
  const ports = [];
  const dy = -(inputs / 2) * 10;
  for (let i = 0; i < inputs; i++) ports.push({dx: -40, dy: dy + 10 * i, label: null});
  ports.push({dx: -20, dy: dy + 10 * inputs, label: null});
  ports.push({dx: 0, dy: 0, label: null});
  return ports;
}

function decoderPorts(outputs) {
  const ports = [];
  for (let i = 0; i < outputs; i++) ports.push({dx: 20, dy: -10 * outputs + 10 * i, label: null});
  ports.push({dx: 0, dy: 0, label: null});
  return ports;
}

function gatePorts(inputs) {
  const ports = [{dx: 0, dy: 0, label: null}];
  // Mirrors AbstractGate.getInputOffset for the default medium gate (size 50).
  const tight = inputs <= 3;
  const skipStart = tight ? -10 : -5;
  const skipDist = tight ? 20 : 10;
  const skipLowerEven = tight ? 20 : 10;
  for (let i = 0; i < inputs; i++) {
    let dy;
    if (inputs % 2 === 1) dy = skipStart * (inputs - 1) + skipDist * i;
    else dy = skipStart * inputs + skipDist * i + (i >= inputs / 2 ? skipLowerEven : 0);
    ports.push({dx: -50, dy, label: null});
  }
  return ports;
}

const PORTS = {
  Pin: [{dx: 0, dy: 0}],
  Buffer: [
    {dx: 0, dy: 0},
    {dx: -20, dy: 0},
  ],
  Constant: [{dx: 0, dy: 0}],
  Ground: [{dx: 0, dy: 0}],
  Adder: [
    {dx: -40, dy: -10},
    {dx: -40, dy: 10},
    {dx: 0, dy: 0},
    {dx: -20, dy: -20},
    {dx: -20, dy: 20},
  ],
  Subtractor: [
    {dx: -40, dy: -10},
    {dx: -40, dy: 10},
    {dx: 0, dy: 0},
    {dx: -20, dy: -20},
    {dx: -20, dy: 20},
  ],
  Shifter: [
    {dx: -40, dy: -10},
    {dx: -40, dy: 10},
    {dx: 0, dy: 0},
  ],
  Comparator: [
    {dx: -40, dy: -10},
    {dx: -40, dy: 10},
    {dx: 0, dy: -10},
    {dx: 0, dy: 0},
    {dx: 0, dy: 10},
  ],
  Multiplexer: [
    {dx: -30, dy: -10},
    {dx: -30, dy: 10},
    {dx: -20, dy: 20},
    {dx: 0, dy: 0},
  ],
  'AND Gate': gatePorts(2),
  'OR Gate': gatePorts(2),
  'NOT Gate': [
    {dx: 0, dy: 0},
    {dx: -30, dy: 0},
  ],
  'Bit Extender': [
    {dx: 0, dy: 0},
    {dx: -40, dy: 0},
  ],
  Register: [
    {dx: 0, dy: 0},
    {dx: -30, dy: 0},
    {dx: -20, dy: 20},
    {dx: -10, dy: 20},
    {dx: -30, dy: 10},
  ],
  ROM: [
    {dx: 0, dy: 0},
    {dx: -140, dy: 0},
    {dx: -90, dy: 40},
  ],
  RAM: [
    {dx: 0, dy: 0},
    {dx: -140, dy: 0},
    {dx: -90, dy: 40},
    {dx: -50, dy: 40},
    {dx: -30, dy: 40},
    {dx: -70, dy: 40},
    {dx: -110, dy: 40},
    {dx: -140, dy: 20},
  ],
};

function instance(lib, name, signals, attrs = [], explicitPorts = PORTS[name]) {
  const loc = cellLocation();
  const ports = explicitPorts.map((port, index) => ({
    ...port,
    label: signals[index] ?? null,
    width: signals.widths?.[index] ?? port.width ?? 1,
  }));
  add(lib, name, loc, attrs, ports);
  return loc;
}

// Width-aware helper for components whose ports have per-port widths.
function wired(lib, name, mapping, attrs = [], explicitPorts = PORTS[name]) {
  const loc = cellLocation();
  const ports = explicitPorts.map((port, index) => {
    const entry = mapping[index];
    return entry ? {dx: port.dx, dy: port.dy, label: entry[0], width: entry[1]} : {...port, label: null};
  });
  add(lib, name, loc, attrs, ports);
  return loc;
}

function constant(label, width, value) {
  const loc = cellLocation();
  add(0, 'Constant', loc, [
    ['width', String(width)],
    ['value', `0x${value.toString(16)}`],
  ], [{dx: 0, dy: 0, label, width}]);
  return loc;
}

function ground(label) {
  const loc = cellLocation();
  add(0, 'Ground', loc, [], [{dx: 0, dy: 0, label, width: 1}]);
  return loc;
}

function inputPin(label, width = 1) {
  const loc = cellLocation();
  const attrs = [];
  if (width !== 1) attrs.push(['width', String(width)]);
  attrs.push(['label', label]);
  add(0, 'Pin', loc, attrs, [{dx: 0, dy: 0, label, width}]);
  return loc;
}

function outputPin(label, width = 1) {
  const loc = cellLocation();
  const attrs = [['output', 'true'], ['facing', 'west']];
  if (width !== 1) attrs.push(['width', String(width)]);
  attrs.push(['label', label]);
  add(0, 'Pin', loc, attrs, [{dx: 0, dy: 0, label, width}]);
  return loc;
}

function outputTap(label, signal, width) {
  outputPin(label, width);
  wired(1, 'Buffer', [[label, width], [signal, width]], [['width', String(width)]], [
    {dx: 0, dy: 0},
    {dx: -20, dy: 0},
  ]);
}

// ---------------------------------------------------------------- pins/consts
inputPin('CLK');
inputPin('RST');
outputPin('PC', 32);
outputPin('INSTR', 32);

// Standard black-box observation interface. These are ordinary output Pins;
// the physical data RAM is not part of the test contract.
outputTap('Instr', 'INSTR', 32);
outputTap('pc', 'PC', 32);
outputTap('RegWrite', 'REGWE', 1);
outputTap('RegAddr', 'WRITEADDR', 5);
outputTap('RegData', 'REGRESULT', 32);
outputTap('MemWrite', 'IS_SW', 1);
outputTap('MemAddr', 'ALUOUT', 32);
outputTap('MemData', 'RTVALUE', 32);

// Debug taps. These are ordinary output Pins; the CPU does not depend on them.
for (const [label, width] of [
  ['PC4', 32],
  ['NEXTPC', 32],
  ['TAKEN', 1],
  ['EQ', 1],
  ['OPCODE', 6],
  ['FUNCT', 6],
  ['RS', 5],
  ['RT', 5],
  ['RD', 5],
  ['SHAMT', 5],
  ['ONE', 1],
  ['GND', 1],
  ['K4', 32],
  ['IS_R', 1],
  ['IS_ORI', 1],
  ['IS_LW', 1],
  ['IS_SW', 1],
  ['IS_BEQ', 1],
  ['IS_ADD_F', 1],
  ['IS_SUB_F', 1],
  ['IS_SLL_F', 1],
  ['IS_ADD', 1],
  ['IS_SUB', 1],
  ['IS_SLL', 1],
  ['ALUOP0', 1],
  ['ALUOP1', 1],
  ['REGWRITE', 1],
  ['REGWE', 1],
  ['WRITEADDR', 5],
  ['WRITEZERO', 1],
  ['RSVALUE', 32],
  ['RTVALUE', 32],
  ['IMM16', 16],
  ['SIGNIMM', 32],
  ['IMMEXT', 32],
  ['ALUA', 32],
  ['ALUB', 32],
  ['OROUT', 32],
  ['ADDSUB', 32],
  ['ALU_HI', 32],
  ['ALUOUT', 32],
  ['REGRESULT', 32],
  ['ALUSRC', 1],
  ['LOADDATA', 32],
]) {
  outputPin(label, width);
}

constant('ONE', 1, 1);
ground('GND');
constant('K4', 32, 4);
constant('K2_5', 5, 2);
constant('K0_5', 5, 0);

constant('K_OP_R', 6, 0x00);
constant('K_OP_ORI', 6, 0x0d);
constant('K_OP_LW', 6, 0x23);
constant('K_OP_SW', 6, 0x2b);
constant('K_OP_BEQ', 6, 0x04);
constant('K_F_ADD', 6, 0x20);
constant('K_F_SUB', 6, 0x22);
constant('K_F_SLL', 6, 0x00);

// ------------------------------------------------------------------ PC / fetch
const pcLoc = wired(2, 'Register', [
  ['PC', 32], // Q
  ['NEXTPC', 32], // D
  ['CLK', 1],
  ['RST', 1],
  ['ONE', 1],
], [['width', '32'], ['label', 'PC_REG']]);
wired(3, 'Adder', [
  ['PC', 32],
  ['K4', 32],
  ['PC4', 32],
  ['GND', 1],
  null,
], [['width', '32']]);
const romLoc = wired(2, 'ROM', [
  ['INSTR', 32],
  ['PCINDEX', 8],
  ['ONE', 1],
], [
  ['addrWidth', '8'],
  ['dataWidth', '32'],
  // Explicit contents header keeps the ROM's MemContents 8x32 even when the
  // file is opened directly in the GUI; without it Logisim's XML reader
  // installs an 8x8 default contents object.
  ['contents', 'addr/data: 8 32'],
]);

// PCINDEX = PC[9:2]
{
  const loc = cellLocation();
  const ports = splitterPorts(2);
  add(0, 'Splitter', loc, splitterAttrs(2, 32, indexAssignments()), [
    {...ports[0], label: 'PC', width: 32},
    {...ports[1], label: 'PCINDEX', width: 8},
    {...ports[2], label: null},
  ]);
}

// Instruction fields: funct, shamt, rd, rt, rs, opcode.
wired(0, 'Splitter', [
  ['INSTR', 32],
  ['FUNCT', 6],
  ['SHAMT', 5],
  ['RD', 5],
  ['RT', 5],
  ['RS', 5],
  ['OPCODE', 6],
], splitterAttrs(6, 32, fieldAssignments()), splitterPorts(6));

// IMM16 = INSTR[15:0]
wired(0, 'Splitter', [
  ['INSTR', 32],
  ['IMM16', 16],
  null,
], splitterAttrs(2, 32, Array.from({length: 32}, (_, bit) => (bit < 16 ? 0 : 1))), splitterPorts(2));

// ------------------------------------------------------------------ regfile
// 32 real Logisim Registers. A write decoder selects one register; two 32:1
// multiplexers provide independent rs/rt read ports. This avoids the
// single-address limitation of a RAM-based register file.
wired(4, 'Multiplexer', [
  ['RT', 5],
  ['RD', 5],
  ['IS_R', 1],
  ['WRITEADDR', 5],
], [['width', '5'], ['select', '1'], ['enable', 'false']]);

// decoder outputs DEC0..DEC31
{
  const signals = [];
  for (let i = 0; i < 32; i++) signals.push([`DEC${i}`, 1]);
  signals.push(['WRITEADDR', 5]);
  wired(4, 'Decoder', signals, [['select', '5'], ['enable', 'false']], decoderPorts(32));
}

// $zero must never be written.
wired(3, 'Comparator', [['WRITEADDR', 5], ['K0_5', 5], null, ['WRITEZERO', 1], null], [
  ['width', '5'],
  ['mode', 'unsigned'],
]);
wired(1, 'NOT Gate', [['WRITENOTZERO', 1], ['WRITEZERO', 1]], [['width', '1']]);
wired(1, 'AND Gate', [['REGWE', 1], ['REGWRITE', 1], ['WRITENOTZERO', 1]], [
  ['width', '1'],
  ['inputs', '2'],
]);

for (let i = 0; i < 32; i++) {
  wired(1, 'AND Gate', [[`EN${i}`, 1], [`DEC${i}`, 1], ['REGWE', 1]], [
    ['width', '1'],
    ['inputs', '2'],
  ]);
  wired(2, 'Register', [
    [`R${i}`, 32],
    ['REGRESULT', 32],
    ['CLK', 1],
    ['RST', 1],
    [`EN${i}`, 1],
  ], [['width', '32']]);
}

{
  const signals = [];
  for (let i = 0; i < 32; i++) signals.push([`R${i}`, 32]);
  signals.push(['RS', 5]);
  signals.push(['RSVALUE', 32]);
  wired(4, 'Multiplexer', signals, [['width', '32'], ['select', '5'], ['enable', 'false']], muxPorts(32));
}
{
  const signals = [];
  for (let i = 0; i < 32; i++) signals.push([`R${i}`, 32]);
  signals.push(['RT', 5]);
  signals.push(['RTVALUE', 32]);
  wired(4, 'Multiplexer', signals, [['width', '32'], ['select', '5'], ['enable', 'false']], muxPorts(32));
}

// --------------------------------------------------------------- control
const opcodeChecks = [
  ['IS_R', 'K_OP_R'],
  ['IS_ORI', 'K_OP_ORI'],
  ['IS_LW', 'K_OP_LW'],
  ['IS_SW', 'K_OP_SW'],
  ['IS_BEQ', 'K_OP_BEQ'],
];
for (const [output, constantLabel] of opcodeChecks) {
  wired(3, 'Comparator', [['OPCODE', 6], [constantLabel, 6], null, [output, 1], null], [
    ['width', '6'],
    ['mode', 'unsigned'],
  ]);
}
const functChecks = [
  ['IS_ADD_F', 'K_F_ADD'],
  ['IS_SUB_F', 'K_F_SUB'],
  ['IS_SLL_F', 'K_F_SLL'],
];
for (const [output, constantLabel] of functChecks) {
  wired(3, 'Comparator', [['FUNCT', 6], [constantLabel, 6], null, [output, 1], null], [
    ['width', '6'],
    ['mode', 'unsigned'],
  ]);
}

wired(1, 'AND Gate', [['IS_ADD', 1], ['IS_R', 1], ['IS_ADD_F', 1]], [['width', '1'], ['inputs', '2']]);
wired(1, 'AND Gate', [['IS_SUB', 1], ['IS_R', 1], ['IS_SUB_F', 1]], [['width', '1'], ['inputs', '2']]);
wired(1, 'AND Gate', [['IS_SLL', 1], ['IS_R', 1], ['IS_SLL_F', 1]], [['width', '1'], ['inputs', '2']]);
wired(1, 'OR Gate', [
  ['REGWRITE', 1],
  ['IS_ADD', 1],
  ['IS_SUB', 1],
  ['IS_SLL', 1],
  ['IS_ORI', 1],
  ['IS_LW', 1],
], [['width', '1'], ['inputs', '5']], gatePorts(5));
wired(1, 'OR Gate', [['ALUOP0', 1], ['IS_SUB', 1], ['IS_SLL', 1]], [['width', '1'], ['inputs', '2']]);
wired(1, 'OR Gate', [['ALUOP1', 1], ['IS_ORI', 1], ['IS_SLL', 1]], [['width', '1'], ['inputs', '2']]);
wired(1, 'OR Gate', [['ALUSRC', 1], ['IS_ORI', 1], ['IS_LW', 1], ['IS_SW', 1]], [
  ['width', '1'],
  ['inputs', '3'],
], gatePorts(3));
wired(3, 'Comparator', [['RSVALUE', 32], ['RTVALUE', 32], null, ['EQ', 1], null], [
  ['width', '32'],
  ['mode', 'unsigned'],
]);
wired(1, 'AND Gate', [['TAKEN', 1], ['IS_BEQ', 1], ['EQ', 1]], [['width', '1'], ['inputs', '2']]);

// --------------------------------------------------------------- immediates
wired(0, 'Bit Extender', [['SIGNIMM', 32], ['IMM16', 16]], [
  ['in_width', '16'],
  ['out_width', '32'],
  ['type', 'sign'],
]);
wired(0, 'Bit Extender', [['ZEROIMM', 32], ['IMM16', 16]], [
  ['in_width', '16'],
  ['out_width', '32'],
  ['type', 'zero'],
]);
wired(4, 'Multiplexer', [
  ['SIGNIMM', 32],
  ['ZEROIMM', 32],
  ['IS_ORI', 1],
  ['IMMEXT', 32],
], [['width', '32'], ['select', '1'], ['enable', 'false']]);

// --------------------------------------------------------------- ALU
wired(4, 'Multiplexer', [
  ['RSVALUE', 32],
  ['RTVALUE', 32],
  ['IS_SLL', 1],
  ['ALUA', 32],
], [['width', '32'], ['select', '1'], ['enable', 'false']]);
wired(4, 'Multiplexer', [
  ['RTVALUE', 32],
  ['IMMEXT', 32],
  ['ALUSRC', 1],
  ['ALUB', 32],
], [['width', '32'], ['select', '1'], ['enable', 'false']]);
wired(3, 'Adder', [['ALUA', 32], ['ALUB', 32], ['ADDSUM', 32], ['GND', 1], null], [['width', '32']]);
wired(3, 'Subtractor', [['ALUA', 32], ['ALUB', 32], ['SUBSUM', 32], ['GND', 1], null], [['width', '32']]);
wired(1, 'OR Gate', [['OROUT', 32], ['ALUA', 32], ['ALUB', 32]], [['width', '32'], ['inputs', '2']]);
const sllLoc = wired(3, 'Shifter', [['ALUA', 32], ['SHAMT', 5], ['SLLOUT', 32]], [['width', '32'], ['shift', 'll']]);
wired(4, 'Multiplexer', [
  ['ADDSUM', 32],
  ['SUBSUM', 32],
  ['ALUOP0', 1],
  ['ADDSUB', 32],
], [['width', '32'], ['select', '1'], ['enable', 'false']]);
wired(4, 'Multiplexer', [
  ['OROUT', 32],
  ['SLLOUT', 32],
  ['ALUOP0', 1],
  ['ALU_HI', 32],
], [['width', '32'], ['select', '1'], ['enable', 'false']]);
wired(4, 'Multiplexer', [
  ['ADDSUB', 32],
  ['ALU_HI', 32],
  ['ALUOP1', 1],
  ['ALUOUT', 32],
], [['width', '32'], ['select', '1'], ['enable', 'false']]);

// --------------------------------------------------------------- data RAM
const dataRamLoc = wired(2, 'RAM', [
  ['LOADDATA', 32], // DATA
  ['RAMADDR', 8], // ADDR
  ['ONE', 1], // CS
  ['IS_LW', 1], // OE
  ['RST', 1], // CLR
  ['CLK', 1], // CLK
  ['IS_SW', 1], // WE
  ['RTVALUE', 32], // DIN
], [['addrWidth', '8'], ['dataWidth', '32'], ['bus', 'separate'], ['label', 'DATA_RAM']]);

// RAMADDR = ALUOUT[9:2]
{
  const loc = cellLocation();
  const ports = splitterPorts(2);
  add(0, 'Splitter', loc, splitterAttrs(2, 32, indexAssignments()), [
    {...ports[0], label: 'ALUOUT', width: 32},
    {...ports[1], label: 'RAMADDR', width: 8},
    {...ports[2], label: null},
  ]);
}

// writeback and next-PC muxes
wired(4, 'Multiplexer', [
  ['ALUOUT', 32],
  ['LOADDATA', 32],
  ['IS_LW', 1],
  ['REGRESULT', 32],
], [['width', '32'], ['select', '1'], ['enable', 'false']]);

wired(3, 'Shifter', [['SIGNIMM', 32], ['K2_5', 5], ['SHIFTEDOFFSET', 32]], [
  ['width', '32'],
  ['shift', 'll'],
]);
wired(3, 'Adder', [['PC4', 32], ['SHIFTEDOFFSET', 32], ['BRANCHTARGET', 32], ['GND', 1], null], [
  ['width', '32'],
]);
wired(4, 'Multiplexer', [
  ['PC4', 32],
  ['BRANCHTARGET', 32],
  ['TAKEN', 1],
  ['NEXTPC', 32],
], [['width', '32'], ['select', '1'], ['enable', 'false']]);

// ------------------------------------------------------------------ emit XML
const libs = [
  ['0', '#Wiring'],
  ['1', '#Gates'],
  ['2', '#Memory'],
  ['3', '#Arithmetic'],
  ['4', '#Plexers'],
];
const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
function emitCircuit(list, path) {
  const lines = [];
  lines.push('<project source="2.7.1" version="1.0">');
  lines.push(` ${libs.map(([name, desc]) => `<lib desc="${desc}" name="${name}"/>`).join('')}`);
  lines.push(' <main name="SingleCycleCPU"/>');
  lines.push(' <circuit name="SingleCycleCPU">');
  for (const component of list) {
    const attrs = component.attrs
      .map(([name, value]) => `<a name="${escape(name)}" val="${escape(value)}"/>`)
      .join('');
    lines.push(`  <comp lib="${component.lib}" loc="(${component.x},${component.y})" name="${escape(component.name)}">${attrs}</comp>`);
  }
  lines.push(' </circuit>');
  lines.push('</project>');
  lines.push('');
  writeFileSync(path, lines.join('\n'));
}
mkdirSync('fixtures', {recursive: true});
emitCircuit(components, 'fixtures/cpu.circ');

// Controlled faulty variant: the sll shifter always receives a shift amount of
// zero. This is a separate fixture; the good CPU file is never modified.
{
  const faulty = structuredClone(components);
  const tunnel = faulty.find(
    (component) =>
      component.name === 'Tunnel' &&
      component.x === sllLoc.x - 40 &&
      component.y === sllLoc.y + 10,
  );
  if (!tunnel) throw new Error('Could not locate the sll shifter input tunnel');
  tunnel.attrs = tunnel.attrs.map(([name, value]) => (name === 'label' ? ['label', 'K0_5'] : [name, value]));
  emitCircuit(faulty, 'fixtures/cpu-faulty.circ');
}

// Controlled dead variant: the PC is never enabled, so no new instruction is
// fetched. A CPU that does nothing must not produce a passing differential run.
{
  const dead = structuredClone(components);
  const tunnel = dead.find(
    (component) =>
      component.name === 'Tunnel' &&
      component.x === pcLoc.x - 30 &&
      component.y === pcLoc.y + 10,
  );
  if (!tunnel) throw new Error('Could not locate the PC enable tunnel');
  tunnel.attrs = tunnel.attrs.map(([name, value]) => (name === 'label' ? ['label', 'GND'] : [name, value]));
  emitCircuit(dead, 'fixtures/cpu-dead.circ');
}

const componentPath = (name, loc) => `SingleCycleCPU/${name}@${loc.x},${loc.y}`;
const config = {
  schemaVersion: 1,
  name: 'generated-single-cycle-mips',
  circuitName: 'SingleCycleCPU',
  clock: {pin: 'CLK', edge: 'rising'},
  reset: {strategy: 'pin', pin: 'RST', activeLow: false, ticks: 1},
  pc: {
    mode: 'pin',
    port: 'pc',
    initial: 0,
    checkEachCycle: true,
  },
  rom: {
    path: componentPath('ROM', romLoc),
    baseByteAddress: 0,
    addressBits: 8,
    addressShift: 2,
    dataBits: 32,
    capacityWords: 256,
  },
  ram: {
    baseByteAddress: 0,
    capacityWords: 256,
  },
  limits: {maxSteps: 200000, maxCycles: 200000},
  inputs: [],
  instructions: ['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'sll', 'nop'],
  outputs: {
    instruction: 'Instr',
    pc: 'pc',
    regWrite: 'RegWrite',
    regAddr: 'RegAddr',
    regData: 'RegData',
    memWrite: 'MemWrite',
    memAddr: 'MemAddr',
    memData: 'MemData',
  },
  notes:
    'Generated single-cycle MIPS fixture. The CPU is tested through top-level outputs; its physical data RAM is implementation detail.',
};
writeFileSync('fixtures/cpu.config.json', `${JSON.stringify(config, null, 2)}\n`);
console.log(
  `wrote fixtures/cpu.circ (${components.length} components, ${tunnelAt.size} tunnel endpoints) and fixtures/cpu.config.json`,
);
