// ─────────────────────────────────────────────────────────────────────────────
// Zornade MCP server - Supabase Edge Function `mcp`
//
// Espone l'API v2 di Zornade come strumenti Model Context Protocol su
// streamable HTTP, per client AI: Claude, Cursor, VS Code Copilot, Cline, ecc.
//
// Specifica servita: MCP 2026-07-28, con nucleo stateless. Niente handshake
// obbligatorio, niente sessione di protocollo, discovery via `server/discover`.
// `initialize` resta servito per i client non aggiornati, come la specifica
// prevede per i server che vogliono reggere entrambe le ere.
//
// Il protocollo vive in dispatch.ts, condiviso con l'entrypoint stdio: la
// stessa implementazione risponde su HTTP e su stdin/stdout, quindi i check
// delle directory (che usano stdio) verificano lo stesso codice dei client.
//
// Endpoint pubblico (via proxy Netlify mcp.zornade.com):
//   https://mcp.zornade.com/mcp
// Upstream diretto:
//   https://wupqwfqjfpwrapgnogjv.supabase.co/functions/v1/mcp/mcp
//
// Autenticazione: la chiave API Zornade (zrn_..., gratuita su
// https://app.zornade.com/api) va inviata in uno di questi modi:
//   - header  x-api-key (prefisso zrn_)
//   - header  Authorization con schema Bearer
//   - query   ?api_key=
// Il rate limit (10000 richieste/ora) e gli scope sono quelli della chiave.
// ─────────────────────────────────────────────────────────────────────────────

import { Hono, type Context } from 'npm:hono@4.6.14';
import {
  extractApiKey,
  extractSupabaseToken,
  utenteDaTokenSupabase,
  chiaveMcpDaUtente,
} from './tools.ts';
import {
  bustaErrore,
  bustaRisposta,
  ERRORE,
  gestisciRichiesta,
  ISTRUZIONI,
  VERSIONE_SERVER,
  VERSIONI_SUPPORTATE,
  type RichiestaJsonRpc,
} from './dispatch.ts';

// Documento di protected resource (RFC 9728), servito dal sito Netlify su
// mcp.zornade.com: dice al client MCP qual e' il server di autorizzazione.
// L'URL e' quello pubblico, non quello interno di Supabase, perche' e' il
// client a doverlo leggere.
const RESOURCE_METADATA_URL = 'https://mcp.zornade.com/.well-known/oauth-protected-resource';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-api-key, content-type, mcp-protocol-version, last-event-id, accept',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  // Nessun header di sessione: la 2026-07-28 elimina la sessione di protocollo.
  // `mcp-session-id` resta accettato in ingresso per i client non aggiornati.
};

// 401 conforme: senza `WWW-Authenticate` i client OAuth (Claude in primis) non
// sanno dove andare a fare il login e la connessione fallisce senza spiegazioni.
function rispostaNonAutenticato(tokenNonValido: boolean): Response {
  const headers: Record<string, string> = {
    ...CORS,
    'Content-Type': 'application/json',
    'WWW-Authenticate':
      `Bearer resource_metadata="${RESOURCE_METADATA_URL}"` +
      (tokenNonValido ? ', error="invalid_token"' : ''),
  };
  return new Response(
    bustaErrore(
      null,
      -32001,
      tokenNonValido
        ? "Access token non valido o scaduto. Rifai il flusso OAuth, oppure usa una chiave API Zornade nell'header x-api-key."
        : "Autenticazione richiesta: chiave API Zornade nell'header x-api-key, oppure access token OAuth 2.1. Chiavi gratuite su https://app.zornade.com/api.",
    ),
    { status: 401, headers },
  );
}

/**
 * Corpo della risposta secondo quello che il client sa leggere. Il transport
 * MCP classico pretendeva che il client accettasse sia JSON sia SSE; qui
 * rispondiamo JSON a chi accetta JSON e SSE a chi accetta solo SSE, che e' piu'
 * permissivo e toglie un motivo di rifiuto.
 */
