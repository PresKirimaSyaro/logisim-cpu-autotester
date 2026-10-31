package bridge;

import com.cburch.logisim.circuit.*;
import com.cburch.logisim.comp.Component;
import com.cburch.logisim.data.*;
import com.cburch.logisim.file.*;
import com.cburch.logisim.instance.*;
import com.cburch.logisim.proj.Project;
import com.cburch.logisim.std.memory.BridgeMemory;
import com.cburch.logisim.std.wiring.Clock;
import com.cburch.logisim.std.wiring.Pin;
import java.io.*;
import java.math.BigInteger;
import java.util.*;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.*;

/** All logic simulation is delegated to the unmodified original Logisim JAR. */
public final class Engine implements AutoCloseable {
    public static final class Failure extends RuntimeException {
        public final String code;
        public Failure(String code, String message) { super(message); this.code = code; }
    }
    static Failure fail(String c, String m) { return new Failure(c, m); }

    private static final int MAX_MEMORY_WORDS = 1 << 20;
    private static final int DEFAULT_READ_LIMIT = 1 << 16;
    private static final int MAX_HIERARCHY_DEPTH = 32;

    private Project project;
    private Circuit circuit;
    private CircuitState state;
    private final Map<String, Instance> pins = new TreeMap<>();

    /** A component located in the live state tree, addressed by a deterministic path. */
    private static final class Ref {
        final Instance instance;
        final Component component;
        final CircuitState state;
        final String path;
        final int depth;
        Ref(Instance instance, Component component, CircuitState state, String path, int depth) {
            this.instance = instance;
            this.component = component;
            this.state = state;
            this.path = path;
            this.depth = depth;
        }
    }

    public void load(String path, String name) {
        Project next = null;
        try {
            File file = new File(path);
            if (!file.isFile()) throw fail("INVALID_FILE", "Not a file: " + path);
            // Reject external entities and external libraries before the legacy XML reader.
            // This is validation only: Logisim itself still parses and builds the circuit.
            DocumentBuilderFactory f = DocumentBuilderFactory.newInstance();
            f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            f.setFeature("http://xml.org/sax/features/external-general-entities", false);
            f.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            Document d = f.newDocumentBuilder().parse(file);
            if (!d.getDocumentElement().getTagName().equals("project")) throw fail("INVALID_FILE", "Expected project root");
            NodeList libs = d.getElementsByTagName("lib");
            for (int i=0; i<libs.getLength(); i++) {
                String desc = ((Element)libs.item(i)).getAttribute("desc");
                if (!desc.startsWith("#")) throw fail("UNSUPPORTED_LIBRARY", "Only built-in libraries supported: " + desc);
            }
            Loader loader = new Loader(null) {
                @Override public void showError(String message) { throw fail("INVALID_FILE", message); }
            };
            LogisimFile loaded = LogisimFile.load(file, loader);
            if (loaded == null) throw fail("INVALID_FILE", "Logisim could not load file");
            String message = loaded.getMessage();
            if (message != null) throw fail("INVALID_FILE", message);
            Circuit target = loaded.getCircuit(name);
            if (target == null) throw fail("CIRCUIT_NOT_FOUND", name);
            Map<String,Instance> discovered = new TreeMap<>();
            for (Component c : target.getNonWires()) if (c.getFactory() == Pin.FACTORY) {
                Instance p = Instance.getInstanceFor(c);
                String id = target.getName() + "/pin@" + p.getLocation().getX() + "," + p.getLocation().getY();
                if (discovered.put(id,p) != null) throw fail("INVALID_FILE","Duplicate Pin location: " + id);
            }
            loaded.getOptions().getAttributeSet().setValue(Options.sim_rand_attr, 0);
            loaded.getOptions().getAttributeSet().setValue(Options.sim_limit_attr, 1000);
            next = new Project(loaded);
            // Project creates background GUI simulator threads: disable and shut them down.
            next.getSimulator().setIsRunning(false);
            next.getSimulator().shutDown();
            CircuitState fresh = new CircuitState(next, target);
            fresh.getPropagator().propagate();
            if (fresh.getPropagator().isOscillating()) throw fail("OSCILLATION", "Initial propagation oscillates");
            close(); project = next; next = null; circuit = target; state = fresh;
            pins.clear();
            pins.putAll(discovered);
        } catch (Failure e) { throw e; }
        catch (Exception e) { throw fail("INVALID_FILE", e.toString()); }
        finally { if (next != null) next.getSimulator().shutDown(); }
    }

