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

function indexAssignments(highBit) {
  const assignments = [];
  for (let bit = 0; bit < 32; bit++) assignments.push(bit >= 2 && bit <= highBit ? 0 : 1);
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
  Buffer: [
    {dx: 0, dy: 0},
    {dx: -20, dy: 0},
  ],
  Clock: [{dx: 0, dy: 0}],
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

// ---------------------------------------------------------------- pins/consts
// Course profile: exactly one external input (reset) and an internal Clock.
inputPin('reset');
{
  const loc = cellLocation();
  add(0, 'Clock', loc, [['highDuration', '1'], ['lowDuration', '1']], [
    {dx: 0, dy: 0, label: 'CLK', width: 1},
  ]);
}
outputPin('Instr', 32);
outputPin('pc', 32);
outputPin('RegWrite', 1);
outputPin('RegAddr', 5);
outputPin('RegData', 32);
outputPin('MemWrite', 1);
outputPin('MemAddr', 32);
outputPin('MemData', 32);

constant('ONE', 1, 1);
ground('GND');
constant('K4', 32, 4);
constant('K3000', 32, 0x3000);
constant('K2_5', 5, 2);
constant('K16_5', 5, 16);
constant('K0_5', 5, 0);
constant('K_HIGH32', 32, 0xf0000000);

// Delay the PC/register-file clock slightly so the data RAM sees the stable
// pre-edge write event before PC changes the instruction/control signals.
wired(1, 'NOT Gate', [['CLK1', 1], ['CLK', 1]], [['width', '1']]);
wired(1, 'NOT Gate', [['CLKCPU', 1], ['CLK1', 1]], [['width', '1']]);

constant('K_OP_R', 6, 0x00);
constant('K_OP_J', 6, 0x02);
constant('K_OP_LUI', 6, 0x0f);
constant('K_OP_ORI', 6, 0x0d);
constant('K_OP_LW', 6, 0x23);
constant('K_OP_SW', 6, 0x2b);
constant('K_OP_BEQ', 6, 0x04);
constant('K_F_ADD', 6, 0x20);
constant('K_F_SUB', 6, 0x22);
constant('K_F_SLL', 6, 0x00);

// ------------------------------------------------------------------ PC / fetch
// On reset, a clock pulse loads 0x3000 through the PC input mux. The register
// itself has no async clear; RAM/registers use reset as async clear.
wired(4, 'Multiplexer', [
  ['NEXTPC', 32],
  ['K3000', 32],
  ['reset', 1],
  ['PCD', 32],
], [['width', '32'], ['select', '1'], ['enable', 'false']]);
const pcLoc = wired(2, 'Register', [
  ['PC', 32], // Q
  ['PCD', 32], // D
  ['CLKCPU', 1],
  ['GND', 1],
  ['ONE', 1],
], [['width', '32'], ['label', 'PC_REG']]);
wired(3, 'Adder', [
  ['PC', 32],
  ['K4', 32],
  ['PC4', 32],
  ['GND', 1],
  null,
], [['width', '32']]);
wired(3, 'Subtractor', [
  ['PC', 32],
  ['K3000', 32],
  ['PCOFFSET', 32],
  ['GND', 1],
  null,
], [['width', '32']]);
const romLoc = wired(2, 'ROM', [
  ['INSTR', 32],
  ['PCINDEX', 12],
  ['ONE', 1],
], [
  ['addrWidth', '12'],
  ['dataWidth', '32'],
  ['contents', 'addr/data: 12 32'],
]);

// PCINDEX = PC[13:2], 4096 words covering 0x3000..0x6FFF.
{
  const loc = cellLocation();
  const ports = splitterPorts(2);
  add(0, 'Splitter', loc, splitterAttrs(2, 32, indexAssignments(13)), [
    {...ports[0], label: 'PCOFFSET', width: 32},
    {...ports[1], label: 'PCINDEX', width: 12},
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

// J target index = INSTR[25:0]. It is zero-extended and shifted left by 2.
{
  const ports = splitterPorts(2);
  wired(0, 'Splitter', [
    ['INSTR', 32],
    ['JINDEX', 26],
    null,
  ], splitterAttrs(2, 32, Array.from({length: 32}, (_, bit) => (bit < 26 ? 0 : 1))), ports);
}
wired(0, 'Bit Extender', [['JINDEX32', 32], ['JINDEX', 26]], [
  ['in_width', '26'],
  ['out_width', '32'],
  ['type', 'zero'],
]);
wired(3, 'Shifter', [['JINDEX32', 32], ['K2_5', 5], ['JSHIFTED', 32]], [
  ['width', '32'],
  ['shift', 'll'],
]);

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
    ['CLKCPU', 1],
    ['reset', 1],
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
  ['IS_J', 'K_OP_J'],
  ['IS_LUI', 'K_OP_LUI'],
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
  ['IS_LUI', 1],
], [['width', '1'], ['inputs', '6']], gatePorts(6));
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

// LUI writes imm16 << 16, with imm16 treated as an unsigned bit pattern.
wired(3, 'Shifter', [['ZEROIMM', 32], ['K16_5', 5], ['LUI_VALUE', 32]], [
  ['width', '32'],
  ['shift', 'll'],
]);

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
  ['RAMADDR', 12], // ADDR
  ['ONE', 1], // CS
  ['IS_LW', 1], // OE
  ['reset', 1], // CLR
  ['CLK', 1], // CLK
  ['IS_SW', 1], // WE
  ['RTVALUE', 32], // DIN
], [['addrWidth', '12'], ['dataWidth', '32'], ['bus', 'separate'], ['label', 'DATA_RAM']]);

