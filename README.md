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

## License

MIT. Data served by the API retains its own attributions (CC BY, ODbL, Copernicus,
AdE terms) as detailed in the API documentation.
