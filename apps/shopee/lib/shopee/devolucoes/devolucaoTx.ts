/**
 * The ONE Firestore write of a Shopee return (#1525, step 17) — the incidente
 * at `pedidos/{pedidoId}/incidentes/shopee-devolucao-<return_sn>`, created or
 * refreshed in a single `db.runTransaction`. Class **B**; the inventory entry
 * is in `packages/config-eslint/rules/firestore-transaction-inventory.test.js`.
 *
 * ## The race class — **B**, and the honest reason
 *
 * The {@link DevolucaoMapeada} is built OUTSIDE the callback, from the
 * `get_return_detail` the importer pulled, and is re-applied verbatim on an OCC
 * retry. It is B rather than C because that Shopee call closes BEFORE the
 * transaction opens: nothing networked sits between this read and this write,
 * so the widest window is one Firestore round trip (the `freteTx.ts`
 * reasoning).
 *
 * The named guard, ADR 0011 tier 2, in **microseconds**: the incidente's own
 * top-level `relogioProvedorUs` — the detail's `update_time`, wire SECONDS
 * converted ONCE by `microsDeSegundosShopee` in `devolucaoMapping.ts` (this
 * module converts nothing). Re-derived from the callback's own `tx.get`:
 *
 *  - incoming OLDER than stored ⇒ `ignorado-obsoleto`, ZERO writes — a stale
 *    detail neither opens nor closes the incidente;
 *  - EQUAL ⇒ write only when {@link mesmoConteudoDevolucao} (field by field,
 *    strict, NO generic deep-equal — #1372) says the content differs. Shopee's
 *    stamps have 1-second resolution, so two changes inside one second share
 *    one `update_time`; a strict `>` could never converge on the second;
 *  - NEWER ⇒ write, and the watermark ALWAYS advances: the importer-owned
 *    patch when the content differs, `{ relogioProvedorUs, ultimaModificacao }`
 *    alone when it does not (`relogio-avancado`);
 *  - a stored watermark that is absent or not a number reads as OLDER: an
 *    absent clock on OUR deterministic id is not evidence of order, and the
 *    incoming one is never null (`update_time` is REQUIRED on the wire).
 *
 * ⚠️ **`ultimaModificacao` is NOT the guard, and must never become it.** The
 * web editor stamps WALL-CLOCK µs there on every operator save
 * (`saveIncidenteEdit.ts`), so an operator who added a comment would block every
 * later import of the return for as long as Shopee's clock trails ours. This
 * module only WRITES it — `= relogioProvedorUs` on every applied write, for
 * display — and never reads it.
 *
 * ⚠️ **Operator turf is never written after the create.** The update patch
 * names EXACTLY the importer-owned keys — `origem`, `tipo`, `externalId`,
 * `claimStatus`, `claimStage`, `entregue`, `ultimaModificacao`,
 * `relogioProvedorUs`, `devolucaoShopee` — and `tx.update` masks at top-level
 * keys, so `timestamp`, `motivoDoIncidente`, `comentarios`, `resolucao` and the
 * server-owned `overrideBloqueio` survive every refresh untouched. `origem` and
 * `tipo` ARE in it on purpose: they are part of the compared content, so an
 * operator's retype of an imported row (E3 F2) reads as a difference and is
 * RE-ASSERTED by the next fresher-or-equal delivery — the web lock is the
 * other half (R-16).
 *
 * ⚠️ **`revisao` moves with CONTENT, never with the clock.** It is assigned
 * here, inside the callback, from the stored block (`+1` per content change,
 * `1` on create), and a watermark-only advance leaves it alone. The aviso's
 * `relogioEvento` is built from it (`relogioDoAvisoDeDevolucao`), which is why
 * it must be monotone per content change and must not churn.
 *
 * ⚠️ A pedido that does not exist — re-read in-tx, because the importer's cheap
 * read is a SKIP and not the guard — drops with `ignorado-sem-pedido` and ZERO
 * writes: a subcollection document under a missing pedido is an orphan nothing
 * lists. This transaction never creates a pedido (step 5 does).
 *
 * ⚠️ The decision AND the exact payload live in ONE pure function,
 * {@link preverIncidenteDevolucaoShopee}, which the callback runs on its own
 * `tx.get` snapshot and the `importar:devolucao` dry run runs on a plain read —
 * so the rehearsal prints the bytes a live delivery writes (the
 * `preverFreteShopee` rule). It logs nothing: the importer's ONE line per
 * delivery is `importarDevolucao.ts`'s, outside any callback an OCC retry
 * re-runs.
 */
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { incidenteCollection, pedidoCollection } from '@delfrance/data/admin/collections';
import {
  ORIGEM_INCIDENTE,
  TIPO_INCIDENTE,
  statusClaimSchema,
  type StatusClaim,
} from '@delfrance/schemas';