// RAMADDR = ALUOUT[11:2]; logical RAM is 3072 words (0x0000..0x2FFF).
{
  const loc = cellLocation();
  const ports = splitterPorts(2);
  add(0, 'Splitter', loc, splitterAttrs(2, 32, indexAssignments(13)), [
    {...ports[0], label: 'ALUOUT', width: 32},
    {...ports[1], label: 'RAMADDR', width: 12},
    {...ports[2], label: null},
  ]);
}

// writeback and next-PC muxes
wired(4, 'Multiplexer', [
  ['ALUOUT', 32],
  ['LOADDATA', 32],
  ['IS_LW', 1],
  ['REGRESULT_BASE', 32],
], [['width', '32'], ['select', '1'], ['enable', 'false']]);
wired(4, 'Multiplexer', [
  ['REGRESULT_BASE', 32],
  ['LUI_VALUE', 32],
  ['IS_LUI', 1],
  ['REGRESULT', 32],
], [['width', '32'], ['select', '1'], ['enable', 'false']]);

wired(3, 'Shifter', [['SIGNIMM', 32], ['K2_5', 5], ['SHIFTEDOFFSET', 32]], [
  ['width', '32'],
  ['shift', 'll'],
]);
wired(3, 'Adder', [['PC4', 32], ['SHIFTEDOFFSET', 32], ['BRANCHTARGET', 32], ['GND', 1], null], [
  ['width', '32'],
]);
wired(1, 'AND Gate', [['PC_HIGH', 32], ['PC4', 32], ['K_HIGH32', 32]], [
  ['width', '32'],
  ['inputs', '2'],
]);
wired(1, 'OR Gate', [['JTARGET', 32], ['PC_HIGH', 32], ['JSHIFTED', 32]], [
  ['width', '32'],
  ['inputs', '2'],
]);
const pcBranchLoc = wired(4, 'Multiplexer', [
  ['PC4', 32],
  ['BRANCHTARGET', 32],
  ['TAKEN', 1],
  ['PCBRANCH', 32],
], [['width', '32'], ['select', '1'], ['enable', 'false']]);
wired(4, 'Multiplexer', [
  ['PCBRANCH', 32],
  ['JTARGET', 32],
  ['IS_J', 1],
  ['NEXTPC', 32],
], [['width', '32'], ['select', '1'], ['enable', 'false']]);

// --------------------------------------------------- course observation outputs
function outputBuffer(inputLabel, outputLabel, width) {
  wired(1, 'Buffer', [[outputLabel, width], [inputLabel, width]], [
    ['width', String(width)],
  ], PORTS.Buffer);
}
outputBuffer('INSTR', 'Instr', 32);
outputBuffer('PC', 'pc', 32);
outputBuffer('REGWE', 'RegWrite', 1);
outputBuffer('WRITEADDR', 'RegAddr', 5);
outputBuffer('REGRESULT', 'RegData', 32);
outputBuffer('IS_SW', 'MemWrite', 1);
outputBuffer('ALUOUT', 'MemAddr', 32);
outputBuffer('RTVALUE', 'MemData', 32);

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
  lines.push(' <main name="main"/>');
  lines.push(' <circuit name="main">');
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
emitCircuit(components, 'fixtures/course-cpu.circ');

