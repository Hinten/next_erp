import { db } from './admin';

/**
 * Debug the opaque Melhor Envio cart-insert 500
 * ("Houve um erro ao salvar o pedido no carrinho").
 *
 * Reproduces the etiqueta buy WITHOUT the UI: reads the connected integração's
 * token + the pedido data from Firestore, builds the same `POST /api/v2/me/cart`
 * payload the app sends, then POSTs a series of **variants** to ME sandbox to
 * bisect which field ME rejects. `/me/cart` only adds to the cart (no checkout
 * → no balance spent), so iterating is safe.
 *
 * Usage (from the repo root; same env as the seeds, incl. the Norton CA via
 * NODE_EXTRA_CA_CERTS so the ME HTTPS call passes):
 *   pnpm --filter @delfrance/test-fixtures debug:me-cart
 *   ME_DEBUG_INT_ID=<intId> ME_DEBUG_PEDIDO_ID=<pedidoId> pnpm ... debug:me-cart
 *
 * Defaults target the `teste` integração + `dev-frete-me-02` pedido used in the
 * manual test.
 */

const SANDBOX = (process.env.MELHOR_ENVIO_SANDBOX ?? 'true') !== 'false';
const ME_BASE = SANDBOX ? 'https://sandbox.melhorenvio.com.br' : 'https://www.melhorenvio.com.br';
// Generic default — set MELHOR_ENVIO_USER_AGENT to a real contact email if ME needs one.
const UA = process.env.MELHOR_ENVIO_USER_AGENT ?? 'next_erp (dev tooling)';
const INT_ID = process.env.ME_DEBUG_INT_ID ?? 'mi1a0TfrBWM3fap6NZpC';
const PEDIDO_ID = process.env.ME_DEBUG_PEDIDO_ID ?? 'dev-frete-me-02';
/**
 * Set ME_DEBUG_SP=1 to override BOTH addresses to intra-São Paulo capital. The
 * default route (Caxias do Sul RS → Rio RJ) only quotes Jadlog (service 3),
 * which demands an NF-e; a same-city SP→SP route surfaces Correios PAC/SEDEX,
 * which accept a `non_commercial` (declaração de conteúdo) shipment — so the
 * buy can succeed end-to-end without a real NF-e key.
 */
const SP_OVERRIDE = (process.env.ME_DEBUG_SP ?? '') !== '';
/**
 * Set ME_DEBUG_INSURANCE_DECLARED=1 to override `insurance_value` to the total
 * declared product value BEFORE the quote runs — so calculate AND every
 * cart-insert use the same value. ME requires, for a non_commercial (declaração
 * de conteúdo) shipment, that the insured value equals the declared product
 * total and matches the value used in the freight quotation. The seeded pedido's
 * `valor_assegurado` can differ from the declared product total — this forces
 * them to agree so that mismatch is ruled out as a cause.
 */
const INSURANCE_DECLARED = (process.env.ME_DEBUG_INSURANCE_DECLARED ?? '') !== '';

/* eslint-disable no-console */

import type { DocumentReference } from 'firebase-admin/firestore';

