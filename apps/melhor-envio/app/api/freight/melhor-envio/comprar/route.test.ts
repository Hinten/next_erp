import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { PERM } from '@delfrance/auth';
import { deferred } from '@delfrance/data/testing';
import { ESTADO_FRETE } from '@delfrance/schemas';
import {
  MelhorEnvioHttpError,
  MelhorEnvioNetworkError,
  MelhorEnvioReauthRequiredError,
  MelhorEnvioTimeoutError,
  MelhorEnvioValidationError,
} from '@delfrance/integrations-freight-br';

import {
  COMPRA_ETIQUETA_JANELA_PAGA_MS,
  COMPRA_ETIQUETA_LEASE_MS,
} from '@/lib/freight/compraEtiqueta';
import { MelhorEnvioContaNotConfiguredError } from '@/lib/freight/melhorEnvioErrors';
import { processMelhorEnvioNotification } from '@/lib/freight/notificacao';
import { FirestoreFake } from '@/lib/freight/testing/fakeFirestore';

// The route runs the REAL comprarEtiqueta pipeline and the REAL claim
// (`lib/freight/compraEtiqueta.ts`, through the real collection handles) against
// an in-memory Firestore on the shared OCC engine, and a mocked ME api.
const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  addToCart: vi.fn(),
  getOrder: vi.fn(),
  checkout: vi.fn(),
  generate: vi.fn(),
  print: vi.fn(),
  db: { atual: null as unknown },
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db.atual,
}));

vi.mock('@/lib/freight/melhorEnvio', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/freight/melhorEnvio')>();
  return { ...actual, loadMelhorEnvioContext: h.loadCtx };
});

const { POST } = await import('./route');

const T0 = 1_780_000_000_000;
const PEDIDO = 'pedidos/ped-1';
const CLAIM = 'pedidos/ped-1/compraEtiqueta/current';

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3001/api/freight/melhor-envio/comprar', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const WRITER = { uid: 'u1', permissions: (PERM.frete.read | PERM.frete.write).toString() };
const VALID_BODY = { intFreteId: 'int-1', pedidoId: 'ped-1', cartPayload: { service: 3 } };
const AUTH = { authorization: 'Bearer t' };
const comprar = (body: unknown = VALID_BODY) => POST(req(body, AUTH));

/**
 * A cart insert that STALLS until released, and says when it was reached.
 * ⚠️ Not `vi.waitFor`: under fake timers it advances the faked clock by its
 * polling interval, which would shift every lease this file pins to the ms.
 */
function carrinhoTravado() {
  const chegou = deferred();
  const libera = deferred<{ id: string }>();
  h.addToCart.mockImplementationOnce(() => {
    chegou.resolve();
    return libera.promise;
  });
  return { chegou: chegou.promise, liberar: (id: string) => libera.resolve({ id }) };
}

let fake: FirestoreFake;
const frete = () => fake.dados(PEDIDO)?.freteInicial as Record<string, unknown> | undefined;

