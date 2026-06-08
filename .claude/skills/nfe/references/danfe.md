# DANFE — Documento Auxiliar da NF-e (MOC 7.0 Anexo II)

The **DANFE** is the human-readable representation of an authorized NF-e —
printed for the shipment, the customer copy and audits. It is **not** the
fiscal document (the signed XML is); the DANFE only *accompanies* the goods and
lets a human/scanner reach the XML via the chave de acesso. Spec: MOC 7.0
**Anexo II** (`references/sources/moc7/ANEXO II -Manual
EspecificaçõesTécnicas - Danfe-Código-Barras-2.pdf`).

## Hard rules

- **Render from the authorized `procNFe` XML, never regenerate.** A DANFE is a
  view of `<nfeProc>` (`<NFe>` + `<protNFe>`), already persisted at
  `pedidos/{id}/nfev4/{nfeId}.xml_nfe_proc`. Re-deriving values from order data
  would let the print disagree with what SEFAZ authorized.
- **A DANFE only exists for an authorized NF-e** (`cStat 100/150`, protocolo
  present). A cancelada NF-e keeps its `xml_nfe_proc` → still printable, with a
  "CANCELADO" overlay. EPEC renders from `xml_epec_proc` (different proc shape).
- **No valor fiscal of its own.** The footer states the DANFE is not a fiscal
  document. In **homologação** (`tpAmb=2`) it carries a **"SEM VALOR FISCAL"**
  watermark (see `homologacao.md`).
- **Barcode = Code 128C of the 44-digit chave.** Model 55 DANFE carries the
  chave as a **Code 128C** linear barcode (the chave is all-digits, even length
  → subset C packs two digits per symbol). **No QR code** — the QR is NFC-e
  (model 65) only, via `infNFeSupl/qrCode`, and is out of scope here.
- **Build the chave text grouped** in eleven blocks of four for human reading.

## Orientations / formats

| Format | Size | Notes |
|---|---|---|
| **Retrato** | A4 portrait | Default. Canhoto strip across the top. |
| **Paisagem** | A4 landscape | Canhoto rotated down the left edge. |
| **Simplificado — Etiqueta** | 10×15 cm label | Compact: title, barcode+chave, protocolo, emitente, dados gerais, destinatário, infCpl. (≠ "DANFE Simplificado Tipo 2" of NT 2026.003.) |
| **Etiqueta ZPL2** *(ours)* | 10×15 cm | Net-new vs. the legacy PDF etiqueta — streams ZPL directly to a Zebra. |

## Mandatory blocks (retrato/paisagem, Anexo II §3)

Canhoto/recibo (date-of-receipt stub + chave) · identificação do **emitente** +
the **"DANFE"** label box (tipo `0-entrada`/`1-saída`, nº, série) + **Code 128**
of the chave + the formatted chave + **protocolo de autorização** + natureza da
operação + inscrições (IE/IE-ST/CNPJ) · **destinatário/remetente** · local de
**entrega/retirada** (when present) · **fatura/duplicatas** · **cálculo do
imposto** (vBC, vICMS, vBCST, vST, vProd, vFrete, vSeg, vDesc, vOutro, vIPI,
**vNF**) · **transportador/volumes** (modFrete, placa, qVol, pesoB/L) · **dados
dos produtos/serviços** (cProd, xProd, NCM, CST/CSOSN, CFOP, uCom, qCom, vUnCom,
vProd, vBC, vICMS, vIPI, alíquotas) — paginates, repeating the emitente strip +
table header · **cálculo do ISSQN** (when serviços) · **dados adicionais**
(infCpl + infAdFisco) · **reservado ao Fisco**.

## Fonts

Standard PDF Times/Helvetica (WinAnsi) cover every Portuguese accent + `º ª §` —
no font embedding needed.

## Our implementation

- **Lib:** `packages/integrations/nfe/src/danfe/` — `model.ts`
  (`parseProcNFe(xml): DanfeModel` over the codegen `parse('nfeProc', …)`),
  `format.ts` (chave/cpf-cnpj/cep/money/date helpers), `barcode.ts`
  (`code128Png` via **bwip-js**), `zpl2.ts`, `pdf/*` (**pdfkit**).
- **Server-only:** exposed via the `@delfrance/integrations-nfe/danfe` subpath
  (NOT the package root barrel) so pdfkit/bwip-js never enter the `apps/web`
  bundle. `apps/web` only calls the route.
- **Route:** `GET /api/nfe/danfe?pedidoId&nfeId&format=simplificado|zpl2&dpi=203`
  (`PERM.fiscal.read`), rendered by `danfeArtifactService`.
- **Phasing:** PR1 = simplificado PDF + ZPL2; PR2 = retrato + paisagem; PR3 =
  carta-de-correção PDF.

## ZPL2 label variant (Zebra)

Net-new — the legacy "etiqueta" was a small PDF. ZPL streams to the printer with
no rasterisation:

- `^XA … ^XZ` wrapper; **`^CI28`** selects UTF-8 (Portuguese accents survive).
- `^PW`/`^LL` = print width/label length, scaled by `dpi/25.4`. **Default
  203 dpi** (8 dots/mm → ~800×1200 for 10×15 cm); **300 dpi** supported
  (~1200×1800). Author layout in millimetres; scale once.
- Native scalable font `^A0N,h,w`; native Code 128 **`^BCN,h,N,N,N`** fed the
  raw 44-digit chave (no embedded image).
- Strip `^`/`~` from field data so a razão social/endereço can't inject a
  command.
- **Preview** any output at https://labelary.com before a physical run.
