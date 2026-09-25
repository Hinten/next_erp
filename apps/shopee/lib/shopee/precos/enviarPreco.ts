/**
 * **The per-item price sender** (#1521, step 13) — one priced item, one conta
 * that passed its verdict, one instant ⇒ at most ONE `update_price`, and one
 * report row per model the planner addressed.
 *
 * {@link enviarPrecoDoItem} is the IO ladder around the pure decision
 * (`./decisaoPreco`): it reads the listing fresh, asks the decision, sends the
 * body the decision built, attributes Shopee's answer per model, verifies what
 * was accepted and records the outcome on the link documents. The manual push
 * and the job both call this function and nothing else under this folder for
 * an item; the ORDER below is the contract (reconcile §2.6, §2.9).
 *
 * ## The gates, in order
 *
 * | # | what | calls | outcome |
 * |---|---|---|---|
 * | G0 | no alvo has a target price | 0 | `pulado preco-nao-encontrado`, nothing read |
 * | G1 | the fresh read (batched base row; `get_model_list` only for a has-model listing) | 0–1 | absent from the batch ⇒ `falha anuncio-inexistente`, stamped with our `erp:` code |
 * | G2–G8 | {@link decidirEnvioDePreco} | 0 | `pular` ⇒ no write; `falhar` ⇒ stamped with the decision's `erp:` code |
 * | G9 | ONE `update_price` | 1 | the error ladder below |
 * | G10 | attribution by `model_id` | 0 | per model: accepted, refused (the code table), or unanswered |
 * | G11 | verification of what was accepted | 0 (echo) | a mismatch ⇒ `falha preco-nao-atualizado`, NEVER stamped |
 * | G12 | the write-backs (`./linkPreco`) | 0 | sequential, BEFORE this function returns |
 *
 * ## The error ladder — one narrowing order for every call
 *
 * `ShopeeRateLimitError` (burst ⇒ `pausa burst` carrying Shopee's
 * `Retry-After`; daily ⇒ `pausa cota-diaria` until the next 00:00 UTC+8,
 * `proximaViradaDaCotaMs`, never the header) → `ShopeeReauthRequiredError` ⇒
 * `fatal reauth` → `ShopeeApiPartialError` → `ShopeeApiError` (the code table)
 * → the four conta classes ⇒ `fatal conta-nao-configurada` →
 * `ShopeeSchemaError` ⇒ rethrow → anything else ⇒ rethrow.
 *
 * ⚠️ The first three classes EXTEND `ShopeeApiError`, so each is narrowed
 * BEFORE it — a bare base-class arm placed above them swallows all three. And
 * the partial class is not a verdict on its own: the transport builds it
 * INSTEAD of whichever subclass the envelope would have produced, whenever the
 * body re-parses. So its arm reads `err.kind` FIRST (a throttle or a dead
 * authorization that arrived with the lists is still a pause or a fatal), and
 * only then re-parses the lists — `shopeeUpdatePriceSchema.safeParse`, never a
 * cast — and attributes per model.
 *
 * Inside the table (`classificarCodigoDePreco`): `pular` and `falhar` become
 * rows, `fatal` ends the run for the conta, `transitorio` is RETHROWN (the
 * queue's ladder, or the manual push's second attempt, owns the retry).
 *
 * ⚠️ `pausa` and `fatal` carry NO rows and write NOTHING (contract S3), even
 * when they arrive after a write that landed: the surface reports the item
 * `nao-tentado`, and the next run reads the landed price back as already equal
 * (S4 — register 147's accepted under-report).
 *
 * ## Attribution (G10) — per model, by id, never by position
 *
 * Only the rows the decision marked `enviado` are re-attributed; every other
 * row of the decision is FINAL and kept verbatim. For each sent model:
 *
 * 1. named in `failure_list` ⇒ its `failed_reason` through the SAME code
 *    table, kind `other` (one refused model is never a reason to retry the
 *    whole call). `pular` ⇒ a skip row; `falhar` ⇒ a refusal row. A per-model
 *    reason the table calls `fatal` or `transitorio` becomes an UNSTAMPED
 *    refusal row (the conta-wide motivo, or `modelo-sem-resposta`): the call
 *    already landed its other models, and a pause or a fatal would drop their
 *    write-backs on the floor.
 *    ⚠️ A reason the table does NOT know (T14 — a generic `"fail"`, or no
 *    text at all) says nothing about WHY. When the call also threw a
 *    top-level code the table DOES know, the row takes that top-level reading
 *    instead (case 3's), so a promotion lock stays a skip that stamps nothing
 *    and the catch-all stays `preco-recusado` under Shopee's verbatim code;
 *    the free text survives as the row's code only when the top-level reading
 *    carries none. A KNOWN per-model reason (T4's `model ID not exist in sku`)
 *    still wins over any top-level code — it names THIS model, the top-level
 *    code names the call;
 * 2. answered in `success_list` ⇒ accepted, pending G11;
 * 3. named in neither ⇒ the TOP-LEVEL code's classification when the call
 *    threw (a partial, or a plain refusal with no lists at all — then every
 *    sent model reads it), else `falha modelo-sem-resposta`.
 *
 * A refusal named in `failure_list` wins over an echo of the same model: a
 * model Shopee also refused is never recorded as sent.
 *
 * ⚠️ Every list row is matched through `modeloDoEco` (`./verificacaoPreco`),
 * the ONE matcher: a no-model listing's echo carries NO `model_id` (probe P4c)
 * and answers the sent `SHOPEE_PRECO_MODEL_ID_SEM_MODELO` by that absence; on a
 * has-model listing a row with a `null` id answers nothing, so every sent model
 * reads `modelo-sem-resposta` rather than a guess. There is no second matcher
 * here to drift from it.
 *
 * ## The item's outcome
 *
 * Any `falha` row ⇒ `falha` (`envio-parcial` when at least one model was
 * accepted, else the first refusal's motivo). No `falha` and nothing accepted ⇒
 * `pulado`, with the first sent model's skip motivo (a promotion lock on every
 * sent model). Otherwise ⇒ `enviado`.
 *
 * ## The write-backs (G12, reconcile C-n)
 *
 * - An ACCEPTED and verified model ⇒ its own success pair on its `variashopee`
 *   (`registrarPrecoDeModelo`) — on a clean send AND on a partial one: the
 *   pair is what expires that model's earlier refusal.
 * - A `falha` row whose motivo is in `MOTIVOS_QUE_CARIMBAM` ⇒ its child is
 *   stamped with the code it was refused under (`registrarRecusaDeModelo`) —
 *   Shopee's text VERBATIM, or our `erp:` code (`codigoDoErpDePreco`, the one
 *   spelling) when the refusal is ours. A no-model listing has no child.
 * - The ITEM doc is written LAST, so a crash mid-way never leaves the parent
 *   claiming more than its children show:
 *   - a CLEAN send ⇒ `registrarPrecoLimpo`, the one clearer — `precoEnviado`
 *     only for a no-model listing (a has-model listing's prices live per
 *     model). Clean means the WHOLE item is in sync: at least one model
 *     accepted, no refusal, and every other row either already equal or
 *     without a target price (see {@link MOTIVOS_EM_SINCRONIA});
 *   - a stamping refusal ⇒ `registrarRecusaDePreco` with the item-level
 *     refusal (a decision's or a read's), else with the FIRST stamping row's
 *     motivo and code (a partial send);
 *   - anything else writes nothing on the item.
 * - Written by NOTHING: `preco-igual` (S4 — an equal reading may be a Seller
 *   Centre edit, and stamping it would attribute it to us), a promotion or
 *   slash-sale lock, an echo mismatch, a skip, a pause, a fatal, a rethrow.
 *
 * Rule 7: none of these fields is ever read to decide a send (Shopee's own
 * reading is the authority) — tier (0) by design, and `./linkPreco` states the
 * whole of it. What a lost race CAN leave is a stale diagnostic, and it stays
 * stale until the next send that CHANGES the price: a `preco-igual` send
 * writes nothing. The item's refusal fields are cleared by a `null` write, not
 * expired by a stamp, so a refusal that lands after a newer clean clear stands
 * beside the newer `precoEnviadoEm` — the step-21 reader shows the item's
 * refusal only while `precoRecusaEm >= (precoEnviadoEm ?? 0)`, the rule that
 * survives this race where the `null` clear does not.
 *
 * ## What it never does
 *
 * It reads no clock (`deps.nowMs` is the instant, in MILLISECONDS), imports no
 * Next module (the functions bundle reaches this folder), touches Firestore
 * only through `./linkPreco`, and catches nothing it does not name.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeApiPartialError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  shopeeUpdatePricePayloadSchema,
  shopeeUpdatePriceSchema,
  type ShopeeClient,
  type ShopeeErrorKind,
  type ShopeeUpdatePrice,
} from '@delfrance/integrations-shopee';
import { ENVIO_PRECO_RESULTADO } from '@delfrance/schemas';

import { proximaViradaDaCotaMs } from '../anuncios/pausarAnuncio';
import { validationPaths } from '../core/validationIssues';
import { MOTIVOS_DE_PAUSA } from '../estoque/constantesEstoque';
import { classificarCodigoDePreco, type ClassePreco } from './classificarPreco';
import { FONTE_DE_VERIFICACAO_PRECO } from './constantesPreco';
import {
  codigoDoErpDePreco,
  decidirEnvioDePreco,
  type LinhaModeloPreco,
  type ResultadoModeloPreco,
} from './decisaoPreco';
import { MOTIVOS_QUE_CARIMBAM, MOTIVO_PRECO_SHOPEE, type MotivoPrecoShopee } from './errosPreco';
import { criarLeitorDeBaseEmLote, type LeitorDeBase } from './leitorDeBase';
import { lerItemParaPreco, projetarLeitura, type LeituraDePreco } from './leituraPreco';
import {
  registrarPrecoDeModelo,
  registrarPrecoLimpo,
  registrarRecusaDeModelo,
  registrarRecusaDePreco,
} from './linkPreco';
import type { AlvoDeModelo, ItemDePreco } from './planoPreco';
import { ehContaInutilizavel, type ContextoContaPreco } from './regiaoPreco';
import { modeloDoEco, verificarPrecosEnviados } from './verificacaoPreco';

// Seam amendment C-1: the row types are DECLARED by the pure decision (the
// first module that produces rows) and re-exported here under the same names,
// so the dependency runs sender → decision, never the reverse.
export type { LinhaModeloPreco, ResultadoModeloPreco } from './decisaoPreco';

/* -------------------------------------------------------------------------- */
/*                                  THE SEAM                                   */
/* -------------------------------------------------------------------------- */

