/**
 * The outcome WRITE-BACK of the Amazon listings flows (step 13, PR 13-b): one
 * outcome written onto every link doc of ONE SKU, under its flow's own field
 * (`CAMPO_ENVIO_LISTING_AMAZON`, `vinculoListing.ts`), under rule 7's tier 2
 * through a tier-1 precondition. ONE loop for every flow; a flow binds it with
 * {@link CampoEnvioListingAmazon} (its flow, which names the field, and the
 * field's schema). The stock flow's binding is `estoque/envioEstoqueFirestore.ts`.
 *
 * ## One attempt
 *
 *  1. ONE `getAll` of the SKU's link docs, masked to the flow's field ALONE (a
 *     link doc carries a whole product payload, and another flow's outcome; a
 *     masked snapshot still carries the `updateTime` the precondition needs).
 *     By id: no index.
 *  2. Per document, `decidirGravacaoEnvioListing(stored, new)`
 *     (`envioListing.ts`): the stored outcome is replaced only by a STRICTLY
 *     newer `emMs` (an equal one keeps the stored), so a report read hours later
 *     never overwrites a later send's outcome, and the winner always writes its
 *     own `emMs` (the watermark advances).
 *  3. `update({ <field>: outcome }, { lastUpdateTime })` on THAT snapshot's
 *     `updateTime`, the outcome through the link handle's partial validation,
 *     then the field's own schema. Only that field is written.
 *
 * A precondition lost (9), or the document gone since the read (5), sends that
 * document to the next attempt, which RE-READS and RE-DECIDES — never re-sends
 * the decision that lost. At most {@link MAX_TENTATIVAS_ENVIO_LISTING_AMAZON}
 * attempts; a document still losing after them is left as the winner wrote it,
 * with ONE WARNING for the whole call, never a throw: the write-back runs after
 * the write it records, and a throw there would read as the write failing. A
 * document that does not exist is skipped (counted `ausentes`): a link removed
 * since the verdict has no outcome to hold. Any other failure is rethrown
 * untouched (root rule 6); the caller's no-throw boundary decides what it
 * costs.
 *
 * ## The units
 *
 * `emMs` is MILLISECONDS, our own submission instant. A value more than
 * {@link ADIANTAMENTO_MAXIMO_ENVIO_LISTING_AMAZON_MS} ahead of the caller's
 * `agoraMs` is refused as a `RangeError` before anything is read: a
 * microsecond value (or any far-future one) stored once would win every later
 * comparison and drop every later write-back of that link.
 *
 * ## What it answers
 *
 * The counts, and `relogio`: the read time of the LAST link-doc read — the
 * Firestore clock of an aviso this outcome raises (`avisos/avisos.ts` converts
 * it; this module never does). `null` only when no link was named.
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import type { z } from 'zod';
import { produtoAmazonLinkCollection } from '@delfrance/data/admin/collections';
import { isFailedPrecondition, isNotFound } from '@delfrance/data/admin/grpcErrors';
import { naoDocId } from '@delfrance/schemas';

import { type LoggerAmazon, registrarEventoAmazon } from '../core/log';
import { type EnvioComRelogioListingAmazon, decidirGravacaoEnvioListing } from './envioListing';
import type { FluxoListingAmazon } from './fluxoListing';
import { CAMPO_ENVIO_LISTING_AMAZON } from './vinculoListing';

/** The most read-decide-write attempts per document (module header). */
export const MAX_TENTATIVAS_ENVIO_LISTING_AMAZON = 3;

/**
 * The furthest an outcome's `emMs` may sit AHEAD of the caller's clock: 24
 * hours (module header, "The units"). A clock that ran ahead is off by
 * seconds; a µs value is about a thousand times ahead.
 */
export const ADIANTAMENTO_MAXIMO_ENVIO_LISTING_AMAZON_MS = 86_400_000;

/** The WARNING's motivo: a document still losing its precondition after every attempt. */
export const MOTIVO_GRAVACAO_ENVIO_LISTING_EM_CONFLITO = 'gravacao-em-conflito';

/** What the write-back reads of an outcome: its clock, and the two codes its WARNING names. */
export interface EnvioGravavelListingAmazon extends EnvioComRelogioListingAmazon {
  readonly via: string;
  readonly resultado: string;
}

/** How a flow binds the write-back: its flow (which names the field), the field's schema, its module. */
export interface CampoEnvioListingAmazon<E extends EnvioGravavelListingAmazon> {
  readonly fluxo: FluxoListingAmazon;
  /** The outcome's own schema: what the field holds. */
  readonly schema: z.ZodType<E>;
  /** The binding's module, as its refusals name it. */
  readonly rotulo: string;
}

/** One link doc of the SKU: the produto it sits under (from its path) and its id. */
export interface LinkDoEnvioListingAmazon {
  readonly produtoId: string;
  readonly linkId: string;
}

/** What {@link gravarEnvioListingAmazon} is handed. */
export interface EntradaGravacaoEnvioListingAmazon<E extends EnvioGravavelListingAmazon> {
  readonly contaId: string;
  readonly sku: string;
  /** Every link doc of the SKU the outcome belongs on (repeats are read once). */
  readonly links: readonly LinkDoEnvioListingAmazon[];
  readonly envio: E;
  /** ms — the caller's clock, for the unit guard only (module header). */
  readonly agoraMs: number;
}

