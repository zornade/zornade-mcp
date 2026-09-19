# Zornade MCP Server

Model Context Protocol server for Italian cadastral, geospatial and real
estate data, powered by the [Zornade API v2](https://api.zornade.com).

Add it to any MCP client (Claude, Cursor, VS Code Copilot, Cline, ...) and ask
questions about Italian properties in natural language: geocoding, cadastral
parcels, risk layers, valuations, solar potential, administrative lists.

## Endpoint

```
https://mcp.zornade.com/mcp
```

## Authentication

A free Zornade API key (`zrn_...`) from
[https://app.zornade.com/api](https://app.zornade.com/api) is required. Send it
as `x-api-key` header, `Authorization: Bearer`, or `?api_key=` query parameter.
Rate limits and scopes are the ones of your key (10,000 requests/hour).

## Tools

| Tool | Description |
| --- | --- |
| `zornade_geocode_search` | Forward geocoding on 18.7M+ Italian addresses (ANNCSU) |
| `zornade_geocode_reverse` | Reverse geocoding by WGS84 coordinates |
| `zornade_parcel_by_id` | Enriched cadastral parcel profile (risk, economics, solar, valuations, POI, ...) |
| `zornade_parcel_locate` | Parcels by point, multiple points, or bounding box |
| `zornade_parcel_search` | Parcels by comune, foglio, label |
| `zornade_admin_lists` | Regions, provinces, municipalities |

## Connect

Claude Code:

```bash
claude mcp add zornade -t http https://mcp.zornade.com/mcp \
  --header "x-api-key: zrn_YOUR_KEY"
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "zornade": {
      "type": "http",
      "url": "https://mcp.zornade.com/mcp",
      "headers": { "x-api-key": "zrn_YOUR_KEY" }
    }
  }
}
```

## Test

```bash
curl -X POST https://mcp.zornade.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-api-key: zrn_YOUR_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Architecture

- `functions/mcp/index.ts` - Supabase Edge Function (Deno), built with
  [mcp-lite](https://github.com/fiberplane/mcp-lite) + Hono, streamable HTTP
  transport. Pattern from the official Supabase MCP guide.
- `netlify.toml` + `public/` - Netlify reverse proxy for the clean hostname
  `mcp.zornade.com` (no build step).

## Documentation

- API docs: [api.zornade.com](https://api.zornade.com)
- API keys: [app.zornade.com/api](https://app.zornade.com/api)
- Main site: [zornade.com](https://zornade.com)

## Known limitations

- The HTTP transport is stateless: no persistent SSE sessions. Some modern
  SDK clients open a persistent SSE GET after initialize and receive a 400;
  request/response calls work normally and that error is harmless.
- Protocol revision negotiation: the server supports the 2025 MCP revisions
  (2025-03-26 and 2025-06-18). A client requesting a newer or unknown
  revision is answered with the oldest supported revision instead of an
  error.
- Tool responses are text-only: geometries are omitted to keep the LLM
  context light.
- Tool calls require a free Zornade API key. Direct API v2 calls are the
  right tool for batch pipelines, see [api.zornade.com](https://api.zornade.com).

## License

Two distinct layers:

- **Server code: MIT.** Free to use, modify and redistribute, also for
  commercial purposes. The full text is in `LICENSE`.
- **Data: licenses of the original sources, which remain in force for every
  consumer of the API and of this server.** Key ones:
  - cadastral parcels and cadastral data: Agenzia delle Entrate (free reuse,
    attribution required)
  - addresses: ANNCSU, ISTAT and Agenzia delle Entrate (CC BY 4.0, partly
    CC BY 3.0 IT)
  - buildings and map layers: OpenStreetMap (ODbL 1.0)
  - risk and environmental layers: ISPRA, INGV, Copernicus (CC BY 4.0 /
    Copernicus Data Policy)
  - solar potential: PVGIS-SARAH3, JRC European Union (free reuse)
  - real estate market data: OMI and MEF (free reuse)

Every API response lists the applicable licenses in `meta.licenses` and the
required attribution text. Two attribution levels exist: source attributions
are always mandatory; the "Dati elaborati da Zornade" attribution with link to
zornade.com is required for free plan keys and can be waived with a commercial
license (the response field `meta.zornade_attribution_required` tells you
which rule applies). Full terms: [api.zornade.com](https://api.zornade.com).
