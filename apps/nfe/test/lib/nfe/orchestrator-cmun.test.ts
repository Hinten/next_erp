import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { ensureCodigoMunicipio } from '@/lib/nfe/orchestrator/cmun';
import { NFeOrchestratorError } from '@/lib/nfe/orchestrator/errors';

/**
 * `ensureCodigoMunicipio` — the emission-time cMun lookup (#785).
 *
 * The generator hard-requires the código in three places, but nothing on any
 * server path used to produce it. This resolves it from the `CMUN` table, and
 * — the property this suite exists to pin — **writes nothing to the endereço**.
 */

interface Faixa {
  cepInicial: number;
  cepFinal: number;
  cMun: string;
  nomeMunicipio: string;
  estado: string;
  origem?: string | null;
}

/** Serves the resolver's single query shape and records every write attempt. */
class FakeDb {
  readonly rows = new Map<string, Faixa>();
  readonly writes: string[] = [];

  seed(faixa: Faixa): void {
    this.rows.set(String(faixa.cepInicial).padStart(8, '0'), faixa);
  }

  collection(path: string) {
    const self = this;
    let gte: number | null = null;
    const q = {
      where(_f: string, _op: string, value: number) {
        gte = value;
        return q;
      },
      orderBy: () => q,
      limit: () => q,
      get: () => {
        const hit = [...self.rows.entries()]
          .filter(([, f]) => gte === null || f.cepFinal >= gte)
          .sort((a, b) => a[1].cepFinal - b[1].cepFinal)[0];
        return Promise.resolve({ docs: hit ? [{ id: hit[0], data: () => hit[1] }] : [] });
      },
      doc: (id: string) => ({
        id,
        create: (data: Faixa) => {
          self.writes.push(`${path}/${id}`);
          self.rows.set(id, data);
          return Promise.resolve();
        },
        update: (patch: unknown) => {
          self.writes.push(`${path}/${id} ${JSON.stringify(patch)}`);
          return Promise.resolve();
        },
      }),
    };
    return q;
  }
}

function db(fake: FakeDb): Firestore {
  return fake as unknown as Firestore;
}

const SP: Faixa = {
  cepInicial: 1_000_000,
  cepFinal: 1_099_999,
  cMun: '3550308',
  nomeMunicipio: 'SAO PAULO',
  estado: 'SP',
};

const forbiddenViaCep = {
  buscarCep: vi.fn(() => {
    throw new Error('ViaCEP must not be consulted here');
  }),
};

describe('ensureCodigoMunicipio', () => {
  beforeEach(() => __resetAllReadCaches());
  afterEach(() => {
    __resetAllReadCaches();
    vi.restoreAllMocks();
  });

  it('short-circuits on a stored 7-digit código', async () => {
    const fake = new FakeDb();

    const result = await ensureCodigoMunicipio(
      db(fake),
      { cep: '99999999', codigoMunicipio: '3550308', estado: 'SP' },
      { contexto: 'endereco test', resolve: { viaCep: forbiddenViaCep } },
    );

    expect(result.codigoMunicipio).toBe('3550308');
  });

  it.each([
    ['an empty string', ''],
    ['a 6-digit value', '355030'],
    ['null', null],
  ])('treats %s as missing and resolves from the table', async (_label, stored) => {
    // `enderecoSchema.codigoMunicipio` is `.max(8).regex(/^\d*$/)`, so `''` is
    // storable — and used to reach the generator as an empty <cMun>.
    const fake = new FakeDb();
    fake.seed(SP);

    const result = await ensureCodigoMunicipio(
      db(fake),
      { cep: '01050000', codigoMunicipio: stored, estado: 'SP' },
      { contexto: 'endereco test', resolve: { viaCep: forbiddenViaCep } },
    );

    expect(result.codigoMunicipio).toBe('3550308');
  });

  /**
   * The property this file exists for. `endereco.codigoMunicipio` is a MANUAL
   * override, not a cache — the CMUN table is what caches CEP → município. An
   * earlier revision of this code persisted the resolved value back onto the
   * endereço; that is precisely what must not happen.
   */
  it('writes NOTHING to the endereço', async () => {
    const fake = new FakeDb();
    fake.seed(SP);

    await ensureCodigoMunicipio(
      db(fake),
      { cep: '01050000', codigoMunicipio: null, estado: 'SP' },
      { contexto: 'endereco test', resolve: { viaCep: forbiddenViaCep } },
    );

    // A table hit writes nothing at all — not to the endereço, not to CMUN.
    expect(fake.writes).toEqual([]);
  });

  it('teaches the CMUN table (not the endereço) when ViaCEP resolves a gap', async () => {
    const fake = new FakeDb();
    const viaCep = {
      buscarCep: vi.fn(() =>
        Promise.resolve({
          logradouro: '',
          bairro: '',
          cidade: 'São Paulo',
          estado: 'SP',
          codigoMunicipio: '3550308',
        }),
      ),
    };

    const result = await ensureCodigoMunicipio(
      db(fake),
      { cep: '01500000', codigoMunicipio: null, estado: 'SP' },
      { contexto: 'endereco test', resolve: { viaCep } },
    );

    expect(result.codigoMunicipio).toBe('3550308');
    // Exactly one write, and it is a CMUN row — never the endereço.
    expect(fake.writes).toEqual(['CMUN/01500000']);
  });

  describe('unresolvable', () => {
    it('names the document, the CEP and the reason', async () => {
      const err = await ensureCodigoMunicipio(
        db(new FakeDb()),
        { cep: '123', codigoMunicipio: null, estado: 'SP' },
        {
          contexto: "endereco 'clientes/c1/enderecos/e1'",
          resolve: { viaCep: forbiddenViaCep },
        },
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NFeOrchestratorError);
      const message = (err as Error).message;
      expect(message).toContain('clientes/c1/enderecos/e1');
      expect(message).toContain('123');
      expect(message).toContain('cep-invalido');
    });

    it('reports a CEP outside every faixa when offline', async () => {
      const err = await ensureCodigoMunicipio(
        db(new FakeDb()),
        { cep: '99999999', codigoMunicipio: null, estado: 'SP' },
        {
          contexto: 'endereco test',
          resolve: { viaCep: forbiddenViaCep, offline: true },
        },
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NFeOrchestratorError);
      expect((err as Error).message).toContain('desconhecido');
    });
  });
});
