import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';

import { parseIsoToMillis } from '@delfrance/core/datetime';
import { pedidoCollection } from '@delfrance/data/admin/collections';
import {
  TIPO_TAREFA_ESCRITA_LI,
  estadoRastreioLiSchema,
  historicoFreteInicialMeta,
} from '@delfrance/schemas';

import {
  type AmbienteLi,
  FLUXO_LI,
  MODO_LI,
  lerValvula,
  registrarValvulaLi,
} from '../../lib/lojaIntegrada/core/valvulas';
import {
  type AgendadorEscritaLi,
  LiTarefasDesligadasError,
  LiTarefasTransitoriasError,
  eventoDoHistoricoLi,
  idDaTarefaEscritaLi,
} from '../../lib/lojaIntegrada/rastreio/agendadorEscrita';
import { pedidoRastreioLi } from '../../lib/lojaIntegrada/rastreio/identidadeRastreio';
import {
  persistirFalhaEscritaLi,
  tarefaEscritaLiSchema,
} from '../../lib/lojaIntegrada/rastreio/notificacaoEscrita';
import { criarAgendadorEscritaLiDoAmbiente } from './agendadorEscrita';
import { getDb } from './lib/admin';

const TAG = '[loja-integrada] onHistoricoFreteLojaIntegrada';

/** Everything one fire needs — injected so the test drives the ladder with doubles. */
export interface DepsGatilhoRastreioLi {
  /** The process environment: the write valve is read from it, once. */
  readonly ambiente: AmbienteLi;
  /** Resolved LAZILY: a row that stops at T1 or T2 never builds the handle. */
  readonly db: () => Firestore;
  /** Built only once T4 said "enqueue" — the sweep-only valve is read at construction. */
  readonly agendador: () => AgendadorEscritaLi;
  readonly logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
}

/** One created freight history row, as the trigger received it. */
export interface HistoricoCriadoLi {
  readonly pedidoId: string;
  readonly historicoId: string;
  /** The created row's RAW body; `undefined` when the event carried none. */
  readonly dados: Record<string, unknown> | undefined;
  /** The CloudEvent's own occurrence time (RFC 3339) — stable across redeliveries. */
  readonly horaDoEvento: string;
}

/**
 * The event's clock, in ms: the row's own `data` (ms, written from the pedido
 * write's CloudEvent time); for a row without a usable one, this event's own
 * occurrence time. Never the wall clock: a redelivery must build the same
 * payload. `null` when neither reads — the payload check then refuses it.
 */
function eventoEmMsDoHistorico(dados: unknown, horaDoEvento: string): number | null {
  return typeof dados === 'number' && Number.isSafeInteger(dados) && dados > 0
    ? dados
    : parseIsoToMillis(horaDoEvento);
}

/**
 * T1–T5 for ONE created history row — see {@link onHistoricoFreteLojaIntegrada}.
 * Never throws for a row that is not ours; rethrows what Eventarc must retry.
 */
export async function tratarHistoricoFreteLi(
  deps: DepsGatilhoRastreioLi,
  h: HistoricoCriadoLi,
): Promise<void> {
  // ---- T1: the estado, from the created row. Zero reads, and NO line. ----
  const estado = estadoRastreioLiSchema.safeParse(h.dados?.estado);
  if (!estado.success) return;

  // ---- T2: the write valve. `off` reads nothing; a value it does not
  // recognise is `off` too, plus ONE WARNING — it would otherwise drop every
  // posting with no trace. ----
  const valvula = lerValvula(FLUXO_LI.rastreio, deps.ambiente);
  if (valvula.modo === MODO_LI.off) {
    if (!valvula.modoReconhecido) registrarValvulaLi(valvula, { conta: null });
    return;
  }

  // ---- T3: ONE raw pedido read. ----
  const db = deps.db();
  const snap = await pedidoCollection.docRef(db, {}, h.pedidoId).get();
  if (!snap.exists) return;

  // ---- T4: the identity proof — an imported Loja Integrada order whose id is
  // the digest of its own conta and numero. Anything else: no line. ----
  const pedido = pedidoRastreioLi(h.pedidoId, snap.data());
  if (pedido === null) return;

  // ---- T5: the named enqueue. ----
  const evento = eventoDoHistoricoLi(h.pedidoId, h.historicoId);
  const lido = tarefaEscritaLiSchema.safeParse({
    tipo: TIPO_TAREFA_ESCRITA_LI.rastreio,
    contaId: pedido.contaId,
    numero: pedido.numero,
    pedidoId: h.pedidoId,
    evento,
    estado: estado.data,
    eventoEmMs: eventoEmMsDoHistorico(h.dados?.data, h.horaDoEvento),
  });
  if (!lido.success) {
    // Deterministic: no retry could ever make this payload valid. The field
    // NAMES only, never a value.
    deps.logger.warn(`${TAG} evento fora do formato da fila de escritas; nada enfileirado`, {
      pedidoId: h.pedidoId,
      evento,
      campos: [...new Set(lido.error.issues.map((i) => String(i.path[0])))].sort(),
    });
    return;
  }
  const payload = lido.data;
  const ids = {
    pedidoId: payload.pedidoId,
    contaId: payload.contaId,
    numero: payload.numero,
    evento: payload.evento,
    estado: payload.estado,
  };

  try {
    await deps.agendador().enfileirar(payload, { id: idDaTarefaEscritaLi(payload) });
  } catch (err) {
    if (err instanceof LiTarefasDesligadasError || err instanceof LiTarefasTransitoriasError) {
      // Persisted `failed` at the event's own id: the varredura drains it. A
      // redelivery lands on the same document.
      const motivo =
        err instanceof LiTarefasDesligadasError
          ? 'enfileiramento-desligado'
          : `enfileiramento-transitorio/${err.codigo}`;
      await persistirFalhaEscritaLi(db, payload, motivo);
      deps.logger.warn(`${TAG} não enfileirado — persistido para a varredura de escritas`, {
        ...ids,
        classe: err.name,
      });
      return;
    }
    throw err;
  }

  deps.logger.info(`${TAG} enfileirado`, ids);
}