/** The one log tag of this module. */
const TAG_LOG = '[shopee/precos] envio de preço';

/**
 * The bound on a row's `codigo` — Shopee's text is carried verbatim into the
 * report, and a free-text `failed_reason` is not ours to trust for length.
 * The link documents keep the UNCAPPED text (`./linkPreco` stores verbatim).
 */
const MAX_CODIGO_NA_LINHA = 300;

/** The two pauses this sender produces — the stock sync's own spellings. */
type PausaDePreco = (typeof MOTIVOS_DE_PAUSA)['burst' | 'cotaDiaria'];

/** The conta-wide refusals that end a run. */
type MotivoFatalDePreco =
  | 'reauth'
  | 'conta-nao-configurada'
  | 'loja-com-penalidade'
  | 'sem-permissao';

/** What every row-carrying outcome carries. */
interface ComLinhas {
  /** EXACTLY one row per `item.alvos` entry, in the same order (contract S1). */
  readonly modelos: readonly LinhaModeloPreco[];
  /** The Shopee calls THIS item spent — the batched base read is the surface's, never counted here. */
  readonly chamadasShopee: number;
}

/** What happened to one item. `pausa` and `fatal` carry no rows and wrote nothing. */
export type ResultadoEnvioPreco =
  | (ComLinhas & { readonly tipo: 'enviado' })
  | (ComLinhas & { readonly tipo: 'pulado'; readonly motivo: MotivoPrecoShopee })
  | (ComLinhas & {
      readonly tipo: 'falha';
      readonly motivo: MotivoPrecoShopee;
      /** The code the refusal is known by: Shopee's VERBATIM, our `erp:<motivo>`, or `null` (unanswered / unconfirmed). */
      readonly codigo: string | null;
      /** Shopee's sentence when Shopee refused the whole call; `null` otherwise. */
      readonly mensagem: string | null;
      /** Whether a refusal was written onto the ITEM link (a vanished link answers `false`). */
      readonly carimbado: boolean;
    })
  | {
      readonly tipo: 'pausa';
      readonly pausa: PausaDePreco;
      /** MILLISECONDS — the next quota reset on `cota-diaria`; `null` on `burst` (the surface owns the delay). */
      readonly ate: number | null;
      /** Shopee's `Retry-After` on a `burst`, when it sent one; always `null` on `cota-diaria`. */
      readonly retryAfterSeconds: number | null;
      /** Shopee's code, verbatim. */
      readonly codigo: string;
      readonly chamadasShopee: number;
    }
  | {
      readonly tipo: 'fatal';
      readonly motivo: MotivoFatalDePreco;
      /** `"<class>: <message>"` — for the log and the surface, never a link field. */
      readonly erro: string;
      readonly chamadasShopee: number;
    };

