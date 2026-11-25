/**
 * The outcome WATERMARK of the Amazon listings flows (step 13, PR 13-b), pure:
 * whether a new outcome replaces the one a link doc stores under its flow's
 * field (`CAMPO_ENVIO_LISTING_AMAZON`, `vinculoListing.ts`). ONE rule for every
 * flow; its reader and the preconditioned `update` are
 * `envioListingFirestore.ts`, and the stock flow binds both
 * (`estoque/envioEstoque.ts`, `estoque/envioEstoqueFirestore.ts`).
 *
 * ## Strictly newer wins
 *
 * {@link decidirGravacaoEnvioListing} writes iff nothing readable is stored or
 * the stored `emMs` is STRICTLY older than the new one; an EQUAL `emMs` keeps
 * the stored. `emMs` is OUR submission instant, in milliseconds, so a report
 * read hours after its submission never overwrites the outcome of a send
 * submitted after it, and the winner writes its own `emMs`: the watermark
 * always advances. A stored value whose `emMs` cannot be read (not an object,
 * or no non-negative safe integer there) is no watermark: the new outcome
 * replaces it.
 *
 * ## Two parameters, the price flow's (step 13, PR 13-d)
 *
 * Absent, they change nothing: the stock flow's binding passes neither, and
 * the rule above is all it gets. Each can only REPLACE an entry the rule above
 * would keep, never keep one it would replace:
 *
 *  - `refinaMesmoEnvio` — an incoming entry of the SAME send as the stored one
 *    replaces it: the same `emMs`, both `via: 'patch'`, and the same non-empty
 *    `submissionId`. That is a check after an accepted send writing Amazon's
 *    later verdict onto the entry the send left, which the equal `emMs` would
 *    otherwise keep. A `submissionId` absent on either side is no send's
 *    identity (an `incerto` record has none), so it refines nothing.
 *  - `futuroToleradoMs` — a stored `emMs` MORE than this ahead of the caller's
 *    clock (`agoraMs`) is no watermark: the link docs are writable by a
 *    client, and a forged far-future value would otherwise keep every later
 *    outcome of that link out. Up to the tolerance, a stored value ahead of
 *    the clock (a skewed writer) is a watermark as usual.
 *
 * {@link classificarGravacaoEnvioListing} answers WHY, so a writer can log the
 * ignored future value; {@link decidirGravacaoEnvioListing} is its boolean;
 * {@link marcaDaguaEnvioListing} answers the stored `emMs` the decision
 * compares with (the raw field, whatever the rest of the entry holds), so a
 * writer can place its own `emMs` past it.
 *
 * PURE: no Firestore, no clock, no network.
 */
import { VIA_ENVIO_ESTOQUE_AMAZON } from '@delfrance/schemas';

/** What the decision reads of an outcome: its clock, in ms. */
export interface EnvioComRelogioListingAmazon {
  readonly emMs: number;
}

/** What the same-send refinement also reads of the incoming outcome (module header). */
export interface EnvioRefinavelListingAmazon extends EnvioComRelogioListingAmazon {
  readonly via?: unknown;
  readonly submissionId?: unknown;
}

/** The price flow's two parameters of the decision (module header); absent, nothing changes. */
export interface ParametrosGravacaoEnvioListingAmazon {
  /** An incoming entry of the stored one's own send replaces it. */
  readonly refinaMesmoEnvio?: boolean;
  /** ms — a stored `emMs` more than this ahead of `agoraMs` is no watermark. */
  readonly futuroToleradoMs?: number;
  /** ms — the caller's clock: what `futuroToleradoMs` is measured from. */
  readonly agoraMs?: number;
}

/** Why the decision writes, or that it keeps the stored (module header). */
export type GravacaoEnvioListingAmazon = 'mais-novo' | 'futuro-ignorado' | 'mesmo-envio' | 'manter';

/** The closed set, so code names a member instead of spelling a slug. */
export const GRAVACAO_ENVIO_LISTING_AMAZON = {
  /** Nothing readable stored, or a STRICTLY older `emMs`. */
  maisNovo: 'mais-novo',
  /** The stored `emMs` sits further ahead of the clock than the tolerance. */
  futuroIgnorado: 'futuro-ignorado',
  /** The same send, refined. */
  mesmoEnvio: 'mesmo-envio',
  /** Equal or newer: the stored is kept. */
  manter: 'manter',
} as const satisfies Record<string, GravacaoEnvioListingAmazon>;

/** A readable ms instant: a non-negative safe integer. */
function msLegivel(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isSafeInteger(valor) && valor >= 0;
}

