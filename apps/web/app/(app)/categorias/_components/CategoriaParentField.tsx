'use client';

import { useEffect, useRef } from 'react';
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
 * Parent-category picker bound to `categoriaPaiOuterRef`. On pick, the
 * breadcrumb is set synchronously from the option meta (hint=`nomeCompleto`,
 * else label=`nome`) so a fast save cannot race a follow-up getDoc. On edit
 * load, a useEffect revalidates the breadcrumb from the server.
 *
 * Out-of-order `getDocFromServer` results are dropped via a monotonic request
 * token (`breadcrumbLoadSeqRef`) so a stale load cannot overwrite a newer
 * pick/clear.
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
  const breadcrumbLoadSeqRef = useRef(0);

  // When the form loads an existing parent (edit), resolve the breadcrumb.
  // On pick the sync path already set a breadcrumb — this revalidates it and
  // must not wipe it on transient Firebase errors. Each run takes a new request
  // token; stale completions are dropped when `seq !== breadcrumbLoadSeqRef`.
  useEffect(() => {
    const seq = ++breadcrumbLoadSeqRef.current;
    async function load() {
      if (value == null || value === '') {
        if (seq === breadcrumbLoadSeqRef.current) onParentBreadcrumbChange(null);
        return;
      }
      if (typeof value !== 'string') return;
      const id = idFromRef(value);
      if (!id) {
        if (seq === breadcrumbLoadSeqRef.current) onParentBreadcrumbChange(null);
        return;
      }
      try {
        const snap = await getDocFromServer(
          categoriaCollection.docRef(db, {}, id) as DocumentReference,
        );
        if (seq !== breadcrumbLoadSeqRef.current) return;
        if (!snap.exists()) return;
        onParentBreadcrumbChange(parentBreadcrumbFromDoc(snap.data()));
      } catch (err) {
        if (err instanceof FirebaseError) {
          // Keep any sync-resolved breadcrumb from the picker.
          return;
        }
        throw err;
      }
    }
    void load();
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
      onChange={(next, meta) => {
        // Bump the load token so any in-flight server revalidation for the
        // previous parent cannot overwrite the breadcrumb we set below.
        breadcrumbLoadSeqRef.current += 1;
        if (next == null || next === '') {
          onParentBreadcrumbChange(null);
          onChange(null);
          return;
        }
        // Sync path: set breadcrumb from the option's hint (nomeCompleto) or
        // label (nome) BEFORE the form value commits, so a fast save cannot
        // race an async getDoc and write nomeCompleto as if the category were
        // a root. The useEffect above still revalidates from server on edit.
        if (meta) {
          const bc = meta.hint?.trim() || meta.label?.trim() || null;
          onParentBreadcrumbChange(bc);
        }
        onChange(next);
      }}
    />
  );
}
