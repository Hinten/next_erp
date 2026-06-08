# `@delfrance/integrations-nfe`

NF-e (Nota Fiscal Eletrônica, model 55, layout 4.00) for SEFAZ.

## Certificate (A1 PFX) — env vars

Pick one of two ways to provide the A1 PFX (`.pfx` and `.p12` are the
same PKCS#12 format — both are accepted):

| Env var             | When to use                 | Value                                |
| ------------------- | --------------------------- | ------------------------------------ |
| `NFE_CERT_PATH`     | Local dev — most convenient | Filesystem path to the PFX file      |
| `NFE_CERT_BASE64`   | CI / secret managers        | Base-64 of the PFX bytes             |
| `NFE_CERT_PASSWORD` | **Always required**         | Passphrase the PFX was exported with |

If both `NFE_CERT_PATH` and `NFE_CERT_BASE64` are set, **path wins** —
typically a developer overriding a checked-in CI value.

```powershell
# Local dev
$env:NFE_CERT_PATH = "C:\path\to\cert.pfx"
$env:NFE_CERT_PASSWORD = "your-pfx-password"

# CI / secrets
$env:NFE_CERT_BASE64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\cert.pfx"))
$env:NFE_CERT_PASSWORD = "your-pfx-password"
```

Vitest auto-loads `.env.local` from the repo root, so either set sticks
between test runs without re-exporting in the shell.

`loadCertificateFromEnv()` picks the right source. To be explicit (e.g.
in a route handler) reach for `loadCertificateFromPath(path, pwd)` or
`loadCertificateFromBase64(b64, pwd)` directly.

### Two well-known gotchas with Brazilian A1 PFX files

1. **`ERR_CRYPTO_UNSUPPORTED_OPERATION: Unsupported PKCS12 PFX data`** —
   Node 17+ (OpenSSL 3.0) refuses to parse PFX files using legacy
   PKCS#12 ciphers (RC2-40-CBC for cert bags, 3DES-CBC for the MAC),
   which is exactly what the Receita Federal exports. **Already
   handled**: `createSefazAgent` feeds Node the PEM key + cert (decoded
   by node-forge in pure JS) instead of the raw PFX, sidestepping
   OpenSSL's PFX parser. No action needed.

2. **`UNABLE_TO_VERIFY_LEAF_SIGNATURE` on the SOAP call** — SEFAZ
   endpoints chain through Brazilian CAs (ICP-Brasil → SERPRO /
   SAFEWEB / VALID → leaf), not all of which are in Node's bundled
   Mozilla root store. Three resolution paths, in priority order:
   1. **Vendor the chain (recommended)** — run the helper script once:

      ```powershell
      pnpm --filter @delfrance/integrations-nfe fetch:sefaz-ca
      ```

      The script connects to SEFAZ-SP homologação (TOFU — trust on first
      use), captures the chain it serves, and writes a PEM bundle to
      `packages/integrations/nfe/ca/sefaz-sp-homologacao.pem`. The
      homologação smoke test auto-loads that file. The `ca/` folder is
      gitignored — each contributor / CI environment captures its own,
      since hand-verification against ICP-Brasil's published roots is
      the right step before trusting in **produção**.

   2. **Explicit env-var override** — set `NFE_TLS_CA_PATH=/abs/path/to/chain.pem`
      to point at any PEM bundle you already trust.

   3. **OS trust store (Node 22+)** — set `NODE_OPTIONS=--use-system-ca`.
      On Windows the OS root store usually has the ICP-Brasil chain; on
      Linux containers it typically doesn't.

   For `apps/nfe` route handlers in production, `createSefazAgent(cert,
{ ca })` accepts the PEM bundle programmatically — load the chain
   once at server start and reuse the agent.

## How to use — the typed operations layer

**Default to the typed helpers in `src/operations/`.** They are the
canonical entry points for every SEFAZ call: typed object in, typed
object out, with full validation between (Zod on the input object, XSD
against the canonical SEFAZ schema on the wire bytes, safety guard
against accidental produção traffic).

```ts
import {
  consultarStatusServico,
  consultarSituacaoNFe,
  consultarLote,
  autorizarLote,
} from '@delfrance/integrations-nfe/operations';
import { loadCertificateFromEnv, createSefazAgent } from '@delfrance/integrations-nfe';
import { getEndpoints } from '@delfrance/integrations-nfe';

const cert = loadCertificateFromEnv();
const agent = createSefazAgent(cert);
const endpoints = getEndpoints('SP', 'homologacao');

// 1) Service availability — the safest call to make first.
const status = await consultarStatusServico(
  { url: endpoints.NfeStatusServico, cert, agent, tpAmb: '2' },
  { cUF: '35' },
);
if (status.cStat === '107') console.log('SEFAZ-SP is up:', status.xMotivo);

// 2) Recovery — query one NF-e by chave.
const sit = await consultarSituacaoNFe(
  { url: endpoints.NfeConsultaProtocolo, cert, agent, tpAmb: '2' },
  { chave: '35260514200166000187550010000000071000000018' },
);

// 3) Poll a lote by nRec.
const lote = await consultarLote(
  { url: endpoints.NfeRetAutorizacao, cert, agent, tpAmb: '2' },
  { nRec: '351000000000123' },
);

// 4) Submit a lote of signed NF-e. Each `NFe[]` entry must be the signed
//    byte stream straight from signNFe() — never re-parsed.
const submitted = await autorizarLote(
  { url: endpoints.NfeAutorizacao, cert, agent, tpAmb: '2' },
  { idLote: '1', NFe: [signedNFeXml] },
);
```

### Validation pipeline

Every call goes through three gates before any byte leaves the process:

1. **Safety guard** — `tpAmb='2'` always passes; `tpAmb='1'` requires
   `NFE_ALLOW_PRODUCAO=true` (or Vitest's `NODE_ENV='test'`).
2. **XSD validation** — the request is validated against the vendored
   SEFAZ XSD pack (`schemas/*.xsd`) via `xmllint-wasm` before the POST.
   This is the **`cStat=656` ban kill switch**: nothing schema-invalid
   ever reaches SEFAZ.
3. **Inbound XSD validation** — the response is validated against the
   matching `ret*` XSD before being parsed. Catches captive-portal
   HTML, proxy junk, parser drift.

See `.claude/skills/nfe/references/cstat-rejeicoes.md` for the
ban-prevention rationale.

## When to drop to the low-level SOAP transport

The low-level functions in `src/soap/` (`nfeStatusServico`,
`nfeConsultaProtocolo`, `nfeRetAutorizacao`, `nfeAutorizacaoLote`) take a
raw XML string. **Reach for them only when:**

- Replaying an archived `xml_assinado` for recovery (signed bytes).
- A recovery flow that intentionally bypasses the typed shape.
- Implementing a new SEFAZ NT that hasn't been wired into a typed
  helper yet — in which case, **add the helper first**.

The low-level functions still enforce the XSD gate and the
production-safety guard — they're not unsafe, just unergonomic.

## Generating the chave + signing

```ts
import { generateNFe } from '@delfrance/integrations-nfe';
import { signNFe } from '@delfrance/integrations-nfe';

const out = generateNFe({
  ambiente: 'homologacao',
  numeracao: 7,
  serie: 1,
  dhEmi: new Date(),
  filial,
  operacao,
  cliente,
  enderecoDest,
  itens: [
    /* ... */
  ],
  totalXml: '<total>...</total>',
  transpXml: '<transp>...</transp>',
  pagXml: '<pag>...</pag>',
});
// out.chave is the 44-digit access key (anti-loss anchor)
// out.nfeXml is the unsigned <NFe>...</NFe>

const signedXml = signNFe(out.nfeXml, cert);
// Now ready for autorizarLote({ idLote: '1', NFe: [signedXml] }).
```

## Layers

| Module            | Job                                                    |
| ----------------- | ------------------------------------------------------ |
| `src/operations/` | **Typed entry points** — start here                    |
| `src/generator/`  | Pedido data → unsigned `<NFe>` + 44-digit chave        |
| `src/sign/`       | XMLDSig signing via `xml-crypto`                       |
| `src/xsd/`        | Canonical SEFAZ XSD validation (`xmllint-wasm`)        |
| `src/safety/`     | Production-traffic guard (`assertSafeTpAmb`)           |
| `src/soap/`       | Low-level SOAP 1.2 transport + mTLS — power users only |
| `src/cert/`       | A1 PFX loader                                          |
| `src/state/`      | cStat → estado mapping, retry policy                   |
| `src/xml/`        | NF-e XML (de)serializer (META-driven)                  |
| `src/sanitize/`   | SEFAZ-safe text sanitization                           |
| `src/endpoints/`  | SEFAZ URLs by UF + ambiente                            |
