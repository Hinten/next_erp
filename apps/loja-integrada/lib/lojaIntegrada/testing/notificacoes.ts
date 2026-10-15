/**
 * Failure-document fixtures for the ROUTE suites that exercise the token-save
 * re-drive, **for tests only** — the same rule as `fakeDb.ts`: nothing outside a
 * `*.test.ts` imports this.
 *
 * The id comes from the app's own `docIdNotificacaoLi`, so a fixture can never
 * sit at a path the pipeline would not build. Every value is a fake.
 */
import { ORIGEM_NOTIFICACAO_LI, TIPO_TAREFA_LI } from '@delfrance/schemas';

import { docIdNotificacaoLi } from '../notificacoes/notificacao';
import type { DocData, FakeDb } from './fakeDb';

export const COLECAO_NOTIFICACOES_LI = 'notificacoesLojaIntegrada';

/** LI's own stamp, canonical text (the payload's `dataModificacaoLi`). */
export const STAMP_NOTIFICACAO_LI = '2026-10-13T08:15:58.123456';

/** The status vocabulary of a failure document. */
export type StatusNotificacaoLi = 'failed' | 'deferred' | 'parked';

/**
 * Seed one failure document for `contaId`/`numero` as the shared store leaves
 * it, and return its path.
 */
export function seedNotificacaoLi(
  db: FakeDb,
  contaId: string,
  numero: string,
  status: StatusNotificacaoLi,
  over: DocData = {},
): string {
  const payload = {
    tipo: TIPO_TAREFA_LI.pedido,
    contaId,
    numero,
    origem: ORIGEM_NOTIFICACAO_LI.poll,
    dataModificacaoLi: STAMP_NOTIFICACAO_LI,
  };
  const caminho = `${COLECAO_NOTIFICACOES_LI}/${docIdNotificacaoLi(payload)}`;
  db.seed(caminho, {
    ...payload,
    status,
    tentativas: status === 'deferred' ? 3 : 1,
    erro: 'adiado/conta-parada',
    processedAt: 1,
    ...over,
  });
  return caminho;
}
