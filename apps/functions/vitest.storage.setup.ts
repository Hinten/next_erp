// Bridges the env that `firebase emulators:exec` injects to what the
// firebase-admin SDK expects, so the storage integration tests talk to the
// emulators rather than a real project.
//
// - Firestore admin auto-detects `FIRESTORE_EMULATOR_HOST` (host:port).
// - Storage admin expects `STORAGE_EMULATOR_HOST` as a full URL, while
//   emulators:exec exports `FIREBASE_STORAGE_EMULATOR_HOST` as host:port —
//   bridge it here.
if (!process.env.STORAGE_EMULATOR_HOST && process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
  process.env.STORAGE_EMULATOR_HOST = `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}`;
}

// A project id is required even in demo mode; emulators:exec sets GCLOUD_PROJECT.
if (!process.env.GCLOUD_PROJECT) {
  process.env.GCLOUD_PROJECT = process.env.GCP_PROJECT ?? 'demo-erp';
}

// No Cloud Tasks emulator exists, and the LIVE `onProdutoChanged` fires on every
// produto write this suite makes. Without the kill switch each of those would
// try to reach the real Cloud Tasks API. `ci-storage.yml` sets this too; setting
// it here as well keeps a local `emulators:exec` run honest. The rollup's own
// behaviour is covered by `kitRollup.storage.test.ts`, which passes a recorder
// scheduler rather than relying on the transport.
process.env.KIT_ROLLUP_TASKS_DISABLED ??= '1';
