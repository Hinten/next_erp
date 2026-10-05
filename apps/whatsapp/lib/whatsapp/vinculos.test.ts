import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { detalheVinculoWhatsapp } from './vinculos';

type Data = Record<string, unknown>;

/** Read-only query seam: evaluates equality/membership against stored phone shapes. */
class PendingReadDb {
  readonly collections = new Map<string, Map<string, Data>>();
  readonly queries: Array<{
    path: string;
    field: string;
    op: string;
    value: unknown;
    limit: number;
  }> = [];

  constructor(phone: string | null) {
    this.seed('whatsappVinculos', 'pending', {
      revision: 0,
      integracaoId: 'wa-1',
      integracaoNome: 'WhatsApp',
      nome: 'Contato recebido',
      telefone: phone,
      bsuid: null,
      motivo: 'ambiguo',
      ultimaMensagemEm: 1,
      quantidadeMensagens: 0,
      estado: 'aguardando',
      clienteId: null,
      conversaId: null,
    });
  }

  seed(path: string, id: string, value: Data) {
    const rows = this.collections.get(path) ?? new Map<string, Data>();
    rows.set(id, value);
    this.collections.set(path, rows);
  }

  collection(path: string) {
    const rows = this.collections.get(path) ?? new Map<string, Data>();
    const snapshot = (id: string) => ({ id, exists: rows.has(id), data: () => rows.get(id) });
    const build = (
      filter: { field: string; op: string; value: unknown } | null = null,
      cap = Infinity,
    ) => ({
      where: (field: string, op: string, value: unknown) => build({ field, op, value }, cap),
      orderBy: (_field: string) => build(filter, cap),
      limit: (next: number) => build(filter, next),
      get: async () => {
        if (filter) this.queries.push({ path, ...filter, limit: cap });
        const docs = [...rows]
          .filter(
            ([, data]) =>
              !filter ||
              (filter.op === 'in'
                ? Array.isArray(filter.value) && filter.value.includes(data[filter.field])
                : filter.op === '==' && data[filter.field] === filter.value),
          )
          .slice(0, cap)
          .map(([id]) => snapshot(id));
        return { docs, size: docs.length };
      },
    });
    return { ...build(), doc: (id: string) => ({ get: async () => snapshot(id) }) };
  }

  async candidates() {
    const detail = await detalheVinculoWhatsapp(this as unknown as Firestore, 'pending');
    return detail?.candidates ?? [];
  }
}

describe('pending WhatsApp detail — current-phone candidate equivalence', () => {
  it('finds both a canonical Brazilian phone and its legacy national shape, preserving ambiguity for the operator', async () => {
    const db = new PendingReadDb('5511999998888');
    db.seed('clientes', 'canonical', { nome: 'Cliente E164', telefone: '5511999998888' });
    db.seed('clientes', 'legacy', { nome: 'Cliente legado', telefone: '11999998888' });
    const result = await db.candidates();
    expect(result.map((candidate) => candidate.id)).toEqual(['canonical', 'legacy']);
    expect(db.queries).toEqual([
      {
        path: 'clientes',
        field: 'telefone',
        op: 'in',
        value: ['5511999998888', '11999998888'],
        limit: 20,
      },
    ]);
    expect(db.collections.get('whatsappVinculos')?.get('pending')?.clienteId).toBeNull();
    expect(db.collections.has('chat')).toBe(false);
  });

  it('does not fold the ninth digit or suggest a cliente from its inactive history', async () => {
    const db = new PendingReadDb('5511999998888');
    db.seed('clientes', 'exact', { nome: 'Atual', telefone: '5511999998888' });
    db.seed('clientes', 'without-ninth', { nome: 'Outro número', telefone: '551199998888' });
    db.seed('clientes', 'legacy-without-ninth', { nome: 'Outro legado', telefone: '1199998888' });
    db.seed('clientes', 'historical-only', {
      nome: 'Inativo',
      telefone: '5511888887777',
      telefonesAdicionais: ['5511999998888'],
    });
    expect((await db.candidates()).map((candidate) => candidate.id)).toEqual(['exact']);
  });

  it('keeps an explicit international country code distinct from the Brazilian national interpretation', async () => {
    const db = new PendingReadDb('14155552671');
    db.seed('clientes', 'us', { nome: 'US', telefone: '14155552671' });
    db.seed('clientes', 'br', { nome: 'Brasil', telefone: '5514155552671' });
    expect((await db.candidates()).map((candidate) => candidate.id)).toEqual(['us']);
    expect(db.queries[0]?.value).toEqual(['14155552671']);
  });

  it('keeps the 20-candidate cap across equivalent stored shapes', async () => {
    const db = new PendingReadDb('5511999998888');
    for (let i = 0; i < 25; i++)
      db.seed('clientes', 'cliente-' + i, {
        nome: 'Cliente ' + i,
        telefone: i % 2 ? '11999998888' : '5511999998888',
      });
    expect(await db.candidates()).toHaveLength(20);
    expect(db.queries[0]?.limit).toBe(20);
  });

  it('does not look up phone candidates when the provider omitted the phone', async () => {
    const db = new PendingReadDb(null);
    db.seed('clientes', 'unrelated', { nome: 'Outro', telefone: '5511999998888' });
    expect(await db.candidates()).toEqual([]);
    expect(db.queries).toEqual([]);
  });
});