/** Everything the sender needs besides the item. */
export interface DepsEnvioPreco {
  readonly db: Firestore;
  /** A conta that PASSED `avaliarContaParaPreco` — branded, so nothing else fits here. */
  readonly conta: ContextoContaPreco;
  /** MILLISECONDS — the ONE instant of the request or dispatch; every stamp is this. */
  readonly nowMs: number;
  /** `true` ⇒ the decrease guard is OFF (the operator authorised a lower price). */
  readonly baixarPreco: boolean;
  /** The request's (or dispatch's) batched `get_item_base_info` reader. */
  readonly lerBase: LeitorDeBase;
}

/* -------------------------------------------------------------------------- */
/*                              THE COMPLETENESS                               */
/* -------------------------------------------------------------------------- */

/**
 * **Every alvo has exactly one row, in the same order** — contract S1.
 *
 * Throws when it does not. A thrown `Error` is the right shape (step 12's
 * `conferirCompletudeDoAnuncio`): a mismatch can only be a defect in this
 * folder's own bookkeeping — no document, no wire answer and no operator input
 * can cause it — and a report that silently lost a model is worse than a
 * failed item. It runs BEFORE any write-back, so a broken row set writes
 * nothing.
 *
 * Exported so the property is testable on its own, beside the end-to-end pins.
 */
export function conferirCompletudeDoItemDePreco(
  item: ItemDePreco,
  linhas: readonly LinhaModeloPreco[],
): void {
  const completo =
    linhas.length === item.alvos.length &&
    item.alvos.every((alvo, i) => {
      const linha = linhas[i];
      return (
        linha !== undefined &&
        linha.modelId === alvo.modelId &&
        linha.produtoId === alvo.produtoId &&
        linha.varLinkDocId === alvo.varLinkDocId
      );
    });
  if (completo) return;
  throw new Error(
    '[shopee/precos] linhas incompletas: ' +
      `${String(linhas.length)} linhas para ${String(item.alvos.length)} alvos ` +
      `(anúncio ${String(item.itemId)}, vínculo ${item.linkDocId})`,
  );
}

/* -------------------------------------------------------------------------- */
/*                                   HELPERS                                   */
/* -------------------------------------------------------------------------- */

/** Calls spent by THIS item — the one mutable of a run. */
interface Contador {
  n: number;
}

/** The per-item state every step reads. */
interface Contexto {
  readonly item: ItemDePreco;
  readonly deps: DepsEnvioPreco;
  readonly contador: Contador;
}

/** A refusal row's stamp: the code VERBATIM and the sentence that goes with it. */
interface Carimbo {
  readonly codigo: string;
  readonly mensagem: string | null;
}

/**
 * One row plus what the write-back needs that the report row must not carry:
 * whether the model was SENT (the decision's provisional `enviado`), and the
 * UNCAPPED code its child is stamped with (`null` ⇔ the row stamps nothing).
 */
interface LinhaAtribuida {
  readonly linha: LinhaModeloPreco;
  readonly enviada: boolean;
  readonly carimbo: Carimbo | null;
}

/** The item-level refusal the ITEM link records. */
interface RecusaDoItem extends Carimbo {
  readonly motivo: MotivoPrecoShopee;
}

/** A refusal the table turned into rows. */
type Recusa = Extract<ClassePreco, { readonly classe: 'pular' | 'falhar' }>;

/** A thrown refusal's top-level reading — what the models no list names take. */
interface Topo {
  readonly classe: Recusa;
  readonly codigo: string;
  readonly mensagem: string;
}

/** The ladder's verdict on one thrown error; `null` ⇔ rethrow it. */
type VereditoDoErro =
  | {
      readonly tipo: 'pausa';
      readonly pausa: PausaDePreco;
      readonly ate: number | null;
      readonly retryAfterSeconds: number | null;
      readonly codigo: string;
    }
  | { readonly tipo: 'fatal'; readonly motivo: MotivoFatalDePreco; readonly erro: string }
  | (Topo & { readonly tipo: 'recusa'; readonly resposta: ShopeeUpdatePrice | null });

