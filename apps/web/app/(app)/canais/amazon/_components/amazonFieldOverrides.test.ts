/**
 * The Amazon slice of the shared `integracao` field config.
 *
 * Three properties earn a test. The read-only `selling_partner_id`: an
 * `editable` that silently flips back to `true` gives the form a writer that
 * races the OAuth callback over the seller a conta is bound to. The exclusion
 * list: the form hides every OTHER channel's account fields while keeping its
 * own, plus the intermediador pair it opts in to — and nothing beyond that
 * pair. And the shared pickers: a spread-and-override that dropped a
 * `renderInput` would turn an optimized picker back into a raw text box.
 */
import { describe, expect, it } from 'vitest';

import { CnpjInput } from '@/components/inputs/CnpjInput';
import {
  CAMPOS_POR_CANAL,
  aparaIdCadIntTran,
  integracaoCamposDeSistema,
} from '../../_components/integracaoFieldOverrides';
import { shopeeExcludedFields } from '../../shopee/_components/shopeeFieldOverrides';
import { amazonExcludedFields, amazonFields } from './amazonFieldOverrides';

describe('amazonFields', () => {
  it('surfaces selling_partner_id read-only, saying who fills it and how to change seller', () => {
    expect(amazonFields.selling_partner_id).toEqual({
      label: 'Selling Partner ID',
      editable: false,
      hint: 'Preenchido pela conexão OAuth (o retorno da Amazon informa o vendedor). Para trocar de vendedor, crie outra conta.',
    });
  });

  it('leaves every other field editable — the near-miss of the read-only id', () => {
    for (const [key, config] of Object.entries(amazonFields)) {
      if (key === 'selling_partner_id') continue;
      expect(config.editable, key).toBeUndefined();
    }
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
      'idCadIntTran',
    ]) {
      expect(typeof amazonFields[key]?.renderInput, key).toBe('function');
    }
  });

  it('renders the intermediador CNPJ through the shared CnpjInput', () => {
    expect(amazonFields.cpf_cnpj).toEqual({
      label: 'CNPJ do intermediador',
      renderInput: CnpjInput,
    });
    expect(amazonFields.idCadIntTran?.label).toBe('Identificador no intermediador');
    // The save-time trim survives the spread: without it a pasted trailing
    // space reaches `<idCadIntTran>` and fails the XSD at emission.
    expect(amazonFields.idCadIntTran?.prepareForSave).toBe(aparaIdCadIntTran);
  });

  it('contracts the channel hints in the feminine — "da Amazon", never "do Amazon"', () => {
    expect(amazonFields.filialIntegracaoPedidoOuterRef?.hint).toBe(
      'Filial dos pedidos importados da Amazon.',
    );
    expect(amazonFields.depositoOuterRef?.hint).toBe(
      'Depósito de onde o estoque é enviado à Amazon.',
    );
  });
});

describe('amazonExcludedFields', () => {
  it('hides every other channel’s account fields, without exception', () => {
    for (const [canal, campos] of Object.entries(CAMPOS_POR_CANAL)) {
      if (canal === 'amazon') continue;
      for (const campo of campos) expect(amazonExcludedFields).toContain(campo);
    }
  });

  it('keeps its own selling_partner_id on the form — shown read-only, not hidden', () => {
    expect(amazonExcludedFields).not.toContain('selling_partner_id');
  });

  it('shows the intermediador pair', () => {
    expect(amazonExcludedFields).not.toContain('cpf_cnpj');
    expect(amazonExcludedFields).not.toContain('idCadIntTran');
  });

  /**
   * The near-misses of that opt-in. It surfaces the pair and nothing else:
   * `modalidadeFreteImportacao` (freight milestone) and the system stamps stay
   * hidden. And it is Amazon's opt-in, not a change of the default: a channel
   * built without it — Shopee — still hides the intermediador CNPJ.
   */
  it('keeps every other system field hidden, modalidadeFreteImportacao and tipo included', () => {
    for (const campo of integracaoCamposDeSistema) {
      if (campo === 'cpf_cnpj' || campo === 'idCadIntTran') continue;
      expect(amazonExcludedFields).toContain(campo);
    }
    expect(amazonExcludedFields).toContain('modalidadeFreteImportacao');
    expect(amazonExcludedFields).toContain('tipo');
  });

  it('does not leak the opt-in into a channel that did not ask for it', () => {
    expect(shopeeExcludedFields).toContain('cpf_cnpj');
    expect(shopeeExcludedFields).toContain('idCadIntTran');
  });

  it('keeps the fields the form is for', () => {
    for (const campo of [
      'nome',
      'ativo',
      'padrao',
      'cor',
      'filialIntegracaoPedidoOuterRef',
      'depositoOuterRef',
    ]) {
      expect(amazonExcludedFields).not.toContain(campo);
    }
  });
});
