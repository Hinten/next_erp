/**
 * The DECISIONS of the NF-e upload (#1522, step 14) over Firestore snapshots
 * already in memory: is this pedido ours to upload for, is the conta usable,
 * which of a pedido's NF-e goes to the channel, and which key it carries.
 *
 * Four pure functions, ONE definition each for every caller — the approval
 * trigger, the task handler, the re-drive route and the CLI. None reads a
 * document, a clock or the environment; the caller does the reads and hands
 * the raw data in, so the trigger can decide at zero extra reads and the tests
 * need no Firestore double.
 *
 * ## The pedido: ownership is PROVED, never inferred
 *
 * {@link avaliarPedidoParaNfeShopee} accepts a pedido only when
 * `provaDeIdentidadeShopee` recomputes its id from `(conta, order_sn)` — a
 * digest only the Shopee importer can have written. A marker field, a frete
 * integradora or an order number that merely LOOKS like Shopee's proves
 * nothing, and uploading another channel's note to a Shopee order is not a
 * refusal anyone would see.
 *
 * The FRETE decides nothing here: a proved pedido is ENQUEUED whether its frete
 * is Shopee's, another integradora's or absent, because Shopee's upload attaches
 * the note to the ORDER (its page has no package number), so a re-pointed frete
 * does not take the order's invoice away — only the later frete stamp is
 * owner-guarded, by `carimboFreteNfe.ts`'s own `outra-integradora`.
 *
 * ## The conta: `ativo !== true`, never `=== false`
 *
 * {@link avaliarContaParaNfeShopee} refuses a missing conta and a conta of
 * another tipo as not configured, and any conta whose `ativo` is not exactly
 * `true` as inactive — so a `null` or absent flag refuses instead of slipping
 * through. Both refusals are LOG lines at the caller: switching a conta off is
 * deliberate, and one aviso per pending pedido would be noise.
 *
 * ## The NF-e: the level predicate, the sale gate, and one winner
 *
 * {@link escolherNfeParaEnvioShopee} is the slot rule of the callers that have
 * a pedido but no NF-e id (the route and the CLI; the trigger and the task
 * always carry one). A document is ELIGIBLE when the shared LEVEL predicate
 * says it is ready — never the transition one: a re-drive exists for a
 * document that is ALREADY ready — and its proc is not a legible non-sale
 * note. Several eligible ⇒ the latest `data_autorizacao` (read in ms through
 * the tolerant reader, an unreadable date counting as the oldest), and on a
 * tie the lowest document id — a total order, so the same set always answers
 * the same slot. A cancelled slot is `nao-aprovada` to the predicate, so a
 * cancelled note is never chosen over its aprovada replacement, whatever its
 * dates say.
 *
 * ⚠️ The date ranks only the MIGRATED corpus (review 2, S1-1): the legacy app
 * stamped `data_autorizacao`, while this ERP's NF-e app writes it as `null` and
 * never fills it on approval. Every NF-e emitted after the cutover therefore
 * counts as "the oldest", so between two of them the rule is, in practice, the
 * lowest document id — still total, just not "the latest authorization".
 *
 * An eligible document whose proc is ILLEGIBLE (no readable `tpNF`/`finNFe`)
 * is kept on purpose: the slot rule cannot answer `xml-invalido`, and the
 * handler judges that XML with an aviso the operator sees — dropping it here
 * would turn a loud refusal into a quiet "no approved NF-e".
 *
 * With nothing eligible, the answer is the reason of the document that got
 * FURTHEST down the ladder — `nfe-nao-e-de-venda` over `tpamb-homologacao`
 * over `xml-ausente`, and `sem-nfe-aprovada` when nothing is aprovada at all
 * (the empty list included) — so the operator reads the closest miss, not the
 * first document's.
 *
 * ## The key: the one INSIDE the XML, cross-checked against the document
 *
 * {@link chaveDaNfeParaCanal} reads the key Shopee will parse — the one in the
 * signed proc — and, when the NF-e document also stores a `chave`, requires
 * the two to agree after the folder's one key fold (`chaveCanonica`: `trim()`
 * and the positional regex, nothing more). A document that contradicts its
 * own XML, or whose stored key is not a key, is broken data of ours: it is
 * `xml-invalido`, never uploaded.
 *
 * ⚠️ PII: the key is RETURNED to the caller, which compares it and hands it to
 * the reader of Shopee's answer. It never reaches a log line, an aviso, a
 * stamp or a task payload.
 */
import { coerceToMillis } from '@delfrance/core/datetime';
import {
  decideNfeUploadDispatch,
  INTEGRACAO_TIPO,
  type Integracao,
  type NfeUploadDispatch,
} from '@delfrance/schemas';

import { provaDeIdentidadeShopee } from '../pedidos/reservaTravadaMapping';
import { MOTIVO_NFE_SHOPEE } from './errosNfe';
import { chaveCanonica, chaveDoProc, finalidadeDoProc } from './notaNaShopee';

