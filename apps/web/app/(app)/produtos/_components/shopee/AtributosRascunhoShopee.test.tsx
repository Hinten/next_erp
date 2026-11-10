import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  CAMPO_RASCUNHO_SHOPEE,
  INPUT_VALIDATION_TYPE_ATRIBUTO_SHOPEE,
  TIPO_PROBLEMA_ATRIBUTO_SHOPEE,
  type ArvoreAtributosShopee,
  type AtributoDto,
  type AtributoInfoDto,
  type AtributoShopeeRequisicao,
  type AtributoValorDto,
  type EstadoPublicacaoRascunhoShopee,
} from '@delfrance/schemas';

import { saidaPeloSellerCentreDoRascunhoShopee } from '@/lib/shopee/anuncioProduto';
import {
  MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE,
  MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE,
  aplicarEdicaoDoAtributoShopee,
  linhasDoEditorDeAtributosShopee,
  type DigitacoesAtributosShopee,
  type EdicaoDoAtributoShopee,
  type MotivoNaoSuportadoAtributoShopee,
  type ResultadoDaEdicaoDoAtributoShopee,
} from '@/lib/shopee/atributosRascunho';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { RespostaAtributosShopee } from '@/lib/shopee/wire';

import {
  AtributosRascunhoShopee,
  FRASE_ARVORE_DE_ATRIBUTOS_TRUNCADA_SHOPEE,
  FRASE_ATRIBUTOS_CARREGANDO_SHOPEE,
  FRASE_ATRIBUTOS_CATEGORIA_NAO_FOLHA_SHOPEE,
  FRASE_ATRIBUTOS_CATEGORIA_VAZIA_SHOPEE,
  FRASE_ATRIBUTOS_ILEGIVEIS_SHOPEE,
  FRASE_ATRIBUTOS_SEM_CATEGORIA_SHOPEE,
  ROTULO_OUTRO_VALOR_OPCAO_SHOPEE,
  TIPO_LEITURA_ATRIBUTOS_RASCUNHO_SHOPEE,
  ensaioDaAdicaoAtributoShopee,
  fraseDaDigitacaoDoAtributoShopee,
  fraseDoProblemaDoAtributoShopee,
  leituraDaRespostaDeAtributosShopee,
  type LeituraDosAtributosRascunhoShopee,
} from './AtributosRascunhoShopee';
import { idDoCampoRascunhoShopee } from './DesfechoAcaoShopee';
import { ROTULO_LER_DE_NOVO_RASCUNHO_SHOPEE } from './RascunhoShopee';

/**
 * The draft's «Atributos» section (#1911 P13) over the REAL model
 * (`linhasDoEditorDeAtributosShopee` builds the rows, `aplicarEdicaoDoAtributoShopee`
 * applies each edit the section sends — the walk, the decoder and the validator
 * are the schemas' own). Nothing is doubled but the editor's state, which a
 * harness holds the way `ShopeeEditor` does.
 *
 * Every tree is hand-written in the shape of the public `get_attribute_tree.br-*`
 * captures as `apps/shopee` projects them: public taxonomy where a BR id is
 * named, invented (`9xxxxx`) everywhere else; every typed or stored value is
 * invented. Each rule has a pair and a near miss (#1372).
 */

/* -------------------------------------------------------------------------- */
/*                                  Fixtures                                   */
/* -------------------------------------------------------------------------- */

const LINK = 'rasc00000000000000001';

const info = (p: Partial<AtributoInfoDto>): AtributoInfoDto => ({
  inputType: null,
  inputValidationType: 0,
  formatType: 1,
  dateFormatType: null,
  attributeUnitList: null,
  maxValueCount: null,
  introduction: null,
  isOem: false,
  supportSearchValue: false,
  ...p,
});

const valor = (
  valueId: number,
  name: string | null,
  filhos: AtributoDto[] = [],
  valueUnit: string | null = null,
): AtributoValorDto => ({ valueId, name, valueUnit, childAttributeList: filhos });

const atributo = (
  attributeId: number,
  name: string | null,
  i: Partial<AtributoInfoDto> | null,
  valores: AtributoValorDto[] = [],
  mandatory = false,
): AtributoDto => ({
  attributeId,
  mandatory,
  name,
  attributeInfo: i === null ? null : info(i),
  attributeValueList: valores,
});

// The three mandatory children of 100408 = 2530 (br-b-capa), in the tree's order.
const FABRICANTE = atributo(
  101237,
  'Fabricante',
  { inputType: 2, inputValidationType: 2, supportSearchValue: true },
  [],
  true,
);
const HOMOLOGACAO = atributo(
  101197,
  'Nr. de Homologação',
  { inputType: 3, inputValidationType: 2 },
  [],
  true,
);
const NOME_DO_MODELO = atributo(
  101040,
  'Nome do Modelo',
  { inputType: 3, inputValidationType: 2 },
  [],
  true,
);
const COM_FIO = 2498;
const SEM_FIO = 2530;
const ROTULO_COM_FIO = 'Com fio, Sem conexão ou Outros';
const ROTULO_SEM_FIO = 'Sem fio (Bluetooth, Wifi, Radiofrequência)';
const TIPO_DE_CONEXAO = atributo(
  100408,
  'Tipo de Conexão',
  { inputType: 1 },
  [
    valor(COM_FIO, ROTULO_COM_FIO),
    valor(SEM_FIO, ROTULO_SEM_FIO, [FABRICANTE, HOMOLOGACAO, NOME_DO_MODELO]),
  ],
  true,
);

const UNIDADES_101029 = [
  'ML',
  'L',
  'MG',
  'G/GR',
  'KG',
  'CM',
  'M',
  'Dozen',
  'Piece',
  'Pack',
  'Set',
  'Box',
];
const TAMANHO_DO_PACOTE = atributo(101029, 'Tamanho Do Pacote', {
  inputType: 3,
  inputValidationType: 3,
  formatType: 2,
  attributeUnitList: UNIDADES_101029,
});

const PAIS_DE_ORIGEM = atributo(
  100037,
  'País de Origem',
  { inputType: 2, inputValidationType: 2 },
  [valor(35, 'China'), valor(6737, 'Brasil')],
);
const MATERIAL = atributo(
  100134,
  'Material',
  { inputType: 5, inputValidationType: 2, maxValueCount: 5 },
  [valor(1207, 'Plástico'), valor(1218, 'Vidro'), valor(1481, 'Cerâmica')],
);
const CAPACIDADE = atributo(100278, 'Capacidade de Volume', {
  inputType: 5,
  inputValidationType: 3,
  formatType: 2,
  attributeUnitList: ['L', 'ml'],
  maxValueCount: 5,
});
const VOLUME = atributo(
  100248,
  'Volume',
  { inputType: 2, inputValidationType: 3, formatType: 2, attributeUnitList: ['ml', 'L'] },
  [valor(499, '1L', [], 'L'), valor(511, '10ml', [], 'ml')],
);
const SIM = 20996;
const RADIO = atributo(
  106664,
  'Contém bluetooh, Wi-fi e/ou Tecnologia de Radio Frequência?',
  { inputType: 1 },
  [valor(SIM, 'Sim', [NOME_DO_MODELO, FABRICANTE, HOMOLOGACAO]), valor(20997, 'Não')],
);

// Synthetic: no BR attribute has these shapes.
const MULTIPLA_SO_LISTA = atributo(
  900001,
  'Sintético múltiplo',
  { inputType: 4, maxValueCount: 2 },
  [valor(901, 'Opção A'), valor(902, 'Opção B'), valor(903, 'Opção C')],
);
const INTEIRO = atributo(900007, 'Sintético inteiro', { inputType: 3, inputValidationType: 1 });
const DATA = atributo(900002, 'Sintético data', {
  inputType: 3,
  inputValidationType: INPUT_VALIDATION_TYPE_ATRIBUTO_SHOPEE.data,
});
const NAO_SUPORTADOS: Readonly<Record<MotivoNaoSuportadoAtributoShopee, AtributoDto>> = {
  [MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.data]: DATA,
  [MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.busca]: atributo(
    900003,
    'Sintético busca',
    { inputType: 1, supportSearchValue: true },
    [valor(931, 'Um')],
  ),
  [MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.listaSemValores]: atributo(
    900004,
    'Sintético lista vazia',
    {
      inputType: 1,
    },
  ),
  [MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.desconhecido]: atributo(900005, 'Sintético desconhecido', {
    inputType: 9,
  }),
  [MOTIVO_NAO_SUPORTADO_ATRIBUTO_SHOPEE.unidadeSemLista]: atributo(
    900006,
    'Sintético sem unidades',
    { inputType: 3, inputValidationType: 3, formatType: 2, attributeUnitList: null },
  ),
};

const arvore = (...atributos: AtributoDto[]): ArvoreAtributosShopee => ({
  atributos,
  truncated: false,
});

/** A request-shape stored attribute. */
const guardado = (
  attributeId: number,
  ...valores: AtributoShopeeRequisicao['attribute_value_list']
): AtributoShopeeRequisicao => ({ attribute_id: attributeId, attribute_value_list: valores });

const LIVRE: EstadoPublicacaoRascunhoShopee = { tipo: 'livre' };
const INCERTA: EstadoPublicacaoRascunhoShopee = { tipo: 'incerta', desdeMs: 1_800_000_000_000 };
const LIDA: LeituraDosAtributosRascunhoShopee = {
  tipo: TIPO_LEITURA_ATRIBUTOS_RASCUNHO_SHOPEE.lida,
  truncated: false,
  warning: null,
};

/* -------------------------------------------------------------------------- */
/*                                  Harness                                    */
/* -------------------------------------------------------------------------- */

/** What the harness's editor state holds after the last APPLIED edit, and every edit the section sent. */
const h = {
  lista: null as readonly AtributoShopeeRequisicao[] | null,
  digitacoes: {} as DigitacoesAtributosShopee,
  edicoes: [] as [number, EdicaoDoAtributoShopee][],
};

