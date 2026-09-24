/**
 * The pure half of `enviar:estoque` (#1520, step 12).
 *
 * ⚠️ Six of these are the only thing standing between a rehearsal and a leak, a
 * lie about the exit code, a `--live` that fires by accident, or a printed kit
 * fold that disagrees with the number actually sent — and none of them is a
 * happy path:
 *
 *  - **§2** pins the floor's SCOPE, not just that it applies: a floor ABOVE the
 *    quantity clamps, a floor EQUAL to it does NOT (the near-miss), and a floor
 *    of `0` is a real answer rather than an absent one;
 *  - **§3** pins that the kit fold is the SHARED arithmetic: it appears for a
 *    kit and not for a plain produto, and a component the join did not resolve
 *    reads `null` while `min` still scores it `0` (#238);
 *  - **§4** pins that both `--json` builders are ALLOW-LISTS — an extra key on
 *    the envelope, on a listing row and on a model row never reaches the output;
 *  - **§5** pins that the SCRIPT names `enviarEstoqueManualShopee` only below
 *    the `live` branch, and that the dry-run branch reaches no sender at all —
 *    the one mutant a unit test of the pure half cannot see;
 *  - **§5** also pins that neither branch marks an exit code, which is what the
 *    "200-even-when-every-listing-failed" parity with the route rests on;
 *  - **§6** pins that a throw is described by CLASS plus `code`/`path`, and
 *    never by a payload.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SHOPEE_ERROR_KIND, ShopeeApiError } from '@delfrance/integrations-shopee';

import type { ComponentesKit } from '@delfrance/schemas';

import {
  CODIGO_GUARDA_ENVIO,
  MENSAGEM_POR_MOTIVO,
  MOTIVO_ESTOQUE_SHOPEE,
  RESULTADO_MODELO,
  ShopeeEnvioEstoqueGuardError,
  type LinhaDeModeloEnviada,
  type MotivoEstoqueShopee,
} from './errosEstoque';
import type {
  EnvioEstoqueListing,
  EnvioEstoqueResponse,
  EnvioEstoqueSemEnvio,
} from './enviarEstoqueManual';
import {
  ArgumentoInvalidoError,
  CLAMPE_DO_PLANO,
  MSG_EXCEDE_LIMITE,
  MSG_PRODUTO_OBRIGATORIO,
  USO_ENVIAR_ESTOQUE,
  descreverErroEnvio,
  ehRecusaAntesDaShopee,
  dobraDeKit,
  lerArgsEnviarEstoque,
  modelosRecusadosDoEnvio,
  montarPlanoDeEnvio,
  renderizarPlanoDeEnvio,
  renderizarResultadoEnvio,
  resumoDoEnvio,
  resumoDoPlano,
  type EntradaDoPlano,
} from './enviarEstoqueCli';
import {
  montarTarefasDeEstoqueShopee,
  type LinhaDeFamiliaShopee,
  type LinkShopeeCru,
  type MembroDaFamilia,
  type ResultadoDoPlanoShopee,
  type TarefaDeEstoqueShopee,
} from './planoEstoque';
import { quantidadesDaFamiliaShopee } from './quantidadeEstoque';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real partner, shop, item or seller.  */
/* -------------------------------------------------------------------------- */

const INTEGRACAO = 'int-1';
const ANCORA = 'prod-a';
const ITEM_ID = 2500139861;
const MODEL_A = 2000458802;
const MODEL_B = 2000458803;
const LINK_DOC = 'link-1';
const AGORA = 1_760_000_000_000;

/** The composition root, read as TEXT — the only way to see what it calls where. */
const FONTE_SCRIPT = readFileSync(
  new URL('../../../scripts/enviar-estoque.ts', import.meta.url),
  'utf8',
);

/** The CLI half read as TEXT, for the assertions a behavioural test cannot make. */
const FONTE_CLI = readFileSync(new URL('./enviarEstoqueCli.ts', import.meta.url), 'utf8');

const PACOTE = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8');

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

function componentes(entradas: Record<string, { quantidade: number; limita?: boolean }>) {
  const saida: Record<string, { quantidade: number; limitarEstoque: boolean; timestamp: null }> =
    {};
  for (const [id, v] of Object.entries(entradas)) {
    saida[id] = { quantidade: v.quantidade, limitarEstoque: v.limita ?? true, timestamp: null };
  }
  return saida as ComponentesKit;
}

function link(extra: LinkShopeeCru = {}): LinkShopeeCru {
  return { linkDocId: LINK_DOC, item_id: ITEM_ID, ...extra };
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

function tarefa(extra: Partial<TarefaDeEstoqueShopee> = {}): TarefaDeEstoqueShopee {
  return {
    integracaoId: INTEGRACAO,
    produtoId: ANCORA,
    linkDocId: LINK_DOC,
    itemId: ITEM_ID,
    categoryId: null,
    sweepId: 'ensaio-1',
    sweepComputadoEmMs: AGORA,
    reenfileiramentos: 0,
    parte: 1,
    totalDePartes: 1,
    modelos: [{ modelId: MODEL_A, produtoId: ANCORA, varLinkDocId: 'var-a', quantidade: 7 }],
    ...extra,
  };
}

function plano(extra: Partial<ResultadoDoPlanoShopee> = {}): ResultadoDoPlanoShopee {
  return { tarefas: [tarefa()], pulos: [], ...extra };
}

function entrada(extra: Partial<EntradaDoPlano> = {}): EntradaDoPlano {
  return { produtoId: ANCORA, produtoNome: 'Camiseta', row: familia(), plano: plano(), ...extra };
}

function pisos(map: Record<number, number>): ReadonlyMap<number, ReadonlyMap<number, number>> {
  const porModelo = new Map<number, number>(
    Object.entries(map).map(([k, v]): [number, number] => [Number(k), v]),
  );
  return new Map<number, ReadonlyMap<number, number>>([[ITEM_ID, porModelo]]);
}

const SEM_PISO: ReadonlyMap<number, ReadonlyMap<number, number>> = new Map();

function modeloEnviado(extra: Partial<LinhaDeModeloEnviada> = {}): LinhaDeModeloEnviada {
  return {
    modelId: MODEL_A,
    produtoId: ANCORA,
    varLinkDocId: 'var-a',
    quantidadeSolicitada: 7,
    quantidadeEnviada: 7,
    resultado: RESULTADO_MODELO.enviado,
    motivo: null,
    codigo: null,
    mensagem: 'ok',
    clampado: false,
    piso: null,
    ...extra,
  };
}

function listagem(extra: Partial<EnvioEstoqueListing> = {}): EnvioEstoqueListing {
  return {
    produtoId: ANCORA,
    produtoNome: 'Camiseta',
    variacaoProdutoId: null,
    anuncioId: String(ITEM_ID),
    linkDocId: LINK_DOC,
    outcome: 'enviado',
    motivo: null,
    mensagem: 'Estoque enviado à Shopee.',
    quantidade: 7,
    variacoes: [modeloEnviado()],
    modelosRecusados: 0,
    clampados: 0,
    rearme: null,
    ...extra,
  };
}

function envelope(extra: Partial<EnvioEstoqueResponse> = {}): EnvioEstoqueResponse {
  return {
    canal: 'shopee',
    integracaoId: INTEGRACAO,
    contaNome: 'Loja de teste',
    solicitados: 1,
    familias: 1,
    resumo: { enviados: 1, pulados: 0, falhas: 0, naoTentados: 0 },
    listings: [listagem()],
    produtosSemEnvio: [],
    pausadoAte: null,
    ...extra,
  };
}

function semEnvio(extra: Partial<EnvioEstoqueSemEnvio> = {}): EnvioEstoqueSemEnvio {
  return {
    produtoId: 'prod-z',
    produtoNome: null,
    motivo: MOTIVO_ESTOQUE_SHOPEE.semLink,
    mensagem: MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.semLink],
    ...extra,
  };
}

