import { describe, expect, it } from 'vitest';
import { buildFotoRefs } from './storage/foto';
import { tabelaDeMedidasMeta, tabelaDeMedidasSchema } from './tabelaDeMedidas';

describe('tabelaDeMedidasSchema', () => {
  it('accepts a minimal valid record with null codigo and descricao', () => {
    const out = tabelaDeMedidasSchema.parse({
      nome: 'Camiseta P/M/G',
      codigo: null,
      descricao: null,
    });
    expect(out.nome).toBe('Camiseta P/M/G');
  });

  it('rejects empty nome', () => {
    expect(
      tabelaDeMedidasSchema.safeParse({
        nome: '',
        codigo: null,
        descricao: null,
      }).success,
    ).toBe(false);
  });

  it('rejects nome longer than 255 chars', () => {
    expect(
      tabelaDeMedidasSchema.safeParse({
        nome: 'x'.repeat(256),
        codigo: null,
        descricao: null,
      }).success,
    ).toBe(false);
  });

  it('rejects descricao longer than 1000 chars', () => {
    expect(
      tabelaDeMedidasSchema.safeParse({
        nome: 'X',
        codigo: null,
        descricao: 'a'.repeat(1001),
      }).success,
    ).toBe(false);
  });

  // Regression: Firebase JS SDK v12 rejects `undefined` in addDoc/setDoc.
  it('rejects missing codigo (must be string | null, not undefined)', () => {
    expect(tabelaDeMedidasSchema.safeParse({ nome: 'X', descricao: null }).success).toBe(false);
  });

  it('accepts marketplace integration maps keyed by integracao_id', () => {
    const out = tabelaDeMedidasSchema.parse({
      nome: 'Tabela X',
      codigo: 'TX',
      descricao: null,
      tabelasDeMedidasMercadoLivre: { 'conta-1': { tabelas: [] } },
      tabelasMedidasShopee: { 'conta-2': [] },
    });
    expect(out.tabelasDeMedidasMercadoLivre).toBeDefined();
    expect(out.tabelasMedidasShopee).toBeDefined();
  });

  // Step 18 (#1526): the legacy reader tolerated a per-conta `null`, so the
  // corpus can carry one. Before the loosening that ONE value failed the whole
  // base parse, and `parseRead` handed every reader the RAW doc — defaults
  // unapplied, so `ultimaModificacao` came back ABSENT instead of `null`.
  it('accepts a per-conta null in tabelasMedidasShopee and still applies the defaults', () => {
    const result = tabelaDeMedidasSchema.safeParse({
      nome: 'Tabela X',
      codigo: null,
      descricao: null,
      tabelasMedidasShopee: { 'int-1': null },
    });
    expect(result.success).toBe(true);
    expect(result.data?.ultimaModificacao).toBeNull();
    expect(result.data?.tabelasMedidasShopee).toEqual({ 'int-1': null });
  });

  it('keeps every per-conta value verbatim, readable or not, beside a null sibling', () => {
    const entradas = [
      { categoryId: 400055, size_chart_id: 700024641, name: 'Camisetas' },
      { size_chart_id: 1 },
      null,
      'x',
    ];
    const out = tabelaDeMedidasSchema.parse({
      nome: 'Tabela X',
      codigo: null,
      descricao: null,
      tabelasMedidasShopee: { 'int-1': entradas, 'int-10': null },
    });
    // The base schema judges no element — the read slice does, one by one.
    expect(out.tabelasMedidasShopee).toEqual({ 'int-1': entradas, 'int-10': null });
  });

  // Step-18 review (R2-F4 / R3-F2): a per-conta value the read slice calls
  // `lista-invalida` used to fail the base parse, and ObjectView's resolver
  // validates EVERY field — so one such value blocked every save of the tabela,
  // an unrelated Descrição edit included, while the Shopee tab offered no way to
  // fix it. The per-conta value is now `unknown`: the base judges nothing, the
  // read slice judges each conta's list, and the value rides back verbatim.
  it.each<[string, unknown]>([
    ['an object', {}],
    ['an object with keys', { categoryId: 400055 }],
    ['a string', 'x'],
    ['a number', 42],
    ['a boolean', true],
    ['an empty list', []],
  ])('accepts a per-conta value that is %s and keeps it VERBATIM', (_label, valor) => {
    const result = tabelaDeMedidasSchema.safeParse({
      nome: 'Tabela X',
      codigo: null,
      descricao: null,
      tabelasMedidasShopee: { 'int-1': valor, 'int-10': null },
    });
    expect(result.success).toBe(true);
    // The SAME value (by reference for an object) — nothing rebuilt, nothing defaulted.
    expect(result.data?.tabelasMedidasShopee?.['int-1']).toBe(valor);
    expect(result.data?.tabelasMedidasShopee).toEqual({ 'int-1': valor, 'int-10': null });
  });

  it('an unrelated ObjectView-style save of a tabela holding legacy oddities parses, and carries the map back byte-identical', () => {
    // What the edit form holds: the loaded doc, Descrição edited. The resolver
    // runs the WHOLE schema over it (`zodResolver(tabelaDeMedidasSchema)`); a
    // failure there is the "Corrija os campos inválidos" toast and NO write.
    const mapa = {
      'int-1': 'x',
      'int-2': { a: 1 },
      'int-3': [
        { categoryId: 400055, size_chart_id: 700024641, name: 'Camisetas' },
        { size_chart_id: '700024641' },
        null,
      ],
      'int-4': null,
    };
    const ml = { 'conta-ml': { tabelas: [{ id: 'g1' }] } };
    const formulario = {
      nome: 'Tabela X',
      codigo: null,
      descricao: 'editada',
      tabelasMedidasShopee: mapa,
      tabelasDeMedidasMercadoLivre: ml,
      ultimaModificacao: 1_759_000_000_000,
    };

    const result = tabelaDeMedidasSchema.safeParse(formulario);

    expect(result.success).toBe(true);
    expect(result.data?.descricao).toBe('editada');
    // Byte-identical once serialised (key order kept) — what a whole-map write
    // would store; and the ML sibling untouched.
    expect(JSON.stringify(result.data?.tabelasMedidasShopee)).toBe(JSON.stringify(mapa));
    expect(result.data?.tabelasDeMedidasMercadoLivre).toEqual(ml);
  });

  // The SCOPE of the loosening: the per-conta VALUE is free, the outer field is
  // not. `null`, `{}` and absent read as before; a field that is not a plain
  // object at all (`campo-invalido` in the read slice) still fails the base
  // parse — pinned so widening the outer field is a decision, not a drift.
  it.each<[string, unknown, unknown]>([
    ['null', null, null],
    ['an empty map', {}, {}],
  ])('the outer field %s parses to itself', (_label, valor, esperado) => {
    const result = tabelaDeMedidasSchema.safeParse({
      nome: 'Tabela X',
      codigo: null,
      descricao: null,
      tabelasMedidasShopee: valor,
    });
    expect(result.success).toBe(true);
    expect(result.data?.tabelasMedidasShopee).toEqual(esperado);
  });

  it('an ABSENT outer field stays absent (no default invented)', () => {
    const out = tabelaDeMedidasSchema.parse({ nome: 'Tabela X', codigo: null, descricao: null });
    expect(Object.hasOwn(out, 'tabelasMedidasShopee')).toBe(false);
  });

  it.each<[string, unknown]>([
    ['a list', [{ categoryId: 400055, size_chart_id: 700024641, name: 'Camisetas' }]],
    ['a string', 'x'],
    ['a number', 42],
  ])('NEAR-MISS: still rejects an outer field that is %s (not a map)', (_label, valor) => {
    expect(
      tabelaDeMedidasSchema.safeParse({
        nome: 'Tabela X',
        codigo: null,
        descricao: null,
        tabelasMedidasShopee: valor,
      }).success,
    ).toBe(false);
  });

  it('parses a fotos array of Foto wire shapes', () => {
    const out = tabelaDeMedidasSchema.parse({
      nome: 'Tabela X',
      codigo: null,
      descricao: null,
      fotos: [buildFotoRefs('tm1', 'h1')],
    });
    expect(out.fotos?.[0]?.arquivoOuterRef).toBe('arquivos/tm1_h1');
  });
});

describe('tabelaDeMedidasMeta', () => {
  it('targets the tabMedi collection (Flutter wire name)', () => {
    expect(tabelaDeMedidasMeta.collectionPath).toBe('tabMedi');
  });

  it('reuses the produto BigInt permission bits', () => {
    expect(tabelaDeMedidasMeta.permissions.read).toBe(1n << 8n);
    expect(tabelaDeMedidasMeta.permissions.write).toBe(1n << 9n);
    expect(tabelaDeMedidasMeta.permissions.delete).toBe(1n << 10n);
  });
});
