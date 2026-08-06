import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { MlBillingInfo, MlShipment } from '@delfrance/integrations-mercado-livre';
import { IE_SENTINELA, UF_SIGLA, TIPO_CLIENTE } from '@delfrance/schemas';

import {
  type ClienteImportFields,
  type EnderecoImportFields,
  MlBillingInfoUnsupportedError,
  billingInfoToClienteFields,
  billingInfoToEnderecoFields,
  ensureEndereco,
  findOrCreateCliente,
  makeEnderecoId,
  shipmentToEnderecoFields,
} from './orderCliente';

/* ------------------------------ fake Firestore ---------------------------- */
// Adapted from massImport.test.ts's FakeDb: operator-aware `where()` ('==' and
// 'in', the two this suite needs) plus a `.create()` that throws gRPC
// ALREADY_EXISTS (code 6) on a doc that already exists.

type DocData = Record<string, unknown>;

function matchClause(fieldValue: unknown, op: string, value: unknown): boolean {
  if (op === 'in') return Array.isArray(value) && value.includes(fieldValue);
  return fieldValue === value;
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  private autoN = 0;

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }
  storedDoc(path: string, id: string): DocData | undefined {
    return this.col(path).get(id);
  }
  /** Every doc in a collection — `.size` is the no-duplicate assertion. */
  docs(path: string): Map<string, DocData> {
    return this.col(path);
  }

  private query(entries: Array<[string, DocData]>) {
    const clauses: Array<[string, string, unknown]> = [];
    let lim: number | null = null;
    const q = {
      where(field: string, op: string, value: unknown) {
        clauses.push([field, op, value]);
        return q;
      },
      limit(n: number) {
        lim = n;
        return q;
      },
      async get() {
        let rows = entries.filter(([, d]) =>
          clauses.every(([f, op, v]) => matchClause(d[f], op, v)),
        );
        if (lim != null) rows = rows.slice(0, lim);
        return {
          docs: rows.map(([id, d]) => ({ id, data: () => d, exists: true })),
          empty: rows.length === 0,
        };
      },
    };
    return q;
  }

  collection(path: string) {
    const col = this.col(path);
    const self = this;
    return {
      doc: (id?: string) => {
        const docId = id ?? `auto-${++self.autoN}`;
        return {
          id: docId,
          get: async () => ({ exists: col.has(docId), id: docId, data: () => col.get(docId) }),
          set: async (data: DocData, opts?: { merge?: boolean }) => {
            col.set(docId, opts?.merge ? { ...(col.get(docId) ?? {}), ...data } : { ...data });
          },
          create: async (data: DocData) => {
            if (col.has(docId)) throw Object.assign(new Error('already exists'), { code: 6 });
            col.set(docId, { ...data });
          },
          update: async (patch: DocData) => {
            col.set(docId, { ...(col.get(docId) ?? {}), ...patch });
          },
        };
      },
      where: (field: string, op: string, value: unknown) =>
        self.query([...col.entries()]).where(field, op, value),
      limit: (n: number) => self.query([...col.entries()]).limit(n),
      get: async () => ({
        docs: [...col.entries()].map(([id, d]) => ({ id, data: () => d, exists: true })),
      }),
      // `CollectionReference.add()` — auto-generated id, used by
      // `clienteCollection.add()` on the create path.
      add: async (data: DocData) => {
        const id = `auto-${++self.autoN}`;
        col.set(id, { ...data });
        return { id };
      },
    };
  }
}

function db(fake: FakeDb): Firestore {
  return fake as unknown as Firestore;
}

const NOW_MS = 1_753_180_800_000; // 2026-07-22T00:00:00.000Z (arbitrary, fixed)

/* ------------------------------- fixtures --------------------------------- */

