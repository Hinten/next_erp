import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  produtoShopeeLinkSchema,
  variacaoShopeeLinkSchema,
  shopeeItemStatusSchema,
  shopeeModelStatusSchema,
  SHOPEE_ITEM_STATUS,
  estadoAnuncioShopeeSchema,
  ESTADO_ANUNCIO_SHOPEE,
  shopeeViolacaoSchema,
  shopeeViolationReasonWireSchema,
  podeMoverAnuncioShopee,
  type EstadoAnuncioShopee,
  type MotivoAnuncioNaoMovivel,
} from './shopeeLink';
import { ACAO_STATUS_ANUNCIO, type AcaoStatusAnuncio } from './mercadoLivreLink';

/** Fixture ids only — never a real partner/shop/item id. */
const CONTA_REF = 'documents/integracao/int-1';
const ITEM_ID = 2500139861;
const MODEL_ID = 2000458802;

describe('produtoShopeeLinkSchema', () => {
  it('parses a legacy-shaped ProdutoShopee fixture doc', () => {
    const fixture = {
      contaProdutoShopeeOuterRef: 'documents/integracao/int1',
      item_name: 'Camiseta Básica Azul',
      item_id: 123456789,
      category_id: 100182,
      description: 'Camiseta 100% algodão.',
      description_type: 'normal',
      description_info: { field_list: [{ field_type: 'text', text: 'Camiseta 100% algodão.' }] },
      attributes: [{ attribute_id: 6, attribute_value_list: [{ value_id: 900000 }] }],
      complaint_policy: { warranty_time: 90, extended_consumer_protection: false },
      pre_order: { is_pre_order: false, days_to_ship: 2 },
      item_status: 'NORMAL',
      logistic_info: [{ logistic_id: 1, enabled: true }],
      wholesale: [{ min_count: 3, max_count: 10, unit_price: 19.9 }],
      brand_id: 0,
      item_dangerous: 0,
      violations: null,
    };
    const parsed = produtoShopeeLinkSchema.parse(fixture);
    expect(parsed).toMatchObject({
      item_name: 'Camiseta Básica Azul',
      item_id: 123456789,
      category_id: 100182,
      item_status: 'NORMAL',
      brand_id: 0,
    });
  });

  it('requires a non-empty item_name', () => {
    expect(
      produtoShopeeLinkSchema.safeParse({
        contaProdutoShopeeOuterRef: 'documents/integracao/int1',
        item_name: '',
      }).success,
    ).toBe(false);
    expect(produtoShopeeLinkSchema.safeParse({}).success).toBe(false);
  });

  it('rejects when contaProdutoShopeeOuterRef is missing', () => {
    expect(produtoShopeeLinkSchema.safeParse({ item_name: 'X' }).success).toBe(false);
  });

  it('defaults nullable fields to null when absent', () => {
    const parsed = produtoShopeeLinkSchema.parse({
      contaProdutoShopeeOuterRef: 'documents/integracao/int1',
      item_name: 'X',
    });
    expect(parsed.item_id).toBeNull();
    expect(parsed.category_id).toBeNull();
    expect(parsed.item_status).toBeNull();
    expect(parsed.violations).toBeNull();
  });

  it('aceita os seis valores de wire de item_status', () => {
    for (const valor of [
      'NORMAL',
      'BANNED',
      'UNLIST',
      'REVIEWING',
      'SELLER_DELETE',
      'SHOPEE_DELETE',
    ]) {
      expect(shopeeItemStatusSchema.safeParse(valor).success).toBe(true);
    }
    // e o link doc aceita cada um deles no campo
    for (const valor of Object.values(SHOPEE_ITEM_STATUS)) {
      const parsed = produtoShopeeLinkSchema.parse({
        contaProdutoShopeeOuterRef: 'documents/integracao/int-1',
        item_name: 'X',
        item_status: valor,
      });
      expect(parsed.item_status).toBe(valor);
    }
  });

  it('⛔ NEAR-MISS: recusa DELETED (a grafia pré-2024)', () => {
    // `announcement 769`/`841`: até 2024-01-18 o conjunto era
    // NORMAL|BANNED|UNLIST|DELETED. A grafia antiga fica de fora de propósito.
    expect(shopeeItemStatusSchema.safeParse('DELETED').success).toBe(false);
    expect(shopeeItemStatusSchema.safeParse('SELLER_DELETE').success).toBe(true);
  });

  it('⛔ NEAR-MISS: recusa normal minúsculo e um código que não é de wire', () => {
    expect(shopeeItemStatusSchema.safeParse('normal').success).toBe(false);
    expect(shopeeItemStatusSchema.safeParse('Normal').success).toBe(false);
    expect(shopeeItemStatusSchema.safeParse('ACTIVE').success).toBe(false);
  });

  it('SHOPEE_ITEM_STATUS cobre exatamente os seis membros', () => {
    expect([...Object.values(SHOPEE_ITEM_STATUS)].sort()).toEqual([
      'BANNED',
      'NORMAL',
      'REVIEWING',
      'SELLER_DELETE',
      'SHOPEE_DELETE',
      'UNLIST',
    ]);
    expect([...shopeeItemStatusSchema.options].sort()).toEqual(
      [...Object.values(SHOPEE_ITEM_STATUS)].sort(),
    );
  });

  it('um item_status DELETED armazenado reprova no safeParse do documento inteiro', () => {
    // Registro do comportamento observado (register item 61). `parseSoftRead`
    // (`packages/data/src/zodParse.ts:123-133`) é `safeParse` + `console.warn` +
    // devolver o RAW: com um valor pré-2024 guardado ele NÃO derruba a leitura e
    // NÃO apaga a chave — devolve o documento cru, com o `DELETED` intacto e sem
    // nenhum `.default()` aplicado. Nada do caminho de importação chega aqui (o
    // raw existente é espalhado, nunca reparseado), e a primeira reimportação
    // substitui o valor por um vivo.
    const armazenado = {
      contaProdutoShopeeOuterRef: 'documents/integracao/int-1',
      item_name: 'X',
      item_status: 'DELETED',
    };
    const resultado = produtoShopeeLinkSchema.safeParse(armazenado);
    expect(resultado.success).toBe(false);
    if (resultado.success) throw new Error('esperava falha');
    expect(resultado.error.issues.some((i) => i.path.join('.') === 'item_status')).toBe(true);
    // o que `parseSoftRead` devolveria: o raw, sem tocar na chave
    expect(armazenado.item_status).toBe('DELETED');
  });

  it('parses the banned-item push violations shape and typed extra keys pass through', () => {
    const parsed = produtoShopeeLinkSchema.parse({
      contaProdutoShopeeOuterRef: 'documents/integracao/int1',
      item_name: 'X',
      item_status: 'UNLIST',
      violations: [
        {
          days_to_fix: 7,
          suggestion: 'Remove counterfeit claim',
          violation_reason: 'IP infringement',
          violation_type: 'listing',
          // unknown extra key on the nested violation object
          reference_id: 'abc-123',
        },
      ],
    });
    expect(parsed.violations?.[0]).toMatchObject({
      days_to_fix: 7,
      violation_type: 'listing',
    });
    expect((parsed.violations?.[0] as Record<string, unknown>).reference_id).toBe('abc-123');
  });

  it('preserves unknown top-level fields (pass-through)', () => {
    const parsed = produtoShopeeLinkSchema.parse({
      contaProdutoShopeeOuterRef: 'documents/integracao/int1',
      item_name: 'X',
      _futureShopeeField: 'whatever',
    });
    expect((parsed as Record<string, unknown>)._futureShopeeField).toBe('whatever');
  });
});

