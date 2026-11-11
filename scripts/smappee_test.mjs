// Eenmalige test: is de Smappee API bereikbaar vanuit GitHub en geeft ze het laadkanaal terug?
// Drukt bewust alleen een samenvatting af (de logboeken van een openbare repository zijn openbaar).
const env = process.env, need = ["SMAPPEE_CLIENT_ID", "SMAPPEE_CLIENT_SECRET", "SMAPPEE_USERNAME", "SMAPPEE_PASSWORD", "SMAPPEE_LOCATION_ID"];
const missing = need.filter((k) => !env[k]);
if (missing.length) { console.error("Ontbrekende geheimen: " + missing.join(", ")); process.exit(1); }
const BASE = "https://app1pub.smappee.net/dev/v3";
const tok = await fetch(BASE + "/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "password", client_id: env.SMAPPEE_CLIENT_ID, client_secret: env.SMAPPEE_CLIENT_SECRET, username: env.SMAPPEE_USERNAME, password: env.SMAPPEE_PASSWORD }) });
if (!tok.ok) { console.error("Aanmelden mislukt: HTTP " + tok.status); process.exit(1); }
const { access_token } = await tok.json();
console.log("Aanmelden gelukt.");
const to = Date.now(), from = to - 7 * 86400000;
const r = await fetch(`${BASE}/servicelocation/${env.SMAPPEE_LOCATION_ID}/consumption?aggregation=1&from=${from}&to=${to}`, { headers: { Authorization: "Bearer " + access_token } });
if (!r.ok) { console.error("Verbruik opvragen mislukt: HTTP " + r.status); process.exit(1); }
const j = await r.json(), c = j.consumptions || [];
console.log("Aantal metingen (7 dagen, per 5 min): " + c.length);
if (!c.length) process.exit(1);
console.log("Velden: " + Object.keys(c[0]).join(", "));
console.log("Aantal kanalen in 'active': " + (Array.isArray(c[0].active) ? c[0].active.length : "geen"));
const step = c.length > 1 ? (c[1].timestamp - c[0].timestamp) / 60000 : null;
console.log("Interval: " + step + " min; laatste meting " + Math.round((to - c[c.length - 1].timestamp) / 60000) + " min oud");
const ev = c.map((x) => (x.active && x.active[0]) || 0), charging = ev.filter((v) => v > 40).length;
console.log("Laadkanaal active[0]: " + (ev.reduce((a, b) => a + b, 0) / 1000).toFixed(1) + " kWh in 7 dagen; " + charging + " intervallen met laden; hoogste interval " + Math.max(...ev).toFixed(0) + " Wh");
