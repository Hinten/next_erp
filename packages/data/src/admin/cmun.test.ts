import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { ViaCepClient } from '@delfrance/core/cep';
import { ViaCepError } from '@delfrance/core/cep';
import { __resetAllReadCaches } from './cache';
import { CodigoMunicipioNaoResolvidoError, resolveCodigoMunicipio } from './cmun';

/**
 * `resolveCodigoMunicipio` — the CMUN table with a ViaCEP write-back (#785).
 *
 * The write-back is the design: a CEP the table does not cover costs one
 * external call ever, then becomes a local row. ViaCEP rate-limits (429), so
 * that property is load-bearing, not a nicety.
 */

interface Faixa {
  cepInicial: number;
  cepFinal: number;
  cMun: string;
  nomeMunicipio: string;
  estado: string;
  origem?: string | null;
}

/**
 * Minimal Firestore stand-in for the ONE query shape the resolver issues:
 * `where('cepFinal','>=',n).orderBy('cepFinal').limit(1)`. Modelling exactly
 * that (rather than a general query engine) is deliberate — if the resolver is
 * ever "improved" into a different shape, these tests stop compiling instead of
 * silently passing against a fake that is more capable than Firestore.
 */
class FakeDb {
  readonly rows = new Map<string, Faixa>();
  readonly created: Array<{ id: string; data: Faixa }> = [];
  createError: Error | null = null;
  /** How many times the CMUN query actually executed. */
  queries = 0;

  seed(faixa: Faixa): void {
    this.rows.set(String(faixa.cepInicial).padStart(8, '0'), faixa);
  }

