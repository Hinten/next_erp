/**
 * Path parity between the TWO Firestore bindings of the Imposto cascade (#1519).
 *
 * The cascade moved to `@delfrance/data/admin/imposto`, but `apps/nfe` kept its
 * own `createFirestoreImpostoResolver` byte-identical, because this app's suite
 * drives it through a double that models the nested
 * `collection(root).doc(uid).collection(sub)` chain, while the promoted binding
 * reads whole resolved paths off `defineAdminCollection` handles. That is 25
 * lines of plumbing duplicated on purpose (C38) — and duplicated plumbing is
 * exactly what drifts toward plausible while reading correct.
 *
 * So this file is the anti-drift the duplication owes. It asserts nothing about
 * the cascade (the two byte-unedited suites beside it still own that): only
 * that both bindings still name the SAME legacy Flutter paths, reading the
 * handles' own `resolvePath` as the authority rather than repeating a literal.
 * Move a path on either side and this reds.
 *
 * Source-text assertion is this repo's own device for a guarantee no runtime
 * test can observe (`apps/shopee/lib/shopee/notificacoes/notificacao.test.ts`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  impostoCategoriaCollection,
  impostoProdutoCollection,
  regraImpostoCollection,
} from '@delfrance/data/admin/collections';

const FONTE_APP = readFileSync(
  fileURLToPath(new URL('../../../lib/nfe/imposto-resolver.ts', import.meta.url)),
  'utf8',
);

const FONTE_PACOTE = readFileSync(
  fileURLToPath(
    new URL(
      '../../../../../packages/data/src/admin/imposto/firestoreImpostoResolver.ts',
      import.meta.url,
    ),
  ),
  'utf8',
);

/** The app builds its refs by chaining, so whitespace is not part of the shape. */
const APP_SEM_ESPACOS = FONTE_APP.replace(/\s+/g, '');

/** Every `.collection('<literal>')` the app binding names, in source order. */
const LITERAIS_DO_APP = [...FONTE_APP.matchAll(/\.collection\('([^']+)'\)/g)].map((m) => m[1]);

const [raizProduto, , folhaProduto] = impostoProdutoCollection
  .resolvePath({ produtoId: 'UID' })
  .split('/');
const [raizCategoria, , folhaCategoria] = impostoCategoriaCollection
  .resolvePath({ categoriaId: 'UID' })
  .split('/');

describe('imposto — paridade de caminhos entre os dois bindings', () => {
  it('os handles promovidos resolvem exatamente os caminhos legados', () => {
    // The legacy Flutter wire names, unrenameable without a migration (#423).
    expect(impostoProdutoCollection.resolvePath({ produtoId: 'p1' })).toBe('produtos/p1/imposto');
    expect(impostoCategoriaCollection.resolvePath({ categoriaId: 'c1' })).toBe(
      'categorias/c1/imposto',
    );
    // The third handle has no twin in this app file — its only binding is
    // `lerResolverBundle`, in `packages/data`. Pinned here anyway, because the
    // three are read together by one module and move together.
    expect(regraImpostoCollection.resolvePath({ operacaoId: 'o1' })).toBe('operacao/o1/regras');
  });

  it('o binding local de apps/nfe ainda lê os MESMOS três caminhos', () => {
    // Derived from the handles, never re-typed: if a handle's path moves and
    // this file does not, the regex stops matching.
    const cadeia = (raiz: string, folha: string) =>
      new RegExp(`collection\\('${raiz}'\\)\\.doc\\(\\w+\\)\\.collection\\('${folha}'\\)`);

    expect(APP_SEM_ESPACOS).toMatch(cadeia(raizProduto!, folhaProduto!));
    expect(APP_SEM_ESPACOS).toMatch(cadeia(raizCategoria!, folhaCategoria!));
    // The raw produto document read (tier 2's NCM / categoriaProdutoOuterRef).
    expect(APP_SEM_ESPACOS).toContain(`collection('${raizProduto}').doc(produtoUid).get()`);
    // Both subcollections are the same leaf, and nothing here may fork that.
    expect(folhaProduto).toBe(folhaCategoria);
  });

  it('⛔ QUASE-IGUAL: o binding local não nomeia NENHUM outro caminho', () => {
    // The near-miss of the parity above: matching the three does not show that a
    // FOURTH did not appear. A raw ref to any other collection in this file is
    // plumbing the promoted handles do not cover, so it cannot be kept in step.
    expect(new Set(LITERAIS_DO_APP)).toEqual(new Set([raizProduto, raizCategoria, folhaProduto]));
    expect(LITERAIS_DO_APP).toHaveLength(5);
  });

  it('o binding promovido lê pelos handles — nenhuma ref crua do outro lado', () => {
    // The mirror of the assertion above, on the twin. `git grep "\.collection("`
    // over `packages/data/src/admin/imposto/` is a gate in the plan; this is the
    // same check where a reader of this file will look for it.
    expect(FONTE_PACOTE).not.toMatch(/\.collection\(/);
    for (const handle of [
      'impostoProdutoCollection',
      'impostoCategoriaCollection',
      'regraImpostoCollection',
    ]) {
      expect(FONTE_PACOTE).toContain(handle);
    }
  });
});
