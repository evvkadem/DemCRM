// firebase.js — локальный адаптер для демо/превью.
// Сохраняет тот же API, который ожидает script.js, но работает без внешних
// CDN и без настоящего Firebase. Данные лежат в localStorage.

const DB_KEY = "demcrm-local-db-v4";
const AUTH_KEY = "demcrm-local-auth-v1";

const listeners = new Set();
const authListeners = new Set();

function clone(value) {
  if (value === undefined) return undefined;
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function msOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function isoOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function sampleDb() {
  return {
    users: {
      u_admin: { name: "Администратор", email: "admin@demcrm.local", role: "admin", _password: "admin123" },
      u_recruiter: { name: "Рекрутер", email: "recruiter@demcrm.local", role: "recruiter", _password: "demo123" },
    },
    tags: {
      tag_contact: { name: "не вышел на связь", color: "#C9A24A" },
      tag_black: { name: "чёрный список", color: "#2A241A" },
      tag_bad: { name: "не подходит", color: "#A85C5C" },
      tag_old: { name: "не актуально", color: "#8A7C63" },
      tag_noshow: { name: "не пришёл на собеседование", color: "#B5793F" },
      tag_strong: { name: "сильный", color: "#2F8F58" },
      tag_reserve: { name: "резерв", color: "#5F67D8" },
    },
    vacancies: {
      v_sales: {
        title: "Менеджер по продажам",
        manager: "Clair Burge",
        managerPhone: "7 921 555-21-12",
        internalPhone: "1042",
        slots: 4,
        status: "active",
        openDate: dateOffset(-28),
        closeDate: "",
        comment: "Приоритетная вакансия на июль",
        createdAt: msOffset(-28),
      },
      v_support: {
        title: "Специалист поддержки",
        manager: "Christian Bass",
        managerPhone: "7 999 555-17-03",
        internalPhone: "1180",
        slots: 3,
        status: "active",
        openDate: dateOffset(-22),
        closeDate: "",
        comment: "Нужны кандидаты с ночными сменами",
        createdAt: msOffset(-22),
      },
      v_hr: {
        title: "HR-координатор",
        manager: "Craig Curry",
        managerPhone: "7 903 555-84-10",
        internalPhone: "1212",
        slots: 2,
        status: "active",
        openDate: dateOffset(-18),
        closeDate: "",
        comment: "Онбординг и документооборот",
        createdAt: msOffset(-18),
      },
      v_ops: {
        title: "Операционный менеджер",
        manager: "Helna Julie",
        managerPhone: "7 925 555-19-30",
        internalPhone: "1301",
        slots: 2,
        status: "active",
        openDate: dateOffset(-12),
        closeDate: "",
        comment: "Работа с ежедневными операциями",
        createdAt: msOffset(-12),
      },
      v_marketing: {
        title: "Маркетолог",
        manager: "Brandon Crawford",
        managerPhone: "7 916 555-71-42",
        internalPhone: "1410",
        slots: 1,
        status: "paused",
        openDate: dateOffset(-40),
        closeDate: "",
        comment: "Приостановлена до согласования бюджета",
        createdAt: msOffset(-40),
      },
    },
    candidates: {
      c_01: {
        name: "Clair Burge",
        phone: "9211112233",
        vacancyId: "v_sales",
        source: "hh",
        resumeLink: "",
        stage: "Отклик",
        status: "активный",
        createdAt: msOffset(-2),
        stageChangedAt: isoOffset(-2),
        noShowCount: 0,
        onKanban: true,
        tags: { tag_strong: true },
      },
      c_02: {
        name: "Christian Bass",
        phone: "9991112233",
        vacancyId: "v_support",
        source: "avito",
        resumeLink: "",
        stage: "Отклик",
        status: "активный",
        createdAt: msOffset(-5),
        stageChangedAt: isoOffset(-5),
        noShowCount: 0,
        onKanban: true,
        tags: {},
      },
      c_03: {
        name: "Craig Curry",
        phone: "9031112233",
        vacancyId: "v_hr",
        source: "hh",
        resumeLink: "",
        stage: "Скрининг",
        status: "активный",
        createdAt: msOffset(-8),
        stageChangedAt: isoOffset(-3),
        noShowCount: 0,
        onKanban: true,
        tags: {},
        interviews: {
          iv_1: { date: dateOffset(0), time: "12:30", comment: "Первичное интервью", result: "" },
        },
      },
      c_04: {
        name: "Helna Julie",
        phone: "9251112233",
        vacancyId: "v_ops",
        source: "other",
        resumeLink: "",
        stage: "Приглашён на собеседование",
        status: "активный",
        createdAt: msOffset(-4),
        stageChangedAt: isoOffset(-1),
        noShowCount: 0,
        onKanban: true,
        tags: { tag_reserve: true },
        interviews: {
          iv_2: { date: dateOffset(1), time: "10:00", comment: "С руководителем", result: "" },
        },
      },
      c_05: {
        name: "Brandon Crawford",
        phone: "9161112233",
        vacancyId: "v_marketing",
        source: "hh",
        resumeLink: "",
        stage: "Анкета",
        status: "активный",
        createdAt: msOffset(-12),
        stageChangedAt: isoOffset(-4),
        noShowCount: 0,
        onKanban: true,
        tags: {},
      },
      c_06: {
        name: "Anna Petrova",
        phone: "9112223344",
        vacancyId: "v_sales",
        source: "avito",
        resumeLink: "",
        stage: "Собеседование",
        status: "активный",
        createdAt: msOffset(-14),
        stageChangedAt: isoOffset(-2),
        noShowCount: 0,
        onKanban: true,
        tags: {},
        interviews: {
          iv_3: { date: dateOffset(0), time: "15:15", comment: "Финальное уточнение", result: "" },
        },
      },
      c_07: {
        name: "Mikhail Orlov",
        phone: "9223334455",
        vacancyId: "v_support",
        source: "hh",
        resumeLink: "",
        stage: "Отобрано",
        status: "активный",
        createdAt: msOffset(-20),
        stageChangedAt: isoOffset(-1),
        noShowCount: 0,
        onKanban: true,
        tags: { tag_strong: true },
      },
      c_08: {
        name: "Sofia Ivanova",
        phone: "9334445566",
        vacancyId: "v_ops",
        source: "other",
        resumeLink: "",
        stage: "Собеседование с директором",
        status: "активный",
        createdAt: msOffset(-21),
        stageChangedAt: isoOffset(-6),
        noShowCount: 0,
        onKanban: true,
        tags: {},
      },
      c_09: {
        name: "Nikita Smirnov",
        phone: "9445556677",
        vacancyId: "v_sales",
        source: "hh",
        resumeLink: "",
        stage: "Трудоустройство",
        status: "трудоустроен",
        createdAt: msOffset(-35),
        stageChangedAt: isoOffset(-9),
        employmentDate: dateOffset(-7),
        noShowCount: 0,
        onKanban: false,
        tags: {},
      },
      c_10: {
        name: "Daria Volkova",
        phone: "9556667788",
        vacancyId: "v_support",
        source: "avito",
        resumeLink: "",
        stage: "Скрининг",
        status: "не актуально",
        createdAt: msOffset(-16),
        stageChangedAt: isoOffset(-10),
        noShowCount: 0,
        onKanban: false,
        tags: { tag_old: true },
      },
    },
  };
}

function loadDb() {
  ensureSeed();
  try {
    return JSON.parse(localStorage.getItem(DB_KEY)) || sampleDb();
  } catch {
    return sampleDb();
  }
}

function saveDb(data) {
  localStorage.setItem(DB_KEY, JSON.stringify(data));
}

function ensureSeed() {
  if (typeof localStorage === "undefined") return;
  if (!localStorage.getItem(DB_KEY)) {
    saveDb(sampleDb());
  } else {
    try {
      const db = JSON.parse(localStorage.getItem(DB_KEY));
      db.users ||= {};
      db.tags ||= {};
      db.vacancies ||= {};
      db.candidates ||= {};
      if (!db.users.u_admin) db.users.u_admin = { name: "Администратор", email: "admin@demcrm.local", role: "admin", _password: "admin123" };
      saveDb(db);
    } catch {
      saveDb(sampleDb());
    }
  }
  if (!localStorage.getItem(AUTH_KEY)) localStorage.setItem(AUTH_KEY, "u_admin");
}

function parts(path) {
  return String(path || "").split("/").filter(Boolean);
}

function getAt(obj, path) {
  let current = obj;
  for (const p of parts(path)) {
    if (current == null) return undefined;
    current = current[p];
  }
  return current;
}

function ensureParent(obj, path) {
  const ps = parts(path);
  const key = ps.pop();
  let current = obj;
  for (const p of ps) {
    if (!current[p] || typeof current[p] !== "object") current[p] = {};
    current = current[p];
  }
  return { parent: current, key };
}

function setAt(obj, path, value) {
  const { parent, key } = ensureParent(obj, path);
  if (!key) return;
  parent[key] = value;
}

function removeAt(obj, path) {
  const { parent, key } = ensureParent(obj, path);
  if (parent && key && Object.prototype.hasOwnProperty.call(parent, key)) delete parent[key];
}

function rootOf(path) {
  return parts(path)[0] || "";
}

function shouldNotify(listenerPath, changedPath) {
  if (!listenerPath) return true;
  const lp = parts(listenerPath).join("/");
  const cp = parts(changedPath).join("/");
  return cp === lp || cp.startsWith(lp + "/") || lp.startsWith(cp + "/") || rootOf(cp) === rootOf(lp);
}

function notify(changedPath = "") {
  const data = loadDb();
  listeners.forEach((entry) => {
    if (shouldNotify(entry.path, changedPath)) entry.cb(clone(getAt(data, entry.path)) || null);
  });
}

function currentAuthUser() {
  ensureSeed();
  const db = loadDb();
  const uid = localStorage.getItem(AUTH_KEY) || "u_admin";
  const profile = db.users?.[uid] || db.users?.u_admin;
  if (!profile) return null;
  return { uid, email: profile.email };
}

function notifyAuth() {
  const user = currentAuthUser();
  authListeners.forEach((cb) => cb(user));
}

export const auth = {
  get currentUser() { return currentAuthUser(); },
};

export const db = {};
export const timestamp = () => Date.now();
export const nowISO = () => new Date().toISOString();

export async function login(email, password, remember = true) {
  ensureSeed();
  const data = loadDb();
  const found = Object.entries(data.users || {}).find(([, user]) => String(user.email).toLowerCase() === String(email).toLowerCase());
  let id;
  if (found) {
    const [uidValue, user] = found;
    if (user._password && password && user._password !== password) {
      throw new Error("Неверный email или пароль");
    }
    id = uidValue;
  } else {
    id = uid("u");
    data.users[id] = { name: email.split("@")[0] || "Пользователь", email, role: "recruiter", _password: password || "demo123" };
    saveDb(data);
  }
  localStorage.setItem(AUTH_KEY, id);
  notifyAuth();
  return { uid: id, email };
}

export async function logout() {
  localStorage.removeItem(AUTH_KEY);
  authListeners.forEach((cb) => cb(null));
}

export function watchAuth(cb) {
  ensureSeed();
  authListeners.add(cb);
  queueMicrotask(() => cb(currentAuthUser()));
  return () => authListeners.delete(cb);
}

export async function changeOwnPassword(newPassword) {
  const user = currentAuthUser();
  if (!user) throw new Error("Нет активного пользователя");
  const data = loadDb();
  if (!data.users[user.uid]) throw new Error("Пользователь не найден");
  data.users[user.uid]._password = newPassword;
  saveDb(data);
  notify("users");
}

export async function createUserAsAdmin({ email, password, name, role }) {
  const data = loadDb();
  const exists = Object.entries(data.users || {}).find(([, user]) => String(user.email).toLowerCase() === String(email).toLowerCase());
  if (exists) throw new Error("Пользователь с таким email уже существует");
  const id = uid("u");
  data.users[id] = { name, email, role, _password: password };
  saveDb(data);
  notify("users");
  return id;
}

export async function dbGet(path) {
  return clone(getAt(loadDb(), path)) || null;
}

export async function dbSet(path, value) {
  const data = loadDb();
  setAt(data, path, clone(value));
  saveDb(data);
  notify(path);
}

export async function dbUpdate(path, patch) {
  const data = loadDb();
  const current = getAt(data, path);
  if (current && typeof current === "object" && !Array.isArray(current)) {
    Object.assign(current, clone(patch));
  } else {
    setAt(data, path, clone(patch));
  }
  saveDb(data);
  notify(path);
}

export async function dbPush(path, value) {
  const data = loadDb();
  let list = getAt(data, path);
  if (!list || typeof list !== "object" || Array.isArray(list)) {
    setAt(data, path, {});
    list = getAt(data, path);
  }
  const id = uid(rootOf(path) || "id");
  list[id] = clone(value);
  saveDb(data);
  notify(path);
  return id;
}

export async function dbRemove(path) {
  const data = loadDb();
  removeAt(data, path);
  saveDb(data);
  notify(path);
}

export function dbListen(path, cb) {
  const entry = { path, cb };
  listeners.add(entry);
  queueMicrotask(() => cb(clone(getAt(loadDb(), path)) || null));
  return () => listeners.delete(entry);
}