describe('variacaoShopeeLinkSchema', () => {
  it('parses a legacy-shaped VariacaoShopee fixture doc', () => {
    const parsed = variacaoShopeeLinkSchema.parse({
      contaVariacaoShopeeOuterRef: 'documents/integracao/int1',
      produtoShopeeOuterRef: 'documents/produtos/p1/prodshopee/l1',
      model_id: 987654,
      tier_index: [0, 1],
      promotion_id: 555,
      model_status: 'MODEL_NORMAL',
    });
    expect(parsed).toMatchObject({
      model_id: 987654,
      tier_index: [0, 1],
      promotion_id: 555,
      model_status: 'MODEL_NORMAL',
    });
  });

  it('requires model_id and defaults tier_index to an empty array', () => {
    expect(variacaoShopeeLinkSchema.safeParse({}).success).toBe(false);
    const parsed = variacaoShopeeLinkSchema.parse({
      contaVariacaoShopeeOuterRef: 'documents/integracao/int1',
      produtoShopeeOuterRef: 'documents/produtos/p1/prodshopee/l1',
      model_id: 1,
    });
    expect(parsed.tier_index).toEqual([]);
    expect(parsed.promotion_id).toBeNull();
    expect(parsed.model_status).toBeNull();
  });

  it('rejects when contaVariacaoShopeeOuterRef or produtoShopeeOuterRef is missing', () => {
    expect(variacaoShopeeLinkSchema.safeParse({ model_id: 1 }).success).toBe(false);
    expect(
      variacaoShopeeLinkSchema.safeParse({
        model_id: 1,
        contaVariacaoShopeeOuterRef: 'documents/integracao/int1',
      }).success,
    ).toBe(false);
    expect(
      variacaoShopeeLinkSchema.safeParse({
        model_id: 1,
        produtoShopeeOuterRef: 'documents/produtos/p1/prodshopee/l1',
      }).success,
    ).toBe(false);
  });

  it('accepts only the two model_status wire codes', () => {
    expect(shopeeModelStatusSchema.safeParse('MODEL_NORMAL').success).toBe(true);
    expect(shopeeModelStatusSchema.safeParse('MODEL_UNAVAILABLE').success).toBe(true);
    expect(shopeeModelStatusSchema.safeParse('NORMAL').success).toBe(false);
  });

  it('preserves unknown extra keys (pass-through)', () => {
    const parsed = variacaoShopeeLinkSchema.parse({
      contaVariacaoShopeeOuterRef: 'documents/integracao/int1',
      produtoShopeeOuterRef: 'documents/produtos/p1/prodshopee/l1',
      model_id: 1,
      _customField: 'x',
    });
    expect((parsed as Record<string, unknown>)._customField).toBe('x');
  });
});

// ===========================================================================
// Passo 11 (#1519) — o ciclo de vida do anúncio
// ===========================================================================

describe('estadoAnuncioShopeeSchema', () => {
  it('tem exatamente sete membros, e ESTADO_ANUNCIO_SHOPEE os nomeia todos', () => {
    expect([...estadoAnuncioShopeeSchema.options].sort()).toEqual(
      ['ativo', 'agendado', 'banido', 'desconhecido', 'em_revisao', 'pausado', 'removido'].sort(),
    );
    // O companheiro cobre TODOS os membros: um estado que o fold produz e a
    // constante esqueceu (ou o contrário) reprova aqui.
    expect([...Object.values(ESTADO_ANUNCIO_SHOPEE)].sort()).toEqual(
      [...estadoAnuncioShopeeSchema.options].sort(),
    );
    expect(Object.keys(ESTADO_ANUNCIO_SHOPEE)).toHaveLength(
      estadoAnuncioShopeeSchema.options.length,
    );
  });

  it('⛔ NEAR-MISS: um item_status de WIRE não é um estadoAnuncio', () => {
    // Os dois vocabulários vivem no mesmo arquivo e NÃO se misturam: um é a
    // resposta da Shopee, o outro é o que este app decide que ela significa.
    for (const wire of Object.values(SHOPEE_ITEM_STATUS)) {
      expect(estadoAnuncioShopeeSchema.safeParse(wire).success).toBe(false);
    }
    expect(estadoAnuncioShopeeSchema.safeParse('Ativo').success).toBe(false);
    expect(estadoAnuncioShopeeSchema.safeParse('em revisao').success).toBe(false);
    expect(estadoAnuncioShopeeSchema.safeParse('emRevisao').success).toBe(false);
    expect(estadoAnuncioShopeeSchema.safeParse('ativo').success).toBe(true);
  });
});