// `overrides` merges onto `billing_info` (e.g. `identification`/`taxes`);
// `addressOverrides` merges INTO the nested `address` object (not a
// shallow-replace at the `billing_info` level) so a test can drop a single
// address field (e.g. `street_number`) without losing its siblings (e.g.
// `zip_code`, which `canMakeAdress` depends on).
function cpfBillingInfo(
  overrides: Record<string, unknown> = {},
  addressOverrides: Record<string, unknown> = {},
): MlBillingInfo {
  return {
    site_id: 'MLB',
    buyer: {
      cust_id: 234343545,
      billing_info: {
        name: 'Maria',
        last_name: 'Silva',
        // Valid CPF (mod-11 checksum) — same constant used by
        // `packages/core/src/documents/br.test.ts` — required because the
        // create path round-trips this value through `clienteSchema`'s
        // `validateCpfCnpj` refine.
        identification: { type: 'CPF', number: '529.982.247-25' },
        taxes: { inscriptions: null, taxpayer_type: null },
        address: {
          street_name: 'Rua das Flores',
          street_number: '50',
          city_name: 'São Paulo',
          comment: 'apto 12',
          neighborhood: 'Centro',
          state: { name: 'São Paulo' },
          zip_code: '01310100',
          country_id: 'BR',
          ...addressOverrides,
        },
        ...overrides,
      },
    },
    seller: { cust_id: '999' },
  } as unknown as MlBillingInfo;
}

function cnpjBillingInfo(
  overrides: Record<string, unknown> = {},
  addressOverrides: Record<string, unknown> = {},
): MlBillingInfo {
  return {
    site_id: 'MLB',
    buyer: {
      cust_id: 234343545,
      billing_info: {
        name: 'Apple Brasil',
        // Valid CNPJ (mod-11 checksum), punctuated as ML sends it — exercises
        // the punctuation-strip fix (see this module's header doc).
        identification: { type: 'CNPJ', number: '11.222.333/0001-81' },
        taxes: {
          inscriptions: { state_registration: '30703088534' },
          taxpayer_type: { description: 'Contribuinte' },
        },
        address: {
          street_name: 'Nicolau de Marcos',
          street_number: '05',
          city_name: 'Bom Jardim',
          comment: null,
          neighborhood: 'Jardim Ornelas',
          state: { name: 'Rio de Janeiro' },
          zip_code: '28660000',
          country_id: 'BR',
          ...addressOverrides,
        },
        ...overrides,
      },
    },
    seller: { cust_id: '999' },
  } as unknown as MlBillingInfo;
}

function shipmentWithReceiverAddress(receiver_address: Record<string, unknown> | null): MlShipment {
  return {
    id: 555,
    order_id: 987654321,
    status: 'delivered',
    receiver_address,
  } as unknown as MlShipment;
}

/**
 * The 18 `EnderecoImportFields` slots at fixed, fully-populated values — a test
 * overrides only what it cares about. The defaults are the tuple every golden
 * vector below is computed over, so changing one re-keys those vectors.
 */
function enderecoFields(overrides: Partial<EnderecoImportFields> = {}): EnderecoImportFields {
  return {
    idExterno: null,
    cep: '01310100',
    logradouro: 'Rua Teste',
    numero: '123',
    bairro: 'Centro',
    complemento: null,
    codigoMunicipio: null,
    cidade: 'São Paulo',
    estado: UF_SIGLA.SP,
    cPais: null,
    pais: null,
    nome: null,
    cpf_cnpj: null,
    rg: null,
    ie: null,
    imun: null,
    email: null,
    telefone: null,
    ...overrides,
  };
}

/** Narrows a mapper's `| null` return without a non-null assertion. */
function requireFields(fields: EnderecoImportFields | null): EnderecoImportFields {
  if (fields == null) throw new Error('the fixture must produce an endereço');
  return fields;
}

/* --------------------------------------------------------------------------- */

