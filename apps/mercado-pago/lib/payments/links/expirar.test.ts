import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MercadoPagoHttpError,
  MercadoPagoNetworkError,
  type MercadoPagoApi,
} from '@delfrance/integrations-mercado-pago';

import { AGORA_MS } from './testing/suporte';
import { expirarPreferencia, expirarPreferencias, expirePatch } from './expirar';

/** The fallback body: the full patch minus `date_of_expiration`. */
const SEM_PRAZO_OFFLINE = {
  expires: true,
  expiration_date_to: '2026-09-29T12:00:00.000-03:00',
};

describe('expirePatch', () => {
  it('moves BOTH deadlines to now, with an explicit offset and never Z', () => {
    expect(expirePatch(AGORA_MS)).toEqual({
      expires: true,
      expiration_date_to: '2026-09-29T12:00:00.000-03:00',
      date_of_expiration: '2026-09-29T12:00:00.000-03:00',
    });
  });

  it('uses the offset in force AT THAT INSTANT, not a constant', () => {
    // Brazil still observed daylight saving in the 2018 summer: -02:00.
    expect(expirePatch(Date.UTC(2018, 11, 1, 15, 0, 0)).expiration_date_to).toBe(
      '2018-12-01T13:00:00.000-02:00',
    );
  });
});

describe('expirarPreferencia — the 400 fallback', () => {
  let api: { updatePreference: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api = { updatePreference: vi.fn(async (id: string) => ({ id, init_point: 'x' })) };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const comoApi = () => api as unknown as Pick<MercadoPagoApi, 'updatePreference'>;

  it('sends the FULL patch once, and nothing more, when Mercado Pago accepts it', async () => {
    await expirarPreferencia(comoApi(), 'p1', AGORA_MS);
    expect(api.updatePreference.mock.calls).toEqual([['p1', expirePatch(AGORA_MS)]]);
  });

  it('retries a 400 ONCE without date_of_expiration, and resolves when that is accepted', async () => {
    api.updatePreference.mockRejectedValueOnce(new MercadoPagoHttpError('MP 400', 400, {}));
    await expect(expirarPreferencia(comoApi(), 'p1', AGORA_MS)).resolves.toBeUndefined();
    expect(api.updatePreference.mock.calls).toEqual([
      ['p1', expirePatch(AGORA_MS)],
      ['p1', SEM_PRAZO_OFFLINE],
    ]);
    expect(api.updatePreference.mock.calls[1]![1]).not.toHaveProperty('date_of_expiration');
  });

  it('throws the RETRY’s error when the fallback is refused too — never a third PUT', async () => {
    const segunda = new MercadoPagoHttpError('MP 400 de novo', 400, {});
    api.updatePreference
      .mockRejectedValueOnce(new MercadoPagoHttpError('MP 400', 400, {}))
      .mockRejectedValueOnce(segunda);
    await expect(expirarPreferencia(comoApi(), 'p1', AGORA_MS)).rejects.toBe(segunda);
    expect(api.updatePreference).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a 403', new MercadoPagoHttpError('MP 403', 403, {})],
    ['a 404', new MercadoPagoHttpError('MP 404', 404, {})],
    ['a 500', new MercadoPagoHttpError('MP 500', 500, {})],
    ['a network failure', new MercadoPagoNetworkError('sem rede')],
  ])('does NOT retry %s: it is rethrown as it came', async (_nome, erro) => {
    api.updatePreference.mockRejectedValueOnce(erro);
    await expect(expirarPreferencia(comoApi(), 'p1', AGORA_MS)).rejects.toBe(erro);
    expect(api.updatePreference).toHaveBeenCalledTimes(1);
  });
});

describe('expirarPreferencias', () => {
  let api: { updatePreference: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api = { updatePreference: vi.fn(async (id: string) => ({ id, init_point: 'x' })) };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const comoApi = () => api as unknown as Pick<MercadoPagoApi, 'updatePreference'>;

  it('expires every preference with the same patch', async () => {
    await expirarPreferencias(comoApi(), ['p1', 'p2', 'p3'], AGORA_MS);
    expect(api.updatePreference.mock.calls).toEqual([
      ['p1', expirePatch(AGORA_MS)],
      ['p2', expirePatch(AGORA_MS)],
      ['p3', expirePatch(AGORA_MS)],
    ]);
  });

  it('does nothing for an empty list', async () => {
    await expirarPreferencias(comoApi(), [], AGORA_MS);
    expect(api.updatePreference).not.toHaveBeenCalled();
  });

  it('keeps going, and never throws, when some expiries fail', async () => {
    api.updatePreference
      .mockRejectedValueOnce(new MercadoPagoHttpError('MP 500', 500, {}))
      .mockResolvedValueOnce({ id: 'p2', init_point: 'x' })
      .mockRejectedValueOnce(new MercadoPagoNetworkError('sem rede'));

    const execucao = expirarPreferencias(comoApi(), ['p1', 'p2', 'p3'], AGORA_MS);
    await expect(execucao).resolves.toBeUndefined();

    expect(api.updatePreference).toHaveBeenCalledTimes(3);
    const logados = vi.mocked(console.error).mock.calls.map(([, detalhe]) => detalhe);
    expect(logados).toEqual([
      expect.objectContaining({ preferenceId: 'p1', motivo: 'MP 500' }),
      expect.objectContaining({ preferenceId: 'p3' }),
    ]);
  });

  it('applies the 400 fallback to an orphan too, so it does not stay payable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.updatePreference.mockRejectedValueOnce(new MercadoPagoHttpError('MP 400', 400, {}));
    await expirarPreferencias(comoApi(), ['p1'], AGORA_MS);
    expect(api.updatePreference.mock.calls).toEqual([
      ['p1', expirePatch(AGORA_MS)],
      ['p1', SEM_PRAZO_OFFLINE],
    ]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('logs nothing when every expiry succeeds', async () => {
    await expirarPreferencias(comoApi(), ['p1'], AGORA_MS);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('survives a rejection that is not an Error', async () => {
    api.updatePreference.mockRejectedValueOnce('texto solto');
    await expirarPreferencias(comoApi(), ['p1'], AGORA_MS);
    expect(vi.mocked(console.error).mock.calls[0]![1]).toMatchObject({
      preferenceId: 'p1',
      motivo: 'erro desconhecido',
    });
  });
});
