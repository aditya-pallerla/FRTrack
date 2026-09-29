# Data sources, licences and limitations

Every source below was fetched and checked on **29 Sep 2026** with the scripts in `scripts/data/`
(`npm run data:all`). Nothing in `data/kolhapur/` was typed in by hand except the files marked **manual**
or **scenario**.

| Data | Source | Licence | Coverage / resolution | Used for | Limitations |
|---|---|---|---|---|---|
| District boundary | OpenStreetMap relation **1997163** (Kolhapur District, `ref:LGD:district` 480, Wikidata Q1797312) via Overpass API | © OpenStreetMap contributors, ODbL 1.0 | District polygon | Study area, map | — |
| Roads | OSM `highway` motorway…unclassified (+links), 4,677 ways, split into **8,670 routable segments** (largest connected network; 97 disconnected segments dropped) | ODbL | Whole district | Road graph, routing, closures | Village tracks below `unclassified` are not included; OSM may be outdated in places |
| Rivers | OSM `waterway=river`, 72 ways (Panchganga, Krishna, Warna, Dudhganga, Vedganga, Bhogawati, Kasari, Kumbhi, Tulsi, Hiranyakeshi, …) | ODbL | Whole district | Distance-to-river, height-above-river, flood-prone roads | Smaller streams not included |
| Settlements | OSM `place` city/town/village/suburb nodes (777) → **587 in scope**: every city/town plus villages within 3 km of a mapped river | ODbL | Point per settlement | Warnings, priorities | Point location only (no village polygons) |
| Population | OSM `population` tag | ODbL | **15 of 587** settlements | Exposure | **572 settlements have unknown population**; shown as "unknown", never estimated. Census 2011 village tables not yet joined |
| Facilities | OSM `amenity` police (11) and hospital (256); **no fire stations are tagged in OSM for this district** | ODbL | Points | Locations of demo response bases | Capacities unknown |
| Terrain | **Copernicus DEM GLO-90** (~90 m) via the Open-Meteo Elevation API, 4,202 points (settlements, river samples every 500 m, road points near rivers) | Copernicus DEM © DLR e.V. / Airbus, Copernicus programme; Open-Meteo CC BY 4.0 | Point samples | Height above nearest river (HAND proxy), flood-prone roads | 90 m DEM is noisy for differences of a few metres |
| Historical rainfall | **Open-Meteo Historical Weather API — ERA5 reanalysis (0.25°)**, hourly, `models=era5` | CC BY 4.0 (Open-Meteo); ERA5 © ECMWF / C3S | 68 rain cells (0.1°) each filled from the nearest ERA5 grid point; replay events + Jun–Sep 2010–2023 | Replay, evaluation | **Reanalysis, not rain gauges.** ~28 km grid smooths extreme local rainfall (e.g. the short July 2021 burst). ERA5-Land was tried first but Open-Meteo returned no precipitation for this area (0/48 values), so ERA5 is used |
| Live rainfall | Open-Meteo Forecast API (`past_days=4`, completed hours only) | CC BY 4.0 | Same cells | LIVE mode | **Model nowcast, not gauge observation**; labelled so in the UI |
| River level | Rajaram weir gauge (Panchganga) — reference levels in `data/manual/gauges.json` (**manual**, 39 ft warning / 43 ft danger, `levels_verified: false`, citation pending) | — | — | Would be river-level evidence | **Not used yet**: the gauge could not be located in OSM and no cited level timeseries is bundled, so the UI shows "No river-level observation available" |
| Flood labels | `data/manual/flood-labels.json` (**manual**): Aug 2019 and Jul 2021 major floods, approximate dates | — | 2 events | Weak labels for `eval:warnings` | Smaller floods unlabelled; dates approximate — must be checked against district records |
| Replay scenario | `data/kolhapur/replay/kop-2019-08/scenario.json` (**scenario**, team-written) | — | 13 ground reports, closures of real OSM roads/bridges | Demo | **All reports and closures are SYNTHETIC SCENARIO inputs**, labelled everywhere in the UI. Places and roads are referenced by name or real OSM way id, never by invented coordinates |
| Response units | `data/kolhapur/units.json` (derived) | — | 22 units | Allocation demo | **Synthetic demo fleet** (not a real fleet) placed at real OSM police stations and hospitals |

## Thresholds
- 24-hour rainfall: **IMD rainfall-intensity categories** (heavy ≥ 64.5 mm, very heavy ≥ 115.6 mm, extremely heavy ≥ 204.5 mm). These are rainfall categories, **not official flood thresholds**.
- 1 h / 3 h / 6 h / 72 h thresholds, terrain, confidence and priority weights: **prototype values** in `server/src/engine/config.ts`, each labelled "prototype".

## Replay event selection (from the data)
ERA5 daily means across the district's cells:
- **Aug 2019:** sustained build-up 22 → 42 → 96 → 96 → 67 mm/day (1–7 Aug); Ghats cells reached **165–207 mm / 24 h** on 5 Aug.
- **Jul 2021:** peaks of 48–55 mm/day; ERA5 smooths the short extreme burst.

August 2019 was chosen because the usable public data shows the event clearly.
