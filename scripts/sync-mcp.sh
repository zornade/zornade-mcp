#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Sincronizza il codice dell'MCP fra il repository pubblico e la cartella da
# cui si deploya la Edge Function su Supabase.
#
# Perche' serve. Il codice vive in due posti:
#   - zornade-mcp-repo/functions/mcp/     quello che vedono GitHub e i registri
#   - app/supabase/functions/mcp/         quello che Supabase CLI carica
# Sono due copie indipendenti: una modifica fatta solo nella prima non arriva in
# produzione, e una modifica fatta solo nella seconda non e' versionata. Il 10
# novembre 2026 le due copie erano divergenti e la produzione serviva
# descrizioni dei tool piu' vecchie di quelle pubblicate.
#
# Uso:
#   ./scripts/sync-mcp.sh            copia repo -> app
#   ./scripts/sync-mcp.sh --check    non copia; esce 1 se le copie divergono
#
# La cartella di destinazione si puo' cambiare con ZORNADE_APP_FUNCTIONS.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${REPO_ROOT}/functions/mcp"
DST="${ZORNADE_APP_FUNCTIONS:-${REPO_ROOT}/../app/supabase/functions/mcp}"

# I file che compongono la funzione. Se se ne aggiunge uno va aggiunto qui,
# altrimenti il check non lo vede e il deploy non lo carica.
FILES=(index.ts stdio.ts dispatch.ts tools.ts)

if [[ ! -d "${SRC}" ]]; then
  echo "errore: cartella sorgente non trovata: ${SRC}" >&2
  exit 2
fi
if [[ ! -d "${DST}" ]]; then
  echo "errore: cartella di destinazione non trovata: ${DST}" >&2
  echo "        passala con ZORNADE_APP_FUNCTIONS=/percorso/functions/mcp" >&2
  exit 2
fi

MODE="sync"
if [[ "${1:-}" == "--check" ]]; then
  MODE="check"
elif [[ -n "${1:-}" ]]; then
  echo "errore: opzione sconosciuta '${1}'. Usa --check oppure niente." >&2
  exit 2
fi

differenze=()
for f in "${FILES[@]}"; do
  if [[ ! -f "${SRC}/${f}" ]]; then
    echo "errore: manca ${SRC}/${f}" >&2
    exit 2
  fi
  if [[ ! -f "${DST}/${f}" ]]; then
    differenze+=("${f} (assente nella destinazione)")
    continue
  fi
  if ! cmp -s "${SRC}/${f}" "${DST}/${f}"; then
    differenze+=("${f}")
  fi
done

# File presenti nella destinazione ma non nella lista: segnalati, non copiati.
while IFS= read -r extra; do
  nome="$(basename "${extra}")"
  if [[ ! " ${FILES[*]} " == *" ${nome} "* ]]; then
    differenze+=("${nome} (presente solo nella destinazione)")
  fi
done < <(find "${DST}" -maxdepth 1 -name '*.ts' -type f)

if [[ ${#differenze[@]} -eq 0 ]]; then
  echo "ok: le due copie sono identiche (${#FILES[@]} file)"
  exit 0
fi

if [[ "${MODE}" == "check" ]]; then
  echo "DIVERSE: ${#differenze[@]} file fuori sincrono" >&2
  for d in "${differenze[@]}"; do echo "  - ${d}" >&2; done
  echo "" >&2
  echo "La cartella di deploy non corrisponde al repository. Deployare cosi'" >&2
  echo "significa pubblicare codice diverso da quello versionato." >&2
  echo "Rimedio: ./scripts/sync-mcp.sh" >&2
  exit 1
fi

for f in "${FILES[@]}"; do
  cp "${SRC}/${f}" "${DST}/${f}"
done
echo "copiati ${#FILES[@]} file in ${DST}"
