# Traveller Campaign Console

A shared, live campaign tool for the **Traveller** tabletop RPG (Mongoose 2nd edition, Core
Rulebook Update 2022). The GM builds the universe in **creator mode**; players connect from
their own devices and see only what their characters know.

Everyone is connected to the same campaign at once: when the GM or a player changes something,
every other screen updates within a moment.

## What is in it

| Screen | What it does |
| --- | --- |
| **Map** | The universe in the classic hex style, zooming from universe to sector, subsector, system and world. Add and place sectors, roll or place systems, draw routes, import from generators. Detailed surveys that work out every star, world and moon of a system. Route planner for jump rating, fuel, refuelling and travel zones. |
| **Crew** | Character sheets for travellers, NPCs and creatures: characteristics, skills, weapons and armour, with one-click checks, attacks and damage. Rolls can be made in the app or typed in from the table. |
| **Combat** | Encounters with the opposition in initiative order along the top and the party along the bottom, an uploadable battlemap with draggable tokens, turns put together on an action bar and published to everyone as an animated replay. |
| **Cargo** | Personal kit, ship's lockers and cargo holds for any number of people and ships; search, move things between holders, pay from personal credits or the ship's account. A catalogue of everything the rules packs list, with how hard each thing is to find on the world you are on. |
| **Trade** | What is for sale here, on the world or in orbit, and around the system. Broker negotiations, freight, passengers, and trade leads about other systems that the GM hands out one at a time. |
| **Ship** | The ship's status board: damage and faults flash on the hull plan, with systems, alerts and crew stations. Battle stations for space combat, where each crew member queues their station's actions and the ship acts as one. |
| **Yard** | Ship design: start from a stock design or a bare hull, drag parts onto a hologram of the hull, see tonnage, power, cost and crew as you go, show the draft to the party, collect sign-off and commission it at the starport you are docked at. |
| **Goals** | Objectives for the party and private ones per player, tied to places on the map. |
| **Library** | Every page of the Chronicler wiki, revealed to players section by section. |
| **Control** (GM) | Players and invite links, the campaign date, backups, wiki settings. |

Across all of it:

