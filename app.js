import {
  auth, db,
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
  ref, set, get, update, remove, push, onValue, serverTimestamp,
  ensureMainAdmin, createUserAsAdmin, updatePassword,
} from "./firebase.js";

const MAX_DOC_SIZE = 4 * 1024 * 1024;
const DOC_TYPES = [
  { key: "anketa", label: "анкета" },
  { key: "resume", label: "резюме" },
];

// === ЭТАПЫ ===
const KANBAN_STAGES = [
  { id: "response", label: "подходящий отклик" },
  { id: "selected", label: "отобрано" },
  { id: "invited", label: "приглашён" },
  { id: "form", label: "анкета" },
  { id: "interview", label: "собеседование" },
  { id: "selected2", label: "отобрано" },
  { id: "director_interview", label: "собеседование с директором" },
  { id: "hired", label: "трудоустройство" },
];

// === СОСТОЯНИЕ ===
const state = {
  currentUser: null,
  vacancies: {},
  candidates: {},
  users: {},
  activeSection: "vacancies",
  activeVacancyId: null,
  analyticsPeriod: "week",
  selectedTags: [],
};

// === УТИЛИТЫ ===
function showToast(message, type = "default") {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = `toast${type === "error" ? " toast-error" : ""}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

function formatDate(value) {
  if (!value) return "";
  const d = typeof value === "number" ? new Date(value) : new Date(value);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatPhone(phone) {
  const cleaned = String(phone || "").replace(/\D/g, "");
  if (cleaned.length === 11 && cleaned.startsWith("7")) {
    return `7 ${cleaned.slice(1, 4)} ${cleaned.slice(4, 7)}-${cleaned.slice(7, 9)}-${cleaned.slice(9, 11)}`;
  }
  return phone || "";
}

function formatDateInput(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function isToday(dateStr) {
  if (!dateStr) return false;
  return dateStr === new Date().toISOString().slice(0, 10);
}

function daysBetween(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
}

function confirmDialog(message) {
  return new Promise((resolve) => {
    openModal({
      title: "подтверждение",
      bodyHtml: `<p style="margin:0;color:var(--text-secondary);font-size:14px;">${message}</p>`,
      footerHtml: `
        <button class="btn btn-secondary" id="confirm-cancel">отмена</button>
        <button class="btn btn-danger" id="confirm-ok">продолжить</button>
      `,
      onMount: (overlay, close) => {
        overlay.querySelector("#confirm-cancel").addEventListener("click", () => { close(); resolve(false); });
        overlay.querySelector("#confirm-ok").addEventListener("click", () => { close(); resolve(true); });
      },
    });
  });
}

// === МОДАЛКИ ===
function openModal({ title, bodyHtml, wide = false, onMount, footerHtml }) {
  const root = document.getElementById("modal-root");
  root.innerHTML = "";

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal ${wide ? "modal-wide" : ""}">
      <div class="modal-header">
        <h2>${title}</h2>
        <button class="modal-close" aria-label="закрыть">✕</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
      ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ""}
    </div>
  `;
  root.appendChild(overlay);

  const close = () => { root.innerHTML = ""; };
  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", function escHandler(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", escHandler); }
  });

  if (onMount) onMount(overlay, close);
  return close;
}

// === КАСТОМНЫЙ SELECT (раскрывающийся список) ===
function createCustomSelect(container, options, selectedValue, onChange) {
  const wrapper = document.createElement("div");
  wrapper.className = "custom-select";

  const trigger = document.createElement("div");
  trigger.className = "custom-select-trigger";
  const selectedLabel = options.find(o => o.value === selectedValue)?.label || "выберите";
  trigger.innerHTML = `<span>${selectedLabel}</span><span class="custom-select-arrow">▾</span>`;
  wrapper.appendChild(trigger);

  const dropdown = document.createElement("div");
  dropdown.className = "custom-select-dropdown";
  options.forEach(opt => {
    const item = document.createElement("div");
    item.className = `custom-select-item${opt.value === selectedValue ? " active" : ""}`;
    item.textContent = opt.label;
    item.dataset.value = opt.value;
    item.addEventListener("click", () => {
      const label = options.find(o => o.value === opt.value)?.label || opt.value;
      trigger.querySelector("span:first-child").textContent = label;
      dropdown.querySelectorAll(".custom-select-item").forEach(el => el.classList.remove("active"));
      item.classList.add("active");
      wrapper.querySelector(".custom-select-dropdown").classList.remove("open");
      if (onChange) onChange(opt.value);
    });
    dropdown.appendChild(item);
  });
  wrapper.appendChild(dropdown);

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = dropdown.classList.toggle("open");
    document.querySelectorAll(".custom-select-dropdown.open").forEach(el => {
      if (el !== dropdown) el.classList.remove("open");
    });
  });

  document.addEventListener("click", () => {
    dropdown.classList.remove("open");
  });

  container.appendChild(wrapper);

  return {
    setValue: (val) => {
      const opt = options.find(o => o.value === val);
      if (opt) {
        trigger.querySelector("span:first-child").textContent = opt.label;
        dropdown.querySelectorAll(".custom-select-item").forEach(el => {
          el.classList.toggle("active", el.dataset.value === val);
        });
        if (onChange) onChange(val);
      }
    },
    getValue: () => {
      const active = dropdown.querySelector(".custom-select-item.active");
      return active ? active.dataset.value : null;
    }
  };
}

// === АВТОРИЗАЦИЯ ===
const loginForm = document.getElementById("login-form");
const loginScreen = document.getElementById("login-screen");
const appRoot = document.getElementById("app");

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const remember = document.getElementById("login-remember").checked;
  const errorBox = document.getElementById("login-error");
  errorBox.hidden = true;

  try {
    await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    errorBox.textContent = "неверный email или пароль";
    errorBox.hidden = false;
  }
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    loginScreen.hidden = false;
    appRoot.hidden = true;
    return;
  }

  const snap = await get(ref(db, `users/${user.uid}`));
  const profile = snap.val();
  if (!profile) {
    showToast("профиль не найден, обратитесь к администратору", "error");
    await signOut(auth);
    return;
  }

  state.currentUser = { uid: user.uid, ...profile };
  loginScreen.hidden = true;
  appRoot.hidden = false;

  document.getElementById("user-name").textContent = profile.name || profile.email;
  document.getElementById("user-avatar").textContent = (profile.name || profile.email || "?").charAt(0).toUpperCase();

  document.querySelectorAll("[data-admin-only]").forEach((el) => {
    el.style.display = profile.role === "admin" ? "flex" : "none";
  });

  initDataListeners();
});

// === НАВИГАЦИЯ ===
document.querySelectorAll(".nav-item[data-section]").forEach((btn) => {
  btn.addEventListener("click", () => switchSection(btn.dataset.section));
});

document.getElementById("kanban-back").addEventListener("click", () => switchSection("vacancies"));

function switchSection(section) {
  state.activeSection = section;
  document.querySelectorAll(".nav-item[data-section]").forEach((b) => b.classList.toggle("active", b.dataset.section === section));
  document.querySelectorAll(".section").forEach((s) => s.classList.remove("active"));
  const target = document.getElementById(`section-${section}`);
  if (target) target.classList.add("active");
  if (section === "analytics") renderAnalytics();
}

// === ДАННЫЕ ===
let listenersInitialized = false;