/** An OWN field of a plain object, or `undefined`. */
function campoArmazenado(armazenado: unknown, chave: string): unknown {
  if (typeof armazenado !== 'object' || armazenado === null) return undefined;
  return (armazenado as Readonly<Record<string, unknown>>)[chave];
}

/** A send's identity: a non-empty `submissionId`, or `null`. */
function idDoEnvio(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/** Whether `novo` is the stored entry's own send (module header, `refinaMesmoEnvio`). */
function mesmoEnvio(
  armazenado: unknown,
  emMsArmazenado: number,
  novo: EnvioRefinavelListingAmazon,
) {
  const id = idDoEnvio(campoArmazenado(armazenado, 'submissionId'));
  return (
    emMsArmazenado === novo.emMs &&
    campoArmazenado(armazenado, 'via') === VIA_ENVIO_ESTOQUE_AMAZON.patch &&
    novo.via === VIA_ENVIO_ESTOQUE_AMAZON.patch &&
    id !== null &&
    id === idDoEnvio(novo.submissionId)
  );
}

/** A wiring bug in the parameters: `futuroToleradoMs` without a clock, or either not in ms. */
function exigirParametros(parametros: ParametrosGravacaoEnvioListingAmazon): void {
  const { futuroToleradoMs, agoraMs } = parametros;
  if (futuroToleradoMs !== undefined && (!msLegivel(futuroToleradoMs) || !msLegivel(agoraMs))) {
    throw new RangeError('envioListing.ts: futuroToleradoMs pede agoraMs, ambos em ms');
  }
}

/** Whether a stored `emMs` sits further ahead of the clock than the tolerance (module header). */
function alemDoFuturoTolerado(
  anterior: number,
  parametros: ParametrosGravacaoEnvioListingAmazon,
): boolean {
  const { futuroToleradoMs, agoraMs } = parametros;
  return (
    futuroToleradoMs !== undefined && agoraMs !== undefined && anterior - agoraMs > futuroToleradoMs
  );
}

/**
 * The stored outcome's `emMs` while it is a WATERMARK under the parameters
 * (module header): the raw field when it is readable and no further ahead of
 * the clock than the tolerance, else `null`. Exactly what
 * {@link classificarGravacaoEnvioListing} keeps a new outcome out with: an
 * entry its flow's schema refuses still carries it.
 *
 * @throws {RangeError} as {@link classificarGravacaoEnvioListing}.
 */
export function marcaDaguaEnvioListing(
  armazenado: unknown,
  parametros: ParametrosGravacaoEnvioListingAmazon = {},
): number | null {
  exigirParametros(parametros);
  const anterior = campoArmazenado(armazenado, 'emMs');
  if (!msLegivel(anterior) || alemDoFuturoTolerado(anterior, parametros)) return null;
  return anterior;
}

/**
 * Why `novo` replaces the stored outcome, or that it does not (module header).
 *
 * @throws {RangeError} `futuroToleradoMs` without `agoraMs`, or either outside
 *   a non-negative safe integer (a wiring bug).
 */
export function classificarGravacaoEnvioListing(
  armazenado: unknown,
  novo: EnvioRefinavelListingAmazon,
  parametros: ParametrosGravacaoEnvioListingAmazon = {},
): GravacaoEnvioListingAmazon {
  exigirParametros(parametros);
  const anterior = campoArmazenado(armazenado, 'emMs');
  if (!msLegivel(anterior) || anterior < novo.emMs) return GRAVACAO_ENVIO_LISTING_AMAZON.maisNovo;
  if (alemDoFuturoTolerado(anterior, parametros)) {
    return GRAVACAO_ENVIO_LISTING_AMAZON.futuroIgnorado;
  }
  if (parametros.refinaMesmoEnvio === true && mesmoEnvio(armazenado, anterior, novo)) {
    return GRAVACAO_ENVIO_LISTING_AMAZON.mesmoEnvio;
  }
  return GRAVACAO_ENVIO_LISTING_AMAZON.manter;
}

/**
 * Whether `novo` replaces the stored outcome (module header): nothing readable
 * stored, or a STRICTLY older `emMs`. Equal keeps the stored — unless one of
 * the two parameters says otherwise.
 */
export function decidirGravacaoEnvioListing(
  armazenado: unknown,
  novo: EnvioRefinavelListingAmazon,
  parametros: ParametrosGravacaoEnvioListingAmazon = {},
): boolean {
  return (
    classificarGravacaoEnvioListing(armazenado, novo, parametros) !==
    GRAVACAO_ENVIO_LISTING_AMAZON.manter
  );
}
