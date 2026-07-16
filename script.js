// ============================================================
// script.js — бизнес-логика DemCRM
// Разделы (ищи по комментариям):
//   1. STATE & CONSTANTS
//   2. UTILS (toast, modal, confirm, phone-format, date)
//   3. AUTH
//   4. NAVIGATION
//   5. VACANCIES
//   6. KANBAN
//   7. CANDIDATE CARD (tabs: info/stage/interviews/documents/notes/history)
//   8. CANDIDATES DATABASE (table, filters, search, bulk actions)
//   9. IMPORT
//  10. TAGS
//  11. ANALYTICS
//  12. USERS
//  13. SETTINGS
//  14. AUTOMATION (weekly auto-transfer, no-show blacklist)
//  15. QUICK SEARCH (Ctrl+K)
//  16. BOOTSTRAP
// ============================================================

import {
  auth, db, login, logout, watchAuth, changeOwnPassword, createUserAsAdmin,
  dbGet, dbSet, dbUpdate, dbPush, dbRemove, dbListen, timestamp, nowISO,
} from "./firebase.js";

// ----------------------------------------------------------------
// 1. STATE & CONSTANTS
// ----------------------------------------------------------------

const STAGES = [
  "Отклик",
  "Скрининг",
  "Приглашён на собеседование",
  "Анкета",
  "Собеседование",
  "Отобрано",
  "Собеседование с директором",
  "Трудоустройство",
];

const STAGE_NO_AUTOTRANSFER = ["Отобрано", "Собеседование с директором", "Трудоустройство"];
const AUTOTRANSFER_DAYS = 7;
const NOSHOW_LIMIT = 3;

const SYSTEM_TAGS = ["не вышел на связь", "чёрный список", "не подходит", "не актуально"];

// теги, которые при добавлении кандидату автоматически убирают его с Kanban
// (кандидат остаётся в базе). «чёрный список» дополнительно подсвечивает
// строку в таблице базы кандидатов другим цветом (см. renderCandidatesTable).
const KANBAN_REMOVE_TAGS = new Set(["не вышел на связь", "чёрный список", "не подходит", "не актуально"]);
// для части тегов заодно проставляем понятный статус в базе кандидатов
const TAG_STATUS_MAP = {
  "не вышел на связь": "не вышел на связь",
  "не подходит": "не подходит",
  "не актуально": "не подходит",
};

const state = {
  user: null,          // { uid, name, email, role }
  vacancies: {},        // id -> vacancy
  candidates: {},       // id -> candidate
  tags: {},              // id -> {name, color}
  users: {},             // uid -> user
  currentVacancyId: null,
  currentCandidateId: null,
  selectedCandidateIds: new Set(),
  interviewDateOffset: 0, // дней от сегодня, для панели собеседований
  confirmCallback: null,
  pendingTagSelection: new Set(),
  importRows: [],
};

// ----------------------------------------------------------------
// 2. UTILS
// ----------------------------------------------------------------

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function toast(message, isError = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = message;
  $("#toastContainer").appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function openModal(id) {
  $("#overlay").classList.remove("hidden");
  $("#" + id).classList.remove("hidden");
}
function closeModal(id) {
  $("#" + id).classList.add("hidden");
  const anyOpen = $all(".modal:not(.hidden)").length > 0;
  if (!anyOpen) $("#overlay").classList.add("hidden");
}
$all("[data-close-modal]").forEach((btn) =>
  btn.addEventListener("click", () => closeModal(btn.dataset.closeModal))
);
$("#overlay").addEventListener("click", () => {
  $all(".modal:not(.hidden)").forEach((m) => m.classList.add("hidden"));
  $("#overlay").classList.add("hidden");
});

function confirmAction(text, onConfirm) {
  $("#confirmText").textContent = text;
  state.confirmCallback = onConfirm;
  openModal("confirmModal");
}
$("#confirmOkBtn").addEventListener("click", () => {
  closeModal("confirmModal");
  if (state.confirmCallback) state.confirmCallback();
  state.confirmCallback = null;
});
$("#confirmCancelBtn").addEventListener("click", () => {
  closeModal("confirmModal");
  state.confirmCallback = null;
});

// формат телефона -> 7 999 999-99-99
function formatPhone(raw) {
  const digits = (raw || "").replace(/\D/g, "").replace(/^8/, "7");
  if (digits.length < 11) return raw || "";
  const d = digits.slice(-10);
  return `7 ${d.slice(0, 3)} ${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8, 10)}`;
}
function phoneDigits(raw) {
  return (raw || "").replace(/\D/g, "").replace(/^8/, "7").slice(-10);
}

function formatDate(isoOrTs) {
  if (!isoOrTs) return "—";
  const d = new Date(isoOrTs);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function formatDateTime(isoOrTs) {
  if (!isoOrTs) return "—";
  const d = new Date(isoOrTs);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }) +
    " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
function daysBetween(a, b) {
  return Math.floor((new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24));
}
function isToday(dateStr) {
  const t = new Date();
  const d = new Date(dateStr);
  return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
}

async function logHistory(candidateId, action) {
  await dbPush(`candidates/${candidateId}/history`, {
    action,
    date: nowISO(),
    user: state.user?.name || state.user?.email || "система",
  });
}

// ----------------------------------------------------------------
// 3. AUTH
// ----------------------------------------------------------------

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#loginEmail").value.trim();
  const password = $("#loginPassword").value;
  const remember = $("#loginRemember").checked;
  $("#loginError").classList.add("hidden");
  try {
    await login(email, password, remember);
  } catch (err) {
    $("#loginError").textContent = "Неверный email или пароль";
    $("#loginError").classList.remove("hidden");
  }
});

$("#openSettingsBtn").addEventListener("click", () => {
  $("#profileName").value = state.user?.name || "";
  $("#profileEmail").value = state.user?.email || "";
  renderTagsManager();
  openModal("settingsModal");
});

watchAuth(async (fbUser) => {
  if (fbUser) {
    const profile = await dbGet(`users/${fbUser.uid}`);
    state.user = { uid: fbUser.uid, email: fbUser.email, ...(profile || { name: fbUser.email, role: "recruiter" }) };
    $("#loginScreen").classList.add("hidden");
    $("#app").classList.remove("hidden");
    applyRoleVisibility();
    initListeners();
  } else {
    state.user = null;
    $("#app").classList.add("hidden");
    $("#loginScreen").classList.remove("hidden");
  }
});

function applyRoleVisibility() {
  const isAdmin = state.user?.role === "admin";
  $all("[data-admin-only]").forEach((el) => (el.style.display = isAdmin ? "" : "none"));
}

// ----------------------------------------------------------------
// 4. NAVIGATION
// ----------------------------------------------------------------

function showView(name) {
  $all(".view").forEach((v) => v.classList.add("hidden"));
  $("#view-" + name).classList.remove("hidden");
  $all(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === name));
  $(".main").scrollTop = 0;
  if (name === "candidates") renderCandidatesTable();
  if (name === "analytics") renderAnalytics();
  if (name === "users") renderUsersTable();
  if (name === "vacancies") renderVacancies();
}

$all(".nav-item").forEach((btn) =>
  btn.addEventListener("click", () => {
    if (btn.dataset.view === "kanban") openKanban(null);
    else showView(btn.dataset.view);
  })
);

// ----------------------------------------------------------------
// 5. VACANCIES
// ----------------------------------------------------------------

let vacancyFilterMode = "active";