// Controlled fault for the NextPC regression: sw selects the branch target.
if (process.env.COURSE_CPU_FAULT === 'sw-nextpc') {
  const faulty = structuredClone(components);
  // Add SWBRANCH = TAKEN || IS_SW and retarget the PC branch select tunnel.
  const cellCol = 40;
  const cellRow = 60;
  faulty.push({
    lib: 1,
    name: 'OR Gate',
    x: 200 + cellCol * 1000,
    y: 200 + cellRow * 1000,
    attrs: [['width', '1'], ['inputs', '2']],
  });
  for (const [dx, dy, label] of [[0, 0, 'SWBRANCH'], [-50, -20, 'TAKEN'], [-50, 20, 'IS_SW']]) {
    faulty.push({
      lib: 0,
      name: 'Tunnel',
      x: 200 + cellCol * 1000 + dx,
      y: 200 + cellRow * 1000 + dy,
      attrs: [['label', label]],
    });
  }
  const selectTunnel = faulty.find(
    (component) =>
      component.name === 'Tunnel' &&
      component.x === pcBranchLoc.x - 20 &&
      component.y === pcBranchLoc.y + 20,
  );
  if (!selectTunnel) throw new Error('Could not locate PC branch select tunnel for fault fixture');
  selectTunnel.attrs = selectTunnel.attrs.map(([name, value]) =>
    name === 'label' ? ['label', 'SWBRANCH'] : [name, value],
  );
  emitCircuit(faulty, 'fixtures/course-cpu-fault-sw-nextpc.circ');
}

// Controlled fault for GUI failure-detail validation: sll always shifts by 0.
{
  const faulty = structuredClone(components);
  const tunnel = faulty.find(
    (component) =>
      component.name === 'Tunnel' &&
      component.x === sllLoc.x - 40 &&
      component.y === sllLoc.y + 10,
  );
  if (!tunnel) throw new Error('Could not locate the course sll shifter input tunnel');
  tunnel.attrs = tunnel.attrs.map(([name, value]) => (name === 'label' ? ['label', 'K0_5'] : [name, value]));
  emitCircuit(faulty, 'fixtures/course-faulty.circ');
}

// Multi-RAM acceptance fixture: the circuit contains extra unused physical RAM
// components. The black-box runner must not inspect, count or read them.
{
  const multi = structuredClone(components);
  for (let i = 0; i < 3; i++) {
    multi.push({
      lib: 2,
      name: 'RAM',
      x: 30000 + i * 1000,
      y: 30000,
      attrs: [
        ['addrWidth', '12'],
        ['dataWidth', '32'],
        ['bus', 'separate'],
        ['label', `UNUSED_RAM_${i}`],
      ],
    });
  }
  emitCircuit(multi, 'fixtures/course-multi-ram.circ');
}

const componentPath = (name, loc) => `main/${name}@${loc.x},${loc.y}`;
const config = {
  schemaVersion: 1,
  name: 'course-single-cycle-mips',
  circuitName: 'main',
  clock: {mode: 'internal', halfCycles: 2},
  reset: {strategy: 'pin', pin: 'reset', activeLow: false, ticks: 1},
  pc: {
    mode: 'pin',
    port: 'pc',
    initial: 0x3000,
    checkEachCycle: true,
  },
  rom: {
    path: componentPath('ROM', romLoc),
    baseByteAddress: 0x3000,
    addressBits: 12,
    addressShift: 2,
    dataBits: 32,
    capacityWords: 4096,
  },
  ram: {
    baseByteAddress: 0,
    capacityWords: 3072,
  },
  limits: {maxSteps: 200000, maxCycles: 200000},
  inputs: [],
  instructions: ['add', 'sub', 'ori', 'lw', 'sw', 'beq', 'lui', 'nop'],
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
    'Generated course-profile CPU fixture. Internal Logisim Clock, ROM at 0x3000, 3072-word logical data memory, standard observation outputs. Physical RAM is not part of the test contract.',
};
writeFileSync('fixtures/course.config.json', `${JSON.stringify(config, null, 2)}\n`);
console.log(
  `wrote fixtures/course-cpu.circ (${components.length} components, ${tunnelAt.size} tunnel endpoints) and fixtures/course.config.json`,
);
