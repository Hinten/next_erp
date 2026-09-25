/**
 * The MANUAL price push (#1521, step 13) — "enviar preço agora" for a
 * hand-picked set of produtos, the synchronous twin of step 12's manual stock
 * push. The route `POST /api/marketplace/shopee/enviar-precos` and the
 * `enviar:precos --live` CLI both run THIS function, and nothing else.
 *
 * Shape, and why:
 *
 *  - **Synchronous, in-process, no job document.** The request is bounded at
 *    {@link SHOPEE_ENVIO_PRECO_MAX_PRODUTOS} produtos, and the acceptance is a
 *    per-MODEL outcome — enqueueing would answer a "the price is wrong now"
 *    complaint with a poll route.
 *  - **One sender.** Every item goes through `enviarPrecoDoItem` verbatim: the
 *    fresh read, the decision, the wire, the attribution, the verification and
 *    every link write-back live there. This module owns the RUN around it — the
 *    child → anchor resolution, the plan (identities), the send-time price
 *    read, the ONE batched base reader, the pool, the deadline, the retry
 *    ladder, the aborts — and the ACCOUNTING.
 *  - **The conta verdict is the CALLER's.** The deps carry the branded
 *    `ContextoContaPreco`, which only `avaliarContaParaPreco` can produce, so
 *    this module cannot be called for a conta the ERP refuses to price; the
 *    route answers that refusal 422 before a single item is considered.
 *
 * ## A requested CHILD resolves to its ANCHOR
 *
 * The listing (`prodshopee`) hangs off the family anchor, and every model of it
 * is priced from its own child — so a request naming a variation child is a
 * request for its anchor's listings. Anchors are deduplicated AFTER resolution
 * (a child and its own anchor in one request cost one family, one plan, one
 * send per listing). Rows always name the ANCHOR in `produtoId` and the child
 * whose price a model carries in `variacaoProdutoId`.
 *
 * ## ⚠️ The price is read at SEND time, never at plan time (reconcile C-d)
 *
 * The plan carries IDENTITIES only — anchor, listing, `item_id`, models. Each
 * item's price is read inside its pool task, immediately before the sender
 * runs: ONE masked key read (`lerPrecosDosProdutos`) of exactly the produtos
 * that price it — the anchor of a no-model listing, each model's own child
 * otherwise — handed to the pure `precificarItem`. That is the job's
 * drain-time rule, applied to this surface. An item late in the pool is sent up
 * to the deadline after the request started, and pricing every item up front
 * made a tabela edited inside that window (a second operator, another tab, the
 * job) a lost update ON THE WIRE: the older value overwrote the newer one at
 * Shopee — and when the newer one was a decrease the operator had authorised,
 * the default push (guard ON) then refused to lower it again. A produto deleted
 * after the plan is simply absent from that read: its models carry no price
 * and answer `preco-nao-encontrado`, never a throw.
 *
 * Every ladder attempt re-reads, so a retry sends the tabela as it stands at
 * the retry. After a first attempt's read, and before any Shopee call, the task
 * checks the abort flags again: a sibling may have thrown, paused or hit a
 * fatal while the read was in flight, and an item that has not called Shopee
 * yet answers `nao-tentado` like every item that had not started.
 *
 * ⚠️ **ACCEPTED, not fixed — the no-model comparand's window** (reconcile C-c,
 * register 148). A no-model listing's CURRENT price comes from the batched base
 * row below, and the first item of a chunk reads it for the whole chunk, so it
 * is up to one request old when a later item is decided. The TARGET is fresh;
 * the shelf price it is compared with is not. Consequence: a Seller-Centre edit
 * landing inside the window is judged against the older shelf price — the
 * equality check can re-send a value Shopee already holds, and the decrease
 * guard can let a send LOWER a price the seller has just raised there, with the
 * guard ON. A has-model listing reads its model list per item and has no such
 * window.
 *
 * ## One base read per request
 *
 * `criarLeitorDeBaseEmLote` is built ONCE, over every planned item, before the
 * pool starts: up to fifty listings cost one `get_item_base_info` instead of
 * fifty (the per-APPLICATION quota every conta shares). Its construction throws
 * `ShopeeConfigError` on a malformed id — that is OUR bug, and it propagates
 * as one; it never becomes item rows.
 *
 * ## ⚠️ `pausa` and `fatal` answer 200, not a rethrow (reconcile C-s)
 *
 * Step 12's manual push rethrows a dead grant, which loses the rows of every
 * listing that ALREADY landed in the same request. Here a quota pause or a
 * conta-wide fatal (`reauth`, `conta-nao-configurada`, `loja-com-penalidade`,
 * `sem-permissao`) ABORTS the rest: the item that met it and every item not yet
 * started answer `nao-tentado` with that motivo, the landed ones keep their
 * rows, and the envelope still answers 200 — with `pausadoAte` on a pause. The
 * rows say "reconecte a conta" as clearly as a status code would, and they do
 * not throw away the work that already reached Shopee.
 *
 * ## ⚠️ The deadline runs on ELAPSED wall clock, through the INJECTED `agora`
 *
 * `nowMs` is the request's ONE logical instant — every stamp the sender writes
 * is it, and tests pin it. Measuring the budget as `nowMs + orçamento` would mix
 * two clock domains (step 12's trap): an injected instant in the past would
 * report the whole run `tempo-esgotado` without a single call. The elapsed
 * clock is a FUNCTION, read at the start and before each item, and this folder
 * therefore holds no clock read of its own.
 *
 * ## The retry ladder — THROWN errors only
 *
 * {@link ENVIO_PRECO_MANUAL_MAX_TENTATIVAS} attempts, {@link
 * ENVIO_PRECO_MANUAL_RETRY_DELAY_MS} apart through the injected `esperar`. Only
 * a THROW retries — a transient Shopee answer, a network or HTTP failure, a
 * token refresh held elsewhere, a Firestore blip. A classified refusal is an
 * ANSWER and is never asked twice. Three classes never retry: our own
 * misconfiguration (`ShopeeConfigError`), a conta-level guard, and a rate
 * limit — hammering a throttled conta is the one thing this must never do.
 *
 * ⚠️ A retry reads the listing through a FRESH one-id base reader
 * (`criarLeitorDeBaseEmLote(client, [itemId])`), never the request's memo. An
 * attempt that landed its `update_price` and THEN threw (a write-back blip)
 * left the memo holding the PRE-write row, and a retry judged against it would
 * send again — a wasted per-APPLICATION call, and contract S4 ("a replay of a
 * landed send is `pulado preco-igual`") broken inside one request. The fresh
 * read sees the landed price and answers `preco-igual`, which writes nothing:
 * the lost write-back stays lost until the next send that CHANGES the price
 * (rule 7, below).
 *
 * After the ladder: a guard error and a config error ABORT and propagate (the
 * route maps them); any other Shopee error becomes that item's rows `falha
 * recusa-desconhecida` with Shopee's code verbatim; anything else aborts and
 * propagates (a 500 — rule 6). Every rethrow sets the abort flag FIRST — the
 * surface's own S1 check included — which is the pool's contract: once one
 * task has thrown, no sibling that has not called Shopee yet does.
 *
 * ## Rule 7 — what a lost race costs here
 *
 * The WIRE write: the target is read at send time (above), so a concurrent
 * tabela edit reaches Shopee at its NEW value; the window left is one item's
 * read-to-wire interval, plus the accepted no-model comparand window above. The
 * LINK diagnostics the sender writes are tier (0): no field of them decides a
 * send, so a lost race leaves a stale diagnostic — stale until the next send
 * that CHANGES the price, because a `preco-igual` send writes nothing (S4). The
 * item's refusal fields are cleared by a null write, not expired by a stamp,
 * so a refusal that lands after a clean clear stays beside a newer
 * `precoEnviadoEm`: step 21's reader must show the item's refusal only while
 * `precoRecusaEm >= (precoEnviadoEm ?? 0)` — a comparison that survives this
 * race where the null-clear does not.
 *
 * ## ⚠️ THE ACCOUNTING INVARIANT
 *
 * Every requested produto leaves in exactly ONE place: either its own
 * `produtosSemEnvio` entry, or at least one listing row of the anchor it
 * resolved to — never both, never neither — and no listing names an anchor that
 * no request resolved to. A produto that vanishes under a green summary is the
 * failure this whole area is built against, so it THROWS rather than logs.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeError,
  ShopeeRateLimitError,
} from '@delfrance/integrations-shopee';
import { produtoCollection } from '@delfrance/data/admin/collections';
import { ENVIO_PRECO_RESULTADO, type EnvioPrecoResultado } from '@delfrance/schemas';

import { proximaViradaDaCotaMs } from '../anuncios/pausarAnuncio';
import { naoDocId } from '../anuncios/corpoPublicacao';
import { executarEmPool } from '../core/pool';
import { MOTIVOS_DE_PAUSA, ratePauseMin } from '../estoque/constantesEstoque';
import { estaPausada, type EstadoEstoqueLido } from '../estoque/estadoEstoque';
import {
  ENVIO_PRECO_MANUAL_MAX_TENTATIVAS,
  ENVIO_PRECO_MANUAL_RETRY_DELAY_MS,
  SHOPEE_ENVIO_PRECO_MAX_PRODUTOS,
  concorrenciaEnvioPrecoManual,
  manualDeadlineMsPreco,
} from './constantesPreco';
import { lerFamiliasDePrecoPorIds, lerPrecosDosProdutos } from './descobertaPreco';
import {
  conferirCompletudeDoItemDePreco,
  enviarPrecoDoItem,
  type ResultadoEnvioPreco,
} from './enviarPreco';
import {
  MOTIVO_PRECO_SHOPEE,
  ShopeeEnvioPrecoGuardError,
  mensagemDoMotivoDePreco,
  type MotivoPrecoShopee,
} from './errosPreco';
import { criarLeitorDeBaseEmLote, type LeitorDeBase } from './leitorDeBase';
import {
  montarItensDePreco,
  precificarItem,
  type ItemDePreco,
  type ItemPlanejadoPreco,
  type PuloDePlano,
} from './planoPreco';
import type { ContextoContaPreco } from './regiaoPreco';

/** Seconds to milliseconds, in one named place. */
const MS_POR_SEGUNDO = 1_000;

