// ─────────────────────────────────────────────────────────────────────────────
// Zornade MCP - definizioni condivise dei tool (HTTP + stdio)
//
// Modulo senza side effect. buildTools() costruisce i sei strumenti MCP a
// partire da una chiave API. Usato da:
//   - index.ts  Supabase Edge Function, mcp-lite streamable HTTP
//   - stdio.ts  container Docker (check Glama), JSON-RPC su stdin/stdout
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'npm:zod@4.6.7';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.49.8';

const ZORNADE_BASE = 'https://api.zornade.com/api/v2';

export interface ToolTextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// Annotazioni MCP (spec 2025-06-18). Servono a due cose concrete: la directory
// dei connettori di Claude richiede che OGNI tool abbia `title` e
// `readOnlyHint` o `destructiveHint`, e gli altri client (Cursor, Copilot,
// Cline) usano i hint per decidere se chiedere conferma prima di eseguire.
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  audience?: Array<'user' | 'assistant'>;
  priority?: number;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  // Tutti e sei i tool usano z.object({...}): il tipo lo dichiara, cosi' l'SDK
  // v2 puo' ricevere `.shape` (overload ZodRawShape) senza cast e senza
  // dipendere dall'interfaccia StandardJSONSchema, che zod 4.1 non espone.
  inputSchema: z.ZodObject<z.ZodRawShape>;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Promise<ToolTextResult>;
}

// Tutti i sei tool sono di sola lettura: leggono dati catastali e geografici
// pubblici dall'API v2 e non modificano niente, né da noi né da terzi. Sono
// idempotenti (stessa query, stesso risultato) e "open world" perché la
// risposta arriva da un sistema esterno al server MCP.
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
  audience: ['assistant'],
};

interface ApiErrorBody {
  error?: string;
  message?: string;
}

export function extractApiKey(req: Request): string | null {
  const header = req.headers.get('x-api-key');
  if (header?.startsWith('zrn_')) return header;
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token.startsWith('zrn_')) return token;
  }
  const param = new URL(req.url).searchParams.get('api_key');
  if (param?.startsWith('zrn_')) return param;
  // Fallback: chiave di default dall'ambiente (self-hosting / check automatici
  // tipo Glama, che iniettano ZORNADE_API_KEY come placeholder).
  const envKey = Deno.env.get('ZORNADE_API_KEY');
  if (envKey?.startsWith('zrn_')) return envKey;
  return null;
}

// ─── OAuth 2.1: accesso MCP senza incollare una chiave ─────────────────────
//
// Il client MCP puo' autenticarsi in due modi: con la chiave API nell'header
// x-api-key (come sempre), oppure con un access token Supabase nel Bearer, che
// e' quello che usano i client che fanno il flusso OAuth (Claude, Cursor,
// Postman). Nel secondo caso l'utente non ha nessuna chiave da incollare: la
// chiave personale gliela mintiamo al primo collegamento con
// `ensure_mcp_token`, che la registra in api_tokens (solo hash) e ne conserva
// il valore in chiaro in Supabase Vault.

/** Access token Supabase presente nel Bearer (null se assente o se e' una chiave zrn_). */
export function extractSupabaseToken(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token || token.startsWith('zrn_')) return null;
  return token;
}

/**
 * Valida un access token Supabase e restituisce l'id dell'utente.
 *
 * Verifica lato Auth server (`/auth/v1/user`) invece di controllare la firma in
 * locale: cosi' funziona anche con la chiave JWT simmetrica, senza dipendere
 * dal JWKS, che oggi e' vuoto. Il costo e' un giro di rete in piu' per
 * richiesta, accettabile perche' l'handshake avviene una volta per chiamata.
 */
export async function utenteDaTokenSupabase(token: string): Promise<string | null> {
  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anon) return null;
  try {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const dati = (await res.json()) as { id?: string };
    return dati?.id ?? null;
  } catch {
    return null;
  }
}

/** Cache utente -> chiave, per la vita dell'isolato: evita un RPC a ogni chiamata. */
const _chiaveCache = new Map<string, { chiave: string; scadenza: number }>();
const TTL_CHIAVE_MS = 10 * 60 * 1000;

/**
 * Chiave API dell'utente per l'accesso MCP, creandola alla prima chiamata.
 * Richiede il service role: la funzione nel database revoca EXECUTE ad anon e
 * authenticated proprio perche' consegna un segreto in chiaro.
 */
