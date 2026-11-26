/**
 * The shared outcome watermark's two price-only parameters (step 13, PR 13-d),
 * pure: the same-send refinement and the future tolerance can only REPLACE an
 * entry the rule keeps, and with both ABSENT (the stock binding) every input
 * decides exactly as the rule alone.
 */
import { describe, expect, it } from 'vitest';

import { decidirGravacaoEnvioEstoque, envioDoPatch } from '../estoque/envioEstoque';
import {
  GRAVACAO_ENVIO_LISTING_AMAZON,
  classificarGravacaoEnvioListing,
  decidirGravacaoEnvioListing,
  marcaDaguaEnvioListing,
} from './envioListing';

const T = 1_800_000_000_000;

describe('★ the two price parameters (step 13, PR 13-d): each can only REPLACE an entry the rule keeps', () => {
  const MINUTO = 60_000;
  const TOLERANCIA = 5 * MINUTO;
  const envio = (emMs: number, extra: Record<string, unknown> = {}) => ({
    via: 'patch',
    emMs,
    resultado: 'aceito',
    submissionId: 'sub-1',
    ...extra,
  });
  const PRECO = { refinaMesmoEnvio: true, futuroToleradoMs: TOLERANCIA, agoraMs: T } as const;

  it('★ refinaMesmoEnvio: the SAME send (equal emMs, both patch, the same submissionId) replaces the stored', () => {
    const guardado = envio(T, { resultado: 'aceito' });
    const refino = envio(T, { resultado: 'recusado' });
    expect(classificarGravacaoEnvioListing(guardado, refino, PRECO)).toBe(
      GRAVACAO_ENVIO_LISTING_AMAZON.mesmoEnvio,
    );
    expect(decidirGravacaoEnvioListing(guardado, refino, PRECO)).toBe(true);
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['another submissionId', {}, { submissionId: 'sub-2' }],
    [
      'no submissionId on either side (an incerto record)',
      { submissionId: null },
      { submissionId: null },
    ],
    ['an empty submissionId', { submissionId: '' }, { submissionId: '' }],
    ['the incoming one a feed', {}, { via: 'feed' }],
    ['the stored one a feed', { via: 'feed' }, {}],
  ])('NEAR-MISS: %s ⇒ the equal emMs keeps the stored', (_c, doGuardado, doNovo) => {
    expect(decidirGravacaoEnvioListing(envio(T, doGuardado), envio(T, doNovo), PRECO)).toBe(false);
  });

  it('NEAR-MISS: the same send with a NEWER stored emMs is kept (a refinement never goes back in time)', () => {
    expect(decidirGravacaoEnvioListing(envio(T + 1), envio(T), PRECO)).toBe(false);
  });

  it('★ futuroToleradoMs: a stored emMs 10 min ahead of the clock is no watermark (futuro-ignorado); NEAR-MISS: 4 min ahead is kept', () => {
    expect(classificarGravacaoEnvioListing({ emMs: T + 10 * MINUTO }, envio(T), PRECO)).toBe(
      GRAVACAO_ENVIO_LISTING_AMAZON.futuroIgnorado,
    );
    expect(decidirGravacaoEnvioListing({ emMs: T + 4 * MINUTO }, envio(T), PRECO)).toBe(false);
    // The bound itself is still a watermark; one ms past it is not.
    expect(decidirGravacaoEnvioListing({ emMs: T + TOLERANCIA }, envio(T), PRECO)).toBe(false);
    expect(decidirGravacaoEnvioListing({ emMs: T + TOLERANCIA + 1 }, envio(T), PRECO)).toBe(true);
  });

  it('★ PARITY: with the parameters ABSENT (stock’s binding) every input decides exactly as the rule alone', () => {
    const casos: [unknown, ReturnType<typeof envio>][] = [
      [envio(T, { resultado: 'aceito' }), envio(T, { resultado: 'recusado' })],
      [{ emMs: T + 10 * MINUTO }, envio(T)],
      [{ emMs: T - 1 }, envio(T)],
      [{ emMs: T }, envio(T)],
      [null, envio(T)],
    ];
    for (const [guardado, novo] of casos) {
      const regra = guardado === null ? true : (guardado as { emMs: number }).emMs < novo.emMs;
      expect(decidirGravacaoEnvioListing(guardado, novo)).toBe(regra);
      expect(decidirGravacaoEnvioListing(guardado, novo, {})).toBe(regra);
    }
    // The stock binding answers the same: it passes neither parameter.
    const futuro = envioDoPatch({ status: 'ACCEPTED', submissionId: 's' }, T + 10 * MINUTO, 3);
    const agora = envioDoPatch({ status: 'ACCEPTED', submissionId: 's' }, T, 3);
    expect(decidirGravacaoEnvioEstoque(futuro, agora)).toBe(false);
    const recusado = envioDoPatch({ status: 'INVALID', submissionId: 's' }, T, 3);
    expect(decidirGravacaoEnvioEstoque(agora, recusado)).toBe(false);
  });

  it('a strictly older stored is replaced under every combination of the parameters', () => {
    for (const parametros of [{}, { refinaMesmoEnvio: true }, PRECO]) {
      expect(classificarGravacaoEnvioListing({ emMs: T - 1 }, envio(T), parametros)).toBe(
        GRAVACAO_ENVIO_LISTING_AMAZON.maisNovo,
      );
    }
  });

  it('futuroToleradoMs without a clock is a wiring bug: RangeError', () => {
    expect(() =>
      classificarGravacaoEnvioListing({ emMs: T }, envio(T), { futuroToleradoMs: TOLERANCIA }),
    ).toThrow(RangeError);
    expect(() =>
      classificarGravacaoEnvioListing({ emMs: T }, envio(T), { futuroToleradoMs: -1, agoraMs: T }),
    ).toThrow(RangeError);
    expect(() => marcaDaguaEnvioListing({ emMs: T }, { futuroToleradoMs: TOLERANCIA })).toThrow(
      RangeError,
    );
  });

  it('★ marcaDaguaEnvioListing: the RAW stored emMs the decision compares with, whatever else the entry holds', () => {
    // An entry no outcome schema would take still keeps a new outcome out by its emMs.
    expect(marcaDaguaEnvioListing({ emMs: T + 2 * MINUTO, resultado: '?' }, PRECO)).toBe(
      T + 2 * MINUTO,
    );
    expect(marcaDaguaEnvioListing(envio(T - 5))).toBe(T - 5);
    // NEAR-MISS: what the decision cannot read is no watermark.
    for (const ilegivel of [null, undefined, 'x', {}, { emMs: '1' }, { emMs: -1 }, { emMs: 1.5 }]) {
      expect(marcaDaguaEnvioListing(ilegivel, PRECO), JSON.stringify(ilegivel)).toBeNull();
    }
    // The tolerance: the bound itself is a watermark, one ms past it is set aside — and without
    // the parameter (stock's binding) a far-future value is still one.
    expect(marcaDaguaEnvioListing({ emMs: T + TOLERANCIA }, PRECO)).toBe(T + TOLERANCIA);
    expect(marcaDaguaEnvioListing({ emMs: T + TOLERANCIA + 1 }, PRECO)).toBeNull();
    expect(marcaDaguaEnvioListing({ emMs: T + 10 * MINUTO })).toBe(T + 10 * MINUTO);
  });

  it('★ marcaDaguaEnvioListing and the decision agree: a new outcome is kept out EXACTLY when the watermark is at or past it (no refinement)', () => {
    const guardados: unknown[] = [
      null,
      { emMs: 'x' },
      { emMs: T - 1 },
      { emMs: T },
      { emMs: T + 1 },
      { emMs: T + TOLERANCIA },
      { emMs: T + TOLERANCIA + 1 },
      { emMs: T + 10 * MINUTO, via: 'patch' },
    ];
    for (const parametros of [{}, { futuroToleradoMs: TOLERANCIA, agoraMs: T }]) {
      for (const guardado of guardados) {
        for (const emMs of [T - 1, T, T + 1, T + TOLERANCIA + 1]) {
          const marca = marcaDaguaEnvioListing(guardado, parametros);
          const mantido =
            classificarGravacaoEnvioListing(guardado, { emMs }, parametros) ===
            GRAVACAO_ENVIO_LISTING_AMAZON.manter;
          expect(mantido, `${JSON.stringify(guardado)} ${emMs}`).toBe(
            marca !== null && marca >= emMs,
          );
        }
      }
    }
  });
});
