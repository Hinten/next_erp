/**
 * The wire READERS of the NF-e upload (#1522, step 14): which key is OURS, whether
 * our note is a SALE, what Shopee says it holds for the order, and whether the
 * order may receive a note at all.
 *
 * Four pure readers and one gate, each over a value already in memory — our own
 * `nfeProc` XML, or one `get_order_detail` row read with
 * `SHOPEE_NFE_DETALHE_CAMPOS`. This is the ONE module of the folder that names
 * Shopee's `invoice_data.access_key` field: every other module holds a
 * {@link NotaNaShopee} verdict, never the row's key.
 *
 * ## "Ours" is the key INSIDE the XML we upload
 *
 * Shopee parses the key out of the file — the request carries none — so the
 * identity that matters is the one in the signed content, never only the NF-e
 * document's `chave` field (the handler cross-checks the two). {@link chaveDoProc}
 * reads `infNFe/@Id` and checks it against the protocol's `chNFe`; both must
 * satisfy `CHAVE_NFE_REGEX`, which is POSITIONAL and alphanumeric in the CNPJ
 * window (NT 2026.004). ⚠️ Never a digits-only extractor: it would silently fail
 * every NF-e of an alphanumeric-CNPJ emitter.
 *
 * ## The folds, and where each one STOPS
 *
 * - {@link chaveCanonica} — `trim()` and then the regex, NOTHING more. EQUAL:
 *   `'  K  '` and `'K\n'` read as `K`. DISTINCT (each pinned by a test): K with
 *   one digit changed, K's first 43 characters, K plus one, `NFe` + K, K with its
 *   CNPJ letters lower-cased, K spaced in DANFE groups of four. Every widening
 *   (a prefix strip, a case fold, an inner-space fold, a `startsWith`) would read
 *   ANOTHER note as ours and skip an upload in silence; the narrow fold's failure
 *   is an aviso, which an operator sees.
 * - {@link statusDaNota} — `trim()` + lower-case, then an EXACT match on `valid` /
 *   `pending`. EQUAL: `' VALID '` is `valida`. DISTINCT: `invalid` is
 *   `desconhecido` — a substring test would RESOLVE the aviso of a rejected note —
 *   and so are `validated` and `pending_review`; `null` / blank is `ausente`.
 * - `statusBruto` (on `nossa` / `sem-nota`) — the SAME `trim()` + lower-case,
 *   kept only when the result is a bare TOKEN (`[a-z_]`, 1 to 24 characters),
 *   else `null`. It decides nothing: it is what a caller LOGS when the fold
 *   above answers `desconhecido`, so an unknown value is diagnosable without a
 *   line ever carrying Shopee's free text. EQUAL: `' INVALID '` and `invalid`
 *   log as `invalid`. DISTINCT: `valid.`, `pending review`, anything with a
 *   digit and anything over 24 characters log as `null` — a token has no room
 *   for a key, a document number or a sentence.
 *
 * None of them uses a shared comparison helper, so none has a row in the repo's
 * fold inventory; the pairs and near-misses live in this module's tests.
 *
 * ## Never decided by the absence of `invoice_data`
 *
 * The wire schema folds an ABSENT `invoice_data` and a `null` one into the same
 * `null`, so a Brazilian row that simply lacks the field reads exactly like a
 * foreign one. A foreign order is therefore decided by the ORDER's `region`
 * through `pedidoForaDoBrasil` — the one predicate the importer also uses for
 * `bloquearEmissaoNFe` — and a Brazilian row with no `invoice_data` is
 * `sem-nota`, which UPLOADS: a wrong skip is silent, a wrong attempt is refused
 * loudly.
 *
 * ⚠️ PII: the verdicts hold a key only where a caller must compare it (`outra`'s
 * legible key, for the cancelled-sibling rule). None of it may reach a log line,
 * an aviso, a stamp or a task payload; the pending reason arrives here already
 * through the folder's sanitizer.
 *
 * Pure and total: no clock, no I/O, no Firestore, no environment.
 */