/**
 * The status write-back TRIGGER of the Loja Integrada channel (master plan
 * step 7, PR 7-e) — the producer of the writes queue (`./filaEscrita`). It turns
 * a freight transition of an imported Loja Integrada order — posted, delivered,
 * awaiting pickup — into ONE named task, and the task (never this function)
 * decides from a fresh read whether and what to write.
 *
 * ⚠️ It fires on EVERY row of `pedidos/{pedidoId}/historicoFtIni`, the freight
 * audit trail the `onPedidoChanged` trigger appends for every channel's pedidos,
 * on every freight transition. So the first two rungs cost ZERO reads and log
 * NOTHING for a row that is not ours — a line per transition would be noise:
 *
 *  - **T1** the estado of the CREATED row: one of the three a write-back acts on
 *    (`estadoRastreioLiSchema`), else return.
 *  - **T2** the write valve `LOJA_INTEGRADA_MODO_RASTREIO`: `off` (unset, blank,
 *    `off`) returns — `off` records nothing, so an event under `off` is never
 *    written back; an UNRECOGNISED value (`ON`, `dry_run`) returns too, after
 *    ONE WARNING run-start line with the valve fields only.
 *  - **T3** ONE raw pedido read, through the handle.
 *  - **T4** the identity proof (`pedidoRastreioLi`): not an imported Loja
 *    Integrada order whose id is the digest of its own conta and numero (another
 *    channel, a duplicate, a manual pedido) ⇒ return, no line.
 *  - **T5** the enqueue of `{ tipo: rastreio, contaId, numero, pedidoId, evento,
 *    estado, eventoEmMs }` — ids and one enum — under the task id
 *    `rastreio-<evento>`, the event id being a digest of the pedido and history
 *    ids. A redelivered row within Cloud Tasks' dedup window collides
 *    (`task-already-exists` is success); past it, the task's own fresh read
 *    skips what is already written. Tasks switched off or a transient Cloud
 *    Tasks failure ⇒ the event is persisted `failed` for the varredura, with one
 *    WARNING. Anything else — a missing region, a refused permission — is
 *    rethrown for Eventarc's retry.
 *
 * The trigger reads no canary list and no read switch: a target outside the
 * canary, and the switch off, are the task's to defer — so `dry-run` keeps
 * every event for a later `on`.
 *
 * A row created by the history trigger for a NON-target estado is never seen
 * again: only a CREATE fires this, and the history trigger writes each row once
 * at a deterministic id (a redelivery rewrites the same document, which is not a
 * create). A tracking code that reaches the pedido after its posting row is
 * therefore not written back — a decided gap.
 *
 * ⚠️ Targets the NAMED `default` database, inlined at build time by `build.mjs`
 * (`onIntegracaoLojaIntegradaChanged`'s docblock says why): an `onDocument*`
 * bound to `(default)` deploys fine and NEVER fires. `retry: true`: a transient
 * failure (the pedido read, the persist) is retried; the ladder is replay-safe
 * because its only Firestore write is the deterministic failure row (tier 0,
 * `create` ignoring ALREADY_EXISTS). No `region:` (options.ts), no `secrets:`
 * (it never calls Loja Integrada), no memory or timeout of its own.
 *
 * LOGS: ids and the estado only — never the order's data, a tracking code or a
 * value of the valve.
 */
export const onHistoricoFreteLojaIntegrada = onDocumentCreated(
  {
    // The meta, never a literal: `pedidos/{pedidoId}/historicoFtIni`.
    document: `${historicoFreteInicialMeta.collectionPath}/{historicoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    retry: true,
    // ⚠️ No `region:` (options.ts) and no `secrets:` — see the docblock.
  },
  async (event) => {
    // The `{pedidoId}` wildcard sits inside the meta-derived prefix, so its type
    // is not inferred into `event.params` — both are present at runtime.
    const { pedidoId, historicoId } = event.params as { pedidoId: string; historicoId: string };
    const dados = event.data?.exists
      ? (event.data.data() as Record<string, unknown> | undefined)
      : undefined;

    await tratarHistoricoFreteLi(
      {
        ambiente: process.env,
        db: getDb,
        agendador: criarAgendadorEscritaLiDoAmbiente,
        logger,
      },
      { pedidoId, historicoId, dados, horaDoEvento: event.time },
    );
  },
);
