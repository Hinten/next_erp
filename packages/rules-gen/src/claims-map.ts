import { rulesCheckForBit } from '@delfrance/auth';
import type { CollectionMetadata } from '@delfrance/schemas';

export interface ClaimCheck {
  claim: string;
  k: number;
}

export interface ResolvedPermissions {
  read: ClaimCheck;
  write: ClaimCheck;
  /** `null` means an explicit client deny, including the `su` claim. */
  delete: ClaimCheck | null;
}

/**
 * Resolve a meta's permission bits to the `d_*` claim checks the rules read.
 * Each bit must be a single PERM bit — composite masks would silently demand
 * an AND of domains the claims model can't express, so they fail generation.
 */
export function resolvePermissions(meta: CollectionMetadata): ResolvedPermissions {
  for (const [action, bit] of Object.entries(meta.permissions)) {
    if (action === 'delete' && bit === null) continue;
    if (bit === null) {
      throw new Error(`${meta.collectionPath}: only permissions.delete may be null`);
    }
    if (bit <= 0n || (bit & (bit - 1n)) !== 0n) {
      throw new Error(
        `${meta.collectionPath}: permissions.${action} must be a single PERM bit, got ${bit.toString()}`,
      );
    }
  }
  return {
    read: rulesCheckForBit(meta.permissions.read),
    write: rulesCheckForBit(meta.permissions.write),
    delete: meta.permissions.delete === null ? null : rulesCheckForBit(meta.permissions.delete),
  };
}
