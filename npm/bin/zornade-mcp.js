#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { costruisciArgomenti } from "../lib/args.js";

function percorsoBridge() {
  const require = createRequire(import.meta.url);
  const pacchetto = require.resolve("mcp-remote/package.json");
  return path.join(path.dirname(pacchetto), "dist", "proxy.js");
}

const argomenti = costruisciArgomenti({
  endpoint: process.env.ZORNADE_MCP_URL,
  chiave: process.env.ZORNADE_API_KEY,
  extra: process.argv.slice(2),
});

const figlio = spawn(process.execPath, [percorsoBridge(), ...argomenti], {
  stdio: "inherit",
});

for (const segnale of ["SIGINT", "SIGTERM"]) {
  process.on(segnale, () => figlio.kill(segnale));
}

figlio.on("error", (errore) => {
  process.stderr.write(`zornade-mcp: impossibile avviare il bridge: ${errore.message}\n`);
  process.exit(1);
});

figlio.on("exit", (codice, segnale) => {
  if (segnale) {
    process.kill(process.pid, segnale);
    return;
  }
  process.exit(codice ?? 1);
});
