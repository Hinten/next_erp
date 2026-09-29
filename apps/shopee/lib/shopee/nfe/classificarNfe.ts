/**
 * THE refusal table of the NF-e upload (#1522, step 14): Shopee's envelope error
 * for one `upload_invoice_doc` → what the handler does about it.
 *
 * The rows are guide 382's seventeen cases plus the api page's own codes, walked
 * N1 … N18 in the DECLARED order of design D1 §5.2 (the first row that matches
 * answers), with reconcile R-f's amendments and one row of our own ABOVE them,
 * N0 (below). The shape is step 13's `precos/classificarPreco.ts`.
 *
 * ## The discriminant is the ACTION
 *
 * - `ja-anexada` — Shopee says the key is already attached (N1, on ANOTHER order;
 *   N2, the legacy same-order text). Never a stamp by itself: the handler reads
 *   the order back and the read-back decides (R-f(1)) — which is why the two
 *   cases stay apart.
 * - `aguardar-serpro` — case 5, "not valid, or less than five minutes old": a
 *   delayed self re-enqueue, bounded by the handler.
 * - `ignorar` — terminal and nobody's defect (case 11): the carrier needs no
 *   note, or the order is cancelled — split by the PRE-READ's `order_status`.
 * - `recusar` — a refusal the operator must see. Whether it ALSO stamps the frete
 *   is `MOTIVOS_QUE_CARIMBAM`'s answer (`errosNfe.ts`), never restated here: the
 *   sets are the only source of both effects (`ip-nao-declarado` is `recusar`
 *   and does not stamp).
 * - `transitorio` — the caller RETHROWS and the queue's bounded ladder owns it.
 *
 * ## ⚠️ Needles read `providerMessage`, NEVER the formatted Error text
 *
 * The thrown sentence is `Shopee <path> respondeu <code> (HTTP n) — <text>`, and
 * on `/api/v2/order/upload_invoice_doc` answering `order.upload_invoice_error`
 * its haystack holds `upload`, `invoice` and `error` before Shopee has said a
 * word. Every needle therefore runs on the provider's own sentence, folded ONCE
 * ({@link detalheDaRecusa}): whitespace collapsed and trimmed, a leading
 * `Wrong parameters, detail:` stripped, lower-cased, trailing periods dropped
 * (guide 382's texts end in `..`). A `null` sentence matches no needle at all.
 *
 * ## ⚠️ Codes are compared TRIMMED and without their module prefix
 *
 * The api page names its code `order.upload_invoice_error` followed by a TAB. The
 * code is trimmed, stripped of ONE module segment by the package's
 * `shopeeCodeSemPrefixoDeModulo` (which does not trim), and trimmed again. The
 * handler keeps the VERBATIM code for its log line; this table never returns it.
 *
 * ## ⚠️ The order is load-bearing (each pinned by a near-miss test)
 *
 * - **N0 first** — `burst`, `daily` and `reauth` are CLASSES the handler narrows
 *   before it consults this table (`ShopeeRateLimitError`,
 *   `ShopeeReauthRequiredError`). But the package's classes are not mutually
 *   exclusive (a partial error copies its `kind`), and an arm ordered wrongly in
 *   the handler would hand one here. Read as a row it would fall to N18 and
 *   STAMP — on the ABSENCE of an answer, which R-g forbids and which this step
 *   cannot revoke. So those kinds answer `transitorio` before any needle:
 *   the safe direction, never a refusal.
 * - **N1/N2 before everything else** — both texts share the template of every
 *   other refusal, and a stamp on an already-attached note is the one false
 *   alarm nothing resolves.
 * - **N10 before N14** — `Invalid NF-e model. Only model 55 is accepted.`
 *   contains `invalid nf-e`; read as case 5 it would wait for SERPRO on a
 *   document that can never pass.
 * - **N12 against N15** — `field file_type type error` is OUR request's defect
 *   (N15) and must never read as a file refusal (`file error`, N12).
 * - **N17 after every needle row** — `order.upload_invoice_error` carries TWO
 *   sentences: `File error.` (N12, deterministic) and `Upload invoice failed,
 *   please try again later.` (N17, transient — R-f(4)). A code-only row would
 *   retry a file Shopee will never accept.
 *
 * Why substring needles and not exact texts: a wording drift on a `recusar` row
 * costs a label (N18 is ALSO aviso + stamp); on N14 an exact match would turn a
 * SERPRO wait into a stamp. The one wrong-direction risk — a future sentence
 * containing `invalid nf-e` — costs a bounded delay and then `nfe-invalida`.
 *
 * ## ⚠️ Every lookup is a `Set`, never an object literal
 *
 * The keys arrive verbatim from a provider; on an object literal `constructor`
 * answers an `Object.prototype` member (the package's rule, `errors.ts`).
 *
 * Pure and total: no clock, no I/O, no environment.
 */
