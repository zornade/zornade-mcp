#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Costruisce lo ZIP da caricare nel portale OpenAI (plugin directory).
#
# Il pacchetto contiene solo cio' che il portale legge: manifest del plugin,
# configurazione MCP e le immagini. Tutto il resto del repository (funzioni,
# README, Dockerfile) non serve alla submission e va tenuto fuori.
#
# Uso:  ./scripts/build-openai-zip.sh
# Esito: dist/zornade-mcp-<versione>.zip
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

VERSIONE="$(python3 -c "import json;print(json.load(open('plugin.json'))['version'])")"
OUT="dist/zornade-mcp-${VERSIONE}.zip"

FILE=(plugin.json mcp.json assets/logo.png)

for f in "${FILE[@]}"; do
  if [[ ! -f "${f}" ]]; then
    echo "errore: manca ${f}" >&2
    exit 2
  fi
done

# Controlli minimi prima di impacchettare: un errore qui fa perdere un giro di
# revisione, e la revisione non è immediata.
python3 - <<'PY'
import json, struct, sys

p = json.load(open('plugin.json', encoding='utf-8'))
m = json.load(open('mcp.json', encoding='utf-8'))

errori = []
if p.get('$schema') != 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json':
    errori.append('plugin.json: $schema deve essere la 1.0.0 (la 1.1.0 non esiste, risponde 404)')
if not p.get('name', '').count(' ') == 0 or not p.get('name', '').islower():
    errori.append('plugin.json: name deve essere minuscolo e senza spazi')

oa = p.get('extensions', {}).get('com.openai', {})
intf = oa.get('interface', {})
for campo, limite in (('displayName', 30), ('shortDescription', 30)):
    valore = intf.get(campo, '')
    if not valore:
        errori.append(f'plugin.json: manca interface.{campo}')
    elif len(valore) > limite:
        errori.append(f'plugin.json: interface.{campo} supera {limite} caratteri ({len(valore)})')
for campo in ('longDescription', 'developerName', 'category', 'logo'):
    if not intf.get(campo):
        errori.append(f'plugin.json: manca interface.{campo}')
for campo in ('websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL'):
    if not intf.get(campo, '').startswith('https://'):
        errori.append(f'plugin.json: interface.{campo} deve essere HTTPS')

casi = oa.get('review', {}).get('test_cases', {})
for tipo, attesi in (('positive', 5), ('negative', 3)):
    n = len(casi.get(tipo, []))
    if n != attesi:
        errori.append(f'plugin.json: review.test_cases.{tipo} ne ha {n}, ne servono {attesi}')
for c in casi.get('positive', []):
    for campo in ('description', 'prompt', 'tools_triggered', 'expected_behavior'):
        if not c.get(campo):
            errori.append(f'plugin.json: caso positivo senza {campo}')

if 'demo_recording_url' not in oa.get('review', {}):
    print('ATTENZIONE: manca review.demo_recording_url. Non blocca lo ZIP, ma la')
    print('revisione MCP lo richiede: va caricato il video e inserito il link.')

if not oa.get('publication', {}).get('countries'):
    errori.append('plugin.json: manca publication.countries')

srv = m.get('mcpServers', {})
if len(srv) != 1:
    errori.append(f'mcp.json: un solo server per plugin, trovati {len(srv)}')
else:
    s = next(iter(srv.values()))
    if s.get('type') != 'streamable-http':
        errori.append('mcp.json: type deve essere streamable-http')
    if not str(s.get('url', '')).startswith('https://'):
        errori.append('mcp.json: url deve essere HTTPS')
    auth = s.get('extensions', {}).get('com.openai', {}).get('auth', {})
    if auth.get('type') not in ('oauth', 'mixed', 'none'):
        errori.append('mcp.json: auth.type deve essere oauth, mixed o none (api_key non è supportata dal portale)')
    if s.get('headers'):
        errori.append('mcp.json: il portale rifiuta header non vuoti')

d = open('assets/logo.png', 'rb').read()
if d[:8] != b'\x89PNG\r\n\x1a\n':
    errori.append('assets/logo.png non è un PNG')
else:
    w, h = struct.unpack('>II', d[16:24])
    if w != h or w < 48:
        errori.append(f'assets/logo.png deve essere quadrata e almeno 48x48 (è {w}x{h})')

if errori:
    print('CONTROLLI FALLITI:', file=sys.stderr)
    for e in errori:
        print('  -', e, file=sys.stderr)
    sys.exit(1)
print(f'controlli superati: plugin {p["name"]} {p["version"]}, 1 server MCP, logo {w}x{h}')
PY

mkdir -p dist
rm -f "${OUT}"
zip -q -X "${OUT}" "${FILE[@]}"

echo "creato ${OUT}"
unzip -l "${OUT}" | sed -n '1,12p'
