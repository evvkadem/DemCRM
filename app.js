// ============================================================
// app.js — вся логика интерфейса DemCRM
// ============================================================

import {
  auth, db, loginUser, logoutUser, onAuthChange, getUserProfile,
  updateOwnPassword, updateOwnProfile, createUserSecondary,
  listenPath, getPath, pushPath, setPath, updatePath, removePath, pushKey
} from "./firebase.js";

// ---------------------------------------------------------
// КОНСТАНТЫ
// ---------------------------------------------------------

const STAGES = [
  { key: "response", label: "Отклик" },
  { key: "screening", label: "Скрининг" },
  { key: "invited", label: "Приглашён на собеседование" },
  { key: "form", label: "Анкета" },
  { key: "interview", label: "Собеседование" },
  { key: "selected", label: "Отобрано" },
  { key: "director", label: "Собеседование с директором" },
  { key: "employment", label: "Трудоустройство" },
];
const STALE_STAGES = ["response", "screening", "invited", "form", "interview"];
const STALE_DAYS = 7;
const SOURCES = ["HH.ru", "Авито", "Прочее"];
const VACANCY_STATUSES = [
  { key: "open", label: "Открыта" },
  { key: "paused", label: "Приостановлена" },
  { key: "closed", label: "Закрыта" },
];
const TAG_COLORS = ["#4f6dfa", "#2fb463", "#e8a53a", "#e5484d", "#a855f7", "#0ea5e9", "#f43f5e", "#64748b"];

let state = {
  user: null, profile: null,
  vacancies: {}, managers: {}, candidates: {}, tags: {}, users: {}, activityLogs: {},
  view: "vacancies", currentVacancyId: null,
  theme: localStorage.getItem("demcrm_theme") || "light",
  candidatesFilters: { search: "", vacancy: "", stage: "", source: "", tag: "" },
  candidatesSort: { field: "createdAt", dir: "desc" },
  analyticsPeriod: "month",
};

