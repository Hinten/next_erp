import {
  ACAO_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  CATEGORIAS_IMPORTACAO_LI,
  FASE_IMPORTACAO_LI,
  FOTOS_IMPORTACAO_LI,
  MODO_IMPORTACAO_LI,
  type RespostaImportacaoLi,
  STATUS_IMPORTACAO_LI,
} from '@delfrance/schemas';

/**
 * One Loja Integrada product-import job as the backend answers it
 * (`respostaImportacaoLiSchema`), for TESTS: a running `aplicar` with every
 * counter at zero, overridden field by field. The ids are obviously fake.
 *
 * Test-only, and it imports no `vitest`, so it is safe to import from anywhere
 * a test runs.
 */
export function respostaImportacaoLiFalsa(
  over: Partial<RespostaImportacaoLi> = {},
): RespostaImportacaoLi {
  const agora = Date.now();
  return {
    jobId: 'job-falso-1',
    integracaoId: 'conta-falsa-1',
    status: STATUS_IMPORTACAO_LI.executando,
    fase: FASE_IMPORTACAO_LI.familias,
    motivo: null,
    modo: MODO_IMPORTACAO_LI.aplicar,
    alvo: ALVO_IMPORTACAO_LI.todos,
    acao: ACAO_IMPORTACAO_LI.soVincular,
    categorias: CATEGORIAS_IMPORTACAO_LI.soVincular,
    fotos: FOTOS_IMPORTACAO_LI.naoImportar,
    selecionados: 0,
    simulacaoId: null,
    iniciadoEmMs: agora - 60_000,
    atualizadoEmMs: agora,
    concluidoEmMs: null,
    contadores: {
      familias: 0,
      vinculados: 0,
      criados: 0,
      completados: 0,
      semMudanca: 0,
      pendenciasAcionaveis: 0,
      pendenciasInformativas: 0,
      fotos: 0,
      falhas: 0,
    },
    listagem: { paginas: 0, linhas: 0, totalLi: null, divergente: false },
    pausas429: 0,
    fotosIndisponiveis: false,
    ...over,
  };
}
