import { describe, expect, it } from 'vitest';
import * as barrel from './index';
import { ALL_DOMAINS } from './registry';
import * as modulo from './sincEstoqueLojaIntegrada';
import {
  BALDES_SNAPSHOT_ESTOQUE_LI,
  COLECAO_SINC_ESTOQUE_LI,
  FLAG_ENTRADA_ESTOQUE_LI,
  ID_BALDE_SNAPSHOT_ESTOQUE_LI_REGEX,
  ID_PAIS_SNAPSHOT_ESTOQUE_LI,
  MAX_KITS_EM_LINHA_ESTOQUE_LI,
  MAX_KITS_POR_FATIA_ESTOQUE_LI,
  SUBCOLECOES_SINC_ESTOQUE_LI,
  baldeSnapshotEstoqueLi,
  entradaSnapshotEstoqueLiSchema,
  fatiaKitsComponenteEstoqueLiSchema,
  flagEntradaEstoqueLiSchema,
  idDocumentoEstoqueLiSchema,
  idFatiaKitsEstoqueLi,
  idProdutoLiTextoSchema,
  kitsComponenteEstoqueLiSchema,
  paisSnapshotEstoqueLiSchema,
  sincEstoqueLojaIntegradaSchema,
  snapshotEstoqueLiSchema,
} from './sincEstoqueLojaIntegrada';

const AGORA_MS = 1_800_000_000_000;
const RUN = 'estoque-reconcile-20271115';

describe('sincEstoqueLojaIntegradaSchema (the per-conta root)', () => {
  it('an empty document parses to the defaults: no list read under way, no finished run', () => {
    expect(sincEstoqueLojaIntegradaSchema.parse({})).toEqual({
      reconcile: null,
      ultimoReconcile: null,
    });
  });

  it('a full document round-trips, every stamp in ms', () => {
    const doc = {
      reconcile: { offset: 600, limite: 50, iniciadoEmMs: AGORA_MS },
      ultimoReconcile: {
        execucaoId: RUN,
        iniciadoEmMs: AGORA_MS - 3_600_000,
        concluidoEmMs: AGORA_MS - 60_000,
        contadores: { linhasLi: 7103, candidatos: 41, retidos: 12 },
      },
    };
    expect(sincEstoqueLojaIntegradaSchema.parse(doc)).toEqual(doc);
  });

  it('an explicit null cursor and last run round-trip — null is the stored "none", not an absence', () => {
    const doc = { reconcile: null, ultimoReconcile: null };
    expect(sincEstoqueLojaIntegradaSchema.parse(doc)).toEqual(doc);
  });

  it('a last run stored without counters reads with none, never as a refusal', () => {
    const ultimoReconcile = { execucaoId: RUN, iniciadoEmMs: AGORA_MS, concluidoEmMs: AGORA_MS };
    expect(sincEstoqueLojaIntegradaSchema.parse({ ultimoReconcile }).ultimoReconcile).toEqual({
      ...ultimoReconcile,
      contadores: {},
    });
  });

  it('STRIPS unknown keys — no light-mode field survives a write', () => {
    const lido = sincEstoqueLojaIntegradaSchema.parse({
      modoPendente: 'completo',
      ultimoCompletoEmMs: AGORA_MS,
      janelaDesdeMs: AGORA_MS,
      continuacao: { ultimoProdutoId: 'p1' },
    }) as Record<string, unknown>;
    expect(Object.keys(lido).sort()).toEqual(['reconcile', 'ultimoReconcile']);
  });

  it('⚠️ NEAR-MISS: the cursor refuses a negative offset, a zero page and a fractional one', () => {
    for (const reconcile of [
      { offset: -1, limite: 50, iniciadoEmMs: AGORA_MS },
      { offset: 0, limite: 0, iniciadoEmMs: AGORA_MS },
      { offset: 0, limite: 50.5, iniciadoEmMs: AGORA_MS },
      { offset: 1.5, limite: 50, iniciadoEmMs: AGORA_MS },
      { offset: 0, limite: 50 },
    ]) {
      expect(sincEstoqueLojaIntegradaSchema.safeParse({ reconcile }).success).toBe(false);
    }
  });

  it('⚠️ NEAR-MISS: a cursor with no offset is refused — never a silent restart at row 0', () => {
    expect(
      sincEstoqueLojaIntegradaSchema.safeParse({
        reconcile: { limite: 50, iniciadoEmMs: AGORA_MS },
      }).success,
    ).toBe(false);
  });

  it('the page size is at most 1 000: 1 000 is a page, 1 001 is not', () => {
    const ok = (limite: number) =>
      sincEstoqueLojaIntegradaSchema.safeParse({
        reconcile: { offset: 0, limite, iniciadoEmMs: AGORA_MS },
      }).success;
    expect(ok(1000)).toBe(true);
    expect(ok(1001)).toBe(false);
  });

  it('a counter name is an identifier, and a count a non-negative integer', () => {
    const base = { execucaoId: RUN, iniciadoEmMs: AGORA_MS, concluidoEmMs: AGORA_MS };
    for (const contadores of [{ 'linhas-li': 1 }, { linhasLi: -1 }, { linhasLi: 1.5 }]) {
      expect(
        sincEstoqueLojaIntegradaSchema.safeParse({ ultimoReconcile: { ...base, contadores } })
          .success,
        JSON.stringify(contadores),
      ).toBe(false);
    }
  });

  it('is NOT registered in ALL_DOMAINS, and the module exports nothing combined { schema, meta }', () => {
    expect(ALL_DOMAINS.map((d) => d.schema)).not.toContain(sincEstoqueLojaIntegradaSchema);
    for (const d of ALL_DOMAINS) {
      expect(d.meta.collectionPath.startsWith(COLECAO_SINC_ESTOQUE_LI)).toBe(false);
    }
    expect(Object.keys(modulo).length).toBeGreaterThan(0);
    for (const [nome, valor] of Object.entries(modulo)) {
      const temSchemaEMeta =
        typeof valor === 'object' && valor !== null && 'schema' in valor && 'meta' in valor;
      expect(temSchemaEMeta, nome).toBe(false);
      expect(Reflect.get(barrel, nome), nome).toBe(valor);
    }
  });
});

