import { describe, expect, it } from 'vitest';
import {
  emailLookupShapes,
  idCompatible,
  identityValue,
  isSameCliente,
  isSameEmail,
  isSameTelefone,
  normalizeNome,
  sanitizeTelefone,
  shouldUpdateName,
  telefoneLookupShapes,
} from './clienteIdentity';

const CPF = '52998224725';
const CPF_PUNCTUATED = '529.982.247-25';
const OTHER_CPF = '11144477735';
const CNPJ_ALPHA = '12ABC34501DE35';

describe('identityValue', () => {
  it('returns a trimmed non-empty string', () => {
    expect(identityValue(CPF)).toBe(CPF);
    expect(identityValue(`  ${CPF} `)).toBe(CPF);
  });

  it('treats empty and blank as absent — clienteSchema permits an empty string', () => {
    expect(identityValue('')).toBeNull();
    expect(identityValue('   ')).toBeNull();
  });

  it('tolerates the raw shapes a soft-parsed read can hand back', () => {
    // `parseSoftRead` returns the RAW document when it fails the schema, so a
    // legacy Flutter-written field may be any type at all.
    expect(identityValue(null)).toBeNull();
    expect(identityValue(undefined)).toBeNull();
    expect(identityValue(52998224725)).toBeNull();
    expect(identityValue({ cpf: CPF })).toBeNull();
  });
});

describe('idCompatible', () => {
  // The truth table from issue #786: absence is "no evidence", never "no match".
  it.each([
    ['both absent — the common pre-billing_info case', null, null, true],
    ['candidate absent, incoming present — we are adding information', null, CPF, true],
    ['candidate present, incoming absent', CPF, null, true],
    ['both present and equal', CPF, CPF, true],
    ['both present and DIFFERENT — a different person', CPF, OTHER_CPF, false],
  ] as const)('%s', (_label, a, b, expected) => {
    expect(idCompatible(a, b)).toBe(expected);
  });

  it('normalizes BOTH sides — one person spelled two ways is still one person', () => {
    // The live bug this closes: the lookup normalized, the patch compared raw.
    expect(idCompatible(CPF_PUNCTUATED, CPF)).toBe(true);
    expect(idCompatible(CPF, CPF_PUNCTUATED)).toBe(true);
  });

  it('keeps letters, so an alphanumeric CNPJ is not mangled into a match', () => {
    expect(idCompatible('12.ABC.345/01DE-35', CNPJ_ALPHA)).toBe(true);
    expect(idCompatible(CNPJ_ALPHA, '12XYZ34501DE35')).toBe(false);
  });

  it('treats an empty string as absent, not as a value that contradicts', () => {
    expect(idCompatible('', CPF)).toBe(true);
    expect(idCompatible(CPF, '')).toBe(true);
  });

  it('never throws on a non-string', () => {
    expect(idCompatible(52998224725, CPF)).toBe(true);
    expect(idCompatible({}, CPF)).toBe(true);
  });
});

describe('isSameCliente', () => {
  it('matches when nothing contradicts', () => {
    expect(isSameCliente({ cpf_cnpj: null, idEstrangeiro: null }, { cpf_cnpj: CPF })).toBe(true);
    expect(isSameCliente({ cpf_cnpj: CPF_PUNCTUATED }, { cpf_cnpj: CPF })).toBe(true);
  });

  it('rejects a candidate whose cpf_cnpj differs — the #786 headline case', () => {
    expect(isSameCliente({ cpf_cnpj: OTHER_CPF }, { cpf_cnpj: CPF })).toBe(false);
  });

  it('is the AND of both strong keys — an idEstrangeiro contradiction alone rejects', () => {
    expect(
      isSameCliente(
        { cpf_cnpj: CPF, idEstrangeiro: 'AB-123456' },
        { cpf_cnpj: CPF, idEstrangeiro: 'ZZ-999999' },
      ),
    ).toBe(false);
  });

  it('normalizes idEstrangeiro too, so punctuation alone never rejects', () => {
    expect(isSameCliente({ idEstrangeiro: 'AB-123456' }, { idEstrangeiro: 'AB123456' })).toBe(true);
  });

  it('accepts a partial shape — the keys are optional', () => {
    expect(isSameCliente({}, {})).toBe(true);
  });
});

describe('normalizeNome', () => {
  it('trims and collapses internal whitespace runs', () => {
    expect(normalizeNome('  Ana   Maria  Souza ')).toBe('Ana Maria Souza');
    expect(normalizeNome('Ana\tMaria\nSouza')).toBe('Ana Maria Souza');
  });

  it('treats a whitespace-only value as absent', () => {
    expect(normalizeNome('')).toBeNull();
    expect(normalizeNome('   ')).toBeNull();
    expect(normalizeNome('\t\n')).toBeNull();
  });

  it('tolerates a non-string', () => {
    expect(normalizeNome(null)).toBeNull();
    expect(normalizeNome(42)).toBeNull();
  });
});

