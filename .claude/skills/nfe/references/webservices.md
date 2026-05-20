# SEFAZ Web Services

## Transport

- **SOAP 1.2**, `Document/Literal`, WS-I Basic Profile 1.1.
- **TLS 1.2+ with mutual authentication** — the client presents the transport
  certificate (`https.Agent` carrying the A1 cert + key).
- Each UF (state) publishes its own WSDL endpoints; some states delegate to
  **SVAN** (SEFAZ Virtual Ambiente Nacional) or **SVRS** (SEFAZ Virtual RS).
- The payload XML goes in the body parameter **`nfeDadosMsg`**. The SOAP header
  carries **`nfeCabecMsg`** with `versaoDados` (e.g. `4.00`) and `cUF`.
- Namespace ordering in the envelope matters — small `xmlns` differences cause
  rejections 215 / 225.

## Services (layout 4.00)

| Service | Method | Process | Purpose |
|---|---|---|---|
| `NfeAutorizacao4` | `nfeAutorizacaoLote` | async / sync | Send an NF-e lote |
| `NfeRetAutorizacao4` | `nfeRetAutorizacao` | async | Poll a lote by `nRec` |
| `NfeConsultaProtocolo4` | `nfeConsultaNF` | sync | Query one NF-e by chave |
| `NfeStatusServico4` | `nfeStatusServicoNF` | sync | Service availability |
| `NfeInutilizacao4` | `nfeInutilizacaoNF` | sync | Void a number range |
| `RecepcaoEvento4` | `nfeRecepcaoEvento` | sync | Cancelamento / CCe / EPEC |
| `NfeConsultaCadastro` | `consultaCadastro` | sync | Taxpayer registration |
| `NFeDistribuicaoDFe` | `nfeDistDFeInteresse` | sync | Download issued DF-e |

## Autorização flow (the core path)

### Send — `enviNFe` (schema `enviNFe_v4.00.xsd`)

- Root `<enviNFe versao="4.00">` with `<idLote>` (1–15 digits, caller-assigned,
  sequential) and `<indSinc>` (0 = async, 1 = synchronous).
- 1 to **50** `<NFe>` elements; total message ≤ ~500 KB. A gzip variant exists
  (`NfeAutorizacaoLoteZip`, base64 of GZip; failure → rejection 416).
- **Synchronous** (`indSinc=1`) is only honored when the lote has **exactly one
  NF-e** and the UF implements it — the response carries `<protNFe>` inline,
  with no `nRec`.

### Receive — `retEnviNFe` (schema `retEnviNFe_v4.00.xsd`)

- `cStat=103` "Lote recebido com sucesso" → async; `<infRec>` carries `nRec`
  (15-digit receipt) and `tMed` (avg response seconds).
- `cStat=104` "Lote processado" with inline `<protNFe>` → synchronous.
- Any other `cStat` → the lote itself was rejected (schema, signature, etc.).

### Poll — `consReciNFe` → `retConsReciNFe`

- Input: `tpAmb` + `nRec`. **Wait ≥ 15 s** before the first poll (avoids the
  noise of `105 Lote em Processamento`).
- `cStat=104` → lote processed; `<protNFe>` array (0–50), one per NF-e.
- `cStat=105` → still processing — wait and retry (bounded; old code: max 4).
- `cStat=106` → "Lote não localizado" — the lote is gone; recover via
  `consSitNFe` per NF-e (see `cstat-rejeicoes.md`).

### `protNFe` leiaute (`infProt`)

`tpAmb`, `verAplic`, `chNFe` (44), `dhRecbto`, `nProt` (15-digit protocol),
`digVal` (the NF-e's DigestValue), `cStat`, `xMotivo`. `cStat=100` → authorized.

### procNFe

The authorized document = `<nfeProc>` wrapping the signed `<NFe>` + its
`<protNFe>`. This is what gets archived and rendered as a DANFE.

## NfeConsultaProtocolo — `consSitNFe`

Input: `tpAmb` + `chNFe`. Returns the current situation of one NF-e, including
its `<protNFe>` if authorized, and any linked events (cancelamento, CCe). This
is the **recovery query**: use it whenever a send/poll outcome is uncertain.

## NfeStatusServico — `consStatServ`

Input: `tpAmb` + `cUF`. `cStat=107` → service operating. Use sparingly (a
status loop triggers consumo indevido). Useful as a CI reachability check and
to decide whether to switch to contingency.

## Performance / abuse

- SEFAZ commits to processing 95% of lotes within 3 minutes.
- A lote result stays available for ≥ 24 h after processing.
- Looping the same request → `656 — Rejeição: Consumo Indevido`. Always
  back off and respect `tMed`.

### Mandatory pre-send XSD validation (the ban-prevention rule)

**Never send anything to SEFAZ without first validating against the
vendored XSD pack.** Schema-invalid requests trigger `cStat=215`/`225`,
and **repeating those rejections trips `cStat=656`** — which escalates to
throttling and ultimately a CNPJ / certificate ban.

In this repo the gate is `packages/integrations/nfe/src/xsd/`:
`validateXsd(rootKey, xml)` runs `xmllint-wasm` (libxml2 in WebAssembly)
against the schemas under `packages/integrations/nfe/schemas/`. Every
public SOAP operation in `src/soap/` runs it pre-POST **and** on the
inbound response (catches captive-portal HTML, proxy junk, parser drift).
There is no escape hatch from public callers.

If you ever add a new SEFAZ operation, wire it through `postSoapValidated`
in `src/soap/` with the matching request + response roots. The XSD map
lives at `XSD_BY_ROOT` in `src/xsd/index.ts`.
