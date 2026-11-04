/**
 * The Amazon panel's describers and the callback toast's copy.
 *
 * The callback's reasons are a CLOSED set in the shared contract
 * (`motivoRetornoOAuthAmazonSchema`). They are transcribed LITERALLY here rather
 * than derived from the map under test — deriving them would make the test pass
 * for whatever the map happens to contain, which is exactly the property that
 * has to fail when the backend gains a reason without copy. (Typecheck already
 * forces a key per reason; this pins that no key is an invention either.)
 */
import { describe, expect, it } from 'vitest';
import { FirebaseError } from 'firebase/app';
import {
  CHAVE_RETORNO_OAUTH_AMAZON,
  CODIGO_ERRO_AMAZON,
  motivoRetornoOAuthAmazonSchema,
} from '@delfrance/schemas';

import {
  AmazonBackendError,
  AmazonRedeError,
  AmazonRespostaInvalidaError,
} from '@/lib/amazon/erros';
import { oauthCallbackMessage } from '@/lib/oauth/useOAuthCallbackToast';
import {
  AMAZON_CALLBACK_TOAST,
  MENSAGENS_RETORNO_OAUTH_AMAZON,
  describeAmazonConnectFailure,
  describeAmazonContaFailure,
} from './amazonOAuthErrors';

/** Transcribed from the contract's closed set — do not derive. */
const MOTIVOS_DO_BACKEND = [
  'config',
  'bad_state',
  'integracao_desligada',
  'missing_params',
  'vendedor_invalido',
  'conta',
  'vendedor_diferente',
  'vendedor_em_outra_conta',
  'codigo_invalido',
  'server_config',
  'amazon_indisponivel',
  'tempo_esgotado',
  'rede',
  'resposta_invalida',
  'conflito',
  'exchange',
] as const;

describe('MENSAGENS_RETORNO_OAUTH_AMAZON', () => {
  it('the transcription matches the contract (a widened contract fails HERE first)', () => {
    expect([...motivoRetornoOAuthAmazonSchema.options].sort()).toEqual(
      [...MOTIVOS_DO_BACKEND].sort(),
    );
  });

  it('covers the backend set exactly — no reason missing, none invented', () => {
    expect(Object.keys(MENSAGENS_RETORNO_OAUTH_AMAZON).sort()).toEqual(
      [...MOTIVOS_DO_BACKEND].sort(),
    );
  });

  it.each(MOTIVOS_DO_BACKEND)('gives %s copy an operator can act on', (motivo) => {
    const mensagem = MENSAGENS_RETORNO_OAUTH_AMAZON[motivo];
    expect(mensagem.length).toBeGreaterThan(30);
    // Not the slug echoed back. Checked as the PARENTHESISED echo, because some
    // slugs are ordinary Portuguese words the copy legitimately uses ("conta",
    // "rede").
    expect(mensagem).not.toContain(`(${motivo})`);
    expect(mensagem).not.toContain('undefined');
    // Every reason resolves through the shared mechanism to its own copy, never
    // to the unknown-reason fallback (the slug alphabet is `[a-z_]{1,32}`).
    expect(oauthCallbackMessage(motivo, MENSAGENS_RETORNO_OAUTH_AMAZON)).toBe(mensagem);
  });

  it('carries the agreed sentences for the wrong seller and the switch', () => {
    expect(MENSAGENS_RETORNO_OAUTH_AMAZON.vendedor_diferente).toBe(
      'Esta conta já está ligada a outro vendedor da Amazon; para trocar de vendedor, crie outra conta.',
    );
    expect(MENSAGENS_RETORNO_OAUTH_AMAZON.integracao_desligada).toMatch(
      /^A integração com a Amazon fica desligada até a virada\./,
    );
  });

  it('tells the operator a state is single-use rather than blaming the deploy', () => {
    expect(MENSAGENS_RETORNO_OAUTH_AMAZON.bad_state).toContain('uma vez só');
    expect(MENSAGENS_RETORNO_OAUTH_AMAZON.bad_state).not.toContain('deploy');
    // The near miss: `config` IS a deploy problem and must keep saying so.
    expect(MENSAGENS_RETORNO_OAUTH_AMAZON.config).toContain('deploy');
  });

  it('never sends the operator to Seller Central to reauthorize', () => {
    for (const mensagem of Object.values(MENSAGENS_RETORNO_OAUTH_AMAZON)) {
      expect(mensagem).not.toMatch(/Seller Central/i);
    }
  });

  // ConnectionPanel labels its one button "Reautenticar" on a connected conta
  // and "Conectar conta" otherwise — and a failed reauthorization returns to a
  // conta that is STILL connected. A message naming one label alone names a
  // button that may not be on the screen.
  it.each(MOTIVOS_DO_BACKEND)(
    '%s names the connect button by both labels, or by neither',
    (motivo) => {
      const mensagem = MENSAGENS_RETORNO_OAUTH_AMAZON[motivo];
      expect(mensagem.includes('Conectar conta')).toBe(mensagem.includes('Reautenticar'));
    },
  );

  it('the reasons a reauthorization can end in DO name the button (the near miss)', () => {
    for (const motivo of [
      'missing_params',
      'codigo_invalido',
      'tempo_esgotado',
      'conflito',
    ] as const) {
      expect(MENSAGENS_RETORNO_OAUTH_AMAZON[motivo]).toContain('Reautenticar');
    }
  });
});

