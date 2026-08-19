/**
 * Why the "Publicar no Mercado Livre" button is disabled, in words.
 *
 * ⚠️ Six independent conditions can disable that button and only three of them
 * said anything on screen. The two worst were wholly silent: `disabled` (the
 * produto form is not editable — ObjectView threads it down through
 * `renderInput`) and `!client` (no authenticated Firebase user, so the ML HTTP
 * client is null). An operator hitting either saw a dead control and no reason
 * anywhere on the page.
 *
 * The three that DO render a `<Text>` beneath the button keep doing so — the
 * vendas e2e asserts the categoria one as visible page text — but they are
 * repeated here so the tooltip is complete rather than a second, partial story.
 *
 * Pure on purpose: the ordering below is the whole behaviour, and it is cheaper
 * to pin in a unit test than through a rendered card.
 */
export interface PublishDisabledInput {
  /**
   * Data the decision itself depends on has not arrived yet — the produto doc,
   * its extraData, the tenant claims, or a listing's category attributes.
   */
  loading: boolean;
  /** ObjectView's `disabled` — the produto form is not in an editable state. */
  disabled: boolean;
  /** `PERM.integracao.write`. */
  canPublish: boolean;
  /** The ML HTTP client; null until there is an authenticated user. */
  hasClient: boolean;
  /** A publish is already in flight — for THIS conta, or another one. */
  publishingThisConta: boolean;
  publishingOtherConta: boolean;
  /** The produto form holds unsaved edits. */
  produtoDirty: boolean;
  /** A listing in this conta holds unsaved edits. */
  contaDirty: boolean;
  /** The listing has no `category_id`. */
  missingCategoria: boolean;
}

/**
 * `null` when the button is enabled.
 *
 * Order is most-actionable first: something the operator can fix right now beats
 * something they can only wait for, which beats something only an admin can
 * grant. ⚠️ `produtoDirty` and `contaDirty` are reported SEPARATELY — the
 * on-screen text collapses both into "Salve as alterações pendentes", which
 * leaves the operator hunting for edits in the wrong half of the screen.
 */
export function publishDisabledReason(input: PublishDisabledInput): string | null {
  // ⚠️ FIRST, and this deliberately inverts the "most-actionable first" order
  // documented above — that order ranks GENUINE reasons. While the data is still
  // arriving every other input is derived from what has not landed, so they
  // answer confidently and wrongly. The visible case is `canPublish`:
  // `usePermission` returns `allowed: false` WHILE LOADING (`usePermission.ts`),
  // so the branch below used to tell an operator with full rights that they
  // lacked permission, on every ordinary page load, until the claims resolved.
  // Nothing here is actionable anyway — the only correct instruction is "wait".
  if (input.loading) return 'Carregando os dados do anúncio…';
  if (!input.canPublish) return 'Requer permissão de escrita em integrações.';
  if (!input.hasClient) return 'Sessão não autenticada — recarregue a página e entre novamente.';
  if (input.disabled) return 'O formulário do produto não está em modo de edição.';
  if (input.publishingThisConta) return 'Publicação em andamento…';
  if (input.publishingOtherConta) return 'Aguarde a publicação em andamento em outra conta.';
  if (input.produtoDirty && input.contaDirty) {
    return 'Salve o produto e o anúncio antes de publicar.';
  }
  if (input.produtoDirty) return 'Salve as alterações do produto antes de publicar.';
  if (input.contaDirty) return 'Salve as alterações do anúncio antes de publicar.';
  // Last: it is the only one that needs a decision rather than a click, and the
  // three above all hide it today (the on-screen text gates it behind
  // `!publishBlocked`, so fixing the dirty state reveals a NEW blocker).
  if (input.missingCategoria) return 'Escolha a categoria do Mercado Livre antes de publicar.';
  return null;
}
