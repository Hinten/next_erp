import { describe, expect, it, vi } from 'vitest';

import { ESTADO_ANUNCIO_SHOPEE } from '@delfrance/schemas';

import {
  type MembroDaFamilia,
  type MovimentoDaJanela,
  chaveMovimento,
} from '@delfrance/data/admin/estoque';

import { MAX_MODELOS_POR_TASK } from './constantesEstoque';
import { MENSAGEM_POR_MOTIVO, MOTIVO_ESTOQUE_SHOPEE } from './errosEstoque';
import {
  type FilhoDaFamilia,
  type LinhaDeFamiliaShopee,
  type LinkShopeeCru,
  type OpcoesDeMontagem,
  type ResultadoDoPlanoShopee,
  type VarLinkShopeeCru,
  anterioresComDesauditado,
  conferirCompletudeDoAnuncio,
  contarModelosPlanejados,
  estoqueDesauditado,
  montarTarefasDeEstoqueShopee,
} from './planoEstoque';

/* ---------------------------------- fixtures ------------------------------ */

const INTEGRACAO = 'int-1';
const OUTRA_CONTA = 'int-2';
const DEPOSITO = 'dep-1';
const SWEEP = 'sweep-1';
const AGORA = 1_757_000_000_000;
const COMPUTADO_EM = AGORA - 5_000;

const ANCORA = 'prod-pai';
const FILHO_A = 'prod-filho-a';
const FILHO_B = 'prod-filho-b';

const ITEM_ID = 2500139861;
const MODEL_A = 2000458802;
const MODEL_B = 2000458803;

const LINK_DOC = 'link-1';
const OUTRO_LINK_DOC = 'link-2';

/** The canonical stored encoding: `documents/<col>/<id>`. */
function refConta(id: string): string {
  return `documents/integracoes/${id}`;
}

/** The bare legacy encoding the migrated corpus also carries. */
function refContaNua(id: string): string {
  return `integracoes/${id}`;
}

function refLink(produtoId: string, linkDocId: string): string {
  return `documents/produtos/${produtoId}/prodshopee/${linkDocId}`;
}

function refLinkNua(produtoId: string, linkDocId: string): string {
  return `produtos/${produtoId}/prodshopee/${linkDocId}`;
}

function membro(produtoId: string, extra: Partial<MembroDaFamilia> = {}): MembroDaFamilia {
  return {
    produtoId,
    ehKit: false,
    ehKitVirtual: false,
    publicado: true,
    componentesKit: null,
    timestampMs: null,
    estoque: null,
    componentEstoques: [],
    ...extra,
  };
}

function filho(
  produtoId: string,
  varLinks: readonly VarLinkShopeeCru[],
  extra: Partial<MembroDaFamilia> = {},
): FilhoDaFamilia {
  return { ...membro(produtoId, extra), varLinks };
}

function link(extra: LinkShopeeCru = {}): LinkShopeeCru {
  return {
    contaProdutoShopeeOuterRef: refConta(INTEGRACAO),
    linkDocId: LINK_DOC,
    item_id: ITEM_ID,
    ...extra,
  };
}

function varLink(extra: VarLinkShopeeCru = {}): VarLinkShopeeCru {
  return {
    produtoShopeeOuterRef: refLink(ANCORA, LINK_DOC),
    model_id: MODEL_A,
    varLinkDocId: 'var-a',
    ...extra,
  };
}

function familia(extra: Partial<LinhaDeFamiliaShopee> = {}): LinhaDeFamiliaShopee {
  return {
    anchorId: ANCORA,
    anchor: membro(ANCORA),
    integracoesComProduto: [INTEGRACAO],
    links: [link()],
    children: [],
    ...extra,
  };
}

function montar(
  row: LinhaDeFamiliaShopee,
  quantidades: ReadonlyMap<string, number>,
  extra: Partial<OpcoesDeMontagem> = {},
): ResultadoDoPlanoShopee {
  return montarTarefasDeEstoqueShopee(row, quantidades, {
    integracaoId: INTEGRACAO,
    sweepId: SWEEP,
    sweepComputadoEmMs: COMPUTADO_EM,
    nowMs: AGORA,
    ...extra,
  });
}

function motivos(resultado: ResultadoDoPlanoShopee): string[] {
  return resultado.pulos.map((p) => p.motivo);
}

/* -------------------------------------------------------------------------- */
/*      (1) a que CONTA o vínculo pertence — o fold das duas codificações      */
/* -------------------------------------------------------------------------- */