    private void ready() { if (state == null) throw fail("NOT_LOADED", "Load a circuit first"); }

    private Instance pin(String key) {
        ready(); Instance p = pins.get(key); if (p != null) return p;
        List<Instance> matches = new ArrayList<>();
        for (Instance i : pins.values()) if (!key.isEmpty() && key.equals(i.getAttributeValue(StdAttr.LABEL))) matches.add(i);
        if (matches.size() > 1) throw fail("AMBIGUOUS_PORT", key);
        if (matches.isEmpty()) throw fail("PORT_NOT_FOUND", key);
        return matches.get(0);
    }

    public Map<String,Object> inspect() {
        ready(); List<Object> ports = new ArrayList<>();
        pins.forEach((id,p) -> ports.add(Map.of("id",id,"label",p.getAttributeValue(StdAttr.LABEL),
            "direction",Pin.FACTORY.isInputPin(p)?"input":"output", "width",Pin.FACTORY.getWidth(p).getWidth(),
            "x",p.getLocation().getX(),"y",p.getLocation().getY())));
        return Map.of("circuit",circuit.getName(),"logisimVersion",com.cburch.logisim.Main.VERSION_NAME,"ports",ports);
    }

    private static String escapeSegment(String value) {
        return value.replace("%", "%25").replace("/", "%2F").replace("@", "%40").replace(",", "%2C");
    }

    private static String segment(Component component) {
        Instance instance = Instance.getInstanceFor(component);
        return escapeSegment(component.getFactory().getName()) + "@"
                + instance.getLocation().getX() + "," + instance.getLocation().getY();
    }

    private void collect(CircuitState current, String prefix, Map<String,Ref> out, int depth) {
        if (depth > MAX_HIERARCHY_DEPTH) throw fail("HIERARCHY_TOO_DEEP", prefix);
        for (Component component : current.getCircuit().getNonWires()) {
            Instance instance = Instance.getInstanceFor(component);
            if (instance == null) continue;
            String path = prefix + "/" + segment(component);
            out.put(path, new Ref(instance, component, current, path, depth));
            if (component.getFactory() instanceof SubcircuitFactory) {
                // Create the substate on demand so hierarchical CPU designs can
                // expose nested ROM/RAM/register components before any clock
                // edge. Logisim itself owns the state object; no memory model is
                // reimplemented here.
                CircuitState sub = ((SubcircuitFactory) component.getFactory())
                        .getSubstate(current, component);
                if (sub != null) collect(sub, path, out, depth + 1);
            }
        }
    }

    private Map<String,Ref> refs() {
        ready();
        Map<String,Ref> out = new LinkedHashMap<>();
        collect(state, circuit.getName(), out, 0);
        return out;
    }

    private Ref resolve(String path) {
        Ref ref = refs().get(path);
        if (ref == null) throw fail("COMPONENT_NOT_FOUND", path);
        return ref;
    }

    public Map<String,Object> inspectComponents(boolean recursive) {
        ready();
        List<Object> components = new ArrayList<>();
        for (Ref ref : refs().values()) {
            if (!recursive && ref.depth != 0) continue;
            Instance instance = ref.instance;
            Map<String,Object> item = new LinkedHashMap<>();
            item.put("path", ref.path);
            item.put("name", instance.getFactory().getName());
            item.put("circuit", ref.state.getCircuit().getName());
            item.put("x", instance.getLocation().getX());
            item.put("y", instance.getLocation().getY());
            item.put("label", instance.getAttributeValue(StdAttr.LABEL));
            String kind = "other";
            if (BridgeMemory.isRom(instance)) {
                kind = "rom";
                item.put("addressBits", BridgeMemory.addressBits(instance));
                item.put("dataBits", BridgeMemory.dataBits(instance));
                item.put("capacity", 1L << BridgeMemory.addressBits(instance));
            } else if (BridgeMemory.isRam(instance)) {
                kind = "ram";
                item.put("addressBits", BridgeMemory.addressBits(instance));
                item.put("dataBits", BridgeMemory.dataBits(instance));
                item.put("capacity", 1L << BridgeMemory.addressBits(instance));
            } else if (BridgeMemory.isRegister(instance)) {
                kind = "register";
                item.put("width", BridgeMemory.registerWidth(instance));
            } else if (instance.getFactory() == Clock.FACTORY) {
                kind = "clock";
            } else if (instance.getFactory() instanceof SubcircuitFactory) {
                kind = "subcircuit";
                item.put("subcircuit", ((SubcircuitFactory) instance.getFactory()).getSubcircuit().getName());
            }
            item.put("kind", kind);
            components.add(item);
        }
        return Map.of("circuit", circuit.getName(), "components", components);
    }

