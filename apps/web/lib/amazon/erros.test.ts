import { describe, expect, it } from 'vitest';
import { CODIGO_ERRO_AMAZON } from '@delfrance/schemas';

import {
  AmazonBackendError,
  AmazonRedeError,
  AmazonRespostaInvalidaError,
  MENSAGENS_CODIGO_ERRO_AMAZON,
  ehCodigoErroAmazon,
  mensagemErroAmazon,
  mensagemHttpAmazon,
  repetivelAmazon,
} from './erros';

/**
 * The copy for a failed call to `apps/amazon`, TOTAL over the two code families
 * the conta routes answer with: the routes' own `CODIGO_ERRO_AMAZON`, and
 * `verifyCaller`'s (`auth/…` on a 401, `app/…` on a 500, plus its codeless
 * 401/403).
 *
 * The contract's codes are transcribed LITERALLY below rather than derived from
 * the map under test — deriving them would make the totality test pass for
 * whatever the map happens to contain.
 */
const CODIGOS_DO_CONTRATO = [
  'AMAZON_ID_INVALIDO',
  'AMAZON_CONTA_NAO_ENCONTRADA',
  'AMAZON_CHAMADAS_DESLIGADAS',
  'AMAZON_CONFIG_AUSENTE',
] as const;

const MENSAGEM_DO_BACKEND = 'Frase do backend que não deve aparecer quando há cópia própria.';

function erro(status: number, codigo: string | null, message = MENSAGEM_DO_BACKEND) {
  return new AmazonBackendError(message, status, codigo);
}

describe('MENSAGENS_CODIGO_ERRO_AMAZON — total over the contract', () => {
  it('covers the contract exactly — no code missing, none invented', () => {
    expect(Object.values(CODIGO_ERRO_AMAZON).sort()).toEqual([...CODIGOS_DO_CONTRATO].sort());
    expect(Object.keys(MENSAGENS_CODIGO_ERRO_AMAZON).sort()).toEqual(
      [...CODIGOS_DO_CONTRATO].sort(),
    );
  });

  it.each(CODIGOS_DO_CONTRATO)('gives %s its own pt-BR copy, never the raw code', (codigo) => {
    const copia = mensagemErroAmazon(erro(400, codigo));
    expect(copia.length).toBeGreaterThan(30);
    expect(copia).not.toContain(codigo);
    expect(copia).not.toContain('undefined');
  });

  it('the switch-off copy says nothing was sent and that retrying cannot help by itself', () => {
    const copia = mensagemErroAmazon(erro(503, CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS));
    expect(copia).toContain('desligada até a virada');
    expect(copia).toContain('Nada foi enviado');
    // Not the backend's sentence: the copy is keyed on the code.
    expect(copia).not.toContain(MENSAGEM_DO_BACKEND);
  });

  it('CONFIG_AUSENTE appends the backend sentence — variable NAMES, which say what to set', () => {
    const copia = mensagemErroAmazon(
      erro(
        500,
        CODIGO_ERRO_AMAZON.CONFIG_AUSENTE,
        'Configuração da Amazon ausente ou inválida neste backend: AMAZON_APPLICATION_ID.',
      ),
    );
    expect(copia).toContain('deploy');
    expect(copia).toContain('AMAZON_APPLICATION_ID');
  });

  it('the near miss: no OTHER code echoes the backend sentence', () => {
    for (const codigo of CODIGOS_DO_CONTRATO.filter((c) => c !== 'AMAZON_CONFIG_AUSENTE')) {
      expect(mensagemErroAmazon(erro(400, codigo))).not.toContain(MENSAGEM_DO_BACKEND);
    }
  });
});

describe("verifyCaller's codes", () => {
  it.each(['auth/id-token-expired', 'auth/id-token-revoked', 'auth/argument-error'])(
    'a 401 coded %s asks the operator to sign in again',
    (codigo) => {
      const copia = mensagemErroAmazon(erro(401, codigo));
      expect(copia).toContain('entre de novo');
      expect(copia).not.toContain(MENSAGEM_DO_BACKEND);
    },
  );

  it('a 500 coded app/… is a server configuration problem, not a session problem', () => {
    const copia = mensagemErroAmazon(erro(500, 'app/invalid-credential'));
    expect(copia).toContain('deploy');
    expect(copia).not.toContain('entre de novo');
  });

  it('the codeless 401 (no Bearer token) is the session copy, from the status', () => {
    expect(mensagemErroAmazon(erro(401, null))).toContain('entre de novo');
  });

  it('the codeless 403 (missing permission) says which permission', () => {
    const copia = mensagemErroAmazon(erro(403, null));
    expect(copia).toContain('permissão');
    expect(copia).toContain('integrações');
  });

  it('⚠️ near miss: a code that merely CONTAINS "auth/" is not a Firebase Auth code', () => {
    expect(mensagemErroAmazon(erro(400, 'AMAZON_X_auth/y'))).toBe(MENSAGEM_DO_BACKEND);
  });
});

