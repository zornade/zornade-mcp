// ─────────────────────────────────────────────────────────────────────────────
// Zornade MCP - dispatcher JSON-RPC condiviso
//
// Un solo posto che conosce il protocollo, usato da entrambi gli entrypoint:
//   - index.ts  HTTP (Supabase Edge Function / Netlify proxy)
//   - stdio.ts  processo su stdin/stdout (container Docker e check di Glama)
//
// Perche' non un SDK. La libreria usata prima (mcp-lite) si ferma alla 0.10.0
// del 3 novembre 2025. L'SDK "ufficiale" v2 (@modelcontextprotocol/server) si
// dichiara nel README come implementazione della 2026-07-28, ma il codice
// pubblicato dichiara LATEST_PROTOCOL_VERSION = '2025-11-25' e non elenca la
// 2026-07-28 fra le versioni servite: verificato a runtime il 10/11/2026.
// Servire la specifica che dichiariamo richiede quindi il protocollo qui.
//
// La 2026-07-28 e' comunque piccola da servire, perche' e' diventata stateless:
// niente handshake obbligatorio, niente sessione, niente flusso bidirezionale.
// I metodi che ci servono sono cinque: server/discover, initialize (per i
// client non aggiornati), ping, tools/list, tools/call.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'npm:zod@4.6.7';
import { buildTools, logMcpUsage, type ToolDef } from './tools.ts';

export const VERSIONE_SERVER = '2.0.0';

// 2026-07-28 e' la specifica servita. Le due precedenti restano dichiarate
// perche' `initialize` continua a rispondere ai client non aggiornati: un
// server che serve entrambe le ere e' esplicitamente previsto dalla specifica.
export const VERSIONI_SUPPORTATE = ['2026-07-28', '2025-11-25', '2025-06-18'];

/** Validita' della discovery, dichiarata al client per la cache. */
export const TTL_DISCOVERY_MS = 3_600_000;

export const ISTRUZIONI =
  'Zornade espone dati catastali e territoriali italiani: particelle (foglio, particella, subalterno), ' +
  'geocoding su indirizzi ANNCSU, quotazioni OMI, rischi e dati demografici. Tutti i tool sono di sola ' +
  "lettura e chiamano l'API v2 di Zornade. Serve una chiave gratuita (zrn_...) da https://app.zornade.com/api.";

/** Codici JSON-RPC usati, secondo la specifica. */
export const ERRORE = {
  parse: -32700,
  richiestaNonValida: -32600,
  metodoNonTrovato: -32601,
  parametriNonValidi: -32602,
  interno: -32603,
} as const;

export interface RichiestaJsonRpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export type Esito =
  | { tipo: 'risposta'; risultato: Record<string, unknown> }
  | { tipo: 'errore'; codice: number; messaggio: string }
  | { tipo: 'non_autenticato' }
  | { tipo: 'notifica' };

/** Risultato di `server/discover`: identita', versioni e capacita'. */
export function risultatoDiscovery(): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions: VERSIONI_SUPPORTATE,
    capabilities: { tools: {} },
    _meta: {
      'io.modelcontextprotocol/serverInfo': { name: 'zornade', version: VERSIONE_SERVER },
    },
    instructions: ISTRUZIONI,
    ttlMs: TTL_DISCOVERY_MS,
    cacheScope: 'public',
  };
}

/** Nome del client dichiarato dal chiamante, nelle due forme possibili. */
export function nomeClient(msg: RichiestaJsonRpc): string | null {
  const params = (msg.params ?? {}) as {
    clientInfo?: { name?: string };
    _meta?: Record<string, unknown>;
  };
  const diretto = params.clientInfo?.name;
  if (diretto) return diretto;
  const meta = params._meta?.['io.modelcontextprotocol/clientInfo'] as
    | { name?: string }
    | undefined;
  return meta?.name ?? null;
}

function elencoTool(tools: ToolDef[]): Record<string, unknown> {
  return {
    resultType: 'complete',
    tools: tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      annotations: t.annotations,
      inputSchema: z.toJSONSchema(t.inputSchema),
    })),
    ttlMs: TTL_DISCOVERY_MS,
    cacheScope: 'public',
  };
}

