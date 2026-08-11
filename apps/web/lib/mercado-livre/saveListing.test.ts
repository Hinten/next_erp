import { describe, expect, it } from 'vitest';
import type { ProdutoMercadoLivreLink } from '@delfrance/schemas';

import { linkFixture } from './linkFixture';
import {
  ListingConflictError,
  ListingMissingError,
  ListingNothingChangedError,
  saveListing,
  type ListingSavePort,
} from './saveListing';

const NOW = 1_800_000_000_000;

/** In-memory port: records what a save would write, without Firestore. */
function fakePort(current: ProdutoMercadoLivreLink | null) {
  const writes: Array<Record<string, unknown>> = [];
  const port: ListingSavePort = {
    now: () => NOW,
    async update(patchFor) {
      const patch = patchFor(current);
      if (Object.keys(patch).length > 0) writes.push(patch);
    },
  };
  return { port, writes };
}

describe('saveListing', () => {
  it('writes only the keys that actually changed', async () => {
    const baseline = linkFixture({ title: 'Antigo', descricao: null });
    const { port, writes } = fakePort(baseline);

    await saveListing(port, {
      values: { title: 'Novo', descricao: null, category_id: baseline.category_id },
      // The operator touched three inputs, but two ended where they started.
      dirty: { title: true, descricao: true, category_id: true },
      baseline,
      baselineMs: baseline.ultimaModificacao ?? null,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ title: 'Novo', ultimaModificacao: NOW });
  });

  it('refuses a save whose every dirty field round-tripped', async () => {
    // A nullable input clears through '' and comes back, so "dirty" alone is
    // not evidence of an edit — and writing it anyway would let a no-op
    // overwrite a value someone else legitimately changed.
    const baseline = linkFixture();
    const { port, writes } = fakePort(baseline);

    await expect(
      saveListing(port, {
        values: { title: baseline.title, descricao: null },
        dirty: { title: true, descricao: true },
        baseline,
        baselineMs: baseline.ultimaModificacao ?? null,
      }),
    ).rejects.toBeInstanceOf(ListingNothingChangedError);
    expect(writes).toHaveLength(0);
  });

  it('ignores keys outside the operator-owned allow-list', async () => {
    const baseline = linkFixture({ estado: 'p' });
    const { port, writes } = fakePort(baseline);

    await saveListing(port, {
      values: { title: 'Novo', estado: 'E' } as never,
      dirty: { title: true, estado: true },
      baseline,
      baselineMs: baseline.ultimaModificacao ?? null,
    });

    expect(writes[0]).not.toHaveProperty('estado');
  });

  it('lets a remote change to a key we do NOT write through untouched', async () => {
    // The price sync refreshing `precoPublicado` while the editor is open must
    // not block a `descricao` edit, or the screen becomes unusable on any
    // listing ML is actively syncing.
    const baseline = linkFixture({ precoPublicado: 79.9 });
    const remote = linkFixture({
      precoPublicado: 88.0,
      ultimaModificacao: (baseline.ultimaModificacao ?? 0) + 5_000,
    });
    const { port, writes } = fakePort(remote);

    await saveListing(port, {
      values: { descricao: 'nova' },
      dirty: { descricao: true },
      baseline,
      baselineMs: baseline.ultimaModificacao ?? null,
    });

    expect(writes[0]).toEqual({ descricao: 'nova', ultimaModificacao: NOW });
  });

  it('raises a conflict when the remote doc moved on a key this save writes', async () => {
    const baseline = linkFixture({ title: 'Original' });
    const remote = linkFixture({
      title: 'Alterado por outra pessoa',
      ultimaModificacao: (baseline.ultimaModificacao ?? 0) + 5_000,
    });
    const { port, writes } = fakePort(remote);

    const err = await saveListing(port, {
      values: { title: 'Meu texto' },
      dirty: { title: true },
      baseline,
      baselineMs: baseline.ultimaModificacao ?? null,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ListingConflictError);
    expect((err as ListingConflictError).fields).toEqual(['title']);
    expect((err as ListingConflictError).current.title).toBe('Alterado por outra pessoa');
    expect(writes).toHaveLength(0);
  });

  it('goes through once the operator re-baselines on the version they reviewed', async () => {
    // "Salvar mesmo assim" is a re-save against the remote doc, not a blind
    // force — so if the doc moves AGAIN it trips a second time.
    const reviewed = linkFixture({ title: 'Alterado por outra pessoa' });
    const { port, writes } = fakePort(reviewed);

    await saveListing(port, {
      values: { title: 'Meu texto' },
      dirty: { title: true },
      baseline: reviewed,
      baselineMs: reviewed.ultimaModificacao ?? null,
    });

    expect(writes[0]).toEqual({ title: 'Meu texto', ultimaModificacao: NOW });
  });

  it('reports a deleted link doc instead of resurrecting it', async () => {
    // `tx.update` on a missing doc fails anyway; catching it here gives the
    // operator a sentence instead of a Firestore code.
    const baseline = linkFixture();
    const { port } = fakePort(null);

    await expect(
      saveListing(port, {
        values: { title: 'Novo' },
        dirty: { title: true },
        baseline,
        baselineMs: baseline.ultimaModificacao ?? null,
      }),
    ).rejects.toBeInstanceOf(ListingMissingError);
  });

  it('stamps ultimaModificacao in MILLISECONDS', async () => {
    // The ML link docs stamp ms while pedido/pagamento/produto stamp µs; a
    // cross-unit value makes every later staleness comparison a no-op.
    const baseline = linkFixture();
    const { port, writes } = fakePort(baseline);

    await saveListing(port, {
      values: { title: 'Novo' },
      dirty: { title: true },
      baseline,
      baselineMs: baseline.ultimaModificacao ?? null,
    });

    const stamp = writes[0]!.ultimaModificacao as number;
    // 1.8e12 ms ≈ year 2027; the µs value of the same instant is 1000× larger.
    expect(stamp).toBeLessThan(1e13);
  });
});