import {
  devolucaoShopeeArmazenadaSchema,
  mesmoConteudoDevolucao,
  pendenciaDoVendedor,
  type ConteudoDevolucao,
  type DevolucaoMapeada,
  type DevolucaoShopeeArmazenada,
} from './devolucaoMapping';

/* -------------------------------------------------------------------------- */
/*                                  contract                                   */
/* -------------------------------------------------------------------------- */

/** What one return delivery did to its incidente. */
export type AcaoDevolucaoTx =
  | 'criado'
  | 'atualizado'
  | 'relogio-avancado'
  | 'ignorado-obsoleto'
  | 'ignorado-sem-mudanca'
  | 'ignorado-sem-pedido';

/** The return as the incidente holds it — before, or after, this transaction. */
export interface EstadoConfirmadoDevolucao {
  /** `null` when the stored value is absent or not a member. */
  readonly claimStatus: StatusClaim | null;
  /** `null` when the stored block is absent or illegible. */
  readonly bloco: DevolucaoShopeeArmazenada | null;
}

/**
 * What {@link preverIncidenteDevolucaoShopee} decided about ONE stored
 * incidente.
 *
 * ⚠️ It carries the PAYLOAD itself — already through `incidenteCollection.parse`
 * (create) or `.parseMerge` (update) — not a description of it, so a dry run
 * prints exactly what a live delivery writes. The verb follows from `acao`:
 * `criado` ⇒ `tx.create`, every other non-null patch ⇒ `tx.update`.
 */
export interface PrevisaoDevolucao {
  readonly acao: AcaoDevolucaoTx;
  /** `null` on every zero-write outcome. */
  readonly patch: Record<string, unknown> | null;
  /**
   * The incidente once this transaction is over: what it WROTE, else what its
   * own `tx.get` read and kept — never a second read. The aviso is derived from
   * THIS, never from the delivery's detail, so a stale detail can neither raise
   * nor resolve it.
   */
  readonly confirmado: EstadoConfirmadoDevolucao;
  /** The incidente as this transaction READ it; `null` when it did not exist. */
  readonly anterior: EstadoConfirmadoDevolucao | null;
  /**
   * What the aviso SHOWS changed: the seller's pending action
   * ({@link pendenciaDoVendedor} — the pendência or its deadline) or the raw
   * status token differs between {@link PrevisaoDevolucao.anterior} and
   * {@link PrevisaoDevolucao.confirmado}. Always `false` on a zero-write outcome
   * and on a watermark-only advance, where the two are the same stored state;
   * always `true` on a create (there was no status before).
   *
   * ⚠️ A DIAGNOSTIC (the delivery log and `importar:devolucao` print it), never
   * the aviso's gate. It describes THIS transaction's change, so the retry of a
   * delivery whose transaction committed but whose aviso effect then failed
   * reads `false` — on `ignorado-sem-mudanca`, and on an `atualizado` when
   * Shopee changed only a field the aviso does not show in between. So
   * `avisoDevolucao.ts` projects every content change and every replay: the
   * effect is idempotent under its own clock — `escreverAviso` drops an equal
   * `relogioEvento`, `resolverAviso` skips a stored one `>=` the given.
   */
  readonly mudouAviso: boolean;
}

