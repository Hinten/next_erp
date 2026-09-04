import { describe, expect, it } from 'vitest';
import {
  ENVIO_PRECO_MERCADO_LIVRE_STATUS,
  envioPrecoFailureSchema,
  envioPrecoFilaItemSchema,
  envioPrecoMercadoLivreSchema,
  envioPrecoMercadoLivreStatusSchema,
  envioPrecoSkipSchema,
} from './envioPrecoMercadoLivre';
import { ALL_DOMAINS } from './registry';

const FILA_ITEM = {
  kind: 'item' as const,
  itemId: 'MLB1',
  produtoId: 'PROD1',
  variacaoProdutoId: null,
  linkDocId: 'LINK1',
  preco: 129.9,
};

describe('envioPrecoMercadoLivreSchema', () => {
  it('parses a freshly-started job with defaults applied', () => {
    const parsed = envioPrecoMercadoLivreSchema.parse({
      integracaoId: 'INT1',
      status: 'running',
      startedAt: 1718003600000,
      updatedAt: 1718003600000,
    });
    expect(parsed).toMatchObject({
      integracaoId: 'INT1',
      status: 'running',
      baixarPreco: false,
      afterAnchorId: null,
      planejamentoConcluido: false,
      afterLinkPath: null,
      reconciliacaoConcluida: false,
      reconciliacaoPaginas: 0,
      naoEnumerados: 0,
      linksReconciliados: 0,
      fila: [],
      planejados: 0,
      enviados: 0,
      pulados: 0,
      falhas: 0,
      pausas: 0,
      skips: [],
      failures: [],
      startedBy: null,
      finishedAt: null,
      erro: null,
    });
  });

  it('#1072: a job doc written BEFORE the reconciliation phase existed still parses', () => {
    // The resume-compat case. A `running` job checkpointed by the previous
    // deploy carries none of these keys; the defaults must fill them so the
    // phase simply starts, rather than the parse throwing mid-dispatch.
    const parsed = envioPrecoMercadoLivreSchema.parse({
      integracaoId: 'INT1',
      status: 'running',
      afterAnchorId: 'PROD40',
      planejamentoConcluido: true,
      planejados: 12,
      enviados: 12,
      startedAt: 1718003600000,
      updatedAt: 1718003600000,
    });
    expect(parsed).toMatchObject({
      afterLinkPath: null,
      reconciliacaoConcluida: false,
      reconciliacaoPaginas: 0,
      naoEnumerados: 0,
      linksReconciliados: 0,
    });
  });

  it('#1072: naoEnumerados is independent of pulados', () => {
    // They answer different questions — "looked at, then not sent" vs "never
    // looked at" — and only the second one makes `completed` mean what it says.
    const parsed = envioPrecoMercadoLivreSchema.parse({
      integracaoId: 'INT1',
      status: 'completed',
      pulados: 3,
      naoEnumerados: 41,
      linksReconciliados: 900,
      afterLinkPath: 'produtos/P1/produtoMercadoLivre/link1',
      reconciliacaoConcluida: true,
      startedAt: 1718003600000,
      updatedAt: 1718003600000,
    });
    expect(parsed.pulados).toBe(3);
    expect(parsed.naoEnumerados).toBe(41);
    expect(parsed.linksReconciliados).toBe(900);
    expect(parsed.afterLinkPath).toBe('produtos/P1/produtoMercadoLivre/link1');
    expect(parsed.reconciliacaoConcluida).toBe(true);
  });

  it('parses a full in-progress job (mid-fila, mid-plan)', () => {
    const doc = {
      integracaoId: 'INT1',
      status: 'running' as const,
      baixarPreco: true,
      afterAnchorId: 'PROD40',
      planejamentoConcluido: false,
      fila: [
        FILA_ITEM,
        {
          kind: 'variationItem' as const,
          itemId: 'MLB2',
          produtoId: 'PROD1',
          variacaoProdutoId: 'PROD1-VAR2',
          linkDocId: 'LINK2',
          preco: 99.9,
        },
      ],
      planejados: 40,
      enviados: 20,
      pulados: 12,
      falhas: 1,
      pausas: 2,
      skips: [{ itemId: 'MLB98', produtoId: 'PROD9', code: 'PRECO_ANTIGO_IGUAL' }],
      failures: [
        { itemId: 'MLB99', produtoId: 'PROD8', code: 'UPDATE_PRECO_ERROR', error: 'boom' },
      ],
      startedBy: 'uid-1',
      startedAt: 1718003600000,
      updatedAt: 1718003650000,
      finishedAt: null,
      erro: null,
    };
    expect(envioPrecoMercadoLivreSchema.parse(doc)).toMatchObject(doc);
  });

  it('parses a completed job', () => {
    const parsed = envioPrecoMercadoLivreSchema.parse({
      integracaoId: 'INT1',
      status: 'completed',
      planejamentoConcluido: true,
      startedAt: 1718003600000,
      updatedAt: 1718003999000,
      finishedAt: 1718003999000,
    });
    expect(parsed.status).toBe('completed');
    expect(parsed.finishedAt).toBe(1718003999000);
  });

  it('parses a failed job with an erro string', () => {
    const parsed = envioPrecoMercadoLivreSchema.parse({
      integracaoId: 'INT1',
      status: 'failed',
      startedAt: 1718003600000,
      updatedAt: 1718003999000,
      finishedAt: 1718003999000,
      erro: 'Token do Mercado Livre inválido. Reconecte a conta.',
    });
    expect(parsed.status).toBe('failed');
    expect(parsed.erro).toBe('Token do Mercado Livre inválido. Reconecte a conta.');
  });

  it('requires integracaoId and status', () => {
    expect(
      envioPrecoMercadoLivreSchema.safeParse({ status: 'running', startedAt: 1, updatedAt: 1 })
        .success,
    ).toBe(false);
    expect(
      envioPrecoMercadoLivreSchema.safeParse({ integracaoId: 'INT1', startedAt: 1, updatedAt: 1 })
        .success,
    ).toBe(false);
    expect(
      envioPrecoMercadoLivreSchema.safeParse({
        integracaoId: '',
        status: 'running',
        startedAt: 1,
        updatedAt: 1,
      }).success,
    ).toBe(false);
  });

  it('only accepts running/completed/failed/cancelled as status', () => {
    expect(envioPrecoMercadoLivreStatusSchema.safeParse('running').success).toBe(true);
    expect(envioPrecoMercadoLivreStatusSchema.safeParse('completed').success).toBe(true);
    expect(envioPrecoMercadoLivreStatusSchema.safeParse('failed').success).toBe(true);
    // #1144 — the operator's cancel is terminal like the other two.
    expect(envioPrecoMercadoLivreStatusSchema.safeParse('cancelled').success).toBe(true);
    expect(envioPrecoMercadoLivreStatusSchema.safeParse('parked').success).toBe(false);
  });

  it('names every status member on the as-const companion', () => {
    // `prefer-schema-enum` reads the companion, so a member added to the enum
    // and not to it is a member no call site can spell.
    expect(Object.keys(ENVIO_PRECO_MERCADO_LIVRE_STATUS).sort()).toEqual(
      [...envioPrecoMercadoLivreStatusSchema.options].sort(),
    );
  });
});