- **Live for everyone.** One shared campaign; a change on one screen reaches every other within a moment.
- **The GM decides what players know.** Everything starts hidden and is revealed to the party or to one player.
- **Shared dice** with boon and bane, hidden GM rolls and "rolled at the table" entry.
- **Chronicler wiki sync in both directions**, from a vault folder or a GitHub repository.

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
```

```bash
docker run -p 8787:8787 -v traveller-data:/data -e GM_PASSWORD=choose-something -e WIKI_REPO=your-name/Traveller-Campaign -e WIKI_TOKEN=github_pat_... traveller-ui
```

With `WIKI_REPO` set the container fetches the wiki and any rules packs kept beside it. To use
packs from a folder instead, add `-v /path/to/rulepacks:/app/rulepacks`.

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
| `RULEPACK_DIR` | Folder of rules packs (default `rulepacks`). Packs in the wiki vault's `.traveller-ui/rulepacks` folder are loaded as well |

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

## Using the tools

### Star systems

- A system on the map starts as a chart: its stars, mainworld, gas giants and belts, as its listing gives them.
- Where the installed rules packs carry tables for building whole systems, the GM's **Detailed survey** in the system view works out the rest: each star's mass, size, heat and light; where the other stars orbit; which orbits are left open to worlds; and every world and moon, with its distance, its year and where it sits against the habitable zone.
- With tables for it, the survey also works each world, moon and belt out in detail: its true diameter, what it is made of and its gravity; its air (pressure, oxygen, taints, or what kind of unbreathable it is and what gases fill it) and its seas; the length of its day, its tilt and whether tides have locked it; mean, highest and lowest temperatures; how restless its ground is; any native life; and ratings for resources and habitability. Moons get their distance and month, rings their span, belts their makeup and largest bodies. It is all on the body's panel in the system view.
- An inhabited mainworld also gets its people in depth on the system's panel: their number, how gathered they are and their largest cities; how the government is put together and which factions stand against it; the courts and what each branch of law allows; technology field by field; cultural traits; the economy (importance, product, trade number, inequality, tariffs) and the port's shipping. This **Society** part is kept from players until you reveal it, separately from the survey. Other worlds of a crowded system may have settlements of their own, shown on their panels with what each is there for.
- The survey is built around the listing. The stars, the number of gas giants and belts and the mainworld stay as they are, and a mainworld with air to breathe is put where its climate is found. The mainworld keeps the size, air and water of its profile. A system with no listing gets its stars and counts from the dice, and the world easiest to live on stands as its mainworld.
- The mainworld keeps its record through a survey, with its notes and everything placed on it. **Survey again** rolls a different system; **Rebuild from survey** goes back to the plain chart.
- Players who have had the system charted keep what the chart showed them. The other worlds and the moons stay hidden until you reveal them one at a time, or all together with **Share the full survey**.
- New systems rolled on the map take their stars, and their counts of gas giants, belts and worlds, from the same tables.

### Combat

1. The GM creates an encounter on the **Combat** screen. The party's characters are placed on the field; **Add NPC** makes up opponents on the spot or pulls them from the cast, optionally hidden until they act.
2. **Battlemap** uploads any image. Say how many squares it is across and distances are shown in metres.
3. Everyone drags their own token into place (the GM can move anyone), initiative is rolled or typed in, and the GM presses **Start**.
4. On your turn, drag actions from the palette into the bar in the order you take them, tick each off as it is resolved at the table and note the rolls. Rolls made from the character sheet while planning are picked up automatically. Dragging your token plans a move.
5. **Publish turn** shows everyone what you did as a replay, moves your token, takes damage off the target through its armour and passes play on. Earlier turns can be replayed from the log.

Players see an NPC only once it is in the encounter, and then only its name and a rough state of health unless the GM reveals more.

### Shopping

- **Add** on the **Cargo** screen opens the catalogue: weapons, armour and every other piece of equipment the installed rules packs list, searchable and filtered by section or tech level. **Add** records an item; **Buy** also takes its price from the traveller's credits or the ship's account.
- The catalogue knows which world the party is on. Each line shows the modifier for finding the item there (tech level, starport, population, trade codes); tick what else applies, such as paying over the odds, or switch to the black market, where the law level counts and prices multiply. Click the modifier to roll the check for the traveller you are buying for.
- Equipment can be bought as a prototype, or as an older design built at a higher tech level, where the rules allow it. **Buying rules** keeps the tables to hand.
- Weapons and armour bought with **Also put it on the sheet** are ready to use. Armour that needs a skill, or that lends strength, shows in every check made while it is worn. A weapon that takes special ammunition has a **Loaded with** choice on the sheet, and attacks and damage follow what is loaded.

### The ship

- On the **Ship** screen each player puts their character at a station (pilot, captain, engineer, sensors, gunner at a particular turret, marine).
- The GM's **Simulate attack** takes an attack roll and damage, works out what gets through the armour, any critical hit and its severity, and the extra damage for every tenth of the hull lost. **System fault** breaks something without a shot being fired. Both light up on the hull plan for the whole crew.
- **Battle stations**: the GM adds the other ships and their ranges. Each round has three steps (manoeuvre, attack, actions), with ships acting in initiative order. Every crew member adds their station's actions to the ship's shared plan, with the rolls; **Carry out step** resolves them together. Range changes, missile salvos in flight, sensor locks, countermeasures, repairs and the captain's initiative bonus are tracked for you.
- Players see other ships as a name, a range band and a rough condition.

### The yard

- **New design** starts from one of the stock designs or a bare hull. Parts that the design still needs are marked; parts that do not fit, need a higher tech level or cannot be supplied by the starport you are docked at are locked with the reason.
- Drag parts onto the hull or click them; drag blocks along the hull to rearrange. Hull outlines can be one of the built-in shapes, SVG path data pasted in or an `.svg` file, or a picture of a silhouette.
- Drafts are private until you **Show the party**. **Ask for sign-off** puts the design to the other players; when all have signed (or the GM signs for the table) it can be commissioned, paid from a ship's account or a traveller's credits. Changing a design after sign-off asks everyone again.
- Stock designs are ten per cent cheaper while they are built unchanged. Existing ships can be refitted for the difference in cost.

## Rules packs

The engines in this repository are generic. The tables, prices and thresholds that come from a
rulebook live in JSON **rules packs**, loaded when the server starts. Packs are layered, so house
rules or a supplement only need to list what they add or change. See `rulepacks/README.md` for
the format.

**Rule tables transcribed from a rulebook are not part of this repository.** Keep them somewhere
private. The server looks in two places:

1. `RULEPACK_DIR` (default `rulepacks/` beside the app), one folder per pack.
2. The wiki vault, in the hidden folder `.traveller-ui/rulepacks/`. With `WIKI_DIR` the folder is
   read in place; with `WIKI_REPO` it is fetched from the repository each time the server starts.
   The wiki sync ignores hidden folders, so the pack never shows up as wiki pages.

The second option means a private campaign repository can carry both the wiki and the rules data,
and a server only needs the two wiki settings to have everything.

Without a pack the app still runs, but world profiles are shown undecoded and the trade tables,
ship parts, combat actions and critical hit tables are empty.

## For developers

```
src/shared   Types, hex maths, parsers, knowledge rules, route planning, rules engines (used by both sides)
src/server   Node server: storage, sign-in, sync hub, actions, wiki sync
src/web      React app, one folder per screen under src/web/modules
rulepacks    Rule tables as data (format notes only; the tables themselves are kept private)
tests        Vitest: unit tests plus end-to-end tests that run the real server
```

- Clients change the campaign only through **actions** (`src/server/actions`). Each action checks
  who is asking, validates its input and edits state in a transaction.
- After every change the **hub** works out, per connection, how that viewer's redacted picture
  changed and sends only that difference.
- What a viewer may see is decided in one place: `src/shared/knowledge.ts`.
- Rules engines (`src/shared/rules`) take a rules pack and plain data and return plain data, so
  they run the same on the server and in the browser and are easy to test.
- Tests that need rule tables skip themselves when no pack is present.

Traveller is a trademark of Mongoose Publishing. This is an unofficial fan-made tool and is not
affiliated with or endorsed by Mongoose Publishing.
