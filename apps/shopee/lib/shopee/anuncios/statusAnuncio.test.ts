import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ESTADO_ANUNCIO_SHOPEE, type EstadoAnuncioShopee } from '@delfrance/schemas';

import {
  agendadoParaMsDe,
  anuncioShopeeVivo,
  deboostDeWire,
  estadoDoAnuncio,
  type LeituraDeAnuncio,
} from './statusAnuncio';

/* ---------------------------------- fixtures ------------------------------ */

const AGORA = 1_757_000_000_000;
const ITEM_ID = 2500139861;

function lido(
  parcial: Partial<Extract<LeituraDeAnuncio, { kind: 'lido' }>> = {},
): LeituraDeAnuncio {
  return { kind: 'lido', itemStatus: null, deboost: null, agendadoParaMs: null, ...parcial };
}

/* -------------------------------------------------------------------------- */
/*                        (1) the fold — the whole table                       */
/* -------------------------------------------------------------------------- */

interface Linha {
  readonly rotulo: string;
  readonly leitura: LeituraDeAnuncio;
  readonly estado: EstadoAnuncioShopee;
  readonly deboost: boolean;
}

const TABELA: readonly Linha[] = [
  {
    rotulo: '1 — ausente (error_item_not_found) ⇒ removido',
    leitura: { kind: 'ausente' },
    estado: ESTADO_ANUNCIO_SHOPEE.removido,
    deboost: false,
  },
  {
    rotulo: '2 — SELLER_DELETE ⇒ removido',
    leitura: lido({ itemStatus: 'SELLER_DELETE' }),
    estado: ESTADO_ANUNCIO_SHOPEE.removido,
    deboost: false,
  },
  {
    rotulo: '3 — SHOPEE_DELETE ⇒ removido',
    leitura: lido({ itemStatus: 'SHOPEE_DELETE' }),
    estado: ESTADO_ANUNCIO_SHOPEE.removido,
    deboost: false,
  },
  {
    rotulo: '4 — DELETED (grafia pré-2024) ⇒ removido',
    leitura: lido({ itemStatus: 'DELETED' }),
    estado: ESTADO_ANUNCIO_SHOPEE.removido,
    deboost: false,
  },
  {
    rotulo: '5 — BANNED ⇒ banido',
    leitura: lido({ itemStatus: 'BANNED' }),
    estado: ESTADO_ANUNCIO_SHOPEE.banido,
    deboost: false,
  },
  {
    rotulo: '6 — REVIEWING ⇒ em_revisao',
    leitura: lido({ itemStatus: 'REVIEWING' }),
    estado: ESTADO_ANUNCIO_SHOPEE.emRevisao,
    deboost: false,
  },
  {
    rotulo: '7 — UNLIST com agendamento FUTURO ⇒ agendado',
    leitura: lido({ itemStatus: 'UNLIST', agendadoParaMs: AGORA + 1 }),
    estado: ESTADO_ANUNCIO_SHOPEE.agendado,
    deboost: false,
  },
  {
    rotulo: '8 — UNLIST sem agendamento ⇒ pausado',
    leitura: lido({ itemStatus: 'UNLIST', agendadoParaMs: null }),
    estado: ESTADO_ANUNCIO_SHOPEE.pausado,
    deboost: false,
  },
  {
    rotulo: '9 — NORMAL sem deboost ⇒ ativo',
    leitura: lido({ itemStatus: 'NORMAL', deboost: false }),
    estado: ESTADO_ANUNCIO_SHOPEE.ativo,
    deboost: false,
  },
  {
    rotulo: '10 — NORMAL COM deboost ⇒ ativo, e o deboost sobrevive',
    leitura: lido({ itemStatus: 'NORMAL', deboost: true }),
    estado: ESTADO_ANUNCIO_SHOPEE.ativo,
    deboost: true,
  },
  {
    rotulo: '11 — um item_status desconhecido ⇒ desconhecido',
    leitura: lido({ itemStatus: 'QUALQUER_COISA_NOVA' }),
    estado: ESTADO_ANUNCIO_SHOPEE.desconhecido,
    deboost: false,
  },
];

