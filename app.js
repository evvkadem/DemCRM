import {
  app, auth, db, storage,
  loginUser, logoutUser, watchAuth,
  dbGet, dbSet, dbUpdate, dbRemove, dbPushKey, dbWatch, nowStamp,
  ref, push, serverTimestamp,
  storageRef, uploadBytes, getDownloadURL, deleteObject,
  updatePassword
} from "./firebase.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getAuth as getAuthSecondary, createUserWithEmailAndPassword, signOut as signOutSecondary } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

/* ===================== константы ===================== */

const STAGES = [
  { key: "response", label: "Отклик" },
  { key: "selected1", label: "Подходящий отклик" },
  { key: "invited", label: "Приглашён" },
  { key: "form", label: "Анкета" },
  { key: "interview", label: "Собеседование" },
  { key: "selected2", label: "Отобрано" },
  { key: "director", label: "Собеседование с директором" },
  { key: "hired", label: "Трудоустройство" }
];

const STAGES_FOR_AUTO_ARCHIVE = ["response", "selected1", "invited"]; // этапы для автоархивации

// правила проверки перехода между этапами — легко расширяется новыми объектами
const STAGE_TRANSITION_RULES = [
  {
    from: "interview",
    to: "selected2",
    check: (candidate) => !!(candidate.documents && candidate.documents.anketa),
    message: "Анкета кандидата не загружена.\nВы действительно хотите перевести кандидата на следующий этап без анкеты?"
  }
];

const SOURCES = [
  { key: "hh", label: "hh" },
  { key: "авито", label: "Авито" },
  { key: "прочее", label: "Прочее" }
];

/* ===================== состояние ===================== */

const state = {
  currentUser: null, // { uid, name, email, role, phone }
  users: {},
  vacancies: {},
  candidates: {},
  activeVacancyId: null,
  pendingStageMove: null,
  currentCandidateId: null,
  notesTimer: null,
  historyDebounceTimer: null,
  theme: localStorage.getItem("demcrm_theme") || "light",
  analyticsDate: new Date(),
  analyticsPeriod: "day",
  missedInterviewCount: {} // для отслеживания пропусков собеседований
};

/* ===================== утилиты ===================== */

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function escapeHtml(str) {
  if (str === undefined || str === null) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatDateTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleDateString("ru-RU") + " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function isSameDay(ts, date2 = new Date()) {
  if (!ts) return false;
  const d = new Date(ts);
  return d.getFullYear() === date2.getFullYear() && d.getMonth() === date2.getMonth() && d.getDate() === date2.getDate();
}

function isToday(ts) {
  return isSameDay(ts);
}

function initials(name) {
  if (!name) return "?";
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
}

function stageLabel(key) {
  const s = STAGES.find((s) => s.key === key);
  return s ? s.label : key;
}

function toast(message, type = "info") {
  const stack = $("#toastStack");
  const el = document.createElement("div");
  el.className = "toast" + (type === "error" ? " toast-error" : "");
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

function openModal(id) { $(id).classList.remove("hidden"); }
function closeModal(id) { $(id).classList.add("hidden"); }

function debounce(fn, delay) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

function formatPhone(phone) {
  if (!phone) return "";
  // Убираем все кроме цифр
  let cleaned = String(phone).replace(/\D/g, "");
  if (cleaned.length === 11 && cleaned.startsWith("7")) {
    return `7 ${cleaned.slice(1, 4)} ${cleaned.slice(4, 7)}-${cleaned.slice(7, 9)}-${cleaned.slice(9, 11)}`;
  }
  if (cleaned.length === 10) {
    return `7 ${cleaned.slice(0, 3)} ${cleaned.slice(3, 6)}-${cleaned.slice(6, 8)}-${cleaned.slice(8, 10)}`;
  }
  return phone;
}

function parsePhone(phone) {
  if (!phone) return "";
  return String(phone).replace(/\D/g, "");
}

function getTagsArray(tagsStr) {
  if (!tagsStr) return [];
  return tagsStr.split(",").map(t => t.trim()).filter(t => t);
}

function tagsToString(tagsArray) {
  return tagsArray.join(", ");
}

function getStageIndex(key) {
  return STAGES.findIndex(s => s.key === key);
}

/* ===================== тема ===================== */

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("demcrm_theme", theme);
  $all(".theme-option").forEach((b) => b.classList.toggle("active", b.dataset.theme === theme));
}

/* ===================== история действий кандидата ===================== */

async function pushHistory(candidateId, actionText) {
  const key = dbPushKey(`candidates/${candidateId}/history`);
  await dbSet(`candidates/${candidateId}/history/${key}`, {
    user: state.currentUser.name,
    action: actionText,
    time: nowStamp()
  });
}

/* ===================== авторизация ===================== */

function initAuth() {
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#loginEmail").value.trim();
    const password = $("#loginPassword").value;
    const remember = $("#loginRemember").checked;
    $("#loginError").classList.add("hidden");
    $("#loginSubmit").textContent = "Входим...";
    try {
      await loginUser(email, password, remember);
    } catch (err) {
      $("#loginError").textContent = "неверный email или пароль";
      $("#loginError").classList.remove("hidden");
    }
    $("#loginSubmit").textContent = "Войти";
  });

  watchAuth(async (fbUser) => {
    if (!fbUser) {
      state.currentUser = null;
      $("#app").classList.add("hidden");
      $("#loginScreen").classList.remove("hidden");
      return;
    }
    const profile = await dbGet(`users/${fbUser.uid}`);
    if (!profile) {
      $("#loginError").textContent = "у вашего аккаунта нет профиля в базе — обратитесь к администратору";
      $("#loginError").classList.remove("hidden");
      await logoutUser();
      return;
    }
    state.currentUser = { uid: fbUser.uid, email: fbUser.email, ...profile };
    $("#loginScreen").classList.add("hidden");
    $("#app").classList.remove("hidden");
    applyRoleUI();
    startDataWatchers();
    switchView("vacancies");
    // Запускаем проверку автоархивации
    checkAutoArchive();
  });
}

function applyRoleUI() {
  const isAdmin = state.currentUser.role === "администратор";
  $("#navUsers").classList.toggle("hidden", !isAdmin);
  $("#tabBackupBtn").classList.toggle("hidden", !isAdmin);
  $("#userChipName").textContent = state.currentUser.name || state.currentUser.email;
  $("#userChipRole").textContent = isAdmin ? "Администратор" : "Рекрутер";
  $("#userAvatar").textContent = initials(state.currentUser.name || state.currentUser.email);
}

$("#openSettings")?.addEventListener("click", () => openSettingsModal());

document.body.addEventListener("click", (e) => {
  if (e.target.id === "logoutBtn") logoutUser();
});

/* ===================== вотчеры данных ===================== */

