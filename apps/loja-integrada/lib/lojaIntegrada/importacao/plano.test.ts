/**
 * The product import's plan for one family (`plano.ts`): pure, so every case is a value in and a
 * value out — the target, the link documents (what a row-only link must leave ABSENT), the create
 * classification (hidden and blocked products, the name, a variation left out), the learning's
 * verdict on an unlinked option, and `dado-invalido` instead of a throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACAO_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  ESTADO_PUBLICACAO_LI,
  type ImportacaoLojaIntegrada,
  MODO_IMPORTACAO_LI,
  MOTIVO_RECUSA_APRENDIZADO_LI,
  type MotivoRecusaAprendizadoLi,
  PENDENCIA_IMPORTACAO_LI,
  SITUACAO_ERP_ITEM_LI,
  TIPO_RESOLUCAO_OPCAO_LI,
  FORMA_RAIZ_ERP,
  produtoLojaIntegradaLinkSchema,
} from '@delfrance/schemas';

import type { DocData } from '../testing/fakeDb';
import {
  detalheLi,
  filhoLi,
  linhaProdutoLi,
  paiLi,
  uriOpcaoLi,
  vistaDetalhadaLi,
  vistaLi,
} from '../testing/produtosLi';
import { type FamiliaLi, ORIGEM_DO_FILHO_LI, type PendenciaDaMontagemLi } from './familias';
import type { RecusaNoRelatorioLi } from './gruposLi';
import {
  type EntradaDoPlanoLi,
  MAX_NOME_PRODUTO_LI,
  PAPEL_DO_VINCULO_LI,
  ocultoNaLojaLi,
  planejarFamiliaLi,
} from './plano';
import {
  type ResolucaoDaRaizLi,
  type ResolucaoDoFilhoLi,
  type ResolucaoDosFilhosLi,
  SITUACAO_DO_FILHO_LI,
  VIA_DA_RAIZ_LI,
  VIA_DO_FILHO_LI,
} from './resolucao';

const CONTA = 'conta-li-plano';

// Pure: nothing may reach the network (D17).
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('plano.test: nenhuma chamada de rede'))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const REF_CONTA = `documents/integracao/${CONTA}`;

type JobDoPlano = EntradaDoPlanoLi['job'];

function job(over: Partial<JobDoPlano> = {}): JobDoPlano {
  return {
    integracaoId: CONTA,
    modo: MODO_IMPORTACAO_LI.aplicar,
    alvo: ALVO_IMPORTACAO_LI.todos,
    acao: ACAO_IMPORTACAO_LI.soVincular,
    selecionados: [],
    ...over,
  } satisfies Pick<ImportacaoLojaIntegrada, keyof JobDoPlano>;
}

function familia(
  raiz: DocData,
  filhos: readonly DocData[] = [],
  over: Partial<Pick<FamiliaLi, 'semDetalhe' | 'pendencias' | 'detalheDaRaiz'>> = {},
  detalhes: ReadonlyMap<number, DocData> = new Map(),
): FamiliaLi {
  return {
    raiz: vistaLi(raiz),
    detalheDaRaiz: over.detalheDaRaiz ?? null,
    filhos: filhos.map((f) => {
      const linha = vistaLi(f);
      const d = detalhes.get(linha.id);
      return {
        linha,
        detalhe: d === undefined ? null : vistaDetalhadaLi(d),
        origem: ORIGEM_DO_FILHO_LI.filhos,
      };
    }),
    semDetalhe: over.semDetalhe ?? [],
    pendencias: over.pendencias ?? [],
  };
}

const VINCULADO = (erpId: string): ResolucaoDaRaizLi => ({
  tipo: SITUACAO_ERP_ITEM_LI.vinculado,
  erpId,
  via: VIA_DA_RAIZ_LI.vinculo,
  forma: FORMA_RAIZ_ERP.familiaDeMuitas,
});
const ENCONTRADO = (erpId: string): ResolucaoDaRaizLi => ({
  tipo: SITUACAO_ERP_ITEM_LI.encontrado,
  erpId,
  via: VIA_DA_RAIZ_LI.skuRaiz,
  forma: FORMA_RAIZ_ERP.raizSimples,
});
const AUSENTE: ResolucaoDaRaizLi = { tipo: SITUACAO_ERP_ITEM_LI.ausente };

function casado(liId: number, erpId: string): ResolucaoDoFilhoLi {
  return {
    liId,
    situacao: SITUACAO_DO_FILHO_LI.casado,
    erp: {
      id: erpId,
      sku: null,
      paiId: 'pai',
      filhoUnicoId: null,
      variacoesUid: null,
      grupoDeVariacoesUid: null,
    },
    via: VIA_DO_FILHO_LI.sku,
    opcoes: [],
    pendencias: [],
  };
}

function filhosRes(
  filhos: readonly ResolucaoDoFilhoLi[],
  pendencias: ResolucaoDosFilhosLi['pendencias'] = [],
): ResolucaoDosFilhosLi {
  return { filhos, erpFilhos: [], combinacaoAmbiguaNaLoja: false, pendencias };
}

function planejar(over: Partial<EntradaDoPlanoLi> & Pick<EntradaDoPlanoLi, 'familia' | 'raiz'>) {
  return planejarFamiliaLi({
    job: job(),
    filhos: null,
    skusEmConflito: new Map(),
    recusasDoAprendizado: new Map(),
    ...over,
  });
}

/* --------------------------------- target -------------------------------- */

