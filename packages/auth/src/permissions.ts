/**
 * Permission bitmask. Encoded as BigInt to support sets > 53 bits.
 * Custom claims store these as strings (`permissions: '0x...'` or decimal).
 *
 * Bits are grouped per domain. New domains take the next free byte.
 */
export const PERM = {
  cliente: {
    read: 1n << 0n,
    write: 1n << 1n,
    delete: 1n << 2n,
  },
  produto: {
    read: 1n << 8n,
    write: 1n << 9n,
    delete: 1n << 10n,
  },
  pedido: {
    read: 1n << 16n,
    write: 1n << 17n,
    delete: 1n << 18n,
  },
  pagamento: {
    read: 1n << 24n,
    write: 1n << 25n,
    delete: 1n << 26n,
  },
  nfe: {
    read: 1n << 32n,
    write: 1n << 33n,
    delete: 1n << 34n,
  },
  configuracoes: {
    read: 1n << 40n,
    write: 1n << 41n,
  },
  // Chat / atendimento — Conversa + Mensagem live in the same domain.
  chat: {
    read: 1n << 48n,
    write: 1n << 49n,
    delete: 1n << 50n,
  },
  // Integracao — canais de venda / integrações (Flutter `integracao`).
  // Already in use by `packages/schemas/src/integracao.ts` since launch;
  // registered here so the next free byte is unambiguous.
  integracao: {
    read: 1n << 56n,
    write: 1n << 57n,
    delete: 1n << 58n,
  },
  // Estoque — depósitos e operações de inventário.
  estoque: {
    read: 1n << 64n,
    write: 1n << 65n,
    delete: 1n << 66n,
  },
  // Fiscal — operações fiscais (CFOPs, configurações tributárias).
  fiscal: {
    read: 1n << 72n,
    write: 1n << 73n,
    delete: 1n << 74n,
  },
  // Lixeira — visualizar e restaurar itens excluídos (coleção `lixeira`).
  lixeira: {
    read: 1n << 80n,
    write: 1n << 81n,
    delete: 1n << 82n,
  },
} as const;

export function hasPerm(grantedClaim: string | undefined, requiredBit: bigint): boolean {
  if (!grantedClaim) return false;
  try {
    return (BigInt(grantedClaim) & requiredBit) === requiredBit;
  } catch (err) {
    if (err instanceof SyntaxError) {
      return false;
    }
    throw err;
  }
}