describe('shopeeViolacaoSchema', () => {
  const MODERNA = {
    violation_type: 'PROHIBITED_ITEM',
    violation_reason: 'Produto proibido para esta categoria',
    suggestion: 'Ajuste a categoria e reenvie o anúncio',
    fix_deadline_time: 1_757_000_000_000,
    update_time: 1_756_000_000_000,
    suggested_category: [{ category_id: 100182, category_name: 'Camisetas' }],
    kind: 'status' as const,
  };
  const LEGADA = {
    days_to_fix: 7,
    suggestion: 'Remove counterfeit claim',
    violation_reason: 'IP infringement',
    violation_type: 'listing',
  };

  it('PAR: o corpo LEGADO e o MODERNO fazem parse no MESMO array de violations', () => {
    const parsed = produtoShopeeLinkSchema.parse({
      contaProdutoShopeeOuterRef: CONTA_REF,
      item_name: 'X',
      violations: [LEGADA, MODERNA],
    });
    expect(parsed.violations).toHaveLength(2);
    // O legado continua legível — nenhuma chave some.
    expect(parsed.violations?.[0]).toMatchObject({
      days_to_fix: 7,
      violation_reason: 'IP infringement',
    });
    expect(parsed.violations?.[1]).toMatchObject({
      violation_type: 'PROHIBITED_ITEM',
      fix_deadline_time: 1_757_000_000_000,
      kind: 'status',
    });
    // ⚠️ O ELEMENTO do campo é o moderno, não o legado com `.passthrough()` por
    // cima: um elemento legado atravessa o schema antigo com as chaves modernas
    // AUSENTES (`undefined`), enquanto aqui elas chegam `null` por default. É o
    // que distingue "o campo foi trocado" de "as chaves só passaram batido".
    expect(parsed.violations?.[0]?.fix_deadline_time).toBeNull();
    expect(parsed.violations?.[0]?.kind).toBeNull();
    expect(parsed.violations?.[0]?.suggested_category).toBeNull();
  });

  it('⛔ NEAR-MISS: fix_deadline_time NÃO é derivado de days_to_fix, nem o contrário', () => {
    // Mutante M-39. A conversão precisa de um relógio, perde o valor original e
    // não é idempotente — o mesmo push relido amanhã daria outro número.
    const soLegado = shopeeViolacaoSchema.parse({ days_to_fix: 10 });
    expect(soLegado.days_to_fix).toBe(10);
    expect(soLegado.fix_deadline_time).toBeNull();
    expect(soLegado.update_time).toBeNull();
    expect(soLegado.kind).toBeNull();
    expect(soLegado.suggested_category).toBeNull();

    const soModerno = shopeeViolacaoSchema.parse({ fix_deadline_time: 1_757_000_000_000 });
    expect(soModerno.fix_deadline_time).toBe(1_757_000_000_000);
    expect(soModerno.days_to_fix).toBeNull();
  });

  it('suggested_category sobrevive com category_id e category_name', () => {
    const parsed = shopeeViolacaoSchema.parse({
      kind: 'deboost',
      suggested_category: [
        { category_id: 100182, category_name: 'Camisetas' },
        { category_id: 100183 },
      ],
    });
    expect(parsed.suggested_category?.[0]).toEqual({
      category_id: 100182,
      category_name: 'Camisetas',
    });
    // Metade do par também passa: o nome ausente entra null, nunca undefined.
    expect(parsed.suggested_category?.[1]).toEqual({ category_id: 100183, category_name: null });
  });

  it('kind distingue uma violação de STATUS de um DEBOOST no mesmo array', () => {
    const parsed = produtoShopeeLinkSchema.parse({
      contaProdutoShopeeOuterRef: CONTA_REF,
      item_name: 'X',
      violations: [
        { ...MODERNA, kind: 'status' },
        { ...MODERNA, kind: 'deboost' },
      ],
    });
    expect(parsed.violations?.map((v) => v.kind)).toEqual(['status', 'deboost']);
  });

  it('⛔ NEAR-MISS: kind aceita só status e deboost — e uma linha legada fica null', () => {
    expect(shopeeViolacaoSchema.safeParse({ kind: 'STATUS' }).success).toBe(false);
    expect(shopeeViolacaoSchema.safeParse({ kind: 'item_status' }).success).toBe(false);
    expect(shopeeViolacaoSchema.parse(LEGADA).kind).toBeNull();
  });

  it('uma chave extra sobrevive NO elemento E na categoria sugerida (pass-through)', () => {
    const parsed = shopeeViolacaoSchema.parse({
      ...MODERNA,
      reference_id: 'abc-123',
      suggested_category: [{ category_id: 1, category_name: 'A', display_name: 'A > B' }],
    });
    expect((parsed as Record<string, unknown>).reference_id).toBe('abc-123');
    expect(
      (parsed.suggested_category?.[0] as Record<string, unknown> | undefined)?.display_name,
    ).toBe('A > B');
  });

  it('o alias deprecado ainda parseia o corpo legado, e o novo parseia tudo que ele parseava', () => {
    // A troca de elemento (C22) só não é quebra porque as quatro chaves antigas
    // são um SUBCONJUNTO das novas.
    const peloAntigo = shopeeViolationReasonWireSchema.parse(LEGADA);
    const peloNovo = shopeeViolacaoSchema.parse(LEGADA) as Record<string, unknown>;
    for (const [chave, valor] of Object.entries(peloAntigo)) {
      expect(peloNovo[chave]).toEqual(valor);
    }
  });
});

