# lttp-online

*The Legend of Zelda: A Link to the Past* in the browser, with online co-op where friends share
progress. Built on [snesrev/zelda3](https://github.com/snesrev/zelda3), a C reimplementation of the
game, compiled to WebAssembly, plus a reverse engineering toolkit for the original SNES ROM.

**Play: https://insideou7.github.io/lttp-online/**

You need your own US ROM of the game. None is included or hosted here: the page reads the ROM you
pick, checks it, and extracts the game's graphics and sound in your browser. The ROM never leaves
your computer. The first load takes about 15 seconds; after that the game starts right away.

**Randomizers**: load an ALttPR (or other randomizer) seed instead and it runs on an SNES emulator
core in the page, with the same online co-op. Everyone in a room must load the same seed.

## Controls

| SNES | Keyboard | | SNES | Keyboard |
| --- | --- | --- | --- | --- |
| D-pad | W A S D | | Start | G |
| A | J | | Select | F |
| B | M | | L / R | Q / E |
| X / Y | I / L | | Turbo | Tab (hold) |

Arrow keys, Enter and Right Shift also work, and so do gamepads. Save states: Shift+F1…F10 to
save, F1…F10 to load. In-game saves are kept in your browser. To change the keys, edit
[`web/keymap.ini`](web/keymap.ini) (and the controls table in `web/site/index.html`).

## Playing online

1. Press **Create room** and send the invite link (`…/?room=CODE`) to friends, or have them type
   the code into **Join**. No accounts.
2. Everyone loads their own ROM, presses **Play**, and starts or loads a save file. For a
   randomizer, everyone loads their copy of the same seed (the five icons on the file select
   screen match) and presses **Play seed**; the room won't let in a different seed.
3. Everyone plays their own game and can go anywhere, on different screens. Progress is shared:

| Shared by everyone | Each player's own |
| --- | --- |
| Items, sword, shield, armor | Rupees |
| Heart containers, pieces of heart, magic upgrade | Bombs and arrows |
| Bomb and arrow capacity upgrades, bottles | Current health and magic |
| Small keys (a key picked up counts for everyone; a key used is spent for everyone) | Bottle contents |
| Pendants, crystals, maps, compasses, big keys | Position and followers |
| Opened chests and doors, beaten bosses, story progress | |

When someone gets an item, the others see "*Name* got *item*" and have it right away. A room keeps
its progress for 12 hours after the last player leaves. Details and known limits:
[docs/multiplayer.md](docs/multiplayer.md).

## How it's built

- **Browser client** (`web/`): `web/build.sh` builds zelda3 with Emscripten into a static site in
  `web/dist/`. The game's asset tool runs unchanged in the browser through Pyodide. See
  [docs/web-client.md](docs/web-client.md).
- **SNES emulator** (`web/src/emu_api.c`, `web/site/emu.js`): randomizer seeds change the game's
  code, so zelda3 can't play them. They run on [LakeSnes](https://github.com/dinkc64/LakeSnes)
  (MIT), compiled to WebAssembly by the same build. See
  [docs/web-client.md](docs/web-client.md#randomizer-seeds).
- **Sync server** (`server/`): a small room server that relays only progress. It runs as a
  Cloudflare Worker with a Durable Object per room (`server/cloudflare/`), live at
  `https://lttp-sync.insideou7.workers.dev`. `server/index.js` is the same server for Node, for
  local play.
- **Reverse engineering toolkit** (`tools/`): `tools/setup-re-toolkit.sh` installs Ghidra with a
  65816 module, asar, zelda3 and the JP 1.0 disassembly into `/opt/re`. See
  [docs/reverse-engineering.md](docs/reverse-engineering.md).

### Run it locally

```bash
EMSDK=/path/to/emsdk web/build.sh   # about 1 minute
npm start                           # site + sync server on http://localhost:8080
npm test                            # sync tests (Node 22, no packages)
```

### Deploy

Pushes to `main` deploy automatically with GitHub Actions:

- `.github/workflows/web.yml` builds the site and publishes it to GitHub Pages. It fails if a ROM or
  extracted assets end up in the build.
- `.github/workflows/sync-server.yml` deploys the sync server to Cloudflare. It needs the Actions
  secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the site finds the server through the
  repository variable `SYNC_URL`. One-time setup is in [docs/multiplayer.md](docs/multiplayer.md#hosting-the-server).

## Roadmap

- **Randomizer extras**: share randomizer-only progress (e.g. keysanity key totals, triforce hunt
  pieces), and test more randomizer variants (door and entrance shuffles).


## Legal

No game data is hosted or committed here; bring your own legally obtained ROM. zelda3 is MIT
licensed, and so is LakeSnes.