beforeEach(() => {
  // RESET, not clear: `clearAllMocks` keeps queued `*Once` implementations, and
  // one a failed test never consumed would silently answer the next test.
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  fake = new FirestoreFake();
  h.db.atual = fake.comoFirestore();
  // Default: the pedido exists with no bought label yet (fresh buy).
  fake.semear(PEDIDO, { estadoPedido: 'aberto', freteInicial: {} });
  h.verifyIdToken.mockResolvedValue(WRITER);
  h.addToCart.mockResolvedValue({ id: 'new-label' });
  h.checkout.mockResolvedValue({});
  h.generate.mockResolvedValue({});
  h.print.mockResolvedValue({ url: 'https://sandbox.melhorenvio.com.br/imprimir/abc' });
  h.getOrder.mockResolvedValue({ id: 'new-label', tracking: 'ME123BR' });
  h.loadCtx.mockResolvedValue({
    intFreteId: 'int-1',
    api: {
      addToCart: h.addToCart,
      getOrder: h.getOrder,
      checkout: h.checkout,
      generate: h.generate,
      print: h.print,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('POST /api/freight/melhor-envio/comprar', () => {
  it('returns 401 without an Authorization header', async () => {
    expect((await POST(req(VALID_BODY))).status).toBe(401);
  });

  it('returns 403 for a caller without frete.write', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: PERM.frete.read.toString() });
    expect((await comprar()).status).toBe(403);
  });

  it('returns 400 when the body is missing pedidoId', async () => {
    const res = await comprar({ intFreteId: 'int-1', cartPayload: { service: 3 } });
    expect(res.status).toBe(400);
  });

  it('returns 404 without touching Melhor Envio — or leaving a claim — when the pedido does not exist', async () => {
    const res = await comprar({ ...VALID_BODY, pedidoId: 'nao-existe' });
    expect(res.status).toBe(404);
    // No label is bought for a pedido we can't persist to.
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.addToCart).not.toHaveBeenCalled();
    expect(fake.dados('pedidos/nao-existe/compraEtiqueta/current')).toBeUndefined();
  });

  it('buys the label, anchors printLabelId BEFORE checkout, writes estado/codRastreio and frees the claim', async () => {
    let ancoraNoCheckout: unknown = 'não chamado';
    h.checkout.mockImplementation(async () => {
      ancoraNoCheckout = frete()?.printLabelId;
      return {};
    });

    const res = await comprar();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      printLabelId: 'new-label',
      printUrl: 'https://sandbox.melhorenvio.com.br/imprimir/abc',
      tracking: 'ME123BR',
      estado: 'aguardandoPostagem',
    });
    // The anchor was committed before checkout spent balance.
    expect(ancoraNoCheckout).toBe('new-label');
    expect(frete()).toEqual({
      printLabelId: 'new-label',
      estado: 'aguardandoPostagem',
      codRastreio: 'ME123BR',
    });
    expect(fake.dados(CLAIM)).toBeUndefined();
  });

  it('persists the client-picked drop-off agency onto externalOptionData (#377)', async () => {
    const res = await comprar({ ...VALID_BODY, cartPayload: { service: 3, agency: 195 } });
    expect(res.status).toBe(200);
    expect(frete()).toMatchObject({ externalOptionData: { agency: 195 } });
  });

  it('resumes from the doc printLabelId (ignoring a stale null in the body) — no double-buy', async () => {
    // The pedido already has a bought + paid label persisted on its doc...
    fake.semear(PEDIDO, { freteInicial: { printLabelId: 'existing-label' } });
    h.getOrder.mockResolvedValue({
      id: 'existing-label',
      paid_at: '2026-06-17 09:00:00',
      generated_at: '2026-06-17 09:01:00',
      tracking: 'ME123BR',
    });
    // ...even though the (stale) browser sends printLabelId: null.
    const res = await comprar({ ...VALID_BODY, printLabelId: null });
    expect(res.status).toBe(200);
    expect((await res.json()).printLabelId).toBe('existing-label');
    // Resumes the existing label: no new cart, no second checkout (no double spend).
    expect(h.addToCart).not.toHaveBeenCalled();
    expect(h.checkout).not.toHaveBeenCalled();
    expect(h.getOrder).toHaveBeenCalledWith('existing-label');
  });

  it("IGNORES a body printLabelId the pedido does not hold — it can't resume a cleared frete's label (#1677)", async () => {
    const res = await comprar({ ...VALID_BODY, printLabelId: 'label-de-um-frete-antigo' });
    expect(res.status).toBe(200);
    expect(h.getOrder).not.toHaveBeenCalledWith('label-de-um-frete-antigo');
    expect(h.addToCart).toHaveBeenCalledTimes(1);
  });

  it('maps a canceled label to 409 ME_LABEL_TERMINAL, does not re-buy, and frees the claim', async () => {
    fake.semear(PEDIDO, { freteInicial: { printLabelId: 'existing' } });
    h.getOrder.mockResolvedValue({ id: 'existing', canceled_at: '2026-06-17 09:00:00' });
    const res = await comprar();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ME_LABEL_TERMINAL');
    expect(h.checkout).not.toHaveBeenCalled();
    expect(fake.dados(CLAIM)).toBeUndefined();
  });

  it('maps a dead token to 409 ME_REAUTH', async () => {
    h.addToCart.mockRejectedValue(
      new MelhorEnvioReauthRequiredError('no_token', 'Conta não conectada.'),
    );
    const res = await comprar();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ME_REAUTH');
  });

  it('maps a 422 from ME to 422', async () => {
    h.addToCart.mockRejectedValue(new MelhorEnvioValidationError('inválido', { to: ['x'] }, {}));
    const res = await comprar();
    expect(res.status).toBe(422);
  });

  describe('shipment progress (#1801)', () => {
    it.each([ESTADO_FRETE.postado, ESTADO_FRETE.entregue, ESTADO_FRETE.cancelado])(
      'a stale buy resumes the anchored label without regressing %s',
      async (estado) => {
        fake.semear(PEDIDO, { freteInicial: { printLabelId: 'existing-label', estado } });
        h.getOrder.mockResolvedValue({
          id: 'existing-label',
          status: 'released',
          paid_at: '2026-06-17 09:00:00',
          generated_at: '2026-06-17 09:01:00',
          tracking: 'ME123BR',
        });
        const res = await comprar({ ...VALID_BODY, printLabelId: null });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ printLabelId: 'existing-label', estado });
        expect(frete()?.estado).toBe(estado);
        expect(h.addToCart).not.toHaveBeenCalled();
        expect(h.checkout).not.toHaveBeenCalled();
        expect(h.generate).not.toHaveBeenCalled();
        expect(h.getOrder).toHaveBeenCalledTimes(2);
        expect(fake.dados(CLAIM)).toBeUndefined();
      },
    );

    it('a fresh buy resets inherited postado at the anchor and awaits posting', async () => {
      fake.semear(PEDIDO, {
        freteInicial: { printLabelId: null, estado: ESTADO_FRETE.postado },
      });
      h.checkout.mockImplementation(async () => {
        expect(frete()).toMatchObject({
          printLabelId: 'new-label',
          estado: ESTADO_FRETE.aguardandoPostagem,
        });
        return {};
      });
      h.getOrder.mockResolvedValue({ id: 'new-label', status: 'released', tracking: 'ME123BR' });
      const res = await comprar();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ estado: ESTADO_FRETE.aguardandoPostagem });
      expect(frete()?.estado).toBe(ESTADO_FRETE.aguardandoPostagem);
      expect(h.getOrder).toHaveBeenCalledTimes(1);
    });

    it.each([
      [ESTADO_FRETE.cancelado, ESTADO_FRETE.iniciado],
      [ESTADO_FRETE.entregue, ESTADO_FRETE.aguardandoPostagem],
      [ESTADO_FRETE.suspenso, ESTADO_FRETE.aguardandoPostagem],
      [ESTADO_FRETE.falhaNaEntrega, ESTADO_FRETE.aguardandoPostagem],
    ])(
      'a new label over inherited %s starts at %s and accepts posted/delivered webhooks',
      async (anterior, inicial) => {
        fake.semear(PEDIDO, {
          freteInicial: {
            printLabelId: null,
            estado: anterior,
            integracaoFreteOuterRef: 'documents/int_frete/int-1',
          },
        });
        h.checkout.mockImplementation(async () => {
          expect(frete()).toMatchObject({ printLabelId: 'new-label', estado: inicial });
          return {};
        });
        h.getOrder.mockResolvedValue({ id: 'new-label', status: 'released', tracking: 'ME123BR' });
        const res = await comprar();
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          printLabelId: 'new-label',
          estado: ESTADO_FRETE.aguardandoPostagem,
        });
        expect(frete()?.estado).toBe(ESTADO_FRETE.aguardandoPostagem);
        expect(fake.dados(CLAIM)).toBeUndefined();

        // Drive the real notification processor after the real buy pipeline.
        // Its injected write port uses OCC so every change is a committed write.
        for (const [status, esperado] of [
          ['posted', ESTADO_FRETE.postado],
          ['delivered', ESTADO_FRETE.entregue],
        ]) {
          const outcome = await processMelhorEnvioNotification(
            fake.comoFirestore(),
            { labelId: 'new-label', event: null, providerStatus: status, tracking: null },
            {
              findPedidoByLabel: async (_db, labelId) => {
                const data = fake.dados(PEDIDO);
                return data && frete()?.printLabelId === labelId
                  ? { id: 'ped-1', data, updateTime: Timestamp.fromMillis(T0) }
                  : null;
              },
              loadCurrentLabel: async (_db, _intFreteId, labelId) => ({
                id: labelId,
                status,
                tracking: 'ME123BR',
              }),
              updatePedido: async (_db, pedido, patch) => {
                const ref = fake.ref(`pedidos/${pedido.id}`);
                await fake.runTransaction(async (tx) => {
                  await tx.get(ref);
                  tx.update(ref, patch);
                });
              },
            },
          );
          expect(outcome).toMatchObject({ kind: 'applied', estado: esperado });
          expect(frete()?.estado).toBe(esperado);
        }
        expect(h.addToCart).toHaveBeenCalledTimes(1);
        expect(h.checkout).toHaveBeenCalledTimes(1);
      },
    );

    it.each(['rejected', 'timeout'])(
      'a canceled-shipment checkout %s leaves the new unpaid label initiated',
      async (falha) => {
        fake.semear(PEDIDO, { freteInicial: { estado: ESTADO_FRETE.cancelado } });
        h.checkout.mockRejectedValue(
          falha === 'timeout'
            ? new MelhorEnvioTimeoutError('x', { operacao: 'checkout', timeoutMs: 60_000 })
            : new MelhorEnvioValidationError('x', {}, {}),
        );
        const res = await comprar();
        expect(res.status).toBe(falha === 'timeout' ? 504 : 422);
        expect(frete()).toEqual({ printLabelId: 'new-label', estado: ESTADO_FRETE.iniciado });
        if (falha === 'timeout') {
          expect(fake.dados(CLAIM)).toMatchObject({
            leaseExpiraEmMs: T0 + COMPRA_ETIQUETA_LEASE_MS,
          });
        } else {
          expect(fake.dados(CLAIM)).toBeUndefined();
        }
        expect(h.generate).not.toHaveBeenCalled();
        expect(h.getOrder).not.toHaveBeenCalled();
      },
    );

    it.each(['posted', 'received', 'delivered'])(
      'a fresh buy uses the final provider status %s',
      async (status) => {
        h.getOrder.mockResolvedValue({ id: 'new-label', status, tracking: 'ME123BR' });
        const esperado = status === 'delivered' ? ESTADO_FRETE.entregue : ESTADO_FRETE.postado;
        const res = await comprar();
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ estado: esperado });
        expect(frete()?.estado).toBe(esperado);
        expect(h.getOrder).toHaveBeenCalledTimes(1);
      },
    );

    it.each(['rejected', 'timeout'])(
      'a checkout %s preserves the normalized anchor and the existing claim policy',
      async (falha) => {
        fake.semear(PEDIDO, { freteInicial: { estado: ESTADO_FRETE.postado } });
        h.checkout.mockRejectedValue(
          falha === 'timeout'
            ? new MelhorEnvioTimeoutError('x', { operacao: 'checkout', timeoutMs: 60_000 })
            : new MelhorEnvioValidationError('x', {}, {}),
        );
        const res = await comprar();
        expect(res.status).toBe(falha === 'timeout' ? 504 : 422);
        expect(frete()).toEqual({
          printLabelId: 'new-label',
          estado: ESTADO_FRETE.aguardandoPostagem,
        });
        if (falha === 'timeout') {
          expect(fake.dados(CLAIM)).toMatchObject({
            leaseExpiraEmMs: T0 + COMPRA_ETIQUETA_LEASE_MS,
          });
          expect(await res.json()).toMatchObject({ code: 'ME_TIMEOUT' });
        } else {
          expect(fake.dados(CLAIM)).toBeUndefined();
        }
        expect(h.generate).not.toHaveBeenCalled();
        expect(h.getOrder).not.toHaveBeenCalled();
      },
    );

    it('never rolls a webhook state back when checkout fails after normalization', async () => {
      fake.semear(PEDIDO, { freteInicial: { estado: ESTADO_FRETE.postado } });
      h.checkout.mockImplementation(async () => {
        await fake.runTransaction(async (tx) => {
          await tx.get(fake.ref(PEDIDO));
          tx.update(fake.ref(PEDIDO), { 'freteInicial.estado': ESTADO_FRETE.postado });
        });
        throw new MelhorEnvioTimeoutError('x', { operacao: 'checkout', timeoutMs: 60_000 });
      });
      const res = await comprar();
      expect(res.status).toBe(504);
      expect(frete()).toEqual({ printLabelId: 'new-label', estado: ESTADO_FRETE.postado });
      expect(fake.dados(CLAIM)).toBeDefined();
    });

    it.each([
      [null, ESTADO_FRETE.postado, ESTADO_FRETE.postado],
      [null, ESTADO_FRETE.entregue, ESTADO_FRETE.postado],
      ['existing-label', ESTADO_FRETE.postado, ESTADO_FRETE.aguardandoPostagem],
      ['existing-label', ESTADO_FRETE.entregue, ESTADO_FRETE.aguardandoPostagem],
      [null, ESTADO_FRETE.postado, ESTADO_FRETE.cancelado],
      [null, ESTADO_FRETE.entregue, ESTADO_FRETE.entregue],
    ])(
      'retries label %s advanced to %s from inherited %s after the provider fetch',
      async (anchor, estado, anterior) => {
        const labelId = anchor ?? 'new-label';
        fake.semear(PEDIDO, {
          freteInicial: {
            printLabelId: anchor,
            estado: anterior,
          },
        });
        h.getOrder.mockResolvedValue({
          id: labelId,
          status: 'released',
          paid_at: '2026-06-17 09:00:00',
          generated_at: '2026-06-17 09:01:00',
          tracking: 'ME123BR',
        });
        const chegou = deferred();
        const libera = deferred();
        let travou = false;
        fake.occ.beforeCommit = async ({ writes }) => {
          if (
            !travou &&
            writes.some(
              (w) =>
                w.path === PEDIDO && w.kind === 'update' && 'freteInicial.codRastreio' in w.data,
            )
          ) {
            travou = true;
            chegou.resolve();
            await libera.promise;
          }
        };
        const compra = comprar();
        await chegou.promise;
        // The final provider fetch is complete; the concurrent write bumps the
        // OCC version. Seeding here would make this retry assertion vacuous.
        expect(h.getOrder).toHaveBeenCalledTimes(anchor === null ? 1 : 2);
        await fake.runTransaction(async (tx) => {
          await tx.get(fake.ref(PEDIDO));
          tx.update(fake.ref(PEDIDO), { 'freteInicial.estado': estado });
        });
        libera.resolve();
        const res = await compra;
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ printLabelId: labelId, estado });
        expect(frete()?.estado).toBe(estado);
        expect(fake.occ.txLog.some((e) => e.phase === 'abort' && e.conflictPath === PEDIDO)).toBe(
          true,
        );
        expect(h.addToCart).toHaveBeenCalledTimes(anchor === null ? 1 : 0);
        expect(h.checkout).toHaveBeenCalledTimes(anchor === null ? 1 : 0);
        expect(h.generate).toHaveBeenCalledTimes(anchor === null ? 1 : 0);
        expect(fake.dados(CLAIM)).toBeUndefined();
      },
    );

    it.each(['changed', 'cleared', 'deleted'])(
      'retries finalization and returns 412 when the anchor is %s before commit',
      async (mudanca) => {
        fake.semear(PEDIDO, {
          freteInicial: { printLabelId: 'existing-label', estado: ESTADO_FRETE.aguardandoPostagem },
        });
        h.getOrder.mockResolvedValue({
          id: 'existing-label',
          status: 'released',
          paid_at: '2026-06-17 09:00:00',
          generated_at: '2026-06-17 09:01:00',
          tracking: 'ME123BR',
        });
        const chegou = deferred();
        const libera = deferred();
        let travou = false;
        fake.occ.beforeCommit = async ({ writes }) => {
          if (
            !travou &&
            writes.some(
              (w) =>
                w.path === PEDIDO && w.kind === 'update' && 'freteInicial.codRastreio' in w.data,
            )
          ) {
            travou = true;
            chegou.resolve();
            await libera.promise;
          }
        };
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const compra = comprar();
        await chegou.promise;
        await fake.runTransaction(async (tx) => {
          await tx.get(fake.ref(PEDIDO));
          if (mudanca === 'deleted') {
            tx.delete(fake.ref(PEDIDO));
          } else {
            tx.update(fake.ref(PEDIDO), {
              'freteInicial.printLabelId': mudanca === 'cleared' ? null : 'winner-label',
              'freteInicial.estado': ESTADO_FRETE.entregue,
            });
          }
        });
        libera.resolve();
        const res = await compra;
        expect(res.status).toBe(412);
        expect(await res.json()).toMatchObject({
          code: 'ME_ETIQUETA_DESVINCULADA',
          printLabelId: 'existing-label',
          printUrl: 'https://sandbox.melhorenvio.com.br/imprimir/abc',
        });
        if (mudanca === 'deleted') {
          expect(fake.dados(PEDIDO)).toBeUndefined();
        } else {
          expect(frete()).toEqual({
            printLabelId: mudanca === 'cleared' ? null : 'winner-label',
            estado: ESTADO_FRETE.entregue,
          });
        }
        expect(fake.occ.txLog.some((e) => e.phase === 'abort' && e.conflictPath === PEDIDO)).toBe(
          true,
        );
        expect(fake.dados(CLAIM)).toBeUndefined();
        expect(log).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe('two requests for the same pedido (#1677)', () => {
    it('⭐ a CONCURRENT second click gets 423 before any ME call — one label, one payment', async () => {
      const carrinho = carrinhoTravado();

      const primeira = comprar();
      // Let A acquire the claim and reach the (stalled) cart insert.
      await carrinho.chegou;

      const segunda = await comprar();
      expect(segunda.status).toBe(423);
      const corpo = (await segunda.json()) as Record<string, unknown>;
      expect(corpo.code).toBe('ME_COMPRA_EM_ANDAMENTO');
      expect(corpo.leaseExpiraEmMs).toBe(T0 + COMPRA_ETIQUETA_LEASE_MS);
      expect(String(corpo.error)).toContain('em andamento');
      // B never reached Melhor Envio at all.
      expect(h.loadCtx).toHaveBeenCalledTimes(1);
      expect(h.addToCart).toHaveBeenCalledTimes(1);
      expect(h.checkout).not.toHaveBeenCalled();

      carrinho.liberar('new-label');
      expect((await primeira).status).toBe(200);
      expect(h.checkout).toHaveBeenCalledTimes(1);
      expect(fake.dados(CLAIM)).toBeUndefined();
    });

    it('a SEQUENTIAL re-click after a finished buy acquires again and resumes — no new cart', async () => {
      expect((await comprar()).status).toBe(200);
      h.getOrder.mockResolvedValue({
        id: 'new-label',
        paid_at: '2026-10-06 10:00:00',
        generated_at: '2026-10-06 10:00:01',
        tracking: 'ME123BR',
      });

      expect((await comprar()).status).toBe(200);
      expect(h.addToCart).toHaveBeenCalledTimes(1);
      expect(h.checkout).toHaveBeenCalledTimes(1);
    });

    it("another request's live claim answers 423; once it expires the buy goes ahead", async () => {
      fake.semear(CLAIM, { dono: 'outro', leaseExpiraEmMs: T0 + 90_000, criadoEmMs: T0 - 270_000 });
      const res = await comprar();
      expect(res.status).toBe(423);
      expect(((await res.json()) as { leaseExpiraEmMs: number }).leaseExpiraEmMs).toBe(T0 + 90_000);
      expect(h.loadCtx).not.toHaveBeenCalled();

      vi.setSystemTime(T0 + 90_000);
      expect((await comprar()).status).toBe(200);
    });

    it('⭐ a ZOMBIE past its lease cannot anchor or pay — the takeover run owns the pedido', async () => {
      const carrinhoA = carrinhoTravado();
      const a = comprar();
      await carrinhoA.chegou;

      // A stalls past its whole lease (the platform answered its 504 long ago).
      vi.setSystemTime(T0 + COMPRA_ETIQUETA_LEASE_MS + 1);
      h.addToCart.mockResolvedValueOnce({ id: 'label-B' });
      h.getOrder.mockResolvedValue({ id: 'label-B', tracking: 'MEB' });
      expect((await comprar()).status).toBe(200);
      expect(frete()?.printLabelId).toBe('label-B');

      // A wakes up with ITS cart item: its anchor is refused, nothing is paid.
      carrinhoA.liberar('label-A');
      expect((await a).status).toBe(423);
      expect(h.checkout).toHaveBeenCalledTimes(1);
      expect(h.checkout).toHaveBeenCalledWith(['label-B']);
      expect(frete()?.printLabelId).toBe('label-B');
    });

    it('past the paid window before checkout → 503, nothing paid, claim freed, the next click resumes', async () => {
      h.addToCart.mockImplementationOnce(async () => {
        vi.setSystemTime(T0 + COMPRA_ETIQUETA_JANELA_PAGA_MS);
        return { id: 'new-label' };
      });
      const res = await comprar();
      expect(res.status).toBe(503);
      const corpo = (await res.json()) as Record<string, unknown>;
      expect(corpo).toMatchObject({ code: 'ME_COMPRA_INTERROMPIDA', etapa: 'checkout' });
      expect(String(corpo.error)).toContain('nada foi pago');
      expect(h.checkout).not.toHaveBeenCalled();
      expect(frete()?.printLabelId).toBe('new-label');
      expect(fake.dados(CLAIM)).toBeUndefined();

      // The retry is a fresh request with its own window: it resumes on the anchor.
      expect((await comprar()).status).toBe(200);
      expect(h.addToCart).toHaveBeenCalledTimes(1);
      expect(h.checkout).toHaveBeenCalledWith(['new-label']);
    });

    it('past the window AFTER checkout → 503 that never says nothing was paid', async () => {
      h.checkout.mockImplementationOnce(async () => {
        vi.setSystemTime(T0 + COMPRA_ETIQUETA_JANELA_PAGA_MS);
        return {};
      });
      const res = await comprar();
      expect(res.status).toBe(503);
      const corpo = (await res.json()) as Record<string, unknown>;
      expect(corpo).toMatchObject({ etapa: 'generate' });
      expect(String(corpo.error)).not.toMatch(/nada foi pago/i);
      expect(h.generate).not.toHaveBeenCalled();
    });

    it('the fence runs before GENERATE too — a run that lost its claim after paying stops there', async () => {
      h.checkout.mockImplementationOnce(async () => {
        fake.semear(CLAIM, { dono: 'outro', leaseExpiraEmMs: T0 + 300_000, criadoEmMs: T0 });
        return {};
      });
      const res = await comprar();
      expect(res.status).toBe(423);
      expect(h.generate).not.toHaveBeenCalled();
      // Never free the winner's claim.
      expect(fake.dados(CLAIM)?.dono).toBe('outro');
    });

    it('near-miss: a resume with nothing left to pay runs NO fence, even past the window', async () => {
      fake.semear(PEDIDO, { freteInicial: { printLabelId: 'existing-label' } });
      h.getOrder.mockImplementation(async () => {
        vi.setSystemTime(T0 + COMPRA_ETIQUETA_JANELA_PAGA_MS + 1);
        return {
          id: 'existing-label',
          paid_at: '2026-06-17 09:00:00',
          generated_at: '2026-06-17 09:01:00',
          tracking: 'ME123BR',
        };
      });
      expect((await comprar()).status).toBe(200);
    });

    it('a frete re-pointed while the cart insert was in flight → 412, nothing paid, not overwritten', async () => {
      // Used to be a silent last-writer-wins overwrite of the other label.
      h.addToCart.mockImplementationOnce(async () => {
        fake.semear(PEDIDO, { freteInicial: { printLabelId: 'outro-label' } });
        return { id: 'new-label' };
      });
      const res = await comprar();
      expect(res.status).toBe(412);
      const corpo = (await res.json()) as Record<string, unknown>;
      expect(corpo.code).toBe('ME_FRETE_ALTERADO');
      expect(String(corpo.error)).toContain('Nada foi pago');
      expect(h.checkout).not.toHaveBeenCalled();
      expect(frete()?.printLabelId).toBe('outro-label');
      expect(fake.dados(CLAIM)).toBeUndefined();
    });
  });

  describe('the claim on every exit (#1677)', () => {
    it.each([
      [
        'a 422 at the cart',
        () => h.addToCart.mockRejectedValue(new MelhorEnvioValidationError('x', {}, {})),
        422,
      ],
      [
        'a dead token',
        () => h.addToCart.mockRejectedValue(new MelhorEnvioReauthRequiredError('no_token', 'x')),
        409,
      ],
      [
        'an HTTP 500 from ME at checkout (ME answered: nothing in transit)',
        () => h.checkout.mockRejectedValue(new MelhorEnvioHttpError('x', 500, {})),
        502,
      ],
      [
        'a context-load failure',
        () => h.loadCtx.mockRejectedValue(new MelhorEnvioContaNotConfiguredError('int-1')),
        404,
      ],
      [
        'a cart-insert TIMEOUT (before the anchor — nothing paid)',
        () =>
          h.addToCart.mockRejectedValue(
            new MelhorEnvioTimeoutError('x', { operacao: 'addToCart', timeoutMs: 30_000 }),
          ),
        504,
      ],
      [
        'a TOKEN timeout inside checkout (the request never left)',
        () =>
          h.checkout.mockRejectedValue(
            new MelhorEnvioTimeoutError('x', { operacao: 'token', timeoutMs: 20_000 }),
          ),
        504,
      ],
      [
        'a 502 from /oauth/token while checkout was refreshing its token (nothing was sent to checkout)',
        () =>
          h.checkout.mockRejectedValue(
            new MelhorEnvioHttpError('Melhor Envio /oauth/token: HTTP 502', 502, {}, 'token'),
          ),
        502,
      ],
      [
        'a 422 at checkout (ME answered)',
        () => h.checkout.mockRejectedValue(new MelhorEnvioValidationError('x', {}, {})),
        422,
      ],
    ])('is FREED after %s', async (_nome, preparar, status) => {
      preparar();
      expect((await comprar()).status).toBe(status);
      expect(fake.dados(CLAIM)).toBeUndefined();
    });

    it('is freed after an unknown error, which still propagates', async () => {
      h.generate.mockRejectedValue(new RangeError('bug'));
      await expect(comprar()).rejects.toBeInstanceOf(RangeError);
      expect(fake.dados(CLAIM)).toBeUndefined();
    });

    it.each([
      [
        'a checkout TIMEOUT',
        () =>
          h.checkout.mockRejectedValue(
            new MelhorEnvioTimeoutError('O Melhor Envio não respondeu em 60 s…', {
              operacao: 'checkout',
              timeoutMs: 60_000,
            }),
          ),
        504,
      ],
      [
        'a checkout connection drop',
        () =>
          h.checkout.mockRejectedValue(new MelhorEnvioNetworkError('reset', new TypeError('x'))),
        504,
      ],
      [
        "a 502 from ME's edge at checkout (the origin may still be processing)",
        () => h.checkout.mockRejectedValue(new MelhorEnvioHttpError('x', 502, {})),
        504,
      ],
      [
        "a 504 from ME's edge at checkout",
        () => h.checkout.mockRejectedValue(new MelhorEnvioHttpError('x', 504, {})),
        504,
      ],
      [
        'a generate TIMEOUT',
        () =>
          h.generate.mockRejectedValue(
            new MelhorEnvioTimeoutError('x', { operacao: 'generate', timeoutMs: 45_000 }),
          ),
        504,
      ],
    ])('is KEPT after %s — the payment outcome is unknown', async (_nome, preparar, status) => {
      preparar();
      const res = await comprar();
      expect(res.status).toBe(status);
      expect(fake.dados(CLAIM)).toMatchObject({ leaseExpiraEmMs: T0 + COMPRA_ETIQUETA_LEASE_MS });
      // The anchor landed before the paid step, so a later re-buy resumes.
      expect(frete()?.printLabelId).toBe('new-label');
      // …and a click right now is told to wait instead of re-paying.
      expect((await comprar()).status).toBe(423);
    });

    it('a checkout timeout answers a CODED 504 ME_TIMEOUT with estado untouched (#1679)', async () => {
      h.checkout.mockRejectedValue(
        new MelhorEnvioTimeoutError('O Melhor Envio não respondeu em 60 s ao pagar a etiqueta…', {
          operacao: 'checkout',
          timeoutMs: 60_000,
        }),
      );
      const res = await comprar();
      expect(res.status).toBe(504);
      expect(await res.json()).toEqual({
        error: 'O Melhor Envio não respondeu em 60 s ao pagar a etiqueta…',
        code: 'ME_TIMEOUT',
        operacao: 'checkout',
        timeoutMs: 60_000,
      });
      expect(frete()).toEqual({ printLabelId: 'new-label' });
      expect(h.generate).not.toHaveBeenCalled();
    });

    it('a checkout that failed IN TRANSIT says the payment may be done — the "outcome unknown" 504, never a plain "Falha"', async () => {
      h.checkout.mockRejectedValue(new MelhorEnvioNetworkError('reset', new TypeError('x')));
      const res = await comprar();
      expect(res.status).toBe(504);
      const corpo = (await res.json()) as Record<string, unknown>;
      // The same coded envelope the browser already maps to its timeout
      // handling (yellow notice, the modal closes, no re-click).
      expect(corpo).toMatchObject({ code: 'ME_TIMEOUT', operacao: 'checkout', timeoutMs: null });
      expect(String(corpo.error)).toContain('o pagamento pode ter sido concluído');
    });

    it('a release that fails in Firestore is logged — it never replaces the answer already chosen', async () => {
      const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      h.addToCart.mockImplementation(async () => {
        // Every transaction from here on (the release) fails UNAVAILABLE.
        fake.runTransaction = () =>
          Promise.reject(Object.assign(new Error('unavailable'), { code: 14 }));
        throw new MelhorEnvioValidationError('CEP inválido', { to: ['inválido'] }, {});
      });
      const res = await comprar();
      expect(res.status).toBe(422);
      expect(((await res.json()) as { errors: unknown }).errors).toEqual({ to: ['inválido'] });
      expect(erro).toHaveBeenCalledWith(
        expect.stringContaining('liberar o claim'),
        expect.objectContaining({ pedidoId: 'ped-1', code: 14 }),
      );
    });

    it('near-miss: a release that fails with a BUG still propagates', async () => {
      h.addToCart.mockImplementation(async () => {
        fake.runTransaction = () => Promise.reject(new RangeError('bug no release'));
        throw new MelhorEnvioValidationError('x', {}, {});
      });
      await expect(comprar()).rejects.toThrow('bug no release');
    });
  });

  describe('a label PAID but no longer linked to the pedido (review of #1677)', () => {
    it('answers a coded 412 naming the paid label — NEVER a 200 that invites a second purchase', async () => {
      const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      h.generate.mockImplementation(async () => {
        // The operator re-pointed the frete while the paid label was generating.
        fake.semear(PEDIDO, { freteInicial: { printLabelId: null, estado: 'aguardandoCompra' } });
        return {};
      });
      const res = await comprar();
      expect(res.status).toBe(412);
      const corpo = (await res.json()) as Record<string, unknown>;
      expect(corpo).toMatchObject({
        code: 'ME_ETIQUETA_DESVINCULADA',
        printLabelId: 'new-label',
        printUrl: 'https://sandbox.melhorenvio.com.br/imprimir/abc',
      });
      expect(String(corpo.error)).toContain('PAGA');
      // The operator's frete is not overwritten, and the claim is freed.
      expect(frete()).toEqual({ printLabelId: null, estado: 'aguardandoCompra' });
      expect(fake.dados(CLAIM)).toBeUndefined();
      expect(erro).toHaveBeenCalledWith(
        expect.stringContaining('sem vínculo'),
        expect.objectContaining({ pedidoId: 'ped-1', printLabelId: 'new-label' }),
      );
    });

    it('a pedido deleted mid-buy is the same coded 412, not a false success', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      h.generate.mockImplementation(async () => {
        await fake.runTransaction(async (tx) => {
          tx.delete(fake.ref(PEDIDO));
        });
        return {};
      });
      const res = await comprar();
      expect(res.status).toBe(412);
      expect(((await res.json()) as { code: string }).code).toBe('ME_ETIQUETA_DESVINCULADA');
    });
  });
});