export interface SalvarIncidenteDevolucaoArgs {
  /** `makePedidoIdShopee(integracaoId, orderSn)`, computed by the caller. */
  readonly pedidoId: string;
  /** `idIncidenteDevolucaoShopee(returnSn)`, computed by the caller. */
  readonly incidenteId: string;
  readonly mapeada: DevolucaoMapeada;
}

/* -------------------------------------------------------------------------- */
/*                                 raw readers                                 */
/* -------------------------------------------------------------------------- */

/**
 * The stored watermark, or `null` when there is none worth comparing.
 *
 * RAW and without coercion: `relogioProvedorUs` is this module's own field,
 * written only here and only in µs, so there is no legacy unit to tolerate. A
 * value that is not a finite number is treated exactly like an absent one —
 * as OLDER than any delivery.
 */
function relogioArmazenadoUs(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
}

/** The stored block re-parsed by its own permissive schema, or `null`. */
function blocoArmazenado(valor: unknown): DevolucaoShopeeArmazenada | null {
  const lido = devolucaoShopeeArmazenadaSchema.safeParse(valor);
  return lido.success ? lido.data : null;
}

function estadoArmazenado(raw: Record<string, unknown>): EstadoConfirmadoDevolucao {
  const claim = statusClaimSchema.safeParse(raw.claimStatus);
  return {
    claimStatus: claim.success ? claim.data : null,
    bloco: blocoArmazenado(raw.devolucaoShopee),
  };
}

/** The block minus its revision — the compared part of it. */
function semRevisao(bloco: DevolucaoShopeeArmazenada): Omit<DevolucaoShopeeArmazenada, 'revisao'> {
  const { revisao: _revisao, ...resto } = bloco;
  return resto;
}

/**
 * The stored document as a {@link ConteudoDevolucao}, or `null` when it cannot
 * be one.
 *
 * ⚠️ Not a second comparison — a TYPE adapter. Four of the content's fields are
 * CONSTANTS of every importer-written incidente (`origem` 5, `tipo` `returns`,
 * `claimStage` and `entregue` null), and `claimStatus` / `externalId` are never
 * null there. A stored value outside that shape — an operator's retype, a
 * hand-made row at our id, an illegible block — is a document the type cannot
 * describe, so its content differs from any delivery's BY CONSTRUCTION and the
 * importer re-asserts it. Everything the type CAN describe is compared by
 * {@link mesmoConteudoDevolucao} and nowhere else. `null` and an absent key are
 * the same stored fact here, as in the block's own schema (R-9).
 */
function conteudoArmazenado(
  raw: Record<string, unknown>,
  estado: EstadoConfirmadoDevolucao,
): ConteudoDevolucao | null {
  const { origem, tipo, externalId } = raw;
  if (origem !== ORIGEM_INCIDENTE.pedidoShopee) return null;
  if (tipo !== TIPO_INCIDENTE.devolucao) return null;
  if (typeof externalId !== 'string') return null;
  if ((raw.claimStage ?? null) !== null || (raw.entregue ?? null) !== null) return null;
  if (estado.claimStatus === null || estado.bloco === null) return null;
  return {
    origem,
    tipo,
    externalId,
    claimStatus: estado.claimStatus,
    claimStage: null,
    entregue: null,
    bloco: semRevisao(estado.bloco),
  };
}

/* -------------------------------------------------------------------------- */
/*                                the aviso hint                               */
/* -------------------------------------------------------------------------- */

function pendenciaDe(estado: EstadoConfirmadoDevolucao | null) {
  return estado?.bloco ? pendenciaDoVendedor(estado.claimStatus, estado.bloco) : null;
}

/**
 * Does the aviso need a new effect? The pendência, its deadline, or the raw
 * status token moved between what this transaction READ and what it LEFT.
 *
 * ⚠️ Compared field by field, strictly — the deadline in µs, the token
 * verbatim (`'ACCEPTED'` and `'Accepted'` are two tokens). A status change that
 * keeps the same pendência (`REQUESTED` → `PROCESSING`) still counts: the
 * aviso's `motivo` IS that token.
 */