/** Minutes to seconds — the stock pause knob is in MINUTES. */
const SEGUNDOS_POR_MINUTO = 60;

/** The bound on a row's `codigo` — Shopee's text travels verbatim, its length is not ours to trust. */
const MAX_CODIGO_NA_LINHA = 300;

/** The one log tag of this module. */
const TAG_LOG = '[shopee/precos] envio manual';

/* -------------------------------------------------------------------------- */
/*                                 the envelope                                */
/* -------------------------------------------------------------------------- */

/**
 * FOUR outcomes, never five — and the SAME four as the job's report rows: the
 * type IS the shared report enum's, so an envelope row and a report row cannot
 * disagree about what outcomes exist. A partial send is `falha` +
 * `envio-parcial`, never a fifth member the web dialog would have to learn.
 */
export type EnvioPrecoOutcome = EnvioPrecoResultado;

/**
 * One MODEL's row (one row for a no-model listing). On Shopee each model
 * carries its own child's tabela price, so a listing-level `preco` could not
 * hold them — and the job's report rows are per model too, so the envelope and
 * the report share one grain.
 */
export interface EnvioPrecoListing {
  /** The family ANCHOR, always — never the requested child (see the accounting). */
  readonly produtoId: string;
  /** The anchor's name. */
  readonly produtoNome: string | null;
  /** The CHILD whose price this model carries; `null` for a no-model listing or a listing-level line. */
  readonly variacaoProdutoId: string | null;
  /** `String(item_id)`, or `null` when the listing never had one. */
  readonly anuncioId: string | null;
  /** The `prodshopee` document id. */
  readonly linkDocId: string | null;
  readonly outcome: EnvioPrecoOutcome;
  /** A `MotivoPrecoShopee` slug; `null` only on a clean `enviado`. */
  readonly motivo: MotivoPrecoShopee | null;
  /** RENDERED pt-BR through `mensagemDoMotivoDePreco`, always. Never a slug, never provider prose. */
  readonly mensagem: string;
  /** What was SENT — `null` unless `outcome === 'enviado'`. */
  readonly preco: number | null;
  /** Shopee's shelf price as the fresh read saw it, when it was read. */
  readonly precoAnterior: number | null;
  /** Permanently `null`: the rows are already one per model. The key stays for the ML-shaped web provider. */
  readonly variacoes: null;
  /** Shopee's code / `failed_reason` VERBATIM (≤ 300) — the ONE key beyond Mercado Livre's row. */
  readonly codigo: string | null;
}

