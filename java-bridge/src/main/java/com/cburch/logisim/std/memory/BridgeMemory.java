package com.cburch.logisim.std.memory;

import com.cburch.logisim.circuit.CircuitState;
import com.cburch.logisim.instance.Instance;
import com.cburch.logisim.instance.StdAttr;

/**
 * Small, read/write adapter for the original Logisim memory and register
 * components.
 *
 * <p>This class is compiled into the original component package on purpose.
 * Logisim 2.7.1 keeps {@code Mem}, {@code MemState}, {@code MemContents} and
 * {@code RegisterData} package-private. Living in that package lets the bridge
 * use their public/package methods directly, without modifying the JAR, using
 * reflection, or re-implementing memory behaviour. The original JAR remains
 * byte-for-byte untouched.</p>
 */
public final class BridgeMemory {
    private BridgeMemory() { }

    public static boolean isMemory(Instance instance) {
        return instance.getFactory() instanceof Mem;
    }

    public static boolean isRom(Instance instance) {
        return instance.getFactory() instanceof Rom;
    }

    public static boolean isRam(Instance instance) {
        return instance.getFactory() instanceof Ram;
    }

    public static boolean isRegister(Instance instance) {
        return instance.getFactory() instanceof Register;
    }

    public static int addressBits(Instance instance) {
        if (!(instance.getFactory() instanceof Mem)) return 0;
        return instance.getAttributeValue(Mem.ADDR_ATTR).getWidth();
    }

    public static int dataBits(Instance instance) {
        return instance.getAttributeValue(Mem.DATA_ATTR).getWidth();
    }

    public static int registerWidth(Instance instance) {
        return instance.getAttributeValue(StdAttr.WIDTH).getWidth();
    }

    private static MemContents romContents(Instance instance) {
        Rom rom = (Rom) instance.getFactory();
        MemContents memory = rom.getMemContents(instance);
        // Logisim's XML reader may install a default 8x8 contents object when a
        // ROM omits the "contents" attribute, even though addrWidth/dataWidth
        // were set. Normalise to the declared shape so the bridge never
        // silently truncates a 32-bit word.
        memory.setDimensions(instance.getAttributeValue(Mem.ADDR_ATTR).getWidth(),
                instance.getAttributeValue(Mem.DATA_ATTR).getWidth());
        return memory;
    }

    private static MemContents contents(Instance instance, CircuitState state) {
        Object factory = instance.getFactory();
        if (factory instanceof Rom) {
            return romContents(instance);
        }
        if (factory instanceof Ram) {
            MemState memoryState = ((Mem) factory).getState(instance, state);
            return memoryState.getContents();
        }
        throw new IllegalArgumentException("Not a ROM or RAM: " + instance.getFactory().getName());
    }

    public static int[] readWords(Instance instance, CircuitState state, int start, int count) {
        MemContents memory = contents(instance, state);
        checkRange(memory, start, count);
        int[] result = new int[count];
        for (int i = 0; i < count; i++) result[i] = memory.get(start + i);
        return result;
    }

    public static void write(Instance instance, CircuitState state, int start, int[] values) {
        MemContents memory = contents(instance, state);
        checkRange(memory, start, values.length);
        int width = memory.getWidth();
        long mask = width >= 32 ? 0xFFFFFFFFL : ((1L << width) - 1L);
        for (int i = 0; i < values.length; i++) {
            long value = values[i] & 0xFFFFFFFFL;
            if (value > mask) {
                throw new IllegalArgumentException("Value " + Long.toHexString(value)
                        + " does not fit " + width + " bits");
            }
            memory.set(start + i, values[i]);
        }
    }

    /** Replace the complete ROM image. Mutates the in-memory attribute copy only. */
    public static void loadRom(Instance instance, int start, int[] values) {
        if (!(instance.getFactory() instanceof Rom)) {
            throw new IllegalArgumentException("Not a ROM: " + instance.getFactory().getName());
        }
        MemContents memory = romContents(instance);
        checkRange(memory, start, values.length);
        memory.clear();
        int width = memory.getWidth();
        long mask = width >= 32 ? 0xFFFFFFFFL : ((1L << width) - 1L);
        for (int i = 0; i < values.length; i++) {
            long value = values[i] & 0xFFFFFFFFL;
            if (value > mask) {
                throw new IllegalArgumentException("Word " + Long.toHexString(value)
                        + " does not fit " + width + " bits");
            }
            memory.set(start + i, values[i]);
        }
    }

    public static boolean registerInitialized(Instance instance, CircuitState state) {
        return instance.getData(state) instanceof RegisterData;
    }

    public static int readRegister(Instance instance, CircuitState state) {
        Object data = instance.getData(state);
        if (!(data instanceof RegisterData)) return 0;
        return ((RegisterData) data).getValue();
    }

    public static void writeRegister(Instance instance, CircuitState state, int value, int width) {
        long mask = width >= 32 ? 0xFFFFFFFFL : ((1L << width) - 1L);
        long unsigned = value & 0xFFFFFFFFL;
        if (unsigned > mask) {
            throw new IllegalArgumentException("Value " + Long.toHexString(unsigned)
                    + " does not fit " + width + " bits");
        }
        RegisterData data = (RegisterData) instance.getData(state);
        if (data == null) {
            data = new RegisterData();
            instance.setData(state, data);
        }
        data.setValue(value);
        instance.fireInvalidated();
    }

    private static void checkRange(MemContents memory, int start, int count) {
        long capacity = 1L << memory.getLogLength();
        long end = (long) start + count;
        if (start < 0 || count < 0 || end > capacity) {
            throw new IllegalArgumentException("Range [" + start + ", " + end + ") outside capacity "
                    + capacity);
        }
    }
}