export async function chiaveMcpDaUtente(userId: string): Promise<string | null> {
  const inCache = _chiaveCache.get(userId);
  if (inCache && inCache.scadenza > Date.now()) return inCache.chiave;

  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;

  try {
    const res = await fetch(`${url}/rest/v1/rpc/ensure_mcp_token`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_user_id: userId }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error('ensure_mcp_token failed:', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const chiave = (await res.json()) as unknown;
    if (typeof chiave !== 'string' || !chiave.startsWith('zrn_')) return null;
    _chiaveCache.set(userId, { chiave, scadenza: Date.now() + TTL_CHIAVE_MS });
    return chiave;
  } catch (e) {
    console.error('ensure_mcp_token error:', (e as Error).message);
    return null;
  }
}

// ─── Logging usage (tabella mcp_usage, fire-and-forget) ─────────────────────

let _usageDb: SupabaseClient | null = null;

function usageDb(): SupabaseClient | null {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  if (!_usageDb) {
    _usageDb = createClient(url, key, { auth: { persistSession: false } });
  }
  return _usageDb;
}

// Chiave -> id del token, con l'impronta SHA-256 su cui `api-v2` autentica le
// richieste: cosi' il conteggio MCP e il conteggio REST sono attribuiti alla
// stessa riga di `api_tokens`, senza confrontare prefissi troncati.
//
// La lettura e' DIRETTA su api_tokens e non passa da `validate_api_key`: quella
// funzione incrementa `total_requests` e `last_used_at` come effetto collaterale,
// quindi chiamarla qui conterebbe due volte la stessa chiamata (una per l'API,
// una per il log dell'MCP).
const _tokenCache = new Map<string, string | null>();

async function hashChiave(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function tokenIdDaChiave(db: SupabaseClient, apiKey: string): Promise<string | null> {
  const hash = await hashChiave(apiKey);
  const inCache = _tokenCache.get(hash);
  if (inCache !== undefined) return inCache;
  const { data, error } = await db.from('api_tokens').select('id').eq('token_hash', hash).maybeSingle();
  const id = error || !data ? null : (data as { id: string }).id;
  // Anche una chiave non risolta resta in cache: una chiave cancellata non deve
  // provocare una query a ogni chiamata.
  _tokenCache.set(hash, id);
  return id;
}

export function logMcpUsage(entry: {
  tool: string;
  status?: string;
  statusCode?: number | null;
  durationMs?: number | null;
  /** Chiave API della chiamata: da qui si ricava il token a cui attribuirla. */
  apiKey?: string | null;
  client?: string | null;
}): void {
  const db = usageDb();
  if (!db) return;
  void (async () => {
    try {
      const tokenId = entry.apiKey ? await tokenIdDaChiave(db, entry.apiKey) : null;
      const r = await db.from('mcp_usage').insert({
        tool: entry.tool,
        status: entry.status ?? 'ok',
        status_code: entry.statusCode ?? null,
        duration_ms: entry.durationMs ?? null,
        token_prefix: entry.apiKey ? entry.apiKey.slice(0, 8) : null,
        token_id: tokenId,
        client: entry.client ?? null,
      });
      if (r.error) console.error('mcp_usage insert failed:', r.error.message);
    } catch {
      // Il logging non deve mai interferire con la risposta MCP.
    }
  })();
}

// ─── Traduzione etichette in inglese per il livello MCP ──────────────────
//
// L'API v2 espone quasi tutti i nomi di campo in inglese. Le poche eccezioni
// italiane vengono tradotte qui, SOLO per le risposte MCP: l'API REST resta
// invariata per i client esistenti. I valori restano in italiano dove sono
// nomi propri (comuni, strade, regioni) o termini catastali ufficiali (foglio).

const KEY_RENAMES: Record<string, string> = {
  sezione_urbana: 'urban_section',
  comune_code: 'municipality_code',
};

const VALUE_TRANSLATIONS: Record<string, Record<string, string>> = {
  risk_label: {
    trascurabile: 'negligible',
    basso: 'low',
    medio: 'medium',
    alto: 'high',
    elevato: 'very high',
  },
  direction: {
    stabile: 'stable',
    subsidenza: 'subsidence',
    sollevamento: 'uplift',
  },
};

function translateToEnglish(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) translateToEnglish(item);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (typeof value === 'string') {
        const map = VALUE_TRANSLATIONS[key];
        if (map && map[value] !== undefined) obj[key] = map[value];
      } else {
        translateToEnglish(value);
      }
      if (key in KEY_RENAMES) {
        obj[KEY_RENAMES[key]] = value;
        delete obj[key];
      }
    }
  }
}

