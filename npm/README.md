# @zornade/mcp

Italian cadastral data for AI agents, for MCP clients that only speak stdio.

The server itself is remote and speaks MCP `2026-07-28` over streamable HTTP at
`https://mcp.zornade.com/mcp`. This package is a bridge: it starts, connects to that endpoint, and
translates between the stdio transport your client understands and the HTTP transport the server
serves.

## Perche' serve

La maggior parte dei client desktop parla ancora la revisione `2025-11-25` del protocollo, che
prevede il handshake `initialize`. Il nostro server implementa `2026-07-28`, che quel handshake lo ha
ritirato. Il ponte risolve la differenza: sonda `server/discover` una volta, e se trova un server
moderno risponde lui al handshake del client e riscrive le richieste successive nell'era nuova. Se
trova un server vecchio non cambia niente.

Questa e' la ragione per cui il pacchetto esiste: un bridge generico non puo' sapere che dall'altra
parte c'e' un server `2026-07-28`.

## Uso

```json
{
  "mcpServers": {
    "zornade": {
      "command": "npx",
      "args": ["-y", "@zornade/mcp"],
      "env": {
        "ZORNADE_API_KEY": "zrn_..."
      }
    }
  }
}
```

La chiave e' gratuita e si genera su <https://app.zornade.com/api>. Senza chiave il ponte lascia
partire il flusso OAuth: il server conia una chiave personale alla prima connessione.

`-y` evita la domanda di conferma di `npx` al primo avvio, che molti client non sanno gestire.

## Variabili d'ambiente

| Variabile | Default | A cosa serve |
|---|---|---|
| `ZORNADE_API_KEY` | nessuna | chiave `zrn_...`. Se c'e', viene mandata come header `x-api-key`. Se non c'e', si usa OAuth |
| `ZORNADE_MCP_URL` | `https://mcp.zornade.com/mcp` | endpoint alternativo, utile per puntare a un server locale o a un fork |

Ogni altro argomento sulla riga di comando viene passato al ponte, quindi `--debug`, `--transport
sse-only` e le altre opzioni di `mcp-remote` restano disponibili:

```bash
npx -y @zornade/mcp --debug
```

## Cosa espone il server

| Tool | Cosa fa |
|---|---|
| `zornade_geocode_search` | geocoding diretto su indirizzi italiani, archivio ANNCSU |
| `zornade_geocode_reverse` | geocoding inverso da coordinate |
| `zornade_parcel_by_id` | profilo di una particella: rischio, OMI, terreno, popolazione, edifici, economia, uso del suolo, patrimonio culturale, POI, fotovoltaico, nightlights |
| `zornade_parcel_locate` | particelle da coordinate o bounding box |
| `zornade_parcel_search` | ricerca per riferimento catastale |
| `zornade_admin_lists` | regioni, province e comuni |

Il dettaglio dei parametri si legge con `tools/list`, oppure su <https://mcp.zornade.com>.

## Sviluppo

```bash
npm install
npm test          # test unitari, nessuna rete
npm run test:e2e  # sonda il server vero e verifica l'header, richiede rete
```

## Licenza

MIT. Il codice del server e' su <https://github.com/zornade/zornade-mcp>.