function initDataListeners() {
  if (listenersInitialized) return;
  listenersInitialized = true;

  onValue(ref(db, "vacancies"), (snap) => {
    state.vacancies = snap.val() || {};
    renderVacancies();
    renderCandidateFilters();
    renderTodayInterviews();
  });

  onValue(ref(db, "candidates"), (snap) => {
    state.candidates = snap.val() || {};
    renderVacancies();
    renderCandidatesTable();
    renderTodayInterviews();
    if (state.activeVacancyId) renderKanban();
    checkAutoArchive();
  });

  onValue(ref(db, "users"), (snap) => {
    state.users = snap.val() || {};
    renderUsersTable();
    renderManagerSelects();
  });
}

// === АВТОАРХИВ ===
function checkAutoArchive() {
  const now = Date.now();
  const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
  const archiveStages = ["response", "selected", "invited"];

  Object.entries(state.candidates).forEach(([id, c]) => {
    if (c.archived) return;
    if (!archiveStages.includes(c.stage)) return;
    if (!c.createdAt) return;

    const age = now - c.createdAt;
    if (age > TWO_WEEKS) {
      update(ref(db, `candidates/${id}`), {
        archived: true,
        archivedAt: now,
        archiveReason: "не вышел на связь",
      });
    }
  });
}

// === СОБЕСЕДОВАНИЯ НА СЕГОДНЯ ===
function renderTodayInterviews() {
  const container = document.getElementById("today-interviews");
  if (!container) return;

  const today = new Date().toISOString().slice(0, 10);
  const todayCandidates = Object.entries(state.candidates).filter(([, c]) => {
    return c.interviewDate === today && !c.archived;
  });

  if (todayCandidates.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding:20px 0;">сегодня собеседований нет</div>`;
    return;
  }

  container.innerHTML = todayCandidates.map(([id, c]) => {
    const vacancy = state.vacancies[c.vacancyId];
    return `
      <div class="today-interview-item" data-id="${id}">
        <span class="today-interview-name">${escapeHtml(c.name)}</span>
        <span class="today-interview-vacancy">${escapeHtml(vacancy?.title || "—")}</span>
        <span class="today-interview-time">${escapeHtml(c.interviewTime || "")}</span>
        <button class="btn btn-sm btn-ghost" data-action="mark-no-show" data-id="${id}">не пришёл</button>
      </div>
    `;
  }).join("");

  container.querySelectorAll('[data-action="mark-no-show"]').forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      await markNoShow(id);
    });
  });

  container.querySelectorAll('.today-interview-item').forEach(item => {
    item.addEventListener("click", () => {
      const id = item.dataset.id;
      if (id) openCandidateModal(id);
    });
  });
}

// === ПОМЕТКА "НЕ ПРИШЁЛ" ===
async function markNoShow(candidateId) {
  const c = state.candidates[candidateId];
  if (!c) return;

  const noShows = c.noShowCount || 0;
  const newCount = noShows + 1;

  const updates = { noShowCount: newCount };

  if (newCount >= 3) {
    const tags = c.tags || [];
    if (!tags.includes("черный список")) {
      tags.push("черный список");
      updates.tags = tags;
      showToast("кандидат добавлен в чёрный список", "error");
    }
  }

  await update(ref(db, `candidates/${candidateId}`), updates);
  await push(ref(db, `candidates/${candidateId}/history`), {
    action: `отметка "не пришёл на собеседование" (${newCount}/3)`,
    userName: state.currentUser.name || state.currentUser.email,
    at: serverTimestamp(),
  });
  showToast(`отмечено (${newCount}/3)`);
}

// === ВАКАНСИИ ===
const vacancyGrid = document.getElementById("vacancies-grid");
const vacancyEmpty = document.getElementById("vacancies-empty");
const vacancySearch = document.getElementById("vacancy-search");
const vacancyFilter = document.getElementById("vacancy-filter");

vacancySearch.addEventListener("input", renderVacancies);
vacancyFilter.addEventListener("change", renderVacancies);

const STATUS_LABELS = { active: "активна", paused: "приостановлена", closed: "закрыта" };

function vacancyMetrics(vacancyId) {
  const candidatesForVacancy = Object.entries(state.candidates).filter(([, c]) => c.vacancyId === vacancyId);
  const total = candidatesForVacancy.length;
  const hired = candidatesForVacancy.filter(([, c]) => c.stage === "hired").length;
  return { total, hired };
}