function renderVacancies() {
  const grid = $("#vacancyGrid");
  const search = $("#vacancySearch").value.trim().toLowerCase();
  const list = Object.entries(state.vacancies)
    .filter(([id, v]) => (vacancyFilterMode === "all" ? true : v.status === "active"))
    .filter(([id, v]) => !search || v.title.toLowerCase().includes(search) || (v.manager || "").toLowerCase().includes(search))
    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  grid.innerHTML = "";
  $("#vacancyEmpty").classList.toggle("hidden", list.length > 0);

  const statusLabel = { active: "Активна", paused: "Приостановлена", closed: "Закрыта" };

  list.forEach(([id, v]) => {
    const candidatesForV = Object.values(state.candidates).filter((c) => c.vacancyId === id);
    const employed = candidatesForV.filter((c) => c.stage === "Трудоустройство" && c.employmentDate).length;
    const progress = v.slots ? Math.min(100, Math.round((employed / v.slots) * 100)) : 0;

    const card = document.createElement("div");
    card.className = "vacancy-card";
    card.innerHTML = `
      <div class="vacancy-card-title">${escapeHtml(v.title)}</div>
      <div class="vacancy-card-manager">${escapeHtml(v.manager || "")}${v.internalPhone ? ` · вн. ${escapeHtml(v.internalPhone)}` : ""}</div>
      <div class="vacancy-card-row"><span>Кандидатов</span><span>${candidatesForV.length}</span></div>
      <div class="vacancy-card-row"><span>Трудоустроено</span><span>${employed} / ${v.slots || 0}</span></div>
      <div class="vacancy-card-row"><span class="vacancy-card-status">${statusLabel[v.status] || v.status}</span><span>${formatDate(v.openDate)}</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
    `;
    card.addEventListener("click", () => openVacancyEditModal(id));
    grid.appendChild(card);
  });
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str ?? "";
  return d.innerHTML;
}

$("#vacancySearch").addEventListener("input", renderVacancies);
$("#vacancyFilter").addEventListener("click", (e) => {
  const btn = e.target.closest(".segmented-item");
  if (!btn) return;
  $all("#vacancyFilter .segmented-item").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  vacancyFilterMode = btn.dataset.filter;
  renderVacancies();
});

let editingVacancyId = null;

$("#addVacancyBtn").addEventListener("click", () => {
  editingVacancyId = null;
  $("#vacancyModalTitle").textContent = "Новая вакансия";
  $("#vacancyForm").reset();
  refreshCustomSelect($("#vStatus"));
  $("#vOpenDate").value = new Date().toISOString().slice(0, 10);
  $("#deleteVacancyBtn").classList.add("hidden");
  $("#openVacancyKanbanBtn").classList.add("hidden");
  openModal("vacancyModal");
});

function openVacancyEditModal(id) {
  const v = state.vacancies[id];
  if (!v) return;
  editingVacancyId = id;
  $("#vacancyModalTitle").textContent = v.title;
  $("#vTitle").value = v.title || "";
  $("#vManager").value = v.manager || "";
  $("#vManagerPhone").value = formatPhone(v.managerPhone || "");
  $("#vInternalPhone").value = v.internalPhone || "";
  $("#vDescription").value = v.description || "";
  $("#vSlots").value = v.slots || 1;
  $("#vStatus").value = v.status || "active";
  refreshCustomSelect($("#vStatus"));
  $("#vOpenDate").value = v.openDate || "";
  $("#vCloseDate").value = v.closeDate || "";
  $("#vComment").value = v.comment || "";
  $("#deleteVacancyBtn").classList.remove("hidden");
  $("#openVacancyKanbanBtn").classList.remove("hidden");
  openModal("vacancyModal");
}

$("#openVacancyKanbanBtn").addEventListener("click", () => {
  const id = editingVacancyId;
  closeModal("vacancyModal");
  openKanban(id);
});

$("#deleteVacancyBtn").addEventListener("click", () => {
  const id = editingVacancyId;
  if (!id) return;
  const candidatesCount = Object.values(state.candidates).filter((c) => c.vacancyId === id).length;
  const warn = candidatesCount
    ? `Удалить вакансию? У неё ${candidatesCount} кандидатов — они останутся в базе, но без привязки к вакансии.`
    : "Удалить вакансию без возможности восстановления?";
  confirmAction(warn, async () => {
    await dbRemove(`vacancies/${id}`);
    closeModal("vacancyModal");
    toast("Вакансия удалена");
  });
});

$("#saveVacancyBtn").addEventListener("click", async () => {
  const title = $("#vTitle").value.trim();
  const manager = $("#vManager").value.trim();
  if (!title || !manager) { toast("Заполните обязательные поля", true); return; }
  const payload = {
    title,
    manager,
    managerPhone: formatPhone($("#vManagerPhone").value),
    internalPhone: $("#vInternalPhone").value.trim(),
    description: $("#vDescription").value.trim(),
    slots: Number($("#vSlots").value) || 1,
    status: $("#vStatus").value,
    openDate: $("#vOpenDate").value,
    closeDate: $("#vCloseDate").value,
    comment: $("#vComment").value.trim(),
  };
  try {
    if (editingVacancyId) {
      await dbUpdate(`vacancies/${editingVacancyId}`, payload);
      toast("Вакансия обновлена");
    } else {
      payload.createdAt = Date.now();
      await dbPush("vacancies", payload);
      toast("Вакансия создана");
    }
    closeModal("vacancyModal");
  } catch (err) {
    toast("Ошибка сохранения: " + err.message, true);
  }
});

function updateManagersList() {
  const dl = $("#managersList");
  const names = [...new Set(Object.values(state.vacancies).map((v) => v.manager).filter(Boolean))];
  dl.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join("");
}

// ----------------------------------------------------------------
// 6. KANBAN
// ----------------------------------------------------------------

function populateKanbanScope() {
  const sel = $("#kanbanVacancyScope");
  const keep = sel.value;
  sel.innerHTML = `<option value="">Все вакансии</option>` +
    Object.entries(state.vacancies).map(([id, v]) => `<option value="${id}">${escapeHtml(v.title)}</option>`).join("");
  sel.value = keep;
  refreshCustomSelect(sel);
}

function openKanban(vacancyId) {
  state.currentVacancyId = vacancyId || null;
  state.interviewDateOffset = 0;
  showView("kanban");
  populateKanbanScope();
  $("#kanbanVacancyScope").value = state.currentVacancyId || "";
  refreshCustomSelect($("#kanbanVacancyScope"));
  renderKanban();
  renderInterviewsPanel();
}

$("#kanbanVacancyScope").addEventListener("change", (e) => {
  openKanban(e.target.value || null);
});

function renderKanban() {
  const board = $("#kanbanBoard");
  board.innerHTML = "";
  const vacancyId = state.currentVacancyId;

  STAGES.forEach((stage) => {
    const col = document.createElement("div");
    col.className = "kanban-column";
    col.dataset.stage = stage;

    const candidatesInStage = Object.entries(state.candidates)
      .filter(([id, c]) => (!vacancyId || c.vacancyId === vacancyId) && c.stage === stage && c.onKanban !== false && !(stage === "Трудоустройство" && c.employmentDate))
      .sort((a, b) => {
        const aNext = nextInterviewTime(a[0]);
        const bNext = nextInterviewTime(b[0]);
        if (aNext && bNext) return aNext - bNext;
        if (aNext) return -1;
        if (bNext) return 1;
        return (a[1].createdAt || 0) - (b[1].createdAt || 0);
      });

    col.innerHTML = `<div class="kanban-column-header"><span>${stage}</span><span>${candidatesInStage.length}</span></div>
      <div class="kanban-column-body" data-stage="${stage}"></div>`;
    board.appendChild(col);

    const body = $(".kanban-column-body", col);
    candidatesInStage.forEach(([id, c]) => body.appendChild(renderKCard(id, c)));

    body.addEventListener("dragover", (e) => { e.preventDefault(); body.classList.add("drag-over"); });
    body.addEventListener("dragleave", () => body.classList.remove("drag-over"));
    body.addEventListener("drop", (e) => {
      e.preventDefault();
      body.classList.remove("drag-over");
      const candidateId = e.dataTransfer.getData("text/plain");
      handleStageDrop(candidateId, stage);
    });
  });
}

