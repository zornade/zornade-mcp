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

import { Hono } from 'npm:hono@4.6.14';
import { McpServer, StreamableHttpTransport } from 'npm:mcp-lite@0.8.2';
import { z } from 'npm:zod@4.1.12';

const ZORNADE_BASE = 'https://api.zornade.com/api/v2';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-api-key, content-type, mcp-session-id, mcp-protocol-version, last-event-id, accept',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'mcp-session-id',
};

interface ApiErrorBody {
  error?: string;
  message?: string;
}

function extractApiKey(req: Request): string | null {
  const header = req.headers.get('x-api-key');
  if (header?.startsWith('zrn_')) return header;
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token.startsWith('zrn_')) return token;
  }
  const param = new URL(req.url).searchParams.get('api_key');
  if (param?.startsWith('zrn_')) return param;
  return null;
}

async function callApi(apiKey: string | null, endpoint: string): Promise<string> {
  if (!apiKey) {
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
    if (!r.ok) {
      const err = (body ?? {}) as ApiErrorBody;
      return `ERROR (HTTP ${r.status}): ${err.message ?? err.error ?? 'unknown error'}`;
    }
    // Il dettaglio particella include la geometria GeoJSON completa: la
    // rimuoviamo per tenere il contesto LLM leggero (i token costano).
    const data = (body as { data?: { geometry?: unknown } }).data;
    if (data && 'geometry' in data) delete data.geometry;
    return JSON.stringify(body, null, 2);
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      return 'ERROR: Zornade API call timed out after 20 seconds.';
    }
    return `ERROR: API call failed (${(e as Error).message})`;
  } finally {
    clearTimeout(timer);
  }
}

function createMcp(apiKey: string | null): McpServer {
  const mcp = new McpServer({
    name: 'zornade',
    version: '1.0.0',
    schemaAdapter: (schema) => z.toJSONSchema(schema as z.ZodType),
  });

  const textResult = (out: string) => ({
    content: [{ type: 'text' as const, text: out }],
    isError: out.startsWith('ERROR'),
  });

  mcp.tool('zornade_geocode_search', {
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
    handler: async (args: { q: string; city?: string; limit?: number }) => {
      const p = new URLSearchParams();
      p.set('q', args.q);
      if (args.city) p.set('city', args.city);
      p.set('limit', String(args.limit ?? 10));
      return textResult(await callApi(apiKey, `geocode/search?${p.toString()}`));
    },
  });

  mcp.tool('zornade_geocode_reverse', {
    description:
      'Reverse geocoding: find Italian addresses near WGS84 coordinates. ' +
      'Returns the closest ANNCSU addresses with distance in meters.',
    inputSchema: z.object({
      lat: z.number().min(35.5).max(47.5).describe('Latitude WGS84, Italy bounds 35.5-47.5'),
      lng: z.number().min(6.0).max(19.0).describe('Longitude WGS84, Italy bounds 6.0-19.0'),
      radius: z.number().int().min(1).max(500).optional().describe('Search radius in meters, default 100, max 500'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results, default 5'),
    }),
    handler: async (args: { lat: number; lng: number; radius?: number; limit?: number }) => {
      const p = new URLSearchParams();
      p.set('lat', String(args.lat));
      p.set('lng', String(args.lng));
      p.set('radius', String(args.radius ?? 100));
      p.set('limit', String(args.limit ?? 5));
      return textResult(await callApi(apiKey, `geocode/reverse?${p.toString()}`));
    },
  });

  mcp.tool('zornade_parcel_by_id', {
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
            'cultural_heritage,poi,solar,nightlights. Default: risk,economics,solar,valuation',
        ),
    }),
    handler: async (args: { fid: string; include?: string }) => {
      const include = args.include ?? 'risk,economics,solar,valuation';
      return textResult(
        await callApi(apiKey, `parcels/${encodeURIComponent(args.fid)}?include=${encodeURIComponent(include)}`),
      );
    },
  });

  mcp.tool('zornade_parcel_locate', {
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
    handler: async (args: {
      lat?: number;
      lng?: number;
      points?: string;
      bbox?: string;
      limit?: number;
    }) => {
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
      return textResult(await callApi(apiKey, `parcels/locate?${p.toString()}`));
    },
  });

  mcp.tool('zornade_parcel_search', {
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
    handler: async (args: {
      comune: string;
      foglio?: string;
      label?: string;
      sezione?: string;
      limit?: number;
    }) => {
      const p = new URLSearchParams();
      p.set('comune', args.comune);
      if (args.foglio) p.set('foglio', args.foglio);
      if (args.label) p.set('label', args.label);
      if (args.sezione) p.set('sezione', args.sezione);
      p.set('limit', String(args.limit ?? 20));
      return textResult(await callApi(apiKey, `parcels/search?${p.toString()}`));
    },
  });

  mcp.tool('zornade_admin_lists', {
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
    handler: async (args: { type: 'regions' | 'provinces' | 'municipalities'; region?: string; province?: string }) => {
      const p = new URLSearchParams();
      if (args.region) p.set('region', args.region);
      if (args.province) p.set('province', args.province);
      const qs = p.toString();
      return textResult(await callApi(apiKey, `admin/${args.type}${qs ? `?${qs}` : ''}`));
    },
  });

  return mcp;
}

// ─── Routing (pattern Supabase: la funzione è montata su /mcp/*) ─────────────

const mcpApp = new Hono();

mcpApp.get('/', (c) =>
  c.json({
    name: 'Zornade MCP server',
    version: '1.0.0',
    description:
      'MCP (Model Context Protocol) server for Zornade API v2: Italian cadastral parcels, geocoding and administrative data.',
    mcp_endpoint: `${new URL(c.req.url).origin}/mcp`,
    authentication:
      'Send your free Zornade API key (zrn_...) via x-api-key header, Authorization: Bearer, or ?api_key= query parameter. Get one at https://app.zornade.com/api',
    documentation: 'https://api.zornade.com',
  }),
);

mcpApp.options('/mcp', (c) => new Response(null, { status: 204, headers: CORS }));

mcpApp.all('/mcp', async (c) => {
  // Per ogni richiesta costruiamo il server con la chiave estratta dagli
  // header: gli handler dei tool la chiudono nel proprio scope.
  const apiKey = extractApiKey(c.req.raw);
  const mcp = createMcp(apiKey);
  const transport = new StreamableHttpTransport();
  const httpHandler = transport.bind(mcp);
  const res = await httpHandler(c.req.raw);
  for (const [k, v] of Object.entries(CORS)) {
    res.headers.set(k, v);
  }
  return res;
});

const app = new Hono();
app.route('/mcp', mcpApp);

Deno.serve(app.fetch);
