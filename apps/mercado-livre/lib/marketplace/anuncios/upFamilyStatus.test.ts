import { describe, expect, it } from 'vitest';

import { foldFamilyStatus } from './upFamilyStatus';

/**
 * The fold is the whole reason a family member's status is not written straight
 * through to the parent link. Its one job is to be conservative about `closed`,
 * because `estado 'c'` drops the produto out of `integracoesComProduto` and so
 * out of BOTH ML sweeps' anchor query — a failure with no error and no log.
 *
 * Cases are written out one by one rather than iterated over a table of the
 * ladder itself: a loop over the ranking cannot notice a rung that was deleted.
 */
describe('foldFamilyStatus', () => {
  it('a live member outranks a closed sibling — the transition this exists for', () => {
    expect(
      foldFamilyStatus([
        { status: 'closed', subStatus: null },
        { status: 'active', subStatus: null },
      ]),
    ).toEqual({ status: 'active', subStatus: null, moderacoes: [] });
  });

  it('closes the family only when EVERY observed member is closed', () => {
    expect(
      foldFamilyStatus([
        { status: 'closed', subStatus: null },
        { status: 'closed', subStatus: ['deleted'] },
      ]),
    ).toEqual({ status: 'closed', subStatus: null, moderacoes: [] });
  });

  it('refuses to conclude when the only observed members are closed and one was never observed', () => {
    // Writing `closed` here would be a guess about the unobserved member, and the
    // cost of guessing wrong is a silent sweep outage. Null leaves the parent as-is.
    expect(
      foldFamilyStatus([
        { status: 'closed', subStatus: null },
        { status: null, subStatus: null },
      ]),
    ).toBeNull();
  });

  it('an unobserved member does NOT block a live conclusion', () => {
    // Only the all-closed reading is unsafe; a live member is proof on its own.
    expect(
      foldFamilyStatus([
        { status: null, subStatus: null },
        { status: 'paused', subStatus: null },
      ]),
    ).toEqual({ status: 'paused', subStatus: null, moderacoes: [] });
  });

  it('nothing observed at all → no conclusion', () => {
    expect(foldFamilyStatus([{ status: null, subStatus: null }])).toBeNull();
    expect(foldFamilyStatus([])).toBeNull();
  });

  it('ranks active over paused over under_review', () => {
    const all = [
      { status: 'under_review', subStatus: null },
      { status: 'paused', subStatus: null },
      { status: 'active', subStatus: null },
    ];
    expect(foldFamilyStatus(all)?.status).toBe('active');
    expect(foldFamilyStatus(all.slice(0, 2))?.status).toBe('paused');
    expect(foldFamilyStatus(all.slice(0, 1))?.status).toBe('under_review');
  });

  it('an unrecognised status still outranks closed — it is evidence of a listing, not of a dead one', () => {
    expect(
      foldFamilyStatus([
        { status: 'closed', subStatus: null },
        { status: 'some_new_ml_status', subStatus: null },
      ])?.status,
    ).toBe('some_new_ml_status');
  });

  it('carries the winning member sub_status, so estado/status/sub_status describe ONE listing', () => {
    expect(
      foldFamilyStatus([
        { status: 'closed', subStatus: ['deleted'] },
        { status: 'paused', subStatus: ['out_of_stock'] },
      ]),
    ).toEqual({ status: 'paused', subStatus: ['out_of_stock'], moderacoes: [] });
  });
});

describe('foldFamilyStatus — the tie-break among equal-ranked members', () => {
  const plainPaused = { status: 'paused', subStatus: null };
  const oosPaused = { status: 'paused', subStatus: ['out_of_stock'] };

  /**
   * `rank` reads `status` alone, so two `paused` members tie — but the stock gate
   * reads the PAIR (`paused` sends only WITH `out_of_stock`). Left to arrive-order
   * the winner would be whichever child produto sorts first by `__name__`: same
   * family, same member statuses, opposite stock outcome. Both orders must agree,
   * and they must agree on the SENDABLE reading.
   */
  it('prefers the sendable reading regardless of member order', () => {
    expect(foldFamilyStatus([plainPaused, oosPaused])).toEqual({ ...oosPaused, moderacoes: [] });
    expect(foldFamilyStatus([oosPaused, plainPaused])).toEqual({ ...oosPaused, moderacoes: [] });
  });

  it('does not let the tie-break promote a LOWER-ranked member', () => {
    // `active` outranks any `paused`, sendable or not — the ladder still governs.
    const active = { status: 'active', subStatus: null };
    expect(foldFamilyStatus([oosPaused, active])).toEqual({ ...active, moderacoes: [] });
    expect(foldFamilyStatus([active, oosPaused])).toEqual({ ...active, moderacoes: [] });
  });

  it('is stable when neither tied member is sendable', () => {
    // ⚠️ `held`, deliberately, NOT `forbidden`. Both are unsendable review
    // sub_statuses, but `forbidden` is the one reading that ranks at the FLOOR
    // (#1226) — so using it here would be testing the removal rung under the
    // name of the tie-break, and it would flip the expected winner.
    const a = { status: 'under_review', subStatus: ['held'] };
    const b = { status: 'under_review', subStatus: null };
    expect(foldFamilyStatus([a, b])).toEqual({ ...a, moderacoes: [] });
  });
});