function nextInterviewTime(candidateId) {
  const c = state.candidates[candidateId];
  if (!c || !c.interviews) return null;
  const upcoming = Object.values(c.interviews)
    .filter((i) => !i.result && new Date(`${i.date}T${i.time || "00:00"}`) >= new Date().setHours(0, 0, 0, 0))
    .map((i) => new Date(`${i.date}T${i.time || "00:00"}`).getTime());
  return upcoming.length ? Math.min(...upcoming) : null;
}

function renderKCard(id, c) {
  const el = document.createElement("div");
  el.className = "kcard";
  el.draggable = true;
  el.dataset.id = id;

  const hasInterviewToday = c.interviews && Object.values(c.interviews).some((i) => isToday(i.date) && !i.result);
  const tagsHtml = Object.keys(c.tags || {}).map((tagId) => {
    const t = state.tags[tagId];
    if (!t) return "";
    return `<span class="tag-chip" style="background:${t.color}22;color:${t.color}">${escapeHtml(t.name)}</span>`;
  }).join("");

  el.innerHTML = `
    <div class="kcard-name">${escapeHtml(c.name)}</div>
    <div class="kcard-phone">${escapeHtml(formatPhone(c.phone))}</div>
    ${!state.currentVacancyId ? `<div class="kcard-vacancy">${escapeHtml(state.vacancies[c.vacancyId]?.title || "—")}</div>` : ""}
    <div class="kcard-meta">
      <span class="kcard-source">${sourceLabel(c.source)}</span>
      ${hasInterviewToday ? '<span class="kcard-today">сегодня собес.</span>' : ""}
    </div>
    ${tagsHtml ? `<div class="kcard-tags">${tagsHtml}</div>` : ""}
  `;
  el.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", id);
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => el.classList.remove("dragging"));
  el.addEventListener("click", () => openCandidateModal(id));
  return el;
}

function sourceLabel(src) {
  return { hh: "hh", avito: "авито", other: "другое" }[src] || src || "";
}

async function handleStageDrop(candidateId, newStage) {
  const c = state.candidates[candidateId];
  if (!c || c.stage === newStage) return;

  const doMove = async () => {
    await dbUpdate(`candidates/${candidateId}`, { stage: newStage, stageChangedAt: nowISO() });
    await logHistory(candidateId, `Этап изменён: ${c.stage} → ${newStage}`);
  };

  // проверка анкеты при переходе Собеседование -> Отобрано
  if (c.stage === "Собеседование" && newStage === "Отобрано" && !c.formLink) {
    confirmAction("Анкета кандидата не загружена. Продолжить перевод без анкеты?", doMove);
    return;
  }

  await doMove();
}

// панель собеседований (по датам)
function renderInterviewsPanel() {
  const offset = state.interviewDateOffset;
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + offset);
  const targetStr = targetDate.toISOString().slice(0, 10);

  $("#interviewsDateLabel").textContent = offset === 0
    ? "Сегодня"
    : targetDate.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });

  const list = $("#interviewsList");
  list.innerHTML = "";

  const items = [];
  Object.entries(state.candidates).forEach(([id, c]) => {
    if ((state.currentVacancyId && c.vacancyId !== state.currentVacancyId) || !c.interviews) return;
    Object.values(c.interviews).forEach((iv) => {
      if (iv.date === targetStr) items.push({ candidateId: id, candidate: c, iv });
    });
  });
  items.sort((a, b) => (a.iv.time || "").localeCompare(b.iv.time || ""));

  if (!items.length) {
    list.innerHTML = `<div class="interviews-empty">Собеседований нет</div>`;
    return;
  }

  items.forEach(({ candidateId, candidate, iv }) => {
    const chip = document.createElement("div");
    chip.className = "interview-chip";
    chip.innerHTML = `
      <div class="interview-chip-time">${iv.time || "—"}</div>
      <div class="interview-chip-name">${escapeHtml(candidate.name)}</div>
      <div class="interview-chip-phone">${escapeHtml(formatPhone(candidate.phone))}</div>
    `;
    chip.addEventListener("click", () => openCandidateModal(candidateId, "interviews"));
    list.appendChild(chip);
  });
}
$("#interviewPrevDay").addEventListener("click", () => { state.interviewDateOffset--; renderInterviewsPanel(); });
$("#interviewNextDay").addEventListener("click", () => { state.interviewDateOffset++; renderInterviewsPanel(); });

$("#addCandidateBtn").addEventListener("click", () => openCandidateModal(null));

// ----------------------------------------------------------------
// 7. CANDIDATE CARD
// ----------------------------------------------------------------

function fillVacancySelect(selectEl) {
  selectEl.innerHTML = Object.entries(state.vacancies)
    .map(([id, v]) => `<option value="${id}">${escapeHtml(v.title)}</option>`)
    .join("");
}

function openCandidateModal(candidateId, activeTab = "info") {
  state.currentCandidateId = candidateId;
  fillVacancySelect($("#cVacancy"));
  $("#duplicateWarning").classList.add("hidden");

  const c = candidateId ? state.candidates[candidateId] : null;
  $("#candidateModalTitle").textContent = c ? c.name : "Новый кандидат";
  $("#deleteCandidateBtn").classList.toggle("hidden", !candidateId);

  $("#cName").value = c?.name || "";
  $("#cPhone").value = c ? formatPhone(c.phone) : "";
  $("#cVacancy").value = c?.vacancyId || state.currentVacancyId || "";
  $("#cSource").value = c?.source || "hh";
  refreshCustomSelect($("#cVacancy"));
  refreshCustomSelect($("#cSource"));
  $("#cResumeLink").value = c?.resumeLink || "";
  $("#cComment").value = c?.comment || "";
  $("#cCreatedAt").value = c?.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);

  renderTagPicker(c?.tags || {});
  renderStageTab(c);
  renderInterviewsTab(c, candidateId);
  $("#docResumeLink").value = c?.resumeLink || "";
  $("#docFormLink").value = c?.formLink || "";
  renderNotesTab(c);
  renderHistoryTab(c);

  switchCandidateTab(activeTab);
  openModal("candidateModal");
}

function switchCandidateTab(tab) {
  $all(".modal-tab", $("#candidateTabs")).forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $all(".tab-pane", $("#candidateModal")).forEach((p) => p.classList.toggle("active", p.dataset.pane === tab));
  $(".modal-body", $("#candidateModal")).scrollTop = 0;
}
$("#candidateTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".modal-tab");
  if (btn) switchCandidateTab(btn.dataset.tab);
});

function renderTagPicker(selectedTags) {
  const wrap = $("#cTagPicker");
  state.pendingTagSelection = new Set(Object.keys(selectedTags || {}));
  wrap.innerHTML = "";
  Object.entries(state.tags).forEach(([id, t]) => {
    const chip = document.createElement("span");
    chip.className = "tag-chip" + (state.pendingTagSelection.has(id) ? " selected" : "");
    chip.style.background = t.color + "22";
    chip.style.color = t.color;
    chip.textContent = t.name;
    chip.addEventListener("click", () => {
      if (state.pendingTagSelection.has(id)) state.pendingTagSelection.delete(id);
      else state.pendingTagSelection.add(id);
      chip.classList.toggle("selected");
    });
    wrap.appendChild(chip);
  });
}