/** An answer with no lists at all — the schema's own defaults, never a hand-built literal. */
const SEM_LISTAS: ShopeeUpdatePrice = shopeeUpdatePricePayloadSchema.parse({});

/**
 * The rows that leave the item "in sync" beside an accepted send: already
 * equal, or without a target price (the ERP has no opinion on that model). A
 * guard-held decrease, an unreadable current price, an absent model or a lock
 * are NOT — the listing does not carry the ERP's price there, so the item doc
 * keeps its last success stamp and its refusal stays legible.
 */
const MOTIVOS_EM_SINCRONIA: ReadonlySet<MotivoPrecoShopee> = new Set<MotivoPrecoShopee>([
  MOTIVO_PRECO_SHOPEE.precoIgual,
  MOTIVO_PRECO_SHOPEE.precoNaoEncontrado,
]);

function descrever(err: Error): string {
  return `${err.name}: ${err.message}`;
}

function limitarCodigo(texto: string): string {
  return texto.length <= MAX_CODIGO_NA_LINHA ? texto : texto.slice(0, MAX_CODIGO_NA_LINHA);
}

/** A row rewritten with a new result — identity fields and prices untouched. */
function reescrever(
  linha: LinhaModeloPreco,
  resultado: ResultadoModeloPreco,
  motivo: MotivoPrecoShopee | null,
  codigo: string | null,
): LinhaModeloPreco {
  return { ...linha, resultado, motivo, codigo: codigo === null ? null : limitarCodigo(codigo) };
}

/** A row built straight from an alvo — the paths that end before the decision. */
function linhaDoAlvo(
  alvo: AlvoDeModelo,
  resultado: ResultadoModeloPreco,
  motivo: MotivoPrecoShopee,
  codigo: string | null,
): LinhaModeloPreco {
  return {
    modelId: alvo.modelId,
    produtoId: alvo.produtoId,
    varLinkDocId: alvo.varLinkDocId,
    precoAlvo: alvo.precoAlvo,
    precoAnterior: null,
    resultado,
    motivo,
    codigo: codigo === null ? null : limitarCodigo(codigo),
  };
}

/** The stamp a `falha` row takes — `null` when its motivo does not stamp. */
function carimboSe(motivo: MotivoPrecoShopee, carimbo: Carimbo): Carimbo | null {
  return MOTIVOS_QUE_CARIMBAM.has(motivo) ? carimbo : null;
}

/** The motivo a settled row carries; a row without one here is a bookkeeping defect. */
function motivoDe(linha: LinhaModeloPreco): MotivoPrecoShopee {
  if (linha.motivo === null) {
    throw new Error(
      `[shopee/precos] a linha do modelo ${String(linha.modelId)} (${linha.resultado}) não tem motivo.`,
    );
  }
  return linha.motivo;
}

/** The price an accepted row was sent at; an accepted row without one is a bookkeeping defect. */
function precoEnviadoDe(linha: LinhaModeloPreco): number {
  if (linha.precoAlvo === null) {
    throw new Error(
      `[shopee/precos] a linha do modelo ${String(linha.modelId)} foi aceita sem preço-alvo.`,
    );
  }
  return linha.precoAlvo;
}

/* -------------------------------------------------------------------------- */
/*                                 THE LADDER                                  */
/* -------------------------------------------------------------------------- */

/** A rate limit, whichever class carried it. The daily reset NEVER reads the header. */
function pausaDoLimite(
  kind: ShopeeErrorKind,
  codigo: string,
  retryAfterSeconds: number | null,
  nowMs: number,
): VereditoDoErro {
  if (kind === SHOPEE_ERROR_KIND.burst) {
    return { tipo: 'pausa', pausa: MOTIVOS_DE_PAUSA.burst, ate: null, retryAfterSeconds, codigo };
  }
  return {
    tipo: 'pausa',
    pausa: MOTIVOS_DE_PAUSA.cotaDiaria,
    ate: proximaViradaDaCotaMs(nowMs),
    retryAfterSeconds: null,
    codigo,
  };
}

/** One Shopee refusal through the code table. `null` ⇔ transient: rethrow. */
function daTabela(err: ShopeeApiError, resposta: ShopeeUpdatePrice | null): VereditoDoErro | null {
  const classe = classificarCodigoDePreco(err.code, err.message, err.kind);
  if (classe.classe === 'transitorio') return null;
  if (classe.classe === 'fatal')
    return { tipo: 'fatal', motivo: classe.motivo, erro: descrever(err) };
  return { tipo: 'recusa', classe, codigo: err.code, mensagem: err.message, resposta };
}

/**
 * THE narrowing order (see the module docblock). `comListas` is `true` only
 * for the write: it is the one call whose partial carries price lists worth
 * re-parsing.
 */
