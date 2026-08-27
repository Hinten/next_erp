import { describe, expect, it } from 'vitest';
import { ESTADO_ENVIO, TIPO_MENSAGEM } from '@delfrance/schemas';

import { lastMensagemPreview, type PreviewMensagem } from './preview';

/** Minimal preview message with sensible defaults, overridable per test. */
function msg(partial: Partial<PreviewMensagem> = {}): PreviewMensagem {
  return {
    tipo: TIPO_MENSAGEM.comum,
    conteudo: null,
    transcription: null,
    user_id: null,
    audio: null,
    image: null,
    video: null,
    sticker: null,
    genericDocument: null,
    reaction: null,
    ...partial,
  };
}

describe('lastMensagemPreview', () => {
  it('returns "Sem mensagens" when there is no message', () => {
    expect(lastMensagemPreview(null)).toBe('Sem mensagens');
    expect(lastMensagemPreview(undefined)).toBe('Sem mensagens');
  });

  it('shows the text content, collapsing newlines', () => {
    expect(lastMensagemPreview(msg({ conteudo: 'olá\nmundo  ' }))).toBe('olá mundo');
  });

  it('prefixes "(Eu) " when the author is the current operator', () => {
    expect(lastMensagemPreview(msg({ conteudo: 'oi', user_id: 'op1' }), { meuUid: 'op1' })).toBe(
      '(Eu) oi',
    );
  });

  it('prefixes "(Eu) " for an AUTHORLESS message whose state says we sent it', () => {
    // Every marketplace reply is authorless — identity is a cliente, so nothing
    // stamps `user_id`. Keying on the author alone dropped the prefix on exactly
    // the messages we did send. Same rule the thread uses for the bubble side.
    expect(
      lastMensagemPreview(
        msg({ conteudo: 'oi', user_id: null, estadoEnvio: ESTADO_ENVIO.enviado }),
        { meuUid: 'op1' },
      ),
    ).toBe('(Eu) oi');
  });

  it('does NOT prefix an authorless message the contact sent', () => {
    expect(
      lastMensagemPreview(
        msg({ conteudo: 'oi', user_id: null, estadoEnvio: ESTADO_ENVIO.recebido }),
        { meuUid: 'op1' },
      ),
    ).toBe('oi');
  });

  it('prefixes the author name for a known non-operator author', () => {
    expect(
      lastMensagemPreview(msg({ conteudo: 'oi', user_id: 'cliente9' }), {
        meuUid: 'op1',
        autorNome: 'Ana',
      }),
    ).toBe('(Ana) oi');
  });

  it('does not prefix when the author is unknown / no user_id', () => {
    expect(lastMensagemPreview(msg({ conteudo: 'oi', user_id: null }), { meuUid: 'op1' })).toBe(
      'oi',
    );
  });

  it('wraps an event message in brackets and never prefixes it', () => {
    expect(
      lastMensagemPreview(msg({ tipo: 'e', conteudo: 'Ana entrou na conversa', user_id: 'op1' }), {
        meuUid: 'op1',
      }),
    ).toBe('[Ana entrou na conversa]');
  });

  it('prefixes an error message with "(!) "', () => {
    expect(lastMensagemPreview(msg({ tipo: '!', conteudo: 'falhou' }))).toBe('(!) falhou');
  });

  it('renders media placeholders from the typed sub-objects', () => {
    expect(lastMensagemPreview(msg({ audio: { audio: 'documents/arquivos/a' } }))).toBe(
      'Enviou um áudio',
    );
    expect(lastMensagemPreview(msg({ image: { image: 'documents/arquivos/i' } }))).toBe(
      'Enviou uma imagem',
    );
    expect(lastMensagemPreview(msg({ video: { video: 'documents/arquivos/v' } }))).toBe(
      'Enviou um vídeo',
    );
    expect(lastMensagemPreview(msg({ sticker: { sticker: 'documents/arquivos/s' } }))).toBe(
      'Enviou uma figurinha',
    );
    expect(
      lastMensagemPreview(msg({ genericDocument: { genericDocument: 'documents/arquivos/d' } })),
    ).toBe('Enviou um documento');
  });

  it('falls back to the tipo char for media without a sub-object', () => {
    expect(lastMensagemPreview(msg({ tipo: 'a' }))).toBe('Enviou um áudio');
    expect(lastMensagemPreview(msg({ tipo: 'v' }))).toBe('Enviou um vídeo');
    expect(lastMensagemPreview(msg({ tipo: 'f' }))).toBe('Enviou um arquivo');
  });

  it('renders a reaction with its emoji', () => {
    expect(lastMensagemPreview(msg({ reaction: { emoji: '👍' } }))).toBe('Reagiu com 👍');
  });

  it('prefers text over media when both are present', () => {
    expect(
      lastMensagemPreview(msg({ conteudo: 'legenda', image: { image: 'documents/arquivos/i' } })),
    ).toBe('legenda');
  });

  it('falls back to "Nova mensagem" for a content-less, media-less message', () => {
    expect(lastMensagemPreview(msg({ tipo: 'c' }))).toBe('Nova mensagem');
  });
});
