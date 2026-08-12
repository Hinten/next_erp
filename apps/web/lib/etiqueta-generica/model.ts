import { getDoc, getDocs, type DocumentReference, type Firestore } from 'firebase/firestore';
import {
  INTEGRACAO_FRETE,
  ESTADO_NFE,
  INTEGRACAO_FRETE_LABELS,
  type Cliente,
  type Endereco,
  type Filial,
  type FreteDoPedido,
  type Integracao,
  type IntFrete,
  type IntegracaoFrete,
  type Pedido,
} from '@delfrance/schemas';

import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { nfeCollection } from '@/lib/data/nfeCollection';

/**
 * The flat model the generic (10×15cm) shipping label renders from — the
 * client-side port of the data-loading half of the Flutter
 * `EtiquetaFreteGenericaPDF` constructor
 * (`.old/lib/despacho/pages/emitirOuImprimirFrete.dart:611-655`), which
 * dereferenced the pedido's cliente / endereço / recebedor / NF-e / (reverse)
 * filial-sede on the fly.
 *
 * Everything reads through the shared `dereferenceOuterRef` + the typed
 * `defineCollection` handles, so Firestore rules enforce tenancy on every
 * read. No server hop — this runs in the browser; independent reads fan out
 * with `Promise.all`.
 */

/** A minimal address for the label (subset of `Endereco`). */
export interface EtiquetaGenericaAddress {
  readonly logradouro: string | null;
  readonly numero: string | null;
  readonly complemento: string | null;
  readonly bairro: string | null;
  readonly cidade: string | null;
  readonly uf: string | null;
  readonly cep: string | null;
}

/** A person block (cliente / recebedor) for the label. */
export interface EtiquetaGenericaPessoa {
  readonly nome: string | null;
  readonly telefone: string | null;
  readonly cpfCnpj: string | null;
}

export interface EtiquetaGenericaModel {
  /** `Pedido {numero}`. */
  readonly title: string;
  /** The freight integration label (its `nome`, else the tipo label). */
  readonly subTitle: string | null;
  readonly pedidoNumero: string | null;
  /** Numeração of the latest aprovada NF-e, or null. */
  readonly nfeNumero: number | null;
  /** Chave of the latest aprovada NF-e, or null. */
  readonly nfeChave: string | null;
  readonly ehReverso: boolean;
  readonly cliente: EtiquetaGenericaPessoa | null;
  /** Delivery address — SUPPRESSED (null) for retiradaNaLoja. */
  readonly endereco: EtiquetaGenericaAddress | null;
  readonly recebedor: EtiquetaGenericaPessoa | null;
  /** Filial-sede address, present only on a reverse (return) shipment. */
  readonly enderecoReverso: EtiquetaGenericaAddress | null;
  /** One-line volumes summary (`"2 volume(s) · 3,5 kg"`), or null. */
  readonly volumesResumo: string | null;
}

/** Dereference an opaque outer ref and read it (untyped — raw wire data). */
async function readRef<T>(db: Firestore, outerRef: unknown): Promise<T | null> {
  const ref: DocumentReference | null = dereferenceOuterRef(db, outerRef);
  if (!ref) return null;
  const snap = await getDoc(ref);
  return snap.exists() ? (snap.data() as T) : null;
}

function toAddress(e: Endereco | null): EtiquetaGenericaAddress | null {
  if (!e) return null;
  return {
    logradouro: e.logradouro,
    numero: e.numero,
    complemento: e.complemento,
    bairro: e.bairro,
    cidade: e.cidade,
    uf: e.estado,
    cep: e.cep,
  };
}

function toPessoa(c: Cliente | null): EtiquetaGenericaPessoa | null {
  if (!c) return null;
  return { nome: c.nome, telefone: c.telefone, cpfCnpj: c.cpf_cnpj };
}

/**
 * Latest aprovada / EPEC-aprovada NF-e of a pedido carrying a chave — the same
 * pick as `nfeFlow.resolveAprovadaNfe`, but keeping `numeracao` for the label's
 * "NFe nº". Returns null when there's no authorized NF-e.
 */
