import { describe, expect, it } from 'vitest';
import {
  MAX_TOKEN_LI,
  SITUACAO_VALIDADE_TOKEN_LI,
  type RespostaCredencialLojaIntegrada,
  type StatusContaLojaIntegrada,
  corpoRenovarValidadeLiSchema,
  corpoSalvarCredencialLiSchema,
  janelaDeValidadeTokenLi,
} from '@delfrance/schemas';

import {
  MENSAGEM_REMOVIDO,
  bloqueioAoRenovar,
  bloqueioAoSalvar,
  bloqueioDoTokenLi,
  dataNaJanela,
  mensagemRenovado,
  mensagemSalvo,
  montarCorpoRenovar,
  montarCorpoSalvar,
  statusDaResposta,
} from './credencialForm';

/** 2026-10-08 15:00 in São Paulo. */
const AGORA = Date.UTC(2026, 9, 8, 18, 0);
const JANELA = janelaDeValidadeTokenLi(AGORA);

const SEM_TOKEN: StatusContaLojaIntegrada = {
  configurado: false,
  expiraEm: null,
  diasParaExpirar: null,
  situacaoValidade: null,
  atualizadoEmMs: null,
  versaoCredencialUs: null,
  reconexaoPendente: null,
};

const COM_TOKEN: StatusContaLojaIntegrada = {
  configurado: true,
  expiraEm: '2026-12-31',
  diasParaExpirar: 84,
  situacaoValidade: SITUACAO_VALIDADE_TOKEN_LI.ok,
  atualizadoEmMs: AGORA - 86_400_000,
  versaoCredencialUs: 1_790_000_000_123_456,
  reconexaoPendente: null,
};

describe('the window the picker and the route share', () => {
  it('is today..today + 120 days in São Paulo', () => {
    expect(JANELA).toEqual({ desde: '2026-10-08', ate: '2027-02-05' });
  });

  it('⭐ accepts both ends, refuses one day past either (the near misses)', () => {
    expect(dataNaJanela('2026-10-08', JANELA)).toBe(true);
    expect(dataNaJanela('2027-02-05', JANELA)).toBe(true);
    expect(dataNaJanela('2026-10-07', JANELA)).toBe(false);
    expect(dataNaJanela('2027-02-06', JANELA)).toBe(false);
  });

  it('refuses anything that is not YYYY-MM-DD, even when it sorts inside the window', () => {
    // '2026-10-1' sorts between the bounds as a string but is not a date.
    expect(dataNaJanela('2026-10-1', JANELA)).toBe(false);
    expect(dataNaJanela('08/10/2026', JANELA)).toBe(false);
  });
});

describe('montarCorpoSalvar — the body the save route receives', () => {
  it('⭐ trims the token at both ENDS — a paste carries a trailing line break', () => {
    const corpo = montarCorpoSalvar('  abc\n', '2026-12-31', COM_TOKEN);
    expect(corpo.token).toBe('abc');
  });

  it('⭐ the near miss: whitespace INSIDE is left alone, for the backend to refuse', () => {
    // The backend's `invalido` verdict is the authority on what a Personal
    // Token looks like; the form never "repairs" one.
    expect(montarCorpoSalvar('a bc', '2026-12-31', COM_TOKEN).token).toBe('a bc');
  });

  it('sends the version of the status the operator saw', () => {
    expect(montarCorpoSalvar('abc', '2026-12-31', COM_TOKEN)).toEqual({
      token: 'abc',
      expiraEm: '2026-12-31',
      versaoEsperada: 1_790_000_000_123_456,
    });
  });

  it('sends null when the operator saw no token — the create path', () => {
    expect(montarCorpoSalvar('abc', '2026-12-31', SEM_TOKEN).versaoEsperada).toBeNull();
  });

  it('is exactly what the route’s strict schema accepts, and trims the way it does', () => {
    const corpo = montarCorpoSalvar(' abc ', '2026-12-31', COM_TOKEN);
    const r = corpoSalvarCredencialLiSchema.safeParse(corpo);
    expect(r.success).toBe(true);
    // The route trims too; both must agree on where the token ends.
    expect(r.data?.token).toBe(corpo.token);
  });
});

describe('montarCorpoRenovar — the body the renewal route receives', () => {
  it('carries the date and the version, never a token', () => {
    const corpo = montarCorpoRenovar('2027-01-15', COM_TOKEN);
    expect(corpo).toEqual({ expiraEm: '2027-01-15', versaoEsperada: 1_790_000_000_123_456 });
    expect(corpoRenovarValidadeLiSchema.safeParse(corpo).success).toBe(true);
  });

  it('is null when there is no stored token to renew', () => {
    expect(montarCorpoRenovar('2027-01-15', SEM_TOKEN)).toBeNull();
    // A contract breach — configured with no version — is not sent either:
    // the route requires a number.
    expect(montarCorpoRenovar('2027-01-15', { ...COM_TOKEN, versaoCredencialUs: null })).toBeNull();
  });
});

