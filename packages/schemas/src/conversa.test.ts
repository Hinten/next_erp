import { describe, expect, it } from 'vitest';
import {
  ESTADO_CONVERSA,
  ESTADO_ENVIO,
  conversaSchema,
  mensagemSchema,
  podeReabrirConversa,
} from './conversa';

describe('conversaSchema', () => {
  it('parses with defaults applied', () => {
    const out = conversaSchema.parse({});
    expect(out.estadoConversa).toBe(ESTADO_CONVERSA.naoRespondido);
    expect(out.origem).toBe('site');
    expect(out.atendido).toBe(false);
    expect(out.nome).toBe('Conversa sem título');
    expect(out.urlAvatar).toBe('');
  });

  it('accepts every estadoConversa code (incl. spam=99)', () => {
    for (const value of Object.values(ESTADO_CONVERSA)) {
      const out = conversaSchema.safeParse({ estadoConversa: value });
      expect(out.success).toBe(true);
    }
  });

  it('rejects unknown estadoConversa codes', () => {
    expect(conversaSchema.safeParse({ estadoConversa: 42 }).success).toBe(false);
  });

  it('rejects unknown origem strings', () => {
    expect(conversaSchema.safeParse({ origem: 'tiktok' }).success).toBe(false);
  });

  it('keeps a documents/<col>/<id> outer-ref string and rejects a non-string ref', () => {
    const out = conversaSchema.parse({ usarioOuterRef: 'documents/usuarios/u1' });
    expect(out.usarioOuterRef).toBe('documents/usuarios/u1');
    expect(conversaSchema.safeParse({ usarioOuterRef: { docId: { id: 'u1' } } }).success).toBe(
      false,
    );
  });

  it('strips unknown top-level keys (passthrough removed, #464)', () => {
    // Before #464 this schema was `.passthrough()`, so an unknown key survived
    // the parse; now it is stripped (and rejected on a write via defineCollection).
    const out = conversaSchema.parse({ nome: 'X', bogusLegacyKey: 1 });
    expect(out).not.toHaveProperty('bogusLegacyKey');
  });
});

describe('mensagemSchema', () => {
  it('parses with defaults', () => {
    const out = mensagemSchema.parse({});
    expect(out.estadoEnvio).toBe(ESTADO_ENVIO.salva);
    expect(out.tipo).toBe('c');
    expect(out.canal).toBe(0);
  });

  it('accepts every estadoEnvio code', () => {
    for (const value of Object.values(ESTADO_ENVIO)) {
      expect(mensagemSchema.safeParse({ estadoEnvio: value }).success).toBe(true);
    }
  });

  it('rejects unknown tipo characters', () => {
    expect(mensagemSchema.safeParse({ tipo: 'z' }).success).toBe(false);
  });

  it('models anexo_url (snake_case) and no longer knows the camelCase anexoUrl (#464)', () => {
    const out = mensagemSchema.parse({
      conteudo: 'Veja o anexo',
      anexo_url: 'https://cdn.example.com/x.pdf',
      timestamp: '2026-01-01T12:00:00.000Z',
    });
    expect(out.anexo_url).toBe('https://cdn.example.com/x.pdf');
    // The pre-#464 camelCase key is now an unknown field: stripped, not kept.
    expect(mensagemSchema.parse({ anexoUrl: 'x' })).not.toHaveProperty('anexoUrl');
    // The modeled key is now type-validated (was pass-through `unknown` before).
    expect(mensagemSchema.safeParse({ anexo_url: 123 }).success).toBe(false);
  });

  it('strips unknown top-level keys (passthrough removed, #464)', () => {
    const out = mensagemSchema.parse({ conteudo: 'oi', totallyUnknownKey: 42 });
    expect(out).not.toHaveProperty('totallyUnknownKey');
  });

  it('models the WhatsApp media / interactive sub-objects', () => {
    const out = mensagemSchema.parse({
      image: { image: 'documents/arquivos/a1', caption: 'foto', ai_description: 'a cat' },
      audio: { audio: 'arquivos/a2', transcription: 'olá' },
      sticker: { sticker: 'documents/arquivos/a3', animated: true },
      button: { text: 'Sim', payload: 'YES' },
      reaction: { mensagemOuterRef: 'documents/chat/c1/mensagem/m1', emoji: '👍' },
      context: { produto_uid: 'p1', forwarded: true },
      referral: { source_url: 'https://x', ctwa_clid: 'clid1' },
    });
    expect(out.image?.image).toBe('documents/arquivos/a1');
    expect(out.audio?.transcription).toBe('olá');
    expect(out.sticker?.animated).toBe(true);
    expect(out.button?.payload).toBe('YES');
    expect(out.reaction?.emoji).toBe('👍');
    expect(out.context?.forwarded).toBe(true);
    expect(out.referral?.ctwa_clid).toBe('clid1');
  });

  it('models errors[], the storage attachment and the lifecycle timestamps', () => {
    const out = mensagemSchema.parse({
      errors: [
        { code: 131051, title: 'Unsupported message type', details: 'x', error_data: { k: 'v' } },
      ],
      anexoStorage: 'documents/arquivos/a9',
      anexoDescription: 'nota',
      data_cadastro: '2026-01-01T00:00:00.000Z',
      lastExternalUpdateDateTime: '2026-01-02T00:00:00.000Z',
    });
    expect(out.errors?.[0]?.code).toBe(131051);
    expect(out.anexoStorage).toBe('documents/arquivos/a9');
    expect(out.data_cadastro).toBe('2026-01-01T00:00:00.000Z');
    expect(out.lastExternalUpdateDateTime).toBe('2026-01-02T00:00:00.000Z');
  });

  it('rejects a malformed errors[] entry (missing required code/title)', () => {
    expect(mensagemSchema.safeParse({ errors: [{ title: 'no code' }] }).success).toBe(false);
  });
});

describe('podeReabrirConversa', () => {
  it('returns true for finalizadas/canceladas', () => {
    expect(podeReabrirConversa(ESTADO_CONVERSA.atendimentoFinalizado)).toBe(true);
    expect(podeReabrirConversa(ESTADO_CONVERSA.atendimentoCancelado)).toBe(true);
    expect(podeReabrirConversa(ESTADO_CONVERSA.atendimentoCanceladoPeloCliente)).toBe(true);
    expect(podeReabrirConversa(ESTADO_CONVERSA.atendimentoCanceladoPeloAtendente)).toBe(true);
    expect(podeReabrirConversa(ESTADO_CONVERSA.finalizadoSemAtendimento)).toBe(true);
  });

  it('returns false for estados ativos / spam', () => {
    expect(podeReabrirConversa(ESTADO_CONVERSA.naoRespondido)).toBe(false);
    expect(podeReabrirConversa(ESTADO_CONVERSA.emResposta)).toBe(false);
    expect(podeReabrirConversa(ESTADO_CONVERSA.emEspera)).toBe(false);
    expect(podeReabrirConversa(ESTADO_CONVERSA.emTransferencia)).toBe(false);
    expect(podeReabrirConversa(ESTADO_CONVERSA.spam)).toBe(false);
  });
});