function renderVacancies() {
  const searchTerm = vacancySearch.value.trim().toLowerCase();
  const filterStatus = vacancyFilter.value;

  const entries = Object.entries(state.vacancies).filter(([, v]) => {
    const matchesSearch = !searchTerm || (v.title || "").toLowerCase().includes(searchTerm);
    const matchesStatus = filterStatus === "all" || v.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  vacancyGrid.innerHTML = "";
  vacancyEmpty.hidden = entries.length > 0;

  entries.forEach(([id, v]) => {
    const { total, hired } = vacancyMetrics(id);
    const positions = Number(v.positions) || 0;
    const progressPct = positions > 0 ? Math.min(100, Math.round((hired / positions) * 100)) : 0;

    const manager = state.users[v.managerId];
    const managerName = manager?.name || v.manager || "—";
    const managerPhone = manager?.phone ? formatPhone(manager.phone) : "";

    const card = document.createElement("div");
    card.className = "vacancy-card";
    card.innerHTML = `
      <div class="vacancy-card-title">${escapeHtml(v.title || "без названия")}</div>
      <div class="vacancy-card-manager">${escapeHtml(managerName)} ${managerPhone ? `· ${managerPhone}` : ""}</div>
      <div class="vacancy-card-metrics">
        <span>кандидаты: <b>${total}</b></span>
        <span>места: <b>${positions}</b></span>
        <span>трудоустроено: <b>${hired}</b></span>
      </div>
      <div>
        <div class="progress-bar"><div class="progress-bar-fill" style="width:${progressPct}%"></div></div>
        <div class="progress-label">закрыто ${hired} из ${positions} мест</div>
      </div>
      <div class="vacancy-card-footer">
        <span class="status-pill status-${v.status || "active"}">${STATUS_LABELS[v.status] || "активна"}</span>
        <span class="progress-label">${v.openedAt ? formatDate(v.openedAt) : ""}</span>
      </div>
    `;
    card.addEventListener("click", () => openKanban(id));
    vacancyGrid.appendChild(card);
  });
}

function openKanban(vacancyId) {
  state.activeVacancyId = vacancyId;
  const v = state.vacancies[vacancyId];
  document.getElementById("kanban-title").textContent = v ? v.title : "—";
  switchSection("kanban");
  renderKanban();
}

// === РУКОВОДИТЕЛИ (select) ===
function renderManagerSelects() {
  const managerOptions = Object.entries(state.users).map(([id, u]) => ({
    value: id,
    label: `${u.name || u.email} ${u.phone ? `(${formatPhone(u.phone)})` : ""}`
  }));

  // Обновляем существующие custom select'ы
  document.querySelectorAll('.manager-select-container').forEach(container => {
    const currentValue = container.dataset.value || "";
    container.innerHTML = "";
    const select = createCustomSelect(container, managerOptions, currentValue, (val) => {
      container.dataset.value = val;
    });
  });
}

// === СОЗДАНИЕ ВАКАНСИИ ===
document.getElementById("add-vacancy-btn").addEventListener("click", () => {
  const managerOptions = Object.entries(state.users).map(([id, u]) => ({
    value: id,
    label: `${u.name || u.email} ${u.phone ? `(${formatPhone(u.phone)})` : ""}`
  }));

  openModal({
    title: "новая вакансия",
    bodyHtml: `
      <label class="field"><span class="field-label">название</span><input class="field-input" id="v-title" /></label>
      <label class="field"><span class="field-label">руководитель</span><div class="manager-select-container" id="v-manager-container"></div></label>
      <label class="field"><span class="field-label">описание</span><textarea id="v-desc"></textarea></label>
      <label class="field"><span class="field-label">количество открытых мест</span><input type="number" min="1" class="field-input" id="v-positions" value="1" /></label>
      <label class="field"><span class="field-label">статус</span>
        <select class="select" id="v-status">
          <option value="active">активна</option>
          <option value="paused">приостановлена</option>
          <option value="closed">закрыта</option>
        </select>
      </label>
      <label class="field"><span class="field-label">дата открытия</span><input type="date" class="field-input" id="v-open-date" /></label>
      <label class="field"><span class="field-label">дата закрытия</span><input type="date" class="field-input" id="v-close-date" /></label>
      <label class="field"><span class="field-label">комментарий</span><textarea id="v-comment"></textarea></label>
    `,
    footerHtml: `
      <button class="btn btn-secondary" id="v-cancel">отмена</button>
      <button class="btn btn-primary" id="v-save">сохранить</button>
    `,
    onMount: (overlay, close) => {
      overlay.querySelectorAll(".field-input, .select, textarea").forEach((el) => {
        el.style.cssText = "height:38px;border:1px solid var(--border);border-radius:8px;padding:0 12px;background:var(--bg);color:var(--text);width:100%;";
      });

      const managerContainer = overlay.querySelector("#v-manager-container");
      if (managerOptions.length > 0) {
        const defaultManager = state.currentUser?.uid || managerOptions[0]?.value || "";
        createCustomSelect(managerContainer, managerOptions, defaultManager);
      }

      overlay.querySelector("#v-cancel").addEventListener("click", close);
      overlay.querySelector("#v-save").addEventListener("click", async () => {
        const title = overlay.querySelector("#v-title").value.trim();
        if (!title) { showToast("укажите название вакансии", "error"); return; }

        const managerSelect = managerContainer.querySelector('.custom-select');
        const managerId = managerSelect ? managerSelect.querySelector('.custom-select-item.active')?.dataset.value : null;

        const payload = {
          title,
          managerId: managerId || null,
          manager: managerId ? state.users[managerId]?.name : null,
          description: overlay.querySelector("#v-desc").value.trim(),
          positions: Number(overlay.querySelector("#v-positions").value) || 1,
          status: overlay.querySelector("#v-status").value,
          openedAt: overlay.querySelector("#v-open-date").value || null,
          closedAt: overlay.querySelector("#v-close-date").value || null,
          comment: overlay.querySelector("#v-comment").value.trim(),
          createdAt: serverTimestamp(),
          createdBy: state.currentUser.uid,
        };

        try {
          await push(ref(db, "vacancies"), payload);
          showToast("вакансия создана");
          close();
        } catch (err) {
          showToast("ошибка сохранения вакансии", "error");
        }
      });
    },
  });
});

// === KANBAN ===
const kanbanBoard = document.getElementById("kanban-board");

function renderKanban() {
  kanbanBoard.innerHTML = "";
  const candidatesForVacancy = Object.entries(state.candidates).filter(([, c]) => c.vacancyId === state.activeVacancyId && !c.archived);

  KANBAN_STAGES.forEach((stage) => {
    const stageCandidates = candidatesForVacancy.filter(([, c]) => c.stage === stage.id);

    const col = document.createElement("div");
    col.className = "kanban-column";
    col.dataset.stageId = stage.id;
    col.innerHTML = `
      <div class="kanban-column-header"><span>${stage.label}</span><span>${stageCandidates.length}</span></div>
      <div class="kanban-cards" data-stage="${stage.id}"></div>
    `;

    const cardsWrap = col.querySelector(".kanban-cards");
    stageCandidates
      .sort((a, b) => sortCandidates(a[1], b[1]))
      .forEach(([id, c]) => cardsWrap.appendChild(renderCandidateCard(id, c)));

    cardsWrap.addEventListener("dragover", (e) => e.preventDefault());
    cardsWrap.addEventListener("drop", (e) => {
      e.preventDefault();
      const candidateId = e.dataTransfer.getData("text/plain");
      handleCandidateDrop(candidateId, stage.id);
    });

    kanbanBoard.appendChild(col);
  });
}

function sortCandidates(a, b) {
  const aToday = isInterviewToday(a) ? 0 : 1;
  const bToday = isInterviewToday(b) ? 0 : 1;
  if (aToday !== bToday) return aToday - bToday;
  const aDate = a.interviewDate ? new Date(a.interviewDate).getTime() : Infinity;
  const bDate = b.interviewDate ? new Date(b.interviewDate).getTime() : Infinity;
  if (aDate !== bDate) return aDate - bDate;
  return (a.createdAt || 0) - (b.createdAt || 0);
}

function isInterviewToday(c) {
  if (!c.interviewDate) return false;
  return c.interviewDate === new Date().toISOString().slice(0, 10);
}

function renderCandidateCard(id, c) {
  const card = document.createElement("div");
  card.className = "kanban-card";
  card.draggable = true;
  card.dataset.id = id;

  const tags = [];
  if (isInterviewToday(c)) tags.push('<span class="tag tag-warning">собеседование сегодня</span>');
  if (!c.hasForm) tags.push('<span class="tag tag-info">нет анкеты</span>');
  if (c.stage === "hired") tags.push('<span class="tag tag-success">трудоустроен</span>');
  if (c.archived) tags.push('<span class="tag tag-danger">архив</span>');
  if (c.archiveReason) tags.push(`<span class="tag tag-danger">${escapeHtml(c.archiveReason)}</span>`);
  if (c.tags) {
    c.tags.forEach(t => {
      if (t === "черный список") tags.push(`<span class="tag tag-danger">${escapeHtml(t)}</span>`);
      else tags.push(`<span class="tag tag-info">${escapeHtml(t)}</span>`);
    });
  }

  card.innerHTML = `
    <div class="kanban-card-name">${escapeHtml(c.name || "без имени")}</div>
    <div class="kanban-card-phone">${formatPhone(c.phone)}</div>
    <div class="kanban-card-tags">${tags.join("")}</div>
    <div class="kanban-card-footer">
      <span class="progress-label">${c.recruiterName ? escapeHtml(c.recruiterName) : ""}</span>
      <span class="progress-label">${c.createdAt ? formatDate(c.createdAt) : ""}</span>
    </div>
  `;

  card.addEventListener("dragstart", (e) => {
    card.classList.add("dragging");
    e.dataTransfer.setData("text/plain", id);
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
  card.addEventListener("click", () => openCandidateModal(id));

  return card;
}

// === ПЕРЕХОДЫ МЕЖДУ ЭТАПАМИ ===
const TRANSITION_RULES = [
  {
    from: "interview",
    to: "selected2",
    check: (c) => !!c.hasForm,
    message: "анкета кандидата не загружена.\n\nвы действительно хотите перевести кандидата на следующий этап без анкеты?",
  },
];

async function handleCandidateDrop(candidateId, targetStage) {
  const candidate = state.candidates[candidateId];
  if (!candidate || candidate.stage === targetStage) return;

  const rule = TRANSITION_RULES.find((r) => r.from === candidate.stage && r.to === targetStage);
  if (rule && !rule.check(candidate)) {
    const proceed = await confirmDialog(rule.message.replace(/\n/g, "<br>"));
    if (!proceed) return;
  }

  await moveCandidateToStage(candidateId, targetStage);
}

async function moveCandidateToStage(candidateId, targetStage) {
  const updates = { stage: targetStage };
  if (targetStage === "hired") updates.hiredAt = new Date().toISOString();

  await update(ref(db, `candidates/${candidateId}`), updates);
  await push(ref(db, `candidates/${candidateId}/history`), {
    action: `этап изменён на «${KANBAN_STAGES.find((s) => s.id === targetStage)?.label}»`,
    userName: state.currentUser.name || state.currentUser.email,
    at: serverTimestamp(),
  });
  showToast("этап обновлён");
}

// === ДОБАВЛЕНИЕ КАНДИДАТА (с проверкой дублей) ===
document.getElementById("add-candidate-btn").addEventListener("click", () => {
  if (!state.activeVacancyId) return;

  openModal({
    title: "новый кандидат",
    bodyHtml: `
      <label class="field"><span class="field-label">имя</span><input class="field-input" id="c-name" /></label>
      <label class="field"><span class="field-label">телефон</span><input class="field-input" id="c-phone" placeholder="7 999 999-99-99" /></label>
      <label class="field"><span class="field-label">источник</span>
        <select class="select" id="c-source">
          <option value="hh">hh</option>
          <option value="avito">авито</option>
          <option value="other">прочее</option>
        </select>
      </label>
      <label class="field"><span class="field-label">теги</span><input class="field-input" id="c-tags" placeholder="теги через запятую" /></label>
    `,
    footerHtml: `
      <button class="btn btn-secondary" id="c-cancel">отмена</button>
      <button class="btn btn-primary" id="c-save">сохранить</button>
    `,
    onMount: (overlay, close) => {
      overlay.querySelectorAll(".field-input, .select").forEach((el) => {
        el.style.cssText = "height:38px;border:1px solid var(--border);border-radius:8px;padding:0 12px;background:var(--bg);color:var(--text);width:100%;";
      });

      overlay.querySelector("#c-cancel").addEventListener("click", close);
      overlay.querySelector("#c-save").addEventListener("click", async () => {
        const name = overlay.querySelector("#c-name").value.trim();
        const phone = overlay.querySelector("#c-phone").value.trim();
        if (!name && !phone) { showToast("укажите имя или телефон кандидата", "error"); return; }

        // Проверка на дубли
        const existing = Object.entries(state.candidates).find(([, c]) => {
          const nameMatch = name && c.name?.toLowerCase() === name.toLowerCase();
          const phoneMatch = phone && c.phone === phone;
          return nameMatch || phoneMatch;
        });

        if (existing) {
          const [existingId] = existing;
          showToast("кандидат уже есть в базе, открываю карточку");
          close();
          switchSection("candidates");
          setTimeout(() => openCandidateModal(existingId), 300);
          return;
        }

        const tags = overlay.querySelector("#c-tags").value.split(",").map(t => t.trim()).filter(Boolean);

        await push(ref(db, "candidates"), {
          name,
          phone,
          source: overlay.querySelector("#c-source").value,
          vacancyId: state.activeVacancyId,
          stage: "response",
          hasForm: false,
          archived: false,
          recruiterId: state.currentUser.uid,
          recruiterName: state.currentUser.name || state.currentUser.email,
          createdAt: Date.now(),
          tags,
          noShowCount: 0,
        });
        showToast("кандидат добавлен");
        close();
      });
    },
  });
});

// === КАРТОЧКА КАНДИДАТА ===
function openCandidateModal(candidateId) {
  const c = state.candidates[candidateId];
  if (!c) return;

  const historyHtml = (c.history || []).slice(-10).reverse().map(h => `
    <div class="history-item">
      <span class="history-time">${formatDate(h.at)}</span>
      <span class="history-action">${escapeHtml(h.action)}</span>
      <span class="history-user">${escapeHtml(h.userName || "")}</span>
    </div>
  `).join("");

  openModal({
    title: escapeHtml(c.name || "кандидат"),
    wide: true,
    bodyHtml: `
      <label class="field"><span class="field-label">телефон</span><input class="field-input" id="cc-phone" value="${escapeHtml(c.phone || "")}" placeholder="7 999 999-99-99" /></label>
      <label class="field"><span class="field-label">источник</span>
        <select class="select" id="cc-source">
          <option value="hh" ${c.source === "hh" ? "selected" : ""}>hh</option>
          <option value="avito" ${c.source === "avito" ? "selected" : ""}>авито</option>
          <option value="other" ${c.source === "other" ? "selected" : ""}>прочее</option>
        </select>
      </label>
      <label class="field"><span class="field-label">теги (через запятую)</span><input class="field-input" id="cc-tags" value="${escapeHtml((c.tags || []).join(", "))}" /></label>
      <div class="field"><span class="field-label">документы</span>
        <div class="doc-slots">${DOC_TYPES.map((t) => renderDocSlot(candidateId, t, c.documents?.[t.key])).join("")}</div>
      </div>
      <label class="field"><span class="field-label">заметки</span><textarea id="cc-notes">${escapeHtml(c.notes || "")}</textarea></label>
      <div class="field"><span class="field-label">история изменений</span>
        <div class="history-list">${historyHtml || "<div class='empty-state'>нет записей</div>"}</div>
      </div>
      <div class="field"><span class="field-label">собеседование</span>
        <div style="display:flex;gap:8px;">
          <input type="date" class="field-input" id="cc-interview-date" value="${formatDateInput(c.interviewDate)}" style="flex:1;" />
          <input type="time" class="field-input" id="cc-interview-time" value="${escapeHtml(c.interviewTime || "")}" style="flex:1;" />
        </div>
        <button class="btn btn-secondary" id="cc-mark-no-show">отметить "не пришёл" (${c.noShowCount || 0}/3)</button>
      </div>
    `,
    footerHtml: `
      <button class="btn btn-danger" id="cc-delete">удалить</button>
      <button class="btn btn-secondary" id="cc-archive">архивировать</button>
      <button class="btn btn-primary" id="cc-save">сохранить</button>
    `,
    onMount: (overlay, close) => {
      overlay.querySelectorAll(".field-input, .select").forEach((el) => {
        el.style.cssText = "height:38px;border:1px solid var(--border);border-radius:8px;padding:0 12px;background:var(--bg);color:var(--text);width:100%;";
      });

      bindDocSlots(overlay, candidateId);

      overlay.querySelector("#cc-save").addEventListener("click", async () => {
        const tags = overlay.querySelector("#cc-tags").value.split(",").map(t => t.trim()).filter(Boolean);
        await update(ref(db, `candidates/${candidateId}`), {
          phone: overlay.querySelector("#cc-phone").value.trim(),
          source: overlay.querySelector("#cc-source").value,
          notes: overlay.querySelector("#cc-notes").value,
          tags,
          interviewDate: overlay.querySelector("#cc-interview-date").value || null,
          interviewTime: overlay.querySelector("#cc-interview-time").value || null,
        });
        showToast("сохранено");
        close();
      });

      overlay.querySelector("#cc-archive").addEventListener("click", async () => {
        await update(ref(db, `candidates/${candidateId}`), { archived: true, archivedAt: Date.now() });
        showToast("кандидат архивирован");
        close();
      });

      overlay.querySelector("#cc-delete").addEventListener("click", async () => {
        const ok = await confirmDialog("вы действительно хотите удалить кандидата?");
        if (!ok) return;
        await remove(ref(db, `candidates/${candidateId}`));
        showToast("кандидат удалён");
        close();
      });

      overlay.querySelector("#cc-mark-no-show").addEventListener("click", async () => {
        await markNoShow(candidateId);
        close();
      });
    },
  });
}

// === ДОКУМЕНТЫ ===
function renderDocSlot(candidateId, docType, docData) {
  if (docData) {
    return `
      <div class="doc-slot doc-slot-filled" data-doc="${docType.key}">
        <div class="doc-slot-info">
          <span class="doc-slot-icon">📄</span>
          <div>
            <div class="doc-slot-name">${escapeHtml(docData.name)}</div>
            <div class="doc-slot-label">${docType.label}</div>
          </div>
        </div>
        <div class="doc-slot-actions">
          <button class="btn btn-ghost btn-sm" data-action="open" data-doc="${docType.key}">открыть</button>
          <button class="btn btn-secondary btn-sm" data-action="replace" data-doc="${docType.key}">заменить</button>
          <button class="btn btn-danger btn-sm" data-action="delete" data-doc="${docType.key}">удалить</button>
        </div>
        <input type="file" accept="application/pdf" hidden data-input="${docType.key}" />
      </div>
    `;
  }
  return `
    <div class="doc-slot doc-slot-empty" data-doc="${docType.key}">
      <div class="doc-slot-dropzone" data-dropzone="${docType.key}">
        <span>перетащите ${docType.label} (pdf) сюда или</span>
        <button class="btn btn-secondary btn-sm" data-action="pick" data-doc="${docType.key}">выбрать файл</button>
      </div>
      <input type="file" accept="application/pdf" hidden data-input="${docType.key}" />
    </div>
  `;
}

function bindDocSlots(overlay, candidateId) {
  DOC_TYPES.forEach((docType) => bindSingleDocSlot(overlay, candidateId, docType));
}

async function handleDocUpload(candidateId, docType, file, overlay) {
  if (file.type !== "application/pdf") {
    showToast("нужен файл в формате pdf", "error");
    return;
  }
  if (file.size > MAX_DOC_SIZE) {
    showToast("файл слишком большой (максимум 4мб)", "error");
    return;
  }
  showToast(`загружаю ${docType.label}...`);
  try {
    const dataUrl = await fileToBase64(file);
    await uploadCandidateDocument(candidateId, docType, file, dataUrl);
    showToast(`${docType.label} загружена`);
    refreshDocSlot(overlay, candidateId, docType);
  } catch (err) {
    showToast("не удалось загрузить файл. проверьте соединение и попробуйте снова", "error");
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function openBase64Pdf(dataUrl) {
  try {
    const base64 = dataUrl.split(",")[1];
    const byteChars = atob(base64);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/pdf" });
    window.open(URL.createObjectURL(blob), "_blank");
  } catch (err) {
    showToast("не удалось открыть файл", "error");
  }
}

function refreshDocSlot(overlay, candidateId, docType) {
  const c = state.candidates[candidateId];
  const oldSlot = overlay.querySelector(`.doc-slot[data-doc="${docType.key}"]`);
  if (!oldSlot) return;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = renderDocSlot(candidateId, docType, c?.documents?.[docType.key]);
  const newSlot = wrapper.firstElementChild;
  oldSlot.replaceWith(newSlot);
  bindSingleDocSlot(overlay, candidateId, docType);
}

function bindSingleDocSlot(overlay, candidateId, docType) {
  const slot = overlay.querySelector(`.doc-slot[data-doc="${docType.key}"]`);
  if (!slot) return;
  const fileInput = slot.querySelector(`input[data-input="${docType.key}"]`);
  const pickBtn = slot.querySelector('[data-action="pick"]');
  const replaceBtn = slot.querySelector('[data-action="replace"]');
  const deleteBtn = slot.querySelector('[data-action="delete"]');
  const openBtn = slot.querySelector('[data-action="open"]');

  if (pickBtn) pickBtn.addEventListener("click", () => fileInput.click());
  if (replaceBtn) replaceBtn.addEventListener("click", () => fileInput.click());
  if (openBtn) openBtn.addEventListener("click", () => {
    const c = state.candidates[candidateId];
    const docData = c?.documents?.[docType.key];
    if (docData) openBase64Pdf(docData.dataUrl);
  });
  if (deleteBtn) deleteBtn.addEventListener("click", async () => {
    const ok = await confirmDialog(`удалить ${docType.label}?`);
    if (!ok) return;
    await deleteCandidateDocument(candidateId, docType);
    refreshDocSlot(overlay, candidateId, docType);
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    await handleDocUpload(candidateId, docType, file, overlay);
  });

  const dropzone = slot.querySelector(`[data-dropzone="${docType.key}"]`);
  if (dropzone) {
    dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("doc-dropzone-active"); });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("doc-dropzone-active"));
    dropzone.addEventListener("drop", async (e) => {
      e.preventDefault();
      dropzone.classList.remove("doc-dropzone-active");
      const file = e.dataTransfer.files[0];
      if (!file) return;
      await handleDocUpload(candidateId, docType, file, overlay);
    });
  }
}

async function uploadCandidateDocument(candidateId, docType, file, dataUrl) {
  const docPayload = { name: file.name, dataUrl, size: file.size, uploadedAt: Date.now(), uploadedBy: state.currentUser.uid };
  const updates = { [`documents/${docType.key}`]: docPayload };
  if (docType.key === "anketa") updates.hasForm = true;

  await update(ref(db, `candidates/${candidateId}`), updates);
  await push(ref(db, `candidates/${candidateId}/history`), {
    action: `загрузил(а) ${docType.label}`,
    userName: state.currentUser.name || state.currentUser.email,
    at: serverTimestamp(),
  });
}

async function deleteCandidateDocument(candidateId, docType) {
  const updates = { [`documents/${docType.key}`]: null };
  if (docType.key === "anketa") updates.hasForm = false;
  await update(ref(db, `candidates/${candidateId}`), updates);
  await push(ref(db, `candidates/${candidateId}/history`), {
    action: `удалил(а) ${docType.label}`,
    userName: state.currentUser.name || state.currentUser.email,
    at: serverTimestamp(),
  });
  showToast(`${docType.label} удалена`);
}

// === БАЗА КАНДИДАТОВ ===
const candidatesTableBody = document.getElementById("candidates-table-body");
const candidatesSearch = document.getElementById("candidates-search");
const filterVacancy = document.getElementById("candidates-filter-vacancy");
const filterStage = document.getElementById("candidates-filter-stage");
const filterSource = document.getElementById("candidates-filter-source");

[candidatesSearch, filterVacancy, filterStage, filterSource].forEach((el) => el.addEventListener("input", renderCandidatesTable));

function renderCandidateFilters() {
  filterVacancy.innerHTML = '<option value="all">все вакансии</option>' +
    Object.entries(state.vacancies).map(([id, v]) => `<option value="${id}">${escapeHtml(v.title)}</option>`).join("");
  filterStage.innerHTML = '<option value="all">все этапы</option>' +
    KANBAN_STAGES.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
}

function renderCandidatesTable() {
  const term = candidatesSearch.value.trim().toLowerCase();
  const vId = filterVacancy.value;
  const stg = filterStage.value;
  const src = filterSource.value;

  candidatesTableBody.innerHTML = "";
  Object.entries(state.candidates)
    .filter(([, c]) => {
      const matchesTerm = !term ||
        (c.name || "").toLowerCase().includes(term) ||
        (c.phone || "").toLowerCase().includes(term) ||
        (state.vacancies[c.vacancyId]?.title || "").toLowerCase().includes(term);
      const matchesVacancy = vId === "all" || c.vacancyId === vId;
      const matchesStage = stg === "all" || c.stage === stg;
      const matchesSource = src === "all" || c.source === src;
      return matchesTerm && matchesVacancy && matchesStage && matchesSource && !c.archived;
    })
    .forEach(([id, c]) => {
      const tr = document.createElement("tr");
      const stageLabel = KANBAN_STAGES.find((s) => s.id === c.stage)?.label || c.stage;
      tr.innerHTML = `
        <td>${escapeHtml(c.name || "")}</td>
        <td>${formatPhone(c.phone)}</td>
        <td>${escapeHtml(state.vacancies[c.vacancyId]?.title || "—")}</td>
        <td>${escapeHtml(stageLabel || "")}</td>
        <td>${escapeHtml(c.source || "")}</td>
        <td>${c.createdAt ? formatDate(c.createdAt) : ""}</td>
        <td>${escapeHtml(c.recruiterName || "")}</td>
        <td>${(c.tags || []).map(t => `<span class="tag tag-info">${escapeHtml(t)}</span>`).join("")}</td>
      `;
      tr.addEventListener("click", () => openCandidateModal(id));
      candidatesTableBody.appendChild(tr);
    });
}

// === ПОЛЬЗОВАТЕЛИ ===
const usersTableBody = document.getElementById("users-table-body");

function renderUsersTable() {
  usersTableBody.innerHTML = "";
  Object.entries(state.users).forEach(([uid, u]) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(u.name || "")}</td>
      <td>${escapeHtml(u.email || "")}</td>
      <td>${formatPhone(u.phone || "")}</td>
      <td>${u.role === "admin" ? "администратор" : "рекрутер"}</td>
      <td style="text-align:right;">
        ${u.isMainAdmin ? '<span class="progress-label">главный админ</span>' : `
          <button class="btn btn-ghost btn-sm" data-action="edit-user" data-uid="${uid}">изменить</button>
          <button class="btn btn-ghost btn-sm" data-action="delete-user" data-uid="${uid}">удалить</button>
        `}
      </td>
    `;
    usersTableBody.appendChild(tr);
  });

  usersTableBody.querySelectorAll('[data-action="edit-user"]').forEach((btn) =>
    btn.addEventListener("click", () => openEditUserModal(btn.dataset.uid)));
  usersTableBody.querySelectorAll('[data-action="delete-user"]').forEach((btn) =>
    btn.addEventListener("click", () => handleDeleteUser(btn.dataset.uid)));
}

document.getElementById("add-user-btn").addEventListener("click", () => {
  openModal({
    title: "новый пользователь",
    bodyHtml: `
      <label class="field"><span class="field-label">имя</span><input class="field-input" id="u-name" /></label>
      <label class="field"><span class="field-label">email</span><input type="email" class="field-input" id="u-email" /></label>
      <label class="field"><span class="field-label">телефон</span><input class="field-input" id="u-phone" placeholder="7 999 999-99-99" /></label>
      <label class="field"><span class="field-label">пароль</span><input type="password" class="field-input" id="u-password" /></label>
      <label class="field"><span class="field-label">роль</span>
        <select class="select" id="u-role">
          <option value="recruiter">рекрутер</option>
          <option value="admin">администратор</option>
        </select>
      </label>
    `,
    footerHtml: `
      <button class="btn btn-secondary" id="u-cancel">отмена</button>
      <button class="btn btn-primary" id="u-save">создать</button>
    `,
    onMount: (overlay, close) => {
      overlay.querySelectorAll(".field-input, .select").forEach((el) => {
        el.style.cssText = "height:38px;border:1px solid var(--border);border-radius:8px;padding:0 12px;background:var(--bg);color:var(--text);width:100%;";
      });
      overlay.querySelector("#u-cancel").addEventListener("click", close);
      overlay.querySelector("#u-save").addEventListener("click", async () => {
        const name = overlay.querySelector("#u-name").value.trim();
        const email = overlay.querySelector("#u-email").value.trim();
        const phone = overlay.querySelector("#u-phone").value.trim();
        const password = overlay.querySelector("#u-password").value;
        const role = overlay.querySelector("#u-role").value;

        if (!name || !email || password.length < 6) {
          showToast("заполните имя, email и пароль (мин. 6 символов)", "error");
          return;
        }

        const saveBtn = overlay.querySelector("#u-save");
        saveBtn.disabled = true;
        try {
          await createUserAsAdmin({ email, password, name, phone, role });
          showToast("пользователь создан");
          close();
        } catch (err) {
          showToast(err.code === "auth/email-already-in-use" ? "такой email уже используется" : "ошибка создания пользователя", "error");
          saveBtn.disabled = false;
        }
      });
    },
  });
});

function openEditUserModal(uid) {
  const u = state.users[uid];
  if (!u) return;
  openModal({
    title: "изменить пользователя",
    bodyHtml: `
      <label class="field"><span class="field-label">имя</span><input class="field-input" id="eu-name" value="${escapeHtml(u.name || "")}" /></label>
      <label class="field"><span class="field-label">телефон</span><input class="field-input" id="eu-phone" value="${escapeHtml(u.phone || "")}" placeholder="7 999 999-99-99" /></label>
      <label class="field"><span class="field-label">роль</span>
        <select class="select" id="eu-role">
          <option value="recruiter" ${u.role === "recruiter" ? "selected" : ""}>рекрутер</option>
          <option value="admin" ${u.role === "admin" ? "selected" : ""}>администратор</option>
        </select>
      </label>
      <p style="color:var(--text-secondary);font-size:12px;margin:0;">
        смена пароля другого пользователя недоступна на бесплатном тарифе firebase (нужен admin sdk / план blaze) —
        пусть меняет пароль сам через настройки → профиль.
      </p>
    `,
    footerHtml: `
      <button class="btn btn-secondary" id="eu-cancel">отмена</button>
      <button class="btn btn-primary" id="eu-save">сохранить</button>
    `,
    onMount: (overlay, close) => {
      overlay.querySelectorAll(".field-input, .select").forEach((el) => {
        el.style.cssText = "height:38px;border:1px solid var(--border);border-radius:8px;padding:0 12px;background:var(--bg);color:var(--text);width:100%;";
      });
      overlay.querySelector("#eu-cancel").addEventListener("click", close);
      overlay.querySelector("#eu-save").addEventListener("click", async () => {
        await update(ref(db, `users/${uid}`), {
          name: overlay.querySelector("#eu-name").value.trim(),
          phone: overlay.querySelector("#eu-phone").value.trim(),
          role: overlay.querySelector("#eu-role").value,
        });
        showToast("пользователь обновлён");
        close();
      });
    },
  });
}

async function handleDeleteUser(uid) {
  const u = state.users[uid];
  if (!u) return;
  const ok = await confirmDialog(`удалить пользователя «${escapeHtml(u.name)}»? его кандидаты перейдут главному администратору.`);
  if (!ok) return;

  const mainAdminEntry = Object.entries(state.users).find(([, x]) => x.isMainAdmin);
  if (!mainAdminEntry) { showToast("не найден главный администратор для передачи кандидатов", "error"); return; }
  const [mainAdminUid, mainAdminData] = mainAdminEntry;

  const reassignedCandidates = Object.entries(state.candidates).filter(([, c]) => c.recruiterId === uid);
  const updates = {};
  reassignedCandidates.forEach(([id]) => {
    updates[`candidates/${id}/recruiterId`] = mainAdminUid;
    updates[`candidates/${id}/recruiterName`] = mainAdminData.name;
  });
  updates[`users/${uid}`] = null;

  await update(ref(db), updates);
  showToast("пользователь удалён, кандидаты переданы главному администратору");
}

// === ИМПОРТ/ЭКСПОРТ КАНДИДАТОВ ===
document.getElementById("export-candidates-btn")?.addEventListener("click", () => {
  const data = Object.entries(state.candidates).map(([id, c]) => ({
    id,
    name: c.name,
    phone: c.phone,
    source: c.source,
    vacancy: state.vacancies[c.vacancyId]?.title || "",
    stage: KANBAN_STAGES.find(s => s.id === c.stage)?.label || c.stage,
    recruiter: c.recruiterName,
    createdAt: c.createdAt ? new Date(c.createdAt).toISOString() : "",
    tags: (c.tags || []).join(", "),
    notes: c.notes || "",
    archived: c.archived || false,
    noShowCount: c.noShowCount || 0,
  }));

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `candidates-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  showToast("кандидаты экспортированы");
});

document.getElementById("import-candidates-btn")?.addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error("ожидается массив кандидатов");

      const ok = await confirmDialog(`найдено ${data.length} кандидатов. импортировать?`);
      if (!ok) return;

      let imported = 0;
      for (const c of data) {
        const payload = {
          name: c.name || "без имени",
          phone: c.phone || "",
          source: c.source || "other",
          stage: c.stage || "response",
          recruiterId: state.currentUser.uid,
          recruiterName: state.currentUser.name || state.currentUser.email,
          createdAt: c.createdAt ? new Date(c.createdAt).getTime() : Date.now(),
          tags: c.tags ? c.tags.split(",").map(t => t.trim()).filter(Boolean) : [],
          notes: c.notes || "",
          archived: c.archived || false,
          noShowCount: c.noShowCount || 0,
          hasForm: false,
        };

        // ищем вакансию по названию
        if (c.vacancy) {
          const vacancyEntry = Object.entries(state.vacancies).find(([, v]) => v.title === c.vacancy);
          if (vacancyEntry) payload.vacancyId = vacancyEntry[0];
        }

        await push(ref(db, "candidates"), payload);
        imported++;
      }

      showToast(`импортировано ${imported} кандидатов`);
    } catch (err) {
      showToast("ошибка импорта: " + err.message, "error");
    }
  };
  input.click();
});

