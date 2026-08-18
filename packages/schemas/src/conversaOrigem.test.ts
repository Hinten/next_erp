import { describe, expect, it } from 'vitest';
import { ORIGEM_RULES, WHATSAPP_ANEXO_LIMITS, type OrigemRule } from './conversaOrigem';
import { origemConversaSchema, type OrigemConversa } from './conversa';

/**
 * These assertions pin `ORIGEM_RULES` to the EXACT legacy Flutter values in
 * `.old/packages/atendimento/lib/src/models.dart:981-1112` (`Origem` enum) and
 * `.old/packages/canais_de_venda/facebook/lib/src/models.dart:134-140`
 * (`TamanhoAnexoWhatsapp`). Each expected value cites the legacy source line.
 */

// The single source of truth for the expected table, transcribed from legacy.
const EXPECTED: Record<OrigemConversa, OrigemRule> = {
  // site — all legacy `default` branches: limite 1000 (L1018), permiteAnexo
  // true (L1061), maximoAnexos 5 (L1076), formats throw → null (L1093),
  // size throw → 25 MB fallback (L1109), isHtml false (L1031).
  site: {
    limiteCaracteres: 1000,
    permiteAnexo: true,
    maximoAnexos: 5,
    formatosAnexo: null,
    maxTamanhoAnexoBytes: 25_000_000,
    isHtml: false,
    temEnvio: false,
  },
  // facebook — limite 2000 (L1006), maximoAnexos 1 (L1073), formats L1089,
  // size 25 MB (L1105).
  facebook: {
    limiteCaracteres: 2000,
    permiteAnexo: true,
    maximoAnexos: 1,
    formatosAnexo: ['jpg', 'jpeg', 'png', 'pdf', 'txt', 'aac', 'mp4', 'mmpeg', 'amr', 'ogg', '3gp'],
    maxTamanhoAnexoBytes: 25_000_000,
    isHtml: false,
    temEnvio: false,
  },
  // comentario — limite 2000 (L1008), maximoAnexos default 5, formats throw →
  // null, size throw → 25 MB fallback, isHtml false.
  comentario: {
    limiteCaracteres: 2000,
    permiteAnexo: true,
    maximoAnexos: 5,
    formatosAnexo: null,
    maxTamanhoAnexoBytes: 25_000_000,
    isHtml: false,
    temEnvio: false,
  },
  // whatsapp — limite 2000 (L1010), maximoAnexos 1 (L1075), formats L1091 (same
  // list as facebook, incl. the legacy `'mmpeg'` typo), size 25 MB (L1107).
  whatsapp: {
    limiteCaracteres: 2000,
    permiteAnexo: true,
    maximoAnexos: 1,
    formatosAnexo: ['jpg', 'jpeg', 'png', 'pdf', 'txt', 'aac', 'mp4', 'mmpeg', 'amr', 'ogg', '3gp'],
    maxTamanhoAnexoBytes: 25_000_000,
    isHtml: false,
    temEnvio: true,
  },
  // mlperg — limite 2000 (L1012), permiteAnexo FALSE (L1059) so maximoAnexos 0
  // (L1066), formats [] (L1082), size 0 (L1098); isHtml true (L1026).
  mlperg: {
    limiteCaracteres: 2000,
    permiteAnexo: false,
    maximoAnexos: 0,
    formatosAnexo: [],
    maxTamanhoAnexoBytes: 0,
    isHtml: true,
    temEnvio: false,
  },
  // mlped — limite 350 (corrected from legacy 300 at L1014), maximoAnexos 1 (L1069), formats L1085,
  // size 25 MB (L1101), isHtml true (L1028).
  mlped: {
    limiteCaracteres: 350,
    permiteAnexo: true,
    maximoAnexos: 1,
    formatosAnexo: ['jpg', 'jpeg', 'png', 'pdf', 'txt'],
    maxTamanhoAnexoBytes: 25_000_000,
    isHtml: true,
    temEnvio: false,
  },
  // mlclaims — limite 300 (L1016), maximoAnexos 3 (L1071), formats L1087,
  // size 25 MB (L1103), isHtml true (L1030).
  mlclaims: {
    limiteCaracteres: 300,
    permiteAnexo: true,
    maximoAnexos: 3,
    formatosAnexo: ['jpg', 'jpeg', 'png', 'pdf'],
    maxTamanhoAnexoBytes: 5_000_000,
    isHtml: true,
    temEnvio: false,
  },
};