describe('billingInfoToClienteFields', () => {
  it('maps a CPF buyer (name + last_name joined, digits-only cpf_cnpj)', () => {
    const fields = billingInfoToClienteFields(cpfBillingInfo());
    expect(fields).toEqual({
      tipo: '0',
      nome: 'Maria Silva',
      cpf_cnpj: '52998224725',
      idEstrangeiro: null,
      ie: null,
      telefone: null,
      email: null,
    });
  });

  it('maps a CNPJ buyer, ie = state_registration when taxpayer is a contribuinte', () => {
    const fields = billingInfoToClienteFields(cnpjBillingInfo());
    expect(fields.tipo).toBe('1');
    expect(fields.nome).toBe('Apple Brasil');
    expect(fields.cpf_cnpj).toBe('11222333000181');
    expect(fields.ie).toBe('30703088534');
  });

  // Every spelling ML has been seen to send. The exact-match this replaced
  // caught only the first one; the rest silently fell through to
  // `state_registration` (null for a não-contribuinte), which the NF-e reader
  // then classifies as ISENTO — a wrong classification SEFAZ accepts.
  it.each([
    'Não contribuinte',
    'NÃO CONTRIBUINTE',
    'Nao contribuinte',
    'não  contribuinte',
    '  Não Contribuinte  ',
  ])(
    'CNPJ taxpayer_type %j stores the canonical token, ignoring state_registration',
    (description) => {
      const fields = billingInfoToClienteFields(
        cnpjBillingInfo({
          taxes: {
            inscriptions: { state_registration: '30703088534' },
            taxpayer_type: { description },
          },
        }),
      );
      expect(fields.ie).toBe(IE_SENTINELA.naoContribuinte);
      expect(fields.ie).toBe('NAO CONTRIBUINTE');
    },
  );

  it('stores a real state_registration unchanged', () => {
    const fields = billingInfoToClienteFields(
      cnpjBillingInfo({
        taxes: {
          inscriptions: { state_registration: '110.042.490.114' },
          taxpayer_type: { description: 'Contribuinte' },
        },
      }),
    );
    expect(fields.ie).toBe('110.042.490.114');
  });

  it('falls back to state_registration when taxpayer_type is absent', () => {
    const fields = billingInfoToClienteFields(
      cnpjBillingInfo({
        taxes: { inscriptions: { state_registration: '30703088534' }, taxpayer_type: null },
      }),
    );
    expect(fields.ie).toBe('30703088534');
  });

  it('throws MlBillingInfoUnsupportedError for an identification.type other than CPF/CNPJ', () => {
    expect(() =>
      billingInfoToClienteFields(cpfBillingInfo({ identification: { type: 'DNI', number: 'X' } })),
    ).toThrow(MlBillingInfoUnsupportedError);
  });
});

describe('billingInfoToEnderecoFields', () => {
  it('builds the endereço from the billing address, resolving the state NAME to a UF code', () => {
    const fields = billingInfoToEnderecoFields(cpfBillingInfo());
    expect(fields).toEqual({
      idExterno: null,
      cep: '01310100',
      logradouro: 'Rua das Flores',
      numero: '50',
      bairro: 'Centro',
      complemento: 'apto 12',
      codigoMunicipio: null,
      cidade: 'São Paulo',
      estado: UF_SIGLA.SP,
      cPais: null,
      pais: null,
      nome: null,
      cpf_cnpj: null,
      rg: null,
      ie: null,
      imun: null,
      email: null,
      telefone: null,
    } satisfies EnderecoImportFields);
  });

  it('returns null when the billing address has no zip code (canMakeAdress false)', () => {
    expect(billingInfoToEnderecoFields(cpfBillingInfo({}, { zip_code: '' }))).toBeNull();
    expect(billingInfoToEnderecoFields(cpfBillingInfo({}, { zip_code: null }))).toBeNull();
  });

  it('falls back to "S/N" for a missing street_number (legacy fallback text overflows numero max(10))', () => {
    const fields = billingInfoToEnderecoFields(cpfBillingInfo({}, { street_number: null }));
    expect(fields?.numero).toBe('S/N');
  });
});