// === АНАЛИТИКА ===
const PERIODS = [
  { value: "day", label: "день" },
  { value: "week", label: "неделя" },
  { value: "month", label: "месяц" },
  { value: "year", label: "год" },
];

function renderAnalytics() {
  const period = document.getElementById("analytics-period")?.value || "week";
  const candidates = Object.values(state.candidates);
  const now = Date.now();

  // Фильтр по периоду
  const periodMs = {
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
    year: 365 * 24 * 60 * 60 * 1000,
  };

  const cutoff = now - (periodMs[period] || periodMs.week);
  const filtered = candidates.filter(c => (c.createdAt || 0) >= cutoff);

  // Конверсия по этапам
  const stageCounts = {};
  KANBAN_STAGES.forEach(s => stageCounts[s.id] = 0);
  filtered.forEach(c => {
    if (stageCounts[c.stage] !== undefined) stageCounts[c.stage]++;
  });

  const total = filtered.length;
  const responseCount = stageCounts.response || 0;
  const hiredCount = stageCounts.hired || 0;
  const conversionRate = total > 0 ? Math.round((hiredCount / total) * 100) : 0;

  // По источникам
  const sourceCounts = {};
  filtered.forEach(c => {
    const src = c.source || "other";
    sourceCounts[src] = (sourceCounts[src] || 0) + 1;
  });

  // По рекрутерам
  const recruiterCounts = {};
  filtered.forEach(c => {
    const recruiter = c.recruiterName || "неизвестен";
    recruiterCounts[recruiter] = (recruiterCounts[recruiter] || 0) + 1;
  });

  // По тегам
  const tagCounts = {};
  filtered.forEach(c => {
    (c.tags || []).forEach(t => {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    });
  });

  // Архив
  const archivedCount = filtered.filter(c => c.archived).length;

  const container = document.getElementById("analytics-content");
  if (!container) return;

  container.innerHTML = `
    <div class="analytics-period">
      <label class="field-label">период</label>
      <select id="analytics-period" class="select">
        ${PERIODS.map(p => `<option value="${p.value}" ${p.value === period ? "selected" : ""}>${p.label}</option>`).join("")}
      </select>
    </div>

    <div class="analytics-grid">
      <div class="analytics-card"><div class="analytics-num">${total}</div><div class="analytics-label">всего кандидатов</div></div>
      <div class="analytics-card"><div class="analytics-num">${responseCount}</div><div class="analytics-label">откликов</div></div>
      <div class="analytics-card"><div class="analytics-num">${hiredCount}</div><div class="analytics-label">трудоустроено</div></div>
      <div class="analytics-card"><div class="analytics-num">${conversionRate}%</div><div class="analytics-label">конверсия</div></div>
      <div class="analytics-card"><div class="analytics-num">${archivedCount}</div><div class="analytics-label">в архиве</div></div>
    </div>

    <div class="analytics-bars">
      <div class="analytics-bars-title">кандидаты по этапам</div>
      ${renderAnalyticsBars(KANBAN_STAGES.map(s => ({ label: s.label, value: stageCounts[s.id] || 0 })))}
    </div>

    <div class="analytics-bars">
      <div class="analytics-bars-title">кандидаты по источникам</div>
      ${renderAnalyticsBars(Object.entries(sourceCounts).map(([label, value]) => ({ label, value })))}
    </div>

    <div class="analytics-bars">
      <div class="analytics-bars-title">кандидаты по рекрутерам</div>
      ${renderAnalyticsBars(Object.entries(recruiterCounts).map(([label, value]) => ({ label, value })))}
    </div>

    <div class="analytics-bars">
      <div class="analytics-bars-title">популярность тегов</div>
      ${renderAnalyticsBars(Object.entries(tagCounts).map(([label, value]) => ({ label, value })))}
    </div>
  `;

  document.getElementById("analytics-period")?.addEventListener("change", renderAnalytics);
}

