package bridge;

import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public final class Main {
    private static final Gson JSON = new GsonBuilder().serializeNulls().create();
    private final Engine engine = new Engine();
    private boolean stopping;
    private static String str(JsonObject o,String k) {
        if (!o.has(k) || !o.get(k).isJsonPrimitive() || !o.get(k).getAsJsonPrimitive().isString())
            throw Engine.fail("INVALID_REQUEST", "Missing/string required: "+k);
        return o.get(k).getAsString();
    }
    private static Integer optInt(JsonObject o,String k) {
        if (!o.has(k) || o.get(k).isJsonNull()) return null;
        try { return o.get(k).getAsBigDecimal().intValueExact(); }
        catch(Exception e) { throw Engine.fail("INVALID_REQUEST", k + " must be an integer"); }
    }
    private static boolean optBool(JsonObject o,String k,boolean dflt) {
        if (!o.has(k) || o.get(k).isJsonNull()) return dflt;
        if (!o.get(k).isJsonPrimitive() || !o.get(k).getAsJsonPrimitive().isBoolean())
            throw Engine.fail("INVALID_REQUEST", k + " must be a boolean");
        return o.get(k).getAsBoolean();
    }
    private static long unsignedWord(JsonElement el) {
        long value;
        if (el.isJsonPrimitive() && el.getAsJsonPrimitive().isString()) {
            String text = el.getAsString().trim();
            try {
                if (text.startsWith("0x") || text.startsWith("0X"))
                    value = Long.parseUnsignedLong(text.substring(2), 16);
                else
                    value = Long.parseUnsignedLong(text, 10);
            } catch (NumberFormatException e) {
                throw Engine.fail("INVALID_REQUEST", "Invalid unsigned word: " + text);
            }
        } else if (el.isJsonPrimitive() && el.getAsJsonPrimitive().isNumber()) {
            try { value = el.getAsBigDecimal().longValueExact(); }
            catch (Exception e) { throw Engine.fail("INVALID_REQUEST", "Invalid unsigned word"); }
        } else {
            throw Engine.fail("INVALID_REQUEST", "Word must be a hex string or integer");
        }
        if (value < 0 || value > 0xFFFFFFFFL)
            throw Engine.fail("INVALID_REQUEST", "Word outside 32-bit unsigned range");
        return value;
    }
    private static int[] words(JsonObject o,String k) {
        if (!o.has(k) || !o.get(k).isJsonArray())
            throw Engine.fail("INVALID_REQUEST", "Array required: " + k);
        JsonArray array = o.getAsJsonArray(k);
        int[] values = new int[array.size()];
        for (int i = 0; i < array.size(); i++) values[i] = (int) unsignedWord(array.get(i));
        return values;
    }
    private static List<String> portNames(JsonObject o,String k) {
        if (!o.has(k) || !o.get(k).isJsonArray())
            throw Engine.fail("INVALID_REQUEST", "Array required: " + k);
        JsonArray array = o.getAsJsonArray(k);
        List<String> values = new ArrayList<>(array.size());
        for (int i = 0; i < array.size(); i++) {
            JsonElement el = array.get(i);
            if (!el.isJsonPrimitive() || !el.getAsJsonPrimitive().isString())
                throw Engine.fail("INVALID_REQUEST", "Port names must be strings");
            values.add(el.getAsString());
        }
        return values;
    }
    private Object execute(JsonObject o, boolean nested) {
        String op=str(o,"op");
        switch(op) {
            case "load": engine.load(str(o,"path"),str(o,"circuit")); return null;
            case "inspect": return engine.inspect();
            case "setInput":
                Integer width=null;
                if(o.has("width")) {
                    try { width=o.get("width").getAsBigDecimal().intValueExact(); }
                    catch(Exception e) { throw Engine.fail("INVALID_REQUEST","width must be an integer"); }
                }
                engine.setInput(str(o,"port"),str(o,"value"),width); return null;
            case "propagate": engine.propagate(); return null;
            case "getOutput": return engine.getOutput(str(o,"port"));
            case "reset": engine.reset(); return null;
            case "tick": engine.tick(str(o,"port"),o.has("edge")?str(o,"edge"):"rising"); return null;
            case "clockCycle": engine.clockCycle(optInt(o,"halfCycles")); return null;
            case "readOutputs": return engine.readOutputs(portNames(o,"ports"));
            case "parseHex": return Engine.parseHexImage(str(o,"text"));
            case "inspectComponents": return engine.inspectComponents(optBool(o,"recursive",true));
            case "readMemory": return engine.readMemory(str(o,"path"),optInt(o,"start"),optInt(o,"count"));
            case "writeMemory": {
                Integer start = optInt(o,"start");
                engine.writeMemory(str(o,"path"), start == null ? 0 : start, words(o,"words"));
                return null;
            }
            case "loadRom": {
                Integer start = optInt(o,"start");
                engine.loadRom(str(o,"path"), start == null ? 0 : start, words(o,"words"));
                return null;
            }
            case "readRegister": return engine.readRegister(str(o,"path"));
            case "writeRegister": {
                long value = unsignedWord(o.get("value"));
                engine.writeRegister(str(o,"path"), (int) value);
                return null;
            }
            case "batch":
                if(nested) throw Engine.fail("INVALID_REQUEST","Nested batch forbidden");
                if(!o.has("operations") || !o.get("operations").isJsonArray()) throw Engine.fail("INVALID_REQUEST","operations array required");
                List<Object> results=new ArrayList<>();
                for(JsonElement el:o.getAsJsonArray("operations")) {
                    try {
                        if(!el.isJsonObject()) throw Engine.fail("INVALID_REQUEST","Operation must be an object");
                        results.add(success(execute(el.getAsJsonObject(),true)));
                    } catch(Exception e) { results.add(error(e)); return Map.of("results",results,"completed",false); }
                }
                return Map.of("results",results,"completed",true);
            case "shutdown":
                if(nested) throw Engine.fail("INVALID_REQUEST","shutdown forbidden inside batch");
                stopping=true; return null;
            default: throw Engine.fail("UNKNOWN_OPERATION",op);
        }
    }
    private static Map<String,Object> success(Object result) {
        Map<String,Object> m=new LinkedHashMap<>(); m.put("ok",true); m.put("result",result); return m;
    }
    private static Map<String,Object> error(Exception e) {
        String code=e instanceof Engine.Failure?((Engine.Failure)e).code:"INTERNAL_ERROR";
        if(code.equals("INTERNAL_ERROR")) e.printStackTrace(System.err);
        return new LinkedHashMap<>(Map.of("ok",false,"error",Map.of("code",code,"message",String.valueOf(e.getMessage()))));
    }
    private void run(PrintStream out) throws IOException {
        Set<String> ids=new HashSet<>();
        try(BufferedReader in=new BufferedReader(new InputStreamReader(System.in,StandardCharsets.UTF_8))) {
            String line;
            while(!stopping && (line=in.readLine())!=null) {
                String id=null; Map<String,Object> response;
                try {
                    JsonElement el=JsonParser.parseString(line);
                    if(!el.isJsonObject()) throw Engine.fail("INVALID_REQUEST","Request object required");
                    JsonObject o=el.getAsJsonObject(); id=str(o,"id");
                    if(id.isEmpty()) throw Engine.fail("INVALID_REQUEST","Nonempty id required");
                    if(!ids.add(id)) throw Engine.fail("DUPLICATE_ID",id);
                    response=success(execute(o,false));
                } catch(JsonParseException e) { response=error(Engine.fail("INVALID_JSON",e.getMessage())); }
                catch(Exception e) { response=error(e); }
                response.put("id",id); out.println(JSON.toJson(response)); out.flush();
            }
        } finally { engine.close(); }
    }
    public static void main(String[] args) throws IOException {
        System.setProperty("java.awt.headless","true");
        System.setProperty("java.util.prefs.PreferencesFactory","bridge.MemoryPreferences");
        PrintStream protocolOut=System.out;
        // Legacy library diagnostics must never corrupt JSON stdout.
        System.setOut(System.err);
        new Main().run(protocolOut);
    }
}
