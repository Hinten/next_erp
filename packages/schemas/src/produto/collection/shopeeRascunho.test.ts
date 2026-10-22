import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { AGUARDAR_KIT_INCERTO_SHOPEE_MS } from '../../shopeeAcaoSugerida';
import { ESTADO_ANUNCIO_SHOPEE, produtoShopeeLinkSchema } from './shopeeLink';
import { anuncioShopeeVivo, ehRascunhoShopee } from './shopeeLinkLeitura';
import {
  AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
  baseRascunhoShopeeSchema,
  CAMPO_RASCUNHO_SHOPEE,
  campoRascunhoShopeeSchema,
  camposDoRascunhoShopee,
  camposPresentesDoRascunhoShopee,
  CODIGO_RASCUNHO_SHOPEE,
  conflitoRascunhoShopeeSchema,
  conteudoRascunhoShopeeSchema,
  corpoAtualizarRascunhoShopeeSchema,
  corpoCriarRascunhoShopeeSchema,
  corpoDescartarRascunhoShopeeSchema,
  estadoPublicacaoRascunhoShopee,
  idRascunhoShopeeSchema,
  MARGEM_ENVIO_SHOPEE_MS,
  MAX_DESCRIPTION_RASCUNHO_SHOPEE,
  MAX_ITEM_NAME_RASCUNHO_SHOPEE,
  mesmoValorDoRascunhoShopee,
  MOTIVO_RASCUNHO_INVALIDO_SHOPEE,
  motivoRascunhoInvalidoShopeeSchema,
  MSG_BASE_DIFERENTE_DO_PATCH_RASCUNHO_SHOPEE,
  MSG_ITEM_NAME_EM_BRANCO_RASCUNHO_SHOPEE,
  MSG_PATCH_VAZIO_RASCUNHO_SHOPEE,
  PADRAO_ID_RASCUNHO_SHOPEE,
  PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
  rascunhoSemMarcaShopee,
  respostaAtualizarRascunhoShopeeSchema,
  respostaCriarRascunhoShopeeSchema,
  respostaDescartarRascunhoShopeeSchema,
  TETO_ROTA_SHOPEE_MS,
  vinculoConflitanteShopeeSchema,
  vinculosQueExigemConfirmacaoShopee,
  type CampoRascunhoShopee,
  type CamposRascunhoShopee,
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

describe('CODIGO_RASCUNHO_SHOPEE — os códigos do P3 e do P4', () => {
  it('os onze códigos, com os valores congelados no §2.1 (seis do P3, cinco do P4)', () => {
    expect(CODIGO_RASCUNHO_SHOPEE).toEqual({
      publicacaoEmAndamento: 'SHOPEE_PUBLICACAO_EM_ANDAMENTO',
      jaPublicado: 'SHOPEE_RASCUNHO_JA_PUBLICADO',
      publicacaoExpirada: 'SHOPEE_PUBLICACAO_EXPIRADA',
      contencao: 'SHOPEE_RASCUNHO_CONTENCAO',
      criacaoIncerta: 'SHOPEE_RASCUNHO_CRIACAO_INCERTA',
      contaJaTemAnuncio: 'SHOPEE_RASCUNHO_CONTA_JA_TEM_ANUNCIO',
      conflito: 'SHOPEE_RASCUNHO_CONFLITO',
      idEmUso: 'SHOPEE_RASCUNHO_ID_EM_USO',
      categoriaTravada: 'SHOPEE_RASCUNHO_CATEGORIA_TRAVADA',
      produtoInvalido: 'SHOPEE_RASCUNHO_PRODUTO_INVALIDO',
      inexistente: 'SHOPEE_RASCUNHO_INEXISTENTE',
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
/*                  (7) the 422's motivo (P4, K2-10)                           */
/* -------------------------------------------------------------------------- */

describe('MOTIVO_RASCUNHO_INVALIDO_SHOPEE — o motivo do 422 (K2-10)', () => {
  it('os dois valores congelados no §2.1, e a constante cobre EXATAMENTE o enum', () => {
    expect(motivoRascunhoInvalidoShopeeSchema.options).toEqual(['filho', 'kit-virtual']);
    expect(MOTIVO_RASCUNHO_INVALIDO_SHOPEE).toEqual({ filho: 'filho', kitVirtual: 'kit-virtual' });
    expect(Object.values(MOTIVO_RASCUNHO_INVALIDO_SHOPEE).sort()).toEqual(
      [...motivoRascunhoInvalidoShopeeSchema.options].sort(),
    );
  });

  it('⛔ NEAR-MISS: os slugs PERSISTIDOS do despacho não são motivos desta rota', () => {
    // `falhaPublicacao` guarda o vocabulário do despacho; uma resposta que
    // ninguém guarda não se mistura com ele (o pino de `errosPublicacao.test.ts`).
    for (const slug of ['rascunho-em-kit-virtual', 'produto-e-filho', 'kit_virtual', 'Filho']) {
      expect(motivoRascunhoInvalidoShopeeSchema.safeParse(slug).success, slug).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                     (8) the vocabulary of the fields                        */
/* -------------------------------------------------------------------------- */

describe('CampoRascunhoShopee — os campos editáveis (§2.1)', () => {
  it('os seis campos na ordem CANÔNICA, e a constante cobre exatamente o enum', () => {
    expect(campoRascunhoShopeeSchema.options).toEqual([
      'item_name',
      'description',
      'category_id',
      'marca',
      'attributes',
      'logistic_info',
    ]);
    expect(Object.values(CAMPO_RASCUNHO_SHOPEE)).toEqual(campoRascunhoShopeeSchema.options);
  });
});

/* -------------------------------------------------------------------------- */
/*                  (9) camposDoRascunhoShopee — THE projection                */
/* -------------------------------------------------------------------------- */

const C = CAMPO_RASCUNHO_SHOPEE;
const VAZIO: CamposRascunhoShopee = {
  item_name: null,
  description: null,
  category_id: null,
  marca: null,
};

/**
 * What the draft route STORES for a normalised write — the frozen rule "the
 * pair is stored as BOTH keys; `null` ⇒ both `null`". The test's own spelling,
 * used to prove that every value a write produces reads back through the
 * projection unchanged.
 */
function gravado(conteudo: z.output<typeof conteudoRascunhoShopeeSchema>): Record<string, unknown> {
  const { marca, ...escalares } = conteudo;
  return {
    item_id: null,
    ...escalares,
    ...(marca === undefined
      ? {}
      : {
          brand_id: marca === null ? null : marca.brand_id,
          original_brand_name: marca === null ? null : marca.original_brand_name,
        }),
  };
}

/** Every field the value NAMES compares equal to the projection of what was stored. */
function todosIguais(
  campos: CamposRascunhoShopee,
  valores: Partial<Record<CampoRascunhoShopee, unknown>>,
): boolean {
  const lidos = campos as unknown as Record<CampoRascunhoShopee, never>;
  const dados = valores as Record<CampoRascunhoShopee, never>;
  return camposPresentesDoRascunhoShopee(valores).every((campo) =>
    mesmoValorDoRascunhoShopee(campo, lidos[campo], dados[campo]),
  );
}

describe('camposDoRascunhoShopee — A projeção de um rascunho guardado (K2-4, #1369)', () => {
  it('PAR: chave AUSENTE e `null` explícito são o MESMO `null` — decidido aqui, uma vez', () => {
    expect(camposDoRascunhoShopee({})).toEqual(VAZIO);
    expect(
      camposDoRascunhoShopee({
        item_id: null,
        item_name: null,
        description: null,
        category_id: null,
        brand_id: null,
        original_brand_name: null,
      }),
    ).toEqual(VAZIO);
  });

  it('VERBATIM: nunca apara, nunca troca o branco por `null` (o "" legado fica "")', () => {
    expect(camposDoRascunhoShopee({ item_name: 'Camiseta ', description: '' })).toMatchObject({
      item_name: 'Camiseta ',
      description: '',
    });
    expect(camposDoRascunhoShopee({ item_name: '', description: '   ' })).toMatchObject({
      item_name: '',
      description: '   ',
    });
  });

  it('a marca é o PAR quando há brand_id; `0` ("Sem marca") é uma escolha', () => {
    expect(camposDoRascunhoShopee({ brand_id: 77, original_brand_name: 'Acme' }).marca).toEqual({
      brand_id: 77,
      original_brand_name: 'Acme',
    });
    expect(camposDoRascunhoShopee({ brand_id: 0 }).marca).toEqual({
      brand_id: 0,
      original_brand_name: null,
    });
    expect(camposDoRascunhoShopee({ brand_id: 77, original_brand_name: '' }).marca).toEqual({
      brand_id: 77,
      original_brand_name: '',
    });
  });

  it('⛔ NEAR-MISS: um nome SEM brand_id não é marca escolhida', () => {
    expect(camposDoRascunhoShopee({ original_brand_name: 'Acme' }).marca).toBeNull();
    expect(
      camposDoRascunhoShopee({ brand_id: null, original_brand_name: 'Acme' }).marca,
    ).toBeNull();
  });

  it('um valor ILEGÍVEL lê `null` — o rascunho continua editável', () => {
    expect(
      camposDoRascunhoShopee({
        item_name: 123,
        description: { paragrafos: [] },
        category_id: '100087',
        brand_id: '77',
        original_brand_name: 'Acme',
      }),
    ).toEqual(VAZIO);
    for (const categoria of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1', true]) {
      expect(
        camposDoRascunhoShopee({ category_id: categoria }).category_id,
        String(categoria),
      ).toBeNull();
    }
    expect(camposDoRascunhoShopee({ brand_id: 77, original_brand_name: 5 }).marca).toEqual({
      brand_id: 77,
      original_brand_name: null,
    });
  });

  it('ler não é validar: inteiros fora da faixa de ESCRITA (0, negativo) são lidos VERBATIM', () => {
    expect(camposDoRascunhoShopee({ category_id: 0, brand_id: -1 })).toMatchObject({
      category_id: 0,
      marca: { brand_id: -1, original_brand_name: null },
    });
  });

  it('os campos RESERVADOS não são projetados, mesmo quando guardados', () => {
    const campos = camposDoRascunhoShopee({
      attributes: [{ attribute_id: 1 }],
      logistic_info: [{ logistic_id: 2 }],
    });
    expect(Object.keys(campos)).toEqual(['item_name', 'description', 'category_id', 'marca']);
  });

  it('lê qualquer documento — ser rascunho é pergunta de quem chama', () => {
    expect(camposDoRascunhoShopee({ item_id: 2500139861, item_name: 'Vivo' }).item_name).toBe(
      'Vivo',
    );
  });

  it('um rascunho recém-criado pelo schema guardado projeta exatamente o que foi escrito', () => {
    const criado = produtoShopeeLinkSchema.parse({
      contaProdutoShopeeOuterRef: REF,
      item_name: 'Camiseta',
    }) as Record<string, unknown>;
    expect(camposDoRascunhoShopee(criado)).toEqual({ ...VAZIO, item_name: 'Camiseta' });
  });

  it('PAR com rascunhoSemMarcaShopee: num rascunho de brand_id nulo, ausente ou inteiro, `marca === null` ⇔ "sem marca"', () => {
    const rascunhos: Record<string, unknown>[] = [
      { item_id: null },
      { item_id: null, brand_id: null },
      { item_id: null, brand_id: 0 },
      { item_id: null, brand_id: 77 },
      { item_id: null, brand_id: -1 },
    ];
    for (const r of rascunhos) {
      expect(camposDoRascunhoShopee(r).marca === null, JSON.stringify(r)).toBe(
        rascunhoSemMarcaShopee(r),
      );
    }
  });

  it('⚠️ DIVERGÊNCIA PINADA: um brand_id NÃO inteiro é ilegível aqui e "escolhido" para rascunhoSemMarcaShopee', () => {
    // Nenhum escritor grava um brand_id assim (a rota só grava inteiros). O
    // editor mostra "não escolhida" e o operador corrige; alinhar o predicado
    // do P3 é uma decisão em aberto — este pino faz a mudança ser deliberada.
    const corrompido: Record<string, unknown> = { item_id: null, brand_id: '77' };
    expect(camposDoRascunhoShopee(corrompido).marca).toBeNull();
    expect(rascunhoSemMarcaShopee(corrompido)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*              (10) mesmoValorDoRascunhoShopee — THE comparison               */
/* -------------------------------------------------------------------------- */

describe('mesmoValorDoRascunhoShopee — a comparação ESTREITA', () => {
  const ACME = { brand_id: 77, original_brand_name: 'Acme' };

  it('PAR: `undefined` ≡ `null` em cada campo escalar e na marca', () => {
    expect(mesmoValorDoRascunhoShopee(C.itemName, undefined, null)).toBe(true);
    expect(mesmoValorDoRascunhoShopee(C.description, null, undefined)).toBe(true);
    expect(mesmoValorDoRascunhoShopee(C.categoryId, undefined, undefined)).toBe(true);
    expect(mesmoValorDoRascunhoShopee(C.marca, undefined, null)).toBe(true);
  });

  it('PAR: o mesmo texto, o mesmo número, o mesmo "" e duas marcas nulas', () => {
    expect(mesmoValorDoRascunhoShopee(C.itemName, 'Camiseta', 'Camiseta')).toBe(true);
    expect(mesmoValorDoRascunhoShopee(C.description, '', '')).toBe(true);
    expect(mesmoValorDoRascunhoShopee(C.categoryId, 100087, 100087)).toBe(true);
    expect(mesmoValorDoRascunhoShopee(C.marca, null, null)).toBe(true);
  });

  it('PAR: a marca compara pelo brand_id — o nome SEGUE o id', () => {
    expect(
      mesmoValorDoRascunhoShopee(C.marca, ACME, { brand_id: 77, original_brand_name: null }),
    ).toBe(true);
    expect(
      mesmoValorDoRascunhoShopee(C.marca, ACME, { brand_id: 77, original_brand_name: 'ACME Ltda' }),
    ).toBe(true);
  });

  it('⛔ NEAR-MISS: "Camiseta" vs "Camiseta " (sem trim) e vs "camiseta" (sem caixa)', () => {
    expect(mesmoValorDoRascunhoShopee(C.itemName, 'Camiseta', 'Camiseta ')).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.itemName, ' Camiseta', 'Camiseta')).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.itemName, 'Camiseta', 'camiseta')).toBe(false);
  });

  it('⛔ NEAR-MISS: "" vs `null` — um "" guardado não é "nada"', () => {
    expect(mesmoValorDoRascunhoShopee(C.description, '', null)).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.itemName, undefined, '')).toBe(false);
  });

  it('⛔ NEAR-MISS: 100 vs "100" — sem coerção', () => {
    const texto = '100' as unknown as number;
    expect(mesmoValorDoRascunhoShopee(C.categoryId, 100, texto)).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.categoryId, 100, 101)).toBe(false);
  });

  it('⛔ NEAR-MISS: marca 0 ("Sem marca", escolhida) vs `null` (não escolhida); 0 vs 77', () => {
    const semMarca = { brand_id: 0, original_brand_name: null };
    expect(mesmoValorDoRascunhoShopee(C.marca, semMarca, null)).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.marca, undefined, semMarca)).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.marca, semMarca, ACME)).toBe(false);
  });

  it('⛔ uma "marca" que não é um par nunca é igual a nada — a dúvida vira conflito', () => {
    const solto = 77 as unknown as typeof ACME;
    expect(mesmoValorDoRascunhoShopee(C.marca, solto, solto)).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.marca, solto, ACME)).toBe(false);
    // @ts-expect-error — a marca é o PAR, nunca um brand_id solto.
    expect(mesmoValorDoRascunhoShopee(C.marca, 77, null)).toBe(false);
  });

  it('RESERVADOS: attributes e logistic_info são SEMPRE distintos, até `null` vs `null`', () => {
    expect(mesmoValorDoRascunhoShopee(C.attributes, null, null)).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.attributes, undefined, undefined)).toBe(false);
    expect(mesmoValorDoRascunhoShopee(C.logisticInfo, [], [])).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                      (11) camposPresentesDoRascunhoShopee                   */
/* -------------------------------------------------------------------------- */

describe('camposPresentesDoRascunhoShopee — os campos que um valor NOMEIA', () => {
  it('na ordem canônica, qualquer que seja a ordem das chaves; `null` conta, `undefined` não', () => {
    expect(
      camposPresentesDoRascunhoShopee({ marca: null, item_name: 'x', description: undefined }),
    ).toEqual(['item_name', 'marca']);
    expect(camposPresentesDoRascunhoShopee({ category_id: 1, item_name: null })).toEqual([
      'item_name',
      'category_id',
    ]);
    expect(camposPresentesDoRascunhoShopee({})).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                 (12) conteudoRascunhoShopeeSchema — the WHITELIST           */
/* -------------------------------------------------------------------------- */

describe('conteudoRascunhoShopeeSchema — a whitelist de escrita (normaliza)', () => {
  it('PAR: `{}` é um conteúdo válido e vazio', () => {
    expect(conteudoRascunhoShopeeSchema.parse({})).toEqual({});
  });

  it('item_name é guardado VERBATIM (sem trim)', () => {
    expect(conteudoRascunhoShopeeSchema.parse({ item_name: ' Camiseta ' })).toEqual({
      item_name: ' Camiseta ',
    });
  });

  it('description: em branco ⇒ `null` ("a do produto"); com texto, VERBATIM', () => {
    for (const branco of ['', '   ', '\n\t', null]) {
      expect(
        conteudoRascunhoShopeeSchema.parse({ description: branco }),
        JSON.stringify(branco),
      ).toEqual({ description: null });
    }
    expect(conteudoRascunhoShopeeSchema.parse({ description: ' Algodão \n' })).toEqual({
      description: ' Algodão \n',
    });
  });

  it('a marca: `null` fica `null`; `0` apaga o nome; nome em branco ⇒ `null`; com texto, VERBATIM', () => {
    expect(conteudoRascunhoShopeeSchema.parse({ marca: null })).toEqual({ marca: null });
    expect(
      conteudoRascunhoShopeeSchema.parse({
        marca: { brand_id: 0, original_brand_name: 'No Brand' },
      }),
    ).toEqual({ marca: { brand_id: 0, original_brand_name: null } });
    expect(
      conteudoRascunhoShopeeSchema.parse({ marca: { brand_id: 77, original_brand_name: '  ' } }),
    ).toEqual({ marca: { brand_id: 77, original_brand_name: null } });
    expect(
      conteudoRascunhoShopeeSchema.parse({ marca: { brand_id: 77, original_brand_name: 'Acme ' } }),
    ).toEqual({ marca: { brand_id: 77, original_brand_name: 'Acme ' } });
  });

  it('category_id: um inteiro positivo ou `null`', () => {
    expect(conteudoRascunhoShopeeSchema.parse({ category_id: 100087 })).toEqual({
      category_id: 100087,
    });
    expect(conteudoRascunhoShopeeSchema.parse({ category_id: null })).toEqual({
      category_id: null,
    });
  });

  it('⛔ a whitelist: item_id, um campo de ciclo de vida, os RESERVADOS e chaves desconhecidas são recusados', () => {
    for (const ruim of [
      { item_id: 2500139861 },
      { item_status: 'NORMAL' },
      { brand_id: 77 },
      { original_brand_name: 'Acme' },
      { publicacaoEmCurso: null },
      { attributes: [] },
      { logistic_info: [] },
      { item_name: 'Camiseta', foo: 1 },
    ]) {
      expect(conteudoRascunhoShopeeSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(
        false,
      );
    }
  });

  it('⛔ item_name vazio, só espaços ou `null` é recusado com a frase', () => {
    for (const ruim of ['', '   ', '\n', null]) {
      const lido = conteudoRascunhoShopeeSchema.safeParse({ item_name: ruim });
      expect(lido.success, JSON.stringify(ruim)).toBe(false);
      expect(lido.error?.issues[0]?.message).toBe(MSG_ITEM_NAME_EM_BRANCO_RASCUNHO_SHOPEE);
    }
  });

  it('as cotas são inclusivas: o máximo passa, +1 é recusado', () => {
    const nome = 'a'.repeat(MAX_ITEM_NAME_RASCUNHO_SHOPEE);
    const descricao = 'b'.repeat(MAX_DESCRIPTION_RASCUNHO_SHOPEE);
    expect(conteudoRascunhoShopeeSchema.safeParse({ item_name: nome }).success).toBe(true);
    expect(conteudoRascunhoShopeeSchema.safeParse({ item_name: `${nome}a` }).success).toBe(false);
    expect(conteudoRascunhoShopeeSchema.safeParse({ description: descricao }).success).toBe(true);
    expect(conteudoRascunhoShopeeSchema.safeParse({ description: `${descricao}b` }).success).toBe(
      false,
    );
    expect(MAX_ITEM_NAME_RASCUNHO_SHOPEE).toBe(2_000);
    expect(MAX_DESCRIPTION_RASCUNHO_SHOPEE).toBe(10_000);
  });

  it('⛔ category_id 0, negativo, fracionário, em texto ou inseguro é recusado', () => {
    for (const ruim of [0, -1, 1.5, '100087', 2 ** 53, Number.NaN]) {
      expect(
        conteudoRascunhoShopeeSchema.safeParse({ category_id: ruim }).success,
        String(ruim),
      ).toBe(false);
    }
  });

  it('⛔ a marca: brand_id negativo, fracionário ou em texto; o par sem nome; uma chave a mais', () => {
    for (const ruim of [
      { brand_id: -1, original_brand_name: null },
      { brand_id: 1.5, original_brand_name: null },
      { brand_id: '77', original_brand_name: null },
      { brand_id: 77 },
      { original_brand_name: 'Acme' },
      { brand_id: 77, original_brand_name: 'Acme', brand_name: 'Acme' },
    ]) {
      expect(
        conteudoRascunhoShopeeSchema.safeParse({ marca: ruim }).success,
        JSON.stringify(ruim),
      ).toBe(false);
    }
  });

  it('o que a escrita normaliza volta IGUAL pela projeção (todo valor gravado é legível)', () => {
    const conteudos = [
      { item_name: 'Camiseta ', description: '', category_id: 100087, marca: null },
      { description: 'Algodão', marca: { brand_id: 0, original_brand_name: 'No Brand' } },
      { marca: { brand_id: 77, original_brand_name: '  ' } },
      { marca: { brand_id: 77, original_brand_name: 'Acme' }, category_id: null },
    ];
    for (const bruto of conteudos) {
      const conteudo = conteudoRascunhoShopeeSchema.parse(bruto);
      const lidos = camposDoRascunhoShopee(gravado(conteudo));
      expect(todosIguais(lidos, conteudo), JSON.stringify(bruto)).toBe(true);
      // e o nome da marca volta exatamente como foi gravado, não só o id
      if (conteudo.marca !== undefined) expect(lidos.marca).toEqual(conteudo.marca);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*            (13) baseRascunhoShopeeSchema — what the operator SAW            */
/* -------------------------------------------------------------------------- */

const BASE_COMPLETA = {
  item_name: 'Camiseta',
  description: null,
  category_id: 100087,
  marca: { brand_id: 0, original_brand_name: null },
};

describe('baseRascunhoShopeeSchema — o que o operador VIU, verbatim (K2-4)', () => {
  it('VERBATIM: "" fica "", espaços ficam, `null` fica `null`', () => {
    expect(baseRascunhoShopeeSchema.parse({ description: '' })).toEqual({ description: '' });
    expect(baseRascunhoShopeeSchema.parse({ item_name: ' Camiseta ' })).toEqual({
      item_name: ' Camiseta ',
    });
    expect(baseRascunhoShopeeSchema.parse({ item_name: null })).toEqual({ item_name: null });
    expect(
      baseRascunhoShopeeSchema.parse({ marca: { brand_id: 0, original_brand_name: 'No Brand' } }),
    ).toEqual({ marca: { brand_id: 0, original_brand_name: 'No Brand' } });
  });

  it('⛔ QUASE-PAR com a escrita: o MESMO "" vira `null` no conteúdo e fica "" na base', () => {
    expect(conteudoRascunhoShopeeSchema.parse({ description: '' })).toEqual({ description: null });
    expect(baseRascunhoShopeeSchema.parse({ description: '' })).toEqual({ description: '' });
  });

  it('tolerante: sem mínimo, sem máximo, inteiros fora da faixa de escrita', () => {
    const longo = 'x'.repeat(MAX_DESCRIPTION_RASCUNHO_SHOPEE + 1);
    expect(
      baseRascunhoShopeeSchema.parse({
        item_name: '',
        description: longo,
        category_id: 0,
        marca: { brand_id: -1, original_brand_name: '' },
      }),
    ).toEqual({
      item_name: '',
      description: longo,
      category_id: 0,
      marca: { brand_id: -1, original_brand_name: '' },
    });
  });

  it('⛔ estrita: chave desconhecida, campo RESERVADO, par incompleto e tipo errado são recusados', () => {
    for (const ruim of [
      { foo: 1 },
      { attributes: null },
      { logistic_info: null },
      { brand_id: 77 },
      { marca: { brand_id: 77 } },
      { marca: { brand_id: 77, original_brand_name: null, extra: 1 } },
      { category_id: '100087' },
      { category_id: 1.5 },
      { item_name: 123 },
    ]) {
      expect(baseRascunhoShopeeSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(false);
    }
  });

  it('toda projeção é uma base VERBATIM — inclusive a completa do descarte (a ida e volta)', () => {
    const guardados: Record<string, unknown>[] = [
      {},
      { item_name: '', description: '' },
      { item_name: 'Camiseta ', description: '   ', category_id: 0, brand_id: -1 },
      { item_name: 7, category_id: 'x', brand_id: 77, original_brand_name: '' },
      { item_name: 'Camiseta', brand_id: 0, original_brand_name: 'No Brand' },
      { item_name: 'z'.repeat(5_000), description: 'y'.repeat(20_000) },
    ];
    const descarte = corpoDescartarRascunhoShopeeSchema.shape.base;
    for (const guardado of guardados) {
      const projecao = camposDoRascunhoShopee(guardado);
      expect(baseRascunhoShopeeSchema.parse(projecao)).toEqual(projecao);
      expect(descarte.parse(projecao)).toEqual(projecao);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                       (14) the create body                                  */
/* -------------------------------------------------------------------------- */

const ID_RASCUNHO = 'Ab3dEf5hIj7lMn9pQr1t';
const IDS = { integracaoId: CONTA, produtoId: 'prod-1' };

describe('corpoCriarRascunhoShopeeSchema — POST rascunho', () => {
  it('PAR: o mínimo, e com conteúdo + confirmação', () => {
    expect(corpoCriarRascunhoShopeeSchema.parse({ ...IDS, linkDocId: ID_RASCUNHO })).toEqual({
      ...IDS,
      linkDocId: ID_RASCUNHO,
    });
    expect(
      corpoCriarRascunhoShopeeSchema.parse({
        ...IDS,
        linkDocId: ID_RASCUNHO,
        conteudo: { item_name: 'Camiseta', description: '' },
        confirmarSegundoAnuncio: true,
      }),
    ).toEqual({
      ...IDS,
      linkDocId: ID_RASCUNHO,
      conteudo: { item_name: 'Camiseta', description: null },
      confirmarSegundoAnuncio: true,
    });
  });

  it('conteudo `null` e confirmação `null`/false são aceitos (só um `true` literal confirma)', () => {
    for (const confirmar of [false, null]) {
      expect(
        corpoCriarRascunhoShopeeSchema.safeParse({
          ...IDS,
          linkDocId: ID_RASCUNHO,
          conteudo: null,
          confirmarSegundoAnuncio: confirmar,
        }).success,
      ).toBe(true);
    }
    expect(
      corpoCriarRascunhoShopeeSchema.safeParse({
        ...IDS,
        linkDocId: ID_RASCUNHO,
        confirmarSegundoAnuncio: 'true',
      }).success,
    ).toBe(false);
  });

  it('o id do rascunho: exatamente 20 letras ou dígitos (o auto-id do Firestore)', () => {
    expect(PADRAO_ID_RASCUNHO_SHOPEE.test(ID_RASCUNHO)).toBe(true);
    expect(idRascunhoShopeeSchema.safeParse('00000000000000000000').success).toBe(true);
    const ruins = [
      ID_RASCUNHO.slice(1), // 19
      `${ID_RASCUNHO}x`, // 21
      `${ID_RASCUNHO.slice(2)}a/`, // 20 com "/"
      `${ID_RASCUNHO.slice(1)}-`, // 20 com "-"
      `${ID_RASCUNHO.slice(1)}_`, // 20 com "_"
      `${ID_RASCUNHO.slice(1)}é`, // 20 com acento
      'a/b',
      '',
      'f'.repeat(64), // o id derivado de um kit nativo
    ];
    for (const ruim of ruins) {
      expect(
        corpoCriarRascunhoShopeeSchema.safeParse({ ...IDS, linkDocId: ruim }).success,
        ruim,
      ).toBe(false);
    }
  });

  it('⛔ integracaoId e produtoId inutilizáveis como id de documento são recusados', () => {
    for (const ruim of ['', 'a/b', 'integracao/int-1', '.', '..', 7]) {
      expect(
        corpoCriarRascunhoShopeeSchema.safeParse({
          ...IDS,
          integracaoId: ruim,
          linkDocId: ID_RASCUNHO,
        }).success,
        `integracaoId ${String(ruim)}`,
      ).toBe(false);
      expect(
        corpoCriarRascunhoShopeeSchema.safeParse({
          ...IDS,
          produtoId: ruim,
          linkDocId: ID_RASCUNHO,
        }).success,
        `produtoId ${String(ruim)}`,
      ).toBe(false);
    }
  });

  it('⛔ estrito: item_id no conteúdo, chave desconhecida e campo ausente são 400', () => {
    for (const ruim of [
      { ...IDS, linkDocId: ID_RASCUNHO, conteudo: { item_id: 2500139861 } },
      { ...IDS, linkDocId: ID_RASCUNHO, categoryId: 100087 },
      { ...IDS, linkDocId: ID_RASCUNHO, base: {} },
      { integracaoId: CONTA, linkDocId: ID_RASCUNHO },
      { ...IDS },
    ]) {
      expect(corpoCriarRascunhoShopeeSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(
        false,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                         (15) the update body                                */
/* -------------------------------------------------------------------------- */

/** The update body for `base` and `patch`. */
function atualizar(base: unknown, patch: unknown): unknown {
  return { ...IDS, linkDocId: ID_RASCUNHO, base, patch };
}

/** The messages of a refused body. */
function mensagens(lido: { error?: { issues: { message: string }[] } }): string[] {
  return (lido.error?.issues ?? []).map((i) => i.message);
}

describe('corpoAtualizarRascunhoShopeeSchema — POST rascunho/atualizar', () => {
  it('PAR: `base` nomeia exatamente os campos de `patch` — em qualquer ordem de chaves', () => {
    const lido = corpoAtualizarRascunhoShopeeSchema.parse(
      atualizar(
        { category_id: null, item_name: 'Camiseta' },
        { item_name: 'Camiseta Azul', category_id: 100087 },
      ),
    );
    expect(lido.base).toEqual({ category_id: null, item_name: 'Camiseta' });
    expect(lido.patch).toEqual({ item_name: 'Camiseta Azul', category_id: 100087 });
  });

  it('`base` é VERBATIM e `patch` é NORMALIZADO, no mesmo corpo', () => {
    const lido = corpoAtualizarRascunhoShopeeSchema.parse(
      atualizar({ description: '' }, { description: '  ' }),
    );
    expect(lido.base).toEqual({ description: '' });
    expect(lido.patch).toEqual({ description: null });
  });

  it('⛔ `patch` vazio é 400 com a frase, no caminho `patch`', () => {
    const lido = corpoAtualizarRascunhoShopeeSchema.safeParse(atualizar({}, {}));
    expect(lido.success).toBe(false);
    expect(mensagens(lido)).toEqual([MSG_PATCH_VAZIO_RASCUNHO_SHOPEE]);
    expect(lido.error?.issues[0]?.path).toEqual(['patch']);
  });

  it('⛔ `base` com um campo A MAIS, A MENOS ou OUTRO é 400 com a frase, no caminho `base`', () => {
    for (const [base, patch] of [
      [{ item_name: 'A', description: null }, { item_name: 'B' }],
      [{ item_name: 'A' }, { item_name: 'B', description: 'x' }],
      [{ description: null }, { item_name: 'B' }],
      [{}, { item_name: 'B' }],
    ] as const) {
      const lido = corpoAtualizarRascunhoShopeeSchema.safeParse(atualizar(base, patch));
      expect(lido.success, JSON.stringify([base, patch])).toBe(false);
      expect(mensagens(lido)).toEqual([MSG_BASE_DIFERENTE_DO_PATCH_RASCUNHO_SHOPEE]);
      expect(lido.error?.issues[0]?.path).toEqual(['base']);
    }
  });

  it('PAR (K2-4): um rascunho legado SEM item_name aceita `base: {item_name: null}` e a edição do título', () => {
    const legado: Record<string, unknown> = { item_id: null, contaProdutoShopeeOuterRef: REF };
    const lido = corpoAtualizarRascunhoShopeeSchema.parse(
      atualizar({ item_name: null }, { item_name: 'Camiseta' }),
    );
    expect(
      mesmoValorDoRascunhoShopee(
        C.itemName,
        camposDoRascunhoShopee(legado).item_name,
        lido.base.item_name,
      ),
    ).toBe(true);
  });

  it('PAR/QUASE-PAR (K2-4): `description: ""` legado contra base "" ⇒ sem conflito; contra base `null` ⇒ conflito', () => {
    const guardado = camposDoRascunhoShopee({ item_id: null, description: '' });
    const comVazio = corpoAtualizarRascunhoShopeeSchema.parse(
      atualizar({ description: '' }, { description: 'Algodão' }),
    );
    const comNulo = corpoAtualizarRascunhoShopeeSchema.parse(
      atualizar({ description: null }, { description: 'Algodão' }),
    );
    expect(
      mesmoValorDoRascunhoShopee(C.description, guardado.description, comVazio.base.description),
    ).toBe(true);
    expect(
      mesmoValorDoRascunhoShopee(C.description, guardado.description, comNulo.base.description),
    ).toBe(false);
  });

  it('o id de um rascunho EXISTENTE só precisa ser um id de documento (o legado vem como veio)', () => {
    expect(
      corpoAtualizarRascunhoShopeeSchema.safeParse({
        ...IDS,
        linkDocId: 'rascunho-legado-1',
        base: { item_name: 'A' },
        patch: { item_name: 'B' },
      }).success,
    ).toBe(true);
    for (const ruim of ['', 'a/b', '..']) {
      expect(
        corpoAtualizarRascunhoShopeeSchema.safeParse({
          ...IDS,
          linkDocId: ruim,
          base: { item_name: 'A' },
          patch: { item_name: 'B' },
        }).success,
        ruim,
      ).toBe(false);
    }
  });

  it('⛔ estrito: uma chave desconhecida no corpo é 400, nunca descartada em silêncio', () => {
    const valido = atualizar({ item_name: 'A' }, { item_name: 'B' }) as Record<string, unknown>;
    expect(corpoAtualizarRascunhoShopeeSchema.safeParse(valido).success).toBe(true);
    for (const extra of [
      { conteudo: { item_name: 'B' } },
      { confirmarSegundoAnuncio: true },
      { item_name: 'B' },
    ]) {
      expect(
        corpoAtualizarRascunhoShopeeSchema.safeParse({ ...valido, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it('⛔ o patch passa pela whitelist: item_id, um RESERVADO ou um título em branco são 400', () => {
    for (const [base, patch] of [
      [{}, { item_id: 2500139861 }],
      [{ attributes: null }, { attributes: [] }],
      [{ item_name: 'A' }, { item_name: '  ' }],
    ] as const) {
      expect(
        corpoAtualizarRascunhoShopeeSchema.safeParse(atualizar(base, patch)).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                          (16) the discard body                              */
/* -------------------------------------------------------------------------- */

describe('corpoDescartarRascunhoShopeeSchema — POST rascunho/descartar (K1-13, K1-6)', () => {
  const corpo = { ...IDS, linkDocId: ID_RASCUNHO, base: BASE_COMPLETA };

  it('PAR: a base COMPLETA, com e sem a atestação', () => {
    expect(corpoDescartarRascunhoShopeeSchema.parse(corpo)).toEqual(corpo);
    for (const atesta of [true, false, null]) {
      expect(
        corpoDescartarRascunhoShopeeSchema.parse({ ...corpo, confirmarCriacaoIncerta: atesta })
          .confirmarCriacaoIncerta,
      ).toBe(atesta);
    }
  });

  it('⛔ a base precisa trazer TODO campo projetado — faltar um é 400', () => {
    for (const campo of Object.keys(BASE_COMPLETA)) {
      const { [campo]: _fora, ...incompleta } = BASE_COMPLETA as Record<string, unknown>;
      expect(
        corpoDescartarRascunhoShopeeSchema.safeParse({ ...corpo, base: incompleta }).success,
        campo,
      ).toBe(false);
    }
    expect(corpoDescartarRascunhoShopeeSchema.safeParse({ ...corpo, base: {} }).success).toBe(
      false,
    );
  });

  it('⛔ base com RESERVADO ou chave desconhecida, atestação não booleana, corpo sem base: 400', () => {
    for (const ruim of [
      { ...corpo, base: { ...BASE_COMPLETA, attributes: null } },
      { ...corpo, base: { ...BASE_COMPLETA, foo: 1 } },
      { ...corpo, confirmarCriacaoIncerta: 'sim' },
      { ...IDS, linkDocId: ID_RASCUNHO },
      { ...corpo, patch: {} },
    ]) {
      expect(corpoDescartarRascunhoShopeeSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(
        false,
      );
    }
  });

  it('a corrida (K1-13): uma edição feita depois do que o operador viu aparece na comparação', () => {
    const visto = camposDoRascunhoShopee({ item_id: null, item_name: 'Camiseta', brand_id: 0 });
    const { base } = corpoDescartarRascunhoShopeeSchema.parse({ ...corpo, base: visto });
    const depois = camposDoRascunhoShopee({ item_id: null, item_name: 'Camiseta 2', brand_id: 0 });
    const diferentes = camposPresentesDoRascunhoShopee(base).filter(
      (campo) =>
        !mesmoValorDoRascunhoShopee(
          campo,
          (depois as unknown as Record<CampoRascunhoShopee, never>)[campo],
          (base as unknown as Record<CampoRascunhoShopee, never>)[campo],
        ),
    );
    expect(diferentes).toEqual(['item_name']);
  });
});

/* -------------------------------------------------------------------------- */
/*                    (17) the create retry compare (K1-9)                     */
/* -------------------------------------------------------------------------- */

describe('a repetição de uma criação (K1-9) — o mesmo conteúdo ⟷ outro conteúdo', () => {
  const primeiro = conteudoRascunhoShopeeSchema.parse({
    item_name: 'Camiseta',
    description: '   ',
    marca: { brand_id: 0, original_brand_name: 'No Brand' },
  });
  const guardado = camposDoRascunhoShopee(gravado(primeiro));

  it('PAR: a repetição IDÊNTICA (normalizada) é igual ao que foi guardado', () => {
    const repeticao = conteudoRascunhoShopeeSchema.parse({
      item_name: 'Camiseta',
      description: '',
      marca: { brand_id: 0, original_brand_name: null },
    });
    expect(todosIguais(guardado, repeticao)).toBe(true);
  });

  it('⛔ NEAR-MISS: a repetição com o item_name mudado NÃO é igual', () => {
    const repeticao = conteudoRascunhoShopeeSchema.parse({
      item_name: 'Camiseta Azul',
      description: '',
      marca: { brand_id: 0, original_brand_name: null },
    });
    expect(todosIguais(guardado, repeticao)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                       (18) the answers and the 409 item                     */
/* -------------------------------------------------------------------------- */

describe('as respostas da rota e o item de `conflitos[]`', () => {
  it('criar: `criado` booleano; atualizar: `gravados` do vocabulário; descartar: `descartado: true`', () => {
    expect(
      respostaCriarRascunhoShopeeSchema.parse({ linkDocId: ID_RASCUNHO, criado: false }),
    ).toEqual({ linkDocId: ID_RASCUNHO, criado: false });
    expect(
      respostaAtualizarRascunhoShopeeSchema.parse({
        linkDocId: ID_RASCUNHO,
        gravados: [C.itemName, C.marca],
      }),
    ).toEqual({ linkDocId: ID_RASCUNHO, gravados: ['item_name', 'marca'] });
    expect(
      respostaAtualizarRascunhoShopeeSchema.parse({ linkDocId: ID_RASCUNHO, gravados: [] })
        .gravados,
    ).toEqual([]);
    expect(
      respostaDescartarRascunhoShopeeSchema.parse({
        linkDocId: ID_RASCUNHO,
        descartado: true,
        criacaoIncerta: true,
      }),
    ).toEqual({ linkDocId: ID_RASCUNHO, descartado: true, criacaoIncerta: true });
  });

  it('⛔ campo fora do vocabulário, `descartado: false` e linkDocId vazio são recusados', () => {
    expect(
      respostaAtualizarRascunhoShopeeSchema.safeParse({
        linkDocId: ID_RASCUNHO,
        gravados: ['brand_id'],
      }).success,
    ).toBe(false);
    expect(
      respostaDescartarRascunhoShopeeSchema.safeParse({
        linkDocId: ID_RASCUNHO,
        descartado: false,
        criacaoIncerta: false,
      }).success,
    ).toBe(false);
    expect(
      respostaCriarRascunhoShopeeSchema.safeParse({ linkDocId: '', criado: true }).success,
    ).toBe(false);
  });

  it('conflito: o campo e o valor guardado AGORA, na forma da projeção (qualquer valor)', () => {
    for (const atual of [
      null,
      '',
      'Camiseta',
      100087,
      { brand_id: 0, original_brand_name: null },
    ]) {
      expect(conflitoRascunhoShopeeSchema.parse({ campo: C.marca, atual })).toEqual({
        campo: 'marca',
        atual,
      });
    }
    expect(conflitoRascunhoShopeeSchema.parse({ campo: C.itemName, atual: 'x', extra: 1 })).toEqual(
      { campo: 'item_name', atual: 'x' },
    );
    expect(conflitoRascunhoShopeeSchema.safeParse({ campo: 'brand_id', atual: 77 }).success).toBe(
      false,
    );
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