function startDataWatchers() {
  dbWatch("users", (data) => { state.users = data || {}; renderUsersTable(); populateGlobalCaches(); populateManagerSelects(); });
  dbWatch("vacancies", (data) => { state.vacancies = data || {}; renderVacancies(); populateFilterOptions(); renderKanbanIfOpen(); });
  dbWatch("candidates", (data) => {
    state.candidates = data || {};
    renderVacancies();
    renderKanbanIfOpen();
    renderCandidatesTable();
    renderAnalytics();
    renderTodayInterviews();
    if (state.currentCandidateId) refreshOpenCandidateModal();
    checkAutoArchive();
  });
}

function populateGlobalCaches() {}

function populateManagerSelects() {
  const select = $("#vManager");
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">Выберите руководителя</option>' + 
    Object.entries(state.users || {}).map(([uid, u]) => 
      `<option value="${uid}">${escapeHtml(u.name)}</option>`
    ).join("");
  select.value = current;
}

/* ===================== навигация ===================== */

function switchView(name) {
  $all(".view").forEach((v) => v.classList.remove("active"));
  $(`#view-${name}`).classList.add("active");
  $all(".nav-item[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name === "candidates") renderCandidatesTable();
  if (name === "analytics") renderAnalytics();
}

$all(".nav-item[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

$("#kanbanBack").addEventListener("click", () => { state.activeVacancyId = null; switchView("vacancies"); });

/* ===================== ВАКАНСИИ ===================== */

let vacancyStatusFilter = "all";
let vacancySearchTerm = "";

$("#vacancyStatusFilter").addEventListener("click", (e) => {
  const btn = e.target.closest(".pill");
  if (!btn) return;
  vacancyStatusFilter = btn.dataset.status;
  $all("#vacancyStatusFilter .pill").forEach((p) => p.classList.toggle("active", p === btn));
  renderVacancies();
});

$("#vacancySearch").addEventListener("input", (e) => {
  vacancySearchTerm = e.target.value.trim().toLowerCase();
  renderVacancies();
});

function vacancyStats(vacancyId) {
  const list = Object.entries(state.candidates || {}).filter(([, c]) => c.vacancyId === vacancyId);
  const active = list.filter(([, c]) => !c.archived);
  const hired = list.filter(([, c]) => c.stage === "hired" && !c.archived);
  return { total: active.length, hired: hired.length };
}

function renderVacancies() {
  const grid = $("#vacancyGrid");
  let entries = Object.entries(state.vacancies || {});
  if (vacancyStatusFilter !== "all") entries = entries.filter(([, v]) => v.status === vacancyStatusFilter);
  if (vacancySearchTerm) entries = entries.filter(([, v]) => (v.title || "").toLowerCase().includes(vacancySearchTerm));
  entries.sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  $("#vacancyEmpty").classList.toggle("hidden", entries.length > 0);
  grid.innerHTML = entries.map(([id, v]) => {
    const stats = vacancyStats(id);
    const positions = Number(v.positions) || 0;
    const progress = positions > 0 ? Math.min(100, Math.round((stats.hired / positions) * 100)) : 0;
    const manager = state.users[v.managerId];
    return `
      <div class="vacancy-card" data-id="${id}">
        <div class="vc-top">
          <span class="status-badge status-${escapeHtml(v.status)}">${escapeHtml(v.status)}</span>
        </div>
        <div class="vc-title">${escapeHtml(v.title)}</div>
        <div class="vc-manager">${escapeHtml(manager ? manager.name : v.manager || "")} ${v.managerPhone ? '· ' + escapeHtml(v.managerPhone) : ''}</div>
        <div class="vc-metrics">
          <div class="vc-metric"><b>${positions}</b><span>мест</span></div>
          <div class="vc-metric"><b>${stats.total}</b><span>кандидатов</span></div>
          <div class="vc-metric"><b>${stats.hired}</b><span>трудоустроено</span></div>
        </div>
        <div class="vc-progress-track"><div class="vc-progress-fill" style="width:${progress}%"></div></div>
        <div class="vc-progress-label">закрыто ${stats.hired} из ${positions} мест</div>
        <div class="vc-footer">
          <span class="vc-date">открыта ${formatDate(v.openDate ? new Date(v.openDate).getTime() : v.createdAt)}</span>
        </div>
      </div>`;
  }).join("");

  $all(".vacancy-card", grid).forEach((card) => {
    card.addEventListener("click", () => openKanban(card.dataset.id));
  });
}

$("#addVacancyBtn").addEventListener("click", () => openVacancyModal(null));

function openVacancyModal(id) {
  const isEdit = !!id;
  $("#vacancyModalTitle").textContent = isEdit ? "Редактировать вакансию" : "Новая вакансия";
  $("#deleteVacancyBtn").classList.toggle("hidden", !isEdit);
  $("#vacancyForm").reset();
  $("#vacancyId").value = id || "";
  populateManagerSelects();
  if (isEdit) {
    const v = state.vacancies[id];
    $("#vTitle").value = v.title || "";
    $("#vManager").value = v.managerId || "";
    $("#vManagerPhone").value = v.managerPhone || "";
    $("#vDescription").value = v.description || "";
    $("#vPositions").value = v.positions || 1;
    $("#vStatus").value = v.status || "активна";
    $("#vOpenDate").value = v.openDate || "";
    $("#vCloseDate").value = v.closeDate || "";
    $("#vComment").value = v.comment || "";
  } else {
    $("#vStatus").value = "активна";
    $("#vPositions").value = 1;
  }
  openModal("#modalVacancy");
}

$("#saveVacancyBtn").addEventListener("click", async () => {
  if (!$("#vacancyForm").reportValidity()) return;
  const id = $("#vacancyId").value || dbPushKey("vacancies");
  const managerId = $("#vManager").value;
  const manager = state.users[managerId];
  const payload = {
    title: $("#vTitle").value.trim(),
    managerId: managerId,
    manager: manager ? manager.name : "",
    managerPhone: $("#vManagerPhone").value.trim(),
    description: $("#vDescription").value.trim(),
    positions: Number($("#vPositions").value) || 1,
    status: $("#vStatus").value,
    openDate: $("#vOpenDate").value || "",
    closeDate: $("#vCloseDate").value || "",
    comment: $("#vComment").value.trim(),
    createdAt: (state.vacancies[id] && state.vacancies[id].createdAt) || nowStamp()
  };
  await dbSet(`vacancies/${id}`, payload);
  closeModal("#modalVacancy");
  toast("Вакансия сохранена");
});

$("#deleteVacancyBtn").addEventListener("click", async () => {
  const id = $("#vacancyId").value;
  if (!id) return;
  if (!confirm("Удалить вакансию? Кандидаты останутся в базе, но потеряют привязку.")) return;
  await dbRemove(`vacancies/${id}`);
  closeModal("#modalVacancy");
  toast("Вакансия удалена");
});

/* ===================== KANBAN ===================== */

function openKanban(vacancyId) {
  state.activeVacancyId = vacancyId;
  const v = state.vacancies[vacancyId];
  $("#kanbanTitle").textContent = v ? v.title : "Вакансия";
  switchView("kanban");
  renderKanban();
}

function renderKanbanIfOpen() {
  if (state.activeVacancyId && $("#view-kanban").classList.contains("active")) renderKanban();
}

function renderKanban() {
  const board = $("#kanbanBoard");
  const vacancyId = state.activeVacancyId;
  const candidates = Object.entries(state.candidates || {}).filter(([, c]) => c.vacancyId === vacancyId && !c.archived);

  board.innerHTML = STAGES.map((stage) => {
    const inStage = candidates.filter(([, c]) => c.stage === stage.key);
    inStage.sort((a, b) => {
      const ai = a[1].interview && a[1].interview.date ? new Date(a[1].interview.date).getTime() : Infinity;
      const bi = b[1].interview && b[1].interview.date ? new Date(b[1].interview.date).getTime() : Infinity;
      if (ai !== bi) return ai - bi;
      return (a[1].createdAt || 0) - (b[1].createdAt || 0);
    });
    return `
      <div class="kanban-col" data-stage="${stage.key}">
        <div class="kanban-col-header"><span>${escapeHtml(stage.label)}</span><span>${inStage.length}</span></div>
        <div class="kanban-col-body" data-stage="${stage.key}">
          ${inStage.map(([id, c]) => renderKcard(id, c)).join("")}
        </div>
      </div>`;
  }).join("");

  bindKanbanDnD();
  $all(".kcard", board).forEach((card) => {
    card.addEventListener("click", () => openCandidateModal(card.dataset.id));
  });
}

function renderKcard(id, c) {
  const tags = [];
  if (!c.documents || !c.documents.anketa) tags.push('<span class="tag tag-no-anketa">нет анкеты</span>');
  if (c.interview && c.interview.date && isToday(new Date(c.interview.date).getTime())) tags.push('<span class="tag tag-today">собеседование сегодня</span>');
  if (c.stage === "hired") tags.push('<span class="tag tag-hired">трудоустроен</span>');
  if (c.archived) tags.push('<span class="tag tag-archived">архивный</span>');
  if (c.tags && c.tags.includes("черный список")) tags.push('<span class="tag tag-blacklist">черный список</span>');
  if (c.missedCount && c.missedCount >= 3) tags.push('<span class="tag tag-blacklist">черный список</span>');
  
  const recruiter = state.users[c.recruiterId];
  return `
    <div class="kcard" draggable="true" data-id="${id}">
      <div class="kcard-name">${escapeHtml(c.name)}</div>
      <div class="kcard-phone">${escapeHtml(formatPhone(c.phone || ""))}</div>
      <div class="kcard-tags">${tags.join("")}</div>
      <div class="kcard-footer">
        <div class="kcard-avatar" title="${escapeHtml(recruiter ? recruiter.name : "")}">${initials(recruiter ? recruiter.name : "?")}</div>
        <div class="kcard-date">${formatDate(c.createdAt)}</div>
      </div>
    </div>`;
}

function bindKanbanDnD() {
  let draggedId = null;
  $all(".kcard").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      draggedId = card.dataset.id;
      card.classList.add("dragging");
      e.dataTransfer.setData("text/plain", draggedId);
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });
  $all(".kanban-col-body").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.closest(".kanban-col").classList.add("drag-over"); });
    col.addEventListener("dragleave", () => col.closest(".kanban-col").classList.remove("drag-over"));
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.closest(".kanban-col").classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain") || draggedId;
      const newStage = col.dataset.stage;
      if (id) attemptStageMove(id, newStage);
    });
  });
}

