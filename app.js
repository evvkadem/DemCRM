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
  { key: "selected1", label: "Отобрано" },
  { key: "invited", label: "Приглашён" },
  { key: "form", label: "Анкета" },
  { key: "interview", label: "Собеседование" },
  { key: "selected2", label: "Отобрано" },
  { key: "director", label: "Собеседование с директором" },
  { key: "hired", label: "Трудоустройство" }
];

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
  currentUser: null, // { uid, name, email, role }
  users: {},
  vacancies: {},
  candidates: {},
  activeVacancyId: null,
  pendingStageMove: null,
  currentCandidateId: null,
  notesTimer: null,
  historyDebounceTimer: null,
  theme: localStorage.getItem("demcrm_theme") || "light"
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
  dbWatch("users", (data) => { state.users = data || {}; renderUsersTable(); populateGlobalCaches(); });
  dbWatch("vacancies", (data) => { state.vacancies = data || {}; renderVacancies(); populateFilterOptions(); renderKanbanIfOpen(); });
  dbWatch("candidates", (data) => {
    state.candidates = data || {};
    renderVacancies();
    renderKanbanIfOpen();
    renderCandidatesTable();
    if (state.currentCandidateId) refreshOpenCandidateModal();
  });
}

function populateGlobalCaches() {}

/* ===================== навигация ===================== */

function switchView(name) {
  $all(".view").forEach((v) => v.classList.remove("active"));
  $(`#view-${name}`).classList.add("active");
  $all(".nav-item[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name === "candidates") renderCandidatesTable();
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
    return `
      <div class="vacancy-card" data-id="${id}">
        <div class="vc-top">
          <span class="status-badge status-${escapeHtml(v.status)}">${escapeHtml(v.status)}</span>
        </div>
        <div class="vc-title">${escapeHtml(v.title)}</div>
        <div class="vc-manager">${escapeHtml(v.manager || "")}</div>
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
  if (isEdit) {
    const v = state.vacancies[id];
    $("#vTitle").value = v.title || "";
    $("#vManager").value = v.manager || "";
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
  const payload = {
    title: $("#vTitle").value.trim(),
    manager: $("#vManager").value.trim(),
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
  if (c.interview && c.interview.date && isSameDay(new Date(c.interview.date).getTime())) tags.push('<span class="tag tag-today">собеседование сегодня</span>');
  if (c.stage === "hired") tags.push('<span class="tag tag-hired">трудоустроен</span>');
  const recruiter = state.users[c.recruiterId];
  return `
    <div class="kcard" draggable="true" data-id="${id}">
      <div class="kcard-name">${escapeHtml(c.name)}</div>
      <div class="kcard-phone">${escapeHtml(c.phone || "")}</div>
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
  openModal("#modalAddCandidate");
});

