// firebase.js — инициализация firebase (modular sdk v9, через cdn, без npm/сборки)

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  updatePassword,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDatabase,
  ref,
  set,
  get,
  update,
  remove,
  push,
  onValue,
  off,
  query,
  orderByChild,
  equalTo,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyAfqdcFJ8Mz2EzvqhqXKcyfBJLdl7-w3Xg",
  authDomain: "demcrm1611.firebaseapp.com",
  databaseURL: "https://demcrm1611-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "demcrm1611",
  storageBucket: "demcrm1611.firebasestorage.app",
  messagingSenderId: "1087839612882",
  appId: "1:1087839612882:web:40212eba37bff3403b620b",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

const MAIN_ADMIN = {
  email: "genedemi@mail.ru",
  password: "demicheva16",
  name: "Главный администратор",
  role: "admin",
  phone: "",
};

async function ensureMainAdmin() {
  const readyRef = ref(db, "meta/mainAdminReady");

  let alreadyReady = false;
  try {
    const snap = await get(readyRef);
    alreadyReady = snap.val() === true;
  } catch (err) {
    console.warn("ensureMainAdmin: не удалось проверить флаг", err.message);
    return;
  }
  if (alreadyReady) return;

  try {
    const cred = await createUserWithEmailAndPassword(auth, MAIN_ADMIN.email, MAIN_ADMIN.password);
    await updateProfile(cred.user, { displayName: MAIN_ADMIN.name });
    await set(ref(db, `users/${cred.user.uid}`), {
      name: MAIN_ADMIN.name,
      email: MAIN_ADMIN.email,
      phone: MAIN_ADMIN.phone,
      role: MAIN_ADMIN.role,
      isMainAdmin: true,
      createdAt: serverTimestamp(),
    });
    await set(readyRef, true);
  } catch (err) {
    if (err.code === "auth/email-already-in-use") {
      try { await set(readyRef, true); } catch (_) {}
    } else {
      console.warn("ensureMainAdmin:", err.message);
    }
  }
}

async function createUserAsAdmin({ email, password, name, role, phone = "" }) {
  const secondaryApp = initializeApp(firebaseConfig, `secondary-${Date.now()}`);
  const secondaryAuth = getAuth(secondaryApp);
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    await updateProfile(cred.user, { displayName: name });
    await set(ref(db, `users/${cred.user.uid}`), {
      name,
      email,
      phone,
      role,
      isMainAdmin: false,
      createdAt: serverTimestamp(),
    });
    await signOut(secondaryAuth);
    return cred.user.uid;
  } finally {
    await deleteApp(secondaryApp);
  }
}

export {
  app,
  auth,
  db,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  updatePassword,
  updateProfile,
  ref,
  set,
  get,
  update,
  remove,
  push,
  onValue,
  off,
  query,
  orderByChild,
  equalTo,
  serverTimestamp,
  ensureMainAdmin,
  createUserAsAdmin,
  MAIN_ADMIN,
};
