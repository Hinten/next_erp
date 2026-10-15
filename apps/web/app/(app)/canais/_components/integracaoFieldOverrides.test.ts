import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { FieldRenderProps } from '@delfrance/ui';
import { whatsappFields } from '../whatsapp/_components/whatsappFieldOverrides';
import { integracaoSchema } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { CnpjInput } from '@/components/inputs/CnpjInput';

import {
  CAMPOS_INTERMEDIADOR,
  CAMPOS_POR_CANAL,
  type CanalComCampos,
  MAX_ID_CAD_INT_TRAN,
  MIN_ID_CAD_INT_TRAN,
  PADRAO_TSTRING,
  aparaIdCadIntTran,
  integracaoCamposDeSistema,
  integracaoExcludedFields,
  integracaoFieldsCompartilhados,
  integracaoFieldsIntermediador,
  validarIntermediador,
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
  'portfolioId',
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
  'portfolioId',
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

/**
 * The intermediador pair, as a literal for the same reason as
 * `CAMPOS_GENERICOS`: derived from `CAMPOS_INTERMEDIADOR` the assertions below
 * would agree with whatever that constant says.
 */
const INTERMEDIADOR = ['cpf_cnpj', 'idCadIntTran'];

const DONOS: ReadonlyArray<CanalComCampos | null> = [
  null,
  ...(Object.keys(CAMPOS_POR_CANAL) as CanalComCampos[]),
];

describe('integracaoExcludedFields — totality with the `intermediador` opt-in', () => {
  /**
   * What each form can SHOW, computed from the schema shape: the generic block,
   * the owner's own fields and — only when opted in — the intermediador pair.
   * A field leaking onto a form (or an opt-in that surfaces more than the two
   * fields) is a key in one set and not the other.
   */
  it.each(DONOS.flatMap((dono) => [false, true].map((intermediador) => ({ dono, intermediador }))))(
    'dono $dono, intermediador $intermediador → shows exactly generic + own + the opted-in pair',
    ({ dono, intermediador }) => {
      const excluidos = integracaoExcludedFields(dono, [], { intermediador });
      const visiveis = Object.keys(integracaoSchema.shape).filter((k) => !excluidos.includes(k));
      const esperado = [
        ...CAMPOS_GENERICOS,
        ...(dono === null ? [] : CAMPOS_POR_CANAL[dono]),
        ...(intermediador ? INTERMEDIADOR : []),
      ];
      expect(visiveis.sort()).toEqual([...esperado].sort());
    },
  );

  it('names exactly the two NF-e intermediador fields, both system fields by default', () => {
    expect([...CAMPOS_INTERMEDIADOR].sort()).toEqual([...INTERMEDIADOR].sort());
    for (const campo of INTERMEDIADOR) expect(integracaoCamposDeSistema).toContain(campo);
  });

  /**
   * The near-miss of the opt-in: it surfaces the pair and NOTHING else. In
   * particular `modalidadeFreteImportacao` — the other marketplace-only system
   * field, which belongs to the freight milestone — stays hidden.
   */
  it('keeps every other system field excluded, modalidadeFreteImportacao included', () => {
    for (const dono of DONOS) {
      const excluidos = integracaoExcludedFields(dono, [], { intermediador: true });
      for (const campo of integracaoCamposDeSistema) {
        if (INTERMEDIADOR.includes(campo)) expect(excluidos).not.toContain(campo);
        else expect(excluidos).toContain(campo);
      }
      expect(excluidos).toContain('modalidadeFreteImportacao');
    }
  });

  it('changes nothing for a form that does not opt in', () => {
    for (const dono of DONOS) {
      expectMesmoConjunto(
        integracaoExcludedFields(dono, [], { intermediador: false }),
        integracaoExcludedFields(dono),
      );
      for (const campo of INTERMEDIADOR) expect(integracaoExcludedFields(dono)).toContain(campo);
    }
  });

  it('lets `extra` hide an intermediador field even after the opt-in', () => {
    const excluidos = integracaoExcludedFields('amazon', ['idCadIntTran'], { intermediador: true });
    expect(excluidos).toContain('idCadIntTran');
    expect(excluidos).not.toContain('cpf_cnpj');
  });
});

describe('integracaoFieldsIntermediador', () => {
  const ROTULO = 'Identificador no intermediador';

  function props(patch: Partial<FieldRenderProps> = {}): FieldRenderProps {
    return {
      name: 'idCadIntTran',
      label: ROTULO,
      value: null,
      onChange: vi.fn(),
      onBlur: vi.fn(),
      descriptor: {} as FieldRenderProps['descriptor'],
      ...patch,
    };
  }

  function renderIdCadIntTran(patch: Partial<FieldRenderProps> = {}): HTMLInputElement {
    const { idCadIntTran } = integracaoFieldsIntermediador();
    render(idCadIntTran?.renderInput?.(props(patch)), { wrapper: MantineTestProvider });
    const input = screen.getByLabelText(ROTULO);
    if (!(input instanceof HTMLInputElement)) throw new Error('not an <input>');
    return input;
  }

  it('configures exactly the intermediador pair', () => {
    expect(Object.keys(integracaoFieldsIntermediador()).sort()).toEqual([...INTERMEDIADOR].sort());
  });

  it('renders cpf_cnpj through the shared CnpjInput, labelled as the intermediador', () => {
    const { cpf_cnpj } = integracaoFieldsIntermediador();
    expect(cpf_cnpj?.label).toBe('CNPJ do intermediador');
    expect(cpf_cnpj?.renderInput).toBe(CnpjInput);
  });

  it('labels idCadIntTran and caps its input at the schema max, 60', () => {
    expect(integracaoFieldsIntermediador().idCadIntTran?.label).toBe(ROTULO);
    expect(MAX_ID_CAD_INT_TRAN).toBe(60);
    expect(renderIdCadIntTran().maxLength).toBe(60);
  });

  /**
   * The cap and the schema must agree on BOTH sides: a cap below the schema's
   * max refuses a value the NF-e accepts, a cap above it lets the operator type
   * a value the save then refuses.
   */
  it('agrees with integracaoSchema.idCadIntTran — 60 characters parse, 61 do not', () => {
    const campo = integracaoSchema.shape.idCadIntTran;
    expect(campo.safeParse('x'.repeat(MAX_ID_CAD_INT_TRAN)).success).toBe(true);
    expect(campo.safeParse('x'.repeat(MAX_ID_CAD_INT_TRAN + 1)).success).toBe(false);
  });

  it('shows the stored value and hands typed text through untouched', () => {
    const onChange = vi.fn();
    const input = renderIdCadIntTran({ value: 'loja-123', onChange });
    expect(input.value).toBe('loja-123');
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: ' Loja-123 ' } });
    // No trim on a keystroke (it would eat a space being typed between two
    // words) and no case fold ever: the identifier is the intermediador's.
    // The edges are trimmed on save — next test.
    expect(onChange).toHaveBeenCalledWith(' Loja-123 ');
  });

  /**
   * The NF-e XSD's `TString`: no leading or trailing whitespace, at least one
   * non-space character. The serializer copies the value verbatim, so what
   * `prepareForSave` stores is what reaches `<idCadIntTran>`.
   */
  const T_STRING = /^(?:[!-\u00ff][ -\u00ff]*[!-\u00ff]|[!-\u00ff])$/;

  it('trims idCadIntTran on save, so the stored value is a valid XSD TString', () => {
    expect(integracaoFieldsIntermediador().idCadIntTran?.prepareForSave).toBe(aparaIdCadIntTran);
    expect(T_STRING.test(' Loja-123 ')).toBe(false);
    expect(aparaIdCadIntTran(' Loja-123 ')).toBe('Loja-123');
    expect(aparaIdCadIntTran('\tLoja-123\n')).toBe('Loja-123');
    expect(T_STRING.test(aparaIdCadIntTran(' Loja-123 ') as string)).toBe(true);
  });

  /**
   * The near-misses of that trim: it stops at the edges. A space inside the
   * identifier, and its case, are the intermediador's and must survive.
   */
  it('keeps inner spaces and case, and saves a blank identifier as null', () => {
    expect(aparaIdCadIntTran('Loja 123')).toBe('Loja 123');
    expect(aparaIdCadIntTran(' Loja  ABC ')).toBe('Loja  ABC');
    expect(aparaIdCadIntTran('loja-abc')).toBe('loja-abc');
    expect(aparaIdCadIntTran('')).toBeNull();
    expect(aparaIdCadIntTran('   ')).toBeNull();
    expect(aparaIdCadIntTran(null)).toBeNull();
  });

  it('renders an empty input for a null value, and honours `disabled`', () => {
    const input = renderIdCadIntTran({ value: null, disabled: true });
    expect(input.value).toBe('');
    expect(input.disabled).toBe(true);
  });
});