function renderStageTab(c) {
  const list = $("#stageList");
  list.innerHTML = STAGES.map((stage) => `
    <div class="stage-item ${c && c.stage === stage ? "current" : ""}">
      <span class="stage-dot"></span><span>${stage}</span>
    </div>`).join("");

  // ручной переключатель "на Kanban / только в базе" — независим от этапа
  if (c) {
    const isOnKanban = c.onKanban !== false;
    const toggleBox = document.createElement("div");
    toggleBox.style.marginTop = "16px";
    toggleBox.innerHTML = `
      <button class="btn ${isOnKanban ? "btn-secondary" : "btn-primary"} btn-tiny" id="toggleKanbanBtn">
        ${isOnKanban ? "Убрать с Kanban (оставить только в базе)" : "Вернуть в Kanban"}
      </button>
    `;
    list.appendChild(toggleBox);
    $("#toggleKanbanBtn", toggleBox).addEventListener("click", async () => {
      await dbUpdate(`candidates/${state.currentCandidateId}`, { onKanban: !isOnKanban });
      await logHistory(state.currentCandidateId, isOnKanban ? "Вручную убран с Kanban" : "Возвращён в Kanban");
      toast(isOnKanban ? "Кандидат убран с Kanban" : "Кандидат возвращён в Kanban");
      closeModal("candidateModal");
    });
  }

  // для этапа "Трудоустройство" — поле даты трудоустройства, обязательное
  // для того, чтобы кандидат пропал с kanban и остался только в базе.
  if (c && c.stage === "Трудоустройство") {
    const box = document.createElement("div");
    box.style.marginTop = "16px";
    box.innerHTML = `
      <label class="field">
        <span class="field-label">Дата трудоустройства</span>
        <input type="date" id="employmentDateInput" value="${c.employmentDate || ""}" />
      </label>
      <button class="btn btn-primary btn-tiny" id="saveEmploymentDateBtn">Сохранить дату</button>
    `;
    list.appendChild(box);
    $("#saveEmploymentDateBtn", box).addEventListener("click", async () => {
      const val = $("#employmentDateInput", box).value;
      if (!val) { toast("Укажите дату трудоустройства", true); return; }
      await dbUpdate(`candidates/${state.currentCandidateId}`, { employmentDate: val, status: "трудоустроен" });
      await logHistory(state.currentCandidateId, `Дата трудоустройства: ${formatDate(val)}`);
      toast("Кандидат трудоустроен — убран с Kanban");
      closeModal("candidateModal");
    });
  }
}

function renderInterviewsTab(c, candidateId) {
  const box = $("#interviewHistory");
  box.innerHTML = "";
  if (!c || !c.interviews) {
    box.innerHTML = `<div class="interviews-empty">Собеседований пока нет</div>`;
  } else {
    Object.entries(c.interviews)
      .sort((a, b) => new Date(b[1].date) - new Date(a[1].date))
      .forEach(([ivId, iv]) => {
        const row = document.createElement("div");
        row.className = "interview-row";
        const resultLabel = { pass: "Прошёл дальше", fail: "Не подходит", noshow: "Не пришёл", "": "Ожидает" }[iv.result || ""];
        row.innerHTML = `
          <strong>${formatDate(iv.date)} ${iv.time || ""}</strong> — ${resultLabel}
          ${iv.comment ? `<div>${escapeHtml(iv.comment)}</div>` : ""}
          <div class="interview-actions" style="margin-top:6px;display:flex;gap:6px;"></div>
        `;
        if (!iv.result) {
          const actions = $(".interview-actions", row);
          ["pass", "fail", "noshow"].forEach((res) => {
            const b = document.createElement("button");
            b.className = "btn btn-tiny btn-secondary";
            b.textContent = { pass: "Прошёл", fail: "Не подходит", noshow: "Не пришёл" }[res];
            b.addEventListener("click", () => setInterviewResult(candidateId, ivId, res));
            actions.appendChild(b);
          });
        }
        box.appendChild(row);
      });
  }
}

$("#addInterviewBtn").addEventListener("click", async () => {
  const candidateId = state.currentCandidateId;
  if (!candidateId) { toast("Сначала сохраните кандидата", true); return; }
  const date = $("#newInterviewDate").value;
  const time = $("#newInterviewTime").value;
  if (!date) { toast("Укажите дату", true); return; }
  await dbPush(`candidates/${candidateId}/interviews`, {
    date, time, comment: $("#newInterviewComment").value.trim(), result: "",
  });
  await logHistory(candidateId, `Назначено собеседование: ${formatDate(date)} ${time}`);
  $("#newInterviewComment").value = "";
  toast("Собеседование назначено");
});

async function setInterviewResult(candidateId, ivId, result) {
  await dbUpdate(`candidates/${candidateId}/interviews/${ivId}`, { result });
  const c = state.candidates[candidateId];
  await logHistory(candidateId, `Результат собеседования: ${{ pass: "прошёл дальше", fail: "не подходит", noshow: "не пришёл" }[result]}`);

  if (result === "noshow") {
    const newCount = (c.noShowCount || 0) + 1;
    await dbUpdate(`candidates/${candidateId}`, { noShowCount: newCount });
    if (newCount >= NOSHOW_LIMIT) {
      await addSystemTagToCandidate(candidateId, "чёрный список");
      toast("Кандидат добавлен в чёрный список (3 неявки)");
    }
  } else if (result === "fail") {
    await dbUpdate(`candidates/${candidateId}`, { status: "не подходит" });
  }
  toast("Результат сохранён");
}

async function ensureSystemTags() {
  for (const name of SYSTEM_TAGS) {
    const exists = Object.values(state.tags).some((t) => t.name === name);
    if (!exists) {
      const colors = { "не вышел на связь": "#c9a24a", "чёрный список": "#333333", "не подходит": "#a85c5c", "не актуально": "#8a8a8e" };
      await dbPush("tags", { name, color: colors[name] || "#999999" });
    }
  }
}

// центральная точка для побочных эффектов от тегов: убрать с Kanban,
// проставить статус. Вызывается из ЛЮБОГО места, где кандидату добавляется
// тег — карточка кандидата, массовое действие, автоматика чёрного списка.
async function applyTagAutomation(candidateId, tagName) {
  if (!KANBAN_REMOVE_TAGS.has(tagName)) return;
  const updates = { onKanban: false };
  if (TAG_STATUS_MAP[tagName]) updates.status = TAG_STATUS_MAP[tagName];
  await dbUpdate(`candidates/${candidateId}`, updates);
  await logHistory(candidateId, `Автоматически убран с Kanban (тег «${tagName}»)`);
}

async function addSystemTagToCandidate(candidateId, tagName) {
  const tagEntry = Object.entries(state.tags).find(([id, t]) => t.name === tagName);
  if (!tagEntry) return;
  await dbUpdate(`candidates/${candidateId}/tags`, { [tagEntry[0]]: true });
  await applyTagAutomation(candidateId, tagName);
}

$("#saveDocsBtn").addEventListener("click", async () => {
  const candidateId = state.currentCandidateId;
  if (!candidateId) { toast("Сначала сохраните кандидата", true); return; }
  await dbUpdate(`candidates/${candidateId}`, {
    resumeLink: $("#docResumeLink").value.trim(),
    formLink: $("#docFormLink").value.trim(),
  });
  await logHistory(candidateId, "Обновлены ссылки на документы");
  toast("Документы сохранены");
});

function renderNotesTab(c) {
  const box = $("#notesList");
  box.innerHTML = "";
  if (!c || !c.notes) { box.innerHTML = `<div class="interviews-empty">Заметок пока нет</div>`; return; }
  Object.values(c.notes)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .forEach((n) => {
      const row = document.createElement("div");
      row.className = "note-row";
      row.innerHTML = `${escapeHtml(n.text)}<div class="note-row-meta">${escapeHtml(n.user)} · ${formatDateTime(n.date)}</div>`;
      box.appendChild(row);
    });
}
$("#addNoteBtn").addEventListener("click", async () => {
  const candidateId = state.currentCandidateId;
  if (!candidateId) { toast("Сначала сохраните кандидата", true); return; }
  const text = $("#newNoteText").value.trim();
  if (!text) return;
  await dbPush(`candidates/${candidateId}/notes`, { text, date: nowISO(), user: state.user.name || state.user.email });
  $("#newNoteText").value = "";
  toast("Заметка добавлена");
});

