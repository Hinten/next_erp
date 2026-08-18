import { describe, expect, it } from 'vitest';

import { publishDisabledReason, type PublishDisabledInput } from './publishDisabled';

function input(over: Partial<PublishDisabledInput> = {}): PublishDisabledInput {
  return {
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

  // ⚠️ The two that said NOTHING on screen. An operator hitting either saw a
  // dead button and no explanation anywhere on the page.
  it('explains the produto form not being editable', () => {
    expect(publishDisabledReason(input({ disabled: true }))).toMatch(/modo de edição/i);
  });

  it('explains a missing client, which means an unauthenticated session', () => {
    expect(publishDisabledReason(input({ hasClient: false }))).toMatch(/autenticada/i);
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
