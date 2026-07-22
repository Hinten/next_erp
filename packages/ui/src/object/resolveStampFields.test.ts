import { describe, expect, it } from 'vitest';
import type { FieldDescriptor } from '../schema/types';
import { resolveStampFields } from './resolveStampFields';

function desc(
  key: string,
  opts: { kind?: FieldDescriptor['kind']; dateUnit?: 'ms' | 'us' } = {},
): FieldDescriptor {
  return {
    key,
    kind: opts.kind ?? 'datetime',
    optional: true,
    nullable: true,
    label: key,
    dateUnit: opts.dateUnit,
    zodType: {} as never,
  };
}

describe('resolveStampFields', () => {
  it('auto-detects timestamp + ultimaModificacao', () => {
    const r = resolveStampFields([
      desc('nome', { kind: 'string' }),
      desc('timestamp', { dateUnit: 'ms' }),
      desc('ultimaModificacao', { dateUnit: 'ms' }),
    ]);
    expect(r).toEqual({
      createdAtField: 'timestamp',
      modifiedAtField: 'ultimaModificacao',
      stampUnit: 'ms',
    });
  });

  it('prefers timestamp over dataCadastro when both exist', () => {
    const r = resolveStampFields([
      desc('timestamp', { dateUnit: 'ms' }),
      desc('dataCadastro', { dateUnit: 'ms' }),
    ]);
    expect(r.createdAtField).toBe('timestamp');
  });

  it('falls back to dataCadastro when timestamp is absent', () => {
    const r = resolveStampFields([desc('dataCadastro', { dateUnit: 'ms' })]);
    expect(r.createdAtField).toBe('dataCadastro');
    expect(r.modifiedAtField).toBeUndefined();
    expect(r.stampUnit).toBe('ms');
  });

  it('uses micros when the modified field is us', () => {
    const r = resolveStampFields([
      desc('timestamp', { dateUnit: 'ms' }),
      desc('ultimaModificacao', { dateUnit: 'us' }),
    ]);
    expect(r.stampUnit).toBe('us');
  });

  it('prop override forces a key; false disables', () => {
    const descriptors = [desc('timestamp', { dateUnit: 'ms' }), desc('ultimaModificacao')];
    expect(resolveStampFields(descriptors, { createdAtField: 'dataCadastro' }).createdAtField).toBe(
      'dataCadastro',
    );
    expect(
      resolveStampFields(descriptors, { createdAtField: false }).createdAtField,
    ).toBeUndefined();
    expect(
      resolveStampFields(descriptors, { modifiedAtField: false }).modifiedAtField,
    ).toBeUndefined();
  });

  it('defaults stampUnit to iso when no datetime descriptor matches', () => {
    const r = resolveStampFields([desc('nome', { kind: 'string' })]);
    expect(r.stampUnit).toBe('iso');
    expect(r.createdAtField).toBeUndefined();
    expect(r.modifiedAtField).toBeUndefined();
  });
});