describe('envioPrecoFilaItemSchema', () => {
  it('parses both draft kinds and defaults variacaoProdutoId to null', () => {
    const { variacaoProdutoId: _variacaoProdutoId, ...withoutVariacao } = FILA_ITEM;
    expect(envioPrecoFilaItemSchema.parse(withoutVariacao).variacaoProdutoId).toBeNull();
    expect(
      envioPrecoFilaItemSchema.safeParse({ ...FILA_ITEM, kind: 'variationItem' }).success,
    ).toBe(true);
    expect(envioPrecoFilaItemSchema.safeParse({ ...FILA_ITEM, kind: 'variation' }).success).toBe(
      false,
    );
  });

  it('requires itemId, produtoId and linkDocId', () => {
    for (const key of ['itemId', 'produtoId', 'linkDocId'] as const) {
      expect(envioPrecoFilaItemSchema.safeParse({ ...FILA_ITEM, [key]: undefined }).success).toBe(
        false,
      );
      expect(envioPrecoFilaItemSchema.safeParse({ ...FILA_ITEM, [key]: '' }).success).toBe(false);
    }
  });

  it('rides unknown keys through passthrough', () => {
    const parsed = envioPrecoFilaItemSchema.parse({ ...FILA_ITEM, futureHint: 'keep-me' });
    expect(parsed).toMatchObject({ ...FILA_ITEM, futureHint: 'keep-me' });
  });
});

describe('envioPrecoSkipSchema / envioPrecoFailureSchema', () => {
  it('defaults itemId to null (plan-time skips have no listing)', () => {
    expect(envioPrecoSkipSchema.parse({ produtoId: 'PROD1', code: 'SEM_LINK' })).toMatchObject({
      itemId: null,
      produtoId: 'PROD1',
      code: 'SEM_LINK',
    });
  });

  it('failure extends skip with a required error string', () => {
    expect(
      envioPrecoFailureSchema.safeParse({ itemId: 'MLB1', produtoId: 'PROD1', code: 'FORBIDDEN' })
        .success,
    ).toBe(false);
    expect(
      envioPrecoFailureSchema.parse({
        itemId: 'MLB1',
        produtoId: 'PROD1',
        code: 'UPDATE_PRECO_ERROR',
        error: 'boom',
      }),
    ).toMatchObject({ code: 'UPDATE_PRECO_ERROR', error: 'boom' });
  });
});

describe('enviosPrecoMercadoLivre admin-only registration', () => {
  it('is NOT registered in ALL_DOMAINS (server-only price-sync job doc)', () => {
    const domainSchemas = ALL_DOMAINS.map((d) => d.schema);
    expect(domainSchemas).not.toContain(envioPrecoMercadoLivreSchema);
  });
});
