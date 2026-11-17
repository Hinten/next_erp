import { FieldValue } from 'firebase-admin/firestore';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { nfeMeta } from '@delfrance/schemas';

import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';
import { tratarEscritaNfeAmazon } from '../../lib/amazon/nfe/gatilhoNfe';
import { criarAgendadorNfeAmazonDoAmbiente } from './agendadorNfe';
import { getDb } from './lib/admin';

/**
 * The NF-e trigger of the Amazon channel (master plan step 14, PR 14-c) — the
 * codebase's SECOND Firestore trigger, and the first producer of the NF-e
 * queue `processAmazonNfeUpload`. The ladder (T1–T5 and the a→c arm) is
 * `lib/amazon/nfe/gatilhoNfe.ts`; this file only binds the deps and hands the
 * raw snapshot bodies and the CloudEvent id over.
 *
 * ⚠️ **The export is `onNfeAprovadaAmazon`, never `onNfeAprovada`**: Mercado
 * Livre's codebase deploys a function of that name into the same project, and
 * Shopee's is `onNfeAprovadaShopee` (`functions-export-names.test.js` refuses a
 * repeated name across codebases).
 *
 * ⚠️ The FOURTH function on `pedidos/{pedidoId}/nfev4/{nfeId}` (Mercado Livre's,
 * Shopee's and `apps/functions`' `onNfeDeleted` are the other three), so EVERY
 * `nfev4` write of the project fires it: the body's first rung costs zero reads
 * and logs nothing outside its two edges.
 *
 * `event.id` is handed to the body because it NAMES the trigger's one enqueue
 * (`sha256Hex(event.id)`): Eventarc redelivers the SAME CloudEvent id, so a
 * redelivery meets Cloud Tasks' refusal of a held id and enqueues nothing new.
 *
 * ⚠️ Targets the NAMED `default` database (`FIREBASE_DATABASE_ID ?? 'default'`,
 * defined at build time by `build.mjs`; `onIntegracaoAmazonChanged.ts`'s
 * docblock has why): a trigger bound to `(default)` deploys fine and never
 * fires. `index.test.ts` pins the analysed endpoint.
 *
 * No `region:` — `options.ts` sets it globally (`index.ts` imports it first).
 * `retry: true` — Eventarc at-least-once for what the body rethrows (a
 * transient enqueue, a missing region, a Firestore failure); the named enqueue
 * makes a redelivery harmless. NO `secrets:` — this trigger never calls Amazon
 * (D11), and a needless binding is one more Secret Manager grant that can fail
 * the deploy. No memory or timeout of its own.
 *
 * D11 BY CONSTRUCTION: this file's import closure, with its composition root
 * `./agendadorNfe`, is pinned file by file (`lib/amazon/estrutura.test.ts`).
 */
export const onNfeAprovadaAmazon = onDocumentWritten(
  {
    // The meta, never a literal: `pedidos/{pedidoId}/nfev4`.
    document: `${nfeMeta.collectionPath}/{nfeId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    retry: true,
    // ⚠️ No `region:` (options.ts), no `secrets:` (no Amazon call, D11), no memory/timeout.
  },
  async (event) => {
    // The middle `{pedidoId}` wildcard sits inside the meta-derived prefix, so
    // its type is not inferred into `event.params` — both are present at runtime.
    const { pedidoId, nfeId } = event.params as { pedidoId: string; nfeId: string };
    const before = event.data?.before.exists
      ? (event.data.before.data() as Record<string, unknown>)
      : undefined;
    const after = event.data?.after.exists
      ? (event.data.after.data() as Record<string, unknown>)
      : undefined;

    await tratarEscritaNfeAmazon(
      {
        db: getDb,
        agendador: criarAgendadorNfeAmazonDoAmbiente,
        logger: LOGGER_STDOUT_AMAZON,
        increment: (by: number) => FieldValue.increment(by),
        // Read ONLY on an aviso arm; the enqueue path holds no clock.
        agoraMs: () => Date.now(),
      },
      { eventId: event.id, pedidoId, nfeId, before, after },
    );
  },
);
