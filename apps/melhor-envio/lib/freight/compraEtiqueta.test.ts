import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '@delfrance/data/testing';
import {
  MelhorEnvioError,
  MelhorEnvioHttpError,
  MelhorEnvioNetworkError,
  MelhorEnvioTimeoutError,
  MelhorEnvioValidationError,
  PRAZO_ME_MS,
  PRAZO_ME_TOKEN_MS,
} from '@delfrance/integrations-freight-br';

import {
  adquirirCompraEtiqueta,
  ancorarEtiqueta,
  COMPRA_ETIQUETA_JANELA_PAGA_MS,
  COMPRA_ETIQUETA_LEASE_MS,
  CompraEtiquetaAncoraMudouError,
  CompraEtiquetaJanelaEsgotadaError,
  CompraEtiquetaPossePerdidaError,
  ehDesfechoPagoIncerto,
  finalizarCompraEtiqueta,
  garantirPosseCompraEtiqueta,
  leaseDe,
  liberarCompraEtiqueta,
  type PosseCompraEtiqueta,
} from './compraEtiqueta';
import { FirestoreFake } from './testing/fakeFirestore';

const T0 = 1_780_000_000_000;
const PEDIDO = 'pedidos/ped-1';
const CLAIM = 'pedidos/ped-1/compraEtiqueta/current';

let fake: FirestoreFake;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  fake = new FirestoreFake();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  warn.mockRestore();
});

const db = () => fake.comoFirestore();

function adquirir(inicioMs = T0) {
  return adquirirCompraEtiqueta(db(), {
    pedidoId: 'ped-1',
    inicioMs,
    uid: 'u1',
    intFreteId: 'int-1',
  });
}

function posse(
  dono: string,
  janelaFechaEmMs = T0 + COMPRA_ETIQUETA_JANELA_PAGA_MS,
): PosseCompraEtiqueta {
  return { pedidoId: 'ped-1', dono, janelaFechaEmMs };
}

function semearPedido(freteInicial: Record<string, unknown> = {}) {
  fake.semear(PEDIDO, { estadoPedido: 'aberto', freteInicial });
}

function semearClaim(dono: unknown, leaseExpiraEmMs: unknown, extra: Record<string, unknown> = {}) {
  fake.semear(CLAIM, { dono, leaseExpiraEmMs, criadoEmMs: T0 - 1_000, ...extra });
}

describe('the lease arithmetic (#1677)', () => {
  it('the lease outlives the platform ceiling plus margin', () => {
    expect(COMPRA_ETIQUETA_LEASE_MS).toBeGreaterThanOrEqual(300_000 + 60_000);
  });

  it('a paid step starts at least 30 s before the platform gives up', () => {
    expect(COMPRA_ETIQUETA_JANELA_PAGA_MS + 30_000).toBeLessThanOrEqual(300_000);
  });

  it('a paid call that passed the fence has ended before anyone can take over', () => {
    // Uses the REAL deadlines — raising checkout's (or the token's) must not
    // silently let a takeover land while a payment is still in flight. Between
    // the fence and the paid call's end sit a token refresh (at most once per
    // run), the paid call itself, and a few Firestore round trips (the margin).
    const maisLonga = Math.max(PRAZO_ME_MS.checkout, PRAZO_ME_MS.generate);
    const MARGEM_FIRESTORE_MS = 30_000;
    expect(
      COMPRA_ETIQUETA_JANELA_PAGA_MS + PRAZO_ME_TOKEN_MS + maisLonga + MARGEM_FIRESTORE_MS,
    ).toBeLessThanOrEqual(COMPRA_ETIQUETA_LEASE_MS);
  });
});