import { SHOPEE_ERROR_KIND, shopeeCodeSemPrefixoDeModulo } from '@delfrance/integrations-shopee';
import type { ShopeeErrorKind } from '@delfrance/integrations-shopee';

import { SHOPEE_ORDER_STATUS } from '../pedidos/orderStatusMaps';
import { MOTIVO_NFE_SHOPEE } from './errosNfe';

/* ------------------------------ the verdict -------------------------------- */

/** The thirteen motivos a `recusar` row can answer (N4 … N13, N15, N16, N18). */
export type MotivoRecusaNfe = (typeof MOTIVO_NFE_SHOPEE)[
  | 'emissorShopee'
  | 'cnpjDivergente'
  | 'ufDivergente'
  | 'ieDivergente'
  | 'nfeCancelada'
  | 'dataDeEmissaoInvalida'
  | 'modeloNao55'
  | 'cfopNaoAceito'
  | 'xmlRecusado'
  | 'chaveInvalida'
  | 'requisicaoInvalida'
  | 'ipNaoDeclarado'
  | 'recusaDesconhecida'];

/** The two case-11 readings (N3). */
type MotivoIgnorarNfe = (typeof MOTIVO_NFE_SHOPEE)['semSuporteANfe' | 'pedidoCancelado'];

/**
 * WHICH "already attached" answer matched — N1 (the key sits on another order)
 * or N2 (the same-order resend). Not a motivo of the vocabulary: the read-back
 * turns it into one (R-f(1)), so it is spelled through a const, never as a
 * vocabulary slug.
 */
type CasoJaAnexada = 'chave-duplicada' | 'chave-ja-enviada';

const CASO_JA_ANEXADA = {
  chaveDuplicada: 'chave-duplicada',
  chaveJaEnviada: 'chave-ja-enviada',
} as const satisfies Record<string, CasoJaAnexada>;

/** What the handler does with one refusal (design D1 §5.1; see the module docblock). */
export type ClasseNfe =
  | { readonly classe: 'ja-anexada'; readonly motivo: CasoJaAnexada }
  | { readonly classe: 'aguardar-serpro' }
  | { readonly classe: 'ignorar'; readonly motivo: MotivoIgnorarNfe }
  | { readonly classe: 'recusar'; readonly motivo: MotivoRecusaNfe }
  | { readonly classe: 'transitorio' };

/* ------------------------------- the rows ---------------------------------- */

/** N0 — the kinds the handler's class ladder owns; never a table row. */
const KINDS_DA_ESCADA: ReadonlySet<ShopeeErrorKind> = new Set<ShopeeErrorKind>([
  SHOPEE_ERROR_KIND.burst,
  SHOPEE_ERROR_KIND.daily,
  SHOPEE_ERROR_KIND.reauth,
]);

/**
 * N1 — guide 382 case 7: the key is already on ANOTHER order. The key's field
 * name takes a space OR an underscore, as in N13: a drift to the underscore
 * spelling would otherwise fall to N18 and stamp, with no read-back, a note
 * that may be our own.
 */
const AGULHA_CHAVE_DUPLICADA = /access[ _]key duplicated/;

/** N2 — the legacy importer's same-order resend text (never documented). */
const AGULHA_JA_ENVIADA = 'already sent';

/** N3 — case 11: the carrier needs no note, or the order is cancelled. */
const AGULHA_STATUS_INVALIDO = 'invoice status is invalid';

/** N3 — the pre-read statuses that make case 11 a cancellation. */
const STATUS_DE_CANCELAMENTO: ReadonlySet<string> = new Set<string>([
  SHOPEE_ORDER_STATUS.inCancel,
  SHOPEE_ORDER_STATUS.cancelled,
]);

/**
 * N4 … N13 — a deterministic refusal of THIS note, one motivo per row, walked in
 * this order. Each entry names its guide-382 case.
 */
