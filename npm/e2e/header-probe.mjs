// Verifica che la chiave passata via ZORNADE_API_KEY arrivi davvero al server.
// Avvia un finto server MCP su loopback, ci punta il bin, e ispeziona gli header.
// Uso: node e2e/header-probe.mjs
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const qui = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(qui, "..", "bin", "zornade-mcp.js");

const visti = [];

const server = createServer((req, res) => {
  let corpo = "";
  req.on("data", (p) => (corpo += p));
  req.on("end", () => {
    visti.push({ metodo: req.method, url: req.url, apiKey: req.headers["x-api-key"] || null });

    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }

    let richiesta = {};
    try {
      richiesta = JSON.parse(corpo);
    } catch {
      res.writeHead(400).end();
      return;
    }

    const risultato =
      richiesta.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "finto", version: "0.0.1" },
          }
        : { tools: [] };

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: richiesta.id ?? null, result: risultato }));
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const porta = server.address().port;
const endpoint = `http://127.0.0.1:${porta}/mcp`;

const figlio = spawn(process.execPath, [bin], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ZORNADE_API_KEY: "zrn_prova_123", ZORNADE_MCP_URL: endpoint },
});
figlio.stderr.resume();
figlio.stdout.resume();

figlio.stdin.write(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "header-probe", version: "1.0.0" },
    },
  }) + "\n",
);

await new Promise((r) => setTimeout(r, 6000));
figlio.kill("SIGTERM");
server.close();

const conPost = visti.filter((v) => v.metodo === "POST");
const esiti = [
  {
    nome: "il bin contatta l'endpoint indicato da ZORNADE_MCP_URL",
    ok: conPost.length > 0,
    dettaglio: `${visti.length} richieste totali`,
  },
  {
    nome: "ogni richiesta porta x-api-key con la chiave fornita",
    ok: conPost.length > 0 && conPost.every((v) => v.apiKey === "zrn_prova_123"),
    dettaglio: JSON.stringify(conPost.map((v) => v.apiKey)),
  },
];

let falliti = 0;
for (const e of esiti) {
  if (!e.ok) falliti += 1;
  process.stdout.write(`${e.ok ? "ok  " : "FAIL"}  ${e.nome}  [${e.dettaglio}]\n`);
}
process.stdout.write(`\n${esiti.length - falliti}/${esiti.length} verifiche superate\n`);
process.exit(falliti ? 1 : 0);
