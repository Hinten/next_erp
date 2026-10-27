import { z } from 'zod';
import { contaIdLiSchema, numeroPedidoLiSchema } from './notificacaoLojaIntegrada';
import { ESTADO_FRETE } from './shared/frete';
import { notificationResilienceFields } from './shared/notificationResilience';

/**
 * `notificacoesEscritaLojaIntegrada` (TOP-LEVEL) — the **failures-only** backlog of
 * the Loja Integrada WRITES queue (master plan step 7): the status write-back of an
 * order (its tracking code and its situação), and from steps 11–13 every later
 * write kind. A task that settled writes NOTHING; a document lands here only when
 * the event could not be written yet: the task exhausted its retries or the write
 * landed without its effect confirmed (`failed`), a precondition outside this
 * system is not met yet — the valve at `off` or `dry-run`, the target outside the
 * canary list, the read switch off, the conta inactive, its token missing, corrupt
 * or refused (`deferred`, replayed daily) — or the outcome is terminal (`parked`).
 *
 * Modelled on `notificacaoLojaIntegrada.ts` (the reads queue's store).
 *
 * ## The payload is IDS and ONE enum, and unknown keys are STRIPPED
 *
 * An event names a freight transition of one pedido; the run re-reads the pedido
 * and Loja Integrada before deciding anything. So the wire fields are the conta,
 * the order `numero`, the pedido id, the event's own id, the freight estado the
 * event recorded and its clock — no code, no body, no personal data. The object
 * STRIPS anything else instead of passing it through: a field nobody declared is a
 * field nobody reviewed for what it may carry.
 *
 * ⚠️ Every field a later step adds must be optional or defaulted. Tasks in flight
 * survive a deploy, and a task whose payload no longer parses is DROPPED by the
 * shared pipeline (`handleTask`).
 *
 * ## The ids are digests, so every document id is valid by construction
 *
 * The document id is `evento` (64 lowercase hex characters), and the Cloud Tasks
 * task id is `rastreio-<evento>`: both are safe whatever form the source ids have.
 *
 * Admin-only / default-deny: NOT registered in `ALL_DOMAINS`, no Meta, so the
 * rules generator emits no match block and no client can read it.
 */

/**
 * What a writes-queue task asks for — the field the run dispatches on. The
 * queue's sweep task (`varredura`) is dispatched by the function BEFORE any parse,
 * so it is deliberately not a member: it never reaches this schema.
 */
export const tipoTarefaEscritaLiSchema = z.enum(['rastreio']);
export type TipoTarefaEscritaLi = z.infer<typeof tipoTarefaEscritaLiSchema>;

/** Named members of {@link tipoTarefaEscritaLiSchema} — see `delfrance/prefer-schema-enum`. */
export const TIPO_TAREFA_ESCRITA_LI = {
  rastreio: 'rastreio',
} as const satisfies Record<string, TipoTarefaEscritaLi>;

/**
 * The freight estados a write-back acts on: a posting, a delivery and a pickup
 * awaiting the buyer. Every other estado is unrepresentable in the payload, so an
 * event about one can never be enqueued, let alone written.
 */
export const estadoRastreioLiSchema = z.enum([
  ESTADO_FRETE.postado,
  ESTADO_FRETE.entregue,
  ESTADO_FRETE.aguardandoRetirada,
]);
export type EstadoRastreioLi = z.infer<typeof estadoRastreioLiSchema>;

/** Named members of {@link estadoRastreioLiSchema} — see `delfrance/prefer-schema-enum`. */
export const ESTADO_RASTREIO_LI = {
  postado: ESTADO_FRETE.postado,
  entregue: ESTADO_FRETE.entregue,
  aguardandoRetirada: ESTADO_FRETE.aguardandoRetirada,
} as const satisfies Record<string, EstadoRastreioLi>;

/** A sha256 digest in lowercase hex: a pedido id, an event id. */
export const DIGEST_HEX_LI_REGEX = /^[0-9a-f]{64}$/;

/**
 * The wire fields, shared by the persisted document and the task payload (the
 * app's task schema is `z.object(camposNotificacaoEscritaLi())`), so the two
 * cannot drift. A FUNCTION returning fresh builders, the
 * `notificationResilienceFields` shape — never a `{ schema, meta }` value
 * (`registry.test.ts`).
 *
 *  - `pedidoId` — the pedido the event belongs to (a digest: imported pedidos'
 *    ids are);
 *  - `evento` — the event's own id, a digest of its source (the document id);
 *  - `estado` — the freight estado the event recorded;
 *  - `eventoEmMs` — when the event happened, in MILLISECONDS (the source row's
 *    own stamp): the aviso's clock.
 */
export function camposNotificacaoEscritaLi() {
  return {
    tipo: tipoTarefaEscritaLiSchema,
    contaId: contaIdLiSchema,
    numero: numeroPedidoLiSchema,
    pedidoId: z.string().regex(DIGEST_HEX_LI_REGEX),
    evento: z.string().regex(DIGEST_HEX_LI_REGEX),
    estado: estadoRastreioLiSchema,
    eventoEmMs: z.number().int().positive().refine(Number.isSafeInteger, {
      message: 'eventoEmMs acima de 2^53 - 1',
    }),
  };
}

export const notificacaoEscritaLojaIntegradaSchema = z.object({
  ...camposNotificacaoEscritaLi(),
  // ---- Local resilience fields (shared; not on any provider's wire) -------
  // Written/read blind by the pipeline in `@delfrance/data/admin/notifications`.
  ...notificationResilienceFields(),
});

export type NotificacaoEscritaLojaIntegrada = z.infer<typeof notificacaoEscritaLojaIntegradaSchema>;
