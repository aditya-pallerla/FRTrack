# Kolhapur Flood Response — Local Disaster Warning & Response Coordination

HackMatrix 5.0 · MISC-04 · Study area: **Kolhapur District, Maharashtra** · Primary hazard: **Flood**

A decision-support prototype that turns rainfall, terrain and ground reports into explained flood
warnings for 587 settlements, checks which roads still work, ranks where help is needed first, and
proposes units with valid road routes — recalculating everything when conditions change.
**AI recommends; a coordinator decides.** Nothing is dispatched automatically.

Full methodology, results and demo script: [docs/PROJECT_DOCUMENTATION.md](docs/PROJECT_DOCUMENTATION.md) ·
Data sources and licences: [data/SOURCES.md](data/SOURCES.md)

## Run it
```bash
npm install
npm run dev
```
Open http://localhost:5173. The Kolhapur dataset is already built in `data/kolhapur/`
(rebuild from the source APIs with `npm run data:all`, ~15 minutes, needs internet).

Local demo accounts (created on first start; override with `SEED_ADMIN_PASSWORD`, `SEED_COORDINATOR_PASSWORD`,
`SEED_FIELD_PASSWORD`, and set `SESSION_SECRET` for any shared deployment):

| Role | Username | Password |
|---|---|---|
| Admin (can switch LIVE/REPLAY) | `admin` | `Admin@12345` |
| Coordinator | `coordinator` | `Coord@12345` |
| Field unit | `field` | `Field@12345` |

Public citizen page (no login): http://localhost:5173/public

Optional: `GEMINI_API_KEY` in `.env` enables Gemini extraction of free-text reports; without it the
deterministic English/Hindi/Marathi keyword extractor is used.

## Commands
| Command | What it does |
|---|---|
| `npm run dev` | API (:3001) + web (:5173) |
| `npm test` | All test suites (engine, routing, allocation, storage / live-replay separation) |
| `npm run eval:warnings` | False-alert evaluation → `server/results/warning-evaluation/results.json` |
| `npm run eval:route-validity` | Route validity under disruption → `server/results/route-validity/results.json` |
| `npm run replay:check` | Runs the replay twice headless and confirms identical results |
| `npm run typecheck` / `npm run build` | Type-check / production build |
| `npm run data:all` | Re-fetch OSM, DEM elevation and ERA5 rainfall and rebuild the dataset |

## Data policy
- Every observation carries a mode: `live`, `replay` (historical, **original timestamps kept**) or
  `synthetic_scenario` (team-written, clearly labelled). Replay data is never shown as live.
- Missing data is reported as a data gap, never invented.
