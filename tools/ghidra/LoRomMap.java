// Maps a headerless LoROM .sfc (raw import) into SNES bus addresses and
// disassembles from the reset/NMI/IRQ vectors.
// Bank N of the file (0x8000 bytes each) lands at $NN:8000-$NN:FFFF.
// Usage: analyzeHeadless ... -import rom.sfc -processor 65816:LE:16:default
//        -loader BinaryLoader -noanalysis -postScript LoRomMap.java
//@category SNES
import ghidra.app.script.GhidraScript;
import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.program.database.mem.FileBytes;
import ghidra.program.model.address.Address;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.SourceType;

public class LoRomMap extends GhidraScript {
  @Override
  public void run() throws Exception {
    Memory mem = currentProgram.getMemory();
    FileBytes fb = mem.getAllFileBytes().get(0);
    long size = fb.getSize();
    long off = 0;
    if (size % 0x8000 == 512) off = 512; // skip copier header
    for (MemoryBlock b : mem.getBlocks()) mem.removeBlock(b, monitor);
    int banks = (int) ((size - off) / 0x8000);
    for (int n = 0; n < banks; n++) {
      Address a = toAddr(((long) n << 16) | 0x8000);
      MemoryBlock b = mem.createInitializedBlock(
          String.format("bank_%02X", n), a, fb, off + (long) n * 0x8000, 0x8000, false);
      b.setRead(true); b.setExecute(true); b.setWrite(false);
    }
    println("Mapped " + banks + " LoROM banks");
    // Native-mode vectors at $00:FFE4.., emulation-mode at $00:FFF4..
    String[][] vecs = {{"NMI", "FFEA"}, {"IRQ", "FFEE"}, {"RESET", "FFFC"}};
    for (String[] v : vecs) {
      Address va = toAddr(Long.parseLong(v[1], 16));
      int target = (mem.getByte(va) & 0xff) | ((mem.getByte(va.add(1)) & 0xff) << 8);
      if (target < 0x8000) continue;
      Address t = toAddr(target);
      createLabel(t, "Vector_" + v[0], true, SourceType.USER_DEFINED);
      new DisassembleCommand(t, null, true).applyTo(currentProgram, monitor);
      println(v[0] + " -> " + t);
    }
  }
}
