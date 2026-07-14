// firebase.js — инициализация firebase и общие хелперы доступа к данным

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  updatePassword,
  EmailAuthProvider,
  reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  remove,
  push,
  onValue,
  off,
  query,
  orderByChild,
  equalTo,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";
import {
  getStorage,
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
  deleteObject
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-storage.js";

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
export const storage = getStorage(app);

export {
  ref, get, set, update, remove, push, onValue, off, query, orderByChild, equalTo, serverTimestamp,
  storageRef, uploadBytes, getDownloadURL, deleteObject,
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
  updatePassword, EmailAuthProvider, reauthenticateWithCredential
};

// ---------- auth ----------

export function loginUser(email, password, remember) {
  const persistence = remember ? browserLocalPersistence : browserSessionPersistence;
  return setPersistence(auth, persistence).then(() =>
    signInWithEmailAndPassword(auth, email, password)
  );
}

export function logoutUser() {
  return signOut(auth);
}

export function watchAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

// ---------- generic db helpers ----------

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

export function dbRemove(path) {
  return remove(ref(db, path));
}

export function dbPushKey(path) {
  return push(ref(db, path)).key;
}

export function dbWatch(path, callback) {
  const r = ref(db, path);
  onValue(r, (snap) => callback(snap.exists() ? snap.val() : null));
  return () => off(r);
}

export function nowStamp() {
  return Date.now();
}