describe('shipmentToEnderecoFields', () => {
  it('builds the endereço from the shipment receiver_address, truncating complement to 30 chars', () => {
    const longComplement = 'Referência: Edifício Queen Mary, portaria 2, sala dos fundos';
    const fields = shipmentToEnderecoFields(
      shipmentWithReceiverAddress({
        street: 'Rua Visconde de Ouro Preto',
        number: '51',
        complement: longComplement,
        neighborhood: { name: 'Consolação' },
        city: { name: 'São Paulo' },
        state: { name: 'São Paulo' },
        postal_code: '01303060',
      }),
    );
    expect(fields?.complemento).toBe(longComplement.slice(0, 30));
    expect(fields?.complemento).toHaveLength(30);
    expect(fields?.estado).toBe('SP');
    expect(fields?.cidade).toBe('São Paulo');
    expect(fields?.bairro).toBe('Consolação');
    expect(fields?.cep).toBe('01303060');
  });

  it("defaults complemento to 'Não informado' when the shipment has none", () => {
    const fields = shipmentToEnderecoFields(
      shipmentWithReceiverAddress({
        street: 'Rua X',
        number: '1',
        complement: null,
        neighborhood: { name: 'Bairro' },
        city: { name: 'Cidade' },
        state: { name: 'SP' },
        postal_code: '01310100',
      }),
    );
    expect(fields?.complemento).toBe('Não informado');
  });

  it('returns null when the shipment carries no receiver_address', () => {
    expect(shipmentToEnderecoFields(shipmentWithReceiverAddress(null))).toBeNull();
  });

  it('returns null when the shipment has no usable postal_code', () => {
    expect(
      shipmentToEnderecoFields(
        shipmentWithReceiverAddress({
          street: 'Rua X',
          number: '1',
          neighborhood: { name: 'Bairro' },
          city: { name: 'Cidade' },
          state: { name: 'SP' },
          postal_code: null,
        }),
      ),
    ).toBeNull();
  });
});

/**
 * GOLDEN VECTORS — hand-computed, byte-for-byte fixed. `makeEnderecoId` ports
 * `Endereco.generateUid` (models.dart:841-866), and a Flutter-written endereço
 * only resolves to the same doc id during dual-run while every hashed value
 * matches. Each 40-char hex is the lowercase SHA-1 of the documented UTF-8
 * preimage. Recompute any of them by pasting that preimage as the argument —
 * runs as-is in both bash and PowerShell (the inner quotes must stay single;
 * PowerShell strips double ones and `require` then picks up Node's WebCrypto
 * global instead of `node:crypto`):
 *   node -e "console.log(require('crypto').createHash('sha1').update(process.argv[1],'utf8').digest('hex'))" "enderecoRua Teste123Centro01310100São PauloSP"
 *   → 70d9018b0d28f930c549ce4ad9e164b3be7904d5 (the FULL vector below)
 * A change to any of these is a WIRE BREAK — an address that silently forks
 * into a second document — not a test to "fix".
 *
 * PROVENANCE: each digest is computed from the preimage in its comment, which
 * mirrors the concatenation documented at `orderCliente.ts:378-407`. They are
 * NOT captured from a running Dart build (`.old/` is unavailable), so they pin
 * THIS port's contract against accidental drift. The check that would prove
 * legacy parity outright is recomputing the id of a real Flutter-written
 * endereço doc — see #790.
 *
 * Two traps these exist to catch:
 *  - the hash order is NOT `enderecoSchema`'s declaration order — `cep` sits at
 *    position 7 here but 2 in the schema, and `complemento`/`bairro` are swapped,
 *    so deriving the id by iterating schema keys yields a different digest;
 *  - `parts.join('')` uses NO separator, so field boundaries are ambiguous and
 *    editing any fallback string moves the digest of every address hitting it.
 */