/* ========================================================================== */
/*  1 · os argumentos                                                         */
/* ========================================================================== */

describe('lerArgsEnviarEstoque', () => {
  it('o padrão é DRY-RUN, sem json, sem reenvio e sem projeto', () => {
    const cmd = lerArgsEnviarEstoque(['--integracao', INTEGRACAO, '--produto', ANCORA]);
    expect(cmd.kind).toBe('enviar');
    if (cmd.kind !== 'enviar') throw new Error('esperava enviar');
    expect(cmd.args).toEqual({
      integracaoId: INTEGRACAO,
      produtoIds: [ANCORA],
      reenviarComErro: false,
      live: false,
      json: false,
      projectId: null,
    });
  });

  it('--produto é REPETÍVEL, mantém a ordem e tira os repetidos', () => {
    const cmd = lerArgsEnviarEstoque([
      '--integracao',
      INTEGRACAO,
      '--produto',
      'prod-b',
      '--produto',
      'prod-a',
      '--produto',
      'prod-b',
    ]);
    if (cmd.kind !== 'enviar') throw new Error('esperava enviar');
    expect(cmd.args.produtoIds).toEqual(['prod-b', 'prod-a']);
  });

  it('a forma inline --flag=valor vale para integração e produto', () => {
    const cmd = lerArgsEnviarEstoque([
      `--integracao=${INTEGRACAO}`,
      '--produto=prod-a',
      '--live',
      '--json',
      '--reenviar-com-erro',
      '--project=projeto-de-teste',
    ]);
    if (cmd.kind !== 'enviar') throw new Error('esperava enviar');
    expect(cmd.args.live).toBe(true);
    expect(cmd.args.json).toBe(true);
    expect(cmd.args.reenviarComErro).toBe(true);
    expect(cmd.args.projectId).toBe('projeto-de-teste');
  });

  it('⛔ --live e --dry-run juntos são RECUSADOS, nunca resolvidos por precedência', () => {
    expect(() =>
      lerArgsEnviarEstoque([
        '--integracao',
        INTEGRACAO,
        '--produto',
        ANCORA,
        '--live',
        '--dry-run',
      ]),
    ).toThrow(ArgumentoInvalidoError);
  });

  it('--help responde ANTES de qualquer validação, mesmo sem as flags obrigatórias', () => {
    expect(lerArgsEnviarEstoque(['--help']).kind).toBe('ajuda');
    expect(lerArgsEnviarEstoque(['-h']).kind).toBe('ajuda');
    expect(lerArgsEnviarEstoque(['--produto', '..', '--help']).kind).toBe('ajuda');
  });

  it('sem --produto e sem --integracao as duas recusas têm sentença própria', () => {
    expect(() => lerArgsEnviarEstoque(['--integracao', INTEGRACAO])).toThrow(
      MSG_PRODUTO_OBRIGATORIO,
    );
    expect(() => lerArgsEnviarEstoque(['--produto', ANCORA])).toThrow('--integracao');
  });

  it('⛔ um id que endereça outro caminho é recusado pela MESMA regra das rotas', () => {
    expect(() => lerArgsEnviarEstoque(['--integracao', INTEGRACAO, '--produto', '..'])).toThrow(
      ArgumentoInvalidoError,
    );
    expect(() => lerArgsEnviarEstoque(['--integracao', INTEGRACAO, '--produto', 'a/b'])).toThrow(
      /não é um id de documento/,
    );
  });

  it('o separador "--" e uma opção desconhecida são recusados', () => {
    expect(() => lerArgsEnviarEstoque(['--integracao', INTEGRACAO, '--'])).toThrow(/pnpm repassa/);
    expect(() => lerArgsEnviarEstoque(['--integracao', INTEGRACAO, '--turbo'])).toThrow(
      'Opção desconhecida: --turbo',
    );
  });

  it('PAR/QUASE: 51 distintos excedem o limite, 51 flags com 50 distintos NÃO', () => {
    const flags = (n: number, repetir = false): string[] => {
      const args = ['--integracao', INTEGRACAO];
      for (let i = 0; i < n; i += 1) args.push('--produto', `prod-${String(i)}`);
      if (repetir) args.push('--produto', 'prod-0');
      return args;
    };
    expect(() => lerArgsEnviarEstoque(flags(51))).toThrow(MSG_EXCEDE_LIMITE);
    const cmd = lerArgsEnviarEstoque(flags(50, true));
    if (cmd.kind !== 'enviar') throw new Error('esperava enviar');
    expect(cmd.args.produtoIds).toHaveLength(50);
  });
});

/* ========================================================================== */
/*  2 · o piso: o ESCOPO da dobra, não só que ela se aplica                   */
/* ========================================================================== */