describe('planejarFamiliaLi — the target', () => {
  it('jaNoErp: a matched root is in it and planned; an ausente one is out, with nothing planned', () => {
    const f = familia(linhaProdutoLi(10));
    const dentro = planejar({
      job: job({ alvo: ALVO_IMPORTACAO_LI.jaNoErp }),
      familia: f,
      raiz: ENCONTRADO('p10'),
    });
    expect(dentro.noAlvo).toBe(true);
    expect(dentro.raizVinculo?.produtoId).toBe('p10');

    const fora = planejar({
      job: job({ alvo: ALVO_IMPORTACAO_LI.jaNoErp }),
      familia: f,
      raiz: AUSENTE,
    });
    expect(fora).toMatchObject({
      noAlvo: false,
      raizVinculo: null,
      filhosVinculos: [],
      criacao: null,
    });
  });

  it('selecionados: only the named roots — a matched root NOT named plans no link', () => {
    const f = familia(linhaProdutoLi(10));
    const nomeado = planejar({
      job: job({ alvo: ALVO_IMPORTACAO_LI.selecionados, selecionados: [10] }),
      familia: f,
      raiz: ENCONTRADO('p10'),
    });
    expect(nomeado.raizVinculo).not.toBeNull();
    const outro = planejar({
      job: job({ alvo: ALVO_IMPORTACAO_LI.selecionados, selecionados: [11] }),
      familia: f,
      raiz: ENCONTRADO('p10'),
    });
    expect(outro).toMatchObject({ noAlvo: false, raizVinculo: null });
  });

  it('a root in conflict is reported with the ERP ids involved, and plans no link', () => {
    const p = planejar({
      familia: familia(linhaProdutoLi(10)),
      raiz: {
        tipo: SITUACAO_ERP_ITEM_LI.conflito,
        pendencia: PENDENCIA_IMPORTACAO_LI.skuAmbiguo,
        erpIds: ['a', 'b'],
      },
    });
    expect(p.situacaoErp).toBe(SITUACAO_ERP_ITEM_LI.conflito);
    expect(p.erpId).toBeNull();
    expect(p.raizVinculo).toBeNull();
    expect(p.pendencias).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.skuAmbiguo, liId: null, referencias: ['a', 'b'] },
    ]);
  });

  const CONFLITO: ResolucaoDaRaizLi = {
    tipo: SITUACAO_ERP_ITEM_LI.conflito,
    pendencia: PENDENCIA_IMPORTACAO_LI.skuAmbiguo,
    erpIds: ['a', 'b'],
  };

  it.each([ALVO_IMPORTACAO_LI.jaNoErp, ALVO_IMPORTACAO_LI.naoNoErp])(
    '⚠️ a root in conflict is in no target but todos/selecionados — and under %s it is still REPORTED, with no link',
    (alvo) => {
      const p = planejar({
        job: job({ alvo }),
        familia: familia(linhaProdutoLi(10)),
        raiz: CONFLITO,
      });
      expect(p).toMatchObject({ noAlvo: false, relatar: true, raizVinculo: null, criacao: null });
      expect(p.pendencias).toEqual([
        { codigo: PENDENCIA_IMPORTACAO_LI.skuAmbiguo, liId: null, referencias: ['a', 'b'] },
      ]);
    },
  );

  it('⚠️ NEAR-MISS: a cleanly classified root outside the target, and a conflict outside a SELECTION, are not reported', () => {
    expect(
      planejar({
        job: job({ alvo: ALVO_IMPORTACAO_LI.jaNoErp }),
        familia: familia(linhaProdutoLi(10)),
        raiz: AUSENTE,
      }),
    ).toMatchObject({ noAlvo: false, relatar: false, pendencias: [] });
    expect(
      planejar({
        job: job({ alvo: ALVO_IMPORTACAO_LI.selecionados, selecionados: [11] }),
        familia: familia(linhaProdutoLi(10)),
        raiz: CONFLITO,
      }),
    ).toMatchObject({ noAlvo: false, relatar: false });
  });
});