// sha1("enderecoRua Teste123Centro01310100São PauloSP")
const FULL = '70d9018b0d28f930c549ce4ad9e164b3be7904d5';
// sha1("enderecoRua Augusta1500Apt 42Consolação01305100São PauloSP")
const FULL_WITH_COMPLEMENTO = 'e9628f9968f54ac0c1a6f3270e73bff09134a30e';
// sha1("enderecoNAO INFORMADOS/NSEM BAIRRO01310100NAO INFORMADASP")
const BILLING_FALLBACKS = '303b2fa905f645c8ca70c704df4bea5c27d3b971';
// sha1("enderecoNão informadoS/NNão informadoNão informado01310100NAO INFORMADASP")
const SHIPMENT_FALLBACKS = 'f1726b875c77521560406cbb8b6a9d032367788b';
// sha1("enderecoNAO INFORMADOS/NSEM BAIRRO01310100NAO INFORMADAAC") — estado absent
const BILLING_FALLBACKS_UF_AC = 'c9a338fc57a5c098b31ed098fc95fc586db76b6f';
// sha1("enderecoNAO INFORMADONAO INFORMADOSEM BAIRRO01310100NAO INFORMADASP")
// — what legacy wrote for the billing payload below: numero "NAO INFORMADO".
const LEGACY_BILLING_NUMERO = '7e3e3a4ca54c301c9613c0c681f6180085d312c2';
// sha1("enderecoNão informadoNão informadoNão informadoNão informado01310100NAO INFORMADASP")
// — what legacy wrote for the shipment payload below: numero "Não informado".
const LEGACY_SHIPMENT_NUMERO = 'e1db83b989200c55f7123d5d12e326aa5eaecad4';

describe('makeEnderecoId', () => {
  it('matches a hand-computed sha1 vector over the exact legacy field order', () => {
    // 'endereco' + '' + 'Rua Teste' + '123' + '' + 'Centro' + '01310100' + '' +
    // 'São Paulo' + 'SP', then nine empty tail slots.
    expect(makeEnderecoId(enderecoFields())).toBe(FULL);
  });

  it('hashes a non-null complemento into the 5th slot, between numero and bairro', () => {
    // The slot the vector above leaves empty. Pins the complemento/bairro order,
    // which is SWAPPED relative to enderecoSchema's declaration order.
    expect(
      makeEnderecoId(
        enderecoFields({
          logradouro: 'Rua Augusta',
          numero: '1500',
          complemento: 'Apt 42',
          bairro: 'Consolação',
          cep: '01305100',
        }),
      ),
    ).toBe(FULL_WITH_COMPLEMENTO);
  });

  it('returns a 40-char lowercase hex digest', () => {
    expect(makeEnderecoId(enderecoFields())).toMatch(/^[0-9a-f]{40}$/);
  });

  it('changes when any single field changes (id is a function of the whole tuple)', () => {
    expect(makeEnderecoId(enderecoFields({ numero: '124' }))).not.toBe(
      makeEnderecoId(enderecoFields()),
    );
  });
});

/**
 * #790's "legacy-id compatibility" case. Every fallback string the two mappers
 * substitute is HASHED, so these vectors pin the fallback TEXT itself — driven
 * end-to-end from an ML payload through the real mapper rather than from a
 * hand-written field literal, which is what makes them bite.
 *
 * #789 replaces both mappers with one shared `forceEndereco`-faithful builder
 * and unifies the two fallback vocabularies. The moment it does, these go red.
 * That is the point: unifying them re-keys every address that hits a fallback,
 * so the port creates a DUPLICATE instead of recovering the doc the Flutter app
 * already wrote. The re-key has to be a decision, not a discovery.
 */