/** A requested produto that produced no listing row at all, and why. */
export interface EnvioPrecoSemEnvio {
  /** The REQUESTED id, verbatim — a child stays a child here. */
  readonly produtoId: string;
  readonly produtoNome: string | null;
  readonly motivo: MotivoPrecoShopee;
  readonly mensagem: string;
}

export interface EnvioPrecoResponse {
  readonly canal: 'shopee';
  readonly integracaoId: string;
  readonly contaNome: string | null;
  /** The DEDUPED request size. */
  readonly solicitados: number;
  /** Distinct family anchors the discovery returned. */
  readonly familias: number;
  /** Counts ROWS (models), per outcome. */
  readonly resumo: {
    readonly enviados: number;
    readonly pulados: number;
    readonly falhas: number;
    readonly naoTentados: number;
  };
  readonly listings: readonly EnvioPrecoListing[];
  readonly produtosSemEnvio: readonly EnvioPrecoSemEnvio[];
  /** ISO-8601 — set when a quota pause stopped the run; the rest was not attempted. */
  readonly pausadoAte: string | null;
}

/**
 * The key sets, declared as DATA — FOUR levels. The route builds its body BY
 * NAME at every level and the tests compare `Object.keys().sort()` against
 * these, so a key added upstream cannot leave the building unannounced (the
 * per-model row is the level that carries Shopee's own words in `codigo`).
 */
export const CHAVES_DO_ENVELOPE_PRECO = [
  'canal',
  'integracaoId',
  'contaNome',
  'solicitados',
  'familias',
  'resumo',
  'listings',
  'produtosSemEnvio',
  'pausadoAte',
] as const;

export const CHAVES_DO_RESUMO_PRECO = ['enviados', 'pulados', 'falhas', 'naoTentados'] as const;

export const CHAVES_DA_LISTAGEM_PRECO = [
  'produtoId',
  'produtoNome',
  'variacaoProdutoId',
  'anuncioId',
  'linkDocId',
  'outcome',
  'motivo',
  'mensagem',
  'preco',
  'precoAnterior',
  'variacoes',
  'codigo',
] as const;

export const CHAVES_SEM_ENVIO_PRECO = ['produtoId', 'produtoNome', 'motivo', 'mensagem'] as const;

/* -------------------------------------------------------------------------- */
/*                               args and deps                                 */
/* -------------------------------------------------------------------------- */

export interface ArgsEnvioPrecoManual {
  readonly integracaoId: string;
  /** Anchors or children, in the operator's order; deduplicated here too. */
  readonly produtoIds: readonly string[];
  /** `true` ⇒ the decrease guard is OFF (the operator authorised a lower price). */
  readonly baixarPreco: boolean;
}

