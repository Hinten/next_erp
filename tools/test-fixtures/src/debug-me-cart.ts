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
const UA = process.env.MELHOR_ENVIO_USER_AGENT ?? 'Delfrance ERP (dev) debug';
const INT_ID = process.env.ME_DEBUG_INT_ID ?? 'mi1a0TfrBWM3fap6NZpC';
const PEDIDO_ID = process.env.ME_DEBUG_PEDIDO_ID ?? 'dev-frete-me-02';

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
      reverse: false,
      non_commercial: true,
      platform: 'Delfrance ERP',
      tags: [{ tag: `Pedido ${pedido.numero ?? PEDIDO_ID}` }],
    },
  };
}

async function postCart(token: string, payload: Record<string, unknown>) {
  const res = await fetch(`${ME_BASE}/api/v2/me/cart`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  return { status: res.status, body: body.slice(0, 500) };
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

  const fakeKey = '35200114200166000187550010000000015000000016'; // 44 digits, fake chave
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
  ];
}

async function main() {
  console.log(`[debug-me-cart] base=${ME_BASE} int=${INT_ID} pedido=${PEDIDO_ID}`);
  const token = await getAccessToken();
  const base = await buildBasePayload();
  const realChave = await getNfeChave(PEDIDO_ID);
  console.log(`[debug-me-cart] pedido NF-e chave: ${realChave ?? 'none'}`);
  console.log('[debug-me-cart] base payload:\n' + JSON.stringify(base, null, 2));

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