function renderAnalyticsBars(data) {
  const max = Math.max(1, ...data.map(d => d.value));
  return data.map(({ label, value }) => `
    <div class="bar-row">
      <span class="bar-label">${escapeHtml(label)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(value / max) * 100}%"></div></div>
      <span class="bar-value">${value}</span>
    </div>
  `).join("") || '<div class="empty-state">нет данных</div>';
}

// === НАСТРОЙКИ ===
document.getElementById("settings-btn").addEventListener("click", () => {
  const currentTheme = document.documentElement.dataset.theme || "light";
  const u = state.currentUser;
  const stats = computeAnalytics();

  openModal({
    title: "настройки",
    wide: true,
    bodyHtml: `
      <div class="settings-block">
        <h3 class="settings-block-title">профиль</h3>
        <label class="field"><span class="field-label">имя</span><input class="field-input" id="s-name" value="${escapeHtml(u.name || "")}" /></label>
        <label class="field"><span class="field-label">телефон</span><input class="field-input" id="s-phone" value="${escapeHtml(u.phone || "")}" placeholder="7 999 999-99-99" /></label>
        <label class="field"><span class="field-label">email</span><input class="field-input" value="${escapeHtml(u.email || "")}" disabled /></label>
        <label class="field"><span class="field-label">новый пароль (необязательно, мин. 6 символов)</span><input type="password" class="field-input" id="s-password" /></label>
        <button class="btn btn-secondary" id="s-save-profile">сохранить профиль</button>
      </div>

      <div class="settings-block">
        <h3 class="settings-block-title">внешний вид</h3>
        <label class="field"><span class="field-label">тема</span>
          <select class="select" id="theme-select">
            <option value="light" ${currentTheme === "light" ? "selected" : ""}>светлая</option>
            <option value="dark" ${currentTheme === "dark" ? "selected" : ""}>тёмная</option>
          </select>
        </label>
      </div>

      ${u.role === "admin" ? `
      <div class="settings-block">
        <h3 class="settings-block-title">аналитика</h3>
        <div class="analytics-grid">
          <div class="analytics-card"><div class="analytics-num">${stats.totalCandidates}</div><div class="analytics-label">всего кандидатов</div></div>
          <div class="analytics-card"><div class="analytics-num">${stats.activeVacancies}</div><div class="analytics-label">активных вакансий</div></div>
          <div class="analytics-card"><div class="analytics-num">${stats.hired}</div><div class="analytics-label">трудоустроено</div></div>
          <div class="analytics-card"><div class="analytics-num">${stats.archived}</div><div class="analytics-label">архивных кандидатов</div></div>
          <div class="analytics-card"><div class="analytics-num">${stats.interviewsToday}</div><div class="analytics-label">собеседований сегодня</div></div>
          <div class="analytics-card"><div class="analytics-num">${stats.conversionRate || 0}%</div><div class="analytics-label">конверсия</div></div>
        </div>
        <div class="analytics-bars">
          <div class="analytics-bars-title">кандидаты по источникам</div>
          ${renderBarChart(stats.bySource)}
        </div>
        <div class="analytics-bars">
          <div class="analytics-bars-title">кандидаты по этапам</div>
          ${renderBarChart(stats.byStage)}
        </div>
      </div>

      <div class="settings-block">
        <h3 class="settings-block-title">резервное копирование</h3>
        <div class="section-actions">
          <button class="btn btn-secondary" id="s-export">экспортировать базу</button>
          <label class="btn btn-secondary" for="s-import-input" style="cursor:pointer;">импортировать базу</label>
          <input type="file" id="s-import-input" accept="application/json" hidden />
        </div>
      </div>
      ` : ""}
    `,
    onMount: (overlay) => {
      overlay.querySelectorAll(".field-input, .select").forEach((el) => {
        el.style.cssText = "height:38px;border:1px solid var(--border);border-radius:8px;padding:0 12px;background:var(--bg);color:var(--text);width:100%;";
      });

      overlay.querySelector("#theme-select").addEventListener("change", (e) => {
        document.documentElement.dataset.theme = e.target.value;
        localStorage.setItem("demcrm-theme", e.target.value);
      });

      overlay.querySelector("#s-save-profile").addEventListener("click", async () => {
        const name = overlay.querySelector("#s-name").value.trim();
        const phone = overlay.querySelector("#s-phone").value.trim();
        const newPassword = overlay.querySelector("#s-password").value;
        try {
          const updates = {};
          if (name && name !== u.name) updates.name = name;
          if (phone !== u.phone) updates.phone = phone;
          if (Object.keys(updates).length > 0) {
            await update(ref(db, `users/${u.uid}`), updates);
          }
          if (newPassword) {
            if (newPassword.length < 6) { showToast("пароль должен быть от 6 символов", "error"); return; }
            await updatePassword(auth.currentUser, newPassword);
          }
          showToast("профиль обновлён");
        } catch (err) {
          showToast("не удалось обновить профиль. возможно, нужно перезайти в систему", "error");
        }
      });

      const exportBtn = overlay.querySelector("#s-export");
      if (exportBtn) exportBtn.addEventListener("click", exportDatabase);

      const importInput = overlay.querySelector("#s-import-input");
      if (importInput) importInput.addEventListener("change", async () => {
        const file = importInput.files[0];
        if (!file) return;
        const ok = await confirmDialog("импорт полностью заменит текущие данные вакансий и кандидатов. продолжить?");
        if (!ok) return;
        await importDatabase(file);
      });
    },
  });
});