describe('produtoShopeeLinkSchema — os onze campos do passo 11', () => {
  const NOVOS = [
    'estadoAnuncio',
    'deboost',
    'pausadoPeloErp',
    'condition',
    'original_brand_name',
    'publicadoEm',
    'ultimaPublicacao',
    'falhaPublicacao',
    'taxInfoOmitido',
    'violacoesLidasEm',
    'agendamentoFalhouEm',
  ] as const;

  it('um link do passo 9, sem nenhum campo novo, continua a fazer parse — e cada um entra null', () => {
    const migrado = {
      contaProdutoShopeeOuterRef: CONTA_REF,
      item_name: 'Camiseta Básica Azul',
      item_id: ITEM_ID,
      item_status: 'NORMAL',
      violations: null,
    };
    const parsed = produtoShopeeLinkSchema.parse(migrado) as Record<string, unknown>;
    expect(NOVOS).toHaveLength(11);
    for (const campo of NOVOS) {
      expect(parsed).toHaveProperty(campo);
      expect(parsed[campo]).toBeNull();
      // `undefined` seria rejeitado pelo SDK do Firebase num addDoc/setDoc.
      expect(parsed[campo]).not.toBeUndefined();
    }
  });

  it('um documento MODERNO completo faz round-trip', () => {
    const doc = {
      contaProdutoShopeeOuterRef: CONTA_REF,
      item_name: 'Camiseta Básica Azul',
      item_id: ITEM_ID,
      category_id: 100182,
      item_status: 'NORMAL',
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      deboost: true,
      pausadoPeloErp: false,
      condition: 'NEW',
      original_brand_name: 'No Brand',
      publicadoEm: 1_755_000_000_000,
      ultimaPublicacao: { em: 1_756_000_000_000, etapa: 'update_item', itemId: ITEM_ID },
      falhaPublicacao: null,
      taxInfoOmitido: 'recusado-incompleto',
      violacoesLidasEm: 1_756_500_000_000,
      agendamentoFalhouEm: null,
    };
    const parsed = produtoShopeeLinkSchema.parse(doc);
    expect(parsed).toMatchObject(doc);
    // ⚠️ `NORMAL` + deboost continua ATIVO: os dois campos são ortogonais e o
    // documento guarda os dois.
    expect(parsed.estadoAnuncio).toBe('ativo');
    expect(parsed.deboost).toBe(true);
  });

  it('falhaPublicacao guarda os problemas classificados, com problemas default []', () => {
    const parsed = produtoShopeeLinkSchema.parse({
      contaProdutoShopeeOuterRef: CONTA_REF,
      item_name: 'X',
      falhaPublicacao: {
        em: 1_756_000_000_000,
        etapa: 'add_item',
        erro: 'ShopeePublishRejectedError',
        mensagem: 'A Shopee recusou o anúncio.',
        problemas: [{ campo: 'weight', motivo: 'sem-peso', mensagem: 'Informe o peso bruto.' }],
      },
    });
    expect(parsed.falhaPublicacao?.problemas).toHaveLength(1);
    expect(parsed.falhaPublicacao?.problemas[0]).toMatchObject({ motivo: 'sem-peso' });

    const semProblemas = produtoShopeeLinkSchema.parse({
      contaProdutoShopeeOuterRef: CONTA_REF,
      item_name: 'X',
      falhaPublicacao: {
        em: 1_756_000_000_000,
        etapa: 'upload_image',
        erro: 'ShopeeApiError',
        mensagem: 'Falha ao subir as fotos.',
      },
    });
    expect(semProblemas.falhaPublicacao?.problemas).toEqual([]);
  });

  it('uma chave extra sobrevive DENTRO de ultimaPublicacao, falhaPublicacao e seus problemas', () => {
    const parsed = produtoShopeeLinkSchema.parse({
      contaProdutoShopeeOuterRef: CONTA_REF,
      item_name: 'X',
      ultimaPublicacao: { em: 1, etapa: 'add_item', itemId: ITEM_ID, tentativas: 2 },
      falhaPublicacao: {
        em: 2,
        etapa: 'add_item',
        erro: 'E',
        mensagem: 'M',
        problemas: [{ campo: 'c', motivo: 'm', mensagem: 'x', wire: 'error_param' }],
        requestId: 'req-1',
      },
    });
    expect((parsed.ultimaPublicacao as Record<string, unknown>).tentativas).toBe(2);
    expect((parsed.falhaPublicacao as Record<string, unknown>).requestId).toBe('req-1');
    expect(
      (parsed.falhaPublicacao?.problemas[0] as Record<string, unknown> | undefined)?.wire,
    ).toBe('error_param');
    // `itemId` ausente entra null — o bloco é gravado antes de existir item_id.
    expect(
      produtoShopeeLinkSchema.parse({
        contaProdutoShopeeOuterRef: CONTA_REF,
        item_name: 'X',
        ultimaPublicacao: { em: 1, etapa: 'add_item' },
      }).ultimaPublicacao?.itemId,
    ).toBeNull();
  });

  it('⛔ NEAR-MISS: um bloco aninhado sem "em" reprova — é escrito inteiro ou não é escrito', () => {
    expect(
      produtoShopeeLinkSchema.safeParse({
        contaProdutoShopeeOuterRef: CONTA_REF,
        item_name: 'X',
        ultimaPublicacao: { etapa: 'add_item', itemId: ITEM_ID },
      }).success,
    ).toBe(false);
    expect(
      produtoShopeeLinkSchema.safeParse({
        contaProdutoShopeeOuterRef: CONTA_REF,
        item_name: 'X',
        falhaPublicacao: { em: 1, etapa: 'add_item', erro: 'E' },
      }).success,
    ).toBe(false);
  });

  it('estadoAnuncio no documento aceita os sete membros e recusa um item_status', () => {
    for (const estado of Object.values(ESTADO_ANUNCIO_SHOPEE)) {
      expect(
        produtoShopeeLinkSchema.parse({
          contaProdutoShopeeOuterRef: CONTA_REF,
          item_name: 'X',
          estadoAnuncio: estado,
        }).estadoAnuncio,
      ).toBe(estado);
    }
    expect(
      produtoShopeeLinkSchema.safeParse({
        contaProdutoShopeeOuterRef: CONTA_REF,
        item_name: 'X',
        estadoAnuncio: 'UNLIST',
      }).success,
    ).toBe(false);
  });
});

describe('variacaoShopeeLinkSchema — modeloAusenteEm', () => {
  it('entra null num link antigo e guarda um carimbo em MILISSEGUNDOS quando marcado', () => {
    const base = {
      contaVariacaoShopeeOuterRef: CONTA_REF,
      produtoShopeeOuterRef: 'documents/produtos/p1/prodshopee/l1',
      model_id: MODEL_ID,
    };
    expect(variacaoShopeeLinkSchema.parse(base).modeloAusenteEm).toBeNull();
    const marcado = variacaoShopeeLinkSchema.parse({
      ...base,
      model_status: 'MODEL_UNAVAILABLE',
      modeloAusenteEm: 1_756_000_000_000,
    });
    expect(marcado.modeloAusenteEm).toBe(1_756_000_000_000);
    // O doc filho CONTINUA existindo — a marca é o oposto de um delete.
    expect(marcado.model_id).toBe(MODEL_ID);
  });
});

