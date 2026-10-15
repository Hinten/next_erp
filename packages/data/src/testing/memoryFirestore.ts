import { OccEngine, type OccRef, type OccReadable, type OccTransaction } from './occTransaction';

type Data = Record<string, unknown>;
type Snapshot = { exists: boolean; data: () => Data | undefined };

/** Small SDK adapter for tests of guarded document/FieldPath updates. */
export class MemoryFirestore {
  readonly documents = new Map<string, Data>();
  readonly occ = new OccEngine({
    applyWrite: (kind, path, data) => {
      const previous = this.documents.get(path);
      if (kind === 'create' && previous) throw new Error('ALREADY_EXISTS');
      if (kind === 'update' && !previous) throw new Error('NOT_FOUND');
      const next = kind === 'update' ? structuredClone(previous!) : {};
      for (const [key, value] of Object.entries(data)) {
        const parts: string[] = key.startsWith('[') ? (JSON.parse(key) as string[]) : [key];
        let target = next;
        for (const part of parts.slice(0, -1)) {
          target[part] ??= {};
          target = target[part] as Data;
        }
        target[parts[parts.length - 1]!] = structuredClone(value);
      }
      this.documents.set(path, next);
    },
    applyDelete: (path) => {
      this.documents.delete(path);
    },
  });

  seed(path: string, id: string, data: Data): void {
    this.documents.set(`${path}/${id}`, structuredClone(data));
  }
  docs(path: string): Map<string, Data> {
    return new Map(
      [...this.documents]
        .filter(
          ([key]) => key.startsWith(`${path}/`) && key.slice(path.length + 1).indexOf('/') < 0,
        )
        .map(([key, data]) => [key.slice(path.length + 1), data]),
    );
  }
  collection(path: string) {
    return { doc: (id: string) => this.doc(`${path}/${id}`) };
  }
  doc(path: string): OccReadable<Snapshot> & OccRef {
    return {
      path,
      get: () => {
        const data = this.documents.get(path);
        return Promise.resolve({
          exists: data != null,
          data: () => (data == null ? undefined : structuredClone(data)),
        });
      },
    };
  }
  runTransaction<T>(
    callback: (
      tx: Omit<OccTransaction, 'update'> & { update: (ref: OccRef, ...fields: unknown[]) => void },
    ) => Promise<T>,
  ): Promise<T> {
    return this.occ.runTransaction((tx) =>
      callback({
        ...tx,
        update: (ref, ...fields) => {
          if (fields.length === 1) {
            tx.update(ref, fields[0] as Data);
            return;
          }
          const data: Data = {};
          for (let index = 0; index < fields.length; index += 2) {
            const field = fields[index] as string | { _segments?: string[]; segments?: string[] };
            const segments =
              typeof field === 'string' ? [field] : (field._segments ?? field.segments);
            if (!segments) throw new Error('Unknown FieldPath');
            data[JSON.stringify(segments)] = fields[index + 1];
          }
          tx.update(ref, data);
        },
      }),
    );
  }
}
