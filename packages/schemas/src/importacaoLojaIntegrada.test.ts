import { describe, expect, it } from 'vitest';

// Imported through the BARREL on purpose: proof that `src/index.ts` exports the module.
import {
  ACAO_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  CAUDA_DESPACHO_IMPORTACAO_LI_MS,
  FASE_IMPORTACAO_LI,
  LIMITE_PAGINA_PRODUTOS_LI,
  MAX_PAUSAS_429_LI,
  MAX_SELECIONADOS_LI,
  MODO_IMPORTACAO_LI,
  ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS,
  PENDENCIAS_ACIONAVEIS_LI,
  PENDENCIA_IMPORTACAO_LI,
  STATUS_EM_CURSO_IMPORTACAO_LI,
  STATUS_IMPORTACAO_LI,
  TIPO_PAGINA_IMPORTACAO_LI,
  TIPO_TAREFA_IMPORTACAO_LI,
  TIPO_TAREFA_LI,
  ALL_DOMAINS,
  detalheProdutoLiSchema,
  ehPendenciaAcionavelLi,
  evidenciaOpcaoLiSchema,
  faseImportacaoLiSchema,
  idEvidenciaImportacaoLi,
  idPaginaImportacaoLi,
  idTarefaImportacaoLi,
  importacaoLojaIntegradaMeta,
  importacaoLojaIntegradaSchema,
  itemImportacaoLiSchema,
  lerProdutoLi,
  opcoesImportacaoLiSchema,
  paginaListagemLiSchema,
  pendenciaImportacaoLiSchema,
  respostaImportacaoLiSchema,
  respostaItensImportacaoLiSchema,
  revisaoFiscalLiSchema,
  tarefaImportacaoLiSchema,
  tipoTarefaLiSchema,
  type EvidenciaAprendizadoLi,
  type EvidenciaOpcaoLi,
} from './index';

const AGORA_MS = 1_800_000_000_000;

describe('the dispatch budget constants', () => {
  it('a dispatch is held to 100 s: budget 70 s + tail 30 s', () => {
    expect(ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS).toBe(70_000);
    expect(CAUDA_DESPACHO_IMPORTACAO_LI_MS).toBe(30_000);
    expect(
      ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS + CAUDA_DESPACHO_IMPORTACAO_LI_MS,
    ).toBeLessThanOrEqual(100_000);
  });

  it('the order-intake ladder still closes inside half the hot sweep’s hour with an import co-tenant', () => {
    // Three intake attempts of 300 s, each waiting at most one import dispatch, plus two 300 s
    // backoffs, must fit 1 800 s.
    const despachoS =
      (ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS + CAUDA_DESPACHO_IMPORTACAO_LI_MS) / 1000;
    expect(3 * (300 + despachoS) + 2 * 300).toBeLessThanOrEqual(1_800);
  });

  it('the remaining limits', () => {
    expect(MAX_SELECIONADOS_LI).toBe(1_000);
    expect(MAX_PAUSAS_429_LI).toBe(10);
    expect(LIMITE_PAGINA_PRODUTOS_LI).toBe(100);
  });
});

describe('opcoesImportacaoLiSchema — the strict start body', () => {
  const base = {
    modo: MODO_IMPORTACAO_LI.simular,
    alvo: ALVO_IMPORTACAO_LI.todos,
    acao: ACAO_IMPORTACAO_LI.soVincular,
  };

  it('fills the options that change the least', () => {
    expect(opcoesImportacaoLiSchema.parse(base)).toEqual({
      ...base,
      categorias: 'soVincular',
      fotos: 'naoImportar',
      selecionados: [],
      simulacaoId: null,
    });
  });

  it('accepts "Importar selecionados" from a finished Simular', () => {
    const corpo = {
      modo: MODO_IMPORTACAO_LI.aplicar,
      alvo: ALVO_IMPORTACAO_LI.selecionados,
      acao: ACAO_IMPORTACAO_LI.completar,
      categorias: 'criarEVincular',
      fotos: 'soSemFotos',
      selecionados: [1000001, 1000004],
      simulacaoId: 'aB3dE5gH7jK9mN1pQ3sT',
    };
    expect(opcoesImportacaoLiSchema.safeParse(corpo).success).toBe(true);
  });

  it.each([
    ['an unknown key', { ...base, sobrescrever: true }],
    ['no modo', { alvo: 'todos', acao: 'soVincular' }],
    ['selecionados without alvo selecionados', { ...base, selecionados: [1] }],
    ['alvo selecionados with none', { ...base, alvo: 'selecionados' }],
    ['create categories under soVincular', { ...base, categorias: 'criarEVincular' }],
    ['photos under soVincular', { ...base, fotos: 'soSemFotos' }],
    ['a text id', { ...base, alvo: 'selecionados', selecionados: ['1'] }],
    [
      'more than the ceiling',
      {
        ...base,
        alvo: 'selecionados',
        selecionados: Array.from({ length: MAX_SELECIONADOS_LI + 1 }, (_, i) => i + 1),
      },
    ],
    ['an unknown modo', { ...base, modo: 'importar' }],
    ['a simulacaoId with a slash', { ...base, simulacaoId: 'a/b' }],
  ])('refuses %s (400)', (_r, corpo) => {
    expect(opcoesImportacaoLiSchema.safeParse(corpo).success).toBe(false);
  });
});

