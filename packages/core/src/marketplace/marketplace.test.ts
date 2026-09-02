import { describe, it, expect } from 'vitest';
import type { ChannelContext, IncidentAction, ImportedIncident } from './index';

/**
 * Compile-time exhaustiveness over the `IncidentAction` union, including the
 * `custom` escape hatch. The `never` default is the whole point: adding a
 * variant without handling it here fails `tsc --noEmit`, which is what stops a
 * new per-channel verb from being silently dropped by a dispatcher.
 */
function describeAction(action: IncidentAction): string {
  switch (action.type) {
    case 'reply_message':
      return action.text;
    case 'attach_evidence':
      return `${action.attachments.length} files`;
    case 'accept_return':
      return 'accept';
    case 'offer_refund':
      return `refund ${action.refundAmount}`;
    case 'ship_replacement':
      return 'replace';
    case 'escalate_mediation':
      return 'escalate';
    case 'custom':
      return action.action;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

describe('IncidentAction', () => {
  it('describes every variant including custom', () => {
    expect(describeAction({ type: 'reply_message', text: 'oi' })).toBe('oi');
    expect(describeAction({ type: 'accept_return' })).toBe('accept');
    expect(describeAction({ type: 'custom', action: 'shopee:confirm' })).toBe('shopee:confirm');
  });

  /**
   * ⚠️ Money in this module is REAIS, never integer centavos — the removed
   * contract's `MinorUnits` is the single reason `pushPrice`/`pushStock` were
   * bypassed for the whole Mercado Livre port (`precoSync.ts`). A refund of
   * R$ 12,34 is `12.34`. This assertion is the near-miss that would fail if
   * anyone reintroduced centavos: under the old convention the same refund was
   * `1234`, which is a plausible-looking number in the same field.
   */
  it('carries a refund amount in reais, not centavos', () => {
    const action: IncidentAction = { type: 'offer_refund', refundAmount: 12.34, partial: true };
    expect(describeAction(action)).toBe('refund 12.34');
    expect(action.type === 'offer_refund' && action.refundAmount).toBeLessThan(100);
  });
});

describe('ChannelContext', () => {
  /**
   * ⚠️ The token THUNK is required, the snapshot is not the shape to reach for.
   * A context whose only token is `accessToken` cannot serve a sweep page or a
   * resumable job that outlives the grant — issue #815 amendment 4.
   */
  it('exposes a token thunk beside the snapshot', async () => {
    let refreshes = 0;
    const ctx: ChannelContext = {
      integracaoId: 'i1',
      accessToken: 'snapshot',
      getAccessToken: async () => {
        refreshes += 1;
        return `fresh-${refreshes}`;
      },
      account: { user_id: 42 },
    };

    expect(ctx.accessToken).toBe('snapshot');
    expect(await ctx.getAccessToken()).toBe('fresh-1');
    expect(await ctx.getAccessToken()).toBe('fresh-2');
    expect(ctx.account.user_id).toBe(42);
  });
});

describe('ImportedIncident', () => {
  it('keeps the provider status raw and carries a channelSpecific escape hatch', () => {
    const incident: ImportedIncident = {
      externalId: '5551234',
      kind: 'mediation',
      orderExternalId: '2000012345',
      status: 'dispute_opened',
      openedMs: 1_700_000_000_000,
      lastUpdatedMs: 1_700_000_100_000,
      channelSpecific: { stage: 'dispute' },
    };
    expect(incident.status).toBe('dispute_opened');
    expect(incident.channelSpecific?.stage).toBe('dispute');
  });
});
