/**
 * The Shopee slice of the shared `integracao` field config.
 *
 * Two properties earn a test here. The first is the read-only pair: `shop_id`
 * and `main_account_id` are written by the OAuth callback, and an `editable`
 * that silently flips back to `true` gives the form a writer that races the
 * callback over the id a conta is bound to. The second is the exclusion list —
 * the Shopee screen must hide every OTHER channel's account fields while
 * keeping its own two visible, which is the exact fold the shared helper
 * performs.
 */
import { describe, expect, it } from 'vitest';

import { shopeeExcludedFields, shopeeFields } from './shopeeFieldOverrides';

describe('shopeeFields', () => {
  it('surfaces the two OAuth-written ids read-only, each saying who fills it', () => {
    expect(shopeeFields.shop_id?.label).toBe('Shop ID');
    expect(shopeeFields.shop_id?.editable).toBe(false);
    expect(shopeeFields.shop_id?.hint).toContain('conexão OAuth');
    expect(shopeeFields.main_account_id?.label).toBe('Main Account ID');
    expect(shopeeFields.main_account_id?.editable).toBe(false);
    expect(shopeeFields.main_account_id?.hint).toContain('conexão OAuth');
  });

  it('leaves every other field editable — the near-miss of the pair above', () => {
    // `editable: false` on the shared block would freeze the whole form; the
    // read-only decision is scoped to the two ids and nothing else.
    for (const key of ['nome', 'ativo', 'padrao', 'depositoOuterRef', 'cor']) {
      expect(shopeeFields[key]?.editable).toBeUndefined();
    }
  });

  it('keeps the shared pickers rather than replacing them with plain inputs', () => {
    // A spread-and-override that dropped `renderInput` would turn an optimized
    // outer-ref picker back into a raw doc-path text box, silently.
    for (const key of [
      'filialIntegracaoPedidoOuterRef',
      'tabelaNormalOuterRef',
      'tabelaPromocionalOuterRef',
      'operacaoOuterRef',
      'operacaoDevolucaoOuterRef',
      'depositoOuterRef',
      'cor',
    ]) {
      expect(typeof shopeeFields[key]?.renderInput).toBe('function');
    }
  });

  it('contracts the channel hints in the feminine — "da Shopee", never "do Shopee"', () => {
    expect(shopeeFields.filialIntegracaoPedidoOuterRef?.hint).toBe(
      'Filial dos pedidos importados da Shopee.',
    );
    expect(shopeeFields.depositoOuterRef?.hint).toBe(
      'Depósito de onde o estoque é enviado à Shopee.',
    );
  });
});

describe('shopeeExcludedFields', () => {
  it('hides every other channel’s account fields and the system stamps', () => {
    for (const campo of [
      'user_id',
      'modoEnvioMercadoLivre',
      'wa_id',
      'waba_id',
      'phoneNumberId',
      'selling_partner_id',
      'tenant_id',
      'tipo',
      'dataCadastro',
      'ultimaModificacao',
    ]) {
      expect(shopeeExcludedFields).toContain(campo);
    }
  });

  it('hides tabelasAtacado until step 13 owns a real editor for it', () => {
    // `ObjectView` would render it as raw JSON in a text input — an editor that
    // can only corrupt the value.
    expect(shopeeExcludedFields).toContain('tabelasAtacado');
  });

  it('keeps this channel’s own ids on the form — the near-miss of that exclusion', () => {
    expect(shopeeExcludedFields).not.toContain('shop_id');
    expect(shopeeExcludedFields).not.toContain('main_account_id');
  });
});
