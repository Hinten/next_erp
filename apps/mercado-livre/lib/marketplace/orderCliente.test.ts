import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { MlBillingInfo, MlShipment } from '@delfrance/integrations-mercado-livre';
import {
  ENDERECO_FALLBACKS,
  IE_SENTINELA,
  UF_SIGLA,
  TIPO_CLIENTE,
  type EnderecoBuildOutcome,
} from '@delfrance/schemas';

import {
  type ClienteImportFields,
  type EnderecoImportFields,
  MlBillingInfoUnsupportedError,
  billingInfoToClienteFields,
  billingInfoToEnderecoFields,
  ensureEndereco,
  makeEnderecoId,
  shipmentToEnderecoFields,
} from './orderCliente';

/** Narrow an adapter's outcome to its fields, failing loudly on anything else. */
function fieldsOf(outcome: EnderecoBuildOutcome): EnderecoImportFields {
  if (outcome.kind === 'sem-cep') throw new Error(`esperava um endereço, veio 'sem-cep'`);
  return outcome.fields;
}

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

/** The LEGACY placement: a top-level `receiver_address` with legacy leaf names. */
function shipmentWithReceiverAddress(receiver_address: unknown): MlShipment {
  return {
    id: 555,
    order_id: 987654321,
    status: 'delivered',
    receiver_address,
  } as unknown as MlShipment;
}

/**
 * The `x-format-new` placement: `destination.shipping_address`, with every leaf
 * renamed (#957). Nothing in this file used to exercise it — the fixture above
 * is an `as unknown as` cast, so the whole suite would have stayed green while
 * every ML pedido silently lost its address and stranded short of `pago`.
 */
function shipmentComDestination(shipping_address: unknown): MlShipment {
  return {
    id: 555,
    status: 'delivered',
    destination: { receiver_name: 'Fulana', shipping_address },
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
    const fields = fieldsOf(billingInfoToEnderecoFields(cpfBillingInfo()));
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

  it('reports sem-cep when the billing address has no zip code (canMakeAdress false)', () => {
    expect(billingInfoToEnderecoFields(cpfBillingInfo({}, { zip_code: '' })).kind).toBe('sem-cep');
    expect(billingInfoToEnderecoFields(cpfBillingInfo({}, { zip_code: null }))).toEqual({
      kind: 'sem-cep',
      cepRaw: null,
    });
  });

  it('falls back to "S/N" for a missing street_number (legacy fallback text overflows numero max(10))', () => {
    const fields = fieldsOf(
      billingInfoToEnderecoFields(cpfBillingInfo({}, { street_number: null })),
    );
    expect(fields.numero).toBe('S/N');
  });

  it('recovers instead of discarding when the state name is unmappable', () => {
    // The pre-#789 port returned null here and `applyEnderecoStep` silently
    // dropped the endereço, stranding the pedido short of `pago` forever.
    const outcome = billingInfoToEnderecoFields(
      cpfBillingInfo({}, { state: { id: 'BR-SP', name: 'Sao Paulo' } }),
    );
    expect(outcome.kind).toBe('uf-desconhecida');
    expect(fieldsOf(outcome).logradouro).toBe('Rua das Flores');
  });
});

