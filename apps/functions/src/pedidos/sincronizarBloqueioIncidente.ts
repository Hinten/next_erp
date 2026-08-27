import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { incidenteCollection, pedidoCollection } from '@delfrance/data/admin/collections';
import {
  acaoBloqueadaSchema,
  classificarIncidenteBloqueante,
  incidenteMeta,
  nowMicros,
  origemIncidenteSchema,
  statusClaimSchema,
  tipoIncidenteSchema,
  type AcaoBloqueada,
  type OrigemIncidente,
  type StatusClaim,
  type TipoIncidente,
} from '@delfrance/schemas';

import { getDb } from '../lib/admin';

/**
 * Keep `pedido.disputaAbertaEm` / `pedido.devolucaoAbertaEm` in step with the
 * pedido's `incidentes` subcollection (#1322).
 *
 * ## Why a denorm exists at all
 *
 * The failure this closes is an operator opening a marketplace order during a
 * mediation and seeing a completely healthy `pago` pedido — cliente bound,
 * endereço fine, freteInicial fine, stock committed — with nothing on screen to
 * say the money is about to be refunded, and shipping it. The decision is made
 * on the `/pedidos` LIST and inside the checkout transaction, neither of which
 * can afford a subcollection read per row. Two scalars on the pedido doc ride
 * the projection both surfaces already fetch.
 *
 * ## Why a TRIGGER rather than the claim importer
 *
 * `claimImport.ts` is the only writer of ML incidentes, so it could keep these
 * fields itself — but it is not the only writer of an incidente's OPEN-ness. An
 * operator resolving one by hand in the Incidentes tab would close it without
 * clearing the pedido flag, stranding the pedido behind a block that nothing
 * left could lift. A trigger covers every writer, including ones added later.
 *
 * ## Concurrency (root CLAUDE.md rule 7 — class A)
 *
 * The whole decision is RE-DERIVED inside the transaction from a fresh read of
 * the subcollection; nothing is captured from the event payload except which
 * pedido to look at. Two incidentes changing at once contend on OCC and the
 * retry recomputes from scratch, so a late-arriving write cannot re-apply a
 * stale verdict. `before`/`after` are used ONLY for the fast-path skip, never
 * as the source of the value written.
 *
 * ## Loop safety
 *
 * This trigger reads `pedidos/{id}/incidentes/*` and writes `pedidos/{id}`. It
 * cannot re-enter itself (a pedido write is not an incidente write), and the
 * two fields it writes are absent from `sincronizarEstoquePedido`'s
 * `CAMPOS_OBSERVADOS`, so the stock sync's fast-path diff exits untouched.
 */

/** The incidente fields whose movement can change a pedido's blocking state. */
const CAMPOS_BLOQUEIO = [
  'origem',
  'tipo',
  'claimStatus',
  'resolucao',
  'entregue',
  // Without this the fast path swallows the very write that grants a release.
  'overrideBloqueio',
] as const;

/** One incidente, narrowed to what the classifier reads. */
function lerIncidente(raw: Record<string, unknown>): {
  origem: OrigemIncidente | null;
  tipo: TipoIncidente;
  claimStatus: StatusClaim | null;
  resolucao: unknown | null;
  entregue: boolean | null;
  timestamp: number | null;
} | null {
  // A tipo we cannot parse cannot be classified, and guessing would either
  // block a pedido for no reason or silently fail to block one. Skip it and
  // say so — an unparseable incidente is a data problem, not a verdict.
  const tipo = tipoIncidenteSchema.safeParse(raw.tipo);
  if (!tipo.success) return null;
  return {
    origem: origemIncidenteSchema.safeParse(raw.origem).data ?? null,
    tipo: tipo.data,
    claimStatus: statusClaimSchema.safeParse(raw.claimStatus).data ?? null,
    resolucao: raw.resolucao ?? null,
    entregue: typeof raw.entregue === 'boolean' ? raw.entregue : null,
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : null,
  };
}

/**
 * The actions one incidente's override releases. Each entry is parsed
 * individually so an unknown action name — a field hand-edited in the console,
 * or a member added in a later version — is dropped rather than poisoning the
 * whole override and releasing nothing.
 */
function lerOverride(raw: Record<string, unknown>): AcaoBloqueada[] {
  const override = raw.overrideBloqueio;
  if (override == null || typeof override !== 'object') return [];
  const acoes = (override as Record<string, unknown>).acoes;
  if (!Array.isArray(acoes)) return [];
  return acoes.flatMap((a) => {
    const parsed = acaoBloqueadaSchema.safeParse(a);
    return parsed.success ? [parsed.data] : [];
  });
}

export interface MarcadoresBloqueio {
  disputaAbertaEm: number | null;
  devolucaoAbertaEm: number | null;
  /**
   * Union of the per-action overrides across the pedido's OPEN blocking
   * incidentes, or null when there are none.
   *
   * ⚠️ Computed from OPEN incidentes only, and that is what makes a release
   * self-clearing: it evaporates with the claim that justified it, so it can
   * never silently unblock the NEXT dispute on the same pedido. Null rather
   * than `[]` for "nothing released", matching the schema default — the two
   * read the same to every consumer, and null keeps a cleared pedido byte
   * identical to one that never had an override.
   */
  bloqueiosLiberados: AcaoBloqueada[] | null;
}

