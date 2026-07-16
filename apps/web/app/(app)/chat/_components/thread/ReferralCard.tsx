'use client';

import { Anchor, Card, Stack, Text } from '@mantine/core';
import type { Mensagem } from '@delfrance/schemas';
import { isHttpUrl } from '@/lib/chat/safeUrl';

/**
 * Click-to-WhatsApp referral card (`referral`, legacy `ReferralWidget`,
 * `mensagem.dart:633-690`): a compact card with the ad's headline/body and an
 * outbound link to the source. Rendered above the message body when a customer
 * arrived via a CTWA ad.
 *
 * `source_url`/`image_url` are advertiser-supplied — guarded through
 * {@link isHttpUrl} so a non-http(s) scheme can't smuggle an XSS payload.
 */
export function ReferralCard({ referral }: { referral: NonNullable<Mensagem['referral']> }) {
  const { headline, body } = referral;
  const sourceUrl = isHttpUrl(referral.source_url) ? referral.source_url : null;
  const imageUrl = isHttpUrl(referral.image_url) ? referral.image_url : null;
  const hasContent = headline || body || sourceUrl || imageUrl;
  if (!hasContent) return null;

  return (
    <Card withBorder radius="sm" p="xs" bg="var(--mantine-color-gray-0)" mb={4}>
      <Stack gap={2}>
        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
          Anúncio
        </Text>
        {headline && (
          <Text size="sm" fw={600} lineClamp={2}>
            {headline}
          </Text>
        )}
        {body && (
          <Text size="xs" c="dimmed" lineClamp={3}>
            {body}
          </Text>
        )}
        {imageUrl && (
          <Anchor href={imageUrl} target="_blank" rel="noopener noreferrer" size="xs">
            Ver imagem
          </Anchor>
        )}
        {sourceUrl && (
          <Anchor
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            size="xs"
            lineClamp={1}
          >
            {sourceUrl}
          </Anchor>
        )}
      </Stack>
    </Card>
  );
}
