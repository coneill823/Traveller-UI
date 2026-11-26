# Rules packs

The app's engines are generic. Every table, price and threshold that comes from a rulebook is
kept in JSON "rules packs" and loaded when the server starts.

**This folder is deliberately empty in the public repository.** Tables transcribed from a rulebook
belong somewhere private: either drop pack folders in here on the machine that runs the server
(`.gitignore` keeps them out of commits), or keep them in your wiki vault under
`.traveller-ui/rulepacks/`, which the server reads as well.

## Layout

- Each sub-folder is one pack. `pack.json` names it (`id`, `name`, optional `version` and `note`);
  every other `*.json` file contributes one section, named after the file.
- Packs are layered: first the folders here in alphabetical order, then those in the wiki vault.
  A later pack only needs to list what it adds or changes. Lists whose rows carry an `id` or a
  `code` are merged row by row on that key; other lists are replaced whole.
- A pack that must come after another, whatever the folders are called, names it in `pack.json`:
  `"after": ["the-other-pack-id"]`. It is then layered straight after the packs it names. Names of
  packs that are not installed are ignored.
- To add house rules or a supplement, create a new folder (for example `zz-house-rules`) with a
  `pack.json` and only the sections you want to override.

## Sections

| File | Section | Used for |
| --- | --- | --- |
| `world.json` | `world` | World profile digits, starports, bases, trade codes, world and star generation; under `system`, the tables for building a whole star system; under `detail`, those for working each of its worlds out; under `society`, those for the people of a world |
| `tasks.json` | `tasks` | Difficulties, effect bands, characteristic modifiers |
| `characters.json` | `characters` | Characteristics (optional ones included), skills and specialities, species, careers, quick-creation packages |
| `gear.json` | `gear` | Personal weapons, armour and weapon traits; other equipment, special ammunition, and the rules for finding and buying things |
| `combat.json` | `combat` | Personal combat: actions, range bands, modifiers, cover, damage |
| `trade.json` | `trade` | Trade goods, price table, passengers, freight |
| `ships.json` | `ships` | Hulls, armour, drives, power plants, bridges, computers, sensors, software, weapons and mounts, fittings, crew, shipyards and stock designs |
| `space.json` | `space` | Space combat: range bands, crew duties and their actions, attack modifiers, critical hit locations and effects, missiles |
| `reference.json` | `reference` | Rule summaries and tables for the Library's Rules tab |

The exact shape of every section is documented by the TypeScript types in
`src/shared/rulepack.ts`. A section that is missing simply switches off the features that need it.

## Characters

- `characteristics` lists them in the order a sheet shows them. One marked `"optional": true` is on
  a sheet only once it has been added there. `start` is the score it is added with: a number, or the
  id of another characteristic to copy; without it, 7. `note` is shown as a hint.
- `skills` and `careers` have no ids, so a pack that adds to either gives the whole list.
- `packages` are ready-made backgrounds and careers:

  ```json
  { "id": "islander", "kind": "background", "name": "Islander",
    "mods": { "STR": 1, "EDU": -1 },
    "skills": { "Sailing": 1, "Fishing": 0, "Ropework (any)": 1 },
    "credits": 150, "benefits": ["A boat"], "note": "Grew up on the water" }
  ```

  `kind` is `background` or `career`; a career may give a `rank`. A skill named loosely (with "any",
  "another", "suitable" or "or" in it) is offered to the player to settle.
- `packageRules` holds every figure for applying them: `skillCap` (how high stacking can take a
  skill), `charMin` and `charMax` (bounds on characteristic changes), `backgroundAge` (the age a
  background brings a character to), `careerYears` (a formula for the years a career adds) and
  `termYears` (for counting those years as terms). Leave one out and that limit or change is not made.

## The rules reference

`reference.json` holds `{ "topics": [...] }`. Topics are merged by `id`, so several packs can add to
the list and one can rewrite another's topic.

```json
{ "id": "house-weather", "title": "Weather at sea", "group": "Voyages",
  "source": "House rules", "optional": true,
  "text": ["Roll each morning.", "A storm doubles the time a crossing takes."],
  "tables": [
    { "id": "sky", "title": "The sky", "roll": "2D + DM",
      "columns": ["2D", "Sky", "Wind"],
      "rows": [
        { "on": "4-",   "cells": ["Storm", "Gale"] },
        { "on": "5-8",  "cells": ["Cloud", "Fresh"] },
        { "on": "9-11", "cells": ["Fair", "Light"] },
        { "on": "12+",  "cells": ["Dead calm", "None"] } ] },
    { "id": "stores", "columns": ["Store", "Lasts"],
      "rows": [ { "cells": ["Biscuit", "A year"] }, { "cells": ["Fruit", "A week"] } ] } ] }
```

- `group` is the heading the topic is filed under. `text` is a list of paragraphs.
- A table with a `roll` can be rolled on from the page. The roll is on six-sided dice: `2D`, `1D`,
  `3D - 2`, `D3`, `D66`, with `+ DM` where a modifier from the situation is added. The first heading
  is then the roll's, and each row says in `on` which results it covers: `7`, `3-4`, `11+`, `2-`
  (2 or less), or several separated by commas. Each row has one cell fewer than there are headings.