describe('importacaoLojaIntegradaSchema — the job document', () => {
  it('a document with only the three create fields parses, every other field defaulted', () => {
    const job = importacaoLojaIntegradaSchema.parse({
      integracaoId: 'C1',
      status: STATUS_IMPORTACAO_LI.pendente,
      iniciadoEmMs: AGORA_MS,
    });
    expect(job).toMatchObject({
      modo: 'simular',
      alvo: 'todos',
      acao: 'soVincular',
      categorias: 'soVincular',
      fotos: 'naoImportar',
      fase: FASE_IMPORTACAO_LI.catalogo,
      motivo: null,
      seq: 0,
      catalogo: { recurso: 'categorias', proximoOffset: 0, paginas: 0 },
      listagem: {
        proximoOffset: 0,
        paginas: 0,
        linhas: 0,
        limiteLido: null,
        totalLi: null,
        divergente: false,
      },
      lixeira: { proximoOffset: 0, paginas: 0, linhas: 0 },
      orfaos: { cursorLiId: null },
      familias: { cursorPaiId: null, filhosLidos: [] },
      aprendizado: { cursorEvidenciaId: null },
      revisao: { cursorProdutoId: null, anteriorJobId: null },
      mapaCategorias: [],
      marcas: [],
      aprendizadosSimulados: [],
      pausas429: 0,
      fotosIndisponiveis: false,
    });
    expect(job.contadores.pendenciasAcionaveis).toBe(0);
  });

  it('two parses never share an array default', () => {
    const a = importacaoLojaIntegradaSchema.parse({
      integracaoId: 'C1',
      status: 'pendente',
      iniciadoEmMs: 1,
    });
    const b = importacaoLojaIntegradaSchema.parse({
      integracaoId: 'C1',
      status: 'pendente',
      iniciadoEmMs: 1,
    });
    a.familias.filhosLidos.push(1);
    a.selecionados.push(1);
    expect(b.familias.filhosLidos).toEqual([]);
    expect(b.selecionados).toEqual([]);
  });

  it('the phases run in the documented order, the trash list right after the listing', () => {
    expect(faseImportacaoLiSchema.options).toEqual([
      'catalogo',
      'listagem',
      'lixeira',
      'orfaos',
      'evidencias',
      'aprendizado',
      'familias',
      'revisao',
      'fim',
    ]);
  });

  it('only pendente and executando are a running job (the start guard)', () => {
    expect([...STATUS_EM_CURSO_IMPORTACAO_LI].sort()).toEqual(['executando', 'pendente']);
  });

  it('is admin-only and never registered as a domain', () => {
    expect(importacaoLojaIntegradaMeta.collectionPath).toBe('importacoesLojaIntegrada');
    expect(importacaoLojaIntegradaMeta.permissions).toEqual({ read: 0n, write: 0n, delete: 0n });
    expect(importacaoLojaIntegradaMeta.collectionPath.startsWith('notificacoes')).toBe(false);
    expect(
      ALL_DOMAINS.some((d) => d.meta.collectionPath === importacaoLojaIntegradaMeta.collectionPath),
    ).toBe(false);
  });
});

