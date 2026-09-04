import { describe, expect, it } from 'vitest';
import { integracaoSchema } from '@delfrance/schemas';

import {
  CAMPOS_POR_CANAL,
  integracaoCamposDeSistema,
  integracaoExcludedFields,
  integracaoFieldsCompartilhados,
} from './integracaoFieldOverrides';

/**
 * The generic block — the fields EVERY channel form renders. Written as a
 * literal on purpose: derived from the factory alone it would agree with
 * whatever the factory happens to return, and the totality assertion below
 * would go vacuous the moment a field silently left the factory.
 */
const CAMPOS_GENERICOS = [
  'nome',
  'ativo',
  'padrao',
  'cor',
  'filialIntegracaoPedidoOuterRef',
  'tabelaNormalOuterRef',
  'tabelaPromocionalOuterRef',
  'operacaoOuterRef',
  'operacaoDevolucaoOuterRef',
  'depositoOuterRef',
];

/**
 * The three exclusion arrays EXACTLY as the three channel screens carried them
 * before the extraction (`git show main:…FieldOverrides.tsx`). These literals
 * are the regression test of the refactor: they are not derived from the new
 * module in any way, so a shared list that quietly gains or loses a field
 * fails here rather than in production, where the symptom is a raw number
 * input appearing on a shipped form.
 */
const ML_EXCLUDED_ANTES = [
  'tipo',
  'cpf_cnpj',
  'idCadIntTran',
  'modalidadeFreteImportacao',
  'dataCadastro',
  'ultimaModificacao',
  'user_id',
  'shop_id',
  'main_account_id',
  'tabelasAtacado',
  'selling_partner_id',
  'tenant_id',
  'wa_id',
  'waba_id',
  'phoneNumberId',
  'numero',
  'verificado',
  'mensagem_automatica',
  'mensagem_inatividade',
  'horario_funcionamento',
];

const BALCAO_EXCLUDED_ANTES = [
  'tipo',
  'cpf_cnpj',
  'idCadIntTran',
  'modalidadeFreteImportacao',
  'dataCadastro',
  'ultimaModificacao',
  'user_id',
  'modoEnvioMercadoLivre',
  'shop_id',
  'main_account_id',
  'tabelasAtacado',
  'selling_partner_id',
  'tenant_id',
  'wa_id',
  'waba_id',
  'phoneNumberId',
  'numero',
  'verificado',
  'mensagem_automatica',
  'mensagem_inatividade',
  'horario_funcionamento',
];

const WHATSAPP_EXCLUDED_ANTES = [
  'tipo',
  'cpf_cnpj',
  'idCadIntTran',
  'modalidadeFreteImportacao',
  'dataCadastro',
  'ultimaModificacao',
  'verificado',
  'user_id',
  'modoEnvioMercadoLivre',
  'shop_id',
  'main_account_id',
  'tabelasAtacado',
  'selling_partner_id',
  'tenant_id',
];

/** Order carries no meaning in an exclusion list — set equality is the claim. */
function expectMesmoConjunto(atual: readonly string[], esperado: readonly string[]): void {
  expect(new Set(atual).size).toBe(atual.length); // no duplicates
  expect(atual).toEqual(expect.arrayContaining([...esperado]));
  expect(new Set(atual).size).toBe(new Set(esperado).size);
}

describe('integracaoFieldOverrides — totality over integracaoSchema', () => {
  /**
   * ⚠️ The guard that makes the shared module safe. A per-channel field added
   * to `integracaoSchema` and to NO list here is rendered by every channel's
   * `ObjectView` as a raw number/text input — four forms silently gain a field
   * nobody designed. Nothing else in the repo notices: the schemas registry
   * test only checks the domain is registered, and every channel screen is
   * green with the field showing.
   */
  it('classifies every key of integracaoSchema.shape as system, per-channel or generic', () => {
    const porCanal = Object.values(CAMPOS_POR_CANAL).flat();
    const classificados = new Set<string>([
      ...integracaoCamposDeSistema,
      ...porCanal,
      ...CAMPOS_GENERICOS,
    ]);
    const naoClassificados = Object.keys(integracaoSchema.shape).filter(
      (key) => !classificados.has(key),
    );
    expect(naoClassificados).toEqual([]);
  });

  it('classifies each key exactly once — the three groups do not overlap', () => {
    const todos = [...integracaoCamposDeSistema, ...Object.values(CAMPOS_POR_CANAL).flat()].concat(
      CAMPOS_GENERICOS,
    );
    expect(new Set(todos).size).toBe(todos.length);
  });

  it('names no field integracaoSchema does not declare', () => {
    const doSchema = new Set(Object.keys(integracaoSchema.shape));
    const declarados = [
      ...integracaoCamposDeSistema,
      ...Object.values(CAMPOS_POR_CANAL).flat(),
      ...CAMPOS_GENERICOS,
    ];
    expect(declarados.filter((key) => !doSchema.has(key))).toEqual([]);
  });

  it('renders exactly the generic block — no more, no less', () => {
    expect(Object.keys(integracaoFieldsCompartilhados()).sort()).toEqual(
      [...CAMPOS_GENERICOS].sort(),
    );
  });
});

