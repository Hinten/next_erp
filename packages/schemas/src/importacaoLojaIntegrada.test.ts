import { describe, expect, it } from 'vitest';

// Imported through the BARREL on purpose: proof that `src/index.ts` exports the module.
import {
  ACAO_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  CAMINHO_DO_COMPLETAR_LI,
  CAUDA_DESPACHO_IMPORTACAO_LI_MS,
  DESFECHO_FOTOS_DO_PRODUTO_LI,
  ETAPA_REVISAO_FISCAL_LI,
  FASE_IMPORTACAO_LI,
  LIMITE_PAGINA_PRODUTOS_LI,
  MAX_IMAGENS_PRODUTO_LI,
  MAX_PAUSAS_429_LI,
  MAX_SELECIONADOS_LI,
  MODO_IMPORTACAO_LI,
  MOTIVO_FOTO_RECUSADA_LI,
  ORCAMENTO_DESPACHO_IMPORTACAO_LI_MS,
  PENDENCIAS_ACIONAVEIS_LI,
  PENDENCIA_IMPORTACAO_LI,
  PROFUNDIDADE_MAX_CATEGORIA_LI,
  STATUS_EM_CURSO_IMPORTACAO_LI,
  STATUS_IMPORTACAO_LI,
  TIPO_PAGINA_IMPORTACAO_LI,
  TIPO_TAREFA_IMPORTACAO_LI,
  TIPO_TAREFA_LI,
  VINCULO_CATEGORIA_IMPORTACAO_LI,
  ALL_DOMAINS,
  caminhoDoCompletarLiSchema,
  cursorFotosLiSchema,
  cursorRevisaoFiscalLiSchema,
  desfechoFotosDoProdutoLiSchema,
  detalheProdutoLiSchema,
  ehPendenciaAcionavelLi,
  entradaRespostaRevisaoFiscalLiSchema,
  etapaRevisaoFiscalLiSchema,
  evidenciaOpcaoLiSchema,
  faseImportacaoLiSchema,
  idEvidenciaImportacaoLi,
  idPaginaImportacaoLi,
  idTarefaImportacaoLi,
  importacaoLojaIntegradaMeta,
  importacaoLojaIntegradaSchema,
  itemImportacaoLiSchema,
  itemRespostaImportacaoLiSchema,
  lerProdutoLi,
  motivoFotoRecusadaLiSchema,
  opcoesImportacaoLiSchema,
  paginaListagemLiSchema,
  pendenciaImportacaoLiSchema,
  progressoDaFamiliaLiSchema,
  respostaImportacaoLiSchema,
  respostaItensImportacaoLiSchema,
  respostaRevisaoFiscalLiSchema,
  revisaoFiscalLiSchema,
  tarefaImportacaoLiSchema,
  tipoTarefaLiSchema,
  type EvidenciaAprendizadoLi,
  type EvidenciaOpcaoLi,
  type ProgressoDaFamiliaLi,
} from './index';

const AGORA_MS = 1_800_000_000_000;

const JOB_MINIMO = {
  integracaoId: 'C1',
  status: STATUS_IMPORTACAO_LI.executando,
  iniciadoEmMs: AGORA_MS,
};

/** A family's progress under way, through the schema, with its smallest valid content. */
function progressoMinimo(): ProgressoDaFamiliaLi {
  return progressoDaFamiliaLiSchema.parse({
    raizLiId: 1000001,
    caminho: CAMINHO_DO_COMPLETAR_LI.criada,
    erpRaizId: 'p1',
    categoria: { erpId: null, criadaPelaImportacao: false },
    criacaoAplicada: true,
    completado: false,
    campos: [],
    pendencias: [],
    categoriasCriadas: [],
    criados: 1,
    completados: 0,
    vinculados: 0,
    sumidos: [],
    alvos: [{ produtoId: 'p1', liId: null }],
    fotos: null,
    resultadoFotos: null,
  });
}

/** A photo cursor and a photos' result, each with its smallest valid content. */
const CURSOR_FOTOS = {
  produtoId: 'p1',
  proxima: 0,
  reduzida: false,
  enviadas: [],
  feitos: [],
  recusadas: [],
};
const RESULTADO_FOTOS = { produtos: [], gravadas: 0, pendencias: [] };

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
      aprendizado: { cursorEvidenciaId: null, conflitos: [] },
      progressoDaFamilia: null,
      revisao: {
        etapa: 'inicio',
        fonteJobId: null,
        ultimaFonte: false,
        depoisProdutoId: null,
        abertos: 0,
        anteriorJobId: null,
      },
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