function computeAnalytics() {
  const candidates = Object.values(state.candidates);
  const today = new Date().toISOString().slice(0, 10);
  const bySource = {};
  const byStage = {};
  let hired = 0;
  candidates.forEach((c) => {
    bySource[c.source || "прочее"] = (bySource[c.source || "прочее"] || 0) + 1;
    const stageLabel = KANBAN_STAGES.find((s) => s.id === c.stage)?.label || c.stage || "—";
    byStage[stageLabel] = (byStage[stageLabel] || 0) + 1;
    if (c.stage === "hired") hired++;
  });

  const total = candidates.length;
  const conversionRate = total > 0 ? Math.round((hired / total) * 100) : 0;

  return {
    totalCandidates: total,
    activeVacancies: Object.values(state.vacancies).filter((v) => v.status === "active").length,
    hired,
    archived: candidates.filter((c) => c.archived).length,
    interviewsToday: candidates.filter((c) => c.interviewDate === today).length,
    conversionRate,
    bySource,
    byStage,
  };
}

function renderBarChart(dataObj) {
  const entries = Object.entries(dataObj);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return entries.map(([label, value]) => `
    <div class="bar-row">
      <span class="bar-label">${escapeHtml(label)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(value / max) * 100}%"></div></div>
      <span class="bar-value">${value}</span>
    </div>
  `).join("") || '<div class="empty-state" style="padding:12px 0;">нет данных</div>';
}

