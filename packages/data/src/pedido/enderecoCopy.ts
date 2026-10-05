import type { Pedido } from '@delfrance/schemas';
import type { PedidoDocData, PedidoWriteOp } from './port';

const CLIENTE_REF_RE = /^documents\/clientes\/([^/]+)$/;
const ENDERECO_REF_RE = /^documents\/clientes\/([^/]+)\/enderecos\/([^/]+)$/;

export type PedidoEnderecoUso = 'fiscal' | 'entrega';

export interface PedidoEnderecoCopyEntry {
  sourceOuterRef: string;
  sourcePath: string;
  targetOuterRef: string;
  targetPath: string;
  usos: ReadonlyArray<PedidoEnderecoUso>;
}

/**
 * A confirmed, retry-stable address-copy plan. Target ids are minted before
 * the transaction so a Firestore retry always writes the same references.
 */
export interface PedidoEnderecoCopyPlan {
  clienteId: string;
  copies: ReadonlyArray<PedidoEnderecoCopyEntry>;
}

export interface PedidoEnderecoMismatch {
  uso: PedidoEnderecoUso;
  ownerClienteId: string;
  sourceOuterRef: string;
}

/** A confirmed source address disappeared before the atomic save committed. */
export class PedidoEnderecoOrigemAusenteError extends Error {
  constructor(readonly sourcePath: string) {
    super('O endereço selecionado não existe mais. Revise o pedido antes de salvar.');
    this.name = 'PedidoEnderecoOrigemAusenteError';
  }
}

function clienteIdFromCanonicalRef(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  return CLIENTE_REF_RE.exec(ref)?.[1] ?? null;
}

function parseCanonicalEnderecoRef(
  ref: unknown,
): { outerRef: string; path: string; ownerClienteId: string } | null {
  if (typeof ref !== 'string') return null;
  const match = ENDERECO_REF_RE.exec(ref);
  if (!match) return null;
  const [, ownerClienteId, enderecoId] = match;
  if (!ownerClienteId || !enderecoId) return null;
  return {
    outerRef: ref,
    path: `clientes/${ownerClienteId}/enderecos/${enderecoId}`,
    ownerClienteId,
  };
}

function enderecoRefForUso(values: Pedido, uso: PedidoEnderecoUso): unknown {
  if (uso === 'fiscal') return values.enderecoFiscalOuterRef;
  return values.freteInicial?.enderecoFreteOuterReference;
}

/**
 * Detect only unambiguous canonical cross-customer references. Missing clients
 * and legacy/non-canonical references are intentionally left untouched.
 */
export function detectarEnderecosDeOutroCliente(values: Pedido): PedidoEnderecoMismatch[] {
  const clienteId = clienteIdFromCanonicalRef(values.clientePedidoOuterRef);
  if (clienteId === null) return [];

  const mismatches: PedidoEnderecoMismatch[] = [];
  for (const uso of ['fiscal', 'entrega'] as const) {
    const parsed = parseCanonicalEnderecoRef(enderecoRefForUso(values, uso));
    if (parsed !== null && parsed.ownerClienteId !== clienteId) {
      mismatches.push({
        uso,
        ownerClienteId: parsed.ownerClienteId,
        sourceOuterRef: parsed.outerRef,
      });
    }
  }
  return mismatches;
}

/**
 * Build a copy plan, grouping fiscal + delivery when both point to the same
 * source. `newId` is called once per distinct source and never inside a tx.
 */
export function planejarCopiasDeEndereco(
  values: Pedido,
  newId: () => string,
): PedidoEnderecoCopyPlan | null {
  const clienteId = clienteIdFromCanonicalRef(values.clientePedidoOuterRef);
  if (clienteId === null) return null;

  const grouped = new Map<
    string,
    { sourceOuterRef: string; sourcePath: string; usos: PedidoEnderecoUso[] }
  >();
  for (const mismatch of detectarEnderecosDeOutroCliente(values)) {
    const parsed = parseCanonicalEnderecoRef(mismatch.sourceOuterRef);
    if (parsed === null) continue;
    const existing = grouped.get(parsed.path);
    if (existing) existing.usos.push(mismatch.uso);
    else {
      grouped.set(parsed.path, {
        sourceOuterRef: parsed.outerRef,
        sourcePath: parsed.path,
        usos: [mismatch.uso],
      });
    }
  }
  if (grouped.size === 0) return null;

  return {
    clienteId,
    copies: [...grouped.values()].map((source) => {
      const enderecoId = newId();
      const targetPath = `clientes/${clienteId}/enderecos/${enderecoId}`;
      return {
        ...source,
        targetPath,
        targetOuterRef: `documents/${targetPath}`,
      };
    }),
  };
}

/** Rewrite the pedido refs described by a previously confirmed plan. */
export function aplicarPlanoDeCopiaDeEndereco(
  values: Pedido,
  plan: PedidoEnderecoCopyPlan | null | undefined,
): Pedido {
  if (!plan) return values;
  let fiscalRef = values.enderecoFiscalOuterRef;
  let freteInicial = values.freteInicial;
  for (const copy of plan.copies) {
    if (copy.usos.includes('fiscal')) fiscalRef = copy.targetOuterRef;
    if (copy.usos.includes('entrega') && freteInicial) {
      freteInicial = { ...freteInicial, enderecoFreteOuterReference: copy.targetOuterRef };
    }
  }
  return { ...values, enderecoFiscalOuterRef: fiscalRef, freteInicial };
}

/**
 * Force rewritten refs into a partial edit patch, even when the original
 * address controls were not dirty (changing only the customer is sufficient).
 */
export function aplicarPlanoDeCopiaAoPatch(
  patch: Record<string, unknown>,
  values: Pedido,
  plan: PedidoEnderecoCopyPlan | null | undefined,
): Record<string, unknown> {
  if (!plan) return patch;
  const rewritten = aplicarPlanoDeCopiaDeEndereco(values, plan);
  const next = { ...patch };
  if (plan.copies.some((copy) => copy.usos.includes('fiscal'))) {
    next.enderecoFiscalOuterRef = rewritten.enderecoFiscalOuterRef;
  }
  if (plan.copies.some((copy) => copy.usos.includes('entrega'))) {
    next.freteInicial = rewritten.freteInicial;
  }
  return next;
}

/** Unique source paths that must be read before any write in the transaction. */
export function enderecoCopyReadPaths(plan: PedidoEnderecoCopyPlan | null | undefined): string[] {
  return plan ? [...new Set(plan.copies.map((copy) => copy.sourcePath))] : [];
}

/**
 * Materialize address copies from the snapshots read inside the SAME
 * transaction as the pedido write. Address timestamps use milliseconds.
 */
export function buildEnderecoCopyOps(
  plan: PedidoEnderecoCopyPlan | null | undefined,
  docs: ReadonlyMap<string, PedidoDocData>,
  nowMicros: number,
): PedidoWriteOp[] {
  if (!plan) return [];
  const nowMillis = Math.floor(nowMicros / 1000);
  return plan.copies.map((copy) => {
    const source = docs.get(copy.sourcePath) ?? null;
    if (source === null) throw new PedidoEnderecoOrigemAusenteError(copy.sourcePath);
    return {
      type: 'set',
      path: copy.targetPath,
      data: { ...source, timestamp: nowMillis, ultimaModificacao: nowMillis },
    };
  });
}
