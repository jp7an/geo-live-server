// scripts/fetch-cities-from-wikidata.mjs
// Node 18+ required (inbyggd fetch)
// Kör: node scripts/fetch-cities-from-wikidata.mjs
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.join(process.cwd(), 'data');
const OUT_FILE = path.join(OUT_DIR, 'cities.json');

// --- Hjälpfunktion: robust kontinentmappning via landkod ----------
const CONTINENT_BY_ISO2 = {
  // EUROPE (urval, lista kan utökas – Wikidata-land kodas i svar)
  AL:'EUROPE', AD:'EUROPE', AT:'EUROPE', BY:'EUROPE', BE:'EUROPE', BA:'EUROPE',
  BG:'EUROPE', HR:'EUROPE', CY:'EUROPE', CZ:'EUROPE', DK:'EUROPE', EE:'EUROPE',
  FI:'EUROPE', FR:'EUROPE', DE:'EUROPE', GR:'EUROPE', HU:'EUROPE', IS:'EUROPE',
  IE:'EUROPE', IT:'EUROPE', LV:'EUROPE', LI:'EUROPE', LT:'EUROPE', LU:'EUROPE',
  MT:'EUROPE', MD:'EUROPE', MC:'EUROPE', ME:'EUROPE', NL:'EUROPE', MK:'EUROPE',
  NO:'EUROPE', PL:'EUROPE', PT:'EUROPE', RO:'EUROPE', RU:'EUROPE', SM:'EUROPE',
  RS:'EUROPE', SK:'EUROPE', SI:'EUROPE', ES:'EUROPE', SE:'EUROPE', CH:'EUROPE',
  UA:'EUROPE', GB:'EUROPE', VA:'EUROPE',

  // NORTH AMERICA (def: USA, Kanada, Mexiko, Centralamerika, Karibien)
  US:'NORTH_AMERICA', CA:'NORTH_AMERICA', MX:'NORTH_AMERICA',
  GT:'NORTH_AMERICA', BZ:'NORTH_AMERICA', SV:'NORTH_AMERICA', HN:'NORTH_AMERICA',
  NI:'NORTH_AMERICA', CR:'NORTH_AMERICA', PA:'NORTH_AMERICA',
  CU:'NORTH_AMERICA', DO:'NORTH_AMERICA', HT:'NORTH_AMERICA', JM:'NORTH_AMERICA',
  TT:'NORTH_AMERICA', BB:'NORTH_AMERICA', BS:'NORTH_AMERICA', AG:'NORTH_AMERICA',
  DM:'NORTH_AMERICA', GD:'NORTH_AMERICA', KN:'NORTH_AMERICA', LC:'NORTH_AMERICA',
  VC:'NORTH_AMERICA', TT:'NORTH_AMERICA', // m.fl. karibiska ö-länder

  // Allt annat -> OTHER
};

function mapContinent(iso2) {
  if (!iso2) return 'OTHER';
  return CONTINENT_BY_ISO2[iso2.toUpperCase()] || 'OTHER';
}

// --- SPARQL: city (Q515), population >= 500000, koordinater, land, ISO2 ----
const SPARQL = `
SELECT ?city ?cityLabel ?population ?coord ?country ?iso2 WHERE {
  ?city wdt:P31/wdt:P279* wd:Q515.
  ?city wdt:P1082 ?population.
  FILTER(?population >= 500000)

  ?city wdt:P625 ?coord.
  ?city wdt:P17 ?country.
  OPTIONAL { ?country wdt:P297 ?iso2. }  # ISO 3166-1 alpha-2
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`;

async function queryWikidata() {
  const url = 'https://query.wikidata.org/sparql';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/sparql-results+json',
      'Content-Type': 'application/sparql-query'
    },
    body: SPARQL
  });
  if (!res.ok) {
    throw new Error(`Wikidata query failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function parsePoint(wktPoint) {
  // WKT "Point(long lat)"
  // exempel: "Point(-0.1275 51.507222)"
  const m = /Point\\(([-0-9\\.]+)\\s+([-0-9\\.]+)\\)/.exec(wktPoint);
  if (!m) return null;
  return { lng: Number(m[1]), lat: Number(m[2]) };
}

function normalize(items) {
  const seen = new Set();
  const out = [];
  for (const b of items) {
    const name = b.cityLabel?.value?.trim();
    const population = Number(b.population?.value || 0);
    const coord = b.coord?.value ? parsePoint(b.coord.value) : null;
    const iso2 = b.iso2?.value?.trim() || null;

    if (!name || !coord) continue;
    const key = `${name}|${coord.lat.toFixed(4)}|${coord.lng.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      name,
      lat: coord.lat,
      lng: coord.lng,
      population,
      iso2,
      continent: mapContinent(iso2)
    });
  }
  // Filtrera igen för säkerhets skull
  return out.filter(x => x.population >= 500000 && isFinite(x.lat) && isFinite(x.lng));
}

async function main() {
  console.log('> Querying Wikidata (this can take ~5–15s)...');
  const json = await queryWikidata();
  const items = json.results?.bindings || [];
  const cities = normalize(items);

  // Bas-rapport
  const counts = cities.reduce((acc, c) => {
    acc[c.continent] = (acc[c.continent] || 0) + 1;
    return acc;
  }, {});
  console.log('> Cities collected:', cities.length, counts);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(cities, null, 2));
  console.log('> Wrote', OUT_FILE);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