describe('validarIntermediador', () => {
  const paths = (values: Record<string, unknown>) =>
    validarIntermediador(values).map((i) => i.path);

  /**
   * Why the form needs its own rule: the schema's `\d*` branch takes ANY run
   * of digits, and `CnpjInput` sets no minimum length. Were this ever to flip,
   * the validator below would be belt-and-braces rather than the only guard.
   */
  it('guards what integracaoSchema.cpf_cnpj alone lets through', () => {
    const campo = integracaoSchema.shape.cpf_cnpj;
    expect(campo.safeParse('1234567890123').success).toBe(true);
    expect(campo.safeParse('12345678000100').success).toBe(true);
    expect(paths({ cpf_cnpj: '1234567890123' })).toEqual(['cpf_cnpj']);
    expect(paths({ cpf_cnpj: '12345678000100' })).toEqual(['cpf_cnpj']);
  });

  it('accepts a valid CNPJ, numeric or alphanumeric, and an unfilled one', () => {
    for (const cpf_cnpj of ['11222333000181', '12ABC34501DE35', null, '', undefined]) {
      expect(paths({ cpf_cnpj }), String(cpf_cnpj)).toEqual([]);
    }
  });

  /**
   * The near-misses: each is one step from a CNPJ the XSD's `TCnpj` takes —
   * one character short (numeric and alphanumeric), an 11-digit CPF, a wrong
   * check digit on each form, and the all-same-digit degenerate.
   */
  it.each([
    ['13 digits', '1234567890123'],
    ['13 alphanumeric characters', '12ABC34501DE3'],
    ['an 11-digit CPF', '12345678909'],
    ['a wrong numeric check digit', '11222333000182'],
    ['a wrong alphanumeric check digit', '12ABC34501DE36'],
    ['all one digit', '11111111111111'],
  ])('refuses %s as the intermediador CNPJ', (_caso, cpf_cnpj) => {
    const issues = validarIntermediador({ cpf_cnpj });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: 'cpf_cnpj', message: expect.stringContaining('CNPJ') });
  });

  it('holds idCadIntTran to the XSD minimum of 2 characters, counted trimmed', () => {
    expect(MIN_ID_CAD_INT_TRAN).toBe(2);
    expect(paths({ idCadIntTran: 'x' })).toEqual(['idCadIntTran']);
    expect(paths({ idCadIntTran: ' x ' })).toEqual(['idCadIntTran']);
    expect(paths({ idCadIntTran: 'xy' })).toEqual([]);
    expect(paths({ idCadIntTran: 'x'.repeat(MAX_ID_CAD_INT_TRAN) })).toEqual([]);
    expect(paths({ idCadIntTran: null })).toEqual([]);
    expect(paths({ idCadIntTran: '' })).toEqual([]);
  });

  it('holds idCadIntTran to the XSD TString character range', () => {
    // Refused: above U+00FF (en dash, curly quote, emoji) and control characters.
    expect(paths({ idCadIntTran: 'seller–123' })).toEqual(['idCadIntTran']);
    expect(paths({ idCadIntTran: 'loja “A”' })).toEqual(['idCadIntTran']);
    expect(paths({ idCadIntTran: 'ab😀' })).toEqual(['idCadIntTran']);
    expect(paths({ idCadIntTran: 'a\u0007b' })).toEqual(['idCadIntTran']);
    expect(paths({ idCadIntTran: 'a\tb' })).toEqual(['idCadIntTran']);
    // Accepted: Latin-1 letters and inner spaces.
    expect(paths({ idCadIntTran: 'Loja São José' })).toEqual([]);
    // ⚠️ The near-miss pair at the top of the range: ÿ (U+00FF) passes,
    // Ā (U+0100) does not — the boundary is the XSD's, not "ASCII".
    expect(paths({ idCadIntTran: 'abÿ' })).toEqual([]);
    expect(paths({ idCadIntTran: 'abĀ' })).toEqual(['idCadIntTran']);
    expect(PADRAO_TSTRING.test('ab')).toBe(true);
  });

  it('reports both fields at once, each at its own path', () => {
    expect(paths({ cpf_cnpj: '1234567890123', idCadIntTran: 'x' }).sort()).toEqual([
      'cpf_cnpj',
      'idCadIntTran',
    ]);
  });

  it('ignores every other field', () => {
    expect(paths({ nome: '', ativo: 'nao', selling_partner_id: 'x' })).toEqual([]);
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

describe('WhatsApp business portfolio field', () => {
  it('offers the BSUID scope in the Cloud API connection tab only for WhatsApp', () => {
    expect(whatsappFields.portfolioId).toMatchObject({
      label: 'ID do portfólio empresarial Meta',
      section: 'Conexão (Cloud API)',
      hint: expect.stringContaining('BSUID'),
    });
    expect(integracaoExcludedFields('whatsapp')).not.toContain('portfolioId');
    for (const owner of [null, 'mercadoLivre', 'shopee', 'amazon', 'magalu'] as const) {
      expect(integracaoExcludedFields(owner)).toContain('portfolioId');
    }
  });
});
