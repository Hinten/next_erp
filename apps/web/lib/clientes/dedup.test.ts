import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';

/* --------------------------------- mocks ---------------------------------- */
// Same shape as apps/web/lib/data/getDocsByIds.test.ts: the query builders are
// replaced with tagged plain objects so a test can assert WHICH query was
// issued, and `getDocs` resolves rows keyed on that tag.

type Row = Record<string, unknown>;

const { getDocsMock, executeMock, rowsByQuery, FakePipelineUnsupportedError } = vi.hoisted(() => {
  const rowsByQuery = new Map<string, Array<[string, Record<string, unknown>]>>();
  return {
    rowsByQuery,
    FakePipelineUnsupportedError: class FakePipelineUnsupportedError extends Error {},
    getDocsMock: vi.fn(async (q: { key: string }) => ({
      docs: (rowsByQuery.get(q.key) ?? []).map(([id, data]) => ({ id, data: () => data })),
    })),
    executeMock: vi.fn(async () => ({ results: [] })),
  };
});

vi.mock('firebase/firestore', () => ({ getDocs: getDocsMock }));
vi.mock('firebase/firestore/pipelines', () => ({ execute: executeMock }));

vi.mock('@delfrance/data', () => ({
  PipelineUnsupportedError: FakePipelineUnsupportedError,
  // Each constraint carries its own fragment; `buildQuery` joins them into the
  // key the fake `getDocs` looks up, so an assertion on the key IS an assertion
  // on the field, operator and value that were queried.
  whereEqual: (field: string, value: unknown) => ({ frag: `${field}==${String(value)}` }),
  whereOp: (field: string, op: string, value: unknown) => ({
    frag: `${field}${op}${Array.isArray(value) ? value.join('|') : String(value)}`,
  }),
  orderByField: (field: string, dir: string) => ({ frag: `order:${field}:${dir}` }),
  limit: (n: number) => ({ frag: `limit:${n}` }),
  buildQuery: (_base: unknown, constraints: Array<{ frag: string }>) => ({
    key: constraints.map((c) => c.frag).join(' '),
  }),
  buildPipeline: (_db: unknown, spec: unknown) => spec,
}));

vi.mock('@/lib/data/clienteCollection', () => ({
  clienteCollection: { ref: () => ({}), resolvePath: () => 'clientes' },
}));

import { checkClienteDuplicates, type ClienteDedupInput } from './dedup';

const db = {} as unknown as Firestore;

const CPF_A = '52998224725';
const CPF_A_PUNCTUATED = '529.982.247-25';
const CPF_B = '11144477735';

function input(overrides: Partial<ClienteDedupInput> = {}): ClienteDedupInput {
  return { nome: '', cpf_cnpj: '', idEstrangeiro: '', email: '', telefone: '', ...overrides };
}

function seed(key: string, rows: Array<[string, Row]>): void {
  rowsByQuery.set(key, rows);
}

beforeEach(() => {
  rowsByQuery.clear();
  getDocsMock.mockClear();
});

describe('checkClienteDuplicates — query construction', () => {
  it('normalizes the typed cpf_cnpj before querying it', async () => {
    // The stored value is canonical (clienteSchema's `^[0-9A-Z]*$` rejects
    // punctuation), so querying what the operator typed would find nothing.
    seed(`cpf_cnpj==${CPF_A} limit:5`, [['cli-a', { nome: 'Ana', cpf_cnpj: CPF_A }]]);

    const result = await checkClienteDuplicates(db, input({ cpf_cnpj: CPF_A_PUNCTUATED }));

    expect(result.blocking.map((c) => c.id)).toEqual(['cli-a']);
  });

  it('matches telefone against BOTH wire shapes', async () => {
    seed('telefonein11999998888|5511999998888 limit:5', [
      ['cli-a', { nome: 'Ana', telefone: '5511999998888' }],
    ]);

    const result = await checkClienteDuplicates(db, input({ telefone: '11999998888' }));

    expect(result.telefoneMatches.map((c) => c.id)).toEqual(['cli-a']);
  });

  it('matches e-mail against the typed and lowercased forms', async () => {
    seed('emailinAna@Example.com|ana@example.com limit:5', [
      ['cli-a', { nome: 'Ana', email: 'ana@example.com' }],
    ]);

    const result = await checkClienteDuplicates(db, input({ email: 'Ana@Example.com' }));

    expect(result.emailMatches.map((c) => c.id)).toEqual(['cli-a']);
  });

  it('skips the sub-check for every empty input — no query is issued', async () => {
    const result = await checkClienteDuplicates(db, input());

    expect(getDocsMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      blocking: [],
      similarNome: [],
      telefoneMatches: [],
      emailMatches: [],
    });
  });

  it('falls back to a prefix range when the SDK lacks the Pipelines API', async () => {
    executeMock.mockRejectedValueOnce(new FakePipelineUnsupportedError('no pipelines'));
    seed(`order:nome:asc nome>=Ana nome<=Ana￿ limit:5`, [['cli-a', { nome: 'Ana Maria' }]]);

    const result = await checkClienteDuplicates(db, input({ nome: 'Ana' }));

    expect(result.similarNome.map((c) => c.id)).toEqual(['cli-a']);
  });

  it('propagates a non-pipeline error rather than silently returning nothing', async () => {
    executeMock.mockRejectedValueOnce(new Error('permission-denied'));

    await expect(checkClienteDuplicates(db, input({ nome: 'Ana' }))).rejects.toThrow(
      'permission-denied',
    );
  });
});