/** Records one edit the section sent and, when the model applied it, the state it left. */
function registrar(
  attributeId: number,
  edicao: EdicaoDoAtributoShopee,
  r: ResultadoDaEdicaoDoAtributoShopee,
): void {
  h.edicoes.push([attributeId, edicao]);
  if (!r.ok) return;
  h.lista = r.lista;
  h.digitacoes = r.digitacoes;
}

interface Cenario {
  arvore: ArvoreAtributosShopee;
  /** The HELD base (`base.attributes`); also the list on load unless {@link lista} says otherwise. */
  guardados?: readonly AtributoShopeeRequisicao[] | null;
  lista?: readonly AtributoShopeeRequisicao[] | null;
  leitura?: LeituraDosAtributosRascunhoShopee;
  publicacao?: EstadoPublicacaoRascunhoShopee;
  editavel?: boolean;
}

/** The editor's role: hold the list and the typings, build the rows, apply each edit through the model. */
function Editor(c: Cenario) {
  const guardados = c.guardados ?? null;
  const [estado, setEstado] = useState({
    lista: c.lista !== undefined ? c.lista : guardados,
    digitacoes: {} as DigitacoesAtributosShopee,
  });
  const args = { arvore: c.arvore, lista: estado.lista, guardados, digitacoes: estado.digitacoes };
  return (
    <AtributosRascunhoShopee
      linkDocId={LINK}
      leitura={c.leitura ?? LIDA}
      {...linhasDoEditorDeAtributosShopee(args)}
      publicacao={c.publicacao ?? LIVRE}
      editavel={c.editavel ?? true}
      onAtributo={(attributeId, edicao) => {
        const r = aplicarEdicaoDoAtributoShopee({ ...args, attributeId, edicao });
        registrar(attributeId, edicao, r);
        if (r.ok) setEstado({ lista: r.lista, digitacoes: r.digitacoes });
      }}
      ensaiarAdicao={ensaioDaAdicaoAtributoShopee(args)}
    />
  );
}

function mostrar(c: Cenario): void {
  h.lista = c.lista !== undefined ? c.lista : (c.guardados ?? null);
  render(
    <MantineTestProvider>
      <Editor {...c} />
    </MantineTestProvider>,
  );
}

/**
 * {@link Editor} with the tab's two outside facts the section must survive:
 * `editavel` going false for a moment (any write of the tab in flight), and
 * «Desfazer alterações» — the entry dropped (the list back to the stored one)
 * and the section REMOUNTED by its key, as `RascunhoShopee` keys it.
 */
function EditorDoForm(c: Cenario) {
  const guardados = c.guardados ?? null;
  const [estado, setEstado] = useState({
    lista: guardados,
    digitacoes: {} as DigitacoesAtributosShopee,
  });
  const [editavel, setEditavel] = useState(true);
  const [revisao, setRevisao] = useState(0);
  const args = { arvore: c.arvore, lista: estado.lista, guardados, digitacoes: estado.digitacoes };
  return (
    <>
      <button type="button" onClick={() => setEditavel((v) => !v)}>
        Alternar edição
      </button>
      <button
        type="button"
        onClick={() => {
          setEstado({ lista: guardados, digitacoes: {} });
          h.lista = guardados;
          setRevisao((r) => r + 1);
        }}
      >
        Desfazer
      </button>
      <AtributosRascunhoShopee
        key={revisao}
        linkDocId={LINK}
        leitura={LIDA}
        {...linhasDoEditorDeAtributosShopee(args)}
        publicacao={LIVRE}
        editavel={editavel}
        onAtributo={(attributeId, edicao) => {
          const r = aplicarEdicaoDoAtributoShopee({ ...args, attributeId, edicao });
          registrar(attributeId, edicao, r);
          if (r.ok) setEstado({ lista: r.lista, digitacoes: r.digitacoes });
        }}
        ensaiarAdicao={ensaioDaAdicaoAtributoShopee(args)}
      />
    </>
  );
}

function mostrarNoForm(c: Cenario): void {
  h.lista = c.guardados ?? null;
  render(
    <MantineTestProvider>
      <EditorDoForm {...c} />
    </MantineTestProvider>,
  );
}

/** A presentational render with no rows: only the read's state. */
function mostrarLeitura(leitura: LeituraDosAtributosRascunhoShopee): void {
  render(
    <MantineTestProvider>
      <AtributosRascunhoShopee
        linkDocId={LINK}
        leitura={leitura}
        linhas={[]}
        semLugar={[]}
        removidosAoSalvar={[]}
        publicacao={LIVRE}
        editavel
        onAtributo={() => {
          throw new Error('nenhuma edição esperada');
        }}
        ensaiarAdicao={() => null}
      />
    </MantineTestProvider>,
  );
}

const raiz = () => screen.getByTestId(`shopee-rascunho-atributos-${LINK}`);
const linha = (attributeId: number) =>
  screen.getByTestId(`shopee-atributo-${LINK}-${String(attributeId)}`);
const linhaAusente = (attributeId: number) =>
  screen.queryByTestId(`shopee-atributo-${LINK}-${String(attributeId)}`);
const combobox = (dentro: HTMLElement, nome: string) =>
  within(dentro).getByRole('combobox', { name: nome });
const caixa = (dentro: HTMLElement, nome: string) =>
  within(dentro).getByRole('textbox', { name: nome }) as HTMLInputElement;

/** Opens a Select / MultiSelect and answers its options' labels, in order. */
function opcoesDe(dentro: HTMLElement, nome: string): string[] {
  fireEvent.click(combobox(dentro, nome));
  return within(dentro)
    .getAllByRole('option')
    .map((o) => o.textContent ?? '');
}

function escolher(dentro: HTMLElement, nome: string, rotulo: string): void {
  fireEvent.click(combobox(dentro, nome));
  fireEvent.click(within(dentro).getByRole('option', { name: rotulo }));
}

function digitar(campo: HTMLInputElement, texto: string): void {
  fireEvent.change(campo, { target: { value: texto } });
}

beforeEach(() => {
  h.lista = null;
  h.digitacoes = {};
  h.edicoes = [];
});

/* -------------------------------------------------------------------------- */
/*                                The read                                     */
/* -------------------------------------------------------------------------- */

describe('AtributosRascunhoShopee — a leitura da árvore', () => {
  const ESTADOS: readonly (readonly [LeituraDosAtributosRascunhoShopee, string, string])[] = [
    [{ tipo: 'sem-conta', gravados: 2 }, 'sem-conta', '2 atributo(s) gravado(s) neste rascunho.'],
    [{ tipo: 'sem-categoria' }, 'sem-categoria', FRASE_ATRIBUTOS_SEM_CATEGORIA_SHOPEE],
    [{ tipo: 'carregando' }, 'carregando', FRASE_ATRIBUTOS_CARREGANDO_SHOPEE],
    [{ tipo: 'nao-folha' }, 'nao-folha', FRASE_ATRIBUTOS_CATEGORIA_NAO_FOLHA_SHOPEE],
    [{ tipo: 'vazia', warning: null }, 'vazia', FRASE_ATRIBUTOS_CATEGORIA_VAZIA_SHOPEE],
  ];

  it.each(ESTADOS)('o estado %o mostra a sua frase, e nenhuma linha', (leitura, sufixo, frase) => {
    mostrarLeitura(leitura);
    expect(screen.getByTestId(`shopee-rascunho-atributos-${LINK}-${sufixo}`).textContent).toBe(
      frase,
    );
    expect(within(raiz()).getByText('Atributos')).toBeTruthy();
    expect(within(raiz()).queryByRole('combobox')).toBeNull();
    expect(within(raiz()).queryByRole('textbox')).toBeNull();
  });

  it('as frases do ATTR §3.9, verbatim', () => {
    expect(FRASE_ATRIBUTOS_SEM_CATEGORIA_SHOPEE).toBe('Escolha a categoria para ver os atributos.');
    expect(FRASE_ATRIBUTOS_CARREGANDO_SHOPEE).toBe('Lendo os atributos da categoria…');
    expect(FRASE_ATRIBUTOS_CATEGORIA_NAO_FOLHA_SHOPEE).toBe(
      'Escolha uma categoria final para ver os atributos.',
    );
    expect(FRASE_ATRIBUTOS_CATEGORIA_VAZIA_SHOPEE).toBe(
      'Esta categoria não tem atributos na Shopee.',
    );
    expect(FRASE_ATRIBUTOS_ILEGIVEIS_SHOPEE).toBe(
      'Não foi possível ler os atributos desta categoria na Shopee.',
    );
  });

  it.each([
    ...ESTADOS.map(([l]) => l),
    { tipo: 'falha', causa: '', relendo: false, onLerDeNovo: () => undefined },
    LIDA,
  ] as LeituraDosAtributosRascunhoShopee[])(
    'em %o o wrapper leva o id que «Corrigir no rascunho: Atributos» foca',
    (leitura) => {
      mostrarLeitura(leitura);
      const alvo = document.getElementById(
        idDoCampoRascunhoShopee(LINK, CAMPO_RASCUNHO_SHOPEE.attributes),
      );
      expect(alvo).not.toBeNull();
      expect(alvo).toBe(raiz());
    },
  );

  it('NEAR-MISS: o id é o do campo `attributes`, nunca o da categoria ou da marca', () => {
    mostrarLeitura(LIDA);
    expect(raiz().id).toBe(`shopee-rascunho-${LINK}-campo-attributes`);
    expect(
      document.getElementById(idDoCampoRascunhoShopee(LINK, CAMPO_RASCUNHO_SHOPEE.categoryId)),
    ).toBeNull();
  });

  it('falha: a frase, a causa, e «Ler de novo» pede a releitura', () => {
    const onLerDeNovo = vi.fn();
    mostrarLeitura({
      tipo: 'falha',
      causa: 'A Shopee não respondeu a tempo.',
      relendo: false,
      onLerDeNovo,
    });
    const falha = screen.getByTestId(`shopee-rascunho-atributos-${LINK}-falha`);
    expect(falha.textContent).toContain(
      `${FRASE_ATRIBUTOS_ILEGIVEIS_SHOPEE} A Shopee não respondeu a tempo.`,
    );
    fireEvent.click(
      within(falha).getByRole('button', { name: ROTULO_LER_DE_NOVO_RASCUNHO_SHOPEE }),
    );
    expect(onLerDeNovo).toHaveBeenCalledTimes(1);
  });

  it.each(['', '   ', 'rode pnpm --anuncio para ver'])(
    'NEAR-MISS: a causa %j (em branco, ou de terminal) não é impressa',
    (causa) => {
      mostrarLeitura({ tipo: 'falha', causa, relendo: false, onLerDeNovo: () => undefined });
      const texto = screen.getByTestId(`shopee-rascunho-atributos-${LINK}-falha`).textContent;
      expect(texto).toBe(
        `${FRASE_ATRIBUTOS_ILEGIVEIS_SHOPEE}${ROTULO_LER_DE_NOVO_RASCUNHO_SHOPEE}`,
      );
    },
  );

  it('falha relendo: o botão gira', () => {
    mostrarLeitura({ tipo: 'falha', causa: '', relendo: true, onLerDeNovo: () => undefined });
    const botao = within(screen.getByTestId(`shopee-rascunho-atributos-${LINK}-falha`)).getByRole(
      'button',
    );
    expect(botao.getAttribute('data-loading')).toBe('true');
  });

  it('árvore truncada: a frase SEM o número da profundidade (correção 7)', () => {
    mostrarLeitura({ tipo: 'lida', truncated: true, warning: null });
    const nota = screen.getByTestId(`shopee-rascunho-atributos-${LINK}-truncada`).textContent;
    expect(nota).toBe(
      'A árvore de atributos desta categoria é mais profunda do que o ERP mostra; os níveis ' +
        'mais profundos ficam de fora.',
    );
    expect(nota).toBe(FRASE_ARVORE_DE_ATRIBUTOS_TRUNCADA_SHOPEE);
    expect(nota).not.toMatch(/\d/);
  });

  it('NEAR-MISS: árvore completa, nenhuma nota de truncamento', () => {
    mostrarLeitura(LIDA);
    expect(screen.queryByTestId(`shopee-rascunho-atributos-${LINK}-truncada`)).toBeNull();
  });

  it.each([
    { tipo: 'lida', truncated: false, warning: 'Categoria em revisão.' },
    { tipo: 'vazia', warning: 'Categoria em revisão.' },
  ] as LeituraDosAtributosRascunhoShopee[])('o aviso da Shopee aparece (%o)', (leitura) => {
    mostrarLeitura(leitura);
    expect(screen.getByTestId(`shopee-rascunho-atributos-${LINK}-aviso`).textContent).toBe(
      'Aviso da Shopee sobre esta categoria: Categoria em revisão.',
    );
  });

  it.each([null, '', '   '])('NEAR-MISS: aviso %j não mostra nada', (warning) => {
    mostrarLeitura({ tipo: 'lida', truncated: false, warning });
    expect(screen.queryByTestId(`shopee-rascunho-atributos-${LINK}-aviso`)).toBeNull();
  });
});

