import { describe, expect, it } from 'vitest';
import { CODIGO_ERRO_LI } from '@delfrance/schemas';

import {
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAlteradaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
  LiEstacionamentoEmConflitoError,
} from './erros';
import { isLiAppError, respostaDeErroLi } from './respond';

const ID = 'conta-li-1';

describe('respostaDeErroLi', () => {
  const casos = [
    [new LiContaNaoEncontradaError(ID), 404, CODIGO_ERRO_LI.contaNaoEncontrada],
    [new LiContaInativaError(ID), 409, CODIGO_ERRO_LI.contaInativa],
    [new LiCredencialAusenteError(ID), 409, CODIGO_ERRO_LI.credencialAusente],
    [new LiCredencialAlteradaError(ID), 409, CODIGO_ERRO_LI.credencialAlterada],
    [new LiContaParadaError(ID, 401, 1), 409, CODIGO_ERRO_LI.reconexaoPendente],
    [new LiEstacionamentoEmConflitoError(ID, 3), 503, CODIGO_ERRO_LI.estacionamentoEmConflito],
  ] as const;

  for (const [err, status, code] of casos) {
    it(`${err.name} → ${String(status)} ${code}, no issues`, async () => {
      expect(isLiAppError(err)).toBe(true);
      const res = respostaDeErroLi(err);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: err.message, code });
    });
  }

  it('LiCredencialInvalidaError → 409 with the field PATHS as issues', async () => {
    const res = respostaDeErroLi(
      new LiCredencialInvalidaError(ID, ['tokenFingerprint', 'reconexaoPendente.status']),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: CODIGO_ERRO_LI.credencialInvalida,
      issues: ['tokenFingerprint', 'reconexaoPendente.status'],
    });
  });

  it('isLiAppError rejects anything that is not an app error', () => {
    expect(isLiAppError(new Error('x'))).toBe(false);
    expect(isLiAppError(Object.assign(new Error('x'), { code: 9 }))).toBe(false);
  });
});