function attemptStageMove(candidateId, newStage) {
  const c = state.candidates[candidateId];
  if (!c || c.stage === newStage) return;
  const rule = STAGE_TRANSITION_RULES.find((r) => r.from === c.stage && r.to === newStage);
  if (rule && !rule.check(c)) {
    state.pendingStageMove = { candidateId, newStage };
    openModal("#modalConfirmStage");
    return;
  }
  commitStageMove(candidateId, newStage);
}

async function commitStageMove(candidateId, newStage) {
  const c = state.candidates[candidateId];
  const updates = { stage: newStage };
  if (newStage === "hired" && !c.hiredAt) updates.hiredAt = nowStamp();
  await dbUpdate(`candidates/${candidateId}`, updates);
  await pushHistory(candidateId, `перевёл(а) кандидата на этап «${stageLabel(newStage)}»`);
}

$("#cancelStageBtn").addEventListener("click", () => { state.pendingStageMove = null; closeModal("#modalConfirmStage"); renderKanban(); });
$("#continueStageBtn").addEventListener("click", async () => {
  if (state.pendingStageMove) await commitStageMove(state.pendingStageMove.candidateId, state.pendingStageMove.newStage);
  state.pendingStageMove = null;
  closeModal("#modalConfirmStage");
});

/* ===================== добавление кандидата ===================== */

$("#addCandidateBtn").addEventListener("click", () => {
  $("#addCandidateForm").reset();
  $("#candidateExistsWarning").classList.add("hidden");
  $("#cAddSource").value = "прочее";
  updateCustomSelect("cAddSourceSelect", "cAddSourceOptions", "прочее");
  openModal("#modalAddCandidate");
});

// Кастомные селекты
function initCustomSelects() {
  document.addEventListener("click", (e) => {
    const trigger = e.target.closest(".custom-select-trigger");
    if (trigger) {
      const targetId = trigger.dataset.target;
      const options = document.getElementById(targetId);
      if (options) {
        const isOpen = !options.classList.contains("hidden");
        // Закрываем все открытые
        $all(".custom-select-options").forEach(o => o.classList.add("hidden"));
        $all(".custom-select-trigger").forEach(t => t.classList.remove("active"));
        if (!isOpen) {
          options.classList.remove("hidden");
          trigger.classList.add("active");
        }
      }
      return;
    }
    
    const option = e.target.closest(".custom-select-option");
    if (option) {
      const value = option.dataset.value;
      const container = option.closest(".custom-select-options");
      const trigger = container.parentElement.querySelector(".custom-select-trigger");
      const hiddenInput = container.parentElement.parentElement.querySelector('input[type="hidden"]');
      if (trigger) {
        trigger.textContent = option.textContent;
        trigger.classList.remove("active");
      }
      if (hiddenInput) {
        hiddenInput.value = value;
      }
      container.classList.add("hidden");
      // trigger change event
      if (hiddenInput) {
        hiddenInput.dispatchEvent(new Event('change'));
      }
      return;
    }
    
    // Закрываем все при клике вне
    if (!e.target.closest(".custom-select")) {
      $all(".custom-select-options").forEach(o => o.classList.add("hidden"));
      $all(".custom-select-trigger").forEach(t => t.classList.remove("active"));
    }
  });
}