describe('produtoShopeeLinkSchema — os onze campos do passo 12 (estoque)', () => {
  const NOVOS_12 = [
    'kitNativo',
    'estoqueEnviadoEm',
    'estoqueEnviado',
    'estoqueModelosEnviados',
    'estoqueRecusaEm',
    'estoqueRecusaCodigo',
    'estoqueRecusaMotivo',
    'estoqueRecusaMensagem',
    'estoqueRecusaEstado',
    'estoqueRecusaItemStatus',
    'estoqueRecusaAte',
  ] as const;

  const LINK_ANTIGO = {
    contaProdutoShopeeOuterRef: CONTA_REF,
    item_name: 'Camiseta Básica Azul',
    item_id: ITEM_ID,
    item_status: 'NORMAL',
  };

  it('um link anterior ao passo 12 continua a fazer parse — e cada campo novo entra null', () => {
    const parsed = produtoShopeeLinkSchema.parse(LINK_ANTIGO) as Record<string, unknown>;
    expect(NOVOS_12).toHaveLength(11);
    for (const campo of NOVOS_12) {
      expect(parsed).toHaveProperty(campo);
      expect(parsed[campo]).toBeNull();
      // `undefined` seria rejeitado pelo SDK do Firebase num addDoc/setDoc.
      expect(parsed[campo]).not.toBeUndefined();
    }
  });

  it('um envio LIMPO faz round-trip: carimbo, quantidades e nenhuma recusa', () => {
    const doc = {
      ...LINK_ANTIGO,
      kitNativo: false,
      estoqueEnviadoEm: 1_758_000_900_000,
      estoqueEnviado: 12,
      estoqueModelosEnviados: 3,
      estoqueRecusaEm: null,
      estoqueRecusaCodigo: null,
      estoqueRecusaMotivo: null,
      estoqueRecusaMensagem: null,
      estoqueRecusaEstado: null,
      estoqueRecusaItemStatus: null,
      estoqueRecusaAte: null,
    };
    expect(produtoShopeeLinkSchema.parse(doc)).toMatchObject(doc);
  });

  it('uma RECUSA faz round-trip com a impressão digital inteira e o código VERBATIM', () => {
    const doc = {
      ...LINK_ANTIGO,
      estoqueRecusaEm: 1_758_000_900_000,
      // ⚠️ VERBATIM: o prefixo faz parte do que a Shopee respondeu.
      estoqueRecusaCodigo: 'product.error_busi_update_stock_failed',
      estoqueRecusaMotivo: 'anuncio-banido',
      estoqueRecusaMensagem: 'A Shopee recusou o envio de estoque deste anúncio.',
      estoqueRecusaEstado: 'banido',
      estoqueRecusaItemStatus: 'BANNED',
      estoqueRecusaAte: null,
    };
    const parsed = produtoShopeeLinkSchema.parse(doc);
    expect(parsed).toMatchObject(doc);
    // O prefixo sobrevive — nada reescreve o código no lado da escrita.
    expect(parsed.estoqueRecusaCodigo).toContain('product.');
  });

  it('um bloqueio por promoção guarda o lado TEMPORAL do pulo, sem impressão digital', () => {
    // Uma promoção terminando não move `item_status`, então a impressão digital
    // latiria para sempre — por isso este braço usa `estoqueRecusaAte`.
    const parsed = produtoShopeeLinkSchema.parse({
      ...LINK_ANTIGO,
      estoqueRecusaEm: 1_758_000_900_000,
      estoqueRecusaMotivo: 'bloqueado-por-promocao',
      estoqueRecusaAte: 1_758_004_500_000,
    });
    expect(parsed.estoqueRecusaAte).toBe(1_758_004_500_000);
    expect(parsed.estoqueRecusaEstado).toBeNull();
    expect(parsed.estoqueRecusaItemStatus).toBeNull();
  });

  it('✅ kitNativo aceita true, false e null — os três são leituras distintas', () => {
    for (const valor of [true, false, null]) {
      const parsed = produtoShopeeLinkSchema.parse({ ...LINK_ANTIGO, kitNativo: valor });
      expect(parsed.kitNativo).toBe(valor);
    }
    // ⚠️ `null` (um link anterior ao passo 12) NÃO é `false` no papel, mas ambos
    // ENVIAM: só `true` recusa. A assimetria é deliberada — um falso positivo
    // custa uma linha pulada, um falso negativo é apagão de estoque silencioso
    // no catálogo legado inteiro de kits do ERP.
    expect(produtoShopeeLinkSchema.parse(LINK_ANTIGO).kitNativo).toBeNull();
  });

  it('⛔ NEAR-MISS: kitNativo recusa uma string — é três-valorado, nunca um slug', () => {
    for (const valor of ['true', 'kit', '1', 1]) {
      expect(produtoShopeeLinkSchema.safeParse({ ...LINK_ANTIGO, kitNativo: valor }).success).toBe(
        false,
      );
    }
  });

  it('estoqueRecusaEstado e estoqueRecusaItemStatus são strings SOLTAS, não os enums', () => {
    // São LEITURAS gravadas para comparar contra si mesmas, não estados a agir.
    // Um valor que este app deixe de reconhecer ainda tem de comparar igual.
    const parsed = produtoShopeeLinkSchema.parse({
      ...LINK_ANTIGO,
      estoqueRecusaEstado: 'um_estado_que_ainda_nao_existe',
      estoqueRecusaItemStatus: 'DELETED',
    });
    expect(parsed.estoqueRecusaEstado).toBe('um_estado_que_ainda_nao_existe');
    // `DELETED` é a grafia pré-2024 que `shopeeItemStatusSchema` recusa — e que
    // um corpus migrado ainda guarda. Como impressão digital ela tem de passar.
    expect(parsed.estoqueRecusaItemStatus).toBe('DELETED');
    expect(shopeeItemStatusSchema.safeParse('DELETED').success).toBe(false);
  });
});

describe('variacaoShopeeLinkSchema — os dois campos do passo 12', () => {
  const BASE_FILHO = {
    contaVariacaoShopeeOuterRef: CONTA_REF,
    produtoShopeeOuterRef: 'documents/produtos/p1/prodshopee/l1',
    model_id: MODEL_ID,
  };

  it('entram null num link antigo e guardam a recusa por MODELO quando escritos', () => {
    const antigo = variacaoShopeeLinkSchema.parse(BASE_FILHO);
    expect(antigo.estoqueRecusaEm).toBeNull();
    expect(antigo.estoqueRecusaCodigo).toBeNull();

    const recusado = variacaoShopeeLinkSchema.parse({
      ...BASE_FILHO,
      estoqueRecusaEm: 1_758_000_900_000,
      estoqueRecusaCodigo: 'product.error_busi_model_stock_invalid',
    });
    expect(recusado.estoqueRecusaEm).toBe(1_758_000_900_000);
    // VERBATIM, prefixo e tudo — igual ao campo do pai.
    expect(recusado.estoqueRecusaCodigo).toBe('product.error_busi_model_stock_invalid');
    // O doc filho continua existindo: a linha é diagnóstica, nunca um delete.
    expect(recusado.model_id).toBe(MODEL_ID);
  });
});