describe('the pendência vocabulary', () => {
  it('the actionable half is exactly the 24 codes a person can fix', () => {
    expect(PENDENCIAS_ACIONAVEIS_LI.size).toBe(24);
    for (const codigo of PENDENCIAS_ACIONAVEIS_LI) {
      expect(pendenciaImportacaoLiSchema.safeParse(codigo).success, codigo).toBe(true);
    }
  });

  it.each([
    PENDENCIA_IMPORTACAO_LI.orfao,
    PENDENCIA_IMPORTACAO_LI.naLixeira,
    PENDENCIA_IMPORTACAO_LI.familiaVazia,
    PENDENCIA_IMPORTACAO_LI.tipoDesconhecido,
    PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado,
    PENDENCIA_IMPORTACAO_LI.naoListado,
    PENDENCIA_IMPORTACAO_LI.skuDiferente,
    PENDENCIA_IMPORTACAO_LI.vinculoAtualizado,
    PENDENCIA_IMPORTACAO_LI.fotoRecusada,
    PENDENCIA_IMPORTACAO_LI.semEstoqueNoErp,
    PENDENCIA_IMPORTACAO_LI.semPrecoNoErp,
    PENDENCIA_IMPORTACAO_LI.revisaoFiscal,
  ])('%s is informational: it never keeps the summary aviso open', (codigo) => {
    expect(ehPendenciaAcionavelLi(codigo)).toBe(false);
  });

  it('every code is one or the other, and a code this build does not know is not actionable', () => {
    expect(pendenciaImportacaoLiSchema.options).toHaveLength(24 + 12);
    expect(ehPendenciaAcionavelLi(PENDENCIA_IMPORTACAO_LI.semSku)).toBe(true);
    expect(ehPendenciaAcionavelLi('codigo-novo')).toBe(false);
    expect(ehPendenciaAcionavelLi('SEM-SKU')).toBe(false);
  });
});

describe('the subcollection documents', () => {
  it('a snapshot page holds row views, and its id sorts by offset', () => {
    const linha = lerProdutoLi({ id: 1000001, tipo: 'normal', sku: 'KX7' });
    const pagina = paginaListagemLiSchema.parse({
      tipo: TIPO_PAGINA_IMPORTACAO_LI.lixeira,
      offset: 100,
      linhas: [linha],
      limiteLido: 100,
      totalLi: 35,
      lidaEmMs: AGORA_MS,
    });
    expect(pagina.linhas).toHaveLength(1);
    expect(idPaginaImportacaoLi(TIPO_PAGINA_IMPORTACAO_LI.listagem, 100)).toBe(
      'listagem-000000100',
    );
    expect(
      idPaginaImportacaoLi(TIPO_PAGINA_IMPORTACAO_LI.listagem, 900) <
        idPaginaImportacaoLi(TIPO_PAGINA_IMPORTACAO_LI.listagem, 1000),
    ).toBe(true);
    expect(() => idPaginaImportacaoLi(TIPO_PAGINA_IMPORTACAO_LI.listagem, -1)).toThrow(RangeError);
  });

  it('a detail document is the view, or a 404 with none', () => {
    expect(
      detalheProdutoLiSchema.parse({ liId: 1000002, estado: 'inexistente', lidoEmMs: AGORA_MS })
        .detalhe,
    ).toBeNull();
  });

  it('an evidence document is the shape the learning pass reads', () => {
    const doc: EvidenciaOpcaoLi = evidenciaOpcaoLiSchema.parse({
      gradeId: 8001,
      opcaoId: 30001,
      alegacoes: [
        {
          grupoId: 'cor',
          varianteId: 'v1',
          ocorrencias: 3,
          todasDeEixoUnico: true,
          exemploLiFilhoId: 1000002,
          exemploErpFilhoId: 'p2',
        },
      ],
    });
    // A compile-time proof as much as a runtime one: the stored document IS the evidence input.
    const entrada: EvidenciaAprendizadoLi = doc;
    expect(entrada.alegacoes).toHaveLength(1);
    expect(idEvidenciaImportacaoLi(8001, 30001)).toBe('8001_30001');
    expect(() => idEvidenciaImportacaoLi(0, 1)).toThrow(RangeError);
  });

  it('a report item and a tax-review entry parse with their defaults', () => {
    expect(
      itemImportacaoLiSchema.parse({
        liId: 1000001,
        tipo: 'atributo',
        situacaoErp: 'ausente',
        atualizadoEmMs: AGORA_MS,
        pendencias: [{ codigo: 'sku-ja-existe', acionavel: true, referencias: ['p9'] }],
      }),
    ).toMatchObject({ acao: 'nenhuma', aplicada: false, camposPreenchidos: [] });
    expect(
      revisaoFiscalLiSchema.parse({ produtoId: 'p1', motivos: ['produto-criado'] }),
    ).toMatchObject({
      liId: null,
      desdeJobId: null,
    });
  });
});

