import {
  auth, db,
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
  ref, set, get, update, remove, push, onValue, serverTimestamp,
  ensureMainAdmin, createUserAsAdmin,
} from "./firebase.js";

const MAX_DOC_SIZE = 4 * 1024 * 1024; // 4мб — с запасом под base64-инфляцию в realtime db
const DOC_TYPES = [
  { key: "anketa", label: "анкета" },
  { key: "resume", label: "резюме" },
];

// этапы, на которых кандидат считается "потерянным", если не двигается 2 недели
const STALE_STAGE_IDS = ["response", "selected", "invited"];
const STALE_MS = 14 * 24 * 60 * 60 * 1000;

const PERIOD_TYPES = [
  { value: "day", label: "день" },
  { value: "week", label: "неделя" },
  { value: "month", label: "месяц" },
  { value: "year", label: "год" },
];

/* ===================== ГЛОБАЛЬНОЕ СОСТОЯНИЕ ===================== */
const state = {
  currentUser: null,   // { uid, name, email, role }
  vacancies: {},        // vacancyId -> vacancy
  candidates: {},        // candidateId -> candidate
  users: {},              // uid -> user
  managers: {},            // managerId -> { name, phone }
  activeSection: "vacancies",
  activeVacancyId: null,
  filters: {
    vacancyStatus: "all",
    candVacancy: "all",
    candStage: "all",
    candSource: "all",
  },
  analytics: { period: "month", offset: 0 },
};

const KANBAN_STAGES = [
  { id: "response", label: "отклик" },
  { id: "selected", label: "подходящий отклик" },
  { id: "invited", label: "приглашён" },
  { id: "form", label: "анкета" },
  { id: "interview", label: "собеседование" },
  { id: "selected2", label: "отобрано" },
  { id: "director_interview", label: "собеседование с директором" },
  { id: "hired", label: "трудоустройство" },
];