function veredictoDoErro(err: unknown, nowMs: number, comListas: boolean): VereditoDoErro | null {
  if (err instanceof ShopeeRateLimitError) {
    return pausaDoLimite(err.kind, err.code, err.retryAfterSeconds, nowMs);
  }
  if (err instanceof ShopeeReauthRequiredError) {
    return { tipo: 'fatal', motivo: MOTIVO_PRECO_SHOPEE.reauth, erro: descrever(err) };
  }
  if (err instanceof ShopeeApiPartialError) {
    // ⚠️ The KIND first: the transport builds this class INSTEAD of the
    // throttle / reauth subclass whenever the body re-parses.
    if (err.kind === SHOPEE_ERROR_KIND.burst || err.kind === SHOPEE_ERROR_KIND.daily) {
      // `null` because there is none to pass: the transport copies no
      // `Retry-After` onto the partial class, so a throttle whose body carried
      // a `response` object (even `{}`) loses the header and pauses on the
      // surface's own default.
      return pausaDoLimite(err.kind, err.code, null, nowMs);
    }
    if (err.kind === SHOPEE_ERROR_KIND.reauth) {
      return { tipo: 'fatal', motivo: MOTIVO_PRECO_SHOPEE.reauth, erro: descrever(err) };
    }
    if (!comListas) return daTabela(err, null);
    // RE-PARSED, never cast: `parsed` is `unknown` on purpose.
    const relido = shopeeUpdatePriceSchema.safeParse(err.parsed);
    if (relido.success) return daTabela(err, relido.data.response);
    // Lists that do not re-parse say nothing per model: the top-level code
    // speaks for every sent model, exactly as for a plain refusal.
    console.warn(TAG_LOG, {
      evento: 'parcial-ilegivel',
      codigo: err.code,
      campos: validationPaths(relido.error.issues),
    });
    return daTabela(err, null);
  }
  if (err instanceof ShopeeApiError) return daTabela(err, null);
  if (ehContaInutilizavel(err)) {
    return {
      tipo: 'fatal',
      motivo: MOTIVO_PRECO_SHOPEE.contaNaoConfigurada,
      erro: descrever(err),
    };
  }
  // A wire drift must reach the queue's alarm, never a report row.
  if (err instanceof ShopeeSchemaError) return null;
  return null;
}

/** A `pausa` or a `fatal` — no rows, no write (S3). */
function interromper(
  ctx: Contexto,
  v: Exclude<VereditoDoErro, { readonly tipo: 'recusa' }>,
): ResultadoEnvioPreco {
  if (v.tipo === 'pausa') {
    return {
      tipo: 'pausa',
      pausa: v.pausa,
      ate: v.ate,
      retryAfterSeconds: v.retryAfterSeconds,
      codigo: v.codigo,
      chamadasShopee: ctx.contador.n,
    };
  }
  return { tipo: 'fatal', motivo: v.motivo, erro: v.erro, chamadasShopee: ctx.contador.n };
}

/* -------------------------------------------------------------------------- */
/*                                  THE READ                                   */
/* -------------------------------------------------------------------------- */

/**
 * `lerItemParaPreco` with its calls counted on `contador`, a throw included.
 *
 * The read reports the calls it issued only when it returns; on a throw, the
 * `get_model_list` it issued is known from the base row it read — through
 * `projetarLeitura`, the read module's own `has_model` rule, never a second
 * copy of it. `cobrarBase` counts the base call itself: `false` for the
 * surface's batched reader (the surface's cost), `true` for the fresh one-id
 * reader a read-back builds (this item's cost).
 */
async function lerContando(
  client: ShopeeClient,
  itemId: number,
  lerBase: LeitorDeBase,
  contador: Contador,
  cobrarBase: boolean,
): ReturnType<typeof lerItemParaPreco> {
  let listaDeModelosPedida = false;
  const lerBaseObservado: LeitorDeBase = async (id) => {
    if (cobrarBase) contador.n += 1;
    const linha = await lerBase(id);
    listaDeModelosPedida = linha !== null && projetarLeitura(linha, null).temModelos;
    return linha;
  };
  let lida: Awaited<ReturnType<typeof lerItemParaPreco>>;
  try {
    lida = await lerItemParaPreco(client, itemId, lerBaseObservado);
  } catch (err) {
    if (listaDeModelosPedida) contador.n += 1;
    throw err;
  }
  if (!lida.ausente) contador.n += lida.chamadas;
  return lida;
}

/** A read Shopee refused (G1 under the table): every row reads the same refusal. */
function recusaNaLeitura(ctx: Contexto, v: Topo): Promise<ResultadoEnvioPreco> {
  const { item } = ctx;
  if (v.classe.classe === 'pular') {
    const motivo = v.classe.motivo;
    return concluir(ctx, {
      tipo: 'pulado',
      motivo,
      atribuidas: item.alvos.map((alvo) => ({
        linha: linhaDoAlvo(alvo, ENVIO_PRECO_RESULTADO.pulado, motivo, v.codigo),
        enviada: false,
        carimbo: null,
      })),
    });
  }
  const motivo = v.classe.motivo;
  const carimbo = carimboSe(motivo, { codigo: v.codigo, mensagem: v.mensagem });
  return concluir(ctx, {
    tipo: 'falha',
    motivo,
    codigo: v.codigo,
    mensagem: v.mensagem,
    recusaDoItem: carimbo === null ? null : { ...carimbo, motivo },
    atribuidas: item.alvos.map((alvo) => ({
      linha: linhaDoAlvo(alvo, ENVIO_PRECO_RESULTADO.falha, motivo, v.codigo),
      enviada: false,
      carimbo,
    })),
  });
}

/* -------------------------------------------------------------------------- */
/*                               THE ATTRIBUTION                               */
/* -------------------------------------------------------------------------- */

/** T14 — the table's answer to a text nobody taught it (`classificarPreco.ts`). */
function ehRecusaDesconhecida(classe: ClassePreco): boolean {
  return classe.classe === 'falhar' && classe.motivo === MOTIVO_PRECO_SHOPEE.recusaDesconhecida;
}

/**
 * One sent model refused by name in `failure_list` — its own reason, through
 * the table.
 *
 * ⚠️ Unless the table does not know that reason (T14) and the call threw a
 * top-level code it DOES know: then the top-level reading speaks for the row
 * ({@link daRecusaDoTopo}), with the reason kept as evidence only where that
 * reading carries no code. Without this, a promotion lock sent with the lists
 * and a generic `"fail"` row would stamp a healthy listing for the length of
 * the promotion (review L1-1). A KNOWN reason still wins over any top-level code.
 */