describe('podeMoverAnuncioShopee', () => {
  type Caso = {
    acao: AcaoStatusAnuncio;
    estado: EstadoAnuncioShopee | null;
    itemId: number | null;
    esperado: true | MotivoAnuncioNaoMovivel;
  };

  const PAUSAR = ACAO_STATUS_ANUNCIO.pausar;
  const REATIVAR = ACAO_STATUS_ANUNCIO.reativar;
  const E = ESTADO_ANUNCIO_SHOPEE;

  const TABELA: Caso[] = [
    // pausar
    { acao: PAUSAR, estado: E.ativo, itemId: null, esperado: 'sem-item-id' },
    { acao: PAUSAR, estado: E.ativo, itemId: 0, esperado: 'sem-item-id' },
    { acao: PAUSAR, estado: E.removido, itemId: ITEM_ID, esperado: 'anuncio-removido' },
    { acao: PAUSAR, estado: E.banido, itemId: ITEM_ID, esperado: 'anuncio-banido' },
    { acao: PAUSAR, estado: E.emRevisao, itemId: ITEM_ID, esperado: 'anuncio-em-revisao' },
    { acao: PAUSAR, estado: E.pausado, itemId: ITEM_ID, esperado: 'ja-pausado' },
    { acao: PAUSAR, estado: E.ativo, itemId: ITEM_ID, esperado: true },
    // ⚠️ pausar um AGENDADO é permitido: é o operador cancelando o agendamento.
    { acao: PAUSAR, estado: E.agendado, itemId: ITEM_ID, esperado: true },
    { acao: PAUSAR, estado: E.desconhecido, itemId: ITEM_ID, esperado: true },
    { acao: PAUSAR, estado: null, itemId: ITEM_ID, esperado: true },
    // reativar
    { acao: REATIVAR, estado: E.pausado, itemId: null, esperado: 'sem-item-id' },
    { acao: REATIVAR, estado: E.removido, itemId: ITEM_ID, esperado: 'anuncio-removido' },
    { acao: REATIVAR, estado: E.banido, itemId: ITEM_ID, esperado: 'anuncio-banido' },
    { acao: REATIVAR, estado: E.emRevisao, itemId: ITEM_ID, esperado: 'anuncio-em-revisao' },
    { acao: REATIVAR, estado: E.agendado, itemId: ITEM_ID, esperado: 'anuncio-agendado' },
    { acao: REATIVAR, estado: E.ativo, itemId: ITEM_ID, esperado: 'ja-ativo' },
    { acao: REATIVAR, estado: E.pausado, itemId: ITEM_ID, esperado: true },
    { acao: REATIVAR, estado: E.desconhecido, itemId: ITEM_ID, esperado: true },
    { acao: REATIVAR, estado: null, itemId: ITEM_ID, esperado: true },
  ];

  it.each(TABELA)('$acao + estado $estado + item_id $itemId ⇒ $esperado', (caso) => {
    const resultado = podeMoverAnuncioShopee(
      { item_id: caso.itemId, estadoAnuncio: caso.estado },
      caso.acao,
    );
    if (caso.esperado === true) {
      expect(resultado).toEqual({ pode: true });
    } else {
      expect(resultado).toEqual({ pode: false, motivo: caso.esperado });
    }
  });

  it('a tabela cobre as DUAS ações × os OITO estados possíveis (os sete membros + null)', () => {
    const cobertos = new Set(
      TABELA.filter((c) => c.itemId === ITEM_ID).map((c) => `${c.acao}/${String(c.estado)}`),
    );
    const esperados = new Set<string>();
    for (const acao of Object.values(ACAO_STATUS_ANUNCIO)) {
      for (const estado of [...estadoAnuncioShopeeSchema.options, null]) {
        esperados.add(`${acao}/${String(estado)}`);
      }
    }
    expect([...cobertos].sort()).toEqual([...esperados].sort());
    expect(esperados.size).toBe(16);
  });

  it('as SETE recusas têm todas um produtor — nenhuma é vocabulário morto', () => {
    const produzidos = new Set(
      TABELA.map((caso) =>
        podeMoverAnuncioShopee({ item_id: caso.itemId, estadoAnuncio: caso.estado }, caso.acao),
      )
        .filter((r): r is { pode: false; motivo: MotivoAnuncioNaoMovivel } => r.pode === false)
        .map((r) => r.motivo),
    );
    expect([...produzidos].sort()).toEqual(
      [
        'anuncio-agendado',
        'anuncio-banido',
        'anuncio-em-revisao',
        'anuncio-removido',
        'ja-ativo',
        'ja-pausado',
        'sem-item-id',
      ].sort(),
    );
  });

  it('⛔ NEAR-MISS: estadoAnuncio null NÃO é recusado; removido É', () => {
    // Um link importado pelo passo 9 nunca foi dobrado — a leitura ausente não é
    // prova de nada, e recusá-la mataria o botão para o corpus inteiro.
    expect(podeMoverAnuncioShopee({ item_id: ITEM_ID, estadoAnuncio: null }, PAUSAR)).toEqual({
      pode: true,
    });
    expect(podeMoverAnuncioShopee({ item_id: ITEM_ID, estadoAnuncio: null }, REATIVAR)).toEqual({
      pode: true,
    });
    expect(podeMoverAnuncioShopee({ item_id: ITEM_ID, estadoAnuncio: E.removido }, PAUSAR)).toEqual(
      {
        pode: false,
        motivo: 'anuncio-removido',
      },
    );
  });

  it('⛔ NEAR-MISS: um item_id 0, negativo ou não finito é sem-item-id — nunca endereçável', () => {
    for (const itemId of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(podeMoverAnuncioShopee({ item_id: itemId, estadoAnuncio: E.ativo }, PAUSAR)).toEqual({
        pode: false,
        motivo: 'sem-item-id',
      });
    }
    expect(podeMoverAnuncioShopee({ item_id: 1, estadoAnuncio: E.ativo }, PAUSAR)).toEqual({
      pode: true,
    });
  });
});

