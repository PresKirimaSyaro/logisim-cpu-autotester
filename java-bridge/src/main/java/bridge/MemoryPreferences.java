package bridge;

import java.util.*;
import java.util.prefs.*;

/** Process-local preferences keep headless runs independent of desktop settings/registry. */
public final class MemoryPreferences implements PreferencesFactory {
    private final Preferences root = new Node(null, "");
    public Preferences userRoot() { return root; }
    public Preferences systemRoot() { return root; }
    private static final class Node extends AbstractPreferences {
        private final Map<String,String> values = new HashMap<>();
        private final Map<String,Node> nodes = new HashMap<>();
        Node(AbstractPreferences parent, String name) { super(parent,name); }
        protected void putSpi(String k,String v) { values.put(k,v); }
        protected String getSpi(String k) { return values.get(k); }
        protected void removeSpi(String k) { values.remove(k); }
        protected void removeNodeSpi() { values.clear(); nodes.clear(); }
        protected String[] keysSpi() { return values.keySet().toArray(new String[0]); }
        protected String[] childrenNamesSpi() { return nodes.keySet().toArray(new String[0]); }
        protected AbstractPreferences childSpi(String n) { return nodes.computeIfAbsent(n,k->new Node(this,k)); }
        protected void syncSpi() { }
        protected void flushSpi() { }
    }
}