describe('codes and bodies this build does not know', () => {
  it("a code a newer backend added shows the backend's own (pt-BR) sentence", () => {
    expect(mensagemErroAmazon(erro(409, 'AMAZON_CODIGO_NOVO'))).toBe(MENSAGEM_DO_BACKEND);
  });

  it('a codeless body falls to the status — never a raw body', () => {
    expect(mensagemErroAmazon(erro(404, null))).toContain('HTTP 404');
    expect(mensagemErroAmazon(erro(502, null))).toContain('HTTP 502');
    expect(mensagemErroAmazon(erro(418, null))).toContain('HTTP 418');
  });

  it('an unreadable 2xx keeps the sentence the client built for it', () => {
    const err = new AmazonRespostaInvalidaError('Frase do cliente.', 200, ['connected']);
    expect(mensagemErroAmazon(err)).toBe('Frase do cliente.');
  });

  it('ehCodigoErroAmazon refuses inherited keys', () => {
    expect(ehCodigoErroAmazon('constructor')).toBe(false);
    expect(ehCodigoErroAmazon('__proto__')).toBe(false);
    expect(ehCodigoErroAmazon(null)).toBe(false);
    expect(ehCodigoErroAmazon(CODIGO_ERRO_AMAZON.ID_INVALIDO)).toBe(true);
  });

  it('mensagemHttpAmazon never prints undefined', () => {
    for (const status of [400, 401, 403, 404, 409, 500, 501, 503, 504]) {
      expect(mensagemHttpAmazon(status)).not.toContain('undefined');
    }
  });
});

describe('repetivelAmazon', () => {
  it('a codeless 5xx may be transient', () => {
    expect(repetivelAmazon(erro(502, null))).toBe(true);
    expect(repetivelAmazon(erro(503, null))).toBe(true);
  });

  it('⚠️ near miss: the switch-off 503 is NOT — it answers the same until someone acts', () => {
    expect(repetivelAmazon(erro(503, CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS))).toBe(false);
  });

  it('a 501, a 4xx, an Admin init 500 and an unreadable 2xx are never repeatable', () => {
    expect(repetivelAmazon(erro(501, null))).toBe(false);
    expect(repetivelAmazon(erro(404, null))).toBe(false);
    expect(repetivelAmazon(erro(500, 'app/invalid-credential'))).toBe(false);
    expect(repetivelAmazon(new AmazonRespostaInvalidaError('x', 200, []))).toBe(false);
  });

  it('⚠️ an unreadable answer is never repeatable WHATEVER its status (narrowed first)', () => {
    // A 5xx-looking status is what a codeless base error retries on, so only
    // the subclass check can answer `false` here — a 200 cannot tell the two
    // orders apart.
    expect(repetivelAmazon(new AmazonRespostaInvalidaError('x', 503, []))).toBe(false);
    expect(mensagemErroAmazon(new AmazonRespostaInvalidaError('Frase do cliente.', 503, []))).toBe(
      'Frase do cliente.',
    );
  });
});

describe('the classes', () => {
  it('AmazonRespostaInvalidaError IS an AmazonBackendError (catch sites narrow to the base)', () => {
    const err = new AmazonRespostaInvalidaError('x', 200, ['a']);
    expect(err).toBeInstanceOf(AmazonBackendError);
    expect(err.codigo).toBeNull();
    expect(err.campos).toEqual(['a']);
    expect(err.name).toBe('AmazonRespostaInvalidaError');
  });

  it("AmazonRedeError's message is fixed; the transport's text stays on `cause`", () => {
    const causa = new TypeError('net::ERR_CONNECTION_REFUSED 10.0.0.1');
    const err = new AmazonRedeError(causa);
    expect(err.message).toBe('Falha de rede ao contatar o backend da Amazon.');
    expect(err.message).not.toContain('10.0.0.1');
    expect(err.cause).toBe(causa);
    expect(err).not.toBeInstanceOf(AmazonBackendError);
  });
});
