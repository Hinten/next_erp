/**
 * K2 (step 21, #1529) — the guard the three kit refusal suites
 * (`armaDePublicacao`, `planoKit`, `recriarKit`) run over every refusal they
 * produce: a refusal whose sentence names a CLI flag or a CLI command must ALSO
 * carry the machine-readable `acao` (`@delfrance/schemas`
 * `shopeeAcaoSugerida.ts`) that the produto's Shopee tab maps to a button. The
 * web never parses the sentence, so a CLI-worded refusal shipped without `acao`
 * reaches the operator as advice nobody can follow from the browser.
 *
 * Test-only, imported by no source file (the `lib/shopee/testing/` precedent);
 * it sits in a SUBFOLDER so the raw-text producer scans over `kits/*.ts`
 * (`anuncios/errosPublicacao.test.ts`, O7) never read it. It throws instead of
 * importing `vitest`, so a test that calls it fails like any assertion.
 */
import type { ProblemaPublicacao } from '../../anuncios/errosPublicacao';

/**
 * A CLI flag (`--link`, `--recriar`, at the start, after a space or after an
 * opening parenthesis — `(--principal)` is how two sentences spell it) or a CLI
 * command (`importar:anuncio`, `publicar:anuncio`, `reverificar:anuncio`).
 * Slightly WIDER than the reconcile's `/(^|\s)--[a-z]|:anuncio/` on purpose:
 * the parenthesised flag is the same advice.
 */
export const FRASE_COM_COMANDO = /(^|[\s(])--[a-z]|:anuncio/;

/** Throws when `p.mensagem` names a CLI flag or command and `p.acao` is absent. */
export function exigirAcaoSeHaComando(
  p: Pick<ProblemaPublicacao, 'motivo' | 'mensagem' | 'acao'>,
): void {
  if (FRASE_COM_COMANDO.test(p.mensagem) && p.acao === undefined) {
    throw new Error(
      `a recusa ${p.motivo} nomeia um comando de CLI e não traz \`acao\`: «${p.mensagem}»`,
    );
  }
}

/** {@link exigirAcaoSeHaComando} over a whole list, returned untouched for chaining. */
export function exigirAcaoEmTodas<
  P extends Pick<ProblemaPublicacao, 'motivo' | 'mensagem' | 'acao'>,
>(problemas: readonly P[]): readonly P[] {
  for (const p of problemas) exigirAcaoSeHaComando(p);
  return problemas;
}
