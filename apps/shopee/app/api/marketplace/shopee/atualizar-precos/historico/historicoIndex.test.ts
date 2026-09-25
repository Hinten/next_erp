/**
 * The TWO composite indexes `enviosPrecoShopee` needs, each DERIVED from the
 * source of the query that needs it and compared against
 * `firestore.indexes.json`: the history route's `(integracaoId, startedAt
 * DESC)` — the twin of Mercado Livre's
 * `atualizar-precos/historico/historicoIndex.test.ts` (EVIDENCE, not imported:
 * `apps/*` has no dependency edge to another app) — and, since review 2 (S-1),
 * the job's start guard's `(integracaoId, status)`, derived from
 * `iniciarEnvioPrecoShopee` (bottom of this file).
 *
 * Why a bespoke guard: both repo-wide index backstops key on
 * `meta.defaultQuery` (the `delfrance/default-query-needs-index` lint rule and
 * `packages/schemas/src/defaultQuery.indexes.test.ts`), and `enviosPrecoShopee`
 * has no `CollectionMetadata` at all — it is admin-only and deliberately
 * outside `ALL_DOMAINS`. A hand-written equality-plus-order query in a route is
 * exactly the shape nothing else covers.
 *
 * ⚠️ And it has NO runtime signal. On Firestore Enterprise a missing composite
 * does not throw `FAILED_PRECONDITION` — it silently full-scans, and Enterprise
 * bills data scanned. This file is the only place it surfaces.
 *
 * Like its twin, it tests the DETECTOR too: a parser that silently stopped
 * matching would manufacture a green guard, so it has a known-good and a
 * known-bad control.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ_DO_REPO = resolve(AQUI, '../../../../../../../..');

const fonteDaRota = readFileSync(resolve(AQUI, 'route.ts'), 'utf8');

interface CampoDoIndice {
  fieldPath: string;
  order: 'ASCENDING' | 'DESCENDING';
}

/**
 * Read the query's shape out of the route source: EVERY equality field (the
 * `matchAll` matters — a second equality filter changes the index the query
 * needs, and reading only the first would keep a stale two-field requirement
 * green) plus the `orderBy` field and direction.
 */