async function callApi(apiKey: string | null, endpoint: string, toolName: string): Promise<string> {
  const started = Date.now();
  if (!apiKey) {
    logMcpUsage({ tool: toolName, status: 'error', durationMs: Date.now() - started });
    return 'ERROR: Zornade API key missing. Send it as x-api-key header, Authorization: Bearer header, or ?api_key= query parameter. Free keys: https://app.zornade.com/api';
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(`${ZORNADE_BASE}/${endpoint}`, {
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    const body = (await r.json()) as (Record<string, unknown> & ApiErrorBody) | null;
    const ms = Date.now() - started;
    logMcpUsage({
      tool: toolName,
      status: r.ok ? 'ok' : 'error',
      statusCode: r.status,
      durationMs: ms,
      apiKey,
    });
    if (!r.ok) {
      const err = (body ?? {}) as ApiErrorBody;
      return `ERROR (HTTP ${r.status}): ${err.message ?? err.error ?? 'unknown error'}`;
    }
    // Il dettaglio particella include la geometria GeoJSON completa: la
    // rimuoviamo per tenere il contesto LLM leggero (i token costano).
    const data = (body as { data?: { geometry?: unknown } }).data;
    if (data && 'geometry' in data) delete data.geometry;
    translateToEnglish(body);
    return JSON.stringify(body, null, 2);
  } catch (e) {
    logMcpUsage({
      tool: toolName,
      status: 'error',
      durationMs: Date.now() - started,
      apiKey,
    });
    if ((e as Error).name === 'AbortError') {
      return 'ERROR: Zornade API call timed out after 20 seconds.';
    }
    return `ERROR: API call failed (${(e as Error).message})`;
  } finally {
    clearTimeout(timer);
  }
}

export function buildTools(apiKey: string | null): ToolDef[] {
  const textResult = (out: string): ToolTextResult => ({
    content: [{ type: 'text', text: out }],
    isError: out.startsWith('ERROR'),
  });

  return [
    {
      name: 'zornade_geocode_search',
      title: 'Geocode Italian addresses',
      annotations: READ_ONLY,
      description:
        'Forward geocoding for Italian addresses. Searches the ANNCSU street archive ' +
        '(18.7+ million addresses) by street name and optional municipality. ' +
        'Returns matches with WGS84 coordinates, postal code, municipality, province and region. ' +
        'Does NOT find points of interest: search by street name instead.',
      inputSchema: z.object({
        q: z.string().describe('Street name or search text, min 2 chars. Example: "Via del Corso"'),
        city: z.string().optional().describe('Municipality name filter. Example: "Roma"'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results, default 10'),
      }),
      handler: async (raw: Record<string, unknown>) => {
        const args = raw as { q: string; city?: string; limit?: number };
        const p = new URLSearchParams();
        p.set('q', args.q);
        if (args.city) p.set('city', args.city);
        p.set('limit', String(args.limit ?? 10));
        return textResult(await callApi(apiKey, `geocode/search?${p.toString()}`, 'zornade_geocode_search'));
      },
    },
    {
      name: 'zornade_geocode_reverse',
      title: 'Reverse geocode coordinates to addresses',
      annotations: READ_ONLY,
      description:
        'Reverse geocoding: find Italian addresses near WGS84 coordinates. ' +
        'Returns the closest ANNCSU addresses with distance in meters.',
      inputSchema: z.object({
        lat: z.number().min(35.5).max(47.5).describe('Latitude WGS84, Italy bounds 35.5-47.5'),
        lng: z.number().min(6.0).max(19.0).describe('Longitude WGS84, Italy bounds 6.0-19.0'),
        radius: z.number().int().min(1).max(500).optional().describe('Search radius in meters, default 100, max 500'),
        limit: z.number().int().min(1).max(20).optional().describe('Max results, default 5'),
      }),
      handler: async (raw: Record<string, unknown>) => {
        const args = raw as { lat: number; lng: number; radius?: number; limit?: number };
        const p = new URLSearchParams();
        p.set('lat', String(args.lat));
        p.set('lng', String(args.lng));
        p.set('radius', String(args.radius ?? 100));
        p.set('limit', String(args.limit ?? 5));
        return textResult(await callApi(apiKey, `geocode/reverse?${p.toString()}`, 'zornade_geocode_reverse'));
      },
    },
    {
      name: 'zornade_parcel_by_id',
      title: 'Get cadastral parcel profile',
      annotations: READ_ONLY,
      description:
        'Enriched cadastral parcel profile by FID or GML ID. ' +
        'Returns municipality, area, cadastral reference, and the requested data sections ' +
        '(risk, subsidence, terrain, buildings, economics, demographics, valuation, ' +
        'valuation_history, solar, POI, etc.). Geometry is omitted to keep the reply compact.',
      inputSchema: z.object({
        fid: z.string().describe('Parcel FID number (example "28009975") or GML ID'),
        include: z
          .string()
          .optional()
          .describe(
            'Comma-separated sections: risk,subsidence,terrain,population,buildings,economics,' +
              'demographics,land_cover,land_use,valuation,valuation_history,coastal_erosion,' +
              'cultural_heritage,poi,solar,nightlights,nightlights_v2. ' +
              'Default: risk,economics,solar,valuation. ' +
              'nightlights_v2 is the current VIIRS per-parcel section (measurement, not an estimate) ' +
              'and must be requested by name: it is not part of all. nightlights is deprecated ' +
              '(removal 2027-04-12).',
          ),
      }),
      handler: async (raw: Record<string, unknown>) => {
        const args = raw as { fid: string; include?: string };
        const include = args.include ?? 'risk,economics,solar,valuation';
        return textResult(
          await callApi(apiKey, `parcels/${encodeURIComponent(args.fid)}?include=${encodeURIComponent(include)}`, 'zornade_parcel_by_id'),
        );
      },
    },
    {
      name: 'zornade_parcel_locate',
      title: 'Find cadastral parcels by coordinates or bounding box',
      annotations: READ_ONLY,
      description:
        'Find cadastral parcels by coordinates or bounding box. Three modes: ' +
        'single point (lat+lng), multiple points (points="lat,lng;lat,lng", max 10), ' +
        'or bounding box (bbox="minLng,minLat,maxLng,maxLat", max 0.05 degrees per side). ' +
        'Returns matching parcels with FID, municipality and centroid.',
      inputSchema: z.object({
        lat: z.number().optional().describe('Latitude for single-point mode'),
        lng: z.number().optional().describe('Longitude for single-point mode'),
        points: z
          .string()
          .optional()
          .describe('Multiple points as "lat,lng;lat,lng", max 10 pairs'),
        bbox: z
          .string()
          .optional()
          .describe('Bounding box as "minLng,minLat,maxLng,maxLat", max 0.05 degrees per side'),
        limit: z.number().int().min(1).max(200).optional().describe('Max results, default 50'),
      }),
      handler: async (raw: Record<string, unknown>) => {
        const args = raw as {
          lat?: number;
          lng?: number;
          points?: string;
          bbox?: string;
          limit?: number;
        };
        const p = new URLSearchParams();
        if (args.bbox) {
          p.set('bbox', args.bbox);
        } else if (args.points) {
          p.set('points', args.points);
        } else if (args.lat != null && args.lng != null) {
          p.set('lat', String(args.lat));
          p.set('lng', String(args.lng));
        } else {
          return textResult(
            'ERROR: provide one of: lat+lng, points, or bbox (see tool description).',
          );
        }
        p.set('limit', String(args.limit ?? 50));
        return textResult(await callApi(apiKey, `parcels/locate?${p.toString()}`, 'zornade_parcel_locate'));
      },
    },
    {
      name: 'zornade_parcel_search',
      title: 'Search parcels by cadastral reference',
      annotations: READ_ONLY,
      description:
        'Search cadastral parcels by cadastral reference: municipality (fuzzy match), ' +
        'sheet number (foglio), parcel label, optional section. ' +
        'Returns matching parcels with FID, municipality, sheet, area and centroid.',
      inputSchema: z.object({
        comune: z.string().describe('Municipality name, required. Example: "Roma"'),
        foglio: z.string().optional().describe('Cadastral sheet number. Example: "481"'),
        label: z.string().optional().describe('Parcel label. Example: "A" or "123"'),
        sezione: z.string().optional().describe('Administrative section. Example: "A"'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results, default 20'),
      }),
      handler: async (raw: Record<string, unknown>) => {
        const args = raw as {
          comune: string;
          foglio?: string;
          label?: string;
          sezione?: string;
          limit?: number;
        };
        const p = new URLSearchParams();
        p.set('comune', args.comune);
        if (args.foglio) p.set('foglio', args.foglio);
        if (args.label) p.set('label', args.label);
        if (args.sezione) p.set('sezione', args.sezione);
        p.set('limit', String(args.limit ?? 20));
        return textResult(await callApi(apiKey, `parcels/search?${p.toString()}`, 'zornade_parcel_search'));
      },
    },
    {
      name: 'zornade_admin_lists',
      title: 'List Italian regions, provinces and municipalities',
      annotations: READ_ONLY,
      description:
        'Italian administrative reference data: regions, provinces, or municipalities. ' +
        'Provinces can be filtered by region; municipalities by province or region.',
      inputSchema: z.object({
        type: z
          .enum(['regions', 'provinces', 'municipalities'])
          .describe('Which administrative list to return'),
        region: z.string().optional().describe('Filter by region name (provinces, municipalities)'),
        province: z.string().optional().describe('Filter by province name (municipalities)'),
      }),
      handler: async (raw: Record<string, unknown>) => {
        const args = raw as {
          type: 'regions' | 'provinces' | 'municipalities';
          region?: string;
          province?: string;
        };
        const p = new URLSearchParams();
        if (args.region) p.set('region', args.region);
        if (args.province) p.set('province', args.province);
        const qs = p.toString();
        return textResult(await callApi(apiKey, `admin/${args.type}${qs ? `?${qs}` : ''}`, 'zornade_admin_lists'));
      },
    },
  ];
}
