import { GeoPoint, Timestamp, type Firestore, DocumentReference } from 'firebase-admin/firestore';
import { WhatsappMigrationError, type Raw } from './transform';

const TAG = '$whatsappMigrationValue';

/** Lossless manifest codec. Never JSON.stringify an Admin SDK document directly. */
export function encodeFirestore(value: unknown): unknown {
  if (value instanceof Timestamp)
    return { [TAG]: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
  if (value instanceof GeoPoint)
    return { [TAG]: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  if (value instanceof DocumentReference) return { [TAG]: 'reference', path: value.path };
  if (Buffer.isBuffer(value)) return { [TAG]: 'bytes', base64: value.toString('base64') };
  if (value instanceof Date) return { [TAG]: 'date', value: value.toISOString() };
  if (typeof value === 'number' && !Number.isFinite(value))
    return { [TAG]: 'number', value: String(value) };
  if (Object.is(value, -0)) return { [TAG]: 'number', value: '-0' };
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return value;
  if (Array.isArray(value)) return value.map(encodeFirestore);
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Raw = {};
    for (const [key, item] of Object.entries(value)) out[key] = encodeFirestore(item);
    // Escape a real document map that happens to contain our reserved marker.
    return TAG in out ? { [TAG]: 'escaped-map', entries: Object.entries(out) } : out;
  }
  throw new WhatsappMigrationError(
    'Tipo Firestore não suportado pelo codec; nada será serializado com perda.',
  );
}

export function decodeFirestore(value: unknown, db: Pick<Firestore, 'doc'>): unknown {
  if (Array.isArray(value)) return value.map((v) => decodeFirestore(v, db));
  if (value === null || typeof value !== 'object') return value;
  const raw = value as Raw;
  const kind = raw[TAG];
  if (kind === 'timestamp') return new Timestamp(Number(raw.seconds), Number(raw.nanoseconds));
  if (kind === 'geopoint') return new GeoPoint(Number(raw.latitude), Number(raw.longitude));
  if (kind === 'reference' && typeof raw.path === 'string') return db.doc(raw.path);
  if (kind === 'bytes' && typeof raw.base64 === 'string') return Buffer.from(raw.base64, 'base64');
  if (kind === 'date' && typeof raw.value === 'string') return new Date(raw.value);
  if (kind === 'number' && typeof raw.value === 'string') return Number(raw.value);
  if (kind === 'escaped-map' && Array.isArray(raw.entries)) {
    return Object.fromEntries(
      raw.entries.map((entry: unknown) => {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string')
          throw new WhatsappMigrationError('Mapa escapado inválido');
        return [entry[0], decodeFirestore(entry[1], db)];
      }),
    );
  }
  if (kind !== undefined) throw new WhatsappMigrationError('Tag Firestore inválida no manifesto');
  return Object.fromEntries(
    Object.entries(raw).map(([key, item]) => [key, decodeFirestore(item, db)]),
  );
}