function daRecusaDoModelo(
  linha: LinhaModeloPreco,
  razao: string | null,
  topo: Topo | null,
): LinhaAtribuida {
  const texto = razao ?? '';
  const classe = classificarCodigoDePreco(texto, '', SHOPEE_ERROR_KIND.other);
  const codigo = texto === '' ? null : texto;
  if (ehRecusaDesconhecida(classe) && topo !== null && !ehRecusaDesconhecida(topo.classe)) {
    return daRecusaDoTopo(linha, topo, codigo);
  }
  switch (classe.classe) {
    case 'pular':
      return {
        linha: reescrever(linha, ENVIO_PRECO_RESULTADO.pulado, classe.motivo, codigo),
        enviada: true,
        carimbo: null,
      };
    case 'falhar':
      return {
        linha: reescrever(linha, ENVIO_PRECO_RESULTADO.falha, classe.motivo, codigo),
        enviada: true,
        // A reason with no text is stamped under the call's own code (an
        // unknown one here — a known one took the branch above), or ours.
        carimbo: carimboSe(classe.motivo, {
          codigo: codigo ?? topo?.codigo ?? codigoDoErpDePreco(classe.motivo),
          mensagem: null,
        }),
      };
    case 'fatal':
      // Conta-wide by nature, but THIS call landed other models: an unstamped
      // row keeps their write-backs (a fatal would write nothing at all).
      return {
        linha: reescrever(linha, ENVIO_PRECO_RESULTADO.falha, classe.motivo, codigo),
        enviada: true,
        carimbo: null,
      };
    case 'transitorio':
      // Not confirmed, not refused for good: the next run sends it again.
      return {
        linha: reescrever(
          linha,
          ENVIO_PRECO_RESULTADO.falha,
          MOTIVO_PRECO_SHOPEE.modeloSemResposta,
          codigo,
        ),
        enviada: true,
        carimbo: null,
      };
  }
}

/**
 * One sent model under a thrown refusal's top-level reading — a model no list
 * names, or one whose own reason the table does not know. `evidencia` is that
 * unknown reason: it becomes the row's code (and its stamp's) only when the
 * top-level reading carries no code of its own.
 */
function daRecusaDoTopo(
  linha: LinhaModeloPreco,
  topo: Topo,
  evidencia: string | null = null,
): LinhaAtribuida {
  const { classe } = topo;
  const codigo = topo.codigo === '' && evidencia !== null ? evidencia : topo.codigo;
  if (classe.classe === 'pular') {
    return {
      linha: reescrever(linha, ENVIO_PRECO_RESULTADO.pulado, classe.motivo, codigo),
      enviada: true,
      carimbo: null,
    };
  }
  return {
    linha: reescrever(linha, ENVIO_PRECO_RESULTADO.falha, classe.motivo, codigo),
    enviada: true,
    carimbo: carimboSe(classe.motivo, { codigo, mensagem: topo.mensagem }),
  };
}

/**
 * G10 — Shopee's answer, per model, by id. See the module docblock for the
 * three cases and why a refusal wins over an echo.
 */
function atribuir(
  item: ItemDePreco,
  linhas: readonly LinhaModeloPreco[],
  resposta: ShopeeUpdatePrice,
  topo: Topo | null,
): LinhaAtribuida[] {
  return linhas.map((linha) => {
    // Every row the decision settled is FINAL.
    if (linha.resultado !== ENVIO_PRECO_RESULTADO.enviado) {
      return { linha, enviada: false, carimbo: null };
    }
    const recusada = resposta.failure_list.find(
      (f) => modeloDoEco(f, item.semModelos) === linha.modelId,
    );
    if (recusada !== undefined) return daRecusaDoModelo(linha, recusada.failed_reason, topo);
    const aceita = resposta.success_list.some(
      (s) => modeloDoEco(s, item.semModelos) === linha.modelId,
    );
    if (aceita) return { linha, enviada: true, carimbo: null };
    if (topo !== null) return daRecusaDoTopo(linha, topo);
    return {
      linha: reescrever(
        linha,
        ENVIO_PRECO_RESULTADO.falha,
        MOTIVO_PRECO_SHOPEE.modeloSemResposta,
        null,
      ),
      enviada: true,
      carimbo: null,
    };
  });
}

/* -------------------------------------------------------------------------- */
/*                               THE WRITE-BACKS                               */
/* -------------------------------------------------------------------------- */

/** What {@link concluir} records and returns — the item's outcome before the count. */
type Desfecho =
  | {
      readonly tipo: 'enviado';
      readonly atribuidas: readonly LinhaAtribuida[];
      /** Non-null ⇔ the WHOLE item is in sync — the one clearer runs. */
      readonly limpo: { readonly precoEnviado: number | null } | null;
    }
  | {
      readonly tipo: 'pulado';
      readonly motivo: MotivoPrecoShopee;
      readonly atribuidas: readonly LinhaAtribuida[];
    }
  | {
      readonly tipo: 'falha';
      readonly motivo: MotivoPrecoShopee;
      readonly codigo: string | null;
      readonly mensagem: string | null;
      readonly recusaDoItem: RecusaDoItem | null;
      readonly atribuidas: readonly LinhaAtribuida[];
    };

/**
 * G12 — sequential, children first (in row order), the ITEM doc last.
 * Resolves whether a refusal landed on the item doc.
 */