function renderHistoryTab(c) {
  const box = $("#historyList");
  box.innerHTML = "";
  if (!c || !c.history) { box.innerHTML = `<div class="interviews-empty">История пуста</div>`; return; }
  Object.values(c.history)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .forEach((h) => {
      const row = document.createElement("div");
      row.className = "history-row";
      row.innerHTML = `${escapeHtml(h.action)}<div class="history-row-meta">${escapeHtml(h.user)} · ${formatDateTime(h.date)}</div>`;
      box.appendChild(row);
    });
}

function findDuplicateCandidate(name, phoneDigitsStr, excludeId) {
  return Object.entries(state.candidates).find(([id, c]) =>
    id !== excludeId && (phoneDigits(c.phone) === phoneDigitsStr || c.name.trim().toLowerCase() === name.trim().toLowerCase())
  );
}

$("#saveCandidateBtn").addEventListener("click", async () => {
  const name = $("#cName").value.trim();
  const phoneRaw = $("#cPhone").value.trim();
  const vacancyId = $("#cVacancy").value;
  const source = $("#cSource").value;
  if (!name || !phoneRaw || !vacancyId || !source) { toast("Заполните обязательные поля", true); return; }

  const pDigits = phoneDigits(phoneRaw);
  const dup = findDuplicateCandidate(name, pDigits, state.currentCandidateId);
  if (dup && !state.currentCandidateId) {
    $("#duplicateWarning").classList.remove("hidden");
    openCandidateModal(dup[0]);
    toast("Кандидат уже существует — открыта существующая карточка");
    return;
  }

  const tagsObj = {};
  state.pendingTagSelection.forEach((id) => (tagsObj[id] = true));
  const prevTagsForDiff = state.currentCandidateId ? (state.candidates[state.currentCandidateId]?.tags || {}) : {};
  const newlyAddedTagIds = Object.keys(tagsObj).filter((id) => !prevTagsForDiff[id]);

  const createdAtValue = $("#cCreatedAt").value ? new Date($("#cCreatedAt").value).getTime() : Date.now();

  const payload = {
    name, phone: pDigits, vacancyId, source,
    resumeLink: $("#cResumeLink").value.trim(),
    comment: $("#cComment").value.trim(),
    tags: tagsObj,
    createdAt: createdAtValue,
  };

  try {
    let targetId = state.currentCandidateId;
    if (targetId) {
      const prev = state.candidates[targetId];
      await dbUpdate(`candidates/${targetId}`, payload);
      if (prev.vacancyId !== vacancyId) await logHistory(targetId, "Вакансия изменена");
      toast("Кандидат обновлён");
    } else {
      payload.stage = "Отклик";
      payload.status = "активный";
      payload.stageChangedAt = nowISO();
      payload.noShowCount = 0;
      payload.onKanban = true;
      targetId = await dbPush("candidates", payload);
      await logHistory(targetId, "Кандидат создан");
      toast("Кандидат добавлен");
    }

    for (const tagId of newlyAddedTagIds) {
      const tagName = state.tags[tagId]?.name;
      if (tagName) await applyTagAutomation(targetId, tagName);
    }

    closeModal("candidateModal");
  } catch (err) {
    toast("Ошибка сохранения: " + err.message, true);
  }
});

$("#deleteCandidateBtn").addEventListener("click", () => {
  const candidateId = state.currentCandidateId;
  if (!candidateId) return;
  confirmAction("Удалить кандидата без возможности восстановления?", async () => {
    await dbRemove(`candidates/${candidateId}`);
    closeModal("candidateModal");
    toast("Кандидат удалён");
  });
});

// ----------------------------------------------------------------
// 8. CANDIDATES DATABASE (table, filters, search, bulk actions)
// ----------------------------------------------------------------

function populateCandidateFilters() {
  const vSel = $("#filterVacancy");
  const keepV = vSel.value;
  vSel.innerHTML = `<option value="">Вакансия: все</option>` +
    Object.entries(state.vacancies).map(([id, v]) => `<option value="${id}">${escapeHtml(v.title)}</option>`).join("");
  vSel.value = keepV;

  const sSel = $("#filterStage");
  const keepS = sSel.value;
  sSel.innerHTML = `<option value="">Этап: все</option>` + STAGES.map((s) => `<option value="${s}">${s}</option>`).join("");
  sSel.value = keepS;

  const statSel = $("#filterStatus");
  const keepStat = statSel.value;
  statSel.innerHTML = `<option value="">Статус: все</option>` +
    ["активный", "трудоустроен", "не вышел на связь", "не подходит"].map((s) => `<option value="${s}">${s}</option>`).join("");
  statSel.value = keepStat;
}

