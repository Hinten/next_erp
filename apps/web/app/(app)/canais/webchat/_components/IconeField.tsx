'use client';

import { SegmentedControl } from '@mantine/core';
import { IconHeadset, IconMessageCircle, IconQuestionMark } from '@tabler/icons-react';
import { WEBCHAT_ICONE_LABELS, type WebchatIcone } from '@delfrance/schemas';
import type { FieldRenderProps } from '@delfrance/ui';

/**
 * 3-preset trigger-button icon picker. The legacy screen (`.old/lib/webchat/
 * pages/conta.dart`, per #558) offered exactly 3 FontAwesome presets; this app
 * renders the same choice with `@tabler/icons-react` (this repo's icon set —
 * see `apps/web`/`packages/ui` dependencies).
 */
const OPTIONS: ReadonlyArray<{ value: WebchatIcone; icon: typeof IconMessageCircle }> = [
  { value: 'mensagem', icon: IconMessageCircle },
  { value: 'duvida', icon: IconQuestionMark },
  { value: 'suporte', icon: IconHeadset },
];

export function IconeField({ value, onChange, disabled, error }: FieldRenderProps) {
  return (
    <SegmentedControl
      value={typeof value === 'string' ? value : 'mensagem'}
      onChange={onChange}
      disabled={disabled}
      color={error ? 'red' : undefined}
      data={OPTIONS.map(({ value: v, icon: Icon }) => ({
        value: v,
        label: (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon size={16} />
            {WEBCHAT_ICONE_LABELS[v]}
          </span>
        ),
      }))}
    />
  );
}