/* -------------------------------------------------------------------------- */
/*                                  the pedido                                 */
/* -------------------------------------------------------------------------- */

/**
 * The three reasons a pedido takes no NF-e upload. A frete of another
 * integradora is NOT one: the upload targets the order, not the shipment.
 */
type MotivoIgnorarPedidoNfe =
  | typeof MOTIVO_NFE_SHOPEE.pedidoNaoEncontrado
  | typeof MOTIVO_NFE_SHOPEE.naoShopee
  | typeof MOTIVO_NFE_SHOPEE.emissaoBloqueada;

/** The pedido's verdict: enqueue with the proved identity, or ignore and say why. */
type AvaliacaoPedidoNfeShopee =
  | { readonly acao: 'enfileirar'; readonly contaId: string; readonly orderSn: string }
  | { readonly acao: 'ignorar'; readonly motivo: MotivoIgnorarPedidoNfe };

/**
 * May this pedido's NF-e go to Shopee? In THIS order (the first match answers):
 *
 * 1. no document ⇒ `pedido-nao-encontrado`;
 * 2. the id does not recompute from `(conta, order_sn)` ⇒ `nao-shopee`;
 * 3. `bloquearEmissaoNFe === true` ⇒ `emissao-bloqueada` — the NF-e app
 *    refuses to emit under the flag, so an approved note under it means the
 *    flag was set after emission: do not upload, let the caller warn;
 * 4. otherwise — whatever the frete says, a frete-less pedido included —
 *    enqueue, carrying the conta and the order number the PROOF recovered
 *    (the note belongs to the ORDER, so the frete's owner is the stamp's
 *    question, never the upload's).
 */
export function avaliarPedidoParaNfeShopee(
  pedidoId: string,
  raw: Record<string, unknown> | null,
): AvaliacaoPedidoNfeShopee {
  if (raw === null) return { acao: 'ignorar', motivo: MOTIVO_NFE_SHOPEE.pedidoNaoEncontrado };

  const prova = provaDeIdentidadeShopee(pedidoId, raw);
  if (prova === null) return { acao: 'ignorar', motivo: MOTIVO_NFE_SHOPEE.naoShopee };

  if (raw.bloquearEmissaoNFe === true) {
    return { acao: 'ignorar', motivo: MOTIVO_NFE_SHOPEE.emissaoBloqueada };
  }

  return { acao: 'enfileirar', contaId: prova.contaId, orderSn: prova.orderSn };
}

/* -------------------------------------------------------------------------- */
/*                                  the conta                                  */
/* -------------------------------------------------------------------------- */

/** The two reasons a conta takes no NF-e upload. */
type MotivoRecusaContaNfe =
  | typeof MOTIVO_NFE_SHOPEE.contaNaoConfigurada
  | typeof MOTIVO_NFE_SHOPEE.contaInativa;

/** The conta's verdict. */
type AvaliacaoContaNfeShopee =
  | { readonly ok: true }
  | { readonly ok: false; readonly motivo: MotivoRecusaContaNfe };

/**
 * May this conta upload? Missing or not a Shopee conta ⇒ `conta-nao-configurada`;
 * `ativo` anything but exactly `true` ⇒ `conta-inativa`. The caller runs it
 * BEFORE building a client, so a refused conta never costs a token read.
 */
