import { describe, expect, it } from 'vitest';

import { publishDisabledReason, type PublishDisabledInput } from './publishDisabled';

function input(over: Partial<PublishDisabledInput> = {}): PublishDisabledInput {
  return {
    loading: false,
    disabled: false,
    canPublish: true,
    hasClient: true,
    publishingThisConta: false,
    publishingOtherConta: false,
    produtoDirty: false,
    contaDirty: false,
    missingCategoria: false,
    ...over,
  };
}

describe('publishDisabledReason', () => {
  it('returns null when nothing blocks publishing', () => {
    expect(publishDisabledReason(input())).toBeNull();
  });

  /**
   * The publish buttons were clickable while the produto doc, its extraData, the
   * tenant claims and the category attribute grid were all still in flight — so
   * a publish could go out built from data nobody had seen.
   */
  describe('loading outranks every other reason', () => {
    it('says the data is still arriving', () => {
      expect(publishDisabledReason(input({ loading: true }))).toMatch(/carregando/i);
    });

    it('⚠️ beats a FALSE permission denial, which is why it must come first', () => {
      // `usePermission` answers `allowed: false` while it loads, so with the
      // old ordering an operator with full rights was told they lacked
      // permission on every ordinary page load.
      expect(publishDisabledReason(input({ loading: true, canPublish: false }))).toMatch(
        /carregando/i,
      );
    });

    it('beats every remaining reason too — none of them is trustworthy yet', () => {
      const outranked: Array<Partial<PublishDisabledInput>> = [
        { hasClient: false },
        { disabled: true },
        { publishingThisConta: true },
        { publishingOtherConta: true },
        { produtoDirty: true },
        { contaDirty: true },
        { missingCategoria: true },
      ];
      for (const over of outranked) {
        expect(publishDisabledReason(input({ loading: true, ...over }))).toMatch(/carregando/i);
      }
    });

    it('gets out of the way once the data lands', () => {
      // The gate must RELEASE — a permanently-loading signal is a dead button,
      // which is worse than the race it replaces.
      expect(publishDisabledReason(input({ loading: false }))).toBeNull();
    });
  });

  // ⚠️ The two that said NOTHING on screen. An operator hitting either saw a
  // dead button and no explanation anywhere on the page.
  it('explains the produto form not being editable', () => {
    expect(publishDisabledReason(input({ disabled: true }))).toMatch(/modo de edição/i);
  });

  it('explains a missing client, which means an unauthenticated session', () => {
    expect(publishDisabledReason(input({ hasClient: false }))).toMatch(/autenticada/i);
  });

  /**
   * A logged-out operator arrives here with BOTH flags down, because no Firebase
   * user means no claims: `useTenant` answers a userless session with
   * `claims: null, loading: false`, so `usePermission` reports
   * `allowed: false`. Ranking `canPublish` first therefore made the `hasClient`
   * branch unreachable in practice and told someone who merely needs to sign in
   * again that they lack permission — a dead end, since only an admin can grant
   * that. It also contradicted this function's own "most-actionable first" rule.
   */
  it('⚠️ tells a logged-out operator to sign in, NOT that they lack permission', () => {
    const reason = publishDisabledReason(input({ hasClient: false, canPublish: false }));
    expect(reason).toMatch(/autenticada/i);
    expect(reason).not.toMatch(/permissão/i);
  });

  it('still reports a real permission gap once the session is authenticated', () => {
    expect(publishDisabledReason(input({ hasClient: true, canPublish: false }))).toMatch(
      /permissão/i,
    );
  });

  it('explains a publish running on ANOTHER conta', () => {
    // `publishing` is a global latch: while conta A publishes, every other card's
    // button goes flat-disabled with no spinner and no text of its own.
    expect(publishDisabledReason(input({ publishingOtherConta: true }))).toMatch(/outra conta/i);
  });

  // ⚠️ The on-screen text collapses both into "Salve as alterações pendentes",
  // which sends the operator hunting in the wrong half of the screen.
  it('says WHICH half is dirty', () => {
    expect(publishDisabledReason(input({ produtoDirty: true }))).toMatch(/do produto/i);
    expect(publishDisabledReason(input({ contaDirty: true }))).toMatch(/do anúncio/i);
    expect(publishDisabledReason(input({ produtoDirty: true, contaDirty: true }))).toMatch(
      /produto e o anúncio/i,
    );
  });

  it('keeps the categoria wording the e2e pins', () => {
    expect(publishDisabledReason(input({ missingCategoria: true }))).toBe(
      'Escolha a categoria do Mercado Livre antes de publicar.',
    );
  });

  it('leads with permission, which no amount of clicking fixes', () => {
    const reason = publishDisabledReason(
      input({ canPublish: false, produtoDirty: true, missingCategoria: true }),
    );
    expect(reason).toMatch(/permissão/i);
  });

  it('reports a fixable blocker before the categoria decision', () => {
    // Saving is a click; choosing a category is a judgement. Reporting the
    // category first would have the operator make a decision they may not need.
    expect(publishDisabledReason(input({ contaDirty: true, missingCategoria: true }))).toMatch(
      /Salve/,
    );
  });
});