describe('AMAZON_CALLBACK_TOAST', () => {
  it('keeps the callback contract the backend redirects against', () => {
    // `?amazon=connected|error` is what apps/amazon's callback appends; a
    // changed key silences every toast on both the conta page and the list.
    expect(AMAZON_CALLBACK_TOAST.chave).toBe(CHAVE_RETORNO_OAUTH_AMAZON);
    expect(AMAZON_CALLBACK_TOAST.chave).toBe('amazon');
    expect(AMAZON_CALLBACK_TOAST.sucesso).toBe('Conta Amazon conectada.');
    expect(AMAZON_CALLBACK_TOAST.tituloErro).toBe('Falha ao conectar a conta Amazon');
  });

  it('⭐ holds the SAME map object every time it is read (mounting trap 2)', () => {
    expect(AMAZON_CALLBACK_TOAST.mensagens).toBe(MENSAGENS_RETORNO_OAUTH_AMAZON);
  });
});

describe('describeAmazonContaFailure — total', () => {
  it('an unreadable 2xx keeps the client sentence and is not retryable', () => {
    const err = new AmazonRespostaInvalidaError('Frase do cliente.', 503, ['connected']);
    expect(describeAmazonContaFailure(err)).toEqual({
      message: 'Frase do cliente.',
      retryable: false,
    });
  });

  it('a codeless 5xx from the backend is retryable', () => {
    const err = new AmazonBackendError('x', 502, null);
    expect(describeAmazonContaFailure(err)).toEqual({
      message: expect.stringContaining('HTTP 502') as unknown,
      retryable: true,
    });
  });

  it('a 404 for a conta that is not Amazon is a verdict, not retryable', () => {
    const err = new AmazonBackendError('x', 404, CODIGO_ERRO_AMAZON.CONTA_NAO_ENCONTRADA);
    const falha = describeAmazonContaFailure(err);
    expect(falha.retryable).toBe(false);
    expect(falha.message).toContain('não encontrou esta conta');
  });

  it('a network failure is retryable', () => {
    expect(describeAmazonContaFailure(new AmazonRedeError())).toEqual({
      message: 'Não foi possível contatar o backend da Amazon.',
      retryable: true,
    });
  });

  it('a session failure before the request is retryable and says so', () => {
    const falha = describeAmazonContaFailure(new FirebaseError('auth/network-request-failed', 'x'));
    expect(falha.retryable).toBe(true);
    expect(falha.message).toContain('sessão');
  });

  it('anything else still produces copy (the panel has nowhere to rethrow to)', () => {
    expect(describeAmazonContaFailure(new RangeError('x'))).toEqual({
      message: 'Não foi possível consultar a conexão desta conta.',
      retryable: false,
    });
    expect(describeAmazonContaFailure('não é erro').retryable).toBe(false);
  });
});

describe('describeAmazonConnectFailure — null means "not mine"', () => {
  it('⭐ maps the switch-off 503 to copy, so the button can stay on screen', () => {
    const err = new AmazonBackendError('x', 503, CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS);
    expect(describeAmazonConnectFailure(err)).toContain('desligada até a virada');
  });

  it('maps a missing configuration to the deploy copy with the variable names', () => {
    const err = new AmazonBackendError(
      'Configuração da Amazon ausente ou inválida neste backend: AMAZON_LWA_CLIENT_ID.',
      500,
      CODIGO_ERRO_AMAZON.CONFIG_AUSENTE,
    );
    const copia = describeAmazonConnectFailure(err);
    expect(copia).toContain('deploy');
    expect(copia).toContain('AMAZON_LWA_CLIENT_ID');
  });

  it('maps a missing permission (codeless 403)', () => {
    expect(describeAmazonConnectFailure(new AmazonBackendError('x', 403, null))).toContain(
      'permissão',
    );
  });

  it('maps a network failure and a session failure', () => {
    expect(describeAmazonConnectFailure(new AmazonRedeError())).toContain('Falha de rede');
    expect(
      describeAmazonConnectFailure(new FirebaseError('auth/network-request-failed', 'x')),
    ).toContain('sessão');
  });

  it('⚠️ answers null for a foreign error, which ConnectionPanel rethrows (rule 6)', () => {
    expect(describeAmazonConnectFailure(new RangeError('x'))).toBeNull();
    expect(describeAmazonConnectFailure(new Error('genérico'))).toBeNull();
  });
});
