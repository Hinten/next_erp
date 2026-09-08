import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import {
  fetchReceitaSimples,
  fetchTotalJanelaSimples,
} from '../../lib/nfe/handlers/fetchReceitaSimples';
import { runApuracaoSimples } from '../../lib/nfe/handlers/runApuracaoSimples';
import { safeErrorShape } from '../../lib/nfe/log';
import { getDb } from './lib/admin';

/**
 * Liga a apuração. **Desligada por padrão**, como toda varredura nova neste
 * repositório: a primeira competência apurada num projeto real deve ser uma
 * decisão, não um efeito colateral do deploy.
 */
const HABILITADO = 'NFE_APURACAO_SIMPLES_ENABLED';

/**
 * Apuração mensal do Simples Nacional (#1491) — 03:00 do dia 2, São Paulo.
 *
 * O dia 2 e não o dia 1: a competência apurada é o mês ANTERIOR, e rodar no
 * primeiro instante do mês novo deixaria a janela empatada com notas ainda
 * sendo autorizadas na virada. Um dia de folga custa nada e remove a corrida.
 *
 * Wrapper fino de propósito — toda a decisão está em `runApuracaoSimples`, que
 * é testável sem trigger e sem pipeline. Aqui só se resolve o `db`, injeta-se o
 * agregado real e loga-se o resultado.
 */
export const apuracaoSimplesNacional = onSchedule(
  { schedule: '0 3 2 * *', timeZone: 'America/Sao_Paulo' },
  async () => {
    if (process.env[HABILITADO] !== 'true') {
      logger.info(`apuracaoSimplesNacional: desligada (${HABILITADO} != 'true')`);
      return;
    }

    let resultado;
    try {
      resultado = await runApuracaoSimples({
        fs: getDb(),
        nowMs: Date.now(),
        fetchReceita: fetchReceitaSimples,
        fetchTotalJanela: fetchTotalJanelaSimples,
      });
    } catch (e) {
      // Falha de configuração (competência inválida, credencial) — sobe, para
      // aparecer como erro do job em vez de virar um mês silenciosamente não
      // apurado. A próxima execução tenta de novo.
      logger.error('apuracaoSimplesNacional: falhou', safeErrorShape(e));
      throw e;
    }

    // Contadores por veredito, nunca um total só: "examinou 4, promoveu 0" e
    // "examinou 4, promoveu 4" não podem parecer a mesma linha de log.
    logger.info(
      `apuracaoSimplesNacional competencia=${resultado.competencia} ` +
        `filiais=${resultado.filiaisExaminadas} semConfig=${resultado.semConfig} ` +
        `promovidas=${resultado.promovidas} incompletas=${resultado.incompletas} ` +
        `aguardando=${resultado.aguardandoAutorizacao} foraDoRegime=${resultado.foraDoRegime} ` +
        `erros=${resultado.erros.length}`,
    );

    if (resultado.incompletas > 0) {
      // A razão de existir do contador: notas ilegíveis significam RBT12
      // incompleta, e uma RBT12 incompleta subdeclara. Isto precisa ser
      // visível, não deduzível.
      logger.warn(
        'apuracaoSimplesNacional: competências NÃO promovidas por notas ilegíveis — ' +
          'a RBT12 está incompleta e a alíquota vigente foi mantida',
        resultado.porFilial
          .filter((r) => r.estado === 'incompleta')
          .map((r) => ({ filialId: r.filialId, competencia: r.competencia })),
      );
    }
    if (resultado.erros.length > 0) {
      logger.warn('apuracaoSimplesNacional erros por filial', resultado.erros.slice(0, 10));
    }
  },
);
