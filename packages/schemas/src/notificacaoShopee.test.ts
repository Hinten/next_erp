import { describe, expect, it } from 'vitest';
import { notificacaoShopeeSchema, notificacaoShopeeStatusSchema } from './notificacaoShopee';
import { ALL_DOMAINS } from './registry';

describe('notificacaoShopeeSchema', () => {
  it('aplica os defaults num doc de falha mínimo', () => {
    const parsed = notificacaoShopeeSchema.parse({ code: 1 });
    expect(parsed).toMatchObject({
      code: 1,
      shop_id: null,
      timestamp: null,
      data: null,
      status: 'failed',
      tentativas: 0,
      erro: null,
      processedAt: null,
    });
  });

  it('aceita um doc completo', () => {
    const doc = {
      code: 12,
      shop_id: 987654,
      timestamp: 1568606634000,
      data: { expire_before: 1619740800, page_no: 1, total_page: 2 },
      status: 'parked' as const,
      tentativas: 3,
      erro: 'sem handler para o push_code 12',
      processedAt: 1568606700000,
    };
    expect(notificacaoShopeeSchema.parse(doc)).toMatchObject(doc);
  });

  it('exige um code inteiro', () => {
    expect(notificacaoShopeeSchema.safeParse({}).success).toBe(false);
    expect(notificacaoShopeeSchema.safeParse({ code: 'um' }).success).toBe(false);
    expect(notificacaoShopeeSchema.safeParse({ code: 1.5 }).success).toBe(false);
  });

  it('preserva campos desconhecidos do push via passthrough', () => {
    const parsed = notificacaoShopeeSchema.parse({
      code: 1,
      partner_id: 1000001,
      campo_novo_da_shopee: 'valor',
    }) as Record<string, unknown>;
    expect(parsed.partner_id).toBe(1000001);
    expect(parsed.campo_novo_da_shopee).toBe('valor');
  });

  // O receiver já converte SEGUNDOS → MILLIS antes de persistir, mas o campo é
  // um `millisSinceEpoch()` tolerante, e essa tolerância é o que impede um
  // ZodError dentro de `persistFailure` (que roda FORA do catch do handleTask).
  it('é tolerante a um timestamp ISO-8601 no campo já normalizado', () => {
    const parsed = notificacaoShopeeSchema.parse({
      code: 3,
      timestamp: '2021-11-01T02:02:02.000Z',
    });
    expect(parsed.timestamp).toBe(Date.parse('2021-11-01T02:02:02.000Z'));
  });

  // Pinado como CONJUNTO — é um alias do enum compartilhado, então uma nova
  // faixa de retry chega aqui sem tocar neste arquivo. Ver os irmãos ML/MP.
  it('aceita exatamente os status de resiliência compartilhados', () => {
    expect([...notificacaoShopeeStatusSchema.options].sort()).toEqual([
      'deferred',
      'failed',
      'parked',
    ]);
    for (const status of notificacaoShopeeStatusSchema.options) {
      expect(notificacaoShopeeStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(notificacaoShopeeStatusSchema.safeParse('done').success).toBe(false);
  });
});

describe('registro admin-only de notificacoesShopee', () => {
  it('NÃO está registrado em ALL_DOMAINS (log de falhas server-only)', () => {
    // O schema não expõe `xMeta`/constante de path (o handle admin é dono do
    // literal, espelhando notificacaoMercadoPago) — a asserção é por identidade
    // do schema, não por collectionPath.
    const domainSchemas = ALL_DOMAINS.map((d) => d.schema);
    expect(domainSchemas).not.toContain(notificacaoShopeeSchema);
  });
});