async function gravar(ctx: Contexto, d: Desfecho): Promise<boolean> {
  if (d.tipo === 'pulado') return false;
  const { db, conta, nowMs } = ctx.deps;
  const integracaoId = conta.integracaoId;

  for (const { linha, carimbo } of d.atribuidas) {
    if (linha.varLinkDocId === null) continue;
    const alvoVar = { integracaoId, produtoId: linha.produtoId, varLinkDocId: linha.varLinkDocId };
    if (linha.resultado === ENVIO_PRECO_RESULTADO.enviado) {
      await registrarPrecoDeModelo(db, alvoVar, { preco: precoEnviadoDe(linha), nowMs });
    } else if (carimbo !== null) {
      await registrarRecusaDeModelo(db, alvoVar, { codigo: carimbo.codigo, nowMs });
    }
  }

  const alvo = { integracaoId, produtoId: ctx.item.produtoId, linkDocId: ctx.item.linkDocId };
  if (d.tipo === 'enviado') {
    if (d.limpo !== null) {
      await registrarPrecoLimpo(db, alvo, { precoEnviado: d.limpo.precoEnviado, nowMs });
    }
    return false;
  }
  if (d.recusaDoItem === null) return false;
  return registrarRecusaDePreco(db, alvo, {
    codigo: d.recusaDoItem.codigo,
    motivo: d.recusaDoItem.motivo,
    mensagem: d.recusaDoItem.mensagem,
    nowMs,
  });
}

/** S1, then G12, then the result — in that order (S5: the writes land before the return). */
async function concluir(ctx: Contexto, d: Desfecho): Promise<ResultadoEnvioPreco> {
  const modelos = d.atribuidas.map((a) => a.linha);
  conferirCompletudeDoItemDePreco(ctx.item, modelos);
  const carimbado = await gravar(ctx, d);
  const chamadasShopee = ctx.contador.n;
  switch (d.tipo) {
    case 'enviado':
      return { tipo: 'enviado', modelos, chamadasShopee };
    case 'pulado':
      return { tipo: 'pulado', motivo: d.motivo, modelos, chamadasShopee };
    case 'falha':
      return {
        tipo: 'falha',
        motivo: d.motivo,
        codigo: d.codigo,
        mensagem: d.mensagem,
        carimbado,
        modelos,
        chamadasShopee,
      };
  }
}

/** The item's outcome from its attributed rows (see the module docblock). */
function desfechoDoEnvio(item: ItemDePreco, atribuidas: readonly LinhaAtribuida[]): Desfecho {
  const falhas = atribuidas.filter((a) => a.linha.resultado === ENVIO_PRECO_RESULTADO.falha);
  const aceitas = atribuidas.filter((a) => a.linha.resultado === ENVIO_PRECO_RESULTADO.enviado);

  const [primeiraFalha] = falhas;
  if (primeiraFalha !== undefined) {
    // The item doc records the FIRST refusal that stamps, with its own motivo
    // and code — the pair stays coherent even when the item reads `envio-parcial`.
    let recusaDoItem: RecusaDoItem | null = null;
    for (const a of falhas) {
      if (a.carimbo === null) continue;
      recusaDoItem = { ...a.carimbo, motivo: motivoDe(a.linha) };
      break;
    }
    return {
      tipo: 'falha',
      motivo: aceitas.length > 0 ? MOTIVO_PRECO_SHOPEE.envioParcial : motivoDe(primeiraFalha.linha),
      codigo: recusaDoItem?.codigo ?? primeiraFalha.linha.codigo,
      mensagem: recusaDoItem?.mensagem ?? null,
      recusaDoItem,
      atribuidas,
    };
  }

  const [primeiraAceita] = aceitas;
  if (primeiraAceita === undefined) {
    // Every model sent was held (a lock): the item is a skip, with ITS motivo.
    const retida = atribuidas.find((a) => a.enviada);
    if (retida === undefined) {
      throw new Error(
        `[shopee/precos] envio sem nenhum modelo enviado (anúncio ${String(item.itemId)}).`,
      );
    }
    return { tipo: 'pulado', motivo: motivoDe(retida.linha), atribuidas };
  }

  const emSincronia = atribuidas.every(
    ({ linha }) =>
      linha.resultado === ENVIO_PRECO_RESULTADO.enviado ||
      (linha.motivo !== null && MOTIVOS_EM_SINCRONIA.has(linha.motivo)),
  );
  return {
    tipo: 'enviado',
    atribuidas,
    limpo: emSincronia
      ? { precoEnviado: item.semModelos ? precoEnviadoDe(primeiraAceita.linha) : null }
      : null,
  };
}

/* -------------------------------------------------------------------------- */
/*                                 THE SENDER                                  */
/* -------------------------------------------------------------------------- */

/**
 * Send ONE item's price — G0 to G12 (see the module docblock).
 *
 * Resolves in every case the ladder names: `enviado` / `pulado` / `falha`
 * carry one row per alvo and have ALREADY written their write-backs; `pausa`
 * and `fatal` carry no rows and wrote nothing.
 *
 * @throws the SAME instance for a transient or unclassified failure (the
 *   table's `transitorio`, HTTP / network, a held token refresh, a schema
 *   drift, a Firestore failure, any class this module does not name) — the
 *   caller's retry ladder owns it (contract S2).
 * @throws Error when the rows would break contract S1 — before any write.
 */