describe('the job field a family’s complete step spans units through', () => {
  it('a document written before the field existed reads no progress', () => {
    expect(importacaoLojaIntegradaSchema.parse(JOB_MINIMO).progressoDaFamilia).toBeNull();
  });

  it('EQUAL: an absent field, a stored null and an unreadable value all read as no progress', () => {
    for (const progressoDaFamilia of [
      null,
      undefined,
      'f:{"raizLiId":1}',
      7,
      { raizLiId: 1000001 },
      { ...progressoMinimo(), caminho: 'outro' },
      { ...progressoMinimo(), fotos: CURSOR_FOTOS, resultadoFotos: RESULTADO_FOTOS },
    ]) {
      const job = importacaoLojaIntegradaSchema.parse({ ...JOB_MINIMO, progressoDaFamilia });
      expect(job.progressoDaFamilia).toBeNull();
    }
  });

  it.each([
    ['neither yet', {}],
    ['a cursor under way', { fotos: CURSOR_FOTOS }],
    ['a result, the cursor cleared', { resultadoFotos: RESULTADO_FOTOS }],
  ])('EQUAL: %s is a progress', (_r, fotos) => {
    expect(progressoDaFamiliaLiSchema.safeParse({ ...progressoMinimo(), ...fotos }).success).toBe(
      true,
    );
  });

  it.each([
    ['a cursor under way', CURSOR_FOTOS],
    ['a cursor past its last target', { ...CURSOR_FOTOS, produtoId: null }],
  ])('⚠️ NEAR-MISS: %s beside a result is refused, not stored', (_r, fotos) => {
    const lido = progressoDaFamiliaLiSchema.safeParse({
      ...progressoMinimo(),
      fotos,
      resultadoFotos: RESULTADO_FOTOS,
    });
    expect(lido.success).toBe(false);
  });

  it('⚠️ NEAR-MISS: a readable progress is kept whole, never read as none', () => {
    const job = importacaoLojaIntegradaSchema.parse({
      ...JOB_MINIMO,
      progressoDaFamilia: progressoMinimo(),
    });
    expect(job.progressoDaFamilia).toEqual(progressoMinimo());
  });

  it('a merge patch of the field keeps null and a value (the shape every checkpoint goes through)', () => {
    const parcial = importacaoLojaIntegradaSchema.partial();
    expect(parcial.parse({ progressoDaFamilia: null }).progressoDaFamilia).toBeNull();
    expect(parcial.parse({ progressoDaFamilia: progressoMinimo() }).progressoDaFamilia).toEqual(
      progressoMinimo(),
    );
  });

  it('⚠️ the job’s tolerance is the field’s alone: the schema itself refuses what the dispatch must not write', () => {
    expect(progressoDaFamiliaLiSchema.safeParse({ raizLiId: 1000001 }).success).toBe(false);
    expect(
      progressoDaFamiliaLiSchema.safeParse({ ...progressoMinimo(), caminho: 'outro' }).success,
    ).toBe(false);
    expect(
      progressoDaFamiliaLiSchema.safeParse({ ...progressoMinimo(), categoriasCriadas: [0] })
        .success,
    ).toBe(false);
    expect(
      importacaoLojaIntegradaSchema.safeParse({ ...JOB_MINIMO, seq: 'um' }).success,
      'every other field still fails the job',
    ).toBe(false);
  });

  it('survives a JSON round trip unchanged: nothing in it is undefined or a class', () => {
    const p = progressoMinimo();
    expect(progressoDaFamiliaLiSchema.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it.each([
    [motivoFotoRecusadaLiSchema.options, MOTIVO_FOTO_RECUSADA_LI],
    [desfechoFotosDoProdutoLiSchema.options, DESFECHO_FOTOS_DO_PRODUTO_LI],
    [caminhoDoCompletarLiSchema.options, CAMINHO_DO_COMPLETAR_LI],
    [etapaRevisaoFiscalLiSchema.options, ETAPA_REVISAO_FISCAL_LI],
  ])('every enum member has its named companion: %j', (opcoes, companheiro) => {
    expect(Object.values(companheiro).sort()).toEqual([...opcoes].sort());
  });

  it('EQUAL: a picture’s hash is a lowercase sha-512; ⚠️ NEAR-MISS: uppercase or one digit short is refused', () => {
    const comHash = (hash: string) => ({
      produtoId: 'p1',
      proxima: 0,
      reduzida: false,
      enviadas: [{ imagemId: 1, hash }],
      feitos: [],
      recusadas: [],
    });
    expect(cursorFotosLiSchema.safeParse(comHash('a'.repeat(128))).success).toBe(true);
    expect(cursorFotosLiSchema.safeParse(comHash('A'.repeat(128))).success).toBe(false);
    expect(cursorFotosLiSchema.safeParse(comHash('a'.repeat(127))).success).toBe(false);
  });
});

/** UTF-8 bytes of a string. */
function bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Firestore's documented storage size of a value: a string is its UTF-8 bytes + 1, a number 8, a
 * boolean or `null` 1, an array the sum of its values, a map the sum of its keys (bytes + 1) and
 * values.
 */
function tamanhoFirestore(v: unknown): number {
  if (typeof v === 'string') return bytes(v) + 1;
  if (typeof v === 'number') return 8;
  if (typeof v === 'boolean' || v === null) return 1;
  if (Array.isArray(v)) {
    return (v as unknown[]).reduce<number>((s, e) => s + tamanhoFirestore(e), 0);
  }
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).reduce(
      (s, [k, e]) => s + bytes(k) + 1 + tamanhoFirestore(e),
      0,
    );
  }
  throw new TypeError(`tamanhoFirestore: ${typeof v}`);
}

describe('a job document stays under the 1 MiB limit with a family at its ceilings', () => {
  // The ceilings: a root and the store's 50 variations; 50 pictures each (the reader's own cap);
  // every picture refused with the longest motivo; ten-digit store ids; 20-character ERP ids.
  const VARIACOES = 50;
  const PRODUTOS = VARIACOES + 1;
  const ID_ERP = 'p'.repeat(20);
  const liIdDe = (i: number): number | null => (i === 0 ? null : 2_000_000_000 + i);
  const feitos = Array.from({ length: PRODUTOS }, (_, i) => ({
    produtoId: ID_ERP,
    liId: liIdDe(i),
    desfecho: DESFECHO_FOTOS_DO_PRODUTO_LI.nenhumaAceita,
    fotos: 0,
  }));
  const recusadas = Array.from({ length: PRODUTOS * MAX_IMAGENS_PRODUTO_LI }, (_, i) => ({
    liId: liIdDe(i % PRODUTOS),
    imagemId: 3_000_000_000 + i,
    motivo: MOTIVO_FOTO_RECUSADA_LI.caminhoInvalido,
  }));
  /** At most six pendências per produto out of the preparation, each with two references. */
  const pendencias = Array.from({ length: PRODUTOS * 6 }, (_, i) => ({
    codigo: PENDENCIA_IMPORTACAO_LI.filhoDeOutraFamilia,
    liId: liIdDe(i % PRODUTOS),
    referencias: [ID_ERP, ID_ERP],
  }));
  const base = {
    raizLiId: 2_000_000_000,
    caminho: CAMINHO_DO_COMPLETAR_LI.existente,
    erpRaizId: ID_ERP,
    categoria: { erpId: ID_ERP, criadaPelaImportacao: true },
    criacaoAplicada: true,
    completado: true,
    campos: Array.from({ length: 20 }, (_, i) => `campoDoProdutoNumero${String(i)}`),
    pendencias,
    categoriasCriadas: Array.from(
      { length: PROFUNDIDADE_MAX_CATEGORIA_LI },
      (_, i) => 4_000_000_000 + i,
    ),
    criados: PRODUTOS,
    completados: PRODUTOS,
    vinculados: PRODUTOS,
    sumidos: Array.from({ length: PRODUTOS }, () => ID_ERP),
    alvos: Array.from({ length: PRODUTOS }, (_, i) => ({ produtoId: ID_ERP, liId: liIdDe(i) })),
  };
  const sobCursor = progressoDaFamiliaLiSchema.parse({
    ...base,
    fotos: {
      produtoId: ID_ERP,
      proxima: MAX_IMAGENS_PRODUTO_LI - 1,
      reduzida: true,
      enviadas: Array.from({ length: MAX_IMAGENS_PRODUTO_LI }, (_, i) => ({
        imagemId: 3_000_000_000 + i,
        hash: 'a'.repeat(128),
      })),
      feitos,
      recusadas,
    },
    resultadoFotos: null,
  });
  const noFechamento = progressoDaFamiliaLiSchema.parse({
    ...base,
    fotos: null,
    resultadoFotos: {
      produtos: feitos,
      gravadas: 0,
      pendencias: recusadas.map((r) => ({
        codigo: PENDENCIA_IMPORTACAO_LI.fotoRecusada,
        liId: r.liId,
        referencias: [String(r.imagemId), r.motivo],
      })),
    },
  });

  it('the progress alone: under 256 KiB while the pictures run and at the closing', () => {
    expect(tamanhoFirestore(sobCursor)).toBeLessThan(256 * 1024);
    expect(tamanhoFirestore(noFechamento)).toBeLessThan(256 * 1024);
  });

  /** The job at every other ceiling, with `nome` as the store's category and brand names. */
  function jobNoTeto(nome: string, progressoDaFamilia: ProgressoDaFamiliaLi) {
    return importacaoLojaIntegradaSchema.parse({
      ...JOB_MINIMO,
      iniciadoPor: ID_ERP,
      atualizadoEmMs: AGORA_MS,
      alvo: ALVO_IMPORTACAO_LI.selecionados,
      selecionados: Array.from({ length: MAX_SELECIONADOS_LI }, (_, i) => 2_000_000_000 + i),
      simulacaoId: ID_ERP,
      fase: FASE_IMPORTACAO_LI.familias,
      familias: {
        cursorPaiId: 2_000_000_000,
        filhosLidos: Array.from({ length: PRODUTOS }, (_, i) => 2_000_000_000 + i),
      },
      aprendizado: {
        cursorEvidenciaId: '2000000000_2000000000',
        conflitos: Array.from({ length: 50 }, () => '2000000000_2000000000'),
      },
      mapaCategorias: Array.from({ length: 500 }, (_, i) => ({
        id: 2_000_000_000 + i,
        nome,
        pai: { tipo: 'id', id: 2_000_000_000 },
        erpCategoriaId: ID_ERP,
        vinculo: VINCULO_CATEGORIA_IMPORTACAO_LI.semVinculo,
      })),
      marcas: Array.from({ length: 500 }, (_, i) => ({
        id: 2_000_000_000 + i,
        nome,
        ativo: true,
      })),
      aprendizadosSimulados: Array.from({ length: 500 }, () => ({
        grupoId: ID_ERP,
        gradeId: 2_000_000_000,
        opcaoId: 2_000_000_000,
        varianteId: ID_ERP,
      })),
      progressoDaFamilia,
    });
  }

  /** Document size = name + fields + 32. */
  const tamanhoDoDoc = (job: unknown): number =>
    bytes(`${importacaoLojaIntegradaMeta.collectionPath}/${ID_ERP}`) +
    1 +
    16 +
    tamanhoFirestore(job) +
    32;

  it('the whole job, at the closing beside every other ceiling: under 900 KiB', () => {
    const job = jobNoTeto('ã'.repeat(255), noFechamento);
    expect(job.progressoDaFamilia).toEqual(noFechamento);
    expect(tamanhoDoDoc(job)).toBeLessThan(900 * 1024);
  });

  it('the same job under way, its cursor instead of the result: smaller still', () => {
    const emCurso = tamanhoDoDoc(jobNoTeto('ã'.repeat(255), sobCursor));
    const noFim = tamanhoDoDoc(jobNoTeto('ã'.repeat(255), noFechamento));
    expect(emCurso).toBeLessThan(noFim);
  });

  it('with 30-character names, the realistic ceiling: under half the limit', () => {
    expect(tamanhoDoDoc(jobNoTeto('ã'.repeat(30), noFechamento))).toBeLessThan(512 * 1024);
  });

  it('⚠️ the schema refuses a cursor beside the result: that shape would leave almost no margin', () => {
    // What the refusal buys: with the cursor kept beside the result, the worst case grows by the
    // whole cursor, past the 900 KiB this contract allows. The document is assembled by hand,
    // because the job's own field reads this progress as none.
    const ambos = { ...noFechamento, fotos: sobCursor.fotos };
    expect(progressoDaFamiliaLiSchema.safeParse(ambos).success).toBe(false);
    const job = { ...jobNoTeto('ã'.repeat(255), noFechamento), progressoDaFamilia: ambos };
    expect(tamanhoDoDoc(job)).toBeGreaterThan(900 * 1024);
  });
});

describe('the revisao cursor', () => {
  it('a document written before the typed cursor reads from the start, its source kept', () => {
    const job = importacaoLojaIntegradaSchema.parse({
      ...JOB_MINIMO,
      revisao: { cursorProdutoId: 'c:j0:p9', anteriorJobId: 'j0' },
    });
    expect(job.revisao).toEqual({
      etapa: ETAPA_REVISAO_FISCAL_LI.inicio,
      fonteJobId: null,
      ultimaFonte: false,
      depoisProdutoId: null,
      abertos: 0,
      anteriorJobId: 'j0',
    });
    expect(job.revisao).not.toHaveProperty('cursorProdutoId');
  });

  it.each([
    ['nothing done yet', { etapa: 'inicio' }],
    ['every job down to a source is handled', { etapa: 'apos', fonteJobId: 'j1' }],
    [
      'copying a source after a position',
      { etapa: 'copiando', fonteJobId: 'j1', depoisProdutoId: 'p9' },
    ],
    ['copying a source from its start', { etapa: 'copiando', fonteJobId: 'j1' }],
    [
      'copying the walk’s last source',
      { etapa: 'copiando', fonteJobId: 'j1', ultimaFonte: true, depoisProdutoId: 'p9' },
    ],
    ['re-checking from the start', { etapa: 'conferindo' }],
    [
      're-checking after a position, with entries kept',
      { etapa: 'conferindo', abertos: 3, depoisProdutoId: 'p9' },
    ],
  ])('%s: the state reads back as written, the rest at its default', (_r, estado) => {
    const lido = cursorRevisaoFiscalLiSchema.parse(estado);
    expect(lido).toEqual({
      fonteJobId: null,
      ultimaFonte: false,
      depoisProdutoId: null,
      abertos: 0,
      anteriorJobId: null,
      ...estado,
    });
    // A checkpoint's own write parses to itself.
    expect(cursorRevisaoFiscalLiSchema.parse(lido)).toEqual(lido);
  });

  it('a produto id with a colon is a position like any other: no grammar reads it', () => {
    const lido = cursorRevisaoFiscalLiSchema.parse({
      etapa: 'copiando',
      fonteJobId: 'j1',
      depoisProdutoId: 'a:b:c',
    });
    expect(lido.depoisProdutoId).toBe('a:b:c');
  });

  it.each([
    ['an etapa this build does not know', { etapa: 'outra' }],
    ['a negative open count', { abertos: -1 }],
    ['a fractional open count', { abertos: 1.5 }],
    ['an empty source', { fonteJobId: '' }],
    ['an empty position (null says "from the start")', { depoisProdutoId: '' }],
  ])('refuses %s', (_r, estado) => {
    expect(cursorRevisaoFiscalLiSchema.safeParse(estado).success).toBe(false);
  });

  it('two parses never share a cursor default', () => {
    const a = importacaoLojaIntegradaSchema.parse(JOB_MINIMO);
    const b = importacaoLojaIntegradaSchema.parse(JOB_MINIMO);
    a.revisao.abertos = 9;
    expect(b.revisao.abertos).toBe(0);
  });
});

describe('the pendência vocabulary', () => {
  it('the actionable half is exactly the 25 codes a person can fix', () => {
    expect(PENDENCIAS_ACIONAVEIS_LI.size).toBe(25);
    for (const codigo of PENDENCIAS_ACIONAVEIS_LI) {
      expect(pendenciaImportacaoLiSchema.safeParse(codigo).success, codigo).toBe(true);
    }
  });

  it('EQUAL: a store near duplicate is actionable, like an exact store repeat', () => {
    expect(PENDENCIA_IMPORTACAO_LI.skuParecidoNaLoja).toBe('sku-parecido-na-loja');
    expect(ehPendenciaAcionavelLi(PENDENCIA_IMPORTACAO_LI.skuParecidoNaLoja)).toBe(true);
    expect(ehPendenciaAcionavelLi(PENDENCIA_IMPORTACAO_LI.skuRepetidoNaLoja)).toBe(true);
  });

  it('⚠️ NEAR-MISS: a name cut at the ERP’s limit is informational, like a hidden row left out', () => {
    expect(PENDENCIA_IMPORTACAO_LI.nomeCortado).toBe('nome-cortado');
    expect(ehPendenciaAcionavelLi(PENDENCIA_IMPORTACAO_LI.nomeCortado)).toBe(false);
    expect(PENDENCIAS_ACIONAVEIS_LI.has(PENDENCIA_IMPORTACAO_LI.nomeCortado)).toBe(false);
  });

  it.each([
    PENDENCIA_IMPORTACAO_LI.orfao,
    PENDENCIA_IMPORTACAO_LI.naLixeira,
    PENDENCIA_IMPORTACAO_LI.familiaVazia,
    PENDENCIA_IMPORTACAO_LI.tipoDesconhecido,
    PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado,
    PENDENCIA_IMPORTACAO_LI.nomeCortado,
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
    expect(pendenciaImportacaoLiSchema.options).toHaveLength(25 + 13);
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
    ).toMatchObject({
      acao: 'nenhuma',
      aplicada: false,
      camposPreenchidos: [],
      categoriasCriadas: [],
    });
    expect(
      revisaoFiscalLiSchema.parse({ produtoId: 'p1', motivos: ['produto-criado'] }),
    ).toMatchObject({
      liId: null,
      desdeJobId: null,
    });
  });

  describe('the categories a report item names', () => {
    const ITEM = {
      liId: 1000001,
      tipo: 'normal',
      situacaoErp: 'ausente',
      atualizadoEmMs: AGORA_MS,
    };

    it('an item written before the field existed names none', () => {
      expect(itemImportacaoLiSchema.parse(ITEM).categoriasCriadas).toEqual([]);
    });

    it('keeps the ids it is given, in their order, and the route answer inherits them', () => {
      const comCategorias = { ...ITEM, categoriasCriadas: [7645875, 7645876] };
      expect(itemImportacaoLiSchema.parse(comCategorias).categoriasCriadas).toEqual([
        7645875, 7645876,
      ]);
      expect(
        itemRespostaImportacaoLiSchema.parse({ ...comCategorias, acao: 'criar', pendencias: [] })
          .categoriasCriadas,
      ).toEqual([7645875, 7645876]);
    });

    it.each([[0], [-1], [1.5], ['7645875']])('refuses %j: a store category id only', (id) => {
      expect(itemImportacaoLiSchema.safeParse({ ...ITEM, categoriasCriadas: [id] }).success).toBe(
        false,
      );
    });

    it('two parses never share the default', () => {
      const a = itemImportacaoLiSchema.parse(ITEM);
      const b = itemImportacaoLiSchema.parse(ITEM);
      a.categoriasCriadas.push(1);
      expect(b.categoriasCriadas).toEqual([]);
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

  describe('the tax-review answer', () => {
    it('a motivo this build does not know still parses and is kept verbatim, while the STORED entry refuses it', () => {
      const lido = respostaRevisaoFiscalLiSchema.parse({
        entradas: [{ produtoId: 'p1', motivos: ['produto-criado', 'motivo-de-uma-versao-nova'] }],
        proximo: null,
        campoFuturo: 1,
      });
      expect(lido.entradas[0]?.motivos).toEqual(['produto-criado', 'motivo-de-uma-versao-nova']);
      expect(lido).not.toHaveProperty('campoFuturo');
      // The contrast: the job's own document schema stays closed over the motivos it knows.
      expect(
        revisaoFiscalLiSchema.safeParse({ produtoId: 'p1', motivos: ['motivo-de-uma-versao-nova'] })
          .success,
      ).toBe(false);
    });

    it('an entry carries the stored entry’s defaults; ⚠️ NEAR-MISS: a motivo that is not a string, or no `proximo`, is refused', () => {
      expect(
        entradaRespostaRevisaoFiscalLiSchema.parse({ produtoId: 'p1', campoFuturo: true }),
      ).toEqual({ produtoId: 'p1', motivos: [], liId: null, desdeJobId: null, desdeMs: null });
      expect(
        entradaRespostaRevisaoFiscalLiSchema.safeParse({ produtoId: 'p1', motivos: [1] }).success,
      ).toBe(false);
      expect(respostaRevisaoFiscalLiSchema.safeParse({ entradas: [] }).success).toBe(false);
      expect(respostaRevisaoFiscalLiSchema.parse({ entradas: [], proximo: null })).toEqual({
        entradas: [],
        proximo: null,
      });
    });

    it('two parses never share the motivos default', () => {
      const a = entradaRespostaRevisaoFiscalLiSchema.parse({ produtoId: 'p1' });
      const b = entradaRespostaRevisaoFiscalLiSchema.parse({ produtoId: 'p2' });
      expect(a.motivos).not.toBe(b.motivos);
    });
  });
});
