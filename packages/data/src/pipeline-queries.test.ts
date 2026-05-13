import { describe, expect, it, vi, beforeEach } from 'vitest';

// Pre-declare every export the wrapper looks at so vitest's strict module
// mock doesn't trip on a missing key. Tests reassign these between cases.
// `vi.hoisted` makes the value available inside the hoisted `vi.mock` factory.
const { mockExports } = vi.hoisted(() => ({
  mockExports: {
    pipeline: undefined,
    Field: undefined,
    and: undefined,
    or: undefined,
    gte: undefined,
    lte: undefined,
    ascending: undefined,
    descending: undefined,
  } as Record<string, unknown>,
}));

vi.mock('firebase/firestore', () => mockExports);

import {
  PipelineUnsupportedError,
  buildPipeline,
  isPipelineSupported,
} from './pipeline-queries';

function reset() {
  for (const k of Object.keys(mockExports)) mockExports[k] = undefined;
}

beforeEach(reset);

describe('buildPipeline', () => {
  it('throws PipelineUnsupportedError when pipeline() is missing from SDK', () => {
    expect(isPipelineSupported()).toBe(false);
    expect(() => buildPipeline({} as never, { collection: 'clientes' })).toThrow(
      PipelineUnsupportedError,
    );
  });

  it('builds collection -> where -> sort -> limit when SDK supports pipelines', () => {
    const calls: string[] = [];
    const stage: { where: ReturnType<typeof vi.fn>; sort: ReturnType<typeof vi.fn>; limit: ReturnType<typeof vi.fn> } = {
      where: vi.fn().mockImplementation(() => { calls.push('where'); return stage; }),
      sort: vi.fn().mockImplementation(() => { calls.push('sort'); return stage; }),
      limit: vi.fn().mockImplementation(() => { calls.push('limit'); return stage; }),
    };
    const collection = vi.fn().mockImplementation(() => { calls.push('collection'); return stage; });
    mockExports['pipeline'] = vi.fn().mockReturnValue({ collection });
    mockExports['Field'] = (name: string) => ({ field: name });
    mockExports['and'] = (...args: unknown[]) => ({ and: args });
    mockExports['or'] = (...args: unknown[]) => ({ or: args });
    mockExports['gte'] = (a: unknown, b: unknown) => ({ gte: [a, b] });
    mockExports['lte'] = (a: unknown, b: unknown) => ({ lte: [a, b] });
    mockExports['ascending'] = (f: unknown) => ({ asc: f });
    mockExports['descending'] = (f: unknown) => ({ desc: f });

    expect(isPipelineSupported()).toBe(true);

    buildPipeline({} as never, {
      collection: 'clientes',
      search: { fields: ['nome', 'email'], term: 'ma' },
      orderBy: [{ field: 'nome', direction: 'asc' }],
      limit: 50,
    });

    expect(calls).toEqual(['collection', 'where', 'sort', 'limit']);
    expect(collection).toHaveBeenCalledWith('clientes');
    expect(stage.limit).toHaveBeenCalledWith(50);
  });

  it('skips where when search term is empty', () => {
    const stage = {
      where: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };
    mockExports['pipeline'] = vi.fn().mockReturnValue({ collection: () => stage });
    mockExports['Field'] = (n: string) => n;
    mockExports['and'] = () => ({});
    mockExports['or'] = () => ({});
    mockExports['gte'] = () => ({});
    mockExports['lte'] = () => ({});

    buildPipeline({} as never, {
      collection: 'x',
      search: { fields: ['nome'], term: '' },
    });
    expect(stage.where).not.toHaveBeenCalled();
  });
});