describe('integracaoExcludedFields — set-equal to the pre-extraction arrays', () => {
  it('reproduces mercadoLivreExcludedFields', () => {
    expectMesmoConjunto(integracaoExcludedFields('mercadoLivre', ['user_id']), ML_EXCLUDED_ANTES);
  });

  it('reproduces balcaoExcludedFields', () => {
    expectMesmoConjunto(integracaoExcludedFields(null), BALCAO_EXCLUDED_ANTES);
  });

  it('reproduces whatsappExcludedFields', () => {
    expectMesmoConjunto(
      integracaoExcludedFields('whatsapp', ['verificado']),
      WHATSAPP_EXCLUDED_ANTES,
    );
  });

  /**
   * The near-miss of the fold above: the owner's OWN fields must survive, or
   * every channel screen would hide the very field it exists to edit.
   */
  it('keeps the owner channel’s own fields visible unless `extra` hides them', () => {
    const ml = integracaoExcludedFields('mercadoLivre');
    expect(ml).not.toContain('user_id');
    expect(ml).not.toContain('modoEnvioMercadoLivre');
    const shopee = integracaoExcludedFields('shopee');
    expect(shopee).not.toContain('shop_id');
    expect(shopee).not.toContain('main_account_id');
    expect(shopee).toContain('user_id');
  });

  it('de-duplicates an `extra` the owner rule already covers', () => {
    const comRedundancia = integracaoExcludedFields('whatsapp', [
      'verificado',
      'modoEnvioMercadoLivre',
    ]);
    expectMesmoConjunto(comRedundancia, WHATSAPP_EXCLUDED_ANTES);
  });

  it('excludes every channel’s fields when no channel owns the form', () => {
    const balcao = integracaoExcludedFields(null);
    for (const campo of Object.values(CAMPOS_POR_CANAL).flat()) {
      expect(balcao).toContain(campo);
    }
  });
});

describe('integracaoFieldsCompartilhados', () => {
  const COM_RENDER_INPUT = [
    'filialIntegracaoPedidoOuterRef',
    'tabelaNormalOuterRef',
    'tabelaPromocionalOuterRef',
    'operacaoOuterRef',
    'operacaoDevolucaoOuterRef',
    'depositoOuterRef',
    'cor',
  ];

  it('keeps a renderInput on all six outer refs and on cor, for every channel', () => {
    for (const opts of [{}, { canal: 'Mercado Livre' }, { section: 'Geral' }]) {
      const campos = integracaoFieldsCompartilhados(opts);
      for (const key of COM_RENDER_INPUT) {
        expect(typeof campos[key]?.renderInput).toBe('function');
      }
    }
  });

  it('carries the Mercado Livre labels and hints the screen ships today', () => {
    const campos = integracaoFieldsCompartilhados({ canal: 'Mercado Livre' });
    expect(campos.filialIntegracaoPedidoOuterRef).toMatchObject({
      label: 'Filial',
      hint: 'Filial dos pedidos importados do Mercado Livre.',
    });
    expect(campos.depositoOuterRef).toMatchObject({
      label: 'Depósito',
      hint: 'Depósito de onde o estoque é enviado ao Mercado Livre.',
    });
    expect(campos.cor?.hint).toBe(
      'Cor de destaque do canal — usada nos badges de "Canais de venda" em /produtos.',
    );
    expect(campos.nome?.label).toBe('Nome');
    expect(campos.ativo?.label).toBe('Ativo');
    expect(campos.padrao?.label).toBe('Padrão');
    expect(campos.tabelaNormalOuterRef?.label).toBe('Tabela de preços');
    expect(campos.tabelaPromocionalOuterRef?.label).toBe('Tabela promocional');
    expect(campos.operacaoOuterRef?.label).toBe('Operação fiscal');
    expect(campos.operacaoDevolucaoOuterRef?.label).toBe('Operação de devolução');
  });

  it('contracts the article for a feminine channel name', () => {
    const campos = integracaoFieldsCompartilhados({ canal: 'Shopee', generoCanal: 'f' });
    expect(campos.filialIntegracaoPedidoOuterRef?.hint).toBe(
      'Filial dos pedidos importados da Shopee.',
    );
    expect(campos.depositoOuterRef?.hint).toBe('Depósito de onde o estoque é enviado à Shopee.');
  });

  /**
   * Balcão and WhatsApp ship these three fields with NO hint. A shared block
   * that hinted unconditionally would be an operator-visible change in a PR
   * whose acceptance criterion is that nothing changed.
   */
  it('omits every channel-naming hint when no channel is named', () => {
    for (const opts of [{}, { section: 'Geral' }]) {
      const campos = integracaoFieldsCompartilhados(opts);
      expect(campos.filialIntegracaoPedidoOuterRef?.hint).toBeUndefined();
      expect(campos.depositoOuterRef?.hint).toBeUndefined();
      expect(campos.cor?.hint).toBeUndefined();
    }
  });

  it('stamps the section on every shared field, and none without one', () => {
    const comSecao = integracaoFieldsCompartilhados({ section: 'Geral' });
    for (const cfg of Object.values(comSecao)) expect(cfg.section).toBe('Geral');
    const semSecao = integracaoFieldsCompartilhados();
    for (const cfg of Object.values(semSecao)) expect(cfg.section).toBeUndefined();
  });
});
