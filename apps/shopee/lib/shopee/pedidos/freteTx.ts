/**
 * The ONE Firestore write of Shopee shipment tracking (#1515, step 7) — a merge
 * over an existing `freteInicial`, never a create, in a single
 * `db.runTransaction`. Class **B**; the inventory entry is in
 * `packages/config-eslint/rules/firestore-transaction-inventory.test.js`.
 *
 * ## Why its OWN transaction, and not `orderPedidoTx.ts`'s `dados` group
 *
 * `freteInicial` already lives in that group (`orderMapping.ts`,
 * `orderPedidoTx.ts`) — and that group is FROZEN while
 * `hasUserInteraction === true`, so one operator save would permanently blind
 * the tracking feed of the pedido it was meant to correct. A code-4/30/47
 * delivery also has no `get_order_detail` payload to build a
 * `PedidoMapeadoShopee` from, and `mesmoFrete` would have to grow an eighth
 * field in two more places. Three independent reasons, one conclusion.
 *
 * ## The race class — **B**, and the honest reason
 *
 * The per-package OBSERVATIONS are built OUTSIDE the callback and re-applied
 * verbatim on an OCC retry. It is B rather than C because the Shopee call
 * (`v2.order.get_package_detail`) closes BEFORE the transaction opens, so the
 * widest window is one Firestore round trip.
 *
 * The named guard, ADR 0011 tier 2, **per package**, in **microseconds**:
 *
 *  - re-read the pedido with the callback's own `tx.get` (RAW, deliberately not
 *    `parseRead` — its soft parse returns the raw object anyway and would warn
 *    on every legacy pedido this handler walks);
 *  - compare each package's stored `pacotes[].atualizadoEm` against the
 *    observation's clock;
 *  - DROP that package's observation when the stored stamp is strictly newer,
 *    and the whole delivery with the named outcome `ignorado-obsoleto` when a
 *    row was dropped and the rebuild is content-identical;
 *  - re-derive EVERY written value from that snapshot: each package's ERP estado
 *    from the STORED raw token through the channel's table, the fold over the
 *    MERGED diary, and the block estado through `estadoFreteShopeeAplicavel`.
 *
 * ⚠️ **This module is µs SITE 7, and the unit IS the guard.**
 * `get_package_detail.update_time` ("the last time that there was a change in
 * value of package") and `ship_by_date` are wire SECONDS, and they cross into
 * microseconds HERE — once each, by CALLING site 3 (`microsDeSegundosShopee`).
 * Never by `coerceToMicros`, which classifies by magnitude and reads `1.66e9` as
 * MILLISECONDS — 1970, and a comparison that answers "older" for ever. The
 * STORED side is the opposite: `coerceToMicros` is exactly right there, because
 * the legacy corpus holds ms ints and ISO strings, and it reaches the diary's
 * two stamps through `pacoteFreteSchema`'s own tolerant preprocess.
 *
 * ⚠️ **`lastMarketplaceUpdate` is deliberately NOT a guard here.** It is the
 * ORDER clock and step 5's alone; comparing a package event against it is the
 * cross-clock failure ADR 0011 names. This transaction neither reads it as a
 * gate nor writes it.
 *
 * ⚠️ **`atualizadoEm` advances only on a WIRE-content change** — never merely
 * because we looked, and never on a change to the DERIVED `estado`. Without that
 * rule the code-3 backstop re-stamps every row on every order import and files a
 * `historicoDeModificacoes` row per import, for ever. Same discipline as
 * `pagamentoTx.ts`'s `marketplace.atualizadoEm` and `liquidarPagamento.ts`'s
 * excluded `liquidacao.liquidadoEmUs`. The rule itself lives in
 * `freteShopeeMapping.ts`; this module only has to not defeat it.
 *
 * ⚠️ **`freteInicial` is ONE top-level key** and `tx.update` masks at top-level
 * keys, so this writer and `orderPedidoTx.ts` can NEVER own disjoint masks of
 * it. They share a merge policy instead: step 5 refreshes exactly
 * `CAMPOS_FRETE_ATUALIZAVEIS_SHOPEE` through a spread of the stored block, this
 * one touches exactly `estado`, `codRastreio`, `prazoDespacho`,
 * `externalOptionId` and `pacotes`, and the single field in both
 * (`externalOptionId`) is `mapeado ?? existente`. An interleaving is an OCC
 * abort and retry, never a lost update.
 *
 * ⚠️ It writes NO `freteInicial.ultimaModificacao` (step 5's ORDER watermark —
 * rewriting it would ping-pong with `mesmoFrete` and file one
 * `historicoDeModificacoes` row per delivery). The SHIPMENT clock lives in
 * `pacotes[].atualizadoEm`. This is where step 7 diverges from Mercado Livre's
 * shipment import, and the divergence is forced: there, the shipment import is
 * the only writer of that field; here, step 5 already owns it. ⚠️ The stored
 * value is CARRIED by the `{ ...armazenado }` spread and must be — omitting it
 * from a whole-map rebuild ERASES it — so "never written" means never ASSIGNED,
 * and a test pins that the value in the patch is the stored one.
 *
 * ⚠️ It appends NO `historicoFtIni` row. The `onPedidoChanged` trigger derives
 * that trail from the `freteInicial.estado` this transaction writes, comparing
 * the NESTED estado only — so a delivery that refreshes the diary without moving
 * the estado appends nothing, by design. Call-site appends were rejected in
 * PR #720.
 *
 * ⚠️ This module moves NO stock directly. `onPedidoEstoqueSync` owns that and
 * reacts to the `estado` this transaction writes.
 *
 * ⚠️ Nothing is ever DELETED. A package row the latest call did not name keeps
 * its stored state: Shopee splits ONE order into N packages
 * (`get_order_detail.package_list[]`, and `get_package_detail.is_split_up` /
 * `can_split_order`), so a number disappearing from one list is not evidence the
 * parcel stopped existing. (The caps row says the OTHER direction —
 * `consolidaPacote: 'nao'` means several orders are never consolidated into one
 * parcel here — which is why a package number is the only identity a row has.)
 * The ONE exception is forced and is not a decision of this module: a
 * stored row that does not parse at all is read as `null` by the per-ELEMENT
 * tolerant parse and cannot be re-serialised, because the block's own schema
 * validates every row on the way back in.
 *
 * ⚠️ Both guards and the patch live in ONE pure function, {@link preverFreteShopee},
 * which the callback runs on its own `tx.get` snapshot and `rastrear:pedido
 * --dry-run` runs on a plain read — so the rehearsal prints the exact bytes a
 * live tick writes. A rehearsal that disagreed with production would be worse
 * than none.
 */
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import { coerceToMicros } from '@delfrance/core/datetime';
import { pedidoCollection } from '@delfrance/data/admin/collections';
import {
  estadoFreteSchema,
  pacoteFreteSchema,
  type EstadoFrete,
  type PacoteFrete,
} from '@delfrance/schemas';

