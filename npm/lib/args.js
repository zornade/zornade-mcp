const ENDPOINT_PREDEFINITO = "https://mcp.zornade.com/mcp";

export function costruisciArgomenti({ endpoint, chiave, extra = [] } = {}) {
  const url = (endpoint || "").trim() || ENDPOINT_PREDEFINITO;
  const argomenti = [url, "--protocol", "auto"];

  // x-api-key:VALORE senza spazio: Cursor, Codex-CLI e Claude Desktop su Windows
  // non fanno l'escaping degli spazi negli args passati a npx.
  const token = (chiave || "").trim();
  if (token) argomenti.push("--header", `x-api-key:${token}`);

  return argomenti.concat(extra);
}

export { ENDPOINT_PREDEFINITO };
