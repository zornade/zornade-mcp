// ─────────────────────────────────────────────────────────────────────────────
// Zornade MCP server - Supabase Edge Function `mcp`
//
// Espone l'API v2 di Zornade come strumenti Model Context Protocol
// (streamable HTTP) per client AI: Claude, Cursor, VS Code Copilot, Cline, ecc.
// Pattern ufficiale Supabase con mcp-lite:
// https://supabase.com/docs/guides/functions/examples/mcp-server-mcp-lite
//
// Endpoint pubblico (via proxy Netlify mcp.zornade.com):
//   https://mcp.zornade.com/mcp
// Upstream diretto:
//   https://wupqwfqjfpwrapgnogjv.supabase.co/functions/v1/mcp/mcp
//
// Autenticazione: la chiave API Zornade (zrn_..., gratuita su
// https://app.zornade.com/api) va inviata in uno di questi modi:
//   - header  x-api-key: zrn_...
//   - header  Authorization: Bearer zrn_...
//   - query   ?api_key=zrn_...
// Il rate limit (10000 richieste/ora) e gli scope sono quelli della chiave.
// ─────────────────────────────────────────────────────────────────────────────

import { Hono, type Context } from 'npm:hono@4.6.14';
import { McpServer, StreamableHttpTransport } from 'npm:mcp-lite@0.10.0';
import { z } from 'npm:zod@4.1.12';
import { buildTools, extractApiKey, extractSupabaseToken, utenteDaTokenSupabase, chiaveMcpDaUtente, logMcpUsage } from './tools.ts';
import type { ToolTextResult } from './tools.ts';

// Documento di protected resource (RFC 9728), servito dal sito Netlify su
// mcp.zornade.com: dice al client MCP qual e' il server di autorizzazione.
// L'URL e' quello pubblico, non quello interno di Supabase, perche' e' il
// client a doverlo leggere.
const RESOURCE_METADATA_URL = 'https://mcp.zornade.com/.well-known/oauth-protected-resource';

// 401 conforme: senza questo header i client OAuth (Claude in primis) non
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
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32001,
        message: tokenNonValido
          ? "Access token non valido o scaduto. Rifai il flusso OAuth, oppure usa una chiave API Zornade nell'header x-api-key."
          : "Autenticazione richiesta: chiave API Zornade nell'header x-api-key, oppure access token nel Bearer (OAuth 2.1). Chiavi gratuite su https://app.zornade.com/api.",
      },
    }),
    { status: 401, headers },
  );
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-api-key, content-type, mcp-session-id, mcp-protocol-version, last-event-id, accept',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'mcp-session-id',
};

function createMcp(apiKey: string | null): McpServer {
  const mcp = new McpServer({
    name: 'zornade',
    version: '1.1.0',
    schemaAdapter: (schema) => z.toJSONSchema(schema as z.ZodType),
  });

  for (const tool of buildTools(apiKey)) {
    mcp.tool(tool.name, {
      description: tool.description,
      // title + annotations (spec MCP 2025-06-18): richiesti dalla directory
      // dei connettori di Claude, usati dagli altri client per i hint di
      // sola lettura. Supportati da mcp-lite dalla 0.10.0.
      title: tool.title,
      annotations: tool.annotations,
      inputSchema: tool.inputSchema,
      handler: tool.handler as (
        args: Record<string, unknown>,
      ) => Promise<ToolTextResult>,
    });
  }

  return mcp;
}

// ─── Routing (pattern Supabase: la funzione è montata su /mcp/*) ─────────────

const mcpApp = new Hono();

mcpApp.get('/', (c) =>
  c.json({
    name: 'Zornade MCP server',
    version: '1.1.0',
    description:
      'MCP (Model Context Protocol) server for Zornade API v2: Italian cadastral parcels, geocoding and administrative data.',
    mcp_endpoint: `${new URL(c.req.url).origin}/mcp`,
    authentication:
      'Send your free Zornade API key (zrn_...) via x-api-key header, Authorization: Bearer, or ?api_key= query parameter. Get one at https://app.zornade.com/api. OAuth 2.1 is also supported: protected resource metadata at https://mcp.zornade.com/.well-known/oauth-protected-resource',
    documentation: 'https://api.zornade.com',
  }),
);