  collection(path: string) {
    if (path !== 'CMUN') throw new Error(`unexpected collection ${path}`);
    const self = this;
    let gte: number | null = null;

    const q = {
      where(field: string, op: string, value: number) {
        if (field !== 'cepFinal' || op !== '>=') {
          throw new Error(`unexpected where(${field}, ${op}) — see the resolver's query comment`);
        }
        gte = value;
        return q;
      },
      orderBy(field: string) {
        if (field !== 'cepFinal') throw new Error(`unexpected orderBy(${field})`);
        return q;
      },
      limit(n: number) {
        if (n !== 1) throw new Error(`unexpected limit(${n})`);
        return q;
      },
      get: () => {
        self.queries += 1;
        const hit = [...self.rows.entries()]
          .filter(([, f]) => gte === null || f.cepFinal >= gte)
          .sort((a, b) => a[1].cepFinal - b[1].cepFinal)[0];
        return Promise.resolve({
          docs: hit ? [{ id: hit[0], data: () => hit[1] }] : [],
          empty: !hit,
        });
      },
      doc: (id: string) => ({
        id,
        create: (data: Faixa) => {
          if (self.createError) return Promise.reject(self.createError);
          if (self.rows.has(id)) {
            return Promise.reject(Object.assign(new Error('already exists'), { code: 6 }));
          }
          self.rows.set(id, data);
          self.created.push({ id, data });
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

function viaCepReturning(
  codigoMunicipio: string,
  cidade = 'São Paulo',
  estado = 'SP',
): ViaCepClient {
  return {
    buscarCep: vi.fn(() =>
      Promise.resolve({ logradouro: '', bairro: '', cidade, estado, codigoMunicipio }),
    ),
  };
}

const forbiddenViaCep: ViaCepClient = {
  buscarCep: vi.fn(() => {
    throw new Error('ViaCEP must not be consulted here');
  }),
};

const SP = {
  cepInicial: 1_000_000,
  cepFinal: 1_099_999,
  cMun: '3550308',
  nomeMunicipio: 'SAO PAULO',
  estado: 'SP',
};

describe('resolveCodigoMunicipio', () => {
  beforeEach(() => __resetAllReadCaches());
  afterEach(() => {
    __resetAllReadCaches();
    vi.restoreAllMocks();
  });

  describe('stored override', () => {
    it('short-circuits without touching Firestore or ViaCEP', async () => {
      // A db that throws on any use proves neither leg ran.
      const exploding = {
        collection: () => {
          throw new Error('Firestore must not be queried');
        },
      } as unknown as Firestore;

      await expect(
        resolveCodigoMunicipio(
          exploding,
          { cep: '99999999', codigoMunicipio: '3550308', estado: 'SP' },
          { viaCep: forbiddenViaCep },
        ),
      ).resolves.toBe('3550308');
    });

    it.each([
      ['an empty string', ''],
      ['6 digits', '355030'],
      ['null', null],
    ])('treats %s as absent and resolves properly', async (_label, stored) => {
      // `enderecoSchema.codigoMunicipio` is `.max(8).regex(/^\d*$/)`, so '' is
      // storable — and would otherwise reach the wire as an empty <cMun>.
      const fake = new FakeDb();
      fake.seed(SP);

      await expect(
        resolveCodigoMunicipio(
          db(fake),
          { cep: '01050000', codigoMunicipio: stored, estado: 'SP' },
          { viaCep: forbiddenViaCep },
        ),
      ).resolves.toBe('3550308');
    });
  });

  describe('table hit', () => {
    it('resolves from the covering faixa without calling ViaCEP', async () => {
      const fake = new FakeDb();
      fake.seed(SP);
      const viaCep = viaCepReturning('9999999');

      await expect(
        resolveCodigoMunicipio(db(fake), { cep: '01050000', estado: 'SP' }, { viaCep }),
      ).resolves.toBe('3550308');
      expect(viaCep.buscarCep).not.toHaveBeenCalled();
    });

    it('serves a repeated CEP from the read cache, without re-querying', async () => {
      // The repeat this cache exists for: `emitirPedidosLote` fans out over
      // pedidos that share addresses. On Enterprise a saved query is saved
      // SCANNED BYTES, not just a document count.
      const fake = new FakeDb();
      fake.seed(SP);

      await resolveCodigoMunicipio(db(fake), { cep: '01050000' }, { viaCep: forbiddenViaCep });
      await resolveCodigoMunicipio(db(fake), { cep: '01050000' }, { viaCep: forbiddenViaCep });

      expect(fake.queries).toBe(1);
    });

    it('still UF-checks a cached value against EACH endereço', async () => {
      // The cache holds the CEP → município mapping, which is endereço-
      // independent. The UF cross-check is NOT: the same CEP can be looked up
      // for two endereços whose `estado` differs, and only one is wrong. If the
      // check moved inside the cache, the first caller's estado would decide
      // for the second.
      const fake = new FakeDb();
      fake.seed(SP);

      await resolveCodigoMunicipio(
        db(fake),
        { cep: '01050000', estado: 'SP' },
        { viaCep: forbiddenViaCep },
      );

      const err = await resolveCodigoMunicipio(
        db(fake),
        { cep: '01050000', estado: 'AC' },
        { viaCep: forbiddenViaCep },
      ).catch((e: unknown) => e);

      expect(fake.queries).toBe(1); // served from cache…
      expect((err as CodigoMunicipioNaoResolvidoError).motivo).toBe('uf-divergente'); // …and still checked
    });

    it('treats both faixa bounds as inclusive', async () => {
      const fake = new FakeDb();
      fake.seed(SP);

      for (const cep of ['01000000', '01099999']) {
        __resetAllReadCaches();
        await expect(
          resolveCodigoMunicipio(db(fake), { cep, estado: 'SP' }, { viaCep: forbiddenViaCep }),
        ).resolves.toBe('3550308');
      }
    });

    /**
     * THE regression this port exists to prevent. The legacy query filtered on
     * `cepFinal >= cep` with an inert `startAt` cursor and NO lower bound, so a
     * CEP in a gap matched the next faixa ABOVE it — a wrong município, into
     * the signed XML, with nothing to flag it.
     */
    it('does NOT return the next faixa above for a CEP in a gap', async () => {
      const fake = new FakeDb();
      fake.seed(SP);
      fake.seed({ ...SP, cepInicial: 2_000_000, cepFinal: 2_099_999, cMun: '3304557' });
      const viaCep = viaCepReturning('3304557', 'Rio de Janeiro', 'RJ');

      // 01500000 falls between the two faixas. The legacy would have answered
      // 3304557 from the table; we must go and ask instead.
      await resolveCodigoMunicipio(db(fake), { cep: '01500000' }, { viaCep });

      expect(viaCep.buscarCep).toHaveBeenCalledWith('01500000');
    });
  });

  describe('ViaCEP write-back — the point of the design', () => {
    it('records the resolved CEP as a new faixa', async () => {
      const fake = new FakeDb();
      const viaCep = viaCepReturning('3550308');

      await expect(
        resolveCodigoMunicipio(db(fake), { cep: '01500000', estado: 'SP' }, { viaCep }),
      ).resolves.toBe('3550308');

      expect(fake.created).toHaveLength(1);
      const [row] = fake.created;
      // Deterministic id, so re-resolution and concurrent writers converge.
      expect(row!.id).toBe('01500000');
      // A SINGLE-CEP faixa — that is all ViaCEP actually told us. Inventing a
      // range would risk shadowing a real faixa we simply have not imported.
      expect(row!.data.cepInicial).toBe(1_500_000);
      expect(row!.data.cepFinal).toBe(1_500_000);
      expect(row!.data.origem).toBe('viacep');
    });

    it('means the SAME CEP never calls ViaCEP twice', async () => {
      const fake = new FakeDb();
      const viaCep = viaCepReturning('3550308');

      await resolveCodigoMunicipio(db(fake), { cep: '01500000', estado: 'SP' }, { viaCep });
      __resetAllReadCaches(); // even with a cold process memo, the TABLE now answers
      await resolveCodigoMunicipio(db(fake), { cep: '01500000', estado: 'SP' }, { viaCep });

      expect(viaCep.buscarCep).toHaveBeenCalledTimes(1);
    });

    it('derives the UF from the código, not from ViaCEP free text', async () => {
      const fake = new FakeDb();
      // ViaCEP's `uf` disagrees with the código's own prefix; the código wins.
      const viaCep = viaCepReturning('3550308', 'São Paulo', '');

      await resolveCodigoMunicipio(db(fake), { cep: '01500000' }, { viaCep });

      expect(fake.created[0]!.data.estado).toBe('SP');
    });

    it('does not fail resolution when a concurrent writer won the id', async () => {
      const fake = new FakeDb();
      fake.createError = Object.assign(new Error('already exists'), { code: 6 });
      const viaCep = viaCepReturning('3550308');

      await expect(
        resolveCodigoMunicipio(db(fake), { cep: '01500000', estado: 'SP' }, { viaCep }),
      ).resolves.toBe('3550308');
    });

    it('rethrows a write failure that is NOT already-exists', async () => {
      const fake = new FakeDb();
      fake.createError = Object.assign(new Error('PERMISSION_DENIED'), { code: 7 });
      const viaCep = viaCepReturning('3550308');

      await expect(
        resolveCodigoMunicipio(db(fake), { cep: '01500000', estado: 'SP' }, { viaCep }),
      ).rejects.toThrow(/PERMISSION_DENIED/);
    });
  });

  describe('failures', () => {
    it('reports cep-invalido before consulting anything', async () => {
      const fake = new FakeDb();
      const err = await resolveCodigoMunicipio(
        db(fake),
        { cep: '123' },
        { viaCep: forbiddenViaCep },
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CodigoMunicipioNaoResolvidoError);
      expect((err as CodigoMunicipioNaoResolvidoError).motivo).toBe('cep-invalido');
    });

    it('reports viacep-indisponivel, preserving the cause', async () => {
      const cause = new ViaCepError('rede', '01500000');
      const viaCep: ViaCepClient = { buscarCep: vi.fn(() => Promise.reject(cause)) };

      const err = await resolveCodigoMunicipio(
        new FakeDb() as unknown as Firestore,
        {
          cep: '01500000',
        },
        { viaCep },
      ).catch((e: unknown) => e);

      expect((err as CodigoMunicipioNaoResolvidoError).motivo).toBe('viacep-indisponivel');
      expect((err as CodigoMunicipioNaoResolvidoError).cause).toBe(cause);
    });

    it('reports desconhecido in offline mode instead of calling ViaCEP', async () => {
      const viaCep = viaCepReturning('3550308');

      const err = await resolveCodigoMunicipio(
        db(new FakeDb()),
        { cep: '01500000' },
        { viaCep, offline: true },
      ).catch((e: unknown) => e);

      expect((err as CodigoMunicipioNaoResolvidoError).motivo).toBe('desconhecido');
      expect(viaCep.buscarCep).not.toHaveBeenCalled();
    });

    it('rejects a derived código that contradicts the endereço UF', async () => {
      // The ML mapper defaults a genuinely-absent estado to 'AC'; emitting a
      // São Paulo cMun under UF=AC earns SEFAZ rejection 273.
      const fake = new FakeDb();
      fake.seed(SP);

      const err = await resolveCodigoMunicipio(
        db(fake),
        { cep: '01050000', estado: 'AC' },
        { viaCep: forbiddenViaCep },
      ).catch((e: unknown) => e);

      expect((err as CodigoMunicipioNaoResolvidoError).motivo).toBe('uf-divergente');
    });
  });
});
