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
    expect(out).toContain(
      "allow create: if p('d_cliente', 2) && v_foo(request.resource.data, request.resource.data.keys());",
    );
    expect(out).toContain(
      "allow update: if p('d_cliente', 2) && v_foo(request.resource.data, request.resource.data.diff(resource.data).affectedKeys());",
    );
    expect(out).toContain('match /bar/{docId} {');
    expect(out).toContain("allow create, update: if p('d_cliente', 2);");
    expect(out).not.toContain('v_bar');
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

  it('rejects leaves whose metas disagree on the read permission', () => {
    const other = {
      read: PERM.produto.read,
      write: PERM.produto.write,
      delete: PERM.produto.delete,
    };
    expect(() =>
      emitRules([domain('a/{aId}/leaf'), domain('b/{bId}/leaf', other)], [], new Set()),
    ).toThrow(/conflicting read permissions/);
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
