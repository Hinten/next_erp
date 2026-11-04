import { describe, expect, it } from 'vitest';
import { AfterSaveBlockedError } from '@delfrance/ui';

import {
  MENSAGEM_RASCUNHO_SHOPEE_PENDENTE,
  exigirRascunhosShopeeSalvos,
} from './rascunhoShopeePendente';

/**
 * #1911 P10, DC §2.8: the produto save stops its NAVIGATION — never the save,
 * never a flush of the draft — while the Shopee tab holds unsaved draft work.
 */
describe('exigirRascunhosShopeeSalvos', () => {
  it('a dirty Shopee tab blocks the navigation with AfterSaveBlockedError — the save itself already happened', () => {
    expect(() => exigirRascunhosShopeeSalvos(true)).toThrow(AfterSaveBlockedError);
    expect(() => exigirRascunhosShopeeSalvos(true)).toThrow(MENSAGEM_RASCUNHO_SHOPEE_PENDENTE);
    expect(MENSAGEM_RASCUNHO_SHOPEE_PENDENTE).toContain('«Salvar rascunho»');
    expect(MENSAGEM_RASCUNHO_SHOPEE_PENDENTE).toContain(
      'O que você alterou no produto já foi salvo.',
    );
  });

  it('never claims a produto write: ObjectView also runs this on its nothing-changed path', () => {
    expect(MENSAGEM_RASCUNHO_SHOPEE_PENDENTE).not.toMatch(/^Produto salvo/);
  });

  it('NEAR-MISS: a clean tab lets the save navigate', () => {
    expect(() => exigirRascunhosShopeeSalvos(false)).not.toThrow();
  });
});