function mudouOAviso(
  anterior: EstadoConfirmadoDevolucao | null,
  confirmado: EstadoConfirmadoDevolucao,
): boolean {
  const antes = pendenciaDe(anterior);
  const depois = pendenciaDe(confirmado);
  return (
    (antes?.pendencia ?? null) !== (depois?.pendencia ?? null) ||
    (antes?.prazoUs ?? null) !== (depois?.prazoUs ?? null) ||
    (anterior?.bloco?.status ?? null) !== (confirmado.bloco?.status ?? null)
  );
}

/* -------------------------------------------------------------------------- */
/*                          the decision AND the patch                         */
/* -------------------------------------------------------------------------- */

function semEscrita(
  acao: AcaoDevolucaoTx,
  anterior: EstadoConfirmadoDevolucao | null,
): PrevisaoDevolucao {
  return {
    acao,
    patch: null,
    confirmado: anterior ?? { claimStatus: null, bloco: null },
    anterior,
    mudouAviso: false,
  };
}

/** The outcome of a pedido the callback's own read found missing. */
const SEM_PEDIDO: PrevisaoDevolucao = semEscrita('ignorado-sem-pedido', null);

/**
 * The whole return DECISION, as a pure function of the stored incidente.
 *
 * ⚠️ It exists so there is exactly ONE of it: the transaction below runs it on
 * its own `tx.get` snapshot, and the `importar:devolucao` dry run on a plain
 * read. `rawIncidente` is `undefined` when the incidente does not exist; the
 * PEDIDO's existence is the caller's gate (`ignorado-sem-pedido` is decided
 * before this runs). Nothing here writes, reads a clock or touches the network.
 *
 * @throws RangeError when the mapped watermark is not a positive safe integer —
 *   a mapper bug, never a wire value (`update_time` is a REQUIRED `wireInt`),
 *   refused here because a `NaN` would compare false against everything and
 *   become a watermark no later delivery could ever beat.
 */