function updateCustomSelect(triggerId, optionsId, value) {
  const trigger = document.getElementById(triggerId);
  const options = document.getElementById(optionsId);
  const hiddenInput = options ? options.parentElement.parentElement.querySelector('input[type="hidden"]') : null;
  
  if (trigger) {
    const selectedOption = options ? options.querySelector(`.custom-select-option[data-value="${value}"]`) : null;
    if (selectedOption) {
      trigger.textContent = selectedOption.textContent;
    }
    // Убираем выделение со всех опций
    if (options) {
      options.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
      const opt = options.querySelector(`.custom-select-option[data-value="${value}"]`);
      if (opt) opt.classList.add('selected');
    }
  }
  if (hiddenInput) {
    hiddenInput.value = value;
  }
}

// Инициализация кастомных селектов
initCustomSelects();

// Проверка существования кандидата
function findExistingCandidate(name, phone) {
  const candidates = Object.entries(state.candidates || {});
  const phoneClean = parsePhone(phone);
  for (const [id, c] of candidates) {
    if (c.archived) continue;
    const cPhone = parsePhone(c.phone || "");
    if (c.name && name && c.name.toLowerCase() === name.toLowerCase()) {
      return { id, candidate: c };
    }
    if (phoneClean && cPhone === phoneClean) {
      return { id, candidate: c };
    }
  }
  return null;
}

$("#cAddName, #cAddPhone").oninput = function() {
  const name = $("#cAddName").value.trim();
  const phone = $("#cAddPhone").value.trim();
  if (name || phone) {
    const existing = findExistingCandidate(name, phone);
    const warning = $("#candidateExistsWarning");
    if (existing) {
      warning.classList.remove("hidden");
      $("#gotoExistingCandidate").onclick = (e) => {
        e.preventDefault();
        closeModal("#modalAddCandidate");
        const c = existing.candidate;
        if (c.vacancyId) openKanban(c.vacancyId);
        openCandidateModal(existing.id);
      };
    } else {
      warning.classList.add("hidden");
    }
  }
};

$("#saveAddCandidateBtn").addEventListener("click", async () => {
  if (!$("#addCandidateForm").reportValidity()) return;
  
  const name = $("#cAddName").value.trim();
  const phone = $("#cAddPhone").value.trim();
  
  // Проверяем существует ли кандидат
  const existing = findExistingCandidate(name, phone);
  if (existing) {
    toast("Кандидат уже существует в базе", "error");
    return;
  }
  
  const id = dbPushKey("candidates");
  const tags = getTagsArray($("#cAddTags").value);
  
  const payload = {
    name: name,
    phone: phone,
    source: $("#cAddSource").value || "прочее",
    vacancyId: state.activeVacancyId,
    stage: "response",
    recruiterId: state.currentUser.uid,
    createdAt: nowStamp(),
    notes: "",
    documents: {},
    tags: tags,
    missedCount: 0,
    lastActivity: nowStamp()
  };
  await dbSet(`candidates/${id}`, payload);
  await pushHistory(id, "создал(а) кандидата");
  closeModal("#modalAddCandidate");
  toast("Кандидат добавлен");
});

/* ===================== карточка кандидата ===================== */

function canEditCandidate(c) {
  return state.currentUser.role === "администратор" || c.recruiterId === state.currentUser.uid;
}

function openCandidateModal(id) {
  state.currentCandidateId = id;
  renderCandidateModal(id);
  openModal("#modalCandidate");
}

function refreshOpenCandidateModal() {
  if (!$("#modalCandidate").classList.contains("hidden")) renderCandidateModal(state.currentCandidateId);
}

function renderCandidateModal(id) {
  const c = state.candidates[id];
  if (!c) { closeModal("#modalCandidate"); return; }
  const editable = canEditCandidate(c);

  $("#candidateModalName").textContent = c.name || "Кандидат";
  $("#candName").value = c.name || "";
  $("#candPhone").value = c.phone || "";
  
  // Обновляем кастомный селект для источника
  updateCustomSelect("candSourceSelect", "candSourceOptions", c.source || "прочее");
  $("#candSource").value = c.source || "прочее";

  const vacSelect = $("#candVacancy");
  vacSelect.innerHTML = Object.entries(state.vacancies).map(([vid, v]) => `<option value="${vid}">${escapeHtml(v.title)}</option>`).join("");
  vacSelect.value = c.vacancyId || "";

  // Теги
  $("#candTagsInput").value = (c.tags && Array.isArray(c.tags)) ? c.tags.join(", ") : "";

  $("#candStageValue").textContent = stageLabel(c.stage);
  $("#candCreatedValue").textContent = formatDate(c.createdAt);
  $("#candHiredValue").textContent = formatDate(c.hiredAt);
  $("#candFiredValue").textContent = formatDate(c.firedAt);

  $("#candInterviewDate").value = (c.interview && c.interview.date) || "";
  $("#candInterviewTime").value = (c.interview && c.interview.time) || "";
  $("#candInterviewComment").value = (c.interview && c.interview.comment) || "";

  const anketa = c.documents && c.documents.anketa;
  const resume = c.documents && c.documents.resume;
  $("#anketaFileName").textContent = anketa ? anketa.name : "перетащите файл или нажмите";
  $("#dropAnketa").classList.toggle("has-file", !!anketa);
  $("#resumeFileName").textContent = resume ? resume.name : "перетащите файл или нажмите";
  $("#dropResume").classList.toggle("has-file", !!resume);

  const tags = [];
  if (!anketa) tags.push('<span class="tag tag-no-anketa">нет анкеты</span>');
  if (c.interview && c.interview.date && isToday(new Date(c.interview.date).getTime())) tags.push('<span class="tag tag-today">собеседование сегодня</span>');
  if (c.stage === "hired") tags.push('<span class="tag tag-hired">трудоустроен</span>');
  if (c.archived) tags.push('<span class="tag tag-archived">архивный</span>');
  if (c.tags && Array.isArray(c.tags)) {
    c.tags.forEach(t => {
      if (t === "черный список") tags.push('<span class="tag tag-blacklist">черный список</span>');
      else if (t) tags.push(`<span class="tag" style="background:var(--border);color:var(--text);">${escapeHtml(t)}</span>`);
    });
  }
  if (c.missedCount && c.missedCount >= 3) {
    tags.push('<span class="tag tag-blacklist">черный список (3+ пропусков)</span>');
  }
  if (c.missedCount && c.missedCount > 0 && c.missedCount < 3) {
    tags.push(`<span class="tag tag-missed">пропусков: ${c.missedCount}</span>`);
  }
  $("#candTags").innerHTML = tags.join("");

  const history = Object.values(c.history || {}).sort((a, b) => b.time - a.time);
  $("#candHistory").innerHTML = history.length
    ? history.map((h) => `<div class="history-item"><b>${escapeHtml(h.user)}</b> ${escapeHtml(h.action)} <span class="history-time">· ${formatDateTime(h.time)}</span></div>`).join("")
    : '<div class="history-item">пока пусто</div>';

  $all("#modalCandidate input, #modalCandidate select, #modalCandidate textarea").forEach((el) => { 
    if (el.id !== "candInterviewDate" && el.id !== "candInterviewTime" && el.id !== "candInterviewComment") {
      el.disabled = !editable;
    }
  });
  $("#saveCandidateBtn").classList.toggle("hidden", !editable);
  $("#archiveCandidateBtn").classList.toggle("hidden", !editable);
  $("#deleteCandidateBtn").classList.toggle("hidden", state.currentUser.role !== "администратор");
  $("#candMissInterviewBtn").classList.toggle("hidden", !editable);
}