// ---------------------------------------------------------
// УТИЛИТЫ
// ---------------------------------------------------------

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}
function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function fmtDateTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleDateString("ru-RU") + " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysBetween(ts1, ts2) {
  return Math.floor((ts2 - ts1) / (1000 * 60 * 60 * 24));
}
function colorFromString(str) {
  let hash = 0;
  for (let i = 0; i < (str || "").length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 50%)`;
}
function initials(name) {
  if (!name) return "?";
  return name.split(" ").filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function maskPhone(value) {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("8")) digits = "7" + digits.slice(1);
  if (!digits.startsWith("7")) digits = "7" + digits;
  digits = digits.slice(0, 11);
  let out = "7";
  if (digits.length > 1) out += " " + digits.slice(1, 4);
  if (digits.length > 4) out += " " + digits.slice(4, 7);
  if (digits.length > 7) out += "-" + digits.slice(7, 9);
  if (digits.length > 9) out += "-" + digits.slice(9, 11);
  return out;
}
function isValidPhone(v) {
  return /^7 \d{3} \d{3}-\d{2}-\d{2}$/.test(v);
}
function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
function escapeHtml(s) {
  return (s || "").toString().replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// ---------------------------------------------------------
// TOASTS
// ---------------------------------------------------------
function toast(message, type = "info") {
  const root = $("#toastRoot");
  const node = el("div", { class: `toast toast-${type}` }, message);
  root.appendChild(node);
  setTimeout(() => { node.style.opacity = "0"; node.style.transition = "opacity 200ms"; setTimeout(() => node.remove(), 200); }, 3500);
}

// ---------------------------------------------------------
// ПОДТВЕРЖДЕНИЕ ДЕЙСТВИЯ (общий модал)
// ---------------------------------------------------------
function confirmModal({ title, message, confirmLabel = "Продолжить", danger = false }) {
  return new Promise((resolve) => {
    const overlay = el("div", { class: "modal-overlay" });
    const modal = el("div", { class: "modal" }, [
      el("div", { class: "modal-head" }, [el("h3", {}, title)]),
      el("div", { class: "modal-body" }, [el("div", {}, message)]),
      el("div", { class: "modal-footer" }, [
        el("button", { class: "btn btn-secondary", onclick: () => { close(false); } }, "Отмена"),
        el("button", { class: danger ? "btn btn-danger" : "btn btn-primary", onclick: () => { close(true); } }, confirmLabel),
      ]),
    ]);
    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
    function onKey(e) { if (e.key === "Escape") close(false); }
    document.addEventListener("keydown", onKey);
    function close(result) {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    }
    document.body.appendChild(overlay);
  });
}

function openModal(contentNode, { wide = false } = {}) {
  const overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: wide ? "modal modal-wide" : "modal" });
  modal.appendChild(contentNode);
  overlay.appendChild(modal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(overlay); });
  function onKey(e) { if (e.key === "Escape") closeModal(overlay); }
  document.addEventListener("keydown", onKey);
  overlay._onKey = onKey;
  document.body.appendChild(overlay);
  return overlay;
}
function closeModal(overlay) {
  if (!overlay) return;
  document.removeEventListener("keydown", overlay._onKey);
  overlay.remove();
}

// ---------------------------------------------------------
// КАСТОМНЫЙ DROPDOWN
// ---------------------------------------------------------
function buildDropdown({ options, value, placeholder = "Выбрать…", onChange, searchable = true, allowEmpty = true }) {
  const wrap = el("div", { class: "dd" });
  const trigger = el("div", { class: "dd-trigger", tabindex: "0" });
  wrap.appendChild(trigger);
  let currentValue = value;

  function labelFor(v) {
    const opt = options.find(o => o.value === v);
    return opt ? opt.label : "";
  }
  function renderTrigger() {
    trigger.innerHTML = "";
    const lbl = labelFor(currentValue);
    trigger.appendChild(el("span", { class: lbl ? "dd-value" : "dd-placeholder" }, lbl || placeholder));
    trigger.appendChild(el("span", { class: "text-secondary", html: "▾" }));
  }
  renderTrigger();

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    openPopover();
  });

  function openPopover() {
    closeAllPopovers();
    const rect = trigger.getBoundingClientRect();
    const pop = el("div", { class: "dd-popover" });
    pop.style.left = rect.left + "px";
    pop.style.top = (rect.bottom + 6) + "px";
    pop.style.width = Math.max(rect.width, 200) + "px";
    let searchInput;
    if (searchable) {
      searchInput = el("input", { class: "dd-search", placeholder: "Поиск…" });
      pop.appendChild(searchInput);
    }
    const list = el("div", { class: "dd-list" });
    pop.appendChild(list);

    function renderList(filter = "") {
      list.innerHTML = "";
      const filtered = options.filter(o => o.label.toLowerCase().includes(filter.toLowerCase()));
      if (allowEmpty) {
        const emptyOpt = el("div", { class: "dd-option" }, "— не выбрано —");
        emptyOpt.addEventListener("click", () => { select(""); });
        list.appendChild(emptyOpt);
      }
      if (filtered.length === 0) {
        list.appendChild(el("div", { class: "dd-option text-secondary" }, "Ничего не найдено"));
      }
      filtered.forEach(o => {
        const optNode = el("div", { class: "dd-option" + (o.value === currentValue ? " selected" : "") }, o.label);
        optNode.addEventListener("click", () => select(o.value));
        list.appendChild(optNode);
      });
    }
    function select(v) {
      currentValue = v;
      renderTrigger();
      onChange && onChange(v);
      document.body.removeChild(pop);
    }
    renderList();
    if (searchInput) {
      searchInput.addEventListener("input", () => renderList(searchInput.value));
      setTimeout(() => searchInput.focus(), 10);
    }
    document.body.appendChild(pop);
    setTimeout(() => {
      document.addEventListener("click", outsideClick);
    }, 0);
    function outsideClick(e) {
      if (!pop.contains(e.target)) {
        pop.remove();
        document.removeEventListener("click", outsideClick);
      }
    }
    pop._cleanup = () => { pop.remove(); document.removeEventListener("click", outsideClick); };
    activePopovers.push(pop);
  }
  wrap.setValue = (v) => { currentValue = v; renderTrigger(); };
  wrap.getValue = () => currentValue;
  return wrap;
}
let activePopovers = [];
function closeAllPopovers() {
  activePopovers.forEach(p => p._cleanup && p._cleanup());
  activePopovers = [];
}

// ---------------------------------------------------------
// АВТОРИЗАЦИЯ
// ---------------------------------------------------------

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#loginEmail").value.trim();
  const password = $("#loginPassword").value;
  const remember = $("#loginRemember").checked;
  const errBox = $("#loginError");
  errBox.textContent = "";
  try {
    await loginUser(email, password, remember);
  } catch (err) {
    errBox.textContent = "Неверный email или пароль.";
  }
});

$("#openSettings").addEventListener("click", openSettingsModal);

document.querySelectorAll(".nav-item[data-view]").forEach(btn => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

onAuthChange(async (user) => {
  if (user) {
    state.user = user;
    state.profile = await getUserProfile(user.uid);
    if (!state.profile) {
      // на случай отсутствия профиля — считаем рекрутером
      state.profile = { name: user.email, email: user.email, role: "recruiter" };
    }
    $("#loginScreen").classList.add("hidden");
    $("#app").classList.remove("hidden");
    document.documentElement.setAttribute("data-theme", state.theme);
    if (state.profile.role !== "admin") $("#navUsers").classList.add("hidden");
    initListeners();
    switchView("vacancies");
  } else {
    state.user = null;
    $("#loginScreen").classList.remove("hidden");
    $("#app").classList.add("hidden");
  }
});

// ---------------------------------------------------------
// REALTIME LISTENERS
// ---------------------------------------------------------
let listenersInitialized = false;
function initListeners() {
  if (listenersInitialized) return;
  listenersInitialized = true;
  listenPath("vacancies", (data) => { state.vacancies = data; renderCurrentView(); });
  listenPath("managers", (data) => { state.managers = data; renderCurrentView(); });
  listenPath("candidates", (data) => { state.candidates = data; runStaleCheck(); renderCurrentView(); });
  listenPath("tags", (data) => { state.tags = data; renderCurrentView(); });
  listenPath("users", (data) => { state.users = data; if (state.view === "users") renderCurrentView(); });
  setInterval(runStaleCheck, 60000);
}

// ---------------------------------------------------------
// РОУТИНГ / ОБЩИЙ РЕНДЕР
// ---------------------------------------------------------
function switchView(view, opts = {}) {
  state.view = view;
  if (opts.vacancyId !== undefined) state.currentVacancyId = opts.vacancyId;
  $all(".nav-item[data-view]").forEach(btn => btn.classList.toggle("active", btn.dataset.view === view));
  renderCurrentView();
}

function renderCurrentView() {
  if (!state.user) return;
  const topbar = $("#topbar");
  const workspace = $("#workspace");
  topbar.innerHTML = "";
  workspace.innerHTML = "";

  if (state.view === "vacancies") {
    if (state.currentVacancyId) renderKanbanView(topbar, workspace);
    else renderVacanciesView(topbar, workspace);
  } else if (state.view === "candidates") {
    renderCandidatesView(topbar, workspace);
  } else if (state.view === "analytics") {
    renderAnalyticsView(topbar, workspace);
  } else if (state.view === "users") {
    renderUsersView(topbar, workspace);
  }
}

// ---------------------------------------------------------
// ВАКАНСИИ
// ---------------------------------------------------------
function renderVacanciesView(topbar, workspace) {
  topbar.appendChild(el("div", { class: "topbar-title" }, "Вакансии"));
  const search = el("input", { placeholder: "Поиск по вакансиям…" });
  const searchWrap = el("div", { class: "topbar-search" }, [
    el("div", { html: searchIconSvg() }), search
  ]);
  topbar.appendChild(searchWrap);
  topbar.appendChild(el("div", { class: "topbar-spacer" }));
  topbar.appendChild(el("button", { class: "btn btn-primary", onclick: () => openVacancyModal(null) }, "+ Добавить вакансию"));

  // сегодняшние собеседования
  const todayList = Object.entries(state.candidates || {})
    .filter(([id, c]) => c.interviewDate === todayStr() && !c.archived);
  const todayBlock = el("div", { class: "card today-interviews" });
  todayBlock.appendChild(el("h4", { style: "margin:0 0 10px;font-size:13px;color:var(--text-secondary);" }, "Собеседования сегодня"));
  if (todayList.length === 0) {
    todayBlock.appendChild(el("div", { class: "text-secondary" }, "Собеседований сегодня нет."));
  } else {
    todayList.forEach(([id, c]) => {
      const vac = state.vacancies?.[c.vacancyId];
      todayBlock.appendChild(el("div", { class: "today-interview-item" }, [
        el("span", {}, c.fio),
        el("span", { class: "text-secondary" }, vac ? vac.title : "—"),
        el("span", {}, c.interviewTime || "—"),
      ]));
    });
  }
  workspace.appendChild(todayBlock);
  workspace.appendChild(el("div", { style: "height:16px" }));

  const list = Object.entries(state.vacancies || {});
  const filtered = list.filter(([id, v]) => (v.title || "").toLowerCase().includes(search.value.toLowerCase()));
  const grid = el("div", { class: "grid grid-vacancies" });

  function draw() {
    grid.innerHTML = "";
    const q = search.value.toLowerCase();
    const items = Object.entries(state.vacancies || {}).filter(([id, v]) => (v.title || "").toLowerCase().includes(q));
    if (items.length === 0) {
      grid.appendChild(emptyState("Нет активных вакансий."));
      return;
    }
    items.forEach(([id, v]) => grid.appendChild(vacancyCard(id, v)));
  }
  search.addEventListener("input", draw);
  draw();
  workspace.appendChild(grid);
}

function vacancyCard(id, v) {
  const cands = Object.entries(state.candidates || {}).filter(([cid, c]) => c.vacancyId === id && !c.archived);
  const employed = cands.filter(([cid, c]) => c.stage === "employment").length;
  const total = cands.length;
  const progress = v.openSlots ? Math.min(100, Math.round((employed / v.openSlots) * 100)) : 0;
  const manager = state.managers?.[v.managerId];
  const statusInfo = VACANCY_STATUSES.find(s => s.key === v.status) || VACANCY_STATUSES[0];
  const badgeClass = v.status === "closed" ? "badge-closed" : v.status === "paused" ? "badge-paused" : "badge-open";

  const card = el("div", { class: "card vacancy-card", onclick: () => switchView("vacancies", { vacancyId: id }) }, [
    el("div", { class: "vacancy-card-head" }, [
      el("div", {}, [
        el("div", { class: "vacancy-card-title" }, v.title || "Без названия"),
        el("div", { class: "vacancy-card-manager" }, manager ? `${manager.fio} · ${manager.phone || ""}` : "Руководитель не указан"),
      ]),
      el("span", { class: `badge ${badgeClass}` }, statusInfo.label),
    ]),
    el("div", { class: "progress-bar" }, [el("div", { class: "progress-bar-fill", style: `width:${progress}%` })]),
    el("div", { class: "vacancy-stats" }, [
      el("span", {}, [el("b", {}, String(v.openSlots || 0)), " мест"]),
      el("span", {}, [el("b", {}, String(total)), " кандидатов"]),
      el("span", {}, [el("b", {}, String(employed)), " трудоустроено"]),
    ]),
    el("div", { class: "text-secondary", style: "font-size:11px" }, `Открыта: ${fmtDate(v.createdAt)}`),
  ]);
  return card;
}

function emptyState(text) {
  return el("div", { class: "empty-state" }, [
    el("div", { html: "🗂️", style: "font-size:32px" }),
    el("div", {}, text),
  ]);
}
function searchIconSvg() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
}

function openVacancyModal(vacancyId) {
  const isEdit = !!vacancyId;
  const v = isEdit ? state.vacancies[vacancyId] : { title: "", managerId: "", description: "", openSlots: 1, status: "open", comment: "" };

  const titleInput = el("input", { value: v.title || "" });
  const descInput = el("textarea", { placeholder: "Описание вакансии" }, v.description || "");
  descInput.value = v.description || "";
  const slotsInput = el("input", { type: "number", min: "1", value: v.openSlots || 1 });
  const commentInput = el("textarea", {}, v.comment || "");
  commentInput.value = v.comment || "";

  const statusDD = buildDropdown({
    options: VACANCY_STATUSES.map(s => ({ value: s.key, label: s.label })),
    value: v.status || "open", allowEmpty: false, searchable: false,
    onChange: () => {}
  });

  const managerFieldWrap = el("div", { class: "field" }, [el("label", {}, "Руководитель отдела")]);
  let selectedManagerId = v.managerId || "";
  function managerOptions() {
    return Object.entries(state.managers || {}).map(([id, m]) => ({ value: id, label: `${m.fio} · ${m.phone || ""}` }));
  }
  const managerDD = buildDropdown({
    options: managerOptions(), value: selectedManagerId, placeholder: "Выбрать руководителя",
    onChange: (v2) => { selectedManagerId = v2; }
  });
  const addManagerBtn = el("button", { class: "btn btn-secondary", type: "button", onclick: () => openManagerModal((newId) => {
    managerDD.wrap = managerDD;
    const opts = managerOptions();
    // пересоздаём dropdown с обновлённым списком
    const newDD = buildDropdown({ options: opts, value: newId, placeholder: "Выбрать руководителя", onChange: (v3) => { selectedManagerId = v3; } });
    managerFieldWrap.replaceChild(newDD, managerFieldWrap.lastChild);
    selectedManagerId = newId;
  }) }, "+ Новый руководитель");
  managerFieldWrap.appendChild(managerDD);

  const body = el("div", { class: "modal-body" }, [
    el("div", { class: "field" }, [el("label", {}, "Название вакансии"), titleInput]),
    el("div", { class: "form-row" }, [
      managerFieldWrap,
      el("div", { class: "field" }, [el("label", {}, " "), addManagerBtn]),
    ]),
    el("div", { class: "field" }, [el("label", {}, "Описание"), descInput]),
    el("div", { class: "form-row" }, [
      el("div", { class: "field" }, [el("label", {}, "Открытых мест"), slotsInput]),
      el("div", { class: "field" }, [el("label", {}, "Статус"), statusDD]),
    ]),
    el("div", { class: "field" }, [el("label", {}, "Комментарий"), commentInput]),
  ]);

  const footer = el("div", { class: "modal-footer" });
  if (isEdit) {
    footer.appendChild(el("button", { class: "btn btn-danger", onclick: async () => {
      const ok = await confirmModal({ title: "Удалить вакансию?", message: "Это действие необратимо. Кандидаты останутся в базе.", confirmLabel: "Удалить", danger: true });
      if (ok) { await removePath(`vacancies/${vacancyId}`); toast("Вакансия удалена", "success"); closeModal(overlay); }
    } }, "Удалить"));
  }
  const spacer = el("div", { class: "topbar-spacer" });
  footer.appendChild(spacer);
  footer.appendChild(el("button", { class: "btn btn-secondary", onclick: () => closeModal(overlay) }, "Отмена"));
  footer.appendChild(el("button", { class: "btn btn-primary", onclick: async () => {
    if (!titleInput.value.trim()) { toast("Укажите название вакансии", "error"); return; }
    const payload = {
      title: titleInput.value.trim(),
      managerId: selectedManagerId || "",
      description: descInput.value,
      openSlots: Number(slotsInput.value) || 1,
      status: statusDD.getValue(),
      comment: commentInput.value,
      createdAt: v.createdAt || Date.now(),
    };
    if (isEdit) await updatePath(`vacancies/${vacancyId}`, payload);
    else await pushPath("vacancies", payload);
    toast("Вакансия сохранена", "success");
    closeModal(overlay);
  } }, "Сохранить"));

  const content = el("div", {}, [
    el("div", { class: "modal-head" }, [el("h3", {}, isEdit ? "Редактирование вакансии" : "Новая вакансия"), el("button", { class: "btn-icon", onclick: () => closeModal(overlay) }, "✕")]),
    body, footer,
  ]);
  const overlay = openModal(content);
}

function openManagerModal(onCreated) {
  const fioInput = el("input", { placeholder: "ФИО" });
  const phoneInput = el("input", { placeholder: "7 999 999-99-99" });
  phoneInput.addEventListener("input", () => { phoneInput.value = maskPhone(phoneInput.value); });
  phoneInput.value = "7 ";

  const content = el("div", {}, [
    el("div", { class: "modal-head" }, [el("h3", {}, "Новый руководитель"), el("button", { class: "btn-icon", onclick: () => closeModal(overlay) }, "✕")]),
    el("div", { class: "modal-body" }, [
      el("div", { class: "field" }, [el("label", {}, "ФИО"), fioInput]),
      el("div", { class: "field" }, [el("label", {}, "Телефон"), phoneInput]),
    ]),
    el("div", { class: "modal-footer" }, [
      el("button", { class: "btn btn-secondary", onclick: () => closeModal(overlay) }, "Отмена"),
      el("button", { class: "btn btn-primary", onclick: async () => {
        if (!fioInput.value.trim()) { toast("Укажите ФИО", "error"); return; }
        if (!isValidPhone(phoneInput.value)) { toast("Некорректный номер телефона", "error"); return; }
        const newId = await pushPath("managers", { fio: fioInput.value.trim(), phone: phoneInput.value });
        toast("Руководитель добавлен", "success");
        closeModal(overlay);
        onCreated && onCreated(newId);
      } }, "Сохранить"),
    ]),
  ]);
  const overlay = openModal(content);
}

// ---------------------------------------------------------
// KANBAN
// ---------------------------------------------------------
function renderKanbanView(topbar, workspace) {
  const vId = state.currentVacancyId;
  const v = state.vacancies?.[vId];
  if (!v) { state.currentVacancyId = null; renderVacanciesView(topbar, workspace); return; }

  topbar.appendChild(el("button", { class: "btn-icon", onclick: () => switchView("vacancies", { vacancyId: null }) }, "←"));
  topbar.appendChild(el("div", { class: "topbar-title" }, v.title));
  topbar.appendChild(el("div", { class: "topbar-spacer" }));
  topbar.appendChild(el("button", { class: "btn btn-secondary", onclick: () => openVacancyModal(vId) }, "Изменить вакансию"));
  topbar.appendChild(el("button", { class: "btn btn-primary", onclick: () => openCandidateModal(null, { vacancyId: vId, stage: "response" }) }, "+ Добавить кандидата"));

  const board = el("div", { class: "kanban-board" });
  STAGES.forEach(stage => {
    const candidates = Object.entries(state.candidates || {})
      .filter(([id, c]) => c.vacancyId === vId && !c.archived && c.onKanban !== false && c.stage === stage.key);

    const cardsWrap = el("div", { class: "kanban-cards" });
    cardsWrap.dataset.stage = stage.key;
    candidates.forEach(([id, c]) => cardsWrap.appendChild(candidateCard(id, c)));

    const column = el("div", { class: "kanban-column" }, [
      el("div", { class: "kanban-column-head" }, [el("span", {}, stage.label), el("span", { class: "count" }, String(candidates.length))]),
      cardsWrap,
    ]);

    column.addEventListener("dragover", (e) => { e.preventDefault(); column.classList.add("drag-over"); });
    column.addEventListener("dragleave", () => column.classList.remove("drag-over"));
    column.addEventListener("drop", async (e) => {
      e.preventDefault();
      column.classList.remove("drag-over");
      const candidateId = e.dataTransfer.getData("text/candidate-id");
      if (!candidateId) return;
      await handleStageTransition(candidateId, stage.key);
    });

    board.appendChild(column);
  });
  workspace.appendChild(el("div", { class: "kanban-header" }, [el("h2", {}, "Kanban")]));
  workspace.appendChild(board);
}

function candidateCard(id, c) {
  const recruiter = state.users?.[c.recruiterId];
  const isToday = c.interviewDate === todayStr();
  const card = el("div", { class: "candidate-card" + (isToday ? " highlight-today" : ""), draggable: "true", onclick: () => openCandidateModal(id) }, [
    el("div", { class: "candidate-card-top" }, [
      el("div", {}, [
        el("div", { class: "candidate-name" }, c.fio),
        el("div", { class: "candidate-phone" }, c.phone || ""),
      ]),
      el("div", { class: "avatar", style: `background:${colorFromString(c.recruiterId || c.fio)}` }, initials(recruiter ? recruiter.name : c.fio)),
    ]),
    el("div", { class: "indicator-row" }, candidateIndicators(c)),
    el("div", { class: "candidate-meta" }, [
      el("div", { class: "candidate-tags" }, Object.keys(c.tags || {}).map(tid => tagChip(tid)).filter(Boolean)),
      c.interviewDate ? el("span", { class: "text-secondary", style: "font-size:11px" }, fmtDate(c.interviewDate)) : null,
    ]),
  ]);
  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/candidate-id", id);
    setTimeout(() => card.classList.add("dragging"), 0);
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
  return card;
}
function candidateIndicators(c) {
  const items = [];
  if (!c.formLink) items.push(el("span", { class: "indicator", title: "Отсутствует анкета" }, "📋"));
  if (c.interviewDate === todayStr()) items.push(el("span", { class: "indicator", title: "Сегодня собеседование" }, "🕒"));
  if (c.archived) items.push(el("span", { class: "indicator", title: "Архив" }, "🗄"));
  if (c.stage === "employment") items.push(el("span", { class: "indicator", title: "Трудоустроен" }, "✅"));
  if (c.tags && Object.keys(c.tags).some(tid => state.tags?.[tid]?.name === "Чёрный список")) items.push(el("span", { class: "indicator", title: "Чёрный список" }, "⛔"));
  return items;
}
function tagChip(tagId) {
  const tag = state.tags?.[tagId];
  if (!tag) return null;
  return el("span", { class: "tag-chip", style: `background:${tag.color}` }, tag.name);
}

async function handleStageTransition(candidateId, newStage) {
  const c = state.candidates[candidateId];
  if (!c || c.stage === newStage) return;

  if (c.stage === "interview" && newStage === "selected" && !c.formLink) {
    const ok = await confirmModal({
      title: "Анкета кандидата не указана",
      message: "Продолжить перевод кандидата без анкеты?",
      confirmLabel: "Продолжить",
    });
    if (!ok) return;
  }

  const updates = { stage: newStage, stageChangedAt: Date.now() };
  if (newStage === "employment") updates.employmentDate = Date.now();

  await updatePath(`candidates/${candidateId}`, updates);
  await logHistory(candidateId, `Этап изменён на «${STAGES.find(s => s.key === newStage)?.label}»`);
  toast("Этап обновлён", "success");
}

async function logHistory(candidateId, action) {
  await pushPath(`activityLogs/${candidateId}`, { date: Date.now(), action });
}

// ---------------------------------------------------------
// ПРОВЕРКА "БОЛЕЕ 7 ДНЕЙ НА ЭТАПЕ" + ЧЁРНЫЙ СПИСОК
// ---------------------------------------------------------
let staleCheckRunning = false;
async function runStaleCheck() {
  if (staleCheckRunning) return;
  staleCheckRunning = true;
  try {
    const now = Date.now();
    for (const [id, c] of Object.entries(state.candidates || {})) {
      if (c.archived || c.onKanban === false) continue;
      if (!STALE_STAGES.includes(c.stage)) continue;
      const changedAt = c.stageChangedAt || c.createdAt || now;
      if (daysBetween(changedAt, now) > STALE_DAYS) {
        // найдём/создадим тег "Не вышел на связь"
        let tagId = Object.entries(state.tags || {}).find(([tid, t]) => t.name === "Не вышел на связь")?.[0];
        if (!tagId) tagId = await pushPath("tags", { name: "Не вышел на связь", color: "#64748b" });
        const newTags = { ...(c.tags || {}), [tagId]: true };
        await updatePath(`candidates/${id}`, { onKanban: false, tags: newTags });
        await logHistory(id, "Автоматически снят с Kanban (более 7 дней без изменений) и перенесён в базу кандидатов");
      }
    }
  } finally {
    staleCheckRunning = false;
  }
}

// ---------------------------------------------------------
// КАРТОЧКА КАНДИДАТА (МОДАЛ)
// ---------------------------------------------------------
function openCandidateModal(candidateId, presetData) {
  const isEdit = !!candidateId;
  const c = isEdit ? state.candidates[candidateId] : {
    fio: "", phone: "7 ", vacancyId: presetData?.vacancyId || "", source: SOURCES[0], stage: presetData?.stage || "response",
    createdAt: Date.now(), stageChangedAt: Date.now(), notes: "", tags: {}, recruiterId: state.user.uid,
    onKanban: true,
  };

  let activeTab = "info";
  const draft = { ...c, tags: { ...(c.tags || {}) } };

  const content = el("div", {});
  const head = el("div", { class: "modal-head" }, [
    el("h3", {}, isEdit ? draft.fio : "Новый кандидат"),
    el("button", { class: "btn-icon", onclick: () => closeModal(overlay) }, "✕"),
  ]);
  const tabsBar = el("div", { class: "tabs" });
  const bodyWrap = el("div", { class: "modal-body" });
  const footer = el("div", { class: "modal-footer" });
  content.append(head, tabsBar, bodyWrap, footer);

  const tabDefs = isEdit
    ? [["info", "Основное"], ["stage", "Этап"], ["interview", "Собеседование"], ["docs", "Документы"], ["notes", "Заметки"], ["tags", "Теги"], ["history", "История"]]
    : [["info", "Основное"]];

  tabDefs.forEach(([key, label]) => {
    const btn = el("button", { class: "tab-btn" + (key === activeTab ? " active" : ""), onclick: () => { activeTab = key; renderTabs(); renderBody(); } }, label);
    btn.dataset.tab = key;
    tabsBar.appendChild(btn);
  });
  function renderTabs() {
    $all(".tab-btn", tabsBar).forEach(b => b.classList.toggle("active", b.dataset.tab === activeTab));
  }

  function renderBody() {
    bodyWrap.innerHTML = "";
    if (activeTab === "info") bodyWrap.appendChild(tabInfo());
    if (activeTab === "stage") bodyWrap.appendChild(tabStage());
    if (activeTab === "interview") bodyWrap.appendChild(tabInterview());
    if (activeTab === "docs") bodyWrap.appendChild(tabDocs());
    if (activeTab === "notes") bodyWrap.appendChild(tabNotes());
    if (activeTab === "tags") bodyWrap.appendChild(tabTags());
    if (activeTab === "history") bodyWrap.appendChild(tabHistory());
  }

  function tabInfo() {
    const fioInput = el("input", { value: draft.fio || "" });
    fioInput.addEventListener("input", () => draft.fio = fioInput.value);
    const phoneInput = el("input", { value: draft.phone || "7 " });
    phoneInput.addEventListener("input", () => { phoneInput.value = maskPhone(phoneInput.value); draft.phone = phoneInput.value; });

    const vacancyDD = buildDropdown({
      options: Object.entries(state.vacancies || {}).map(([id, v]) => ({ value: id, label: v.title })),
      value: draft.vacancyId, placeholder: "Выбрать вакансию", allowEmpty: false,
      onChange: (v) => draft.vacancyId = v,
    });
    const sourceDD = buildDropdown({
      options: SOURCES.map(s => ({ value: s, label: s })), value: draft.source || SOURCES[0], allowEmpty: false, searchable: false,
      onChange: (v) => draft.source = v,
    });

    return el("div", { style: "display:flex;flex-direction:column;gap:14px" }, [
      el("div", { class: "field" }, [el("label", {}, "ФИО"), fioInput]),
      el("div", { class: "form-row" }, [
        el("div", { class: "field" }, [el("label", {}, "Телефон"), phoneInput]),
        el("div", { class: "field" }, [el("label", {}, "Источник"), sourceDD]),
      ]),
      el("div", { class: "field" }, [el("label", {}, "Вакансия"), vacancyDD]),
    ]);
  }

  function tabStage() {
    const stageDD = buildDropdown({
      options: STAGES.map(s => ({ value: s.key, label: s.label })), value: draft.stage, allowEmpty: false, searchable: false,
      onChange: (v) => draft.stage = v,
    });
    return el("div", { style: "display:flex;flex-direction:column;gap:14px" }, [
      el("div", { class: "field" }, [el("label", {}, "Текущий этап"), stageDD]),
      el("div", { class: "text-secondary", style: "font-size:12px" }, [
        el("div", {}, `Дата создания: ${fmtDate(draft.createdAt)}`),
        el("div", {}, `Дата трудоустройства: ${fmtDate(draft.employmentDate)}`),
        el("div", {}, `Дата увольнения: ${fmtDate(draft.dismissalDate)}`),
      ]),
    ]);
  }

  function tabInterview() {
    const dateInput = el("input", { type: "date", value: draft.interviewDate || "" });
    dateInput.addEventListener("input", () => draft.interviewDate = dateInput.value);
    const timeInput = el("input", { type: "time", value: draft.interviewTime || "" });
    timeInput.addEventListener("input", () => draft.interviewTime = timeInput.value);
    const commentInput = el("textarea", {}, draft.interviewComment || "");
    commentInput.value = draft.interviewComment || "";
    commentInput.addEventListener("input", () => draft.interviewComment = commentInput.value);
    const noShowBtn = el("button", { class: "btn btn-secondary", type: "button", onclick: () => {
      draft.noShowCount = (draft.noShowCount || 0) + 1;
      toast(`Отметка «Не пришёл» (${draft.noShowCount}/3)`, "warning");
    } }, "Отметить «Не пришёл на собеседование»");
    return el("div", { style: "display:flex;flex-direction:column;gap:14px" }, [
      el("div", { class: "form-row" }, [
        el("div", { class: "field" }, [el("label", {}, "Дата"), dateInput]),
        el("div", { class: "field" }, [el("label", {}, "Время"), timeInput]),
      ]),
      el("div", { class: "field" }, [el("label", {}, "Комментарий"), commentInput]),
      noShowBtn,
    ]);
  }

  function tabDocs() {
    const formInput = el("input", { placeholder: "Ссылка на анкету", value: draft.formLink || "" });
    formInput.addEventListener("input", () => draft.formLink = formInput.value);
    const resumeInput = el("input", { placeholder: "Ссылка на резюме", value: draft.resumeLink || "" });
    resumeInput.addEventListener("input", () => draft.resumeLink = resumeInput.value);
    return el("div", { style: "display:flex;flex-direction:column;gap:14px" }, [
      el("div", { class: "field" }, [el("label", {}, "Анкета"), formInput]),
      el("div", { class: "field" }, [el("label", {}, "Резюме"), resumeInput]),
    ]);
  }

  function tabNotes() {
    const notesInput = el("textarea", { style: "min-height:200px" }, draft.notes || "");
    notesInput.value = draft.notes || "";
    notesInput.addEventListener("input", () => draft.notes = notesInput.value);
    return el("div", { class: "field" }, [el("label", {}, "Заметки"), notesInput]);
  }

  function tabTags() {
    const wrap = el("div", { style: "display:flex;flex-direction:column;gap:14px" });
    const chipsWrap = el("div", { class: "candidate-tags" });
    function drawChips() {
      chipsWrap.innerHTML = "";
      Object.keys(draft.tags || {}).forEach(tid => {
        const tag = state.tags?.[tid];
        if (!tag) return;
        chipsWrap.appendChild(el("span", { class: "tag-chip", style: `background:${tag.color}` }, [
          tag.name, " ",
          el("span", { style: "cursor:pointer", onclick: () => { delete draft.tags[tid]; drawChips(); } }, "✕"),
        ]));
      });
      chipsWrap.appendChild(el("button", { class: "tag-add-btn", type: "button", onclick: () => openTagPicker() }, "+ Добавить тег"));
    }
    function openTagPicker() {
      const pop = el("div", { class: "dd-popover", style: "position:static;margin-top:8px;width:100%" });
      Object.entries(state.tags || {}).forEach(([tid, tag]) => {
        pop.appendChild(el("div", { class: "dd-option", onclick: () => { draft.tags[tid] = true; drawChips(); pop.remove(); } }, [
          el("span", { style: `width:8px;height:8px;border-radius:50%;background:${tag.color};display:inline-block` }), " " + tag.name,
        ]));
      });
      pop.appendChild(el("div", { class: "dd-option", style: "color:var(--accent)", onclick: () => { pop.remove(); openTagManageModal(); } }, "Управление тегами…"));
      wrap.appendChild(pop);
    }
    drawChips();
    wrap.appendChild(el("div", { class: "field" }, [el("label", {}, "Теги кандидата"), chipsWrap]));
    return wrap;
  }

  function tabHistory() {
    const wrap = el("div", {});
    const logs = state.activityLogs?.[candidateId];
    if (!logs || Object.keys(logs).length === 0) {
      wrap.appendChild(el("div", { class: "text-secondary" }, "Изменений пока нет."));
      return wrap;
    }
    Object.values(logs).sort((a, b) => b.date - a.date).forEach(log => {
      wrap.appendChild(el("div", { class: "history-item" }, [
        el("span", { class: "history-date" }, fmtDateTime(log.date)),
        el("span", {}, log.action),
      ]));
    });
    return wrap;
  }

  renderBody();

  if (isEdit) {
    footer.appendChild(el("button", { class: "btn btn-danger", onclick: async () => {
      const ok = await confirmModal({ title: "Удалить кандидата?", message: "Действие необратимо.", confirmLabel: "Удалить", danger: true });
      if (ok) { await removePath(`candidates/${candidateId}`); toast("Кандидат удалён", "success"); closeModal(overlay); }
    } }, "Удалить"));
    footer.appendChild(el("button", { class: "btn btn-secondary", onclick: async () => {
      await updatePath(`candidates/${candidateId}`, { archived: !draft.archived, archivedAt: !draft.archived ? Date.now() : null });
      await logHistory(candidateId, draft.archived ? "Восстановлен из архива" : "Архивирован");
      toast(draft.archived ? "Кандидат восстановлен" : "Кандидат архивирован", "success");
      closeModal(overlay);
    } }, draft.archived ? "Восстановить" : "Архивировать"));
  }
  footer.appendChild(el("div", { class: "topbar-spacer" }));
  footer.appendChild(el("button", { class: "btn btn-secondary", onclick: () => closeModal(overlay) }, "Отмена"));
  footer.appendChild(el("button", { class: "btn btn-primary", onclick: async () => {
    if (!draft.fio || !draft.fio.trim()) { toast("Укажите ФИО кандидата", "error"); return; }
    if (!isValidPhone(draft.phone)) { toast("Некорректный номер телефона", "error"); return; }
    if (!draft.vacancyId) { toast("Выберите вакансию", "error"); return; }

    if (!isEdit) {
      const dup = Object.entries(state.candidates || {}).find(([id, cc]) => cc.fio === draft.fio.trim() && cc.phone === draft.phone);
      if (dup) { toast("Кандидат уже существует, открываю карточку", "warning"); closeModal(overlay); openCandidateModal(dup[0]); return; }
      const payload = { ...draft, fio: draft.fio.trim(), createdAt: Date.now(), stageChangedAt: Date.now() };
      const newId = await pushPath("candidates", payload);
      await logHistory(newId, "Кандидат создан");
      toast("Кандидат добавлен", "success");
      closeModal(overlay);
      return;
    }

    const stageChanged = draft.stage !== c.stage;
    const payload = { ...draft, fio: draft.fio.trim() };
    if (stageChanged) payload.stageChangedAt = Date.now();
    if (draft.noShowCount && draft.noShowCount >= 3 && draft.noShowCount !== (c.noShowCount || 0)) {
      let tagId = Object.entries(state.tags || {}).find(([tid, t]) => t.name === "Чёрный список")?.[0];
      if (!tagId) tagId = await pushPath("tags", { name: "Чёрный список", color: "#e5484d" });
      payload.tags = { ...(payload.tags || {}), [tagId]: true };
    }
    await updatePath(`candidates/${candidateId}`, payload);
    if (stageChanged) await logHistory(candidateId, `Этап изменён на «${STAGES.find(s => s.key === draft.stage)?.label}»`);
    else await logHistory(candidateId, "Данные карточки изменены");
    toast("Сохранено", "success");
    closeModal(overlay);
  } }, "Сохранить"));

  const overlay = openModal(content, { wide: true });
}

function openTagManageModal() {
  const content = el("div", {});
  const list = el("div", { style: "display:flex;flex-direction:column;gap:8px" });
  function draw() {
    list.innerHTML = "";
    Object.entries(state.tags || {}).forEach(([id, tag]) => {
      const nameInput = el("input", { value: tag.name, style: "flex:1" });
      const colorDots = el("div", { style: "display:flex;gap:4px" }, TAG_COLORS.map(c => {
        const dot = el("span", { style: `width:18px;height:18px;border-radius:50%;background:${c};cursor:pointer;border:2px solid ${c === tag.color ? "var(--text-main)" : "transparent"}` });
        dot.addEventListener("click", async () => { await updatePath(`tags/${id}`, { color: c }); draw(); });
        return dot;
      }));
      const row = el("div", { style: "display:flex;align-items:center;gap:8px" }, [
        nameInput, colorDots,
        el("button", { class: "btn-icon", onclick: async () => { await updatePath(`tags/${id}`, { name: nameInput.value }); toast("Тег обновлён", "success"); } }, "💾"),
        el("button", { class: "btn-icon", onclick: async () => {
          const ok = await confirmModal({ title: "Удалить тег?", message: `Тег «${tag.name}» будет удалён у всех кандидатов.`, danger: true, confirmLabel: "Удалить" });
          if (ok) { await removePath(`tags/${id}`); draw(); }
        } }, "🗑"),
      ]);
      list.appendChild(row);
    });
  }
  draw();
  const newTagName = el("input", { placeholder: "Название нового тега" });
  content.append(
    el("div", { class: "modal-head" }, [el("h3", {}, "Управление тегами"), el("button", { class: "btn-icon", onclick: () => closeModal(overlay) }, "✕")]),
    el("div", { class: "modal-body" }, [list, el("div", { class: "field" }, [el("label", {}, "Новый тег"), newTagName])]),
    el("div", { class: "modal-footer" }, [
      el("button", { class: "btn btn-secondary", onclick: () => closeModal(overlay) }, "Закрыть"),
      el("button", { class: "btn btn-primary", onclick: async () => {
        if (!newTagName.value.trim()) return;
        await pushPath("tags", { name: newTagName.value.trim(), color: TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)] });
        newTagName.value = ""; draw();
      } }, "+ Добавить"),
    ])
  );
  const overlay = openModal(content);
}

// ---------------------------------------------------------
// БАЗА КАНДИДАТОВ
// ---------------------------------------------------------
function renderCandidatesView(topbar, workspace) {
  topbar.appendChild(el("div", { class: "topbar-title" }, "База кандидатов"));
  topbar.appendChild(el("div", { class: "topbar-spacer" }));
  topbar.appendChild(el("button", { class: "btn btn-secondary", onclick: () => importCandidatesFlow() }, "Импорт"));
  topbar.appendChild(el("button", { class: "btn btn-secondary", onclick: () => exportCandidatesCsv() }, "Экспорт"));
  topbar.appendChild(el("button", { class: "btn btn-primary", onclick: () => openCandidateModal(null) }, "+ Добавить кандидата"));

  const f = state.candidatesFilters;
  const searchInput = el("input", { placeholder: "Поиск по ФИО, телефону, вакансии…", value: f.search });
  searchInput.addEventListener("input", debounce(() => { f.search = searchInput.value; drawTable(); }, 200));

  const vacancyDD = buildDropdown({
    options: Object.entries(state.vacancies || {}).map(([id, v]) => ({ value: id, label: v.title })),
    value: f.vacancy, placeholder: "Вакансия", onChange: (v) => { f.vacancy = v; drawTable(); },
  });
  const stageDD = buildDropdown({
    options: STAGES.map(s => ({ value: s.key, label: s.label })), value: f.stage, placeholder: "Этап", searchable: false,
    onChange: (v) => { f.stage = v; drawTable(); },
  });
  const sourceDD = buildDropdown({
    options: SOURCES.map(s => ({ value: s, label: s })), value: f.source, placeholder: "Источник", searchable: false,
    onChange: (v) => { f.source = v; drawTable(); },
  });
  const tagDD = buildDropdown({
    options: Object.entries(state.tags || {}).map(([id, t]) => ({ value: id, label: t.name })),
    value: f.tag, placeholder: "Тег", onChange: (v) => { f.tag = v; drawTable(); },
  });

  const filtersRow = el("div", { class: "filters-row" }, [searchInput, vacancyDD, stageDD, sourceDD, tagDD]);
  workspace.appendChild(filtersRow);

  const tableWrap = el("div", { class: "table-wrap" });
  workspace.appendChild(tableWrap);

  function candStatusLabel(c) {
    if (c.archived) return "Архив";
    if (c.stage === "employment") return "Трудоустроен";
    return "Активен";
  }

  function getFiltered() {
    return Object.entries(state.candidates || {}).filter(([id, c]) => {
      if (f.vacancy && c.vacancyId !== f.vacancy) return false;
      if (f.stage && c.stage !== f.stage) return false;
      if (f.source && c.source !== f.source) return false;
      if (f.tag && !(c.tags && c.tags[f.tag])) return false;
      if (f.search) {
        const q = f.search.toLowerCase();
        const vac = state.vacancies?.[c.vacancyId];
        const hay = `${c.fio} ${c.phone} ${vac ? vac.title : ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function drawTable() {
    tableWrap.innerHTML = "";
    let items = getFiltered();
    const { field, dir } = state.candidatesSort;
    items.sort((a, b) => {
      let av = a[1][field], bv = b[1][field];
      if (field === "vacancy") { av = state.vacancies?.[a[1].vacancyId]?.title || ""; bv = state.vacancies?.[b[1].vacancyId]?.title || ""; }
      if (typeof av === "string") av = av.toLowerCase();
      if (typeof bv === "string") bv = bv.toLowerCase();
      if (av === undefined) av = "";
      if (bv === undefined) bv = "";
      if (av < bv) return dir === "asc" ? -1 : 1;
      if (av > bv) return dir === "asc" ? 1 : -1;
      return 0;
    });

    if (items.length === 0) { tableWrap.appendChild(emptyState("Кандидаты не найдены.")); return; }

    const columns = [
      { key: "fio", label: "ФИО" }, { key: "phone", label: "Телефон" }, { key: "vacancy", label: "Вакансия" },
      { key: "stage", label: "Этап" }, { key: "source", label: "Источник" }, { key: "createdAt", label: "Дата создания" },
      { key: "tagsCol", label: "Теги" }, { key: "statusCol", label: "Статус" },
    ];
    const table = el("table", { class: "data-table" });
    const thead = el("thead", {}, [el("tr", {}, columns.map(col => {
      const th = el("th", { onclick: () => {
        if (["tagsCol", "statusCol"].includes(col.key)) return;
        const sortField = col.key === "vacancy" ? "vacancy" : col.key;
        if (state.candidatesSort.field === sortField) state.candidatesSort.dir = state.candidatesSort.dir === "asc" ? "desc" : "asc";
        else state.candidatesSort = { field: sortField, dir: "asc" };
        drawTable();
      } }, col.label + (state.candidatesSort.field === col.key ? (state.candidatesSort.dir === "asc" ? " ↑" : " ↓") : ""));
      return th;
    }))]);
    const tbody = el("tbody");
    items.forEach(([id, c]) => {
      const vac = state.vacancies?.[c.vacancyId];
      const stageLabel = STAGES.find(s => s.key === c.stage)?.label || c.stage;
      const tr = el("tr", { onclick: () => openCandidateModal(id) }, [
        el("td", {}, c.fio),
        el("td", {}, c.phone),
        el("td", {}, vac ? vac.title : "—"),
        el("td", {}, stageLabel),
        el("td", {}, c.source || "—"),
        el("td", {}, fmtDate(c.createdAt)),
        el("td", {}, Object.keys(c.tags || {}).map(tid => state.tags?.[tid]?.name).filter(Boolean).join(", ") || "—"),
        el("td", {}, candStatusLabel(c)),
      ]);
      tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    tableWrap.appendChild(table);
  }
  drawTable();
}

function exportCandidatesCsv() {
  const rows = [["ФИО", "Телефон", "Вакансия", "Этап", "Источник", "Дата создания", "Теги", "Статус"]];
  Object.values(state.candidates || {}).forEach(c => {
    const vac = state.vacancies?.[c.vacancyId];
    const stageLabel = STAGES.find(s => s.key === c.stage)?.label || c.stage;
    rows.push([
      c.fio, c.phone, vac ? vac.title : "", stageLabel, c.source || "",
      fmtDate(c.createdAt), Object.keys(c.tags || {}).map(tid => state.tags?.[tid]?.name).filter(Boolean).join("; "),
      c.archived ? "Архив" : (c.stage === "employment" ? "Трудоустроен" : "Активен"),
    ]);
  });
  const csv = rows.map(r => r.map(v => `"${(v || "").toString().replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `candidates_${todayStr()}.csv` });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast("Экспорт завершён", "success");
}

function importCandidatesFlow() {
  const fileInput = el("input", { type: "file", accept: ".csv,.xlsx" });
  const pasteArea = el("textarea", { placeholder: "Вставьте данные из Excel сюда (Ctrl+V)…", style: "min-height:120px" });

  const content = el("div", {});
  content.append(
    el("div", { class: "modal-head" }, [el("h3", {}, "Импорт кандидатов"), el("button", { class: "btn-icon", onclick: () => closeModal(overlay) }, "✕")]),
    el("div", { class: "modal-body" }, [
      el("div", { class: "field" }, [el("label", {}, "Файл CSV"), fileInput]),
      el("div", { class: "text-secondary", style: "font-size:12px" }, "Ожидаемый порядок столбцов: ФИО, Телефон, Вакансия, Источник. Формат .xlsx как бинарный excel без сторонних библиотек не поддерживается — сохраните файл как CSV, либо вставьте данные из буфера ниже."),
      el("div", { class: "field" }, [el("label", {}, "Или вставьте из буфера обмена"), pasteArea]),
    ]),
    el("div", { class: "modal-footer" }, [
      el("button", { class: "btn btn-secondary", onclick: () => closeModal(overlay) }, "Отмена"),
      el("button", { class: "btn btn-primary", onclick: async () => {
        let rows = [];
        if (fileInput.files[0]) {
          const text = await fileInput.files[0].text();
          rows = text.split(/\r?\n/).filter(Boolean).map(line => line.split(",").map(v => v.replace(/^"|"$/g, "").trim()));
        } else if (pasteArea.value.trim()) {
          rows = pasteArea.value.trim().split(/\r?\n/).map(line => line.split("\t").map(v => v.trim()));
        }
        if (rows.length === 0) { toast("Нет данных для импорта", "error"); return; }
        await runImport(rows);
        closeModal(overlay);
      } }, "Импортировать"),
    ])
  );
  const overlay = openModal(content);
}

async function runImport(rows) {
  let added = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    const [fio, phoneRaw, vacancyTitle, source] = row;
    if (!fio || !phoneRaw) { skipped++; continue; }
    const phone = maskPhone(phoneRaw);
    const existing = Object.entries(state.candidates || {}).find(([id, c]) => c.fio === fio && c.phone === phone);
    const vacancyEntry = Object.entries(state.vacancies || {}).find(([id, v]) => v.title === vacancyTitle);
    if (existing) {
      await updatePath(`candidates/${existing[0]}`, { source: source || existing[1].source });
      updated++;
      continue;
    }
    await pushPath("candidates", {
      fio, phone, vacancyId: vacancyEntry ? vacancyEntry[0] : "", source: source || "Прочее",
      stage: "response", createdAt: Date.now(), stageChangedAt: Date.now(), tags: {}, recruiterId: state.user.uid, onKanban: true,
    });
    added++;
  }
  toast(`Импорт завершён: добавлено ${added}, обновлено ${updated}, пропущено ${skipped}`, "success");
}

// ---------------------------------------------------------
// АНАЛИТИКА
// ---------------------------------------------------------
function renderAnalyticsView(topbar, workspace) {
  topbar.appendChild(el("div", { class: "topbar-title" }, "Аналитика"));
  topbar.appendChild(el("div", { class: "topbar-spacer" }));
  const periodDD = buildDropdown({
    options: [{ value: "day", label: "День" }, { value: "week", label: "Неделя" }, { value: "month", label: "Месяц" }, { value: "year", label: "Год" }],
    value: state.analyticsPeriod, allowEmpty: false, searchable: false,
    onChange: (v) => { state.analyticsPeriod = v; renderCurrentView(); },
  });
  topbar.appendChild(periodDD);

  const periodMs = { day: 864e5, week: 7 * 864e5, month: 30 * 864e5, year: 365 * 864e5 }[state.analyticsPeriod];
  const since = Date.now() - periodMs;
  const allCands = Object.values(state.candidates || {});
  const periodCands = allCands.filter(c => (c.createdAt || 0) >= since);

  const metrics = [
    { label: "Всего кандидатов", value: allCands.length },
    { label: "Активных вакансий", value: Object.values(state.vacancies || {}).filter(v => v.status === "open").length },
    { label: "Трудоустроено", value: allCands.filter(c => c.stage === "employment").length },
    { label: "Архивных кандидатов", value: allCands.filter(c => c.archived).length },
    { label: "Собеседований сегодня", value: allCands.filter(c => c.interviewDate === todayStr()).length },
  ];
  const grid = el("div", { class: "grid grid-metrics" }, metrics.map(m => el("div", { class: "card metric-card" }, [
    el("div", { class: "metric-value" }, String(m.value)), el("div", { class: "metric-label" }, m.label),
  ])));
  workspace.appendChild(grid);

  const secondaryMetrics = [
    { label: "Откликов", value: periodCands.length },
    { label: "Приглашений", value: periodCands.filter(c => ["invited", "form", "interview", "selected", "director", "employment"].includes(c.stage)).length },
    { label: "Собеседований проведено", value: periodCands.filter(c => ["selected", "director", "employment"].includes(c.stage)).length },
    { label: "Отказов", value: allCands.filter(c => Object.keys(c.tags || {}).some(tid => state.tags?.[tid]?.name === "Не вышел на связь")).length },
    { label: "В работе", value: allCands.filter(c => !c.archived && c.stage !== "employment").length },
  ];
  const grid2 = el("div", { class: "grid grid-metrics", style: "margin-top:14px" }, secondaryMetrics.map(m => el("div", { class: "card metric-card" }, [
    el("div", { class: "metric-value" }, String(m.value)), el("div", { class: "metric-label" }, m.label),
  ])));
  workspace.appendChild(grid2);

  // конверсия по этапам
  const funnelCard = el("div", { class: "card", style: "margin-top:18px" }, [el("h4", { style: "margin:0 0 8px" }, "Конверсия между этапами")]);
  const total = allCands.length || 1;
  STAGES.forEach((stage, i) => {
    const count = allCands.filter(c => STAGES.findIndex(s => s.key === c.stage) >= i).length;
    const pct = Math.round((count / total) * 100);
    funnelCard.appendChild(el("div", { class: "funnel-row" }, [
      el("span", { class: "funnel-label" }, stage.label),
      el("span", { class: "funnel-bar-bg" }, [el("span", { class: "funnel-bar-fill", style: `width:${pct}%` })]),
      el("span", { class: "funnel-pct" }, `${count} · ${pct}%`),
    ]));
  });
  workspace.appendChild(funnelCard);

  // графики
  const chartsRow = el("div", { class: "charts-row" });
  chartsRow.appendChild(barChartCard("По источникам", groupCount(allCands, "source")));
  chartsRow.appendChild(barChartCard("По этапам", groupCount(allCands, c => STAGES.find(s => s.key === c.stage)?.label || c.stage)));
  workspace.appendChild(chartsRow);

  const chartsRow2 = el("div", { class: "charts-row" });
  chartsRow2.appendChild(lineChartCard("Трудоустройства по месяцам", monthlySeries(allCands.filter(c => c.employmentDate), "employmentDate")));
  chartsRow2.appendChild(lineChartCard("Динамика количества кандидатов", monthlySeries(allCands, "createdAt")));
  workspace.appendChild(chartsRow2);
}

function groupCount(items, keyFn) {
  const map = {};
  items.forEach(i => { const k = typeof keyFn === "function" ? keyFn(i) : (i[keyFn] || "—"); map[k] = (map[k] || 0) + 1; });
  return map;
}
function monthlySeries(items, dateField) {
  const map = {};
  items.forEach(i => {
    const d = new Date(i[dateField]);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    map[key] = (map[key] || 0) + 1;
  });
  return Object.entries(map).sort(([a], [b]) => a.localeCompare(b)).slice(-6);
}
function barChartCard(title, dataMap) {
  const entries = Object.entries(dataMap);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const w = 260, h = 140, barW = entries.length ? Math.min(40, (w - 20) / entries.length - 8) : 20;
  let svg = `<svg width="${w}" height="${h + 24}" viewBox="0 0 ${w} ${h + 24}">`;
  entries.forEach(([k, v], i) => {
    const barH = (v / max) * h;
    const x = i * (w / entries.length) + 8;
    svg += `<rect x="${x}" y="${h - barH}" width="${barW}" height="${barH}" rx="4" fill="var(--accent)" style="fill:#4f6dfa" />`;
    svg += `<text x="${x + barW / 2}" y="${h + 14}" font-size="9" text-anchor="middle" fill="#85888e">${escapeHtml(String(k).slice(0, 8))}</text>`;
    svg += `<text x="${x + barW / 2}" y="${h - barH - 4}" font-size="9" text-anchor="middle" fill="#85888e">${v}</text>`;
  });
  svg += `</svg>`;
  if (entries.length === 0) return el("div", { class: "card chart-card" }, [el("h4", {}, title), el("div", { class: "text-secondary" }, "Нет данных")]);
  return el("div", { class: "card chart-card" }, [el("h4", {}, title), el("div", { html: svg })]);
}
function lineChartCard(title, entries) {
  if (entries.length === 0) return el("div", { class: "card chart-card" }, [el("h4", {}, title), el("div", { class: "text-secondary" }, "Нет данных")]);
  const w = 260, h = 140;
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const step = w / Math.max(1, entries.length - 1);
  const points = entries.map(([, v], i) => `${i * step},${h - (v / max) * h}`).join(" ");
  let svg = `<svg width="${w}" height="${h + 24}" viewBox="0 0 ${w} ${h + 24}">`;
  svg += `<polyline points="${points}" fill="none" stroke="#4f6dfa" stroke-width="2" />`;
  entries.forEach(([k, v], i) => {
    const x = i * step, y = h - (v / max) * h;
    svg += `<circle cx="${x}" cy="${y}" r="3" fill="#4f6dfa" />`;
    svg += `<text x="${x}" y="${h + 14}" font-size="9" text-anchor="middle" fill="#85888e">${k.slice(5)}</text>`;
  });
  svg += `</svg>`;
  return el("div", { class: "card chart-card" }, [el("h4", {}, title), el("div", { html: svg })]);
}

// ---------------------------------------------------------
// ПОЛЬЗОВАТЕЛИ (только админ)
// ---------------------------------------------------------
function renderUsersView(topbar, workspace) {
  if (state.profile.role !== "admin") { workspace.appendChild(emptyState("Доступ только для администраторов.")); return; }
  topbar.appendChild(el("div", { class: "topbar-title" }, "Пользователи"));
  topbar.appendChild(el("div", { class: "topbar-spacer" }));
  topbar.appendChild(el("button", { class: "btn btn-primary", onclick: () => openUserModal(null) }, "+ Добавить пользователя"));

  const tableWrap = el("div", { class: "table-wrap" });
  const entries = Object.entries(state.users || {});
  if (entries.length === 0) { tableWrap.appendChild(emptyState("Пользователей нет.")); }
  else {
    const table = el("table", { class: "data-table" });
    table.appendChild(el("thead", {}, [el("tr", {}, [el("th", {}, "Имя"), el("th", {}, "Email"), el("th", {}, "Роль"), el("th", {}, "")])]));
    const tbody = el("tbody");
    entries.forEach(([uid, u]) => {
      tbody.appendChild(el("tr", {}, [
        el("td", {}, u.name || "—"),
        el("td", {}, u.email || "—"),
        el("td", {}, u.role === "admin" ? "Администратор" : "Рекрутер"),
        el("td", {}, [
          el("button", { class: "btn btn-secondary", onclick: (e) => { e.stopPropagation(); openUserModal(uid); } }, "Изменить"),
        ]),
      ]));
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
  }
  workspace.appendChild(tableWrap);
}

function openUserModal(uid) {
  const isEdit = !!uid;
  const u = isEdit ? state.users[uid] : { name: "", email: "", role: "recruiter" };
  const nameInput = el("input", { value: u.name || "" });
  const emailInput = el("input", { value: u.email || "", disabled: isEdit ? "true" : undefined });
  const passInput = el("input", { type: "password", placeholder: isEdit ? "Оставить пустым, если не менять" : "Пароль" });
  const roleDD = buildDropdown({
    options: [{ value: "admin", label: "Администратор" }, { value: "recruiter", label: "Рекрутер" }],
    value: u.role, allowEmpty: false, searchable: false, onChange: () => {},
  });

  const content = el("div", {});
  content.append(
    el("div", { class: "modal-head" }, [el("h3", {}, isEdit ? "Редактирование пользователя" : "Новый пользователь"), el("button", { class: "btn-icon", onclick: () => closeModal(overlay) }, "✕")]),
    el("div", { class: "modal-body" }, [
      el("div", { class: "field" }, [el("label", {}, "Имя"), nameInput]),
      el("div", { class: "field" }, [el("label", {}, "Email"), emailInput]),
      !isEdit ? el("div", { class: "field" }, [el("label", {}, "Пароль"), passInput]) : null,
      el("div", { class: "field" }, [el("label", {}, "Роль"), roleDD]),
      isEdit ? el("div", { class: "text-secondary", style: "font-size:12px" }, "Смена пароля другого пользователя недоступна на бесплатном тарифе Firebase — попросите его сменить пароль самостоятельно через настройки.") : null,
    ]),
    el("div", { class: "modal-footer" }, [
      isEdit ? el("button", { class: "btn btn-danger", onclick: async () => {
        const ok = await confirmModal({ title: "Удалить пользователя?", message: "Кандидаты, закреплённые за ним, станут незакреплёнными.", danger: true, confirmLabel: "Удалить" });
        if (ok) {
          const toUnassign = Object.entries(state.candidates || {}).filter(([id, c]) => c.recruiterId === uid);
          for (const [id] of toUnassign) await updatePath(`candidates/${id}`, { recruiterId: "" });
          await removePath(`users/${uid}`);
          toast("Пользователь удалён", "success");
          closeModal(overlay);
        }
      } }, "Удалить") : null,
      el("div", { class: "topbar-spacer" }),
      el("button", { class: "btn btn-secondary", onclick: () => closeModal(overlay) }, "Отмена"),
      el("button", { class: "btn btn-primary", onclick: async () => {
        if (!nameInput.value.trim()) { toast("Укажите имя", "error"); return; }
        if (!isEdit) {
          if (!isValidEmail(emailInput.value)) { toast("Некорректный email", "error"); return; }
          if (!passInput.value || passInput.value.length < 6) { toast("Пароль минимум 6 символов", "error"); return; }
          try {
            await createUserSecondary(emailInput.value.trim(), passInput.value, nameInput.value.trim(), roleDD.getValue());
            toast("Пользователь создан", "success");
            closeModal(overlay);
          } catch (err) {
            toast("Ошибка: " + (err.message || "не удалось создать"), "error");
          }
        } else {
          await updatePath(`users/${uid}`, { name: nameInput.value.trim(), role: roleDD.getValue() });
          toast("Пользователь обновлён", "success");
          closeModal(overlay);
        }
      } }, "Сохранить"),
    ])
  );
  const overlay = openModal(content);
}

// ---------------------------------------------------------
// НАСТРОЙКИ
// ---------------------------------------------------------
function openSettingsModal() {
  const nameInput = el("input", { value: state.profile?.name || "" });
  const emailInput = el("input", { value: state.profile?.email || "", disabled: "true" });
  const passInput = el("input", { type: "password", placeholder: "Новый пароль (необязательно)" });
  const themeDD = buildDropdown({
    options: [{ value: "light", label: "Светлая" }, { value: "dark", label: "Тёмная" }],
    value: state.theme, allowEmpty: false, searchable: false,
    onChange: (v) => { state.theme = v; localStorage.setItem("demcrm_theme", v); document.documentElement.setAttribute("data-theme", v); },
  });

  const content = el("div", {});
  content.append(
    el("div", { class: "modal-head" }, [el("h3", {}, "Настройки"), el("button", { class: "btn-icon", onclick: () => closeModal(overlay) }, "✕")]),
    el("div", { class: "modal-body" }, [
      el("div", { class: "field" }, [el("label", {}, "Имя"), nameInput]),
      el("div", { class: "field" }, [el("label", {}, "Email"), emailInput]),
      el("div", { class: "field" }, [el("label", {}, "Новый пароль"), passInput]),
      el("div", { class: "field" }, [el("label", {}, "Тема оформления"), themeDD]),
    ]),
    el("div", { class: "modal-footer" }, [
      el("button", { class: "btn btn-secondary", onclick: async () => { await logoutUser(); closeModal(overlay); } }, "Выйти"),
      el("div", { class: "topbar-spacer" }),
      el("button", { class: "btn btn-primary", onclick: async () => {
        try {
          if (nameInput.value.trim() && nameInput.value.trim() !== state.profile.name) {
            await updateOwnProfile(nameInput.value.trim());
            state.profile.name = nameInput.value.trim();
          }
          if (passInput.value) {
            if (passInput.value.length < 6) { toast("Пароль минимум 6 символов", "error"); return; }
            await updateOwnPassword(passInput.value);
          }
          toast("Настройки сохранены", "success");
          closeModal(overlay);
        } catch (err) {
          toast("Ошибка: " + (err.message || ""), "error");
        }
      } }, "Сохранить"),
    ])
  );
  const overlay = openModal(content);
}

// ---------------------------------------------------------
// ГЛОБАЛЬНЫЙ ПОИСК (Ctrl+K)
// ---------------------------------------------------------
const gsOverlay = $("#globalSearchOverlay");
const gsInput = $("#globalSearchInput");
const gsResults = $("#globalSearchResults");

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (!state.user) return;
    gsOverlay.classList.remove("hidden");
    gsInput.value = "";
    gsResults.innerHTML = "";
    setTimeout(() => gsInput.focus(), 10);
  } else if (e.key === "Escape") {
    gsOverlay.classList.add("hidden");
  }
});
gsOverlay.addEventListener("click", (e) => { if (e.target === gsOverlay) gsOverlay.classList.add("hidden"); });
gsInput?.addEventListener("input", () => {
  const q = gsInput.value.toLowerCase().trim();
  gsResults.innerHTML = "";
  if (!q) return;
  const results = [];
  Object.entries(state.candidates || {}).forEach(([id, c]) => {
    if (`${c.fio} ${c.phone}`.toLowerCase().includes(q)) results.push({ type: "Кандидат", label: c.fio, action: () => openCandidateModal(id) });
  });
  Object.entries(state.vacancies || {}).forEach(([id, v]) => {
    if ((v.title || "").toLowerCase().includes(q)) results.push({ type: "Вакансия", label: v.title, action: () => { switchView("vacancies", { vacancyId: id }); } });
  });
  Object.entries(state.managers || {}).forEach(([id, m]) => {
    if ((m.fio || "").toLowerCase().includes(q)) results.push({ type: "Руководитель", label: m.fio, action: () => {} });
  });
  results.slice(0, 20).forEach(r => {
    const item = el("div", { class: "gs-item", onclick: () => { r.action(); gsOverlay.classList.add("hidden"); } }, [
      el("span", {}, r.label), el("span", { class: "gs-item-type" }, r.type),
    ]);
    gsResults.appendChild(item);
  });
  if (results.length === 0) gsResults.appendChild(el("div", { class: "gs-item text-secondary" }, "Ничего не найдено"));
});