export function avaliarContaParaNfeShopee(conta: Integracao | null): AvaliacaoContaNfeShopee {
  if (conta === null || conta.tipo !== INTEGRACAO_TIPO.shopee) {
    return { ok: false, motivo: MOTIVO_NFE_SHOPEE.contaNaoConfigurada };
  }
  if (conta.ativo !== true) return { ok: false, motivo: MOTIVO_NFE_SHOPEE.contaInativa };
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*                         which NF-e goes to the channel                      */
/* -------------------------------------------------------------------------- */

/** One `nfev4` document of the pedido, raw, with its id. */
interface DocumentoNfe {
  readonly id: string;
  readonly raw: Record<string, unknown>;
}

/** A skip reason of the shared LEVEL predicate. */
type MotivoDoPredicado = Extract<NfeUploadDispatch, { action: 'skip' }>['reason'];

/** Why no document of the pedido goes to the channel. */
type MotivoSemNfeParaEnvio =
  | MotivoDoPredicado
  | typeof MOTIVO_NFE_SHOPEE.semNfeAprovada
  | typeof MOTIVO_NFE_SHOPEE.nfeNaoEDeVenda;

/** The slot rule's verdict. */
type EscolhaNfeShopee = { readonly nfeId: string } | { readonly motivo: MotivoSemNfeParaEnvio };

/**
 * How far down the ladder each miss got — the higher, the closer the document
 * came to being sent, and the more the reason tells the operator. `apagada`
 * and `nao-aprovada` never climb: a document that is not aprovada is what
 * `sem-nfe-aprovada` summarises.
 */
const PROFUNDIDADE_DA_FALTA: Readonly<Record<MotivoSemNfeParaEnvio, number>> = {
  [MOTIVO_NFE_SHOPEE.apagada]: 0,
  [MOTIVO_NFE_SHOPEE.naoAprovada]: 0,
  [MOTIVO_NFE_SHOPEE.semNfeAprovada]: 0,
  [MOTIVO_NFE_SHOPEE.xmlAusente]: 1,
  [MOTIVO_NFE_SHOPEE.tpambHomologacao]: 2,
  [MOTIVO_NFE_SHOPEE.nfeNaoEDeVenda]: 3,
};

/** `a` wins over `b`: the later authorization, then the lower id. */
function venceNaEscolha(
  a: { readonly id: string; readonly autorizadaMs: number | null },
  b: { readonly id: string; readonly autorizadaMs: number | null },
): boolean {
  const ma = a.autorizadaMs ?? Number.NEGATIVE_INFINITY;
  const mb = b.autorizadaMs ?? Number.NEGATIVE_INFINITY;
  if (ma !== mb) return ma > mb;
  return a.id < b.id;
}

/**
 * Why this document is NOT eligible, or `null` when it is: the level
 * predicate's skip reason, else `nfe-nao-e-de-venda` for a legible non-sale
 * proc. An ILLEGIBLE proc is eligible — the handler judges it.
 */
function motivoDeFicarDeFora(raw: Record<string, unknown>): MotivoSemNfeParaEnvio | null {
  const pronta = decideNfeUploadDispatch(undefined, raw);
  if (pronta.action === 'skip') return pronta.reason;
  const xml = raw.xml_nfe_proc;
  return typeof xml === 'string' && finalidadeDoProc(xml) === 'outra'
    ? MOTIVO_NFE_SHOPEE.nfeNaoEDeVenda
    : null;
}

/**
 * The slot rule: which of the pedido's NF-e documents goes to the channel.
 *
 * Eligible = the LEVEL predicate says ready AND the proc is not a legible
 * non-sale note (an illegible one stays eligible — the handler answers it).
 * Several ⇒ latest `data_autorizacao` in ms, tie ⇒ lowest id — and since only
 * the migrated corpus carries that date (a post-cutover NF-e stores `null`, the
 * oldest), two post-cutover notes fall to the lowest id. None ⇒ the furthest
 * miss (see {@link PROFUNDIDADE_DA_FALTA}), `sem-nfe-aprovada` when nothing got
 * past "aprovada".
 */
export function escolherNfeParaEnvioShopee(docs: readonly DocumentoNfe[]): EscolhaNfeShopee {
  let melhor: { readonly id: string; readonly autorizadaMs: number | null } | null = null;
  let falta: MotivoSemNfeParaEnvio = MOTIVO_NFE_SHOPEE.semNfeAprovada;

  for (const doc of docs) {
    const motivo = motivoDeFicarDeFora(doc.raw);
    if (motivo !== null) {
      if (PROFUNDIDADE_DA_FALTA[motivo] > PROFUNDIDADE_DA_FALTA[falta]) falta = motivo;
      continue;
    }

    const candidata = { id: doc.id, autorizadaMs: coerceToMillis(doc.raw.data_autorizacao) };
    if (melhor === null || venceNaEscolha(candidata, melhor)) melhor = candidata;
  }

  return melhor === null ? { motivo: falta } : { nfeId: melhor.id };
}

/* -------------------------------------------------------------------------- */
/*                         the key the channel will read                       */
/* -------------------------------------------------------------------------- */

/** The key verdict: the key inside our proc, or `xml-invalido`. */
type VereditoDaChave =
  | { readonly chave: string }
  | { readonly motivo: typeof MOTIVO_NFE_SHOPEE.xmlInvalido };

/**
 * The key Shopee will parse out of the file we upload.
 *
 * - no proc string, or `chaveDoProc` finds no key or a self-contradicting one
 *   ⇒ `xml-invalido`;
 * - the document's `chave` field, when it is not `null`/absent, must read as
 *   the SAME key through `chaveCanonica` — a different key, a blank string or
 *   a non-key value ⇒ `xml-invalido`;
 * - otherwise the proc's key.
 */
export function chaveDaNfeParaCanal(raw: Record<string, unknown>): VereditoDaChave {
  const xml = raw.xml_nfe_proc;
  if (typeof xml !== 'string') return { motivo: MOTIVO_NFE_SHOPEE.xmlInvalido };

  const doProc = chaveDoProc(xml);
  if (!('chave' in doProc)) return { motivo: MOTIVO_NFE_SHOPEE.xmlInvalido };

  const armazenada = raw.chave;
  if (armazenada != null) {
    const legivel = typeof armazenada === 'string' ? chaveCanonica(armazenada) : null;
    if (legivel !== doProc.chave) return { motivo: MOTIVO_NFE_SHOPEE.xmlInvalido };
  }

  return { chave: doProc.chave };
}
