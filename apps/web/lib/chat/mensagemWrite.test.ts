import { describe, expect, it } from 'vitest';
import { ESTADO_ENVIO } from '@delfrance/schemas';
import { buildMediaMensagem, buildTextMensagem, makeOptimistic } from './mensagemWrite';
import { tipoForFiletype } from './mediaKind';

describe('buildTextMensagem (#529 outbound text shape)', () => {
  it('produces the exact salva / tipo c / mid null write shape', () => {
    const now = 1_700_000_000_000;
    const write = buildTextMensagem({ text: 'Olá cliente', uid: 'op1', now });
    expect(write).toEqual({
      mid: null,
      conteudo: 'Olá cliente',
      tipo: 'c',
      canal: 0,
      estadoEnvio: ESTADO_ENVIO.salva,
      user_id: 'op1',
      timestamp: now,
      resposta: null,
      usarioMensagemOuterRef: null,
      urlAvatar: null,
      midGroup: null,
      error: null,
      visualizado: null,
      transcription: null,
      anexo: null,
      anexo_url: null,
    });
  });
});

describe('buildMediaMensagem (dual-write + tipo per legacy)', () => {
  const arquivoRef = 'documents/arquivos/hash123';
  const now = 1_700_000_000_000;

  it('writes anexoStorage + the image sub-object + tipo c for an image', () => {
    const w = buildMediaMensagem({
      arquivoRef,
      filetype: 'image',
      caption: 'foto',
      uid: 'op1',
      now,
    });
    // Dual-write: anexoStorage for the #529 sender, sub-object for rendering.
    expect(w.anexoStorage).toBe(arquivoRef);
    expect(w.image).toEqual({ image: arquivoRef, caption: 'foto' });
    expect(w.conteudo).toBe('foto');
    expect(w.anexoDescription).toBe('foto');
    // salva + mid null → trigger picks it up; tipo 'c' for an image (legacy).
    expect(w.estadoEnvio).toBe(ESTADO_ENVIO.salva);
    expect(w.mid).toBeNull();
    expect(w.tipo).toBe('c');
    // No cross-contamination of the other media slots.
    expect(w.video).toBeUndefined();
    expect(w.audio).toBeUndefined();
    expect(w.genericDocument).toBeUndefined();
  });

  it('writes the video sub-object + tipo v', () => {
    const w = buildMediaMensagem({ arquivoRef, filetype: 'video', caption: null, uid: 'op1', now });
    expect(w.video).toEqual({ video: arquivoRef, caption: null });
    expect(w.tipo).toBe('v');
    expect(w.anexoStorage).toBe(arquivoRef);
  });

  it('writes the audio sub-object (no caption) + tipo a', () => {
    const w = buildMediaMensagem({ arquivoRef, filetype: 'audio', caption: 'x', uid: 'op1', now });
    expect(w.audio).toEqual({ audio: arquivoRef });
    expect(w.tipo).toBe('a');
    // Caption still rides on conteudo (what resolveSendSpec uses), not the audio slot.
    expect(w.conteudo).toBe('x');
  });

  it('writes genericDocument + tipo f for a document', () => {
    const w = buildMediaMensagem({
      arquivoRef,
      filetype: 'document',
      caption: 'contrato',
      uid: 'op1',
      now,
    });
    expect(w.genericDocument).toEqual({ genericDocument: arquivoRef, caption: 'contrato' });
    expect(w.tipo).toBe('f');
  });

  it('normalises a blank caption to null', () => {
    const w = buildMediaMensagem({
      arquivoRef,
      filetype: 'image',
      caption: '   ',
      uid: 'op1',
      now,
    });
    expect(w.conteudo).toBeNull();
    expect(w.image).toEqual({ image: arquivoRef, caption: null });
  });

  it('carries midGroup when a caption+media were split into two docs', () => {
    const w = buildMediaMensagem({
      arquivoRef,
      filetype: 'image',
      caption: null,
      uid: 'op1',
      now,
      midGroup: 'text-doc-1',
    });
    expect(w.midGroup).toBe('text-doc-1');
  });
});

describe('tipoForFiletype', () => {
  it('maps per the legacy TipoMensagem.fromFileType switch', () => {
    expect(tipoForFiletype('audio')).toBe('a');
    expect(tipoForFiletype('video')).toBe('v');
    expect(tipoForFiletype('application')).toBe('f');
    expect(tipoForFiletype('document')).toBe('f');
    expect(tipoForFiletype('image')).toBe('c');
    expect(tipoForFiletype('txt')).toBe('c');
    expect(tipoForFiletype('sticker')).toBe('c');
    expect(tipoForFiletype('fallback')).toBe('c');
  });
});

describe('makeOptimistic', () => {
  it('overrides estadoEnvio to enviando and tags the entry', () => {
    const write = buildTextMensagem({ text: 'oi', uid: 'op1', now: 1 });
    const opt = makeOptimistic('doc-1', write);
    expect(opt._optimistic).toBe(true);
    expect(opt._docId).toBe('doc-1');
    expect(opt.estadoEnvio).toBe(ESTADO_ENVIO.enviando);
    // The write itself stays salva (the optimistic copy differs only in state).
    expect(write.estadoEnvio).toBe(ESTADO_ENVIO.salva);
  });
});