export async function enviarPrecoDoItem(
  item: ItemDePreco,
  deps: DepsEnvioPreco,
): Promise<ResultadoEnvioPreco> {
  const ctx: Contexto = { item, deps, contador: { n: 0 } };
  const { client } = deps.conta;

  // ---- G0: nothing priced ⇒ nothing to read. ----
  if (!item.alvos.some((alvo) => alvo.precoAlvo !== null)) {
    const motivo = MOTIVO_PRECO_SHOPEE.precoNaoEncontrado;
    return concluir(ctx, {
      tipo: 'pulado',
      motivo,
      atribuidas: item.alvos.map((alvo) => ({
        linha: linhaDoAlvo(alvo, ENVIO_PRECO_RESULTADO.pulado, motivo, null),
        enviada: false,
        carimbo: null,
      })),
    });
  }

  // ---- G1: the fresh read. ----
  let lida: Awaited<ReturnType<typeof lerItemParaPreco>>;
  try {
    lida = await lerContando(client, item.itemId, deps.lerBase, ctx.contador, false);
  } catch (err) {
    const v = veredictoDoErro(err, deps.nowMs, false);
    if (v === null) throw err;
    if (v.tipo !== 'recusa') return interromper(ctx, v);
    return recusaNaLeitura(ctx, v);
  }
  if (lida.ausente) {
    const motivo = MOTIVO_PRECO_SHOPEE.anuncioInexistente;
    const carimbo = { codigo: codigoDoErpDePreco(motivo), mensagem: null };
    return concluir(ctx, {
      tipo: 'falha',
      motivo,
      codigo: carimbo.codigo,
      mensagem: null,
      recusaDoItem: { ...carimbo, motivo },
      atribuidas: item.alvos.map((alvo) => ({
        linha: linhaDoAlvo(alvo, ENVIO_PRECO_RESULTADO.falha, motivo, null),
        enviada: false,
        carimbo,
      })),
    });
  }

  // ---- G2–G8: the pure decision. ----
  const decisao = decidirEnvioDePreco(
    item,
    lida.leitura,
    { moeda: deps.conta.moeda, multiplo: deps.conta.multiplo },
    { baixarPreco: deps.baixarPreco },
  );
  // S1 BEFORE the wire as well: a row set that lost a model never sends.
  conferirCompletudeDoItemDePreco(item, decisao.linhas);
  if (decisao.tipo === 'pular') {
    return concluir(ctx, {
      tipo: 'pulado',
      motivo: decisao.motivo,
      atribuidas: decisao.linhas.map((linha) => ({ linha, enviada: false, carimbo: null })),
    });
  }
  if (decisao.tipo === 'falhar') {
    // Our refusal: the item doc takes the decision's `erp:` code, and a child
    // only when ITS row was refused (reconcile Appendix D, D-11).
    const recusa: Carimbo = { codigo: decisao.codigoErp, mensagem: null };
    return concluir(ctx, {
      tipo: 'falha',
      motivo: decisao.motivo,
      codigo: decisao.codigoErp,
      mensagem: null,
      recusaDoItem: MOTIVOS_QUE_CARIMBAM.has(decisao.motivo)
        ? { ...recusa, motivo: decisao.motivo }
        : null,
      atribuidas: decisao.linhas.map((linha) => ({
        linha,
        enviada: false,
        carimbo:
          linha.resultado === ENVIO_PRECO_RESULTADO.falha
            ? carimboSe(motivoDe(linha), recusa)
            : null,
      })),
    });
  }

  // ---- G9: the ONE write. ----
  let resposta: ShopeeUpdatePrice;
  let topo: Topo | null = null;
  ctx.contador.n += 1;
  try {
    const envelope = await client.updatePrice({
      item_id: item.itemId,
      price_list: decisao.priceList,
    });
    resposta = envelope.response;
  } catch (err) {
    const v = veredictoDoErro(err, deps.nowMs, true);
    if (v === null) throw err;
    if (v.tipo !== 'recusa') return interromper(ctx, v);
    resposta = v.resposta ?? SEM_LISTAS;
    topo = v;
  }

  // ---- G10: who answered what. ----
  let atribuidas = atribuir(item, decisao.linhas, resposta, topo);

  // ---- G11: does Shopee show what it accepted? ----
  const enviados = atribuidas
    .filter((a) => a.linha.resultado === ENVIO_PRECO_RESULTADO.enviado)
    .map((a) => ({ modelId: a.linha.modelId, precoAlvo: precoEnviadoDe(a.linha) }));
  if (enviados.length > 0) {
    const reler = async (): Promise<LeituraDePreco> => {
      // A FRESH one-id reader: the request's batched one is memoised, and a
      // read-back through it would compare against the pre-write row.
      const fresca = await lerContando(
        client,
        item.itemId,
        criarLeitorDeBaseEmLote(client, [item.itemId]),
        ctx.contador,
        true,
      );
      return fresca.ausente
        ? { itemStatus: null, temModelos: !item.semModelos, modelos: [] }
        : fresca.leitura;
    };
    let veredito: Awaited<ReturnType<typeof verificarPrecosEnviados>>;
    try {
      veredito = await verificarPrecosEnviados(
        enviados,
        resposta,
        FONTE_DE_VERIFICACAO_PRECO,
        reler,
      );
    } catch (err) {
      const v = veredictoDoErro(err, deps.nowMs, false);
      if (v === null) throw err;
      if (v.tipo !== 'recusa') return interromper(ctx, v);
      // A read-back Shopee refused cannot confirm anything.
      veredito = { ok: false, divergentes: enviados.map((e) => e.modelId) };
    }
    if (veredito.ok) {
      if (veredito.ecosNulos > 0) {
        console.warn(TAG_LOG, {
          evento: 'eco-sem-preco',
          itemId: item.itemId,
          ecosNulos: veredito.ecosNulos,
        });
      }
    } else {
      const divergentes = new Set(veredito.divergentes);
      atribuidas = atribuidas.map((a) =>
        a.linha.resultado === ENVIO_PRECO_RESULTADO.enviado && divergentes.has(a.linha.modelId)
          ? {
              linha: reescrever(
                a.linha,
                ENVIO_PRECO_RESULTADO.falha,
                MOTIVO_PRECO_SHOPEE.precoNaoAtualizado,
                null,
              ),
              enviada: true,
              // Accepted, just not confirmed: neither side of the link is written.
              carimbo: null,
            }
          : a,
      );
    }
  }

  // ---- the item's outcome, then G12. ----
  return concluir(ctx, desfechoDoEnvio(item, atribuidas));
}
