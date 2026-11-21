// Dagelijkse bewaking van de laadgrafiek. Drukt "ALLES IN ORDE" af, of een lijst problemen.
// Gebruik: node scripts/health_check.mjs   (vanuit een kloon van de repository)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const TZ = "Europe/Brussels";
const read = (p) => JSON.parse(readFileSync(new URL("../" + p, import.meta.url), "utf8"));
const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
function bxl(d) { const o = {}; fmt.formatToParts(d).forEach((p) => (o[p.type] = p.value)); return { date: `${o.year}-${o.month}-${o.day}`, h: +o.hour }; }
const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const addMonths = (ym, n) => { let [y, m] = ym.split("-").map(Number); m += n; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return `${y}-${String(m).padStart(2, "0")}`; };
const quarter = (d) => `${d.slice(0, 4)}-Q${Math.floor((+d.slice(5, 7) - 1) / 3) + 1}`;
const hoursAgo = (iso, now) => (now - new Date(iso)) / 3600000;

export function check(now, { prices, charging, tariffs, cfg }) {
  const p = [], { date: today, h } = bxl(now), tomorrow = addDays(today, 1);
  const n = (d) => (prices.days && prices.days[d] ? prices.days[d].length : 0);
  if (n(today) < 92) p.push(`Kwartierprijzen van vandaag (${today}) ontbreken.`);
  if (h >= 15 && n(tomorrow) < 92) p.push(`Kwartierprijzen van morgen (${tomorrow}) ontbreken nog na 15 uur: de dagelijkse ophaling liep niet of mislukte.`);
  if (!charging.gecontroleerd || charging.gecontroleerd < addDays(today, -1)) p.push(`Smappee is sinds ${charging.gecontroleerd || "onbekend"} niet meer bevraagd: laadsessies worden niet meer bijgewerkt.`);
  const creg = tariffs.creg_vlaams_gewest_eur_kwh || {};
  if (creg[quarter(today)] == null) p.push(`Er is geen CREG-tarief voor het lopende kwartaal ${quarter(today)}: de grafiek gebruikt een oud tarief.`);
  const m = +today.slice(5, 7), d = +today.slice(8, 10);
  if (m % 3 === 0 && d >= 20) { const nq = quarter(addDays(today, 15)); if (creg[nq] == null) p.push(`Het CREG-tarief voor volgend kwartaal ${nq} staat er nog niet in.`); }
  const ym = today.slice(0, 7), expected = addMonths(ym, d >= 22 ? -1 : -2);
  if (!tariffs.laatste_factuur || tariffs.laatste_factuur < expected) p.push(`De Ecopower-factuur van ${expected} is nog niet verwerkt (laatst verwerkt: ${tariffs.laatste_factuur || "geen"}). Staat ze in de factuurmap, en stond de Mac aan op de 16e of 20e?`);
  const exp = cfg.sleutel_factuurtaak_vervalt;
  if (exp) { const days = Math.round((new Date(exp + "T12:00:00Z") - new Date(today + "T12:00:00Z")) / 86400000);
    if (days <= 0) p.push(`De GitHub-sleutel van de factuurtaak is vervallen op ${exp}: maak een nieuwe aan.`);
    else if (days <= (cfg.waarschuw_dagen_voor_vervallen || 30)) p.push(`De GitHub-sleutel van de factuurtaak vervalt over ${days} dagen (${exp}): maak tijdig een nieuwe aan.`); }
  if (cfg.testmelding) p.push("TESTMELDING: dit is een proefmelding van de bewaking. Er is niets mis.");
  return p;
}

async function workflowFailures(now) {
  const out = [];
  for (const wf of ["prijzen.yml", "tarieven.yml"]) {
    try {
      // curl in plaats van fetch: curl volgt de proxy-instellingen van de omgeving.
      const body = execFileSync("curl", ["-sS", "-m", "20", "-H", "Accept: application/vnd.github+json", `https://api.github.com/repos/PieterjanCallewaert/laden/actions/workflows/${wf}/runs?per_page=5`], { encoding: "utf8" });
      const runs = JSON.parse(body).workflow_runs;
      if (!Array.isArray(runs)) { out.push(`(Kon de GitHub-runs van ${wf} niet controleren.)`); continue; }
      const last = runs.find((x) => x.status === "completed");
      if (last && last.conclusion === "failure" && hoursAgo(last.created_at, now) < 48) out.push(`De laatste GitHub-run van ${wf} is mislukt: ${last.html_url}`);
    } catch (e) { out.push(`(Kon de GitHub-runs van ${wf} niet controleren: ${e.message}.)`); }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const now = new Date();
  const p = check(now, { prices: read("data/prices.json"), charging: read("data/charging.json"), tariffs: read("tariffs.json"), cfg: read("meta/bewaking.json") });
  p.push(...(await workflowFailures(now)));
  const real = p.filter((x) => !x.startsWith("("));
  console.log(real.length ? "PROBLEMEN:\n- " + p.join("\n- ") : "ALLES IN ORDE" + (p.length ? "\n- " + p.join("\n- ") : ""));
  if (real.length) process.exitCode = 1;
}