describe('o piso no plano', () => {
  it('PAR: um piso ACIMA da quantidade clampa, e "envia" passa a ser o piso', () => {
    const p = montarPlanoDeEnvio([entrada()], {
      integracaoId: INTEGRACAO,
      pisoPorItem: pisos({ [MODEL_A]: 9 }),
    });
    const m = p.listagens[0]?.modelos[0];
    expect(m?.quantidade).toBe(7);
    expect(m?.envia).toBe(9);
    expect(m?.piso).toBe(9);
    expect(m?.clampeado).toBe(CLAMPE_DO_PLANO.piso);
  });

  it('QUASE-ERRO: um piso IGUAL à quantidade não é clampe — nada foi publicado acima do ERP', () => {
    const p = montarPlanoDeEnvio([entrada()], {
      integracaoId: INTEGRACAO,
      pisoPorItem: pisos({ [MODEL_A]: 7 }),
    });
    const m = p.listagens[0]?.modelos[0];
    expect(m?.envia).toBe(7);
    expect(m?.clampeado).toBe(CLAMPE_DO_PLANO.nenhum);
  });

  it('QUASE-ERRO: um piso de 0 é uma RESPOSTA, não uma ausência (`?? null`, nunca `||`)', () => {
    const p = montarPlanoDeEnvio([entrada()], {
      integracaoId: INTEGRACAO,
      pisoPorItem: pisos({ [MODEL_A]: 0 }),
    });
    const m = p.listagens[0]?.modelos[0];
    expect(m?.piso).toBe(0);
    expect(m?.envia).toBe(7);
    expect(m?.clampeado).toBe(CLAMPE_DO_PLANO.nenhum);
  });

  it('sem promoção o piso é null e a coluna fica vazia', () => {
    const p = montarPlanoDeEnvio([entrada()], { integracaoId: INTEGRACAO, pisoPorItem: SEM_PISO });
    expect(p.listagens[0]?.modelos[0]?.piso).toBeNull();
    expect(p.listagens[0]?.modelos[0]?.clampeado).toBe(CLAMPE_DO_PLANO.nenhum);
  });

  it('PAR/QUASE: com banda resolvida um piso ACIMA dela vira "banda"; sem banda, nunca', () => {
    const comBanda = montarPlanoDeEnvio([entrada()], {
      integracaoId: INTEGRACAO,
      pisoPorItem: pisos({ [MODEL_A]: 9 }),
      bandaPorItem: new Map([[ITEM_ID, 8]]),
    });
    expect(comBanda.listagens[0]?.modelos[0]?.clampeado).toBe(CLAMPE_DO_PLANO.banda);
    const semBanda = montarPlanoDeEnvio([entrada()], {
      integracaoId: INTEGRACAO,
      pisoPorItem: pisos({ [MODEL_A]: 9 }),
      bandaPorItem: new Map([[ITEM_ID, null]]),
    });
    expect(semBanda.listagens[0]?.modelos[0]?.clampeado).toBe(CLAMPE_DO_PLANO.piso);
  });

  it('⚠️ model_id 0 é o anúncio SEM variação e atravessa o plano inteiro', () => {
    const p = montarPlanoDeEnvio(
      [
        entrada({
          plano: plano({
            tarefas: [
              tarefa({
                modelos: [{ modelId: 0, produtoId: ANCORA, varLinkDocId: null, quantidade: 0 }],
              }),
            ],
          }),
        }),
      ],
      { integracaoId: INTEGRACAO, pisoPorItem: pisos({ 0: 3 }) },
    );
    const m = p.listagens[0]?.modelos[0];
    expect(m?.modelId).toBe(0);
    expect(m?.quantidade).toBe(0);
    // O piso da chave 0 é lido: um `if (modelId)` em qualquer ponto perderia isto.
    expect(m?.piso).toBe(3);
    expect(m?.envia).toBe(3);
  });
});

/* ========================================================================== */
/*  3 · a dobra do kit — a MESMA aritmética que produz a quantidade           */
/* ========================================================================== */

describe('a dobra do kit', () => {
  const kitAnchor = membro(ANCORA, {
    ehKit: true,
    componentesKit: componentes({ 'comp-1': { quantidade: 2 }, 'comp-2': { quantidade: 1 } }),
    componentEstoques: [
      { estoqueDocId: 'e1', parentId: 'comp-1', quantidade: 14, quantidadeReservada: 0 },
      { estoqueDocId: 'e2', parentId: 'comp-2', quantidade: 9, quantidadeReservada: 0 },
    ],
  });

  it('PAR: um kit rende uma dobra com o min e uma linha por componente', () => {
    const dobra = dobraDeKit(kitAnchor);
    expect(dobra?.min).toBe(7);
    expect(dobra?.componentes).toHaveLength(2);
    expect(dobra?.componentes[0]).toEqual({
      componenteId: 'comp-1',
      disponivel: 14,
      limita: true,
      porKit: 2,
    });
  });

  it('QUASE-ERRO: um produto simples NÃO rende dobra nenhuma', () => {
    expect(dobraDeKit(membro('prod-simples'))).toBeNull();
  });

  it('⚠️ um componente que o join NÃO trouxe lê null — e o min conta 0 (#238)', () => {
    const dobra = dobraDeKit(
      membro(ANCORA, {
        ehKit: true,
        componentesKit: componentes({ 'comp-1': { quantidade: 2 } }),
        componentEstoques: [],
      }),
    );
    expect(dobra?.componentes[0]?.disponivel).toBeNull();
    expect(dobra?.componentes[0]?.limita).toBe(true);
    expect(dobra?.min).toBe(0);
  });

  it('um componente com limitarEstoque=false aparece com limita:não e não entra no min', () => {
    const dobra = dobraDeKit(
      membro(ANCORA, {
        ehKit: true,
        componentesKit: componentes({
          'comp-1': { quantidade: 2 },
          'comp-2': { quantidade: 5, limita: false },
        }),
        componentEstoques: [
          { estoqueDocId: 'e1', parentId: 'comp-1', quantidade: 14, quantidadeReservada: 0 },
          { estoqueDocId: 'e2', parentId: 'comp-2', quantidade: 0, quantidadeReservada: 0 },
        ],
      }),
    );
    expect(dobra?.componentes.find((c) => c.componenteId === 'comp-2')?.limita).toBe(false);
    expect(dobra?.min).toBe(7);
  });

  it('PAR/QUASE no PLANO: as linhas da dobra saem para um kit e não para um produto simples', () => {
    const comKit = montarPlanoDeEnvio([entrada({ row: familia({ anchor: kitAnchor }) })], {
      integracaoId: INTEGRACAO,
      pisoPorItem: SEM_PISO,
    });
    expect(comKit.listagens[0]?.kits).toHaveLength(1);
    const textoKit = renderizarPlanoDeEnvio(comKit).join('\n');
    expect(textoKit).toContain('a conta que produz a quantidade');
    expect(textoKit).toContain('comp-1');
    expect(textoKit).toContain('min = 7');

    const semKit = montarPlanoDeEnvio([entrada()], {
      integracaoId: INTEGRACAO,
      pisoPorItem: SEM_PISO,
    });
    expect(semKit.listagens[0]?.kits).toHaveLength(0);
    expect(renderizarPlanoDeEnvio(semKit).join('\n')).not.toContain(
      'a conta que produz a quantidade',
    );
  });

  it('a dobra só sai para os membros cujo estoque ESTA chamada carrega', () => {
    // O filho é kit, mas nenhum modelo desta tarefa nomeia o produto dele.
    const p = montarPlanoDeEnvio(
      [
        entrada({
          row: familia({
            children: [
              {
                ...membro('prod-filho', {
                  ehKit: true,
                  componentesKit: componentes({ 'comp-9': { quantidade: 1 } }),
                }),
                varLinks: [],
              },
            ],
          }),
        }),
      ],
      { integracaoId: INTEGRACAO, pisoPorItem: SEM_PISO },
    );
    expect(p.listagens[0]?.kits).toHaveLength(0);
  });
});

