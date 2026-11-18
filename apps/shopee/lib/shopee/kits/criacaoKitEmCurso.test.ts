import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGUARDAR_KIT_INCERTO_SHOPEE_MS,
  CODIGO_CRIACAO_KIT_SHOPEE,
  CRIACAO_KIT_SHOPEE_TTL_MS,
  ESPERA_MAXIMA_CRIACAO_KIT_SHOPEE_MS,
  MARGEM_ENVIO_SHOPEE_MS,
  estadoDaCriacaoDeKitShopee,
} from '@delfrance/schemas';

import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import {
  ConflitoDeCriacaoDeKitShopeeError,
  TENTATIVAS_DA_RESERVA,
  esperaDaReservaEnviada,
  liberarParaEnvio,
  liberarReserva,
  podeContinuarNaReserva,
  reservarCriacaoDeKit,
  type ControlesDaReservaDeKit,
} from './criacaoKitEmCurso';
import { idDaCriacaoDeKit } from './idsKit';

const AGORA = 1_760_000_000_000;
const ALVO = { integracaoId: 'int-1', produtoId: 'kit-k', arma: 'kit-criar' } as const;
const CAMINHO = `kitCriacaoShopee/${idDaCriacaoDeKit('int-1', 'kit-k')}`;

afterEach(() => {
  vi.restoreAllMocks();
});

function controles(
  agora: number | (() => number),
  over: Partial<ControlesDaReservaDeKit> = {},
): ControlesDaReservaDeKit {
  return {
    agora: typeof agora === 'number' ? () => agora : agora,
    prazoDaRequisicao: null,
    aquecerCredencial: () => Promise.resolve(),
    ...over,
  };
}

async function recusaDe(p: Promise<unknown>): Promise<ConflitoDeCriacaoDeKitShopeeError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConflitoDeCriacaoDeKitShopeeError);
  return err as ConflitoDeCriacaoDeKitShopeeError;
}

const lease = (db: FakeDb) => db.store[CAMINHO]?.data;

