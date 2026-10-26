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
   For a randomizer seed, only the host needs the seed file: friends load their own original
   Japanese 1.0 ROM once (the one ALttPR seeds are made from), and when they open the invite link
   the seed is sent to them as a patch and set up automatically (see *Sharing a seed* below).
3. The first player to reach gameplay seeds the room with their save's progress. Players who join
   later get the room's progress merged into their file (anything extra they had is shared too).
   When someone gets an item, the others see "*Name* got *item*" and have it right away.
4. When another player is on the same screen as you, you see their Link (slightly see-through,
   with their name above). They're ghosts: you can't bump into or hurt each other.
5. Enemies are shared too: players in the same room or area see the same monsters, and anyone's
   hit counts. The first player to arrive hosts that room's enemies; when they leave, the next
   player there takes over.
6. The place itself is shared. Indoors (dungeons, houses, caves): a pot one player lifts is gone
   for everyone (and its hidden item can only be taken once), and switches, pegs, unlocked
   doors and lit torches change for everyone in the room. Outdoors: cut or lifted bushes, lifted
   rocks and signs, dug holes, bombed walls and hammered pegs. Anyone who arrives later sees the
   place as it is.
7. Text boxes are shared: when someone in your room or area talks to a person, reads a sign or
   gets an item, you see their text box too, with their name on it. It's only a picture over your
   screen: your game keeps running, and the box goes away when they close it.

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
- `web/site/sync/tiles.js`: shared surroundings. Indoors each client watches the room's tilemaps
  ($7E2000-$7E5FFF), collision map ($7F2000-$7F3FFF), crystal switch state ($7EC172) and taken pot
  items ($7EF580); outdoors, the area's map16 tiles ($7E2000-$7E3FFF, collision comes from them).
  Bytes its own game changes go to the others there (`tiles`), who write them and queue the redraw
  in the game's own VRAM upload list ($7E1000, flag $7E0014), the way `Dungeon_Store2x2` and
  `Overworld_DrawMap16` do. Outdoor redraws need the ROM's map16-to-8x8 table (`backend.map16`),
  and outdoor changes also go into the game's list of changed tiles ($7EF800, $7E04AC) so they
  survive a trip indoors. The area's enemy host also sends every change since it arrived to each
  newcomer. Items that pop out of a pot or bush a non-host lifted, and things they throw, are
  handed to the host as new sprites (`hit` with `n`), so they don't vanish.
- `web/site/sync/dialogs.js`: shared text boxes (protocol 6). While a player's game shows a text
  box (module $0E, submodule 2, text renderer state `$1CD4` = 3), the client copies the box out of
  VRAM as the game drew it: the BG3 tilemap from its top left corner (`$1CD2`), 8 tiles high and as
  wide as its border (24 tiles in the US game, 23 in the Japanese one and randomizers), with the 2bpp
  tiles at VRAM $7000 and colors from CGRAM. So any text shows, in any language or randomizer. It's
  deflated (usually under 2 KB) and sent as `dlg` with the area the player was in when the box
  opened (their game is paused, so they're in no area meanwhile); the server relays it to the
  players there. It's sent again when it changes (at most about 8 times a second) and every second
  while it's up, and `d: null` when it closes; a box nobody repeated for 3 s disappears. `ghosts.js`
  draws it where it sits on the speaker's screen, with their name, unless you have a box of your own.
- Backends: the client only needs `ram.get/set`, `inGame()` and an optional `refresh()`.
  `zelda3-backend.js` reads the WASM heap and calls `web_refresh()` (in `web/src/web_api.c`) to
  redraw the HUD, sword, shield and armor after a remote change. To show your Link to others a
  backend also provides `video` (VRAM, CGRAM and the sprite tile base); zelda3 exports them from
  `web_api.c`. `snes-backend.js` does the same for the SNES emulator that runs randomizer seeds
  (see [web-client.md](web-client.md#randomizer-seeds)): randomizers keep the game's RAM layout,
  so everything above works unchanged; its `refresh()` calls the game's own redraw routines.
  For outdoor tile redraws a backend provides `map16(v)`, the four 8x8 tile words of map16 tile
  `v` (zelda3: `web_map16_table()`; the SNES backend reads the game's map16-to-map8 table from
  the ROM).
- One game per room: `hello` carries the ROM's game id and label (`rom-info.js`). The first player
  sets the room's game, which is kept with its progress; a player with a different seed gets
  `wrong-game` and isn't let in, and their page says which seed the room plays. Pages from before
  this count as the US game. A room with no progress and nobody in it takes the next game.
- Sharing a seed (protocol 5, `seed-share.js`, `bps.js`): a page opened with a room code connects
  without joining and sends `seed-get` with the game ids it already has. If the room plays a seed
  it lacks, the server asks a player in the room who said `share` in their `hello` (a seed player)
  to send it. That player's page makes a BPS patch from its saved original ROM (the one sharing the
  most bytes with the seed, normally Japanese 1.0) to the seed, deflates it (an ALttPR seed is about
  90 KB, and the patch holds the randomizer's changes, not the game's code: unchanged and moved data
  are copies from the original ROM) and sends it in `seed-part` messages that the server relays to
  the asker without storing them (at most 24 parts of 64 KiB). The asker rebuilds the seed from
  its own original ROM; the patch's CRCs and metadata (original and seed SHA-1, game id) are
  checked, and the result must be the room's game. If its original ROM is missing, the page says
  which one to load and finishes once it's loaded. Nobody sharing online: the page retries. No ROM
  or patch is ever stored on the server.
- Randomizer-only items: `swapItems` ($7EF38C, which of the items sharing a menu slot you own,
  minus the mushroom the witch takes) and `bowFlags` ($7EF38E) are shared bits. They stay zero in
  the plain game.

## Known limits

- Randomizer seeds: only progress the plain game also has is shared (plus the swap-item flags).
  Randomizer-only counters (keysanity key totals, triforce pieces, collected-item count) stay per
  player. If a randomizer rewrote one of the game's redraw routines, another player's unlock still
  arrives but shows on your HUD or Link only after the next room or area change.
- Shared enemies: the host's game only has the enemies around its own screen. Enemies your game
  runs that aren't on the host's screen (the host's snapshot carries its camera) stay in your
  game, run by your game alone, until the host sees them; an enemy right at that line can still
  flicker. Bosses
  keep extra state outside the sprite tables and may act oddly for non-hosts. Items an enemy
  drops are the host's roll.
- Pushed blocks go through the same tile changes but haven't been tried with two players.
- Overworld changes are shared while players are in the same 512x512 block of an area; someone
  in another block of a big area catches up when they walk into the host's block.

- You see another player's text box only while you're in the same dungeon room or 512x512 block of
  an overworld area as they were. Their Link disappears while they read it, as in any menu.
- Other players are drawn over everything, including the HUD and things they'd walk behind
  (doorways, tree tops). Their Link is shown with whatever he carries over his head (a pot, bush or
  rock); the people who follow them (Zelda, the old man) aren't.

- If two players are in the same dungeon room when one opens a chest, the other's game still shows
  it closed until they leave the room, and could open it again.
- zelda3's optional "switch between bow and silver arrows" feature is undone by the sync (owning
  the silver bow is a shared level).
- With the Node server, rooms are in memory: restarting it forgets them (players' own saves are
  unaffected). The Cloudflare server keeps them in storage.
- If two players open locked doors with the room's last key at the same moment, both doors open.