import type { ShopeeOrderDetailRow } from '@delfrance/integrations-shopee';
import { CHAVE_NFE_REGEX } from '@delfrance/schemas';

import { pedidoForaDoBrasil } from '../pedidos/orderMapping';
import { SHOPEE_ORDER_STATUS } from '../pedidos/orderStatusMaps';
import { MOTIVO_NFE_SHOPEE } from './errosNfe';
import { resumirTextoDaShopee } from './redacaoNfe';

/* -------------------------------------------------------------------------- */
/*                           our key, from our XML                             */
/* -------------------------------------------------------------------------- */

/** The first `infNFe` OPENING tag, namespace prefix tolerated (`infNFeSupl` is not it). */
const ABERTURA_INF_NFE = /<(?:[\w.-]+:)?infNFe\b[^>]*>/;

/** The `Id` attribute inside that tag, either quote. */
const ATRIBUTO_ID = /\bId\s*=\s*(["'])([^"']*)\1/;

/** The XSD's fixed prefix of `infNFe/@Id` — case-sensitive, as signed. */
const PREFIXO_DO_ID = 'NFe';

/** Where the authorization protocol starts; the protocol's key is read AFTER it. */
const ABERTURA_PROT_NFE = /<(?:[\w.-]+:)?protNFe\b/;

/** The first `chNFe` element (from the protocol onwards), its text captured raw. */
const ELEMENTO_CH_NFE = /<(?:[\w.-]+:)?chNFe\s*>([^<]*)<\/(?:[\w.-]+:)?chNFe\s*>/;

/**
 * Our NF-e's access key, read from the `nfeProc` XML we are about to upload.
 *
 * - k1 = `infNFe/@Id` minus its `NFe` prefix — the SIGNED content, the key
 *   Shopee parses. Absent, malformed, or failing `CHAVE_NFE_REGEX` ⇒
 *   `sem-chave`.
 * - k2 = the first `chNFe` after the `protNFe` tag — the protocol's copy. When
 *   the element is present its trimmed text must EQUAL k1, or the document
 *   contradicts itself ⇒ `chaves-divergentes` (an empty or illegible k2
 *   included). No protocol element at all ⇒ k1 alone.
 *
 * ⚠️ k2 is looked for only from the protocol onwards, so a note-reference group
 * a future layout adds inside `infNFe` can never be read as the protocol's key.
 *
 * Both errors mean the file can never be uploaded as it stands: the handler
 * answers them as `xml-invalido`.
 */
export function chaveDoProc(
  xml: string,
): { readonly chave: string } | { readonly erro: 'sem-chave' | 'chaves-divergentes' } {
  const abertura = ABERTURA_INF_NFE.exec(xml);
  const id = abertura === null ? null : ATRIBUTO_ID.exec(abertura[0]);
  const valor = id?.[2];
  if (valor === undefined || !valor.startsWith(PREFIXO_DO_ID)) return { erro: 'sem-chave' };
  const k1 = valor.slice(PREFIXO_DO_ID.length);
  if (!CHAVE_NFE_REGEX.test(k1)) return { erro: 'sem-chave' };

  const inicioDoProtocolo = xml.search(ABERTURA_PROT_NFE);
  if (inicioDoProtocolo >= 0) {
    const k2 = ELEMENTO_CH_NFE.exec(xml.slice(inicioDoProtocolo));
    if (k2 !== null && (k2[1] ?? '').trim() !== k1) return { erro: 'chaves-divergentes' };
  }
  return { chave: k1 };
}

/* -------------------------------------------------------------------------- */
/*                            the sale-only gate                               */
/* -------------------------------------------------------------------------- */

/** The first `tpNF` element's text (B11 — 0 entrada, 1 saída). */
const ELEMENTO_TP_NF = /<(?:[\w.-]+:)?tpNF\s*>([^<]*)<\/(?:[\w.-]+:)?tpNF\s*>/;

/** The first `finNFe` element's text (B25 — 1 normal … 6 débito since NT 2025.002). */
const ELEMENTO_FIN_NFE = /<(?:[\w.-]+:)?finNFe\s*>([^<]*)<\/(?:[\w.-]+:)?finNFe\s*>/;

/** A LEGIBLE code: exactly one decimal digit once trimmed. */
const CODIGO_DE_UM_DIGITO = /^[0-9]$/;

/** `tpNF` of an outgoing note, and `finNFe` of a normal one — the SALE, and only it. */
const SAIDA = '1';
const FINALIDADE_NORMAL = '1';

/** The trimmed text of the first match of `elemento`, or `null` when it is absent. */
function textoDoPrimeiro(xml: string, elemento: RegExp): string | null {
  const achado = elemento.exec(xml);
  return achado === null ? null : (achado[1] ?? '').trim();
}

/**
 * Whether our NF-e is the order's SALE note (reconcile R-p).
 *
 * - first `tpNF` = `1` AND first `finNFe` = `1` ⇒ `venda`;
 * - both legible (one digit each) but anything else ⇒ `outra` — an entrada
 *   (`tpNF 0`), a complementar, an ajuste, a devolução (`finNFe 4`), or a
 *   crédito/débito note (`finNFe 5`/`6`, NT 2025.002). The handler DISCARDS it
 *   (`nfe-nao-e-de-venda`, a log line): uploading it would attach the wrong
 *   fiscal document to the order, and after the sale it would read as another
 *   note already attached;
 * - either element missing, or not one digit ⇒ `ilegivel` ⇒ `xml-invalido`.
 *
 * ⚠️ "Legible" is a SHAPE, not the XSD's value list: the note is authorized, so
 * its domain is SEFAZ's to enforce, and a digit a future layout adds lands on
 * `outra` — a log line, never a sale — rather than on a stamp. Only the EXACT
 * pair `1`/`1` is a sale: `01` is illegible, never read as `1`.
 */
export function finalidadeDoProc(xml: string): 'venda' | 'outra' | 'ilegivel' {
  const tpNF = textoDoPrimeiro(xml, ELEMENTO_TP_NF);
  const finNFe = textoDoPrimeiro(xml, ELEMENTO_FIN_NFE);
  if (tpNF === null || finNFe === null) return 'ilegivel';
  if (!CODIGO_DE_UM_DIGITO.test(tpNF) || !CODIGO_DE_UM_DIGITO.test(finNFe)) return 'ilegivel';
  return tpNF === SAIDA && finNFe === FINALIDADE_NORMAL ? 'venda' : 'outra';
}

/* -------------------------------------------------------------------------- */
/*                                  the folds                                  */
/* -------------------------------------------------------------------------- */

/**
 * A key as Shopee prints it → the canonical key, or `null` when it is not one.
 *
 * `trim()` and then `CHAVE_NFE_REGEX` — NOTHING more (see the module docblock
 * for the pairs and near-misses). `null` covers BOTH "absent" and "illegible";
 * a caller that must tell them apart (the reader below) tests blankness first.
 */
export function chaveCanonica(raw: string | null): string | null {
  if (raw === null) return null;
  const aparada = raw.trim();
  return CHAVE_NFE_REGEX.test(aparada) ? aparada : null;
}

/**
 * What Shopee says about the note's validation (`invoice_data.status`, added
 * 2026-08-06 beside `pending_reason`):
 *
 * - `valida` — validated; also, per `ann 1521`, "the order does not require an
 *   invoice" (unverified on the wire — the handler logs it, never skips on it);
 * - `pendente` — held (e.g. flagged by SEFAZ), with or without a reason;
 * - `ausente` — no status at all;
 * - `desconhecido` — a value we do not know. The caller logs the verdict's
 *   `statusBruto` — the value reduced to a bare token, never the raw text.
 */
export type StatusNotaShopee = 'valida' | 'pendente' | 'ausente' | 'desconhecido';

/** Shopee's two documented spellings, lower-case. */
const STATUS_VALIDO = 'valid';
const STATUS_PENDENTE = 'pending';

/**
 * `invoice_data.status` → {@link StatusNotaShopee}: `trim()` + lower-case, then an
 * EXACT match — never `startsWith` or `includes` (`invalid` contains `valid`).
 */
export function statusDaNota(raw: string | null): StatusNotaShopee {
  if (raw === null) return 'ausente';
  const dobrado = raw.trim().toLowerCase();
  if (dobrado === '') return 'ausente';
  if (dobrado === STATUS_VALIDO) return 'valida';
  if (dobrado === STATUS_PENDENTE) return 'pendente';
  return 'desconhecido';
}

/**
 * The only shape of `invoice_data.status` a log line may carry: lower-case
 * letters and `_`, 1 to 24 of them — no digit, no space, no punctuation.
 */
const TOKEN_DE_STATUS = /^[a-z_]{1,24}$/;

/**
 * `invoice_data.status` → the TOKEN a caller may log (`statusBruto`), or `null`
 * when the trimmed, lower-cased value is not one (see the module docblock).
 */
function tokenDoStatus(raw: string | null): string | null {
  if (raw === null) return null;
  const dobrado = raw.trim().toLowerCase();
  return TOKEN_DE_STATUS.test(dobrado) ? dobrado : null;
}

/* -------------------------------------------------------------------------- */
/*                         what Shopee holds for the order                     */
/* -------------------------------------------------------------------------- */

/**
 * Shopee's note for the order, against OURS — four verdicts (design D1 §3.2):
 *
 * - `nao-br` — the order is foreign; no note belongs on it.
 * - `sem-nota` — no key on the order. `invoiceDataAusente` says the whole block
 *   was missing (a Brazilian row with no `invoice_data` — an anomaly we upload
 *   through rather than skip).
 * - `nossa` — Shopee holds OUR key; `motivoPendente` is the SANITIZED pending
 *   reason, present only when the status is `pendente`.
 * - `outra` — Shopee holds a different key (`legivel`, with that key, for the
 *   cancelled-sibling rule) or a value that is not a key at all
 *   (`legivel: false`, `chave: null`).
 *
 * `sem-nota` and `nossa` also carry `statusBruto`: the raw status as a
 * loggable token (`null` when there is none, or when it is not a token) — what
 * the caller logs beside a `desconhecido` status or a `nota-dispensada`
 * reading, instead of Shopee's free text.
 */
export type NotaNaShopee =
  | { readonly veredito: 'nao-br' }
  | {
      readonly veredito: 'sem-nota';
      readonly status: StatusNotaShopee;
      readonly statusBruto: string | null;
      readonly invoiceDataAusente: boolean;
    }
  | {
      readonly veredito: 'nossa';
      readonly status: StatusNotaShopee;
      readonly statusBruto: string | null;
      readonly motivoPendente: string | null;
    }
  | { readonly veredito: 'outra'; readonly legivel: boolean; readonly chave: string | null };

/**
 * Read one `get_order_detail` row against our key.
 *
 * 1. `pedidoForaDoBrasil(row.region)` ⇒ `nao-br`, whatever `invoice_data` says.
 * 2. `invoice_data === null` ⇒ `sem-nota`, `invoiceDataAusente: true` — NEVER
 *    `nao-br` on this alone (see the module docblock).
 * 3. A blank key (`null`, `''`, whitespace — Shopee's own sample answers `""`)
 *    ⇒ `sem-nota`. ⚠️ Never `outra`: an empty key read as "another note" would
 *    block every upload, silently.
 * 4. {@link chaveCanonica} of the key: equal to `nossaChave` ⇒ `nossa`; legible
 *    and different ⇒ `outra legivel`; present but illegible ⇒ `outra` not
 *    legible (a `'-'` sentinel included — loud, never silent).
 *
 * `nossaChave` is {@link chaveDoProc}'s output, already canonical; the
 * comparison is exact.
 */
export function lerNotaNaShopee(
  row: Pick<ShopeeOrderDetailRow, 'region' | 'invoice_data'>,
  nossaChave: string,
): NotaNaShopee {
  if (pedidoForaDoBrasil(row.region)) return { veredito: 'nao-br' };
  const nota = row.invoice_data;
  if (nota === null) {
    return { veredito: 'sem-nota', status: 'ausente', statusBruto: null, invoiceDataAusente: true };
  }

  const status = statusDaNota(nota.status);
  const statusBruto = tokenDoStatus(nota.status);
  const bruta = nota.access_key;
  if (bruta === null || bruta.trim() === '') {
    return { veredito: 'sem-nota', status, statusBruto, invoiceDataAusente: false };
  }
  const chave = chaveCanonica(bruta);
  if (chave === null) return { veredito: 'outra', legivel: false, chave: null };
  if (chave !== nossaChave) return { veredito: 'outra', legivel: true, chave };
  return {
    veredito: 'nossa',
    status,
    statusBruto,
    motivoPendente: status === 'pendente' ? resumirTextoDaShopee(nota.pending_reason) : null,
  };
}

/* -------------------------------------------------------------------------- */
/*                          may the order take a note?                          */
/* -------------------------------------------------------------------------- */

/** `fulfillment_flag` values, lower-case: Shopee's own fulfilment, and a cross-border seller. */
const FULFILLMENT_SHOPEE = 'fulfilled_by_shopee';
const FULFILLMENT_CROSS_BORDER = 'fulfilled_by_cb_seller';

/** The five deterministic reasons an order takes no upload. */
type MotivoDoPortao = (typeof MOTIVO_NFE_SHOPEE)[
  | 'pedidoNaoBr'
  | 'pedidoFbs'
  | 'lojaCrossBorder'
  | 'pedidoExportacao'
  | 'pedidoCancelado'];

/**
 * The order-level gate, read on the pre-read row BEFORE any upload, in THIS
 * order (the first match answers):
 *
 * 1. `pedidoForaDoBrasil(row.region)` ⇒ `pedido-nao-br`;
 * 2. `fulfillment_flag` (`trim()` + lower-case, EXACT) `fulfilled_by_shopee` ⇒
 *    `pedido-fbs` — Shopee handles that order's invoices itself;
 * 3. … `fulfilled_by_cb_seller` ⇒ `loja-cross-border` (step 13's spelling, the
 *    same fact); `fulfilled_by_local_seller`, `null` or anything else ⇒ on;
 * 4. `is_international === true` (asked for through `international_label`) ⇒
 *    `pedido-exportacao` — Shopee emits the note of an export order (`ann
 *    1086`); `null` / `false` ⇒ on;
 * 5. `order_status` EXACTLY `CANCELLED` ⇒ `pedido-cancelado`.
 *
 * ⚠️ `IN_CANCEL` does NOT stop the upload: the cancellation may still be
 * refused, and the step's doctrine is "send and classify, never pre-skip" — a
 * refusal of a cancelling order classifies as `pedido-cancelado` from the same
 * status (`classificarNfe.ts`).
 */
export function portaoDoPedido(
  row: Pick<
    ShopeeOrderDetailRow,
    'region' | 'fulfillment_flag' | 'is_international' | 'order_status'
  >,
): { readonly segue: true } | { readonly segue: false; readonly motivo: MotivoDoPortao } {
  if (pedidoForaDoBrasil(row.region)) {
    return { segue: false, motivo: MOTIVO_NFE_SHOPEE.pedidoNaoBr };
  }
  const flag = row.fulfillment_flag === null ? null : row.fulfillment_flag.trim().toLowerCase();
  if (flag === FULFILLMENT_SHOPEE) return { segue: false, motivo: MOTIVO_NFE_SHOPEE.pedidoFbs };
  if (flag === FULFILLMENT_CROSS_BORDER) {
    return { segue: false, motivo: MOTIVO_NFE_SHOPEE.lojaCrossBorder };
  }
  if (row.is_international === true) {
    return { segue: false, motivo: MOTIVO_NFE_SHOPEE.pedidoExportacao };
  }
  if (row.order_status === SHOPEE_ORDER_STATUS.cancelled) {
    return { segue: false, motivo: MOTIVO_NFE_SHOPEE.pedidoCancelado };
  }
  return { segue: true };
}
