import { auth, db, googleProvider, signInWithPopup, signOut, onAuthStateChanged, doc, getDoc, setDoc, onSnapshot, isFirebaseConfigured } from "./firebase.js";

// Firestore 문서 경로: users/{uid}/data/state
// 단일 문서로 통합 (events, log, vix, scoreHistory, tabOrder, activeTicker)
// 동시성 이슈는 일단 무시 (단일 사용자가 여러 기기에서 쓰는 시나리오만 가정)

const SYNC_FIELDS = ["events", "log", "vix", "scoreHistory", "tabOrder", "activeTicker"];

export function watchAuth(callback) {
  if (!isFirebaseConfigured || !auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, (user) => callback(user));
}

export async function signInGoogle() {
  if (!auth) throw new Error("Firebase not configured");
  return await signInWithPopup(auth, googleProvider);
}

export async function signOutUser() {
  if (!auth) return;
  return await signOut(auth);
}

function userDocRef(uid) {
  return doc(db, "users", uid, "data", "state");
}

export async function fetchCloudState(uid) {
  if (!db || !uid) return null;
  const snap = await getDoc(userDocRef(uid));
  return snap.exists() ? snap.data() : null;
}

export async function writeCloudState(uid, partial) {
  if (!db || !uid) return;
  await setDoc(userDocRef(uid), { ...partial, updatedAt: Date.now() }, { merge: true });
}

export function subscribeCloudState(uid, callback) {
  if (!db || !uid) return () => {};
  return onSnapshot(
    userDocRef(uid),
    (snap) => callback(snap.exists() ? snap.data() : null),
    (err) => console.error("[cloudSync] subscribe error:", err)
  );
}

// 머지 정책: 서버 데이터 우선, 단 서버에 없는 필드는 로컬값 사용
export function mergeCloudAndLocal(cloudState, localState) {
  const merged = {};
  for (const k of SYNC_FIELDS) {
    const cloudVal = cloudState?.[k];
    const localVal = localState?.[k];
    if (cloudVal !== undefined && cloudVal !== null) {
      merged[k] = cloudVal;
    } else if (localVal !== undefined && localVal !== null) {
      merged[k] = localVal;
    }
  }
  return merged;
}

export { SYNC_FIELDS };