describe('makeEnderecoId — mapper fallback vectors', () => {
  /** Every optional billing address field absent — every fallback fires at once. */
  const emptyBillingAddress = {
    street_name: null,
    street_number: null,
    neighborhood: null,
    comment: null,
    city_name: null,
  };

  const billingFallbackFields = () =>
    requireFields(billingInfoToEnderecoFields(cpfBillingInfo({}, emptyBillingAddress)));

  const shipmentFallbackFields = () =>
    requireFields(
      shipmentToEnderecoFields(
        shipmentWithReceiverAddress({ postal_code: '01310100', state: { name: 'SP' } }),
      ),
    );

  it('pins the billing fallbacks: NAO INFORMADO / S/N / SEM BAIRRO / NAO INFORMADA', () => {
    const fields = billingFallbackFields();
    expect(fields).toMatchObject({
      logradouro: 'NAO INFORMADO',
      numero: 'S/N',
      bairro: 'SEM BAIRRO',
      complemento: null,
      cidade: 'NAO INFORMADA',
      estado: UF_SIGLA.SP,
    });
    expect(makeEnderecoId(fields)).toBe(BILLING_FALLBACKS);
  });

  it('pins the shipment fallbacks: Não informado ×3 / S/N / NAO INFORMADA', () => {
    const fields = shipmentFallbackFields();
    expect(fields).toMatchObject({
      logradouro: 'Não informado',
      numero: 'S/N',
      // Unlike billing, the shipment mapper fills complemento rather than
      // leaving it null (models.dart:5332) — a hashed slot, so it re-keys too.
      complemento: 'Não informado',
      bairro: 'Não informado',
      cidade: 'NAO INFORMADA',
    });
    expect(makeEnderecoId(fields)).toBe(SHIPMENT_FALLBACKS);
  });

  it('the two mappers disagree, so the SAME empty address forks by which one built it', () => {
    // `applyEnderecoStep` (orderImport.ts) tries billing first and falls back to
    // the shipment. An order whose billing address later becomes unusable is
    // re-keyed onto a second endereço purely by that fallback — this asserts the
    // hazard exists today; #789's unification is what removes it.
    expect(makeEnderecoId(billingFallbackFields())).not.toBe(
      makeEnderecoId(shipmentFallbackFields()),
    );
  });

  it('pins resolveUf(null) → AC: an address with no estado folds into the AC bucket', () => {
    const fields = requireFields(
      billingInfoToEnderecoFields(cpfBillingInfo({}, { ...emptyBillingAddress, state: null })),
    );
    expect(fields.estado).toBe(UF_SIGLA.AC);
    expect(makeEnderecoId(fields)).toBe(BILLING_FALLBACKS_UF_AC);
  });

  it("numero's 'S/N' is a KNOWN, accepted dual-run fork — not legacy's digest", () => {
    // orderCliente.ts:55-59: legacy's numero fallback was the 13-char
    // "NAO INFORMADO" / "Não informado", which overflows enderecoSchema.numero's
    // max(10), so this port substitutes 'S/N'. The two constants are what legacy
    // would have written for these exact payloads (derived from that documented
    // text, not from a Dart run). So a número-less address DOES resolve to a
    // different doc than the Flutter app's — a real, accepted duplicate, pinned
    // here so the deviation stays deliberate. #789 owns whether to keep it.
    expect(makeEnderecoId(billingFallbackFields())).not.toBe(LEGACY_BILLING_NUMERO);
    expect(makeEnderecoId(shipmentFallbackFields())).not.toBe(LEGACY_SHIPMENT_NUMERO);
  });
});

