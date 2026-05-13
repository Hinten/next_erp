import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the Pipelines subpath. Tests reassign these between cases via reset().
// `vi.hoisted` ensures the mock object is built before vi.mock evaluates.
const { mockPipelinesExports } = vi.hoisted(() => ({
  mockPipelinesExports: {
    field: (n: string) => ({ kind: 'field', name: n }),
    or: (...xs: unknown[]) => ({ kind: 'or', xs }),
    ascending: (f: unknown) => ({ kind: 'asc', f }),
    descending: (f: unknown) => ({ kind: 'desc', f }),
    startsWith: (f: unknown, t: unknown) => ({ kind: 'startsWith', f, t }),
  } as Record<string, unknown>,
}));

vi.mock('firebase/firestore/pipelines', () => mockPipelinesExports);

import type { Firestore } from 'firebase/firestore';
import {
  PipelineUnsupportedError,
  buildPipeline,
  isPipelineSupported,
} from './pipeline-queries';

interface Stage {
  where: ReturnType<typeof vi.fn>;
  sort: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  __calls: string[];
}

function makeStage(): Stage {
  const calls: string[] = [];
  const stage = {
    where: vi.fn(() => {
      calls.push('where');
      return stage;
    }),
    sort: vi.fn(() => {
      calls.push('sort');
      return stage;
    }),
    limit: vi.fn(() => {
      calls.push('limit');
      return stage;
    }),
    __calls: calls,
  } as Stage;
  return stage;
}

function makeDb(withPipeline: boolean): {
  db: Firestore;
  stage: Stage;
  collection: ReturnType<typeof vi.fn>;
} {
  const stage = makeStage();
  const collection = vi.fn(() => stage);
  const db = (
    withPipeline ? { pipeline: vi.fn(() => ({ collection })) } : {}
  ) as unknown as Firestore;
  return { db, stage, collection };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isPipelineSupported', () => {
  it('returns false when db.pipeline is missing', () => {
    const { db } = makeDb(false);
    expect(isPipelineSupported(db)).toBe(false);
  });

  it('returns true when db.pipeline is a function', () => {
    const { db } = makeDb(true);
    expect(isPipelineSupported(db)).toBe(true);
  });
});

describe('buildPipeline', () => {
  it('throws PipelineUnsupportedError when db.pipeline is missing', () => {
    const { db } = makeDb(false);
    expect(() => buildPipeline(db, { collection: 'clientes' })).toThrow(
      PipelineUnsupportedError,
    );
  });

  it('builds collection -> where(or(startsWith, startsWith)) -> sort -> limit', () => {
    const { db, stage, collection } = makeDb(true);
    buildPipeline(db, {
      collection: 'clientes',
      search: { fields: ['nome', 'email'], term: 'ma' },
      orderBy: [{ field: 'nome', direction: 'asc' }],
      limit: 50,
    });

    expect(collection).toHaveBeenCalledWith('clientes');
    expect(stage.__calls).toEqual(['where', 'sort', 'limit']);
    expect(stage.where).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'or' }),
    );
    expect(stage.sort).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'asc' }),
    );
    expect(stage.limit).toHaveBeenCalledWith(50);
  });

  it('uses single startsWith directly (no or) when only one search field', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'x',
      search: { fields: ['nome'], term: 'a' },
    });
    expect(stage.where).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'startsWith' }),
    );
  });

  it('skips where when search term is empty', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'x',
      search: { fields: ['nome'], term: '' },
    });
    expect(stage.where).not.toHaveBeenCalled();
  });

  it('descending sort wraps field in descending()', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'x',
      orderBy: [{ field: 'createdAt', direction: 'desc' }],
    });
    expect(stage.sort).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'desc' }),
    );
  });
});
