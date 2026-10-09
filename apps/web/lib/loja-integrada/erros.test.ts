import { describe, expect, it } from 'vitest';
import { FirebaseError } from 'firebase/app';
import { CODIGO_ERRO_LI } from '@delfrance/schemas';

import {
  LojaIntegradaClientHttpError,
  LojaIntegradaClientNetworkError,
  LojaIntegradaClientRespostaInvalidaError,
} from './client';
import { codigoDaFalhaLi, descreverFalhaCredencialLi, descreverFalhaStatusLi } from './erros';

/**
 * The copy and the token-field policy, keyed on the backend's `code`.
 *
 * The plan's table (section 7) is the spec, and every row is asserted as a
 * PAIR where it matters: the status a code shares with another code must not
 * decide the outcome. Two 422s — refused and malformed — clear the token; a
 * third 422 — a refused date — keeps it. Two 409s — another conta's token and a
 * changed credential — do the opposite of each other.
 */

function http(
  status: number,
  code: string | null,
  extras: { statusLi?: number | null; campos?: readonly string[] } = {},
): InstanceType<typeof LojaIntegradaClientHttpError> {
  return new LojaIntegradaClientHttpError(
    `mensagem do backend ${String(status)}`,
    status,
    code,
    extras,
  );
}

function descrever(err: unknown) {
  const f = descreverFalhaCredencialLi(err);
  if (f === null) throw new Error('esperava uma falha descrita');
  return f;
}

describe('descreverFalhaCredencialLi — the token field policy (plan section 7)', () => {
  it.each([
    ['LI_TOKEN_RECUSADO', 422, CODIGO_ERRO_LI.tokenRecusado],
    ['LI_TOKEN_INVALIDO', 422, CODIGO_ERRO_LI.tokenInvalido],
    ['LI_TOKEN_DE_OUTRA_CONTA', 409, CODIGO_ERRO_LI.tokenDeOutraConta],
    ['LI_CHAMADAS_DESLIGADAS', 503, CODIGO_ERRO_LI.chamadasDesligadas],
  ])('%s CLEARS the token', (_nome, status, code) => {
    expect(descrever(http(status, code)).manterToken).toBe(false);
  });

  it.each([
    ['LI_VALIDACAO_INCONCLUSIVA', 502, CODIGO_ERRO_LI.validacaoInconclusiva],
    ['LI_VALIDADE_INVALIDA', 422, CODIGO_ERRO_LI.validadeInvalida],
    ['LI_VALIDADE_PASSADA', 422, CODIGO_ERRO_LI.validadePassada],
    ['LI_VALIDADE_DISTANTE', 422, CODIGO_ERRO_LI.validadeDistante],
    ['LI_CREDENCIAL_ALTERADA', 409, CODIGO_ERRO_LI.credencialAlterada],
    ['LI_CREDENCIAL_INVALIDA', 409, CODIGO_ERRO_LI.credencialInvalida],
    ['LI_ESTACIONAMENTO_EM_CONFLITO', 503, CODIGO_ERRO_LI.estacionamentoEmConflito],
  ])('%s KEEPS the token', (_nome, status, code) => {
    expect(descrever(http(status, code)).manterToken).toBe(true);
  });

  it('⭐ a network failure KEEPS it — resending the same token is the point', () => {
    expect(descrever(new LojaIntegradaClientNetworkError(new TypeError('x'))).manterToken).toBe(
      true,
    );
  });

  it('⭐ near miss on the SAME status: 422 recusado clears, 422 validade keeps', () => {
    // A status-keyed implementation gives these the same answer.
    expect(descrever(http(422, CODIGO_ERRO_LI.tokenRecusado)).manterToken).toBe(false);
    expect(descrever(http(422, CODIGO_ERRO_LI.validadePassada)).manterToken).toBe(true);
  });

  it('⭐ near miss on 409: another conta clears, a changed credential keeps', () => {
    expect(descrever(http(409, CODIGO_ERRO_LI.tokenDeOutraConta)).manterToken).toBe(false);
    expect(descrever(http(409, CODIGO_ERRO_LI.credencialAlterada)).manterToken).toBe(true);
  });

  it('⭐ near miss on 503: the read switch off clears and stays put; a park conflict keeps and re-reads', () => {
    const desligadas = descrever(http(503, CODIGO_ERRO_LI.chamadasDesligadas));
    expect(desligadas).toMatchObject({
      manterToken: false,
      recarregarStatus: false,
      cor: 'orange',
    });
    const conflito = descrever(http(503, CODIGO_ERRO_LI.estacionamentoEmConflito));
    expect(conflito).toMatchObject({ manterToken: true, recarregarStatus: true, cor: 'yellow' });
    // And neither is the uncoded 5xx, which cannot know whether the write landed.
    expect(descrever(http(503, null)).mensagem).toContain('pode ou não ter sido salvo');
    expect(desligadas.mensagem).not.toContain('pode ou não ter sido salvo');
  });

  it('a 499 (the request was interrupted) keeps the token — nothing was saved', () => {
    expect(descrever(http(499, null)).manterToken).toBe(true);
  });

  it('a 2xx this build cannot read CLEARS it — the write most likely landed', () => {
    const f = descrever(new LojaIntegradaClientRespostaInvalidaError('formato', 200, ['x']));
    expect(f.manterToken).toBe(false);
    expect(f.recarregarStatus).toBe(true);
  });

  it('an unrecognised code and status clears it (the hygiene default)', () => {
    expect(descrever(http(418, 'LI_ALGO_NOVO')).manterToken).toBe(false);
  });
});

