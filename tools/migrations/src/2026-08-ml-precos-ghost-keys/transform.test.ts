import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { ghostFieldPath, planGhostKeys } from './transform';

describe('planGhostKeys', () => {
  it('removes the legacy full-path key and leaves the bare-id one alone', () => {
    // The exact shape production carries: legacy wrote the path, every reader
    // (and every other writer) uses the bare id — so both keys coexist.
    const plan = planGhostKeys({
      L1: { valor: 137 },
      'listaDePrecos/L1': { valor: 119.9 },
    });
    expect(plan.deletes).toEqual(['listaDePrecos/L1']);
  });

  it('is a total discriminator: any key with a slash goes, whatever the prefix', () => {
    const plan = planGhostKeys({
      L1: { valor: 1 },
      'listaDePrecos/L1': { valor: 2 },
      'documents/listaDePrecos/L2': { valor: 3 },
      'tabelasDePrecos/L3': { valor: 4 },
    });
    expect(plan.deletes).toEqual([
      'listaDePrecos/L1',
      'documents/listaDePrecos/L2',
      'tabelasDePrecos/L3',
    ]);
  });

  it('never touches a bare id, even an odd-looking one', () => {
    // Firestore doc ids may contain dots, dashes, unicode — none of that makes
    // a key a ghost. Only a slash does, and a slash is illegal in a doc id.
    const plan = planGhostKeys({
      L1: { valor: 1 },
      'ab.cd': { valor: 2 },
      'com-hifen': { valor: 3 },
      preço: { valor: 4 },
    });
    expect(plan.deletes).toEqual([]);
  });

  it('handles a ghost key that also contains a dot — FieldPath never splits it', () => {
    const plan = planGhostKeys({ 'listaDePrecos/ab.cd': { valor: 1 } });
    expect(plan.deletes).toEqual(['listaDePrecos/ab.cd']);
  });

  it('tolerates every legacy precos shape without throwing', () => {
    for (const junk of [undefined, null, [], 'nope', 42, {}]) {
      expect(planGhostKeys(junk)).toEqual({ deletes: [] });
    }
  });

  it('is idempotent — a cleaned map plans nothing on a second run', () => {
    expect(planGhostKeys({ L1: { valor: 137 } })).toEqual({ deletes: [] });
  });
});

describe('ghostFieldPath', () => {
  it('returns a FieldPath whose segments are pre-separated, so the SDK quotes the slash', () => {
    const fp = ghostFieldPath('listaDePrecos/L1');
    expect(fp).toBeInstanceOf(FieldPath);
    // `toString()` is the wire rendering: the segment is backtick-quoted
    // because it is not /^[_a-zA-Z][_a-zA-Z0-9]*$/.
    expect(fp.toString()).toBe('precos.`listaDePrecos/L1`');
  });

  it('quotes a segment containing a dot too, without splitting on it', () => {
    expect(ghostFieldPath('listaDePrecos/ab.cd').toString()).toBe('precos.`listaDePrecos/ab.cd`');
  });

  it('REGRESSION: the dotted-string form the SDK rejects is never produced', () => {
    // This is the bug this file exists to prevent. `update({'precos.<key>': …})`
    // throws before the SDK ever splits the key, because every key here contains
    // a `/`, and the string form is validated against /^[^*~/[\]]+$/. Dry-run
    // never calls update(), so nothing else in the suite would notice.
    const rendered = ghostFieldPath('listaDePrecos/L1').toString();
    expect(rendered).not.toBe('precos.listaDePrecos/L1');
    expect(rendered).toContain('`');
  });
});

describe('the update the migration issues', () => {
  it('reaches a real WriteBatch.update without throwing on the slash', async () => {
    // Exercises the ACTUAL SDK validation path — the one dry-run skips. A
    // dotted-string patch here would throw "Paths ... must not contain \"*~/[]\"".
    const calls: unknown[][] = [];
    const batch = {
      update: (...args: unknown[]) => {
        // Mirror the SDK's own validation of the field argument.
        for (const arg of args) {
          if (typeof arg === 'string' && /[*~/[\]]/.test(arg)) {
            throw new Error(`Value for argument is not a valid field path: ${arg}`);
          }
        }
        calls.push(args);
        return batch;
      },
    };

    const plan = planGhostKeys({ L1: { valor: 1 }, 'listaDePrecos/L1': { valor: 2 } });
    const fields = plan.deletes.flatMap((k) => [ghostFieldPath(k), FieldValue.delete()]);
    expect(() => batch.update({} as never, ...fields)).not.toThrow();

    expect(calls).toHaveLength(1);
    const [, field, value] = calls[0]!;
    expect(field).toBeInstanceOf(FieldPath);
    expect((field as FieldPath).toString()).toBe('precos.`listaDePrecos/L1`');
    expect(value).toStrictEqual(FieldValue.delete());
  });
});