describe('shipmentToEnderecoFields', () => {
  it('builds the endereço from destination.shipping_address (x-format-new)', () => {
    const fields = fieldsOf(
      shipmentToEnderecoFields(
        shipmentComDestination({
          street_name: 'Rua Visconde de Ouro Preto',
          street_number: '51',
          comment: 'Apto 42',
          neighborhood: { name: 'Consolação' },
          city: { name: 'São Paulo' },
          state: { name: 'São Paulo' },
          zip_code: '01303060',
        }),
      ),
    );
    expect(fields.cep).toBe('01303060');
    expect(fields.logradouro).toBe('Rua Visconde de Ouro Preto');
    expect(fields.numero).toBe('51');
    expect(fields.complemento).toBe('Apto 42');
    expect(fields.bairro).toBe('Consolação');
    expect(fields.cidade).toBe('São Paulo');
    expect(fields.estado).toBe(UF_SIGLA.SP);
  });

  it('truncates the new-format `comment` to 30 chars, like the legacy `complement`', () => {
    const longo = 'Referência: Edifício Queen Mary, portaria 2, sala dos fundos';
    const fields = fieldsOf(
      shipmentToEnderecoFields(shipmentComDestination({ zip_code: '01303060', comment: longo })),
    );
    expect(fields.complemento).toBe(longo.slice(0, 30));
    expect(fields.complemento).toHaveLength(30);
  });

  it('builds the endereço from the LEGACY receiver_address, truncating complement to 30 chars', () => {
    const longComplement = 'Referência: Edifício Queen Mary, portaria 2, sala dos fundos';
    const fields = fieldsOf(
      shipmentToEnderecoFields(
        shipmentWithReceiverAddress({
          street: 'Rua Visconde de Ouro Preto',
          number: '51',
          complement: longComplement,
          neighborhood: { name: 'Consolação' },
          city: { name: 'São Paulo' },
          state: { name: 'São Paulo' },
          postal_code: '01303060',
        }),
      ),
    );
    expect(fields.complemento).toBe(longComplement.slice(0, 30));
    expect(fields.complemento).toHaveLength(30);
    expect(fields.estado).toBe(UF_SIGLA.SP);
    expect(fields.cidade).toBe('São Paulo');
    expect(fields.bairro).toBe('Consolação');
    expect(fields.cep).toBe('01303060');
  });

  it('leaves complemento null when the shipment has none', () => {
    // Legacy pre-filled 'Não informado' here (models.dart:5332), which meant
    // forceEndereco's own fallbacks never fired on the shipment path. Unified —
    // see the deviations docblock: this DOES re-key `makeEnderecoId` for
    // shipment-sourced addresses, which is a known, accepted cost.
    const fields = fieldsOf(
      shipmentToEnderecoFields(
        shipmentWithReceiverAddress({
          street: 'Rua X',
          number: '1',
          complement: null,
          neighborhood: { name: 'Bairro' },
          city: { name: 'Cidade' },
          state: { name: 'SP' },
          postal_code: '01310100',
        }),
      ),
    );
    expect(fields.complemento).toBeNull();
  });

  it("uses forceEndereco's fallback text, not the shipment path's own", () => {
    const fields = fieldsOf(
      shipmentToEnderecoFields(
        shipmentWithReceiverAddress({
          street: null,
          number: null,
          neighborhood: null,
          city: null,
          state: { name: 'SP' },
          postal_code: '01310100',
        }),
      ),
    );
    expect(fields.logradouro).toBe(ENDERECO_FALLBACKS.logradouro);
    expect(fields.bairro).toBe(ENDERECO_FALLBACKS.bairro);
    expect(fields.cidade).toBe(ENDERECO_FALLBACKS.cidade);
    expect(fields.numero).toBe(ENDERECO_FALLBACKS.numero);
  });

  it('reports sem-cep when the shipment carries no receiver_address', () => {
    expect(shipmentToEnderecoFields(shipmentWithReceiverAddress(null))).toEqual({
      kind: 'sem-cep',
      cepRaw: null,
    });
  });

  it('reports sem-cep when the shipment has no usable postal_code', () => {
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
      ).kind,
    ).toBe('sem-cep');
  });

  it('parses receiver_address instead of trusting it — a malformed shape does not throw', () => {
    // `receiver_address` is untyped on MlShipment, and the schemas either side
    // of it are `.passthrough()` (#810 validated the webhook body's NAMED
    // fields, not its unknown ones), so anything can land here.
    for (const lixo of [42, 'Rua X, 1', [], { city: 'São Paulo' }, { state: 'SP' }]) {
      expect(() => shipmentToEnderecoFields(shipmentWithReceiverAddress(lixo))).not.toThrow();
    }
    const fields = fieldsOf(
      shipmentToEnderecoFields(
        // number where a string belongs, and a scalar where an object belongs
        shipmentWithReceiverAddress({ number: 51, city: 'São Paulo', postal_code: '01310100' }),
      ),
    );
    expect(fields.numero).toBe('51');
    expect(fields.cidade).toBe(ENDERECO_FALLBACKS.cidade);
  });

  it('degrades ONE unusable name-holder, not the whole endereço', () => {
    // `city` as a bare string used to be recovered by a `.catch(null)` wrapping
    // the whole object. Normalising it to null before validation keeps the
    // damage local: the address still builds, with the city falling back.
    const fields = fieldsOf(
      shipmentToEnderecoFields(
        shipmentWithReceiverAddress({
          street: 'Rua Visconde de Ouro Preto',
          number: '51',
          city: 'São Paulo',
          neighborhood: { name: 'Consolação' },
          state: { name: 'SP' },
          postal_code: '01303060',
        }),
      ),
    );
    expect(fields.cidade).toBe(ENDERECO_FALLBACKS.cidade);
    expect(fields.logradouro).toBe('Rua Visconde de Ouro Preto');
    expect(fields.bairro).toBe('Consolação');
    expect(fields.estado).toBe(UF_SIGLA.SP);
  });

  it.each([42, 'Rua X, 1', [], true])(
    'treats a non-object receiver_address (%j) as no address, not as an error',
    (lixo) => {
      // The ONE remaining way the parse can fail. `null` is the honest answer —
      // there is no address in that payload — and the caller's `sem-cep` is
      // logged with the order id by applyEnderecoStep, so nothing is silent.
      expect(shipmentToEnderecoFields(shipmentWithReceiverAddress(lixo))).toEqual({
        kind: 'sem-cep',
        cepRaw: null,
      });
    },
  );
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
// Since #789 unified the two fallback vocabularies onto `ENDERECO_FALLBACKS`,
// this is BOTH mappers' digest for a fallback-only address — see the
// `both mappers now agree` case below.
const UNIFIED_FALLBACKS = '303b2fa905f645c8ca70c704df4bea5c27d3b971';
// sha1("enderecoNão informadoS/NNão informadoNão informado01310100NAO INFORMADASP")
// — what the shipment path produced BEFORE #789 unified it, i.e. what the
// still-running Flutter writer produces for this payload. Pinned as a
// `.not.toBe` so the accepted dual-run fork stays visible, the same way
// LEGACY_*_NUMERO below pin theirs.
const LEGACY_SHIPMENT_FALLBACKS = 'f1726b875c77521560406cbb8b6a9d032367788b';
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
 * #789 has now landed: both mappers are adapters over one shared
 * `buildEnderecoForcado`, and the two fallback vocabularies are unified onto
 * `ENDERECO_FALLBACKS`. This block was written to go red at exactly that moment,
 * because unifying them re-keys every address that hits a fallback — the port
 * creates a DUPLICATE instead of recovering the doc the Flutter app already
 * wrote, and that had to be a decision rather than a discovery.
 *
 * The decision was taken and is recorded in `orderCliente.ts`'s header (the
 * unified-fallback deviation): one text for one meaning is worth the divergence,
 * and `ensureEndereco` creates without overwriting, so the cost is a duplicate
 * document and never a lost one. These vectors are re-baselined onto the unified
 * vocabulary to match, and the pre-#789 shipment digest is kept as
 * `LEGACY_SHIPMENT_FALLBACKS` — asserted `.not.toBe` — so the accepted fork
 * stays pinned instead of being deleted along with the knowledge of it.
 *
 * The BILLING vectors are unchanged: `ENDERECO_FALLBACKS` is the billing
 * vocabulary, so only the shipment path moved.
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
    fieldsOf(billingInfoToEnderecoFields(cpfBillingInfo({}, emptyBillingAddress)));

  const shipmentFallbackFields = () =>
    fieldsOf(
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
    expect(makeEnderecoId(fields)).toBe(UNIFIED_FALLBACKS);
  });

  it('pins the shipment fallbacks: now the SAME unified vocabulary as billing', () => {
    const fields = shipmentFallbackFields();
    expect(fields).toMatchObject({
      logradouro: 'NAO INFORMADO',
      numero: 'S/N',
      // Pre-#789 the shipment mapper pre-filled complemento with 'Não informado'
      // (models.dart:5332) before force ever saw it; it now passes the raw value
      // through, so an absent complement stays null. A hashed slot, so this alone
      // re-keys the address.
      complemento: null,
      bairro: 'SEM BAIRRO',
      cidade: 'NAO INFORMADA',
      estado: UF_SIGLA.SP,
    });
    expect(makeEnderecoId(fields)).toBe(UNIFIED_FALLBACKS);
  });

  it('the shipment fallback address no longer hashes to what Flutter writes for it', () => {
    // The accepted dual-run cost of the unification: the still-running Flutter
    // writer keys this same payload on the pre-#789 digest, so the port creates a
    // SECOND endereço rather than recovering that one. `ensureEndereco` creates
    // without overwriting, so it is a duplicate document, never a lost one.
    expect(makeEnderecoId(shipmentFallbackFields())).not.toBe(LEGACY_SHIPMENT_FALLBACKS);
  });

  it('both mappers now agree, so an empty address no longer forks by which one built it', () => {
    // `applyEnderecoStep` (orderImport.ts) tries billing first and falls back to
    // the shipment. Before #789 that fallback alone re-keyed the order onto a
    // second endereço; unifying the vocabularies is what removed the hazard, and
    // this is the assertion that holds it removed.
    expect(makeEnderecoId(billingFallbackFields())).toBe(makeEnderecoId(shipmentFallbackFields()));
  });

  it('pins resolveUf(null) → AC: an address with no estado folds into the AC bucket', () => {
    const fields = fieldsOf(
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
    // here so the deviation stays deliberate. #789 kept it, and its header now
    // records why (the `numero` fallback-text deviation).
    expect(makeEnderecoId(billingFallbackFields())).not.toBe(LEGACY_BILLING_NUMERO);
    expect(makeEnderecoId(shipmentFallbackFields())).not.toBe(LEGACY_SHIPMENT_NUMERO);
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