import type { PacoteObservadoShopee } from './fretePushShopee';
import {
  MOTIVO_FRETE_SHOPEE,
  dobrarPacotesShopee,
  estadoFreteShopeeAplicavel,
  mesclarPacotesShopee,
  type MotivoFreteShopee,
  type ObservacaoPacoteUs,
  type VereditoFreteShopee,
} from './freteShopeeMapping';
import { maiorUs, microsDeSegundosShopee } from './orderMapping';

/* -------------------------------------------------------------------------- */
/*                                  contract                                   */
/* -------------------------------------------------------------------------- */

/** What one tracking delivery did. */
export type AcaoFreteShopee =
  | 'atualizado'
  | 'ignorado-sem-mudanca'
  | 'ignorado-obsoleto'
  | 'ignorado-sem-pedido'
  | 'ignorado-sem-frete-inicial'
  | 'ignorado-desconhecido';

/** The two top-level pedido keys this transaction may write. Nothing else. */
export interface PatchFreteShopee {
  /** The WHOLE map, rebuilt from the tx-fresh stored block. */
  readonly freteInicial: Record<string, unknown>;
  /** µs, monotone. */
  readonly ultimaModificacao: number;
}

/** Everything the caller's ONE log line may need — counts, ids and tokens. */
export interface DiagnosticosFreteShopee {
  /** Rows in the merged diary. */
  readonly pacotes: number;
  /** Rows this delivery carried. */
  readonly observados: number;
  /** Package numbers whose observation the freshness gate dropped. */
  readonly obsoletos: readonly string[];
  /** Distinct raw tokens the channel's table does not map. */
  readonly tokensDesconhecidos: readonly string[];
  /** Distinct raw tokens that belong to reverse logistics (step 17). */
  readonly tokensDeRetorno: readonly string[];
  readonly estadoAlvo: EstadoFrete | null;
  readonly motivoEstado: MotivoFreteShopee | null;
  readonly estadoRessuscitado: boolean;
  readonly canaisDivergentes: boolean;
  readonly codRastreioTruncado: boolean;
  /**
   * The fold REFUSED an estado because some package has none — an unmapped
   * token, a return-only one, or a row carrying no token at all.
   *
   * ⚠️ Without it the one log line cannot tell the two `estadoAlvo: null` cases
   * apart: "this delivery understood nothing" and "one package of N is
   * unreadable, so the readable ones were not allowed to answer". Paired with
   * {@link DiagnosticosFreteShopee.tokensDesconhecidos} /
   * {@link DiagnosticosFreteShopee.tokensDeRetorno} it names the cause; `true`
   * with both lists empty means a package carried no status at all.
   */
  readonly estadoBloqueadoPorPacoteSemEstado: boolean;
}