describe('checkClienteDuplicates — blocking contract', () => {
  it('blocks on cpf_cnpj and idEstrangeiro, deduping the overlap', async () => {
    seed(`cpf_cnpj==${CPF_A} limit:5`, [['cli-a', { nome: 'Ana', cpf_cnpj: CPF_A }]]);
    seed('idEstrangeiro==AB-123456 limit:5', [
      ['cli-a', { nome: 'Ana', cpf_cnpj: CPF_A }],
      ['cli-b', { nome: 'Bia', idEstrangeiro: 'AB-123456' }],
    ]);

    const result = await checkClienteDuplicates(
      db,
      input({ cpf_cnpj: CPF_A, idEstrangeiro: 'AB-123456' }),
    );

    expect(result.blocking.map((c) => c.id)).toEqual(['cli-a', 'cli-b']);
  });

  it('never promotes a telefone or e-mail match to blocking', async () => {
    // The contract the importer used to violate: a weak key is a warning here,
    // never identity.
    seed('telefonein11999998888|5511999998888 limit:5', [
      ['cli-x', { nome: 'Outra Pessoa', cpf_cnpj: CPF_B, telefone: '5511999998888' }],
    ]);

    const result = await checkClienteDuplicates(
      db,
      input({ cpf_cnpj: CPF_A, telefone: '11999998888' }),
    );

    expect(result.blocking).toEqual([]);
    expect(result.telefoneMatches.map((c) => c.id)).toEqual(['cli-x']);
  });

  it('excludes a blocking candidate from the warning lists', async () => {
    seed(`cpf_cnpj==${CPF_A} limit:5`, [
      ['cli-a', { nome: 'Ana', cpf_cnpj: CPF_A, telefone: '5511999998888' }],
    ]);
    seed('telefonein11999998888|5511999998888 limit:5', [
      ['cli-a', { nome: 'Ana', cpf_cnpj: CPF_A, telefone: '5511999998888' }],
    ]);

    const result = await checkClienteDuplicates(
      db,
      input({ cpf_cnpj: CPF_A, telefone: '11999998888' }),
    );

    expect(result.blocking.map((c) => c.id)).toEqual(['cli-a']);
    expect(result.telefoneMatches).toEqual([]);
  });
});

describe('checkClienteDuplicates — identityConflict', () => {
  it('flags a telefone match whose document contradicts what was typed', async () => {
    seed('telefonein11999998888|5511999998888 limit:5', [
      ['cli-x', { nome: 'Outra Pessoa', cpf_cnpj: CPF_B, telefone: '5511999998888' }],
    ]);

    const result = await checkClienteDuplicates(
      db,
      input({ cpf_cnpj: CPF_A, telefone: '11999998888' }),
    );

    expect(result.telefoneMatches[0]?.identityConflict).toBe(true);
  });

  it('does NOT flag a candidate with no document — absence is not a contradiction', async () => {
    seed('telefonein11999998888|5511999998888 limit:5', [
      ['cli-a', { nome: 'Ana', telefone: '5511999998888' }],
    ]);

    const result = await checkClienteDuplicates(
      db,
      input({ cpf_cnpj: CPF_A, telefone: '11999998888' }),
    );

    expect(result.telefoneMatches[0]?.identityConflict).toBe(false);
  });

  it('does NOT flag on punctuation alone — both sides are normalized', async () => {
    seed('telefonein11999998888|5511999998888 limit:5', [
      ['cli-a', { nome: 'Ana', cpf_cnpj: CPF_A_PUNCTUATED, telefone: '5511999998888' }],
    ]);

    const result = await checkClienteDuplicates(
      db,
      input({ cpf_cnpj: CPF_A, telefone: '11999998888' }),
    );

    expect(result.telefoneMatches[0]?.identityConflict).toBe(false);
  });

  it('does NOT flag when nothing was typed to contradict', async () => {
    seed('telefonein11999998888|5511999998888 limit:5', [
      ['cli-x', { nome: 'Outra Pessoa', cpf_cnpj: CPF_B, telefone: '5511999998888' }],
    ]);

    const result = await checkClienteDuplicates(db, input({ telefone: '11999998888' }));

    expect(result.telefoneMatches[0]?.identityConflict).toBe(false);
  });
});