describe('estadoDoAnuncio', () => {
  it.each(TABELA)('estadoDoAnuncio — a tabela inteira: $rotulo', ({ leitura, estado, deboost }) => {
    expect(estadoDoAnuncio(leitura, AGORA)).toEqual({ estado, deboost });
  });

  it('⚠️ PAR: NORMAL + deboost continua ATIVO — um anúncio rebaixado ainda vende', () => {
    const limpo = estadoDoAnuncio(lido({ itemStatus: 'NORMAL', deboost: false }), AGORA);
    const rebaixado = estadoDoAnuncio(lido({ itemStatus: 'NORMAL', deboost: true }), AGORA);
    expect(rebaixado.estado).toBe(limpo.estado);
    expect(rebaixado.estado).toBe(ESTADO_ANUNCIO_SHOPEE.ativo);
  });

  it('⚠️ NEAR-MISS: …e o deboost sobrevive ao fold, senão o par apagaria o único sinal que existe', () => {
    const limpo = estadoDoAnuncio(lido({ itemStatus: 'NORMAL', deboost: false }), AGORA);
    const rebaixado = estadoDoAnuncio(lido({ itemStatus: 'NORMAL', deboost: true }), AGORA);
    expect(rebaixado.deboost).toBe(true);
    expect(limpo.deboost).toBe(false);
    expect(rebaixado).not.toEqual(limpo);
  });

  it('⚠️ PAR: um scheduled_publish_time FUTURO é agendado; o MESMO instante já é pausado', () => {
    const futuro = lido({ itemStatus: 'UNLIST', agendadoParaMs: AGORA + 1 });
    const agora = lido({ itemStatus: 'UNLIST', agendadoParaMs: AGORA });
    expect(estadoDoAnuncio(futuro, AGORA).estado).toBe(ESTADO_ANUNCIO_SHOPEE.agendado);
    // Strictly `>`, never `>=`.
    expect(estadoDoAnuncio(agora, AGORA).estado).toBe(ESTADO_ANUNCIO_SHOPEE.pausado);
  });

  it('⚠️ NEAR-MISS: um scheduled_publish_time no PASSADO não é agendado — é pausado', () => {
    const passado = lido({ itemStatus: 'UNLIST', agendadoParaMs: AGORA - 1 });
    expect(estadoDoAnuncio(passado, AGORA).estado).toBe(ESTADO_ANUNCIO_SHOPEE.pausado);
  });

  it('um agendamento futuro em qualquer outro status NÃO vira agendado', () => {
    // `scheduled_publish_time` is meaningful only on an UNLIST item: a NORMAL
    // listing carrying a stale one is LIVE, not scheduled.
    const normal = lido({ itemStatus: 'NORMAL', agendadoParaMs: AGORA + 60_000 });
    expect(estadoDoAnuncio(normal, AGORA).estado).toBe(ESTADO_ANUNCIO_SHOPEE.ativo);
  });

  it('DELETED (grafia pré-2024) folda para removido; DELETE não', () => {
    expect(estadoDoAnuncio(lido({ itemStatus: 'DELETED' }), AGORA).estado).toBe(
      ESTADO_ANUNCIO_SHOPEE.removido,
    );
    // ⚠️ NEAR-MISS: an EXACT match, not a prefix and not a `startsWith`.
    expect(estadoDoAnuncio(lido({ itemStatus: 'DELETE' }), AGORA).estado).toBe(
      ESTADO_ANUNCIO_SHOPEE.desconhecido,
    );
    expect(estadoDoAnuncio(lido({ itemStatus: 'DELETED_BY_SHOPEE' }), AGORA).estado).toBe(
      ESTADO_ANUNCIO_SHOPEE.desconhecido,
    );
  });

  it('um item_status que a Shopee inventar amanhã custa UM campo, nunca um item', () => {
    for (const bruto of ['', 'normal', 'PENDING_REVIEW', 'UNLISTED']) {
      expect(() => estadoDoAnuncio(lido({ itemStatus: bruto }), AGORA)).not.toThrow();
      expect(estadoDoAnuncio(lido({ itemStatus: bruto }), AGORA).estado).toBe(
        ESTADO_ANUNCIO_SHOPEE.desconhecido,
      );
    }
    expect(estadoDoAnuncio(lido({ itemStatus: null }), AGORA).estado).toBe(
      ESTADO_ANUNCIO_SHOPEE.desconhecido,
    );
  });

  it('o deboost é foldado em TODAS as linhas lidas, não só na NORMAL', () => {
    for (const status of ['BANNED', 'REVIEWING', 'UNLIST', 'SELLER_DELETE']) {
      expect(estadoDoAnuncio(lido({ itemStatus: status, deboost: 'TRUE' }), AGORA).deboost).toBe(
        true,
      );
    }
    // ⚠️ …but an ABSENT reading folds nothing: there was no body to read.
    expect(estadoDoAnuncio({ kind: 'ausente' }, AGORA).deboost).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                       (2) deboostDeWire — the fold                          */
/* -------------------------------------------------------------------------- */

const TABELA_DEBOOST: readonly { readonly bruto: unknown; readonly esperado: boolean }[] = [
  { bruto: true, esperado: true },
  { bruto: 'true', esperado: true },
  { bruto: 'True', esperado: true },
  { bruto: 'TRUE', esperado: true },
  { bruto: '  true  ', esperado: true },
  // ⚠️ PAR: the four spellings of "no" fold identically — including the
  // sandbox's measured `"FALSE"`, which is TRUTHY in JavaScript.
  { bruto: false, esperado: false },
  { bruto: 'false', esperado: false },
  { bruto: 'False', esperado: false },
  { bruto: 'FALSE', esperado: false },
];

describe('deboostDeWire', () => {
  it.each(TABELA_DEBOOST)(
    'deboostDeWire — a string "FALSE" do sandbox é FALSE: $bruto ⇒ $esperado',
    ({ bruto, esperado }) => {
      expect(deboostDeWire(bruto)).toBe(esperado);
    },
  );

  it('⚠️ NEAR-MISS: "0", "1", "sim" e 1 são FALSE — o fold não é truthiness', () => {
    // Every one of these is TRUTHY in JavaScript except `0`; none is a deboost.
    for (const bruto of ['0', '1', 'sim', 'yes', 'truthy', 1, 0, {}, []]) {
      expect(deboostDeWire(bruto)).toBe(false);
    }
  });

  it('ausência não é deboost', () => {
    expect(deboostDeWire(null)).toBe(false);
    expect(deboostDeWire(undefined)).toBe(false);
    expect(deboostDeWire('')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                        (3) agendadoParaMsDe — seconds                       */
/* -------------------------------------------------------------------------- */

describe('agendadoParaMsDe', () => {
  it('agendadoParaMsDe recusa o zero-fill da Shopee', () => {
    expect(agendadoParaMsDe(0)).toBeNull();
    expect(agendadoParaMsDe(null)).toBeNull();
    expect(agendadoParaMsDe(undefined)).toBeNull();
    // ⚠️ NEAR-MISS: one second BELOW the 2020-01-01 floor is still absence.
    expect(agendadoParaMsDe(1_577_836_799)).toBeNull();
    expect(agendadoParaMsDe(1_577_836_800)).toBe(1_577_836_800_000);
    expect(agendadoParaMsDe(1_733_590_920)).toBe(1_733_590_920_000);
  });

  it('o resultado é MILISSEGUNDOS e alimenta o arm agendado do fold', () => {
    const ms = agendadoParaMsDe(1_790_000_000);
    expect(ms).toBe(1_790_000_000_000);
    expect(estadoDoAnuncio(lido({ itemStatus: 'UNLIST', agendadoParaMs: ms }), AGORA).estado).toBe(
      ESTADO_ANUNCIO_SHOPEE.agendado,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                       (4) anuncioShopeeVivo — the trigger                   */
/* -------------------------------------------------------------------------- */

describe('anuncioShopeeVivo', () => {
  it('anuncioShopeeVivo — estadoAnuncio null é VIVO', () => {
    // A step-9 link has never been folded; `null` is not evidence of anything.
    expect(anuncioShopeeVivo({ item_id: ITEM_ID })).toBe(true);
    expect(anuncioShopeeVivo({ item_id: ITEM_ID, estadoAnuncio: null })).toBe(true);
    expect(
      anuncioShopeeVivo({ item_id: ITEM_ID, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado }),
    ).toBe(true);
  });

  it("⚠️ NEAR-MISS: …e 'removido' não é", () => {
    expect(
      anuncioShopeeVivo({ item_id: ITEM_ID, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido }),
    ).toBe(false);
  });

  it('um link sem item_id publicável não é sobrevivente', () => {
    expect(anuncioShopeeVivo({ item_id: null })).toBe(false);
    expect(anuncioShopeeVivo({ item_id: 0 })).toBe(false);
    expect(anuncioShopeeVivo({ item_id: -1 })).toBe(false);
    expect(anuncioShopeeVivo({})).toBe(false);
    expect(anuncioShopeeVivo(null)).toBe(false);
  });

  it('um documento ilegível não LANÇA — ele responde um booleano', () => {
    const lixo: Record<string, unknown>[] = [
      { item_id: 'abc' },
      { item_id: String(ITEM_ID) },
      { item_id: Number.NaN },
      { item_id: ITEM_ID, estadoAnuncio: 42 },
      { item_id: ITEM_ID, estadoAnuncio: { removido: true } },
      { item_id: [ITEM_ID] },
    ];
    for (const doc of lixo) {
      expect(() => anuncioShopeeVivo(doc)).not.toThrow();
      expect(typeof anuncioShopeeVivo(doc)).toBe('boolean');
    }
    // ⚠️ A STRINGIFIED id reads as NOT alive — recorded, not guessed around.
    expect(anuncioShopeeVivo({ item_id: String(ITEM_ID) })).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                   (5) the folder declares no clock and no µs                */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ Spelled in FRAGMENTS on purpose. This file lives UNDER `anuncios/`, and
 * the wave gate greps that whole folder as raw text for exactly these names —
 * a test that spelled them would red the gate it exists to enforce.
 */
const NOMES_PROIBIDOS = [
  ['millis', 'To', 'Micros'].join(''),
  ['coerce', 'To', 'Micros'].join(''),
  ['micros', 'To', 'Millis'].join(''),
  ['Date', '.', 'now('].join(''),
];

describe('a disciplina da pasta anuncios/', () => {
  it('a pasta anuncios/ não nomeia nenhum conversor de microssegundos', () => {
    // A raw-text grep, so a source must not spell them even in a comment — the
    // `freteShopeeMapping.test.ts` precedent, and what keeps the µs SITE list in
    // `apps/shopee/CLAUDE.md` honest: every stamp on a produto link doc is
    // MILLISECONDS, and this folder reads no clock at all (`nowMs` is always a
    // parameter).
    const pasta = fileURLToPath(new URL('.', import.meta.url));
    const fontes = readdirSync(pasta).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

    // ÂNCORA: the directory really was read and really does hold this module.
    expect(fontes).toContain('statusAnuncio.ts');

    for (const arquivo of fontes) {
      const fonte = readFileSync(`${pasta}${arquivo}`, 'utf8');
      for (const proibido of NOMES_PROIBIDOS) {
        expect(fonte, `${arquivo} nomeia ${proibido}`).not.toContain(proibido);
      }
    }
  });
});