/** Resolve an outer ref (native ref, opaque {path}, or `documents/...` string). */
function resolveRef(value: unknown): DocumentReference | null {
  if (value == null) return null;
  if (typeof value === 'object' && 'path' in (value as Record<string, unknown>)) {
    const path = String((value as { path: unknown }).path);
    return db().doc(path.replace(/^documents\//, ''));
  }
  if (typeof value === 'string' && value.length > 0) {
    return db().doc(value.replace(/^documents\//, ''));
  }
  return null;
}

async function readRef<T = Record<string, unknown>>(value: unknown): Promise<T | null> {
  const ref = resolveRef(value);
  if (!ref) return null;
  const snap = await ref.get();
  return snap.exists ? (snap.data() as T) : null;
}

async function getAccessToken(): Promise<string> {
  const snap = await db().collection('int_frete').doc(INT_ID).collection('tokenMelEnv').get();
  const docs = snap.docs.map((d) => d.data() as { access_token?: string; expirationDate?: number });
  docs.sort((a, b) => (b.expirationDate ?? 0) - (a.expirationDate ?? 0));
  const token = docs[0]?.access_token;
  if (!token) throw new Error(`No tokenMelEnv for int_frete/${INT_ID} — is it connected?`);
  return token;
}

const cap = (s: string | null | undefined, n: number) => (s ?? '').slice(0, n).trim();

async function buildBasePayload(): Promise<Record<string, unknown>> {
  const intFrete = (await db().collection('int_frete').doc(INT_ID).get()).data() as
    | Record<string, unknown>
    | undefined;
  if (!intFrete) throw new Error(`int_frete/${INT_ID} not found`);
  const origem = intFrete.enderecoDeOrigem as Record<string, unknown> | null;
  const filial = await readRef<Record<string, unknown>>(intFrete.filialIntegracaoFreteOuterRef);

  const pedido = (await db().collection('pedidos').doc(PEDIDO_ID).get()).data() as
    | Record<string, unknown>
    | undefined;
  if (!pedido) throw new Error(`pedidos/${PEDIDO_ID} not found`);
  const frete = pedido.freteInicial as Record<string, unknown>;
  const dest = await readRef<Record<string, unknown>>(frete.enderecoFreteOuterReference);
  const cliente = await readRef<Record<string, unknown>>(pedido.clientePedidoOuterRef);

  const itensMap = (pedido.itens ?? {}) as Record<string, Record<string, unknown>[]>;
  const itens = Object.values(itensMap).flat();

  const service = Number(frete.externalOptionId);
  const destDoc = (dest?.cpf_cnpj ?? cliente?.cpf_cnpj ?? null) as string | null;
  const pj = (destDoc ?? '').replace(/\D/g, '').length === 14;
  const country = (v: unknown) =>
    /^[A-Za-z]{2}$/.test(String(v ?? '')) ? String(v).toUpperCase() : 'BR';

  return {
    service,
    from: {
      name: filial?.razaoSocial ?? '',
      phone: origem?.telefone ?? (filial?.sede as Record<string, unknown>)?.telefone ?? undefined,
      company_document: filial?.cnpj ?? undefined,
      state_register: filial?.ie ?? undefined,
      economic_activity_code: filial?.cnae ?? undefined,
      address: cap(origem?.logradouro as string, 39),
      number: origem?.numero ?? '',
      district: origem?.bairro ?? '',
      city: origem?.cidade ?? '',
      state_abbr: origem?.estado ?? '',
      country_id: country(origem?.cPais),
      postal_code: origem?.cep ?? '',
      note: '',
    },
    to: {
      name: dest?.nome ?? cliente?.nome ?? '',
      phone: dest?.telefone ?? cliente?.telefone ?? undefined,
      email: dest?.email ?? cliente?.email ?? undefined,
      ...(pj ? { company_document: destDoc } : { document: destDoc }),
      address: cap(dest?.logradouro as string, 39),
      number: dest?.numero ?? '',
      district: dest?.bairro ?? '',
      city: dest?.cidade ?? '',
      state_abbr: dest?.estado ?? '',
      country_id: country(dest?.cPais),
      postal_code: dest?.cep ?? '',
      note: '',
    },
    products: itens.map((it) => ({
      name: cap((it.nomeDeVenda ?? it.sku ?? 'Item') as string, 50),
      quantity: String(it.quantidade ?? 1),
      unitary_value: (Number(it.precoDeVenda ?? 0) - Number(it.descontoUnitario ?? 0)).toFixed(2),
    })),
    volumes: ((frete.volumes ?? []) as Record<string, unknown>[]).map((v) => {
      const d = (v.dimensoes ?? {}) as Record<string, unknown>;
      return {
        height: d.altura ?? 20,
        width: d.largura ?? 20,
        length: d.comprimento ?? 20,
        weight: v.pesoBruto ?? v.pesoLiquido ?? 1,
      };
    }),
    options: {
      insurance_value: Math.max(1, Number(frete.valor_assegurado ?? 0)),
      receipt: false,
      own_hand: false,
      collect: false,
      reverse: false,
      non_commercial: true,
      // ME's own plugin ALWAYS sends `invoice` as an object (key + number,
      // both null when there's no NF-e). Omitting it makes ME's save do
      // `options.invoice.key` on null → unhandled 500 ("Houve um erro ao
      // salvar o pedido no carrinho"). This is the likely root cause.
      invoice: { key: null, number: null },
      platform: 'Delfrance ERP',
      reminder: null,
      tags: [{ tag: `Pedido ${pedido.numero ?? PEDIDO_ID}` }],
    },
  };
}

async function postCart(token: string, payload: Record<string, unknown>, verbose = false) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': UA,
  };
  if (verbose) {
    const masked = `Bearer ${token.slice(0, 8)}…${token.slice(-6)} (len ${token.length})`;
    console.log('[postCart] request headers:', { ...headers, Authorization: masked });
  }
  const res = await fetch(`${ME_BASE}/api/v2/me/cart`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (verbose) {
    console.log(`[postCart] response status: ${res.status}`);
    console.log('[postCart] response headers:', Object.fromEntries(res.headers.entries()));
  }
  return { status: res.status, body: body.slice(0, 500) };
}

/** ME access tokens are JWTs (Laravel Passport) — decode the payload to read
 *  the GRANTED scopes. Definitive: does this token actually carry cart-write? */
function decodeTokenScopes(token: string): void {
  const parts = token.split('.');
  if (parts.length !== 3) {
    console.log(`[token] not a JWT (${parts.length} segment(s)) — cannot read granted scopes`);
    return;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as {
      scopes?: string[];
      exp?: number;
    };
    const scopes = payload.scopes ?? [];
    console.log(`[token] granted scopes (${scopes.length}): ${JSON.stringify(scopes)}`);
    if (payload.exp) console.log(`[token] expires: ${new Date(payload.exp * 1000).toISOString()}`);
    const need = ['cart-write', 'shipping-checkout', 'shipping-generate', 'shipping-print'];
    const missing = need.filter((s) => !scopes.includes(s));
    console.log(
      missing.length === 0
        ? '[token] ✅ has cart-write + shipping-checkout + generate + print'
        : `[token] ⚠️ MISSING scopes: ${missing.join(', ')} → re-authorize after enabling them on the ME app`,
    );
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    console.log('[token] JWT payload is not valid JSON — cannot read granted scopes');
  }
}

/** GET /me — confirms the token + reveals whether the account profile is
 *  complete (an incomplete sender profile is ME's #1 cause of the cart 500). */
async function inspectAccount(token: string): Promise<void> {
  const res = await fetch(`${ME_BASE}/api/v2/me`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': UA },
  });
  const text = await res.text();
  console.log(`\n=== account profile (GET /me) [${res.status}] ===\n${text.slice(0, 1000)}`);
}

/** Override both addresses to intra-São Paulo (keeps the fiscal identity). */
function applySpOverride(base: Record<string, unknown>): void {
  Object.assign(base.from as Record<string, unknown>, {
    address: 'Avenida Paulista',
    number: '1000',
    district: 'Bela Vista',
    city: 'São Paulo',
    state_abbr: 'SP',
    country_id: 'BR',
    postal_code: '01310100',
  });
  Object.assign(base.to as Record<string, unknown>, {
    address: 'Rua Voluntários da Pátria',
    number: '200',
    district: 'Santana',
    city: 'São Paulo',
    state_abbr: 'SP',
    country_id: 'BR',
    postal_code: '02011000',
  });
}

interface MeService {
  readonly id: number;
  readonly name: string;
  readonly company: string;
  readonly companyId: number | null;
  readonly price: string | null;
  readonly error: string | null;
}

/** List the carriers ME actually offers for the route (`/me/shipment/calculate`). */
async function calculate(token: string, base: Record<string, unknown>): Promise<MeService[]> {
  const opt = base.options as Record<string, unknown>;
  const insurance = Math.max(1, Number(opt.insurance_value ?? 1));
  const volumes = (base.volumes ?? []) as Record<string, unknown>[];
  const products = volumes.map((v, i) => ({
    id: String(i + 1),
    width: v.width,
    height: v.height,
    length: v.length,
    weight: v.weight,
    insurance_value: insurance,
    quantity: 1,
  }));
  const body = {
    from: { postal_code: (base.from as Record<string, unknown>).postal_code },
    to: { postal_code: (base.to as Record<string, unknown>).postal_code },
    products,
    options: { receipt: false, own_hand: false },
  };
  const res = await fetch(`${ME_BASE}/api/v2/me/shipment/calculate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.log(`[calculate] HTTP ${res.status}: ${text.slice(0, 300)}`);
    return [];
  }
  // A hand-run debug script whose whole job is printing what arrived, so it
  // widens rather than asserting — the shape below is a reading aid, not a
  // claim about Melhor Envio's response.
  const parsed = JSON.parse(text) as unknown as Array<{
    id: number;
    name: string;
    price?: string | null;
    error?: string | null;
    company?: { id?: number; name?: string };
  }>;
  return parsed.map((s) => ({
    id: s.id,
    name: s.name,
    companyId: s.company?.id ?? null,
    company: s.company?.name ?? '?',
    price: s.price ?? null,
    error: s.error ?? null,
  }));
}

interface MeAgency {
  readonly id: number;
  readonly name: string;
  readonly city: string;
}

/** List a carrier's drop-off agencies near the sender
 *  (`GET /api/v2/me/shipment/agencies`). The legacy app never sent `agency`,
 *  but ME may require it now for some carriers. */
async function listAgencies(
  token: string,
  company: number | null,
  state: string,
  city: string,
): Promise<MeAgency[]> {
  const url = new URL(`${ME_BASE}/api/v2/me/shipment/agencies`);
  if (company != null) url.searchParams.set('company', String(company));
  url.searchParams.set('country', 'BR');
  url.searchParams.set('state', state);
  url.searchParams.set('city', city);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': UA },
  });
  const text = await res.text();
  if (!res.ok) {
    console.log(`[agencies] HTTP ${res.status}: ${text.slice(0, 300)}`);
    return [];
  }
  if (text.trim().length === 0) {
    console.log('[agencies] empty response body');
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    console.log(`[agencies] non-JSON response: ${text.slice(0, 200)}`);
    return [];
  }
  // ME returns either a bare array or a paginated `{ data: [...] }` envelope.
  const list = Array.isArray(parsed) ? parsed : ((parsed as { data?: unknown }).data ?? []);
  if (!Array.isArray(list)) {
    console.log(`[agencies] unexpected shape: ${text.slice(0, 200)}`);
    return [];
  }
  return (
    list as Array<{ id: number; company?: { name?: string }; address?: { city?: string } }>
  ).map((a) => ({
    id: a.id,
    name: a.company?.name ?? String(a.id),
    city: a.address?.city ?? '?',
  }));
}

/** The pedido's authorized NF-e chave (the #209 path), or null. */
async function getNfeChave(pedidoId: string): Promise<string | null> {
  const snap = await db().collection('pedidos').doc(pedidoId).collection('nfev4').get();
  const auth = snap.docs
    .map((d) => d.data() as { estado?: string; chave?: string; ultima_modificacao?: string })
    .filter((n) => (n.estado === 'a' || n.estado === 'p') && n.chave)
    .sort((a, b) =>
      String(b.ultima_modificacao ?? '').localeCompare(String(a.ultima_modificacao ?? '')),
    );
  return auth[0]?.chave ?? null;
}

/**
 * ME's official docs example for POST /me/cart (verbatim values), as of the
 * 2026-04-06 DC-e change. The new `dce` object is the bit our payload lacks.
 * The example's invoice key is masked with `***`, so the verbatim variant will
 * fail invoice validation — but it shows whether the example STRUCTURE (with
 * `dce`) gets past the save that our payloads never reach.
 */
const ME_EXAMPLE_PAYLOAD: Record<string, unknown> = {
  service: 4,
  from: {
    name: 'Remetente',
    email: 'remetente@email.com',
    phone: '11912345678',
    document: '',
    company_document: '46867029000176',
    state_register: '',
    economic_activity_code: '4687701',
    address: 'Rua do Remetente',
    complement: '',
    number: '1234',
    district: 'Bairro do Remetente',
    city: 'Cidade do Remetente',
    postal_code: '09831510',
    state_abbr: 'SP',
  },
  to: {
    name: 'Destinatário',
    email: 'destinatario@email.com',
    phone: '41912345678',
    document: '05596752088',
    state_register: 'ISENTO',
    address: 'Rua do Destinatário',
    complement: '',
    number: '1234',
    district: 'Bairro do Destinatário',
    city: 'Cidade do Destinatário',
    postal_code: '11730000',
    country_id: 'BR',
    state_abbr: 'SP',
  },
  products: [
    { name: 'Teste 1', quantity: '1', unitary_value: '400' },
    { name: 'Teste 2', quantity: '1', unitary_value: '200' },
  ],
  volumes: [
    { height: 15, width: 30, length: 40, weight: 120 },
    { height: 4, width: 10, length: 10, weight: 0.1 },
  ],
  options: {
    platform: 'Minha Loja',
    reminder: 'Compra XYZ',
    insurance_value: 600,
    receipt: false,
    own_hand: false,
    reverse: false,
    dce: { key: '' },
    invoice: { key: '422404***1497000123400598762797110***653', xml_content: '' },
  },
};

/** Variants to bisect the cause. Each clones + mutates the base payload. */
function variants(
  base: Record<string, unknown>,
  realChave: string | null,
): { name: string; payload: Record<string, unknown> }[] {
  const clone = () => JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  const opt = (p: Record<string, unknown>) => p.options as Record<string, unknown>;

  const declared = ((base.products ?? []) as { unitary_value: string; quantity: string }[]).reduce(
    (s, p) => s + Number(p.unitary_value) * Number(p.quantity),
    0,
  );

  const fakeKey = '35260604520878000109550017999775571588392420'; // 44 digits, fake chave

  // Build options UP from the working minimal, on Correios PAC (service 1 —
  // accepts non_commercial, no NF-e confound). The first rung that 500s is the
  // option field ME chokes on.
  const minimalWith = (options: Record<string, unknown> | undefined) => {
    const p = clone();
    p.service = 1;
    if (options === undefined) delete p.options;
    else p.options = options;
    return p;
  };

  return [
    { name: 'base (app payload)', payload: clone() },
    {
      name: `#209 path — REAL NF-e chave from nfev4 (${realChave ?? 'NONE on this pedido'})`,
      payload: (() => {
        const p = clone();
        if (realChave) {
          opt(p).non_commercial = false;
          opt(p).invoice = { key: realChave };
        }
        return p;
      })(),
    },
    {
      name: 'non_commercial=false + invoice.key (fake chave)',
      payload: (() => {
        const p = clone();
        opt(p).non_commercial = false;
        opt(p).invoice = { key: fakeKey };
        return p;
      })(),
    },
    {
      name: `insurance_value = declared (${declared.toFixed(2)})`,
      payload: (() => {
        const p = clone();
        opt(p).insurance_value = Number(declared.toFixed(2));
        return p;
      })(),
    },
    {
      name: 'single product',
      payload: (() => {
        const p = clone();
        p.products = ((p.products as unknown[]) ?? []).slice(0, 1);
        return p;
      })(),
    },
    {
      name: 'drop from.state_register + economic_activity_code',
      payload: (() => {
        const p = clone();
        const f = p.from as Record<string, unknown>;
        delete f.state_register;
        delete f.economic_activity_code;
        return p;
      })(),
    },
    {
      name: 'drop emails',
      payload: (() => {
        const p = clone();
        delete (p.from as Record<string, unknown>).email;
        delete (p.to as Record<string, unknown>).email;
        return p;
      })(),
    },
    {
      // ME docs mark only service/from/to/products/volumes as required. If the
      // bare payload saves, something in `options` is the trigger.
      name: 'MINIMAL — no options at all',
      payload: (() => {
        const p = clone();
        delete p.options;
        return p;
      })(),
    },
    {
      // Strip the extras ME's plugin doesn't strictly need (tags/platform/
      // reminder/collect) — isolates a server choke on one of them.
      name: 'drop tags + platform + reminder + collect',
      payload: (() => {
        const p = clone();
        const o = opt(p);
        delete o.tags;
        delete o.platform;
        delete o.reminder;
        delete o.collect;
        return p;
      })(),
    },
    {
      // The account is a CPF (document_type "cpf"). Maybe the sandbox rejects a
      // CNPJ sender that isn't the account holder. Send the sender as the
      // account's own CPF instead.
      name: 'from as account CPF sender (37033594801)',
      payload: (() => {
        const p = clone();
        const f = p.from as Record<string, unknown>;
        delete f.company_document;
        delete f.state_register;
        delete f.economic_activity_code;
        f.document = '37033594801';
        return p;
      })(),
    },
    {
      // `12345678909` is the well-known sequential test CPF many BR systems
      // blacklist. Use the account's real (valid, non-blacklisted) CPF.
      name: 'recipient = real valid CPF (37033594801)',
      payload: (() => {
        const p = clone();
        (p.to as Record<string, unknown>).document = '37033594801';
        return p;
      })(),
    },
    {
      // Let ME fill the sender from the account default — isolates our `from`.
      name: 'omit from entirely (account default sender)',
      payload: (() => {
        const p = clone();
        delete p.from;
        return p;
      })(),
    },

    // --- options build-up ladder (Correios PAC, service 1) ---
    { name: 'LADDER 1: min + insurance(1)', payload: minimalWith({ insurance_value: 1 }) },
    { name: 'LADDER 2: min + insurance(480)', payload: minimalWith({ insurance_value: 480 }) },
    {
      name: 'LADDER 3: + receipt/own_hand/reverse',
      payload: minimalWith({
        insurance_value: 1,
        receipt: false,
        own_hand: false,
        reverse: false,
      }),
    },
    {
      name: 'LADDER 4: + non_commercial:true',
      payload: minimalWith({
        insurance_value: 1,
        receipt: false,
        own_hand: false,
        reverse: false,
        non_commercial: true,
      }),
    },
    {
      name: 'LADDER 5: + invoice {key:null,number:null}',
      payload: minimalWith({
        insurance_value: 1,
        receipt: false,
        own_hand: false,
        reverse: false,
        non_commercial: true,
        invoice: { key: null, number: null },
      }),
    },

    // --- DC-e hypothesis (the 2026-04-06 change) ---
    {
      // Our base + the new `dce` object → does the missing DC-e cause the 500?
      // Correios PAC (service 1, accepts non_commercial, no NF-e confound).
      name: 'DCE: base + dce:{key:""} (Correios PAC)',
      payload: minimalWith({
        insurance_value: Number(declared.toFixed(2)),
        receipt: false,
        own_hand: false,
        reverse: false,
        non_commercial: true,
        dce: { key: '' },
      }),
    },
    {
      // ME docs example, VERBATIM (service 4). Invoice key is masked (`***`) →
      // expect an invoice 422, but it proves the example reaches the save.
      name: 'ME docs example — VERBATIM (masked invoice key)',
      payload: JSON.parse(JSON.stringify(ME_EXAMPLE_PAYLOAD)) as Record<string, unknown>,
    },
    {
      // ME docs example structure but a non_commercial DC-e shipment (drop the
      // masked invoice) — the version that could actually SUCCEED.
      name: 'ME docs example — non_commercial + dce (no invoice)',
      payload: (() => {
        const p = JSON.parse(JSON.stringify(ME_EXAMPLE_PAYLOAD)) as Record<string, unknown>;
        const o = p.options as Record<string, unknown>;
        delete o.invoice;
        o.non_commercial = true;
        o.dce = { key: '' };
        return p;
      })(),
    },

    // --- Correios (service 1) — does an agency null/0/-1 let it through? ---
    {
      // The real test: Correios + a REAL NF-e chave (commercial shipment → no
      // DC-e needed). Only meaningful when the pedido has an authorized NF-e
      // (point ME_DEBUG_PEDIDO_ID at one that does).
      name: `Correios PAC + REAL NF-e chave (non_commercial:false) — ${realChave ?? 'NONE on this pedido'}`,
      payload: (() => {
        const p = clone();
        p.service = 1;
        if (realChave) {
          const o = p.options as Record<string, unknown>;
          o.non_commercial = false;
          o.invoice = { key: realChave };
        }
        return p;
      })(),
    },
    {
      // Correios (no agency needed) with the chave currently in `fakeKey` +
      // non_commercial:false. A real authorized NF-e → 201; an unknown/invalid
      // one → 422 on the invoice (which still proves Correios reaches NF-e
      // validation, i.e. past the agency/dce 500).
      name: `Correios PAC + invoice.key=fakeKey (non_commercial:false) — ${fakeKey}`,
      payload: (() => {
        const p = clone();
        p.service = 1;
        const o = p.options as Record<string, unknown>;
        o.non_commercial = false;
        o.invoice = { key: fakeKey };
        return p;
      })(),
    },
    {
      name: 'Correios PAC + agency:null',
      payload: (() => {
        const p = clone();
        p.service = 1;
        p.agency = null;
        return p;
      })(),
    },
    {
      name: 'Correios PAC + agency:0',
      payload: (() => {
        const p = clone();
        p.service = 1;
        p.agency = 0;
        return p;
      })(),
    },
    {
      name: 'Correios PAC + agency:-1',
      payload: (() => {
        const p = clone();
        p.service = 1;
        p.agency = -1;
        return p;
      })(),
    },
    {
      // The DCE variant 422'd "dce.key obrigatório" with an EMPTY key. Try a
      // placeholder 44-char key to see the NEXT error (or whether it passes).
      name: 'Correios PAC + dce:{key:<44-char placeholder>}',
      payload: minimalWith({
        insurance_value: Number(declared.toFixed(2)),
        receipt: false,
        own_hand: false,
        reverse: false,
        non_commercial: true,
        dce: { key: '0'.repeat(44) },
      }),
    },

    // --- Correios SEDEX (service 2) — same probes on the other Correios service ---
    {
      name: 'Correios SEDEX + base (non_commercial:true)',
      payload: (() => {
        const p = clone();
        p.service = 2;
        return p;
      })(),
    },
    {
      name: `Correios SEDEX + invoice.key=fakeKey (non_commercial:false) — ${fakeKey}`,
      payload: (() => {
        const p = clone();
        p.service = 2;
        const o = p.options as Record<string, unknown>;
        o.non_commercial = false;
        o.invoice = { key: fakeKey };
        return p;
      })(),
    },
    {
      name: 'Correios SEDEX + dce:{key:<44-char placeholder>}',
      payload: (() => {
        const p = clone();
        p.service = 2;
        const o = p.options as Record<string, unknown>;
        o.non_commercial = true;
        delete o.invoice;
        o.dce = { key: '0'.repeat(44) };
        return p;
      })(),
    },
  ];
}

async function main() {
  console.log(
    `[debug-me-cart] base=${ME_BASE} int=${INT_ID} pedido=${PEDIDO_ID} sp=${SP_OVERRIDE}`,
  );
  const token = await getAccessToken();
  decodeTokenScopes(token);
  await inspectAccount(token);
  const base = await buildBasePayload();
  if (SP_OVERRIDE) applySpOverride(base);
  if (INSURANCE_DECLARED) {
    const declared = (
      (base.products ?? []) as { unitary_value: string; quantity: string }[]
    ).reduce((s, p) => s + Number(p.unitary_value) * Number(p.quantity), 0);
    (base.options as Record<string, unknown>).insurance_value = Number(declared.toFixed(2));
    console.log(`[debug-me-cart] insurance_value → declared total ${declared.toFixed(2)}`);
  }
  const realChave = await getNfeChave(PEDIDO_ID);
  console.log(`[debug-me-cart] pedido NF-e chave: ${realChave ?? 'none'}`);
  console.log('[debug-me-cart] base payload:\n' + JSON.stringify(base, null, 2));

  // Which carriers does ME actually offer for this route? (Jadlog needs an
  // NF-e; Correios PAC/SEDEX accept a non_commercial declaração de conteúdo.)
  const from = (base.from as Record<string, unknown>).postal_code;
  const to = (base.to as Record<string, unknown>).postal_code;
  console.log(`\n=== available carriers (calculate ${from} → ${to}) ===`);
  const services = await calculate(token, base);
  for (const s of services) {
    const status = s.error ? `ERROR: ${s.error}` : `R$ ${s.price}`;
    console.log(`  service ${s.id} — ${s.company} ${s.name}: ${status}`);
  }

  // Try adding to cart with EACH quotable carrier, keeping non_commercial:true.
  // A ✅ here proves the buy works for at least one carrier without an NF-e.
  const quotable = services.filter((s) => s.error == null && s.price != null);
  console.log(
    `\n=== cart-insert per quotable carrier (non_commercial:true, ${quotable.length}) ===`,
  );
  let firstAttempt = true;
  for (const s of quotable) {
    const p = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    p.service = s.id;
    const r = await postCart(token, p, firstAttempt);
    firstAttempt = false;
    const ok = r.status >= 200 && r.status < 300;
    console.log(
      `\n=== ${ok ? '✅' : '❌'} [${r.status}] service ${s.id} (${s.company} ${s.name})\n${r.body}`,
    );
  }

  // Agency test — the legacy buy flow never sent `agency`, but internet reports
  // + ME's requirement changes suggest some carriers now need a drop-off agency.
  // For each carrier, list agencies near the sender and retry the cart with one.
  const fromBlock = base.from as Record<string, unknown>;
  const senderState = String(fromBlock.state_abbr ?? '');
  const senderCity = String(fromBlock.city ?? '');
  console.log(`\n=== cart-insert WITH agency (sender ${senderState}/${senderCity}) ===`);
  for (const s of quotable) {
    const agencies = await listAgencies(token, s.companyId, senderState, senderCity);
    const pick = agencies[0];
    console.log(
      `  ${s.company} ${s.name} (company ${s.companyId ?? '?'}): ${agencies.length} agencies` +
        (pick ? ` — using #${pick.id} (${pick.city})` : ' — none near sender'),
    );
    if (!pick) continue;
    const p = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    p.service = s.id;
    p.agency = pick.id;
    const r = await postCart(token, p);
    const ok = r.status >= 200 && r.status < 300;
    console.log(
      `=== ${ok ? '✅' : '❌'} [${r.status}] service ${s.id} (${s.company} ${s.name}) + agency ${pick.id}\n${r.body}`,
    );
  }

  console.log('\n=== field-bisection variants (saved service ' + base.service + ') ===');
  for (const v of variants(base, realChave)) {
    const r = await postCart(token, v.payload);
    const ok = r.status >= 200 && r.status < 300;
    console.log(`\n=== ${ok ? '✅' : '❌'} [${r.status}] ${v.name}\n${r.body}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