export interface DepsEnvioPrecoManual {
  /** MILLISECONDS — the request's ONE logical instant, injected. Every stamp the sender writes is it. */
  readonly nowMs: number;
  /** The ELAPSED clock, read at the start and before each item. Never confused with {@link nowMs}. */
  readonly agora: () => number;
  /** The wait between ladder attempts. Injected so this folder holds no timer. */
  readonly esperar: (ms: number) => Promise<void>;
  /** The conta that PASSED `avaliarContaParaPreco` — its client, currency, ratio and tabela. */
  readonly contexto: ContextoContaPreco;
  readonly contaNome: string | null;
  /** Injectable so tests never need the real subcollection reads. */
  readonly lerFamilias?: typeof lerFamiliasDePrecoPorIds;
  /** The SEND-time `precos` read. Injectable so a test can move a tabela between the plan and the send. */
  readonly lerPrecos?: typeof lerPrecosDosProdutos;
  /** Injectable so tests never need the real sender. */
  readonly enviar?: typeof enviarPrecoDoItem;
}

/* -------------------------------------------------------------------------- */
/*                        the quota pause the route reads                      */
/* -------------------------------------------------------------------------- */

/**
 * The instant the conta's QUOTA pause ends, when one is active — else `null`.
 *
 * Price READS the stock sync's pause and never writes it (reconcile C-l): the
 * per-APPLICATION rate limit is one limiter for both syncs. But only the two
 * QUOTA motives are a price pause — a holiday or a blocked-shop stock pause is a
 * stock refusal, and a price push against that shop is still legitimate.
 *
 * ⚠️ A pause with NO motive stored is not a price pause either: the stock
 * writers always stamp one, so a bare `pausadoAte` is a document this reader
 * does not understand, and refusing an operator on it would be a guess.
 */
export function pausaDeCotaParaPreco(estado: EstadoEstoqueLido, nowMs: number): number | null {
  const motivo = estado.pausaMotivo;
  const deCota = motivo === MOTIVOS_DE_PAUSA.burst || motivo === MOTIVOS_DE_PAUSA.cotaDiaria;
  // `estaPausada` is the stock sync's own "still paused" rule, imported rather
  // than re-spelled, so the two surfaces cannot disagree about the edge instant.
  if (!deCota || !estaPausada(estado, nowMs)) return null;
  return estado.pausadoAte;
}

/* -------------------------------------------------------------------------- */
/*                                  the rows                                   */
/* -------------------------------------------------------------------------- */

/** The row-carrying outcomes of the sender. */
type ResultadoComLinhas = Extract<
  ResultadoEnvioPreco,
  { readonly tipo: 'enviado' | 'pulado' | 'falha' }
>;

/** A code, verbatim, bounded. */
function codigoCurto(codigo: string | null): string | null {
  return codigo === null ? null : codigo.slice(0, MAX_CODIGO_NA_LINHA);
}

/**
 * One sender result → one envelope row per model line, in the line order.
 * Pure, exported and table-tested.
 *
 * The outcome is the line's own `resultado`; `preco` is the target only on an
 * `enviado` line (what was SENT); `mensagem` is rendered at this instant
 * through the ONE renderer, so an `enviado` line reads the clean sentence.
 */
export function paraListagensDePreco(
  item: ItemDePreco,
  r: ResultadoComLinhas,
  produtoNome: string | null,
): EnvioPrecoListing[] {
  return r.modelos.map((linha) => ({
    produtoId: item.produtoId,
    produtoNome,
    variacaoProdutoId: linha.produtoId === item.produtoId ? null : linha.produtoId,
    anuncioId: String(item.itemId),
    linkDocId: item.linkDocId,
    outcome: linha.resultado,
    motivo: linha.motivo,
    mensagem: mensagemDoMotivoDePreco(linha.motivo),
    preco: linha.resultado === ENVIO_PRECO_RESULTADO.enviado ? linha.precoAlvo : null,
    precoAnterior: linha.precoAnterior,
    variacoes: null,
    codigo: codigoCurto(linha.codigo),
  }));
}

/**
 * Rows for an item the sender did NOT answer with rows — not attempted (the
 * deadline, an abort) or failed by a throw. One per alvo, so the row set of an
 * item never depends on how it ended.
 */
function linhasDoItem(
  item: ItemDePreco,
  produtoNome: string | null,
  outcome: EnvioPrecoOutcome,
  motivo: MotivoPrecoShopee,
  codigo: string | null,
): EnvioPrecoListing[] {
  return item.alvos.map((alvo) => ({
    produtoId: item.produtoId,
    produtoNome,
    variacaoProdutoId: alvo.produtoId === item.produtoId ? null : alvo.produtoId,
    anuncioId: String(item.itemId),
    linkDocId: item.linkDocId,
    outcome,
    motivo,
    mensagem: mensagemDoMotivoDePreco(motivo),
    preco: null,
    precoAnterior: null,
    variacoes: null,
    codigo: codigoCurto(codigo),
  }));
}

/**
 * A plan line → its rows: one per model when the planner had folded them
 * (`modelos-excedem-limite`), else ONE listing-level row.
 */
function linhasDoPulo(pulo: PuloDePlano, produtoNome: string | null): EnvioPrecoListing[] {
  const base = {
    produtoId: pulo.produtoId,
    produtoNome,
    anuncioId: pulo.itemId === null ? null : String(pulo.itemId),
    linkDocId: pulo.linkDocId,
    outcome: ENVIO_PRECO_RESULTADO.pulado,
    motivo: pulo.motivo,
    mensagem: mensagemDoMotivoDePreco(pulo.motivo),
    preco: null,
    precoAnterior: null,
    variacoes: null,
    codigo: null,
  } as const;
  if (pulo.modelos.length === 0) return [{ ...base, variacaoProdutoId: null }];
  return pulo.modelos.map((modelo) => ({ ...base, variacaoProdutoId: modelo.produtoId }));
}

