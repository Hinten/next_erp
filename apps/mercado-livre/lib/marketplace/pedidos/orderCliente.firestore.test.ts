/**
 * Real Firestore transaction coverage for the shared cliente identity index.
 *
 * The OccEngine unit suite proves the interleavings and conflict policy. This
 * test keeps one deliberately small end-to-end assertion over the emulator so
 * an Admin SDK or query-shape mismatch cannot turn that model into a false
 * proof: two actual transactions race for one CPF and must leave one cliente
 * plus one consistent, PII-free side document.
 */
import { createHash, randomInt } from 'node:crypto';
import { findOrCreateCliente } from '@delfrance/data/admin/clientes';
import { TIPO_CLIENTE, type ClienteResolveFields } from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { getAdminFirestore } from '@/lib/firebase/admin';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

function cpfDigit(base: string, startWeight: number): string {
  const sum = [...base].reduce(
    (total, digit, index) => total + Number(digit) * (startWeight - index),
    0,
  );
  const remainder = sum % 11;
  return String(remainder < 2 ? 0 : 11 - remainder);
}

function newValidCpf(): string {
  const root = String(randomInt(100_000_000, 1_000_000_000));
  const first = cpfDigit(root, 10);
  return `${root}${first}${cpfDigit(`${root}${first}`, 11)}`;
}

function identityId(tipo: string, normalized: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['cliente-identidade-v1', tipo, normalized]))
    .digest('hex');
}

describe.skipIf(!EMULATED)('findOrCreateCliente (Firestore emulator)', () => {
  it('converges two real concurrent transactions on one cliente and identity index', async () => {
    const db = getAdminFirestore();
    const cpf = newValidCpf();
    const fields: ClienteResolveFields = {
      tipo: TIPO_CLIENTE.pessoaFisica,
      nome: 'Concorrência CPF',
      cpf_cnpj: cpf,
      idEstrangeiro: null,
      ie: null,
      telefone: null,
      email: null,
    };

    const [first, second] = await Promise.all([
      findOrCreateCliente(db, { fields, nowMs: Date.now() }),
      findOrCreateCliente(db, { fields, nowMs: Date.now() }),
    ]);

    expect(first.clienteId).toBe(second.clienteId);
    expect([first.created, second.created].sort()).toEqual([false, true]);

    const clientes = await db.collection('clientes').where('cpf_cnpj', '==', cpf).get();
    expect(clientes.docs.map((doc) => doc.id)).toEqual([first.clienteId]);

    const indexId = identityId('cpf_cnpj', cpf);
    const index = await db.collection('clienteIdentidades').doc(indexId).get();
    expect(index.exists).toBe(true);
    expect(index.data()).toMatchObject({
      tipo: 'cpf_cnpj',
      clienteIds: [first.clienteId],
    });
    expect(index.id).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify({ id: index.id, ...index.data() })).not.toContain(cpf);
  });
});
