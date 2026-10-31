package bridge;

public final class Poc {
    static void expect(Engine e, String port, String expected) {
        Object actual=e.getOutput(port).get("value");
        if (!expected.equals(actual) || !e.getOutput(port).get("status").equals("known"))
            throw new AssertionError("port="+port+" expected="+expected+" actual="+e.getOutput(port));
    }
    public static void main(String[] args) {
        System.setProperty("java.util.prefs.PreferencesFactory", "bridge.MemoryPreferences");
        try (Engine e = new Engine()) {
            for (String[] fixture : new String[][]{{"adder","CombinationalAdder"},{"hierarchy","HierarchicalCircuit"}}) {
                e.load("fixtures/"+fixture[0]+".circ",fixture[1]);
                for (int[] row : new int[][]{{1,2,3},{255,1,0},{127,128,255}}) {
                    e.setInput("A","0x"+Integer.toHexString(row[0]),8);
                    e.setInput("B","0x"+Integer.toHexString(row[1]),8); e.propagate();
                    expect(e,"S",String.format("0x%02X",row[2]));
                    System.out.println("PASS "+fixture[1]+" inputs="+row[0]+","+row[1]+" expected="+row[2]+" actual="+e.getOutput("S"));
                }
            }
            e.load("fixtures/register.circ","Register"); expect(e,"Q","0x00");
            e.setInput("WE","0x1",1); e.setInput("D","0x2A",8); e.tick("CLK","rising"); expect(e,"Q","0x2A");
            e.setInput("WE","0x0",1); e.setInput("D","0x55",8); e.tick("CLK","rising"); expect(e,"Q","0x2A");
            e.setInput("WE","0x1",1); e.tick("CLK","rising"); expect(e,"Q","0x55");
            e.setInput("D","0xAA",8); e.tick("CLK","rising"); expect(e,"Q","0xAA");
            e.reset(); expect(e,"Q","0x00");
            System.out.println("PASS Register rising edge, disabled hold, consecutive writes, fresh-state reset");
        }
    }
}