$("#saveCandidateBtn").addEventListener("click", async () => {
  const id = state.currentCandidateId;
  const c = state.candidates[id];
  if (!c || !canEditCandidate(c)) return;
  
  const tags = getTagsArray($("#candTagsInput").value);
  
  const updates = {
    name: $("#candName").value.trim(),
    phone: $("#candPhone").value.trim(),
    vacancyId: $("#candVacancy").value,
    source: $("#candSource").value,
    tags: tags,
    interview: {
      date: $("#candInterviewDate").value,
      time: $("#candInterviewTime").value,
      comment: $("#candInterviewComment").value.trim()
    }
  };
  await dbUpdate(`candidates/${id}`, updates);
  await pushHistory(id, "обновил(а) данные кандидата");
  toast("Сохранено");
});

// Пометка "не пришёл на собеседование"
$("#candMissInterviewBtn").addEventListener("click", async () => {
  const id = state.currentCandidateId;
  const c = state.candidates[id];
  if (!c) return;
  
  const missedCount = (c.missedCount || 0) + 1;
  const updates = { missedCount: missedCount };
  
  // Если 3 пропуска - добавляем тег "черный список"
  if (missedCount >= 3) {
    const tags = c.tags || [];
    if (!tags.includes("черный список")) {
      tags.push("черный список");
      updates.tags = tags;
    }
    toast("Кандидат добавлен в черный список (3 пропуска собеседования)", "error");
  } else {
    toast(`Пропуск ${missedCount}/3`, "info");
  }
  
  await dbUpdate(`candidates/${id}`, updates);
  await pushHistory(id, `пропустил(а) собеседование (${missedCount}/3)`);
  renderCandidateModal(id);
});

$("#archiveCandidateBtn").addEventListener("click", async () => {
  const id = state.currentCandidateId;
  if (!id) return;
  if (!confirm("Архивировать кандидата?")) return;
  await dbUpdate(`candidates/${id}`, { archived: true, archivedAt: nowStamp() });
  await pushHistory(id, "архивировал(а) кандидата");
  closeModal("#modalCandidate");
  toast("Кандидат архивирован");
});

$("#deleteCandidateBtn").addEventListener("click", async () => {
  const id = state.currentCandidateId;
  if (!id) return;
  if (!confirm("Удалить кандидата безвозвратно?")) return;
  await dbRemove(`candidates/${id}`);
  closeModal("#modalCandidate");
  toast("Кандидат удалён");
});

// Автосохранение заметок
$("#candNotes").addEventListener("input", () => {
  const id = state.currentCandidateId;
  clearTimeout(state.notesTimer);
  $("#notesAutosaveHint").textContent = "сохраняем...";
  state.notesTimer = setTimeout(async () => {
    const c = state.candidates[id];
    if (!c || !canEditCandidate(c)) return;
    await dbUpdate(`candidates/${id}`, { notes: $("#candNotes").value });
    $("#notesAutosaveHint").textContent = "сохранено";
    clearTimeout(state.historyDebounceTimer);
    state.historyDebounceTimer = setTimeout(() => pushHistory(id, "добавил(а) заметку"), 400);
  }, 900);
});

/* ---- документы ---- */

function bindDocDrop(dropId, inputId, docType) {
  const drop = $(dropId);
  const input = $(inputId);
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag-over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag-over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) uploadCandidateDoc(docType, file);
  });
  input.addEventListener("change", () => {
    const file = input.files[0];
    if (file) uploadCandidateDoc(docType, file);
    input.value = "";
  });
}
bindDocDrop("#dropAnketa", "#fileAnketa", "anketa");
bindDocDrop("#dropResume", "#fileResume", "resume");

async function uploadCandidateDoc(docType, file) {
  const id = state.currentCandidateId;
  if (file.type !== "application/pdf") { toast("Нужен PDF-файл", "error"); return; }
  if (file.size > 5 * 1024 * 1024) { toast("Файл слишком большой (макс 5MB)", "error"); return; }
  toast("Загружаем файл...");
  try {
    const path = `documents/${id}/${docType}_${Date.now()}.pdf`;
    const sRef = storageRef(storage, path);
    await uploadBytes(sRef, file);
    const url = await getDownloadURL(sRef);
    await dbUpdate(`candidates/${id}/documents/${docType}`, { name: file.name, url, path });
    await pushHistory(id, `загрузил(а) документ «${docType === "anketa" ? "анкета" : "резюме"}»`);
    toast("Файл загружен");
  } catch (err) {
    toast("Не удалось загрузить файл: " + err.message, "error");
  }
}

/* ===================== база кандидатов (таблица) ===================== */

function populateFilterOptions() {
  const vacSelect = $("#filterVacancy");
  const current = vacSelect.value;
  vacSelect.innerHTML = '<option value="">Все вакансии</option>' + Object.entries(state.vacancies).map(([id, v]) => `<option value="${id}">${escapeHtml(v.title)}</option>`).join("");
  vacSelect.value = current;

  const stageSelect = $("#filterStage");
  if (!stageSelect.dataset.filled) {
    stageSelect.innerHTML = '<option value="">Все этапы</option>' + STAGES.map((s) => `<option value="${s.key}">${escapeHtml(s.label)}</option>`).join("");
    stageSelect.dataset.filled = "1";
  }
  const sourceSelect = $("#filterSource");
  if (!sourceSelect.dataset.filled) {
    sourceSelect.innerHTML = '<option value="">Все источники</option>' + SOURCES.map((s) => `<option value="${s.key}">${escapeHtml(s.label)}</option>`).join("");
    sourceSelect.dataset.filled = "1";
  }
}

["candidatesSearch", "filterVacancy", "filterStage", "filterSource"].forEach((id) => {
  $(`#${id}`).addEventListener("input", renderCandidatesTable);
  $(`#${id}`).addEventListener("change", renderCandidatesTable);
});

