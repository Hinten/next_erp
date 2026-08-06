/**
 * Drift backstop for `NFE_ENDERECO_LIMITES` (`@delfrance/schemas`).
 *
 * The shared endereço builder (#789) clamps every field it fills so the stored
 * endereço is one the NF-e generator can actually emit. Those numbers are the
 * intersection of `enderecoSchema`'s own caps and the `TEndereco` XSD facets —
 * and a hand-copied facet rots the moment SEFAZ ships a new layout. So read the
 * facets back out of the vendored XSD and assert the constant against them.
 *
 * This lives here rather than in `packages/schemas` for the same reason the
 * table lives there: schemas cannot depend on this package (the dependency runs
 * the other way), and only this package ships the XSDs.
 *
 * A failure means one of two things — the XSD changed, so re-derive the
 * constant; or someone edited the constant, and the clamp no longer matches
 * what SEFAZ will accept.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { NFE_ENDERECO_LIMITES, enderecoSchema } from '@delfrance/schemas';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..', '..');

/**
 * The MOC this package is configured to read, taken FROM `src/xsd/index.ts`
 * rather than re-declared here.
 *
 * Re-declaring it would make this file a fifth place to remember during an MOC
 * bump — one the package's own upgrade checklist does not list — and the way it
 * would tell you is a file-not-found on a path nobody typed. Reading the real
 * constant means this test simply follows the package. Parsed rather than
 * imported because `src/xsd/index.ts` keeps it module-private, and importing
 * the module would drag in the 3 MB `xmllint-wasm` blob for a pure text assert.
 */
function activeMoc(): string {
  const source = readFileSync(join(PACKAGE_ROOT, 'src', 'xsd', 'index.ts'), 'utf8');
  const match = /^const ACTIVE_MOC = '([^']+)';$/m.exec(source);
  if (match == null) {
    throw new Error(
      'could not read ACTIVE_MOC out of src/xsd/index.ts — if that constant was ' +
        'renamed or moved, teach this reader where it went',
    );
  }
  return match[1];
}

const LEIAUTE = join(
  PACKAGE_ROOT,
  'generated',
  `moc${activeMoc()}`,
  'schemas',
  'leiauteNFe_v4.00.xsd',
);

/** The `<xs:complexType name="TEndereco">` block — `enderDest`'s type. */
function tEnderecoBlock(): string {
  const xsd = readFileSync(LEIAUTE, 'utf8');
  const start = xsd.indexOf('<xs:complexType name="TEndereco">');
  expect(start, 'TEndereco complexType not found in the vendored XSD').toBeGreaterThan(-1);
  const end = xsd.indexOf('</xs:complexType>', start);
  return xsd.slice(start, end);
}

/** `{ min, max }` from one `<xs:element name="…">`'s length facets. */
function facetsOf(block: string, element: string): { min: number; max: number } {
  const start = block.indexOf(`<xs:element name="${element}"`);
  expect(start, `<xs:element name="${element}"> not found in TEndereco`).toBeGreaterThan(-1);
  const end = block.indexOf('</xs:element>', start);
  const slice = block.slice(start, end);

  const min = /<xs:minLength value="(\d+)"\s*\/>/.exec(slice);
  const max = /<xs:maxLength value="(\d+)"\s*\/>/.exec(slice);
  expect(min, `${element} has no minLength facet`).not.toBeNull();
  expect(max, `${element} has no maxLength facet`).not.toBeNull();

  return { min: Number(min?.[1]), max: Number(max?.[1]) };
}

/** Schema `max()` per field, read off the Zod shape rather than hard-coded. */
function schemaMax(field: 'logradouro' | 'numero' | 'complemento' | 'bairro' | 'cidade'): number {
  const parsed = enderecoSchema.shape[field].safeParse('x'.repeat(1_000));
  expect(parsed.success, `${field} accepted a 1000-char value — max() is missing`).toBe(false);
  const issue = parsed.error?.issues.find((i) => i.code === 'too_big');
  return Number(issue?.maximum);
}

describe('NFE_ENDERECO_LIMITES matches the TEndereco XSD', () => {
  const block = tEnderecoBlock();

  it.each([
    ['logradouro', 'xLgr'],
    ['bairro', 'xBairro'],
    ['cidade', 'xMun'],
    ['pais', 'xPais'],
  ] as const)('%s takes its bounds straight from <%s>', (campo, elemento) => {
    expect(NFE_ENDERECO_LIMITES[campo]).toEqual(facetsOf(block, elemento));
  });

  it.each([
    ['numero', 'nro'],
    ['complemento', 'xCpl'],
  ] as const)('%s keeps the XSD min for <%s> but the stricter schema max', (campo, elemento) => {
    const xsd = facetsOf(block, elemento);
    const cap = schemaMax(campo);
    // The schema is the binding constraint here; if that ever stops being true
    // the table has to switch to the XSD value.
    expect(cap).toBeLessThan(xsd.max);
    expect(NFE_ENDERECO_LIMITES[campo]).toEqual({ min: xsd.min, max: cap });
  });

  it('never lets a fallback or a clamped value be rejected for length', () => {
    for (const [campo, { min, max }] of Object.entries(NFE_ENDERECO_LIMITES)) {
      expect(min, `${campo} min`).toBeGreaterThanOrEqual(1);
      expect(max, `${campo} max`).toBeGreaterThanOrEqual(min);
    }
  });

  it('the schema is looser than the XSD on the three free-text fields — which is why the clamp exists', () => {
    // Documents the actual gap: enderecoSchema stores values the XSD would
    // reject on length. If this ever inverts, the clamp becomes a no-op and
    // NFE_ENDERECO_LIMITES can be simplified.
    expect(schemaMax('logradouro')).toBeGreaterThan(facetsOf(block, 'xLgr').max);
    expect(schemaMax('bairro')).toBeGreaterThan(facetsOf(block, 'xBairro').max);
    expect(schemaMax('cidade')).toBeGreaterThan(facetsOf(block, 'xMun').max);
  });
});