/* ========================================================================== */
/*  4 · o plano: contabilidade, motivos e os resumos allow-list               */
/* ========================================================================== */

describe('montarPlanoDeEnvio', () => {
  it('lê estadoAnuncio e kitNativo do VÍNCULO que a tarefa nomeia', () => {
    const p = montarPlanoDeEnvio(
      [
        entrada({
          row: familia({
            links: [
              link({ linkDocId: 'outro', estadoAnuncio: 'pausado', kitNativo: true }),
              link({ estadoAnuncio: 'ativo', kitNativo: false }),
            ],
          }),
        }),
      ],
      { integracaoId: INTEGRACAO, pisoPorItem: SEM_PISO },
    );
    expect(p.listagens[0]?.estadoAnuncio).toBe('ativo');
    expect(p.listagens[0]?.kitNativo).toBe(false);
  });

  it('um produto que a descoberta não devolveu vira UM pulo produto-nao-encontrado', () => {
    const p = montarPlanoDeEnvio([entrada({ row: null, plano: null })], {
      integracaoId: INTEGRACAO,
      pisoPorItem: SEM_PISO,
    });
    expect(p.familias).toBe(0);
    expect(p.listagens).toHaveLength(0);
    expect(p.pulos[0]?.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado);
    expect(p.pulos[0]?.mensagem).toBe(
      MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado],
    );
  });

  it('PAR/QUASE: só um documento INEXISTENTE é produto-nao-encontrado — uma VARIAÇÃO volta como linha e o planejador a recusa por outro motivo', () => {
    // A frase de `produto-nao-encontrado` diz só "não foi encontrado no ERP", e
    // é isto que a torna verdadeira: o leitor por ids não aplica predicado de
    // âncora, então o id de uma variação existente VOLTA como linha e cai num
    // degrau do planejador REAL — `conta-fora-do-produto` quando a variação não
    // carrega a conta (o gatilho da Shopee só carimba o produto do vínculo, a
    // âncora), `sem-link` quando carrega mas não tem vínculo próprio.
    const opcoes = {
      integracaoId: INTEGRACAO,
      sweepId: 'ensaio-1',
      sweepComputadoEmMs: AGORA,
      nowMs: AGORA,
    };
    const daVariacao = (row: LinhaDeFamiliaShopee): EntradaDoPlano => ({
      produtoId: row.anchorId,
      produtoNome: null,
      row,
      plano: montarTarefasDeEstoqueShopee(row, quantidadesDaFamiliaShopee(row), opcoes),
    });
    const variacao = { anchorId: 'prod-filho', anchor: membro('prod-filho'), links: [] };

    const p = montarPlanoDeEnvio(
      [
        entrada({ produtoId: 'prod-sumido', produtoNome: null, row: null, plano: null }),
        daVariacao(familia({ ...variacao, integracoesComProduto: [] })),
        daVariacao(familia(variacao)),
      ],
      { integracaoId: INTEGRACAO, pisoPorItem: SEM_PISO },
    );

    expect(p.pulos.map((pulo) => [pulo.produtoId, pulo.motivo])).toEqual([
      ['prod-sumido', MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado],
      ['prod-filho', MOTIVO_ESTOQUE_SHOPEE.contaForaDoProduto],
      ['prod-filho', MOTIVO_ESTOQUE_SHOPEE.semLink],
    ]);
    expect(p.familias).toBe(2);
  });

  it('os totais agrupam por motivo e o "recusa" vem de ehRecusa, nunca de uma lista de slugs', () => {
    const pulo = (motivo: (typeof MOTIVO_ESTOQUE_SHOPEE)[keyof typeof MOTIVO_ESTOQUE_SHOPEE]) => ({
      produtoId: ANCORA,
      linkDocId: LINK_DOC,
      itemId: ITEM_ID,
      modelId: null,
      modelosAfetados: null,
      motivo,
      mensagem: MENSAGEM_POR_MOTIVO[motivo],
    });
    const p = montarPlanoDeEnvio(
      [
        entrada({
          plano: plano({
            tarefas: [],
            pulos: [
              pulo(MOTIVO_ESTOQUE_SHOPEE.anuncioRemovido),
              pulo(MOTIVO_ESTOQUE_SHOPEE.anuncioRemovido),
              pulo(MOTIVO_ESTOQUE_SHOPEE.clampadoNaReserva),
            ],
          }),
        }),
      ],
      { integracaoId: INTEGRACAO, pisoPorItem: SEM_PISO },
    );
    expect(p.totaisPorMotivo[0]).toEqual({
      motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioRemovido,
      mensagem: MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.anuncioRemovido],
      recusa: true,
      total: 2,
    });
    // ⚠️ O clampe é uma ANOTAÇÃO: contá-lo como recusa reportaria todo envio
    // clampado como falha.
    expect(p.totaisPorMotivo[1]?.recusa).toBe(false);
  });

  it('a mensagem do pulo é a do PLANEJADOR, nunca re-escrita aqui', () => {
    const p = montarPlanoDeEnvio(
      [
        entrada({
          plano: plano({
            tarefas: [],
            pulos: [
              {
                produtoId: ANCORA,
                linkDocId: null,
                itemId: null,
                modelId: null,
                modelosAfetados: 4,
                motivo: MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite,
                mensagem: 'sentença que veio do planejador',
              },
            ],
          }),
        }),
      ],
      { integracaoId: INTEGRACAO, pisoPorItem: SEM_PISO },
    );
    expect(p.pulos[0]?.mensagem).toBe('sentença que veio do planejador');
    expect(p.pulos[0]?.modelosAfetados).toBe(4);
  });

  it('⛔ resumoDoPlano é ALLOW-LIST: uma chave extra na listagem e no modelo não sai', () => {
    const sujo = montarPlanoDeEnvio([entrada()], {
      integracaoId: INTEGRACAO,
      pisoPorItem: SEM_PISO,
    });
    const injetado = {
      ...sujo,
      segredoDoEnvelope: 'nao-deve-sair',
      listagens: sujo.listagens.map((l) => ({
        ...l,
        segredoDaListagem: 'nao-deve-sair',
        modelos: l.modelos.map((m) => ({ ...m, segredoDoModelo: 'nao-deve-sair' })),
      })),
    } as unknown as Parameters<typeof resumoDoPlano>[0];
    const texto = JSON.stringify(resumoDoPlano(injetado));
    expect(texto).not.toContain('nao-deve-sair');
    expect(texto).toContain('"clampeado"');
  });

  it('o tamanho da task é medido e comparado com o orçamento', () => {
    const p = montarPlanoDeEnvio([entrada()], {
      integracaoId: INTEGRACAO,
      pisoPorItem: SEM_PISO,
    });
    expect(p.listagens[0]?.bytes).toBeGreaterThan(0);
    expect(p.avisoBytes).toBeLessThan(p.orcamentoBytes);
    expect(renderizarPlanoDeEnvio(p).join('\n')).toContain('orçamento da task');
  });

  it('um plano sem nenhum anúncio é uma RESPOSTA e diz que nada seria enviado', () => {
    const p = montarPlanoDeEnvio([entrada({ plano: plano({ tarefas: [] }) })], {
      integracaoId: INTEGRACAO,
      pisoPorItem: SEM_PISO,
    });
    expect(renderizarPlanoDeEnvio(p).join('\n')).toContain('NENHUM — nada seria enviado');
  });
});