/**
 * Esegue una richiesta e restituisce cosa rispondere.
 *
 * Non decide nulla di trasporto: la mappa fra `non_autenticato` e un 401 con
 * `WWW-Authenticate` la fa index.ts, perche' e' li' che vive HTTP.
 */
export async function gestisciRichiesta(
  msg: RichiestaJsonRpc,
  apiKey: string | null,
): Promise<Esito> {
  const method = msg.method ?? '';
  const haId = msg.id !== undefined && msg.id !== null;

  // Le notifiche non hanno risposta, qualunque sia il metodo.
  if (!haId) return { tipo: 'notifica' };

  // Il client dice chi e': lo registriamo per il monitoraggio. `initialize` e'
  // il saluto dell'era precedente, `server/discover` quello attuale, e sono lo
  // stesso evento logico: l'apertura di una sessione.
  //
  // Vengono registrati entrambi come `initialize` di proposito. I pannelli
  // Grafana contano le sessioni con `tool = 'initialize'` e le chiamate con
  // `tool <> 'initialize'`: scrivendo `server/discover` nella colonna, ogni
  // discovery sarebbe contata come chiamata a un tool e i pannelli delle
  // sessioni andrebbero a zero per i client aggiornati. La distinzione fra le
  // due ere resta nel codice, non nella tabella.
  if (method === 'initialize' || method === 'server/discover') {
    logMcpUsage({ tool: 'initialize', client: nomeClient(msg), apiKey });
  }

  switch (method) {
    case 'server/discover':
      return { tipo: 'risposta', risultato: risultatoDiscovery() };

    case 'initialize': {
      const params = (msg.params ?? {}) as { protocolVersion?: string };
      const richiesta = params.protocolVersion;
      const versione = richiesta && VERSIONI_SUPPORTATE.includes(richiesta)
        ? richiesta
        : VERSIONI_SUPPORTATE[0];
      return {
        tipo: 'risposta',
        risultato: {
          protocolVersion: versione,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'zornade', version: VERSIONE_SERVER },
          instructions: ISTRUZIONI,
        },
      };
    }

    case 'ping':
      return { tipo: 'risposta', risultato: {} };

    case 'tools/list':
      return { tipo: 'risposta', risultato: elencoTool(buildTools(apiKey)) };

    case 'tools/call': {
      // Senza chiave non si chiama: e' l'unico metodo che consuma dati e quota.
      if (!apiKey) return { tipo: 'non_autenticato' };
      const params = (msg.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      const tools = buildTools(apiKey);
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) {
        return {
          tipo: 'errore',
          codice: ERRORE.parametriNonValidi,
          messaggio: `Unknown tool: ${String(params.name)}`,
        };
      }
      // La validazione dell'input la fa lo schema del tool: un argomento
      // sbagliato deve tornare come errore leggibile all'agente, non come
      // eccezione del server.
      const parsed = tool.inputSchema.safeParse(params.arguments ?? {});
      if (!parsed.success) {
        return {
          tipo: 'risposta',
          risultato: {
            resultType: 'complete',
            content: [{
              type: 'text',
              text: `Input validation error: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
            }],
            isError: true,
          },
        };
      }
      try {
        const esito = await tool.handler(parsed.data as Record<string, unknown>);
        return {
          tipo: 'risposta',
          risultato: {
            resultType: 'complete',
            content: esito.content,
            isError: esito.isError ?? false,
          },
        };
      } catch (e) {
        return {
          tipo: 'risposta',
          risultato: {
            resultType: 'complete',
            content: [{ type: 'text', text: `ERROR: ${(e as Error).message}` }],
            isError: true,
          },
        };
      }
    }

    default:
      return {
        tipo: 'errore',
        codice: ERRORE.metodoNonTrovato,
        messaggio: `Method not found: ${method}`,
      };
  }
}

/** Involucro JSON-RPC 2.0 di una risposta. */
export function bustaRisposta(id: unknown, risultato: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result: risultato });
}

/** Involucro JSON-RPC 2.0 di un errore. */
export function bustaErrore(id: unknown, codice: number, messaggio: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: codice, message: messaggio } });
}
