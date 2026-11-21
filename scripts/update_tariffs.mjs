// Past de Ecopower-tarieven in tariffs.json aan met waarden die de factuurtaak op de Mac
// doorgeeft (via de workflow "Tarieven bijwerken"). Elke waarde wordt streng gecontroleerd,
// zodat ook een verkeerd of misbruikt verzoek geen onzin in de grafiek kan zetten.
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../tariffs.json", import.meta.url);
// Toegelaten velden met hun grenzen (in EUR per kWh, behalve factor en btw).
const LIMITS = {
  factor_per_eur_mwh: [0.0005, 0.002],
  toeslag_eur_kwh: [-0.05, 0.1],
  gsc_eur_kwh: [0, 0.1],
  wkk_eur_kwh: [0, 0.1],
  afnametarief_eur_kwh: [0, 0.25],
  bijzondere_accijns_eur_kwh: [0, 0.2],
  bijdrage_op_de_energie_eur_kwh: [0, 0.05],
  btw: [0, 0.25],
};

export function apply(tariffs, waarden, factuur, today) {
  if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(factuur)) throw new Error("factuur moet de vorm JJJJ-MM hebben, kreeg: " + factuur);
  if (typeof waarden !== "object" || waarden === null || Array.isArray(waarden)) throw new Error("waarden moet een JSON-object zijn");
  const changes = [];
  for (const [k, v] of Object.entries(waarden)) {
    if (!(k in LIMITS)) throw new Error("onbekend veld: " + k);
    if (typeof v !== "number" || !isFinite(v)) throw new Error(k + " is geen getal");
    const [lo, hi] = LIMITS[k];
    if (v < lo || v > hi) throw new Error(`${k} = ${v} ligt buiten de toegelaten grenzen ${lo} tot ${hi}`);
    // De factuur rondt af op 4 decimalen: kleinere verschillen zijn geen echte wijziging.
    if (typeof tariffs.ecopower[k] === "number" && Math.abs(tariffs.ecopower[k] - v) < 0.00006 && k !== "factor_per_eur_mwh") continue;
    if (tariffs.ecopower[k] !== v) { changes.push(`${k}: ${tariffs.ecopower[k]} -> ${v}`); tariffs.ecopower[k] = v; }
  }
  const prev = tariffs.laatste_factuur || "";
  if (factuur < prev) throw new Error(`factuur ${factuur} is ouder dan de al verwerkte ${prev}`);
  tariffs.laatste_factuur = factuur;
  tariffs.bijgewerkt = today;
  if (changes.length) tariffs.bron = `Ecopower-tarieven gecontroleerd met factuur ${factuur}; CREG maximumtarieven thuisladen Vlaams Gewest`;
  return { changes, newInvoice: factuur !== prev };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const tariffs = JSON.parse(readFileSync(FILE, "utf8"));
    const waarden = JSON.parse(process.env.WAARDEN || "{}");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(new Date());
    const { changes, newInvoice } = apply(tariffs, waarden, process.env.FACTUUR || "", today);
    if (!changes.length && !newInvoice) { console.log("Niets veranderd: deze factuur was al verwerkt en de tarieven zijn gelijk."); process.exit(0); }
    writeFileSync(FILE, JSON.stringify(tariffs, null, 2) + "\n");
    console.log(changes.length ? "Gewijzigd:\n" + changes.join("\n") : "Tarieven ongewijzigd; factuur " + process.env.FACTUUR + " als verwerkt genoteerd.");
  } catch (e) { console.error("Geweigerd: " + e.message); process.exit(1); }
}
