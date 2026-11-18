import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import { marcarProdutoPublicado } from './marcarPublicado';

/* -------------------------------------------------------------------------- */
/*                               fake Firestore                               */
/* -------------------------------------------------------------------------- */
/**
 * The `produtos` half of a Firestore double, just wide enough for one
 * `get()` + `update(patch, { lastUpdateTime })`. Every update is recorded with
 * its precondition, and a stale precondition throws FAILED_PRECONDITION (code 9)
 * exactly as the Admin SDK does — without it the tier-1 guard could never lose.
 */
type DocData = Record<string, unknown>;

interface Stamp {
  readonly v: number;
}

class FakeDb {
  readonly produtos = new Map<string, { data: DocData; updateTime: Stamp }>();
  readonly updates: Array<{ id: string; patch: DocData; lastUpdateTime: Stamp | undefined }> = [];
  /** Runs between the read and the write — a concurrent writer. */
  entreLeituraEEscrita: (() => void) | null = null;
  /** Thrown by `update()` instead of applying it. */
  falhaNoUpdate: Error | null = null;
  private relogio = 0;

  seed(id: string, data: DocData): this {
    this.produtos.set(id, { data, updateTime: { v: ++this.relogio } });
    return this;
  }

  editar(id: string, patch: DocData): void {
    const atual = this.produtos.get(id)!;
    this.produtos.set(id, {
      data: { ...atual.data, ...patch },
      updateTime: { v: ++this.relogio },
    });
  }

  collection(path: string) {
    if (path !== 'produtos') throw new Error(`coleção inesperada: ${path}`);
    return {
      doc: (id: string) => ({
        get: async () => {
          const doc = this.produtos.get(id);
          const snap = {
            exists: doc !== undefined,
            updateTime: doc?.updateTime,
            data: () => doc?.data,
          };
          this.entreLeituraEEscrita?.();
          return snap;
        },
        update: async (patch: DocData, opts?: { lastUpdateTime?: Stamp }) => {
          if (this.falhaNoUpdate !== null) throw this.falhaNoUpdate;
          const doc = this.produtos.get(id);
          if (doc === undefined) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
          if (opts?.lastUpdateTime !== undefined && opts.lastUpdateTime !== doc.updateTime) {
            throw Object.assign(new Error('FAILED_PRECONDITION'), { code: 9 });
          }
          this.updates.push({ id, patch, lastUpdateTime: opts?.lastUpdateTime });
          this.editar(id, patch);
        },
      }),
    };
  }

  get asFirestore(): Firestore {
    return this as unknown as Firestore;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('marcarProdutoPublicado', () => {
  it('ticks a not-published produto, writing ONLY `publicado` under the read precondition', async () => {
    const db = new FakeDb().seed('p1', {
      nome: 'Camiseta',
      publicado: false,
      ultimaModificacao: 1,
    });
    const lido = db.produtos.get('p1')!.updateTime;

    await expect(marcarProdutoPublicado(db.asFirestore, 'p1')).resolves.toBe('marcado');

    expect(db.updates).toEqual([{ id: 'p1', patch: { publicado: true }, lastUpdateTime: lido }]);
    expect(db.produtos.get('p1')!.data).toEqual({
      nome: 'Camiseta',
      publicado: true,
      ultimaModificacao: 1,
    });
  });

  it('treats an ABSENT flag (a legacy row) as not published', async () => {
    const db = new FakeDb().seed('p1', { nome: 'Camiseta' });

    await expect(marcarProdutoPublicado(db.asFirestore, 'p1')).resolves.toBe('marcado');
    expect(db.produtos.get('p1')!.data.publicado).toBe(true);
  });

  it('writes nothing when the produto is already published', async () => {
    const db = new FakeDb().seed('p1', { publicado: true });

    await expect(marcarProdutoPublicado(db.asFirestore, 'p1')).resolves.toBe('ja-publicado');
    expect(db.updates).toEqual([]);
  });

  // Near-miss of the line above: only the BOOLEAN true counts as published.
  it('still ticks a truthy non-boolean value', async () => {
    const db = new FakeDb().seed('p1', { publicado: 'true' });

    await expect(marcarProdutoPublicado(db.asFirestore, 'p1')).resolves.toBe('marcado');
    expect(db.produtos.get('p1')!.data.publicado).toBe(true);
  });

  it('never resurrects a missing produto', async () => {
    const db = new FakeDb();

    await expect(marcarProdutoPublicado(db.asFirestore, 'nao-existe')).resolves.toBe('inexistente');
    expect(db.produtos.has('nao-existe')).toBe(false);
  });

  it('answers `inexistente` when the produto is deleted between the read and the write', async () => {
    const db = new FakeDb().seed('p1', { publicado: false });
    db.entreLeituraEEscrita = () => db.produtos.delete('p1');

    await expect(marcarProdutoPublicado(db.asFirestore, 'p1')).resolves.toBe('inexistente');
    expect(db.produtos.has('p1')).toBe(false);
  });

  it('loses to a concurrent operator edit and writes nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = new FakeDb().seed('p1', { publicado: false });
    // The operator saves the produto (still un-ticked) between our read and our write.
    db.entreLeituraEEscrita = () => db.editar('p1', { nome: 'Editado' });

    await expect(marcarProdutoPublicado(db.asFirestore, 'p1')).resolves.toBe('conflito');
    expect(db.updates).toEqual([]);
    expect(db.produtos.get('p1')!.data).toEqual({ publicado: false, nome: 'Editado' });
  });

  it('rethrows any other failure', async () => {
    const db = new FakeDb().seed('p1', { publicado: false });
    const falha = Object.assign(new Error('UNAVAILABLE'), { code: 14 });
    db.falhaNoUpdate = falha;

    await expect(marcarProdutoPublicado(db.asFirestore, 'p1')).rejects.toBe(falha);
  });
});
