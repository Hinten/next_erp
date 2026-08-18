import { describe, expect, it } from 'vitest';
import {
  historicoModificacao,
  historicoModificacaoMeta,
} from '../produto/collection/historicoModificacoes';
import {
  historicoModificacaoPedido,
  historicoModificacaoPedidoMeta,
} from '../pedido/collection/historicoModificacoes';
import { historicoModificacaoSchema } from './historicoModificacoes';

/**
 * The two `historicoDeModificacoes` roots share one entry schema and one
 * trigger factory, so their metas must agree on everything except the path and
 * the permission domain. A meta FACTORY would have guaranteed that — but it
 * would also have switched off `delfrance/default-query-needs-index`, which
 * only fires on a `defaultQuery` sitting beside a string-LITERAL
 * `collectionPath`. Keeping both metas literal preserves the lint error; this
 * test replaces what the factory would have enforced.
 */
describe('historicoDeModificacoes metas agree across roots', () => {
  const metas = [
    ['produto', historicoModificacaoMeta] as const,
    ['pedido', historicoModificacaoPedidoMeta] as const,
  ];

  it.each(metas)('%s: is server-owned (an audit trail no client may write)', (_name, meta) => {
    expect(meta.serverOwned).toBe(true);
  });

  it.each(metas)('%s: suppresses the collection-group read block', (_name, meta) => {
    // Both must set it. `emit.ts` unions the read claims of every collection
    // sharing a leaf into ONE `{path=**}/historicoDeModificacoes` block, and the
    // wildcard matches any parent — so suppressing it on one root alone would
    // leave the other root's block granting cross-domain reads.
    expect(meta.noCollectionGroupRead).toBe(true);
  });

  it('declares the SAME defaultQuery, so both derive the same index', () => {
    expect(historicoModificacaoPedidoMeta.defaultQuery).toEqual(
      historicoModificacaoMeta.defaultQuery,
    );
    expect(historicoModificacaoMeta.defaultQuery).toEqual({
      orderBy: [{ field: 'timestamp', direction: 'desc' }],
      limit: 50,
    });
  });

  it('shares one leaf name, which is what makes the single index cover both', () => {
    const leaf = (path: string) => path.split('/').at(-1);
    expect(leaf(historicoModificacaoPedidoMeta.collectionPath)).toBe('historicoDeModificacoes');
    expect(leaf(historicoModificacaoMeta.collectionPath)).toBe(
      leaf(historicoModificacaoPedidoMeta.collectionPath),
    );
  });

  it('binds both bundles to the one shared entry schema', () => {
    expect(historicoModificacao.schema).toBe(historicoModificacaoSchema);
    expect(historicoModificacaoPedido.schema).toBe(historicoModificacaoSchema);
  });

  it('scopes each root to its OWN permission domain', () => {
    // produto byte 8, pedido byte 16 — reading a pedido's history must not
    // require a produto claim, and must not be granted by one.
    expect(historicoModificacaoMeta.permissions.read).toBe(1n << 8n);
    expect(historicoModificacaoPedidoMeta.permissions.read).toBe(1n << 16n);
  });
});

describe('historicoModificacaoSchema — the actor field', () => {
  const base = {
    path: 'pedidos/p1',
    docId: 'p1',
    kind: 'update' as const,
    campos: ['estado'],
    changes: { estado: { old: 'iniciado', new: 'pago' } },
    timestamp: 1_700_000_000_000_000,
    eventId: 'evt-1',
  };

  it('keeps an ABSENT actor absent — a legacy row must not claim to be a system write', () => {
    const parsed = historicoModificacaoSchema.parse(base);
    expect('usuarioOuterRef' in parsed).toBe(false);
  });

  it('keeps an explicit null distinct from absent (an Admin-SDK write: "Sistema")', () => {
    const parsed = historicoModificacaoSchema.parse({ ...base, usuarioOuterRef: null });
    expect(parsed.usuarioOuterRef).toBeNull();
  });

  it('accepts a documents/usuarios/<uid> outer ref', () => {
    const ref = 'documents/usuarios/AbCdEf0123456789AbCdEf01';
    expect(
      historicoModificacaoSchema.parse({ ...base, usuarioOuterRef: ref }).usuarioOuterRef,
    ).toBe(ref);
  });

  it('rejects a bare uid — the stored form is always the outer-ref path', () => {
    expect(() =>
      historicoModificacaoSchema.parse({ ...base, usuarioOuterRef: 'AbCdEf0123456789AbCdEf01' }),
    ).toThrow();
  });
});