/**
 * What {@link preverFreteShopee} decided about ONE stored pedido.
 *
 * ⚠️ It carries the PATCH itself, not a description of it — so the rehearsal
 * CLI's dry run prints exactly the bytes a live tick writes rather than a second
 * implementation's opinion of them (`PrevisaoLiquidacaoShopee`, step 6).
 */
export interface PrevisaoFreteShopee {
  readonly acao: AcaoFreteShopee;
  /** `null` on every zero-write outcome. */
  readonly patch: PatchFreteShopee | null;
  /** Dotted names of the fields that differed — `[]` on every ignored outcome. */
  readonly campos: readonly string[];
  readonly diagnosticos: DiagnosticosFreteShopee;
}

export interface PreverFreteShopeeArgs {
  readonly orderSn: string;
  readonly observados: readonly PacoteObservadoShopee[];
  /**
   * The ORDER clock in µs, used as the package clock ONLY when an observation
   * carries none (the code-3 backstop). `null` on the push path.
   */
  readonly relogioDaOrdemUs: number | null;
  /**
   * What `prazoDespachoShopee` computed for this order; the fold's fallback when
   * NO package carries a deadline. `null` on the push path.
   */
  readonly prazoDaOrdemUs: number | null;
  /** The task's ONE clock read, µs. Never a clock read in here. */
  readonly nowUs: number;
}

export interface SalvarFreteShopeeArgs extends PreverFreteShopeeArgs {
  /** `makePedidoIdShopee(contaId, orderSn)`, computed by the caller. */
  readonly pedidoId: string;
}

export interface ResultadoFreteShopee {
  readonly pedidoId: string;
  readonly acao: AcaoFreteShopee;
  readonly campos: readonly string[];
  /** The estado actually written, or `null` when the verdict refused it. */
  readonly estadoEscrito: EstadoFrete | null;
  /** Why it refused, or `null` when it wrote. */
  readonly motivoEstado: MotivoFreteShopee | null;
  readonly estadoRessuscitado: boolean;
  /** Rows in the merged diary. */
  readonly pacotes: number;
  readonly tokensDesconhecidos: readonly string[];
}

/* -------------------------------------------------------------------------- */
/*                                 raw readers                                 */
/* -------------------------------------------------------------------------- */

