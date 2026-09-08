import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { SEVERIDADE_AVISO, TIPO_AVISO, chaveDeAviso } from '@delfrance/schemas';
import {
  AvisoEscalacaoError,
  escreverAviso,
  resolverAviso,
  type PlanoAviso,
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

  const docRef = (path: string) => ({
    path,
    create: (data: Record<string, unknown>) => {
      if (store[path]) return Promise.reject(grpc(6, 'ALREADY_EXISTS'));
      relogio += 1;
      store[path] = { data, updateTime: relogio };
      return Promise.resolve();
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
      store[path] = { data: { ...atual.data, ...patch }, updateTime: relogio };
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
    expect(store[PATH]?.data.ocorrencias).toEqual({ __increment: 1 });
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

  it('does not resurrect a swept aviso as a ghost', async () => {
    // `merge` on the Admin SDK is an UPSERT; `mergeIfExists` is why a resolver
    // racing the retention sweep cannot recreate a document holding only the
    // patch keys.
    const { db, store } = makeDb();
    await expect(resolverAviso(db, 'nao-existe', 'x', { agoraUs: AGORA_US })).resolves.toBe(false);
    expect(store['avisos/nao-existe']).toBeUndefined();
  });
});