function renderCandidatesTable() {
  const term = $("#candidatesSearch").value.trim().toLowerCase();
  const fVacancy = $("#filterVacancy").value;
  const fStage = $("#filterStage").value;
  const fSource = $("#filterSource").value;

  let entries = Object.entries(state.candidates || {});
  if (fVacancy) entries = entries.filter(([, c]) => c.vacancyId === fVacancy);
  if (fStage) entries = entries.filter(([, c]) => c.stage === fStage);
  if (fSource) entries = entries.filter(([, c]) => c.source === fSource);
  if (term) {
    entries = entries.filter(([, c]) => {
      const vacTitle = (state.vacancies[c.vacancyId] || {}).title || "";
      return (c.name || "").toLowerCase().includes(term) || 
             (c.phone || "").toLowerCase().includes(term) || 
             vacTitle.toLowerCase().includes(term);
    });
  }
  entries.sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  $("#candidatesEmpty").classList.toggle("hidden", entries.length > 0);
  $("#candidatesTableBody").innerHTML = entries.map(([id, c]) => {
    const vac = state.vacancies[c.vacancyId];
    const rec = state.users[c.recruiterId];
    const tagsDisplay = (c.tags && Array.isArray(c.tags)) ? c.tags.slice(0, 2).join(", ") + (c.tags.length > 2 ? "..." : "") : "";
    return `
      <tr data-id="${id}">
        <td>${escapeHtml(c.name)}</td>
        <td class="cell-secondary">${escapeHtml(formatPhone(c.phone || ""))}</td>
        <td class="cell-secondary">${escapeHtml(vac ? vac.title : "—")}</td>
        <td>${escapeHtml(stageLabel(c.stage))}</td>
        <td class="cell-secondary">${escapeHtml(c.source || "")}</td>
        <td class="cell-secondary" style="font-size:11px;">${escapeHtml(tagsDisplay)}</td>
        <td class="cell-secondary">${formatDate(c.createdAt)}</td>
        <td class="cell-secondary">${escapeHtml(rec ? rec.name : "—")}</td>
      </tr>`;
  }).join("");

  $all("#candidatesTableBody tr").forEach((row) => {
    row.addEventListener("click", () => openCandidateModal(row.dataset.id));
  });
}

/* ===================== импорт/экспорт кандидатов ===================== */