function exportDatabase() {
  const payload = {
    exportedAt: new Date().toISOString(),
    vacancies: state.vacancies,
    candidates: state.candidates,
    users: Object.fromEntries(Object.entries(state.users).map(([uid, u]) => [uid, { name: u.name, email: u.email, phone: u.phone, role: u.role }])),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `demcrm-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  showToast("база экспортирована");
}

async function importDatabase(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.vacancies || !data.candidates) throw new Error("некорректный формат файла");

    await update(ref(db), {
      vacancies: data.vacancies,
      candidates: data.candidates,
    });
    showToast("база импортирована");
  } catch (err) {
    showToast("не удалось импортировать файл. проверьте формат и попробуйте снова", "error");
  }
}

// === ТЕМА ===
const savedTheme = localStorage.getItem("demcrm-theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

// === ГЛОБАЛЬНЫЙ ПОИСК ===
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openGlobalSearch();
  }
});

function openGlobalSearch() {
  openModal({
    title: "глобальный поиск",
    bodyHtml: `
      <input type="text" id="gs-input" class="field-input" placeholder="кандидаты, вакансии..." style="height:40px;border:1px solid var(--border);border-radius:8px;padding:0 12px;background:var(--bg);color:var(--text);width:100%;" />
      <div id="gs-results" class="gs-results"></div>
    `,
    onMount: (overlay) => {
      const input = overlay.querySelector("#gs-input");
      const results = overlay.querySelector("#gs-results");
      input.focus();

      input.addEventListener("input", () => {
        const term = input.value.trim().toLowerCase();
        results.innerHTML = "";
        if (!term) return;

        const vacancyMatches = Object.entries(state.vacancies).filter(([, v]) => (v.title || "").toLowerCase().includes(term));
        const candidateMatches = Object.entries(state.candidates).filter(([, c]) => (c.name || "").toLowerCase().includes(term) || (c.phone || "").includes(term));

        vacancyMatches.forEach(([id, v]) => {
          const row = document.createElement("div");
          row.className = "gs-result";
          row.innerHTML = `<span class="tag tag-info">вакансия</span> ${escapeHtml(v.title)}`;
          row.addEventListener("click", () => { document.getElementById("modal-root").innerHTML = ""; openKanban(id); });
          results.appendChild(row);
        });
        candidateMatches.forEach(([id, c]) => {
          const row = document.createElement("div");
          row.className = "gs-result";
          row.innerHTML = `<span class="tag tag-success">кандидат</span> ${escapeHtml(c.name)} · ${formatPhone(c.phone || "")}`;
          row.addEventListener("click", () => { document.getElementById("modal-root").innerHTML = ""; switchSection("candidates"); openCandidateModal(id); });
          results.appendChild(row);
        });
        if (!vacancyMatches.length && !candidateMatches.length) {
          results.innerHTML = '<div class="empty-state" style="padding:16px 0;">ничего не найдено</div>';
        }
      });
    },
  });
}

// === СТАРТ ===
ensureMainAdmin();
