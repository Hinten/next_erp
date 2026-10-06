import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  avisoNaoLido,
  avisoSchema,
  chaveDeAviso,
  entradaDeLeitura,
  type Aviso,
} from '@delfrance/schemas';
import {
  AvisoEscalacaoError,
  escreverAviso,
  resolverAviso,
  type PlanoAviso,
  type ResolverAvisoOpts,
} from './escreverAviso';

const AGORA_US = 1_760_000_000_000_000;

/* -------------------------------------------------------------------------- */
/*  Fake Admin-SDK Firestore                                                  */
/*                                                                            */
/*  Only what `escreverAviso` touches: `collection(p).doc(id)` returning a ref */
/*  with `create` / `get` / `update` / `set`. `create` throws gRPC 6 when the  */
/*  document exists; `update` honours the `lastUpdateTime` precondition and    */
/*  throws gRPC 9 on a mismatch, which is the whole point of the exercise.     */
/* -------------------------------------------------------------------------- */

interface Stored {
  data: Record<string, unknown>;
  updateTime: number;
}

function grpc(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function makeDb(seed: Record<string, Stored> = {}) {
  const store: Record<string, Stored> = { ...seed };
  let relogio = 100;
  /** Simulates another writer landing between our `get` and our `update`. */
  let aoLer: ((path: string) => void) | null = null;
  let aoCriar: (() => Promise<unknown>) | null = null;

  const docRef = (path: string) => ({
    path,
    create: async (data: Record<string, unknown>) => {
      const interferencia = aoCriar;
      aoCriar = null;
      await interferencia?.();
      if (store[path]) throw grpc(6, 'ALREADY_EXISTS');
      relogio += 1;
      store[path] = { data, updateTime: relogio };
    },
    get: () => {
      aoLer?.(path);
      const atual = store[path];
      return Promise.resolve({
        exists: atual !== undefined,
        updateTime: atual?.updateTime,
        data: () => atual?.data,
      });
    },
    update: (patch: Record<string, unknown>, precond?: { lastUpdateTime?: number }) => {
      const atual = store[path];
      if (!atual) return Promise.reject(grpc(5, 'NOT_FOUND'));
      if (precond?.lastUpdateTime !== undefined && precond.lastUpdateTime !== atual.updateTime) {
        return Promise.reject(grpc(9, 'FAILED_PRECONDITION'));
      }
      relogio += 1;
      const aplicado: Record<string, unknown> = { ...patch };
      for (const [campo, valor] of Object.entries(patch)) {
        if (
          valor !== null &&
          typeof valor === 'object' &&
          '__increment' in valor &&
          typeof valor.__increment === 'number'
        ) {
          const anterior = atual.data[campo];
          aplicado[campo] = (typeof anterior === 'number' ? anterior : 0) + valor.__increment;
        }
      }
      store[path] = { data: { ...atual.data, ...aplicado }, updateTime: relogio };
      return Promise.resolve();
    },
    set: (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      const atual = store[path];
      relogio += 1;
      store[path] = { data: opts?.merge ? { ...atual?.data, ...data } : data, updateTime: relogio };
      return Promise.resolve();
    },
  });

  const db = {
    collection: (colPath: string) => ({
      doc: (id: string) => docRef(`${colPath}/${id}`),
    }),
    doc: (path: string) => docRef(path),
  };

  return {
    db: db as unknown as Firestore,
    store,
    /** Land a competing write after a missing read, before the next create. */
    interferirNaProximaCriacao(acao: () => Promise<unknown>) {
      aoCriar = acao;
    },
    /** Register a one-shot concurrent write that fires on the next `get`. */
    interferirNaProximaLeitura(mutacao: Partial<Record<string, unknown>>) {
      aoLer = (path) => {
        aoLer = null;
        relogio += 1;
        store[path] = { data: { ...store[path]?.data, ...mutacao }, updateTime: relogio };
      };
    },
  };
}

const increment = (by: number) => ({ __increment: by });
const deps = { increment, agoraUs: AGORA_US };

const PLANO: PlanoAviso = {
  tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
  severidade: SEVERIDADE_AVISO.atencao,
  conta: 'integracao-1',
  janela: '2026-11-02',
  params: { loja: 'Delfrance', dias: 29 },
};

const CHAVE = chaveDeAviso(PLANO);
const PATH = `avisos/${CHAVE}`;

describe('escreverAviso — first raise', () => {
  it('creates the row at the dedup key, with ocorrencias 1 and unresolved', async () => {
    const { db, store } = makeDb();
    const out = await escreverAviso(db, PLANO, deps);

    expect(out).toEqual({ chave: CHAVE, resultado: 'criado' });
    expect(store[PATH]?.data).toMatchObject({
      tipo: TIPO_AVISO.shopeeAutorizacaoExpirando,
      ocorrencias: 1,
      criadoEm: AGORA_US,
      atualizadoEm: AGORA_US,
      resolvidoEm: null,
      params: { loja: 'Delfrance', dias: 29 },
    });
  });
});

describe('escreverAviso — the repeat, which must NOT re-alert', () => {
  it('collapses a second producer onto the same row and bumps ocorrencias', async () => {
    // The weekly sweep and Shopee `push 12` describe one expiry. Two rows would
    // mean the operator is told twice about one problem.
    const { db, store } = makeDb();
    await escreverAviso(db, PLANO, deps);
    const out = await escreverAviso(db, PLANO, { ...deps, agoraUs: AGORA_US + 999 });

    expect(out.resultado).toBe('repetido');
    expect(Object.keys(store)).toEqual([PATH]);
    expect(store[PATH]?.data.ocorrencias).toBe(2);
  });

  it('keeps the ORIGINAL criadoEm so a read aviso stays read', async () => {
    // This is the load-bearing half. `avisoNaoLido` compares `criadoEm` against
    // the operator's watermark; moving it on every repeat would make a recurring
    // warning re-surface forever, which is precisely what dedup exists to stop.
    const { db, store } = makeDb();
    await escreverAviso(db, PLANO, deps);
    await escreverAviso(db, PLANO, { ...deps, agoraUs: AGORA_US + 999 });

    expect(store[PATH]?.data.criadoEm).toBe(AGORA_US);
    expect(store[PATH]?.data.atualizadoEm).toBe(AGORA_US + 999);
  });
});

describe('escreverAviso — the reopen, which MUST re-alert', () => {
  it('clears the resolution and takes a NEW criadoEm', async () => {
    // A problem that went away and came back is genuinely new: it has to clear
    // the operator's read watermark, or a resolved-then-recurring failure is
    // invisible forever.
    const { db, store } = makeDb();
    await escreverAviso(db, PLANO, deps);
    await resolverAviso(db, CHAVE, 'reautorizado', { agoraUs: AGORA_US + 10 });

    const out = await escreverAviso(db, PLANO, { ...deps, agoraUs: AGORA_US + 20 });

    expect(out.resultado).toBe('reaberto');
    expect(store[PATH]?.data.resolvidoEm).toBeNull();
    expect(store[PATH]?.data.resolucaoMotivo).toBeNull();
    expect(store[PATH]?.data.criadoEm).toBe(AGORA_US + 20);
  });
});

describe('escreverAviso × avisoNaoLido — what the operator actually sees', () => {
  // Crosses the writer and the read rule, because each half was correct alone
  // and the pair was not: the reopen moved `criadoEm` while the reader accepted a
  // bare id from `lidos` before ever looking at it, so an aviso read individually
  // stayed read after it came back.
  const UID = 'uid-1';

  function naoLido(data: Record<string, unknown> | undefined, lidos: string[]): boolean {
    const visto = data as Pick<Aviso, 'criadoEm' | 'destinatarioUid' | 'resolvidoEm'>;
    return avisoNaoLido(visto, CHAVE, { ultimaVisualizacaoUs: 0, lidos }, UID);
  }

  it('re-alerts a reopened aviso the operator had marked read individually', async () => {
    const { db, store } = makeDb();
    await escreverAviso(db, PLANO, deps);
    const lidos = [entradaDeLeitura(CHAVE, store[PATH]?.data.criadoEm as number)];
    expect(naoLido(store[PATH]?.data, lidos)).toBe(false);

    await resolverAviso(db, CHAVE, 'reautorizado', { agoraUs: AGORA_US + 10 });
    await escreverAviso(db, PLANO, { ...deps, agoraUs: AGORA_US + 20 });

    expect(naoLido(store[PATH]?.data, lidos)).toBe(true);
  });

  it('keeps a repeat read — the near-miss that must NOT re-alert', async () => {
    const { db, store } = makeDb();
    await escreverAviso(db, PLANO, deps);
    const lidos = [entradaDeLeitura(CHAVE, store[PATH]?.data.criadoEm as number)];

    await escreverAviso(db, PLANO, { ...deps, agoraUs: AGORA_US + 999 });

    expect(naoLido(store[PATH]?.data, lidos)).toBe(false);
  });
});

describe('escreverAviso — concurrency', () => {
  it('retries against a fresh read when another writer wins the race', async () => {
    const { db, store, interferirNaProximaLeitura } = makeDb();
    await escreverAviso(db, PLANO, deps);

    // Someone else updates the doc between our get and our update: the
    // precondition must reject, and the retry must re-read rather than
    // re-applying the patch that just lost.
    interferirNaProximaLeitura({ motivo: 'de-outro-escritor' });
    const out = await escreverAviso(db, PLANO, { ...deps, agoraUs: AGORA_US + 5 });

    expect(out.resultado).toBe('repetido');
    expect(store[PATH]?.data.atualizadoEm).toBe(AGORA_US + 5);
  });

  it('drops a provider delivery that is not fresher than the stored event clock', async () => {
    const { db, store } = makeDb();
    await escreverAviso(db, { ...PLANO, relogioEvento: 500 }, deps);

    const out = await escreverAviso(
      db,
      { ...PLANO, relogioEvento: 400 },
      {
        ...deps,
        agoraUs: AGORA_US + 5,
      },
    );

    expect(out.resultado).toBe('ignorado');
    expect(store[PATH]?.data.relogioEvento).toBe(500);
    expect(store[PATH]?.data.atualizadoEm).toBe(AGORA_US);
  });

  it('a producer with NO clock does not wipe the stored watermark', async () => {
    // The two-producer case this module exists for: `push 12` carries a delivery
    // clock, the weekly sweep does not. If the clock-less writer nulls the stored
    // watermark, the guard stops rejecting anything and a stale redelivery wins —
    // rule 7's "a watermark that is never advanced is a guard that never rejects",
    // except reset rather than merely stale.
    const { db, store } = makeDb();
    await escreverAviso(db, { ...PLANO, relogioEvento: 900 }, deps);
    await escreverAviso(db, PLANO, { ...deps, agoraUs: AGORA_US + 5 });

    expect(store[PATH]?.data.relogioEvento).toBe(900);

    const stale = await escreverAviso(
      db,
      { ...PLANO, relogioEvento: 100 },
      {
        ...deps,
        agoraUs: AGORA_US + 10,
      },
    );
    expect(stale.resultado).toBe('ignorado');
  });

  it('a producer that omits a field does not blank what another one stored', async () => {
    // An absent optional means "I do not know", never "set it to null". The sweep
    // knows the expiry window; the push knows the provider reason and its deep
    // link. Whoever writes second must not erase the other's detail.
    const { db, store } = makeDb();
    await escreverAviso(
      db,
      { ...PLANO, motivo: 'open_api_authorization_expiry', urlExterna: 'https://x' },
      deps,
    );
    await escreverAviso(db, PLANO, { ...deps, agoraUs: AGORA_US + 5 });

    expect(store[PATH]?.data.motivo).toBe('open_api_authorization_expiry');
    expect(store[PATH]?.data.urlExterna).toBe('https://x');
  });

  it('advances the watermark on the write that WINS', async () => {
    // A watermark that is never advanced is a guard that never rejects anything.
    const { db, store } = makeDb();
    await escreverAviso(db, { ...PLANO, relogioEvento: 500 }, deps);
    await escreverAviso(db, { ...PLANO, relogioEvento: 900 }, { ...deps, agoraUs: AGORA_US + 5 });

    expect(store[PATH]?.data.relogioEvento).toBe(900);
  });
});

describe('escreverAviso — crítico escalation', () => {
  const critico: PlanoAviso = { ...PLANO, severidade: SEVERIDADE_AVISO.critico };

  it('escalates a crítico and not an atenção', async () => {
    const escalar = vi.fn().mockResolvedValue(undefined);
    const { db } = makeDb();

    await escreverAviso(db, PLANO, { ...deps, escalar });
    expect(escalar).not.toHaveBeenCalled();

    await escreverAviso(db, { ...critico, janela: 'outra' }, { ...deps, escalar });
    expect(escalar).toHaveBeenCalledTimes(1);
  });

  it('writes the aviso anyway when the webhook is down', async () => {
    // The durable row is the system of record. A broken doorbell must not lose it.
    const escalar = vi.fn().mockRejectedValue(new AvisoEscalacaoError('502 from webhook'));
    const warn = vi.fn();
    const { db, store } = makeDb();

    const out = await escreverAviso(db, critico, { ...deps, escalar, logger: { warn } });

    expect(out.resultado).toBe('criado');
    expect(store[PATH]?.data.severidade).toBe(SEVERIDADE_AVISO.critico);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does NOT swallow a programming error in the escalator', async () => {
    // Rule 6: `err instanceof Error` is not a narrowing. A bug in the escalator
    // must surface instead of being reported as a clean write.
    const escalar = vi.fn().mockRejectedValue(new ReferenceError('x is not defined'));
    const { db } = makeDb();

    await expect(escreverAviso(db, critico, { ...deps, escalar })).rejects.toThrow(ReferenceError);
  });
});

describe('resolverAviso', () => {
  it('stamps the resolution as a timestamp, not a boolean', async () => {
    const { db, store } = makeDb();
    await escreverAviso(db, PLANO, deps);

    await expect(
      resolverAviso(db, CHAVE, 'reautorizado', { agoraUs: AGORA_US + 10 }),
    ).resolves.toBe(true);
    expect(store[PATH]?.data.resolvidoEm).toBe(AGORA_US + 10);
    expect(store[PATH]?.data.resolucaoMotivo).toBe('reautorizado');
  });

  // ⚠️ The near-miss of the assertion above: the first call is a TRANSITION and
  // answers `true`; the second sees a row that is already resolved, answers
  // `false` and — the half that matters — leaves `resolvidoEm` where it was.
  // A resolver that re-stamps it on every weekly run pushes the row out of
  // `sweepAvisosResolvidos`'s 90-day window forever.
  it('is a no-op on an already-resolved aviso, and does not move resolvidoEm', async () => {
    const { db, store } = makeDb();
    await escreverAviso(db, PLANO, deps);

    await expect(
      resolverAviso(db, CHAVE, 'reautorizado', { agoraUs: AGORA_US + 10 }),
    ).resolves.toBe(true);
    await expect(
      resolverAviso(db, CHAVE, 'reautorizado', { agoraUs: AGORA_US + 999 }),
    ).resolves.toBe(false);

    expect(store[PATH]?.data.resolvidoEm).toBe(AGORA_US + 10);
    expect(store[PATH]?.data.atualizadoEm).toBe(AGORA_US + 10);
  });

  it('does not resurrect a swept aviso as a ghost', async () => {
    // `merge` on the Admin SDK is an UPSERT; reading first and then `update`ing
    // is why a resolver racing the retention sweep cannot recreate a document
    // holding only the patch keys.
    const { db, store } = makeDb();
    await expect(resolverAviso(db, 'nao-existe', 'x', { agoraUs: AGORA_US })).resolves.toBe(false);
    expect(store['avisos/nao-existe']).toBeUndefined();
  });

  it('without a clock, leaves a stored relogioEvento exactly where it was', async () => {
    // Every pre-step-17 caller passes no `opts`: the resolve neither checks nor
    // touches the watermark, so the raise's guard keeps working after it.
    const { db, store } = makeDb();
    await escreverAviso(db, { ...PLANO, relogioEvento: 500 }, deps);

    await expect(
      resolverAviso(db, CHAVE, 'reautorizado', { agoraUs: AGORA_US + 10 }),
    ).resolves.toBe(true);
    expect(store[PATH]?.data.relogioEvento).toBe(500);
  });
});

describe('resolverAviso — first resolved observation (#1771)', () => {
  const OPTS: ResolverAvisoOpts = { ...PLANO, relogioEvento: 3_000 };

  it('creates a complete resolved row without a transition, unread notice or escalation', async () => {
    const { db, store } = makeDb();
    const escalar = vi.fn();
    const resolucaoDeps = { agoraUs: AGORA_US, escalar };
    await expect(
      resolverAviso(db, CHAVE, 'closed', resolucaoDeps, {
        ...OPTS,
        severidade: SEVERIDADE_AVISO.critico,
      }),
    ).resolves.toBe(false);

    const row = avisoSchema.parse(store[PATH]?.data);
    expect(row).toMatchObject({
      tipo: PLANO.tipo,
      severidade: SEVERIDADE_AVISO.critico,
      canal: null,
      params: PLANO.params,
      motivo: null,
      prazo: null,
      urlInterna: null,
      criadoEm: AGORA_US,
      atualizadoEm: AGORA_US,
      resolvidoEm: AGORA_US,
      resolucaoMotivo: 'closed',
      relogioEvento: 3_000,
      ocorrencias: 1,
    });
    expect(avisoNaoLido(row, CHAVE, null, 'operator')).toBe(false);
    expect(escalar).not.toHaveBeenCalled();
  });

  it('rejects a mismatched identity before writing', async () => {
    const { db, store } = makeDb();
    await expect(
      resolverAviso(db, CHAVE, 'closed', deps, { ...OPTS, conta: 'another-account' }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(store).toEqual({});
  });

  it.each([true, false])('converges when the older raise runs first: %s', async (raiseFirst) => {
    const { db, store } = makeDb();
    const raise = () => escreverAviso(db, { ...PLANO, relogioEvento: 2_000 }, deps);
    if (raiseFirst) await raise();
    await expect(
      resolverAviso(db, CHAVE, 'closed', { agoraUs: AGORA_US + 10 }, OPTS),
    ).resolves.toBe(raiseFirst);
    if (!raiseFirst) expect((await raise()).resultado).toBe('ignorado');
    expect(avisoSchema.parse(store[PATH]?.data)).toMatchObject({
      resolvidoEm: AGORA_US + 10,
      relogioEvento: 3_000,
      ocorrencias: 1,
    });
  });

  it('drops equal and older first raises, but a one-tick-newer raise reopens and alerts', async () => {
    const { db, store } = makeDb();
    await resolverAviso(db, CHAVE, 'closed', deps, OPTS);
    const closed = avisoSchema.parse(store[PATH]?.data);
    for (const relogioEvento of [2_999, 3_000]) {
      expect(
        (await escreverAviso(db, { ...PLANO, relogioEvento }, { ...deps, agoraUs: AGORA_US + 10 }))
          .resultado,
      ).toBe('ignorado');
      expect(store[PATH]?.data).toEqual(closed);
    }

    const out = await escreverAviso(
      db,
      { ...PLANO, relogioEvento: 3_001 },
      { ...deps, agoraUs: AGORA_US + 30 },
    );
    expect(out.resultado).toBe('reaberto');
    const reopened = avisoSchema.parse(store[PATH]?.data);
    expect(reopened).toMatchObject({
      resolvidoEm: null,
      resolucaoMotivo: null,
      criadoEm: AGORA_US + 30,
      relogioEvento: 3_001,
      ocorrencias: 2,
    });
    expect(
      avisoNaoLido(
        reopened,
        CHAVE,
        { ultimaVisualizacaoUs: AGORA_US, lidos: [entradaDeLeitura(CHAVE, closed.criadoEm)] },
        'operator',
      ),
    ).toBe(true);
  });

  it('replay preserves the resolution, and newer clocks do not replace existing metadata', async () => {
    const { db, store } = makeDb();
    await resolverAviso(db, CHAVE, 'first-reason', deps, OPTS);
    const before = avisoSchema.parse(store[PATH]?.data);
    const changed: ResolverAvisoOpts = {
      ...OPTS,
      severidade: SEVERIDADE_AVISO.critico,
      params: { loja: 'replacement' },
      motivo: 'replacement',
    };
    await expect(
      resolverAviso(db, CHAVE, 'another-reason', { agoraUs: AGORA_US + 10 }, changed),
    ).resolves.toBe(false);
    expect(store[PATH]?.data).toEqual(before);
    await expect(
      resolverAviso(
        db,
        CHAVE,
        'another-reason',
        { agoraUs: AGORA_US + 20 },
        {
          ...changed,
          relogioEvento: 3_001,
        },
      ),
    ).resolves.toBe(false);
    expect(store[PATH]?.data).toEqual({ ...before, relogioEvento: 3_001 });
  });

  it.each([2_000, 3_001])(
    're-decides after a competing raise at clock %s creates the row',
    async (clock) => {
      const fake = makeDb();
      fake.interferirNaProximaCriacao(() =>
        escreverAviso(
          fake.db,
          { ...PLANO, params: { loja: 'winning-raise' }, relogioEvento: clock },
          { ...deps, agoraUs: AGORA_US + 5 },
        ),
      );
      await expect(
        resolverAviso(fake.db, CHAVE, 'closed', { agoraUs: AGORA_US + 10 }, OPTS),
      ).resolves.toBe(clock < OPTS.relogioEvento);
      expect(avisoSchema.parse(fake.store[PATH]?.data)).toMatchObject({
        params: { loja: 'winning-raise' },
        relogioEvento: Math.max(clock, OPTS.relogioEvento),
        resolvidoEm: clock < OPTS.relogioEvento ? AGORA_US + 10 : null,
        ocorrencias: 1,
      });
    },
  );

  it.each([2_000, 3_001])(
    'a competing resolve at clock %s keeps its resolution and the greatest clock',
    async (clock) => {
      const fake = makeDb();
      fake.interferirNaProximaCriacao(() =>
        resolverAviso(
          fake.db,
          CHAVE,
          'first-reason',
          { agoraUs: AGORA_US + 5 },
          {
            ...OPTS,
            relogioEvento: clock,
          },
        ),
      );
      await expect(
        resolverAviso(fake.db, CHAVE, 'later-reason', { agoraUs: AGORA_US + 10 }, OPTS),
      ).resolves.toBe(false);
      expect(avisoSchema.parse(fake.store[PATH]?.data)).toMatchObject({
        criadoEm: AGORA_US + 5,
        resolvidoEm: AGORA_US + 5,
        resolucaoMotivo: 'first-reason',
        relogioEvento: Math.max(clock, OPTS.relogioEvento),
        ocorrencias: 1,
      });
    },
  );

  it('propagates a creation transport failure', async () => {
    const fake = makeDb();
    const failure = grpc(14, 'UNAVAILABLE');
    fake.interferirNaProximaCriacao(() => Promise.reject(failure));
    await expect(resolverAviso(fake.db, CHAVE, 'closed', deps, OPTS)).rejects.toBe(failure);
    expect(fake.store).toEqual({});
  });
});

describe('resolverAviso — the event clock (rule 7 tier 2, Shopee step 17)', () => {
  // Two deliveries of one provider event can commit in one order and run their
  // aviso effect in the other. The precondition orders the WRITES, not the
  // observations; only the provider's clock says which observation is newer.
  // The return tipo is the first caller, with µs + content revision.
  const DEVOLUCAO: PlanoAviso = {
    tipo: TIPO_AVISO.reclamacaoAguardandoVendedor,
    severidade: SEVERIDADE_AVISO.atencao,
    conta: 'int-1',
    entidade: '260910ABCDE0001',
    params: { pedido: '260910KJBHUJDM', devolucao: '260910ABCDE0001' },
  };
  const CHAVE_DEVOLUCAO = chaveDeAviso(DEVOLUCAO);
  const PATH_DEVOLUCAO = `avisos/${CHAVE_DEVOLUCAO}`;

  it('a late, OLDER resolve does not close a row a newer raise opened', async () => {
    const { db, store } = makeDb();
    await escreverAviso(db, { ...DEVOLUCAO, relogioEvento: 2_000 }, deps);

    await expect(
      resolverAviso(
        db,
        CHAVE_DEVOLUCAO,
        'ACCEPTED',
        { agoraUs: AGORA_US + 10 },
        { ...DEVOLUCAO, relogioEvento: 1_000 },
      ),
    ).resolves.toBe(false);
    expect(store[PATH_DEVOLUCAO]?.data.resolvidoEm).toBeNull();
    expect(store[PATH_DEVOLUCAO]?.data.relogioEvento).toBe(2_000);
    expect(store[PATH_DEVOLUCAO]?.data.atualizadoEm).toBe(AGORA_US);
  });

  it('an EQUAL clock is stale too — the same rule as the raise', async () => {
    const { db, store } = makeDb();
    await escreverAviso(db, { ...DEVOLUCAO, relogioEvento: 2_000 }, deps);

    await expect(
      resolverAviso(
        db,
        CHAVE_DEVOLUCAO,
        'ACCEPTED',
        { agoraUs: AGORA_US + 10 },
        { ...DEVOLUCAO, relogioEvento: 2_000 },
      ),
    ).resolves.toBe(false);
    expect(store[PATH_DEVOLUCAO]?.data.resolvidoEm).toBeNull();
  });

  it('a NEWER resolve closes it and stamps its clock — the near-miss one tick later', async () => {
    const { db, store } = makeDb();
    await escreverAviso(db, { ...DEVOLUCAO, relogioEvento: 2_000 }, deps);

    await expect(
      resolverAviso(
        db,
        CHAVE_DEVOLUCAO,
        'ACCEPTED',
        { agoraUs: AGORA_US + 10 },
        { ...DEVOLUCAO, relogioEvento: 2_001 },
      ),
    ).resolves.toBe(true);
    expect(store[PATH_DEVOLUCAO]?.data).toMatchObject({
      resolvidoEm: AGORA_US + 10,
      resolucaoMotivo: 'ACCEPTED',
      relogioEvento: 2_001,
    });
  });

  it('stamps the clock, so a late OLDER raise after the resolve cannot reopen the row', async () => {
    // The other half of the inversion: without the stamp the stored watermark
    // stays at the raise's 2 000, and a raise observed at 2 500 — older than the
    // resolve's 3 000 — would reopen a closed return with a fresh `criadoEm`.
    const { db, store } = makeDb();
    await escreverAviso(db, { ...DEVOLUCAO, relogioEvento: 2_000 }, deps);
    await resolverAviso(
      db,
      CHAVE_DEVOLUCAO,
      'ACCEPTED',
      { agoraUs: AGORA_US + 10 },
      { ...DEVOLUCAO, relogioEvento: 3_000 },
    );

    const tardio = await escreverAviso(
      db,
      { ...DEVOLUCAO, relogioEvento: 2_500 },
      { ...deps, agoraUs: AGORA_US + 20 },
    );
    expect(tardio.resultado).toBe('ignorado');
    expect(store[PATH_DEVOLUCAO]?.data.resolvidoEm).toBe(AGORA_US + 10);
    expect(store[PATH_DEVOLUCAO]?.data.criadoEm).toBe(AGORA_US);

    // …while a raise NEWER than the resolve does reopen it — the problem came back.
    const novo = await escreverAviso(
      db,
      { ...DEVOLUCAO, relogioEvento: 3_001 },
      { ...deps, agoraUs: AGORA_US + 30 },
    );
    expect(novo.resultado).toBe('reaberto');
  });

  it('a stored null clock is not evidence of order: the resolve proceeds and stamps', async () => {
    const { db, store } = makeDb();
    await escreverAviso(db, DEVOLUCAO, deps);
    expect(store[PATH_DEVOLUCAO]?.data.relogioEvento).toBeNull();

    await expect(
      resolverAviso(
        db,
        CHAVE_DEVOLUCAO,
        'CLOSED',
        { agoraUs: AGORA_US + 10 },
        { ...DEVOLUCAO, relogioEvento: 1 },
      ),
    ).resolves.toBe(true);
    expect(store[PATH_DEVOLUCAO]?.data.relogioEvento).toBe(1);
  });

  it('an already-resolved row is not RE-resolved, but a newer clock advances its watermark', async () => {
    // The transition contract is unchanged (no second `resolvidoEm`, `false`)…
    const { db, store } = makeDb();
    await escreverAviso(db, { ...DEVOLUCAO, relogioEvento: 2_000 }, deps);
    await resolverAviso(
      db,
      CHAVE_DEVOLUCAO,
      'ACCEPTED',
      { agoraUs: AGORA_US + 10 },
      { ...DEVOLUCAO, relogioEvento: 3_000 },
    );

    await expect(
      resolverAviso(
        db,
        CHAVE_DEVOLUCAO,
        'CLOSED',
        { agoraUs: AGORA_US + 99 },
        { ...DEVOLUCAO, relogioEvento: 4_000 },
      ),
    ).resolves.toBe(false);
    expect(store[PATH_DEVOLUCAO]?.data).toMatchObject({
      resolvidoEm: AGORA_US + 10,
      resolucaoMotivo: 'ACCEPTED',
      // …but the newer CLOSED observation moved the watermark.
      relogioEvento: 4_000,
    });

    // So a late raise observed between the two closes (3 500) cannot reopen it.
    const tardio = await escreverAviso(
      db,
      { ...DEVOLUCAO, relogioEvento: 3_500 },
      { ...deps, agoraUs: AGORA_US + 120 },
    );
    expect(tardio.resultado).toBe('ignorado');
    expect(store[PATH_DEVOLUCAO]?.data.resolvidoEm).toBe(AGORA_US + 10);
  });

  it('near-miss: an EQUAL or OLDER clock on a resolved row writes nothing', async () => {
    const { db, store } = makeDb();
    await escreverAviso(db, { ...DEVOLUCAO, relogioEvento: 2_000 }, deps);
    await resolverAviso(
      db,
      CHAVE_DEVOLUCAO,
      'ACCEPTED',
      { agoraUs: AGORA_US + 10 },
      { ...DEVOLUCAO, relogioEvento: 3_000 },
    );
    const antes = store[PATH_DEVOLUCAO]?.data;

    for (const relogioEvento of [3_000, 2_500]) {
      await expect(
        resolverAviso(
          db,
          CHAVE_DEVOLUCAO,
          'CLOSED',
          { agoraUs: AGORA_US + 99 },
          { ...DEVOLUCAO, relogioEvento },
        ),
      ).resolves.toBe(false);
    }
    expect(store[PATH_DEVOLUCAO]?.data).toEqual(antes);
  });

  it('a resolved row with NO clock passed stays exactly as it was (the periodic resolvers)', async () => {
    const { db, store } = makeDb();
    await escreverAviso(db, { ...DEVOLUCAO, relogioEvento: 2_000 }, deps);
    await resolverAviso(db, CHAVE_DEVOLUCAO, 'ACCEPTED', { agoraUs: AGORA_US + 10 });
    const antes = store[PATH_DEVOLUCAO]?.data;

    await expect(
      resolverAviso(db, CHAVE_DEVOLUCAO, 'CLOSED', { agoraUs: AGORA_US + 99 }),
    ).resolves.toBe(false);
    expect(store[PATH_DEVOLUCAO]?.data).toEqual(antes);
  });
});

describe('resolverAviso — a lost precondition WITH a clock is re-decided, not conceded', () => {
  // The CONCURRENT inversion, which the sequential tests above cannot reach: the
  // newer resolve READS first, an older raise then lands, and the resolve's
  // update loses the precondition. "Someone else wrote it, their write stands"
  // is true of the clock-less periodic resolvers; with a clock the winner can be
  // the OLDER observation, and nothing re-drives a terminal return afterwards.
  const DEVOLUCAO: PlanoAviso = {
    tipo: TIPO_AVISO.reclamacaoAguardandoVendedor,
    severidade: SEVERIDADE_AVISO.atencao,
    conta: 'int-1',
    entidade: '260910ABCDE0001',
    params: { pedido: '260910KJBHUJDM', devolucao: '260910ABCDE0001' },
  };
  const CHAVE_DEVOLUCAO = chaveDeAviso(DEVOLUCAO);
  const PATH_DEVOLUCAO = `avisos/${CHAVE_DEVOLUCAO}`;

  type RefFalso = {
    get: () => Promise<unknown>;
    update: (patch: Record<string, unknown>, precond?: unknown) => Promise<void>;
  } & Record<string, unknown>;
  type DbFalso = { collection: (c: string) => { doc: (id: string) => RefFalso } };

  /**
   * Wrap the fake so another writer lands BETWEEN the resolve's read and the
   * update it built from that read — `interferirNaProximaLeitura` fires BEFORE
   * the read and cannot express this. `antes` runs to completion ahead of each
   * of the first `vezes` updates whose patch matches `quando`; the interfering
   * write goes through the UNWRAPPED db, so it is neither intercepted nor counted.
   */
  function comEscritorEntreLeituraEUpdate(
    db: Firestore,
    quando: (patch: Record<string, unknown>) => boolean,
    antes: () => Promise<unknown>,
    vezes = 1,
  ) {
    const contagem = { leituras: 0, updates: 0, interferencias: 0 };
    const real = db as unknown as DbFalso;
    const envolto: DbFalso = {
      collection: (c) => ({
        doc: (id) => {
          const r = real.collection(c).doc(id);
          return {
            ...r,
            get: () => {
              contagem.leituras += 1;
              return r.get();
            },
            update: async (patch, precond) => {
              contagem.updates += 1;
              if (contagem.interferencias < vezes && quando(patch)) {
                contagem.interferencias += 1;
                await antes();
              }
              return r.update(patch, precond);
            },
          };
        },
      }),
    };
    return { db: envolto as unknown as Firestore, contagem };
  }

  const ehResolucao = (p: Record<string, unknown>) => 'resolvidoEm' in p;
  const ehAvancoDeRelogio = (p: Record<string, unknown>) =>
    'relogioEvento' in p && !('resolvidoEm' in p);

  /** A clock-carrying raise of the same return, landing at `agoraUs`. */
  const levantar = (db: Firestore, relogioEvento: number, agoraUs: number) => () =>
    escreverAviso(db, { ...DEVOLUCAO, motivo: 'REQUESTED', relogioEvento }, { ...deps, agoraUs });

  /** A row raised at 1 000 — and, for the advance branch, resolved at 2 000. */
  async function semear(jaResolvido: boolean) {
    const fake = makeDb();
    await escreverAviso(fake.db, { ...DEVOLUCAO, relogioEvento: 1_000 }, deps);
    if (jaResolvido) {
      await resolverAviso(
        fake.db,
        CHAVE_DEVOLUCAO,
        'sem-pendencia-do-vendedor',
        { agoraUs: AGORA_US + 1 },
        { ...DEVOLUCAO, relogioEvento: 2_000 },
      );
    }
    return fake;
  }

  /** Both branches that write under a precondition: the resolve and the advance. */
  const RAMOS = [
    { ramo: 'an OPEN row (the resolve)', jaResolvido: false },
    { ramo: 'a RESOLVED row (the watermark advance)', jaResolvido: true },
  ] as const;

  it('OPEN row: an OLDER raise lands between the resolve’s read and its update — the row still ends resolved at the newer clock', async () => {
    const { db, store } = await semear(false);

    const corrida = comEscritorEntreLeituraEUpdate(
      db,
      ehResolucao,
      levantar(db, 3_000, AGORA_US + 5),
    );
    await expect(
      resolverAviso(
        corrida.db,
        CHAVE_DEVOLUCAO,
        'devolucao-encerrada',
        { agoraUs: AGORA_US + 10 },
        { ...DEVOLUCAO, relogioEvento: 4_000 },
      ),
    ).resolves.toBe(true);

    expect(corrida.contagem).toEqual({ leituras: 2, updates: 2, interferencias: 1 });
    expect(store[PATH_DEVOLUCAO]?.data).toMatchObject({
      resolvidoEm: AGORA_US + 10,
      resolucaoMotivo: 'devolucao-encerrada',
      relogioEvento: 4_000,
      // The interfering raise really landed — the retry wrote OVER it, from a
      // fresh read, rather than re-applying the losing attempt's decision.
      motivo: 'REQUESTED',
    });
  });

  it('RESOLVED row: an OLDER raise REOPENS it between the advance’s read and its update — the row ends resolved again at the newer clock', async () => {
    const { db, store } = await semear(true);

    const corrida = comEscritorEntreLeituraEUpdate(
      db,
      ehAvancoDeRelogio,
      levantar(db, 3_000, AGORA_US + 5),
    );
    // A real transition: the row this call found open (after the reopen), it closed.
    await expect(
      resolverAviso(
        corrida.db,
        CHAVE_DEVOLUCAO,
        'devolucao-encerrada',
        { agoraUs: AGORA_US + 10 },
        { ...DEVOLUCAO, relogioEvento: 4_000 },
      ),
    ).resolves.toBe(true);

    expect(corrida.contagem).toEqual({ leituras: 2, updates: 2, interferencias: 1 });
    expect(store[PATH_DEVOLUCAO]?.data).toMatchObject({
      resolvidoEm: AGORA_US + 10,
      resolucaoMotivo: 'devolucao-encerrada',
      relogioEvento: 4_000,
      criadoEm: AGORA_US + 5,
    });
  });

  it('near-miss, OPEN row: the interleaved raise is NEWER — the retry is stale and the row stays open', async () => {
    const { db, store } = await semear(false);

    const corrida = comEscritorEntreLeituraEUpdate(
      db,
      ehResolucao,
      levantar(db, 5_000, AGORA_US + 5),
    );
    await expect(
      resolverAviso(
        corrida.db,
        CHAVE_DEVOLUCAO,
        'devolucao-encerrada',
        { agoraUs: AGORA_US + 10 },
        { ...DEVOLUCAO, relogioEvento: 4_000 },
      ),
    ).resolves.toBe(false);

    expect(corrida.contagem).toEqual({ leituras: 2, updates: 1, interferencias: 1 });
    expect(store[PATH_DEVOLUCAO]?.data).toMatchObject({
      resolvidoEm: null,
      relogioEvento: 5_000,
      atualizadoEm: AGORA_US + 5,
    });
  });

  it('near-miss, RESOLVED row: the interleaved REOPEN is NEWER — the retry is stale and the row stays open', async () => {
    const { db, store } = await semear(true);

    const corrida = comEscritorEntreLeituraEUpdate(
      db,
      ehAvancoDeRelogio,
      levantar(db, 5_000, AGORA_US + 5),
    );
    await expect(
      resolverAviso(
        corrida.db,
        CHAVE_DEVOLUCAO,
        'devolucao-encerrada',
        { agoraUs: AGORA_US + 10 },
        { ...DEVOLUCAO, relogioEvento: 4_000 },
      ),
    ).resolves.toBe(false);

    expect(corrida.contagem).toEqual({ leituras: 2, updates: 1, interferencias: 1 });
    expect(store[PATH_DEVOLUCAO]?.data).toMatchObject({
      resolvidoEm: null,
      relogioEvento: 5_000,
      criadoEm: AGORA_US + 5,
    });
  });

  // The winner is another RESOLVE — the race the clock-less contract was written
  // for. The retry re-reads a RESOLVED row and so takes the advance branch: no
  // second transition (`false`), and the watermark ends at the newer of the two.
  it.each([
    { ramo: 'an OPEN row', jaResolvido: false, outro: 3_000, final: 4_000 },
    { ramo: 'an OPEN row', jaResolvido: false, outro: 5_000, final: 5_000 },
    { ramo: 'a RESOLVED row', jaResolvido: true, outro: 5_000, final: 5_000 },
  ])(
    'on $ramo, a concurrent resolve at $outro wins ⇒ false, no re-resolve, watermark $final',
    async ({ jaResolvido, outro, final }) => {
      const { db, store } = await semear(jaResolvido);
      const resolvidoAntes = store[PATH_DEVOLUCAO]?.data.resolvidoEm;

      const corrida = comEscritorEntreLeituraEUpdate(
        db,
        jaResolvido ? ehAvancoDeRelogio : ehResolucao,
        () =>
          resolverAviso(
            db,
            CHAVE_DEVOLUCAO,
            'CLOSED',
            { agoraUs: AGORA_US + 5 },
            { ...DEVOLUCAO, relogioEvento: outro },
          ),
      );
      await expect(
        resolverAviso(
          corrida.db,
          CHAVE_DEVOLUCAO,
          'devolucao-encerrada',
          { agoraUs: AGORA_US + 10 },
          { ...DEVOLUCAO, relogioEvento: 4_000 },
        ),
      ).resolves.toBe(false);

      expect(store[PATH_DEVOLUCAO]?.data).toMatchObject({
        // Whoever closed it first keeps the stamp and the motivo.
        resolvidoEm: jaResolvido ? resolvidoAntes : AGORA_US + 5,
        resolucaoMotivo: jaResolvido ? 'sem-pendencia-do-vendedor' : 'CLOSED',
        // Never regressed by the retry (5 000 stays), always advanced to the
        // newest observation of "closed" (3 000 moves to 4 000).
        relogioEvento: final,
      });
    },
  );

  // A writer that touches the row ahead of EVERY update: each attempt re-reads a
  // decision that still says "write", and loses again. Without the bound this
  // spins forever; after the third loss it throws so the delivery can retry.
  it.each(RAMOS)(
    'is bounded on $ramo: a writer that keeps winning throws after three attempts',
    async ({ jaResolvido }) => {
      const { db, store } = await semear(jaResolvido);
      const antes = store[PATH_DEVOLUCAO]?.data;

      // Moves `updateTime` and nothing the decision reads.
      const ref = (db as unknown as DbFalso).collection('avisos').doc(CHAVE_DEVOLUCAO);
      const corrida = comEscritorEntreLeituraEUpdate(
        db,
        () => true,
        () => ref.update({}),
        Number.POSITIVE_INFINITY,
      );
      await expect(
        resolverAviso(
          corrida.db,
          CHAVE_DEVOLUCAO,
          'devolucao-encerrada',
          { agoraUs: AGORA_US + 10 },
          { ...DEVOLUCAO, relogioEvento: 4_000 },
        ),
      ).rejects.toThrow('3 attempts exhausted');

      expect(corrida.contagem).toEqual({ leituras: 3, updates: 3, interferencias: 3 });
      expect(store[PATH_DEVOLUCAO]?.data).toEqual(antes);
    },
  );

  it('WITHOUT a clock a lost precondition is still conceded on the first attempt (the periodic resolvers)', async () => {
    const { db, store } = makeDb();
    await escreverAviso(db, DEVOLUCAO, deps);

    const ref = (db as unknown as DbFalso).collection('avisos').doc(CHAVE_DEVOLUCAO);
    const corrida = comEscritorEntreLeituraEUpdate(
      db,
      () => true,
      () => ref.update({ atualizadoEm: AGORA_US + 5 }),
      Number.POSITIVE_INFINITY,
    );
    await expect(
      resolverAviso(corrida.db, CHAVE_DEVOLUCAO, 'reautorizado', { agoraUs: AGORA_US + 10 }),
    ).resolves.toBe(false);

    expect(corrida.contagem).toEqual({ leituras: 1, updates: 1, interferencias: 1 });
    expect(store[PATH_DEVOLUCAO]?.data).toMatchObject({
      resolvidoEm: null,
      atualizadoEm: AGORA_US + 5,
    });
  });

  it('WITHOUT a clock, deletion between read and update still returns false without creating a row', async () => {
    const { db, store } = await semear(false);
    const corrida = comEscritorEntreLeituraEUpdate(
      db,
      () => true,
      () => Promise.resolve(Reflect.deleteProperty(store, PATH_DEVOLUCAO)),
    );
    await expect(
      resolverAviso(corrida.db, CHAVE_DEVOLUCAO, 'closed', { agoraUs: AGORA_US + 10 }),
    ).resolves.toBe(false);
    expect(corrida.contagem).toEqual({ leituras: 1, updates: 1, interferencias: 1 });
    expect(store[PATH_DEVOLUCAO]).toBeUndefined();
  });

  it.each(RAMOS)(
    'NOT_FOUND on $ramo retries and records a complete resolved row',
    async ({ jaResolvido }) => {
      const { db, store } = await semear(jaResolvido);

      // The retention sweep deletes the row between the read and the update.
      const corrida = comEscritorEntreLeituraEUpdate(
        db,
        () => true,
        () => Promise.resolve(Reflect.deleteProperty(store, PATH_DEVOLUCAO)),
      );
      await expect(
        resolverAviso(
          corrida.db,
          CHAVE_DEVOLUCAO,
          'devolucao-encerrada',
          { agoraUs: AGORA_US + 10 },
          { ...DEVOLUCAO, relogioEvento: 4_000 },
        ),
      ).resolves.toBe(false);

      expect(corrida.contagem).toEqual({ leituras: 2, updates: 1, interferencias: 1 });
      expect(avisoSchema.parse(store[PATH_DEVOLUCAO]?.data)).toMatchObject({
        tipo: DEVOLUCAO.tipo,
        ocorrencias: 1,
        resolvidoEm: AGORA_US + 10,
        resolucaoMotivo: 'devolucao-encerrada',
        relogioEvento: 4_000,
      });
    },
  );
});