/**
 * Fold a pedido's incidentes into the two markers — the pure core, exported so
 * it can be tested without a Firestore fake.
 *
 * Each marker is the OLDEST open incidente of its kind, so the banner can say
 * how long the pedido has been held rather than resetting every time ML sends
 * another update on the same claim. An incidente with no `timestamp` still
 * counts (it blocks); it just cannot lower the floor, so `nowUs` stands in.
 */
export function calcularMarcadores(
  incidentes: ReadonlyArray<Record<string, unknown>>,
  nowUs: number,
): MarcadoresBloqueio {
  let disputa: number | null = null;
  let devolucao: number | null = null;
  const liberados = new Set<AcaoBloqueada>();
  for (const raw of incidentes) {
    const inc = lerIncidente(raw);
    if (inc == null) continue;
    const classe = classificarIncidenteBloqueante(inc);
    // ⚠️ An override on a CLOSED incidente contributes nothing — `continue`
    // happens before the union below. That is the self-clearing half.
    if (classe == null) continue;
    const em = inc.timestamp ?? nowUs;
    if (classe === 'devolucao') {
      devolucao = devolucao == null ? em : Math.min(devolucao, em);
    } else {
      disputa = disputa == null ? em : Math.min(disputa, em);
    }
    for (const acao of lerOverride(raw)) liberados.add(acao);
  }
  return {
    disputaAbertaEm: disputa,
    devolucaoAbertaEm: devolucao,
    bloqueiosLiberados: liberados.size > 0 ? [...liberados].sort() : null,
  };
}

/** True when none of {@link CAMPOS_BLOQUEIO} moved — the fast-path skip. */
function nadaRelevanteMudou(
  antes: Record<string, unknown> | undefined,
  depois: Record<string, unknown> | undefined,
): boolean {
  if (antes == null || depois == null) return false; // create or delete
  return CAMPOS_BLOQUEIO.every((c) => JSON.stringify(antes[c]) === JSON.stringify(depois[c]));
}

export async function sincronizarMarcadoresBloqueio(
  db: Firestore,
  pedidoId: string,
  nowUs: number,
): Promise<MarcadoresBloqueio | null> {
  return db.runTransaction(async (tx) => {
    const pedidoRef = pedidoCollection.docRef(db, {}, pedidoId);
    const pedidoSnap = await tx.get(pedidoRef);
    // A pedido deleted while its incidentes were being cascaded away is not an
    // error — there is nothing left to mark.
    if (!pedidoSnap.exists) return null;

    const incidentesSnap = await tx.get(incidenteCollection.ref(db, { pedidoId }));
    const marcadores = calcularMarcadores(
      incidentesSnap.docs.map((d) => (d.data() ?? {}) as Record<string, unknown>),
      nowUs,
    );

    // Re-derived from THIS transaction's reads, then compared against the
    // pedido snapshot read in the same transaction — a no-op write would churn
    // the modification history and wake every downstream trigger for nothing.
    const atualDisputa = pedidoSnap.get('disputaAbertaEm') ?? null;
    const atualDevolucao = pedidoSnap.get('devolucaoAbertaEm') ?? null;
    const atualLiberados = (pedidoSnap.get('bloqueiosLiberados') ?? null) as unknown;
    if (
      atualDisputa === marcadores.disputaAbertaEm &&
      atualDevolucao === marcadores.devolucaoAbertaEm &&
      JSON.stringify(atualLiberados) === JSON.stringify(marcadores.bloqueiosLiberados)
    ) {
      return marcadores;
    }

    // ⚠️ A bare `update` of exactly these two keys — NOT a merge of a parsed
    // pedido. The converter would full-parse the patch and the merge mask would
    // then overwrite stored sibling fields (root CLAUDE.md, "New collection").
    // `ultimaModificacao` is deliberately NOT stamped: this is derived state,
    // and bumping it would raise a false "Pedido alterado" conflict in the
    // editor over fields the operator can neither see nor edit (#972).
    tx.update(pedidoRef, {
      disputaAbertaEm: marcadores.disputaAbertaEm,
      devolucaoAbertaEm: marcadores.devolucaoAbertaEm,
      bloqueiosLiberados: marcadores.bloqueiosLiberados,
    });
    logger.info('[pedidos] marcadores de bloqueio atualizados', {
      pedidoId,
      de: { disputa: atualDisputa, devolucao: atualDevolucao, liberados: atualLiberados },
      para: marcadores,
    });
    return marcadores;
  });
}

export const onIncidenteBloqueioSync = onDocumentWritten(
  {
    document: `${incidenteMeta.collectionPath}/{docId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const antes = event.data?.before.data();
    const depois = event.data?.after.data();
    if (nadaRelevanteMudou(antes, depois)) return;

    // `collectionPath` is a runtime string, so TS infers only the `{docId}`
    // wildcard from the template — the same reason `onIncidenteChanged`'s
    // `resolve` casts. Both are always present at runtime; an absent one would
    // mean the trigger is bound to a path this code does not model, and
    // guessing a pedido id there is worse than doing nothing.
    const { pedidoId } = event.params as Record<string, string | undefined>;
    if (pedidoId == null) {
      logger.error('[pedidos] evento de incidente sem pedidoId — ignorado', {
        params: event.params,
      });
      return;
    }
    await sincronizarMarcadoresBloqueio(getDb(), pedidoId, nowMicros());
  },
);
