import test from "node:test";
import assert from "node:assert/strict";
import { costruisciArgomenti, ENDPOINT_PREDEFINITO } from "../lib/args.js";

test("usa l'endpoint pubblico quando non ne viene passato uno", () => {
  assert.deepEqual(costruisciArgomenti(), [ENDPOINT_PREDEFINITO, "--protocol", "auto"]);
});

test("endpoint vuoto o fatto di spazi non sovrascrive il default", () => {
  assert.equal(costruisciArgomenti({ endpoint: "   " })[0], ENDPOINT_PREDEFINITO);
});

test("l'header usa i due punti senza spazio, per non finire spezzato dai client", () => {
  const argomenti = costruisciArgomenti({ chiave: "zrn_abc123" });
  const i = argomenti.indexOf("--header");
  assert.notEqual(i, -1);
  assert.equal(argomenti[i + 1], "x-api-key:zrn_abc123");
  assert.ok(!argomenti[i + 1].includes(": "));
});

test("senza chiave non viene aggiunto nessun header, cosi il client puo fare OAuth", () => {
  assert.ok(!costruisciArgomenti({ chiave: "" }).includes("--header"));
  assert.ok(!costruisciArgomenti({ chiave: "   " }).includes("--header"));
  assert.ok(!costruisciArgomenti({}).includes("--header"));
});

test("gli argomenti dell'utente passano in coda, senza sovrascrivere i nostri", () => {
  const argomenti = costruisciArgomenti({
    chiave: "zrn_abc123",
    extra: ["--debug", "--transport", "http-only"],
  });
  assert.deepEqual(argomenti.slice(0, 4), [
    ENDPOINT_PREDEFINITO,
    "--protocol",
    "auto",
    "--header",
  ]);
  assert.deepEqual(argomenti.slice(-3), ["--debug", "--transport", "http-only"]);
});

test("il protocollo auto e sempre presente, perche il server parla 2026-07-28", () => {
  const argomenti = costruisciArgomenti({ chiave: "zrn_x" });
  assert.equal(argomenti[argomenti.indexOf("--protocol") + 1], "auto");
});