describe('shouldUpdateName', () => {
  it('never updates to an empty name', () => {
    expect(shouldUpdateName('Ana Maria Souza', '')).toBe(false);
    expect(shouldUpdateName(null, '')).toBe(false);
  });

  it('never updates to a WHITESPACE-ONLY name', () => {
    // clienteSchema.nome accepts '   ' happily, so without the trim this wrote
    // blanks over a real name instead of failing loudly.
    expect(shouldUpdateName('Ana Maria Souza', '   ')).toBe(false);
    expect(shouldUpdateName('Ana Maria Souza', '\t\n')).toBe(false);
  });

  it('counts words after collapsing, so padding does not fake a multi-word name', () => {
    // '  Ana  '.split(' ') is 4 raw "words" — the guard used to see a
    // multi-word name and let a first-name-only payload through.
    expect(shouldUpdateName('Ana Maria Souza', '  Ana  ')).toBe(false);
  });

  it('counts the STORED name after collapsing too', () => {
    // 'Ana  '.split(' ') is 3 — a padded single-word stored name used to look
    // multi-word and wrongly BLOCK a legitimate lone-word update.
    expect(shouldUpdateName('Ana  ', 'Beatriz')).toBe(true);
  });

  it('refuses to let a lone word clobber a multi-word name on file', () => {
    expect(shouldUpdateName('Ana Maria Souza', 'Ana')).toBe(false);
  });

  it('accepts a lone word when the stored name is absent or also lone', () => {
    expect(shouldUpdateName(null, 'Ana')).toBe(true);
    expect(shouldUpdateName('Ana', 'Beatriz')).toBe(true);
  });

  it('accepts a multi-word name over anything', () => {
    expect(shouldUpdateName('Ana', 'Ana Maria Souza')).toBe(true);
    expect(shouldUpdateName('Ana Maria Souza', 'Ana Maria de Souza')).toBe(true);
  });
});

describe('sanitizeTelefone', () => {
  it('normalizes a raw BR number to the E.164 wire shape', () => {
    expect(sanitizeTelefone('11999998888')).toBe('5511999998888');
    expect(sanitizeTelefone('(11) 99999-8888')).toBe('5511999998888');
  });

  it('passes an already-normalized value through unchanged', () => {
    expect(sanitizeTelefone('5511999998888')).toBe('5511999998888');
  });

  it('drops a MASKED value rather than mangling it into an invalid one', () => {
    // `normalizeTelefone` would strip the `*` and leave 6 digits, which fails
    // clienteSchema's refine and throws mid-import.
    expect(sanitizeTelefone('11*****8888')).toBeNull();
  });

  it('drops anything still invalid after normalization', () => {
    expect(sanitizeTelefone('123')).toBeNull();
    expect(sanitizeTelefone('sem telefone')).toBeNull();
  });

  it('treats absence as absence', () => {
    expect(sanitizeTelefone(null)).toBeNull();
    expect(sanitizeTelefone('')).toBeNull();
    expect(sanitizeTelefone(11999998888)).toBeNull();
  });
});

describe('telefoneLookupShapes', () => {
  it('yields both wire shapes for a normalized BR number', () => {
    expect(telefoneLookupShapes('5511999998888').sort()).toEqual(
      ['11999998888', '5511999998888'].sort(),
    );
  });

  it('yields both wire shapes for a raw BR number', () => {
    expect(telefoneLookupShapes('11999998888').sort()).toEqual(
      ['11999998888', '5511999998888'].sort(),
    );
  });

  it('yields nothing for absent or masked input, so the caller skips the query', () => {
    expect(telefoneLookupShapes(null)).toEqual([]);
    expect(telefoneLookupShapes('')).toEqual([]);
    expect(telefoneLookupShapes('11*****8888')).toEqual([]);
  });
});

describe('isSameTelefone', () => {
  it('treats the legacy raw shape and the normalized shape as one number', () => {
    expect(isSameTelefone('11999998888', '5511999998888')).toBe(true);
    expect(isSameTelefone('5511999998888', '11999998888')).toBe(true);
  });

  it('is false for a genuinely different number', () => {
    expect(isSameTelefone('11999998888', '5511777776666')).toBe(false);
  });

  it('is false when either side is absent — nothing stored means write it', () => {
    expect(isSameTelefone(null, '5511999998888')).toBe(false);
    expect(isSameTelefone('5511999998888', null)).toBe(false);
  });
});

describe('emailLookupShapes / isSameEmail', () => {
  it('yields the typed and lowercased forms, deduped', () => {
    expect(emailLookupShapes('Ana@Example.com').sort()).toEqual(
      ['Ana@Example.com', 'ana@example.com'].sort(),
    );
    expect(emailLookupShapes('ana@example.com')).toEqual(['ana@example.com']);
  });

  it('yields nothing for absent input', () => {
    expect(emailLookupShapes(null)).toEqual([]);
    expect(emailLookupShapes('')).toEqual([]);
  });

  it('compares case-insensitively', () => {
    expect(isSameEmail('Ana@Example.com', 'ana@example.com')).toBe(true);
    expect(isSameEmail('ana@example.com', 'beatriz@example.com')).toBe(false);
    expect(isSameEmail(null, 'ana@example.com')).toBe(false);
  });
});
