# ROMs (not in git)

In Claude cloud sessions you only need to upload your ROM once, in the project chat. It is kept in
the project's shared files, and `tools/setup-re-toolkit.sh` finds it there at the start of every
session, checks it is the US version, and places it here (header stripped).

Put your own legally dumped ROM here. Nothing in this folder is committed.

- `zelda3.sfc`: US version, needed by the snesrev/zelda3 asset extractor.
  SHA-1 `6d4f10a8b10e10dbe624cb23cf03b88bb8252973`.
- `alttp-jp10.sfc`: JP 1.0, matches the spannerisms/jpdasm disassembly.

Headerless (exactly 1 MiB) is preferred; the Ghidra script skips a 512-byte copier header if present.