async function resolveLatestAprovadaNfe(
  db: Firestore,
  pedidoId: string,
): Promise<{ numero: number; chave: string | null } | null> {
  const snap = await getDocs(nfeCollection.ref(db, { pedidoId }));
  const authorized = snap.docs
    .map((d) => d.data())
    .filter((n) => n.estado === ESTADO_NFE.aprovada || n.estado === ESTADO_NFE.epecAprovado)
    .sort((a, b) => (b.ultima_modificacao ?? 0) - (a.ultima_modificacao ?? 0));
  const first = authorized[0];
  if (first === undefined) return null;
  return { numero: first.numeracao, chave: first.chave };
}

/** Total volumes + gross weight as one label line, or null when absent. */
function volumesResumo(frete: FreteDoPedido): string | null {
  const volumes = frete.volumes;
  if (!volumes || volumes.length === 0) return null;
  const qtd = volumes.reduce((sum, v) => sum + (v.quantidade ?? 1), 0);
  const peso = volumes.reduce((sum, v) => sum + (v.pesoBruto ?? 0), 0);
  const partes = [`${qtd} volume(s)`];
  if (peso > 0) partes.push(`${peso.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} kg`);
  return partes.join(' · ');
}

/**
 * Filial-sede address behind a reverse shipment: pedido → integração →
 * filial → `sede`. Two sequential reads (each needs the previous doc).
 */
async function resolveFilialSede(
  db: Firestore,
  pedido: Pedido,
): Promise<EtiquetaGenericaAddress | null> {
  const integracao = await readRef<Integracao>(db, pedido.integracaoPedidoOuterRef);
  if (!integracao) return null;
  const filial = await readRef<Filial>(db, integracao.filialIntegracaoPedidoOuterRef);
  return toAddress(filial?.sede ?? null);
}

function subTitleFor(intFrete: { tipo: IntegracaoFrete; data: IntFrete }): string | null {
  const nome = intFrete.data.nome?.trim();
  if (nome) return nome;
  return INTEGRACAO_FRETE_LABELS[intFrete.tipo] ?? null;
}

/**
 * Resolve a pedido + its frete into the {@link EtiquetaGenericaModel}. The
 * delivery address is omitted for retiradaNaLoja (pickup — no address to
 * print); a reverse shipment additionally resolves the filial sede as the
 * return target. Independent reads fan out with `Promise.all`.
 */
export async function buildEtiquetaGenericaModel(
  db: Firestore,
  pedido: Pedido,
  pedidoId: string,
  frete: FreteDoPedido,
  intFrete: { id: string; tipo: IntegracaoFrete; data: IntFrete },
): Promise<EtiquetaGenericaModel> {
  const isRetirada = intFrete.tipo === INTEGRACAO_FRETE.retiradaNaLoja;

  const [cliente, endereco, recebedor, nfe, enderecoReverso] = await Promise.all([
    readRef<Cliente>(db, pedido.clientePedidoOuterRef),
    // Retirada na loja has no delivery address to print (the customer picks up).
    isRetirada ? Promise.resolve(null) : readRef<Endereco>(db, frete.enderecoFreteOuterReference),
    readRef<Cliente>(db, frete.clienteRecebedorOuterReference),
    resolveLatestAprovadaNfe(db, pedidoId),
    // Reverse shipment prints the filial sede as the delivery target.
    frete.ehReverso ? resolveFilialSede(db, pedido) : Promise.resolve(null),
  ]);

  return {
    title: `Pedido ${pedido.numero ?? pedidoId}`,
    subTitle: subTitleFor(intFrete),
    pedidoNumero: pedido.numero,
    nfeNumero: nfe?.numero ?? null,
    nfeChave: nfe?.chave ?? null,
    ehReverso: frete.ehReverso,
    cliente: toPessoa(cliente),
    endereco: toAddress(endereco),
    recebedor: toPessoa(recebedor),
    enderecoReverso,
    volumesResumo: volumesResumo(frete),
  };
}