/* ===================== УТИЛИТЫ: TOAST ===================== */
function showToast(message, type = "default") {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = `toast${type === "error" ? " toast-error" : ""}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ===================== УТИЛИТЫ: МОДАЛКИ ===================== */
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

/* ===================== КАСТОМНЫЙ DROPDOWN (замена <select>) ===================== */
function buildCustomSelect({ options, value, placeholder = "выбрать", onChange }) {
  const wrap = document.createElement("div");
  wrap.className = "csel";
  wrap.dataset.value = value ?? "";

  wrap.innerHTML = `
    <button type="button" class="csel-trigger">
      <span class="csel-trigger-label"></span>
      <svg class="icon icon-sm csel-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <div class="csel-menu" hidden></div>
  `;

  const trigger = wrap.querySelector(".csel-trigger");
  const label = wrap.querySelector(".csel-trigger-label");
  const menu = wrap.querySelector(".csel-menu");

  function renderOptions(opts, val) {
    const found = opts.find((o) => String(o.value) === String(val));
    label.textContent = found ? found.label : placeholder;
    menu.innerHTML = opts.map((o) =>
      `<div class="csel-option${String(o.value) === String(val) ? " selected" : ""}" data-value="${escapeHtml(String(o.value))}">${escapeHtml(o.label)}</div>`
    ).join("") || `<div class="csel-empty">нет вариантов</div>`;
    menu.querySelectorAll(".csel-option").forEach((opt) => {
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        const val2 = opt.dataset.value;
        wrap.dataset.value = val2;
        renderOptions(opts, val2);
        closeCustomSelect(wrap);
        if (onChange) onChange(val2);
      });
    });
  }
  renderOptions(options, value);

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = !menu.hidden;
    closeAllCustomSelects();
    if (!isOpen) {
      menu.hidden = false;
      trigger.classList.add("open");
    }
  });

  wrap.updateOptions = (opts, val) => {
    wrap.dataset.value = val ?? "";
    renderOptions(opts, val);
  };

  return wrap;
}

function closeCustomSelect(wrap) {
  const menu = wrap.querySelector(".csel-menu");
  const trigger = wrap.querySelector(".csel-trigger");
  menu.hidden = true;
  trigger.classList.remove("open");
}

function closeAllCustomSelects() {
  document.querySelectorAll(".csel").forEach((w) => closeCustomSelect(w));
}

document.addEventListener("click", () => closeAllCustomSelects());

function mountSelect(container, options, value, onChange, placeholder) {
  if (!container) return null;
  container.innerHTML = "";
  const sel = buildCustomSelect({ options, value, onChange, placeholder });
  container.appendChild(sel);
  return sel;
}

/* ===================== ТЕЛЕФОН: 7 999 999-99-99 ===================== */
function normalizePhoneDigits(input) {
  let digits = String(input || "").replace(/\D/g, "");
  if (digits.startsWith("8")) digits = "7" + digits.slice(1);
  if (digits && !digits.startsWith("7")) digits = "7" + digits;
  return digits.slice(0, 11);
}

function formatPhoneDigits(digits) {
  if (!digits) return "";
  const d = digits;
  let out = d[0] || "";
  if (d.length > 1) out += " " + d.slice(1, 4);
  if (d.length > 4) out += " " + d.slice(4, 7);
  if (d.length > 7) out += "-" + d.slice(7, 9);
  if (d.length > 9) out += "-" + d.slice(9, 11);
  return out;
}

function formatPhone(input) {
  return formatPhoneDigits(normalizePhoneDigits(input));
}

function attachPhoneMask(input) {
  if (!input) return;
  input.addEventListener("input", () => {
    const digits = normalizePhoneDigits(input.value);
    input.value = formatPhoneDigits(digits);
  });
}

/* ===================== АВТОРИЗАЦИЯ ===================== */
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
    // профиля нет в базе — не пускаем без роли
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

/* ===================== НАВИГАЦИЯ ===================== */
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

/* ===================== ДАННЫЕ: REALTIME ПОДПИСКИ ===================== */
let listenersInitialized = false;
function initDataListeners() {
  if (listenersInitialized) return;
  listenersInitialized = true;

  onValue(ref(db, "vacancies"), (snap) => {
    state.vacancies = snap.val() || {};
    renderVacancies();
    renderCandidateFilters();
    if (state.activeSection === "analytics") renderAnalytics();
  });

  onValue(ref(db, "candidates"), (snap) => {
    state.candidates = snap.val() || {};
    renderVacancies(); // метрики вакансий зависят от кандидатов
    renderCandidatesTable();
    renderTodayInterviews();
    if (state.activeVacancyId) renderKanban();
    if (state.activeSection === "analytics") renderAnalytics();
    checkStaleCandidates();
  });

  onValue(ref(db, "users"), (snap) => {
    state.users = snap.val() || {};
    renderUsersTable();
  });

  onValue(ref(db, "managers"), (snap) => {
    state.managers = snap.val() || {};
  });
}

/* ===================== АВТОАРХИВ "НЕ ВЫШЕЛ НА СВЯЗЬ" ===================== */
let staleCheckRunning = false;
async function checkStaleCandidates() {
  if (staleCheckRunning) return;
  const now = Date.now();
  const stale = Object.entries(state.candidates).filter(([, c]) => {
    if (c.archived) return false;
    if (!STALE_STAGE_IDS.includes(c.stage)) return false;
    const lastMove = c.stageUpdatedAt || c.createdAt || now;
    return now - lastMove > STALE_MS;
  });
  if (!stale.length) return;

  staleCheckRunning = true;
  try {
    const updates = {};
    stale.forEach(([id]) => {
      updates[`candidates/${id}/archived`] = true;
      updates[`candidates/${id}/archivedAt`] = now;
      updates[`candidates/${id}/archiveReason`] = "не вышел на связь";
    });
    await update(ref(db), updates);
    await Promise.all(stale.map(([id]) => push(ref(db, `candidates/${id}/history`), {
      action: "автоматически отправлен в архив: не вышел на связь",
      userName: "система",
      at: serverTimestamp(),
    })));
  } catch (err) {
    // тихо — попробуем при следующем обновлении данных
  } finally {
    staleCheckRunning = false;
  }
}

/* ===================== ВАКАНСИИ: РЕНДЕР ===================== */
const vacancyGrid = document.getElementById("vacancies-grid");
const vacancyEmpty = document.getElementById("vacancies-empty");
const vacancySearch = document.getElementById("vacancy-search");

vacancySearch.addEventListener("input", renderVacancies);

function initVacancyFilterControls() {
  mountSelect(
    document.getElementById("vacancy-filter-mount"),
    [
      { value: "all", label: "все статусы" },
      { value: "active", label: "активна" },
      { value: "paused", label: "приостановлена" },
      { value: "closed", label: "закрыта" },
    ],
    state.filters.vacancyStatus,
    (val) => { state.filters.vacancyStatus = val; renderVacancies(); }
  );
}

const STATUS_LABELS = { active: "активна", paused: "приостановлена", closed: "закрыта" };

function vacancyMetrics(vacancyId) {
  const candidatesForVacancy = Object.entries(state.candidates).filter(([, c]) => c.vacancyId === vacancyId);
  const total = candidatesForVacancy.length;
  const hired = candidatesForVacancy.filter(([, c]) => c.stage === "hired").length;
  return { total, hired };
}

function renderVacancies() {
  const searchTerm = vacancySearch.value.trim().toLowerCase();
  const filterStatus = state.filters.vacancyStatus;

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
    const managerLine = [v.manager, v.managerPhone ? formatPhone(v.managerPhone) : ""].filter(Boolean).join(" · ");

    const card = document.createElement("div");
    card.className = "vacancy-card";
    card.innerHTML = `
      <div class="vacancy-card-title">${escapeHtml(v.title || "без названия")}</div>
      <div class="vacancy-card-manager">${escapeHtml(managerLine || "—")}</div>
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

/* ===================== ВАКАНСИИ: СОЗДАНИЕ ===================== */
document.getElementById("add-vacancy-btn").addEventListener("click", () => {
  openModal({
    title: "новая вакансия",
    bodyHtml: `
      <label class="field"><span class="field-label">название</span><input class="field-input" id="v-title" /></label>

      <label class="field"><span class="field-label">руководитель отдела</span><div id="v-manager-mount" class="csel-mount"></div></label>
      <button type="button" class="btn btn-ghost btn-sm" id="v-manager-toggle-new" style="align-self:flex-start;">+ новый руководитель</button>
      <div id="v-manager-new" class="field" hidden>
        <span class="field-label">имя нового руководителя</span>
        <input class="field-input" id="v-manager-new-name" />
        <span class="field-label" style="margin-top:8px;">телефон руководителя</span>
        <input class="field-input" id="v-manager-new-phone" placeholder="7 999 999-99-99" />
      </div>

      <label class="field"><span class="field-label">описание</span><textarea id="v-desc"></textarea></label>
      <label class="field"><span class="field-label">количество открытых мест</span><input type="number" min="1" class="field-input" id="v-positions" value="1" /></label>
      <label class="field"><span class="field-label">статус</span><div id="v-status-mount" class="csel-mount"></div></label>
      <label class="field"><span class="field-label">дата открытия</span><input type="date" class="field-input" id="v-open-date" /></label>
      <label class="field"><span class="field-label">дата закрытия</span><input type="date" class="field-input" id="v-close-date" /></label>
      <label class="field"><span class="field-label">комментарий</span><textarea id="v-comment"></textarea></label>
    `,
    footerHtml: `
      <button class="btn btn-secondary" id="v-cancel">отмена</button>
      <button class="btn btn-primary" id="v-save">сохранить</button>
    `,
    onMount: (overlay, close) => {
      let statusValue = "active";
      mountSelect(overlay.querySelector("#v-status-mount"),
        [{ value: "active", label: "активна" }, { value: "paused", label: "приостановлена" }, { value: "closed", label: "закрыта" }],
        statusValue, (val) => { statusValue = val; });

      let managerId = "";
      const managerOptions = () => Object.entries(state.managers).map(([id, m]) => ({
        value: id, label: `${m.name}${m.phone ? " · " + formatPhone(m.phone) : ""}`,
      }));
      const managerSelect = mountSelect(overlay.querySelector("#v-manager-mount"), managerOptions(), managerId,
        (val) => { managerId = val; }, "выберите руководителя");

      const newManagerBlock = overlay.querySelector("#v-manager-new");
      const newNameInput = overlay.querySelector("#v-manager-new-name");
      const newPhoneInput = overlay.querySelector("#v-manager-new-phone");
      attachPhoneMask(newPhoneInput);
      overlay.querySelector("#v-manager-toggle-new").addEventListener("click", () => {
        newManagerBlock.hidden = !newManagerBlock.hidden;
      });

      overlay.querySelector("#v-cancel").addEventListener("click", close);
      overlay.querySelector("#v-save").addEventListener("click", async () => {
        const title = overlay.querySelector("#v-title").value.trim();
        if (!title) { showToast("укажите название вакансии", "error"); return; }

        let finalManagerId = managerId;
        let finalManagerName = "";
        let finalManagerPhone = "";
        const newName = newNameInput.value.trim();

        if (newName) {
          const newPhoneDigits = normalizePhoneDigits(newPhoneInput.value);
          if (newPhoneDigits.length < 11) { showToast("укажите телефон руководителя", "error"); return; }
          try {
            const newRef = push(ref(db, "managers"));
            await set(newRef, { name: newName, phone: newPhoneDigits, createdAt: serverTimestamp() });
            finalManagerId = newRef.key;
            finalManagerName = newName;
            finalManagerPhone = newPhoneDigits;
          } catch (err) {
            showToast("не удалось сохранить руководителя", "error");
            return;
          }
        } else {
          if (!finalManagerId) { showToast("выберите руководителя или добавьте нового", "error"); return; }
          const m = state.managers[finalManagerId];
          if (!m || !m.phone) { showToast("у выбранного руководителя не указан телефон", "error"); return; }
          finalManagerName = m.name || "";
          finalManagerPhone = m.phone || "";
        }

        const payload = {
          title,
          managerId: finalManagerId,
          manager: finalManagerName,
          managerPhone: finalManagerPhone,
          description: overlay.querySelector("#v-desc").value.trim(),
          positions: Number(overlay.querySelector("#v-positions").value) || 1,
          status: statusValue,
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

/* ===================== KANBAN ===================== */
const kanbanBoard = document.getElementById("kanban-board");

function renderKanban() {
  kanbanBoard.innerHTML = "";
  const candidatesForVacancy = Object.entries(state.candidates).filter(([, c]) => c.vacancyId === state.activeVacancyId);

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
  const today = new Date().toISOString().slice(0, 10);
  return c.interviewDate === today;
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
  (c.tags || []).forEach((t) => tags.push(`<span class="tag ${t === "черный список" ? "tag-danger" : "tag-info"}">${escapeHtml(t)}</span>`));

  card.innerHTML = `
    <div class="kanban-card-name">${escapeHtml(c.name || "без имени")}</div>
    <div class="kanban-card-phone">${escapeHtml(formatPhone(c.phone || ""))}</div>
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
  const updates = { stage: targetStage, stageUpdatedAt: Date.now() };
  if (targetStage === "hired") updates.hiredAt = new Date().toISOString();

  await update(ref(db, `candidates/${candidateId}`), updates);
  await push(ref(db, `candidates/${candidateId}/history`), {
    action: `этап изменён на «${KANBAN_STAGES.find((s) => s.id === targetStage)?.label}»`,
    userName: state.currentUser.name || state.currentUser.email,
    at: serverTimestamp(),
  });
  showToast("этап обновлён");
}

/* ===================== КАНДИДАТ: ПОИСК ДУБЛЕЙ ===================== */
function findDuplicateCandidate(name, phoneDigits) {
  const normName = (name || "").trim().toLowerCase();
  return Object.entries(state.candidates).find(([, c]) => {
    const cName = (c.name || "").trim().toLowerCase();
    const cPhone = normalizePhoneDigits(c.phone);
    return (normName && cName === normName) || (phoneDigits && phoneDigits.length === 11 && cPhone === phoneDigits);
  });
}

/* ===================== КАНДИДАТ: ДОБАВЛЕНИЕ (из канбана и вручную) ===================== */
function openAddCandidateModal(presetVacancyId) {
  const needsVacancySelect = !presetVacancyId;

  openModal({
    title: "новый кандидат",
    bodyHtml: `
      <label class="field"><span class="field-label">имя</span><input class="field-input" id="c-name" /></label>
      <label class="field"><span class="field-label">телефон</span><input class="field-input" id="c-phone" placeholder="7 999 999-99-99" /></label>
      ${needsVacancySelect ? `<label class="field"><span class="field-label">вакансия</span><div id="c-vacancy-mount" class="csel-mount"></div></label>` : ""}
      <label class="field"><span class="field-label">источник</span><div id="c-source-mount" class="csel-mount"></div></label>
    `,
    footerHtml: `
      <button class="btn btn-secondary" id="c-cancel">отмена</button>
      <button class="btn btn-primary" id="c-save">сохранить</button>
    `,
    onMount: (overlay, close) => {
      attachPhoneMask(overlay.querySelector("#c-phone"));

      let sourceValue = "hh";
      mountSelect(overlay.querySelector("#c-source-mount"),
        [{ value: "hh", label: "hh" }, { value: "avito", label: "авито" }, { value: "other", label: "прочее" }],
        sourceValue, (val) => { sourceValue = val; });

      let vacancyValue = presetVacancyId || "";
      if (needsVacancySelect) {
        mountSelect(overlay.querySelector("#c-vacancy-mount"),
          Object.entries(state.vacancies).map(([id, v]) => ({ value: id, label: v.title })),
          vacancyValue, (val) => { vacancyValue = val; }, "выберите вакансию");
      }

      overlay.querySelector("#c-cancel").addEventListener("click", close);
      overlay.querySelector("#c-save").addEventListener("click", async () => {
        const name = overlay.querySelector("#c-name").value.trim();
        const phoneDigits = normalizePhoneDigits(overlay.querySelector("#c-phone").value);
        if (!name) { showToast("укажите имя кандидата", "error"); return; }
        if (!vacancyValue) { showToast("выберите вакансию", "error"); return; }

        const dup = findDuplicateCandidate(name, phoneDigits);
        if (dup) {
          close();
          showToast("такой кандидат уже есть в базе — открываю его карточку");
          switchSection("candidates");
          openCandidateModal(dup[0]);
          return;
        }

        await push(ref(db, "candidates"), {
          name,
          phone: phoneDigits,
          source: sourceValue,
          vacancyId: vacancyValue,
          stage: "response",
          hasForm: false,
          archived: false,
          tags: [],
          noShowCount: 0,
          recruiterId: state.currentUser.uid,
          recruiterName: state.currentUser.name || state.currentUser.email,
          createdAt: Date.now(),
          stageUpdatedAt: Date.now(),
        });
        showToast("кандидат добавлен");
        close();
      });
    },
  });
}

document.getElementById("add-candidate-btn").addEventListener("click", () => {
  if (!state.activeVacancyId) return;
  openAddCandidateModal(state.activeVacancyId);
});

/* ===================== КАНДИДАТ: ПОЛНАЯ КАРТОЧКА ===================== */
function openCandidateModal(candidateId) {
  const c = state.candidates[candidateId];
  if (!c) return;

  openModal({
    title: escapeHtml(c.name || "кандидат"),
    wide: true,
    bodyHtml: `
      <label class="field"><span class="field-label">телефон</span><input class="field-input" id="cc-phone" value="${escapeHtml(formatPhone(c.phone || ""))}" placeholder="7 999 999-99-99" /></label>
      <label class="field"><span class="field-label">источник</span><div id="cc-source-mount" class="csel-mount"></div></label>

      <div class="field">
        <span class="field-label">теги</span>
        <div class="tag-editor" id="cc-tags"></div>
        <div class="tag-add-row">
          <input class="field-input" id="cc-tag-input" placeholder="новый тег" />
          <button type="button" class="btn btn-secondary btn-sm" id="cc-tag-add">добавить тег</button>
        </div>
      </div>

      <div class="field-row">
        <label class="field"><span class="field-label">дата собеседования</span><input type="date" class="field-input" id="cc-interview-date" value="${escapeHtml(c.interviewDate || "")}" /></label>
        <label class="field"><span class="field-label">время</span><input type="time" class="field-input" id="cc-interview-time" value="${escapeHtml(c.interviewTime || "")}" /></label>
      </div>

      <div class="field">
        <span class="field-label">неявки на собеседование: ${c.noShowCount || 0}</span>
        <button type="button" class="btn btn-secondary btn-sm" id="cc-noshow" style="align-self:flex-start;">отметить неявку на собеседование</button>
      </div>

      <div class="field"><span class="field-label">документы</span>
        <div class="doc-slots">${DOC_TYPES.map((t) => renderDocSlot(candidateId, t, c.documents?.[t.key])).join("")}</div>
      </div>
      <label class="field"><span class="field-label">заметки</span><textarea id="cc-notes">${escapeHtml(c.notes || "")}</textarea></label>
    `,
    footerHtml: `
      <button class="btn btn-danger" id="cc-delete">удалить</button>
      <button class="btn btn-secondary" id="cc-archive">архивировать</button>
      <button class="btn btn-primary" id="cc-save">сохранить</button>
    `,
    onMount: (overlay, close) => {
      attachPhoneMask(overlay.querySelector("#cc-phone"));

      let sourceValue = c.source || "hh";
      mountSelect(overlay.querySelector("#cc-source-mount"),
        [{ value: "hh", label: "hh" }, { value: "avito", label: "авито" }, { value: "other", label: "прочее" }],
        sourceValue, (val) => { sourceValue = val; });

      function renderTagChips() {
        const current = state.candidates[candidateId]?.tags || [];
        const wrap = overlay.querySelector("#cc-tags");
        wrap.innerHTML = current.map((t) => `
          <span class="tag ${t === "черный список" ? "tag-danger" : "tag-info"}">
            ${escapeHtml(t)} <button type="button" class="tag-remove" data-tag="${escapeHtml(t)}">✕</button>
          </span>
        `).join("") || '<span class="progress-label">тегов нет</span>';
        wrap.querySelectorAll(".tag-remove").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const next = current.filter((t) => t !== btn.dataset.tag);
            await update(ref(db, `candidates/${candidateId}`), { tags: next });
            renderTagChips();
          });
        });
      }
      renderTagChips();

      overlay.querySelector("#cc-tag-add").addEventListener("click", async () => {
        const input = overlay.querySelector("#cc-tag-input");
        const value = input.value.trim();
        if (!value) return;
        const current = state.candidates[candidateId]?.tags || [];
        if (current.includes(value)) { input.value = ""; return; }
        await update(ref(db, `candidates/${candidateId}`), { tags: [...current, value] });
        input.value = "";
        renderTagChips();
      });

      overlay.querySelector("#cc-noshow").addEventListener("click", async () => {
        const current = state.candidates[candidateId];
        const nextCount = (current.noShowCount || 0) + 1;
        const tags = current.tags || [];
        const updates = { noShowCount: nextCount };
        if (nextCount >= 3 && !tags.includes("черный список")) {
          updates.tags = [...tags, "черный список"];
        }
        await update(ref(db, `candidates/${candidateId}`), updates);
        await push(ref(db, `candidates/${candidateId}/history`), {
          action: "отмечена неявка на собеседование",
          userName: state.currentUser.name || state.currentUser.email,
          at: serverTimestamp(),
        });
        showToast(nextCount >= 3 ? "кандидату присвоен тег «черный список»" : "неявка отмечена");
        close();
        openCandidateModal(candidateId);
      });

      bindDocSlots(overlay, candidateId);

      overlay.querySelector("#cc-save").addEventListener("click", async () => {
        await update(ref(db, `candidates/${candidateId}`), {
          phone: normalizePhoneDigits(overlay.querySelector("#cc-phone").value),
          source: sourceValue,
          notes: overlay.querySelector("#cc-notes").value,
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
    },
  });
}

/* ===================== ДОКУМЕНТЫ КАНДИДАТА (base64 в realtime database) ===================== */
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

/* ===================== СОБЕСЕДОВАНИЯ СЕГОДНЯ ===================== */
function renderTodayInterviews() {
  const container = document.getElementById("today-interviews-block");
  if (!container) return;
  const today = new Date().toISOString().slice(0, 10);
  const list = Object.entries(state.candidates).filter(([, c]) => c.interviewDate === today && !c.archived);

  if (!list.length) { container.innerHTML = ""; return; }

  container.innerHTML = `
    <div class="today-interviews">
      <div class="today-interviews-title">собеседования сегодня (${list.length})</div>
      <div class="today-interviews-list">
        ${list.sort((a, b) => (a[1].interviewTime || "").localeCompare(b[1].interviewTime || "")).map(([id, c]) => `
          <div class="today-interview-row" data-id="${id}">
            <span class="today-interview-time">${escapeHtml(c.interviewTime || "—")}</span>
            <span class="today-interview-name">${escapeHtml(c.name || "")}</span>
            <span class="today-interview-vacancy">${escapeHtml(state.vacancies[c.vacancyId]?.title || "")}</span>
            <span class="today-interview-phone">${escapeHtml(formatPhone(c.phone || ""))}</span>
          </div>
        `).join("")}
      </div>
    </div>
  `;

  container.querySelectorAll(".today-interview-row").forEach((row) => {
    row.addEventListener("click", () => openCandidateModal(row.dataset.id));
  });
}

/* ===================== БАЗА КАНДИДАТОВ ===================== */
const candidatesTableBody = document.getElementById("candidates-table-body");
const candidatesSearch = document.getElementById("candidates-search");

candidatesSearch.addEventListener("input", renderCandidatesTable);

let candVacancySelect = null;
let candStageSelect = null;
let candSourceSelect = null;

function initCandidateFilterControls() {
  candVacancySelect = mountSelect(document.getElementById("candidates-filter-vacancy-mount"),
    [{ value: "all", label: "все вакансии" }], state.filters.candVacancy,
    (val) => { state.filters.candVacancy = val; renderCandidatesTable(); });

  candStageSelect = mountSelect(document.getElementById("candidates-filter-stage-mount"),
    [{ value: "all", label: "все этапы" }, ...KANBAN_STAGES.map((s) => ({ value: s.id, label: s.label }))],
    state.filters.candStage,
    (val) => { state.filters.candStage = val; renderCandidatesTable(); });

  candSourceSelect = mountSelect(document.getElementById("candidates-filter-source-mount"),
    [{ value: "all", label: "все источники" }, { value: "hh", label: "hh" }, { value: "avito", label: "авито" }, { value: "other", label: "прочее" }],
    state.filters.candSource,
    (val) => { state.filters.candSource = val; renderCandidatesTable(); });
}

function renderCandidateFilters() {
  if (!candVacancySelect) return;
  const options = [{ value: "all", label: "все вакансии" }, ...Object.entries(state.vacancies).map(([id, v]) => ({ value: id, label: v.title }))];
  candVacancySelect.updateOptions(options, state.filters.candVacancy);
}

function renderCandidatesTable() {
  const term = candidatesSearch.value.trim().toLowerCase();
  const { candVacancy: vId, candStage: stg, candSource: src } = state.filters;

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
      return matchesTerm && matchesVacancy && matchesStage && matchesSource;
    })
    .forEach(([id, c]) => {
      const tr = document.createElement("tr");
      const stageLabel = KANBAN_STAGES.find((s) => s.id === c.stage)?.label || c.stage;
      const tagsHtml = (c.tags || []).map((t) =>
        `<span class="tag ${t === "черный список" ? "tag-danger" : "tag-info"}" style="margin-right:4px;">${escapeHtml(t)}</span>`
      ).join("");
      tr.innerHTML = `
        <td>${escapeHtml(c.name || "")}</td>
        <td>${escapeHtml(formatPhone(c.phone || ""))}</td>
        <td>${escapeHtml(state.vacancies[c.vacancyId]?.title || "—")}</td>
        <td>${escapeHtml(stageLabel || "")}</td>
        <td>${escapeHtml(c.source || "")}</td>
        <td>${c.createdAt ? formatDate(c.createdAt) : ""}</td>
        <td>${escapeHtml(c.recruiterName || "")}</td>
        <td>${tagsHtml}</td>
      `;
      tr.addEventListener("click", () => openCandidateModal(id));
      candidatesTableBody.appendChild(tr);
    });
}

document.getElementById("add-candidate-manual-btn").addEventListener("click", () => openAddCandidateModal(null));

/* ===================== ИМПОРТ / ЭКСПОРТ КАНДИДАТОВ ===================== */
function exportCandidates() {
  const payload = { exportedAt: new Date().toISOString(), candidates: state.candidates };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `demcrm-candidates-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  showToast("кандидаты экспортированы");
}

async function importCandidates(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const incoming = data.candidates || data;
    if (!incoming || typeof incoming !== "object") throw new Error("некорректный формат файла");
    await update(ref(db, "candidates"), incoming);
    showToast("кандидаты импортированы");
  } catch (err) {
    showToast("не удалось импортировать файл. проверьте формат и попробуйте снова", "error");
  }
}

document.getElementById("candidates-export-btn").addEventListener("click", exportCandidates);
document.getElementById("candidates-import-input").addEventListener("change", async () => {
  const input = document.getElementById("candidates-import-input");
  const file = input.files[0];
  if (!file) return;
  const ok = await confirmDialog("кандидаты из файла будут добавлены/обновлены в базе по их id. продолжить?");
  if (!ok) { input.value = ""; return; }
  await importCandidates(file);
  input.value = "";
});

/* ===================== ПОЛЬЗОВАТЕЛИ ===================== */
const usersTableBody = document.getElementById("users-table-body");

function renderUsersTable() {
  usersTableBody.innerHTML = "";
  Object.entries(state.users).forEach(([uid, u]) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(u.name || "")}</td>
      <td>${escapeHtml(u.email || "")}</td>
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
      <label class="field"><span class="field-label">пароль</span><input type="password" class="field-input" id="u-password" /></label>
      <label class="field"><span class="field-label">роль</span><div id="u-role-mount" class="csel-mount"></div></label>
    `,
    footerHtml: `
      <button class="btn btn-secondary" id="u-cancel">отмена</button>
      <button class="btn btn-primary" id="u-save">создать</button>
    `,
    onMount: (overlay, close) => {
      let roleValue = "recruiter";
      mountSelect(overlay.querySelector("#u-role-mount"),
        [{ value: "recruiter", label: "рекрутер" }, { value: "admin", label: "администратор" }],
        roleValue, (val) => { roleValue = val; });

      overlay.querySelector("#u-cancel").addEventListener("click", close);
      overlay.querySelector("#u-save").addEventListener("click", async () => {
        const name = overlay.querySelector("#u-name").value.trim();
        const email = overlay.querySelector("#u-email").value.trim();
        const password = overlay.querySelector("#u-password").value;

        if (!name || !email || password.length < 6) {
          showToast("заполните имя, email и пароль (мин. 6 символов)", "error");
          return;
        }

        const saveBtn = overlay.querySelector("#u-save");
        saveBtn.disabled = true;
        try {
          await createUserAsAdmin({ email, password, name, role: roleValue });
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
      <label class="field"><span class="field-label">роль</span><div id="eu-role-mount" class="csel-mount"></div></label>
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
      let roleValue = u.role;
      mountSelect(overlay.querySelector("#eu-role-mount"),
        [{ value: "recruiter", label: "рекрутер" }, { value: "admin", label: "администратор" }],
        roleValue, (val) => { roleValue = val; });

      overlay.querySelector("#eu-cancel").addEventListener("click", close);
      overlay.querySelector("#eu-save").addEventListener("click", async () => {
        await update(ref(db, `users/${uid}`), {
          name: overlay.querySelector("#eu-name").value.trim(),
          role: roleValue,
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

/* ===================== АНАЛИТИКА ===================== */
function periodRange(type, offset) {
  const now = new Date();
  let start, end, label;

  if (type === "day") {
    const d = new Date(now); d.setDate(d.getDate() + offset); d.setHours(0, 0, 0, 0);
    start = new Date(d); end = new Date(d); end.setDate(end.getDate() + 1);
    label = d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
  } else if (type === "week") {
    const d = new Date(now);
    const day = (d.getDay() + 6) % 7; // понедельник = 0
    d.setDate(d.getDate() - day + offset * 7); d.setHours(0, 0, 0, 0);
    start = new Date(d); end = new Date(d); end.setDate(end.getDate() + 7);
    const endLabelDate = new Date(end); endLabelDate.setDate(endLabelDate.getDate() - 1);
    label = `${start.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} – ${endLabelDate.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" })}`;
  } else if (type === "month") {
    start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1);
    label = start.toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
  } else {
    start = new Date(now.getFullYear() + offset, 0, 1);
    end = new Date(now.getFullYear() + offset + 1, 0, 1);
    label = String(start.getFullYear());
  }
  return { start: start.getTime(), end: end.getTime(), label };
}

function computeAnalyticsForPeriod(type, offset) {
  const { start, end, label } = periodRange(type, offset);
  const candidates = Object.values(state.candidates).filter((c) => {
    const created = c.createdAt || 0;
    return created >= start && created < end;
  });

  const bySource = {};
  const byStage = {};
  candidates.forEach((c) => {
    bySource[c.source || "прочее"] = (bySource[c.source || "прочее"] || 0) + 1;
    const stageLabel = KANBAN_STAGES.find((s) => s.id === c.stage)?.label || c.stage || "—";
    byStage[stageLabel] = (byStage[stageLabel] || 0) + 1;
  });

  const stageOrder = KANBAN_STAGES.map((s) => s.id);
  const funnel = stageOrder.map((stageId, idx) => {
    const reached = candidates.filter((c) => stageOrder.indexOf(c.stage) >= idx).length;
    return { id: stageId, label: KANBAN_STAGES[idx].label, count: reached };
  });

  const total = candidates.length;
  const hired = candidates.filter((c) => c.stage === "hired").length;
  const archived = candidates.filter((c) => c.archived).length;
  const conversion = total > 0 ? Math.round((hired / total) * 100) : 0;

  const today = new Date().toISOString().slice(0, 10);
  const interviewsToday = Object.values(state.candidates).filter((c) => c.interviewDate === today).length;

  return { label, total, hired, archived, conversion, bySource, byStage, funnel, interviewsToday };
}

function initAnalyticsControls() {
  mountSelect(document.getElementById("analytics-period-mount"), PERIOD_TYPES, state.analytics.period, (val) => {
    state.analytics.period = val;
    state.analytics.offset = 0;
    renderAnalytics();
  });
  document.getElementById("analytics-prev").addEventListener("click", () => {
    state.analytics.offset -= 1;
    renderAnalytics();
  });
  document.getElementById("analytics-next").addEventListener("click", () => {
    state.analytics.offset = Math.min(0, state.analytics.offset + 1);
    renderAnalytics();
  });
}

function renderAnalytics() {
  const content = document.getElementById("analytics-content");
  if (!content) return;
  const { period, offset } = state.analytics;
  const stats = computeAnalyticsForPeriod(period, offset);

  const periodLabelEl = document.getElementById("analytics-period-label");
  if (periodLabelEl) periodLabelEl.textContent = stats.label;

  content.innerHTML = `
    <div class="analytics-grid">
      <div class="analytics-card"><div class="analytics-num">${stats.total}</div><div class="analytics-label">кандидатов за период</div></div>
      <div class="analytics-card"><div class="analytics-num">${stats.hired}</div><div class="analytics-label">трудоустроено</div></div>
      <div class="analytics-card"><div class="analytics-num">${stats.conversion}%</div><div class="analytics-label">конверсия в найм</div></div>
      <div class="analytics-card"><div class="analytics-num">${stats.archived}</div><div class="analytics-label">архивных</div></div>
      <div class="analytics-card"><div class="analytics-num">${stats.interviewsToday}</div><div class="analytics-label">собеседований сегодня</div></div>
    </div>
    <div class="analytics-bars">
      <div class="analytics-bars-title">воронка по этапам (за период)</div>
      ${renderFunnelChart(stats.funnel)}
    </div>
    <div class="analytics-bars">
      <div class="analytics-bars-title">кандидаты по источникам</div>
      ${renderBarChart(stats.bySource)}
    </div>
    <div class="analytics-bars">
      <div class="analytics-bars-title">кандидаты по текущим этапам</div>
      ${renderBarChart(stats.byStage)}
    </div>
  `;
}

function renderFunnelChart(funnel) {
  const max = Math.max(1, ...funnel.map((f) => f.count));
  return funnel.map((f, idx) => {
    const prev = idx > 0 ? funnel[idx - 1].count : f.count;
    const stepConv = prev > 0 ? Math.round((f.count / prev) * 100) : 0;
    return `
      <div class="bar-row">
        <span class="bar-label">${escapeHtml(f.label)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(f.count / max) * 100}%"></div></div>
        <span class="bar-value">${f.count}${idx > 0 ? ` · ${stepConv}%` : ""}</span>
      </div>
    `;
  }).join("");
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

/* ===================== НАСТРОЙКИ ===================== */
document.getElementById("settings-btn").addEventListener("click", () => {
  const currentTheme = document.documentElement.dataset.theme || "light";
  const u = state.currentUser;

  openModal({
    title: "настройки",
    wide: true,
    bodyHtml: `
      <div class="settings-block">
        <h3 class="settings-block-title">профиль</h3>
        <label class="field"><span class="field-label">имя</span><input class="field-input" id="s-name" value="${escapeHtml(u.name || "")}" /></label>
        <label class="field"><span class="field-label">email</span><input class="field-input" value="${escapeHtml(u.email || "")}" disabled /></label>
        <label class="field"><span class="field-label">новый пароль (необязательно, мин. 6 символов)</span><input type="password" class="field-input" id="s-password" /></label>
        <button class="btn btn-secondary" id="s-save-profile">сохранить профиль</button>
      </div>

      <div class="settings-block">
        <h3 class="settings-block-title">внешний вид</h3>
        <label class="field"><span class="field-label">тема</span><div id="theme-select-mount" class="csel-mount"></div></label>
      </div>

      ${u.role === "admin" ? `
      <div class="settings-block">
        <h3 class="settings-block-title">резервное копирование</h3>
        <p style="margin:0 0 8px;color:var(--text-secondary);font-size:12px;">подробная аналитика вынесена в раздел «аналитика» в боковом меню.</p>
        <div class="section-actions">
          <button class="btn btn-secondary" id="s-export">экспортировать всю базу</button>
          <label class="btn btn-secondary" for="s-import-input" style="cursor:pointer;">импортировать всю базу</label>
          <input type="file" id="s-import-input" accept="application/json" hidden />
        </div>
      </div>
      ` : ""}
    `,
    onMount: (overlay) => {
      mountSelect(overlay.querySelector("#theme-select-mount"),
        [{ value: "light", label: "светлая" }, { value: "dark", label: "тёмная" }],
        currentTheme,
        (val) => {
          document.documentElement.dataset.theme = val;
          localStorage.setItem("demcrm-theme", val);
        });

      overlay.querySelector("#s-save-profile").addEventListener("click", async () => {
        const name = overlay.querySelector("#s-name").value.trim();
        const newPassword = overlay.querySelector("#s-password").value;
        try {
          if (name && name !== u.name) {
            await update(ref(db, `users/${u.uid}`), { name });
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

function exportDatabase() {
  const payload = {
    exportedAt: new Date().toISOString(),
    vacancies: state.vacancies,
    candidates: state.candidates,
    users: Object.fromEntries(Object.entries(state.users).map(([uid, u]) => [uid, { name: u.name, email: u.email, role: u.role }])),
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

// применяем сохранённую тему при загрузке
const savedTheme = localStorage.getItem("demcrm-theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

/* ===================== ГЛОБАЛЬНЫЙ ПОИСК CTRL+K ===================== */
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
          row.innerHTML = `<span class="tag tag-success">кандидат</span> ${escapeHtml(c.name)} · ${escapeHtml(formatPhone(c.phone || ""))}`;
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

/* ===================== ХЕЛПЕРЫ ===================== */
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

function formatDate(value) {
  const d = typeof value === "number" ? new Date(value) : new Date(value);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/* ===================== СТАРТ ===================== */
initVacancyFilterControls();
initCandidateFilterControls();
initAnalyticsControls();
ensureMainAdmin();