function derivarCamposDoIndice(fonte: string): CampoDoIndice[] | null {
  const igualdades = [...fonte.matchAll(/\.where\(\s*'([A-Za-z0-9_.]+)'\s*,\s*'=='/g)].map(
    (m) => m[1]!,
  );
  const ordem = /\.orderBy\(\s*'([A-Za-z0-9_.]+)'\s*,\s*'(asc|desc)'\s*\)/.exec(fonte);
  if (igualdades.length === 0 || !ordem) return null;
  return [
    // Sorted only for determinism: the equality PREFIX is order-insensitive.
    ...[...new Set(igualdades)].sort().map<CampoDoIndice>((f) => ({
      fieldPath: f,
      order: 'ASCENDING',
    })),
    { fieldPath: ordem[1]!, order: ordem[2] === 'desc' ? 'DESCENDING' : 'ASCENDING' },
  ];
}

const indices = (
  JSON.parse(readFileSync(resolve(RAIZ_DO_REPO, 'firestore.indexes.json'), 'utf8')) as {
    indexes?: { collectionGroup?: string; queryScope?: string; fields?: CampoDoIndice[] }[];
  }
).indexes;

describe('a rota historico tem o seu índice composto', () => {
  it('firestore.indexes.json é legível e não está vazio', () => {
    // Sem isto, um arquivo ilegível faria cada verificação abaixo passar por
    // não encontrar nada de que discordar.
    expect(Array.isArray(indices)).toBe(true);
    expect(indices!.length).toBeGreaterThan(0);
  });

  it('a forma da consulta ainda é derivável de route.ts', () => {
    expect(derivarCamposDoIndice(fonteDaRota)).toEqual([
      { fieldPath: 'integracaoId', order: 'ASCENDING' },
      { fieldPath: 'startedAt', order: 'DESCENDING' },
    ]);
  });

  it('declara (integracaoId ASC, startedAt DESC) em enviosPrecoShopee, escopo COLLECTION', () => {
    const exigido = derivarCamposDoIndice(fonteDaRota)!;

    const achado = indices!.some(
      (idx) =>
        idx.collectionGroup === 'enviosPrecoShopee' &&
        idx.queryScope === 'COLLECTION' &&
        Array.isArray(idx.fields) &&
        idx.fields.length === exigido.length &&
        idx.fields.every(
          (f, i) => f.fieldPath === exigido[i]!.fieldPath && f.order === exigido[i]!.order,
        ),
    );

    if (achado) return;
    expect.fail(
      `Falta o índice composto de que a consulta desta rota precisa. O Enterprise não cria ` +
        `índices sozinho e a falta de um NÃO lança erro — varre a coleção e cobra a varredura. ` +
        `Acrescente ao array "indexes" de firestore.indexes.json (o deploy é da janela de ` +
        `migração, #1532):\n` +
        JSON.stringify(
          { collectionGroup: 'enviosPrecoShopee', queryScope: 'COLLECTION', fields: exigido },
          null,
          2,
        ),
    );
  });

  // ⚠️ O Enterprise omite o `__name__` final implícito, então um JSON copiado da
  // documentação do Standard está errado.
  it('nenhum índice de enviosPrecoShopee declara o `__name__` final', () => {
    const nossos = indices!.filter((idx) => idx.collectionGroup === 'enviosPrecoShopee');
    expect(nossos.length).toBeGreaterThan(0);
    for (const idx of nossos) {
      expect(idx.fields?.map((f) => f.fieldPath)).not.toContain('__name__');
    }
  });

  describe('a derivação em si', () => {
    it('PAR: lê a DIREÇÃO, não só o campo; QUASE-IGUAL: a ordem invertida exige OUTRO índice', () => {
      expect(derivarCamposDoIndice(`.where('a', '==', x).orderBy('b', 'desc')`)).toEqual([
        { fieldPath: 'a', order: 'ASCENDING' },
        { fieldPath: 'b', order: 'DESCENDING' },
      ]);
      expect(derivarCamposDoIndice(`.where('a', '==', x).orderBy('b', 'asc')`)).toEqual([
        { fieldPath: 'a', order: 'ASCENDING' },
        { fieldPath: 'b', order: 'ASCENDING' },
      ]);
    });

    it('devolve null quando não há consulta a derivar', () => {
      expect(derivarCamposDoIndice(`const x = 1;`)).toBeNull();
      expect(derivarCamposDoIndice(`.where('a', '==', x)`)).toBeNull();
    });

    it('⭐ pega uma SEGUNDA igualdade, que um `exec` teria perdido', () => {
      expect(
        derivarCamposDoIndice(
          `.where('integracaoId', '==', id).where('status', '==', s).orderBy('startedAt', 'desc')`,
        ),
      ).toEqual([
        { fieldPath: 'integracaoId', order: 'ASCENDING' },
        { fieldPath: 'status', order: 'ASCENDING' },
        { fieldPath: 'startedAt', order: 'DESCENDING' },
      ]);
    });

    it('não conta duas vezes uma igualdade repetida', () => {
      expect(
        derivarCamposDoIndice(`.where('a', '==', x).where('a', '==', y).orderBy('b', 'desc')`),
      ).toEqual([
        { fieldPath: 'a', order: 'ASCENDING' },
        { fieldPath: 'b', order: 'DESCENDING' },
      ]);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*          the job's START GUARD — the collection's other composite (S-1)      */
/* -------------------------------------------------------------------------- */

/**
 * The start guard (`iniciarEnvioPrecoShopee`: "does this conta already have a
 * `running` job?") is the collection's OTHER query, and before review 2 nothing
 * pinned its composite: every test above derives from `historico/route.ts`
 * alone, so deleting the `(integracaoId, status)` entry left all of them green
 * — and on Enterprise the guard would then full-scan `enviosPrecoShopee` on
 * every start and bill the scan. Step 9 has this pin; step 13 had dropped it.
 *
 * Its field names are not exported by the job module, so they are DERIVED from
 * that ONE function's source — scoped to it, so a query added elsewhere in the
 * module cannot join the set — and the derived pair is pinned beside it.
 */
const fonteDoJob = readFileSync(
  resolve(AQUI, '../../../../../../lib/shopee/precos/atualizarPrecos.ts'),
  'utf8',
);

/**
 * The equality-only shape of the start guard: every `.where(field, '==', …)`
 * of `iniciarEnvioPrecoShopee`, all ASCENDING (the equality prefix is
 * order-insensitive; sorted for determinism). A range or an `orderBy` needs a
 * DIFFERENT index shape, so the derivation refuses it (`null`) instead of
 * guessing — the "still derivable" test below then says so.
 */
function derivarIgualdadesDoInicio(fonte: string): CampoDoIndice[] | null {
  const inicio = fonte.indexOf('export async function iniciarEnvioPrecoShopee');
  if (inicio < 0) return null;
  const fim = fonte.indexOf('\nexport ', inicio + 1);
  const corpo = fonte.slice(inicio, fim < 0 ? undefined : fim);
  const igualdades = [...corpo.matchAll(/\.where\(\s*'([A-Za-z0-9_.]+)'\s*,\s*'=='/g)].map(
    (m) => m[1]!,
  );
  const filtros = corpo.match(/\.where\(/g)?.length ?? 0;
  if (igualdades.length === 0 || filtros !== igualdades.length || /\.orderBy\(/.test(corpo)) {
    return null;
  }
  return [...new Set(igualdades)].sort().map<CampoDoIndice>((f) => ({
    fieldPath: f,
    order: 'ASCENDING',
  }));
}

describe('a guarda de início do job tem o seu índice composto (S-1)', () => {
  it('a forma da consulta ainda é derivável de iniciarEnvioPrecoShopee: (integracaoId ==, status ==)', () => {
    expect(derivarIgualdadesDoInicio(fonteDoJob)).toEqual([
      { fieldPath: 'integracaoId', order: 'ASCENDING' },
      { fieldPath: 'status', order: 'ASCENDING' },
    ]);
  });

  it('declara (integracaoId ASC, status ASC) em enviosPrecoShopee, escopo COLLECTION, sem `__name__`', () => {
    const exigido = derivarIgualdadesDoInicio(fonteDoJob)!;

    const achado = indices!.some(
      (idx) =>
        idx.collectionGroup === 'enviosPrecoShopee' &&
        idx.queryScope === 'COLLECTION' &&
        Array.isArray(idx.fields) &&
        idx.fields.length === exigido.length &&
        idx.fields.every(
          (f, i) => f.fieldPath === exigido[i]!.fieldPath && f.order === exigido[i]!.order,
        ),
    );

    if (achado) return;
    expect.fail(
      `Falta o índice composto da guarda de início do job. O Enterprise não cria índices ` +
        `sozinho e a falta de um NÃO lança erro — varre a coleção a cada início e cobra a ` +
        `varredura. Acrescente ao array "indexes" de firestore.indexes.json (o deploy é da ` +
        `janela de migração, #1532):\n` +
        JSON.stringify(
          { collectionGroup: 'enviosPrecoShopee', queryScope: 'COLLECTION', fields: exigido },
          null,
          2,
        ),
    );
  });

  it('QUASE-IGUAL: o índice do HISTÓRICO não serve à guarda — são DUAS entradas distintas', () => {
    const inicio = derivarIgualdadesDoInicio(fonteDoJob);
    const historico = derivarCamposDoIndice(fonteDaRota);
    expect(inicio).not.toEqual(historico);
    const nossos = indices!.filter((idx) => idx.collectionGroup === 'enviosPrecoShopee');
    expect(nossos.length).toBeGreaterThanOrEqual(2);
  });

  describe('a derivação em si', () => {
    const inicioDe = (consulta: string): string =>
      `export async function iniciarEnvioPrecoShopee() {\n  ${consulta}\n}\nexport function outra() {\n  x.where('fora', '==', 1);\n}\n`;

    it('PAR: lê TODAS as igualdades da função, e só dela (a consulta de outra função fica fora)', () => {
      expect(
        derivarIgualdadesDoInicio(inicioDe(`.where('b', '==', y).where('a', '==', x).limit(1)`)),
      ).toEqual([
        { fieldPath: 'a', order: 'ASCENDING' },
        { fieldPath: 'b', order: 'ASCENDING' },
      ]);
    });

    it('QUASE-IGUAL: um intervalo ou um orderBy exige OUTRA forma de índice ⇒ null, nunca um palpite', () => {
      expect(
        derivarIgualdadesDoInicio(inicioDe(`.where('a', '==', x).where('b', '<', y)`)),
      ).toBeNull();
      expect(
        derivarIgualdadesDoInicio(inicioDe(`.where('a', '==', x).orderBy('b', 'desc')`)),
      ).toBeNull();
    });

    it('devolve null quando a função sumiu ou não consulta nada', () => {
      expect(derivarIgualdadesDoInicio(`const x = 1;`)).toBeNull();
      expect(derivarIgualdadesDoInicio(inicioDe(`return 1;`))).toBeNull();
    });
  });
});