$("#saveAddCandidateBtn").addEventListener("click", async () => {
  if (!$("#addCandidateForm").reportValidity()) return;
  const id = dbPushKey("candidates");
  const payload = {
    name: $("#cAddName").value.trim(),
    phone: $("#cAddPhone").value.trim(),
    source: $("#cAddSource").value,
    vacancyId: state.activeVacancyId,
    stage: "response",
    recruiterId: state.currentUser.uid,
    createdAt: nowStamp(),
    notes: "",
    documents: {}
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
  $("#candSource").value = c.source || "прочее";
  $("#candNotes").value = c.notes || "";

  const vacSelect = $("#candVacancy");
  vacSelect.innerHTML = Object.entries(state.vacancies).map(([vid, v]) => `<option value="${vid}">${escapeHtml(v.title)}</option>`).join("");
  vacSelect.value = c.vacancyId || "";

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
  if (c.interview && c.interview.date && isSameDay(new Date(c.interview.date).getTime())) tags.push('<span class="tag tag-today">собеседование сегодня</span>');
  if (c.stage === "hired") tags.push('<span class="tag tag-hired">трудоустроен</span>');
  if (c.archived) tags.push('<span class="tag tag-archived">архивный</span>');
  $("#candTags").innerHTML = tags.join("");

  const history = Object.values(c.history || {}).sort((a, b) => b.time - a.time);
  $("#candHistory").innerHTML = history.length
    ? history.map((h) => `<div class="history-item"><b>${escapeHtml(h.user)}</b> ${escapeHtml(h.action)} <span class="history-time">· ${formatDateTime(h.time)}</span></div>`).join("")
    : '<div class="history-item">пока пусто</div>';

  $all("#modalCandidate input, #modalCandidate select, #modalCandidate textarea").forEach((el) => { el.disabled = !editable; });
  $("#saveCandidateBtn").classList.toggle("hidden", !editable);
  $("#archiveCandidateBtn").classList.toggle("hidden", !editable);
  $("#deleteCandidateBtn").classList.toggle("hidden", state.currentUser.role !== "администратор");
}

$("#saveCandidateBtn").addEventListener("click", async () => {
  const id = state.currentCandidateId;
  const c = state.candidates[id];
  if (!c || !canEditCandidate(c)) return;
  const updates = {
    name: $("#candName").value.trim(),
    phone: $("#candPhone").value.trim(),
    vacancyId: $("#candVacancy").value,
    source: $("#candSource").value,
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

// автосохранение заметок
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
      return (c.name || "").toLowerCase().includes(term) || (c.phone || "").toLowerCase().includes(term) || vacTitle.toLowerCase().includes(term);
    });
  }
  entries.sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  $("#candidatesEmpty").classList.toggle("hidden", entries.length > 0);
  $("#candidatesTableBody").innerHTML = entries.map(([id, c]) => {
    const vac = state.vacancies[c.vacancyId];
    const rec = state.users[c.recruiterId];
    return `
      <tr data-id="${id}">
        <td>${escapeHtml(c.name)}</td>
        <td class="cell-secondary">${escapeHtml(c.phone || "")}</td>
        <td class="cell-secondary">${escapeHtml(vac ? vac.title : "—")}</td>
        <td>${escapeHtml(stageLabel(c.stage))}</td>
        <td class="cell-secondary">${escapeHtml(c.source || "")}</td>
        <td class="cell-secondary">${formatDate(c.createdAt)}</td>
        <td class="cell-secondary">${escapeHtml(rec ? rec.name : "—")}</td>
      </tr>`;
  }).join("");

  $all("#candidatesTableBody tr").forEach((row) => {
    row.addEventListener("click", () => openCandidateModal(row.dataset.id));
  });
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

  if (uid) {
    await dbUpdate(`users/${uid}`, { name, role });
    toast("Пользователь обновлён");
    closeModal("#modalUser");
    return;
  }

  const email = $("#uEmail").value.trim();
  const password = $("#uPassword").value;
  if (!email || !password || password.length < 6) { toast("Пароль минимум 6 символов", "error"); return; }

  // создаём юзера через вторичный инстанс firebase, чтобы не разлогинить текущего админа
  const secondaryApp = initializeApp(app.options, "secondary_" + Date.now());
  const secondaryAuth = getAuthSecondary(secondaryApp);
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    await dbSet(`users/${cred.user.uid}`, { name, email, role, createdAt: nowStamp() });
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
  $("#settingsNewPassword").value = "";
  applyTheme(state.theme);
  renderAnalytics();
  openModal("#modalSettings");
}

$("#settingsTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".settings-tab");
  if (!btn) return;
  $all(".settings-tab").forEach((t) => t.classList.toggle("active", t === btn));
  $all(".settings-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== btn.dataset.tab));
  if (btn.dataset.tab === "analytics") renderAnalytics();
});

$all(".theme-option").forEach((btn) => btn.addEventListener("click", () => applyTheme(btn.dataset.theme)));

$("#saveProfileBtn").addEventListener("click", async () => {
  const name = $("#settingsName").value.trim();
  const newPass = $("#settingsNewPassword").value;
  await dbUpdate(`users/${state.currentUser.uid}`, { name });
  state.currentUser.name = name;
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

/* ---- аналитика ---- */

function renderAnalytics() {
  const candidates = Object.values(state.candidates || {});
  const vacancies = Object.values(state.vacancies || {});
  const activeVacancies = vacancies.filter((v) => v.status === "активна").length;
  const hired = candidates.filter((c) => c.stage === "hired").length;
  const archived = candidates.filter((c) => c.archived).length;
  const todayInterviews = candidates.filter((c) => c.interview && c.interview.date && isSameDay(new Date(c.interview.date).getTime())).length;

  $("#analyticsGrid").innerHTML = [
    ["Всего кандидатов", candidates.length],
    ["Активных вакансий", activeVacancies],
    ["Трудоустроено", hired],
    ["Архивных кандидатов", archived],
    ["Собеседований сегодня", todayInterviews]
  ].map(([lbl, num]) => `<div class="analytics-card"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`).join("");

  const bySource = groupCount(candidates, (c) => (SOURCES.find((s) => s.key === c.source) || { label: "прочее" }).label);
  const byStage = groupCount(candidates, (c) => stageLabel(c.stage));
  const byMonth = groupCount(candidates.filter((c) => c.hiredAt), (c) => new Date(c.hiredAt).toLocaleDateString("ru-RU", { month: "short", year: "numeric" }));

  $("#analyticsCharts").innerHTML = [
    chartBlock("Кандидаты по источникам", bySource),
    chartBlock("Кандидаты по этапам", byStage),
    chartBlock("Трудоустройства по месяцам", byMonth)
  ].join("");
}

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
  const cand = Object.entries(state.candidates).filter(([, c]) => (c.name || "").toLowerCase().includes(term) || (c.phone || "").toLowerCase().includes(term));

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

/* ===================== старт ===================== */

applyTheme(state.theme);
initAuth();
