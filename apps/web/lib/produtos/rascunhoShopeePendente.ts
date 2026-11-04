import { AfterSaveBlockedError } from '@delfrance/ui';

/**
 * The produto save's stop for an UNSAVED Shopee draft (#1911, P10, DC §2.8).
 *
 * The Shopee tab's drafts are not part of the produto's form: each one is
 * written by its OWN "Salvar rascunho" through apps/shopee's draft route, whose
 * answer can be a 409 the operator must resolve in the tab — so the produto
 * save never flushes them (D7). What it must not do either is navigate away
 * from typed drafts in silence: "Salvar alterações" ends in
 * `router.replace('/produtos')`, which the unsaved-changes guard does not
 * intercept (it watches `beforeunload`, link clicks and `popstate` only).
 *
 * So the edit page calls this in `onAfterSave`, AFTER the Mercado Livre flush
 * (which can block too) and with its `shopeeDirty` ref: the produto and every
 * sibling are already committed, and `AfterSaveBlockedError` only stops the
 * navigation — `ObjectView` shows the message and skips `onSaved`.
 *
 * It lives here, not in the page, because a Next page module may export only
 * what the route contract allows.
 *
 * The message never opens with "Produto salvo.": `ObjectView` also runs
 * `onAfterSave` on its nothing-changed path (only a draft is dirty), where no
 * produto write happened. "What you changed in the produto is already saved"
 * holds on both paths.
 */
export const MENSAGEM_RASCUNHO_SHOPEE_PENDENTE =
  'O rascunho da Shopee tem alterações não salvas: use «Salvar rascunho», ' +
  '«Desfazer alterações» ou «Descartar» na aba Shopee. O que você alterou no produto já foi salvo.';

/** Throws {@link AfterSaveBlockedError} when the Shopee tab reports unsaved draft work. */
export function exigirRascunhosShopeeSalvos(sujo: boolean): void {
  if (sujo) throw new AfterSaveBlockedError(MENSAGEM_RASCUNHO_SHOPEE_PENDENTE);
}
