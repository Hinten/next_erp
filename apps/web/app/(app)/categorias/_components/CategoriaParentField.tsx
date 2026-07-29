'use client';

import { useEffect } from 'react';
import { FirebaseError } from 'firebase/app';
import { getDocFromServer, type DocumentReference } from 'firebase/firestore';
import { idFromRef } from '@delfrance/schemas';
import type { FieldRenderProps } from '@delfrance/ui';
import { CollectionSelect } from '@/components/collection-select/CollectionSelect';
import { categoriaCollection } from '@/lib/data/categoriaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { parentBreadcrumbFromDoc } from '@/lib/categorias/nomeCompleto';

type Props = FieldRenderProps & {
  /** Doc ids hidden from the option list (self + descendants on edit). */
  excludeIds?: string[];
  /**
   * Called whenever the resolved parent breadcrumb changes (including clear).
   * The page keeps the latest value in a ref for `deriveOnSave`.
   */
  onParentBreadcrumbChange: (breadcrumb: string | null) => void;
};

/**
 * Parent-category picker bound to `categoriaPaiOuterRef`. Loads the parent's
 * materialized breadcrumb on every selection so `deriveOnSave` can build
 * `nomeCompleto` without async work.
 */
export function CategoriaParentField({
  value,
  onChange,
  onBlur,
  label,
  hint,
  disabled,
  error,
  excludeIds,
  onParentBreadcrumbChange,
  name,
}: Props) {
  const db = getFirebaseFirestore();

  // When the form loads an existing parent (edit), resolve the breadcrumb once.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (value == null || value === '') {
        if (!cancelled) onParentBreadcrumbChange(null);
        return;
      }
      if (typeof value !== 'string') return;
      const id = idFromRef(value);
      if (!id) {
        if (!cancelled) onParentBreadcrumbChange(null);
        return;
      }
      try {
        const snap = await getDocFromServer(
          categoriaCollection.docRef(db, {}, id) as DocumentReference,
        );
        if (cancelled) return;
        onParentBreadcrumbChange(parentBreadcrumbFromDoc(snap.exists() ? snap.data() : null));
      } catch (err) {
        if (err instanceof FirebaseError) {
          if (!cancelled) onParentBreadcrumbChange(null);
          return;
        }
        throw err;
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [value, db, onParentBreadcrumbChange]);

  return (
    <CollectionSelect
      collection={categoriaCollection}
      labelField="nome"
      searchFields={['nome', 'nomeCompleto']}
      optionHintField="nomeCompleto"
      fieldName={name}
      label={label}
      hint={hint}
      disabled={disabled}
      error={error}
      value={value}
      excludeIds={excludeIds}
      onBlur={onBlur}
      onChange={(next) => {
        void (async () => {
          if (next == null || next === '') {
            onParentBreadcrumbChange(null);
            onChange(null);
            return;
          }
          const raw = typeof next === 'string' ? next : String(next);
          const id = idFromRef(raw);
          if (!id) {
            onParentBreadcrumbChange(null);
            onChange(next);
            return;
          }
          try {
            const snap = await getDocFromServer(
              categoriaCollection.docRef(db, {}, id) as DocumentReference,
            );
            onParentBreadcrumbChange(parentBreadcrumbFromDoc(snap.exists() ? snap.data() : null));
          } catch (err) {
            if (err instanceof FirebaseError) {
              onParentBreadcrumbChange(null);
            } else {
              throw err;
            }
          }
          onChange(next);
        })();
      }}
    />
  );
}
