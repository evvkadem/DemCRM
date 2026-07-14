// ============================================================
// firebase.js — подключение Firebase, авторизация, работа с RTDB
// ============================================================

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  updatePassword,
  updateProfile
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  set,
  update,
  remove,
  push,
  get,
  onValue,
  off,
  child
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyC_t_WKtpQBkvmcalMjD3KujYYCnjKHh9Y",
  authDomain: "demicrm1611.firebaseapp.com",
  databaseURL: "https://demicrm1611-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "demicrm1611",
  storageBucket: "demicrm1611.firebasestorage.app",
  messagingSenderId: "294937123695",
  appId: "1:294937123695:web:59c9415215e2f6fc7b669a"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

// ---------------------------------------------------------
// AUTH
// ---------------------------------------------------------

export async function loginUser(email, password, remember) {
  await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
  return signInWithEmailAndPassword(auth, email, password);
}

export function logoutUser() {
  return signOut(auth);
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function getUserProfile(uid) {
  const snap = await get(ref(db, `users/${uid}`));
  return snap.exists() ? snap.val() : null;
}

export async function updateOwnPassword(newPassword) {
  return updatePassword(auth.currentUser, newPassword);
}

export async function updateOwnProfile(name) {
  await updateProfile(auth.currentUser, { displayName: name });
  await update(ref(db, `users/${auth.currentUser.uid}`), { name });
}

// Секретный трюк: создаём пользователя через вторичный instance приложения,
// чтобы не разлогинивать текущего администратора.
export async function createUserSecondary(email, password, name, role) {
  const secondaryApp = initializeApp(firebaseConfig, "Secondary_" + Date.now());
  const secondaryAuth = getAuth(secondaryApp);
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    const uid = cred.user.uid;
    await set(ref(db, `users/${uid}`), {
      name, email, role, createdAt: Date.now()
    });
    await signOut(secondaryAuth);
    await deleteApp(secondaryApp);
    return uid;
  } catch (e) {
    await deleteApp(secondaryApp).catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------
// GENERIC DB HELPERS
// ---------------------------------------------------------

export function listenPath(path, callback) {
  const r = ref(db, path);
  onValue(r, (snap) => callback(snap.val() || {}));
  return () => off(r);
}

export async function getPath(path) {
  const snap = await get(ref(db, path));
  return snap.exists() ? snap.val() : null;
}

export function pushPath(path, data) {
  const newRef = push(ref(db, path));
  return set(newRef, data).then(() => newRef.key);
}

export function setPath(path, data) {
  return set(ref(db, path), data);
}

export function updatePath(path, data) {
  return update(ref(db, path), data);
}

export function removePath(path) {
  return remove(ref(db, path));
}

export function pushKey(path) {
  return push(ref(db, path)).key;
}

export { ref, child };
