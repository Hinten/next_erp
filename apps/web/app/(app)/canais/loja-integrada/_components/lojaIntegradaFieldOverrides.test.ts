/**
 * The Loja Integrada slice of the shared `integracao` field config.
 *
 * Two properties earn a test. The first is the exclusion list: this channel
 * owns no flat account field, so the screen must hide EVERY other channel's
 * (the fold `integracaoExcludedFields(null)` performs) rather than keep one of
 * them by accident. The second is that the shared pickers survive: a
 * spread-and-override that dropped a `renderInput` would turn an optimized
 * outer-ref picker back into a raw doc-path text box, silently.
 */
import { describe, expect, it } from 'vitest';

import {
  CAMPOS_POR_CANAL,
  integracaoCamposDeSistema,
} from '../../_components/integracaoFieldOverrides';
import { lojaIntegradaExcludedFields, lojaIntegradaFields } from './lojaIntegradaFieldOverrides';

describe('lojaIntegradaFields', () => {
  it('contracts the channel hints in the feminine, "da/à Loja Integrada", never "do/ao"', () => {
    expect(lojaIntegradaFields.filialIntegracaoPedidoOuterRef?.hint).toBe(
      'Filial dos pedidos importados da Loja Integrada.',
    );
    expect(lojaIntegradaFields.depositoOuterRef?.hint).toBe(
      'Depósito de onde o estoque é enviado à Loja Integrada.',
    );
  });

  it('keeps the shared pickers rather than replacing them with plain inputs', () => {
    for (const key of [
      'filialIntegracaoPedidoOuterRef',
      'tabelaNormalOuterRef',
      'tabelaPromocionalOuterRef',
      'operacaoOuterRef',
      'operacaoDevolucaoOuterRef',
      'depositoOuterRef',
      'cor',
    ]) {
      expect(typeof lojaIntegradaFields[key]?.renderInput).toBe('function');
    }
  });

  it('leaves every field editable, since this channel has no callback-written field to freeze', () => {
    // The near-miss of the Shopee screen, whose `shop_id` is read-only because
    // the OAuth callback writes it. Nothing writes an LI field outside the form.
    for (const config of Object.values(lojaIntegradaFields)) {
      expect(config.editable).toBeUndefined();
    }
  });
});

describe('lojaIntegradaExcludedFields', () => {
  it('hides every other channel’s account fields, without exception', () => {
    for (const campos of Object.values(CAMPOS_POR_CANAL)) {
      for (const campo of campos) {
        expect(lojaIntegradaExcludedFields).toContain(campo);
      }
    }
  });

  it('hides the system stamps, including the pinned tipo', () => {
    for (const campo of integracaoCamposDeSistema) {
      expect(lojaIntegradaExcludedFields).toContain(campo);
    }
    expect(lojaIntegradaExcludedFields).toContain('tipo');
  });

  it('keeps the fields the form is for, the near-miss of those exclusions', () => {
    for (const campo of [
      'nome',
      'ativo',
      'padrao',
      'cor',
      'filialIntegracaoPedidoOuterRef',
      'depositoOuterRef',
    ]) {
      expect(lojaIntegradaExcludedFields).not.toContain(campo);
    }
  });
});
