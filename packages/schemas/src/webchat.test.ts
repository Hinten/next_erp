import { describe, expect, it } from 'vitest';
import {
  mensagemInatividadeWebchatSchema,
  periodoWebchatSchema,
  webchatMeta,
  webchatSchema,
} from './webchat';

const MINIMAL = { nome: 'Loja Principal' };

describe('webchatSchema', () => {
  it('accepts a minimal valid webchat and applies defaults', () => {
    const out = webchatSchema.parse(MINIMAL);
    expect(out).toMatchObject({
      nome: 'Loja Principal',
      url: null,
      posicionamento: 'direita',
      icone: 'mensagem',
      saudacao: null,
      corBorda: '#e5e7eb',
      corIcone: '#2563eb',
      corCabecalho: '#2563eb',
      corBolhaInatividade: '#dc2626',
      corCorpoChat: '#ffffff',
      corTextoChat: '#111827',
      horario_funcionamento: null,
      mensagens_padrao: null,
      mensagens_inatividade: null,
    });
  });

  it('rejects empty nome', () => {
    expect(webchatSchema.safeParse({ ...MINIMAL, nome: '' }).success).toBe(false);
  });

  it('rejects an unknown posicionamento', () => {
    expect(webchatSchema.safeParse({ ...MINIMAL, posicionamento: 'centro' }).success).toBe(false);
  });

  it('rejects an unknown icone', () => {
    expect(webchatSchema.safeParse({ ...MINIMAL, icone: 'sino' }).success).toBe(false);
  });

  it('accepts up to 3 mensagens_padrao and rejects a 4th', () => {
    expect(webchatSchema.safeParse({ ...MINIMAL, mensagens_padrao: ['a', 'b', 'c'] }).success).toBe(
      true,
    );
    expect(
      webchatSchema.safeParse({ ...MINIMAL, mensagens_padrao: ['a', 'b', 'c', 'd'] }).success,
    ).toBe(false);
  });

  it('accepts up to 3 mensagens_inatividade and rejects a 4th', () => {
    const row = { mensagem: 'Ainda por aí?', tempo_inatividade: 60 };
    expect(
      webchatSchema.safeParse({ ...MINIMAL, mensagens_inatividade: [row, row, row] }).success,
    ).toBe(true);
    expect(
      webchatSchema.safeParse({ ...MINIMAL, mensagens_inatividade: [row, row, row, row] }).success,
    ).toBe(false);
  });

  it('accepts an embedded horario_funcionamento array (not a subcollection)', () => {
    const out = webchatSchema.parse({
      ...MINIMAL,
      horario_funcionamento: [
        {
          segunda: { aberturaHora: 8, aberturaMinuto: 0, fechamentoHora: 18, fechamentoMinuto: 0 },
        },
      ],
    });
    expect(out.horario_funcionamento).toHaveLength(1);
  });

  // Every optional field uses `.nullable().default(null)` (never bare
  // `.optional()`) — a payload omitting them entirely still parses because
  // the default fills the gap, so the OUTPUT handed to `addDoc`/`setDoc`
  // never contains `undefined` (the Firebase JS SDK rejects it).
  it('fills every optional field with its default when omitted entirely', () => {
    const out = webchatSchema.parse(MINIMAL);
    for (const key of [
      'url',
      'saudacao',
      'horario_funcionamento',
      'mensagens_padrao',
      'mensagens_inatividade',
    ] as const) {
      expect(out[key]).not.toBeUndefined();
    }
  });
});

describe('mensagemInatividadeWebchatSchema', () => {
  it('defaults tempo_inatividade to 60 seconds', () => {
    const out = mensagemInatividadeWebchatSchema.parse({ mensagem: 'Oi?' });
    expect(out.tempo_inatividade).toBe(60);
  });

  it('rejects tempo_inatividade <= 0', () => {
    expect(
      mensagemInatividadeWebchatSchema.safeParse({ mensagem: 'Oi?', tempo_inatividade: 0 }).success,
    ).toBe(false);
  });
});

describe('periodoWebchatSchema', () => {
  it('accepts an empty period (every weekday absent)', () => {
    expect(periodoWebchatSchema.safeParse({}).success).toBe(true);
  });

  it('rejects an out-of-range hour', () => {
    expect(
      periodoWebchatSchema.safeParse({
        segunda: { aberturaHora: 24, aberturaMinuto: 0, fechamentoHora: 18, fechamentoMinuto: 0 },
      }).success,
    ).toBe(false);
  });
});

describe('webchatMeta', () => {
  it('targets the webchat collection', () => {
    expect(webchatMeta.collectionPath).toBe('webchat');
  });

  it('declares the byte-14 permission bits', () => {
    expect(webchatMeta.permissions.read).toBe(1n << 112n);
    expect(webchatMeta.permissions.write).toBe(1n << 113n);
    expect(webchatMeta.permissions.delete).toBe(1n << 114n);
  });
});
