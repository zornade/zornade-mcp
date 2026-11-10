// ─────────────────────────────────────────────────────────────────────────────
// Zornade MCP - entrypoint stdio (container Docker / check automatici Glama)
//
// mcp-proxy e i validatori delle directory avviano questo file come processo
// figlio e parlano JSON-RPC su stdin/stdout. Il protocollo non e' riscritto
// qui: passa dallo stesso dispatcher di index.ts, cosi' i check su stdio
// verificano esattamente il codice che serve i client via HTTP.
//
// La chiave API (opzionale) si legge da ZORNADE_API_KEY.
// ─────────────────────────────────────────────────────────────────────────────

import {
  bustaErrore,
  bustaRisposta,
  gestisciRichiesta,
  type RichiestaJsonRpc,
} from './dispatch.ts';

const apiKey = Deno.env.get('ZORNADE_API_KEY') ?? null;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function send(msg: unknown): void {
  Deno.stdout.writeSync(encoder.encode(JSON.stringify(msg) + '\n'));
}

async function handle(msg: RichiestaJsonRpc): Promise<void> {
  const esito = await gestisciRichiesta(msg, apiKey);
  switch (esito.tipo) {
    case 'notifica':
      return;
    case 'non_autenticato':
      // Su stdio non esiste un 401: l'assenza di chiave e' un errore JSON-RPC.
      send({
        jsonrpc: '2.0',
        id: msg.id ?? null,
        error: {
          code: -32001,
          message:
            'Chiave API Zornade richiesta per chiamare i tool. Imposta ZORNADE_API_KEY, oppure passa a un client HTTP con x-api-key.',
        },
      });
      return;
    case 'errore':
      Deno.stdout.writeSync(encoder.encode(bustaErrore(msg.id, esito.codice, esito.messaggio) + '\n'));
      return;
    case 'risposta':
      Deno.stdout.writeSync(encoder.encode(bustaRisposta(msg.id, esito.risultato) + '\n'));
      return;
  }
}

let buffer = '';

for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk);
  let idx: number;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg: RichiestaJsonRpc;
    try {
      msg = JSON.parse(line) as RichiestaJsonRpc;
    } catch {
      Deno.stdout.writeSync(encoder.encode(bustaErrore(null, -32700, 'Parse error') + '\n'));
      continue;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      Deno.stdout.writeSync(encoder.encode(bustaErrore(null, -32600, 'Invalid request') + '\n'));
      continue;
    }
    // Il log della discovery vive nel dispatcher, condiviso con HTTP: qui non
    // si duplica, altrimenti ogni connessione conterebbe due volte.
    await handle(msg);
  }
}
