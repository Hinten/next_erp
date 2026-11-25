'use client';

import { Badge, Tooltip } from '@mantine/core';
import type { MarketplaceCapabilities } from '@delfrance/schemas';

import { textoStatusCanal } from './textoStatusCanal';

/**
 * Marketplace implementation status, as defined by `implementado`.
 *
 * ⚠️ This used to read `pluginIdForTipo(tipo)` and show
 * `@delfrance/integrations-shopee` for a channel whose package was a 44-line
 * `throw` with no importer anywhere. It was a capability question wearing a
 * plugin-id costume, and it answered it wrong: "has a package" is not "works".
 * `MARKETPLACE_TIPO_CAPS` answers the real one (#815, ADR 0015).
 *
 * ⚠️ ONE copy, shared by the `/canais` index card and the per-channel panel
 * (#1430). Two components rendering the same judgement drift toward plausible
 * and read correct while disagreeing — the #1369 trap, verbatim.
 */
export function StatusCanalBadge({ caps }: { caps: MarketplaceCapabilities | null }) {
  const { dica } = textoStatusCanal(caps);
  if (caps === null) {
    return (
      <Tooltip label={dica}>
        <Badge variant="light" color="gray" size="xs">
          não-marketplace
        </Badge>
      </Tooltip>
    );
  }
  if (!caps.implementado) {
    return (
      <Tooltip label={dica}>
        <Badge variant="light" color="gray" size="xs">
          não implementado
        </Badge>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={dica}>
      <Badge variant="light" color="blue" size="xs">
        {caps.channel}
      </Badge>
    </Tooltip>
  );
}