    private static void checkRange(long capacity, int start, int count) {
        long end = (long) start + count;
        if (start < 0 || count < 0 || end > capacity) {
            throw fail("MEMORY_RANGE", "Range [" + start + ", " + end + ") outside capacity " + capacity);
        }
    }

    private static String wordHex(int value, int dataBits) {
        int digits = Math.max(1, (dataBits + 3) / 4);
        return "0x" + String.format("%0" + digits + "X", value & 0xFFFFFFFFL);
    }

    public Map<String,Object> readMemory(String path, Integer startOpt, Integer countOpt) {
        Ref ref = resolve(path);
        if (!BridgeMemory.isMemory(ref.instance)) throw fail("NOT_MEMORY", path);
        int addressBits = BridgeMemory.addressBits(ref.instance);
        int dataBits = BridgeMemory.dataBits(ref.instance);
        long capacity = 1L << addressBits;
        int start = startOpt == null ? 0 : startOpt;
        int count;
        if (countOpt == null) {
            if (capacity > DEFAULT_READ_LIMIT) {
                throw fail("EXPLICIT_COUNT_REQUIRED", "Memory has " + capacity
                        + " words; pass count and start for partial reads");
            }
            count = (int) capacity;
        } else {
            count = countOpt;
        }
        if (count > MAX_MEMORY_WORDS) throw fail("READ_TOO_LARGE", "count exceeds " + MAX_MEMORY_WORDS);
        checkRange(capacity, start, count);
        int[] values = BridgeMemory.readWords(ref.instance, ref.state, start, count);
        List<String> words = new ArrayList<>(count);
        for (int value : values) words.add(wordHex(value, dataBits));
        Map<String,Object> result = new LinkedHashMap<>();
        result.put("path", path);
        result.put("kind", BridgeMemory.isRom(ref.instance) ? "rom" : "ram");
        result.put("addressBits", addressBits);
        result.put("dataBits", dataBits);
        result.put("capacity", capacity);
        result.put("start", start);
        result.put("count", count);
        result.put("words", words);
        return result;
    }

    public void writeMemory(String path, int start, int[] values) {
        Ref ref = resolve(path);
        if (!BridgeMemory.isRam(ref.instance)) throw fail("NOT_RAM", path);
        if (values.length > MAX_MEMORY_WORDS) throw fail("MEMORY_RANGE", "Too many words: " + values.length);
        int addressBits = BridgeMemory.addressBits(ref.instance);
        checkRange(1L << addressBits, start, values.length);
        try {
            BridgeMemory.write(ref.instance, ref.state, start, values);
        } catch (IllegalArgumentException e) {
            throw fail("MEMORY_VALUE", e.getMessage());
        }
    }

    public void loadRom(String path, int start, int[] values) {
        Ref ref = resolve(path);
        if (!BridgeMemory.isRom(ref.instance)) throw fail("NOT_ROM", path);
        if (values.length > MAX_MEMORY_WORDS) throw fail("MEMORY_RANGE", "Too many words: " + values.length);
        int addressBits = BridgeMemory.addressBits(ref.instance);
        checkRange(1L << addressBits, start, values.length);
        try {
            BridgeMemory.loadRom(ref.instance, start, values);
        } catch (IllegalArgumentException e) {
            throw fail("MEMORY_VALUE", e.getMessage());
        }
    }

    public Map<String,Object> readRegister(String path) {
        Ref ref = resolve(path);
        if (!BridgeMemory.isRegister(ref.instance)) throw fail("NOT_REGISTER", path);
        int width = BridgeMemory.registerWidth(ref.instance);
        int value = BridgeMemory.readRegister(ref.instance, ref.state);
        Map<String,Object> result = new LinkedHashMap<>();
        result.put("path", path);
        result.put("width", width);
        result.put("initialized", BridgeMemory.registerInitialized(ref.instance, ref.state));
        result.put("value", wordHex(value, width));
        return result;
    }

    public void writeRegister(String path, int value) {
        Ref ref = resolve(path);
        if (!BridgeMemory.isRegister(ref.instance)) throw fail("NOT_REGISTER", path);
        int width = BridgeMemory.registerWidth(ref.instance);
        try {
            BridgeMemory.writeRegister(ref.instance, ref.state, value, width);
        } catch (IllegalArgumentException e) {
            throw fail("REGISTER_VALUE", e.getMessage());
        }
    }