/* ========================================================================== */
/*  5 · o envelope do --live                                                  */
/* ========================================================================== */

describe('renderizarResultadoEnvio', () => {
  it('imprime o resumo, a linha do anúncio e uma linha por modelo', () => {
    const texto = renderizarResultadoEnvio(envelope()).join('\n');
    expect(texto).toContain(INTEGRACAO);
    expect(texto).toContain('Loja de teste');
    expect(texto).toContain(String(ITEM_ID));
    expect(texto).toContain(String(MODEL_A));
    expect(texto).toContain('### produtos sem envio: NENHUM');
  });

  it('⚠️ a linha do anúncio carrega o NOME do produto, como a de "sem envio"', () => {
    // Os dois cabeçalhos de arquivo afirmam que o nome é impresso de propósito
    // — "a única coisa que deixa um humano distinguir uma linha da outra" — e o
    // relatório do --live era a única das quatro superfícies que identificava
    // uma linha ENVIADA só pelo id opaco do documento.
    const linhas = renderizarResultadoEnvio(
      envelope({ listings: [listagem({ produtoNome: 'Camiseta Polo Azul' })] }),
    );
    const linhaDoAnuncio = linhas.find((l) => l.includes(String(ITEM_ID))) ?? '';
    expect(linhaDoAnuncio).toContain('Camiseta Polo Azul');

    // ⚠️ NEAR-MISS: sem nome, a coluna existe e diz "sem nome" — a mesma
    // convenção da tabela de "produtos sem envio", nunca um branco.
    const semNome = renderizarResultadoEnvio(
      envelope({ listings: [listagem({ produtoNome: null })] }),
    ).find((l) => l.includes(String(ITEM_ID)));
    expect(semNome).toContain('sem nome');
  });

  it('⚠️ um envio LIMPO com clampe continua "enviado" — o motivo é uma anotação', () => {
    const texto = renderizarResultadoEnvio(
      envelope({
        listings: [
          listagem({
            motivo: MOTIVO_ESTOQUE_SHOPEE.clampadoNaReserva,
            mensagem: MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.clampadoNaReserva],
            clampados: 1,
            variacoes: [modeloEnviado({ clampado: true, piso: 9, quantidadeEnviada: 9 })],
          }),
        ],
      }),
    ).join('\n');
    expect(texto).toContain('enviado');
    expect(texto).toContain('clampado piso=9');
    expect(texto).toContain(MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.clampadoNaReserva]);
  });

  it('conta os modelos recusados pelo RESULTADO de cada modelo', () => {
    expect(
      modelosRecusadosDoEnvio(
        envelope({
          listings: [
            listagem({
              variacoes: [
                modeloEnviado(),
                modeloEnviado({
                  modelId: MODEL_B,
                  resultado: RESULTADO_MODELO.recusado,
                  quantidadeEnviada: null,
                }),
              ],
            }),
          ],
        }),
      ),
    ).toBe(1);
  });

  it('a pausa e os produtos sem envio aparecem com a sentença que veio pronta', () => {
    const texto = renderizarResultadoEnvio(
      envelope({ pausadoAte: '2026-09-21T12:00:00.000Z', produtosSemEnvio: [semEnvio()] }),
    ).join('\n');
    expect(texto).toContain('2026-09-21T12:00:00.000Z');
    expect(texto).toContain(MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.semLink]);
  });

  it('⛔ resumoDoEnvio é ALLOW-LIST nos TRÊS níveis: envelope, listagem e modelo', () => {
    const injetado = {
      ...envelope(),
      segredoDoEnvelope: 'nao-deve-sair',
      listings: [
        {
          ...listagem(),
          segredoDaListagem: 'nao-deve-sair',
          variacoes: [{ ...modeloEnviado(), segredoDoModelo: 'nao-deve-sair' }],
        },
      ],
      produtosSemEnvio: [{ ...semEnvio(), segredoSemEnvio: 'nao-deve-sair' }],
    } as unknown as EnvioEstoqueResponse;
    const texto = JSON.stringify(resumoDoEnvio(injetado));
    expect(texto).not.toContain('nao-deve-sair');
    expect(texto).toContain('"canal":"shopee"');
    // `rearme` e `variacaoProdutoId` são permanentemente null e não interessam ao
    // terminal — a allow-list é a razão de não estarem lá.
    expect(texto).not.toContain('rearme');
  });
});

/* ========================================================================== */
/*  6 · o script: --live só dentro do ramo live, e nenhum exitCode nos ramos  */
/* ========================================================================== */