// Handler MCP condiviso: montato sia su /mcp (endpoint pubblico) sia su /
// (radice) cosi' che il container Docker risponda anche a chi prova la radice
// (es. check automatizzati tipo Glama). Su Supabase il platform inoltra solo
// richieste sotto /mcp, quindi la rotta / e' inerte in produzione.
// Nome con cui si presenta il nostro cron di uptime (ogni 5 minuti).
// L'uptime vive in `mcp_health`, con status e latenza per target, quindi
// registrarlo anche qui non aggiunge informazione e falsa le letture: senza
// questo filtro il 94% degli eventi "initialize" e' il nostro healthcheck e le
// dashboard MCP raccontano una storia gonfiata di circa quattro volte.
const CLIENT_HEALTHCHECK = 'grafana-healthcheck';

// Forma minima del body JSON-RPC che ci serve ispezionare prima del transport:
// il metodo (per distinguere le chiamate ai tool dall'handshake) e il nome del
// client che si presenta con initialize (per il monitoraggio in Grafana).
type McpBody = { method?: string; params?: { clientInfo?: { name?: string } } };

async function mcpHandler(c: Context): Promise<Response> {
  // Il body si legge una volta su un clone: serve sia al log dell'initialize
  // sia a capire se la richiesta e' una chiamata a un tool (l'unica che
  // richiede autenticazione). La richiesta originale resta integra per il
  // transport MCP.
  let body: McpBody | null = null;
  try {
    body = (await c.req.raw.clone().json()) as McpBody;
  } catch {
    // Body assente o non JSON (es. GET per SSE).
  }

  // Credenziali. Prima la chiave API esplicita; se non c'e', un access token
  // Supabase nel Bearer (flusso OAuth) diventa una chiave personale mintata al
  // primo collegamento.
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

  const nomeClient = body?.params?.clientInfo?.name ?? null;
  if (body?.method === 'initialize' && nomeClient !== CLIENT_HEALTHCHECK) {
    // Le sessioni si contano a parte dalle chiamate (nella pagina /api),
    // perche' un `initialize` non e' una richiesta di dati e non consuma il
    // limite orario della chiave.
    logMcpUsage({ tool: 'initialize', client: nomeClient, apiKey });
  }

  // initialize, tools/list e le notifiche restano accessibili senza
  // credenziali: ci vivono i check automatici (Glama) e le validazioni delle
  // directory, che non hanno una chiave. Le chiamate ai tool invece no: li' la
  // risposta e' un 401 con il puntatore al server di autorizzazione, che e' il
  // segnale con cui i client conformi avviano il flusso OAuth.
  if (!apiKey && body?.method === 'tools/call') {
    return rispostaNonAutenticato(tokenNonValido);
  }

  // Per ogni richiesta costruiamo il server con la chiave risolta: gli handler
  // dei tool la chiudono nel proprio scope.
  const mcp = createMcp(apiKey);
  const transport = new StreamableHttpTransport();
  const httpHandler = transport.bind(mcp);
  const res = await httpHandler(c.req.raw);
  for (const [k, v] of Object.entries(CORS)) {
    res.headers.set(k, v);
  }
  return res;
}

mcpApp.options('/mcp', (c) => new Response(null, { status: 204, headers: CORS }));
mcpApp.all('/mcp', mcpHandler);
mcpApp.options('/', (c) => new Response(null, { status: 204, headers: CORS }));
mcpApp.all('/', mcpHandler);

const app = new Hono();
// Doppio mount: su Supabase il path effettivo e' /mcp/mcp (il platform include
// il prefisso della funzione), nel container Docker invece / e /mcp.
app.route('/', mcpApp);
app.route('/mcp', mcpApp);

// ZORNADE_LISTEN_PORTS (solo container/self-hosting): lista di porte separate
// da virgola su cui servire l'MCP. Utile per i check automatici che provano
// porte convenzionali (3000/8000/8080). Su Supabase la variabile non esiste e
// resta il comportamento platform default (Deno.serve senza opzioni).
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