export function preverIncidenteDevolucaoShopee(
  rawIncidente: Record<string, unknown> | undefined,
  mapeada: DevolucaoMapeada,
): PrevisaoDevolucao {
  const incomingUs = mapeada.relogioProvedorUs;
  if (!Number.isSafeInteger(incomingUs) || incomingUs <= 0) {
    throw new RangeError('relogioProvedorUs da devolução mapeada não é um inteiro positivo');
  }

  // The incoming block through the SAME schema the stored side is read with, so
  // the comparison and the write see one shape (`null` ≡ absent). The revisão
  // is a placeholder until the decision assigns the real one below.
  const entrante = semRevisao(
    devolucaoShopeeArmazenadaSchema.parse({ ...mapeada.bloco, revisao: 1 }),
  );

  /* ------------------------------ absent ⇒ create --------------------------- */
  if (rawIncidente === undefined) {
    const bloco: DevolucaoShopeeArmazenada = { ...entrante, revisao: 1 };
    const confirmado: EstadoConfirmadoDevolucao = { claimStatus: mapeada.claimStatus, bloco };
    return {
      acao: 'criado',
      // `tx.create`, never `tx.set` — OCC turns a concurrent create into an
      // abort-and-retry, which re-runs this decision against the winner.
      patch: incidenteCollection.parse({
        origem: mapeada.origem,
        tipo: mapeada.tipo,
        externalId: mapeada.externalId,
        claimStatus: mapeada.claimStatus,
        claimStage: mapeada.claimStage,
        entregue: mapeada.entregue,
        // Create-only: after this, both are operator turf.
        timestamp: mapeada.timestampUs,
        motivoDoIncidente: mapeada.motivoInicial,
        ultimaModificacao: incomingUs,
        relogioProvedorUs: incomingUs,
        devolucaoShopee: bloco,
      }),
      confirmado,
      anterior: null,
      mudouAviso: mudouOAviso(null, confirmado),
    };
  }

  /* ------------------------------- the guard -------------------------------- */
  const anterior = estadoArmazenado(rawIncidente);
  const armazenadoUs = relogioArmazenadoUs(rawIncidente.relogioProvedorUs);
  if (armazenadoUs !== null && incomingUs < armazenadoUs) {
    return semEscrita('ignorado-obsoleto', anterior);
  }

  const armazenado = conteudoArmazenado(rawIncidente, anterior);
  const mesmoConteudo =
    armazenado !== null &&
    mesmoConteudoDevolucao(
      {
        origem: mapeada.origem,
        tipo: mapeada.tipo,
        externalId: mapeada.externalId,
        claimStatus: mapeada.claimStatus,
        claimStage: mapeada.claimStage,
        entregue: mapeada.entregue,
        bloco: entrante,
      },
      armazenado,
    );
  const maisNovo = armazenadoUs === null || incomingUs > armazenadoUs;

  if (mesmoConteudo) {
    if (!maisNovo) return semEscrita('ignorado-sem-mudanca', anterior);
    // Newer clock, same content: advance the watermark and NOTHING else — no
    // revisão, no block — so the aviso sees no change and the history trigger
    // (`relogioProvedorUs` sits in its `ignoreFields`) files no row.
    return {
      acao: 'relogio-avancado',
      patch: incidenteCollection.parseMerge({
        relogioProvedorUs: incomingUs,
        ultimaModificacao: incomingUs,
      }),
      confirmado: anterior,
      anterior,
      mudouAviso: false,
    };
  }

  /* --------------------- the content changed ⇒ the patch -------------------- */
  const revisaoAnterior = anterior.bloco?.revisao;
  const revisao =
    typeof revisaoAnterior === 'number' &&
    Number.isSafeInteger(revisaoAnterior) &&
    revisaoAnterior >= 1
      ? revisaoAnterior + 1
      : 1;
  const bloco: DevolucaoShopeeArmazenada = { ...entrante, revisao };
  const confirmado: EstadoConfirmadoDevolucao = { claimStatus: mapeada.claimStatus, bloco };
  return {
    acao: 'atualizado',
    // ⚠️ The importer-owned keys and NOTHING else — see the module header.
    patch: incidenteCollection.parseMerge({
      origem: mapeada.origem,
      tipo: mapeada.tipo,
      externalId: mapeada.externalId,
      claimStatus: mapeada.claimStatus,
      claimStage: mapeada.claimStage,
      entregue: mapeada.entregue,
      ultimaModificacao: incomingUs,
      relogioProvedorUs: incomingUs,
      devolucaoShopee: bloco,
    }),
    confirmado,
    anterior,
    mudouAviso: mudouOAviso(anterior, confirmado),
  };
}

/* -------------------------------------------------------------------------- */
/*                               the transaction                               */
/* -------------------------------------------------------------------------- */

/**
 * Apply ONE return delivery to ONE incidente. Class **B** — see the module
 * header and the entry in
 * `packages/config-eslint/rules/firestore-transaction-inventory.test.js`.
 */
export async function salvarIncidenteDevolucaoShopee(
  db: Firestore,
  p: SalvarIncidenteDevolucaoArgs,
): Promise<PrevisaoDevolucao> {
  const { pedidoId, incidenteId, mapeada } = p;
  return db.runTransaction(async (tx: Transaction) => {
    // ⚠️ The pedido FIRST: the importer's cheap read before this transaction is
    // a skip, not the guard — a pedido deleted since must not gain an orphan
    // subcollection.
    const pedido = await tx.get(pedidoCollection.docRef(db, {}, pedidoId));
    if (!pedido.exists) return SEM_PEDIDO;

    const ref = incidenteCollection.docRef(db, { pedidoId }, incidenteId);
    const snap = await tx.get(ref);
    // RAW, deliberately not `parseRead`: the decision reads its own fields
    // through its own tolerant readers, and a soft parse would warn on every
    // operator-touched row while returning the raw object anyway.
    const raw = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : undefined;

    // ⚠️ Every decision is re-derived from THIS attempt's own read — the
    // function is pure and the snapshot is the only input that can have moved.
    const previsao = preverIncidenteDevolucaoShopee(raw, mapeada);
    if (previsao.patch !== null) {
      if (previsao.acao === 'criado') tx.create(ref, previsao.patch);
      else tx.update(ref, previsao.patch);
    }
    return previsao;
  });
}