describe('reservarCriacaoDeKit — take the lease, or say who holds it', () => {
  it('on an empty slot: ONE create at the derived id, every field, reading em-andamento', async () => {
    const db = new FakeDb();
    const r = await reservarCriacaoDeKit(asDb(db), ALVO, controles(AGORA));

    expect(r).toMatchObject({
      docId: idDaCriacaoDeKit('int-1', 'kit-k'),
      desdeMs: AGORA,
      ateMs: AGORA + CRIACAO_KIT_SHOPEE_TTL_MS,
      fase: 'tomada',
    });
    expect(lease(db)).toEqual({
      v: 1,
      integracaoId: 'int-1',
      produtoId: 'kit-k',
      arma: 'kit-criar',
      token: r.token,
      desdeMs: AGORA,
      ateMs: AGORA + CRIACAO_KIT_SHOPEE_TTL_MS,
      enviadoEmMs: null,
      sku: null,
    });
    expect(estadoDaCriacaoDeKitShopee(lease(db), AGORA)).toMatchObject({ tipo: 'em-andamento' });
  });

  it('while another run holds it ⇒ 409 emAndamento with ITS remaining wait, and NOTHING written', async () => {
    const db = new FakeDb();
    await reservarCriacaoDeKit(asDb(db), ALVO, controles(AGORA));
    const antes = structuredClone(lease(db));
    const escritas = db.writes.length;

    const erro = await recusaDe(
      reservarCriacaoDeKit(asDb(db), { ...ALVO, arma: 'kit-recriar' }, controles(AGORA + 1_000)),
    );

    expect(erro.code).toBe(CODIGO_CRIACAO_KIT_SHOPEE.emAndamento);
    expect(erro.aguardarMs).toBe(CRIACAO_KIT_SHOPEE_TTL_MS - 1_000);
    expect(erro.message).toContain('nada foi enviado');
    expect(db.writes.length).toBe(escritas);
    expect(lease(db)).toEqual(antes);
  });

  it('⛔ NEAR-MISS: another produto, or another conta, is another slot', async () => {
    const db = new FakeDb();
    await reservarCriacaoDeKit(asDb(db), ALVO, controles(AGORA));
    await expect(
      reservarCriacaoDeKit(asDb(db), { ...ALVO, produtoId: 'kit-j' }, controles(AGORA)),
    ).resolves.toMatchObject({ fase: 'tomada' });
    await expect(
      reservarCriacaoDeKit(asDb(db), { ...ALVO, integracaoId: 'int-2' }, controles(AGORA)),
    ).resolves.toMatchObject({ fase: 'tomada' });
  });

  it('an UNSTAMPED lease past ateMs is taken over — a new token, the old document replaced', async () => {
    const db = new FakeDb();
    const a = await reservarCriacaoDeKit(asDb(db), ALVO, controles(AGORA));

    const b = await reservarCriacaoDeKit(asDb(db), ALVO, controles(a.ateMs));

    expect(b.token).not.toBe(a.token);
    expect(lease(db)).toMatchObject({ token: b.token, desdeMs: a.ateMs, enviadoEmMs: null });
  });

  it('a STAMPED lease is still held AT ateMs (the post-send grace) and taken over only at ateMs + AGUARDAR', async () => {
    const db = new FakeDb();
    const a = await reservarCriacaoDeKit(asDb(db), ALVO, controles(AGORA));
    await liberarParaEnvio(asDb(db), a, 'KIT-1');

    const cedo = await recusaDe(reservarCriacaoDeKit(asDb(db), ALVO, controles(a.ateMs)));
    expect(cedo.aguardarMs).toBe(AGUARDAR_KIT_INCERTO_SHOPEE_MS);

    const b = await reservarCriacaoDeKit(
      asDb(db),
      ALVO,
      controles(a.ateMs + AGUARDAR_KIT_INCERTO_SHOPEE_MS),
    );
    expect(b.token).not.toBe(a.token);
  });

  it('(ADR 0011 condition 3) a CORRUPT document is no lease: taken over, and the new one carries no stray key', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, { token: 'velho', desdeMs: AGORA, lixo: true });

    const r = await reservarCriacaoDeKit(asDb(db), ALVO, controles(AGORA));

    expect(lease(db)).not.toHaveProperty('lixo');
    expect(lease(db)).toMatchObject({ token: r.token });
  });

  it('a lost race on every attempt ⇒ 409 contencao after TENTATIVAS_DA_RESERVA reads; a lost race once ⇒ re-decided', async () => {
    const db = new FakeDb();
    db.falhasDeCriacao.set(CAMINHO, grpc(6, 'ALREADY_EXISTS'));
    const erro = await recusaDe(reservarCriacaoDeKit(asDb(db), ALVO, controles(AGORA)));
    expect(erro.code).toBe(CODIGO_CRIACAO_KIT_SHOPEE.contencao);
    expect(db.opLog.filter((o) => o.op === 'get' && o.path === CAMINHO)).toHaveLength(
      TENTATIVAS_DA_RESERVA,
    );
  });

  it('⛔ a Firestore failure that is NOT a lost race propagates — never read as contention', async () => {
    const db = new FakeDb();
    db.falhasDeCriacao.set(CAMINHO, grpc(14, 'UNAVAILABLE'));
    await expect(reservarCriacaoDeKit(asDb(db), ALVO, controles(AGORA))).rejects.toMatchObject({
      code: 14,
    });
  });
});

