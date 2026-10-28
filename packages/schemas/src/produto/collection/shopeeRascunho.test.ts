import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AGUARDAR_KIT_INCERTO_SHOPEE_MS } from '../../shopeeAcaoSugerida';
import { ESTADO_ANUNCIO_SHOPEE } from './shopeeLink';
import { anuncioShopeeVivo, ehRascunhoShopee } from './shopeeLinkLeitura';
import {
  AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
  CODIGO_RASCUNHO_SHOPEE,
  estadoPublicacaoRascunhoShopee,
  MARGEM_ENVIO_SHOPEE_MS,
  PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
  rascunhoSemMarcaShopee,
  TETO_ROTA_SHOPEE_MS,
  vinculoConflitanteShopeeSchema,
  vinculosQueExigemConfirmacaoShopee,
  type EstadoPublicacaoRascunhoShopee,
} from './shopeeRascunho';

/* ---------------------------------- fixtures ------------------------------ */

const DESDE = 1_761_000_000_000;
const EXPIRA = DESDE + PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS;
const GRACA = 240_000;
const TRAVA = { desde: DESDE, expiraEm: EXPIRA, token: 'tok-1' };
const INCERTA_DESDE = DESDE - 600_000;

/** A draft carrying the lock (and, when given, an earlier uncertain attempt). */
function rascunhoTravado(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { item_id: null, publicacaoEmCurso: TRAVA, ...extra };
}

const CONTA = 'int-1';
const REF = `documents/integracao/${CONTA}`;
const REF_NUA = `integracao/${CONTA}`;
const OUTRA_REF = 'documents/integracao/int-12';

/* -------------------------------------------------------------------------- */
/*                              (1) the constants                              */
/* -------------------------------------------------------------------------- */

