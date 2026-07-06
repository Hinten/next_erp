import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import type { DomainSchema } from '@delfrance/schemas';
import { resolvePermissions } from './claims-map';
import { emitRules } from './emit';

function domain(
  collectionPath: string,
  permissions = {
    read: PERM.cliente.read,
    write: PERM.cliente.write,
    delete: PERM.cliente.delete,
  },
  schema: z.ZodTypeAny = z.object({ nome: z.string().max(10) }),
): DomainSchema<z.ZodTypeAny> {
  return { schema, meta: { collectionPath, permissions } };
}

describe('emitRules', () => {
  it('emits split create/update with validator calls for whitelisted paths only', () => {
    const out = emitRules([domain('foo'), domain('bar')], [], new Set(['foo']));
    // Super user bypasses the write check; the validator is ANDed OUTSIDE it.
    expect(out).toContain(
      "allow create: if (isSuperUser() || p('d_cliente', 2)) && v_foo(request.resource.data, request.resource.data.keys());",
    );
    expect(out).toContain(
      "allow update: if (isSuperUser() || p('d_cliente', 2)) && v_foo(request.resource.data, request.resource.data.diff(resource.data).affectedKeys());",
    );
    expect(out).toContain('match /bar/{docId} {');
    expect(out).toContain("allow create, update: if isSuperUser() || p('d_cliente', 2);");
    expect(out).not.toContain('v_bar');
  });

  it('gates serverOwnedFields: create allows only null, update denies any touch', () => {
    const withOwned: DomainSchema<z.ZodTypeAny> = {
      schema: z.object({ nome: z.string(), snap: z.object({ a: z.number() }).nullable() }),
      meta: {
        collectionPath: 'foo',
        permissions: {
          read: PERM.cliente.read,
          write: PERM.cliente.write,
          delete: PERM.cliente.delete,
        },
        serverOwnedFields: ['snap'],
      },
    };
    const out = emitRules([withOwned], [], new Set(['foo']));
    expect(out).toContain(
      "v_foo(request.resource.data, request.resource.data.keys()) && (!request.resource.data.keys().hasAny(['snap']) || request.resource.data.get('snap', null) == null);",
    );
    expect(out).toContain(
      "v_foo(request.resource.data, request.resource.data.diff(resource.data).affectedKeys()) && !request.resource.data.diff(resource.data).affectedKeys().hasAny(['snap']);",
    );
  });

  it('gates serverOwnedFields on non-whitelisted collections by splitting create/update', () => {
    const withOwned: DomainSchema<z.ZodTypeAny> = {
      schema: z.object({ nome: z.string() }),
      meta: {
        collectionPath: 'bar',
        permissions: {
          read: PERM.cliente.read,
          write: PERM.cliente.write,
          delete: PERM.cliente.delete,
        },
        serverOwnedFields: ['snap'],
      },
    };
    const out = emitRules([withOwned], [], new Set());
    expect(out).toContain(
      "allow create: if (isSuperUser() || p('d_cliente', 2)) && (!request.resource.data.keys().hasAny(['snap']) || request.resource.data.get('snap', null) == null);",
    );
    expect(out).toContain(
      "allow update: if (isSuperUser() || p('d_cliente', 2)) && !request.resource.data.diff(resource.data).affectedKeys().hasAny(['snap']);",
    );
    expect(out).not.toContain('allow create, update:');
  });

  it('reuses meta placeholders as wildcards and appends {docId}', () => {
    const out = emitRules([domain('clientes/{clienteId}/enderecos')], [], new Set());
    expect(out).toContain('match /clientes/{clienteId}/enderecos/{docId} {');
  });

  it('emits one collection-group read block per subcollection leaf', () => {
    const out = emitRules(
      [domain('a/{aId}/leaf'), domain('b/{bId}/c/{cId}/leaf'), domain('top')],
      [],
      new Set(),
    );
    expect(out.match(/match \/\{path=\*\*\}\/leaf\/\{docId\}/g)).toHaveLength(1);
    expect(out).not.toContain('/{path=**}/top/');
  });

  it('unions the read claims when metas share a subcollection leaf', () => {
    // The legacy-aligned tax paths made this real: `produtos/{id}/imposto`
    // and `categorias/{id}/imposto` both end in `imposto`. The group block
    // cannot tell the parents apart, so EITHER owning collection's read
    // claim grants the group read (deduped, sorted). Flat blocks keep
    // their own per-collection permissions.
    const other = {
      read: PERM.produto.read,
      write: PERM.produto.write,
      delete: PERM.produto.delete,
    };
    const out = emitRules([domain('a/{aId}/leaf'), domain('b/{bId}/leaf', other)], [], new Set());
    expect(out.match(/match \/\{path=\*\*\}\/leaf\/\{docId\}/g)).toHaveLength(1);
    expect(out).toContain(
      "allow read: if isSuperUser() || p('d_cliente', 1) || p('d_produto', 1);",
    );
  });

  it('rejects a group leaf that collides with a top-level collection name', () => {
    // {path=**} matches an empty prefix, so /{path=**}/leaf would also grant
    // reads on a top-level /leaf — generation must fail instead.
    expect(() => emitRules([domain('a/{aId}/leaf'), domain('leaf')], [], new Set())).toThrow(
      /collides with a top-level collection/,
    );
  });

  it('rejects a group leaf that collides with an extra (hand-written) top-level block', () => {
    expect(() =>
      emitRules(
        [domain('a/{aId}/leaf')],
        [{ path: 'leaf/{leafId}', body: ['allow read: if false;'] }],
        new Set(),
      ),
    ).toThrow(/collides with a top-level collection/);
  });

  it('rejects duplicate collection paths', () => {
    expect(() => emitRules([domain('foo'), domain('foo')], [], new Set())).toThrow(
      /duplicate collectionPath/,
    );
  });

  it("rejects '{docId}' used as a path segment", () => {
    expect(() => emitRules([domain('foo/{docId}/bar')], [], new Set())).toThrow(/reserved/);
  });

  it('rejects malformed segments', () => {
    expect(() => emitRules([domain('foo/{1bad}/bar')], [], new Set())).toThrow(/not a literal/);
  });

  it('appends extra match blocks verbatim', () => {
    const out = emitRules([], [{ path: 'x/{xId}', body: ['allow read: if false;'] }], new Set());
    expect(out).toContain('match /x/{xId} {\n      allow read: if false;\n    }');
  });

  it('fails when a whitelisted schema yields no clauses', () => {
    const empty = domain('foo', undefined, z.object({ blob: z.unknown() }));
    expect(() => emitRules([empty], [], new Set(['foo']))).toThrow(/no clauses/);
  });
});

describe('resolvePermissions', () => {
  it('maps action-bit reuse by bit identity (configuracoes write as delete)', () => {
    const meta = {
      collectionPath: 'cargos',
      permissions: {
        read: PERM.configuracoes.read,
        write: PERM.configuracoes.write,
        delete: PERM.configuracoes.write,
      },
    };
    expect(resolvePermissions(meta).delete).toEqual({ claim: 'd_configuracoes', k: 2 });
  });

  it('rejects composite masks', () => {
    const meta = {
      collectionPath: 'foo',
      permissions: {
        read: PERM.cliente.read | PERM.cliente.write,
        write: PERM.cliente.write,
        delete: PERM.cliente.delete,
      },
    };
    expect(() => resolvePermissions(meta)).toThrow(/single PERM bit/);
  });

  it('rejects bits that are not in PERM', () => {
    const meta = {
      collectionPath: 'foo',
      permissions: { read: 1n << 78n, write: PERM.cliente.write, delete: PERM.cliente.delete },
    };
    expect(() => resolvePermissions(meta)).toThrow(/not in PERM/);
  });
});