describe('findOrCreateCliente', () => {
  const baseFields: ClienteImportFields = {
    tipo: TIPO_CLIENTE.pessoaFisica,
    nome: 'Maria Silva',
    cpf_cnpj: '52998224725',
    idEstrangeiro: null,
    ie: null,
    telefone: null,
    email: null,
  };

  it('creates a new cliente, stamping timestamp + ultimaModificacao with nowMs', async () => {
    const fake = new FakeDb();
    const result = await findOrCreateCliente(db(fake), baseFields, NOW_MS);
    expect(result.created).toBe(true);

    const stored = fake.storedDoc('clientes', result.clienteId);
    expect(stored).toMatchObject({
      tipo: '0',
      nome: 'Maria Silva',
      cpf_cnpj: '52998224725',
      timestamp: NOW_MS,
      ultimaModificacao: NOW_MS,
    });
  });

  it('dedups by cpf_cnpj (digits-only equality)', async () => {
    const fake = new FakeDb();
    fake.seed('clientes', 'cli-1', { nome: 'Maria Silva', cpf_cnpj: '52998224725', tipo: '0' });

    const result = await findOrCreateCliente(db(fake), baseFields, NOW_MS);
    expect(result).toEqual({ clienteId: 'cli-1', created: false });
  });

  it('dedups by idEstrangeiro when cpf_cnpj is absent', async () => {
    const fake = new FakeDb();
    fake.seed('clientes', 'cli-2', { nome: 'John Doe', idEstrangeiro: 'PASSPORT123', tipo: '2' });

    const result = await findOrCreateCliente(
      db(fake),
      {
        ...baseFields,
        cpf_cnpj: null,
        idEstrangeiro: 'PASSPORT123',
        tipo: TIPO_CLIENTE.estrangeiro,
      },
      NOW_MS,
    );
    expect(result).toEqual({ clienteId: 'cli-2', created: false });
  });

  it('dedups by telefone (either wire shape, via telefoneQueryShapes)', async () => {
    const fake = new FakeDb();
    // Stored in the raw 10/11-digit shape the live Flutter app writes.
    fake.seed('clientes', 'cli-3', { nome: 'Ana', telefone: '11999998888', tipo: '0' });

    const result = await findOrCreateCliente(
      db(fake),
      { ...baseFields, cpf_cnpj: null, telefone: '11999998888' },
      NOW_MS,
    );
    expect(result).toEqual({ clienteId: 'cli-3', created: false });
  });

  it('dedups by email as the last resort', async () => {
    const fake = new FakeDb();
    fake.seed('clientes', 'cli-4', { nome: 'Bea', email: 'bea@example.com', tipo: '0' });

    const result = await findOrCreateCliente(
      db(fake),
      { ...baseFields, cpf_cnpj: null, email: 'bea@example.com' },
      NOW_MS,
    );
    expect(result).toEqual({ clienteId: 'cli-4', created: false });
  });

  it('update path patches ONLY the changed fields, leaving others untouched', async () => {
    const fake = new FakeDb();
    fake.seed('clientes', 'cli-5', {
      nome: 'Maria Silva Antiga',
      cpf_cnpj: '52998224725',
      tipo: '0',
      email: 'old@example.com',
      observacoesInternas: 'nota interna preservada',
    });

    const result = await findOrCreateCliente(
      db(fake),
      { ...baseFields, nome: 'Maria Silva Nova Sobrenome', email: 'new@example.com' },
      NOW_MS,
    );
    expect(result).toEqual({ clienteId: 'cli-5', created: false });

    const stored = fake.storedDoc('clientes', 'cli-5');
    expect(stored?.nome).toBe('Maria Silva Nova Sobrenome');
    expect(stored?.email).toBe('new@example.com');
    expect(stored?.ultimaModificacao).toBe(NOW_MS);
    // Untouched fields survive the merge unchanged — the whole point of a
    // targeted patch over a full-document rewrite.
    expect(stored?.observacoesInternas).toBe('nota interna preservada');
    expect(stored?.cpf_cnpj).toBe('52998224725');
  });

  it('never lets a lone-word new name overwrite an existing multi-word name', async () => {
    const fake = new FakeDb();
    fake.seed('clientes', 'cli-6', {
      nome: 'Maria Silva Santos',
      cpf_cnpj: '52998224725',
      tipo: '0',
    });

    await findOrCreateCliente(db(fake), { ...baseFields, nome: 'Maria' }, NOW_MS);

    const stored = fake.storedDoc('clientes', 'cli-6');
    expect(stored?.nome).toBe('Maria Silva Santos');
  });

  it('does not write at all when nothing changed', async () => {
    // NOTE: `nome` MUST be '' here — `shouldUpdateName` (ported faithfully
    // from legacy's `_shouldUpdateName`) only ever returns `false` for a
    // non-empty name when the NEW name is a lone word AND the OLD name is
    // multi-word; a same-VALUE multi-word name still returns `true` (legacy
    // always treats a supplied nome as fresh-enough to reassert). So a
    // genuinely no-op update needs an empty `nome` plus every other field
    // either `null` (inert — the update guards are all `!= null`) or
    // exactly matching the stored value (`tipo`, which has no null guard).
    const fake = new FakeDb();
    fake.seed('clientes', 'cli-7', {
      nome: 'Maria Silva',
      cpf_cnpj: '52998224725',
      tipo: '0',
      ie: null,
      email: null,
      telefone: null,
      idEstrangeiro: null,
    });

    const result = await findOrCreateCliente(db(fake), { ...baseFields, nome: '' }, NOW_MS);
    expect(result).toEqual({ clienteId: 'cli-7', created: false });

    const stored = fake.storedDoc('clientes', 'cli-7');
    expect(stored?.ultimaModificacao).toBeUndefined();
    expect(stored?.nome).toBe('Maria Silva');
  });
});