describe('the task payload and its named id', () => {
  it('is NOT a member of the persisted notification tipo', () => {
    expect(tipoTarefaLiSchema.safeParse(TIPO_TAREFA_IMPORTACAO_LI).success).toBe(false);
    expect(Object.values(TIPO_TAREFA_LI)).not.toContain(TIPO_TAREFA_IMPORTACAO_LI);
  });

  it('parses ids only and strips anything else', () => {
    expect(
      tarefaImportacaoLiSchema.parse({
        tipo: 'importacao',
        contaId: 'C1',
        jobId: 'aB3dE5gH7jK9mN1pQ3sT',
        seq: 4,
        corpo: { qualquer: 1 },
      }),
    ).toEqual({ tipo: 'importacao', contaId: 'C1', jobId: 'aB3dE5gH7jK9mN1pQ3sT', seq: 4 });
    expect(
      tarefaImportacaoLiSchema.safeParse({ tipo: 'pedido', contaId: 'C1', jobId: 'j', seq: 0 })
        .success,
    ).toBe(false);
  });

  it('EQUAL: one (job, seq) always names the same task — a redelivery is a duplicate', () => {
    expect(idTarefaImportacaoLi('aB3dE5gH7jK9mN1pQ3sT', 4)).toBe(
      'li-importacao-aB3dE5gH7jK9mN1pQ3sT-4',
    );
    expect(idTarefaImportacaoLi('aB3dE5gH7jK9mN1pQ3sT', 4)).toBe(
      idTarefaImportacaoLi('aB3dE5gH7jK9mN1pQ3sT', 4),
    );
  });

  it('⚠️ NEAR-MISS: the next seq, or another job, is another task', () => {
    expect(idTarefaImportacaoLi('job1', 4)).not.toBe(idTarefaImportacaoLi('job1', 5));
    expect(idTarefaImportacaoLi('job1', 4)).not.toBe(idTarefaImportacaoLi('job2', 4));
  });

  it('only the task-id grammar: letters, digits, - and _', () => {
    expect(idTarefaImportacaoLi('a_B-1', 0)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(() => idTarefaImportacaoLi('a/b', 0)).toThrow(RangeError);
    expect(() => idTarefaImportacaoLi('job', -1)).toThrow(RangeError);
    expect(() => idTarefaImportacaoLi('job', 1.5)).toThrow(RangeError);
  });
});

describe('the route answers are NON-strict', () => {
  const resposta = {
    jobId: 'j1',
    integracaoId: 'C1',
    status: 'executando',
    fase: 'uma-fase-nova',
    motivo: null,
    modo: 'simular',
    alvo: 'todos',
    acao: 'soVincular',
    categorias: 'soVincular',
    fotos: 'naoImportar',
    selecionados: 0,
    simulacaoId: null,
    iniciadoEmMs: AGORA_MS,
    atualizadoEmMs: AGORA_MS,
    concluidoEmMs: null,
    contadores: {},
    listagem: { paginas: 1, linhas: 100, totalLi: 445, divergente: false },
    pausas429: 0,
    fotosIndisponiveis: false,
    campoFuturo: true,
  };

  it('a phase this build does not know, and an unknown key, still parse', () => {
    const lido = respostaImportacaoLiSchema.parse(resposta);
    expect(lido.fase).toBe('uma-fase-nova');
    expect(lido).not.toHaveProperty('campoFuturo');
  });

  it('a report item with a pendência code this build does not know still parses', () => {
    expect(
      respostaItensImportacaoLiSchema.safeParse({
        itens: [
          {
            liId: 1,
            tipo: 'normal',
            situacaoErp: 'ausente',
            acao: 'criar',
            atualizadoEmMs: AGORA_MS,
            pendencias: [{ codigo: 'codigo-novo', acionavel: false }],
          },
        ],
        proximo: null,
      }).success,
    ).toBe(true);
  });
});
