// Haalt het laadvermogen van de Smappee-laadpaal op en bewaart per kwartier
// hoeveel er geladen is in data/charging.json. Draait via GitHub Actions.
// Aannames (nog niet bevestigd met een tweede bron):
//  - active[0] is het laadkanaal, in Wh per 5 minuten (geverifieerd in de Smappee-chat);
//  - het tijdstip van een meting is het EINDE van het interval van 5 minuten;
//  - "uit het net" = min(geladen, netafname) per 5 minuten: zonder laden zou de
//    netafname met dat bedrag gedaald zijn. Dit is een schatting.
import { readFileSync, writeFileSync } from "node:fs";
const OUT = new URL("../data/charging.json", import.meta.url);
const TZ = "Europe/Brussels", Q = 900, KEEP = 14, MIN_WH = 100, MIN_SESSION_WH = 1000, VERSION = 2;
// Minder dan 100 Wh per kwartier telt niet als laden; een sessie (aaneensluitende kwartieren,
// hoogstens één kwartier onderbreking) onder 1 kWh ook niet: dat is de korte laadtest bij het insteken van de kabel.
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const bxlDate = (unix) => dayFmt.format(new Date(unix * 1000));
const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export function toQuarters(consumptions) {
  const q = new Map();
  for (const c of consumptions) {
    const ev = (c.active && c.active[0]) || 0; if (!(ev > 0)) continue;
    const start = Math.floor((c.timestamp / 1000 - 1) / Q) * Q; // meting hoort bij het kwartier waarin het interval eindigt
    const grid = Math.min(ev, Math.max(0, c.gridImport || 0));
    const cur = q.get(start) || [0, 0]; cur[0] += ev; cur[1] += grid; q.set(start, cur);
  }
  const list = [...q.entries()].sort((a, b) => a[0] - b[0]).filter(([, v]) => v[0] >= MIN_WH);
  const days = {};
  let ses = [];
  const flush = () => { if (ses.reduce((a, x) => a + x[1][0], 0) >= MIN_SESSION_WH) for (const [t, [ev, grid]] of ses) (days[bxlDate(t)] ||= []).push([t, Math.round(ev), Math.round(grid)]); ses = []; };
  for (const e of list) { if (ses.length && e[0] - ses[ses.length - 1][0] > 2 * Q) flush(); ses.push(e); }
  flush();
  return days;
}

async function main() {
  const env = process.env, need = ["SMAPPEE_CLIENT_ID", "SMAPPEE_CLIENT_SECRET", "SMAPPEE_USERNAME", "SMAPPEE_PASSWORD", "SMAPPEE_LOCATION_ID"];
  if (need.some((k) => !env[k])) { console.log("Smappee-geheimen ontbreken; laadgegevens overgeslagen."); return; }
  const BASE = "https://app1pub.smappee.net/dev/v3";
  const tok = await fetch(BASE + "/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(30000),
    body: new URLSearchParams({ grant_type: "password", client_id: env.SMAPPEE_CLIENT_ID, client_secret: env.SMAPPEE_CLIENT_SECRET, username: env.SMAPPEE_USERNAME, password: env.SMAPPEE_PASSWORD }) });
  if (!tok.ok) throw new Error("Smappee aanmelden: HTTP " + tok.status);
  const { access_token } = await tok.json();
  let old = { days: {} }; try { old = JSON.parse(readFileSync(OUT, "utf8")); } catch {}
  const now = Math.floor(Date.now() / 1000), today = bxlDate(now);
  const first = !old.generated || old.version !== VERSION;                       // eerste keer: volledige geschiedenis
  const back = first ? KEEP : 2, all = [];
  for (let d = back; d > 0; d -= 7) {                 // in stukken van hoogstens 7 dagen
    const from = (now - d * 86400) * 1000, to = (now - Math.max(0, d - 7) * 86400) * 1000;
    const r = await fetch(`${BASE}/servicelocation/${env.SMAPPEE_LOCATION_ID}/consumption?aggregation=1&from=${from}&to=${to}`, { headers: { Authorization: "Bearer " + access_token }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error("Smappee verbruik: HTTP " + r.status);
    all.push(...((await r.json()).consumptions || []));
  }
  const fresh = toQuarters(all), merged = {};
  for (let i = -KEEP; i <= 0; i++) {
    const d = addDays(today, i), refetched = i >= -(back - 1);   // volledig opnieuw opgehaalde dagen vervangen de oude
    const v = refetched ? fresh[d] : (old.days && old.days[d]);
    if (v && v.length) merged[d] = v;
  }
  if (JSON.stringify(merged) !== JSON.stringify(old.days || {}) || first) {
    writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), version: VERSION, unit: "Wh per kwartier: [start, geladen, waarvan uit het net (schatting)]", days: merged }) + "\n");
    console.log("data/charging.json bijgewerkt.");
  }
  console.log("Dagen met laden: " + Object.keys(merged).length);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