function renderCandidatesTable() {
  populateCandidateFilters();
  const search = $("#candidateSearch").value.trim().toLowerCase();
  const fVacancy = $("#filterVacancy").value;
  const fStage = $("#filterStage").value;
  const fSource = $("#filterSource").value;
  const fStatus = $("#filterStatus").value;

  const rows = Object.entries(state.candidates).filter(([id, c]) => {
    if (fVacancy && c.vacancyId !== fVacancy) return false;
    if (fStage && c.stage !== fStage) return false;
    if (fSource && c.source !== fSource) return false;
    if (fStatus && c.status !== fStatus) return false;
    if (search) {
      const hay = `${c.name} ${c.phone} ${state.vacancies[c.vacancyId]?.title || ""}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  }).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  const tbody = $("#candidatesTableBody");
  tbody.innerHTML = "";
  rows.forEach(([id, c]) => {
    const tr = document.createElement("tr");
    const isBlacklisted = Object.keys(c.tags || {}).some((tagId) => state.tags[tagId]?.name === "чёрный список");
    if (isBlacklisted) tr.classList.add("row-blacklisted");
    const tagsHtml = Object.keys(c.tags || {}).map((tagId) => {
      const t = state.tags[tagId];
      if (!t) return "";
      return `<span class="tag-chip" style="background:${t.color}22;color:${t.color}">${escapeHtml(t.name)}</span>`;
    }).join(" ");
    tr.innerHTML = `
      <td class="th-check"><input type="checkbox" class="row-check" data-id="${id}" ${state.selectedCandidateIds.has(id) ? "checked" : ""} /></td>
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(formatPhone(c.phone))}</td>
      <td>${escapeHtml(state.vacancies[c.vacancyId]?.title || "—")}</td>
      <td>${escapeHtml(c.stage || "—")}</td>
      <td>${sourceLabel(c.source)}</td>
      <td>${formatDate(c.createdAt)}</td>
      <td>${tagsHtml}</td>
      <td>${escapeHtml(c.status || "—")}</td>
    `;
    $(".row-check", tr).addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.target.checked) state.selectedCandidateIds.add(id); else state.selectedCandidateIds.delete(id);
      updateBulkBar();
    });
    tr.addEventListener("click", (e) => {
      if (e.target.classList.contains("row-check")) return;
      openCandidateModal(id);
    });
    tbody.appendChild(tr);
  });
}

["candidateSearch"].forEach((id) => $("#" + id).addEventListener("input", renderCandidatesTable));
["filterVacancy", "filterStage", "filterSource", "filterStatus"].forEach((id) =>
  $("#" + id).addEventListener("change", renderCandidatesTable)
);

$("#selectAllCandidates").addEventListener("change", (e) => {
  $all(".row-check").forEach((cb) => {
    cb.checked = e.target.checked;
    if (e.target.checked) state.selectedCandidateIds.add(cb.dataset.id); else state.selectedCandidateIds.delete(cb.dataset.id);
  });
  updateBulkBar();
});

function updateBulkBar() {
  const n = state.selectedCandidateIds.size;
  $("#bulkBar").classList.toggle("hidden", n === 0);
  $("#bulkCount").textContent = `${n} выбрано`;
}

$("#bulkDeleteBtn").addEventListener("click", () => {
  confirmAction(`Удалить ${state.selectedCandidateIds.size} кандидатов?`, async () => {
    for (const id of state.selectedCandidateIds) await dbRemove(`candidates/${id}`);
    state.selectedCandidateIds.clear();
    updateBulkBar();
    toast("Кандидаты удалены");
  });
});

$("#bulkReturnBtn").addEventListener("click", () => {
  if (!state.selectedCandidateIds.size) return;
  const firstId = [...state.selectedCandidateIds][0];
  const c = state.candidates[firstId];
  openBulkReturnFlow(c?.vacancyId);
});

async function openBulkReturnFlow(defaultVacancyId) {
  // упрощённая реализация: возвращаем всех выбранных на этап "Отклик" в их текущую вакансию
  for (const id of state.selectedCandidateIds) {
    await dbUpdate(`candidates/${id}`, { stage: "Отклик", status: "активный", stageChangedAt: nowISO(), employmentDate: null, onKanban: true });
    await logHistory(id, "Возвращён в Kanban (этап: Отклик)");
  }
  state.selectedCandidateIds.clear();
  updateBulkBar();
  toast("Кандидаты возвращены в Kanban");
}

$("#bulkVacancyBtn").addEventListener("click", () => {
  const title = prompt("Введите точное название вакансии, в которую перенести выбранных кандидатов:");
  if (!title) return;
  const entry = Object.entries(state.vacancies).find(([id, v]) => v.title === title);
  if (!entry) { toast("Вакансия не найдена", true); return; }
  (async () => {
    for (const id of state.selectedCandidateIds) {
      await dbUpdate(`candidates/${id}`, { vacancyId: entry[0] });
      await logHistory(id, `Вакансия изменена на: ${title}`);
    }
    state.selectedCandidateIds.clear();
    updateBulkBar();
    toast("Вакансия обновлена у выбранных кандидатов");
  })();
});

$("#bulkTagBtn").addEventListener("click", () => {
  const tagNames = Object.values(state.tags).map((t) => t.name).join(", ");
  const name = prompt(`Введите название тега для добавления (доступны: ${tagNames}):`);
  if (!name) return;
  const entry = Object.entries(state.tags).find(([id, t]) => t.name === name);
  if (!entry) { toast("Тег не найден", true); return; }
  (async () => {
    for (const id of state.selectedCandidateIds) {
      await dbUpdate(`candidates/${id}/tags`, { [entry[0]]: true });
      await applyTagAutomation(id, entry[1].name);
    }
    state.selectedCandidateIds.clear();
    updateBulkBar();
    toast("Тег добавлен выбранным кандидатам");
  })();
});

// ----------------------------------------------------------------
// 9. IMPORT
// ----------------------------------------------------------------

$("#importBtn").addEventListener("click", () => {
  state.importRows = [];
  $("#importFile").value = "";
  $("#importPasteArea").value = "";
  $("#importPreview").innerHTML = "";
  openModal("importModal");
});

$("#importFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.name.endsWith(".csv")) {
    Papa.parse(file, { header: true, skipEmptyLines: true, complete: (res) => setImportRows(res.data) });
  } else {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const wb = XLSX.read(ev.target.result, { type: "binary" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet);
      setImportRows(rows);
    };
    reader.readAsBinaryString(file);
  }
});

$("#importPasteArea").addEventListener("input", (e) => {
  const text = e.target.value.trim();
  if (!text) { setImportRows([]); return; }
  const parsed = Papa.parse(text, { header: true, delimiter: "\t", skipEmptyLines: true });
  if (parsed.data.length && Object.keys(parsed.data[0]).length > 1) {
    setImportRows(parsed.data);
  } else {
    const commaParsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    setImportRows(commaParsed.data);
  }
});

function normalizeImportRow(row) {
  const find = (keys) => {
    for (const k of Object.keys(row)) {
      if (keys.some((needle) => k.toLowerCase().includes(needle))) return row[k];
    }
    return "";
  };
  return {
    name: find(["фио", "имя", "name"]),
    phone: find(["телефон", "phone"]),
    vacancy: find(["вакансия", "vacancy"]),
    source: find(["источник", "source"]),
  };
}

function setImportRows(rawRows) {
  state.importRows = rawRows.map(normalizeImportRow).filter((r) => r.name || r.phone);
  const preview = $("#importPreview");
  if (!state.importRows.length) { preview.innerHTML = ""; return; }
  preview.innerHTML = `<table class="data-table"><thead><tr><th>ФИО</th><th>Телефон</th><th>Вакансия</th><th>Источник</th></tr></thead><tbody>` +
    state.importRows.slice(0, 50).map((r) => `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.phone)}</td><td>${escapeHtml(r.vacancy)}</td><td>${escapeHtml(r.source)}</td></tr>`).join("") +
    `</tbody></table><p>${state.importRows.length} строк найдено</p>`;
}

$("#confirmImportBtn").addEventListener("click", async () => {
  if (!state.importRows.length) { toast("Нет данных для импорта", true); return; }
  let created = 0, skipped = 0;
  for (const row of state.importRows) {
    if (!row.name || !row.phone) { skipped++; continue; }
    const pDigits = phoneDigits(row.phone);
    const dup = findDuplicateCandidate(row.name, pDigits, null);
    if (dup) { skipped++; continue; }
    const vacancyEntry = Object.entries(state.vacancies).find(([id, v]) => v.title.toLowerCase() === (row.vacancy || "").toLowerCase());
    const sourceMap = { hh: "hh", "hh.ru": "hh", авито: "avito", avito: "avito" };
    const newId = await dbPush("candidates", {
      name: row.name,
      phone: pDigits,
      vacancyId: vacancyEntry ? vacancyEntry[0] : Object.keys(state.vacancies)[0] || "",
      source: sourceMap[(row.source || "").toLowerCase()] || "other",
      stage: "Отклик",
      status: "активный",
      createdAt: Date.now(),
      stageChangedAt: nowISO(),
      noShowCount: 0,
      onKanban: true,
      tags: {},
    });
    await logHistory(newId, "Кандидат импортирован");
    created++;
  }
  toast(`Импортировано: ${created}, пропущено (дубли/ошибки): ${skipped}`);
  closeModal("importModal");
});

// ----------------------------------------------------------------
// 10. TAGS
// ----------------------------------------------------------------

function renderTagsManager() {
  const box = $("#tagsManager");
  const isAdmin = state.user?.role === "admin";
  box.innerHTML = "";
  Object.entries(state.tags).forEach(([id, t]) => {
    const row = document.createElement("div");
    row.className = "tag-manager-row";
    row.innerHTML = `
      <span class="tag-chip" style="background:${t.color}22;color:${t.color}">${escapeHtml(t.name)}</span>
      ${isAdmin ? `<input type="color" value="${t.color}" data-id="${id}" class="tag-color-input" />` : ""}
      ${isAdmin && !SYSTEM_TAGS.includes(t.name) ? `<button class="btn btn-tiny btn-danger" data-del-tag="${id}">Удалить</button>` : ""}
    `;
    box.appendChild(row);
  });
  $all(".tag-color-input", box).forEach((input) =>
    input.addEventListener("change", async (e) => {
      await dbUpdate(`tags/${e.target.dataset.id}`, { color: e.target.value });
    })
  );
  $all("[data-del-tag]", box).forEach((btn) =>
    btn.addEventListener("click", () => {
      confirmAction("Удалить тег?", async () => {
        await dbRemove(`tags/${btn.dataset.delTag}`);
        renderTagsManager();
      });
    })
  );

  // добавление тега — только администратор (правила Firebase всё равно это
  // заблокируют, но лучше не показывать форму, которая всё равно не сработает)
  $("#newTagName").parentElement.classList.toggle("hidden", !isAdmin);
  if (!isAdmin) {
    const note = document.createElement("p");
    note.className = "import-hint";
    note.textContent = "Редактирование справочника тегов доступно только администратору.";
    box.appendChild(note);
  }
}

$("#addTagBtn").addEventListener("click", async () => {
  const name = $("#newTagName").value.trim();
  const color = $("#newTagColor").value;
  if (!name) { toast("Введите название тега", true); return; }
  await dbPush("tags", { name, color });
  $("#newTagName").value = "";
  toast("Тег создан");
});

// ----------------------------------------------------------------
// 11. ANALYTICS
// ----------------------------------------------------------------

let analyticsPeriod = "month";

function populateAnalyticsScope() {
  const sel = $("#analyticsScope");
  const keep = sel.value;
  sel.innerHTML = `<option value="all">Вся CRM</option>` +
    Object.entries(state.vacancies).map(([id, v]) => `<option value="${id}">${escapeHtml(v.title)}</option>`).join("");
  sel.value = keep || "all";
}

$("#analyticsPeriod").addEventListener("click", (e) => {
  const btn = e.target.closest(".segmented-item");
  if (!btn) return;
  $all("#analyticsPeriod .segmented-item").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  analyticsPeriod = btn.dataset.period;
  renderAnalytics();
});
$("#analyticsScope").addEventListener("change", renderAnalytics);

function periodStartDate() {
  const d = new Date();
  if (analyticsPeriod === "day") d.setDate(d.getDate() - 1);
  else if (analyticsPeriod === "week") d.setDate(d.getDate() - 7);
  else if (analyticsPeriod === "month") d.setMonth(d.getMonth() - 1);
  else if (analyticsPeriod === "year") d.setFullYear(d.getFullYear() - 1);
  return d;
}

function renderAnalytics() {
  populateAnalyticsScope();
  const scope = $("#analyticsScope").value;
  const start = periodStartDate();

  const candidates = Object.values(state.candidates).filter((c) => {
    if (scope !== "all" && c.vacancyId !== scope) return false;
    return !c.createdAt || new Date(c.createdAt) >= start;
  });

  const totalCandidates = candidates.length;
  const activeVacancies = Object.values(state.vacancies).filter((v) => v.status === "active" && (scope === "all" || true)).length;
  const employed = candidates.filter((c) => c.employmentDate).length;
  const interviewsCount = candidates.reduce((acc, c) => acc + Object.keys(c.interviews || {}).length, 0);

  $("#statGrid").innerHTML = [
    ["Всего кандидатов", totalCandidates],
    ["Активные вакансии", activeVacancies],
    ["Трудоустроено", employed],
    ["Собеседования", interviewsCount],
  ].map(([label, value]) => `
    <div class="stat-card"><div class="stat-card-value">${value}</div><div class="stat-card-label">${label}</div></div>
  `).join("");

  // воронка
  const funnelCounts = STAGES.map((stage) => candidates.filter((c) => STAGES.indexOf(c.stage) >= STAGES.indexOf(stage)).length);
  const max = funnelCounts[0] || 1;
  $("#funnel").innerHTML = STAGES.map((stage, i) => `
    <div class="funnel-row">
      <span class="funnel-label">${stage}</span>
      <div class="funnel-track"><div class="funnel-fill" style="width:${max ? (funnelCounts[i] / max) * 100 : 0}%"></div></div>
      <span class="funnel-count">${funnelCounts[i]} · ${max ? Math.round((funnelCounts[i] / max) * 100) : 0}%</span>
    </div>
  `).join("");

  // среднее время закрытия вакансии
  const closedVacancies = Object.values(state.vacancies).filter((v) => v.status === "closed" && v.openDate && v.closeDate);
  if (closedVacancies.length) {
    const avgDays = closedVacancies.reduce((acc, v) => acc + daysBetween(v.openDate, v.closeDate), 0) / closedVacancies.length;
    $("#avgCloseTime").textContent = `${Math.round(avgDays)} дн.`;
  } else {
    $("#avgCloseTime").textContent = "нет закрытых вакансий за период";
  }
}

// ----------------------------------------------------------------
// 12. USERS
// ----------------------------------------------------------------

function renderUsersTable() {
  const tbody = $("#usersTableBody");
  tbody.innerHTML = "";
  Object.entries(state.users).forEach(([uid, u]) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(u.name)}</td>
      <td>${escapeHtml(u.email)}</td>
      <td>${u.role === "admin" ? "Администратор" : "Рекрутер"}</td>
      <td>${uid !== state.user.uid ? `<button class="btn btn-tiny btn-danger" data-del-user="${uid}">Удалить</button>` : ""}</td>
    `;
    tbody.appendChild(tr);
  });
  $all("[data-del-user]", tbody).forEach((btn) =>
    btn.addEventListener("click", () => {
      confirmAction("Удалить пользователя? Кандидаты и вакансии сохранятся.", async () => {
        await dbRemove(`users/${btn.dataset.delUser}`);
        toast("Пользователь удалён из системы (доступ к Auth нужно закрыть вручную в консоли Firebase — на бесплатном тарифе это не автоматизировать)");
      });
    })
  );
}