describe('scripts/enviar-estoque.ts', () => {
  const RAMO_DRY = FONTE_SCRIPT.slice(
    FONTE_SCRIPT.indexOf('if (!live) {'),
    FONTE_SCRIPT.indexOf('/* ---------------------------------- live'),
  );
  const RAMO_LIVE = FONTE_SCRIPT.slice(
    FONTE_SCRIPT.indexOf('/* ---------------------------------- live'),
    FONTE_SCRIPT.indexOf('await main().catch('),
  );

  it('⛔ só chama enviarEstoqueManualShopee DEPOIS do ramo do dry-run, e uma vez só', () => {
    // O mutante é mover a chamada para o caminho padrão: uma rehearsal passaria
    // a escrever estoque de verdade sem ninguém pedir `--live`.
    const guarda = FONTE_SCRIPT.indexOf('if (!live) {');
    const chamada = FONTE_SCRIPT.indexOf('await enviarEstoqueManualShopee(');
    expect(guarda).toBeGreaterThan(0);
    expect(chamada).toBeGreaterThan(guarda);
    expect(FONTE_SCRIPT.match(/await enviarEstoqueManualShopee\(/g)).toHaveLength(1);
  });

  it('⛔ o ramo do dry-run nomeia o PLANEJADOR e NENHUM remetente', () => {
    expect(RAMO_DRY.length).toBeGreaterThan(0);
    expect(RAMO_DRY).toContain('montarTarefasDeEstoqueShopee(');
    expect(RAMO_DRY).toContain('buscarFamiliasShopeePorIds(');
    expect(RAMO_DRY).toContain('getItemPromotion(');
    expect(RAMO_DRY).not.toContain('enviarEstoqueManualShopee');
    expect(RAMO_DRY).not.toContain('processShopeeStockSendTask');
    expect(RAMO_DRY).not.toContain('updateStock(');
  });

  it('⚠️ nenhum dos dois ramos marca código de saída — é nisso que o exit 0 se apoia', () => {
    expect(RAMO_DRY).not.toContain('process.exitCode');
    expect(RAMO_LIVE.length).toBeGreaterThan(0);
    expect(RAMO_LIVE).not.toContain('process.exitCode');
    // As duas únicas marcações: a conta sem shop_id e o catch de main().
    expect(FONTE_SCRIPT.match(/process\.exitCode = 1/g)).toHaveLength(2);
    expect(FONTE_SCRIPT.slice(0, FONTE_SCRIPT.indexOf('if (!live) {'))).toContain('shop_id');
  });

  it('devolve na ajuda ANTES do primeiro await import', () => {
    const ajuda = FONTE_SCRIPT.indexOf("comando.kind === 'ajuda'");
    const primeiroImport = FONTE_SCRIPT.indexOf('await import(');
    expect(ajuda).toBeGreaterThan(0);
    expect(primeiroImport).toBeGreaterThan(0);
    expect(ajuda).toBeLessThan(primeiroImport);
  });

  it('o preâmbulo lê os dois valores BRUTOS e diz que o envio manual ignora a válvula', () => {
    expect(FONTE_SCRIPT).toContain('SHOPEE_SANDBOX');
    expect(FONTE_SCRIPT).toContain('o envio manual IGNORA esta flag');
    // O nome da válvula vem da constante, nunca de uma segunda grafia.
    expect(FONTE_SCRIPT).toContain('process.env[SHOPEE_STOCK_SYNC_FLAG_ENV]');
  });

  it('o texto de uso NÃO documenta o separador "--" e não carrega id real', () => {
    // `pnpm-run-args.test.js` derruba a CI nessa grafia, e o comando morreria no
    // próprio separador.
    expect(USO_ENVIAR_ESTOQUE).not.toMatch(/pnpm .*[^ ] -- +-/);
    expect(USO_ENVIAR_ESTOQUE).toContain('enviar:estoque');
    expect(USO_ENVIAR_ESTOQUE).toContain('É o PADRÃO');
    expect(USO_ENVIAR_ESTOQUE).not.toMatch(/partner_key|shop_id|token|secret/i);
  });

  it('⛔ nenhum dos dois arquivos carrega uma sequência de 6+ dígitos', () => {
    // Um id de item, de modelo, de loja ou de parceiro tem essa forma. O único
    // identificador nos dois arquivos é o `int-1` do texto de ajuda.
    expect(FONTE_CLI).not.toMatch(/[0-9]{6,}/);
    expect(FONTE_SCRIPT).not.toMatch(/[0-9]{6,}/);
    expect(USO_ENVIAR_ESTOQUE).toContain('int-1');
  });

  it('o package.json ganha EXATAMENTE um script, com a string exata', () => {
    const pacote = JSON.parse(PACOTE) as { scripts: Record<string, string> };
    expect(pacote.scripts['enviar:estoque']).toBe(
      'dotenv -e ../../.env.local -- tsx scripts/enviar-estoque.ts',
    );
    expect(
      Object.values(pacote.scripts).filter((v) => v.includes('scripts/enviar-estoque.ts')),
    ).toHaveLength(1);
  });
});

/* ========================================================================== */
/*  7 · o caminho do exit 1: classe + code, nunca payload                     */
/* ========================================================================== */

describe('descreverErroEnvio', () => {
  it('um argumento inválido imprime a ajuda DESTE comando, não a de outro', () => {
    const texto = descreverErroEnvio(new ArgumentoInvalidoError(MSG_PRODUTO_OBRIGATORIO)).join(
      '\n',
    );
    expect(texto).toContain(MSG_PRODUTO_OBRIGATORIO);
    expect(texto).toContain('enviar:estoque');
    expect(texto).not.toContain('importar:pedido');
  });

  it('a guarda sai por CLASSE + code e promete que nada foi enviado', () => {
    const linhas = descreverErroEnvio(
      new ShopeeEnvioEstoqueGuardError(
        CODIGO_GUARDA_ENVIO.contaSemDeposito,
        MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.semDeposito],
        { pausadoAte: 'nao-deve-sair' },
      ),
    );
    expect(linhas[0]).toBe(
      `❌ ShopeeEnvioEstoqueGuardError (${CODIGO_GUARDA_ENVIO.contaSemDeposito})`,
    );
    expect(linhas.join('\n')).toContain('a recusa é anterior');
    // ⚠️ `extra` é um saco sem tipo: ele NÃO é impresso.
    expect(linhas.join('\n')).not.toContain('nao-deve-sair');
  });

  it('⚠️ PAR/NEAR-MISS: ehRecusaAntesDaShopee cobre as DUAS classes e nada mais', () => {
    // O predicado que o `catch` do script consulta para NÃO acrescentar "nada
    // garante que nada foi escrito" a uma recusa que aconteceu antes de
    // qualquer chamada — a mesma afirmação que `descreverErroEnvio` já imprime
    // duas linhas acima, e que as duas contradiziam uma à outra.
    expect(ehRecusaAntesDaShopee(new ArgumentoInvalidoError(MSG_PRODUTO_OBRIGATORIO))).toBe(true);
    expect(
      ehRecusaAntesDaShopee(
        new ShopeeEnvioEstoqueGuardError(
          CODIGO_GUARDA_ENVIO.contaSemDeposito,
          MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.semDeposito],
        ),
      ),
    ).toBe(true);
    // NEAR-MISS: tudo que pode ter chegado à Shopee fica de fora — inclusive um
    // erro de API cujo `update_stock` já pode ter caído.
    expect(
      ehRecusaAntesDaShopee(
        new ShopeeApiError('recusou', {
          code: 'error_param',
          kind: SHOPEE_ERROR_KIND.other,
          httpStatus: 200,
          path: '/api/v2/product/update_stock',
        }),
      ),
    ).toBe(false);
    expect(ehRecusaAntesDaShopee(new TypeError('bug nosso'))).toBe(false);
    expect(ehRecusaAntesDaShopee(null)).toBe(false);
  });

  it('um erro da Shopee sai por CLASSE + code/path, sem corpo nenhum', () => {
    const linhas = descreverErroEnvio(
      new ShopeeApiError('Shopee /api/v2/product/update_stock respondeu error_param (HTTP 200)', {
        code: 'error_param',
        kind: SHOPEE_ERROR_KIND.other,
        httpStatus: 200,
        path: '/api/v2/product/update_stock',
        requestId: 'req-1',
      }),
    );
    const texto = linhas.join('\n');
    expect(linhas[0]).toBe(`❌ ShopeeApiError (${SHOPEE_ERROR_KIND.other})`);
    expect(texto).toContain('code=error_param');
    expect(texto).toContain('path=/api/v2/product/update_stock');
    expect(texto).not.toMatch(/token|partner_key|shop_id/i);
  });
});

