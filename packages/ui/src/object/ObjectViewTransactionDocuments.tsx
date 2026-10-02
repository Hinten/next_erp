'use client';

import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import type { DocumentReference } from 'firebase/firestore';
import { useDocSnapshot } from '@delfrance/data/hooks';

export type DocumentBaseline = Record<string, unknown> | null;

/** Persistence adapters receive read access, never the ability to acknowledge a conflict. */
export interface TransactionWriteContext {
  getBaseline: (path: string) => DocumentBaseline | undefined;
}

/** Owned by ObjectView, outside Activity panels and their suspended effects. */
export interface ObjectViewTransactionDocuments extends TransactionWriteContext {
  /** Initial authoritative seed; repeated listener emissions cannot move it. */
  seedBaseline: (path: string, data: DocumentBaseline) => void;
  /** Explicitly accepted restore/conflict version, or a successful commit. */
  rebase: (path: string, data: DocumentBaseline) => void;
  seedFormField: (field: string, value: unknown) => void;
  getFormBaseline: (field: string) => unknown;
  rebaseFormField: (field: string, value: unknown) => void;
  clear: () => void;
  subscribe: (listener: () => void) => () => void;
  getVersion: () => number;
}

export function createTransactionDocuments(): ObjectViewTransactionDocuments {
  const documents = new Map<string, DocumentBaseline>();
  const fields = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  let version = 0;
  function notify() {
    version += 1;
    for (const listener of listeners) listener();
  }
  return {
    getBaseline: (path) => documents.get(path),
    seedBaseline: (path, data) => {
      if (documents.has(path)) return;
      documents.set(path, data);
      notify();
    },
    rebase: (path, data) => {
      documents.set(path, data);
      notify();
    },
    seedFormField: (field, value) => {
      if (fields.has(field)) return;
      fields.set(field, value);
      notify();
    },
    getFormBaseline: (field) => fields.get(field),
    rebaseFormField: (field, value) => {
      fields.set(field, value);
      notify();
    },
    clear: () => {
      documents.clear();
      fields.clear();
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => version,
  };
}

const Context = createContext<ObjectViewTransactionDocuments | null>(null);
export const ObjectViewTransactionDocumentsProvider = Context.Provider;
const subscribeNothing = () => () => {};
const emptyVersion = () => 0;

/** Optional outside ObjectView, like useObjectViewSections. */
export function useObjectViewTransactionDocuments(): ObjectViewTransactionDocuments | null {
  const documents = useContext(Context);
  useSyncExternalStore(
    documents?.subscribe ?? subscribeNothing,
    documents?.getVersion ?? emptyVersion,
    emptyVersion,
  );
  return documents;
}

/** A bounded query cannot prove absence: seed a previously unread target directly. */
export function useObjectViewTransactionDocumentSeed<T extends Record<string, unknown>>(
  ref: DocumentReference<T> | null,
  onSeed: (data: T | null) => void,
) {
  const documents = useObjectViewTransactionDocuments();
  const needsSeed = !!documents && !!ref && documents.getBaseline(ref.path) === undefined;
  const snap = useDocSnapshot(needsSeed ? ref : null);
  useEffect(() => {
    if (
      !needsSeed ||
      !ref ||
      !documents ||
      snap.loading ||
      snap.error ||
      snap.fromCache !== false ||
      snap.hasPendingWrites ||
      snap.data === undefined ||
      snap.documentPath !== ref.path
    )
      return;
    const data = snap.data?.data ?? null;
    documents.seedBaseline(ref.path, data);
    onSeed(data);
    // The seed and its form projection are one operation; listener updates cannot rebase it.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callback is a render closure, not a new seed
  }, [
    needsSeed,
    ref,
    documents,
    snap.loading,
    snap.error,
    snap.fromCache,
    snap.hasPendingWrites,
    snap.data,
    snap.documentPath,
  ]);
  return { ready: !needsSeed, error: needsSeed ? snap.error : undefined };
}