describe('ORIGEM_RULES', () => {
  it('has an entry for every Origem enum member (and no extras)', () => {
    expect(Object.keys(ORIGEM_RULES).sort()).toEqual([...origemConversaSchema.options].sort());
  });

  for (const origem of origemConversaSchema.options) {
    it(`matches the legacy Origem values for "${origem}"`, () => {
      expect(ORIGEM_RULES[origem]).toEqual(EXPECTED[origem]);
    });
  }

  it('mlperg is the only origem that disallows attachments (L1059)', () => {
    const disallowed = origemConversaSchema.options.filter((o) => !ORIGEM_RULES[o].permiteAnexo);
    expect(disallowed).toEqual(['mlperg']);
  });

  it('the Mercado Livre origens render HTML; the others do not (L1022-1033)', () => {
    const html = origemConversaSchema.options.filter((o) => ORIGEM_RULES[o].isHtml);
    expect(html.sort()).toEqual(['mlclaims', 'mlped', 'mlperg']);
  });

  it('a disallowed origem has 0 maxAnexos, [] formats and a 0 byte cap (L1066/L1082/L1098)', () => {
    expect(ORIGEM_RULES.mlperg.maximoAnexos).toBe(0);
    expect(ORIGEM_RULES.mlperg.formatosAnexo).toEqual([]);
    expect(ORIGEM_RULES.mlperg.maxTamanhoAnexoBytes).toBe(0);
  });

  it('WhatsApp is the only channel that can transmit today (#817)', () => {
    const comEnvio = origemConversaSchema.options.filter((o) => ORIGEM_RULES[o].temEnvio);
    expect(comEnvio).toEqual(['whatsapp']);
  });

  it('corrects mlped to ML’s real 350-character seller cap, not the legacy 300', () => {
    // Legacy models.dart:1014 said 300. ML's post-sale reference says 350 and
    // returns the live value as `seller_max_message_length` per thread, so this
    // is the fallback for a thread nobody has read yet.
    expect(ORIGEM_RULES.mlped.limiteCaracteres).toBe(350);
  });

  it('corrects mlclaims attachments to the CLAIMS endpoint limits, not the post-sale ones', () => {
    // Claim attachments are a different ML endpoint: 5 MB and no `txt`. The
    // legacy source applied the 25 MB post-sale limits to both surfaces, so a
    // 10 MB PDF passed the composer and was rejected by ML.
    expect(ORIGEM_RULES.mlclaims.maxTamanhoAnexoBytes).toBe(5_000_000);
    expect(ORIGEM_RULES.mlclaims.formatosAnexo).toEqual(['jpg', 'jpeg', 'png', 'pdf']);
    // ...and mlped keeps the post-sale limits, which ML still documents as 25 MB
    // with txt allowed. The two must not be "unified".
    expect(ORIGEM_RULES.mlped.maxTamanhoAnexoBytes).toBe(25_000_000);
    expect(ORIGEM_RULES.mlped.formatosAnexo).toContain('txt');
  });
});

describe('WHATSAPP_ANEXO_LIMITS', () => {
  it('matches the legacy TamanhoAnexoWhatsapp enum values (models.dart:134-140)', () => {
    expect(WHATSAPP_ANEXO_LIMITS).toEqual({
      image: 5_000_000, // L135
      video: 16_000_000, // L136
      audio: 16_000_000, // L137
      text: 100_000_000, // L138
      application: 100_000_000, // L139
      sticker: 500_000, // L140
    });
  });
});
