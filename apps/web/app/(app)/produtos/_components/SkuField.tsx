'use client';

import { useState } from 'react';
import { ActionIcon, TextInput, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconRefresh } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import { getDocsFromServer } from 'firebase/firestore';
import { buildQuery, limit, whereEqual } from '@delfrance/data';
import type { FieldConfig, FieldRenderProps } from '@delfrance/ui';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

// Flutter parity (`produtoCadastro.dart:703-727`): a random ≤9-digit number,
// retried up to 10× until no produto already has that SKU.
const MAX_TRIES = 10;

async function generateUniqueSku(): Promise<string | null> {
  const db = getFirebaseFirestore();
  for (let i = 0; i < MAX_TRIES; i += 1) {
    const candidate = String(Math.floor(Math.random() * 999_999_999));
    // Server read (fail-closed): a cache-served empty result could let us mint a
    // SKU that already exists. A probe error means we can't guarantee
    // uniqueness, so it propagates to the caller as a generation failure.
    const snap = await getDocsFromServer(
      buildQuery(produtoCollection.ref(db, {}), [whereEqual('sku', candidate), limit(1)]),
    );
    if (snap.empty) return candidate;
  }
  return null;
}

/** SKU text input with a "generate unique SKU" button (refresh icon). */
function SkuField(props: FieldRenderProps) {
  const [generating, setGenerating] = useState(false);

  async function handleGenerate() {
    setGenerating(true);
    try {
      const sku = await generateUniqueSku();
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