const LINHAS_DE_RECUSA: readonly {
  readonly linha: string;
  readonly agulhas: readonly (string | RegExp)[];
  readonly motivo: MotivoRecusaNfe;
}[] = [
  // N4 — case 4: the shop has Shopee as its note issuer. No apostrophe in the
  // needle, so `Don't` and `Don’t` both match.
  { linha: 'N4', agulhas: ['support invoice issuer'], motivo: MOTIVO_NFE_SHOPEE.emissorShopee },
  // N5 … N7 — cases 1 … 3: the emitter is not the shop Shopee has registered.
  { linha: 'N5', agulhas: ['invalid cnpj'], motivo: MOTIVO_NFE_SHOPEE.cnpjDivergente },
  { linha: 'N6', agulhas: ['invalid uf'], motivo: MOTIVO_NFE_SHOPEE.ufDivergente },
  {
    linha: 'N7',
    agulhas: ['invalid state registration'],
    motivo: MOTIVO_NFE_SHOPEE.ieDivergente,
  },
  // N8 — case 6, both spellings of the participle.
  {
    linha: 'N8',
    agulhas: ['canceled nf-e', 'cancelled nf-e'],
    motivo: MOTIVO_NFE_SHOPEE.nfeCancelada,
  },
  // N9 — case 10, plus guide 292's undocumented "date after payment" wording.
  {
    linha: 'N9',
    agulhas: ['invalid issue date', 'issue date'],
    motivo: MOTIVO_NFE_SHOPEE.dataDeEmissaoInvalida,
  },
  // N10 — case 14. BEFORE N14 (see the module docblock).
  { linha: 'N10', agulhas: ['nf-e model', 'model 55'], motivo: MOTIVO_NFE_SHOPEE.modeloNao55 },
  // N11 — case 15.
  { linha: 'N11', agulhas: ['cfop'], motivo: MOTIVO_NFE_SHOPEE.cfopNaoAceito },
  // N12 — cases 16 and 17.
  {
    linha: 'N12',
    agulhas: ['valid invoice xml', 'file error'],
    motivo: MOTIVO_NFE_SHOPEE.xmlRecusado,
  },
  // N13 — cases 8, 9 and 12. Shopee prints the key's field name with a space in
  // cases 1/2 and with an underscore in 8/9, so the needle takes either separator;
  // the wire field's own name stays in the reader module.
  {
    linha: 'N13',
    agulhas: [/access[ _]key (?:must be|is a required)/, 'invalid access key'],
    motivo: MOTIVO_NFE_SHOPEE.chaveInvalida,
  },
];

/** N14 — case 5: not valid at SERPRO yet, or under five minutes old. */
const AGULHA_NFE_INVALIDA = 'invalid nf-e';

/** N15 — case 13 and the api page's own example: OUR request's defect. */
const AGULHAS_REQUISICAO_INVALIDA: readonly string[] = ['order_sn is a required', 'file_type'];

/** N16 — the app's egress IP is not on Shopee's allow-list. */
const CODIGO_IP_NAO_DECLARADO = 'source_ip_undeclared';

/** N17 — the codes that are transient whatever they say. */
const CODIGOS_TRANSITORIOS: ReadonlySet<string> = new Set<string>([
  'error_database',
  // Shopee's own typo, and the correct spelling — a token that lapsed in flight.
  'invalid_acceess_token',
  'invalid_access_token',
]);

/** N17 — the upload's catch-all code, transient ONLY when its sentence says so. */
const CODIGO_FALHA_DE_UPLOAD = 'upload_invoice_error';
const AGULHA_TENTE_DE_NOVO = 'try again';

/* ------------------------------- the folds --------------------------------- */

/** The template prefix twelve of guide 382's seventeen texts share. */
const PREFIXO_DO_ENVELOPE = /^wrong parameters,\s*detail:\s*/i;

/**
 * The code as the rows compare it: trimmed, ONE module segment stripped, trimmed
 * again. EQUAL: `order.upload_invoice_error\t` ≡ `upload_invoice_error`.
 * DISTINCT: `a.b.source_ip_undeclared` keeps `b.` (the package strips exactly
 * one segment) and matches nothing.
 */
function codigoDaRecusa(code: string): string {
  const aparado = code.trim();
  return (shopeeCodeSemPrefixoDeModulo(aparado) ?? aparado).trim();
}

