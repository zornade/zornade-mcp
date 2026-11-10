// Sonda end-to-end: parla JSON-RPC sul nostro bin come farebbe un client stdio.
// Uso: node e2e/stdio-probe.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const qui = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(qui, "..", "bin", "zornade-mcp.js");

const figlio = spawn(process.execPath, [bin], { stdio: ["pipe", "pipe", "pipe"] });

let buffer = "";
const risposte = new Map();
const attese = new Map();

figlio.stdout.on("data", (pezzo) => {
  buffer += pezzo.toString("utf8");
  let riga;
  while ((riga = buffer.indexOf("\n")) !== -1) {
    const testo = buffer.slice(0, riga).trim();
    buffer = buffer.slice(riga + 1);
    if (!testo) continue;
    let messaggio;
    try {
      messaggio = JSON.parse(testo);
    } catch {
      continue;
    }
    if (messaggio.id !== undefined) {
      risposte.set(messaggio.id, messaggio);
      attese.get(messaggio.id)?.(messaggio);
      attese.delete(messaggio.id);
    }
  }
});

let stderr = "";
figlio.stderr.on("data", (pezzo) => {
  stderr += pezzo.toString("utf8");
});

function invia(messaggio) {
  figlio.stdin.write(JSON.stringify(messaggio) + "\n");
}

function attendi(id, timeoutMs = 30000) {
  if (risposte.has(id)) return Promise.resolve(risposte.get(id));
  return new Promise((risolvi, rifiuta) => {
    const timer = setTimeout(() => {
      attese.delete(id);
      rifiuta(new Error(`nessuna risposta per id ${id} entro ${timeoutMs}ms`));
    }, timeoutMs);
    attese.set(id, (m) => {
      clearTimeout(timer);
      risolvi(m);
    });
  });
}

const esiti = [];
function verifica(nome, condizione, dettaglio = "") {
  esiti.push({ nome, ok: Boolean(condizione), dettaglio });
}

try {
  invia({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "zornade-e2e-probe", version: "1.0.0" },
    },
  });

  const init = await attendi(1);
  const server = init.result?.serverInfo || {};
  verifica("initialize risponde", Boolean(init.result), JSON.stringify(init.error || ""));
  verifica("il server si identifica", /zornade/i.test(server.name || ""), JSON.stringify(server));

  invia({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  invia({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  const lista = await attendi(2);
  const tool = lista.result?.tools || [];
  const nomi = tool.map((t) => t.name);
  verifica("tools/list risponde", tool.length > 0, JSON.stringify(lista.error || ""));
  const attesi = [
    "zornade_geocode_search",
    "zornade_geocode_reverse",
    "zornade_parcel_by_id",
    "zornade_parcel_locate",
    "zornade_parcel_search",
    "zornade_admin_lists",
  ];
  verifica("i sei tool attesi ci sono tutti", attesi.every((n) => nomi.includes(n)), nomi.join(","));
  const perId = tool.find((t) => t.name === "zornade_parcel_by_id");
  verifica(
    "nightlights_v2 e una sezione richiedibile su parcel_by_id",
    /nightlights_v2/.test(JSON.stringify(perId?.inputSchema || {})),
    "",
  );
  verifica(
    "ogni tool ha inputSchema",
    tool.every((t) => t.inputSchema && t.inputSchema.type === "object"),
    "",
  );
} catch (errore) {
  verifica("esecuzione senza errori", false, errore.message);
} finally {
  figlio.kill("SIGTERM");
}

await new Promise((r) => setTimeout(r, 500));

let falliti = 0;
for (const e of esiti) {
  if (!e.ok) falliti += 1;
  process.stdout.write(
    `${e.ok ? "ok  " : "FAIL"}  ${e.nome}${e.dettaglio ? "  [" + e.dettaglio + "]" : ""}\n`,
  );
}
if (falliti) {
  process.stdout.write(`\n--- stderr del bridge ---\n${stderr.slice(-2000)}\n`);
}
process.stdout.write(`\n${esiti.length - falliti}/${esiti.length} verifiche superate\n`);
process.exit(falliti ? 1 : 0);
