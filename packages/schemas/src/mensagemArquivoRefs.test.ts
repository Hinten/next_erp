import { describe, expect, it } from 'vitest';
import {
  MENSAGEM_ARQUIVO_REF_FIELDS,
  extractMensagemArquivoIds,
  mensagemArquivoRefValues,
} from './mensagemArquivoRefs';

describe('mensagem arquivo refs', () => {
  it('keeps the six persisted field paths explicit', () => {
    expect(MENSAGEM_ARQUIVO_REF_FIELDS).toEqual([
      'anexoStorage',
      'audio.audio',
      'image.image',
      'video.video',
      'sticker.sticker',
      'genericDocument.genericDocument',
    ]);
  });

  it('extracts all fields, accepts both wire forms and de-duplicates dual writes', () => {
    expect(
      extractMensagemArquivoIds({
        anexoStorage: 'documents/arquivos/shared',
        audio: { audio: 'arquivos/audio' },
        image: { image: 'arquivos/shared' },
        video: { video: 'documents/arquivos/video' },
        sticker: { sticker: 'arquivos/sticker' },
        genericDocument: { genericDocument: 'documents/arquivos/document' },
      }),
    ).toEqual(new Set(['shared', 'audio', 'video', 'sticker', 'document']));
  });

  it('ignores malformed refs and refs to another collection', () => {
    expect(
      extractMensagemArquivoIds({
        anexoStorage: 'documents/produtos/p1',
        audio: { audio: 'sem-barra' },
        image: { image: null },
        video: { video: 'documents/chat/c1/arquivos/nested' },
        sticker: { sticker: 'arquivos/id/extra' },
        genericDocument: { genericDocument: 'documents/arquivos/' },
      }),
    ).toEqual(new Set());
  });

  it('builds the two indexed equality values for an arquivo id', () => {
    expect(mensagemArquivoRefValues('a1')).toEqual(['arquivos/a1', 'documents/arquivos/a1']);
  });
});