describe('leaseDe', () => {
  it('no document is no claim, without a warning', () => {
    expect(leaseDe(undefined, T0, 'p')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-string owner', { dono: 7, leaseExpiraEmMs: T0 + 1 }],
    ['an empty owner', { dono: '', leaseExpiraEmMs: T0 + 1 }],
    ['a missing expiry', { dono: 'a' }],
    ['a string expiry', { dono: 'a', leaseExpiraEmMs: String(T0 + 1) }],
    ['a NaN expiry', { dono: 'a', leaseExpiraEmMs: Number.NaN }],
    ['a non-object', 'lixo'],
  ])('%s reads as NO claim, and warns', (_nome, raw) => {
    expect(leaseDe(raw, T0, 'p')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // The guard allows one minute of clock slack between instances.
  const FOLGA = 60_000;

  it('a claim expiring more than one lease (+ clock slack) ahead reads as none — it could block for ever', () => {
    expect(
      leaseDe({ dono: 'a', leaseExpiraEmMs: T0 + COMPRA_ETIQUETA_LEASE_MS + FOLGA + 1 }, T0, 'p'),
    ).toBeNull();
  });

  it('near-miss: exactly one lease + the slack ahead is a live claim', () => {
    expect(
      leaseDe({ dono: 'a', leaseExpiraEmMs: T0 + COMPRA_ETIQUETA_LEASE_MS + FOLGA }, T0, 'p'),
    ).toEqual({ dono: 'a', leaseExpiraEmMs: T0 + COMPRA_ETIQUETA_LEASE_MS + FOLGA });
  });

  it('a live claim from a writer whose clock runs AHEAD still reads as live (review of #1677)', () => {
    // Zero tolerance let a racing acquire read a just-committed claim as
    // "far-future", overwrite it, and send a second request to Melhor Envio.
    expect(
      leaseDe({ dono: 'a', leaseExpiraEmMs: T0 + COMPRA_ETIQUETA_LEASE_MS + 5 }, T0, 'p'),
    ).not.toBeNull();
  });
});

describe('adquirirCompraEtiqueta', () => {
  it('takes a free claim on the REAL path, with the lease, the window and the diagnostics', async () => {
    semearPedido();
    const r = await adquirir(T0 - 5_000);

    expect(r.kind).toBe('adquirido');
    if (r.kind !== 'adquirido') return;
    expect(r.printLabelIdAncorado).toBeNull();
    // The paid window counts from the request's ARRIVAL, not from the acquire.
    expect(r.posse.janelaFechaEmMs).toBe(T0 - 5_000 + COMPRA_ETIQUETA_JANELA_PAGA_MS);
    expect(fake.dados(CLAIM)).toEqual({
      dono: r.posse.dono,
      leaseExpiraEmMs: T0 + COMPRA_ETIQUETA_LEASE_MS,
      criadoEmMs: T0,
      uid: 'u1',
      intFreteId: 'int-1',
    });
  });

  it('reads the resume anchor from the snapshot that granted the claim', async () => {
    semearPedido({ printLabelId: 'lbl-0' });
    const r = await adquirir();
    expect(r).toMatchObject({ kind: 'adquirido', printLabelIdAncorado: 'lbl-0' });
  });

  it('a missing pedido writes nothing', async () => {
    expect(await adquirir()).toEqual({ kind: 'pedido-ausente' });
    expect(fake.dados(CLAIM)).toBeUndefined();
  });

  it('a live claim held by another request is `ocupado`, and stays untouched', async () => {
    semearPedido();
    semearClaim('outro', T0 + 60_000);
    expect(await adquirir()).toEqual({ kind: 'ocupado', leaseExpiraEmMs: T0 + 60_000 });
    expect(fake.dados(CLAIM)?.dono).toBe('outro');
  });

  it('`now === leaseExpiraEmMs` is expired and takeable; one ms earlier is held', async () => {
    semearPedido();
    semearClaim('outro', T0 + 1);
    expect((await adquirir()).kind).toBe('ocupado');

    vi.setSystemTime(T0 + 1);
    expect((await adquirir()).kind).toBe('adquirido');
  });

  it('a claim from a writer a few ms AHEAD is still `ocupado` — never overwritten', async () => {
    semearPedido();
    semearClaim('outro', T0 + COMPRA_ETIQUETA_LEASE_MS + 5);
    expect((await adquirir()).kind).toBe('ocupado');
    expect(fake.dados(CLAIM)?.dono).toBe('outro');
  });

  it('a corrupt or far-future claim never blocks', async () => {
    semearPedido();
    semearClaim(42, T0 + 60_000);
    expect((await adquirir()).kind).toBe('adquirido');

    semearClaim('outro', T0 + COMPRA_ETIQUETA_LEASE_MS * 10);
    expect((await adquirir()).kind).toBe('adquirido');
  });

  it('two concurrent acquires: exactly one wins, the other sees its claim', async () => {
    semearPedido();
    const [a, b] = await Promise.all([adquirir(), adquirir()]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['adquirido', 'ocupado']);
    // The loser was not a lucky ordering: its first attempt ABORTED on the claim.
    expect(fake.occ.txLog.some((e) => e.phase === 'abort')).toBe(true);
  });

  describe("racing a previous holder's anchor commit (the pedido read is load-bearing)", () => {
    const ANTIGO = posse('antigo');

    beforeEach(() => {
      semearPedido();
      // The previous holder's lease has just expired; it is still about to anchor.
      semearClaim('antigo', T0);
    });

    it('anchor commits first → the acquire retries and RESUMES on that label', async () => {
      const ancorou = deferred();
      fake.occ.beforeCommit = async ({ writes }) => {
        if (writes.some((w) => w.kind === 'set' && w.path === CLAIM)) await ancorou.promise;
      };
      const aquisicao = adquirir();
      await ancorarEtiqueta(db(), ANTIGO, 'lbl-antigo');
      ancorou.resolve();

      const r = await aquisicao;
      expect(r).toMatchObject({ kind: 'adquirido', printLabelIdAncorado: 'lbl-antigo' });
      expect(fake.occ.txLog.some((e) => e.phase === 'abort' && e.conflictPath === PEDIDO)).toBe(
        true,
      );
    });

    it('acquire commits first → the stale anchor is REFUSED, nothing anchored', async () => {
      const adquiriu = deferred();
      fake.occ.beforeCommit = async ({ writes }) => {
        if (writes.some((w) => w.kind === 'update' && w.path === PEDIDO)) await adquiriu.promise;
      };
      const ancoragem = ancorarEtiqueta(db(), ANTIGO, 'lbl-antigo');
      const r = await adquirir();
      adquiriu.resolve();

      await expect(ancoragem).rejects.toBeInstanceOf(CompraEtiquetaPossePerdidaError);
      expect(r).toMatchObject({ kind: 'adquirido', printLabelIdAncorado: null });
      expect(fake.dados(PEDIDO)?.freteInicial).toEqual({});
    });
  });
});

describe('ancorarEtiqueta', () => {
  it('writes ONLY the dotted anchor — every sibling under freteInicial stays', async () => {
    semearPedido({ estado: 'aguardandoCompra', externalOptionData: { id: 3, agency: 195 } });
    semearClaim('eu', T0 + 60_000);
    await ancorarEtiqueta(db(), posse('eu'), 'lbl-1');
    expect(fake.dados(PEDIDO)).toEqual({
      estadoPedido: 'aberto',
      freteInicial: {
        estado: 'aguardandoCompra',
        externalOptionData: { id: 3, agency: 195 },
        printLabelId: 'lbl-1',
      },
    });
  });

  it.each([
    ['another owner holds the claim', () => semearClaim('outro', T0 + 60_000)],
    ['the claim is gone', () => undefined],
  ])('refuses when %s — before checkout, nothing anchored', async (_nome, preparar) => {
    semearPedido();
    preparar();
    await expect(ancorarEtiqueta(db(), posse('eu'), 'lbl-1')).rejects.toBeInstanceOf(
      CompraEtiquetaPossePerdidaError,
    );
    expect(fake.dados(PEDIDO)?.freteInicial).toEqual({});
  });

  it('refuses to overwrite a DIFFERENT stored label', async () => {
    semearPedido({ printLabelId: 'lbl-outro' });
    semearClaim('eu', T0 + 60_000);
    const err = await ancorarEtiqueta(db(), posse('eu'), 'lbl-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CompraEtiquetaAncoraMudouError);
    expect(err).toMatchObject({ esperado: 'lbl-1', encontrado: 'lbl-outro' });
    expect(fake.dados(PEDIDO)?.freteInicial).toEqual({ printLabelId: 'lbl-outro' });
  });

  it('is idempotent on the same label', async () => {
    semearPedido({ printLabelId: 'lbl-1' });
    semearClaim('eu', T0 + 60_000);
    await expect(ancorarEtiqueta(db(), posse('eu'), 'lbl-1')).resolves.toBeUndefined();
    expect(fake.dados(PEDIDO)?.freteInicial).toEqual({ printLabelId: 'lbl-1' });
  });

  it('a deleted pedido is an anchor change, not a NOT_FOUND 500', async () => {
    semearClaim('eu', T0 + 60_000);
    await expect(ancorarEtiqueta(db(), posse('eu'), 'lbl-1')).rejects.toBeInstanceOf(
      CompraEtiquetaAncoraMudouError,
    );
  });
});

describe('garantirPosseCompraEtiqueta (the fence)', () => {
  beforeEach(() => {
    semearPedido({ printLabelId: 'lbl-1' });
    semearClaim('eu', T0 + 300_000);
  });

  it('passes while the claim is ours, the window open and the anchor the label being paid', async () => {
    await expect(
      garantirPosseCompraEtiqueta(db(), posse('eu'), 'checkout', ['lbl-1']),
    ).resolves.toBeUndefined();
  });

  it('the window closes AT janelaFechaEmMs; one ms earlier it is open', async () => {
    const p = posse('eu', T0 + 10);
    vi.setSystemTime(T0 + 9);
    await expect(
      garantirPosseCompraEtiqueta(db(), p, 'checkout', ['lbl-1']),
    ).resolves.toBeUndefined();
    vi.setSystemTime(T0 + 10);
    const err = await garantirPosseCompraEtiqueta(db(), p, 'generate', ['lbl-1']).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CompraEtiquetaJanelaEsgotadaError);
    expect(err).toMatchObject({ etapa: 'generate' });
  });

  it('a slow read cannot carry a run past the window — it is checked again AFTER the read', async () => {
    const p = posse('eu', T0 + 10);
    const lerTudo = fake.getAll.bind(fake);
    fake.getAll = async (...refs) => {
      vi.setSystemTime(T0 + 10);
      return lerTudo(...refs);
    };
    await expect(
      garantirPosseCompraEtiqueta(db(), p, 'checkout', ['lbl-1']),
    ).rejects.toBeInstanceOf(CompraEtiquetaJanelaEsgotadaError);
  });

  it('refuses a run whose claim another request now holds', async () => {
    semearClaim('outro', T0 + 300_000);
    await expect(
      garantirPosseCompraEtiqueta(db(), posse('eu'), 'generate', ['lbl-1']),
    ).rejects.toBeInstanceOf(CompraEtiquetaPossePerdidaError);
  });

  it('before CHECKOUT the anchor must be the label being paid', async () => {
    await expect(
      garantirPosseCompraEtiqueta(db(), posse('eu'), 'checkout', ['lbl-2']),
    ).rejects.toBeInstanceOf(CompraEtiquetaAncoraMudouError);
    await expect(
      garantirPosseCompraEtiqueta(db(), posse('eu'), 'checkout', ['lbl-1', 'lbl-2']),
    ).rejects.toBeInstanceOf(CompraEtiquetaAncoraMudouError);
  });

  it('near-miss: before GENERATE (already paid) a moved anchor does not stop it', async () => {
    await expect(
      garantirPosseCompraEtiqueta(db(), posse('eu'), 'generate', ['lbl-2']),
    ).resolves.toBeUndefined();
  });
});

describe('finalizarCompraEtiqueta', () => {
  const RESULTADO = { printLabelId: 'lbl-1', tracking: 'ME1BR', agency: null };

  it('anchored + ours → the final pedido write AND the claim delete, in one commit', async () => {
    semearPedido({ printLabelId: 'lbl-1', externalOptionData: { id: 3 } });
    semearClaim('eu', T0 + 60_000);
    const commitsAntes = fake.occ.txLog.filter((e) => e.phase === 'commit').length;

    expect(await finalizarCompraEtiqueta(db(), posse('eu'), RESULTADO)).toBe(true);

    expect(fake.dados(PEDIDO)?.freteInicial).toEqual({
      printLabelId: 'lbl-1',
      externalOptionData: { id: 3 },
      estado: 'aguardandoPostagem',
      codRastreio: 'ME1BR',
    });
    expect(fake.dados(CLAIM)).toBeUndefined();
    expect(fake.occ.txLog.filter((e) => e.phase === 'commit').length).toBe(commitsAntes + 1);
  });

  it('records the client-picked agency only when there is one', async () => {
    semearPedido({ printLabelId: 'lbl-1', externalOptionData: { id: 3 } });
    semearClaim('eu', T0 + 60_000);
    await finalizarCompraEtiqueta(db(), posse('eu'), { ...RESULTADO, agency: 195 });
    expect(fake.dados(PEDIDO)?.freteInicial).toMatchObject({
      externalOptionData: { id: 3, agency: 195 },
    });
  });

  it("anchored but the claim is someone else's → the pedido write only, their claim stays", async () => {
    semearPedido({ printLabelId: 'lbl-1' });
    semearClaim('outro', T0 + 60_000);
    expect(await finalizarCompraEtiqueta(db(), posse('eu'), RESULTADO)).toBe(true);
    expect(fake.dados(CLAIM)?.dono).toBe('outro');
  });

  it('the anchor moved mid-buy → the pedido is NOT overwritten; our claim is still freed', async () => {
    semearPedido({ printLabelId: 'lbl-novo', estado: 'aguardandoCompra' });
    semearClaim('eu', T0 + 60_000);
    expect(await finalizarCompraEtiqueta(db(), posse('eu'), RESULTADO)).toBe(false);
    expect(fake.dados(PEDIDO)?.freteInicial).toEqual({
      printLabelId: 'lbl-novo',
      estado: 'aguardandoCompra',
    });
    expect(fake.dados(CLAIM)).toBeUndefined();
  });
});

describe('liberarCompraEtiqueta', () => {
  it('deletes our claim', async () => {
    semearClaim('eu', T0 + 60_000);
    await liberarCompraEtiqueta(db(), posse('eu'));
    expect(fake.dados(CLAIM)).toBeUndefined();
  });

  it("never frees another request's claim", async () => {
    semearClaim('outro', T0 + 60_000);
    await liberarCompraEtiqueta(db(), posse('eu'));
    expect(fake.dados(CLAIM)?.dono).toBe('outro');
  });

  it('an absent claim is a no-op', async () => {
    await expect(liberarCompraEtiqueta(db(), posse('eu'))).resolves.toBeUndefined();
  });
});

describe('ehDesfechoPagoIncerto — is the money outcome of a paid step unknown?', () => {
  it.each([
    [
      'its own timeout',
      new MelhorEnvioTimeoutError('x', { operacao: 'checkout', timeoutMs: 60_000 }),
      true,
    ],
    ['a dropped connection', new MelhorEnvioNetworkError('reset'), true],
    ['a 502 from the edge', new MelhorEnvioHttpError('x', 502, {}), true],
    ['a 503 from the edge', new MelhorEnvioHttpError('x', 503, {}), true],
    ['a 504 from the edge', new MelhorEnvioHttpError('x', 504, {}), true],
    ['a Cloudflare 522', new MelhorEnvioHttpError('x', 522, {}), true],
    // Near-misses: the ORIGIN answered, or nothing was sent.
    ['a plain 500 (the origin answered)', new MelhorEnvioHttpError('x', 500, {}), false],
    ['a 422', new MelhorEnvioValidationError('x', {}, {}), false],
    ['a 401', new MelhorEnvioHttpError('x', 401, {}), false],
    [
      'a TOKEN timeout inside the step (nothing was sent)',
      new MelhorEnvioTimeoutError('x', { operacao: 'token', timeoutMs: 20_000 }),
      false,
    ],
    // Tagged with the call that failed (PR review of #1677): a TOKEN refresh
    // inside the step sent nothing to checkout, whatever the failure shape.
    ['a 502 tagged as the checkout call', new MelhorEnvioHttpError('x', 502, {}, 'checkout'), true],
    [
      'a 502 from /oauth/token inside the step',
      new MelhorEnvioHttpError('x', 502, {}, 'token'),
      false,
    ],
    [
      'a 504 from /oauth/token inside the step',
      new MelhorEnvioHttpError('x', 504, {}, 'token'),
      false,
    ],
    [
      'a connection drop of the checkout call',
      new MelhorEnvioNetworkError('reset', null, 'checkout'),
      true,
    ],
    [
      'a connection drop of /oauth/token inside the step',
      new MelhorEnvioNetworkError('reset', null, 'token'),
      false,
    ],
    ['the bare base error', new MelhorEnvioError('x'), false],
    ['a non-ME error', new RangeError('bug'), false],
  ])('checkout + %s → %s', (_nome, err, esperado) => {
    expect(ehDesfechoPagoIncerto(err, 'checkout')).toBe(esperado);
  });

  it("another step's timeout is not this step's outcome", () => {
    const deGenerate = new MelhorEnvioTimeoutError('x', {
      operacao: 'generate',
      timeoutMs: 45_000,
    });
    expect(ehDesfechoPagoIncerto(deGenerate, 'checkout')).toBe(false);
    expect(ehDesfechoPagoIncerto(deGenerate, 'generate')).toBe(true);
  });
});
