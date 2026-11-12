// Controle 12 nov: handmatig gestart via wijziging.
// Haalt de Belgische day-ahead kwartierprijzen (EUR/MWh) op voor vandaag en morgen
// en bewaart ze in data/prices.json. Draait automatisch via GitHub Actions.
// Bron 1: energy-charts.info (Fraunhofer ISE, geen sleutel nodig).
// Bron 2 (reserve, enkel als ENTSOE_TOKEN is ingesteld): ENTSO-E Transparency Platform.
import { readFileSync, writeFileSync } from "node:fs";

const TZ = "Europe/Brussels";
const OUT = new URL("../data/prices.json", import.meta.url);
const Q = 900; // seconden per kwartier

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
export const bxlDate = (unix) => dayFmt.format(new Date(unix * 1000));
const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const round2 = (v) => Math.round(v * 100) / 100;

// Zet een lijst [unix, prijs] om naar volledige kwartieren per Brusselse dag.
export function toDays(points, wanted) {
  points = points.filter((p) => p[1] != null && isFinite(p[1])).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const [t, p] = points[i];
    const next = i + 1 < points.length ? points[i + 1][0] : null;
    const prev = i > 0 ? points[i - 1][0] : null;
    let step = next != null ? next - t : prev != null ? t - prev : Q;
    if (step > 3600) step = prev != null && t - prev <= 3600 ? t - prev : Q; // gat in de reeks: niet opvullen
    const n = Math.max(1, Math.round(step / Q));
    for (let k = 0; k < n; k++) out.push([t + k * Q, round2(p)]);
  }
  const days = {};
  for (const [t, p] of out) {
    const d = bxlDate(t);
    if (!wanted.includes(d)) continue;
    (days[d] ||= []).push([t, p]);
  }
  // Een dag telt enkel mee als hij volledig is (92, 96 of 100 kwartieren, zonder gaten).
  for (const d of Object.keys(days)) {
    const s = days[d];
    const gapless = s.every((x, i) => i === 0 || x[0] - s[i - 1][0] === Q);
    const startsAtMidnight = bxlDate(s[0][0] - Q) !== d;
    const endsAtMidnight = bxlDate(s[s.length - 1][0] + Q) !== d;
    if (!(gapless && startsAtMidnight && endsAtMidnight && s.length >= 92 && s.length <= 100)) delete days[d];
  }
  return days;
}

export function parseEnergyCharts(j) {
  if (!j || !Array.isArray(j.unix_seconds) || !Array.isArray(j.price)) throw new Error("energy-charts: onverwacht formaat");
  if (j.unit && !/EUR\s*\/\s*MWh/i.test(j.unit)) throw new Error("energy-charts: onverwachte eenheid " + j.unit);
  return j.unix_seconds.map((t, i) => [t, j.price[i]]);
}

// ENTSO-E geeft XML met TimeSeries > Period > Point. Bij curveType A03 worden
// herhaalde waarden weggelaten: die vullen we aan met de vorige waarde.
export function parseEntsoe(xml) {
  const best = new Map(); // unix -> [resolutie, prijs]; fijnste resolutie wint
  for (const per of xml.match(/<Period>[\s\S]*?<\/Period>/g) || []) {
    const start = Date.parse((per.match(/<start>([^<]+)<\/start>/) || [])[1]) / 1000;
    const end = Date.parse((per.match(/<end>([^<]+)<\/end>/) || [])[1]) / 1000;
    const res = (per.match(/<resolution>PT(\d+)M<\/resolution>/) || [])[1];
    if (!isFinite(start) || !isFinite(end) || !res) continue;
    const step = +res * 60, n = Math.round((end - start) / step), vals = new Array(n).fill(null);
    for (const m of per.matchAll(/<Point>\s*<position>(\d+)<\/position>\s*<price\.amount>([-\d.]+)<\/price\.amount>/g)) vals[+m[1] - 1] = +m[2];
    for (let i = 1; i < n; i++) if (vals[i] == null) vals[i] = vals[i - 1];
    for (let i = 0; i < n; i++) {
      if (vals[i] == null) continue;
      for (let k = 0; k < step / Q; k++) {
        const t = start + i * step + k * Q, cur = best.get(t);
        if (!cur || +res < cur[0]) best.set(t, [+res, vals[i]]);
      }
    }
  }
  return [...best.entries()].map(([t, v]) => [t, v[1]]);
}

async function fromEnergyCharts(from, to) {
  const r = await fetch(`https://api.energy-charts.info/price?bzn=BE&start=${from}&end=${to}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("energy-charts: HTTP " + r.status);
  return parseEnergyCharts(await r.json());
}
async function fromEntsoe(from, to, token) {
  const f = (d) => d.replaceAll("-", "") + "0000";
  const u = `https://web-api.tp.entsoe.eu/api?documentType=A44&in_Domain=10YBE----------2&out_Domain=10YBE----------2&periodStart=${f(addDays(from, -1))}&periodEnd=${f(addDays(to, 1))}&securityToken=${token}`;
  const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("ENTSO-E: HTTP " + r.status);
  return parseEntsoe(await r.text());
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const today = bxlDate(now), tomorrow = addDays(today, 1);
  const KEEP = 14; // aantal dagen geschiedenis
  const wanted = []; for (let i = -KEEP; i <= 1; i++) wanted.push(addDays(today, i));
  let old = { days: {} };
  try { old = JSON.parse(readFileSync(OUT, "utf8")); } catch {}

  let days = {}, source = null;
  const errors = [];
  try {
    days = toDays(await fromEnergyCharts(addDays(today, -KEEP - 1), addDays(tomorrow, 1)), wanted);
    if (Object.keys(days).length) source = "energy-charts.info (Fraunhofer ISE; data: ENTSO-E / EPEX Spot)";
  } catch (e) { errors.push(String(e.message || e)); }

  const token = process.env.ENTSOE_TOKEN;
  if (token && !(days[today] && (days[tomorrow] || !afterPublication(now)))) {
    try {
      const d2 = toDays(await fromEntsoe(addDays(today, -KEEP), tomorrow, token), wanted);
      for (const d of wanted) if (!days[d] && d2[d]) { days[d] = d2[d]; source = source ? source + " + ENTSO-E" : "ENTSO-E Transparency Platform"; }
    } catch (e) { errors.push(String(e.message || e)); }
  }

  // Nooit goede gegevens overschrijven met niets.
  const merged = {};
  // Voorbije dagen blijven zoals ze bewaard zijn; vandaag en morgen worden ververst.
  for (const d of wanted) { const o = old.days && old.days[d]; const v = d < today ? (o || days[d]) : (days[d] || o); if (v) merged[d] = v; }
  const same = JSON.stringify(merged) === JSON.stringify(old.days || {});
  console.log(`${Object.keys(merged).length} dagen bewaard; vandaag ${today}: ${merged[today] ? merged[today].length : 0} kwartieren; morgen ${tomorrow}: ${merged[tomorrow] ? merged[tomorrow].length : 0} kwartieren`);
  if (errors.length) console.log("Meldingen: " + errors.join(" | "));
  if (!same) {
    writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), source: source || old.source || null, unit: "EUR/MWh", days: merged }) + "\n");
    console.log("data/prices.json bijgewerkt.");
  }
  if (!merged[today]) { console.error("Geen volledige prijzen voor vandaag gevonden."); process.exit(1); }
}
function afterPublication(now) {
  const h = +new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date(now * 1000));
  return h >= 13;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
