'use client';

import { useState } from 'react';
import { ActionIcon, TextInput, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconRefresh } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import type { FieldConfig, FieldRenderProps } from '@delfrance/ui';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { gerarSkuUnico } from '@/lib/produtos/skuUnico';

/** SKU text input with a "generate unique SKU" button (refresh icon). */
function SkuField(props: FieldRenderProps) {
  const [generating, setGenerating] = useState(false);

  async function handleGenerate() {
    setGenerating(true);
    try {
      const sku = await gerarSkuUnico(getFirebaseFirestore());
      if (sku) props.onChange(sku);
      else notifications.show({ color: 'red', message: 'Não foi possível gerar um SKU único.' });
    } catch (err) {
      if (err instanceof FirebaseError) {
        notifications.show({
          color: 'red',
          message: 'Não foi possível verificar a unicidade do SKU. Tente novamente.',
        });
      } else {
        throw err;
      }
    } finally {
      setGenerating(false);
    }
  }

  return (
    <TextInput
      label={props.label}
      description={props.hint}
      value={(props.value as string | null) ?? ''}
      onChange={(e) => props.onChange(e.currentTarget.value === '' ? null : e.currentTarget.value)}
      onBlur={props.onBlur}
      disabled={props.disabled}
      error={props.error}
      rightSection={
        <Tooltip label="Gerar SKU único">
          <ActionIcon
            variant="subtle"
            onClick={handleGenerate}
            loading={generating}
            disabled={props.disabled}
            aria-label="Gerar SKU único"
          >
            <IconRefresh size={16} />
          </ActionIcon>
        </Tooltip>
      }
    />
  );
}

/** `renderInput` for the `sku` field — mountable from the produto ObjectView. */
export const skuRenderInput: FieldConfig['renderInput'] = (props) => <SkuField {...props} />;
