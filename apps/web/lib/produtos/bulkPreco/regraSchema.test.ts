import { describe, expect, it } from 'vitest';

import { defaultsFor, regraSchema, type RegraTipo } from './regraSchema';

function issueAt(data: unknown, path: string) {
  const result = regraSchema.safeParse(data);
  if (result.success) return undefined;
  return result.error.issues.find((i) => i.path.join('.') === path);
}

describe('regraSchema — defaults per variant', () => {
  it('detalhado: only `tipo` required, every other field defaults to the legacy value', () => {
    const result = regraSchema.safeParse({ tipo: 'detalhado' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(defaultsFor('detalhado'));
    }
  });

  it('valorFixo: `novoPreco` is required — missing it fails', () => {
    expect(regraSchema.safeParse({ tipo: 'valorFixo' }).success).toBe(false);
    const result = regraSchema.safeParse({ tipo: 'valorFixo', novoPreco: 42 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ ...defaultsFor('valorFixo'), novoPreco: 42 });
    }
  });

  it('precoAtual: `percentual`/`valorFixo` default to .6/5', () => {
    const result = regraSchema.safeParse({ tipo: 'precoAtual' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(defaultsFor('precoAtual'));
    }
  });

  it('copiarOutraTabela: `outraListaId` is required — missing/empty both fail', () => {
    expect(regraSchema.safeParse({ tipo: 'copiarOutraTabela' }).success).toBe(false);
    expect(regraSchema.safeParse({ tipo: 'copiarOutraTabela', outraListaId: '' }).success).toBe(
      false,
    );
    const result = regraSchema.safeParse({ tipo: 'copiarOutraTabela', outraListaId: 'lista2' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ ...defaultsFor('copiarOutraTabela'), outraListaId: 'lista2' });
    }
  });

  it('valorMinimo/valorMaximo default to 0 / 99999999 on every variant', () => {
    const tipos: RegraTipo[] = ['detalhado', 'valorFixo', 'precoAtual', 'copiarOutraTabela'];
    for (const tipo of tipos) {
      expect(defaultsFor(tipo).valorMinimo).toBe(0);
      expect(defaultsFor(tipo).valorMaximo).toBe(99_999_999);
    }
  });
});

describe('regraSchema — percent field bounds (0..1)', () => {
  it('rejects a negative percent with the exact message', () => {
    const issue = issueAt({ tipo: 'detalhado', comissao: -0.1 }, 'comissao');
    expect(issue?.message).toBe('Valor de percentual de 0 a 1');
  });

  it('rejects a percent above 1 with the exact message', () => {
    const issue = issueAt({ tipo: 'detalhado', lucro: 1.5 }, 'lucro');
    expect(issue?.message).toBe('Valor de percentual de 0 a 1');
  });

  it('accepts a percent exactly at 0 and exactly at 1', () => {
    // `comissao` doubles as one of the taxas-sum inputs, so testing its own
    // 0..1 boundary independent of that other refine uses `lucro` instead
    // (untouched by the sum guard) plus the default taxas (sum 0.8, under 1).
    expect(regraSchema.safeParse({ tipo: 'detalhado', comissao: 0 }).success).toBe(true);
    expect(regraSchema.safeParse({ tipo: 'detalhado', lucro: 1 }).success).toBe(true);
  });
});

describe('regraSchema — valorMinimo > valorMaximo refine', () => {
  it('rejects with the exact message on the valorMinimo path', () => {
    const issue = issueAt(
      { tipo: 'valorFixo', novoPreco: 10, valorMinimo: 100, valorMaximo: 50 },
      'valorMinimo',
    );
    expect(issue?.message).toBe('Valor mínimo não pode ser maior que o máximo');
  });

  it('accepts valorMinimo === valorMaximo (not strictly greater)', () => {
    const result = regraSchema.safeParse({
      tipo: 'valorFixo',
      novoPreco: 10,
      valorMinimo: 50,
      valorMaximo: 50,
    });
    expect(result.success).toBe(true);
  });
});

describe('regraSchema — detalhado taxas-sum refine', () => {
  it('rejects when comissao+imposto+frete+marketing >= 1, on the comissao path', () => {
    const issue = issueAt(
      { tipo: 'detalhado', comissao: 0.25, imposto: 0.25, frete: 0.25, marketing: 0.25 },
      'comissao',
    );
    expect(issue?.message).toBe(
      'A soma de comissão, imposto, frete e marketing deve ser menor que 1',
    );
  });

  it('accepts a sum just under 1', () => {
    const result = regraSchema.safeParse({
      tipo: 'detalhado',
      comissao: 0.24,
      imposto: 0.25,
      frete: 0.25,
      marketing: 0.25,
    });
    expect(result.success).toBe(true);
  });

  it('does not apply the taxas-sum refine to other strategy types', () => {
    // valorFixo has no comissao/imposto/frete/marketing fields at all — this
    // must not throw or misfire the detalhado-only refine.
    const result = regraSchema.safeParse({ tipo: 'valorFixo', novoPreco: 10 });
    expect(result.success).toBe(true);
  });
});

describe('defaultsFor', () => {
  it('is total over every RegraTipo (never throws)', () => {
    const tipos: RegraTipo[] = ['detalhado', 'valorFixo', 'precoAtual', 'copiarOutraTabela'];
    for (const tipo of tipos) {
      expect(() => defaultsFor(tipo)).not.toThrow();
      expect(defaultsFor(tipo).tipo).toBe(tipo);
    }
  });

  it('detalhado matches the legacy DoubleField initialValues', () => {
    expect(defaultsFor('detalhado')).toEqual({
      tipo: 'detalhado',
      lucro: 0.6,
      tarifaFixa: 6,
      comissao: 0.2,
      imposto: 0.2,
      frete: 0.2,
      marketing: 0.2,
      margemSeguranca: 0.2,
      valorMinimo: 0,
      valorMaximo: 99_999_999,
    });
  });

  it('precoAtual matches the legacy DoubleField initialValues', () => {
    expect(defaultsFor('precoAtual')).toEqual({
      tipo: 'precoAtual',
      percentual: 0.6,
      valorFixo: 5,
      valorMinimo: 0,
      valorMaximo: 99_999_999,
    });
  });
});
