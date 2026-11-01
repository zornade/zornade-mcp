# Politica di sicurezza — server MCP Zornade

Ultimo aggiornamento: 31 ottobre 2026

Il server MCP espone i dati Zornade a un client LLM. Due superfici contano: la chiave API che il client invia a ogni chiamata e la risposta che finisce nel contesto del modello.

## Segnalare una vulnerabilità

Non aprire una issue pubblica. Due canali:

1. **GitHub Security Advisory**: [segnala una vulnerabilità](https://github.com/zornade/zornade-mcp/security/advisories/new)
2. **Email**: `sicurezza@zornade.com`

Servono la revisione MCP usata dal client, il nome del tool coinvolto e la richiesta che ha prodotto il comportamento inatteso.

### Tempi

| Fase | Tempo massimo |
|---|---|
| Conferma di ricezione | 48 ore |
| Prima valutazione tecnica | 7 giorni |
| Correzione | dipende dalla gravità, la data prevista arriva con la valutazione |

Finestra di divulgazione coordinata di 90 giorni.

## Versioni supportate

| Versione | Supportata |
|---|---|
| Ultima release | Sì, per 5 anni dalla data di rilascio |
| Versioni precedenti | La correzione arriva sull'ultima release, che si aggiorna senza costi |

Il periodo di cinque anni è quello previsto dal Cyber Resilience Act come regola generale. Chi ha un contratto di continuità riceve la data di fine supporto della versione consegnata nell'atto di acquisto, in mese e anno.

## Dipendenze e limite noto

Il server è una Edge Function Deno costruita con `mcp-lite` e Hono, importati via URL versionati. Non esiste un manifest con lockfile, quindi Dependabot non può seguire quelle import: il SBOM generato in CI copre l'immagine container, non i moduli Deno importati via URL.

Questo è dichiarato come limite noto e non come conformità piena. Le import sono fissate a una revisione esplicita nell'URL, quindi un aggiornamento non arriva mai da solo; arriva quando lo cambiamo noi, con una modifica tracciata in git.

## Pratiche

- La chiave API arriva dal client a ogni chiamata: non viene conservata lato server e non finisce nei log.
- Il server non esegue codice fornito dall'utente e non ha accesso in scrittura ai dati.
- Le risposte sono testo: nessuna geometria, nessun file, nessun link generato dai dati.
- Il trasporto è stateless: nessuna sessione persistente da hijackare.
- Le correzioni escono come nuova release, con voce in `CHANGELOG.md`.

## Perimetro normativo

Il server è un prodotto con elementi digitali distribuito al pubblico, quindi rientra nel Cyber Resilience Act. La mappatura dei requisiti e la procedura di segnalazione alle autorità sono nel documento pubblico [docs/CRA.md](https://github.com/menimenocchio/zornade-app/blob/main/docs/CRA.md).
