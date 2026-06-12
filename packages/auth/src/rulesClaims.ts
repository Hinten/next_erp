import { PERM } from './permissions';

/**
 * Per-domain rules claims. Firestore rules CEL has no bitwise operators, so
 * the 128-bit `permissions` BigInt claim (decimal string) is undecodable
 * inside rules. Alongside it we mint one small-int claim per PERM domain,
 * keyed `d_<domain>` (e.g. `d_cliente: 3`), where the value ORs the granted
 * actions below. Rules then test a single action bit with int64 math:
 * `(request.auth.token.get('d_cliente', 0) / 1) % 2 == 1`.
 *
 * The `permissions` claim stays the source of truth for app code (`hasPerm`);
 * these claims are a rules-only projection and must always be minted together
 * with it (see the 3 mint points: apps/integrations admin routes +
 * tools/test-fixtures grant-all-perms).
 */
export const ACTION_K = { read: 1, write: 2, delete: 4 } as const;

export type RulesClaimKey = `d_${keyof typeof PERM}`;

type PermDomain = keyof typeof PERM;
type PermAction = keyof typeof ACTION_K;

/**
 * Project a permission bitmask onto the per-domain rules claims. Domains with
 * no granted action are omitted — `token.get('d_x', 0)` in rules treats a
 * missing claim as 0, and omitting keeps the claims payload (1000-byte
 * platform limit) small.
 */
export function rulesClaimsFromBits(bits: bigint): Record<string, number> {
  const claims: Record<string, number> = {};
  for (const [domain, actions] of Object.entries(PERM) as [PermDomain, Record<string, bigint>][]) {
    let value = 0;
    for (const [action, bit] of Object.entries(actions)) {
      if ((bits & bit) === bit) value |= ACTION_K[action as PermAction];
    }
    if (value !== 0) claims[`d_${domain}`] = value;
  }
  return claims;
}

/**
 * Reverse map for the rules generator: which claim key + action constant
 * guards a given permission bit. Metas may reuse one bit across actions
 * (cargo/filial/usuario `delete: PERM_CONFIG_WRITE` → `{d_configuracoes, 2}`;
 * tokenMelEnv `read: PERM_FRETE_WRITE` → `{d_frete, 2}`) — bit identity
 * resolves those naturally. Throws on a bit outside PERM so a bad meta fails
 * at generate time, not as a silently-denied rule.
 */
export function rulesCheckForBit(bit: bigint): { claim: RulesClaimKey; k: number } {
  for (const [domain, actions] of Object.entries(PERM) as [PermDomain, Record<string, bigint>][]) {
    for (const [action, actionBit] of Object.entries(actions)) {
      if (actionBit === bit) {
        return { claim: `d_${domain}`, k: ACTION_K[action as PermAction] };
      }
    }
  }
  throw new Error(
    `Permission bit ${bit.toString()} (1n << ${bit === 0n ? '?' : bitIndex(bit)}n) is not in PERM — ` +
      'register the domain in packages/auth/src/permissions.ts before generating rules.',
  );
}

function bitIndex(bit: bigint): number {
  let index = 0;
  let v = bit;
  while (v > 1n) {
    v >>= 1n;
    index += 1;
  }
  return index;
}