describe('planoEstoque — atribuição do vínculo à conta', () => {
  it('PAR — `documents/integracoes/<id>` e o `integracoes/<id>` nu são a MESMA conta', () => {
    const canonico = montar(familia(), new Map([[ANCORA, 7]]));
    const nu = montar(
      familia({ links: [link({ contaProdutoShopeeOuterRef: refContaNua(INTEGRACAO) })] }),
      new Map([[ANCORA, 7]]),
    );

    expect(canonico.tarefas).toHaveLength(1);
    expect(nu.tarefas).toHaveLength(1);
    expect(nu.tarefas[0]).toEqual(canonico.tarefas[0]);
  });

  it('QUASE-IGUAL — um id de integração diferente NÃO é esta conta, e é ignorado em SILÊNCIO', () => {
    const resultado = montar(
      familia({ links: [link({ contaProdutoShopeeOuterRef: refConta(OUTRA_CONTA) })] }),
      new Map([[ANCORA, 7]]),
    );

    expect(resultado.tarefas).toHaveLength(0);
    // ⚠️ `sem-link` porque NENHUM vínculo desta conta sobrou — nunca uma linha
    // sobre o vínculo da outra conta, que não é assunto desta varredura.
    expect(motivos(resultado)).toEqual([MOTIVO_ESTOQUE_SHOPEE.semLink]);
  });

  it('um vínculo de OUTRA conta ao lado do nosso é ignorado e não gera linha alguma', () => {
    const resultado = montar(
      familia({
        links: [
          link({ contaProdutoShopeeOuterRef: refConta(OUTRA_CONTA), linkDocId: OUTRO_LINK_DOC }),
          link(),
        ],
      }),
      new Map([[ANCORA, 7]]),
    );

    expect(resultado.tarefas).toHaveLength(1);
    expect(resultado.tarefas[0]?.linkDocId).toBe(LINK_DOC);
    expect(resultado.pulos).toEqual([]);
  });

  it('uma referência de conta ausente ou ilegível não é desta conta', () => {
    for (const bruto of [undefined, null, '', 42, 'sem-barra']) {
      const resultado = montar(
        familia({ links: [link({ contaProdutoShopeeOuterRef: bruto })] }),
        new Map([[ANCORA, 7]]),
      );
      expect(resultado.tarefas).toHaveLength(0);
      expect(motivos(resultado)).toEqual([MOTIVO_ESTOQUE_SHOPEE.semLink]);
    }
  });

  it('o produto fora do denorm da conta recusa a família inteira, com UMA linha', () => {
    const resultado = montar(
      familia({ integracoesComProduto: [OUTRA_CONTA] }),
      new Map([[ANCORA, 7]]),
    );

    expect(resultado.tarefas).toHaveLength(0);
    expect(resultado.pulos).toEqual([
      {
        produtoId: ANCORA,
        linkDocId: null,
        itemId: null,
        modelId: null,
        modelosAfetados: null,
        motivo: MOTIVO_ESTOQUE_SHOPEE.contaForaDoProduto,
        mensagem: MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.contaForaDoProduto],
      },
    ]);
  });

  it('um vínculo sem id de documento é defensivamente recusado como `sem-link`', () => {
    const resultado = montar(familia({ links: [link({ linkDocId: '' })] }), new Map([[ANCORA, 7]]));
    expect(resultado.tarefas).toHaveLength(0);
    expect(motivos(resultado)).toEqual([MOTIVO_ESTOQUE_SHOPEE.semLink]);
  });
});

/* -------------------------------------------------------------------------- */
/*                    (2) o anúncio SEM modelos — `model_id: 0`               */
/* -------------------------------------------------------------------------- */