describe('shopeeLink.ts — o texto do arquivo', () => {
  const FONTE = readFileSync(join(import.meta.dirname, 'shopeeLink.ts'), 'utf8');

  it('não menciona runTransaction nem nenhum helper de microssegundos', () => {
    // Este arquivo é puro: nenhuma transação, nenhum relógio, e todo carimbo é
    // MILISSEGUNDO. O inventário de transações (`config-eslint`) grepa TEXTO
    // CRU, inclusive comentários — e uma comparação entre unidades diferentes é
    // uma guarda que nunca dispara (regra 7 do CLAUDE.md da raiz).
    for (const proibido of [
      'runTransaction',
      'coerceToMicros',
      'millisToMicros',
      'microsToMillis',
      'microsDeSegundos',
      'prazoUsDe',
      'nowUs',
      'Date.now(',
      'µs',
    ]) {
      expect(FONTE).not.toContain(proibido);
    }
    expect(FONTE).toContain('MILLISECONDS');
  });

  it('o inventário de escritores do cabeçalho continua exato depois do passo 12', () => {
    // A frase é a única coisa que diz a quem lê o arquivo quantos escritores
    // cada grupo tem. Ela já esteve errada duas vezes (o docblock de
    // `item_status` chamou o campo de push-only, depois disse DOIS escritores),
    // e um comentário que afirma o que OUTRO módulo faz é exatamente o cheiro
    // do #1369 — por isso está presa aqui.
    expect(FONTE).toContain('## The writer inventory, whole');
    // Os quatro escritores de `item_status` continuam QUATRO: o remetente de
    // estoque lê o campo para a impressão digital e nunca o escreve.
    expect(FONTE).toContain('⚠️ FOUR writers now');
    expect(FONTE).toContain('STILL FOUR after step 12');
    // Os dez escalares de estoque têm UM escritor, e `kitNativo` tem UM.
    expect(FONTE).toContain('**the ten `estoque*` scalars** (step 12) — **ONE** writer');
    expect(FONTE).toContain('**`kitNativo`** (step 12) — **ONE** writer');
    // E a regra do conjunto de pulo é documentada aqui mas calculada no app.
    expect(FONTE).toMatch(/is READ by the app[\s*]+\(`podeEnviarEstoqueShopee`\)/);
    expect(FONTE).toMatch(/never[\s*]+computed in this schema/);
  });

  it('a fórmula do conjunto de pulo no docblock traz a GUARDA das duas metades nulas e a dobra dos dois lados', () => {
    // A revisão do PR #1623 achou este docblock descrevendo o predicado de
    // ANTES da decisão B: sem a guarda "pelo menos uma leitura gravada" e sem
    // `ouNulo` — lido ao pé da letra, um carimbo null/null contra leituras
    // ausentes travava o anúncio para sempre, que é exatamente o defeito que
    // foi corrigido, documentado como o comportamento. O código é a regra
    // (`pularPorRecusaAnterior`); isto prende só que o TEXTO não volte atrás.
    expect(FONTE).toContain("typeof estoqueRecusaEm === 'number'");
    expect(FONTE).toContain("typeof estoqueRecusaAte === 'number' && nowMs < estoqueRecusaAte");
    expect(FONTE).toMatch(
      /ouNulo\(estoqueRecusaEstado\) !== null\s*\*\s*\|\| ouNulo\(estoqueRecusaItemStatus\) !== null\)/,
    );
    expect(FONTE).toContain('ouNulo(estoqueRecusaEstado)     === ouNulo(link.estadoAnuncio)');
    expect(FONTE).toContain('ouNulo(estoqueRecusaItemStatus) === ouNulo(link.item_status)');
    expect(FONTE).toContain('apps/shopee/lib/shopee/estoque/podeEnviarEstoque.ts');
    // O NEAR-MISS: a fórmula antiga, sem a dobra, não pode sobreviver.
    expect(FONTE).not.toContain('estoqueRecusaEstado     === link.estadoAnuncio');
    expect(FONTE).not.toContain('estoqueRecusaEm  != null');
  });

  it('o docblock não chama o code 6 de push moderno', () => {
    // A correção é barata de escrever e barata de perder: sem isto, a próxima
    // revisão do docblock volta a apontar o leitor para um push aposentado.
    expect(FONTE).toContain('push_api_id` 18');
    expect(FONTE).toContain('push_code 16');
    const mencoes = [...FONTE.matchAll(/code[ -]6/gi)];
    expect(mencoes.length).toBeGreaterThan(0);
    for (const mencao of mencoes) {
      const inicio = Math.max(0, (mencao.index ?? 0) - 200);
      const janela = FONTE.slice(inicio, (mencao.index ?? 0) + 200);
      expect(janela).toMatch(/retired|retirad|aposentad|legacy|legad/i);
    }
  });
});

// ===========================================================================
// Passo 13 (#1521) — os dez escalares `preco*` (seis no item, quatro no modelo)
// ===========================================================================