/**
 * #1226. A listing Mercado Livre has REMOVED (`under_review` + `forbidden`) is
 * as terminal as `closed`, and reaches the parent's `estado` the same way — so
 * it needs the same floor. By `status` alone it would rank 2, ABOVE `closed`,
 * and `prefere`'s moderation rung would then actively favour it over an
 * equally-ranked sibling: a family with one removed member and one merely under
 * review would elect the removed one, take the terminal `estado 'rm'`, and drop
 * the produto out of both sweeps while a savable sibling was still there.
 */
describe('foldFamilyStatus — a removed member never speaks for a live family', () => {
  const removido = { status: 'under_review', subStatus: ['forbidden'] };

  it('loses to any member ML has not ended', () => {
    for (const vivo of [
      { status: 'active', subStatus: null },
      { status: 'paused', subStatus: ['out_of_stock'] },
      // The one that motivated the rung: same STATUS, so the old ladder tied
      // them — and the moderation tie-break then picked the removed one.
      { status: 'under_review', subStatus: ['waiting_for_patch'] },
    ]) {
      expect(foldFamilyStatus([removido, vivo])).toEqual({ ...vivo, moderacoes: [] });
      // Both orders: arrive-order must not decide a family's coverage.
      expect(foldFamilyStatus([vivo, removido])).toEqual({ ...vivo, moderacoes: [] });
    }
  });

  it('decides the family only when every observed member is removed', () => {
    expect(foldFamilyStatus([removido, removido])).toEqual({ ...removido, moderacoes: [] });
    // Mixed with the other terminal reading — still terminal, still concluded.
    expect(foldFamilyStatus([removido, { status: 'closed', subStatus: null }])).not.toBeNull();
  });

  it('cannot conclude while a member was never observed', () => {
    // Inherits `closed`'s guard: an unobserved member is unknown, never dead,
    // and guessing wrong here is the silent sweep outage.
    expect(foldFamilyStatus([removido, { status: null, subStatus: null }])).toBeNull();
  });
});

/**
 * #1087. A family's `moderacoes` has to describe the SAME listing its `status`
 * does, or the parent link shows a reason for a sibling that is not the one
 * being reported — the "one member speaks for the family" mistake (#1142) in a
 * different disguise.
 */
describe('foldFamilyStatus — ML moderations follow the winner', () => {
  const moderacao = (motivo: string) => ({
    nome: 'POOR_QUALITY_THUMBNAIL',
    dataCriacao: null,
    motivo,
    remedio: null,
    secoes: [],
    evidencias: [],
  });

  it("takes the WINNER's moderations, never a union across members", () => {
    // The closed member is moderated; the live one is not. Unioning would show a
    // policy strike against a listing that is selling normally.
    const folded = foldFamilyStatus([
      { status: 'closed', subStatus: null, moderacoes: [moderacao('removido')] },
      { status: 'active', subStatus: null, moderacoes: [] },
    ]);
    expect(folded).toEqual({ status: 'active', subStatus: null, moderacoes: [] });
  });

  it('carries the moderation when the moderated member IS the winner', () => {
    const m = moderacao('foto de capa com marca d\u2019água');
    expect(
      foldFamilyStatus([
        { status: 'closed', subStatus: null, moderacoes: [] },
        { status: 'active', subStatus: ['poor_quality_thumbnail'], moderacoes: [m] },
      ]),
    ).toEqual({ status: 'active', subStatus: ['poor_quality_thumbnail'], moderacoes: [m] });
  });

  it('a member with no moderations folds to [] — which is what CLEARS a lifted one', () => {
    // The parent write is unconditional, so `[]` here is the value that erases a
    // moderation ML has withdrawn. Returning null/undefined would leave it standing.
    expect(foldFamilyStatus([{ status: 'active', subStatus: null }])?.moderacoes).toEqual([]);
  });

  /**
   * The LAST tie-break rung. Two `active` members tie on rank and on
   * sendability, so before #1087 the winner was whichever child produto sorted
   * first by `__name__` — and with it the family's sub_status. Preferring the
   * member that can explain itself turns that coin-flip into information, and it
   * cannot change stock behaviour because both readings are equally sendable.
   */
  it('breaks an otherwise-arbitrary tie toward the member that can explain itself', () => {
    const m = moderacao('infringe as políticas');
    const limpo = { status: 'active', subStatus: null, moderacoes: [] };
    const moderado = { status: 'active', subStatus: ['poor_quality_thumbnail'], moderacoes: [m] };
    expect(foldFamilyStatus([limpo, moderado])).toEqual(moderado);
    expect(foldFamilyStatus([moderado, limpo])).toEqual(moderado);
  });

  it('explainability NEVER outranks sendability — the rung order is load-bearing', () => {
    // A moderated `paused` member without `out_of_stock` cannot take stock; the
    // sendable sibling must still win, or the family stops receiving the `qty > 0`
    // push ML reactivates on. Being able to explain itself does not buy a promotion.
    const moderadoNaoEnviavel = {
      status: 'paused',
      subStatus: ['moderation_penalty'],
      moderacoes: [moderacao('alteração incomum de preço')],
    };
    const enviavelSemMotivo = { status: 'paused', subStatus: ['out_of_stock'], moderacoes: [] };
    expect(foldFamilyStatus([moderadoNaoEnviavel, enviavelSemMotivo])).toEqual(enviavelSemMotivo);
    expect(foldFamilyStatus([enviavelSemMotivo, moderadoNaoEnviavel])).toEqual(enviavelSemMotivo);
  });
});
