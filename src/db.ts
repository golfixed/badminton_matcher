import { firebaseDb, FIREBASE_READY } from './firebase';
export { FIREBASE_READY } from './firebase';
import { ref, set, onValue } from 'firebase/database';

// ─── Room ID ──────────────────────────────────────────────────────────────────

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomId(): string {
  return Array.from({ length: 6 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
}

function getInitialRoomId(): string {
  const hash = window.location.hash.replace('#', '').toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(hash)) {
    localStorage.setItem('bm_room', hash);
    return hash;
  }
  return '';
}

export let ROOM_ID = getInitialRoomId();
export let isConnected = false;

// ─── Connection tracking ───────────────────────────────────────────────────────

if (FIREBASE_READY && firebaseDb) {
  onValue(ref(firebaseDb, '.info/connected'), (snap) => {
    isConnected = snap.val() === true;
    document.dispatchEvent(new CustomEvent('connection-changed', { detail: isConnected }));
  });
}

// ─── Room navigation ──────────────────────────────────────────────────────────

export function enterRoom(id: string): void {
  ROOM_ID = id;
  localStorage.setItem('bm_room', id);
  history.replaceState(null, '', `${window.location.pathname}#${id}`);
}

export function leaveRoom(): void {
  ROOM_ID = '';
  history.replaceState(null, '', window.location.pathname);
}

// ─── Firebase path helper ─────────────────────────────────────────────────────

function firebaseKey(key: string): string {
  return key.startsWith('bm_') ? key.slice(3) : key;
}

function roomRef(key: string) {
  if (!firebaseDb || !ROOM_ID) return null;
  return ref(firebaseDb, `rooms/${ROOM_ID}/${firebaseKey(key)}`);
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function dbWrite(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
  const r = roomRef(key);
  if (r) set(r, value).catch(() => {});
}

export function dbDelete(key: string): void {
  localStorage.removeItem(key);
  const r = roomRef(key);
  if (r) set(r, null).catch(() => {});
}

export function dbRead<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

// Returns an unsubscribe function
export function dbSubscribe<T>(key: string, callback: (val: T) => void): () => void {
  if (!FIREBASE_READY || !firebaseDb || !ROOM_ID) return () => {};
  const r = ref(firebaseDb, `rooms/${ROOM_ID}/${firebaseKey(key)}`);
  return onValue(r, (snapshot) => {
    if (!snapshot.exists()) return;
    const val = snapshot.val() as T;
    localStorage.setItem(key, JSON.stringify(val));
    callback(val);
  });
}

// ─── Room Index (lobby) ────────────────────────────────────────────────────────

export interface RoomEntry {
  id: string;
  name: string;
  createdAt: number;
}

export function deleteRoomMeta(id: string): void {
  if (!firebaseDb) return;
  set(ref(firebaseDb, `room_index/${id}`), null).catch((err: Error) => {
    console.warn('[Firebase] deleteRoomMeta failed:', err.message);
  });
}

export function writeRoomMeta(id: string, name: string): void {
  if (!firebaseDb) return;
  set(ref(firebaseDb, `room_index/${id}`), {
    name: name.trim() || id,
    createdAt: Date.now(),
  }).catch((err: Error) => {
    console.warn('[Firebase] writeRoomMeta failed:', err.message);
    document.dispatchEvent(new CustomEvent('firebase-rules-error', { detail: err.message }));
  });
}

export function subscribeRoomList(
  callback: (rooms: RoomEntry[], error?: string) => void,
): () => void {
  if (!FIREBASE_READY || !firebaseDb) return () => {};
  return onValue(
    ref(firebaseDb, 'room_index'),
    (snapshot) => {
      if (!snapshot.exists()) { callback([], undefined); return; }
      const data = snapshot.val() as Record<string, { name: string; createdAt: number }>;
      const rooms = Object.entries(data)
        .map(([id, meta]) => ({ id, name: meta.name ?? id, createdAt: meta.createdAt ?? 0 }))
        .sort((a, b) => b.createdAt - a.createdAt);
      callback(rooms, undefined);
    },
    (err) => {
      console.warn('[Firebase] room_index read error:', err.message);
      callback([], err.message);
    },
  );
}