/**
 * The provider's sentence as the needles read it (see the module docblock).
 * `null` ⇒ `''`, which no needle matches.
 */
function detalheDaRecusa(providerMessage: string | null): string {
  if (providerMessage === null) return '';
  return providerMessage
    .replace(/\s+/g, ' ')
    .trim()
    .replace(PREFIXO_DO_ENVELOPE, '')
    .toLowerCase()
    .replace(/[.\s]+$/, '');
}

function contem(detalhe: string, agulha: string | RegExp): boolean {
  return typeof agulha === 'string' ? detalhe.includes(agulha) : agulha.test(detalhe);
}

/* ------------------------------- the walk ---------------------------------- */

/**
 * Classify one `upload_invoice_doc` refusal.
 *
 * @param err the envelope error's code (VERBATIM — prefix, TAB and all), the
 *   package's `kind`, and the provider's own sentence (`null` when the envelope
 *   carried none). A `ShopeeApiError` satisfies it as it stands.
 * @param ctx the PRE-READ's `order_status` (EXACT), which splits case 11.
 */
export function classificarRecusaDeNfe(
  err: {
    readonly code: string;
    readonly kind: ShopeeErrorKind;
    readonly providerMessage: string | null;
  },
  ctx: { readonly statusDoPedido: string | null },
): ClasseNfe {
  // ---- N0: a rate limit or a dead grant is never a refusal of this note. ----
  if (KINDS_DA_ESCADA.has(err.kind)) return { classe: 'transitorio' };

  const nu = codigoDaRecusa(err.code);
  const det = detalheDaRecusa(err.providerMessage);

  // ---- N1/N2: already attached — the read-back decides. FIRST. ----
  if (AGULHA_CHAVE_DUPLICADA.test(det)) {
    return { classe: 'ja-anexada', motivo: CASO_JA_ANEXADA.chaveDuplicada };
  }
  if (det.includes(AGULHA_JA_ENVIADA)) {
    return { classe: 'ja-anexada', motivo: CASO_JA_ANEXADA.chaveJaEnviada };
  }

  // ---- N3: case 11 — no note for this carrier, or a cancelled order. ----
  if (det.includes(AGULHA_STATUS_INVALIDO)) {
    const cancelado = ctx.statusDoPedido !== null && STATUS_DE_CANCELAMENTO.has(ctx.statusDoPedido);
    return {
      classe: 'ignorar',
      motivo: cancelado ? MOTIVO_NFE_SHOPEE.pedidoCancelado : MOTIVO_NFE_SHOPEE.semSuporteANfe,
    };
  }

  // ---- N4 … N13: a deterministic refusal of this note. ----
  for (const linha of LINHAS_DE_RECUSA) {
    if (linha.agulhas.some((agulha) => contem(det, agulha))) {
      return { classe: 'recusar', motivo: linha.motivo };
    }
  }

  // ---- N14: case 5 — wait for SERPRO. AFTER N10. ----
  if (det.includes(AGULHA_NFE_INVALIDA)) return { classe: 'aguardar-serpro' };

  // ---- N15: our request's own defect. AFTER N12. ----
  if (AGULHAS_REQUISICAO_INVALIDA.some((agulha) => det.includes(agulha))) {
    return { classe: 'recusar', motivo: MOTIVO_NFE_SHOPEE.requisicaoInvalida };
  }

  // ---- N16: the egress IP — infrastructure, and the sets keep it unstamped. ----
  if (nu === CODIGO_IP_NAO_DECLARADO) {
    return { classe: 'recusar', motivo: MOTIVO_NFE_SHOPEE.ipNaoDeclarado };
  }

  // ---- N17: Shopee's hiccup — the caller rethrows. AFTER every needle row. ----
  if (err.kind === SHOPEE_ERROR_KIND.transient) return { classe: 'transitorio' };
  if (CODIGOS_TRANSITORIOS.has(nu)) return { classe: 'transitorio' };
  if (nu === CODIGO_FALHA_DE_UPLOAD && det.includes(AGULHA_TENTE_DE_NOVO)) {
    return { classe: 'transitorio' };
  }

  // ---- N18: a refusal nobody taught us. ----
  return { classe: 'recusar', motivo: MOTIVO_NFE_SHOPEE.recusaDesconhecida };
}
