# Dota 2 Tracker

A live, in-game Dota 2 stats overlay/dashboard powered by Valve's official
**Game State Integration (GSI)**. Dota 2 streams your current match state to a
local server, which pushes it to a browser dashboard that updates several times
per second — no game files are modified and it's fully ToS-friendly.

![status](https://img.shields.io/badge/status-working-brightgreen)

## What it shows

- **Scoreboard** — Radiant/Dire kills, game clock, game state, day/night
- **Hero** — name, level, HP/mana bars, respawn timer, status effects
  (stun/silence/hex/smoke/…)
- **Player** — K/D/A + KDA ratio, last hits, denies, GPM, XPM, gold, net worth,
  hero damage, tower damage
- **Items** — all 9 inventory/backpack slots with cooldowns & charges + neutral item
- **Abilities** — levels, cooldowns, ultimate highlight
- **Buildings** — tier-1 tower health per lane

Everything is derived from the live GSI feed, so it works for **every hero and
item** automatically.

## Download & run (easiest — no install)

1. Go to the [**Releases**](../../releases/latest) page and download
   **`Dota2Tracker.exe`** (Windows).
2. Double-click it. It will:
   - install the GSI config into your Dota 2 folder automatically,
   - start the tracker,
   - open the dashboard in your browser.
3. **Restart Dota 2** (configs only load at launch), then load a match / bot
   game / hero demo.

That's it — the window shows live status; close it to stop the tracker.

> The first launch may trigger a SmartScreen warning because the exe isn't
> code-signed. Click **More info → Run anyway**. (You can also build it
> yourself from source — see below — if you'd rather not trust the binary.)

## Build the exe yourself

```bash
npm install
npm run build:exe      # → dist/Dota2Tracker.exe
```

Cross-building works from any OS (pkg downloads the Windows Node base). The
GitHub Actions workflow in `.github/workflows/build-release.yml` also builds it
on a real Windows runner and attaches it to a Release whenever you push a
`vX.Y.Z` tag.

## Run from source (developers)

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Install the GSI config into your Dota 2 folder (auto-detects Steam)
npm run install-cfg

# 3. Fully restart Dota 2 (GSI configs are only loaded at launch)

# 4. Start the tracker
npm start

# 5. Open the dashboard
#    http://localhost:3000
```

Load into a match, a bot game, or a hero demo and the dashboard fills in live.

## Try it without launching Dota

You can verify the whole stack with a simulated match:

```bash
npm start          # terminal 1
npm run mock       # terminal 2 — streams a fake, evolving game
```

Open <http://localhost:3000> and watch the stats tick.

## Manual GSI config install

If auto-detection fails, copy `gamestate_integration_tracker.cfg` into:

```
<Steam>/steamapps/common/dota 2 beta/game/dota/cfg/gamestate_integration/
```

Create the `gamestate_integration` folder if it doesn't exist. Common Steam roots:

| OS      | Path |
|---------|------|
| Windows | `C:\Program Files (x86)\Steam\…` |
| macOS   | `~/Library/Application Support/Steam/…` |
| Linux   | `~/.steam/steam/…` or `~/.local/share/Steam/…` |

Then restart Dota 2.

## Configuration

Environment variables (optional):

| Variable          | Default                 | Description |
|-------------------|-------------------------|-------------|
| `PORT`            | `3000`                  | Server / dashboard port |
| `GSI_AUTH_TOKEN`  | `DOTA2_TRACKER_SECRET`  | Shared secret. **Must match** the `token` in the `.cfg` file. |

If you change the port, also update the `uri` in
`gamestate_integration_tracker.cfg` and re-run `npm run install-cfg`.

## How it works

```
 Dota 2  ──HTTP POST (JSON game state)──▶  server.js  ──WebSocket──▶  browser
 (GSI cfg)         several times/sec       (validates token,          (live UI)
                                            enriches, broadcasts)
```

Dota 2 only sends GSI data for **the player it's currently observing** (your own
hero in a normal match, or whoever you're spectating). It does **not** expose
enemy-only information, so this is safe to use in ranked play.

## Project layout

```
server.js                                  GSI receiver + WebSocket + static host
gamestate_integration_tracker.cfg          The config Dota loads
scripts/install-gsi-config.js              Copies the cfg into your Dota folder
scripts/mock-gsi.js                        Simulated match for development
public/                                    Dashboard (index.html, style.css, app.js)
```

## Troubleshooting

- **Dashboard stuck on "Waiting for Dota 2…"** — the config isn't loaded. Make
  sure you fully restarted Dota *after* installing the cfg, and that you're in a
  game/demo (the main menu sends little to no data).
- **403 in the server log** — the `token` in the cfg doesn't match
  `GSI_AUTH_TOKEN`. Keep them identical.
- **Nothing in the log at all** — check the `uri` port in the cfg matches the
  server `PORT`, and that no firewall blocks `localhost:3000`.

## License

MIT