    public void setInput(String key, String hex, Integer width) {
        Instance p = pin(key);
        if (!Pin.FACTORY.isInputPin(p)) throw fail("WRONG_DIRECTION", key);
        int w = Pin.FACTORY.getWidth(p).getWidth();
        if (width != null && width != w) throw fail("WIDTH_MISMATCH", "Expected " + w + ", received " + width);
        if (!hex.matches("0x[0-9a-fA-F]+")) throw fail("INVALID_VALUE", "Expected unsigned hexadecimal string");
        BigInteger n = new BigInteger(hex.substring(2),16);
        if (n.bitLength() > w) throw fail("WIDTH_MISMATCH", hex + " does not fit " + w + " bits");
        InstanceState s = state.getInstanceState(p);
        Pin.FACTORY.setValue(s,Value.createKnown(BitWidth.create(w),n.intValue()));
        s.fireInvalidated();
    }

    public void propagate() {
        ready();
        try { state.getPropagator().propagate(); }
        catch (Exception e) { throw fail("PROPAGATION_ERROR",e.toString()); }
        if (state.getPropagator().isOscillating()) throw fail("OSCILLATION", "Propagation exceeded 1000 simulation steps; reset required");
    }

    public Map<String,Object> getOutput(String key) {
        Instance p = pin(key);
        if (Pin.FACTORY.isInputPin(p)) throw fail("WRONG_DIRECTION", key);
        Value v = Pin.FACTORY.getValue(state.getInstanceState(p));
        long bits=0, unknown=0, error=0;
        for (int i=0;i<v.getWidth();i++) {
            Value b=v.get(i);
            if (b==Value.TRUE) bits |= 1L<<i;
            else if (b==Value.ERROR) error |= 1L<<i;
            else if (b!=Value.FALSE) unknown |= 1L<<i;
        }
        int digits = Math.max(1,(v.getWidth()+3)/4);
        return Map.of("width",v.getWidth(),"value",hex(bits,digits),
            "unknownMask",hex(unknown,digits),
            "errorMask",hex(error,digits),"status",error!=0?"error":unknown!=0?"unknown":"known");
    }

    private static String hex(long n,int digits) { return "0x" + String.format("%0"+digits+"X",n); }

    /** True when the loaded state tree contains at least one internal Logisim Clock. */
    public boolean hasInternalClock() {
        for (Ref ref : refs().values()) {
            if (ref.instance.getFactory() == Clock.FACTORY) return true;
        }
        return false;
    }

    /**
     * Advance every internal Logisim Clock by a fixed number of half cycles.
     * Two half cycles always contain exactly one rising and one falling edge,
     * regardless of the current phase, so a rising-edge CPU commits exactly one
     * instruction. Propagation runs after every toggle.
     */
    public void clockCycle(Integer halfCyclesOpt) {
        ready();
        int halfCycles = halfCyclesOpt == null ? 2 : halfCyclesOpt;
        if (halfCycles < 1 || halfCycles > 2) {
            throw fail("INVALID_CLOCK", "Internal clock halfCycles must be 1 or 2");
        }
        if (!hasInternalClock()) throw fail("NO_INTERNAL_CLOCK", "No internal Logisim Clock component found");
        for (int i = 0; i < halfCycles; i++) {
            state.getPropagator().tick();
            propagate();
        }
    }

    /** Read several root output Pins in one request. */
    public Map<String,Object> readOutputs(List<String> ports) {
        ready();
        Map<String,Object> result = new LinkedHashMap<>();
        for (String port : ports) result.put(port, getOutput(port));
        return result;
    }

    public void tick(String key, String edge) {
        Instance p = pin(key);
        if (!Pin.FACTORY.isInputPin(p) || Pin.FACTORY.getWidth(p).getWidth()!=1)
            throw fail("INVALID_CLOCK", "Clock must be a one-bit input Pin");
        if (!edge.equals("rising") && !edge.equals("falling")) throw fail("INVALID_CLOCK","Expected rising or falling");
        // Establish and settle the opposite level, then apply and settle the named edge.
        setInput(key,edge.equals("rising")?"0x0":"0x1",1); propagate();
        setInput(key,edge.equals("rising")?"0x1":"0x0",1); propagate();
    }

    public void reset() { ready(); state = new CircuitState(project,circuit); propagate(); }
    @Override public void close() { if (project!=null) project.getSimulator().shutDown(); project=null; state=null; circuit=null; pins.clear(); }
}