describe('bloqueioDoTokenLi — what the token field says before anything is sent', () => {
  it('accepts a token', () => {
    expect(bloqueioDoTokenLi('abc')).toBeNull();
  });

  it('refuses a whitespace-only token', () => {
    expect(bloqueioDoTokenLi('')).toBe('sem-token');
    expect(bloqueioDoTokenLi('  \n ')).toBe('sem-token');
  });

  it('⭐ refuses a paste past MAX_TOKEN_LI — the route would answer a 400 "malformed request"', () => {
    expect(bloqueioDoTokenLi('x'.repeat(MAX_TOKEN_LI + 1))).toBe('token-longo');
    // The near misses: exactly the bound, and the bound padded at the ends —
    // the route measures AFTER trimming, and so must this.
    expect(bloqueioDoTokenLi('x'.repeat(MAX_TOKEN_LI))).toBeNull();
    expect(bloqueioDoTokenLi(`  ${'x'.repeat(MAX_TOKEN_LI)}\r\n`)).toBeNull();
  });

  it('agrees with the route schema on both sides of the bound', () => {
    for (const token of ['x'.repeat(MAX_TOKEN_LI), 'x'.repeat(MAX_TOKEN_LI + 1), ' x ', ' ']) {
      const aceita = corpoSalvarCredencialLiSchema.safeParse(
        montarCorpoSalvar(token, '2026-12-31', COM_TOKEN),
      ).success;
      expect(bloqueioDoTokenLi(token) === null).toBe(aceita);
    }
  });
});

describe('bloqueioAoSalvar — when "Validar e salvar" may be sent', () => {
  const base = {
    bloqueioDoToken: null,
    expiraEm: '2026-12-31',
    janela: JANELA,
    status: COM_TOKEN,
  };

  it('is sendable with a token, a date in the window and a loaded status', () => {
    expect(bloqueioAoSalvar(base)).toBeNull();
    expect(bloqueioAoSalvar({ ...base, status: SEM_TOKEN })).toBeNull();
  });

  it('⭐ waits for the status — without it there is no version to send', () => {
    expect(bloqueioAoSalvar({ ...base, status: undefined })).toBe('sem-status');
  });

  it('refuses whatever the token field refuses', () => {
    expect(bloqueioAoSalvar({ ...base, bloqueioDoToken: 'sem-token' })).toBe('sem-token');
    expect(bloqueioAoSalvar({ ...base, bloqueioDoToken: 'token-longo' })).toBe('token-longo');
  });

  it('refuses no date, and a date outside the window', () => {
    expect(bloqueioAoSalvar({ ...base, expiraEm: null })).toBe('sem-data');
    expect(bloqueioAoSalvar({ ...base, expiraEm: '2027-02-06' })).toBe('data-fora-da-janela');
  });
});

describe('bloqueioAoRenovar — when "Só atualizar a validade" may be sent', () => {
  const base = { expiraEm: '2026-12-31', janela: JANELA, status: COM_TOKEN };

  it('is sendable for a stored token and a date in the window', () => {
    expect(bloqueioAoRenovar(base)).toBeNull();
  });

  it('⭐ refuses when there is no stored token — there is nothing to renew', () => {
    expect(bloqueioAoRenovar({ ...base, status: SEM_TOKEN })).toBe('sem-credencial');
  });

  it('waits for the status, and for a date in the window', () => {
    expect(bloqueioAoRenovar({ ...base, status: undefined })).toBe('sem-status');
    expect(bloqueioAoRenovar({ ...base, expiraEm: null })).toBe('sem-data');
    expect(bloqueioAoRenovar({ ...base, expiraEm: '2026-10-07' })).toBe('data-fora-da-janela');
  });
});

describe('after a successful write', () => {
  const resposta: RespostaCredencialLojaIntegrada = {
    ...COM_TOKEN,
    versaoCredencialUs: 1_790_000_200_000_000,
    reconexaoResolvida: true,
  };

  it('⭐ the cached status takes the ANSWER’s version — the next write carries it', () => {
    const status = statusDaResposta(resposta);
    expect(status.versaoCredencialUs).toBe(1_790_000_200_000_000);
    expect(montarCorpoSalvar('abc', '2026-12-31', status).versaoEsperada).toBe(
      1_790_000_200_000_000,
    );
    // `reconexaoResolvida` is about the write, not the conta.
    expect(status).not.toHaveProperty('reconexaoResolvida');
  });

  it('the save says validated, the date as DD/MM/AAAA, and the resolved park', () => {
    expect(mensagemSalvo(resposta)).toBe(
      'Token validado e salvo. Validade até 31/12/2026. A reconexão pendente foi resolvida.',
    );
  });

  it('the near miss: no park resolved, no sentence about it', () => {
    expect(mensagemSalvo({ ...resposta, reconexaoResolvida: false })).toBe(
      'Token validado e salvo. Validade até 31/12/2026.',
    );
  });

  it('the renewal and the removal say what happened', () => {
    expect(mensagemRenovado({ ...resposta, reconexaoResolvida: false })).toBe(
      'Token salvo revalidado na Loja Integrada. Validade até 31/12/2026.',
    );
    expect(MENSAGEM_REMOVIDO).toContain('Token removido');
  });
});