describe('leituraDaRespostaDeAtributosShopee', () => {
  const resposta = (p: Partial<RespostaAtributosShopee>): RespostaAtributosShopee => ({
    leaf: true,
    categoryId: 100087,
    warning: null,
    truncated: false,
    atributos: [TIPO_DE_CONEXAO],
    ...p,
  });

  it('uma folha com atributos é a árvore lida, com `truncated` e o aviso', () => {
    expect(leituraDaRespostaDeAtributosShopee(resposta({ truncated: true, warning: 'x' }))).toEqual(
      {
        tipo: 'lida',
        truncated: true,
        warning: 'x',
      },
    );
  });

  it('NEAR-MISS: uma folha SEM atributos é `vazia` (com o aviso), nunca `lida`', () => {
    expect(leituraDaRespostaDeAtributosShopee(resposta({ atributos: [], warning: 'x' }))).toEqual({
      tipo: 'vazia',
      warning: 'x',
    });
  });

  it('NEAR-MISS: `leaf: false` é `nao-folha`, nunca vazia', () => {
    expect(leituraDaRespostaDeAtributosShopee(resposta({ leaf: false, atributos: [] }))).toEqual({
      tipo: 'nao-folha',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                               The controls                                  */
/* -------------------------------------------------------------------------- */

describe('AtributosRascunhoShopee — lista única e filhos', () => {
  it('lista única: as opções da árvore, na ordem dela, sem «Outro valor…»', () => {
    mostrar({ arvore: arvore(TIPO_DE_CONEXAO) });
    expect(opcoesDe(linha(100408), 'Tipo de Conexão')).toEqual([ROTULO_COM_FIO, ROTULO_SEM_FIO]);
  });

  it('escolher «Sem fio» manda o id e mostra os três filhos obrigatórios, recuados, com «Exigido quando…»', () => {
    mostrar({ arvore: arvore(TIPO_DE_CONEXAO) });
    expect(linha(100408).getAttribute('data-profundidade')).toBe('0');
    expect(linha(100408).style.paddingLeft).toBe('calc(var(--mantine-spacing-lg) * 0)');
    expect(linhaAusente(101237)).toBeNull();
    escolher(linha(100408), 'Tipo de Conexão', ROTULO_SEM_FIO);
    expect(h.edicoes).toEqual([[100408, { tipo: 'lista', valueIds: [SEM_FIO] }]]);
    for (const filho of [101237, 101197, 101040]) {
      expect(linha(filho).getAttribute('data-profundidade')).toBe('1');
      // Indented by its depth — never flush with its parent.
      expect(linha(filho).style.paddingLeft).toBe('calc(var(--mantine-spacing-lg) * 1)');
      expect(linha(filho).style.paddingLeft).not.toBe(linha(100408).style.paddingLeft);
      expect(linha(filho).textContent).toContain(
        `Exigido quando Tipo de Conexão é «${ROTULO_SEM_FIO}».`,
      );
    }
  });

  it('NEAR-MISS: escolher «Com fio» não mostra filho nenhum', () => {
    mostrar({ arvore: arvore(TIPO_DE_CONEXAO) });
    escolher(linha(100408), 'Tipo de Conexão', ROTULO_COM_FIO);
    expect(h.edicoes).toEqual([[100408, { tipo: 'lista', valueIds: [COM_FIO] }]]);
    for (const filho of [101237, 101197, 101040]) expect(linhaAusente(filho)).toBeNull();
  });

  it('trocar 2530 → 2498 tira os filhos e lista o valor gravado deles em «Serão removidos ao salvar»', () => {
    mostrar({
      arvore: arvore(TIPO_DE_CONEXAO),
      guardados: [
        guardado(100408, { value_id: SEM_FIO }),
        guardado(101197, { value_id: 0, original_value_name: 'HOM-0001' }),
      ],
    });
    expect(screen.queryByTestId(`shopee-rascunho-atributos-${LINK}-removidos`)).toBeNull();
    escolher(linha(100408), 'Tipo de Conexão', ROTULO_COM_FIO);
    expect(linhaAusente(101197)).toBeNull();
    const removidos = screen.getByTestId(`shopee-rascunho-atributos-${LINK}-removidos`);
    expect(removidos.textContent).toContain('Serão removidos ao salvar');
    expect(removidos.textContent).toContain('Nr. de Homologação: HOM-0001');
    expect(removidos.textContent).toContain('Para mantê-los, use «Desfazer alterações».');
    expect(
      within(removidos).getByText('Nr. de Homologação: HOM-0001').getAttribute('style'),
    ).toContain('line-through');
  });

  it('um pai OPCIONAL (106664 = «Sim») mostra os três filhos obrigatórios', () => {
    mostrar({ arvore: arvore(RADIO), guardados: [guardado(106664, { value_id: SIM })] });
    expect(linha(101040).textContent).toContain(
      'Exigido quando Contém bluetooh, Wi-fi e/ou Tecnologia de Radio Frequência? é «Sim».',
    );
    expect(linhaAusente(101237)).not.toBeNull();
    expect(linhaAusente(101197)).not.toBeNull();
  });

  it('NEAR-MISS: 106664 sem valor não mostra filho', () => {
    mostrar({ arvore: arvore(RADIO) });
    for (const filho of [101237, 101197, 101040]) expect(linhaAusente(filho)).toBeNull();
  });

  it('um filho OPCIONAL diz «Aparece quando…», nunca «Exigido quando…»', () => {
    const opcional = atributo(901101, 'Sintético filho opcional', { inputType: 3 });
    const pai = atributo(901100, 'Sintético pai', { inputType: 1 }, [
      valor(911, 'Liga', [opcional]),
    ]);
    mostrar({ arvore: arvore(pai), guardados: [guardado(901100, { value_id: 911 })] });
    expect(linha(901101).textContent).toContain('Aparece quando Sintético pai é «Liga».');
    expect(linha(901101).textContent).not.toContain('Exigido quando');
  });

  it('o rótulo de um valor guardado é o da ÁRVORE, nunca o nome gravado (`Wireless`)', () => {
    mostrar({
      arvore: arvore(TIPO_DE_CONEXAO),
      guardados: [guardado(100408, { value_id: SEM_FIO, original_value_name: 'Wireless' })],
    });
    expect((combobox(linha(100408), 'Tipo de Conexão') as HTMLInputElement).value).toBe(
      ROTULO_SEM_FIO,
    );
    expect(raiz().textContent).not.toContain('Wireless');
  });

  it('desmarcar o valor escolhido manda uma escolha vazia', () => {
    mostrar({
      arvore: arvore(TIPO_DE_CONEXAO),
      guardados: [guardado(100408, { value_id: COM_FIO })],
    });
    escolher(linha(100408), 'Tipo de Conexão', ROTULO_COM_FIO);
    expect(h.edicoes).toEqual([[100408, { tipo: 'lista', valueIds: [] }]]);
    expect(h.lista).toBeNull();
  });

  it('um obrigatório sem valor não traz frase na linha (é a pendência que diz) — só o asterisco', () => {
    mostrar({ arvore: arvore(TIPO_DE_CONEXAO) });
    expect(screen.queryByTestId(`shopee-atributo-${LINK}-100408-problemas`)).toBeNull();
    expect(linha(100408).textContent).toContain('*');
  });
});

describe('AtributosRascunhoShopee — lista ou texto («Outro valor…»)', () => {
  it('as opções terminam em «Outro valor…»; escolher da lista manda o id', () => {
    mostrar({ arvore: arvore(PAIS_DE_ORIGEM) });
    expect(opcoesDe(linha(100037), 'País de Origem')).toEqual([
      'China',
      'Brasil',
      ROTULO_OUTRO_VALOR_OPCAO_SHOPEE,
    ]);
    fireEvent.click(within(linha(100037)).getByRole('option', { name: 'China' }));
    expect(h.edicoes).toEqual([[100037, { tipo: 'lista', valueIds: [35] }]]);
    expect(within(linha(100037)).queryByRole('textbox', { name: 'Outro valor' })).toBeNull();
  });

  it('«Outro valor…» sobre um valor da lista o tira e abre o campo; o texto digitado fica PERSONALIZADO, mesmo sendo um rótulo da lista', () => {
    mostrar({ arvore: arvore(PAIS_DE_ORIGEM), guardados: [guardado(100037, { value_id: 35 })] });
    escolher(linha(100037), 'País de Origem', ROTULO_OUTRO_VALOR_OPCAO_SHOPEE);
    expect(h.edicoes).toEqual([[100037, { tipo: 'lista', valueIds: [] }]]);
    digitar(caixa(linha(100037), 'Outro valor'), 'China');
    expect(h.edicoes[1]).toEqual([100037, { tipo: 'texto', texto: 'China', unidade: null }]);
    expect(h.lista).toEqual([guardado(100037, { value_id: 0, original_value_name: 'China' })]);
  });

  it('NEAR-MISS: escolher «China» na LISTA é `{value_id: 35}`, nunca um personalizado', () => {
    mostrar({ arvore: arvore(PAIS_DE_ORIGEM) });
    escolher(linha(100037), 'País de Origem', 'China');
    expect(h.lista).toEqual([guardado(100037, { value_id: 35 })]);
  });

  it('NEAR-MISS: «Outro valor…» sem nada guardado só abre o campo — não manda edição', () => {
    mostrar({ arvore: arvore(PAIS_DE_ORIGEM) });
    escolher(linha(100037), 'País de Origem', ROTULO_OUTRO_VALOR_OPCAO_SHOPEE);
    expect(h.edicoes).toEqual([]);
    expect(caixa(linha(100037), 'Outro valor').value).toBe('');
  });

  it('um personalizado guardado aparece como «Outro valor…» com o seu texto', () => {
    mostrar({
      arvore: arvore(PAIS_DE_ORIGEM),
      guardados: [guardado(100037, { value_id: 0, original_value_name: 'Terra Inventada' })],
    });
    expect((combobox(linha(100037), 'País de Origem') as HTMLInputElement).value).toBe(
      ROTULO_OUTRO_VALOR_OPCAO_SHOPEE,
    );
    expect(caixa(linha(100037), 'Outro valor').value).toBe('Terra Inventada');
  });

  it('o texto é mandado CRU (com o espaço sendo digitado)', () => {
    mostrar({
      arvore: arvore(PAIS_DE_ORIGEM),
      guardados: [guardado(100037, { value_id: 0, original_value_name: 'Terra' })],
    });
    digitar(caixa(linha(100037), 'Outro valor'), 'Terra ');
    expect(h.edicoes).toEqual([[100037, { tipo: 'texto', texto: 'Terra ', unidade: null }]]);
    expect(caixa(linha(100037), 'Outro valor').value).toBe('Terra ');
  });

  it('um personalizado guardado apagado até o fim mantém «Outro valor…» e o campo vazio aberto', () => {
    mostrar({
      arvore: arvore(PAIS_DE_ORIGEM),
      guardados: [guardado(100037, { value_id: 0, original_value_name: 'Terra Inventada' })],
    });
    digitar(caixa(linha(100037), 'Outro valor'), '');
    expect(caixa(linha(100037), 'Outro valor').value).toBe('');
    expect((combobox(linha(100037), 'País de Origem') as HTMLInputElement).value).toBe(
      ROTULO_OUTRO_VALOR_OPCAO_SHOPEE,
    );
    expect(h.edicoes).toEqual([[100037, { tipo: 'texto', texto: '', unidade: null }]]);
    digitar(caixa(linha(100037), 'Outro valor'), 'Outra Terra');
    expect(h.lista).toEqual([
      guardado(100037, { value_id: 0, original_value_name: 'Outra Terra' }),
    ]);
  });

  it('NEAR-MISS: escolher «China» num personalizado guardado tira o campo', () => {
    mostrar({
      arvore: arvore(PAIS_DE_ORIGEM),
      guardados: [guardado(100037, { value_id: 0, original_value_name: 'Terra Inventada' })],
    });
    escolher(linha(100037), 'País de Origem', 'China');
    expect(within(linha(100037)).queryByRole('textbox', { name: 'Outro valor' })).toBeNull();
    expect(h.lista).toEqual([guardado(100037, { value_id: 35 })]);
  });

  it('⛔ clicar de novo em «Outro valor…» (já escolhido) nunca apaga o personalizado — nenhuma edição ⟷ QUASE-PAR: escolher um valor da LISTA o troca', () => {
    mostrar({
      arvore: arvore(PAIS_DE_ORIGEM),
      guardados: [guardado(100037, { value_id: 0, original_value_name: 'Terra Inventada' })],
    });
    escolher(linha(100037), 'País de Origem', ROTULO_OUTRO_VALOR_OPCAO_SHOPEE);
    expect(h.edicoes).toEqual([]);
    expect(caixa(linha(100037), 'Outro valor').value).toBe('Terra Inventada');

    escolher(linha(100037), 'País de Origem', 'China');
    expect(h.edicoes).toEqual([[100037, { tipo: 'lista', valueIds: [35] }]]);
  });

  it('«Desfazer alterações» remonta a seção: «Outro valor…» escolhido sem nada guardado volta ao vazio ⟷ QUASE-PAR: sem desfazer, apagar o texto deixa «Outro valor…» e o campo', () => {
    mostrarNoForm({ arvore: arvore(PAIS_DE_ORIGEM), guardados: [] });
    escolher(linha(100037), 'País de Origem', ROTULO_OUTRO_VALOR_OPCAO_SHOPEE);
    digitar(caixa(linha(100037), 'Outro valor'), 'Terra Inventada');
    digitar(caixa(linha(100037), 'Outro valor'), '');
    expect((combobox(linha(100037), 'País de Origem') as HTMLInputElement).value).toBe(
      ROTULO_OUTRO_VALOR_OPCAO_SHOPEE,
    );
    expect(caixa(linha(100037), 'Outro valor').value).toBe('');

    digitar(caixa(linha(100037), 'Outro valor'), 'Terra Inventada');
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer' }));
    expect((combobox(linha(100037), 'País de Origem') as HTMLInputElement).value).toBe('');
    expect(within(linha(100037)).queryByRole('textbox', { name: 'Outro valor' })).toBeNull();
  });

  it('as unidades de 100248 no «Outro valor» são `ml`, `L` — NEAR-MISS: nunca `ML`', () => {
    mostrar({ arvore: arvore(VOLUME) });
    escolher(linha(100248), 'Volume', ROTULO_OUTRO_VALOR_OPCAO_SHOPEE);
    expect(opcoesDe(linha(100248), 'Unidade')).toEqual(['ml', 'L']);
  });
});

describe('AtributosRascunhoShopee — texto, decimal e unidade', () => {
  it('101029: as 12 unidades VERBATIM, na ordem da Shopee, e nenhuma pré-escolhida', () => {
    mostrar({ arvore: arvore(TAMANHO_DO_PACOTE) });
    expect((combobox(linha(101029), 'Unidade') as HTMLInputElement).value).toBe('');
    expect(opcoesDe(linha(101029), 'Unidade')).toEqual(UNIDADES_101029);
    expect(linha(101029).textContent).toContain(
      'Como a Shopee escreve — maiúsculas e minúsculas contam.',
    );
  });

  it('a descrição de um decimal, e o teclado decimal', () => {
    mostrar({ arvore: arvore(TAMANHO_DO_PACOTE) });
    expect(linha(101029).textContent).toContain(
      'Número; use vírgula para a parte decimal (ex.: 1,5).',
    );
    expect(caixa(linha(101029), 'Tamanho Do Pacote').getAttribute('inputmode')).toBe('decimal');
  });

  it('NEAR-MISS: um inteiro diz «Número inteiro.» e pede o teclado numérico', () => {
    mostrar({ arvore: arvore(INTEIRO) });
    expect(linha(900007).textContent).toContain('Número inteiro.');
    expect(linha(900007).textContent).not.toContain('vírgula');
    expect(caixa(linha(900007), 'Sintético inteiro').getAttribute('inputmode')).toBe('numeric');
  });

  it('`1,5` sem unidade BLOQUEIA com «Escolha a unidade.» e não entra na lista', () => {
    mostrar({ arvore: arvore(TAMANHO_DO_PACOTE) });
    digitar(caixa(linha(101029), 'Tamanho Do Pacote'), '1,5');
    expect(h.lista).toBeNull();
    expect(h.digitacoes['101029']?.motivo).toBe(MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.unidadeInvalida);
    expect(linha(101029).textContent).toContain('Escolha a unidade.');
    expect(caixa(linha(101029), 'Tamanho Do Pacote').value).toBe('1,5');
  });

  it('então escolher `KG` grava `{0, "1.5", "KG"}` — a vírgula vira o ponto do fio', () => {
    mostrar({ arvore: arvore(TAMANHO_DO_PACOTE) });
    digitar(caixa(linha(101029), 'Tamanho Do Pacote'), '1,5');
    escolher(linha(101029), 'Unidade', 'KG');
    expect(h.edicoes[1]).toEqual([101029, { tipo: 'texto', texto: '1,5', unidade: 'KG' }]);
    expect(h.lista).toEqual([
      guardado(101029, { value_id: 0, original_value_name: '1.5', value_unit: 'KG' }),
    ]);
    expect(linha(101029).textContent).not.toContain('Escolha a unidade.');
  });

  it('NEAR-MISS: `1.5` (ponto) é recusado com a frase do decimal, mesmo com a unidade', () => {
    mostrar({ arvore: arvore(TAMANHO_DO_PACOTE) });
    escolher(linha(101029), 'Unidade', 'KG');
    digitar(caixa(linha(101029), 'Tamanho Do Pacote'), '1.5');
    expect(h.lista).toBeNull();
    expect(linha(101029).textContent).toContain(
      'Use um número, com vírgula para a parte decimal (ex.: 1,5) e sem separador de milhar.',
    );
  });

  it('um decimal guardado `0.125` aparece `0,125` (o modelo converte; o campo mostra)', () => {
    mostrar({
      arvore: arvore(TAMANHO_DO_PACOTE),
      guardados: [
        guardado(101029, { value_id: 0, original_value_name: '0.125', value_unit: 'CM' }),
      ],
    });
    expect(caixa(linha(101029), 'Tamanho Do Pacote').value).toBe('0,125');
    expect((combobox(linha(101029), 'Unidade') as HTMLInputElement).value).toBe('CM');
  });

  it.each([
    ['lista única', TIPO_DE_CONEXAO, 'Tipo de Conexão', COM_FIO],
    ['lista ou texto', PAIS_DE_ORIGEM, 'País de Origem', 35],
    ['lista múltipla', MATERIAL, 'Material', 1207],
  ] as const)(
    '⛔ %s (busca): Enter com a lista fechada ou filtrada sem destaque nunca envia o formulário do produto ⟷ QUASE-PAR: ↓ e Enter ainda escolhe a primeira opção',
    (_, no, nome, primeiro) => {
      mostrar({ arvore: arvore(no) });
      const campo = combobox(linha(no.attributeId), nome);
      expect(fireEvent.keyDown(campo, { key: 'Enter', code: 'Enter' })).toBe(false);
      expect(h.edicoes).toEqual([]);
      fireEvent.click(campo);
      fireEvent.change(campo, { target: { value: 'zz' } });
      expect(fireEvent.keyDown(campo, { key: 'Enter', code: 'Enter' })).toBe(false);
      expect(h.edicoes).toEqual([]);

      fireEvent.change(campo, { target: { value: '' } });
      fireEvent.keyDown(campo, { key: 'ArrowDown', code: 'ArrowDown' });
      fireEvent.keyDown(campo, { key: 'Enter', code: 'Enter' });
      expect(h.edicoes).toEqual([[no.attributeId, { tipo: 'lista', valueIds: [primeiro] }]]);
    },
  );

  it('Enter no campo de texto não envia o formulário do produto (o rascunho fica DENTRO dele)', () => {
    mostrar({ arvore: arvore(TAMANHO_DO_PACOTE) });
    const evento = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    caixa(linha(101029), 'Tamanho Do Pacote').dispatchEvent(evento);
    expect(evento.defaultPrevented).toBe(true);
    expect(h.edicoes).toEqual([]);
  });

  it('a nota da busca aparece em «Fabricante» — NEAR-MISS: não em «Nr. de Homologação»', () => {
    mostrar({
      arvore: arvore(TIPO_DE_CONEXAO),
      guardados: [guardado(100408, { value_id: SEM_FIO })],
    });
    const nota =
      'A Shopee também oferece uma busca de valores para este atributo, que o ERP não faz: ' +
      'digite o valor.';
    expect(linha(101237).textContent).toContain(nota);
    expect(linha(101197).textContent).not.toContain(nota);
  });
});

describe('AtributosRascunhoShopee — múltiplos', () => {
  it('lista múltipla (tipo 4): «Escolha até 2», e uma escolha manda os ids', () => {
    mostrar({ arvore: arvore(MULTIPLA_SO_LISTA) });
    expect(linha(900001).textContent).toContain('Escolha até 2');
    escolher(linha(900001), 'Sintético múltiplo', 'Opção A');
    expect(h.edicoes).toEqual([[900001, { tipo: 'lista', valueIds: [901] }]]);
    expect(
      within(linha(900001)).queryByRole('textbox', { name: 'Adicionar outro valor' }),
    ).toBeNull();
  });

  it('NEAR-MISS: no limite, uma terceira escolha não é mandada', () => {
    mostrar({
      arvore: arvore(MULTIPLA_SO_LISTA),
      guardados: [guardado(900001, { value_id: 901 }, { value_id: 902 })],
    });
    escolher(linha(900001), 'Sintético múltiplo', 'Opção C');
    expect(h.edicoes).toEqual([]);
  });

  it('lista múltipla ou texto: o MultiSelect só cabe o máximo MENOS os personalizados', () => {
    mostrar({
      arvore: arvore(MATERIAL),
      guardados: [
        guardado(
          100134,
          { value_id: 0, original_value_name: 'Bambu' },
          { value_id: 0, original_value_name: 'Cortiça' },
          { value_id: 0, original_value_name: 'Juta' },
          { value_id: 0, original_value_name: 'Sisal' },
        ),
      ],
    });
    escolher(linha(100134), 'Material', 'Plástico');
    expect(h.edicoes).toEqual([[100134, { tipo: 'lista', valueIds: [1207] }]]);
    escolher(linha(100134), 'Material', 'Vidro');
    expect(h.edicoes).toHaveLength(1);
  });

  it('um personalizado é um chip; «Remover Bambu» manda o índice dele entre os personalizados', () => {
    mostrar({
      arvore: arvore(MATERIAL),
      guardados: [
        guardado(100134, { value_id: 1207 }, { value_id: 0, original_value_name: 'Bambu' }),
      ],
    });
    const chips = screen.getByTestId(`shopee-atributo-${LINK}-100134-valores`);
    expect(chips.textContent).toBe('Bambu');
    fireEvent.click(within(chips).getByRole('button', { name: 'Remover Bambu' }));
    expect(h.edicoes).toEqual([[100134, { tipo: 'remover-personalizado', indice: 0 }]]);
    expect(h.lista).toEqual([guardado(100134, { value_id: 1207 })]);
  });

  it('lista múltipla (tipo 4) com um personalizado GUARDADO: o chip tem «Remover» e a frase pede a remoção — nunca «escolha um da lista», que o manteria', () => {
    mostrar({
      arvore: arvore(MULTIPLA_SO_LISTA),
      guardados: [guardado(900001, { value_id: 0, original_value_name: 'Outro' })],
    });
    expect(screen.getByTestId(`shopee-atributo-${LINK}-900001-problemas`).textContent).toBe(
      'Este atributo só aceita valores da lista da Shopee; o valor gravado «Outro» não vale aqui ' +
        '— remova-o.',
    );
    expect(
      within(linha(900001)).queryByRole('textbox', { name: 'Adicionar outro valor' }),
    ).toBeNull();
    fireEvent.click(within(linha(900001)).getByRole('button', { name: 'Remover Outro' }));
    expect(h.edicoes).toEqual([[900001, { tipo: 'remover-personalizado', indice: 0 }]]);
    expect(h.lista).toBeNull();
    expect(screen.queryByTestId(`shopee-atributo-${LINK}-900001-problemas`)).toBeNull();
  });

  it('o compositor guarda o texto quando a edição fica bloqueada por um momento — desligado, nunca desmontado ⟷ religado, o mesmo texto adiciona', () => {
    mostrarNoForm({ arvore: arvore(MATERIAL, CAPACIDADE) });
    digitar(caixa(linha(100134), 'Adicionar outro valor'), 'Bambu');
    escolher(linha(100278), 'Unidade', 'ml');
    digitar(caixa(linha(100278), 'Adicionar outro valor'), '250');
    fireEvent.click(screen.getByRole('button', { name: 'Alternar edição' }));
    for (const id of [100134, 100278]) {
      const adicionar = within(linha(id)).getByRole('button', {
        name: 'Adicionar',
      }) as HTMLButtonElement;
      expect(adicionar.disabled).toBe(true);
      expect(caixa(linha(id), 'Adicionar outro valor').disabled).toBe(true);
      fireEvent.click(adicionar);
    }
    expect(caixa(linha(100134), 'Adicionar outro valor').value).toBe('Bambu');
    expect(caixa(linha(100278), 'Adicionar outro valor').value).toBe('250');
    expect(h.edicoes).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Alternar edição' }));
    const adicionar = within(linha(100278)).getByRole('button', {
      name: 'Adicionar',
    }) as HTMLButtonElement;
    expect(adicionar.disabled).toBe(false);
    fireEvent.click(adicionar);
    expect(h.edicoes).toEqual([
      [100278, { tipo: 'adicionar-personalizado', texto: '250', unidade: 'ml' }],
    ]);
    expect(caixa(linha(100278), 'Adicionar outro valor').value).toBe('');
  });

  it('o compositor adiciona o texto e se limpa', () => {
    mostrar({ arvore: arvore(MATERIAL), guardados: [guardado(100134, { value_id: 1207 })] });
    const adicionar = () => within(linha(100134)).getByRole('button', { name: 'Adicionar' });
    expect((adicionar() as HTMLButtonElement).disabled).toBe(true);
    digitar(caixa(linha(100134), 'Adicionar outro valor'), 'Cortiça');
    expect((adicionar() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(adicionar());
    expect(h.edicoes).toEqual([
      [100134, { tipo: 'adicionar-personalizado', texto: 'Cortiça', unidade: null }],
    ]);
    expect(h.lista).toEqual([
      guardado(100134, { value_id: 1207 }, { value_id: 0, original_value_name: 'Cortiça' }),
    ]);
    expect(caixa(linha(100134), 'Adicionar outro valor').value).toBe('');
  });

  it('NEAR-MISS: um valor que já está (`Bambu `) deixa «Adicionar» desligado', () => {
    mostrar({
      arvore: arvore(MATERIAL),
      guardados: [guardado(100134, { value_id: 0, original_value_name: 'Bambu' })],
    });
    digitar(caixa(linha(100134), 'Adicionar outro valor'), 'Bambu ');
    const botao = within(linha(100134)).getByRole('button', { name: 'Adicionar' });
    expect((botao as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(botao);
    expect(h.edicoes).toEqual([]);
  });

  it('Enter no compositor adiciona — e não envia o formulário do produto', () => {
    mostrar({ arvore: arvore(MATERIAL) });
    const campo = caixa(linha(100134), 'Adicionar outro valor');
    digitar(campo, 'Juta');
    const evento = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    campo.dispatchEvent(evento);
    expect(evento.defaultPrevented).toBe(true);
    expect(h.edicoes).toEqual([
      [100134, { tipo: 'adicionar-personalizado', texto: 'Juta', unidade: null }],
    ]);
  });

  it('só texto com unidade (100278): sem unidade, «Adicionar» espera e diz «Escolha a unidade.»; com `ml`, adiciona e esquece a unidade', () => {
    mostrar({ arvore: arvore(CAPACIDADE) });
    expect(opcoesDe(linha(100278), 'Unidade')).toEqual(['L', 'ml']);
    fireEvent.click(combobox(linha(100278), 'Unidade'));
    digitar(caixa(linha(100278), 'Adicionar outro valor'), '250');
    const adicionar = () =>
      within(linha(100278)).getByRole('button', { name: 'Adicionar' }) as HTMLButtonElement;
    expect(adicionar().disabled).toBe(true);
    expect(linha(100278).textContent).toContain('Escolha a unidade.');
    escolher(linha(100278), 'Unidade', 'ml');
    expect(adicionar().disabled).toBe(false);
    fireEvent.click(adicionar());
    expect(h.lista).toEqual([
      guardado(100278, { value_id: 0, original_value_name: '250', value_unit: 'ml' }),
    ]);
    expect((combobox(linha(100278), 'Unidade') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId(`shopee-atributo-${LINK}-100278-valores`).textContent).toBe('250 ml');
  });

  it('NEAR-MISS: `2.5` com unidade é recusado com a frase do decimal', () => {
    mostrar({ arvore: arvore(CAPACIDADE) });
    escolher(linha(100278), 'Unidade', 'L');
    digitar(caixa(linha(100278), 'Adicionar outro valor'), '2.5');
    expect(
      (within(linha(100278)).getByRole('button', { name: 'Adicionar' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(linha(100278).textContent).toContain(
      'Use um número, com vírgula para a parte decimal (ex.: 1,5) e sem separador de milhar.',
    );
  });

  const cinco = (n: number) =>
    guardado(
      100278,
      ...Array.from({ length: n }, (_, i) => ({
        value_id: 0,
        original_value_name: String(100 + i),
        value_unit: 'ml',
      })),
    );

  it('no máximo (5 valores) o compositor fica desligado', () => {
    mostrar({ arvore: arvore(CAPACIDADE), guardados: [cinco(5)] });
    expect(caixa(linha(100278), 'Adicionar outro valor').disabled).toBe(true);
    expect(
      (within(linha(100278)).getByRole('button', { name: 'Adicionar' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('NEAR-MISS: com 4, o 5º entra', () => {
    mostrar({ arvore: arvore(CAPACIDADE), guardados: [cinco(4)] });
    escolher(linha(100278), 'Unidade', 'ml');
    digitar(caixa(linha(100278), 'Adicionar outro valor'), '500');
    fireEvent.click(within(linha(100278)).getByRole('button', { name: 'Adicionar' }));
    expect(h.lista?.[0]?.attribute_value_list).toHaveLength(5);
  });
});

/* -------------------------------------------------------------------------- */
/*                               Não suportado                                 */
/* -------------------------------------------------------------------------- */

describe('AtributosRascunhoShopee — «não suportado»', () => {
  const FRASES: Readonly<Record<MotivoNaoSuportadoAtributoShopee, string>> = {
    data: 'Atributo de data: o ERP ainda não edita datas.',
    busca: 'Os valores deste atributo vêm de uma busca da Shopee que o ERP não faz.',
    'lista-sem-valores': 'A Shopee não enviou os valores deste atributo.',
    desconhecido: 'O ERP não sabe editar este tipo de atributo.',
    'unidade-sem-lista':
      'A Shopee pede uma unidade para este atributo, mas não enviou a lista de unidades.',
  };
  const motivos = Object.keys(FRASES) as MotivoNaoSuportadoAtributoShopee[];
  const ABERTURA = 'Ele é obrigatório, então este rascunho não pode ser publicado pelo ERP. ';

  it.each(motivos)('%s, OPCIONAL: a frase + «Ele é opcional…», e nenhum controle', (motivo) => {
    const no = NAO_SUPORTADOS[motivo];
    mostrar({ arvore: arvore(no) });
    const texto = screen.getByTestId(
      `shopee-atributo-${LINK}-${String(no.attributeId)}-nao-suportado`,
    ).textContent;
    expect(texto).toBe(`${FRASES[motivo]} Ele é opcional: o anúncio pode ser publicado sem ele.`);
    expect(within(linha(no.attributeId)).queryByRole('combobox')).toBeNull();
    expect(within(linha(no.attributeId)).queryByRole('textbox')).toBeNull();
  });

  it.each(motivos)(
    '%s, OBRIGATÓRIO: a frase + a abertura + a saída pelo Seller Centre da leitura ATUAL (livre)',
    (motivo) => {
      const no = { ...NAO_SUPORTADOS[motivo], mandatory: true };
      mostrar({ arvore: arvore(no), publicacao: LIVRE });
      const texto = screen.getByTestId(
        `shopee-atributo-${LINK}-${String(no.attributeId)}-nao-suportado`,
      ).textContent;
      expect(texto).toBe(
        `${FRASES[motivo]} ${ABERTURA}${saidaPeloSellerCentreDoRascunhoShopee(LIVRE)}`,
      );
    },
  );

  const GRAVADOS: Readonly<
    Record<
      MotivoNaoSuportadoAtributoShopee,
      AtributoShopeeRequisicao['attribute_value_list'][number]
    >
  > = {
    data: { value_id: 0, original_value_name: '15/03/2027' },
    busca: { value_id: 931 },
    'lista-sem-valores': { value_id: 941 },
    desconhecido: { value_id: 0, original_value_name: 'X1' },
    'unidade-sem-lista': { value_id: 0, original_value_name: '2', value_unit: 'KG' },
  };

  it.each(motivos)(
    '%s, OBRIGATÓRIO com valor gravado: sem a abertura nem a saída — não há pendência (o valor é carregado, D-7)',
    (motivo) => {
      const no = { ...NAO_SUPORTADOS[motivo], mandatory: true };
      mostrar({ arvore: arvore(no), guardados: [guardado(no.attributeId, GRAVADOS[motivo])] });
      const texto = screen.getByTestId(
        `shopee-atributo-${LINK}-${String(no.attributeId)}-nao-suportado`,
      ).textContent;
      expect(texto).toBe(FRASES[motivo]);
      expect(texto).not.toContain(ABERTURA.trim());
      expect(texto).not.toContain(saidaPeloSellerCentreDoRascunhoShopee(LIVRE));
      expect(linha(no.attributeId).textContent).toContain('Valor gravado: ');
      expect(linha(no.attributeId).textContent).toContain('(mantido).');
    },
  );

  it('NEAR-MISS: a mesma linha numa leitura `incerta` nomeia a saída da incerta — nunca a da livre', () => {
    const no = { ...DATA, mandatory: true };
    mostrar({ arvore: arvore(no), publicacao: INCERTA });
    const texto = screen.getByTestId(`shopee-atributo-${LINK}-900002-nao-suportado`).textContent;
    expect(texto).toBe(
      `${FRASES.data} ${ABERTURA}${saidaPeloSellerCentreDoRascunhoShopee(INCERTA)}`,
    );
    expect(texto).not.toContain(saidaPeloSellerCentreDoRascunhoShopee(LIVRE));
  });

  it('NEAR-MISS: em andamento, a saída é a de esperar', () => {
    const emAndamento: EstadoPublicacaoRascunhoShopee = {
      tipo: 'em-andamento',
      desdeMs: 1,
      expiraEmMs: 2,
      aguardarMs: 1,
      aposIncerteza: false,
      posExpiracao: false,
    };
    mostrar({ arvore: arvore({ ...DATA, mandatory: true }), publicacao: emAndamento });
    expect(screen.getByTestId(`shopee-atributo-${LINK}-900002-nao-suportado`).textContent).toBe(
      `${FRASES.data} ${ABERTURA}${saidaPeloSellerCentreDoRascunhoShopee(emAndamento)}`,
    );
  });

  it('o valor guardado aparece «mantido», com o problema da data em formato de leitura', () => {
    mostrar({
      arvore: arvore(DATA),
      guardados: [guardado(900002, { value_id: 0, original_value_name: '15/03/2027' })],
    });
    expect(linha(900002).textContent).toContain('Valor gravado: 15/03/2027 (mantido).');
    expect(screen.getByTestId(`shopee-atributo-${LINK}-900002-problemas`).textContent).toBe(
      'Data gravada no formato de leitura da Shopee (15/03/2027); a publicação a converte.',
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                            The rows' problems                               */
/* -------------------------------------------------------------------------- */

describe('AtributosRascunhoShopee — problemas de um valor GUARDADO (mostrados, nunca bloqueiam)', () => {
  const problemas = (id: number) =>
    screen.getByTestId(`shopee-atributo-${LINK}-${String(id)}-problemas`).textContent;

  it('uma unidade gravada fora da lista (`cm` em 101029) é nomeada', () => {
    mostrar({
      arvore: arvore(TAMANHO_DO_PACOTE),
      guardados: [guardado(101029, { value_id: 0, original_value_name: '25', value_unit: 'cm' })],
    });
    expect(problemas(101029)).toBe(
      'A unidade gravada (cm) não está na lista da Shopee para este atributo: escolha uma.',
    );
  });

  it('NEAR-MISS: `CM` (a grafia da lista) não tem problema', () => {
    mostrar({
      arvore: arvore(TAMANHO_DO_PACOTE),
      guardados: [guardado(101029, { value_id: 0, original_value_name: '25', value_unit: 'CM' })],
    });
    expect(screen.queryByTestId(`shopee-atributo-${LINK}-101029-problemas`)).toBeNull();
  });

  it('sem unidade gravada, diz «nenhuma»', () => {
    mostrar({
      arvore: arvore(TAMANHO_DO_PACOTE),
      guardados: [guardado(101029, { value_id: 0, original_value_name: '25' })],
    });
    expect(problemas(101029)).toBe(
      'A unidade gravada (nenhuma) não está na lista da Shopee para este atributo: escolha uma.',
    );
  });

  it('um id que saiu da lista: a frase, e o Select ainda o mostra (`#9999`)', () => {
    mostrar({ arvore: arvore(TIPO_DE_CONEXAO), guardados: [guardado(100408, { value_id: 9999 })] });
    expect(problemas(100408)).toBe(
      'Um valor gravado não está mais na lista da Shopee para esta categoria — escolha outro.',
    );
    expect((combobox(linha(100408), 'Tipo de Conexão') as HTMLInputElement).value).toBe('#9999');
  });

  it('um personalizado onde só a lista vale', () => {
    mostrar({
      arvore: arvore(TIPO_DE_CONEXAO),
      guardados: [guardado(100408, { value_id: 0, original_value_name: 'Sem fio 5' })],
    });
    expect(problemas(100408)).toBe(
      'Este atributo só aceita valores da lista da Shopee; o valor gravado «Sem fio 5» não vale ' +
        'aqui — escolha um da lista.',
    );
  });

  it('valores demais numa escolha única: «no máximo 1»', () => {
    mostrar({
      arvore: arvore(TIPO_DE_CONEXAO),
      guardados: [guardado(100408, { value_id: COM_FIO }, { value_id: SEM_FIO })],
    });
    expect(problemas(100408)).toContain('A Shopee aceita no máximo 1 valor(es) aqui.');
  });

  it('um decimal GRAVADO com vírgula: a frase diz que o valor gravado é o errado e como refazê-lo — digitando de novo ⟷ QUASE-PAR: redigitado, ele vira o ponto do fio e a frase some', () => {
    mostrar({
      arvore: arvore(TAMANHO_DO_PACOTE),
      guardados: [guardado(101029, { value_id: 0, original_value_name: '1,5', value_unit: 'CM' })],
    });
    expect(problemas(101029)).toBe(
      'O valor gravado «1,5» não está no formato de número da Shopee: digite-o de novo, com ' +
        'vírgula para a parte decimal (ex.: 1,5).',
    );
    digitar(caixa(linha(101029), 'Tamanho Do Pacote'), '1,');
    digitar(caixa(linha(101029), 'Tamanho Do Pacote'), '1,5');
    expect(h.lista).toEqual([
      guardado(101029, { value_id: 0, original_value_name: '1.5', value_unit: 'CM' }),
    ]);
    expect(screen.queryByTestId(`shopee-atributo-${LINK}-101029-problemas`)).toBeNull();
  });

  it('chips: a unidade gravada de UM valor (`500 ML` em 100278) — a frase o nomeia e pede remover e adicionar de novo; a «Unidade» do compositor é do PRÓXIMO valor ⟷ QUASE-PAR: removido e readicionado com `ml`, a frase some', () => {
    mostrar({
      arvore: arvore(CAPACIDADE),
      guardados: [guardado(100278, { value_id: 0, original_value_name: '500', value_unit: 'ML' })],
    });
    expect(problemas(100278)).toBe(
      'A unidade gravada de «500» (ML) não está na lista da Shopee para este atributo: remova ' +
        'esse valor e adicione-o de novo, escolhendo a unidade.',
    );
    escolher(linha(100278), 'Unidade', 'ml');
    expect(problemas(100278)).toContain('«500» (ML)');
    fireEvent.click(within(linha(100278)).getByRole('button', { name: 'Remover 500 ML' }));
    digitar(caixa(linha(100278), 'Adicionar outro valor'), '500');
    fireEvent.click(within(linha(100278)).getByRole('button', { name: 'Adicionar' }));
    expect(h.lista).toEqual([
      guardado(100278, { value_id: 0, original_value_name: '500', value_unit: 'ml' }),
    ]);
    expect(screen.queryByTestId(`shopee-atributo-${LINK}-100278-problemas`)).toBeNull();
  });

  it('chips: um decimal gravado com vírgula (`0,5 ml` ao lado de `2 L`) é nomeado e pede remover e adicionar de novo ⟷ QUASE-PAR: o mesmo `0,5` no campo único (101029) pede digitar de novo', () => {
    mostrar({
      arvore: arvore(CAPACIDADE),
      guardados: [
        guardado(
          100278,
          { value_id: 0, original_value_name: '2', value_unit: 'L' },
          { value_id: 0, original_value_name: '0,5', value_unit: 'ml' },
        ),
      ],
    });
    expect(problemas(100278)).toBe(
      'O valor gravado «0,5» não está no formato de número da Shopee: remova-o e adicione-o de ' +
        'novo, com vírgula para a parte decimal (ex.: 1,5).',
    );
  });

  it('NEAR-MISS: o `0,5` gravado no campo único (101029) pede digitar de novo, nunca remover', () => {
    mostrar({
      arvore: arvore(TAMANHO_DO_PACOTE),
      guardados: [guardado(101029, { value_id: 0, original_value_name: '0,5', value_unit: 'CM' })],
    });
    expect(problemas(101029)).toContain('digite-o de novo');
    expect(problemas(101029)).not.toContain('remova');
  });

  it('«não suportado»: nenhuma frase oferece uma saída que a linha não tem — a lista que veio vazia, sem unidades, por busca ⟷ QUASE-PAR: as mesmas, num controle editável, a oferecem', () => {
    const vazia = NAO_SUPORTADOS['lista-sem-valores'];
    mostrar({ arvore: arvore(vazia), guardados: [guardado(vazia.attributeId, { value_id: 123 })] });
    expect(problemas(vazia.attributeId)).toBe(
      'Um valor gravado não está mais na lista da Shopee para esta categoria.',
    );
    expect(linha(vazia.attributeId).textContent).not.toMatch(/escolha/i);
  });

  it('«não suportado» sem lista de unidades (`[]`): a unidade gravada não ganha uma frase própria — a da linha já diz por quê', () => {
    const semUnidades = {
      ...NAO_SUPORTADOS['unidade-sem-lista'],
      attributeInfo: info({
        inputType: 3,
        inputValidationType: 3,
        formatType: 2,
        attributeUnitList: [],
      }),
    };
    mostrar({
      arvore: arvore(semUnidades),
      guardados: [
        guardado(semUnidades.attributeId, {
          value_id: 0,
          original_value_name: '25',
          value_unit: 'KG',
        }),
      ],
    });
    expect(
      screen.queryByTestId(`shopee-atributo-${LINK}-${String(semUnidades.attributeId)}-problemas`),
    ).toBeNull();
    expect(linha(semUnidades.attributeId).textContent).not.toMatch(/escolha/i);
  });

  it('«não suportado» por busca: o personalizado gravado é apontado SEM «escolha um da lista»', () => {
    const busca = NAO_SUPORTADOS.busca;
    mostrar({
      arvore: arvore(busca),
      guardados: [
        guardado(busca.attributeId, { value_id: 0, original_value_name: 'Valor Inventado' }),
      ],
    });
    expect(problemas(busca.attributeId)).toBe(
      'Este atributo só aceita valores da lista da Shopee; o valor gravado «Valor Inventado» não ' +
        'vale aqui.',
    );
  });

  it('NEAR-MISS: a unidade `kg` (minúscula, fora da lista) no campo único de 101029 ainda pede «escolha uma»', () => {
    mostrar({
      arvore: arvore(TAMANHO_DO_PACOTE),
      guardados: [guardado(101029, { value_id: 0, original_value_name: '25', value_unit: 'kg' })],
    });
    expect(problemas(101029)).toBe(
      'A unidade gravada (kg) não está na lista da Shopee para este atributo: escolha uma.',
    );
  });

  it('fraseDoProblemaDoAtributoShopee: os tipos que a linha não diz são `null`', () => {
    const TEXTO = { tipo: 'texto' } as const;
    for (const tipo of [
      TIPO_PROBLEMA_ATRIBUTO_SHOPEE.obrigatorioAusente,
      TIPO_PROBLEMA_ATRIBUTO_SHOPEE.obrigatorioRequerBusca,
      TIPO_PROBLEMA_ATRIBUTO_SHOPEE.filhoSemPai,
      TIPO_PROBLEMA_ATRIBUTO_SHOPEE.foraDaCategoria,
    ]) {
      expect(
        fraseDoProblemaDoAtributoShopee(
          { tipo, valor: null, unidade: null, maximo: null },
          null,
          TEXTO,
        ),
      ).toBeNull();
    }
    const tipoDeValor = (
      valor: string | null,
      controle: Parameters<typeof fraseDoProblemaDoAtributoShopee>[2],
    ) =>
      fraseDoProblemaDoAtributoShopee(
        { tipo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.tipoDeValor, valor, unidade: null, maximo: null },
        'inteiro',
        controle,
      );
    expect(tipoDeValor('1,5', TEXTO)).toBe(
      'O valor gravado «1,5» não é um número inteiro: digite-o de novo.',
    );
    expect(tipoDeValor('1,5', { tipo: 'textos-multiplos', max: null })).toBe(
      'O valor gravado «1,5» não é um número inteiro: remova-o e adicione-o de novo.',
    );
    expect(tipoDeValor('1,5', { tipo: 'nao-suportado', motivo: 'desconhecido' })).toBe(
      'O valor gravado «1,5» não é um número inteiro.',
    );
    // No value to name: the typing sentence.
    expect(tipoDeValor(null, TEXTO)).toBe('Use um número inteiro.');
    const unidade = (controle: Parameters<typeof fraseDoProblemaDoAtributoShopee>[2]) =>
      fraseDoProblemaDoAtributoShopee(
        {
          tipo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.unidadeInvalida,
          valor: '2',
          unidade: 'KG',
          maximo: null,
        },
        'decimal',
        controle,
      );
    expect(unidade({ tipo: 'textos-multiplos', max: null })).toContain('remova esse valor');
    expect(unidade(TEXTO)).toContain(': escolha uma.');
    expect(unidade({ tipo: 'nao-suportado', motivo: 'unidade-sem-lista' })).toBeNull();
    expect(unidade({ tipo: 'nao-suportado', motivo: 'desconhecido' })).toBe(
      'A unidade gravada (KG) não está na lista da Shopee para este atributo.',
    );
    // A chip value with no name to quote keeps the generic sentence.
    expect(
      fraseDoProblemaDoAtributoShopee(
        {
          tipo: TIPO_PROBLEMA_ATRIBUTO_SHOPEE.unidadeInvalida,
          valor: null,
          unidade: null,
          maximo: null,
        },
        'decimal',
        { tipo: 'textos-multiplos', max: null },
      ),
    ).toBe(
      'A unidade gravada (nenhuma) não está na lista da Shopee para este atributo: escolha uma.',
    );
  });

  it('fraseDaDigitacaoDoAtributoShopee: `vazio` e `repetido` não têm frase; `valores-demais` tem', () => {
    expect(
      fraseDaDigitacaoDoAtributoShopee(MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.vazio, null, 5),
    ).toBeNull();
    expect(
      fraseDaDigitacaoDoAtributoShopee(MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.repetido, null, 5),
    ).toBeNull();
    expect(
      fraseDaDigitacaoDoAtributoShopee(MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.valoresDemais, null, 5),
    ).toBe('A Shopee aceita no máximo 5 valor(es) aqui.');
  });
});

/* -------------------------------------------------------------------------- */
/*                           Staged removal (rule 7)                           */
/* -------------------------------------------------------------------------- */

describe('AtributosRascunhoShopee — «sem lugar» e «Serão removidos ao salvar» (apps/web regra 7)', () => {
  const FORA = guardado(777001, { value_id: 0, original_value_name: 'Antigo' });

  it('um guardado fora da categoria é LISTADO ao abrir — nada é mandado nem marcado', () => {
    mostrar({ arvore: arvore(TIPO_DE_CONEXAO), guardados: [FORA] });
    const semLugar = screen.getByTestId(`shopee-rascunho-atributos-${LINK}-sem-lugar`);
    expect(semLugar.textContent).toContain('Gravados, mas sem lugar nesta categoria');
    expect(semLugar.textContent).toContain(
      'A Shopee não mostra estes atributos com as escolhas atuais. Ao salvar uma alteração de ' +
        'atributos, o ERP os remove.',
    );
    expect(semLugar.textContent).toContain('#777001: Antigo');
    expect(screen.queryByTestId(`shopee-rascunho-atributos-${LINK}-removidos`)).toBeNull();
    expect(h.edicoes).toEqual([]);
  });

  it('«Marcar para remover» o passa para «Serão removidos ao salvar», riscado, com o desfazer', () => {
    mostrar({ arvore: arvore(TIPO_DE_CONEXAO), guardados: [FORA] });
    fireEvent.click(screen.getByRole('button', { name: 'Marcar para remover' }));
    expect(h.edicoes).toEqual([[777001, { tipo: 'remover-sem-lugar' }]]);
    expect(h.lista).toBeNull();
    expect(screen.queryByTestId(`shopee-rascunho-atributos-${LINK}-sem-lugar`)).toBeNull();
    const removidos = screen.getByTestId(`shopee-rascunho-atributos-${LINK}-removidos`);
    expect(removidos.textContent).toContain('#777001: Antigo');
    expect(removidos.textContent).toContain('Para mantê-los, use «Desfazer alterações».');
  });
});

/* -------------------------------------------------------------------------- */
/*                                  Read-only                                  */
/* -------------------------------------------------------------------------- */

describe('AtributosRascunhoShopee — somente leitura', () => {
  const TODOS = arvore(TIPO_DE_CONEXAO, PAIS_DE_ORIGEM, TAMANHO_DO_PACOTE, MATERIAL, CAPACIDADE);
  const GUARDADOS = [
    guardado(100037, { value_id: 0, original_value_name: 'Terra Inventada' }),
    guardado(100134, { value_id: 0, original_value_name: 'Bambu' }),
    guardado(777001, { value_id: 0, original_value_name: 'Antigo' }),
  ];

  it('`editavel: false`: todo controle desligado — o compositor também, mas montado; sem «Remover …» nem «Marcar para remover»', () => {
    mostrar({ arvore: TODOS, guardados: GUARDADOS, editavel: false });
    const controles = [
      ...within(raiz()).getAllByRole('combobox'),
      ...within(raiz()).getAllByRole('textbox'),
    ] as HTMLInputElement[];
    expect(controles.length).toBeGreaterThan(0);
    for (const c of controles) expect(c.disabled).toBe(true);
    // The composer stays mounted (its typed text survives), disabled.
    const adicionar = within(raiz()).getAllByRole('button', { name: 'Adicionar' });
    expect(adicionar.length).toBeGreaterThan(0);
    for (const b of adicionar) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(caixa(linha(100134), 'Adicionar outro valor').disabled).toBe(true);
    expect(within(raiz()).queryByRole('button', { name: 'Remover Bambu' })).toBeNull();
    expect(within(raiz()).queryByRole('button', { name: 'Marcar para remover' })).toBeNull();
    // The values still read.
    expect(screen.getByTestId(`shopee-atributo-${LINK}-100134-valores`).textContent).toBe('Bambu');
  });

  it('NEAR-MISS: `editavel: true` liga os mesmos controles', () => {
    mostrar({ arvore: TODOS, guardados: GUARDADOS, editavel: true });
    expect((combobox(linha(100408), 'Tipo de Conexão') as HTMLInputElement).disabled).toBe(false);
    expect(caixa(linha(100037), 'Outro valor').disabled).toBe(false);
    expect(within(raiz()).getByRole('button', { name: 'Remover Bambu' })).toBeTruthy();
    expect(within(raiz()).getByRole('button', { name: 'Marcar para remover' })).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/*                                The dry run                                  */
/* -------------------------------------------------------------------------- */

describe('ensaioDaAdicaoAtributoShopee — a regra do modelo, nunca outra', () => {
  const estado = {
    arvore: arvore(CAPACIDADE),
    lista: [guardado(100278, { value_id: 0, original_value_name: '250', value_unit: 'ml' })],
    guardados: null,
    digitacoes: {},
  };
  const ensaio = ensaioDaAdicaoAtributoShopee(estado);

  it('um valor válido ⇒ `null`', () => {
    expect(ensaio(100278, '500', 'ml')).toBeNull();
  });

  it('NEAR-MISS: em branco, repetido, sem unidade, com ponto', () => {
    expect(ensaio(100278, '  ', 'ml')).toBe(MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.vazio);
    expect(ensaio(100278, '250', 'ml')).toBe(MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.repetido);
    expect(ensaio(100278, '500', null)).toBe(MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.unidadeInvalida);
    expect(ensaio(100278, '0.5', 'L')).toBe(MOTIVO_DIGITACAO_ATRIBUTO_SHOPEE.tipoDeValor);
  });

  it('o ensaio não muda o estado', () => {
    ensaio(100278, '500', 'ml');
    expect(estado.lista).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                         The Seller-Centre exit pin                          */
/* -------------------------------------------------------------------------- */

describe('a saída pelo Seller Centre tem UMA grafia (correção 7, #1369)', () => {
  // Built from parts, so this file does not contain the phrase either.
  const FRASE = new RegExp(['procure', 'o', 'SKU'].join(' '), 'i');
  const aqui = dirname(fileURLToPath(import.meta.url));
  const arquivos = [
    join(aqui, 'AtributosRascunhoShopee.tsx'),
    join(aqui, '../../../../../lib/shopee/atributosRascunho.ts'),
  ];

  it.each(arquivos)('%s nunca a soletra', (arquivo) => {
    const fonte = readFileSync(arquivo, 'utf8');
    expect(fonte.length).toBeGreaterThan(1000);
    expect(FRASE.test(fonte)).toBe(false);
  });

  it('NEAR-MISS: a saída que a linha imprime CONTÉM a frase — vem do `anuncioProduto`', () => {
    expect(FRASE.test(saidaPeloSellerCentreDoRascunhoShopee(LIVRE))).toBe(true);
  });
});
