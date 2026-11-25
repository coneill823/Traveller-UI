# Traveller Campaign Console

A shared, live campaign tool for the **Traveller** tabletop RPG (Mongoose 2nd edition, Core
Rulebook Update 2022). The GM builds the universe in **creator mode**; players connect from
their own devices and see only what their characters know.

Everyone is connected to the same campaign at once: when the GM or a player changes something,
every other screen updates within a moment.

## What is in it so far

| Area | Status |
| --- | --- |
| Live multi-user sync, GM / player sign-in, GM "view as player" preview | Done |
| Knowledge control: reveal anything to the whole party or to one player | Done |
| Universe map in the classic hex style, zooming from universe → sector → subsector → system → world | Done |
| Universe designer: add and place sectors, name subsectors, place or roll systems, draw routes | Done |
| Import from online generators (Second Survey tab/column, legacy SEC, JSON, CSV, loose lists) | Done |
| System drill-down: stars, worlds, gas giants, belts, moons, stations, points of interest, write-ups | Done |
| Route planner (jump rating, fuel, refuelling, travel zones) and objective tours | Done |
| Objectives for the party and private ones per player | Done |
| Chronicler wiki sync, both directions (local vault folder or GitHub repository) | Done |
| Shared dice with boon/bane, hidden GM rolls and "rolled at the table" entry | Done |
| Characters, inventory & cargo, trade, ship builder, personal combat, ship operations & space combat | In progress |

## Running it

You need [Node.js](https://nodejs.org) 22.13 or newer.

```bash
npm install
npm run build
npm start
```

The server prints its address (for example `http://localhost:8787`) and, the first time, a
**setup code**. Open the address, enter the code, name the campaign and choose a GM passphrase.

- **Players at the same table** open the "On your network" address the server prints.
- **Remote players** need the server to be reachable from the internet: either run it on a small
  cloud host (see Docker below), or expose your own machine for the session with a tunnel such as
  Cloudflare Tunnel or Tailscale Funnel.
- In the **Control room** (GM only) add each player and send them their invite link. They stay
  signed in on that device.

### Docker

```bash
docker build -t traveller-ui .
docker run -p 8787:8787 -v traveller-data:/data -e GM_PASSWORD=choose-something traveller-ui
```

### Development

```bash
npm run dev        # server on :8787 with reload, web app on http://localhost:5173
npm test           # unit and end-to-end server tests
npm run typecheck
```

### Settings

Settings are environment variables, or lines in a `.env` file next to `package.json`
(see `.env.example`).

| Variable | Meaning |
| --- | --- |
| `PORT` | Port to listen on (default 8787) |
| `DATA_DIR` | Folder for the campaign database and uploads (default `data`) |
| `GM_PASSWORD` | Pre-set GM passphrase; skips the first-run setup screen |
| `WIKI_DIR` | Path of a Chronicler vault folder on this machine |
| `WIKI_REPO`, `WIKI_BRANCH`, `WIKI_TOKEN` | GitHub repository holding the vault, its branch (default `main`) and an access token |
| `WIKI_POLL_SECONDS` | How often GitHub is checked for changes (default 60) |
| `WIKI_ATLAS_FOLDER` | Vault folder for pages the app creates (default `Atlas`) |
| `RULEPACK_DIR` | Folder of rules packs (default `rulepacks`) |

The whole campaign is one SQLite file in `DATA_DIR`. The Control room can download a backup
(one JSON file) and restore from one.

## What players know

Every piece of information starts **hidden**. The GM reveals it either to the **party** or to a
single **player**, and can take it back.

- Systems and bodies have levels: *Hidden* → *Detected* (something is there) → *Charted* (name and
  survey data). Each facet can also be set separately.
- Notes and wiki sections are revealed one at a time.
- Redaction happens on the server. Hidden data is never sent to a player's browser, so it cannot
  be found by inspecting the page.
- In the app, **violet** always marks GM-only material and **cyan** marks what players can see.
- "Player view" in the top bar shows the GM exactly what the party, or one named player, sees.

## The Chronicler wiki

The app treats a [Chronicler](https://chronicler.pro) vault as the campaign's long-form memory.

**Connect it** with `WIKI_DIR` (the vault folder, if the server runs on the same computer as
Chronicler; changes appear in both within a second) or `WIKI_REPO` + `WIKI_TOKEN` (the vault's
GitHub repository; you push and pull the vault with git as usual).

**Wiki → app**

- Every page appears in the app's Library. Players see nothing until the GM reveals a section.
- Sections under a heading that starts with `GM`, `Referee` or `Secret` can never be revealed.
- `||spoiler||` text stays hidden unless the GM allows spoilers for that section.
- `players: true` in a page's infobox reveals the page to the party as soon as it arrives.
- A page is attached to a map entry by the `ref` key in its infobox (the app writes this), so the
  link survives renaming or moving the page.
- A new page with `type: system`, `sector`, `hex` and `uwp` in its infobox creates that system on
  the map.
- Editing a system page's infobox (`title`, `uwp`, `bases`, `travel_zone`, `pbg`, `allegiance`,
  `stars`, `hex`) updates the map. If both sides changed the same value, the wiki wins.

**App → wiki**

- Systems that are imported, generated or created by hand get a page under
  `Atlas/<Sector>/<Subsector>/<System>.md` (this can be switched off in the Control room).
- Later changes in the app update only the infobox keys the app manages. Your text, your own
  infobox keys and comments are left alone.
- Any system, world or point of interest can be given a page, or attached to an existing page,
  from its Write-ups panel.

## Importing sectors

In the map, open **Sectors → Import data** and paste what your generator gives you, or load the
file. The format is detected automatically and previewed before anything is saved:

- Second Survey tab-delimited or column-delimited files
- Legacy `.sec` files
- JSON world lists and CSV with a header row
- Plain lists where each line has a four-digit hex and a world profile such as `C8759A9-8`
- Sector metadata (subsector names and routes) in comment headers, MSEC lines or XML

Subsector-sized data (hexes 0101–0810) can be dropped into any of a sector's sixteen subsectors.

## Rules packs

The engines in this repository are generic. The tables, prices and thresholds that come from a
rulebook live in JSON **rules packs** under `rulepacks/`, loaded when the server starts. Packs are
layered, so house rules or a supplement only need to list what they add or change. See
`rulepacks/README.md`.

Without a pack the app still runs, but world profiles are shown undecoded and random generation
is unavailable.

## For developers

```
src/shared   Types, hex maths, parsers, knowledge rules, route planning (used by both sides)
src/server   Node server: storage, sign-in, sync hub, actions, wiki sync
src/web      React app
rulepacks    Rule tables as data
tests        Vitest: unit tests plus end-to-end tests that run the real server
```

- Clients change the campaign only through **actions** (`src/server/actions`). Each action checks
  who is asking, validates its input and edits state in a transaction.
- After every change the **hub** works out, per connection, how that viewer's redacted picture
  changed and sends only that difference.
- What a viewer may see is decided in one place: `src/shared/knowledge.ts`.

Traveller is a trademark of Mongoose Publishing. This is an unofficial fan-made tool and is not
affiliated with or endorsed by Mongoose Publishing.