function objetoDe(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * The stored diary, read with a per-ELEMENT tolerance.
 *
 * ⚠️ `nullable().catch(null)` per ROW, never per FIELD: one corrupt legacy row
 * must not block the write for the other packages, and a per-field catch would
 * manufacture a row with a `null` identity. `null` is a sentinel no real row can
 * be. The outer `.catch` covers a `pacotes` that is not an array at all (and the
 * ordinary case of a block that has no such key — the field is `.optional()`).
 * Same shape as `shopeeEscrowListPayloadSchema`'s per-element tolerance.
 */
const DIARIO_ARMAZENADO_SHOPEE = z.array(pacoteFreteSchema.nullable().catch(null)).catch(() => []);

function diarioArmazenadoShopee(valor: unknown): PacoteFrete[] {
  return DIARIO_ARMAZENADO_SHOPEE.parse(valor).filter(
    (linha): linha is PacoteFrete => linha != null,
  );
}

/**
 * The stored block estado, or `null` when it is absent or not a member.
 *
 * ⚠️ `null` and not `ESTADO_FRETE.desconhecido`: that value is a REAL member with
 * its own meaning (`ESTADOS_FRETE_IGNORAR_REMOCAO` names it), so returning it for
 * an illegible document would invent a fact the document does not carry. Today
 * the two readings behave identically — `desconhecido` sits outside the ladder
 * and outside every guard set — which is why only a UNIT assertion separates
 * them, and why `freteTx.test.ts` also anchors the day that stops being true.
 * EXPORTED for exactly that assertion; nothing else imports it.
 */
export function estadoArmazenadoShopee(valor: unknown): EstadoFrete | null {
  const lido = estadoFreteSchema.safeParse(valor);
  return lido.success ? lido.data : null;
}

/**
 * Did one diary row change?
 *
 * Written out field by field, and strictly — there is NO generic deep-equal
 * here, for the #1372 reason: a fold decides which edits count as "no change"
 * and therefore which ones are silently never written. `?? null` on both sides
 * folds only `undefined` into `null`, which is the same stored fact (the schema
 * writes `null`, an absent key reads `undefined`).
 *
 * ⚠️ The row schema is `.passthrough()`, so a stored row may carry keys this
 * comparison does not name. They ride the merge untouched and are deliberately
 * NOT compared: nothing writes one, so a difference is not reachable — and
 * `freteTx.test.ts` pins this list against `pacoteFreteSchema`'s own shape, so a
 * field ADDED to the schema reds CI instead of becoming invisible.
 */
function mesmaLinhaPacote(a: PacoteFrete, b: PacoteFrete): boolean {
  return (
    a.numero === b.numero &&
    (a.estado ?? null) === (b.estado ?? null) &&
    (a.estadoMarketplace ?? null) === (b.estadoMarketplace ?? null) &&
    (a.codRastreio ?? null) === (b.codRastreio ?? null) &&
    (a.canalId ?? null) === (b.canalId ?? null) &&
    (a.prazoDespacho ?? null) === (b.prazoDespacho ?? null) &&
    (a.atualizadoEm ?? null) === (b.atualizadoEm ?? null) &&
    (a.fonte ?? null) === (b.fonte ?? null)
  );
}

/**
 * The whole diary, row by row.
 *
 * Both lists are ordered by `numero` — the merge sorts its output and a stored
 * diary was written by this same writer — so the comparison is POSITIONAL with
 * the identity as its first field. That is "keyed by `numero`" for every diary
 * this writer produced, and it is strictly stronger in the two cases where the
 * key alone is ambiguous: a stored diary holding the same `numero` twice (which
 * the merge preserves rather than repairs), and a re-ordering, which really is a
 * change to the stored array.
 */
function mesmoDiario(a: readonly PacoteFrete[], b: readonly PacoteFrete[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((linha, i) => {
    const outra = b[i];
    return outra !== undefined && mesmaLinhaPacote(linha, outra);
  });
}

/* -------------------------------------------------------------------------- */
/*                          the decision AND the patch                         */
/* -------------------------------------------------------------------------- */

const SEM_DIAGNOSTICO: DiagnosticosFreteShopee = {
  pacotes: 0,
  observados: 0,
  obsoletos: [],
  tokensDesconhecidos: [],
  tokensDeRetorno: [],
  estadoAlvo: null,
  motivoEstado: null,
  estadoRessuscitado: false,
  canaisDivergentes: false,
  codRastreioTruncado: false,
  estadoBloqueadoPorPacoteSemEstado: false,
};

/**
 * The whole shipment DECISION, as a pure function of the stored document.
 *
 * ⚠️ It exists so there is exactly ONE of it. The transaction below runs it on
 * its own `tx.get` snapshot; `rastrear:pedido --dry-run` runs it on a plain read
 * and prints the result. Any other arrangement would put a second copy of the
 * comparison in the rehearsal tool — and a rehearsal that disagrees with
 * production is worse than no rehearsal.
 *
 * `raw` is `null` when the pedido does not exist. Nothing here writes, reads a
 * clock or touches the network.
 *
 * ⚠️ This is the ONE place of this path where Shopee SECONDS become µs. Every
 * `PacoteObservadoShopee` field named `*S` is wire seconds (the producer floors
 * them at 2020 and converts nothing); every `ObservacaoPacoteUs` field named
 * `*Us` is microseconds. A seconds value that reached the diary would be read by
 * `pacoteFreteSchema`'s magnitude-classifying preprocess as MILLISECONDS and
 * stored as January 1970 — irrecoverable downstream, which is why the crossing
 * is here and not one module later.
 */
export function preverFreteShopee(
  rawPedido: Record<string, unknown> | null,
  args: PreverFreteShopeeArgs,
): PrevisaoFreteShopee {
  const { observados, relogioDaOrdemUs, prazoDaOrdemUs, nowUs } = args;

  /* ----------------------- guard (1): the pedido exists --------------------- */
  // Step 5 owns creation (`orderPedidoTx.ts`'s `tx.create`); the pipeline arm
  // turns this outcome into a deferred delivery plus one synthetic code 3.
  if (rawPedido === null) {
    return { acao: 'ignorado-sem-pedido', patch: null, campos: [], diagnosticos: SEM_DIAGNOSTICO };
  }

  /* --------------------- guard (2): the block exists ------------------------ */
  // Never CREATES a block either: a synthesized one would have no `modalidade`,
  // no address ref and no `externalOptionIntegracao`, so the Frete tab would
  // render a freight nobody chose. Step 5 seeds it and the next delivery lands.
  const armazenado = objetoDe(rawPedido.freteInicial);
  if (armazenado === null) {
    return {
      acao: 'ignorado-sem-frete-inicial',
      patch: null,
      campos: [],
      diagnosticos: SEM_DIAGNOSTICO,
    };
  }

  /* ------------------- the wire boundary: SECONDS → µs, once ---------------- */
  const observacoes: ObservacaoPacoteUs[] = observados.map((obs) => ({
    numero: obs.packageNumber,
    estadoMarketplace: obs.fulfillmentStatus,
    codRastreio: obs.trackingNumber,
    // `logistics_channel_id` is a number on the wire and a string on the block.
    // The producer already answered `null` for Shopee's zero-fill.
    canalId: obs.logisticsChannelId == null ? null : String(obs.logisticsChannelId),
    prazoDespachoUs: obs.shipByDateS == null ? null : microsDeSegundosShopee(obs.shipByDateS),
    // ⚠️ The ORDER clock stands in ONLY when this source carries no package
    // clock — the code-3 backstop. It is already µs; the package clock is not.
    relogioUs: obs.updateTimeS == null ? relogioDaOrdemUs : microsDeSegundosShopee(obs.updateTimeS),
    fonte: obs.fonte,
  }));

  /* ------------------------ the diary, then the fold ------------------------ */
  const armazenados = diarioArmazenadoShopee(armazenado.pacotes);
  const mescla = mesclarPacotesShopee(armazenados, observacoes);
  // ⚠️ The fold runs over the MERGED diary, never over this delivery's
  // observations: every row's `estado` is a projection re-derived by the merge,
  // and a push about ONE package of a two-package order must not regress the
  // pedido.
  const dobra = dobrarPacotesShopee(mescla.pacotes, prazoDaOrdemUs);

  /* --------------------------- the estado verdict --------------------------- */
  // ⚠️ A stored estado that is not a member of the enum (a legacy or corrupt
  // block) is NOT substituted by `desconhecido`: that is a real member with its
  // own meaning — `ESTADOS_FRETE_IGNORAR_REMOCAO` names it — and claiming the
  // document says it would be inventing a stored fact. The honest reading is
  // "there is nothing to preserve", so the fold's estado is written whenever it
  // has one, and the refusal keeps the same motivo an unreadable token gets.
  // ⚠️ `dobra.estado` is ALSO null when the fold REFUSED one — a package with no
  // readable estado blocks the slot for the whole pedido
  // (`estadoBloqueadoPorPacoteSemEstado`). Both roads answer `token-desconhecido`
  // here, and neither stops `codRastreio`, `prazoDespacho`, `externalOptionId` or
  // the diary from being written below.
  const estadoDoBloco = estadoArmazenadoShopee(armazenado.estado);
  const veredito: VereditoFreteShopee =
    estadoDoBloco !== null
      ? estadoFreteShopeeAplicavel(estadoDoBloco, dobra.estado)
      : dobra.estado === null
        ? { escrever: false, motivo: MOTIVO_FRETE_SHOPEE.tokenDesconhecido }
        : { escrever: true, estado: dobra.estado, ressuscitado: false };

  const diagnosticos: DiagnosticosFreteShopee = {
    pacotes: mescla.pacotes.length,
    observados: observacoes.length,
    obsoletos: mescla.obsoletos,
    tokensDesconhecidos: mescla.tokensDesconhecidos,
    tokensDeRetorno: mescla.tokensDeRetorno,
    estadoAlvo: dobra.estado,
    motivoEstado: veredito.escrever ? null : veredito.motivo,
    estadoRessuscitado: veredito.escrever && veredito.ressuscitado,
    canaisDivergentes: dobra.canaisDivergentes,
    codRastreioTruncado: dobra.codRastreioTruncado,
    estadoBloqueadoPorPacoteSemEstado: dobra.estadoBloqueadoPorPacoteSemEstado,
  };

  /* ---------------------------- the whole-map rebuild ----------------------- */
  // ⚠️ `{ ...armazenado }` FIRST, and it is not cosmetic: `tx.update` masks at a
  // TOP-LEVEL key and `freteInicial` is one key, so every field this writer does
  // not own has to be carried over explicitly or the update ERASES it. Direct
  // precedent: `liquidarPagamento.ts`'s `marketplace` rebuild.
  const freteInicial: Record<string, unknown> = {
    ...armazenado,
    ...(veredito.escrever ? { estado: veredito.estado } : {}),
    // `null` from the fold means "this delivery has nothing to say", never
    // "erase what an earlier tick learnt" — so the key is simply not assigned.
    ...(dobra.codRastreio !== null ? { codRastreio: dobra.codRastreio } : {}),
    ...(dobra.prazoDespachoUs !== null ? { prazoDespacho: dobra.prazoDespachoUs } : {}),
    ...(dobra.externalOptionId !== null ? { externalOptionId: dobra.externalOptionId } : {}),
    // Always, and never `undefined`: the diary is this writer's own field, and
    // the Firebase SDK rejects an `undefined` in a write payload.
    pacotes: mescla.pacotes,
  };

  /* ------------------------ content equality, field by field ---------------- */
  const campos: string[] = [];
  if (veredito.escrever && armazenado.estado !== veredito.estado) {
    campos.push('freteInicial.estado');
  }
  if (dobra.codRastreio !== null && armazenado.codRastreio !== dobra.codRastreio) {
    campos.push('freteInicial.codRastreio');
  }
  if (dobra.prazoDespachoUs !== null && armazenado.prazoDespacho !== dobra.prazoDespachoUs) {
    campos.push('freteInicial.prazoDespacho');
  }
  if (dobra.externalOptionId !== null && armazenado.externalOptionId !== dobra.externalOptionId) {
    campos.push('freteInicial.externalOptionId');
  }
  if (!mesmoDiario(armazenados, mescla.pacotes)) campos.push('freteInicial.pacotes');

  if (campos.length === 0) {
    // Precedence: obsoleto > desconhecido > sem-mudanca. All three write
    // nothing; the name is what the one log line gets to say about WHY.
    // ⚠️ `ignorado-desconhecido` is raised by an UNMAPPED token only. A
    // `LOGISTICS_PENDING_ARRANGE` is a token we DID understand — as step 17's —
    // and `ResultadoFreteShopee.tokensDesconhecidos` is the only token list the
    // arm consumes, so naming that outcome over an empty list would be a
    // diagnosis pointing at nothing. It rides `diagnosticos.tokensDeRetorno`.
    const acao: AcaoFreteShopee =
      mescla.obsoletos.length > 0
        ? 'ignorado-obsoleto'
        : mescla.tokensDesconhecidos.length > 0
          ? 'ignorado-desconhecido'
          : 'ignorado-sem-mudanca';
    return { acao, patch: null, campos: [], diagnosticos };
  }

  /* --------------------------------- the patch ------------------------------ */
  return {
    acao: 'atualizado',
    patch: {
      freteInicial,
      // Monotone and never null. ⚠️ Appended ONLY here, AFTER the empty check —
      // it is derived from a clock and would make every replay a write. The
      // stored side goes through `coerceToMicros` because the legacy corpus
      // holds ms ints and ISO strings there; the incoming side is already µs.
      ultimaModificacao: maiorUs(coerceToMicros(rawPedido.ultimaModificacao), nowUs),
    },
    campos,
    diagnosticos,
  };
}

/* -------------------------------------------------------------------------- */
/*                               the transaction                               */
/* -------------------------------------------------------------------------- */

/**
 * Apply ONE tracking delivery to ONE pedido. Class **B** — see the module header
 * and the entry in
 * `packages/config-eslint/rules/firestore-transaction-inventory.test.js`.
 */
export async function salvarFreteShopee(
  db: Firestore,
  args: SalvarFreteShopeeArgs,
): Promise<ResultadoFreteShopee> {
  const { pedidoId, orderSn, observados, relogioDaOrdemUs, prazoDaOrdemUs, nowUs } = args;

  const { resultado, diagnosticos } = await db.runTransaction(async (tx: Transaction) => {
    const ref = pedidoCollection.docRef(db, {}, pedidoId);
    const snap = await tx.get(ref);
    // RAW, deliberately not `parseRead`: its soft parse RETURNS the raw object on
    // a failed parse, so reading through it would buy nothing and would warn on
    // every legacy pedido this handler walks.
    const raw = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;

    // ⚠️ Every decision is re-derived from THIS transaction's own read — the
    // function is pure and the snapshot is the only input that can have moved.
    const previsao = preverFreteShopee(raw, {
      orderSn,
      observados,
      relogioDaOrdemUs,
      prazoDaOrdemUs,
      nowUs,
    });

    if (previsao.patch !== null) {
      // ⚠️ `tx.update`, NEVER `tx.set` and never a create — a set would wipe the
      // pedido's itens, money and estado, and this transaction is a merge over a
      // pedido step 5 already wrote.
      tx.update(
        ref,
        pedidoCollection.parseMerge({
          freteInicial: previsao.patch.freteInicial,
          ultimaModificacao: previsao.patch.ultimaModificacao,
        }),
      );
    }

    return {
      resultado: {
        pedidoId,
        acao: previsao.acao,
        campos: previsao.campos,
        estadoEscrito:
          previsao.diagnosticos.motivoEstado === null ? previsao.diagnosticos.estadoAlvo : null,
        motivoEstado: previsao.diagnosticos.motivoEstado,
        estadoRessuscitado: previsao.diagnosticos.estadoRessuscitado,
        pacotes: previsao.diagnosticos.pacotes,
        tokensDesconhecidos: previsao.diagnosticos.tokensDesconhecidos,
      } satisfies ResultadoFreteShopee,
      diagnosticos: previsao.diagnosticos,
    };
  });

  // ⚠️ The logs are OUTSIDE the callback on purpose: an OCC retry re-runs the
  // callback, and "one line per delivery" has to stay true when it does.
  if (resultado.estadoRessuscitado) {
    console.warn('[shopee/pedidos] estado de frete ressuscitado — um terminal voltou a viver', {
      orderSn,
      pedidoId,
      para: resultado.estadoEscrito,
    });
  }
  if (diagnosticos.tokensDesconhecidos.length > 0) {
    // eslint-disable-next-line no-console -- the ONLY record of a token the table does not know; distinct tokens, never a body
    console.info('[shopee/pedidos] token de frete desconhecido', {
      orderSn,
      pedidoId,
      tokens: diagnosticos.tokensDesconhecidos,
    });
  }
  // ONE line per delivery. Ids, counts, enum tokens and µs numbers only — never
  // an address, a `driver_info`, a `virtual_contact_number` or a package's
  // payload (this path reads none of them).
  // eslint-disable-next-line no-console -- expected on every healthy delivery; a warn nobody can act on is what hides the real ones
  console.info('[shopee/pedidos] frete do pacote aplicado', {
    orderSn,
    pedidoId,
    acao: resultado.acao,
    campos: resultado.campos,
    estadoEscrito: resultado.estadoEscrito,
    motivoEstado: resultado.motivoEstado,
    pacotes: diagnosticos.pacotes,
    observados: diagnosticos.observados,
    obsoletos: diagnosticos.obsoletos,
    tokensDeRetorno: diagnosticos.tokensDeRetorno,
    canaisDivergentes: diagnosticos.canaisDivergentes,
    codRastreioTruncado: diagnosticos.codRastreioTruncado,
    // ⚠️ WHY no estado was written when one was refused: a package with no
    // readable estado blocks the slot for the whole pedido, so the readable
    // packages' `estadoAlvo: null` is a refusal and not an absence of news.
    estadoBloqueadoPorPacoteSemEstado: diagnosticos.estadoBloqueadoPorPacoteSemEstado,
  });

  return resultado;
}
