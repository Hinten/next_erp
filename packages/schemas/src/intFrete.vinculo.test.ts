/**
 * `VINCULO_INT_FRETE_CONTA` — the per-channel facts of the conta → `int_frete` sync
 * (#1528) — and the composite index each row's lookup rides.
 *
 * The constant is consumed by ONE IO core (`@delfrance/data/admin/frete`, #1369), so
 * a wrong row here is wrong for every caller at once: the Shopee trigger, the
 * Mercado Livre binding and the window pass. Nothing else pins it — the core's own
 * suite drives a fake database that has no index concept, and
 * `defaultQuery.indexes.test.ts` only sees `meta.defaultQuery`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INTEGRACAO_TIPO_LABELS } from './integracao';
import { INTEGRACAO_FRETE_LABELS } from './shared/frete';
import { VINCULO_INT_FRETE_CONTA, intFreteSchema, type VinculoIntFreteConta } from './intFrete';

const LINHAS: ReadonlyArray<readonly [string, VinculoIntFreteConta]> =
  Object.entries(VINCULO_INT_FRETE_CONTA);

/** The schema's own back-reference keys — the side of the bijection the constant must match. */
const BACK_REF = /^conta[A-Z]\w*OuterRef$/;
const backRefsDoSchema = (): string[] =>
  Object.keys(intFreteSchema.shape)
    .filter((k) => BACK_REF.test(k))
    .sort();

/**
 * The anchor: the back-refs that exist TODAY. It keeps every walk below from
 * passing vacuously (an emptied constant or schema would otherwise "match"), and a
 * third channel's field must be added here on purpose.
 */
const ANCORA = ['contaMercadoLivreMercadoEnviosOuterRef', 'contaShopeeFreteOuterRef'];

/* -------------------------------------------------------------------------- */
/*                         T24 — the constant's rows                          */
/* -------------------------------------------------------------------------- */

describe('VINCULO_INT_FRETE_CONTA — the per-channel rows (T24)', () => {
  it('pins every row byte for byte (the WIRE values, not the constants that name them)', () => {
    // `tipoConta` is `integracao.tipo` (an INT), `tipoFrete` is `int_frete.tipo`
    // (a STRING) — two different enums, so the literals are spelled out: a typo
    // that swapped one channel's value for another's would otherwise compare a
    // constant with itself. `rotuloLog` is the prefix of log lines other suites
    // assert verbatim (the Mercado Livre one must stay byte-identical).
    expect(VINCULO_INT_FRETE_CONTA).toEqual({
      mercadoLivre: {
        tipoConta: 1,
        tipoFrete: 'mercadoLivre',
        campoBackRef: 'contaMercadoLivreMercadoEnviosOuterRef',
        rotuloLog: '[mercado-livre]',
        prefixoDocId: 'mercadoLivre',
      },
      shopee: {
        tipoConta: 5,
        tipoFrete: 'shopee',
        campoBackRef: 'contaShopeeFreteOuterRef',
        rotuloLog: '[shopee]',
        prefixoDocId: 'shopee',
      },
    });
  });

  it('each row bridges ONE channel: the conta tipo and the freight tipo name the same marketplace', () => {
    for (const [canal, linha] of LINHAS) {
      expect(INTEGRACAO_FRETE_LABELS[linha.tipoFrete], canal).toBe(
        INTEGRACAO_TIPO_LABELS[linha.tipoConta],
      );
    }
    // No two rows share a tipo on either side — a lookup keyed on one would
    // otherwise serve two channels.
    expect(new Set(LINHAS.map(([, l]) => l.tipoConta)).size).toBe(LINHAS.length);
    expect(new Set(LINHAS.map(([, l]) => l.tipoFrete)).size).toBe(LINHAS.length);
  });

  it('bijection: the schema back-refs are exactly the rows’ campoBackRef set, one row each', () => {
    const doSchema = backRefsDoSchema();
    expect(doSchema).toEqual(ANCORA);

    const daConstante = LINHAS.map(([, l]) => l.campoBackRef);
    // One row per key — two rows on one key would make two channels adopt each
    // other's freight docs.
    expect(new Set(daConstante).size).toBe(daConstante.length);
    expect([...daConstante].sort()).toEqual(doSchema);
  });

  it('every back-ref field is the strict canonical ref, nullable (null on every other tipo)', () => {
    for (const [canal, linha] of LINHAS) {
      const campo = intFreteSchema.shape[linha.campoBackRef];
      expect(campo.safeParse('documents/integracao/int-1').success, canal).toBe(true);
      expect(campo.safeParse(null).success, canal).toBe(true);
      // Near-miss: the bare spelling is a different string to an equality query.
      expect(campo.safeParse('integracao/int-1').success, canal).toBe(false);
    }
  });

  it('both channels mint deterministic document IDs (#1888)', () => {
    expect(VINCULO_INT_FRETE_CONTA.shopee.prefixoDocId).toBe('shopee');
    expect(`${VINCULO_INT_FRETE_CONTA.shopee.prefixoDocId}-int-1`).toBe('shopee-int-1');
    expect(VINCULO_INT_FRETE_CONTA.mercadoLivre.prefixoDocId).toBe('mercadoLivre');
    expect(`${VINCULO_INT_FRETE_CONTA.mercadoLivre.prefixoDocId}-int-1`).toBe('mercadoLivre-int-1');
  });
});