/** What {@link gravarEnvioListingAmazon} did (module header). */
export interface ResultadoGravacaoEnvioListingAmazon {
  /** The read time of the last link-doc read; `null` when no link was named. */
  readonly relogio: Timestamp | null;
  /** Documents that now hold this outcome. */
  readonly gravados: number;
  /** Documents whose stored outcome is as new or newer: kept. */
  readonly mantidos: number;
  /** Documents that do not exist. */
  readonly ausentes: number;
  /** Documents still losing their precondition after every attempt (one WARNING). */
  readonly emConflito: number;
}

/**
 * Write `entrada.envio` onto every link doc of the SKU, under the flow's field
 * (module header).
 *
 * @throws {RangeError} a link id or produto id that is not a document id, or an
 *   `emMs` more than {@link ADIANTAMENTO_MAXIMO_ENVIO_LISTING_AMAZON_MS} ahead
 *   of `agoraMs` (nothing read).
 * @throws {ZodError} an outcome the field's schema or the link schema refuses
 *   (nothing written).
 */
export async function gravarEnvioListingAmazon<E extends EnvioGravavelListingAmazon>(
  db: Firestore,
  campoDoEnvio: CampoEnvioListingAmazon<E>,
  entrada: EntradaGravacaoEnvioListingAmazon<E>,
  deps: { readonly logger: LoggerAmazon },
): Promise<ResultadoGravacaoEnvioListingAmazon> {
  const { envio } = entrada;
  const { fluxo, rotulo } = campoDoEnvio;
  const campo = CAMPO_ENVIO_LISTING_AMAZON[fluxo];
  if (envio.emMs - entrada.agoraMs > ADIANTAMENTO_MAXIMO_ENVIO_LISTING_AMAZON_MS) {
    throw new RangeError(`${rotulo}: emMs à frente do relógio (microssegundos no lugar de ms?)`);
  }
  const porCaminho = new Map<string, LinkDoEnvioListingAmazon>();
  for (const link of entrada.links) {
    if (naoDocId(link.produtoId) || naoDocId(link.linkId)) {
      throw new RangeError(`${rotulo}: produtoId ou linkId não é um id de documento`);
    }
    porCaminho.set(`${link.produtoId}/${link.linkId}`, link);
  }
  // The link handle's partial validation FIRST (a field it models refuses there,
  // its issues under the field's key), then the field's own schema, which holds
  // a field the link schema does not model yet.
  const mesclado = produtoAmazonLinkCollection.parseMerge({ [campo]: envio });
  const patch = { [campo]: campoDoEnvio.schema.parse(mesclado[campo]) };

  let pendentes = [...porCaminho.values()];
  let relogio: Timestamp | null = null;
  let gravados = 0;
  let mantidos = 0;
  let ausentes = 0;
  for (
    let tentativa = 1;
    tentativa <= MAX_TENTATIVAS_ENVIO_LISTING_AMAZON && pendentes.length > 0;
    tentativa += 1
  ) {
    const refs = pendentes.map((l) =>
      produtoAmazonLinkCollection.docRef(db, { produtoId: l.produtoId }, l.linkId),
    );
    const snaps = await db.getAll(...refs, { fieldMask: [campo] });
    relogio = snaps[0]?.readTime ?? relogio;
    const perdidos: LinkDoEnvioListingAmazon[] = [];
    for (const [i, link] of pendentes.entries()) {
      const snap = snaps[i];
      const ref = refs[i];
      if (snap?.exists !== true || snap.updateTime === undefined || ref === undefined) {
        ausentes += 1;
        continue;
      }
      // ⚠️ Decided from THIS attempt's read, never carried over from a lost one.
      const armazenado: unknown = (snap.data() ?? {})[campo];
      if (!decidirGravacaoEnvioListing(armazenado ?? null, envio)) {
        mantidos += 1;
        continue;
      }
      try {
        await ref.update(patch, { lastUpdateTime: snap.updateTime });
        gravados += 1;
      } catch (err) {
        // Rule 6: only a lost precondition (or the document gone since the
        // read) is re-decided; anything else propagates. The emulator answers
        // a precondition on a document deleted since the read with 9, not 5;
        // the NOT_FOUND arm stays defensive.
        if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
        perdidos.push(link);
      }
    }
    pendentes = perdidos;
  }
  if (pendentes.length > 0) {
    registrarEventoAmazon(
      deps.logger,
      fluxo,
      'WARNING',
      `[amazon] ${fluxo}: resultado do envio não gravado no vínculo (precondição perdida)`,
      {
        fase: 'gravacao-envio',
        motivo: MOTIVO_GRAVACAO_ENVIO_LISTING_EM_CONFLITO,
        sku: entrada.sku,
        via: envio.via,
        resultado: envio.resultado,
        vinculos: pendentes.length,
        tentativas: MAX_TENTATIVAS_ENVIO_LISTING_AMAZON,
      },
      { conta: entrada.contaId, fluxo },
    );
  }
  return { relogio, gravados, mantidos, ausentes, emConflito: pendentes.length };
}