describe('ensureEndereco', () => {
  const path = 'clientes/cli-1/enderecos';
  const fields = enderecoFields();

  it('creates the endereço at the deterministic id under clientes/{clienteId}/enderecos', async () => {
    const fake = new FakeDb();
    const id = await ensureEndereco(db(fake), 'cli-1', fields);
    expect(id).toBe(makeEnderecoId(fields));
    expect(fake.storedDoc(path, id)).toMatchObject({
      logradouro: 'Rua Teste',
      cep: '01310100',
      estado: 'SP',
    });
  });

  it('is idempotent: a second call at the same fields returns the same id without throwing', async () => {
    const fake = new FakeDb();
    const first = await ensureEndereco(db(fake), 'cli-1', fields);
    const second = await ensureEndereco(db(fake), 'cli-1', fields);
    expect(second).toBe(first);
  });

  it('recovers a PRE-EXISTING doc instead of duplicating it', async () => {
    // The real dual-run case: the doc was written earlier — by a prior import or
    // by the still-running Flutter app — so unlike the idempotency test above,
    // not both writes happen here. `create` must hit ALREADY_EXISTS and return.
    const fake = new FakeDb();
    const id = makeEnderecoId(fields);
    fake.seed(path, id, { ...fields, timestamp: 1_700_000_000_000 });

    expect(await ensureEndereco(db(fake), 'cli-1', fields)).toBe(id);
    expect(fake.docs(path).size).toBe(1);
  });

  it('leaves the existing doc untouched — operator edits and unknown legacy keys survive', async () => {
    const fake = new FakeDb();
    const id = makeEnderecoId(fields);
    // An operator edited `complemento` in apps/web after the import (editing a
    // field does not move the doc id), and the Flutter writer left behind a key
    // this port never writes.
    const existing = {
      ...fields,
      complemento: 'Deixar com o porteiro',
      idEnderecoLegado: 'flutter-4711',
    };
    fake.seed(path, id, { ...existing });

    await ensureEndereco(db(fake), 'cli-1', fields);

    expect(fake.storedDoc(path, id)).toStrictEqual(existing);
    // The sharp `create` → `set` detector: `enderecoCollection.parse` injects
    // `timestamp: null` (enderecoSchema's default, endereco.ts:144), so a write
    // that landed on the existing doc would introduce a key the seed never had.
    expect(fake.storedDoc(path, id)).not.toHaveProperty('timestamp');
  });

  it('lands on a SECOND document when a field differs', async () => {
    // The pure-function twin of this only proves two ids differ; this proves
    // `ensureEndereco` actually writes two documents.
    const fake = new FakeDb();
    const baseId = await ensureEndereco(db(fake), 'cli-1', fields);
    const otherId = await ensureEndereco(db(fake), 'cli-1', enderecoFields({ numero: '124' }));

    expect(otherId).not.toBe(baseId);
    expect(fake.docs(path).size).toBe(2);
  });
});