describe('os dez campos preco* do passo 13', () => {
  const NOVOS_13_ITEM = [
    'precoEnviado',
    'precoEnviadoEm',
    'precoRecusaEm',
    'precoRecusaCodigo',
    'precoRecusaMotivo',
    'precoRecusaMensagem',
  ] as const;
  const NOVOS_13_MODELO = [
    'precoEnviado',
    'precoEnviadoEm',
    'precoRecusaEm',
    'precoRecusaCodigo',
  ] as const;

  const LINK_ANTIGO = {
    contaProdutoShopeeOuterRef: CONTA_REF,
    item_name: 'Camiseta Básica Azul',
    item_id: ITEM_ID,
    item_status: 'NORMAL',
  };
  const FILHO_ANTIGO = {
    contaVariacaoShopeeOuterRef: CONTA_REF,
    produtoShopeeOuterRef: 'documents/produtos/p1/prodshopee/l1',
    model_id: MODEL_ID,
  };

  /** As chaves `preco*` que o schema DECLARA — o `.shape`, não um parse. */
  const chavesPreco = (shape: Record<string, unknown>) =>
    Object.keys(shape)
      .filter((k) => k.startsWith('preco'))
      .sort();

  it('PAR: um link anterior ao passo 13 faz parse e cada campo AUSENTE entra null (item e modelo)', () => {
    const item = produtoShopeeLinkSchema.parse(LINK_ANTIGO) as Record<string, unknown>;
    expect(NOVOS_13_ITEM).toHaveLength(6);
    for (const campo of NOVOS_13_ITEM) {
      expect(item).toHaveProperty(campo);
      expect(item[campo]).toBeNull();
      // `undefined` seria rejeitado pelo SDK do Firebase num addDoc/setDoc.
      expect(item[campo]).not.toBeUndefined();
    }
    const modelo = variacaoShopeeLinkSchema.parse(FILHO_ANTIGO) as Record<string, unknown>;
    expect(NOVOS_13_MODELO).toHaveLength(4);
    for (const campo of NOVOS_13_MODELO) {
      expect(modelo).toHaveProperty(campo);
      expect(modelo[campo]).toBeNull();
      expect(modelo[campo]).not.toBeUndefined();
    }
  });

  it('⛔ NEAR-MISS: um valor PRESENTE sobrevive inalterado — o default só preenche o ausente', () => {
    // Um `.default(null)` trocado por `.catch(null)` ou um transform que zere o
    // campo passaria o teste do ausente; este é o que o separa.
    const item = produtoShopeeLinkSchema.parse({
      ...LINK_ANTIGO,
      precoEnviado: 49.9,
      precoEnviadoEm: 1_758_000_900_000,
      precoRecusaEm: 1_758_000_800_000,
      precoRecusaCodigo: 'product.error_busi_update_price_failed',
      precoRecusaMotivo: 'recusa-desconhecida',
      precoRecusaMensagem: 'A Shopee recusou o preço deste anúncio.',
    });
    expect(item.precoEnviado).toBe(49.9);
    expect(item.precoEnviadoEm).toBe(1_758_000_900_000);
    expect(item.precoRecusaEm).toBe(1_758_000_800_000);
    // VERBATIM: o prefixo faz parte do que a Shopee respondeu.
    expect(item.precoRecusaCodigo).toBe('product.error_busi_update_price_failed');
    expect(item.precoRecusaMotivo).toBe('recusa-desconhecida');
    expect(item.precoRecusaMensagem).toBe('A Shopee recusou o preço deste anúncio.');

    const modelo = variacaoShopeeLinkSchema.parse({
      ...FILHO_ANTIGO,
      precoEnviado: 12.34,
      precoEnviadoEm: 1_758_000_900_000,
      precoRecusaEm: 1_758_000_700_000,
      precoRecusaCodigo: 'erp:razao-de-precos-excedida',
    });
    expect(modelo.precoEnviado).toBe(12.34);
    expect(modelo.precoEnviadoEm).toBe(1_758_000_900_000);
    expect(modelo.precoRecusaEm).toBe(1_758_000_700_000);
    expect(modelo.precoRecusaCodigo).toBe('erp:razao-de-precos-excedida');
    // Zero também é um valor presente — nunca vira null.
    expect(
      produtoShopeeLinkSchema.parse({ ...LINK_ANTIGO, precoEnviadoEm: 0 }).precoEnviadoEm,
    ).toBe(0);
  });

  it('PAR: precoEnviado aceita centavos (12.34) — ⛔ NEAR-MISS: os carimbos recusam 1.5', () => {
    // O preço é dinheiro com centavos; os carimbos são MILISSEGUNDOS inteiros.
    // Um `.int()` no preço, ou a falta dele num carimbo, reprova aqui.
    expect(
      produtoShopeeLinkSchema.parse({ ...LINK_ANTIGO, precoEnviado: 12.34 }).precoEnviado,
    ).toBe(12.34);
    expect(
      variacaoShopeeLinkSchema.parse({ ...FILHO_ANTIGO, precoEnviado: 12.34 }).precoEnviado,
    ).toBe(12.34);
    for (const campo of ['precoEnviadoEm', 'precoRecusaEm'] as const) {
      expect(produtoShopeeLinkSchema.safeParse({ ...LINK_ANTIGO, [campo]: 1.5 }).success).toBe(
        false,
      );
      expect(variacaoShopeeLinkSchema.safeParse({ ...FILHO_ANTIGO, [campo]: 1.5 }).success).toBe(
        false,
      );
      // o inteiro vizinho passa — a recusa é pela fração, não pelo campo
      expect(produtoShopeeLinkSchema.safeParse({ ...LINK_ANTIGO, [campo]: 2 }).success).toBe(true);
      expect(variacaoShopeeLinkSchema.safeParse({ ...FILHO_ANTIGO, [campo]: 2 }).success).toBe(
        true,
      );
    }
    // Um preço em string (um valor pt-BR não convertido) nunca é aceito.
    expect(
      produtoShopeeLinkSchema.safeParse({ ...LINK_ANTIGO, precoEnviado: '12,34' }).success,
    ).toBe(false);
  });

  it('o item declara exatamente os seis, e o MODELO exatamente os quatro — sem Motivo nem Mensagem', () => {
    expect(chavesPreco(produtoShopeeLinkSchema.shape)).toEqual([...NOVOS_13_ITEM].sort());
    expect(chavesPreco(variacaoShopeeLinkSchema.shape)).toEqual([...NOVOS_13_MODELO].sort());
    // ⛔ NEAR-MISS: o motivo e a mensagem são do ITEM; no modelo mora só o
    // código verbatim da Shopee. Um schema filho que os declarasse passaria a
    // preenchê-los com null em todo parse de todo modelo.
    expect(variacaoShopeeLinkSchema.shape).not.toHaveProperty('precoRecusaMotivo');
    expect(variacaoShopeeLinkSchema.shape).not.toHaveProperty('precoRecusaMensagem');
    const modelo = variacaoShopeeLinkSchema.parse(FILHO_ANTIGO) as Record<string, unknown>;
    expect(modelo).not.toHaveProperty('precoRecusaMotivo');
    expect(modelo).not.toHaveProperty('precoRecusaMensagem');
  });

  it('ultimaModificacao continua NÃO declarada — um carimbo em ms e um legado atravessam intactos', () => {
    // Register 141: declarar o campo forçaria uma união Timestamp|número em todo
    // leitor. Ele passa pelo `.passthrough()`, nos dois formatos.
    expect(produtoShopeeLinkSchema.shape).not.toHaveProperty('ultimaModificacao');
    const emMs = produtoShopeeLinkSchema.parse({
      ...LINK_ANTIGO,
      ultimaModificacao: 1_758_000_900_000,
    }) as Record<string, unknown>;
    expect(emMs.ultimaModificacao).toBe(1_758_000_900_000);
    const legado = { seconds: 1_758_000_900, nanoseconds: 0 };
    const doLegado = produtoShopeeLinkSchema.parse({
      ...LINK_ANTIGO,
      ultimaModificacao: legado,
    }) as Record<string, unknown>;
    expect(doLegado.ultimaModificacao).toEqual(legado);
    // ⛔ NEAR-MISS: ausente continua AUSENTE — nunca um null inventado.
    expect(produtoShopeeLinkSchema.parse(LINK_ANTIGO)).not.toHaveProperty('ultimaModificacao');
  });

  it('o inventário de escritores do cabeçalho ganha os dez preco* com UM escritor', () => {
    const FONTE = readFileSync(join(import.meta.dirname, 'shopeeLink.ts'), 'utf8');
    expect(FONTE).toContain('**the ten `preco*` scalars** (step 13) — **ONE** writer, the price');
    expect(FONTE).toMatch(
      /nothing clears them but its clean send; none is ever read to\s*\*\s*decide a send/,
    );
    // A regra de leitura do modelo: comparada no MESMO doc, zero escritas de limpeza.
    expect(FONTE).toContain('`precoRecusaEm >= (precoEnviadoEm ?? 0)`');
  });
});