describe('as constantes da trava (#1911, K1-2)', () => {
  it('os valores congelados no §2.1', () => {
    expect(PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS).toBe(300_000);
    expect(TETO_ROTA_SHOPEE_MS).toBe(180_000);
    expect(MARGEM_ENVIO_SHOPEE_MS).toBe(30_000);
    expect(AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS).toBe(240_000);
  });

  it('a espera do anúncio incerto É a do kit — um apelido, nunca um segundo número (#1369)', () => {
    expect(AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS).toBe(AGUARDAR_KIT_INCERTO_SHOPEE_MS);
    // O valor pode estar certo por coincidência; o TEXTO prova que é o apelido.
    const fonte = readFileSync(join(import.meta.dirname, 'shopeeRascunho.ts'), 'utf8');
    expect(fonte).toMatch(
      /export const AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS = AGUARDAR_KIT_INCERTO_SHOPEE_MS;/,
    );
  });

  it('as relações que tornam a janela segura', () => {
    // A trava vive mais que o teto da rota: quando a trava de uma requisição
    // expira, a requisição que a tomou já passou do teto.
    expect(PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS).toBeGreaterThan(TETO_ROTA_SHOPEE_MS);
    // A margem cabe dentro do teto e da trava — senão nenhum envio passaria.
    expect(MARGEM_ENVIO_SHOPEE_MS).toBeLessThan(TETO_ROTA_SHOPEE_MS);
    expect(MARGEM_ENVIO_SHOPEE_MS).toBeLessThan(PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS);
    // A carência sobrevive a uma requisição inteira que tenha começado no limite.
    expect(AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS).toBeGreaterThan(TETO_ROTA_SHOPEE_MS);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 (2) the codes                               */
/* -------------------------------------------------------------------------- */

describe('CODIGO_RASCUNHO_SHOPEE — os códigos do P3', () => {
  it('os seis códigos, com os valores congelados no §2.1', () => {
    expect(CODIGO_RASCUNHO_SHOPEE).toEqual({
      publicacaoEmAndamento: 'SHOPEE_PUBLICACAO_EM_ANDAMENTO',
      jaPublicado: 'SHOPEE_RASCUNHO_JA_PUBLICADO',
      publicacaoExpirada: 'SHOPEE_PUBLICACAO_EXPIRADA',
      contencao: 'SHOPEE_RASCUNHO_CONTENCAO',
      criacaoIncerta: 'SHOPEE_RASCUNHO_CRIACAO_INCERTA',
      contaJaTemAnuncio: 'SHOPEE_RASCUNHO_CONTA_JA_TEM_ANUNCIO',
    });
  });

  it('nenhum valor se repete — um código ambíguo faria o leitor escolher o ramo errado', () => {
    const valores = Object.values(CODIGO_RASCUNHO_SHOPEE);
    expect(new Set(valores).size).toBe(valores.length);
  });
});

/* -------------------------------------------------------------------------- */
/*                   (3) estadoPublicacaoRascunhoShopee                       */
/* -------------------------------------------------------------------------- */

describe('estadoPublicacaoRascunhoShopee — sem trava', () => {
  it('PAR: documento nulo, trava AUSENTE e trava `null` são o MESMO `livre`', () => {
    expect(estadoPublicacaoRascunhoShopee(null, DESDE)).toEqual({ tipo: 'livre' });
    expect(estadoPublicacaoRascunhoShopee({ item_id: null }, DESDE)).toEqual({ tipo: 'livre' });
    expect(
      estadoPublicacaoRascunhoShopee({ item_id: null, publicacaoEmCurso: null }, DESDE),
    ).toEqual({ tipo: 'livre' });
    expect(
      estadoPublicacaoRascunhoShopee(
        { item_id: null, publicacaoEmCurso: null, criacaoIncertaDesde: null },
        DESDE,
      ),
    ).toEqual({ tipo: 'livre' });
  });

  it('⛔ NEAR-MISS: sem trava mas COM `criacaoIncertaDesde` ⇒ `incerta`, nunca `livre`', () => {
    expect(
      estadoPublicacaoRascunhoShopee({ item_id: null, criacaoIncertaDesde: INCERTA_DESDE }, DESDE),
    ).toEqual({ tipo: 'incerta', desdeMs: INCERTA_DESDE });
  });

  it('⛔ NEAR-MISS: um `criacaoIncertaDesde` ilegível AINDA conta como registrado (desdeMs null)', () => {
    for (const bruto of ['1761000000000', '', 1.5, true, {}]) {
      expect(
        estadoPublicacaoRascunhoShopee({ item_id: null, criacaoIncertaDesde: bruto }, DESDE),
        JSON.stringify(bruto),
      ).toEqual({ tipo: 'incerta', desdeMs: null });
    }
  });
});

describe('estadoPublicacaoRascunhoShopee — as fronteiras congeladas (§2.1, K1-2(b))', () => {
  const casos: readonly {
    readonly nome: string;
    readonly agora: number;
    readonly comIncerteza: boolean;
    readonly esperado: EstadoPublicacaoRascunhoShopee;
  }[] = [
    {
      nome: 'DESDE (o instante em que foi tomada) ⇒ em-andamento, a trava inteira por esperar',
      agora: DESDE,
      comIncerteza: false,
      esperado: {
        tipo: 'em-andamento',
        desdeMs: DESDE,
        expiraEmMs: EXPIRA,
        aguardarMs: PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
        aposIncerteza: false,
        posExpiracao: false,
      },
    },
    {
      nome: 'expiraEm − 1 ⇒ em-andamento, posExpiracao: false, 1 ms por esperar',
      agora: EXPIRA - 1,
      comIncerteza: false,
      esperado: {
        tipo: 'em-andamento',
        desdeMs: DESDE,
        expiraEmMs: EXPIRA,
        aguardarMs: 1,
        aposIncerteza: false,
        posExpiracao: false,
      },
    },
    {
      nome: 'expiraEm ⇒ AINDA em-andamento (a carência), posExpiracao: true, 240 000 por esperar',
      agora: EXPIRA,
      comIncerteza: false,
      esperado: {
        tipo: 'em-andamento',
        desdeMs: DESDE,
        expiraEmMs: EXPIRA,
        aguardarMs: GRACA,
        aposIncerteza: false,
        posExpiracao: true,
      },
    },
    {
      nome: 'expiraEm + 240 000 − 1 ⇒ em-andamento, posExpiracao: true, 1 ms por esperar',
      agora: EXPIRA + GRACA - 1,
      comIncerteza: false,
      esperado: {
        tipo: 'em-andamento',
        desdeMs: DESDE,
        expiraEmMs: EXPIRA,
        aguardarMs: 1,
        aposIncerteza: false,
        posExpiracao: true,
      },
    },
    {
      nome: 'expiraEm + 240 000 ⇒ incerta (a carência acabou), desde = o da trava',
      agora: EXPIRA + GRACA,
      comIncerteza: false,
      esperado: { tipo: 'incerta', desdeMs: DESDE },
    },
    {
      nome: 'expiraEm − 1 COM criacaoIncertaDesde ⇒ em-andamento, aposIncerteza: true',
      agora: EXPIRA - 1,
      comIncerteza: true,
      esperado: {
        tipo: 'em-andamento',
        desdeMs: DESDE,
        expiraEmMs: EXPIRA,
        aguardarMs: 1,
        aposIncerteza: true,
        posExpiracao: false,
      },
    },
    {
      nome: 'expiraEm COM criacaoIncertaDesde ⇒ incerta JÁ (a espera já foi cumprida), desde = o da incerteza',
      agora: EXPIRA,
      comIncerteza: true,
      esperado: { tipo: 'incerta', desdeMs: INCERTA_DESDE },
    },
  ];

  for (const caso of casos) {
    it(caso.nome, () => {
      const link = rascunhoTravado(caso.comIncerteza ? { criacaoIncertaDesde: INCERTA_DESDE } : {});
      expect(estadoPublicacaoRascunhoShopee(link, caso.agora)).toEqual(caso.esperado);
    });
  }

  it('a leitura é MONÓTONA no tempo: em-andamento → carência → incerta, nunca de volta, nunca `livre`', () => {
    const ordem = (e: EstadoPublicacaoRascunhoShopee): number =>
      e.tipo === 'livre' ? -1 : e.tipo === 'incerta' ? 2 : e.posExpiracao ? 1 : 0;
    let anterior = 0;
    for (let t = DESDE - 1_000; t <= EXPIRA + GRACA + 60_000; t += 7_919) {
      const atual = ordem(estadoPublicacaoRascunhoShopee(rascunhoTravado(), t));
      expect(atual, String(t)).toBeGreaterThanOrEqual(anterior);
      anterior = atual;
    }
    expect(anterior).toBe(2);
  });

  it('`aguardarMs` é sempre > 0 enquanto em-andamento, e chega exatamente no fim da carência', () => {
    for (let t = DESDE; t < EXPIRA + GRACA; t += 13_337) {
      const e = estadoPublicacaoRascunhoShopee(rascunhoTravado(), t);
      if (e.tipo !== 'em-andamento') throw new Error(`esperava em-andamento em ${String(t)}`);
      expect(e.aguardarMs).toBeGreaterThan(0);
      expect(t + e.aguardarMs).toBe(e.posExpiracao ? EXPIRA + GRACA : EXPIRA);
    }
  });

  it('a incerteza registrada vence o `desde` da trava (a tentativa MAIS ANTIGA)', () => {
    expect(
      estadoPublicacaoRascunhoShopee(
        rascunhoTravado({ criacaoIncertaDesde: INCERTA_DESDE }),
        EXPIRA + GRACA,
      ),
    ).toEqual({ tipo: 'incerta', desdeMs: INCERTA_DESDE });
  });

  it('⛔ NEAR-MISS: um `criacaoIncertaDesde` ilegível ainda TIRA a carência; desdeMs cai no da trava', () => {
    expect(
      estadoPublicacaoRascunhoShopee(rascunhoTravado({ criacaoIncertaDesde: 'x' }), EXPIRA),
    ).toEqual({ tipo: 'incerta', desdeMs: DESDE });
  });
});

describe('estadoPublicacaoRascunhoShopee — trava ilegível', () => {
  it('⛔ uma trava malformada é `incerta`, nunca `livre` (nem ausente, nem em andamento)', () => {
    const malformadas: readonly unknown[] = [
      'tok-1',
      0,
      true,
      [],
      {},
      { ...TRAVA, token: '' },
      { desde: DESDE, expiraEm: EXPIRA },
      { ...TRAVA, desde: 1.5 },
      { ...TRAVA, expiraEm: String(EXPIRA) },
      { ...TRAVA, expiraEm: Number.NaN },
      { ...TRAVA, expiraEm: Number.POSITIVE_INFINITY },
    ];
    for (const trava of malformadas) {
      expect(
        estadoPublicacaoRascunhoShopee({ item_id: null, publicacaoEmCurso: trava }, DESDE),
        JSON.stringify(trava),
      ).toEqual({ tipo: 'incerta', desdeMs: null });
    }
  });

  it('com incerteza registrada, a trava ilegível ainda é incerta — desde = o da incerteza', () => {
    expect(
      estadoPublicacaoRascunhoShopee(
        { item_id: null, publicacaoEmCurso: { token: 'x' }, criacaoIncertaDesde: INCERTA_DESDE },
        DESDE,
      ),
    ).toEqual({ tipo: 'incerta', desdeMs: INCERTA_DESDE });
  });

  it('PAR: uma chave a MAIS na trava (passthrough) não a torna ilegível', () => {
    expect(
      estadoPublicacaoRascunhoShopee(
        { item_id: null, publicacaoEmCurso: { ...TRAVA, etapa: 'addItem' } },
        DESDE,
      ).tipo,
    ).toBe('em-andamento');
  });

  it('lê a trava qualquer que seja o documento — ser rascunho é pergunta de quem chama', () => {
    expect(
      estadoPublicacaoRascunhoShopee({ item_id: 2500139861, publicacaoEmCurso: TRAVA }, DESDE).tipo,
    ).toBe('em-andamento');
  });

  it('⛔ um relógio inválido nunca libera uma trava', () => {
    expect(estadoPublicacaoRascunhoShopee(rascunhoTravado(), Number.NaN).tipo).toBe('incerta');
  });
});

/* -------------------------------------------------------------------------- */
/*                       (4) rascunhoSemMarcaShopee                           */
/* -------------------------------------------------------------------------- */

describe('rascunhoSemMarcaShopee — a marca ainda por escolher (D10)', () => {
  it('PAR: rascunho com `brand_id: null` e rascunho SEM a chave são "sem marca"', () => {
    expect(rascunhoSemMarcaShopee({ item_id: null, brand_id: null })).toBe(true);
    expect(rascunhoSemMarcaShopee({ item_id: null })).toBe(true);
    expect(rascunhoSemMarcaShopee({})).toBe(true);
    expect(rascunhoSemMarcaShopee({ item_id: null, brand_id: undefined })).toBe(true);
  });

  it('⛔ NEAR-MISS: `brand_id: 0` é "Sem marca" ESCOLHIDO — não é pendência', () => {
    expect(rascunhoSemMarcaShopee({ item_id: null, brand_id: 0 })).toBe(false);
  });

  it('DISTINTO: qualquer outro valor guardado responde "escolhida" (o que ele envia é da montagem)', () => {
    for (const brand of [77, -1, '', '77', false]) {
      expect(rascunhoSemMarcaShopee({ item_id: null, brand_id: brand }), String(brand)).toBe(false);
    }
  });

  it('⛔ NEAR-MISS: um anúncio importado com `brand_id: null` NÃO é rascunho ⇒ não é pendência', () => {
    expect(rascunhoSemMarcaShopee({ item_id: 2500139861, brand_id: null })).toBe(false);
    const importadoRemovido: Record<string, unknown> = {
      item_id: 2500139861,
      brand_id: null,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
    };
    expect(rascunhoSemMarcaShopee(importadoRemovido)).toBe(false);
  });

  it('DISTINTO: o resíduo de kit nativo (`kitNativo: true`, sem item) e o documento nulo', () => {
    expect(rascunhoSemMarcaShopee({ item_id: null, kitNativo: true, brand_id: null })).toBe(false);
    expect(rascunhoSemMarcaShopee(null)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                 (5) vinculosQueExigemConfirmacaoShopee                      */
/* -------------------------------------------------------------------------- */

describe('vinculosQueExigemConfirmacaoShopee — o segundo anúncio (D15, K1-4)', () => {
  const rascunhoA = { id: 'A', data: { contaProdutoShopeeOuterRef: REF, item_id: null } };
  const rascunhoB = { id: 'B', data: { contaProdutoShopeeOuterRef: REF, item_id: null } };
  const vivo = {
    id: 'V',
    data: {
      contaProdutoShopeeOuterRef: REF,
      item_id: 2500139861,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    },
  };

  it('dois rascunhos da conta: publicar A ⇒ B exige a confirmação', () => {
    expect(vinculosQueExigemConfirmacaoShopee([rascunhoA, rascunhoB], CONTA, 'A')).toEqual([
      { linkDocId: 'B', itemId: null, rascunho: true },
    ]);
  });

  it('⛔ NEAR-MISS: B `removido` (não é vivo nem rascunho) ⇒ nada a confirmar', () => {
    const bRemovido = {
      id: 'B',
      data: {
        contaProdutoShopeeOuterRef: REF,
        item_id: 2500139862,
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      },
    };
    expect(vinculosQueExigemConfirmacaoShopee([rascunhoA, bRemovido], CONTA, 'A')).toEqual([]);
  });

  it('um anúncio vivo conta com o seu item_id — e um SUBSTITUÍDO também (ainda está na Shopee)', () => {
    const substituido = {
      id: 'S',
      data: {
        contaProdutoShopeeOuterRef: REF,
        item_id: 2500139863,
        substituidoPorLinkDocId: 'V',
      },
    };
    expect(vinculosQueExigemConfirmacaoShopee([vivo, substituido, rascunhoA], CONTA, 'A')).toEqual([
      { linkDocId: 'V', itemId: 2500139861, rascunho: false },
      { linkDocId: 'S', itemId: 2500139863, rascunho: false },
    ]);
  });

  it('o próprio link fica de fora; sem `excluirLinkDocId`, todos contam (a criação de um rascunho novo)', () => {
    expect(vinculosQueExigemConfirmacaoShopee([rascunhoA], CONTA, 'A')).toEqual([]);
    expect(vinculosQueExigemConfirmacaoShopee([rascunhoA, vivo], CONTA)).toEqual([
      { linkDocId: 'A', itemId: null, rascunho: true },
      { linkDocId: 'V', itemId: 2500139861, rascunho: false },
    ]);
  });

  it('PAR: as duas codificações do ref da conta contam igual', () => {
    const legado = { id: 'L', data: { contaProdutoShopeeOuterRef: REF_NUA, item_id: null } };
    expect(vinculosQueExigemConfirmacaoShopee([legado], CONTA)).toEqual([
      { linkDocId: 'L', itemId: null, rascunho: true },
    ]);
  });

  it('⛔ NEAR-MISS: um link de OUTRA conta (`int-12` não é `int-1`) ou sem conta não conta', () => {
    const outra = { id: 'O', data: { contaProdutoShopeeOuterRef: OUTRA_REF, item_id: 2500139864 } };
    const semConta = { id: 'N', data: { item_id: null } };
    expect(vinculosQueExigemConfirmacaoShopee([outra, semConta], CONTA)).toEqual([]);
  });

  it('⛔ NEAR-MISS: um link CORROMPIDO (item 0, "123", resíduo de kit nativo) não é nenhum dos dois', () => {
    const corrompidos = [
      { id: 'z', data: { contaProdutoShopeeOuterRef: REF, item_id: 0 } },
      { id: 's', data: { contaProdutoShopeeOuterRef: REF, item_id: '123' } },
      { id: 'k', data: { contaProdutoShopeeOuterRef: REF, item_id: null, kitNativo: true } },
    ];
    for (const c of corrompidos) {
      expect(anuncioShopeeVivo(c.data) || ehRascunhoShopee(c.data), c.id).toBe(false);
    }
    expect(vinculosQueExigemConfirmacaoShopee(corrompidos, CONTA)).toEqual([]);
  });

  it('a saída é EXATAMENTE o que o leitor do 409 aceita (vinculoConflitanteShopeeSchema)', () => {
    const saida = vinculosQueExigemConfirmacaoShopee([vivo, rascunhoA, rascunhoB], CONTA, 'B');
    expect(saida).toHaveLength(2);
    for (const v of saida) expect(vinculoConflitanteShopeeSchema.parse(v)).toEqual(v);
  });
});

describe('vinculoConflitanteShopeeSchema — o item de `vinculos[]`', () => {
  it('PAR: rascunho (itemId null) e anúncio (itemId inteiro); chaves a mais caem fora', () => {
    expect(
      vinculoConflitanteShopeeSchema.parse({ linkDocId: 'A', itemId: null, rascunho: true }),
    ).toEqual({ linkDocId: 'A', itemId: null, rascunho: true });
    expect(
      vinculoConflitanteShopeeSchema.parse({
        linkDocId: 'V',
        itemId: 2500139861,
        rascunho: false,
        produtoId: 'p-1',
      }),
    ).toEqual({ linkDocId: 'V', itemId: 2500139861, rascunho: false });
  });

  it('⛔ NEAR-MISS: linkDocId vazio, itemId fracionário ou em texto, rascunho ausente são recusados', () => {
    for (const ruim of [
      { linkDocId: '', itemId: null, rascunho: true },
      { linkDocId: 'V', itemId: 1.5, rascunho: false },
      { linkDocId: 'V', itemId: '2500139861', rascunho: false },
      { linkDocId: 'V', itemId: 2500139861 },
    ]) {
      expect(vinculoConflitanteShopeeSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(
        false,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                         (6) the text of the file                            */
/* -------------------------------------------------------------------------- */

describe('shopeeRascunho.ts — o texto do arquivo', () => {
  const FONTE = readFileSync(join(import.meta.dirname, 'shopeeRascunho.ts'), 'utf8');

  it('é puro: nenhum relógio, nenhuma transação, nenhum carimbo em microssegundos', () => {
    // O relógio é o da ROTA e chega como parâmetro; o inventário de transações
    // (`config-eslint`) grepa TEXTO CRU, comentários inclusive.
    for (const proibido of ['Date.now(', 'new Date(', 'runTransaction', 'µs', 'firebase']) {
      expect(FONTE, proibido).not.toContain(proibido);
    }
    expect(FONTE).toContain('MILLISECONDS');
  });
});
