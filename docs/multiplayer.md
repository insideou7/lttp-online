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
4. When another player is on the same screen as you, you see their Link (slightly see-through,
   with their name above). They're ghosts: you can't bump into or hurt each other.
5. Enemies are shared too: players in the same room or area see the same monsters, and anyone's
   hit counts. The first player to arrive hosts that room's enemies; when they leave, the next
   player there takes over.
6. Indoors (dungeons, houses, caves), the room itself is shared: a pot one player lifts is gone
   for everyone (and its hidden item can only be taken once), and switches, pegs, unlocked
   doors and lit torches change for everyone in the room. Anyone who walks in later sees the room
   as it is.

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

## Hosting the server

The site is on GitHub Pages, which only serves files, so the sync server runs on Cloudflare
Workers (free plan). `server/cloudflare/worker.js` wraps the same `room.js` in a Durable Object per
room, which saves the room's progress to storage and deletes it 12 hours after the last player
leaves. `.github/workflows/sync-server.yml` deploys it on pushes to `main`.

One-time setup:

1. Make a free Cloudflare account. In My Profile > API Tokens, create a token from the
   "Edit Cloudflare Workers" template. Copy the Account ID from the Workers & Pages overview.
2. In the repo's Settings > Secrets and variables > Actions, add secrets `CLOUDFLARE_API_TOKEN`
   and `CLOUDFLARE_ACCOUNT_ID`.
3. Run the "Sync server" workflow. Its log ends with the Worker's URL,
   `https://lttp-sync.<subdomain>.workers.dev`.
4. Add a repository variable `SYNC_URL` = `wss://lttp-sync.<subdomain>.workers.dev/sync` and run the
   "Web client" workflow, so the site connects to it by default.

Locally: `cd server/cloudflare && npx wrangler@4 dev` serves the same endpoint on port 8787.

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
  `server/index.js` wraps it in WebSockets; `server/cloudflare/worker.js` wraps it in a Durable Object.
- `web/site/sync/presence.js`: seeing each other. 15 times a second, while Link is on screen,
  the client reads where he is (`$20`/`$22`, which map: indoors, light/dark world or a special
  area) and draws his 12 OAM slots (body, sword, shield, shadow...) from VRAM and CGRAM into one
  small image, a "pose". It sends `{ t: 'pos', p: { l, x, y, f } }` only when something changed;
  `f` is the pose's id and the image itself goes along only the first time (about 1 KB), so a
  walk cycle costs a few bytes per update after the first steps. When someone joins, everyone
  sends their position and poses again. The server relays positions and keeps none.
  `web/site/ghosts.js` draws the others on a canvas over the game, at their position minus your
  camera (`$E2`/`$E8`), gliding between updates and dimmed with the screen fades.
- `web/site/sync/mobs.js`: shared enemies. Each player tells the server which enemy area they're
  in (`{ t: 'at', k }`: a dungeon room, or a 512x512 block of an overworld area); the server makes
  the first one there its owner. 15 times a second the owner sends its 16 sprite slots and 8
  overlords (about 900 bytes of WRAM from $0B00-$0FFF and $7FF9C2-$7FFA5B) to the others there,
  who write them into their game between frames. A non-owner's game still runs between copies,
  so when it damages, stuns or kills an enemy or picks up a drop, the client sends that slot to
  the owner (`hit`), whose game takes it over, and keeps its own copy for 0.4 s so the hit
  doesn't flicker back. Enemies only chase and attack the owner's Link between copies, though
  they still hurt anyone who touches them.
- `web/site/sync/tiles.js`: shared room objects indoors. Each client in a dungeon room watches the
  room's tilemaps ($7E2000-$7E5FFF), collision map ($7F2000-$7F3FFF), crystal switch state
  ($7EC172) and taken pot items ($7EF580). Bytes its own game changes go to the others in the room
  (`tiles`), who write them and queue the redraw in the game's own VRAM upload list ($7E1000,
  flag $7E0014), the way `Dungeon_Store2x2` does. The room's enemy host also sends every change
  since it arrived to each newcomer. Items that pop out of a pot or bush a non-host lifted, and
  pots they throw, are handed to the host as new sprites (`hit` with `n`), so they don't vanish.
- Backends: the client only needs `ram.get/set`, `inGame()` and an optional `refresh()`.
  `zelda3-backend.js` reads the WASM heap and calls `web_refresh()` (in `web/src/web_api.c`) to
  redraw the HUD, sword, shield and armor after a remote change. To show your Link to others a
  backend also provides `video` (VRAM, CGRAM and the sprite tile base); zelda3 exports them from
  `web_api.c`. `snes-backend.js` does the same for the SNES emulator that runs randomizer seeds
  (see [web-client.md](web-client.md#randomizer-seeds)): randomizers keep the game's RAM layout,
  so everything above works unchanged; its `refresh()` calls the game's own redraw routines.
- One game per room: `hello` carries the ROM's game id and label (`rom-info.js`). The first player
  sets the room's game, which is kept with its progress; a player with a different seed gets
  `wrong-game` and isn't let in, and their page says which seed the room plays. Pages from before
  this count as the US game. A room with no progress and nobody in it takes the next game.
- Randomizer-only items: `swapItems` ($7EF38C, which of the items sharing a menu slot you own,
  minus the mushroom the witch takes) and `bowFlags` ($7EF38E) are shared bits. They stay zero in
  the plain game.

## Known limits

- Randomizer seeds: only progress the plain game also has is shared (plus the swap-item flags).
  Randomizer-only counters (keysanity key totals, triforce pieces, collected-item count) stay per
  player. If a randomizer rewrote one of the game's redraw routines, another player's unlock still
  arrives but shows on your HUD or Link only after the next room or area change.
- Shared enemies: an enemy right at the edge of your screen can flicker when the room's host is
  some distance away, because your game stops running enemies it thinks are off screen. Bosses
  keep extra state outside the sprite tables and may act oddly for non-hosts. Items an enemy
  drops are the host's roll.
- Shared rooms are indoors only: on the overworld, bushes and rocks one player lifts stay for the
  others. Pushed blocks go through the same tile changes but haven't been tried with two players.
  Another player carrying a pot isn't shown.

- Other players are drawn over everything, including the HUD and things they'd walk behind
  (doorways, tree tops). The people and enemies they carry or fight aren't shown, only their Link.

- If two players are in the same dungeon room when one opens a chest, the other's game still shows
  it closed until they leave the room, and could open it again.
- zelda3's optional "switch between bow and silver arrows" feature is undone by the sync (owning
  the silver bow is a shared level).
- With the Node server, rooms are in memory: restarting it forgets them (players' own saves are
  unaffected). The Cloudflare server keeps them in storage.
- If two players open locked doors with the room's last key at the same moment, both doors open.