/* ---------------------------------- links -------------------------------- */

describe('planejarFamiliaLi — the link documents', () => {
  it('a row-only link: the row fields and the mirror; destaque, usado and marca ABSENT, never invented', () => {
    const raiz = paiLi(500, [501], {
      sku: 'CAM',
      nome: 'Camiseta',
      grades: ['/api/v1/grade/8946'],
      categorias: ['/api/v1/categoria/77'],
    });
    const p = planejar({
      familia: familia(raiz, [filhoLi(501, { sku: 'CAM-A' })]),
      raiz: VINCULADO('pai'),
      filhos: filhosRes([casado(501, 'f1')]),
    });
    expect(p.raizVinculo?.doc).toEqual({
      contaLojaIntegrada: REF_CONTA,
      id: 500,
      removido: false,
      ativo: true,
      bloqueado: false,
      sku: 'CAM',
      nome: 'Camiseta',
      grades: ['/api/v1/grade/8946'],
      categorias: ['/api/v1/categoria/77'],
      estadoPublicacao: ESTADO_PUBLICACAO_LI.publicado,
    });
    for (const ausente of ['destaque', 'usado', 'marca', 'descricao_html', 'error', 'variacoes']) {
      expect(Object.hasOwn(p.raizVinculo?.doc ?? {}, ausente), ausente).toBe(false);
    }
    // It parses as a link document, and its defaults are NOT what is written.
    expect(produtoLojaIntegradaLinkSchema.safeParse(p.raizVinculo?.doc).success).toBe(true);
  });

  it('a variation link: its parent store id, its own option URIs, no grades', () => {
    const p = planejar({
      familia: familia(paiLi(500, [501]), [filhoLi(501, { sku: 'CAM-A' })]),
      raiz: VINCULADO('pai'),
      filhos: filhosRes([casado(501, 'f1')]),
    });
    expect(p.filhosVinculos).toHaveLength(1);
    const [filho] = p.filhosVinculos;
    expect(filho).toMatchObject({
      papel: PAPEL_DO_VINCULO_LI.filho,
      liId: 501,
      produtoId: 'f1',
      paiLiId: 500,
    });
    expect(filho?.doc).toMatchObject({
      id: 501,
      paiProdutoIntegradaId: 500,
      sku: 'CAM-A',
      variacoes: [uriOpcaoLi(8946, 501)],
    });
    expect(Object.hasOwn(filho?.doc ?? {}, 'grades')).toBe(false);
    // A variation row's `nome` is null: nothing is written for it.
    expect(Object.hasOwn(filho?.doc ?? {}, 'nome')).toBe(false);
  });

  it('a hidden product: `pa`; a row with no ativo boolean: neither ativo nor estadoPublicacao', () => {
    const oculto = planejar({
      familia: familia(linhaProdutoLi(10, { ativo: false })),
      raiz: ENCONTRADO('p10'),
    });
    expect(oculto.raizVinculo?.doc).toMatchObject({
      ativo: false,
      estadoPublicacao: ESTADO_PUBLICACAO_LI.pausado,
    });
    const semBooleano = planejar({
      familia: familia(linhaProdutoLi(10, { ativo: 'sim' })),
      raiz: ENCONTRADO('p10'),
    });
    expect(Object.hasOwn(semBooleano.raizVinculo?.doc ?? {}, 'ativo')).toBe(false);
    expect(Object.hasOwn(semBooleano.raizVinculo?.doc ?? {}, 'estadoPublicacao')).toBe(false);
  });

  it('destaque, usado and marca (the brand URI, verbatim) come only from a detail this job read', () => {
    const linha = linhaProdutoLi(10);
    const p = planejar({
      familia: familia(linha, [], {
        detalheDaRaiz: vistaDetalhadaLi(
          detalheLi(linha, null, { destaque: true, usado: false, marca: '/api/v1/marca/5000001/' }),
        ),
      }),
      raiz: ENCONTRADO('p10'),
    });
    expect(p.raizVinculo?.doc).toMatchObject({
      destaque: true,
      usado: false,
      marca: '/api/v1/marca/5000001/',
    });
    // ⚠️ NEAR-MISS: a detail whose brand does not read as a brand URI writes no marca at all.
    const semMarca = planejar({
      familia: familia(linha, [], {
        detalheDaRaiz: vistaDetalhadaLi(detalheLi(linha, null, { marca: 'Marca Livre' })),
      }),
      raiz: ENCONTRADO('p10'),
    });
    expect(Object.hasOwn(semMarca.raizVinculo?.doc ?? {}, 'marca')).toBe(false);
  });

  it('a store product with no SKU has no creatable document (refresh only), and no pendência yet', () => {
    const p = planejar({
      familia: familia(linhaProdutoLi(10, { sku: '' })),
      raiz: VINCULADO('p10'),
    });
    expect(p.raizVinculo?.doc).toBeNull();
    expect(p.raizVinculo?.preencher).not.toHaveProperty('sku');
    expect(p.pendencias).toEqual([]);
  });

  it('only matched variations are linked; the others carry their cascade pendências', () => {
    const ausente: ResolucaoDoFilhoLi = {
      liId: 502,
      situacao: SITUACAO_DO_FILHO_LI.ausente,
      erp: null,
      via: null,
      opcoes: [],
      pendencias: [
        { codigo: PENDENCIA_IMPORTACAO_LI.opcaoSemVinculo, liId: 502, referencias: ['8946/502'] },
      ],
    };
    const p = planejar({
      familia: familia(paiLi(500, [501, 502]), [filhoLi(501), filhoLi(502)]),
      raiz: VINCULADO('pai'),
      filhos: filhosRes([casado(501, 'f1'), ausente]),
    });
    expect(p.filhosVinculos.map((v) => v.liId)).toEqual([501]);
    expect(p.pendencias).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.opcaoSemVinculo, liId: 502, referencias: ['8946/502'] },
    ]);
  });

  it('an ausente root under soVincular: reported, no link, no create', () => {
    const p = planejar({ familia: familia(linhaProdutoLi(10)), raiz: AUSENTE });
    expect(p).toMatchObject({ noAlvo: true, raizVinculo: null, criacao: null, pendencias: [] });
  });
});