/* -------------------------------------------------------------------------- */
/*                             the ladder and pauses                           */
/* -------------------------------------------------------------------------- */

/**
 * May a THROWN error be asked again? Everything a second attempt could change —
 * but never our own misconfiguration, a conta-level guard, or a rate limit.
 */
function podeRepetir(err: unknown): boolean {
  return !(
    err instanceof ShopeeConfigError ||
    err instanceof ShopeeEnvioPrecoGuardError ||
    err instanceof ShopeeRateLimitError
  );
}

/** A thrown value's class name, for the log — without claiming to narrow it. */
function nomeDoErro(err: unknown): string {
  return typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : typeof err;
}

/**
 * The bounded inline ladder around one item's read-price-and-send.
 * `executar` receives the attempt number (1-based), so an attempt after the
 * first can refuse the request's memoised base reader (module docblock).
 * `deveParar` is read before a retry: once a sibling aborted the run, a second
 * attempt would spend a call on a conta whose answer is already decided, so the
 * last error stands.
 */
async function enviarComLadder<T>(
  itemId: number,
  executar: (tentativa: number) => Promise<T>,
  esperar: (ms: number) => Promise<void>,
  deveParar: () => boolean,
): Promise<T> {
  for (let tentativa = 1; ; tentativa += 1) {
    try {
      return await executar(tentativa);
    } catch (err) {
      const ultima = tentativa >= ENVIO_PRECO_MANUAL_MAX_TENTATIVAS;
      if (ultima || !podeRepetir(err) || deveParar()) throw err;
      console.warn(`${TAG_LOG}: tentativa ${String(tentativa)} lançou; repetindo`, {
        itemId,
        erro: nomeDoErro(err),
      });
      await esperar(ENVIO_PRECO_MANUAL_RETRY_DELAY_MS);
    }
  }
}

/** Where a pause says the conta re-opens, in MILLISECONDS (reconcile D-13). */
function fimDaPausa(
  r: Extract<ResultadoEnvioPreco, { readonly tipo: 'pausa' }>,
  nowMs: number,
): number {
  if (r.pausa === MOTIVOS_DE_PAUSA.cotaDiaria) {
    // The daily quota resets at a fixed wall-clock instant, never after a header.
    return r.ate ?? proximaViradaDaCotaMs(nowMs);
  }
  // A burst: Shopee's Retry-After when it sent one, else the SAME pause the
  // stock sync applies to the same per-application limiter.
  return nowMs + (r.retryAfterSeconds ?? ratePauseMin() * SEGUNDOS_POR_MINUTO) * MS_POR_SEGUNDO;
}

/* -------------------------------------------------------------------------- */
/*                             the send-time price                             */
/* -------------------------------------------------------------------------- */

/**
 * The produtos whose `precos` price a planned item — exactly
 * `precificarItem`'s sources: the ANCHOR of a no-model listing, each model's
 * own CHILD otherwise (a model is never priced from the anchor, so the anchor
 * is not read for one).
 */
function produtosQuePrecificam(item: ItemPlanejadoPreco): string[] {
  return item.modelos.length === 0 ? [item.produtoId] : item.modelos.map((m) => m.produtoId);
}

/** No `precos` at all — every alvo prices as `null`. */
const SEM_PRECOS: ReadonlyMap<string, unknown> = new Map();

/**
 * The item's alvos with NO price — the row shape of an item that never reached
 * the sender (a deadline, an abort, a throw). Built by the SAME pure function
 * that prices a sent item, so the alvos of a row never depend on how the item
 * ended; the rows it feeds carry no price.
 */
function alvosSemPreco(item: ItemPlanejadoPreco, tabelaId: string): ItemDePreco {
  return precificarItem(item, SEM_PRECOS, tabelaId);
}

/** One attempt that reached the sender: the item as priced for THAT attempt, and its answer. */
interface EnvioDoItem {
  readonly item: ItemDePreco;
  readonly r: ResultadoEnvioPreco;
}

/* -------------------------------------------------------------------------- */
/*                           the resolution and names                          */
/* -------------------------------------------------------------------------- */

/** A stored `nome`, when it is a usable one. */
function nomeDe(dados: Record<string, unknown> | undefined): string | null {
  const nome = dados?.['nome'];
  return typeof nome === 'string' && nome.trim() !== '' ? nome : null;
}

/** A stored `paiId`, when it names a document — the same id rule the route applies to a body. */
function paiDe(dados: Record<string, unknown> | undefined): string | null {
  const pai = dados?.['paiId'];
  return naoDocId(pai) ? null : (pai as string);
}

/** One batch key read, masked — the snapshots by id, absent ids omitted. */
async function lerProdutos(
  db: Firestore,
  ids: readonly string[],
  campos: readonly string[],
): Promise<Map<string, Record<string, unknown> | undefined>> {
  const lidos = new Map<string, Record<string, unknown> | undefined>();
  if (ids.length === 0) return lidos;
  const snaps = await db.getAll(...ids.map((id) => produtoCollection.docRef(db, {}, id)), {
    fieldMask: [...campos],
  });
  for (const snap of snaps) {
    if (snap.exists) lidos.set(snap.id, snap.data() as Record<string, unknown> | undefined);
  }
  return lidos;
}

