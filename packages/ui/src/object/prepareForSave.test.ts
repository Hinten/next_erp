import { describe, expect, it } from 'vitest';
import type { FieldConfig } from '../schema/types';
import {
  applyPrepareForSave,
  collectPrepareForSave,
  MAX_NESTING_DEPTH,
  type PreparedTransform,
} from './prepareForSave';

const bang = (v: unknown): unknown => `${v as string}!`;
const upper = (v: unknown): unknown => String(v).toUpperCase();

function paths(transforms: readonly PreparedTransform[]): string[] {
  return transforms.map((t) => t.path.join('.'));
}

/** Freeze an object graph so any mutation throws in strict mode (ES modules). */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

describe('collectPrepareForSave', () => {
  it('collects top-level and nested transforms, parent before its descendants', () => {
    const overrides: Record<string, FieldConfig> = {
      nome: { prepareForSave: bang },
      endereco: {
        prepareForSave: upper,
        fields: { telefone: { prepareForSave: bang }, cep: { label: 'CEP' } },
      },
      email: { label: 'E-mail' },
    };
    expect(paths(collectPrepareForSave(overrides))).toEqual([
      'nome',
      'endereco',
      'endereco.telefone',
    ]);
  });

  it('collects a nested transform even when the parent declares none', () => {
    const overrides: Record<string, FieldConfig> = {
      enderecoDeOrigem: { fields: { telefone: { prepareForSave: bang } } },
    };
    expect(paths(collectPrepareForSave(overrides))).toEqual(['enderecoDeOrigem.telefone']);
  });

  it('returns an empty list when nothing declares a transform', () => {
    expect(
      collectPrepareForSave({ a: { label: 'A' }, b: { fields: { c: { hidden: true } } } }),
    ).toEqual([]);
  });
});

describe('collectPrepareForSave — termination', () => {
  it('terminates on a cyclic config graph', { timeout: 2000 }, () => {
    // The type permits this: `fields` is `Record<string, FieldConfig>` and the
    // two-step form is legal TS.
    const cyclic: FieldConfig = { prepareForSave: bang, fields: {} };
    cyclic.fields!.self = cyclic;

    const collected = collectPrepareForSave({ root: cyclic });

    // It stops at the ancestor, so `root` and `root.self` are reached and the
    // cycle is not followed a second time.
    expect(paths(collected)).toEqual(['root', 'root.self']);
  });

  it('terminates on a cycle reached through an intermediate config', { timeout: 2000 }, () => {
    const a: FieldConfig = { fields: {} };
    const b: FieldConfig = { prepareForSave: bang, fields: { backToA: a } };
    a.fields!.toB = b;

    // `a` is on the ancestor path when it is reached again, so the walk stops
    // there instead of looping a -> b -> a -> b …
    expect(paths(collectPrepareForSave({ a }))).toEqual(['a.toB']);
  });

  it('a leaf shared by two parents is NOT a cycle — both occurrences are collected', () => {
    // The real shape: `intFreteFields.tsx` spreads `enderecoNestedFields`, so
    // the same leaf object hangs under two different parents. A global visited
    // set would silently drop the second one.
    const sharedLeaf: FieldConfig = { prepareForSave: bang };
    const shared: Record<string, FieldConfig> = { telefone: sharedLeaf };
    const overrides: Record<string, FieldConfig> = {
      sede: { fields: shared },
      enderecoDeOrigem: { fields: { ...shared } },
    };
    expect(paths(collectPrepareForSave(overrides))).toEqual([
      'sede.telefone',
      'enderecoDeOrigem.telefone',
    ]);
  });

  it('stops at MAX_NESTING_DEPTH on a chain deeper than the cap', () => {
    const deep: FieldConfig = { prepareForSave: bang };
    let cursor = deep;
    for (let i = 0; i < MAX_NESTING_DEPTH + 5; i++) {
      const child: FieldConfig = { prepareForSave: bang };
      cursor.fields = { child };
      cursor = child;
    }
    const collected = collectPrepareForSave({ root: deep });
    expect(collected.length).toBe(MAX_NESTING_DEPTH + 1);
    expect(collected[collected.length - 1]!.path.length).toBe(MAX_NESTING_DEPTH + 1);
  });
});

