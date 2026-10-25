# Multiplayer

Players in a room share unlocks and keep their own consumables. Each player runs their own copy of
the game in their browser and goes wherever they like; a small server relays only progress.

| Shared | Per player |
| --- | --- |
| Items (bow tier, hookshot, rods, medallions, flute, mirror, gloves, boots, flippers, moon pearl...) | Rupees |
| Sword, shield, armor | Bombs, arrows (the bow's "has arrows" half too) |
| Heart containers and pieces of heart, magic upgrade | Current health and magic |
| Bomb and arrow capacity upgrades | |
| Bottles (owning one; a new one arrives empty) | What's in your bottles |
| Small keys (one picked up counts for everyone; one used is spent for everyone) | |
| Pendants, crystals, maps, compasses, big keys | Position, current screen, followers (Zelda, the old man...) |
| Opened chests, doors, defeated bosses, heart pieces taken, bombed walls (dungeon and overworld flags) | Spawn point |
| Story progress (Zelda rescued, Agahnim beaten...) | |

## Playing

1. Open the site, press **Create room** and send the invite link (`.../?room=CODE`) to friends.
   They can also type the code into **Join**.
2. Everyone loads their own ROM and presses **Play**, then starts or loads a save file.
3. The first player to reach gameplay seeds the room with their save's progress. Players who join
   later get the room's progress merged into their file (anything extra they had is shared too).
   When someone gets an item, the others see "*Name* got *item*" and have it right away.

No accounts: a room is just its code. The server keeps a room's progress in memory for 12 hours
after the last player leaves. In-game saves keep everything as usual, in each player's browser.

## Running the server

```bash
web/build.sh                                  # builds web/dist (see web-client.md)
PORT=8080 node server/index.js --static web/dist
```

That serves the site and the WebSocket endpoint `/sync?room=CODE` from one origin, which is what
the page uses by default. Node 22, no npm packages. If the sync server runs somewhere else, set
it at build time (`SYNC_URL=wss://host/sync web/build.sh`, stored in `dist/build.json`) or per
visit with `?server=wss://host/sync`. Without a reachable server the game still runs, solo, and
the status line says so; the client keeps retrying.

`npm test` runs the sync tests (merge rules, the room, and two clients through the real server).

## How it works

- `web/site/sync/fields.js`: which save RAM bytes ($7EF000-$7EF3FF) are shared and how two values
  merge. Kinds: `bits` (OR; room and overworld flags, pendants...), `max` (item levels), `sum`
  (heart quarters and capacity upgrades; each player's gains add up), `counts` (small keys per
  dungeon; ops carry +1 or -1, so pickups and doors both apply to everyone), `set` (last writer wins, for
  things the game can take away: the smiths borrow your sword, a Like Like eats your shield, the
  witch takes the mushroom).
- `web/site/sync/client.js`: every 100 ms while a file is being played, compares the save area with
  what the room last agreed on and sends the gains as small ops. Ops from others are written into
  RAM between frames. It also writes back shared flags the game overwrote (a dungeon room saves its
  flags from the copy it loaded, which can predate another player's chest).
- `web/site/sync/room.js`: the server-side room, with no transport: messages in, messages out.
  `server/index.js` wraps it in WebSockets; a Cloudflare Durable Object could wrap it the same way.
- Backends: the client only needs `ram.get/set`, `inGame()` and an optional `refresh()`.
  `zelda3-backend.js` reads the WASM heap and calls `web_refresh()` (in `web/src/web_api.c`) to
  redraw the HUD, sword, shield and armor after a remote change. An SNES emulator backend for
  randomizer ROMs can implement the same interface over its WRAM, since randomizers keep vanilla's
  item layout.

## Known limits

- If two players are in the same dungeon room when one opens a chest, the other's game still shows
  it closed until they leave the room, and could open it again.
- zelda3's optional "switch between bow and silver arrows" feature is undone by the sync (owning
  the silver bow is a shared level).
- Rooms are in memory: restarting the server forgets them (players' own saves are unaffected).
- If two players open locked doors with the room's last key at the same moment, both doors open.
