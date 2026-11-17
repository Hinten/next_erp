/**
 * The stock OUTCOME write-back of the Amazon stock sync (step 12, PR 12-e1):
 * one outcome (`envioEstoqueAmazon`, built by `envioEstoque.ts`) written onto
 * every link doc of ONE SKU, under rule 7's tier 2 through a tier-1
 * precondition.
 *
 * ## One attempt
 *
 *  1. ONE `getAll` of the SKU's link docs, masked to the outcome field alone
 *     (a link doc carries a whole product payload; a masked snapshot still
 *     carries the `updateTime` the precondition needs). By id: no index.
 *  2. Per document, `decidirGravacaoEnvioEstoque(stored, new)`: the stored
 *     outcome is replaced only by a STRICTLY newer `emMs` (an equal one keeps
 *     the stored), so a feed report read hours later never overwrites a later
 *     patch's outcome, and the winner always writes its own `emMs` (the
 *     watermark advances).
 *  3. `update({ envioEstoqueAmazon }, { lastUpdateTime })` on THAT snapshot's
 *     `updateTime`, through the link handle's partial validation.
 *
 * A precondition lost (9), or the document gone since the read (5), sends that
 * document to the next attempt, which RE-READS and RE-DECIDES — never re-sends
 * the decision that lost. At most {@link MAX_TENTATIVAS_ENVIO_ESTOQUE_AMAZON}
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
 * `ADIANTAMENTO_MAXIMO_MS` ahead of the caller's `agoraMs` is refused as a
 * `RangeError` before anything is read: a microsecond value (or any far-future
 * one) stored once would win every later comparison and drop every later
 * write-back of that link.
 *
 * ## What it answers
 *
 * The counts, and `relogio`: the read time of the LAST link-doc read — the
 * Firestore clock of an aviso this outcome raises (`avisos/avisos.ts` converts
 * it; this module never does). `null` only when no link was named.
 *
 * Writes only the outcome field, and only on link docs.
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { produtoAmazonLinkCollection } from '@delfrance/data/admin/collections';
import { isFailedPrecondition, isNotFound } from '@delfrance/data/admin/grpcErrors';
import {
  type EnvioEstoqueAmazon,
  naoDocId,
  type produtoAmazonLinkSchema,
} from '@delfrance/schemas';

import { type LoggerAmazon, registrarEventoAmazon } from '../core/log';
import { ADIANTAMENTO_MAXIMO_MS } from './descobertaEstoque';
import { decidirGravacaoEnvioEstoque } from './envioEstoque';

/** The ONE link field this module reads and writes. */
export const CAMPO_ENVIO_ESTOQUE_AMAZON =
  'envioEstoqueAmazon' as const satisfies keyof typeof produtoAmazonLinkSchema.shape;

/** The most read-decide-write attempts per document (module header). */
export const MAX_TENTATIVAS_ENVIO_ESTOQUE_AMAZON = 3;

/** The WARNING's motivo: a document still losing its precondition after every attempt. */
export const MOTIVO_GRAVACAO_ENVIO_EM_CONFLITO = 'gravacao-em-conflito';

/** One link doc of the SKU: the produto it sits under (from its path) and its id. */
export interface LinkDoEnvioEstoqueAmazon {
  readonly produtoId: string;
  readonly linkId: string;
}

/** What {@link gravarEnvioEstoqueAmazon} is handed. */
export interface EntradaGravacaoEnvioEstoqueAmazon {
  readonly contaId: string;
  readonly sku: string;
  /** Every link doc of the SKU the outcome belongs on (repeats are read once). */
  readonly links: readonly LinkDoEnvioEstoqueAmazon[];
  readonly envio: EnvioEstoqueAmazon;
  /** ms — the caller's clock, for the unit guard only (module header). */
  readonly agoraMs: number;
}

/** What {@link gravarEnvioEstoqueAmazon} did (module header). */
export interface ResultadoGravacaoEnvioEstoqueAmazon {
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
 * Write `entrada.envio` onto every link doc of the SKU (module header).
 *
 * @throws {RangeError} a link id or produto id that is not a document id, or an
 *   `emMs` more than `ADIANTAMENTO_MAXIMO_MS` ahead of `agoraMs` (nothing read).
 * @throws {ZodError} an outcome the link schema refuses (nothing written).
 */
export async function gravarEnvioEstoqueAmazon(
  db: Firestore,
  entrada: EntradaGravacaoEnvioEstoqueAmazon,
  deps: { readonly logger: LoggerAmazon },
): Promise<ResultadoGravacaoEnvioEstoqueAmazon> {
  const { envio } = entrada;
  if (envio.emMs - entrada.agoraMs > ADIANTAMENTO_MAXIMO_MS) {
    throw new RangeError(
      'envioEstoqueFirestore.ts: emMs à frente do relógio (microssegundos no lugar de ms?)',
    );
  }
  const porCaminho = new Map<string, LinkDoEnvioEstoqueAmazon>();
  for (const link of entrada.links) {
    if (naoDocId(link.produtoId) || naoDocId(link.linkId)) {
      throw new RangeError(
        'envioEstoqueFirestore.ts: produtoId ou linkId não é um id de documento',
      );
    }
    porCaminho.set(`${link.produtoId}/${link.linkId}`, link);
  }
  const patch = produtoAmazonLinkCollection.parseMerge({ [CAMPO_ENVIO_ESTOQUE_AMAZON]: envio });

  let pendentes = [...porCaminho.values()];
  let relogio: Timestamp | null = null;
  let gravados = 0;
  let mantidos = 0;
  let ausentes = 0;
  for (
    let tentativa = 1;
    tentativa <= MAX_TENTATIVAS_ENVIO_ESTOQUE_AMAZON && pendentes.length > 0;
    tentativa += 1
  ) {
    const refs = pendentes.map((l) =>
      produtoAmazonLinkCollection.docRef(db, { produtoId: l.produtoId }, l.linkId),
    );
    const snaps = await db.getAll(...refs, { fieldMask: [CAMPO_ENVIO_ESTOQUE_AMAZON] });
    relogio = snaps[0]?.readTime ?? relogio;
    const perdidos: LinkDoEnvioEstoqueAmazon[] = [];
    for (const [i, link] of pendentes.entries()) {
      const snap = snaps[i];
      const ref = refs[i];
      if (snap?.exists !== true || snap.updateTime === undefined || ref === undefined) {
        ausentes += 1;
        continue;
      }
      // ⚠️ Decided from THIS attempt's read, never carried over from a lost one.
      const armazenado: unknown = (snap.data() ?? {})[CAMPO_ENVIO_ESTOQUE_AMAZON];
      if (!decidirGravacaoEnvioEstoque(armazenado ?? null, envio)) {
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
      'estoque',
      'WARNING',
      '[amazon] estoque: resultado do envio não gravado no vínculo (precondição perdida)',
      {
        fase: 'gravacao-envio',
        motivo: MOTIVO_GRAVACAO_ENVIO_EM_CONFLITO,
        sku: entrada.sku,
        via: envio.via,
        resultado: envio.resultado,
        vinculos: pendentes.length,
        tentativas: MAX_TENTATIVAS_ENVIO_ESTOQUE_AMAZON,
      },
      { conta: entrada.contaId, fluxo: 'estoque' },
    );
  }
  return { relogio, gravados, mantidos, ausentes, emConflito: pendentes.length };
}