describe('the id grammars', () => {
  it('a store id is its canonical decimal text, and a safe integer', () => {
    for (const ok of ['1', '123456789', '9007199254740991']) {
      expect(idProdutoLiTextoSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const ruim of ['0', '01', '-1', '1.0', ' 1', '1 ', '+1', '1e3', '', '9007199254740992']) {
      expect(idProdutoLiTextoSchema.safeParse(ruim).success, ruim).toBe(false);
    }
  });

  it('an ERP document id: no slash, not reserved, at most 1 500 bytes', () => {
    for (const ok of ['p1', 'a.b', 'x~0', '_x_', 'é'.repeat(750)]) {
      expect(idDocumentoEstoqueLiSchema.safeParse(ok).success, ok.slice(0, 8)).toBe(true);
    }
    for (const ruim of ['', 'a/b', '.', '..', '__x__', 'é'.repeat(751)]) {
      expect(idDocumentoEstoqueLiSchema.safeParse(ruim).success, ruim.slice(0, 8)).toBe(false);
    }
  });
});

describe('baldeSnapshotEstoqueLi (the snapshot bucket)', () => {
  it.each([
    ['1', '01'],
    ['31', '31'],
    ['32', '00'],
    ['33', '01'],
    ['64', '00'],
    ['123456789', '21'],
    ['7654321', '17'],
    ['9007199254740991', '31'],
  ])('GOLDEN: %s ⇒ %s', (id, balde) => {
    expect(baldeSnapshotEstoqueLi(id)).toBe(balde);
  });

  it('every answer is one of the 32 bucket ids, never the parents doc', () => {
    const vistos = new Set<string>();
    for (let n = 1; n <= 200; n += 1) {
      const balde = baldeSnapshotEstoqueLi(String(n));
      expect(balde).toMatch(ID_BALDE_SNAPSHOT_ESTOQUE_LI_REGEX);
      vistos.add(balde ?? '');
    }
    expect(vistos.size).toBe(BALDES_SNAPSHOT_ESTOQUE_LI);
    expect(ID_BALDE_SNAPSHOT_ESTOQUE_LI_REGEX.test(ID_PAIS_SNAPSHOT_ESTOQUE_LI)).toBe(false);
    expect(ID_BALDE_SNAPSHOT_ESTOQUE_LI_REGEX.test('32')).toBe(false);
  });

  it('⚠️ NEAR-MISS: non-canonical text has NO bucket (it folds nothing)', () => {
    for (const ruim of ['01', '0', '1.0', ' 1', '1 ', '', '+1', '9007199254740992', '1e3']) {
      expect(baldeSnapshotEstoqueLi(ruim), ruim).toBeNull();
    }
  });
});

describe('snapshotEstoqueLiSchema (one bucket)', () => {
  it('the flags are exactly the seven, and the named members are those seven', () => {
    expect(flagEntradaEstoqueLiSchema.options).toEqual(['v', 'r', 'par', 'amb', 'dup', 'ns', 'x']);
    expect(Object.values(FLAG_ENTRADA_ESTOQUE_LI)).toEqual(flagEntradaEstoqueLiSchema.options);
  });

  it('⚠️ NEAR-MISS: no spelling of `v` but `v` itself makes an entry — only `v` is ever sent', () => {
    for (const f of ['V', 'valido', '', ' v', 'v ']) {
      expect(entradaSnapshotEstoqueLiSchema.safeParse({ p: 'p1', s: 1, f }).success, f).toBe(false);
    }
  });

  it('a bucket stored with no entries reads as an empty one', () => {
    expect(snapshotEstoqueLiSchema.parse({ execucaoId: RUN })).toEqual({ execucaoId: RUN, e: {} });
  });

  it('round-trips a bucket with every flag', () => {
    const doc = {
      execucaoId: RUN,
      e: {
        '123456789': { p: 'p1', s: 4, f: FLAG_ENTRADA_ESTOQUE_LI.valido },
        '123456790': { p: 'kit1', s: 0, f: FLAG_ENTRADA_ESTOQUE_LI.valido, k: true as const },
        '123456791': { p: 'p2', s: null, f: FLAG_ENTRADA_ESTOQUE_LI.retido },
        '123456792': { p: 'p3', s: null, f: FLAG_ENTRADA_ESTOQUE_LI.paridade },
        '123456793': { p: 'p4', s: null, f: FLAG_ENTRADA_ESTOQUE_LI.ambiguo },
        '123456794': { p: 'p5', s: null, f: FLAG_ENTRADA_ESTOQUE_LI.duplicado },
        '123456795': { p: 'p6', s: null, f: FLAG_ENTRADA_ESTOQUE_LI.naoSuportado },
        '123456796': { p: null, s: null, f: FLAG_ENTRADA_ESTOQUE_LI.semVinculo },
      },
    };
    expect(snapshotEstoqueLiSchema.parse(doc)).toEqual(doc);
  });

  it('⚠️ NEAR-MISS: a key that is not the canonical store id is refused', () => {
    for (const chave of ['0123456789', '123456789.0', 'abc']) {
      expect(
        snapshotEstoqueLiSchema.safeParse({
          execucaoId: RUN,
          e: { [chave]: { p: 'p1', s: 1, f: FLAG_ENTRADA_ESTOQUE_LI.valido } },
        }).success,
        chave,
      ).toBe(false);
    }
  });

  it('S exists exactly on a valid entry, and the produto exactly off a no-link one', () => {
    const ok = (e: unknown) => entradaSnapshotEstoqueLiSchema.safeParse(e).success;
    expect(ok({ p: 'p1', s: 0, f: FLAG_ENTRADA_ESTOQUE_LI.valido })).toBe(true);
    expect(ok({ p: 'p1', s: null, f: FLAG_ENTRADA_ESTOQUE_LI.valido })).toBe(false);
    expect(ok({ p: 'p1', s: 3, f: FLAG_ENTRADA_ESTOQUE_LI.retido })).toBe(false);
    expect(ok({ p: 'p1', s: null, f: FLAG_ENTRADA_ESTOQUE_LI.semVinculo })).toBe(false);
    expect(ok({ p: null, s: null, f: FLAG_ENTRADA_ESTOQUE_LI.retido })).toBe(false);
    expect(ok({ p: null, s: null, f: FLAG_ENTRADA_ESTOQUE_LI.semVinculo, k: true })).toBe(false);
  });

  it('⚠️ NEAR-MISS: `s` is always written (null when not valid), and `p` is a document id', () => {
    const ok = (e: unknown) => entradaSnapshotEstoqueLiSchema.safeParse(e).success;
    expect(ok({ p: 'p1', s: null, f: FLAG_ENTRADA_ESTOQUE_LI.retido })).toBe(true);
    expect(ok({ p: 'p1', f: FLAG_ENTRADA_ESTOQUE_LI.retido })).toBe(false);
    expect(ok({ p: 'a/b', s: 1, f: FLAG_ENTRADA_ESTOQUE_LI.valido })).toBe(false);
    expect(ok({ p: '__x__', s: 1, f: FLAG_ENTRADA_ESTOQUE_LI.valido })).toBe(false);
  });

  it('S is floored and clamped at 0 BEFORE it is stored: a negative or a fraction is refused', () => {
    const ok = (s: number) =>
      entradaSnapshotEstoqueLiSchema.safeParse({ p: 'p1', s, f: FLAG_ENTRADA_ESTOQUE_LI.valido })
        .success;
    expect(ok(0)).toBe(true);
    expect(ok(-1)).toBe(false);
    expect(ok(1.5)).toBe(false);
  });

  it('`k` is `true` or absent — never `false`, which would only cost bytes', () => {
    const base = { p: 'p1', s: 1, f: FLAG_ENTRADA_ESTOQUE_LI.valido };
    expect(entradaSnapshotEstoqueLiSchema.safeParse(base).success).toBe(true);
    expect(entradaSnapshotEstoqueLiSchema.safeParse({ ...base, k: true }).success).toBe(true);
    expect(entradaSnapshotEstoqueLiSchema.safeParse({ ...base, k: false }).success).toBe(false);
  });

  it('the parents doc lists canonical store ids', () => {
    expect(paisSnapshotEstoqueLiSchema.parse({ execucaoId: RUN })).toEqual({
      execucaoId: RUN,
      ids: [],
    });
    expect(
      paisSnapshotEstoqueLiSchema.safeParse({ execucaoId: RUN, ids: ['7', '07'] }).success,
    ).toBe(false);
  });

  it('a run id is task-name safe', () => {
    for (const ruim of ['', 'run 1', 'run/1', 'run.1', 'x'.repeat(101)]) {
      expect(
        paisSnapshotEstoqueLiSchema.safeParse({ execucaoId: ruim }).success,
        ruim.slice(0, 8),
      ).toBe(false);
    }
  });
});

describe('the kits map', () => {
  const kit = (i: string) => ({ i, q: { blank: 1, print: 1 } });

  it('a component with up to 30 store kits keeps them inline, with no shard', () => {
    const doc = {
      execucaoId: RUN,
      F: 2,
      qMax: 1,
      comps: { blank: 'e-blank', print: null },
      kits: { k1: kit('11'), k2: kit('12') },
      fatias: 0,
    };
    expect(kitsComponenteEstoqueLiSchema.parse(doc)).toEqual(doc);
  });

  it(`at ${String(MAX_KITS_EM_LINHA_ESTOQUE_LI)} inline; at ${String(MAX_KITS_EM_LINHA_ESTOQUE_LI + 1)} only in shards`, () => {
    const kits = Object.fromEntries(
      Array.from({ length: MAX_KITS_EM_LINHA_ESTOQUE_LI + 1 }, (_, n) => [
        `k${String(n)}`,
        kit(String(100 + n)),
      ]),
    );
    const trinta = Object.fromEntries(Object.entries(kits).slice(0, MAX_KITS_EM_LINHA_ESTOQUE_LI));
    const base = { execucaoId: RUN, qMax: 1 };
    expect(
      kitsComponenteEstoqueLiSchema.safeParse({
        ...base,
        F: MAX_KITS_EM_LINHA_ESTOQUE_LI,
        kits: trinta,
      }).success,
    ).toBe(true);
    // NEAR-MISS: 31 inline is refused, and so is 30 sent to shards.
    expect(
      kitsComponenteEstoqueLiSchema.safeParse({
        ...base,
        F: MAX_KITS_EM_LINHA_ESTOQUE_LI + 1,
        kits,
      }).success,
    ).toBe(false);
    expect(
      kitsComponenteEstoqueLiSchema.safeParse({
        ...base,
        F: MAX_KITS_EM_LINHA_ESTOQUE_LI,
        fatias: 1,
      }).success,
    ).toBe(false);
    expect(
      kitsComponenteEstoqueLiSchema.safeParse({
        ...base,
        F: MAX_KITS_EM_LINHA_ESTOQUE_LI + 1,
        fatias: 1,
      }).success,
    ).toBe(true);
  });

  it('⚠️ NEAR-MISS: inline kits carry no shard count, and a header names at least one kit', () => {
    const base = { execucaoId: RUN, qMax: 1 };
    expect(
      kitsComponenteEstoqueLiSchema.safeParse({
        ...base,
        F: 2,
        kits: { k1: kit('11'), k2: kit('12') },
        fatias: 1,
      }).success,
    ).toBe(false);
    expect(kitsComponenteEstoqueLiSchema.safeParse({ ...base, F: 0, kits: {} }).success).toBe(
      false,
    );
  });

  it('⚠️ NEAR-MISS: a kit’s store id and the sibling map keep their grammars', () => {
    const base = { execucaoId: RUN, qMax: 1, F: 1 };
    for (const ruim of [
      { kits: { k1: { i: '011', q: { blank: 1 } } } },
      { kits: { k1: { i: 'abc', q: { blank: 1 } } } },
      { comps: { 'a/b': null }, kits: { k1: kit('11') } },
      { comps: { blank: 'e/1' }, kits: { k1: kit('11') } },
    ]) {
      expect(
        kitsComponenteEstoqueLiSchema.safeParse({ ...base, ...ruim }).success,
        JSON.stringify(ruim),
      ).toBe(false);
    }
    expect(
      kitsComponenteEstoqueLiSchema.safeParse({
        ...base,
        comps: { blank: 'e-blank' },
        kits: { k1: kit('11') },
      }).success,
    ).toBe(true);
  });

  it('the shard count is ⌈F / 1000⌉, exactly', () => {
    const base = { execucaoId: RUN, qMax: 2 };
    const ok = (F: number, fatias: number) =>
      kitsComponenteEstoqueLiSchema.safeParse({ ...base, F, fatias }).success;
    expect(ok(2000, 2)).toBe(true);
    expect(ok(2001, 3)).toBe(true);
    expect(ok(2001, 2)).toBe(false);
    expect(ok(2000, 3)).toBe(false);
  });

  it('F counts the inline kits exactly; a kit names at least one component, each quantity positive', () => {
    const base = { execucaoId: RUN, qMax: 1, comps: {} };
    expect(
      kitsComponenteEstoqueLiSchema.safeParse({ ...base, F: 3, kits: { k1: kit('11') } }).success,
    ).toBe(false);
    expect(
      kitsComponenteEstoqueLiSchema.safeParse({ ...base, F: 1, kits: { k1: { i: '11', q: {} } } })
        .success,
    ).toBe(false);
    expect(
      kitsComponenteEstoqueLiSchema.safeParse({
        ...base,
        F: 1,
        kits: { k1: { i: '11', q: { blank: 0 } } },
      }).success,
    ).toBe(false);
    // A fractional quantity is a real kit shape (sold by weight, by length).
    expect(
      kitsComponenteEstoqueLiSchema.safeParse({
        ...base,
        qMax: 0.5,
        F: 1,
        kits: { k1: { i: '11', q: { blank: 0.5 } } },
      }).success,
    ).toBe(true);
  });

  it(`a shard holds 1 to ${String(MAX_KITS_POR_FATIA_ESTOQUE_LI)} kits`, () => {
    const kits = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, k) => [`k${String(k)}`, kit('11')]));
    const ok = (n: number) =>
      fatiaKitsComponenteEstoqueLiSchema.safeParse({ execucaoId: RUN, kits: kits(n) }).success;
    expect(ok(1)).toBe(true);
    expect(ok(MAX_KITS_POR_FATIA_ESTOQUE_LI)).toBe(true);
    expect(ok(0)).toBe(false);
    expect(ok(MAX_KITS_POR_FATIA_ESTOQUE_LI + 1)).toBe(false);
  });

  it('a shard id is `<component>~<n>`, in a subcollection of its own beside the headers', () => {
    expect(idFatiaKitsEstoqueLi('blank', 0)).toBe('blank~0');
    expect(idFatiaKitsEstoqueLi('blank', 12)).toBe('blank~12');
    expect(idFatiaKitsEstoqueLi('blank', 0)).not.toBe('blank');
    // A produto id may itself end in `~0`, so a shard id CAN equal a header id: the two never
    // share a collection.
    expect(SUBCOLECOES_SINC_ESTOQUE_LI.kitsFatias).not.toBe(SUBCOLECOES_SINC_ESTOQUE_LI.kits);
    expect(new Set(Object.values(SUBCOLECOES_SINC_ESTOQUE_LI)).size).toBe(3);
    for (const [id, n] of [
      ['a/b', 0],
      ['', 0],
      ['__x__', 0],
      ['blank', -1],
      ['blank', 1.5],
      ['x'.repeat(1499), 0],
    ] as const) {
      expect(() => idFatiaKitsEstoqueLi(id, n), `${id.slice(0, 8)} ${String(n)}`).toThrow(
        RangeError,
      );
    }
  });

  it('⚠️ NEAR-MISS: among the shards the LAST `~` splits an id back into ONE (component, n)', () => {
    const pares = [
      ['blank', 0],
      ['blank', 10],
      ['blank~0', 1],
      ['blank~1', 0],
      ['a~b', 3],
    ] as const;
    const ids = pares.map(([c, n]) => idFatiaKitsEstoqueLi(c, n));
    expect(new Set(ids).size).toBe(ids.length);
    for (const [n, id] of ids.entries()) {
      const corte = id.lastIndexOf('~');
      expect([id.slice(0, corte), Number(id.slice(corte + 1))]).toEqual(pares[n]);
    }
  });
});