describe('applyPrepareForSave', () => {
  it('applies a nested transform and leaves siblings untouched', () => {
    const values = { nome: 'a', endereco: { telefone: '11999998888', cep: '01000000' } };
    const out = applyPrepareForSave(
      values,
      collectPrepareForSave({
        endereco: { fields: { telefone: { prepareForSave: (v) => `55${v as string}` } } },
      }),
    );
    expect(out).toEqual({
      nome: 'a',
      endereco: { telefone: '5511999998888', cep: '01000000' },
    });
  });

  it('does not mutate its input and shares untouched subtrees by reference', () => {
    const values = deepFreeze({
      endereco: { telefone: '11999998888' },
      outro: { intocado: true },
    });
    const out = applyPrepareForSave(
      values as Record<string, unknown>,
      collectPrepareForSave({
        endereco: { fields: { telefone: { prepareForSave: upper } } },
      }),
    );
    expect(values.endereco.telefone).toBe('11999998888');
    expect(out).not.toBe(values);
    expect(out.endereco).not.toBe(values.endereco);
    // Copy-on-write: nothing was written under `outro`, so it is shared.
    expect(out.outro).toBe(values.outro);
  });

  it('skips a null parent without materializing it', () => {
    const values = deepFreeze({ enderecoDeOrigem: null });
    const out = applyPrepareForSave(
      values as Record<string, unknown>,
      collectPrepareForSave({
        enderecoDeOrigem: { fields: { telefone: { prepareForSave: bang } } },
      }),
    );
    expect(out.enderecoDeOrigem).toBeNull();
  });

  it('skips an absent parent without materializing it', () => {
    const out = applyPrepareForSave(
      {},
      collectPrepareForSave({
        enderecoDeOrigem: { fields: { telefone: { prepareForSave: bang } } },
      }),
    );
    expect(out).toEqual({});
    expect('enderecoDeOrigem' in out).toBe(false);
  });

  it('runs the parent transform first, then the child on its output', () => {
    const overrides: Record<string, FieldConfig> = {
      endereco: {
        // The parent rewrites the whole object...
        prepareForSave: (v) => ({ ...(v as Record<string, unknown>), pais: 'Brasil' }),
        // ...and the child then wins for its own key.
        fields: { telefone: { prepareForSave: upper } },
      },
    };
    const out = applyPrepareForSave(
      { endereco: { telefone: 'ab', cep: '01000000' } },
      collectPrepareForSave(overrides),
    );
    expect(out.endereco).toEqual({ telefone: 'AB', cep: '01000000', pais: 'Brasil' });
  });

  it('a parent transform that nulls the object stops its children', () => {
    const out = applyPrepareForSave(
      { endereco: { telefone: 'ab' } },
      collectPrepareForSave({
        endereco: { prepareForSave: () => null, fields: { telefone: { prepareForSave: upper } } },
      }),
    );
    expect(out.endereco).toBeNull();
  });

  it('returns a fresh root even with no transforms', () => {
    const values = { a: 1 };
    const out = applyPrepareForSave(values, []);
    expect(out).toEqual(values);
    expect(out).not.toBe(values);
  });

  it('transforms a nested key that is absent on an existing parent', () => {
    // Parity with the top-level behaviour, which calls `fn(raw[key])`
    // unconditionally; in practice `buildEmptyDefaults` puts the key there.
    const out = applyPrepareForSave(
      { endereco: { cep: '01000000' } },
      collectPrepareForSave({ endereco: { fields: { telefone: { prepareForSave: () => null } } } }),
    );
    expect(out.endereco).toEqual({ cep: '01000000', telefone: null });
  });
});