describe('descreverFalhaCredencialLi — where the copy goes', () => {
  it.each([
    CODIGO_ERRO_LI.validadeInvalida,
    CODIGO_ERRO_LI.validadePassada,
    CODIGO_ERRO_LI.validadeDistante,
  ])('%s goes on the date field', (code) => {
    expect(descrever(http(422, code)).campo).toBe('expiraEm');
  });

  it('a token verdict goes in the panel, not on the date field', () => {
    expect(descrever(http(422, CODIGO_ERRO_LI.tokenRecusado)).campo).toBeNull();
  });
});

describe('descreverFalhaCredencialLi — re-reading the status', () => {
  it.each([
    CODIGO_ERRO_LI.credencialAlterada,
    CODIGO_ERRO_LI.credencialAusente,
    CODIGO_ERRO_LI.credencialInvalida,
  ])('%s re-reads it — the stored credential differs from the screen', (code) => {
    expect(descrever(http(409, code)).recarregarStatus).toBe(true);
  });

  it('⭐ a refused or malformed token does NOT — a re-read would swallow a concurrent save', () => {
    // Re-reading after a failure that wrote nothing would quietly adopt a
    // version another operator wrote, and the next save would overwrite their
    // token with no 409. Only failures that SAY the state differs re-read.
    expect(descrever(http(422, CODIGO_ERRO_LI.tokenRecusado)).recarregarStatus).toBe(false);
    expect(descrever(http(422, CODIGO_ERRO_LI.tokenInvalido)).recarregarStatus).toBe(false);
    expect(descrever(http(502, CODIGO_ERRO_LI.validacaoInconclusiva)).recarregarStatus).toBe(false);
    expect(descrever(new LojaIntegradaClientNetworkError()).recarregarStatus).toBe(false);
  });

  it('an uncoded 5xx re-reads it — the write may have landed before the failure', () => {
    expect(descrever(http(500, null)).recarregarStatus).toBe(true);
  });
});

describe('descreverFalhaCredencialLi — the words', () => {
  it('a refusal names Loja Integrada’s own status, and says nothing was saved', () => {
    const f = descrever(http(422, CODIGO_ERRO_LI.tokenRecusado, { statusLi: 401 }));
    expect(f.mensagem).toContain('recusou este token (HTTP 401)');
    expect(f.mensagem).toContain('Nada foi salvo');
  });

  it('a malformed token says nothing was even SENT — the opposite advice to a refusal', () => {
    const f = descrever(http(422, CODIGO_ERRO_LI.tokenInvalido));
    expect(f.mensagem).toContain('Nada foi enviado à Loja Integrada');
    expect(f.mensagem).not.toContain('recusou');
  });

  it('an inconclusive validation says to try again', () => {
    const f = descrever(http(502, CODIGO_ERRO_LI.validacaoInconclusiva, { statusLi: 503 }));
    expect(f.mensagem).toContain('(HTTP 503)');
    expect(f.mensagem).toContain('Tente de novo');
    expect(f.cor).toBe('yellow');
  });

  it('a changed credential says the screen was reloaded', () => {
    expect(descrever(http(409, CODIGO_ERRO_LI.credencialAlterada)).mensagem).toContain(
      'foi recarregada',
    );
  });

  it('an unreadable credential names the paths and the remedy', () => {
    const f = descrever(
      http(409, CODIGO_ERRO_LI.credencialInvalida, { campos: ['reconexaoPendente.status'] }),
    );
    expect(f.mensagem).toContain('reconexaoPendente.status');
    expect(f.mensagem).toContain('Remova o token');
  });

  it('the read switch off says the integration is off until the cutover, and nothing was sent', () => {
    const f = descrever(http(503, CODIGO_ERRO_LI.chamadasDesligadas));
    expect(f.mensagem).toContain('está desligada até a migração');
    expect(f.mensagem).toContain('Nada foi enviado à Loja Integrada nem salvo');
    expect(f.mensagem).not.toContain('Tente de novo');
    expect(f.campo).toBeNull();
  });

  it('a missing credential on a renewal asks for a save', () => {
    expect(descrever(http(409, CODIGO_ERRO_LI.credencialAusente)).mensagem).toContain(
      'Salve um Personal Token',
    );
  });

  it('a 403 says permission, never the backend’s auth wording about "token"', () => {
    // verifyCaller's 401 text says "Token inválido ou expirado" about the
    // FIREBASE token — read next to a Personal Token field it would send the
    // operator after the wrong token.
    const f = descrever(http(403, null));
    expect(f.mensagem).toContain('permissão');
    expect(descrever(http(401, null)).mensagem).toContain('sessão');
  });

  it('a FirebaseError (the ID token could not be read) is described, not rethrown', () => {
    const f = descrever(new FirebaseError('auth/network-request-failed', 'x'));
    expect(f.mensagem).toContain('sessão');
  });
});

