// ============================================================
// firebase.js — конфигурация Firebase и низкоуровневые функции
// работы с Authentication и Realtime Database.
// Ничего из бизнес-логики здесь нет — только доступ к данным.
// ============================================================

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  updatePassword,
  createUserWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDatabase,
  ref,
  get,
  set,
  push,
  update,
  remove,
  onValue,
  off,
  query,
  orderByChild,
  equalTo,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// --------------------------------------------------------------
// ⚠️ ЗАМЕНИ на конфиг своего проекта из консоли Firebase
// --------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyC_t_WKtpQBkvmcalMjD3KujYYCnjKHh9Y",
  authDomain: "demicrm1611.firebaseapp.com",
  databaseURL: "https://demicrm1611-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "demicrm1611",
  storageBucket: "demicrm1611.firebasestorage.app",
  messagingSenderId: "294937123695",
  appId: "1:294937123695:web:59c9415215e2f6fc7b669a",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

// ----------------------------------------------------------------
// AUTH
// ----------------------------------------------------------------

export async function login(email, password, remember) {
  await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
  return signInWithEmailAndPassword(auth, email, password);
}

export function logout() {
  return signOut(auth);
}

export function watchAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

export function changeOwnPassword(newPassword) {
  return updatePassword(auth.currentUser, newPassword);
}

// Создание пользователя администратором без потери своей сессии:
// поднимаем второй, временный экземпляр Firebase App, создаём
// юзера там, затем сразу его удаляем. Админ остаётся залогинен
// в основном app. Это обходной путь — без Cloud Functions на
// бесплатном тарифе иначе никак.
export async function createUserAsAdmin({ email, password, name, role }) {
  const secondaryApp = initializeApp(firebaseConfig, "secondary-" + Date.now());
  const secondaryAuth = getAuth(secondaryApp);
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    const uid = cred.user.uid;
    await set(ref(db, `users/${uid}`), {
      name,
      email,
      role,
      createdAt: serverTimestamp(),
    });
    await signOut(secondaryAuth);
    return uid;
  } finally {
    await deleteApp(secondaryApp);
  }
}

// ----------------------------------------------------------------
// DB — универсальные обёртки
// ----------------------------------------------------------------

export function dbRef(path) {
  return ref(db, path);
}

export async function dbGet(path) {
  const snap = await get(ref(db, path));
  return snap.exists() ? snap.val() : null;
}

export function dbSet(path, value) {
  return set(ref(db, path), value);
}

export function dbUpdate(path, value) {
  return update(ref(db, path), value);
}

export function dbPush(path, value) {
  const newRef = push(ref(db, path));
  return set(newRef, value).then(() => newRef.key);
}

export function dbRemove(path) {
  return remove(ref(db, path));
}

export function dbListen(path, callback) {
  const r = ref(db, path);
  onValue(r, (snap) => callback(snap.exists() ? snap.val() : null));
  return () => off(r);
}

export function dbQueryEqual(path, childKey, value) {
  return get(query(ref(db, path), orderByChild(childKey), equalTo(value))).then((snap) =>
    snap.exists() ? snap.val() : null
  );
}

export function timestamp() {
  return serverTimestamp();
}

export function nowISO() {
  return new Date().toISOString();
}