describe('liberarParaEnvio — warm, gate, fence, stamp (right before add_kit_item)', () => {
  it('stamps enviadoEmMs + sku under the read, AFTER warming the credential, and moves to `enviando`', async () => {
    const db = new FakeDb();
    const ordem: string[] = [];
    const ctl = controles(
      () => {
        ordem.push('agora');
        return AGORA + 5_000;
      },
      {
        aquecerCredencial: () => {
          ordem.push('aquecer');
          return Promise.resolve();
        },
      },
    );
    const r = await reservarCriacaoDeKit(asDb(db), ALVO, ctl);
    ordem.length = 0;

    await liberarParaEnvio(asDb(db), r, 'KIT-1');

    expect(ordem[0]).toBe('aquecer');
    expect(r.fase).toBe('enviando');
    expect(lease(db)).toMatchObject({ token: r.token, enviadoEmMs: AGORA + 5_000, sku: 'KIT-1' });
  });

  it('the send gate: agora + MARGEM < ateMs goes; AT the margin ⇒ 409 expirada, NOTHING stamped, still `tomada`', async () => {
    const db = new FakeDb();
    let agora = AGORA;
    const r = await reservarCriacaoDeKit(
      asDb(db),
      ALVO,
      controles(() => agora),
    );

    agora = r.ateMs - MARGEM_ENVIO_SHOPEE_MS;
    const erro = await recusaDe(liberarParaEnvio(asDb(db), r, 'KIT-1'));
    expect(erro.code).toBe(CODIGO_CRIACAO_KIT_SHOPEE.expirada);
    expect(lease(db)?.enviadoEmMs).toBeNull();
    expect(r.fase).toBe('tomada');

    // NEAR-MISS: one millisecond earlier, the send goes.
    agora = r.ateMs - MARGEM_ENVIO_SHOPEE_MS - 1;
    await liberarParaEnvio(asDb(db), r, 'KIT-1');
    expect(r.fase).toBe('enviando');
  });

  it("the REQUEST's ceiling binds before the lease's when it comes first (the route)", async () => {
    const db = new FakeDb();
    const prazo = AGORA + 100_000;
    const r = await reservarCriacaoDeKit(
      asDb(db),
      ALVO,
      controles(prazo - MARGEM_ENVIO_SHOPEE_MS, { prazoDaRequisicao: prazo }),
    );
    const erro = await recusaDe(liberarParaEnvio(asDb(db), r, 'KIT-1'));
    expect(erro.code).toBe(CODIGO_CRIACAO_KIT_SHOPEE.expirada);
  });

  it('(condition 4) a lease another run took over ⇒ 409 expirada, and THEIR lease is never stamped', async () => {
    const db = new FakeDb();
    let agora = AGORA;
    const a = await reservarCriacaoDeKit(
      asDb(db),
      ALVO,
      controles(() => agora),
    );
    agora = a.ateMs;
    const b = await reservarCriacaoDeKit(asDb(db), ALVO, controles(agora));
    // A's own clock, a little behind B's: A's send gate still passes, and B's
    // lease is NOT far ahead of it (within the clock slack) — so the ONLY thing
    // that can refuse A here is the token check.
    agora = a.ateMs - MARGEM_ENVIO_SHOPEE_MS - 1;
    expect(estadoDaCriacaoDeKitShopee(lease(db), agora)).toMatchObject({
      tipo: 'em-andamento',
      token: b.token,
    });

    const erro = await recusaDe(liberarParaEnvio(asDb(db), a, 'KIT-1'));
    expect(erro.code).toBe(CODIGO_CRIACAO_KIT_SHOPEE.expirada);
    expect(lease(db)).toMatchObject({ token: b.token, enviadoEmMs: null });
  });

  it('a write landing between the fence read and the stamp ⇒ 409 expirada (the precondition), never a blind stamp', async () => {
    const db = new FakeDb();
    const r = await reservarCriacaoDeKit(asDb(db), ALVO, controles(AGORA));
    db.falhasDeUpdate.set(CAMINHO, grpc(9, 'FAILED_PRECONDITION'));
    const erro = await recusaDe(liberarParaEnvio(asDb(db), r, 'KIT-1'));
    expect(erro.code).toBe(CODIGO_CRIACAO_KIT_SHOPEE.expirada);
    expect(r.fase).toBe('tomada');
  });

  it('⛔ a second send under the same reserva is a defect, never a second stamp', async () => {
    const db = new FakeDb();
    const r = await reservarCriacaoDeKit(asDb(db), ALVO, controles(AGORA));
    await liberarParaEnvio(asDb(db), r, 'KIT-1');
    await expect(liberarParaEnvio(asDb(db), r, 'KIT-1')).rejects.toThrow(/fase enviando/);
  });
});