/* -------------------------------------------------------------------------- */
/*                                the accounting                               */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ THE ACCOUNTING INVARIANT (module docblock), in code. Throws a plain
 * `Error` — a violation is a defect in this module's bookkeeping, never an
 * input the operator could have sent. Exported so each clause is table-tested
 * on its own: through the run, no input can reach a violating state.
 *
 * `anchorDe` maps each requested id that EXISTS to the anchor it resolved to;
 * a requested id absent from it can only be covered by its own
 * `produtosSemEnvio` entry.
 */
export function conferirContabilidadeDePreco(
  solicitados: readonly string[],
  anchorDe: ReadonlyMap<string, string>,
  listings: readonly EnvioPrecoListing[],
  semEnvio: readonly EnvioPrecoSemEnvio[],
): void {
  const pedidos = new Set(solicitados);
  const anchorsDeLinhas = new Set(listings.map((l) => l.produtoId));
  const anchorsPedidos = new Set<string>();
  for (const id of solicitados) {
    const anchor = anchorDe.get(id);
    if (anchor !== undefined) anchorsPedidos.add(anchor);
  }

  const semEnvioIds = new Set<string>();
  for (const s of semEnvio) {
    if (!pedidos.has(s.produtoId)) {
      throw new Error(
        `${TAG_LOG}: ${s.produtoId} não foi solicitado e aparece em produtosSemEnvio`,
      );
    }
    if (semEnvioIds.has(s.produtoId)) {
      throw new Error(`${TAG_LOG}: ${s.produtoId} aparece DUAS vezes em produtosSemEnvio`);
    }
    semEnvioIds.add(s.produtoId);
  }

  for (const anchor of anchorsDeLinhas) {
    if (!anchorsPedidos.has(anchor)) {
      throw new Error(
        `${TAG_LOG}: a âncora ${anchor} aparece nas linhas e nenhum pedido resolve nela`,
      );
    }
  }

  for (const id of solicitados) {
    const anchor = anchorDe.get(id);
    const nasLinhas = anchor !== undefined && anchorsDeLinhas.has(anchor);
    const semLinha = semEnvioIds.has(id);
    if (nasLinhas && semLinha) {
      throw new Error(`${TAG_LOG}: ${id} aparece nas DUAS listas — contabilidade quebrada`);
    }
    if (!nasLinhas && !semLinha) {
      throw new Error(`${TAG_LOG}: ${id} foi solicitado e não aparece em nenhuma lista`);
    }
  }
}

