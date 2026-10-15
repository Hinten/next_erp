import { describe, expect, it } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { executePlan, verifyPlan, type MigrationStore } from './execute';
import { parseWhatsappArgs } from './migrate';
import { planWhatsappMigration, type Raw, type SourceDocument } from './transform';

const docs: SourceDocument[] = [
  { path: 'integracao/i', data: { tipo: INTEGRACAO_TIPO.whatsapp } },
  { path: 'clientes/c', data: {} },
  ...['a', 'z'].map((id) => ({
    path: `chat/${id}`,
    data: {
      origem: 'whatsapp',
      sender_id: '5511888888888_5511999998888',
      clienteOuterRef: 'clientes/c',
      integracaoOuterRef: 'integracao/i',
    },
  })),
  { path: 'chat/z/mensagem/x', data: { estadoEnvio: 7, tipo: 'c', conteudo: 'oi', mid: 'wa.1' } },
  { path: 'chat/z/unknown/x/nested/y', data: { untouched: { a: [1, '01'] } } },
];

function fixture() {
  const database = new Map(
    docs.map((d) => [d.path, { data: structuredClone(d.data), version: 1 }]),
  );
  let operations = 0;
  let failAt: number | null = null;
  const operationsLog: string[] = [];
  const beforeMutation = (path: string) => {
    operations += 1;
    if (operations === failAt) throw new Error('simulated crash');
    operationsLog.push(path);
  };
  const store: MigrationStore = {
    read: async (path) => database.get(path) ?? null,
    create: async (path, data) => {
      beforeMutation(`create:${path}`);
      if (database.has(path)) throw new Error('already exists');
      database.set(path, { data, version: 1 });
    },
    replace: async (path, data, version) => {
      beforeMutation(`replace:${path}`);
      if (database.get(path)?.version !== version) throw new Error('precondition');
      database.set(path, { data, version: Number(version) + 1 });
    },
    remove: async (path, version) => {
      beforeMutation(`remove:${path}`);
      if (database.get(path)?.version !== version) throw new Error('precondition');
      database.delete(path);
    },
    descendantPaths: async (root) => [...database.keys()].filter((p) => p.startsWith(`${root}/`)),
  };
  return {
    store,
    database,
    operationsLog,
    failAt: (n: number | null) => {
      failAt = n;
    },
  };
}
const options = { apply: true, finalize: true, log: (_record: unknown) => {} };

describe('migration execution', () => {
  it('copies and verifies before deleting, children first; rerun is a no-op', async () => {
    const f = fixture();
    const plan = planWhatsappMigration('p', docs);
    expect(plan.conflicts).toEqual([]);
    const first = await executePlan(f.store, plan, options);
    expect(first.deletes).toBeGreaterThan(0);
    await verifyPlan(f.store, plan, true);
    const firstDelete = f.operationsLog.findIndex((p) => p.startsWith('remove:'));
    expect(f.operationsLog.slice(firstDelete).every((p) => p.startsWith('remove:'))).toBe(true);
    expect(f.operationsLog.at(-1)).toBe('remove:chat/z');
    expect(await executePlan(f.store, plan, options)).toEqual({ writes: 0, deletes: 0 });
  });
  it('survives a crash after every operation without duplicating history', async () => {
    const plan = planWhatsappMigration('p', docs);
    const count = plan.writes.length + plan.deletes.length;
    for (let failure = 1; failure <= count; failure++) {
      const f = fixture();
      f.failAt(failure);
      await expect(executePlan(f.store, plan, options)).rejects.toThrow('simulated crash');
      f.failAt(null);
      await executePlan(f.store, plan, options);
      await verifyPlan(f.store, plan, true);
      expect([...f.database.keys()].filter((p) => /^chat\/a\/mensagem\//.test(p))).toHaveLength(1);
    }
  });
  it('dry-run never mutates and finalize is separate', async () => {
    const f = fixture();
    const plan = planWhatsappMigration('p', docs);
    await executePlan(f.store, plan, { ...options, apply: false });
    expect(f.operationsLog).toEqual([]);
    await executePlan(f.store, plan, { ...options, finalize: false });
    expect(f.database.has('chat/z')).toBe(true);
    await executePlan(f.store, plan, options);
    expect(f.database.has('chat/z')).toBe(false);
  });
  it('refuses drift and new descendants before the first write', async () => {
    const plan = planWhatsappMigration('p', docs);
    const changed = fixture();
    changed.database.set('chat/z', { data: { edit: 'operator' } as Raw, version: 2 });
    await expect(executePlan(changed.store, plan, options)).rejects.toThrow('mudou');
    expect(changed.operationsLog).toEqual([]);
    const added = fixture();
    added.database.set('chat/z/new/subcollection', { data: {}, version: 1 });
    await expect(executePlan(added.store, plan, options)).rejects.toThrow('fora do inventário');
    expect(added.operationsLog).toEqual([]);
  });
  it('refuses conflicts and out-of-scope deletion manifests', async () => {
    const f = fixture();
    const plan = planWhatsappMigration('p', docs);
    await expect(
      executePlan(
        f.store,
        { ...plan, conflicts: [{ path: 'chat/a', reason: 'ambiguous' }] },
        options,
      ),
    ).rejects.toThrow('conflitos');
    await expect(
      executePlan(f.store, { ...plan, deletes: ['clientes/c'] }, options),
    ).rejects.toThrow('Exclusão');
    expect(f.operationsLog).toEqual([]);
  });
  it('allows pending in dry-run but blocks apply, finalization and verification', async () => {
    const f = fixture();
    const plan = planWhatsappMigration('p', [
      ...docs,
      {
        path: 'chat/unknown',
        data: {
          origem: 'whatsapp',
          integracaoOuterRef: 'integracao/i',
          sender_id: '5511888888888_5511999997777',
        },
      },
    ]);
    f.database.set('chat/unknown', {
      data: plan.sources.find((d) => d.path === 'chat/unknown')!.data,
      version: 1,
    });
    expect(plan.pending).toHaveLength(1);
    await executePlan(f.store, plan, { ...options, apply: false });
    await expect(executePlan(f.store, plan, { ...options, finalize: false })).rejects.toThrow(
      'pendências legadas',
    );
    await expect(executePlan(f.store, plan, options)).rejects.toThrow('pendências legadas');
    await expect(verifyPlan(f.store, plan)).rejects.toThrow('pendências legadas');
    expect(f.operationsLog).toEqual([]);
  });
});

describe('CLI guardrails', () => {
  it('requires explicit project, reviewed manifest and operational freeze', () => {
    expect(() => parseWhatsappArgs([])).toThrow('--project');
    expect(() => parseWhatsappArgs(['--project', 'p', '--apply'])).toThrow('--manifest');
    expect(() => parseWhatsappArgs(['--project', 'p', '--manifest', 'm', '--apply'])).toThrow(
      '--writers-stopped',
    );
    expect(() => parseWhatsappArgs(['--project', 'p', '--manifest', 'm', '--finalize'])).toThrow(
      '--apply',
    );
    expect(
      parseWhatsappArgs([
        '--project',
        'p',
        '--manifest',
        'm',
        '--apply',
        '--finalize',
        '--writers-stopped',
      ]),
    ).toMatchObject({
      projectId: 'p',
      apply: true,
      finalize: true,
      writersStopped: true,
    });
  });
});