describe('liberarReserva — token-fenced, best effort', () => {
  it('deletes OUR lease under its read, and marks the reserva `encerrada`', async () => {
    const db = new FakeDb();
    const r = await reservarCriacaoDeKit(asDb(db), ALVO, controles(AGORA));
    await liberarReserva(asDb(db), r);
    expect(lease(db)).toBeUndefined();
    expect(db.deletes).toEqual([{ path: CAMINHO, comPrecondicao: true }]);
    expect(r.fase).toBe('encerrada');
  });

  it('⛔ never touches a lease another run took over; an absent one is a no-op', async () => {
    const db = new FakeDb();
    const a = await reservarCriacaoDeKit(asDb(db), ALVO, controles(AGORA));
    const b = await reservarCriacaoDeKit(asDb(db), ALVO, controles(a.ateMs));
    await liberarReserva(asDb(db), a);
    expect(lease(db)).toMatchObject({ token: b.token });

    await liberarReserva(asDb(db), b);
    await liberarReserva(asDb(db), b);
    expect(lease(db)).toBeUndefined();
  });

  it('a Firestore failure is logged and swallowed (the lease expires on its own); a non-Firestore throw is our bug and propagates', async () => {
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = new FakeDb();
    const r = await reservarCriacaoDeKit(asDb(db), ALVO, controles(AGORA));
    db.falhasDeDelete.set(CAMINHO, grpc(14, 'UNAVAILABLE'));
    await liberarReserva(asDb(db), r);
    expect(aviso).toHaveBeenCalledWith(expect.stringContaining('expira sozinha'), {
      integracaoId: 'int-1',
      produtoId: 'kit-k',
      codigo: 14,
    });
    expect(lease(db)).toBeDefined();

    const r2 = await reservarCriacaoDeKit(
      asDb(db),
      { ...ALVO, produtoId: 'kit-j' },
      controles(AGORA),
    );
    db.falhasDeDelete.set(
      `kitCriacaoShopee/${idDaCriacaoDeKit('int-1', 'kit-j')}`,
      new TypeError('bug'),
    );
    await expect(liberarReserva(asDb(db), r2)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('the clocks of a held lease', () => {
  it('esperaDaReservaEnviada: the stamped hold left — TTL + grace on the reserva clock, less as time passes', async () => {
    const db = new FakeDb();
    let agora = AGORA;
    const r = await reservarCriacaoDeKit(
      asDb(db),
      ALVO,
      controles(() => agora),
    );
    expect(esperaDaReservaEnviada(r)).toBe(ESPERA_MAXIMA_CRIACAO_KIT_SHOPEE_MS);
    agora = AGORA + 100_000;
    expect(esperaDaReservaEnviada(r)).toBe(ESPERA_MAXIMA_CRIACAO_KIT_SHOPEE_MS - 100_000);
    // Never zero or negative: the web always gets a wait it can hold.
    agora = AGORA + 10 * ESPERA_MAXIMA_CRIACAO_KIT_SHOPEE_MS;
    expect(esperaDaReservaEnviada(r)).toBe(1);
  });

  it('podeContinuarNaReserva: the SAME comparison as the send gate (true one ms before the margin, false at it)', async () => {
    const db = new FakeDb();
    let agora = AGORA;
    const r = await reservarCriacaoDeKit(
      asDb(db),
      ALVO,
      controles(() => agora),
    );
    const pode = podeContinuarNaReserva(r);
    agora = r.ateMs - MARGEM_ENVIO_SHOPEE_MS - 1;
    expect(pode()).toBe(true);
    agora = r.ateMs - MARGEM_ENVIO_SHOPEE_MS;
    expect(pode()).toBe(false);
    // An invalid clock stops the walk.
    agora = Number.NaN;
    expect(pode()).toBe(false);
  });
});
