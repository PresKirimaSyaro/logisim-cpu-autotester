import {ConfigError, ExecutionError} from '../errors.js';
import {u32} from '../isa/constants.js';

/**
 * Explicit mapping between MIPS byte addresses and word indices.
 *
 * In black-box mode the data memory is a logical store in the reference model;
 * these indices are **not** physical Logisim RAM addresses and are never used
 * to inspect the DUT. The ROM region still maps to the instruction ROM's word
 * address input for injection.
 *
 * `index = (byteAddress - baseByteAddress) >>> addressShift`
 *
 * Logical DM uses `addressShift=2`: byte address 0x100 maps to word index 64.
 * The mapping is affine and is never inferred from a circuit.
 */
export interface AddressRegion {
  baseByteAddress: number;
  addressBits: number;
  addressShift: number;
  dataBits: number;
  capacityWords: number;
}

export class AddressMap {
  readonly baseByteAddress: number;
  readonly addressBits: number;
  readonly addressShift: number;
  readonly dataBits: number;
  readonly capacityWords: number;
  readonly byteSpan: number;
  readonly alignmentBytes: number;

  constructor(region: AddressRegion, readonly label = 'memory') {
    this.baseByteAddress = region.baseByteAddress >>> 0;
    this.addressBits = region.addressBits;
    this.addressShift = region.addressShift;
    this.dataBits = region.dataBits;
    this.capacityWords = region.capacityWords;
    this.alignmentBytes = 1 << this.addressShift;
    this.byteSpan = this.capacityWords * this.alignmentBytes;
  }

  contains(byteAddress: number): boolean {
    const value = u32(byteAddress);
    return value >= this.baseByteAddress && value < this.baseByteAddress + this.byteSpan;
  }

  /** Translate a MIPS byte address to a component word index. Throws on illegal access. */
  indexOf(byteAddress: number, pc = 0): number {
    const value = u32(byteAddress);
    if (!this.contains(value)) {
      throw new ExecutionError(
        'ADDRESS_OUT_OF_RANGE',
        `${this.label} byte address 0x${value.toString(16)} outside [0x${this.baseByteAddress.toString(
          16,
        )}, 0x${(this.baseByteAddress + this.byteSpan).toString(16)})`,
        pc,
        value,
      );
    }
    if ((value - this.baseByteAddress) % this.alignmentBytes !== 0) {
      throw new ExecutionError(
        'ADDRESS_MISALIGNED',
        `${this.label} byte address 0x${value.toString(16)} is not aligned to ${this.alignmentBytes} bytes`,
        pc,
        value,
      );
    }
    return (value - this.baseByteAddress) >>> this.addressShift;
  }

  /** Inverse mapping for logical-DM labels only. */
  byteAddressOf(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.capacityWords) {
      throw new ConfigError(
        'CONFIG_RANGE',
        `${this.label} index ${index} outside [0, ${this.capacityWords})`,
      );
    }
    return u32(this.baseByteAddress + (index << this.addressShift));
  }

  /** MIPS lw/sw require a 4-byte aligned effective address. */
  assertWordAlignment(byteAddress: number, pc: number): void {
    const value = u32(byteAddress);
    if (value % 4 !== 0) {
      throw new ExecutionError(
        'ADDRESS_MISALIGNED',
        `MIPS word access at 0x${value.toString(16)} is not 4-byte aligned`,
        pc,
        value,
      );
    }
    if (!this.contains(value)) {
      throw new ExecutionError(
        'ADDRESS_OUT_OF_RANGE',
        `MIPS byte address 0x${value.toString(16)} is outside ${this.label} [0x${this.baseByteAddress.toString(
          16,
        )}, 0x${(this.baseByteAddress + this.byteSpan).toString(16)})`,
        pc,
        value,
      );
    }
  }
}
