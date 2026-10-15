/**
 * `SHOPEE_OAUTH_MENSAGENS` — the copy behind every `reason` slug the Shopee
 * callback can redirect with.
 *
 * The union is CLOSED on the backend
 * (`apps/shopee/app/api/oauth/shopee/callback/route.ts`, type `RedirectReason`),
 * so the eleven members are written out LITERALLY here rather than derived from
 * the map under test — deriving them would make the test pass for whatever the
 * map happens to contain, which is exactly the property that has to fail when a
 * new backend cause ships without copy.
 */
import { describe, expect, it } from 'vitest';

import { oauthCallbackMessage } from '@/lib/oauth/useOAuthCallbackToast';
import { SHOPEE_OAUTH_MENSAGENS, SHOPEE_OAUTH_TOAST } from './shopeeOAuthErrors';

/** Transcribed from the backend's `RedirectReason` union — do not derive. */
const SLUGS_DO_BACKEND = [
  'config',
  'bad_state',
  'missing_params',
  'loja_invalida',
  'codigo_invalido',
  'shopee_rejeitou',
  'server_config',
  'conta',
  'resposta_invalida',
  'rede',
  'exchange',
] as const;

describe('SHOPEE_OAUTH_MENSAGENS', () => {
  it.each(SLUGS_DO_BACKEND)('gives %s copy an operator can act on', (slug) => {
    const mensagem = SHOPEE_OAUTH_MENSAGENS[slug];
    expect(mensagem).toBeTypeOf('string');
    expect(mensagem?.length ?? 0).toBeGreaterThan(20);
    // Not the slug echoed back: "Falha ao conectar a conta Shopee (exchange)."
    // is the defect this map exists to replace. Checked as the PARENTHESISED
    // echo rather than as a substring, because a couple of the slugs are also
    // ordinary Portuguese words the copy legitimately uses ("conta", "rede").
    expect(mensagem).not.toBe(slug);
    expect(mensagem).not.toContain(`(${slug})`);
  });

  it('covers the backend union exactly — no extra slug nobody redirects with', () => {
    expect(Object.keys(SHOPEE_OAUTH_MENSAGENS).sort()).toEqual([...SLUGS_DO_BACKEND].sort());
  });

  it('tells the operator that a state is single-use rather than blaming the deploy', () => {
    // `bad_state` fires on a reloaded callback URL and on a consent link opened
    // twice — both with everything configured correctly. Copy that reads as a
    // broken backend sends someone to look at a deploy that is fine.
    expect(SHOPEE_OAUTH_MENSAGENS.bad_state).toContain('uma vez só');
    // The near-miss: `config` IS a deploy problem and must keep saying so.
    expect(SHOPEE_OAUTH_MENSAGENS.config).toContain('deploy');
  });
});

describe('SHOPEE_OAUTH_TOAST', () => {
  it('keeps the callback contract the backend redirects against', () => {
    // `?shopee=connected|error` is what apps/shopee's callback appends; a
    // changed key silences every toast on both this screen and the list.
    expect(SHOPEE_OAUTH_TOAST.chave).toBe('shopee');
    expect(SHOPEE_OAUTH_TOAST.sucesso).toBe('Conta Shopee conectada.');
    expect(SHOPEE_OAUTH_TOAST.tituloErro).toBe('Falha ao conectar a conta Shopee');
    expect(SHOPEE_OAUTH_TOAST.mensagens).toBe(SHOPEE_OAUTH_MENSAGENS);
  });
});

describe('oauthCallbackMessage with the Shopee map', () => {
  it('resolves a known slug to its copy', () => {
    expect(oauthCallbackMessage('rede', SHOPEE_OAUTH_MENSAGENS)).toBe(SHOPEE_OAUTH_MENSAGENS.rede);
  });

  it('names an unrecognised but slug-shaped reason', () => {
    expect(oauthCallbackMessage('slug_desconhecido', SHOPEE_OAUTH_MENSAGENS)).toBe(
      'Motivo não reconhecido (slug_desconhecido).',
    );
  });

  it('refuses to echo a reason that is not slug-shaped, and says nothing on a missing one', () => {
    expect(oauthCallbackMessage('<script>alert(1)</script>', SHOPEE_OAUTH_MENSAGENS)).toBe(
      'Motivo não informado.',
    );
    expect(oauthCallbackMessage(null, SHOPEE_OAUTH_MENSAGENS)).toBe('Motivo não informado.');
  });
});