$("#exportCandidatesBtn").addEventListener("click", () => {
  const candidates = Object.entries(state.candidates || {}).map(([id, c]) => ({
    id,
    name: c.name || "",
    phone: c.phone || "",
    source: c.source || "",
    stage: c.stage || "",
    vacancyTitle: (state.vacancies[c.vacancyId] || {}).title || "",
    createdAt: c.createdAt ? new Date(c.createdAt).toISOString() : "",
    notes: c.notes || "",
    tags: (c.tags && Array.isArray(c.tags)) ? c.tags.join(", ") : "",
    archived: c.archived || false
  }));
  
  const blob = new Blob([JSON.stringify(candidates, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `candidates-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  toast("Кандидаты экспортированы");
});

$("#importCandidatesBtn").addEventListener("click", () => $("#importCandidatesFile").click());
$("#importCandidatesFile").addEventListener("change", async () => {
  const file = $("#importCandidatesFile").files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data)) { toast("Неверный формат файла", "error"); return; }
    
    let count = 0;
    for (const item of data) {
      const id = item.id || dbPushKey("candidates");
      const payload = {
        name: item.name || "Без имени",
        phone: item.phone || "",
        source: item.source || "прочее",
        stage: item.stage || "response",
        recruiterId: state.currentUser.uid,
        createdAt: item.createdAt ? new Date(item.createdAt).getTime() : nowStamp(),
        notes: item.notes || "",
        documents: {},
        tags: item.tags ? item.tags.split(",").map(t => t.trim()).filter(t => t) : [],
        archived: item.archived || false,
        missedCount: 0
      };
      
      // Находим вакансию по названию
      if (item.vacancyTitle) {
        const vac = Object.entries(state.vacancies).find(([, v]) => v.title === item.vacancyTitle);
        if (vac) payload.vacancyId = vac[0];
      }
      
      await dbSet(`candidates/${id}`, payload);
      count++;
    }
    toast(`Импортировано ${count} кандидатов`);
  } catch (err) {
    toast("Ошибка импорта: " + err.message, "error");
  }
  $("#importCandidatesFile").value = "";
});

/* ===================== АНАЛИТИКА ===================== */

// Период для аналитики
$("#analyticsPeriodFilter").addEventListener("click", (e) => {
  const btn = e.target.closest(".pill");
  if (!btn) return;
  state.analyticsPeriod = btn.dataset.period;
  $all("#analyticsPeriodFilter .pill").forEach((p) => p.classList.toggle("active", p === btn));
  renderAnalytics();
});

$("#analyticsDate").addEventListener("change", () => {
  const val = $("#analyticsDate").value;
  if (val) {
    state.analyticsDate = new Date(val);
  } else {
    state.analyticsDate = new Date();
  }
  renderAnalytics();
});

function getPeriodRange(date, period) {
  const start = new Date(date);
  const end = new Date(date);
  
  switch(period) {
    case "day":
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;
    case "week":
      const day = start.getDay();
      const diff = start.getDate() - day + (day === 0 ? -6 : 1);
      start.setDate(diff);
      start.setHours(0, 0, 0, 0);
      end.setDate(start.getDate() + 6);
      end.setHours(23, 59, 59, 999);
      break;
    case "month":
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      end.setMonth(end.getMonth() + 1, 0);
      end.setHours(23, 59, 59, 999);
      break;
    case "year":
      start.setMonth(0, 1);
      start.setHours(0, 0, 0, 0);
      end.setMonth(11, 31);
      end.setHours(23, 59, 59, 999);
      break;
  }
  return { start, end };
}

function getPrevPeriodRange(date, period) {
  const prev = new Date(date);
  switch(period) {
    case "day": prev.setDate(prev.getDate() - 1); break;
    case "week": prev.setDate(prev.getDate() - 7); break;
    case "month": prev.setMonth(prev.getMonth() - 1); break;
    case "year": prev.setFullYear(prev.getFullYear() - 1); break;
  }
  return getPeriodRange(prev, period);
}

function renderAnalytics() {
  const candidates = Object.values(state.candidates || {});
  const vacancies = Object.values(state.vacancies || {});
  
  const date = state.analyticsDate || new Date();
  const period = state.analyticsPeriod || "month";
  const range = getPeriodRange(date, period);
  const prevRange = getPrevPeriodRange(date, period);
  
  // Фильтруем по дате создания
  const filtered = candidates.filter(c => {
    if (c.archived) return false;
    return c.createdAt >= range.start.getTime() && c.createdAt <= range.end.getTime();
  });
  
  const prevFiltered = candidates.filter(c => {
    if (c.archived) return false;
    return c.createdAt >= prevRange.start.getTime() && c.createdAt <= prevRange.end.getTime();
  });
  
  // Статистика
  const total = filtered.length;
  const prevTotal = prevFiltered.length;
  const totalChange = prevTotal > 0 ? ((total - prevTotal) / prevTotal * 100) : 0;
  
  const hired = filtered.filter(c => c.stage === "hired").length;
  const prevHired = prevFiltered.filter(c => c.stage === "hired").length;
  const hiredChange = prevHired > 0 ? ((hired - prevHired) / prevHired * 100) : 0;
  
  const activeVacancies = vacancies.filter(v => v.status === "активна").length;
  
  const interviews = filtered.filter(c => c.interview && c.interview.date && 
    new Date(c.interview.date).getTime() >= range.start.getTime() && 
    new Date(c.interview.date).getTime() <= range.end.getTime()
  ).length;
  
  // Конверсия
  const responseCount = filtered.filter(c => c.stage === "response").length;
  const selected1Count = filtered.filter(c => c.stage === "selected1").length;
  const invitedCount = filtered.filter(c => c.stage === "invited").length;
  const hiredCount = filtered.filter(c => c.stage === "hired").length;
  
  const conversionToSelected = responseCount > 0 ? Math.round(selected1Count / responseCount * 100) : 0;
  const conversionToHired = responseCount > 0 ? Math.round(hiredCount / responseCount * 100) : 0;
  const conversionToInvited = selected1Count > 0 ? Math.round(invitedCount / selected1Count * 100) : 0;
  
  // Обновляем сетку
  $("#analyticsGrid").innerHTML = [
    ["Всего кандидатов", total, totalChange],
    ["Трудоустроено", hired, hiredChange],
    ["Активных вакансий", activeVacancies, 0],
    ["Собеседований", interviews, 0]
  ].map(([lbl, num, change]) => `
    <div class="analytics-card">
      <div class="num">${num}</div>
      <div class="lbl">${lbl}</div>
      ${change !== 0 ? `<div class="change ${change > 0 ? 'up' : 'down'}">${change > 0 ? '↑' : '↓'} ${Math.abs(change).toFixed(1)}%</div>` : ''}
    </div>
  `).join("");
  
  // Графики
  const bySource = groupCount(filtered, (c) => (SOURCES.find((s) => s.key === c.source) || { label: "прочее" }).label);
  const byStage = groupCount(filtered, (c) => stageLabel(c.stage));
  const byMonth = groupCount(filtered, (c) => new Date(c.createdAt).toLocaleDateString("ru-RU", { month: "short", year: "numeric" }));
  
  $("#analyticsCharts").innerHTML = [
    chartBlock("Кандидаты по источникам", bySource),
    chartBlock("Кандидаты по этапам", byStage),
    chartBlock("Динамика создания", byMonth)
  ].join("");
  
  // Конверсия
  $("#analyticsConversion").innerHTML = `
    <h3>Воронка конверсии</h3>
    <div class="conversion-grid">
      <div class="conversion-item">
        <div class="value">${responseCount}</div>
        <div class="label">Отклики</div>
      </div>
      <div class="conversion-item">
        <div class="value">${selected1Count}</div>
        <div class="label">Подходящие отклики</div>
        <div style="font-size:11px;color:var(--text-muted);">${conversionToSelected}%</div>
      </div>
      <div class="conversion-item">
        <div class="value">${invitedCount}</div>
        <div class="label">Приглашённые</div>
        <div style="font-size:11px;color:var(--text-muted);">${conversionToInvited}%</div>
      </div>
      <div class="conversion-item">
        <div class="value">${hiredCount}</div>
        <div class="label">Трудоустроены</div>
        <div style="font-size:11px;color:var(--text-muted);">${conversionToHired}%</div>
      </div>
    </div>
  `;
}

/* ===== Автоархивация кандидатов ===== */

function checkAutoArchive() {
  const now = Date.now();
  const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
  
  const candidates = Object.entries(state.candidates || {});
  for (const [id, c] of candidates) {
    if (c.archived) continue;
    if (!STAGES_FOR_AUTO_ARCHIVE.includes(c.stage)) continue;
    
    const lastActivity = c.lastActivity || c.createdAt || 0;
    if (now - lastActivity > TWO_WEEKS) {
      // Автоархивация
      dbUpdate(`candidates/${id}`, { 
        archived: true, 
        archivedAt: now,
        archivedReason: "не вышел на связь"
      });
      pushHistory(id, "автоматически архивирован (не вышел на связь)");
    }
  }
}

// Запускаем проверку каждые 6 часов
setInterval(checkAutoArchive, 6 * 60 * 60 * 1000);

/* ===== Собеседования на сегодня ===== */

function renderTodayInterviews() {
  const today = new Date();
  const candidates = Object.values(state.candidates || {}).filter(c => 
    !c.archived && c.interview && c.interview.date && isToday(new Date(c.interview.date).getTime())
  );
  
  // Показываем в топбаре
  const actions = $("#topbarActions");
  actions.innerHTML = candidates.length > 0 
    ? `<span style="background:var(--warning-bg);padding:4px 12px;border-radius:999px;font-size:12px;color:var(--warning);">📅 Собеседований сегодня: ${candidates.length}</span>`
    : "";
}

/* ===================== пользователи ===================== */

$("#addUserBtn").addEventListener("click", () => {
  $("#userForm").reset();
  $("#userUid").value = "";
  $("#userModalTitle").textContent = "Новый пользователь";
  $("#uEmail").disabled = false;
  $("#uPassword").required = true;
  $("#uPasswordField").classList.remove("hidden");
  $("#deleteUserBtn").classList.add("hidden");
  openModal("#modalUser");
});

function renderUsersTable() {
  const entries = Object.entries(state.users || {}).sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""));
  $("#usersTableBody").innerHTML = entries.map(([uid, u]) => `
    <tr data-uid="${uid}">
      <td>${escapeHtml(u.name)}</td>
      <td class="cell-secondary">${escapeHtml(u.email)}</td>
      <td>${escapeHtml(u.role)}</td>
      <td class="cell-secondary">${escapeHtml(formatPhone(u.phone || ""))}</td>
      <td><button class="btn btn-ghost btn-edit-user" data-uid="${uid}">Изменить</button></td>
    </tr>`).join("");
  $all(".btn-edit-user").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); openEditUser(btn.dataset.uid); }));
}

function openEditUser(uid) {
  const u = state.users[uid];
  if (!u) return;
  $("#userForm").reset();
  $("#userUid").value = uid;
  $("#userModalTitle").textContent = "Редактировать пользователя";
  $("#uName").value = u.name || "";
  $("#uEmail").value = u.email || "";
  $("#uEmail").disabled = true;
  $("#uPhone").value = u.phone || "";
  $("#uPassword").required = false;
  $("#uPasswordField").classList.add("hidden");
  $("#uRole").value = u.role || "рекрутер";
  $("#deleteUserBtn").classList.toggle("hidden", uid === state.currentUser.uid);
  openModal("#modalUser");
}

$("#saveUserBtn").addEventListener("click", async () => {
  const uid = $("#userUid").value;
  const name = $("#uName").value.trim();
  const role = $("#uRole").value;
  const phone = $("#uPhone").value.trim();

  if (uid) {
    await dbUpdate(`users/${uid}`, { name, role, phone });
    toast("Пользователь обновлён");
    closeModal("#modalUser");
    return;
  }

  const email = $("#uEmail").value.trim();
  const password = $("#uPassword").value;
  if (!email || !password || password.length < 6) { toast("Пароль минимум 6 символов", "error"); return; }

  const secondaryApp = initializeApp(app.options, "secondary_" + Date.now());
  const secondaryAuth = getAuthSecondary(secondaryApp);
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    await dbSet(`users/${cred.user.uid}`, { name, email, role, phone, createdAt: nowStamp() });
    await signOutSecondary(secondaryAuth);
    toast("Пользователь создан");
    closeModal("#modalUser");
  } catch (err) {
    toast("Ошибка: " + err.message, "error");
  } finally {
    await deleteApp(secondaryApp);
  }
});

$("#deleteUserBtn").addEventListener("click", async () => {
  const uid = $("#userUid").value;
  if (!uid || uid === state.currentUser.uid) return;
  if (!confirm("Удалить пользователя? Его кандидаты перейдут главному администратору.")) return;

  const admins = Object.entries(state.users).filter(([, u]) => u.role === "администратор").sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
  const mainAdminId = admins.length ? admins[0][0] : state.currentUser.uid;

  const reassign = Object.entries(state.candidates).filter(([, c]) => c.recruiterId === uid);
  await Promise.all(reassign.map(([cid]) => dbUpdate(`candidates/${cid}`, { recruiterId: mainAdminId })));

  await dbRemove(`users/${uid}`);
  toast("Профиль пользователя удалён из системы. Учётную запись Firebase Auth нужно удалить вручную в консоли Firebase — из клиента это не разрешено.");
  closeModal("#modalUser");
});

/* ===================== настройки ===================== */

function openSettingsModal() {
  $("#settingsName").value = state.currentUser.name || "";
  $("#settingsEmail").value = state.currentUser.email || "";
  $("#settingsPhone").value = state.currentUser.phone || "";
  $("#settingsNewPassword").value = "";
  applyTheme(state.theme);
  openModal("#modalSettings");
}

$("#settingsTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".settings-tab");
  if (!btn) return;
  $all(".settings-tab").forEach((t) => t.classList.toggle("active", t === btn));
  $all(".settings-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== btn.dataset.tab));
});

$all(".theme-option").forEach((btn) => btn.addEventListener("click", () => applyTheme(btn.dataset.theme)));

$("#saveProfileBtn").addEventListener("click", async () => {
  const name = $("#settingsName").value.trim();
  const phone = $("#settingsPhone").value.trim();
  const newPass = $("#settingsNewPassword").value;
  await dbUpdate(`users/${state.currentUser.uid}`, { name, phone });
  state.currentUser.name = name;
  state.currentUser.phone = phone;
  applyRoleUI();
  if (newPass) {
    if (newPass.length < 6) { toast("Пароль минимум 6 символов", "error"); return; }
    try {
      await updatePassword(auth.currentUser, newPass);
      toast("Профиль и пароль обновлены");
    } catch (err) {
      toast("Имя сохранено, но пароль не изменён: нужен повторный вход для смены пароля (" + err.code + ")", "error");
    }
  } else {
    toast("Профиль сохранён");
  }
});

/* ---- резервное копирование ---- */

$("#exportBtn").addEventListener("click", () => {
  const payload = { users: state.users, vacancies: state.vacancies, candidates: state.candidates, exportedAt: nowStamp() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `demcrm-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
});

$("#importBtn").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", async () => {
  const file = $("#importFile").files[0];
  if (!file) return;
  if (!confirm("Импорт полностью перезапишет текущую базу данных. Продолжить?")) { $("#importFile").value = ""; return; }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data.vacancies) await dbSet("vacancies", data.vacancies);
    if (data.candidates) await dbSet("candidates", data.candidates);
    toast("База импортирована");
  } catch (err) {
    toast("Не удалось прочитать файл: " + err.message, "error");
  }
  $("#importFile").value = "";
});

