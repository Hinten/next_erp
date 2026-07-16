'use client';

/**
 * Read-only display block for big XML/JSON payload fields (`xml_enviado`,
 * `xml_retorno`) — a scrollable `<Code block>` with a pinned CopyIconButton.
 * Shared by the enviNfe detail ObjectView (via `xmlBlockRenderInput`) and the
 * `EventRoundtripHistory` accordion panels.
 *
 * `prettyJson` handles retornos persisted as a JSON-stringified parsed object:
 * parsed + re-indented when the value IS JSON, raw otherwise (only
 * `SyntaxError` is treated as "not JSON"; anything else rethrows). The
 * parse+stringify runs over multi-KB payloads, so it's memoized on
 * `(value, prettyJson)` instead of re-running every render.
 */
import { useMemo, type ReactNode } from 'react';
import { Code, Group, Stack, Text } from '@mantine/core';
import type { FieldRenderProps } from '@delfrance/ui';

import { CopyIconButton } from './CopyIconButton';

const MAX_HEIGHT = 360;

export interface XmlBlockProps {
  readonly label: string;
  readonly value: unknown;
  /** Try `JSON.parse` + pretty-print; fall back to the raw text on SyntaxError. */
  readonly prettyJson?: boolean;
}

export function XmlBlock({ label, value, prettyJson }: XmlBlockProps) {
  const display = useMemo(() => {
    const raw = typeof value === 'string' && value.length > 0 ? value : null;
    if (raw === null || !prettyJson) return raw;
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // Not JSON (e.g. a raw XML retorno) — show as-is.
      return raw;
    }
  }, [value, prettyJson]);

  return (
    <Stack gap={4}>
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" fw={500}>
          {label}
        </Text>
        {display !== null && (
          <CopyIconButton
            value={display}
            label="Copiar"
            ariaLabel={`Copiar ${label}`}
            position="left"
          />
        )}
      </Group>
      {display === null ? (
        <Text size="sm" c="dimmed">
          —
        </Text>
      ) : (
        <Code
          block
          fz={11}
          style={{
            maxHeight: MAX_HEIGHT,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {display}
        </Code>
      )}
    </Stack>
  );
}

/** `FieldConfig.renderInput` factory for schema-driven ObjectViews. */
export function xmlBlockRenderInput(opts?: {
  prettyJson?: boolean;
}): (props: FieldRenderProps) => ReactNode {
  function XmlBlockInput(props: FieldRenderProps) {
    return <XmlBlock label={props.label} value={props.value} prettyJson={opts?.prettyJson} />;
  }
  return XmlBlockInput;
}