function montarResposta(
  integracaoId: string,
  contaNome: string | null,
  solicitados: number,
  familias: number,
  listings: readonly EnvioPrecoListing[],
  produtosSemEnvio: readonly EnvioPrecoSemEnvio[],
  pausadoAteMs: number | null,
): EnvioPrecoResponse {
  const contar = (o: EnvioPrecoOutcome): number => listings.filter((l) => l.outcome === o).length;
  return {
    canal: 'shopee',
    integracaoId,
    contaNome,
    solicitados,
    familias,
    resumo: {
      enviados: contar(ENVIO_PRECO_RESULTADO.enviado),
      pulados: contar(ENVIO_PRECO_RESULTADO.pulado),
      falhas: contar(ENVIO_PRECO_RESULTADO.falha),
      naoTentados: contar(ENVIO_PRECO_RESULTADO.naoTentado),
    },
    listings,
    produtosSemEnvio,
    pausadoAte: pausadoAteMs === null ? null : new Date(pausadoAteMs).toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/*                                   the run                                   */
/* -------------------------------------------------------------------------- */

/**
 * One planned unit, in the envelope's order: rows already final, or an item to
 * price and send — IDENTITIES only; its price is read in its pool task.
 */
type Entrada =
  | { readonly tipo: 'linhas'; readonly linhas: readonly EnvioPrecoListing[] }
  | {
      readonly tipo: 'item';
      readonly item: ItemPlanejadoPreco;
      readonly produtoNome: string | null;
    };

/**
 * **The manual price push.** See the module docblock for the shape; the steps
 * are: dedupe → read the requested produtos (name + `paiId`) → resolve each to
 * its anchor → discover the families → plan (identities) → ONE batched base
 * reader → the pool (deadline, then per item: read its `precos`, price it,
 * send it, through the ladder; aborts) → the accounting → the envelope.
 *
 * @throws ShopeeConfigError over {@link SHOPEE_ENVIO_PRECO_MAX_PRODUTOS} (the
 *   route refuses first, with the numbers) or on a context of another conta.
 */
export async function enviarPrecoManualShopee(
  db: Firestore,
  args: ArgsEnvioPrecoManual,
  deps: DepsEnvioPrecoManual,
): Promise<EnvioPrecoResponse> {
  const lerFamilias = deps.lerFamilias ?? lerFamiliasDePrecoPorIds;
  const lerPrecos = deps.lerPrecos ?? lerPrecosDosProdutos;
  const enviar = deps.enviar ?? enviarPrecoDoItem;
  const tabelaId = deps.contexto.tabelaNormalId;

  const solicitados = [...new Set(args.produtoIds)];
  // ⚠️ Asserted, not enforced: the route refuses an oversize selection first,
  // with the limit and the count — this class maps to a 500.
  if (solicitados.length > SHOPEE_ENVIO_PRECO_MAX_PRODUTOS) {
    throw new ShopeeConfigError(
      `envio manual de preço: ${String(solicitados.length)} produtos excedem o limite de ${String(
        SHOPEE_ENVIO_PRECO_MAX_PRODUTOS,
      )}`,
    );
  }
  // A context of another conta would price THIS conta's listings through the
  // other one's client and tabela — a caller bug, refused before any read.
  if (deps.contexto.integracaoId !== args.integracaoId) {
    throw new ShopeeConfigError(
      'envio manual de preço: o contexto da conta não é o da integração pedida.',
    );
  }

  if (solicitados.length === 0) {
    return montarResposta(args.integracaoId, deps.contaNome, 0, 0, [], [], null);
  }

  // --- the requested produtos: existence, name, and the anchor each resolves to.
  const pedidos = await lerProdutos(db, solicitados, ['nome', 'paiId']);
  const semEnvioPorId = new Map<string, EnvioPrecoSemEnvio>();
  const semEnvio = (id: string, motivo: MotivoPrecoShopee): void => {
    semEnvioPorId.set(id, {
      produtoId: id,
      produtoNome: nomeDe(pedidos.get(id)),
      motivo,
      mensagem: mensagemDoMotivoDePreco(motivo),
    });
  };

  // Anchors DEDUPLICATED after resolution, in first-seen request order: a child
  // and its own anchor in one request are one family.
  const anchorDe = new Map<string, string>();
  const anchors: string[] = [];
  for (const id of solicitados) {
    if (!pedidos.has(id)) {
      semEnvio(id, MOTIVO_PRECO_SHOPEE.produtoNaoEncontrado);
      continue;
    }
    const anchor = paiDe(pedidos.get(id)) ?? id;
    anchorDe.set(id, anchor);
    if (!anchors.includes(anchor)) anchors.push(anchor);
  }

  // The anchor's name for its rows — read only for anchors nobody requested.
  const nomesDeAnchors = await lerProdutos(
    db,
    anchors.filter((a) => !pedidos.has(a)),
    ['nome'],
  );
  const nomeDoAnchor = (anchor: string): string | null =>
    nomeDe(pedidos.get(anchor) ?? nomesDeAnchors.get(anchor));

  const familias = await lerFamilias(db, { anchorIds: anchors });
  const pedidosDoAnchor = (anchor: string): string[] =>
    solicitados.filter((id) => anchorDe.get(id) === anchor);

  // --- the plan, in REQUEST order, so the rows come back in the operator's order
  // however the pool interleaves the sends. IDENTITIES only: the family's own
  // `precos` price nothing here — each item is priced in its pool task.
  const entradas: Entrada[] = [];
  for (const anchor of anchors) {
    const familia = familias.get(anchor);
    if (familia === undefined) {
      // The requested child exists but its anchor does not (or the anchor
      // vanished between the two reads) — one word for "no such produto".
      for (const id of pedidosDoAnchor(anchor)) {
        semEnvio(id, MOTIVO_PRECO_SHOPEE.produtoNaoEncontrado);
      }
      continue;
    }

    const plano = montarItensDePreco(familia, args.integracaoId);
    const semListagem =
      plano.itens.length === 0 &&
      plano.pulos.length > 0 &&
      plano.pulos.every((p) => p.motivo === MOTIVO_PRECO_SHOPEE.semLink);
    if (semListagem) {
      // No listing of this conta at all: the whole family's verdict, per
      // requested id — the planner's motivo, never re-derived here.
      for (const id of pedidosDoAnchor(anchor)) semEnvio(id, MOTIVO_PRECO_SHOPEE.semLink);
      continue;
    }

    const nome = nomeDoAnchor(anchor);
    for (const pulo of plano.pulos)
      entradas.push({ tipo: 'linhas', linhas: linhasDoPulo(pulo, nome) });
    for (const planejado of plano.itens) {
      entradas.push({ tipo: 'item', item: planejado, produtoNome: nome });
    }
  }

  // --- ONE batched base reader over every planned item (lazy: no call yet).
  const itens = entradas.flatMap((e) => (e.tipo === 'item' ? [e.item] : []));
  const lerBase = criarLeitorDeBaseEmLote(
    deps.contexto.client,
    itens.map((i) => i.itemId),
  );

  // --- the pool.
  const resolvidas: (readonly EnvioPrecoListing[] | null)[] = entradas.map((e) =>
    e.tipo === 'linhas' ? e.linhas : null,
  );
  const paraEnviar = entradas.flatMap((e, indice) =>
    e.tipo === 'item' ? [{ item: e.item, produtoNome: e.produtoNome, indice }] : [],
  );
  // ⚠️ ELAPSED wall clock, from HERE, through the injected reader.
  const inicioMs = deps.agora();
  const orcamentoMs = manualDeadlineMsPreco();
  let motivoDoAborto: MotivoPrecoShopee | null = null;
  let lancou = false;
  let pausadoAteMs: number | null = null;

  /**
   * One attempt: read the item's `precos` NOW, price it, and send it (the
   * module docblock's C-d rule). `null` = the run was aborted while a FIRST
   * attempt's read was in flight, so no Shopee call was made for this item.
   * An attempt after the first reads the listing through a FRESH one-id base
   * reader, never the request's memo (S4 inside the ladder).
   */
  const lerPrecificarEnviar = async (
    planejado: ItemPlanejadoPreco,
    tentativa: number,
  ): Promise<EnvioDoItem | null> => {
    const precos = await lerPrecos(db, produtosQuePrecificam(planejado));
    if (tentativa === 1 && (lancou || motivoDoAborto !== null)) return null;
    const item = precificarItem(planejado, precos, tabelaId);
    const leitor: LeitorDeBase =
      tentativa === 1 ? lerBase : criarLeitorDeBaseEmLote(deps.contexto.client, [planejado.itemId]);
    const r = await enviar(item, {
      db,
      conta: deps.contexto,
      nowMs: deps.nowMs,
      baixarPreco: args.baixarPreco,
      lerBase: leitor,
    });
    return { item, r };
  };

  await executarEmPool(paraEnviar, concorrenciaEnvioPrecoManual(), async (entrada) => {
    const { item: planejado, produtoNome, indice } = entrada;
    // A sibling threw: the response is already lost, spend nothing more.
    if (lancou) return;

    // Rows for this item when the sender produced none — not attempted, a
    // pause, a fatal, a thrown Shopee error: one per alvo, no price.
    const linhasSemRemetente = (
      outcome: EnvioPrecoOutcome,
      motivo: MotivoPrecoShopee,
      codigo: string | null,
    ): void => {
      resolvidas[indice] = linhasDoItem(
        alvosSemPreco(planejado, tabelaId),
        produtoNome,
        outcome,
        motivo,
        codigo,
      );
    };

    if (motivoDoAborto !== null) {
      linhasSemRemetente(ENVIO_PRECO_RESULTADO.naoTentado, motivoDoAborto, null);
      return;
    }
    if (deps.agora() - inicioMs > orcamentoMs) {
      linhasSemRemetente(ENVIO_PRECO_RESULTADO.naoTentado, MOTIVO_PRECO_SHOPEE.tempoEsgotado, null);
      return;
    }

    let envio: EnvioDoItem | null;
    try {
      envio = await enviarComLadder(
        planejado.itemId,
        (tentativa) => lerPrecificarEnviar(planejado, tentativa),
        deps.esperar,
        () => lancou || motivoDoAborto !== null,
      );
      // S1 again, at the surface: an injected or future sender that dropped a
      // row would otherwise make a model vanish from the envelope. ⚠️ INSIDE the
      // try, so a violation sets the abort flag like every other rethrow — out
      // here it let every sibling keep sending into a request that 500s.
      if (envio !== null && envio.r.tipo !== 'pausa' && envio.r.tipo !== 'fatal') {
        conferirCompletudeDoItemDePreco(envio.item, envio.r.modelos);
      }
    } catch (err) {
      // ⚠️ The guard class FIRST (reconcile D-6): it extends the package's base,
      // and the generic arm below would turn a conta-level refusal into one
      // `falha` row per item.
      if (err instanceof ShopeeEnvioPrecoGuardError || err instanceof ShopeeConfigError) {
        lancou = true;
        throw err;
      }
      if (err instanceof ShopeeError) {
        linhasSemRemetente(
          ENVIO_PRECO_RESULTADO.falha,
          MOTIVO_PRECO_SHOPEE.recusaDesconhecida,
          err instanceof ShopeeApiError ? err.code : null,
        );
        return;
      }
      lancou = true;
      throw err;
    }

    if (envio === null) {
      // Aborted during the price read: not attempted, like every item that had
      // not started. (A sibling's THROW leaves no row — the response is lost.)
      if (motivoDoAborto !== null)
        linhasSemRemetente(ENVIO_PRECO_RESULTADO.naoTentado, motivoDoAborto, null);
      return;
    }

    const { item, r } = envio;
    if (r.tipo === 'pausa') {
      motivoDoAborto ??= MOTIVO_PRECO_SHOPEE.contaPausada;
      const fim = fimDaPausa(r, deps.nowMs);
      pausadoAteMs = pausadoAteMs === null ? fim : Math.max(pausadoAteMs, fim);
      linhasSemRemetente(
        ENVIO_PRECO_RESULTADO.naoTentado,
        MOTIVO_PRECO_SHOPEE.contaPausada,
        r.codigo,
      );
      return;
    }
    if (r.tipo === 'fatal') {
      motivoDoAborto ??= r.motivo;
      // The class and message go to the LOG only — never into a row, whose
      // `codigo` is Shopee's own code and nothing else.
      console.warn(`${TAG_LOG}: a conta encerrou o envio (${r.motivo})`, {
        integracaoId: args.integracaoId,
        itemId: item.itemId,
        erro: r.erro,
      });
      linhasSemRemetente(ENVIO_PRECO_RESULTADO.naoTentado, r.motivo, null);
      return;
    }

    resolvidas[indice] = paraListagensDePreco(item, r, produtoNome);
  });

  const listings = resolvidas.flatMap((linhas) => linhas ?? []);
  const produtosSemEnvio = solicitados.flatMap((id) => {
    const s = semEnvioPorId.get(id);
    return s === undefined ? [] : [s];
  });

  conferirContabilidadeDePreco(solicitados, anchorDe, listings, produtosSemEnvio);

  return montarResposta(
    args.integracaoId,
    deps.contaNome,
    solicitados.length,
    familias.size,
    listings,
    produtosSemEnvio,
    pausadoAteMs,
  );
}