describe('descreverFalhaCredencialLi — every code the credential routes answer has its own copy', () => {
  /**
   * The two codes only the step-3 flows answer (the context loader refuses an
   * inactive or parked conta; the credential routes deliberately do not). A
   * NEW code fails this test until it gets copy here or a line in this set.
   */
  const SO_DOS_FLUXOS = new Set<string>([
    CODIGO_ERRO_LI.contaInativa,
    CODIGO_ERRO_LI.reconexaoPendente,
  ]);

  it.each(Object.values(CODIGO_ERRO_LI).filter((c) => !SO_DOS_FLUXOS.has(c)))(
    '%s is described by its code, never by the backend sentence',
    (code) => {
      // The status is one no branch keys on, so only the code can pick the copy.
      expect(descrever(http(418, code)).mensagem).not.toBe('mensagem do backend 418');
    },
  );

  it('near-miss: a code without copy falls back to the backend sentence', () => {
    expect(descrever(http(418, CODIGO_ERRO_LI.contaInativa)).mensagem).toBe(
      'mensagem do backend 418',
    );
  });
});

describe('descreverFalhaCredencialLi — rule 6', () => {
  it('⭐ returns null for an error it does not know, so the panel RETHROWS it', () => {
    expect(descreverFalhaCredencialLi(new Error('qualquer'))).toBeNull();
    expect(descreverFalhaCredencialLi(new TypeError('bug'))).toBeNull();
    expect(descreverFalhaCredencialLi('texto')).toBeNull();
  });

  it('narrows RESPOSTA_INVALIDA before its base class — it is not an ordinary failure', () => {
    // Base-first would read code 'RESPOSTA_INVALIDA' through the switch's
    // default and fall to the status branch: a 200 would get the generic
    // message and NO re-read.
    const f = descrever(new LojaIntegradaClientRespostaInvalidaError('formato x', 200, ['x']));
    expect(f.mensagem).toBe('formato x');
    expect(f.recarregarStatus).toBe(true);
  });
});

describe('descreverFalhaStatusLi — the status read', () => {
  it('a network failure is repeatable', () => {
    expect(descreverFalhaStatusLi(new LojaIntegradaClientNetworkError())).toEqual({
      mensagem: 'Não foi possível contatar o backend da Loja Integrada.',
      repetivel: true,
    });
  });

  it('an unreadable stored credential is NOT repeatable, and points at "Remover token"', () => {
    const f = descreverFalhaStatusLi(
      http(409, CODIGO_ERRO_LI.credencialInvalida, { campos: ['(raiz)'] }),
    );
    expect(f.repetivel).toBe(false);
    expect(f.mensagem).toContain('Remova o token');
  });

  it('a 5xx is repeatable; a 4xx and a 501 are not', () => {
    expect(descreverFalhaStatusLi(http(503, null)).repetivel).toBe(true);
    expect(descreverFalhaStatusLi(http(404, CODIGO_ERRO_LI.contaNaoEncontrada)).repetivel).toBe(
      false,
    );
    expect(descreverFalhaStatusLi(http(501, null)).repetivel).toBe(false);
  });

  it('a 2xx this build cannot read is not repeatable', () => {
    expect(
      descreverFalhaStatusLi(new LojaIntegradaClientRespostaInvalidaError('m', 200, [])).repetivel,
    ).toBe(false);
  });

  it('is TOTAL — an unknown error still gets copy', () => {
    expect(descreverFalhaStatusLi(new Error('x'))).toEqual({
      mensagem: 'Não foi possível consultar a credencial desta conta.',
      repetivel: false,
    });
  });
});

describe('codigoDaFalhaLi', () => {
  it('reads the code of an HTTP error, null for anything else', () => {
    expect(codigoDaFalhaLi(http(409, CODIGO_ERRO_LI.credencialInvalida))).toBe(
      'LI_CREDENCIAL_INVALIDA',
    );
    expect(codigoDaFalhaLi(new LojaIntegradaClientNetworkError())).toBeNull();
    expect(codigoDaFalhaLi(null)).toBeNull();
  });
});