- Every result the dice alone can give must land on exactly one row. The tests check this for the
  installed packs.
- A table without a `roll` is a plain table: one cell for each heading, and no `on`.

## Star systems and formulas

`world.json` may carry a `system` object with what is needed to build a star system in detail: the
distance of each orbit number, star tables by type and class, the columns the dice are read
against, the modifiers that apply to each roll (`dm`) and a set of named figures and formulas
(`f`). The procedure is in `src/shared/rules/system.ts`, which holds no figures of its own; its
header lists the names a formula can use, and it says which name is missing if a pack leaves one
out. `tests/fixtures/systemRules.ts` is a complete, made-up example.

A `detail` object beside it holds what is needed to work each world out: makeup and density,
moons and rings, atmosphere codes with their subtypes, taints and gas mixes, water, days and tidal
locks, climate, geology, life, and the ratings for resources and habitability. Its procedure is in
`src/shared/rules/worlddetail.ts`, and `tests/fixtures/detailRules.ts` is a made-up example. A pack
may carry `system` without `detail`: the survey then stops at orbits and sizes.

A `society` object holds what describes the people of a mainworld: population and cities,
the make-up of government and its factions, courts and the branches of law, technology field by
field, cultural traits, the economy and the port, and the rules for lesser settlements elsewhere in
the system. Its procedure is in `src/shared/rules/society.ts`, with `tests/fixtures/societyRules.ts`
as a made-up example.

Formulas and conditions are written as text, so a pack states how a figure is worked out rather
than only listing values:

| Written | Means |
| --- | --- |
| `2D`, `1D`, `D3`, `d10`, `3D6` | dice; a lone `D` is one six-sided die |
| `+ - * / ^`, and `x` or `×` for multiplying | arithmetic |
| `min max floor ceil round abs sqrt ln pow sin cos` | functions, as in `max(1, N)`; angles are in degrees |
| `< <= > >= == !=`, `and`, `or`, `not` | conditions, which give 1 or 0 |
| any other name | a value the engine supplies, such as `stars` or `age`; names may contain dots |

A modifier row reads `{ "when": "stars >= 3", "dm": -1 }`, with an optional `"times"` formula for
modifiers that count once per something. Because a lone `D` is a die, no value is called `D`.

## Adding equipment

`gear.json` can list more than weapons and armour. `equipment` holds everything else, each entry
with a `group` (and optionally a `section`) to file it under, a tech level, mass, price and a line
on what it does. Where a price or mass is not a plain figure, say so in `costNote` or `kgNote`.
`kind` marks augments, software, modifications, consumables and ammunition. For example:

```json
{
  "equipment": [
    { "id": "storm-lantern", "name": "Storm Lantern", "group": "Survival gear", "tl": 5, "kg": 1, "cost": 30, "effect": "Stays lit in any weather." }
  ]
}
```

The same file can carry:

- `availability`: the check for finding an item and what a world adds to it (tech level gap,
  starport, population, trade codes), circumstances to tick, and the black market's law level
  modifiers, price multiples and result tables.
- `variants`: prototypes and older designs built at a higher tech level, as multiples of cost and mass.
- Ammunition entries with an `ammo` block saying how they change the weapon that fires them
  (range, damage dice, armour piercing, blast, traits). Weapons say which they take with `ammoClass`.
- `reference`: short rules to keep at hand on the catalogue's **Buying rules** tab.

Armour may give `str` and `dex` changes while worn, a `skill` it needs, `slots` for modifications
and a `versus` line for protection that only counts against some attacks.

## Adding a ship part or a stock design

A fitting in `ships.json` says how it is sized and what it costs; the design engine does the rest.
The sizes are `unit` (so many of a fixed size), `tons` (a tonnage you choose), `hull` (a share of
the hull), `docking` and `capacity` (sized from what it serves: a craft, a cargo, a drop tank) and
`plant` (a share of the power plant). Fittings can also take hardpoints, need gunners, add
protection, generate or store power, exclude one another and be limited to hulls of a certain size. For example, a supplement could add:

```json
{
  "fittings": [
    { "id": "briefingRoom", "name": "Briefing room", "group": "systems", "size": "unit", "unitTons": 4, "unitCost": 500000, "note": "DM+1 to Tactics checks made with planning time." }
  ]
}
```

A supplement pack can go a good deal further without any change to the app: new hull forms
(with armour multipliers, or only part of their tonnage usable), hull types, armour priced per ton,
reaction drives, drive and fuel-tank options, power plants with their own fuel appetite, computer
cores, bridge, sensor and mount options, bays and spinal mounts, grades of build quality with
advantages and drawbacks, and a fuller crew table for large and military ships. All of it is
described field by field in `src/shared/rulepack.ts`.

Stock designs are lists of parts in the same form the yard uses, so a design saved from the app
can be turned into a stock design by copying its parts.