/* --------------------------------- create -------------------------------- */

describe('planejarFamiliaLi — the create classification (completar)', () => {
  const completar = job({ acao: ACAO_IMPORTACAO_LI.completar });

  it('a visible simple product absent from the ERP is creatable', () => {
    const p = planejar({ job: completar, familia: familia(linhaProdutoLi(10)), raiz: AUSENTE });
    expect(p.criacao).toEqual({
      viavel: true,
      nome: 'Produto 10',
      nomeCortado: false,
      filhos: [],
      ocultos: [],
    });
    expect(p.raizVinculo).toBeNull();
  });

  it('a HIDDEN or BLOCKED product absent from the ERP is never created; present, it is linked', () => {
    for (const over of [{ ativo: false }, { bloqueado: true }]) {
      const f = familia(linhaProdutoLi(10, over));
      const ausente = planejar({ job: completar, familia: f, raiz: AUSENTE });
      expect(ausente.criacao?.viavel).toBe(false);
      expect(ausente.pendencias).toContainEqual({
        codigo: PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado,
        liId: null,
        referencias: [],
      });
      const presente = planejar({ job: completar, familia: f, raiz: ENCONTRADO('p10') });
      expect(presente.raizVinculo?.produtoId).toBe('p10');
      expect(presente.criacao).toBeNull();
    }
    // Near-miss: visible and not blocked is not hidden.
    expect(ocultoNaLojaLi({ ativo: true, bloqueado: false })).toBe(false);
    expect(ocultoNaLojaLi({ ativo: null, bloqueado: null })).toBe(false);
  });

  it('a visible family with one hidden variation is created WITHOUT it', () => {
    const p = planejar({
      job: completar,
      familia: familia(paiLi(500, [501, 502]), [
        filhoLi(501, { sku: 'A' }),
        filhoLi(502, { sku: 'B', ativo: false }),
      ]),
      raiz: AUSENTE,
    });
    expect(p.criacao).toMatchObject({ viavel: true, filhos: [501], ocultos: [502] });
    expect(p.pendencias).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado, liId: 502, referencias: [] },
    ]);
  });

  it('a family whose every variation is hidden is not created', () => {
    const p = planejar({
      job: completar,
      familia: familia(paiLi(500, [501]), [filhoLi(501, { sku: 'A', bloqueado: true })]),
      raiz: AUSENTE,
    });
    expect(p.criacao).toMatchObject({ viavel: false, filhos: [], ocultos: [501] });
  });

  it.each([PENDENCIA_IMPORTACAO_LI.skuParecidoNaLoja, PENDENCIA_IMPORTACAO_LI.skuRepetidoNaLoja])(
    'a HIDDEN variation whose SKU is in conflict reports %s too, so its visible partner’s refusal has a row that explains it; the family it is left out of stays viable',
    (codigo) => {
      const p = planejar({
        job: completar,
        familia: familia(paiLi(500, [501, 502]), [
          filhoLi(501, { sku: 'A' }),
          filhoLi(502, { sku: 'b', ativo: false }),
        ]),
        raiz: AUSENTE,
        skusEmConflito: new Map([['b', codigo]]),
      });
      expect(p.criacao).toMatchObject({ viavel: true, filhos: [501], ocultos: [502] });
      expect(p.pendencias).toEqual([
        { codigo: PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado, liId: 502, referencias: [] },
        { codigo, liId: 502, referencias: [] },
      ]);
    },
  );

  it('⚠️ NEAR-MISS: a hidden variation whose SKU is not in conflict (another case, or none at all) says only that it was left out', () => {
    const p = planejar({
      job: completar,
      familia: familia(paiLi(500, [501, 502, 503]), [
        filhoLi(501, { sku: 'A' }),
        filhoLi(502, { sku: 'b', ativo: false }),
        filhoLi(503, { sku: '', bloqueado: true }),
      ]),
      raiz: AUSENTE,
      skusEmConflito: new Map([['B', PENDENCIA_IMPORTACAO_LI.skuParecidoNaLoja]]),
    });
    expect(p.criacao).toMatchObject({ viavel: true, filhos: [501], ocultos: [502, 503] });
    expect(p.pendencias).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado, liId: 502, referencias: [] },
      { codigo: PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado, liId: 503, referencias: [] },
    ]);
  });

  it('an empty family is never created', () => {
    const vazia: PendenciaDaMontagemLi = {
      codigo: PENDENCIA_IMPORTACAO_LI.familiaVazia,
      liId: null,
    };
    const p = planejar({
      job: completar,
      familia: familia(paiLi(500, []), [], { pendencias: [vazia] }),
      raiz: AUSENTE,
    });
    expect(p.criacao?.viavel).toBe(false);
    expect(p.pendencias).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.familiaVazia, liId: null, referencias: [] },
    ]);
  });

  it('a simple product with nome null ⇒ dado-invalido(nome), never a throw; the NEXT family still plans', () => {
    const familias = [familia(linhaProdutoLi(10, { nome: null })), familia(linhaProdutoLi(11))];
    const planos = familias.map((f) => planejar({ job: completar, familia: f, raiz: AUSENTE }));
    expect(planos[0]?.criacao?.viavel).toBe(false);
    expect(planos[0]?.pendencias).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido, liId: null, referencias: ['nome'] },
    ]);
    expect(planos[1]?.criacao?.viavel).toBe(true);
  });

  it('a GTIN over 255 characters ⇒ dado-invalido(gtin); at 255 it parses', () => {
    const longo = planejar({
      job: completar,
      familia: familia(linhaProdutoLi(10, { gtin: '7'.repeat(256) })),
      raiz: AUSENTE,
    });
    expect(longo.pendencias).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido, liId: null, referencias: ['gtin'] },
    ]);
    const limite = planejar({
      job: completar,
      familia: familia(linhaProdutoLi(10, { gtin: '7'.repeat(255) })),
      raiz: AUSENTE,
    });
    expect(limite.criacao?.viavel).toBe(true);
  });

  it('a name over the ERP ceiling is cut there (the one truncation), and says so', () => {
    const nome = 'N'.repeat(MAX_NOME_PRODUTO_LI + 1);
    const p = planejar({
      job: completar,
      familia: familia(linhaProdutoLi(10, { nome })),
      raiz: AUSENTE,
    });
    expect(p.criacao).toMatchObject({
      viavel: true,
      nome: 'N'.repeat(MAX_NOME_PRODUTO_LI),
      nomeCortado: true,
    });
    const exato = planejar({
      job: completar,
      familia: familia(linhaProdutoLi(10, { nome: 'N'.repeat(MAX_NOME_PRODUTO_LI) })),
      raiz: AUSENTE,
    });
    expect(exato.criacao?.nomeCortado).toBe(false);
  });

  it('a kept variation with no SKU, or a SKU the store repeats, blocks the WHOLE family', () => {
    const semSku = planejar({
      job: completar,
      familia: familia(paiLi(500, [501, 502]), [
        filhoLi(501, { sku: 'A' }),
        filhoLi(502, { sku: '' }),
      ]),
      raiz: AUSENTE,
    });
    expect(semSku.criacao?.viavel).toBe(false);
    expect(semSku.pendencias).toContainEqual({
      codigo: PENDENCIA_IMPORTACAO_LI.semSku,
      liId: 502,
      referencias: [],
    });
    const repetido = planejar({
      job: completar,
      familia: familia(paiLi(500, [501]), [filhoLi(501, { sku: 'A' })]),
      raiz: AUSENTE,
      skusEmConflito: new Map([['A', PENDENCIA_IMPORTACAO_LI.skuRepetidoNaLoja]]),
    });
    expect(repetido.criacao?.viavel).toBe(false);
    expect(repetido.pendencias).toContainEqual({
      codigo: PENDENCIA_IMPORTACAO_LI.skuRepetidoNaLoja,
      liId: 501,
      referencias: [],
    });
    // A near duplicate refuses the same way, under its own code.
    const parecido = planejar({
      job: completar,
      familia: familia(paiLi(500, [501]), [filhoLi(501, { sku: 'A' })]),
      raiz: AUSENTE,
      skusEmConflito: new Map([['A', PENDENCIA_IMPORTACAO_LI.skuParecidoNaLoja]]),
    });
    expect(parecido.criacao?.viavel).toBe(false);
    expect(parecido.pendencias).toContainEqual({
      codigo: PENDENCIA_IMPORTACAO_LI.skuParecidoNaLoja,
      liId: 501,
      referencias: [],
    });
    expect(parecido.pendencias.map((p) => p.codigo)).not.toContain(
      PENDENCIA_IMPORTACAO_LI.skuRepetidoNaLoja,
    );
    // Near-miss: `'A '` is another SKU (exact bytes), so `'A'` repeated does not touch it.
    const outro = planejar({
      job: completar,
      familia: familia(paiLi(500, [501]), [filhoLi(501, { sku: 'A ' })]),
      raiz: AUSENTE,
      skusEmConflito: new Map([['A', PENDENCIA_IMPORTACAO_LI.skuRepetidoNaLoja]]),
    });
    expect(outro.criacao?.viavel).toBe(true);
  });

  it('a claimed variation still without a usable detail blocks the create', () => {
    const p = planejar({
      job: completar,
      familia: familia(paiLi(500, [501, 509]), [filhoLi(501, { sku: 'A' })], { semDetalhe: [509] }),
      raiz: AUSENTE,
    });
    expect(p.criacao?.viavel).toBe(false);
    expect(p.pendencias).toContainEqual({
      codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
      liId: 509,
      referencias: ['detalhe'],
    });
  });
});

