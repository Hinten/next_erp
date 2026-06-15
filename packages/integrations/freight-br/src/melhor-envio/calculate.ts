/**
 * Build a `shipment/calculate` request from a list of volumes — pure
 * port of the legacy `calcularFretePacote` payload logic
 * (`.old/.../melhor_envio/lib/src/api/api.dart:415-456`):
 *
 *  - one volume → a single `package` object; many → a `volumes` array;
 *  - dimensions default to 20 cm and weight to 1 kg when absent;
 *  - `insurance_value` is included only when > 0;
 *  - empty input falls back to one default 20×20×20 / 1 kg volume (the
 *    legacy `inserirFreteCarrinho` tolerance) so a quote never 400s on a
 *    missing package.
 *
 * Browser-safe (no deps) — `apps/web` imports it to build the request it
 * sends through the freight HTTP client.
 */
import type { CalculateRequest, DimensionsWeight } from './types';

const DEFAULT_DIM = 20;
const DEFAULT_WEIGHT = 1;

/** Loose per-volume input (e.g. from `freteInicial.volumes`). */
export interface VolumeInput {
  readonly width?: number | null;
  readonly height?: number | null;
  readonly length?: number | null;
  /** Prefer gross weight; falls back to net, then 1 kg. */
  readonly weight?: number | null;
}

function normalizeVolume(v: VolumeInput): DimensionsWeight {
  return {
    width: v.width ?? DEFAULT_DIM,
    height: v.height ?? DEFAULT_DIM,
    length: v.length ?? DEFAULT_DIM,
    weight: v.weight ?? DEFAULT_WEIGHT,
  };
}

export interface BuildCalculateParams {
  readonly fromPostalCode: string;
  readonly toPostalCode: string;
  readonly volumes: ReadonlyArray<VolumeInput>;
  readonly insuranceValue?: number | null;
  readonly receipt?: boolean;
  readonly ownHand?: boolean;
}

export function buildCalculatePayload(params: BuildCalculateParams): CalculateRequest {
  const normalized =
    params.volumes.length > 0
      ? params.volumes.map(normalizeVolume)
      : [{ width: DEFAULT_DIM, height: DEFAULT_DIM, length: DEFAULT_DIM, weight: DEFAULT_WEIGHT }];

  const options: NonNullable<CalculateRequest['options']> = {
    receipt: params.receipt ?? false,
    own_hand: params.ownHand ?? false,
  };
  if (params.insuranceValue != null && params.insuranceValue > 0) {
    options.insurance_value = params.insuranceValue;
  }

  return {
    from: { postal_code: params.fromPostalCode },
    to: { postal_code: params.toPostalCode },
    ...(normalized.length === 1 ? { package: normalized[0] } : { volumes: normalized }),
    options,
  };
}
