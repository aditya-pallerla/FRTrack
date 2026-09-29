/**
 * Step 1 — OpenStreetMap extract for Kolhapur district via the Overpass API (run once, cached to data/raw).
 * Licence: © OpenStreetMap contributors, ODbL 1.0 — attribution required, derived data stays ODbL.
 *
 *   npm run data:osm            (OVERPASS_URL overrides the endpoint)
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RAW, fetchJson, loadJson, saveJson, sleep, type RawMeta } from './common.js';

const ENDPOINT = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';

/**
 * Kolhapur District boundary: OSM relation 1997163 (admin_level 5, name:en "Kolhapur District",
 * ref:LGD:district 480, wikidata Q1797312) — verified by Overpass lookup. Reused as the search area.
 */
const DISTRICT_RELATION = 1997163;
const AREA = `
rel(${DISTRICT_RELATION})->.district;
.district map_to_area->.kop;`;

const ROAD_CLASSES = '^(motorway|trunk|primary|secondary|tertiary|unclassified|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$';
const TILES = 4; // roads are fetched in TILES × TILES pieces so each request stays small

const QUERIES: Record<string, string> = {
  rivers: `[out:json][timeout:300];${AREA}
way(area.kop)["waterway"="river"];
out geom;`,
  places: `[out:json][timeout:300];${AREA}
node(area.kop)["place"~"^(city|town|village|suburb)$"];
out body;`,
  facilities: `[out:json][timeout:300];${AREA}
nwr(area.kop)["amenity"~"^(fire_station|police|hospital)$"];
out center tags;`,
  // River-level reference points (weirs) — located here; reference levels only from data/manual/gauges.json.
  gauges: `[out:json][timeout:180];${AREA}
nwr(area.kop)["name"~"Rajaram",i]["waterway"~"^(weir|dam)$"];
out center tags;`,
};

async function overpass(query: string) {
  return fetchJson<{ elements: { type: string; id: number; geometry?: { lat: number; lon: number }[] }[] }>(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: query }).toString(),
  }, 6);
}

const meta = (query: string): RawMeta => ({
  fetched_at: new Date().toISOString(), source: 'OpenStreetMap via Overpass API', url: ENDPOINT,
  licence: '© OpenStreetMap contributors, ODbL 1.0', query,
});

async function main() {
  const only = process.argv[2];
  const boundaryPath = join(RAW, 'osm-boundary.json');
  if (!existsSync(boundaryPath) || only === 'boundary') {
    console.log('Overpass: boundary …');
    const q = `[out:json][timeout:180];rel(${DISTRICT_RELATION});out geom;`;
    saveJson(boundaryPath, { meta: meta(q), elements: (await overpass(q)).elements });
  }

  if (!only || only === 'roads') {
    // Bounding box of the district from its boundary geometry.
    const rel = loadJson<{ elements: { members: { geometry?: { lat: number; lon: number }[] }[] }[] }>(boundaryPath).elements[0];
    const pts = rel.members.flatMap((m) => m.geometry ?? []);
    const s = Math.min(...pts.map((p) => p.lat)), n = Math.max(...pts.map((p) => p.lat));
    const w = Math.min(...pts.map((p) => p.lon)), e = Math.max(...pts.map((p) => p.lon));
    const byId = new Map<number, unknown>();
    for (let i = 0; i < TILES; i++) for (let j = 0; j < TILES; j++) {
      const bb = [s + ((n - s) * i) / TILES, w + ((e - w) * j) / TILES, s + ((n - s) * (i + 1)) / TILES, w + ((e - w) * (j + 1)) / TILES].map((x) => x.toFixed(5)).join(',');
      const q = `[out:json][timeout:300];${AREA}
way(area.kop)(${bb})["highway"~"${ROAD_CLASSES}"];
out geom;`;
      process.stdout.write(`Overpass: roads tile ${i * TILES + j + 1}/${TILES * TILES} … `);
      const res = await overpass(q);
      for (const el of res.elements) byId.set(el.id, el);
      console.log(`${res.elements.length} ways (total ${byId.size})`);
      await sleep(3000);
    }
    saveJson(join(RAW, 'osm-roads.json'), { meta: { ...meta(`tiled ${TILES}x${TILES}: way(area.kop)(bbox)["highway"~"${ROAD_CLASSES}"]; out geom;`) }, elements: [...byId.values()] });
  }

  for (const [name, query] of Object.entries(QUERIES)) {
    if (only && only !== name) continue;
    console.log(`Overpass: ${name} …`);
    const data = await overpass(query);
    console.log(`  ${data.elements.length} elements`);
    saveJson(join(RAW, `osm-${name}.json`), { meta: meta(query), elements: data.elements });
    await sleep(3000);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
