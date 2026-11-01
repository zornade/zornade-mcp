# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-11-01

Registry metadata, licence and support surfaced to clients, and a landing page
that states what the server costs.

### Changed

- `server.json`: added `repository.id` (the stable GitHub repo id, which lets
  registries detect a deleted-and-recreated repository), a 512x512 `icons`
  entry, and `websiteUrl` pointing at `https://mcp.zornade.com` instead of the
  marketing home, so a client that follows the manifest lands on setup
  instructions rather than a product page.
- The `x-api-key` header is no longer `isRequired`. The server accepts OAuth 2.1
  through Supabase and mints a personal key on first connection, so clients that
  sign in should not be forced to paste a key. The description now says which
  case is which.
- `serverInfo.version` and the root JSON manifest report `1.2.0` on both
  transports (HTTP and stdio), so the running server and the registry entry
  agree.
- The root JSON manifest now exposes `website`, `pricing`, `licence`, `support`
  and `status` next to `documentation`. An agent that only reads that endpoint
  can find the commercial terms without crawling the site.

### Added

- `mcp.zornade.com` landing: the six tools with their annotations, the two
  authentication paths, and the price list (free with attribution, licence from
  490 EUR/year, support contract from 1.800 EUR/year with a 4.800 EUR tier).
  The page used to stop at the endpoint.

## [1.1.0] - 2026-10-05

Tool metadata for directories and clients, plus packaging fixes.

### Added

- `title` and `annotations` (`readOnlyHint`, `idempotentHint`,
  `openWorldHint`, `audience`) on all six tools, per MCP specification
  2025-06-18. The Claude connectors directory requires every tool to expose a
  `title` plus `readOnlyHint` or `destructiveHint`, and the other clients use
  the hints to skip confirmation prompts on read-only calls. Exposed on both
  transports.
- `server.json`, the manifest for the official MCP Registry
  (`registry.modelcontextprotocol.io`): publishes `io.github.zornade/zornade-mcp`
  with the remote endpoint and the `x-api-key` header declaration.
- "Add to Cursor" install link in the README
  (`cursor://anysphere.cursor-deeplink/mcp/install?...`).

### Changed

- `mcp-lite` 0.8.2 to 0.10.0, which is the first release with tool annotation
  support. The Host and Origin validation introduced in 0.9.0 is opt-in and
  stays disabled: it runs only when `allowedHosts` or `allowedOrigins` is
  passed to the transport, so the Netlify proxy path is unaffected.

### Fixed

- Dockerfile: the build copied only `functions/mcp/index.ts`, so `deno cache`
  failed on the `./tools.ts` import added with the shared tools module, and the
  image could not be built. The whole `functions/mcp/` directory is copied now
  and both entrypoints (`index.ts`, `stdio.ts`) are cached.

## [1.0.0] - 2026-09-19

First public release.

### Added

- MCP server for the Zornade API v2, implemented as a Deno Supabase Edge
  Function (mcp-lite + Hono, streamable HTTP transport).
- Six tools:
  - `zornade_geocode_search` - forward geocoding on the ANNCSU street archive
    (18.7+ million Italian addresses).
  - `zornade_geocode_reverse` - reverse geocoding by WGS84 coordinates.
  - `zornade_parcel_by_id` - enriched cadastral parcel profile by FID or GML
    ID (risk, economics, solar, valuation and more, geometry omitted).
  - `zornade_parcel_locate` - parcels by point, multiple points or bounding
    box.
  - `zornade_parcel_search` - parcels by comune, foglio, label, sezione.
  - `zornade_admin_lists` - regions, provinces and municipalities.
- API key passthrough: the client key is accepted as `x-api-key` header,
  `Authorization: Bearer` header or `?api_key=` query parameter, with an
  optional `ZORNADE_API_KEY` environment fallback for self-hosting and
  automated checks.
- Public endpoint `https://mcp.zornade.com/mcp` via Netlify reverse proxy.
- Dockerfile and healthcheck for self-hosting: the HTTP server listens on
  port 8000 by default, or on a comma-separated list of ports via
  `ZORNADE_LISTEN_PORTS`.
- Stdio entrypoint (`functions/mcp/stdio.ts`) speaking JSON-RPC on
  stdin/stdout, used for local agent usage and automated directory checks.
- Shared tool definitions module (`functions/mcp/tools.ts`) so HTTP and stdio
  transports expose the exact same tools.
- MIT license and README with connection instructions for Claude Code,
  Claude Desktop and other MCP clients.

### Known limitations

- The HTTP transport is stateless: no persistent SSE sessions.
- Tool calls require a free Zornade API key (10,000 requests/hour per key).
