import { z } from 'zod';
import type { CollectionMetadata } from '../../types';
import { millisSinceEpoch } from '../../shared/datetime';
import { estadoFreteSchema } from '../../shared/frete';
import { outerRefSchema } from '../../shared/outerRef';

// Shares the PEDIDO permission domain (audit trail of the parent order),
// duplicated locally exactly like the sibling `historicoEstadoPedido`.
const PERM_PEDIDO_READ = 1n << 16n;
const PERM_PEDIDO_WRITE = 1n << 17n;
const PERM_PEDIDO_DELETE = 1n << 18n;

/**
 * HistoricoAlteracaoFreteInicial — subcoleção
 * `pedidos/{pedidoId}/historicoFtIni`. The leaf name is the legacy constant
 * `HISTORICO_FRETE_INICIAL_COLLECTION = '<pedidos>/*​/historicoFtIni'`
 * (`.old/packages/pedido/lib/src/models.dart:27`) kept verbatim — the migrated
 * corpus is stored under that leaf name, so the abbreviation stays. Mirrors the legacy hand-model `HistoricoAlteracaoFreteInicial`
 * (`.old/packages/pedido/lib/src/models.dart:3889-3934`). One audit row per
 * `freteInicial.estado` transition of the parent pedido.
 *
 * Written EXCLUSIVELY by the `onPedidoChanged` Cloud Function
 * (`apps/functions/src/pedidos/registrarHistoricoPedido.ts`), which observes every
 * `pedidos/{pedidoId}` write no matter who made it — the Melhor Envio
 * order-status webhook, the `comprar` etiqueta route, `saveCheckout`, the admin
 * pedido reconcile, the Mercado Livre importers and the web Frete tab. Nothing
 * appends a row at the call site: that design was tried and rejected (PR #720).
 * A call-site append can only ever cover the writers someone remembered to
 * touch — which is precisely how the legacy trail ended up with rows from just
 * two of its writers.
 *
 * DATETIME UNIT — MILLISECONDS, deliberately diverging from the sibling
 * `historicoEstadoPedido` (µs) and from the repo-wide µs default. Legacy
 * production rows in THIS collection are ms: the generated Dart writer
 * serializes `data` through `maybeDateTimeToJson` →
 * `millisecondsSinceEpoch` (`.old/packages/global/lib/src/models/utils.dart:95`).
 * Firestore orders on the STORED value, so a µs row sorts ~1000× above every
 * legacy ms row; under the `limit: 50` defaultQuery below that would push the
 * entire legacy history off the first page and make the trail look like it
 * began the day this shipped. The tolerant `millisSinceEpoch` preprocess fixes
 * DISPLAY (it normalizes ms/µs/ISO/`Date` on read), never the sort key — the
 * unit written to disk is the only thing Firestore sorts on. Same reasoning,
 * same conclusion as `./checkout.ts`, which keeps ms "for byte-for-byte parity"
 * with the migrated corpus.
 * `historicoEstadoPedido` carries no such constraint — its rows have been µs
 * from the first write and there is no ms cohort to interleave with.
 *
 * `.passthrough()` is mandatory: legacy rows carry the base-model keys
 * `docId`/`createTime`/`updateTime`/`readTime`, which a strict object would
 * strip on read.
 */
export const historicoFreteInicialSchema = z
  .object({
    estado: estadoFreteSchema.describe('Estado do frete'),
    /**
     * Free-text failure note. LEGACY-ONLY in practice: the trigger is a
     * document observer with no access to whatever message caused the
     * transition, so it writes `null` on 100% of new rows. The only legacy
     * writer that ever filled it was the Shopee webhook
     * (`.old/packages/canais_de_venda/shopee/lib/src/tasks.dart:1084`, joining
     * `fail_message` + `fail_error`), and Shopee is not ported —
     * `packages/integrations/shopee` is a scaffold whose every operation throws
     * `ShopeeNotConfiguredError`. The field exists so those legacy rows keep
     * parsing and rendering.
     */
    obs: z.string().nullable().default(null).describe('Observação'),
    /**
     * `documents/usuarios/<uid>` of whoever caused the transition, or `null`
     * when no end user is behind it. The legacy model has NO such field — it
     * recorded only estado + data — but the new app has real actors to record:
     * `saveCheckout` and the web Frete tab are signed-in CLIENT writes, so the
     * trigger's auth context carries a uid there. Admin-SDK paths (webhooks,
     * marketplace import, scripts) correctly store `null` rather than guess —
     * see `resolveUsuarioOuterRef`.
     *
     * Adding a key is safe for the still-running Flutter reader: its generated
     * `fromJson` (`.old/packages/pedido/lib/src/models.g.dart:710-720`) reads
     * seven named keys and has no `checkKeys` call, so unknown keys are simply
     * ignored.
     */
    usuarioHistoricoFreteInicialOuterRef: outerRefSchema
      .nullable()
      .default(null)
      .describe('Usuário'),
    data: millisSinceEpoch('Data').nullable().default(null),
    /**
     * CloudEvent id of the pedido write that produced this row — also the
     * document id, which is what makes the at-least-once trigger idempotent.
     * Null on legacy rows written before the trigger existed.
     */
    eventId: z.string().nullable().default(null),
  })
  .passthrough();

export type HistoricoFreteInicial = z.infer<typeof historicoFreteInicialSchema>;

export const historicoFreteInicialMeta: CollectionMetadata = {
  collectionPath: 'pedidos/{pedidoId}/historicoFtIni',
  permissions: {
    read: PERM_PEDIDO_READ,
    write: PERM_PEDIDO_WRITE,
    delete: PERM_PEDIDO_DELETE,
  },
  // An audit trail the audited party can rewrite is not an audit trail: rules
  // deny every client create/update/delete (no `su` bypass), leaving the
  // `onPedidoChanged` trigger as the sole writer. Read stays open to
  // `d_pedido` read. Same posture as `historicoEstadoPedido`.
  serverOwned: true,
  // The freight-history read: newest-first, one page. Declared here so the
  // `defaultQuery.indexes` meta-test REQUIRES the matching
  // `historicoFtIni(data desc)` entry in firestore.indexes.json — on this
  // Enterprise edition an undeclared index means a per-pedido scan plus an
  // in-memory sort on every tab open, billed by data scanned.
  defaultQuery: {
    orderBy: [{ field: 'data', direction: 'desc' }],
    limit: 50,
  },
};

export const historicoFtIni = {
  schema: historicoFreteInicialSchema,
  meta: historicoFreteInicialMeta,
};