/* -------------------------------------------------------------------------- */
/*               T25 — each row's lookup index, in the REAL file              */
/* -------------------------------------------------------------------------- */

describe('firestore.indexes.json — one int_frete lookup index per row (T25)', () => {
  interface CampoDeIndice {
    readonly fieldPath?: string;
    readonly order?: string;
  }
  interface IndiceDeclarado {
    readonly collectionGroup?: string;
    readonly queryScope?: string;
    readonly fields?: readonly CampoDeIndice[];
  }

  const declarados = (): readonly IndiceDeclarado[] => {
    const url = new URL('../../../firestore.indexes.json', import.meta.url);
    return (JSON.parse(readFileSync(url, 'utf8')) as { indexes?: IndiceDeclarado[] }).indexes ?? [];
  };

  // ⚠️ This test exists because DELETING an entry breaks nothing that runs. On
  // Enterprise an undeclared composite does not throw and offers no index link —
  // the lookup silently full-scans `int_frete` and is billed by data scanned
  // (root rule 1). The sync's 2-equality query and the order importer's
  // `apenasAtivo` variant (3 equalities; Mercado Livre only today) both ride its
  // prefix; no query orders, because the newest-`dataCadastro` tie-break is
  // client-side. The 4-field shape is kept identical to the Mercado Livre twin
  // (#782).
  const formaEsperada = (campo: string): CampoDeIndice[] => [
    { fieldPath: 'tipo', order: 'ASCENDING' },
    { fieldPath: campo, order: 'ASCENDING' },
    { fieldPath: 'ativo', order: 'ASCENDING' },
    { fieldPath: 'dataCadastro', order: 'DESCENDING' },
  ];

  it('declares, for every row, exactly one COLLECTION index (tipo, <back-ref>, ativo, dataCadastro DESC)', () => {
    const indices = declarados();
    for (const [canal, linha] of LINHAS) {
      const iguais = indices.filter(
        (i) =>
          i.collectionGroup === 'int_frete' &&
          i.queryScope === 'COLLECTION' &&
          JSON.stringify(i.fields) === JSON.stringify(formaEsperada(linha.campoBackRef)),
      );
      expect(
        iguais,
        `int_frete(tipo, ${linha.campoBackRef}, ativo, dataCadastro DESC) — ${canal}`,
      ).toHaveLength(1);
    }
  });

  it('anchor: the back-refs the int_frete indexes cover are exactly today’s two, and exactly the rows’', () => {
    const cobertos = declarados()
      .filter((i) => i.collectionGroup === 'int_frete')
      .map((i) => i.fields?.[1]?.fieldPath)
      .filter((f): f is string => f !== undefined && BACK_REF.test(f))
      .sort();

    expect(cobertos).toEqual(ANCORA);
    expect(cobertos).toEqual(LINHAS.map(([, l]) => l.campoBackRef).sort());
  });
});