$("#addUserBtn").addEventListener("click", () => {
  $("#userForm").reset();
  refreshCustomSelect($("#uRole"));
  openModal("userModal");
});

$("#saveUserBtn").addEventListener("click", async () => {
  const name = $("#uName").value.trim();
  const email = $("#uEmail").value.trim();
  const password = $("#uPassword").value;
  const role = $("#uRole").value;
  if (!name || !email || password.length < 6) { toast("Проверьте поля (пароль от 6 символов)", true); return; }
  try {
    await createUserAsAdmin({ email, password, name, role });
    toast("Пользователь создан");
    closeModal("userModal");
  } catch (err) {
    toast("Ошибка: " + err.message, true);
  }
});

// ----------------------------------------------------------------
// 13. SETTINGS
// ----------------------------------------------------------------

$("#settingsTabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".modal-tab");
  if (!btn) return;
  $all(".modal-tab", $("#settingsTabs")).forEach((b) => b.classList.toggle("active", b === btn));
  $all(".tab-pane", $("#settingsModal")).forEach((p) => p.classList.toggle("active", p.dataset.settingsPane === btn.dataset.settingsTab));
  $(".modal-body", $("#settingsModal")).scrollTop = 0;
});

$("#saveProfileBtn").addEventListener("click", async () => {
  const name = $("#profileName").value.trim();
  const newPassword = $("#profileNewPassword").value;
  try {
    if (name && name !== state.user.name) {
      await dbUpdate(`users/${state.user.uid}`, { name });
      state.user.name = name;
    }
    if (newPassword) {
      if (newPassword.length < 6) { toast("Пароль слишком короткий", true); return; }
      await changeOwnPassword(newPassword);
      $("#profileNewPassword").value = "";
    }
    toast("Профиль обновлён");
  } catch (err) {
    toast("Ошибка: " + err.message, true);
  }
});

const THEME_KEY = "demcrm-theme";
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  $all("[data-theme]").forEach((b) => b.classList.toggle("active", b.dataset.theme === theme));
  localStorage.setItem(THEME_KEY, theme);
}
$all("[data-theme]").forEach((btn) => btn.addEventListener("click", () => applyTheme(btn.dataset.theme)));