/* ========================================================================== */
/*  8 · as tabelas: nenhuma célula encosta na seguinte, seja qual for o id    */
/* ========================================================================== */

describe('as tabelas impressas — cada coluna medida pelo que ela imprime', () => {
  // O ensaio de 2026-09-23/24 em staging: o id de um produto que o passo 9
  // importou tem 64 caracteres hex, e a largura FIXA pensada para um id curto
  // do Firestore colou o id em `qtd` no plano, no nome na linha do anúncio e em
  // `pedida=` em toda linha de modelo.

  /** O id que o passo 9 cunharia para o anúncio de fixture: um sha256, 64 hex. */
  const ID_LONGO = createHash('sha256')
    .update(`shopee|${INTEGRACAO}|${String(ITEM_ID)}`)
    .digest('hex');
  /** O tamanho de um id automático do Firestore. */
  const ID_CURTO = 'Ab3dE5fG7hJ9kL1mN2pQ';

  /** As células de uma linha: a tabela as separa por 2+ brancos, e nenhuma célula tem dois seguidos. */
  const celulas = (linha: string): string[] => linha.trim().split(/\s{2,}/);
  /** Os tokens separados por branco — um número colado a um id não é um token. */
  const tokens = (linha: string): string[] => linha.trim().split(/\s+/);
  /** Onde cada célula COMEÇA — a coluna que o olho do operador segue. */
  const inicios = (linha: string): number[] =>
    [...linha.matchAll(/(?:^|\s{2,})(\S)/g)].map((m) => m.index + m[0].length - 1);

  const linhaQueComeca = (linhas: readonly string[], prefixo: string): string =>
    linhas.find((l) => l.trimStart().startsWith(prefixo)) ?? '';

  it('PAR: no PLANO, um id de 64 caracteres deixa um vão antes de "qtd" e cada número é o seu próprio token', () => {
    expect(ID_LONGO).toHaveLength(64);
    const p = montarPlanoDeEnvio(
      [
        entrada({
          produtoId: ID_LONGO,
          plano: plano({
            tarefas: [
              tarefa({
                produtoId: ID_LONGO,
                modelos: [
                  { modelId: MODEL_A, produtoId: ID_LONGO, varLinkDocId: 'var-a', quantidade: 2 },
                ],
              }),
            ],
          }),
        }),
      ],
      { integracaoId: INTEGRACAO, pisoPorItem: SEM_PISO },
    );
    const linhas = renderizarPlanoDeEnvio(p);
    const cabecalho = linhaQueComeca(linhas, 'model_id');
    const doModelo = linhaQueComeca(linhas, String(MODEL_A));

    expect(celulas(doModelo)).toEqual([String(MODEL_A), ID_LONGO, '2', '2', '—', '—', 'nenhum']);
    expect(tokens(doModelo)).toEqual(celulas(doModelo));
    expect(inicios(doModelo)).toEqual(inicios(cabecalho));
  });

  it('QUASE: no PLANO, um id de 20 caracteres continua alinhado sob o cabeçalho — e uma célula "—" também', () => {
    expect(ID_CURTO).toHaveLength(20);
    const p = montarPlanoDeEnvio(
      [
        entrada({
          plano: plano({
            tarefas: [
              tarefa({
                modelos: [
                  { modelId: MODEL_A, produtoId: ID_CURTO, varLinkDocId: 'var-a', quantidade: 7 },
                  { modelId: MODEL_B, produtoId: ID_CURTO, varLinkDocId: 'var-b', quantidade: 12 },
                ],
              }),
            ],
          }),
        }),
      ],
      { integracaoId: INTEGRACAO, pisoPorItem: pisos({ [MODEL_A]: 9 }) },
    );
    const linhas = renderizarPlanoDeEnvio(p);
    const cabecalho = linhaQueComeca(linhas, 'model_id');
    const comPiso = linhaQueComeca(linhas, String(MODEL_A));
    const semPiso = linhaQueComeca(linhas, String(MODEL_B));

    expect(celulas(comPiso)).toEqual([String(MODEL_A), ID_CURTO, '7', '9', '9', '—', 'piso']);
    expect(celulas(semPiso)).toEqual([String(MODEL_B), ID_CURTO, '12', '12', '—', '—', 'nenhum']);
    expect(inicios(comPiso)).toEqual(inicios(cabecalho));
    expect(inicios(semPiso)).toEqual(inicios(cabecalho));
  });

  it('PAR: no --live, um id de 64 caracteres não encosta no NOME na linha do anúncio nem em "pedida=" na do modelo', () => {
    const linhas = renderizarResultadoEnvio(
      envelope({
        listings: [
          listagem({
            produtoId: ID_LONGO,
            produtoNome: 'Cotton T-shirt',
            quantidade: 18,
            variacoes: [
              modeloEnviado({ produtoId: ID_LONGO, quantidadeSolicitada: 2, quantidadeEnviada: 2 }),
            ],
          }),
        ],
      }),
    );
    const doAnuncio = linhaQueComeca(linhas, ID_LONGO);
    const doModelo = linhaQueComeca(linhas, 'model ');

    expect(celulas(doAnuncio)).toEqual([
      ID_LONGO,
      'Cotton T-shirt',
      String(ITEM_ID),
      'enviado',
      'qtd=18',
      'modelos=1',
      'recusados=0',
      'clampados=0',
    ]);
    expect(tokens(doAnuncio)).toContain(ID_LONGO);
    expect(tokens(doAnuncio)).toContain('qtd=18');
    expect(celulas(doModelo)).toEqual([
      `model ${String(MODEL_A)}`,
      ID_LONGO,
      'pedida=2',
      'enviada=2',
      'enviado',
    ]);
    expect(tokens(doModelo)).toEqual([
      'model',
      String(MODEL_A),
      ID_LONGO,
      'pedida=2',
      'enviada=2',
      'enviado',
    ]);
  });

  it('QUASE: no --live, ids de 20 caracteres e células "—" seguem em coluna ATRAVÉS dos anúncios', () => {
    const linhas = renderizarResultadoEnvio(
      envelope({
        listings: [
          listagem({
            produtoId: ID_CURTO,
            variacoes: [modeloEnviado({ produtoId: ID_CURTO })],
          }),
          listagem({
            produtoId: ANCORA,
            produtoNome: null,
            anuncioId: null,
            outcome: 'falha',
            quantidade: null,
            modelosRecusados: 1,
            variacoes: [
              modeloEnviado({
                modelId: MODEL_B,
                quantidadeEnviada: null,
                resultado: RESULTADO_MODELO.recusado,
                codigo: 'error_param',
              }),
            ],
          }),
        ],
      }),
    );
    const anuncio1 = linhaQueComeca(linhas, ID_CURTO);
    const anuncio2 = linhaQueComeca(linhas, ANCORA);
    const modelo1 = linhaQueComeca(linhas, `model ${String(MODEL_A)}`);
    const modelo2 = linhaQueComeca(linhas, `model ${String(MODEL_B)}`);

    expect(celulas(anuncio2)).toEqual([
      ANCORA,
      'sem nome',
      '—',
      'falha',
      'qtd=—',
      'modelos=1',
      'recusados=1',
      'clampados=0',
    ]);
    expect(inicios(anuncio2)).toEqual(inicios(anuncio1));
    expect(celulas(modelo2)).toEqual([
      `model ${String(MODEL_B)}`,
      ANCORA,
      'pedida=7',
      'enviada=—',
      'recusado',
      'error_param',
    ]);
    // A primeira linha de modelo não tem a célula final (nem clampe nem código):
    // as cinco colunas que as duas têm começam no mesmo lugar.
    expect(inicios(modelo2).slice(0, 5)).toEqual(inicios(modelo1));
  });

  it('PAR: pulos, totais e "sem envio" — um id de 64 caracteres e o motivo do tamanho da largura antiga (28)', () => {
    const LONGO_28 = MOTIVO_ESTOQUE_SHOPEE.pisoDeReservaNaoAtendido;
    const LONGO_31 = MOTIVO_ESTOQUE_SHOPEE.estruturaDeEstoqueDivergente;
    expect(LONGO_28).toHaveLength(28);
    const pulo = (produtoId: string, itemId: number | null, motivo: MotivoEstoqueShopee) => ({
      produtoId,
      linkDocId: null,
      itemId,
      modelId: null,
      modelosAfetados: null,
      motivo,
      mensagem: MENSAGEM_POR_MOTIVO[motivo],
    });
    const p = montarPlanoDeEnvio(
      [
        entrada({
          plano: plano({
            tarefas: [],
            pulos: [pulo(ID_LONGO, ITEM_ID, LONGO_28), pulo(ANCORA, null, LONGO_31)],
          }),
        }),
      ],
      { integracaoId: INTEGRACAO, pisoPorItem: SEM_PISO },
    );
    const linhas = renderizarPlanoDeEnvio(p);

    expect(celulas(linhaQueComeca(linhas, ID_LONGO))).toEqual([
      ID_LONGO,
      String(ITEM_ID),
      LONGO_28,
      MENSAGEM_POR_MOTIVO[LONGO_28],
    ]);
    expect(celulas(linhaQueComeca(linhas, ANCORA))).toEqual([
      ANCORA,
      '—',
      LONGO_31,
      MENSAGEM_POR_MOTIVO[LONGO_31],
    ]);
    expect(inicios(linhaQueComeca(linhas, ANCORA))).toEqual(
      inicios(linhaQueComeca(linhas, ID_LONGO)),
    );
    expect(celulas(linhaQueComeca(linhas, LONGO_28))).toEqual([
      LONGO_28,
      '1',
      'recusa',
      MENSAGEM_POR_MOTIVO[LONGO_28],
    ]);
    expect(celulas(linhaQueComeca(linhas, LONGO_31))).toEqual([
      LONGO_31,
      '1',
      'recusa',
      MENSAGEM_POR_MOTIVO[LONGO_31],
    ]);

    const semEnvioLonga = linhaQueComeca(
      renderizarResultadoEnvio(
        envelope({
          produtosSemEnvio: [
            semEnvio({
              produtoId: ID_LONGO,
              motivo: MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado,
              mensagem: MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado],
            }),
          ],
        }),
      ),
      ID_LONGO,
    );
    expect(celulas(semEnvioLonga)).toEqual([
      ID_LONGO,
      'sem nome',
      MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado,
      MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado],
    ]);
  });

  it('PAR: a dobra do kit com um componente de 64 caracteres deixa um vão antes de "disponivel="', () => {
    const kit = membro(ANCORA, {
      ehKit: true,
      componentesKit: componentes({ [ID_LONGO]: { quantidade: 2 }, 'comp-2': { quantidade: 1 } }),
      componentEstoques: [
        { estoqueDocId: 'e1', parentId: ID_LONGO, quantidade: 14, quantidadeReservada: 0 },
        { estoqueDocId: 'e2', parentId: 'comp-2', quantidade: 9, quantidadeReservada: 0 },
      ],
    });
    const linhas = renderizarPlanoDeEnvio(
      montarPlanoDeEnvio([entrada({ row: familia({ anchor: kit }) })], {
        integracaoId: INTEGRACAO,
        pisoPorItem: SEM_PISO,
      }),
    );
    const longa = linhaQueComeca(linhas, ID_LONGO);
    const curta = linhaQueComeca(linhas, 'comp-2');

    expect(celulas(longa)).toEqual([ID_LONGO, 'disponivel=14', 'por kit=2', 'limita: sim']);
    expect(celulas(curta)).toEqual(['comp-2', 'disponivel=9', 'por kit=1', 'limita: sim']);
    expect(inicios(curta)).toEqual(inicios(longa));
  });

  it('⚠️ nenhuma linha dos dois relatórios termina em branco — uma célula final vazia não deixa rastro', () => {
    // O modelo LIMPO não tem clampe nem código: a célula final vazia deixava a
    // linha terminando no preenchimento da coluna anterior.
    const plano1 = montarPlanoDeEnvio([entrada()], {
      integracaoId: INTEGRACAO,
      pisoPorItem: pisos({ [MODEL_A]: 9 }),
    });
    const vivo = envelope({
      listings: [
        listagem({
          clampados: 1,
          variacoes: [
            modeloEnviado(),
            modeloEnviado({ modelId: MODEL_B, clampado: true, piso: 9, quantidadeEnviada: 9 }),
          ],
        }),
      ],
      produtosSemEnvio: [semEnvio()],
    });
    const todas = [...renderizarPlanoDeEnvio(plano1), ...renderizarResultadoEnvio(vivo)];

    for (const linha of todas) expect(linha, JSON.stringify(linha)).toBe(linha.trimEnd());
    // ÂNCORA: o clampe continua impresso — o negativo acima não é vácuo.
    expect(todas.join('\n')).toContain('clampado piso=9');
  });
});