/* ------------------------------- the learning ----------------------------- */

describe('planejarFamiliaLi — an unlinked option reads through the learning verdict', () => {
  function comOpcao(
    codigo:
      | typeof PENDENCIA_IMPORTACAO_LI.opcaoSemVinculo
      | typeof PENDENCIA_IMPORTACAO_LI.gradeSemVinculo,
    ref: string,
  ) {
    const r: ResolucaoDoFilhoLi = {
      liId: 501,
      situacao: SITUACAO_DO_FILHO_LI.ausente,
      erp: null,
      via: null,
      opcoes: [],
      pendencias: [{ codigo, liId: 501, referencias: [ref] }],
    };
    return r;
  }

  function plano(ref: string, recusas: ReadonlyMap<string, MotivoRecusaAprendizadoLi>) {
    return planejar({
      familia: familia(paiLi(500, [501]), [filhoLi(501)]),
      raiz: VINCULADO('pai'),
      filhos: filhosRes([comOpcao(PENDENCIA_IMPORTACAO_LI.opcaoSemVinculo, ref)]),
      recusasDoAprendizado: recusas,
    }).pendencias;
  }

  it('claims that disagree ⇒ evidencia-divergente; any other refusal ⇒ variacao-sem-vinculo', () => {
    expect(
      plano('8946/37', new Map([['8946_37', MOTIVO_RECUSA_APRENDIZADO_LI.divergente]])),
    ).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.evidenciaDivergente, liId: 501, referencias: ['8946/37'] },
    ]);
    expect(
      plano('8946/37', new Map([['8946_37', MOTIVO_RECUSA_APRENDIZADO_LI.eixosMultiplos]])),
    ).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.variacaoSemVinculo, liId: 501, referencias: ['8946/37'] },
    ]);
  });

  it('near-miss: a refusal of ANOTHER option leaves the cascade code as it was', () => {
    expect(
      plano('8946/37', new Map([['8946_38', MOTIVO_RECUSA_APRENDIZADO_LI.divergente]])),
    ).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.opcaoSemVinculo, liId: 501, referencias: ['8946/37'] },
    ]);
  });

  /** A variation matched by its EXACT SKU (no pendência) whose option `(8946, v)` is unlinked. */
  function casadoComOpcaoSemVinculo(liId: number, erpId: string, opcaoId: number) {
    return {
      ...casado(liId, erpId),
      opcoes: [
        {
          tipo: TIPO_RESOLUCAO_OPCAO_LI.opcaoSemVinculo,
          gradeId: 8946,
          opcaoId,
          grupoIds: [],
          varianteIds: [],
        },
      ],
    };
  }

  function pendenciasDe(
    paiId: number,
    filhoId: number,
    recusas: ReadonlyMap<string, RecusaNoRelatorioLi>,
  ) {
    return planejar({
      familia: familia(paiLi(paiId, [filhoId]), [filhoLi(filhoId)]),
      raiz: VINCULADO(`erp-${String(paiId)}`),
      filhos: filhosRes([casadoComOpcaoSemVinculo(filhoId, `erp-${String(filhoId)}`, 37)]),
      recusasDoAprendizado: recusas,
    }).pendencias;
  }

  it('⚠️ EQUAL: claims that disagree show on BOTH families whose variations were matched by exact SKU — never on none', () => {
    const recusas = new Map([['8946_37', MOTIVO_RECUSA_APRENDIZADO_LI.divergente]]);
    expect(pendenciasDe(500, 501, recusas)).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.evidenciaDivergente, liId: 501, referencias: ['8946/37'] },
    ]);
    expect(pendenciasDe(600, 601, recusas)).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.evidenciaDivergente, liId: 601, referencias: ['8946/37'] },
    ]);
    // A learning that lost its write twice reads as the conflict it met.
    expect(
      pendenciasDe(500, 501, new Map([['8946_37', PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita]])),
    ).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita, liId: 501, referencias: ['8946/37'] },
    ]);
  });

  it('⚠️ NEAR-MISS: claims that AGREE (no refusal), or a refusal of another option, add nothing to a matched variation', () => {
    expect(pendenciasDe(500, 501, new Map())).toEqual([]);
    expect(
      pendenciasDe(500, 501, new Map([['8946_38', MOTIVO_RECUSA_APRENDIZADO_LI.divergente]])),
    ).toEqual([]);
  });

  it('an unlinked option the cascade already reported is reported ONCE, through the verdict', () => {
    const r: ResolucaoDoFilhoLi = {
      ...casadoComOpcaoSemVinculo(501, 'erp-501', 37),
      situacao: SITUACAO_DO_FILHO_LI.ausente,
      erp: null,
      via: null,
      pendencias: [
        { codigo: PENDENCIA_IMPORTACAO_LI.opcaoSemVinculo, liId: 501, referencias: ['8946/37'] },
      ],
    };
    const p = planejar({
      familia: familia(paiLi(500, [501]), [filhoLi(501)]),
      raiz: VINCULADO('pai'),
      filhos: filhosRes([r]),
      recusasDoAprendizado: new Map([['8946_37', MOTIVO_RECUSA_APRENDIZADO_LI.divergente]]),
    });
    expect(p.pendencias).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.evidenciaDivergente, liId: 501, referencias: ['8946/37'] },
    ]);
  });

  it('a structural code (grade-em-dois-grupos) is never replaced', () => {
    const r: ResolucaoDoFilhoLi = {
      liId: 501,
      situacao: SITUACAO_DO_FILHO_LI.ausente,
      erp: null,
      via: null,
      opcoes: [],
      pendencias: [
        { codigo: PENDENCIA_IMPORTACAO_LI.gradeEmDoisGrupos, liId: 501, referencias: ['8946/37'] },
      ],
    };
    const p = planejar({
      familia: familia(paiLi(500, [501]), [filhoLi(501)]),
      raiz: VINCULADO('pai'),
      filhos: filhosRes([r]),
      recusasDoAprendizado: new Map([['8946_37', MOTIVO_RECUSA_APRENDIZADO_LI.divergente]]),
    });
    expect(p.pendencias[0]?.codigo).toBe(PENDENCIA_IMPORTACAO_LI.gradeEmDoisGrupos);
  });

  it('exact duplicate pendências are reported once', () => {
    const dup = { codigo: PENDENCIA_IMPORTACAO_LI.variacaoAmbigua, liId: 501, referencias: [] };
    const p = planejar({
      familia: familia(paiLi(500, [501]), [filhoLi(501)]),
      raiz: VINCULADO('pai'),
      filhos: filhosRes(
        [{ ...comOpcao(PENDENCIA_IMPORTACAO_LI.opcaoSemVinculo, 'x'), pendencias: [dup] }],
        [dup],
      ),
    });
    expect(p.pendencias).toEqual([dup]);
  });
});