describe('planoEstoque — anúncio sem modelos', () => {
  it('PAR — nenhum vínculo de variação aponta para este anúncio ⇒ UMA tarefa com `modelId: 0` e a quantidade do ÂNCORA', () => {
    const resultado = montar(familia(), new Map([[ANCORA, 7]]));

    expect(resultado.pulos).toEqual([]);
    expect(resultado.tarefas).toEqual([
      {
        integracaoId: INTEGRACAO,
        produtoId: ANCORA,
        linkDocId: LINK_DOC,
        itemId: ITEM_ID,
        categoryId: null,
        sweepId: SWEEP,
        sweepComputadoEmMs: COMPUTADO_EM,
        reenfileiramentos: 0,
        parte: 1,
        totalDePartes: 1,
        modelos: [{ modelId: 0, produtoId: ANCORA, varLinkDocId: null, quantidade: 7 }],
      },
    ]);
  });

  it('o `category_id` do vínculo viaja na tarefa quando é um inteiro positivo, e só então', () => {
    const com = montar(familia({ links: [link({ category_id: 100017 })] }), new Map([[ANCORA, 7]]));
    const sem = montar(familia({ links: [link({ category_id: 0 })] }), new Map([[ANCORA, 7]]));

    expect(com.tarefas[0]?.categoryId).toBe(100017);
    expect(sem.tarefas[0]?.categoryId).toBeNull();
  });

  it('sem quantidade para o âncora não há tarefa, e a linha nomeia o modelo 0', () => {
    const resultado = montar(familia(), new Map());

    expect(resultado.tarefas).toHaveLength(0);
    expect(resultado.pulos).toEqual([
      {
        produtoId: ANCORA,
        linkDocId: LINK_DOC,
        itemId: ITEM_ID,
        modelId: 0,
        modelosAfetados: null,
        motivo: MOTIVO_ESTOQUE_SHOPEE.familiaSemQuantidade,
        mensagem: MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.familiaSemQuantidade],
      },
    ]);
  });

  it('uma quantidade de ZERO é enviada — `0` não é "sem quantidade"', () => {
    const resultado = montar(familia(), new Map([[ANCORA, 0]]));
    expect(resultado.tarefas[0]?.modelos[0]?.quantidade).toBe(0);
    expect(resultado.pulos).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*          (3) o anúncio COM modelos — a atribuição por `prodshopee`          */
/* -------------------------------------------------------------------------- */

describe('planoEstoque — anúncio com modelos', () => {
  const doisFilhos = (): readonly FilhoDaFamilia[] => [
    filho(FILHO_A, [varLink({ model_id: MODEL_A, varLinkDocId: 'var-a' })]),
    filho(FILHO_B, [varLink({ model_id: MODEL_B, varLinkDocId: 'var-b' })]),
  ];

  it('PAR — dois filhos atribuídos a este `prodshopee` ⇒ UMA tarefa com dois modelos, cada um com a quantidade do FILHO', () => {
    const resultado = montar(
      familia({ children: doisFilhos() }),
      new Map([
        [ANCORA, 99],
        [FILHO_A, 3],
        [FILHO_B, 4],
      ]),
    );

    expect(resultado.pulos).toEqual([]);
    expect(resultado.tarefas).toHaveLength(1);
    expect(resultado.tarefas[0]?.modelos).toEqual([
      { modelId: MODEL_A, produtoId: FILHO_A, varLinkDocId: 'var-a', quantidade: 3 },
      { modelId: MODEL_B, produtoId: FILHO_B, varLinkDocId: 'var-b', quantidade: 4 },
    ]);
  });

  it('PAR — as duas codificações do `produtoShopeeOuterRef` apontam para o MESMO anúncio', () => {
    const resultado = montar(
      familia({
        children: [
          filho(FILHO_A, [
            varLink({ produtoShopeeOuterRef: refLinkNua(ANCORA, LINK_DOC), model_id: MODEL_A }),
          ]),
        ],
      }),
      new Map([[FILHO_A, 3]]),
    );

    expect(resultado.tarefas[0]?.modelos).toEqual([
      { modelId: MODEL_A, produtoId: FILHO_A, varLinkDocId: 'var-a', quantidade: 3 },
    ]);
  });

  it('QUASE-IGUAL — um vínculo de variação que nomeia OUTRO `prodshopee` do mesmo produto NÃO entra nesta tarefa', () => {
    const resultado = montar(
      familia({
        children: [
          filho(FILHO_A, [varLink({ model_id: MODEL_A })]),
          filho(FILHO_B, [
            varLink({
              produtoShopeeOuterRef: refLink(ANCORA, OUTRO_LINK_DOC),
              model_id: MODEL_B,
              varLinkDocId: 'var-b',
            }),
          ]),
        ],
      }),
      new Map([
        [FILHO_A, 3],
        [FILHO_B, 4],
      ]),
    );

    expect(resultado.tarefas).toHaveLength(1);
    expect(resultado.tarefas[0]?.modelos.map((m) => m.modelId)).toEqual([MODEL_A]);
  });

  it('dois `prodshopee` do mesmo produto recebem CADA UM os seus modelos, e nunca os do outro', () => {
    const resultado = montar(
      familia({
        links: [link(), link({ linkDocId: OUTRO_LINK_DOC, item_id: ITEM_ID + 1 })],
        children: [
          filho(FILHO_A, [varLink({ model_id: MODEL_A })]),
          filho(FILHO_B, [
            varLink({
              produtoShopeeOuterRef: refLink(ANCORA, OUTRO_LINK_DOC),
              model_id: MODEL_B,
              varLinkDocId: 'var-b',
            }),
          ]),
        ],
      }),
      new Map([
        [FILHO_A, 3],
        [FILHO_B, 4],
      ]),
    );

    expect(resultado.tarefas).toHaveLength(2);
    expect(resultado.tarefas[0]?.modelos.map((m) => m.modelId)).toEqual([MODEL_A]);
    expect(resultado.tarefas[1]?.modelos.map((m) => m.modelId)).toEqual([MODEL_B]);
    expect(resultado.pulos).toEqual([]);
  });

  it('um modelo marcado ausente é descartado ANTES do corte, e não deixa linha própria', () => {
    const resultado = montar(
      familia({
        children: [
          filho(FILHO_A, [varLink({ model_id: MODEL_A, modeloAusenteEm: AGORA - 1_000 })]),
          filho(FILHO_B, [varLink({ model_id: MODEL_B, varLinkDocId: 'var-b' })]),
        ],
      }),
      new Map([
        [FILHO_A, 3],
        [FILHO_B, 4],
      ]),
    );

    expect(resultado.tarefas[0]?.modelos.map((m) => m.modelId)).toEqual([MODEL_B]);
    expect(resultado.pulos).toEqual([]);
  });

  it('PAR — `0`, ausente, texto e fracionário são TODOS "sem modelo utilizável" num vínculo FILHO', () => {
    for (const bruto of [0, undefined, null, '2000458802', 2000458802.5, Number.NaN]) {
      const resultado = montar(
        familia({ children: [filho(FILHO_A, [varLink({ model_id: bruto })])] }),
        new Map([[FILHO_A, 3]]),
      );
      expect(resultado.tarefas).toHaveLength(0);
      expect(motivos(resultado)).toEqual([MOTIVO_ESTOQUE_SHOPEE.semModelos]);
    }
  });

  it('QUASE-IGUAL — dois ids de modelo que diferem de UM dígito continuam distintos', () => {
    const resultado = montar(
      familia({
        children: [
          filho(FILHO_A, [varLink({ model_id: MODEL_A })]),
          filho(FILHO_B, [varLink({ model_id: MODEL_A + 1, varLinkDocId: 'var-b' })]),
        ],
      }),
      new Map([
        [FILHO_A, 3],
        [FILHO_B, 4],
      ]),
    );

    expect(resultado.tarefas[0]?.modelos.map((m) => m.modelId)).toEqual([MODEL_A, MODEL_A + 1]);
  });

  it('dois vínculos com o MESMO `model_id` colapsam num único modelo — o primeiro', () => {
    const resultado = montar(
      familia({
        children: [
          filho(FILHO_A, [varLink({ model_id: MODEL_A, varLinkDocId: 'var-a' })]),
          filho(FILHO_B, [varLink({ model_id: MODEL_A, varLinkDocId: 'var-b' })]),
        ],
      }),
      new Map([
        [FILHO_A, 3],
        [FILHO_B, 4],
      ]),
    );

    expect(resultado.tarefas[0]?.modelos).toEqual([
      { modelId: MODEL_A, produtoId: FILHO_A, varLinkDocId: 'var-a', quantidade: 3 },
    ]);
    expect(resultado.pulos).toEqual([]);
  });

  it('um anúncio COM vínculos mas nenhum utilizável responde `sem-modelos`, não "sem variações"', () => {
    const resultado = montar(
      familia({
        children: [filho(FILHO_A, [varLink({ model_id: MODEL_A, modeloAusenteEm: AGORA })])],
      }),
      new Map([[FILHO_A, 3]]),
    );

    expect(resultado.tarefas).toHaveLength(0);
    expect(motivos(resultado)).toEqual([MOTIVO_ESTOQUE_SHOPEE.semModelos]);
    // ⚠️ E NUNCA a escrita de `modelId: 0` do anúncio sem variações: são dois
    // anúncios diferentes, e escrever 0 aqui apagaria o estoque do item inteiro.
    expect(resultado.tarefas).toEqual([]);
  });

  it('um filho sem quantidade tem o seu modelo omitido e ganha uma linha que o NOMEIA', () => {
    const resultado = montar(
      familia({ children: doisFilhos() }),
      new Map([[FILHO_A, 3]]), // FILHO_B não resolveu
    );

    expect(resultado.tarefas[0]?.modelos.map((m) => m.modelId)).toEqual([MODEL_A]);
    expect(resultado.pulos).toEqual([
      {
        produtoId: FILHO_B,
        linkDocId: LINK_DOC,
        itemId: ITEM_ID,
        modelId: MODEL_B,
        modelosAfetados: null,
        motivo: MOTIVO_ESTOQUE_SHOPEE.familiaSemQuantidade,
        mensagem: MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.familiaSemQuantidade],
      },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                        (4) o corte, e a sua fronteira                      */
/* -------------------------------------------------------------------------- */

describe('planoEstoque — o corte em partes', () => {
  function familiaComModelos(quantos: number): {
    row: LinhaDeFamiliaShopee;
    quantidades: Map<string, number>;
  } {
    const children: FilhoDaFamilia[] = [];
    const quantidades = new Map<string, number>();
    for (let i = 0; i < quantos; i += 1) {
      const produtoId = `filho-${i}`;
      children.push(
        filho(produtoId, [varLink({ model_id: MODEL_A + i, varLinkDocId: `var-${i}` })]),
      );
      quantidades.set(produtoId, i);
    }
    return { row: familia({ children }), quantidades };
  }

  it('exatamente no limite ⇒ UMA parte e NENHUMA linha de divisão (a fronteira)', () => {
    const { row, quantidades } = familiaComModelos(MAX_MODELOS_POR_TASK);
    const resultado = montar(row, quantidades);

    expect(resultado.tarefas).toHaveLength(1);
    expect(resultado.tarefas[0]?.parte).toBe(1);
    expect(resultado.tarefas[0]?.totalDePartes).toBe(1);
    expect(resultado.tarefas[0]?.modelos).toHaveLength(MAX_MODELOS_POR_TASK);
    expect(resultado.pulos).toEqual([]);
  });

  it('um a mais ⇒ DUAS partes (1/2 e 2/2) e UMA linha observável com a contagem', () => {
    const total = MAX_MODELOS_POR_TASK + 1;
    const { row, quantidades } = familiaComModelos(total);
    const resultado = montar(row, quantidades);

    expect(resultado.tarefas.map((t) => [t.parte, t.totalDePartes])).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(resultado.tarefas[0]?.modelos).toHaveLength(MAX_MODELOS_POR_TASK);
    expect(resultado.tarefas[1]?.modelos).toHaveLength(1);
    expect(resultado.pulos).toEqual([
      {
        produtoId: ANCORA,
        linkDocId: LINK_DOC,
        itemId: ITEM_ID,
        modelId: null,
        modelosAfetados: total,
        motivo: MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite,
        mensagem: MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite],
      },
    ]);
  });

  it('a divisão não perde nem repete um único modelo', () => {
    const total = MAX_MODELOS_POR_TASK + 1;
    const { row, quantidades } = familiaComModelos(total);
    const resultado = montar(row, quantidades);

    const ids = resultado.tarefas.flatMap((t) => t.modelos.map((m) => m.modelId));
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
    expect(contarModelosPlanejados(resultado)).toBe(total);
  });
});

/* -------------------------------------------------------------------------- */
/*                            (5) o portão por anúncio                        */
/* -------------------------------------------------------------------------- */

describe('planoEstoque — o portão por anúncio', () => {
  it('uma recusa do portão vira UMA linha com o motivo dele e a mensagem renderizada', () => {
    const resultado = montar(
      familia({ links: [link({ estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido })] }),
      new Map([[ANCORA, 7]]),
    );

    expect(resultado.tarefas).toHaveLength(0);
    expect(resultado.pulos).toEqual([
      {
        produtoId: ANCORA,
        linkDocId: LINK_DOC,
        itemId: ITEM_ID,
        modelId: null,
        modelosAfetados: null,
        motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioRemovido,
        mensagem: MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.anuncioRemovido],
      },
    ]);
  });

  it('`ignorarRecusa` CHEGA ao portão — a mesma família recusa sem ele e envia com ele', () => {
    // ⚠️ A impressão digital tem de carregar ao menos UMA leitura GRAVADA: o
    // mecanismo de ESTADO do portão não arma com as duas metades nulas (L2-1),
    // ou um carimbo que não anotou estado nenhum travaria o anúncio para
    // sempre. Sem isso este vínculo simplesmente ENVIA e o teste não teria o
    // que dispensar.
    const row = familia({
      links: [
        link({
          item_status: 'NORMAL',
          estoqueRecusaEm: AGORA - 1_000,
          estoqueRecusaItemStatus: 'NORMAL',
        }),
      ],
    });
    const quantidades = new Map([[ANCORA, 7]]);

    const sem = montar(row, quantidades);
    const com = montar(row, quantidades, { ignorarRecusa: true });

    expect(motivos(sem)).toEqual([MOTIVO_ESTOQUE_SHOPEE.recusaAnterior]);
    expect(com.tarefas).toHaveLength(1);
    expect(com.pulos).toEqual([]);
  });

  it('um `item_id` fracionário passa o portão e é recusado aqui, com o mesmo slug', () => {
    const resultado = montar(
      familia({ links: [link({ item_id: ITEM_ID + 0.5 })] }),
      new Map([[ANCORA, 7]]),
    );

    expect(resultado.tarefas).toHaveLength(0);
    expect(motivos(resultado)).toEqual([MOTIVO_ESTOQUE_SHOPEE.semItemId]);
  });

  it('a recusa de um anúncio não toca o outro anúncio da mesma família', () => {
    const resultado = montar(
      familia({
        links: [
          link({ estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.banido }),
          link({ linkDocId: OUTRO_LINK_DOC, item_id: ITEM_ID + 1 }),
        ],
      }),
      new Map([[ANCORA, 7]]),
    );

    expect(resultado.tarefas).toHaveLength(1);
    expect(resultado.tarefas[0]?.linkDocId).toBe(OUTRO_LINK_DOC);
    expect(motivos(resultado)).toEqual([MOTIVO_ESTOQUE_SHOPEE.anuncioBanido]);
  });
});

/* -------------------------------------------------------------------------- */
/*                        (6) o orçamento de corpo da tarefa                  */
/* -------------------------------------------------------------------------- */

describe('planoEstoque — o orçamento de corpo', () => {
  /** An anchor id long enough to push the encoded body past the budget. */
  const ANCORA_GIGANTE = 'x'.repeat(40_000);
  /** Long enough to cross the warn line and stay under the budget. */
  const ANCORA_GRANDE = 'y'.repeat(27_000);

  it('uma tarefa acima do orçamento é DESCARTADA e substituída por uma linha com a contagem', () => {
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resultado = montar(
      familia({ anchorId: ANCORA_GIGANTE, anchor: membro(ANCORA_GIGANTE) }),
      new Map([[ANCORA_GIGANTE, 7]]),
    );
    erro.mockRestore();

    expect(resultado.tarefas).toEqual([]);
    expect(resultado.pulos).toHaveLength(1);
    expect(resultado.pulos[0]?.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite);
    expect(resultado.pulos[0]?.modelosAfetados).toBe(1);
  });

  it('uma tarefa entre o aviso e o orçamento é CARREGADA, não descartada', () => {
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resultado = montar(
      familia({ anchorId: ANCORA_GRANDE, anchor: membro(ANCORA_GRANDE) }),
      new Map([[ANCORA_GRANDE, 7]]),
    );
    const chamadas = aviso.mock.calls.length;
    aviso.mockRestore();

    expect(resultado.tarefas).toHaveLength(1);
    expect(resultado.pulos).toEqual([]);
    expect(chamadas).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                   (7) `estoqueDesauditado` — o braço do passo 9            */
/* -------------------------------------------------------------------------- */

describe('estoqueDesauditado', () => {
  const JANELA = AGORA - 60_000;

  function movimentos(...chaves: readonly string[]): ReadonlyMap<string, MovimentoDaJanela> {
    return new Map(chaves.map((c) => [c, { dq: 1, dr: 0, desconhecido: false }] as const));
  }

  it('PAR — a linha própria mexeu dentro da janela e o ledger nada tem para o par ⇒ DESAUDITADA', () => {
    const member = membro(ANCORA, {
      estoque: { quantidade: 10, quantidadeReservada: 0, ultimaModificacao: JANELA + 1 },
    });
    expect(estoqueDesauditado(member, DEPOSITO, movimentos(), JANELA)).toBe(true);
  });

  it('QUASE-IGUAL — a MESMA linha, com um par no ledger ⇒ auditada', () => {
    const member = membro(ANCORA, {
      estoque: { quantidade: 10, quantidadeReservada: 0, ultimaModificacao: JANELA + 1 },
    });
    expect(
      estoqueDesauditado(member, DEPOSITO, movimentos(chaveMovimento(ANCORA, DEPOSITO)), JANELA),
    ).toBe(false);
  });

  it('QUASE-IGUAL — a mesma linha no OUTRO depósito não é o mesmo par', () => {
    const member = membro(ANCORA, {
      estoque: { quantidade: 10, quantidadeReservada: 0, ultimaModificacao: JANELA + 1 },
    });
    expect(
      estoqueDesauditado(member, DEPOSITO, movimentos(chaveMovimento(ANCORA, 'dep-2')), JANELA),
    ).toBe(true);
  });

  it('QUASE-IGUAL — uma linha FORA da janela não mexeu, e a fronteira é estrita', () => {
    const fora = membro(ANCORA, {
      estoque: { quantidade: 10, quantidadeReservada: 0, ultimaModificacao: JANELA - 1 },
    });
    const naBorda = membro(ANCORA, {
      estoque: { quantidade: 10, quantidadeReservada: 0, ultimaModificacao: JANELA },
    });
    const logoDepois = membro(ANCORA, {
      estoque: { quantidade: 10, quantidadeReservada: 0, ultimaModificacao: JANELA + 1 },
    });

    expect(estoqueDesauditado(fora, DEPOSITO, movimentos(), JANELA)).toBe(false);
    // ⚠️ A janela é `changedSinceMs`, nunca o relógio: exatamente no início da
    // janela a linha ainda é "de antes".
    expect(estoqueDesauditado(naBorda, DEPOSITO, movimentos(), JANELA)).toBe(false);
    expect(estoqueDesauditado(logoDepois, DEPOSITO, movimentos(), JANELA)).toBe(true);
  });

  it('QUASE-IGUAL — a linha de um IRMÃO dentro da janela não marca ESTE membro', () => {
    const irmaoMexeu = membro(FILHO_B, {
      estoque: { quantidade: 10, quantidadeReservada: 0, ultimaModificacao: JANELA + 1 },
    });
    const esteParado = membro(FILHO_A, {
      estoque: { quantidade: 10, quantidadeReservada: 0, ultimaModificacao: JANELA - 1 },
    });

    expect(estoqueDesauditado(irmaoMexeu, DEPOSITO, movimentos(), JANELA)).toBe(true);
    expect(estoqueDesauditado(esteParado, DEPOSITO, movimentos(), JANELA)).toBe(false);
  });

  it('um COMPONENTE dentro da janela sem par no ledger marca o membro', () => {
    const member = membro(ANCORA, {
      ehKit: true,
      componentEstoques: [
        {
          parentId: FILHO_A,
          quantidade: 5,
          quantidadeReservada: 0,
          ultimaModificacao: JANELA + 1,
        },
      ],
    });

    expect(estoqueDesauditado(member, DEPOSITO, movimentos(), JANELA)).toBe(true);
    expect(
      estoqueDesauditado(member, DEPOSITO, movimentos(chaveMovimento(FILHO_A, DEPOSITO)), JANELA),
    ).toBe(false);
  });

  it('uma linha sem chave de junção que mexeu é DESCONHECIDA, e falha para o lado do envio', () => {
    const member = membro(ANCORA, {
      componentEstoques: [{ quantidade: 5, quantidadeReservada: 0, ultimaModificacao: JANELA + 1 }],
    });
    expect(estoqueDesauditado(member, DEPOSITO, movimentos(), JANELA)).toBe(true);
  });

  it('um carimbo ilegível não marca nada', () => {
    for (const bruto of [undefined, null, 'ontem', Number.NaN, Number.POSITIVE_INFINITY]) {
      const member = membro(ANCORA, {
        estoque: { quantidade: 10, quantidadeReservada: 0, ultimaModificacao: bruto },
      });
      expect(estoqueDesauditado(member, DEPOSITO, movimentos(), JANELA)).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                   (8) `anterioresComDesauditado` — a OMISSÃO               */
/* -------------------------------------------------------------------------- */

describe('anterioresComDesauditado', () => {
  const JANELA = AGORA - 60_000;

  it('o membro desauditado está AUSENTE do mapa; os outros continuam lá', () => {
    const parado = membro(FILHO_A, {
      estoque: { quantidade: 10, quantidadeReservada: 0, ultimaModificacao: JANELA - 1 },
    });
    const desauditado = membro(FILHO_B, {
      estoque: { quantidade: 4, quantidadeReservada: 0, ultimaModificacao: JANELA + 1 },
    });
    const row = {
      anchor: parado,
      children: [desauditado],
    };
    const movimentos = new Map<string, MovimentoDaJanela>([
      [chaveMovimento(FILHO_A, DEPOSITO), { dq: 2, dr: 0, desconhecido: false }],
    ]);

    const comBraco = anterioresComDesauditado(row, DEPOSITO, movimentos, JANELA);
    expect(comBraco.has(FILHO_B)).toBe(false);
    expect(comBraco.get(FILHO_A)).toBe(8);
  });

  it('sem o braço, o membro do passo 9 entraria no mapa e leria como "não mexeu"', () => {
    const desauditado = membro(FILHO_B, {
      estoque: { quantidade: 4, quantidadeReservada: 0, ultimaModificacao: JANELA + 1 },
    });
    const row = { anchor: desauditado, children: [] };
    const vazio = new Map<string, MovimentoDaJanela>();

    // A fronteira: FORA da janela o mesmo documento continua no mapa — é assim
    // que o corte por mudança segue pagando o seu preço.
    const foraDaJanela = anterioresComDesauditado(
      {
        anchor: membro(FILHO_B, {
          estoque: { quantidade: 4, quantidadeReservada: 0, ultimaModificacao: JANELA - 1 },
        }),
        children: [],
      },
      DEPOSITO,
      vazio,
      JANELA,
    );

    expect(anterioresComDesauditado(row, DEPOSITO, vazio, JANELA).has(FILHO_B)).toBe(false);
    expect(foraDaJanela.get(FILHO_B)).toBe(4);
  });
});

/* -------------------------------------------------------------------------- */
/*                        (9) a invariante de completude                      */
/* -------------------------------------------------------------------------- */

describe('planoEstoque — a invariante de completude', () => {
  it('vale quando tudo bate', () => {
    expect(() =>
      conferirCompletudeDoAnuncio({
        linkDocId: LINK_DOC,
        itemId: ITEM_ID,
        usaveis: 3,
        planejados: 2,
        pulados: 1,
      }),
    ).not.toThrow();
  });

  it('LANÇA quando um modelo sumiu sem linha, e o erro nomeia o anúncio', () => {
    expect(() =>
      conferirCompletudeDoAnuncio({
        linkDocId: LINK_DOC,
        itemId: ITEM_ID,
        usaveis: 3,
        planejados: 2,
        pulados: 0,
      }),
    ).toThrow(new RegExp(`${ITEM_ID}`));
  });

  it('LANÇA também quando um modelo foi contado DUAS vezes', () => {
    expect(() =>
      conferirCompletudeDoAnuncio({
        linkDocId: LINK_DOC,
        itemId: ITEM_ID,
        usaveis: 2,
        planejados: 2,
        pulados: 1,
      }),
    ).toThrow();
  });

  it('o plano de uma família com tudo ao mesmo tempo continua completo e contável', () => {
    const resultado = montar(
      familia({
        children: [
          filho(FILHO_A, [varLink({ model_id: MODEL_A })]),
          filho(FILHO_B, [varLink({ model_id: MODEL_B, varLinkDocId: 'var-b' })]),
          filho('filho-c', [
            varLink({ model_id: MODEL_A, varLinkDocId: 'var-c' }), // duplicado
            varLink({ model_id: 0, varLinkDocId: 'var-d' }), // inutilizável
          ]),
        ],
      }),
      new Map([[FILHO_A, 3]]), // FILHO_B sem quantidade
    );

    expect(contarModelosPlanejados(resultado)).toBe(1);
    expect(motivos(resultado)).toEqual([MOTIVO_ESTOQUE_SHOPEE.familiaSemQuantidade]);
  });
});

/* -------------------------------------------------------------------------- */
/*              (10) as formas de linha que a descoberta vai construir         */
/* -------------------------------------------------------------------------- */

describe('planoEstoque — as formas de linha', () => {
  it('`LinhaDeFamiliaShopee` satisfaz estruturalmente a linha do núcleo promovido', () => {
    const row = familia({ children: [filho(FILHO_A, [varLink()])] });
    // Se esta atribuição parar de compilar, `quantidadesDaFamiliaShopee` e
    // `anterioresComDesauditado` deixam de aceitar a linha da descoberta.
    const doNucleo: { anchor: MembroDaFamilia; children: readonly MembroDaFamilia[] } = row;
    expect(doNucleo.children).toHaveLength(1);
    expect(doNucleo.anchor.produtoId).toBe(ANCORA);
  });

  it('`LinkShopeeCru` é aceito pelo portão sem nenhuma conversão', () => {
    const resultado = montar(familia(), new Map([[ANCORA, 1]]));
    expect(resultado.tarefas).toHaveLength(1);
  });
});
