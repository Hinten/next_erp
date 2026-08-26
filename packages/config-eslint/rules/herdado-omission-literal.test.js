// Repo-state guard: the `herdado` omission reason means the same thing on both
// sides of a workspace boundary the type system cannot span.
//
// ## Why this one needs a guard of its own
//
// `MlAttributeOmission` is declared in `apps/mercado-livre` and consumed in
// `apps/web`, which CANNOT import it: the browser must never load
// `@delfrance/integrations-mercado-livre`, whose root carries the OAuth client
// secret, and the DTO consequently types `omitidos[].motivo` as a bare `string`
// (`apps/web/lib/mercado-livre/client.ts`). So apps/web mirrors the literal by
// hand in `OMISSAO_HERDADO`.
//
// ⚠️ The failure mode is silent and destructive, which is why prose in a comment
// is not enough. `attributesForSave` prunes every id the metadata withheld and
// carves out exactly one reason — `herdado` — because for `BRAND` the stored
// value is the FALLBACK publish reads when the produto has no Marca. Rename the
// server's reason and nothing breaks: types check, both suites pass, and BRAND
// quietly rejoins the prune set, so the next save of any unrelated field deletes
// the brand off every listing whose produto has no Marca.
//
// ## Where it has to live
//
// Here, not in either app. A test inside `apps/mercado-livre` asserting about
// `apps/web` runs NOWHERE on a web-only PR — `ci-mercado-livre.yml` scopes to
// the `workspace:*` closure of the ML app, which contains no sibling app
// (#1255). `packages/config-eslint` is reached by `ci.yml`'s unfiltered lint /
// typecheck / test, so it sees every PR.
//
// ## What it checks
//
// That the producer still emits the literal apps/web carves out, and that the
// carve-out is still spent on the prune set. It does not parse TypeScript —
// these are two fixed lines in two files, and a regex that fails loudly when
// either is reshaped is the point.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './lib/repo-scan.js';

const SERVIDOR = join(
  REPO_ROOT,
  'apps/mercado-livre/lib/marketplace/categorias/categoriaAtributos.ts',
);
const CLIENTE = join(REPO_ROOT, 'apps/web/lib/mercado-livre/attributeForm.ts');

const read = (p) => readFileSync(p, 'utf8');

describe('the `herdado` omission reason agrees across the workspace boundary', () => {
  it('apps/web pins the literal apps/mercado-livre emits', () => {
    // Producer: the arm of `attributeOmission` that returns it.
    const servidor = read(SERVIDOR).match(
      /ML_PRODUTO_HERDADO_ATTRIBUTE_IDS\.includes\(attr\.id\)\)\s*return\s*'([a-z-]+)'/,
    );
    expect(
      servidor,
      'apps/mercado-livre no longer returns a literal reason for ML_PRODUTO_HERDADO_ATTRIBUTE_IDS — ' +
        'if the shape changed, update this guard and apps/web together',
    ).not.toBeNull();

    // Consumer: the constant apps/web mirrors it with.
    const cliente = read(CLIENTE).match(/const OMISSAO_HERDADO = '([a-z-]+)'/);
    expect(
      cliente,
      'apps/web/lib/mercado-livre/attributeForm.ts no longer declares OMISSAO_HERDADO',
    ).not.toBeNull();

    expect(
      cliente[1],
      `apps/web mirrors '${cliente?.[1]}' but apps/mercado-livre emits '${servidor?.[1]}'. ` +
        'They must match, or BRAND rejoins the prune set and every listing whose produto has ' +
        'no Marca loses its stored brand on the next save.',
    ).toBe(servidor[1]);
  });

  it('the literal is actually spent on the prune set, not merely declared', () => {
    // A matching pair of dead constants would satisfy the test above while the
    // carve-out itself had been refactored away.
    expect(read(CLIENTE)).toMatch(/omitidos\.filter\(\(o\) => o\.motivo !== OMISSAO_HERDADO\)/);
  });

  it('the reason is a member of the producer union', () => {
    const cliente = read(CLIENTE).match(/const OMISSAO_HERDADO = '([a-z-]+)'/);
    const union = read(SERVIDOR).match(/export type MlAttributeOmission =([\s\S]*?);/);
    expect(union, 'MlAttributeOmission is no longer a union declaration').not.toBeNull();
    expect(union[1]).toContain(`'${cliente[1]}'`);
  });
});