$("#resetInterfaceBtn").addEventListener("click", () => {
  applyTheme("light");
  toast("Настройки интерфейса сброшены");
});

// ----------------------------------------------------------------
// 14. AUTOMATION (авто-перенос по неделе, чёрный список — расчёт при загрузке)
// ----------------------------------------------------------------

async function runAutomationChecks() {
  const now = Date.now();
  for (const [id, c] of Object.entries(state.candidates)) {
    if (!c.stageChangedAt || STAGE_NO_AUTOTRANSFER.includes(c.stage) || c.stage === undefined) continue;
    if (c.onKanban === false) continue;
    const days = daysBetween(c.stageChangedAt, new Date(now).toISOString());
    if (days >= AUTOTRANSFER_DAYS) {
      await dbUpdate(`candidates/${id}`, { status: "не вышел на связь", onKanban: false });
      await logHistory(id, `Автоматически убран с Kanban (более ${AUTOTRANSFER_DAYS} дней на этапе «${c.stage}»)`);
    }
  }
}

// ----------------------------------------------------------------
// 15. QUICK SEARCH (Ctrl+K)
// ----------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("#quickSearchInput").value = "";
    $("#quickSearchResults").innerHTML = "";
    openModal("quickSearchModal");
    setTimeout(() => $("#quickSearchInput").focus(), 50);
  }
  if (e.key === "Escape") {
    $all(".modal:not(.hidden)").forEach((m) => m.classList.add("hidden"));
    $("#overlay").classList.add("hidden");
  }
});

$("#quickSearchInput").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  const box = $("#quickSearchResults");
  box.innerHTML = "";
  if (!q) return;

  const candMatches = Object.entries(state.candidates).filter(([id, c]) =>
    c.name.toLowerCase().includes(q) || phoneDigits(c.phone).includes(q.replace(/\D/g, ""))
  ).slice(0, 8);
  const vacMatches = Object.entries(state.vacancies).filter(([id, v]) => v.title.toLowerCase().includes(q)).slice(0, 5);

  candMatches.forEach(([id, c]) => {
    const item = document.createElement("div");
    item.className = "quick-search-item";
    item.innerHTML = `${escapeHtml(c.name)}<small>Кандидат · ${escapeHtml(state.vacancies[c.vacancyId]?.title || "")}</small>`;
    item.addEventListener("click", () => { closeModal("quickSearchModal"); openCandidateModal(id); });
    box.appendChild(item);
  });
  vacMatches.forEach(([id, v]) => {
    const item = document.createElement("div");
    item.className = "quick-search-item";
    item.innerHTML = `${escapeHtml(v.title)}<small>Вакансия · ${escapeHtml(v.manager || "")}</small>`;
    item.addEventListener("click", () => { closeModal("quickSearchModal"); openKanban(id); });
    box.appendChild(item);
  });
  if (!candMatches.length && !vacMatches.length) box.innerHTML = `<div class="quick-search-item">Ничего не найдено</div>`;
});

// ----------------------------------------------------------------
// 16. BOOTSTRAP
// ----------------------------------------------------------------

let listenersInitialized = false;

function initListeners() {
  if (listenersInitialized) return;
  listenersInitialized = true;

  applyTheme(localStorage.getItem(THEME_KEY) || "light");

  dbListen("vacancies", (data) => {
    state.vacancies = data || {};
    updateManagersList();
    if ($("#view-vacancies") && !$("#view-vacancies").classList.contains("hidden")) renderVacancies();
    if (!$("#view-kanban").classList.contains("hidden")) {
      populateKanbanScope();
      renderKanban();
    }
  });

  dbListen("candidates", async (data) => {
    state.candidates = data || {};
    if (!$("#view-kanban").classList.contains("hidden")) { renderKanban(); renderInterviewsPanel(); }
    if (!$("#view-candidates").classList.contains("hidden")) renderCandidatesTable();
    if (!$("#view-analytics").classList.contains("hidden")) renderAnalytics();
    await runAutomationChecks();
  });

  dbListen("tags", async (data) => {
    state.tags = data || {};
    if (Object.keys(state.tags).length === 0) await ensureSystemTags();
    if ($("#settingsModal") && !$("#settingsModal").classList.contains("hidden")) renderTagsManager();
  });

  dbListen("users", (data) => {
    state.users = data || {};
    if (!$("#view-users").classList.contains("hidden")) renderUsersTable();
  });

  openKanban(null);
}

// ----------------------------------------------------------------
// 17. CUSTOM DROPDOWNS
// Прогрессивное улучшение обычных <select class="js-enhance"> в
// кастомный список (пункт 2.10 тз). Логика значений (.value,
// событие change) остаётся на нативном select — весь остальной код
// продолжает работать как раньше, здесь только слой отрисовки.
// ----------------------------------------------------------------

let openCustomSelect = null;

function buildCustomSelectPanel(selectEl, panel) {
  panel.innerHTML = "";
  [...selectEl.options].forEach((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "custom-select-option" + (opt.value === selectEl.value ? " selected" : "");
    btn.textContent = opt.textContent;
    btn.addEventListener("click", () => {
      selectEl.value = opt.value;
      selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      refreshCustomSelect(selectEl);
      closeCustomSelect();
    });
    panel.appendChild(btn);
  });
}

function refreshCustomSelect(selectEl) {
  const wrap = selectEl.nextElementSibling;
  if (!wrap || !wrap.classList.contains("custom-select")) return;
  const label = $(".custom-select-label", wrap);
  const selectedOption = selectEl.options[selectEl.selectedIndex];
  label.textContent = selectedOption ? selectedOption.textContent : "";
  buildCustomSelectPanel(selectEl, $(".custom-select-panel", wrap));
}

function positionCustomSelectPanel(wrap) {
  const panel = $(".custom-select-panel", wrap);
  const trigger = $(".custom-select-trigger", wrap);
  panel.style.left = "0";
  panel.style.right = "auto";
  const triggerRect = trigger.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const overflowRight = triggerRect.left + panelRect.width - window.innerWidth + 16;
  if (overflowRight > 0) {
    panel.style.left = "auto";
    panel.style.right = "0";
  }
}

function closeCustomSelect() {
  if (!openCustomSelect) return;
  openCustomSelect.classList.remove("open");
  $(".custom-select-panel", openCustomSelect).classList.add("hidden");
  openCustomSelect = null;
}

function initCustomSelects() {
  $all("select.js-enhance:not(.enhanced)").forEach((selectEl) => {
    selectEl.classList.add("enhanced");

    const wrap = document.createElement("div");
    wrap.className = "custom-select";
    wrap.innerHTML = `
      <button type="button" class="custom-select-trigger">
        <span class="custom-select-label"></span>
        <span class="custom-select-chevron">▾</span>
      </button>
      <div class="custom-select-panel hidden"></div>
    `;
    selectEl.insertAdjacentElement("afterend", wrap);
    refreshCustomSelect(selectEl);

    $(".custom-select-trigger", wrap).addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = wrap.classList.contains("open");
      closeCustomSelect();
      if (!isOpen) {
        wrap.classList.add("open");
        $(".custom-select-panel", wrap).classList.remove("hidden");
        openCustomSelect = wrap;
        positionCustomSelectPanel(wrap);
      }
    });

    // синхронизация при программной перерисовке options (innerHTML rewrite
    // из populateCandidateFilters / fillVacancySelect / populateAnalyticsScope)
    new MutationObserver(() => refreshCustomSelect(selectEl)).observe(selectEl, { childList: true });
  });
}

document.addEventListener("click", closeCustomSelect);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCustomSelect(); });

document.addEventListener("DOMContentLoaded", initCustomSelects);
// на случай, если DOMContentLoaded уже прошёл к моменту загрузки модуля
if (document.readyState !== "loading") initCustomSelects();