/* ===================== глобальный поиск (Ctrl+K) ===================== */

function openGlobalSearch() {
  $("#globalSearchInput").value = "";
  renderGlobalSearchResults("");
  openModal("#modalSearch");
  setTimeout(() => $("#globalSearchInput").focus(), 50);
}

$("#topSearchBox").addEventListener("click", openGlobalSearch);
$("#globalSearchInput").addEventListener("input", (e) => renderGlobalSearchResults(e.target.value.trim().toLowerCase()));

function renderGlobalSearchResults(term) {
  const results = $("#globalSearchResults");
  if (!term) { results.innerHTML = '<div class="search-empty">начните вводить имя, телефон или название вакансии</div>'; return; }

  const vac = Object.entries(state.vacancies).filter(([, v]) => (v.title || "").toLowerCase().includes(term));
  const cand = Object.entries(state.candidates).filter(([, c]) => 
    (c.name || "").toLowerCase().includes(term) || 
    (c.phone || "").toLowerCase().includes(term)
  );

  if (!vac.length && !cand.length) { results.innerHTML = '<div class="search-empty">ничего не найдено</div>'; return; }

  let html = "";
  vac.forEach(([id, v]) => {
    html += `<div class="search-result-item" data-type="vacancy" data-id="${id}"><div class="sr-title">${escapeHtml(v.title)}</div><div class="sr-sub">вакансия · ${escapeHtml(v.status)}</div></div>`;
  });
  cand.forEach(([id, c]) => {
    const vacTitle = (state.vacancies[c.vacancyId] || {}).title || "без вакансии";
    html += `<div class="search-result-item" data-type="candidate" data-id="${id}"><div class="sr-title">${escapeHtml(c.name)}</div><div class="sr-sub">кандидат · ${escapeHtml(vacTitle)}</div></div>`;
  });
  results.innerHTML = html;

  $all(".search-result-item", results).forEach((item) => {
    item.addEventListener("click", () => {
      closeModal("#modalSearch");
      if (item.dataset.type === "vacancy") openVacancyModal(item.dataset.id);
      else {
        const c = state.candidates[item.dataset.id];
        if (c && c.vacancyId) openKanban(c.vacancyId);
        openCandidateModal(item.dataset.id);
      }
    });
  });
}

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openGlobalSearch();
  }
  if (e.key === "Escape") $all(".modal-overlay:not(.hidden)").forEach((m) => m.classList.add("hidden"));
});

/* ===================== общие обработчики модалок ===================== */

$all(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.add("hidden"); });
  $all("[data-close]", overlay).forEach((btn) => btn.addEventListener("click", () => overlay.classList.add("hidden")));
});

/* ===================== утилиты для аналитики ===================== */

function groupCount(list, keyFn) {
  const map = {};
  list.forEach((item) => { const k = keyFn(item) || "—"; map[k] = (map[k] || 0) + 1; });
  return map;
}

function chartBlock(title, dataMap) {
  const entries = Object.entries(dataMap);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  if (!entries.length) return `<div class="chart-block"><h4>${title}</h4><span class="hint-text">нет данных</span></div>`;
  return `<div class="chart-block"><h4>${title}</h4>${entries.map(([label, val]) => `
    <div class="chart-bar-row">
      <div class="chart-bar-label">${escapeHtml(label)}</div>
      <div class="chart-bar-track"><div class="chart-bar-fill" style="width:${(val / max) * 100}%"></div></div>
      <div class="chart-bar-value">${val}</div>
    </div>`).join("")}</div>`;
}

/* ===================== старт ===================== */

applyTheme(state.theme);
initAuth();