function rispostaJsonRpc(payload: string, accept: string): Response {
  const vuoleJson = accept === '' || accept === '*/*' || accept.includes('application/json');
  if (vuoleJson) {
    return new Response(payload, {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  return new Response(`event: message\ndata: ${payload}\n\n`, {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}

async function mcpHandler(c: Context): Promise<Response> {
  const accept = c.req.raw.headers.get('accept') ?? '';

  // Solo POST porta richieste JSON-RPC. GET e DELETE esistevano per lo
  // streaming e la chiusura delle sessioni: senza sessioni rispondiamo 405 con
  // `Allow`, che e' l'informazione utile a un client.
  if (c.req.method !== 'POST') {
    return new Response(
      bustaErrore(null, ERRORE.richiestaNonValida, 'Use POST for JSON-RPC requests.'),
      {
        status: 405,
        headers: { ...CORS, 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' },
      },
    );
  }

  // Credenziali. Prima la chiave API esplicita; se non c'e', un access token
  // Supabase (OAuth) diventa una chiave personale mintata al primo collegamento.
  let apiKey = extractApiKey(c.req.raw);
  let tokenNonValido = false;
  if (!apiKey) {
    const token = extractSupabaseToken(c.req.raw);
    if (token) {
      const utente = await utenteDaTokenSupabase(token);
      if (utente) apiKey = await chiaveMcpDaUtente(utente);
      if (!apiKey) tokenNonValido = true;
    }
  }

  let msg: RichiestaJsonRpc;
  try {
    msg = (await c.req.raw.json()) as RichiestaJsonRpc;
  } catch {
    return new Response(
      bustaErrore(null, ERRORE.parse, 'Parse error: body must be JSON.'),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    return new Response(
      bustaErrore(null, ERRORE.richiestaNonValida, 'Invalid JSON-RPC request.'),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
  if (msg.jsonrpc !== '2.0') {
    return new Response(
      bustaErrore(msg.id ?? null, ERRORE.richiestaNonValida, 'Invalid JSON-RPC version.'),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  const esito = await gestisciRichiesta(msg, apiKey);

  switch (esito.tipo) {
    case 'non_autenticato':
      return rispostaNonAutenticato(tokenNonValido);
    case 'notifica':
      // 202 Accepted: richiesta presa in carico, nessuna risposta attesa.
      return new Response(null, { status: 202, headers: CORS });
    case 'errore':
      return rispostaJsonRpc(bustaErrore(msg.id, esito.codice, esito.messaggio), accept);
    case 'risposta':
      return rispostaJsonRpc(bustaRisposta(msg.id, esito.risultato), accept);
  }
}

// ─── Routing (pattern Supabase: la funzione è montata su /mcp/*) ─────────────

const mcpApp = new Hono();

mcpApp.get('/', (c) =>
  c.json({
    name: 'Zornade MCP server',
    version: VERSIONE_SERVER,
    protocol: {
      served: VERSIONI_SUPPORTATE,
      latest: VERSIONI_SUPPORTATE[0],
      stateless: true,
      discovery: 'server/discover',
    },
    description:
      'MCP server for the Zornade API v2: Italian cadastral parcels, geocoding and administrative data.',
    mcp_endpoint: `${new URL(c.req.url).origin}/mcp`,
    instructions: ISTRUZIONI,
    authentication:
      'Send your free Zornade API key (zrn_...) via x-api-key header, Authorization Bearer, or ?api_key= query parameter. Get one at https://app.zornade.com/api. OAuth 2.1 is also supported: protected resource metadata at https://mcp.zornade.com/.well-known/oauth-protected-resource',
    tools: [
      'zornade_geocode_search',
      'zornade_geocode_reverse',
      'zornade_parcel_by_id',
      'zornade_parcel_locate',
      'zornade_parcel_search',
      'zornade_admin_lists',
    ],
    documentation: 'https://api.zornade.com',
  }),
);

// Doppio mount: su Supabase il path effettivo e' /mcp/mcp (il platform include
// il prefisso della funzione), nel container Docker invece / e /mcp. La rotta
// / e' anche quella che provano i check automatici delle directory.
mcpApp.options('/mcp', () => new Response(null, { status: 204, headers: CORS }));
mcpApp.all('/mcp', mcpHandler);
// Stessa cosa sulla radice: i check automatici delle directory provano a volte
// / e a volte /mcp. La GET resta la pagina informativa registrata sopra.
mcpApp.all('/', mcpHandler);

const app = new Hono();
app.route('/', mcpApp);
app.route('/mcp', mcpApp);

// ZORNADE_LISTEN_PORTS (solo container/self-hosting): lista di porte separate
// da virgola su cui servire l'MCP. Utile ai check automatici che provano porte
// convenzionali (3000/8000/8080). Su Supabase la variabile non esiste e resta
// il comportamento platform default (Deno.serve senza opzioni).
const listenPorts = (Deno.env.get('ZORNADE_LISTEN_PORTS') ?? '')
  .split(',')
  .map((p) => Number(p.trim()))
  .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);

if (listenPorts.length > 0) {
  for (const port of listenPorts) {
    Deno.serve({ port, hostname: '0.0.0.0' }, app.fetch);
  }
} else {
  Deno.serve(app.fetch);
}
