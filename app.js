const STORAGE_KEY_V2 = "flowtree_state_v2";
const STORAGE_KEY_V1 = "flowtree_state_v1";
const LEGACY_CLAIMED_KEY = "flowtree_legacy_claimed_v1";
const LAST_CLOUD_USER_KEY = "flowtree_last_cloud_user_v1";
const PASSWORD_RESET_REQUEST_KEY = "flowtree_password_reset_request_v1";
const TODAY = new Date().toISOString().slice(0, 10);

const urgencyLabels = {
  today: "今天",
  tomorrow: "明天",
  this_week: "本周",
  this_month: "本月",
  no_deadline: "无截止",
  unknown: "待判断",
};

const valueLabels = {
  high: "高价值",
  medium: "中价值",
  low: "低价值",
  unknown: "待判断",
};

const statusLabels = {
  not_started: "未开始",
  in_progress: "进行中",
  stuck: "卡住",
  completed: "已完成",
  paused: "暂时搁置",
};

const historyLabels = {
  created: "创建任务",
  updated: "更新任务",
  today_added: "加入今日任务",
  progress_note: "做到哪了",
  stuck_note: "卡住了",
  retrospective: "复盘",
  completed: "完成任务",
  reopened: "重新打开",
  pomodoro: "专注记录",
  flagged: "设为当前任务",
  unflagged: "取消当前任务",
};

const sampleInput = "我今天要补简历，论文也得定题，猿辅导项目复盘这周要推进。我有点乱，但不想把情侣 App 的想法丢掉。";

let cloudClient = null;
let cloudUser = null;
let cloudReady = false;
let cloudSaveTimer = null;
let cloudSaveInFlight = false;
let cloudSaveQueued = false;
let lastCloudUpdatedAt = "";
let authRequestInFlight = false;
let authRecoveryMode = false;
let authRecoverySession = null;
let authFallbackTimer = null;
let explicitSignOutRequested = false;
let state = loadState();
let activeForm = null;
let toastTimer = null;
let timerInterval = null;
let boardOrigin = "boards";
let taskNoteDraftImages = {};
let draggedTaskId = null;
let lastDeletedStateSnapshot = null;

const primaryRouteMeta = {
  home: { label: "首页", title: "首页" },
  doing: { label: "正在做", title: "正在做" },
  notes: { label: "记事本", title: "记事本" },
  boards: { label: "总任务看板", title: "总任务看板" },
  daily: { label: "今日任务", title: "今日任务" },
};

const els = {
  appView: document.querySelector("#appView"),
  headerTimer: document.querySelector("#headerTimer"),
  syncStatus: document.querySelector("#syncStatus"),
  accountButton: document.querySelector("#accountButton"),
  accountAvatar: document.querySelector("#accountAvatar"),
  accountLabel: document.querySelector("#accountLabel"),
  activityDrawer: document.querySelector("#activityDrawer"),
  activityDrawerBody: document.querySelector("#activityDrawerBody"),
  notesDrawer: document.querySelector("#notesDrawer"),
  notesDrawerBody: document.querySelector("#notesDrawerBody"),
  drawerScrim: document.querySelector("#drawerScrim"),
  formModal: document.querySelector("#formModal"),
  recordForm: document.querySelector("#recordForm"),
  formEyebrow: document.querySelector("#formEyebrow"),
  formTitle: document.querySelector("#formTitle"),
  formBody: document.querySelector("#formBody"),
  formActions: document.querySelector("#formActions"),
  toast: document.querySelector("#toast"),
  taskContextMenu: document.querySelector("#taskContextMenu"),
  authGate: document.querySelector("#authGate"),
  authTitle: document.querySelector("#authTitle"),
  authCopy: document.querySelector("#authCopy"),
  authForm: document.querySelector("#authForm"),
  authEmailField: document.querySelector("#authEmailField"),
  authEmail: document.querySelector("#authEmail"),
  authPassword: document.querySelector("#authPassword"),
  authPasswordToggle: document.querySelector("#authPasswordToggle"),
  authMessage: document.querySelector("#authMessage"),
  authSubmitButton: document.querySelector("#authSubmitButton"),
  authSecondaryActions: document.querySelector("#authSecondaryActions"),
};

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length) return { name: "home" };
  if (parts[0] === "board") {
    return { name: "board", projectId: parts[1] || null, taskId: parts[2] || null };
  }
  if (["home", "pending", "doing", "notes", "boards", "daily"].includes(parts[0])) {
    return { name: parts[0] };
  }
  return { name: "home" };
}

function navigate(path) {
  const target = `#/${path.replace(/^\/+/, "")}`;
  if (location.hash === target) {
    render();
  } else {
    location.hash = target;
  }
}

function loadState() {
  try {
    const v2 = localStorage.getItem(getLocalStateKey());
    if (v2) return normalizeV2(JSON.parse(v2));

    const v1 = localStorage.getItem(STORAGE_KEY_V1);
    if (v1) {
      const migrated = migrateV1(JSON.parse(v1));
      localStorage.setItem(getLocalStateKey(), JSON.stringify(migrated));
      return migrated;
    }
  } catch (error) {
    console.warn("FlowTree state could not be loaded", error);
  }

  const initial = createInitialState();
  localStorage.setItem(getLocalStateKey(), JSON.stringify(initial));
  return initial;
}

function getLocalStateKey(userId = cloudUser?.id) {
  return userId ? `${STORAGE_KEY_V2}_${userId}` : STORAGE_KEY_V2;
}

function serializeStateForStorage() {
  return JSON.parse(
    JSON.stringify(state, function omitTemporaryImageData(key, value) {
      if (key === "dataUrl" && this?.path) return undefined;
      return value;
    })
  );
}

function normalizeV2(saved) {
  const initialTimer = makeTimerState();
  const tasks = Object.fromEntries(
    Object.entries(saved.tasks || {}).map(([id, task]) => [
      id,
      {
        ...task,
        childIds: task.childIds || [],
        valueTags: task.valueTags || [],
        plannedDate: task.plannedDate || "",
        plannedTime: task.plannedTime || "",
        deadlineDate: task.deadlineDate || "",
        deadlineTime: task.deadlineTime || "",
      },
    ])
  );
  const dailyDate = saved.dailyBoard?.date || TODAY;
  let todayTaskIds = unique(saved.dailyBoard?.todayTaskIds || []);
  if (dailyDate === TODAY) {
    todayTaskIds.forEach((taskId) => {
      if (tasks[taskId] && !tasks[taskId].plannedDate) tasks[taskId].plannedDate = TODAY;
    });
  }
  Object.values(tasks).forEach((task) => {
    if (task.plannedDate === TODAY && task.status !== "completed" && !todayTaskIds.includes(task.id)) {
      todayTaskIds.push(task.id);
    }
  });
  return {
    version: 2,
    projects: Array.isArray(saved.projects) ? saved.projects : [],
    tasks,
    histories: Array.isArray(saved.histories) ? saved.histories : [],
    pendingAIItems: Array.isArray(saved.pendingAIItems) ? saved.pendingAIItems : [],
    dailyBoard: {
      date: dailyDate,
      todayTaskIds,
      completedTaskIds: unique(saved.dailyBoard?.completedTaskIds || []),
      pinnedTaskIds: unique(saved.dailyBoard?.pinnedTaskIds || []),
    },
    notes: Array.isArray(saved.notes)
      ? saved.notes.map((note) => ({
          ...note,
          tags: note.tags || [],
          taskId: note.taskId || null,
          projectId: note.projectId || null,
          images: note.images || [],
        }))
      : [],
    recentInputs: Array.isArray(saved.recentInputs) ? saved.recentInputs.slice(0, 5) : [],
    draft: saved.draft || "",
    timer: { ...initialTimer, ...(saved.timer || {}) },
    ui: {
      expandedTaskIds: saved.ui?.expandedTaskIds || [],
      expandedCompletedTaskIds: saved.ui?.expandedCompletedTaskIds || [],
      sidebarCollapsed: Boolean(saved.ui?.sidebarCollapsed),
      selectedTaskByProject: saved.ui?.selectedTaskByProject || {},
      activityScope: saved.ui?.activityScope || "subtree",
      activityFilter: saved.ui?.activityFilter || "all",
      notesView: saved.ui?.notesView || "all",
      noteTag: saved.ui?.noteTag || "",
      noteSearch: saved.ui?.noteSearch || "",
      noteManualTags: saved.ui?.noteManualTags || [],
      carryoverPromptedFor: saved.ui?.carryoverPromptedFor || "",
    },
  };
}

function migrateV1(old) {
  const tasks = { ...(old.tasks || {}) };
  const projects = (old.projects || []).map((project) => {
    const rootIds = project.rootTaskIds || [];
    const topLevelTaskIds = [];
    let currentTaskId = null;

    rootIds.forEach((rootId) => {
      const root = tasks[rootId];
      if (!root) return;
      root.childIds?.forEach((childId) => {
        if (tasks[childId]) {
          tasks[childId].parentId = null;
          topLevelTaskIds.push(childId);
        }
      });
      delete tasks[rootId];
    });

    Object.values(tasks)
      .filter((task) => task.projectId === project.id)
      .forEach((task) => {
        if (rootIds.includes(task.parentId)) task.parentId = null;
        if (!task.parentId && !topLevelTaskIds.includes(task.id)) topLevelTaskIds.push(task.id);
        if (task.userPinned && !currentTaskId) currentTaskId = task.id;
      });

    return {
      id: project.id,
      name: project.name,
      description: project.description || "",
      status: project.status || "active",
      topLevelTaskIds,
      currentTaskId,
      createdAt: project.createdAt || nowIso(),
      updatedAt: project.updatedAt || nowIso(),
    };
  });

  Object.values(tasks).forEach((task) => {
    task.status = task.status === "completed" || Number(task.progress) >= 100 ? "completed" : task.status || "not_started";
    task.completedAt = task.status === "completed" ? task.completedAt || task.updatedAt || nowIso() : null;
    task.nextAction = task.nextPossibleAction || task.nextAction || "";
    task.valueTags = task.valueTags || [];
    task.childIds = task.childIds || [];
    delete task.progress;
    delete task.userPinned;
  });

  const oldColumns = old.dailyBoard?.columns || [];
  const todayTaskIds = unique(
    oldColumns
      .filter((column) => column.id !== "completed")
      .flatMap((column) => column.taskIds || [])
      .filter((taskId) => tasks[taskId] && tasks[taskId].status !== "completed")
  );
  const completedTaskIds = unique([
    ...oldColumns.filter((column) => column.id === "completed").flatMap((column) => column.taskIds || []),
    ...Object.values(tasks).filter((task) => task.status === "completed" && oldColumns.some((column) => column.taskIds?.includes(task.id))).map((task) => task.id),
  ]);

  return normalizeV2({
    version: 2,
    projects,
    tasks,
    histories: old.histories || [],
    pendingAIItems: (old.pendingAIItems || []).map(normalizePendingItem),
    dailyBoard: {
      date: old.dailyBoard?.date || TODAY,
      todayTaskIds,
      completedTaskIds,
      pinnedTaskIds: [],
    },
    notes: [],
    recentInputs: [],
    draft: "",
    timer: makeTimerState(),
    ui: {
      expandedTaskIds: (old.expandedTaskIds || []).filter((id) => tasks[id]),
      expandedCompletedTaskIds: [],
      sidebarCollapsed: false,
      selectedTaskByProject: {},
    },
  });
}

function createInitialState() {
  const createdAt = nowIso();
  const tasks = {};
  const projects = [
    makeProject("project_thesis", "毕业论文", "选题、研究与写作", createdAt),
    makeProject("project_yuanfudao", "猿辅导实习", "项目复盘与求职沉淀", createdAt),
    makeProject("project_job", "秋招准备", "简历、面试与作品集", createdAt),
    makeProject("project_couple_app", "情侣 App", "产品想法与原型验证", createdAt),
  ];

  const add = (projectId, id, title, parentId, childIds, status, urgency, valueLevel, valueTags, nextAction = "") => {
    tasks[id] = makeTask({
      id,
      title,
      projectId,
      parentId,
      childIds,
      status,
      urgency,
      valueLevel,
      valueTags,
      nextAction,
      source: "sample",
      createdAt,
    });
    if (!parentId) getProjectFrom(projects, projectId).topLevelTaskIds.push(id);
  };

  add("project_thesis", "task_thesis_topic", "明确毕业论文选题", null, ["task_thesis_direction", "task_thesis_compare", "task_thesis_tutor"], "in_progress", "this_week", "high", ["高长期价值", "研究方向相关"], "列出 3 个候选选题方向");
  add("project_thesis", "task_thesis_direction", "收集三个候选方向", "task_thesis_topic", ["task_thesis_sources"], "in_progress", "this_week", "medium", ["资料整理"]);
  add("project_thesis", "task_thesis_sources", "整理候选方向资料来源", "task_thesis_direction", [], "not_started", "this_week", "medium", ["资料整理"]);
  add("project_thesis", "task_thesis_compare", "对比研究价值与可行性", "task_thesis_topic", [], "not_started", "this_week", "high", ["决策价值"]);
  add("project_thesis", "task_thesis_tutor", "和导师沟通", "task_thesis_topic", [], "not_started", "this_month", "high", ["外部反馈"]);
  add("project_thesis", "task_thesis_lit", "文献综述", null, [], "not_started", "this_month", "medium", ["研究积累"]);

  add("project_yuanfudao", "task_yuanfudao_review", "复盘当前项目", null, ["task_yuanfudao_background", "task_yuanfudao_problem", "task_yuanfudao_metrics", "task_yuanfudao_reflection"], "stuck", "this_week", "high", ["高求职价值", "项目沉淀"], "整理数据指标和反思");
  add("project_yuanfudao", "task_yuanfudao_background", "写项目背景", "task_yuanfudao_review", [], "completed", "this_week", "medium", ["表达框架"]);
  add("project_yuanfudao", "task_yuanfudao_problem", "梳理用户问题", "task_yuanfudao_review", [], "in_progress", "this_week", "high", ["用户理解"]);
  add("project_yuanfudao", "task_yuanfudao_metrics", "补充数据指标", "task_yuanfudao_review", [], "not_started", "this_week", "high", ["量化结果"]);
  add("project_yuanfudao", "task_yuanfudao_reflection", "写反思总结", "task_yuanfudao_review", [], "stuck", "this_week", "medium", ["复盘深度"]);

  add("project_job", "task_resume", "更新产品经理简历", null, ["task_resume_yuanfudao", "task_resume_move"], "in_progress", "today", "high", ["高求职价值"], "补充一个项目经历段落");
  add("project_job", "task_resume_yuanfudao", "补充猿辅导项目经历", "task_resume", [], "not_started", "today", "high", ["今天想做"]);
  add("project_job", "task_resume_move", "优化搬家项目表述", "task_resume", [], "not_started", "this_week", "medium", ["表达优化"]);
  add("project_job", "task_portfolio", "准备作品集案例", null, [], "not_started", "this_month", "high", ["作品集"]);

  add("project_couple_app", "task_couple_concept", "明确一个核心使用场景", null, [], "not_started", "no_deadline", "medium", ["探索价值"]);

  getProjectFrom(projects, "project_thesis").currentTaskId = "task_thesis_direction";
  getProjectFrom(projects, "project_yuanfudao").currentTaskId = "task_yuanfudao_metrics";

  const histories = [
    makeHistory("task_yuanfudao_review", "project_yuanfudao", "created", { source: "语音输入" }, createdAt),
    makeHistory("task_yuanfudao_review", "project_yuanfudao", "progress_note", { done: "完成项目背景和用户问题。", nextAction: "补充数据指标和反思。" }, createdAt),
    makeHistory("task_yuanfudao_review", "project_yuanfudao", "stuck_note", { stuckPoint: "不知道如何把反思说得更有力。", stuckType: "不知道下一步" }, createdAt),
  ];

  return normalizeV2({
    version: 2,
    projects,
    tasks,
    histories,
    pendingAIItems: [],
    dailyBoard: {
      date: TODAY,
      todayTaskIds: ["task_resume", "task_thesis_direction", "task_yuanfudao_metrics"],
      completedTaskIds: [],
      pinnedTaskIds: ["task_resume"],
    },
    notes: [
      {
        id: "note_sample_1",
        content: "反思不一定要一次写完整，先记录一个具体判断。 #猿辅导实习 #复盘",
        tags: ["猿辅导实习", "复盘"],
        createdAt,
        updatedAt: createdAt,
      },
    ],
    recentInputs: [],
    draft: "",
    timer: makeTimerState(),
    ui: {
      expandedTaskIds: ["task_thesis_topic", "task_thesis_direction", "task_yuanfudao_review", "task_resume"],
      expandedCompletedTaskIds: [],
      sidebarCollapsed: false,
      selectedTaskByProject: {},
    },
  });
}

function makeProject(id, name, description, createdAt = nowIso()) {
  return {
    id,
    name,
    description,
    status: "active",
    topLevelTaskIds: [],
    currentTaskId: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function makeTask({
  id = createId("task"),
  title,
  projectId,
  parentId = null,
  childIds = [],
  status = "not_started",
  urgency = "unknown",
  valueLevel = "unknown",
  valueTags = [],
  valueReason = "",
  nextAction = "",
  source = "manual",
  rawInput = "",
  plannedDate = "",
  plannedTime = "",
  deadlineDate = "",
  deadlineTime = "",
  createdAt = nowIso(),
}) {
  return {
    id,
    title,
    type: "task",
    projectId,
    parentId,
    childIds,
    status,
    urgency,
    valueLevel,
    valueTags,
    valueReason,
    nextAction,
    source,
    rawInput,
    plannedDate,
    plannedTime,
    deadlineDate,
    deadlineTime,
    createdAt,
    updatedAt: createdAt,
    completedAt: status === "completed" ? createdAt : null,
  };
}

function makeHistory(taskId, projectId, type, content, createdAt = nowIso()) {
  return { id: createId("history"), taskId, projectId, type, content, createdAt };
}

function makeTimerState() {
  return {
    mode: "focus",
    status: "idle",
    taskId: null,
    projectId: null,
    focusMinutes: 25,
    breakMinutes: 5,
    remainingSeconds: 25 * 60,
    endAt: null,
    startedAt: null,
  };
}

function normalizePendingItem(item) {
  const isTask = item.type === "task" || item.type === "subtask";
  return {
    id: item.id || createId("pending"),
    category: isTask ? "task" : "other",
    type: item.type || "task",
    title: item.title || "待确认内容",
    content: item.content || item.rawEvidence || "",
    matchedProjectId: item.matchedProjectId || "",
    matchedTaskId: item.matchedTaskId || "",
    suggestedProjectName: item.suggestedProjectName || "",
    urgency: item.urgency || "unknown",
    valueLevel: item.valueLevel || "unknown",
    valueTags: item.valueTags || [],
    valueReason: item.valueReason || "",
    shouldAddToToday: Boolean(item.shouldAddToToday),
    nextAction: item.nextAction || item.nextPossibleAction || "",
    rawEvidence: item.rawEvidence || "",
    noteTags: item.noteTags || [otherTypeLabel(item.type || "note")],
    createdAt: item.createdAt || nowIso(),
  };
}

function saveState() {
  try {
    localStorage.setItem(getLocalStateKey(), JSON.stringify(serializeStateForStorage()));
    scheduleCloudSave();
    return true;
  } catch (error) {
    console.warn("FlowTree state could not be saved", error);
    showToast("本地存储空间不足，请减少记录中的图片。");
    return false;
  }
}

function setSyncStatus(label, tone = "") {
  if (!els.syncStatus) return;
  els.syncStatus.textContent = label;
  els.syncStatus.dataset.tone = tone;
}

function scheduleCloudSave() {
  if (!cloudReady || !cloudUser || !cloudClient) return;
  setSyncStatus("待同步", "pending");
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => {
    pushCloudState();
  }, 700);
}

async function pushCloudState(force = false) {
  if (!cloudReady || !cloudUser || !cloudClient) return false;
  if (cloudSaveInFlight) {
    cloudSaveQueued = true;
    return false;
  }
  cloudSaveInFlight = true;
  cloudSaveQueued = false;
  setSyncStatus("同步中", "pending");
  const payload = {
    user_id: cloudUser.id,
    state: serializeStateForStorage(),
    revision: Date.now(),
    updated_at: nowIso(),
  };
  try {
    const { data, error } = await cloudClient
      .from(window.FlowTreeCloud.config.stateTable)
      .upsert(payload, { onConflict: "user_id" })
      .select("updated_at")
      .single();
    if (error) throw error;
    lastCloudUpdatedAt = data?.updated_at || payload.updated_at;
    setSyncStatus("已同步", "success");
    return true;
  } catch (error) {
    console.warn("FlowTree cloud sync failed", error);
    setSyncStatus("同步失败", "error");
    if (force) showToast("云端保存失败，请检查网络或 Supabase 配置。");
    return false;
  } finally {
    cloudSaveInFlight = false;
    if (cloudSaveQueued) {
      cloudSaveQueued = false;
      scheduleCloudSave();
    }
  }
}

function setAuthMessage(message = "", tone = "") {
  if (!els.authMessage) return;
  els.authMessage.textContent = message;
  if (tone) els.authMessage.dataset.tone = tone;
  else delete els.authMessage.dataset.tone;
}

function getSignedOutPrompt() {
  const lastUser = getLastCloudUser();
  if (lastUser?.email) {
    return `没有检测到 ${lastUser.email} 的登录状态。请重新登录；如果不确定密码，请点“设置/重置密码”。`;
  }
  return "请输入邮箱和密码登录。";
}

function getAuthErrorMessage(error, mode = "signin") {
  const message = String(error?.message || "");
  if (/invalid login credentials/i.test(message)) {
    if (getRecentPasswordResetRequest()) {
      return "邮箱或密码不正确。如果你刚点过重置邮件，请确认已经在“设置新登录密码”页面点了“保存新密码”。只在登录页输入新密码不会完成重置。";
    }
    return "邮箱或密码不正确。也可能是邮箱还没确认：请先打开邮箱确认链接；如果不确定密码，请点“设置/重置密码”。";
  }
  if (/email not confirmed/i.test(message)) {
    return "这个邮箱还没有完成确认。请先打开邮箱里的确认链接，然后回来登录。";
  }
  if (/user already registered|already registered|already exists/i.test(message)) {
    return "这个邮箱已经注册过。请直接登录；如果不确定密码，请点“设置/重置密码”。";
  }
  if (/rate limit|too many requests|too many/i.test(message)) {
    return "请求太频繁，请稍后再试。";
  }
  if (/failed to fetch|network|load failed/i.test(message)) {
    return "网络连接失败，请检查网络后再试。";
  }
  if (mode === "signup") return message || "创建账户失败，请稍后重试。";
  if (mode === "reset") return message || "邮件发送失败，请稍后重试。";
  if (mode === "recover") return message || "密码更新失败，请重试。";
  return message || "登录失败，请稍后重试。";
}

function isExistingSignupResult(result) {
  const identities = result?.data?.user?.identities;
  return Array.isArray(identities) && identities.length === 0;
}

function rememberPasswordResetRequest(email) {
  localStorage.setItem(
    PASSWORD_RESET_REQUEST_KEY,
    JSON.stringify({
      email,
      requestedAt: Date.now(),
    })
  );
}

function getRecentPasswordResetRequest() {
  try {
    const request = JSON.parse(localStorage.getItem(PASSWORD_RESET_REQUEST_KEY) || "null");
    if (!request?.requestedAt) return null;
    if (Date.now() - request.requestedAt > 30 * 60 * 1000) {
      localStorage.removeItem(PASSWORD_RESET_REQUEST_KEY);
      return null;
    }
    return request;
  } catch {
    return null;
  }
}

function clearPasswordResetRequest() {
  localStorage.removeItem(PASSWORD_RESET_REQUEST_KEY);
}

function getPasswordRecoveryRedirectUrl() {
  return `${location.origin}${location.pathname}?flowtree_auth=recovery`;
}

function hasPasswordRecoveryInUrl() {
  const search = location.search || "";
  const hash = location.hash || "";
  return (
    search.includes("flowtree_auth=recovery") ||
    search.includes("type=recovery") ||
    hash.includes("type=recovery") ||
    hash.includes("type=password_recovery") ||
    (hasAuthCallbackInUrl() && Boolean(getRecentPasswordResetRequest()))
  );
}

function showAuthGate(message = "", tone = message ? "info" : "") {
  els.authGate?.classList.remove("hidden");
  document.body.classList.add("auth-locked");
  setAuthMessage(message, tone);
}

function hideAuthGate() {
  els.authGate?.classList.add("hidden");
  document.body.classList.remove("auth-locked");
  setAuthMessage("");
}

function showPasswordRecovery() {
  clearTimeout(authFallbackTimer);
  authRecoveryMode = true;
  showAuthGate();
  if (els.authTitle) els.authTitle.textContent = "设置新登录密码";
  if (els.authCopy) els.authCopy.textContent = "这里不是找回旧密码。请在这里输入一个新密码并点击保存，保存后以后登录就用它。";
  els.authEmailField?.classList.add("hidden");
  els.authSecondaryActions?.classList.add("hidden");
  if (els.authPassword) {
    els.authPassword.value = "";
    els.authPassword.autocomplete = "new-password";
    els.authPassword.type = "password";
  }
  updatePasswordToggle(false);
  if (els.authSubmitButton) els.authSubmitButton.textContent = "保存新密码";
  setAuthMessage("请输入至少 6 位的新密码，然后点击保存。", "info");
}

function resetAuthFormMode() {
  authRecoveryMode = false;
  authRecoverySession = null;
  if (els.authTitle) els.authTitle.textContent = "登录后继续";
  if (els.authCopy) els.authCopy.textContent = "你的任务、记录和时间计划会加密传输，并只对当前账户开放。登录状态会自动保留。";
  els.authEmailField?.classList.remove("hidden");
  els.authSecondaryActions?.classList.remove("hidden");
  if (els.authPassword) {
    els.authPassword.autocomplete = "current-password";
    els.authPassword.type = "password";
  }
  updatePasswordToggle(false);
  if (els.authSubmitButton) els.authSubmitButton.textContent = "登录";
}

function updatePasswordToggle(isVisible = els.authPassword?.type === "text") {
  if (!els.authPasswordToggle) return;
  els.authPasswordToggle.setAttribute("aria-pressed", String(isVisible));
  els.authPasswordToggle.setAttribute("aria-label", isVisible ? "隐藏密码" : "显示密码");
  els.authPasswordToggle.classList.toggle("active", isVisible);
}

function toggleAuthPasswordVisibility() {
  if (!els.authPassword) return;
  const shouldShow = els.authPassword.type === "password";
  els.authPassword.type = shouldShow ? "text" : "password";
  updatePasswordToggle(shouldShow);
  els.authPassword.focus();
}

function rememberCloudUser(user) {
  if (!user?.id) return;
  localStorage.setItem(
    LAST_CLOUD_USER_KEY,
    JSON.stringify({
      id: user.id,
      email: user.email || "",
      updatedAt: nowIso(),
    })
  );
}

function getLastCloudUser() {
  try {
    return JSON.parse(localStorage.getItem(LAST_CLOUD_USER_KEY) || "null");
  } catch {
    return null;
  }
}

function hasAuthCallbackInUrl() {
  const search = location.search || "";
  const hash = location.hash || "";
  return (
    search.includes("code=") ||
    hash.includes("access_token=") ||
    hash.includes("refresh_token=") ||
    hash.includes("type=recovery")
  );
}

function cleanAuthCallbackUrl() {
  if (!hasAuthCallbackInUrl()) return;
  window.history?.replaceState?.(null, "", `${location.origin}${location.pathname}#/home`);
}

function showSignedOutGate(message = getSignedOutPrompt(), tone = "info") {
  clearTimeout(authFallbackTimer);
  cloudUser = null;
  cloudReady = false;
  resetAuthFormMode();
  updateAccountUI();
  setSyncStatus("未登录");
  if (els.appView) els.appView.innerHTML = "";
  closeActivityDrawer();
  closeNotesDrawer();
  showAuthGate(message, tone);
}

function scheduleSignedOutGate(message = getSignedOutPrompt(), delayMs = 2200, tone = "info") {
  clearTimeout(authFallbackTimer);
  authFallbackTimer = setTimeout(async () => {
    if (cloudUser || authRecoveryMode) return;
    try {
      const { data } = await cloudClient.auth.getSession();
      if (data?.session) {
        await handleCloudSession(data.session);
        return;
      }
    } catch (error) {
      console.warn("FlowTree auth retry failed", error);
    }
    showSignedOutGate(message, tone);
  }, delayMs);
}

function updateAccountUI() {
  const signedIn = Boolean(cloudUser);
  els.accountButton?.classList.toggle("hidden", !signedIn);
  if (!signedIn) return;
  const email = cloudUser.email || "账户";
  if (els.accountLabel) els.accountLabel.textContent = email.split("@")[0];
  if (els.accountAvatar) els.accountAvatar.textContent = email.slice(0, 1).toUpperCase();
}

function getLegacyStateForMigration() {
  if (localStorage.getItem(LEGACY_CLAIMED_KEY)) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_V2);
    return raw ? normalizeV2(JSON.parse(raw)) : null;
  } catch (error) {
    console.warn("Legacy state could not be prepared for migration", error);
    return null;
  }
}

async function loadCloudState() {
  setSyncStatus("读取中", "pending");
  const { data, error } = await cloudClient
    .from(window.FlowTreeCloud.config.stateTable)
    .select("state, updated_at")
    .eq("user_id", cloudUser.id)
    .maybeSingle();
  if (error) throw error;

  if (data?.state && Object.keys(data.state).length) {
    state = normalizeV2(data.state);
    lastCloudUpdatedAt = data.updated_at || "";
  } else {
    state = getLegacyStateForMigration() || createInitialState();
    localStorage.setItem(LEGACY_CLAIMED_KEY, cloudUser.id);
    cloudReady = true;
    await pushCloudState(true);
  }

  localStorage.setItem(getLocalStateKey(), JSON.stringify(serializeStateForStorage()));
  setSyncStatus("已同步", "success");
}

async function refreshCloudState() {
  if (!cloudReady || !cloudUser || !cloudClient || cloudSaveInFlight) return;
  try {
    const { data, error } = await cloudClient
      .from(window.FlowTreeCloud.config.stateTable)
      .select("state, updated_at")
      .eq("user_id", cloudUser.id)
      .maybeSingle();
    if (error) throw error;
    if (!data?.state || !data.updated_at || data.updated_at === lastCloudUpdatedAt) return;
    state = normalizeV2(data.state);
    lastCloudUpdatedAt = data.updated_at;
    localStorage.setItem(getLocalStateKey(), JSON.stringify(serializeStateForStorage()));
    render();
    hydrateCloudImages();
    showToast("已载入其他设备上的最新修改。");
  } catch (error) {
    console.warn("FlowTree cloud refresh failed", error);
    setSyncStatus("离线", "error");
  }
}

async function handleCloudSession(session) {
  const nextUser = session?.user || null;
  if (!nextUser) {
    scheduleSignedOutGate();
    return;
  }
  clearTimeout(authFallbackTimer);
  resetAuthFormMode();
  rememberCloudUser(nextUser);
  if (cloudUser?.id === nextUser.id && cloudReady) return;

  cloudUser = nextUser;
  updateAccountUI();
  showAuthGate("正在读取你的数据...");
  try {
    await loadCloudState();
    cloudReady = true;
    hideAuthGate();
    cleanAuthCallbackUrl();
    render();
    hydrateCloudImages();
  } catch (error) {
    console.warn("FlowTree cloud state could not be loaded", error);
    const cached = localStorage.getItem(getLocalStateKey());
    if (cached) {
      state = normalizeV2(JSON.parse(cached));
      cloudReady = true;
      hideAuthGate();
      setSyncStatus("离线缓存", "error");
      render();
      return;
    }
    showAuthGate("无法读取云端数据，请检查网络后重试。", "error");
  }
}

async function initializeCloud() {
  if (!window.FlowTreeCloud?.isConfigured()) {
    setSyncStatus("仅本机");
    render();
    return;
  }
  try {
    const recoveryLinkOpen = hasPasswordRecoveryInUrl();
    cloudClient = window.FlowTreeCloud.getClient();
    const lastUser = getLastCloudUser();
    showAuthGate(
      recoveryLinkOpen
        ? "正在打开密码设置页面..."
        : lastUser?.email
          ? `正在恢复 ${lastUser.email} 的登录状态...`
          : "正在检查登录状态...",
      "info"
    );
    cloudClient.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || (session && hasPasswordRecoveryInUrl())) {
        authRecoverySession = session;
        setTimeout(showPasswordRecovery, 0);
        return;
      }
      if (event === "SIGNED_OUT") {
        const message = explicitSignOutRequested ? "已退出登录。" : getSignedOutPrompt();
        setTimeout(() => showSignedOutGate(message), 0);
        return;
      }
      if (session) {
        setTimeout(() => handleCloudSession(session), 0);
        return;
      }
      if (event === "INITIAL_SESSION") {
        setTimeout(() => {
          if (hasPasswordRecoveryInUrl()) {
            scheduleSignedOutGate("密码设置链接没有成功打开。请重新发送设置/重置密码邮件，并确认 Supabase Redirect URL 包含线上地址。", 5200, "error");
            return;
          }
          scheduleSignedOutGate();
        }, 0);
      }
    });
    const { data, error } = await cloudClient.auth.getSession();
    if (error) throw error;
    if (data.session && hasPasswordRecoveryInUrl()) {
      authRecoverySession = data.session;
      showPasswordRecovery();
    } else if (data.session) {
      await handleCloudSession(data.session);
    } else if (hasPasswordRecoveryInUrl()) {
      scheduleSignedOutGate("密码设置链接没有成功打开。请重新发送设置/重置密码邮件，并确认 Supabase Redirect URL 包含线上地址。", 5200, "error");
    } else {
      scheduleSignedOutGate();
    }
  } catch (error) {
    console.warn("FlowTree cloud could not initialize", error);
    setSyncStatus("云端未连接", "error");
    showAuthGate("云端配置无效或依赖加载失败。", "error");
  }
}

async function submitAuth(mode) {
  if (!cloudClient || authRequestInFlight) return;
  const email = els.authEmail?.value.trim();
  const password = els.authPassword?.value || "";
  if (!email || password.length < 6) {
    setAuthMessage("请输入有效邮箱和至少 6 位密码。", "error");
    return;
  }

  authRequestInFlight = true;
  setAuthMessage(mode === "signup" ? "正在创建账户..." : "正在登录...", "info");
  try {
    const result =
      mode === "signup"
        ? await cloudClient.auth.signUp({ email, password })
        : await cloudClient.auth.signInWithPassword({ email, password });
    if (result.error) throw result.error;
    if (mode === "signup") {
      if (isExistingSignupResult(result)) {
        setAuthMessage("这个邮箱可能已经注册过。请直接登录；如果不确定密码，请点“设置/重置密码”。", "error");
        return;
      }
      if (!result.data?.session) {
        setAuthMessage("账户已创建，但还不能直接登录。请先去邮箱点击确认链接；确认后回来登录。上方密码就是之后登录用的密码。", "success");
        return;
      }
      setAuthMessage("账户已创建，正在读取你的数据...", "success");
    } else {
      setAuthMessage("登录成功，正在读取你的数据...", "success");
    }
    if (result.data?.session) {
      await handleCloudSession(result.data.session);
    }
  } catch (error) {
    console.warn("FlowTree authentication failed", error);
    setAuthMessage(getAuthErrorMessage(error, mode), "error");
  } finally {
    authRequestInFlight = false;
  }
}

async function requestPasswordReset() {
  if (!cloudClient || authRequestInFlight) return;
  const email = els.authEmail?.value.trim();
  if (!email) {
    setAuthMessage("先填写需要设置/重置密码的邮箱。", "error");
    return;
  }
  authRequestInFlight = true;
  setAuthMessage("正在发送设置/重置密码邮件...", "info");
  try {
    const redirectTo = getPasswordRecoveryRedirectUrl();
    const { error } = await cloudClient.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
    rememberPasswordResetRequest(email);
    setAuthMessage("邮件已发送。打开邮件链接后，页面会让你设置一个新的登录密码。若没收到，请检查垃圾箱或先完成注册确认。", "success");
  } catch (error) {
    console.warn("Password reset request failed", error);
    setAuthMessage(getAuthErrorMessage(error, "reset"), "error");
  } finally {
    authRequestInFlight = false;
  }
}

async function updateRecoveredPassword() {
  if (!cloudClient || authRequestInFlight) return;
  const password = els.authPassword?.value || "";
  if (password.length < 6) {
    setAuthMessage("新密码至少需要 6 位。", "error");
    return;
  }
  authRequestInFlight = true;
  setAuthMessage("正在保存新密码...", "info");
  try {
    const { error } = await cloudClient.auth.updateUser({ password });
    if (error) throw error;
    const { data } = await cloudClient.auth.getSession();
    const recoveredSession = data?.session || authRecoverySession;
    clearPasswordResetRequest();
    resetAuthFormMode();
    cleanAuthCallbackUrl();
    if (recoveredSession) await handleCloudSession(recoveredSession);
    else showSignedOutGate("新密码已保存。请用新密码登录。");
    showToast("新密码已保存。以后请用它登录。");
  } catch (error) {
    console.warn("Password update failed", error);
    setAuthMessage(getAuthErrorMessage(error, "recover"), "error");
  } finally {
    authRequestInFlight = false;
  }
}

async function signOut() {
  if (!cloudClient) return;
  clearTimeout(cloudSaveTimer);
  while (cloudSaveInFlight) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await pushCloudState(true);
  explicitSignOutRequested = true;
  const { error } = await cloudClient.auth.signOut();
  if (error) {
    explicitSignOutRequested = false;
    showToast("退出失败，请稍后重试。");
    return;
  }
  state = createInitialState();
  cloudUser = null;
  cloudReady = false;
  localStorage.removeItem(LAST_CLOUD_USER_KEY);
  if (els.appView) els.appView.innerHTML = "";
  resetAuthFormMode();
  updateAccountUI();
  showAuthGate("已退出登录。", "info");
  explicitSignOutRequested = false;
}

function dataUrlToBlob(dataUrl) {
  const [metadata, encoded] = dataUrl.split(",");
  const mimeType = metadata.match(/data:(.*?);/)?.[1] || "image/jpeg";
  const bytes = atob(encoded);
  const values = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) values[index] = bytes.charCodeAt(index);
  return new Blob([values], { type: mimeType });
}

async function uploadTaskNoteImages(taskId, images) {
  if (!cloudReady || !cloudUser || !cloudClient) return images;
  const uploaded = [];
  for (const image of images) {
    const path = `${cloudUser.id}/${taskId}/${image.id}.jpg`;
    const blob = dataUrlToBlob(image.dataUrl);
    const { error } = await cloudClient.storage
      .from(window.FlowTreeCloud.config.imageBucket)
      .upload(path, blob, { contentType: blob.type, upsert: false });
    if (error) throw error;
    uploaded.push({ ...image, path });
  }
  return uploaded;
}

async function hydrateCloudImages() {
  if (!cloudReady || !cloudClient) return;
  const images = state.notes.flatMap((note) => note.images || []).filter((image) => image.path && !image.dataUrl);
  if (!images.length) return;
  await Promise.all(
    images.map(async (image) => {
      const { data, error } = await cloudClient.storage
        .from(window.FlowTreeCloud.config.imageBucket)
        .download(image.path);
      if (!error && data) image.dataUrl = URL.createObjectURL(data);
    })
  );
  render();
}

async function deleteCloudNoteImages(note) {
  if (!cloudReady || !cloudClient) return;
  const paths = (note?.images || []).map((image) => image.path).filter(Boolean);
  if (paths.length) {
    const { error } = await cloudClient.storage.from(window.FlowTreeCloud.config.imageBucket).remove(paths);
    if (error) console.warn("FlowTree note images could not be deleted", error);
  }
}

function getProject(projectId) {
  return state.projects.find((project) => project.id === projectId);
}

function getProjectFrom(projects, projectId) {
  return projects.find((project) => project.id === projectId);
}

function getTask(taskId) {
  return state.tasks[taskId];
}

function getProjectTasks(projectId) {
  return Object.values(state.tasks).filter((task) => task.projectId === projectId);
}

function getIncompleteDescendants(taskId) {
  const result = [];
  const task = getTask(taskId);
  task?.childIds.forEach((childId) => {
    const child = getTask(childId);
    if (!child) return;
    if (child.status !== "completed") result.push(child);
    result.push(...getIncompleteDescendants(childId));
  });
  return result;
}

function getSubtreeIds(taskId) {
  const task = getTask(taskId);
  if (!task) return [];
  return [taskId, ...task.childIds.flatMap(getSubtreeIds)];
}

function getTaskDepth(taskId) {
  let depth = 0;
  let task = getTask(taskId);
  while (task?.parentId) {
    depth += 1;
    task = getTask(task.parentId);
  }
  return depth;
}

function getDefaultTask(project) {
  if (project.currentTaskId && getTask(project.currentTaskId)?.status !== "completed") {
    return getTask(project.currentTaskId);
  }
  const selected = getTask(state.ui.selectedTaskByProject[project.id]);
  if (selected) return selected;
  const incomplete = getProjectTasks(project.id)
    .filter((task) => task.status !== "completed")
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return incomplete[0] || getTask(project.topLevelTaskIds[0]) || null;
}

function countTodayTasks(projectId) {
  return state.dailyBoard.todayTaskIds.filter((taskId) => getTask(taskId)?.projectId === projectId).length;
}

function touchProject(projectId) {
  const project = getProject(projectId);
  if (project) project.updatedAt = nowIso();
}

function render() {
  if (window.FlowTreeCloud?.isConfigured() && !cloudUser) {
    els.appView.innerHTML = "";
    return;
  }
  const route = getRoute();
  updateNavigation(route);
  updateDocumentTitle(route);
  updateHeaderTimer();
  closeActivityDrawer();

  if (route.name === "home") renderHome();
  if (route.name === "pending") renderPending();
  if (route.name === "doing") renderDoing();
  if (route.name === "notes") renderNotesPage();
  if (route.name === "boards") renderBoards();
  if (route.name === "daily") renderDaily();
  if (route.name === "board") renderTaskBoard(route);

  saveState();
}

function updateNavigation(route) {
  const primaryName = primaryRouteMeta[route.name] ? route.name : null;
  document.querySelectorAll("[data-route-link]").forEach((link) => {
    const active = link.dataset.routeLink === primaryName;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function updateDocumentTitle(route) {
  if (route.name === "board") {
    const project = getProject(route.projectId);
    const task = getTask(route.taskId);
    document.title = `${task?.title || project?.name || "具体任务"} · FlowTree`;
    return;
  }
  if (route.name === "pending") {
    document.title = "确认本次整理 · FlowTree";
    return;
  }
  document.title = `${primaryRouteMeta[route.name]?.title || "首页"} · FlowTree`;
}

function renderHome() {
  els.appView.innerHTML = `
    <section class="page home-page">
      <header class="page-header">
        <div>
          <p class="eyebrow">Capture</p>
          <h1>今天脑子里有什么？</h1>
          <p>不用先整理。把任务、想法和情绪一起放下来，确认后再进入你的任务树。</p>
        </div>
      </header>

      <section class="panel capture-panel">
        <label for="thoughtInput">随便说，或者直接写下来</label>
        <textarea id="thoughtInput" placeholder="例如：我今天要补简历，论文也得定题，猿辅导项目复盘这周要推进。">${escapeHtml(state.draft)}</textarea>
        <div class="inline-row">
          <div class="capture-status" id="captureStatus">${cloudReady ? "草稿会自动同步到你的账户。" : "草稿会自动保存在当前浏览器。"}</div>
          <div class="page-actions">
            <button class="icon-button" type="button" data-action="voice-input" title="语音输入" aria-label="语音输入">◉</button>
            <button class="secondary-button" type="button" data-action="fill-sample">填入示例</button>
            <button class="primary-button" type="button" data-action="extract-ai">AI 整理</button>
          </div>
        </div>
      </section>

      ${
        state.pendingAIItems.length
          ? `
            <section class="pending-resume">
              <div>
                <strong>上次 AI 整理还有 ${state.pendingAIItems.length} 项待确认</strong>
                <span>确认后才会进入任务看板或记事本。</span>
              </div>
              <button class="secondary-button" type="button" data-action="resume-pending">继续确认</button>
            </section>
          `
          : ""
      }

      <section class="panel">
        <div class="section-header">
          <div>
            <p class="eyebrow">Recent</p>
            <h2>最近输入</h2>
          </div>
          <span class="muted">最近 5 条</span>
        </div>
        <div class="recent-list">
          ${
            state.recentInputs.length
              ? state.recentInputs
                  .map(
                    (item) => `
                      <button class="recent-item" type="button" data-action="reuse-input" data-id="${item.id}">
                        ${escapeHtml(item.text)}
                        <time>${formatDateTime(item.createdAt)}</time>
                      </button>
                    `
                  )
                  .join("")
              : `<div class="empty-state">完成第一次 AI 整理后，原始输入会保留在这里。</div>`
          }
        </div>
      </section>
    </section>
  `;
}

function renderPending() {
  const taskItems = state.pendingAIItems.filter((item) => item.category === "task");
  const otherItems = state.pendingAIItems.filter((item) => item.category !== "task");

  els.appView.innerHTML = `
    <section class="page">
      <header class="page-header">
        <div>
          <p class="eyebrow">AI Organize</p>
          <h1>确认本次整理</h1>
          <p>这是首页输入后的临时确认步骤。任务进入看板，其他内容进入记事本。</p>
        </div>
        <div class="page-actions">
          <span class="count-badge">${state.pendingAIItems.length}</span>
          <button class="quiet-button" type="button" data-action="leave-pending">稍后处理</button>
        </div>
      </header>

      <div class="pending-sections">
        <section class="panel pending-column">
          <div class="section-header">
            <div>
              <p class="eyebrow">Tasks</p>
              <h2>任务</h2>
            </div>
            <span class="muted">${taskItems.length} 项</span>
          </div>
          ${
            taskItems.length
              ? taskItems.map(renderPendingTask).join("")
              : `<div class="empty-state">没有待确认任务。</div>`
          }
        </section>

        <section class="panel pending-column">
          <div class="section-header">
            <div>
              <p class="eyebrow">Other</p>
              <h2>其他</h2>
            </div>
            <span class="muted">${otherItems.length} 项</span>
          </div>
          ${
            otherItems.length
              ? otherItems.map(renderPendingOther).join("")
              : `<div class="empty-state">想法、情绪、资料和决策会出现在这里。</div>`
          }
        </section>
      </div>
    </section>
  `;
}

function renderPendingTask(item) {
  const projectValue = item.matchedProjectId || "__new__";
  const parentOptions = projectValue !== "__new__" ? getTaskOptions(projectValue, item.matchedTaskId) : `<option value="">作为一级任务</option>`;
  return `
    <article class="pending-card" data-pending-card="${item.id}">
      <div class="card-header">
        <div>
          <div class="tag-row">
            <span class="tag">任务</span>
            ${item.valueTags.slice(0, 2).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
          </div>
          <h2>${escapeHtml(item.title)}</h2>
        </div>
        <button class="danger-button" type="button" data-action="delete-pending" data-id="${item.id}">删除</button>
      </div>
      <div class="evidence">${escapeHtml(item.valueReason || "等待你的判断")}<br>原始内容：${escapeHtml(item.rawEvidence)}</div>
      <div class="field-grid">
        <div class="field">
          <label>总任务看板</label>
          <select data-pending-field="matchedProjectId" data-id="${item.id}">
            ${state.projects.map((project) => `<option value="${project.id}" ${project.id === projectValue ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("")}
            <option value="__new__" ${projectValue === "__new__" ? "selected" : ""}>+ 新建总任务看板</option>
          </select>
        </div>
        <div class="field ${projectValue === "__new__" ? "" : "hidden"}" data-new-project-field="${item.id}">
          <label>新看板名称</label>
          <input data-pending-field="suggestedProjectName" data-id="${item.id}" value="${escapeHtml(item.suggestedProjectName)}" />
        </div>
        <div class="field ${projectValue === "__new__" ? "hidden" : ""}" data-parent-field="${item.id}">
          <label>父任务</label>
          <select data-pending-field="matchedTaskId" data-id="${item.id}">${parentOptions}</select>
        </div>
        <div class="field">
          <label>紧急程度</label>
          <select data-pending-field="urgency" data-id="${item.id}">${renderOptions(urgencyLabels, item.urgency)}</select>
        </div>
        <div class="field">
          <label>价值</label>
          <select data-pending-field="valueLevel" data-id="${item.id}">${renderOptions(valueLabels, item.valueLevel)}</select>
        </div>
        <div class="field">
          <label>加入今日</label>
          <select data-pending-field="shouldAddToToday" data-id="${item.id}">
            <option value="false" ${item.shouldAddToToday ? "" : "selected"}>暂不加入</option>
            <option value="true" ${item.shouldAddToToday ? "selected" : ""}>今天要推进</option>
          </select>
        </div>
      </div>
      <div class="card-actions">
        <button class="primary-button" type="button" data-action="confirm-pending-task" data-id="${item.id}">确认任务</button>
      </div>
    </article>
  `;
}

function renderPendingOther(item) {
  const tags = unique(item.noteTags || [otherTypeLabel(item.type)]);
  return `
    <article class="pending-card" data-pending-card="${item.id}">
      <div class="card-header">
        <div>
          <span class="tag">${escapeHtml(otherTypeLabel(item.type))}</span>
          <h2>${escapeHtml(item.title)}</h2>
        </div>
        <button class="danger-button" type="button" data-action="delete-pending" data-id="${item.id}">删除</button>
      </div>
      <div class="field">
        <label>记录内容</label>
        <textarea rows="4" data-pending-field="content" data-id="${item.id}">${escapeHtml(item.content || item.rawEvidence)}</textarea>
      </div>
      <div class="field">
        <label>标签，用空格分隔</label>
        <input data-pending-field="noteTags" data-id="${item.id}" value="${escapeHtml(tags.map((tag) => `#${tag}`).join(" "))}" />
      </div>
      <div class="card-actions">
        <button class="primary-button" type="button" data-action="confirm-pending-note" data-id="${item.id}">存入记事本</button>
      </div>
    </article>
  `;
}

function renderDoing() {
  const tasks = state.projects
    .map((project) => getTask(project.currentTaskId))
    .filter((task) => task && task.status !== "completed")
    .sort((a, b) => {
      const todayDiff = Number(b.plannedDate === TODAY) - Number(a.plannedDate === TODAY);
      return todayDiff || new Date(b.updatedAt) - new Date(a.updatedAt);
    });

  els.appView.innerHTML = `
    <section class="page doing-page">
      <header class="page-header">
        <div>
          <p class="eyebrow">In Progress</p>
          <h1>正在做</h1>
          <p>这里集中显示每个总任务看板中被插旗的当前任务，不改变它们在任务树中的位置。</p>
        </div>
        <div class="page-actions">
          <span class="count-badge">${tasks.length}</span>
          <button class="primary-button" type="button" data-action="quick-doing-task">添加任务</button>
        </div>
      </header>
      ${
        tasks.length
          ? `<div class="doing-grid">${tasks.map(renderDoingCard).join("")}</div>`
          : `
            <div class="empty-state doing-empty">
              <div>
                <h2>还没有正在做的任务</h2>
                <p>在具体任务页面点击“设为当前任务”，它就会出现在这里。</p>
                <div class="page-actions">
                  <button class="primary-button" type="button" data-action="quick-doing-task">添加任务</button>
                  <button class="secondary-button" type="button" data-action="navigate-route" data-value="boards">查看总任务看板</button>
                </div>
              </div>
            </div>
          `
      }
    </section>
  `;
}

function renderDoingCard(task) {
  const project = getProject(task.projectId);
  const path = getTaskPath(task).map((item) => item.title).join(" / ");
  const latestStuck = getLatestTaskHistory(task.id, "stuck_note");
  return `
    <button class="doing-card" type="button" data-action="open-doing-task" data-id="${task.id}">
      <span class="doing-card-project">${escapeHtml(project?.name || "未归类")}</span>
      <strong>${escapeHtml(task.title)}</strong>
      <span class="doing-card-path">${escapeHtml(path)}</span>
      <span class="tag-row">
        <span class="tag ${task.status}">${statusLabels[task.status]}</span>
        ${renderTaskTimeTags(task)}
        ${task.valueTags.slice(0, 2).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
      </span>
      ${
        task.status === "stuck" && latestStuck
          ? `<span class="doing-card-note">卡点：${escapeHtml(latestStuck.content?.stuckPoint || "等待补充")}</span>`
          : task.nextAction
            ? `<span class="doing-card-note">下一步：${escapeHtml(task.nextAction)}</span>`
            : ""
      }
    </button>
  `;
}

function getNotesOverview() {
  const tags = unique(state.notes.flatMap((note) => note.tags || [])).sort();
  if (state.ui.noteTag && !tags.includes(state.ui.noteTag)) state.ui.noteTag = "";
  const tagCounts = tags.map((tag) => ({
    tag,
    count: state.notes.filter((note) => note.tags?.includes(tag)).length,
  }));
  const search = state.ui.noteSearch.toLowerCase();
  let notes = [...state.notes].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  if (state.ui.noteTag) notes = notes.filter((note) => (note.tags || []).includes(state.ui.noteTag));
  if (search) {
    notes = notes.filter(
      (note) =>
        note.content.toLowerCase().includes(search) ||
        (note.tags || []).some((tag) => tag.toLowerCase().includes(search))
    );
  }
  return { tags, tagCounts, notes };
}

function renderNoteComposer() {
  return `
    <div class="note-composer">
      <textarea id="noteComposer" rows="4" placeholder="写下记录，可直接使用 #标签"></textarea>
      <div class="tag-row" id="recognizedTags">
        ${
          state.ui.noteManualTags.length
            ? state.ui.noteManualTags.map((tag) => renderEditableTag(tag)).join("")
            : `<span class="muted">输入 #标签 后会自动识别</span>`
        }
      </div>
      <div class="inline-row">
        <div class="note-tag-adder">
          <input id="noteTagInput" placeholder="补充标签" />
          <button class="secondary-button" type="button" data-action="add-note-tag">添加标签</button>
        </div>
        <button class="primary-button" type="button" data-action="save-note">保存记录</button>
      </div>
    </div>
  `;
}

function renderNoteItems(notes) {
  if (!notes.length) return `<div class="empty-state">没有匹配的记录。</div>`;
  return notes
    .map(
      (note) => `
        <article class="note-item">
          <div class="note-item-meta">
            <time>${formatDateTime(note.updatedAt)}</time>
            ${renderNoteContext(note)}
          </div>
          ${note.content ? `<p>${escapeHtml(note.content)}</p>` : ""}
          ${renderNoteImages(note.images)}
          <div class="tag-row">${(note.tags || []).map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join("")}</div>
          <div class="card-actions">
            <button class="small-button" type="button" data-action="edit-note" data-id="${note.id}">编辑</button>
            <button class="small-button" type="button" data-action="delete-note" data-id="${note.id}">删除</button>
          </div>
        </article>
      `
    )
    .join("");
}

function renderNoteContext(note) {
  const task = getTask(note.taskId);
  const project = getProject(note.projectId || task?.projectId);
  if (!task && note.deletedTaskTitle) {
    return `<span class="note-context-link deleted-context">已删除任务 / ${escapeHtml(note.deletedTaskTitle)}</span>`;
  }
  if (!task) return "";
  return `<button class="note-context-link" type="button" data-action="open-note-task" data-id="${task.id}">${escapeHtml(project?.name || "任务")} / ${escapeHtml(task.title)}</button>`;
}

function renderNoteImages(images = []) {
  if (!images.length) return "";
  return `
    <div class="note-images">
      ${images
        .map(
          (image) =>
            image.dataUrl
              ? `
                <a href="${escapeHtml(image.dataUrl)}" target="_blank" rel="noreferrer" aria-label="查看图片 ${escapeHtml(image.name || "")}">
                  <img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.name || "任务记录图片")}" />
                </a>
              `
              : `<div class="note-image-loading">图片加载中</div>`
        )
        .join("")}
    </div>
  `;
}

function renderNotesPage() {
  const { tagCounts, notes } = getNotesOverview();
  els.appView.innerHTML = `
    <section class="page notebook-page">
      <header class="page-header">
        <div>
          <p class="eyebrow">Notebook</p>
          <h1>记事本</h1>
          <p>想法、情绪、资料、决策和复盘都保存在这里，用标签建立联系。</p>
        </div>
        <span class="muted">${state.notes.length} 条记录 · ${tagCounts.length} 个标签</span>
      </header>

      <div class="notebook-layout">
        <aside class="notebook-index">
          <div class="section-header">
            <div>
              <p class="eyebrow">Tags</p>
              <h2>标签总览</h2>
            </div>
          </div>
          <button class="notebook-tag ${state.ui.noteTag ? "" : "active"}" type="button" data-action="select-note-tag" data-value="">
            <span>全部记录</span>
            <strong>${state.notes.length}</strong>
          </button>
          ${
            tagCounts.length
              ? tagCounts
                  .map(
                    ({ tag, count }) => `
                      <button class="notebook-tag ${state.ui.noteTag === tag ? "active" : ""}" type="button" data-action="select-note-tag" data-value="${escapeHtml(tag)}">
                        <span>#${escapeHtml(tag)}</span>
                        <strong>${count}</strong>
                      </button>
                    `
                  )
                  .join("")
              : `<p class="notebook-index-empty">保存记录后，标签会出现在这里。</p>`
          }
        </aside>

        <div class="notebook-content">
          <section class="panel notebook-composer-panel">
            <div class="section-header">
              <div>
                <p class="eyebrow">New Note</p>
                <h2>新增记录</h2>
              </div>
            </div>
            ${renderNoteComposer()}
          </section>

          <section class="notebook-records">
            <div class="notebook-records-header">
              <div>
                <p class="eyebrow">Overview</p>
                <h2>${state.ui.noteTag ? `#${escapeHtml(state.ui.noteTag)}` : "全部记录"}</h2>
              </div>
              <input id="noteSearch" type="search" value="${escapeHtml(state.ui.noteSearch)}" placeholder="搜索正文或标签" />
            </div>
            <div class="notes-list">${renderNoteItems(notes)}</div>
          </section>
        </div>
      </div>
    </section>
  `;
}

function renderBoards() {
  const sorted = [...state.projects].sort((a, b) => {
    const todayDiff = countTodayTasks(b.id) - countTodayTasks(a.id);
    if (todayDiff !== 0) return todayDiff;
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });

  els.appView.innerHTML = `
    <section class="page">
      <header class="page-header">
        <div>
          <p class="eyebrow">Boards</p>
          <h1>总任务看板</h1>
          <p>每张看板承载一个长期项目。今日需要推进的看板会自动排在前面。</p>
        </div>
        <button class="primary-button" type="button" data-action="add-project">添加总任务看板</button>
      </header>
      <div class="boards-grid">
        ${
          sorted.length
            ? sorted.map(renderBoardCard).join("")
            : `<div class="empty-state">还没有总任务看板。</div>`
        }
      </div>
    </section>
  `;
}

function renderBoardCard(project) {
  const tasks = getProjectTasks(project.id);
  const todayCount = countTodayTasks(project.id);
  const incompleteCount = tasks.filter((task) => task.status !== "completed").length;
  const stuckCount = tasks.filter((task) => task.status === "stuck").length;
  const flagged = getTask(project.currentTaskId);
  return `
    <article class="board-card ${todayCount ? "today-active" : ""}" role="button" tabindex="0" data-action="open-project" data-id="${project.id}" aria-label="打开${escapeHtml(project.name)}">
      <div class="card-header">
        <div>
          <p class="eyebrow">${todayCount ? "Today active" : "Project"}</p>
          <h2>${escapeHtml(project.name)}</h2>
        </div>
        ${todayCount ? `<span class="count-badge">${todayCount}</span>` : ""}
      </div>
      <p class="muted">${escapeHtml(project.description || "长期任务空间")}</p>
      <div class="board-stats">
        <div class="board-stat"><span>今日任务</span><strong>${todayCount}</strong></div>
        <div class="board-stat"><span>未完成</span><strong>${incompleteCount}</strong></div>
        <div class="board-stat"><span>卡住</span><strong>${stuckCount}</strong></div>
      </div>
      ${flagged ? `<div class="flag-summary">当前任务：${escapeHtml(flagged.title)}</div>` : `<div class="muted">尚未设置当前任务</div>`}
    </article>
  `;
}

function renderDaily() {
  const todayTasks = sortDailyTasks(state.dailyBoard.todayTaskIds);
  const completedTasks = state.dailyBoard.completedTaskIds.map(getTask).filter(Boolean);
  const shouldPromptCarryover =
    state.dailyBoard.date !== TODAY &&
    todayTasks.length > 0 &&
    state.ui.carryoverPromptedFor !== TODAY;

  els.appView.innerHTML = `
    <section class="page">
      <header class="page-header">
        <div>
          <p class="eyebrow">${escapeHtml(state.dailyBoard.date)}</p>
          <h1>今日任务</h1>
          <p>只保留今天要推进和已经完成。顺序由你决定，不制造逾期压力。</p>
        </div>
        <button class="primary-button" type="button" data-action="quick-daily-task">临时添加</button>
      </header>

      ${
        state.dailyBoard.date !== TODAY && todayTasks.length
          ? `<section class="panel inline-row"><span>这里还有上次未完成的任务。</span><button class="secondary-button" type="button" data-action="review-carryover">整理一下</button></section>`
          : ""
      }

      <div class="daily-grid">
        <section class="daily-column">
          <div class="section-header">
            <h2>今天要推进</h2>
            <span class="count-badge">${todayTasks.length}</span>
          </div>
          <div class="daily-column-list">
            ${todayTasks.length ? todayTasks.map((task) => renderDailyTask(task, false)).join("") : `<div class="empty-state">今天还没有安排任务。</div>`}
          </div>
        </section>

        <section class="daily-column">
          <div class="section-header">
            <h2>已完成</h2>
            <span class="count-badge">${completedTasks.length}</span>
          </div>
          <div class="daily-column-list">
            ${completedTasks.length ? completedTasks.map((task) => renderDailyTask(task, true)).join("") : `<div class="empty-state">完成的任务会留在这里。</div>`}
          </div>
        </section>
      </div>
    </section>
  `;

  if (shouldPromptCarryover) {
    state.ui.carryoverPromptedFor = TODAY;
    saveState();
    setTimeout(openCarryoverForm, 0);
  }
}

function renderDailyTask(task, completed) {
  const project = getProject(task.projectId);
  const pinned = state.dailyBoard.pinnedTaskIds.includes(task.id);
  return `
    <article class="daily-task-card ${pinned ? "pinned" : ""}">
      <button class="icon-button" type="button" data-action="toggle-daily-pin" data-id="${task.id}" title="${pinned ? "取消置顶" : "置顶"}" aria-label="${pinned ? "取消置顶" : "置顶"}">${pinned ? "⚑" : "⚐"}</button>
      <button class="daily-task-main" type="button" data-action="open-daily-task" data-id="${task.id}">
        <span class="daily-task-heading">
          ${task.plannedTime ? `<time class="daily-task-time">${escapeHtml(task.plannedTime)}</time>` : ""}
          <span class="daily-task-title">${escapeHtml(task.title)}</span>
        </span>
        <span class="tag-row">
          <span class="tag">${escapeHtml(project?.name || "未归类")}</span>
          <span class="tag ${task.valueLevel}">${valueLabels[task.valueLevel]}</span>
          <span class="tag ${task.status}">${statusLabels[task.status]}</span>
          ${task.deadlineDate ? renderTaskTimeTags({ ...task, plannedDate: "", plannedTime: "" }) : ""}
          ${task.source === "temporary" ? `<span class="tag">临时加入</span>` : ""}
        </span>
      </button>
      <div class="order-actions">
        ${
          completed
            ? `<button class="small-button" type="button" data-action="reopen-task" data-id="${task.id}">重新打开</button>`
            : `
              <button class="icon-button" type="button" data-action="move-daily-up" data-id="${task.id}" title="上移" aria-label="上移">↑</button>
              <button class="icon-button" type="button" data-action="move-daily-down" data-id="${task.id}" title="下移" aria-label="下移">↓</button>
              <button class="small-button" type="button" data-action="complete-task" data-id="${task.id}">完成</button>
            `
        }
      </div>
    </article>
  `;
}

function renderTaskBoard(route) {
  const project = getProject(route.projectId);
  if (!project) {
    navigate("boards");
    return;
  }

  const requestedTask = getTask(route.taskId);
  const selectedTask = requestedTask?.projectId === project.id ? requestedTask : getDefaultTask(project);
  if (selectedTask) {
    state.ui.selectedTaskByProject[project.id] = selectedTask.id;
  }

  const origin = primaryRouteMeta[boardOrigin] || primaryRouteMeta.boards;
  const taskPath = selectedTask ? getTaskPath(selectedTask) : [];
  const collapsedClass = state.ui.sidebarCollapsed ? "sidebar-collapsed" : "";
  els.appView.innerHTML = `
    <section class="page taskboard-page">
      <header class="taskboard-context">
        <nav class="board-breadcrumb" aria-label="当前位置">
          <button class="breadcrumb-back" type="button" data-action="return-from-board">← ${escapeHtml(origin.label)}</button>
          <span class="breadcrumb-separator" aria-hidden="true">/</span>
          <button class="breadcrumb-project" type="button" data-action="select-project-root" data-id="${project.id}">${escapeHtml(project.name)}</button>
          ${taskPath
            .map(
              (task) =>
                task.id === selectedTask?.id
                  ? `
                <span class="breadcrumb-separator" aria-hidden="true">/</span>
                <span class="breadcrumb-task current" aria-current="page">${escapeHtml(task.title)}</span>
              `
                  : `
                <span class="breadcrumb-separator" aria-hidden="true">/</span>
                <button class="breadcrumb-task" type="button" data-action="select-task" data-id="${task.id}">${escapeHtml(task.title)}</button>
              `
            )
            .join("")}
        </nav>
        <div class="page-header">
          <div>
            <p class="eyebrow">具体任务看板</p>
            <h1>${escapeHtml(project.name)}</h1>
          </div>
          <div class="page-actions">
            <button class="secondary-button" type="button" data-action="open-activity">活动记录</button>
            <button class="primary-button" type="button" data-action="add-task" data-project-id="${project.id}">添加一级任务</button>
          </div>
        </div>
      </header>

      <div class="taskboard-layout ${collapsedClass}">
        <aside class="tree-sidebar">
          <header class="tree-sidebar-header">
            <div class="tree-sidebar-title">
              <p class="eyebrow">Navigation</p>
              <h2>任务树</h2>
            </div>
            <button class="icon-button" type="button" data-action="toggle-sidebar" title="${state.ui.sidebarCollapsed ? "展开任务树" : "折叠任务树"}" aria-label="${state.ui.sidebarCollapsed ? "展开任务树" : "折叠任务树"}">${state.ui.sidebarCollapsed ? "→" : "←"}</button>
          </header>
          <nav class="tree-nav" data-tree-root="${project.id}">
            ${
              project.topLevelTaskIds.length
                ? project.topLevelTaskIds.map((taskId) => renderTreeLine(taskId, 0, selectedTask?.id)).join("")
                : `<div class="empty-state">还没有任务。</div>`
            }
            <div class="tree-root-drop" data-tree-root-drop="${project.id}">拖到这里成为一级任务</div>
          </nav>
        </aside>

        <section class="task-canvas">
          ${
            selectedTask
              ? renderSelectedTask(project, selectedTask)
              : `
                <div class="empty-state">
                  <div>
                    <h2>从第一个任务开始</h2>
                    <p>只需要一个名称，之后再补充价值和下一步。</p>
                    <button class="primary-button" type="button" data-action="add-task" data-project-id="${project.id}">添加第一个任务</button>
                  </div>
                </div>
              `
          }
        </section>
      </div>
    </section>
  `;
}

function getTaskPath(task) {
  const path = [];
  const visited = new Set();
  let current = task;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current);
    current = current.parentId ? getTask(current.parentId) : null;
  }
  return path;
}

function getLatestTaskHistory(taskId, type) {
  return [...state.histories]
    .filter((history) => history.taskId === taskId && history.type === type)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function renderTreeLine(taskId, depth, selectedTaskId) {
  const task = getTask(taskId);
  if (!task) return "";
  const project = getProject(task.projectId);
  const hasChildren = task.childIds.length > 0;
  const completedCollapsed = task.status === "completed" && !state.ui.expandedCompletedTaskIds.includes(task.id);
  const expanded = state.ui.expandedTaskIds.includes(task.id) && !completedCollapsed;
  return `
    <div>
      <div class="tree-line ${task.id === selectedTaskId ? "active" : ""} ${project?.currentTaskId === task.id ? "flagged" : ""} ${task.status === "completed" ? "completed" : ""}" style="--depth:${depth}" draggable="true" data-tree-task-id="${task.id}">
        ${
          hasChildren
            ? `<button class="tree-toggle" type="button" data-action="${task.status === "completed" ? "toggle-completed" : "toggle-tree"}" data-id="${task.id}" aria-label="${expanded ? "折叠" : "展开"}">${expanded ? "−" : "+"}</button>`
            : `<span></span>`
        }
        <span class="drag-handle" aria-hidden="true">⋮⋮</span>
        <button class="tree-label" type="button" data-action="select-task" data-id="${task.id}">${escapeHtml(task.title)}</button>
        ${project?.currentTaskId === task.id ? `<span class="tag flagged">旗</span>` : ""}
      </div>
      ${expanded ? task.childIds.map((childId) => renderTreeLine(childId, depth + 1, selectedTaskId)).join("") : ""}
    </div>
  `;
}

function renderSelectedTask(project, task) {
  const timer = state.timer;
  const flagged = project.currentTaskId === task.id;
  const inToday = state.dailyBoard.todayTaskIds.includes(task.id);
  const latestStuck = getLatestTaskHistory(task.id, "stuck_note");
  return `
    <header class="task-heading">
      <div>
        <p class="eyebrow">${escapeHtml(project.name)}</p>
        <h1>${escapeHtml(task.title)}</h1>
        <div class="task-heading-meta">
          <span class="tag ${task.status}">${statusLabels[task.status]}</span>
          <span class="tag ${task.valueLevel}">${valueLabels[task.valueLevel]}</span>
          <span class="tag ${task.urgency}">${urgencyLabels[task.urgency]}</span>
          ${renderTaskTimeTags(task)}
          ${task.valueTags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
        </div>
      </div>
      <div class="page-actions">
        <button class="secondary-button flag-button ${flagged ? "active" : ""}" type="button" data-action="toggle-current-task" data-id="${task.id}">${flagged ? "⚑ 当前任务" : "⚐ 设为当前任务"}</button>
        <button class="secondary-button" type="button" data-action="edit-task-settings" data-id="${task.id}">任务设置</button>
        <button class="danger-button" type="button" data-action="request-delete-task" data-id="${task.id}">删除任务</button>
      </div>
    </header>

    <div class="canvas-toolbar">
      <div class="task-actions">
        <button class="secondary-button" type="button" data-action="record-progress" data-id="${task.id}">做到哪了</button>
        <button class="secondary-button" type="button" data-action="record-stuck" data-id="${task.id}">卡住了</button>
        <button class="secondary-button" type="button" data-action="add-task" data-project-id="${task.projectId}" data-parent-id="${task.id}">添加子任务</button>
        ${
          task.status === "completed"
            ? ""
            : `<button class="secondary-button" type="button" data-action="add-today" data-id="${task.id}" ${inToday ? "disabled" : ""}>${inToday ? "已在今日" : "加入今日"}</button>`
        }
        ${
          task.status === "completed"
            ? `<button class="secondary-button" type="button" data-action="record-retro" data-id="${task.id}">复盘一下</button><button class="secondary-button" type="button" data-action="reopen-task" data-id="${task.id}">重新打开</button>`
            : `<button class="primary-button" type="button" data-action="complete-task" data-id="${task.id}">完成</button>`
        }
      </div>
    </div>

    ${task.nextAction ? `<div class="flag-summary">下一步最小动作：${escapeHtml(task.nextAction)}</div>` : ""}
    ${
      task.status === "stuck"
        ? `<div class="stuck-summary"><strong>当前卡点</strong><span>${escapeHtml(latestStuck?.content?.stuckPoint || "还没有填写具体原因")}</span>${latestStuck?.content?.stuckType ? `<span class="tag stuck">${escapeHtml(latestStuck.content.stuckType)}</span>` : ""}</div>`
        : ""
    }

    ${renderTaskNotebook(project, task)}

    ${renderTimerPanel(task, timer)}
  `;
}

function renderTaskNotebook(project, task) {
  const notes = state.notes
    .filter((note) => note.taskId === task.id)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const draftImages = taskNoteDraftImages[task.id] || [];
  return `
    <section class="task-notebook">
      <header class="section-header">
        <div>
          <p class="eyebrow">Task Notes</p>
          <h2>资料与想法</h2>
        </div>
        <span class="muted">${notes.length} 条记录</span>
      </header>
      <div class="task-note-composer">
        <textarea id="taskNoteComposer" rows="5" placeholder="写下这项任务需要的资料、想法或备注，可使用 #标签"></textarea>
        <div class="task-note-fields">
          <input id="taskNoteTags" placeholder="标签，例如：资料 灵感 待确认" />
          <label class="secondary-button file-button">
            添加图片
            <input id="taskNoteImages" type="file" accept="image/*" multiple data-task-id="${task.id}" />
          </label>
          <button class="primary-button" type="button" data-action="save-task-note" data-id="${task.id}">保存记录</button>
        </div>
        <div class="task-image-drafts" id="taskImageDrafts">
          ${draftImages
            .map(
              (image) => `
                <div class="task-image-draft">
                  <img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.name)}" />
                  <button class="icon-button" type="button" data-action="remove-task-note-image" data-id="${escapeHtml(image.id)}" data-task-id="${task.id}" aria-label="移除图片">×</button>
                </div>
              `
            )
            .join("")}
        </div>
      </div>
      <div class="task-note-list">
        ${
          notes.length
            ? notes
                .map(
                  (note) => `
                    <article class="task-note-item">
                      <time>${formatDateTime(note.updatedAt)}</time>
                      ${note.content ? `<p>${escapeHtml(note.content)}</p>` : ""}
                      ${renderNoteImages(note.images)}
                      <div class="tag-row">${(note.tags || []).map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join("")}</div>
                      <div class="card-actions">
                        <button class="small-button" type="button" data-action="edit-note" data-id="${note.id}">编辑</button>
                        <button class="small-button" type="button" data-action="delete-note" data-id="${note.id}">删除</button>
                      </div>
                    </article>
                  `
                )
                .join("")
            : `<div class="empty-state task-note-empty">还没有任务记录。</div>`
        }
      </div>
    </section>
  `;
}

function renderTimerPanel(selectedTask, timer) {
  const boundTask = getTask(timer.taskId);
  const displaySeconds = getTimerRemainingSeconds();
  const canEdit = timer.status === "idle";
  return `
    <section class="timer-panel">
      <div>
        <p class="eyebrow">${timer.mode === "break" ? "Break" : "Focus"}</p>
        <div class="timer-readout" id="timerReadout">${formatDuration(displaySeconds)}</div>
        <p class="muted">${boundTask ? `正在记录：${escapeHtml(boundTask.title)}` : `准备记录：${escapeHtml(selectedTask.title)}`}</p>
      </div>
      <div>
        <div class="timer-settings">
          <div class="field">
            <label>专注分钟</label>
            <input id="focusMinutes" type="number" min="1" max="180" value="${timer.focusMinutes}" ${canEdit ? "" : "disabled"} />
          </div>
          <div class="field">
            <label>休息分钟</label>
            <input id="breakMinutes" type="number" min="1" max="60" value="${timer.breakMinutes}" ${canEdit ? "" : "disabled"} />
          </div>
        </div>
        <div class="timer-controls">
          ${
            timer.status === "running"
              ? `<button class="primary-button" type="button" data-action="pause-timer">暂停</button>`
              : `<button class="primary-button" type="button" data-action="start-timer" data-id="${selectedTask.id}">${timer.status === "paused" ? "继续" : "开始"}</button>`
          }
          <button class="secondary-button" type="button" data-action="reset-timer">重置</button>
        </div>
      </div>
    </section>
  `;
}

function renderOptions(options, selected) {
  return Object.entries(options)
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
    .join("");
}

function getTaskOptions(projectId, selectedTaskId = "") {
  const project = getProject(projectId);
  if (!project) return `<option value="">作为一级任务</option>`;
  const rows = [`<option value="" ${selectedTaskId ? "" : "selected"}>作为一级任务</option>`];
  const visit = (taskId, depth) => {
    const task = getTask(taskId);
    if (!task) return;
    rows.push(`<option value="${task.id}" ${task.id === selectedTaskId ? "selected" : ""}>${"　".repeat(depth)}${escapeHtml(task.title)}</option>`);
    task.childIds.forEach((childId) => visit(childId, depth + 1));
  };
  project.topLevelTaskIds.forEach((taskId) => visit(taskId, 0));
  return rows.join("");
}

function sortDailyTasks(taskIds) {
  const order = new Map(taskIds.map((id, index) => [id, index]));
  return taskIds
    .map(getTask)
    .filter(Boolean)
    .sort((a, b) => {
      const pinDiff = Number(state.dailyBoard.pinnedTaskIds.includes(b.id)) - Number(state.dailyBoard.pinnedTaskIds.includes(a.id));
      return pinDiff || order.get(a.id) - order.get(b.id);
    });
}

function extractTasks(inputText) {
  const text = inputText.trim();
  const items = [];
  const addTask = (data) => items.push(normalizePendingItem({ id: createId("pending"), type: "task", createdAt: nowIso(), ...data }));
  const addOther = (type, title, content, tags) =>
    items.push(
      normalizePendingItem({
        id: createId("pending"),
        type,
        title,
        content,
        rawEvidence: content,
        noteTags: tags,
        createdAt: nowIso(),
      })
    );

  if (/论文|选题|导师|文献|开题/.test(text)) {
    addTask({
      title: "明确毕业论文选题",
      suggestedProjectName: "毕业论文",
      matchedProjectId: findProjectId(["毕业论文"]),
      urgency: "this_week",
      valueLevel: "high",
      valueTags: ["高长期价值", "研究方向相关"],
      valueReason: "输入中提到论文或选题，是长期主线任务。",
      shouldAddToToday: /今天|今晚/.test(text),
      nextAction: "列出 3 个候选选题方向",
      rawEvidence: findEvidence(text, ["论文", "选题", "导师", "文献"]) || text,
    });
  }

  if (/猿辅导|实习|项目复盘|复盘/.test(text)) {
    addTask({
      title: "复盘猿辅导当前项目",
      suggestedProjectName: "猿辅导实习",
      matchedProjectId: findProjectId(["猿辅导实习", "实习"]),
      urgency: "this_week",
      valueLevel: "high",
      valueTags: ["高求职价值", "项目沉淀"],
      valueReason: "输入中提到实习复盘，和后续面试表达相关。",
      shouldAddToToday: true,
      nextAction: "整理项目背景、问题、方案、指标和反思",
      rawEvidence: findEvidence(text, ["猿辅导", "实习", "复盘"]) || text,
    });
  }

  if (/秋招|简历|面试|求职|补简历/.test(text)) {
    addTask({
      title: "补充秋招简历项目经历",
      suggestedProjectName: "秋招准备",
      matchedProjectId: findProjectId(["秋招准备", "求职"]),
      urgency: "today",
      valueLevel: "high",
      valueTags: ["高求职价值", "今天想做"],
      valueReason: "输入中明确提到简历或求职，是高优先级任务。",
      shouldAddToToday: true,
      nextAction: "补充一个项目经历段落",
      rawEvidence: findEvidence(text, ["秋招", "简历", "面试", "求职"]) || text,
    });
  }

  if (/租房|搬家|行李|续租/.test(text)) {
    addTask({
      title: "整理租房搬家事项",
      suggestedProjectName: "生活搬家",
      matchedProjectId: findProjectId(["生活搬家", "搬家"]),
      urgency: "this_month",
      valueLevel: "medium",
      valueTags: ["生活稳定"],
      valueReason: "输入中提到生活安排，适合作为独立长期看板。",
      shouldAddToToday: false,
      nextAction: "列出联系和购买清单",
      rawEvidence: findEvidence(text, ["租房", "搬家", "行李"]) || text,
    });
  }

  if (/想法|灵感|不想丢|情侣 App|情侣App/.test(text)) {
    addOther("idea", "保留一个产品想法", findEvidence(text, ["想法", "灵感", "不想丢", "情侣 App", "情侣App"]) || text, ["想法"]);
  }

  if (/乱|烦|压力|焦虑|崩溃/.test(text)) {
    addOther("emotion", "记录当前状态", findEvidence(text, ["乱", "烦", "压力", "焦虑", "崩溃"]) || text, ["情绪"]);
  }

  if (/资料|链接|文章|参考/.test(text)) {
    addOther("reference", "保存相关资料", findEvidence(text, ["资料", "链接", "文章", "参考"]) || text, ["资料"]);
  }

  if (/决定|确定|选择/.test(text)) {
    addOther("decision", "记录一个决定", findEvidence(text, ["决定", "确定", "选择"]) || text, ["决策"]);
  }

  if (!items.length) {
    addTask({
      title: text.length > 28 ? `${text.slice(0, 28)}...` : text,
      suggestedProjectName: "新的总任务看板",
      matchedProjectId: "",
      urgency: "unknown",
      valueLevel: "unknown",
      valueTags: ["待确认"],
      valueReason: "没有匹配到现有规则，先作为任务等待确认。",
      shouldAddToToday: false,
      rawEvidence: text,
    });
  }
  return items;
}

function findProjectId(names) {
  return state.projects.find((project) => names.some((name) => project.name.includes(name) || name.includes(project.name)))?.id || "";
}

function findEvidence(text, keywords) {
  const sentences = text.split(/[。！？!?；;]/).map((part) => part.trim()).filter(Boolean);
  return sentences.find((sentence) => keywords.some((keyword) => sentence.includes(keyword))) || "";
}

function otherTypeLabel(type) {
  return { idea: "想法", emotion: "情绪", reference: "资料", decision: "决策", note: "记录" }[type] || "记录";
}

function createProject(name, description = "") {
  const project = makeProject(createId("project"), name, description || `${name} 长期任务空间`);
  state.projects.push(project);
  return project;
}

function createTask({
  title,
  projectId,
  parentId = null,
  urgency = "unknown",
  valueLevel = "unknown",
  valueTags = [],
  valueReason = "",
  nextAction = "",
  source = "manual",
  rawInput = "",
  plannedDate = "",
  plannedTime = "",
  deadlineDate = "",
  deadlineTime = "",
}) {
  const task = makeTask({
    title,
    projectId,
    parentId,
    urgency,
    valueLevel,
    valueTags,
    valueReason,
    nextAction,
    source,
    rawInput,
    plannedDate,
    plannedTime,
    deadlineDate,
    deadlineTime,
  });
  state.tasks[task.id] = task;
  const project = getProject(projectId);
  if (parentId) {
    const parent = getTask(parentId);
    if (parent) {
      parent.childIds.push(task.id);
      parent.updatedAt = nowIso();
      if (!state.ui.expandedTaskIds.includes(parent.id)) state.ui.expandedTaskIds.push(parent.id);
    }
  } else {
    project.topLevelTaskIds.push(task.id);
  }
  touchProject(projectId);
  state.histories.push(makeHistory(task.id, projectId, "created", { source }));
  return task;
}

function addTaskToToday(taskId, source = "manual") {
  const task = getTask(taskId);
  if (!task) return;
  const newlyAdded = !state.dailyBoard.todayTaskIds.includes(taskId);
  task.plannedDate = TODAY;
  state.dailyBoard.completedTaskIds = state.dailyBoard.completedTaskIds.filter((id) => id !== taskId);
  if (!state.dailyBoard.todayTaskIds.includes(taskId)) state.dailyBoard.todayTaskIds.push(taskId);
  task.dailySource = source;
  task.updatedAt = nowIso();
  if (newlyAdded) state.histories.push(makeHistory(taskId, task.projectId, "today_added", { source }));
}

function syncTaskWithPlannedDate(task, source = "schedule") {
  if (!task) return;
  if (task.plannedDate === TODAY && task.status !== "completed") {
    state.dailyBoard.completedTaskIds = state.dailyBoard.completedTaskIds.filter((id) => id !== task.id);
    if (!state.dailyBoard.todayTaskIds.includes(task.id)) {
      state.dailyBoard.todayTaskIds.push(task.id);
      state.histories.push(makeHistory(task.id, task.projectId, "today_added", { source }));
    }
    return;
  }
  state.dailyBoard.todayTaskIds = state.dailyBoard.todayTaskIds.filter((id) => id !== task.id);
  state.dailyBoard.pinnedTaskIds = state.dailyBoard.pinnedTaskIds.filter((id) => id !== task.id);
}

function removePending(itemId, completionRoute = "home") {
  state.pendingAIItems = state.pendingAIItems.filter((item) => item.id !== itemId);
  if (!state.pendingAIItems.length) {
    saveState();
    navigate(completionRoute);
  }
}

function confirmPendingTask(itemId) {
  const item = state.pendingAIItems.find((entry) => entry.id === itemId);
  if (!item) return;
  let project;
  if (!item.matchedProjectId || item.matchedProjectId === "__new__") {
    if (!item.suggestedProjectName.trim()) {
      showToast("请先填写新看板名称。");
      return;
    }
    project = createProject(item.suggestedProjectName.trim());
  } else {
    project = getProject(item.matchedProjectId);
  }
  if (!project) return;

  const parent = getTask(item.matchedTaskId);
  const task = createTask({
    title: item.title,
    projectId: project.id,
    parentId: parent?.projectId === project.id ? parent.id : null,
    urgency: item.urgency,
    valueLevel: item.valueLevel,
    valueTags: item.valueTags,
    valueReason: item.valueReason,
    nextAction: item.nextAction,
    source: "ai",
    rawInput: item.rawEvidence,
  });
  if (item.shouldAddToToday) addTaskToToday(task.id, "ai");
  removePending(itemId, "boards");
  if (state.pendingAIItems.length) renderPending();
}

function confirmPendingNote(itemId) {
  const item = state.pendingAIItems.find((entry) => entry.id === itemId);
  if (!item) return;
  const content = item.content?.trim() || item.rawEvidence?.trim();
  if (!content) {
    showToast("备注内容不能为空。");
    return;
  }
  const tags = unique([...(item.noteTags || []), ...extractTags(content)]);
  const note = {
    id: createId("note"),
    content: appendMissingTags(content, tags),
    tags,
    taskId: null,
    projectId: null,
    images: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.notes.unshift(note);
  removePending(itemId, "notes");
  if (state.pendingAIItems.length) renderPending();
}

function openProject(projectId, taskId = null) {
  const project = getProject(projectId);
  if (!project) return;
  const currentRoute = getRoute();
  if (primaryRouteMeta[currentRoute.name]) boardOrigin = currentRoute.name;
  else if (currentRoute.name !== "board") boardOrigin = "boards";
  const selected = taskId ? getTask(taskId) : getDefaultTask(project);
  navigate(`board/${project.id}${selected ? `/${selected.id}` : ""}`);
}

function returnFromBoard() {
  navigate(primaryRouteMeta[boardOrigin] ? boardOrigin : "boards");
}

function selectProjectRoot(projectId) {
  const project = getProject(projectId);
  if (!project) return;
  const currentTask = getTask(getRoute().taskId);
  const rootTask = currentTask ? getTaskPath(currentTask)[0] : getTask(project.topLevelTaskIds[0]);
  navigate(`board/${project.id}${rootTask ? `/${rootTask.id}` : ""}`);
}

function goBack() {
  const route = getRoute();
  if (route.name === "board") {
    returnFromBoard();
    return;
  }
  if (route.name === "pending") {
    navigate("home");
    return;
  }
  if (window.history?.length > 1) {
    window.history.back();
    return;
  }
  navigate("home");
}

function selectTask(taskId) {
  const task = getTask(taskId);
  if (!task) return;
  state.ui.selectedTaskByProject[task.projectId] = task.id;
  navigate(`board/${task.projectId}/${task.id}`);
}

function toggleCurrentTask(taskId) {
  const task = getTask(taskId);
  const project = getProject(task?.projectId);
  if (!task || !project || task.status === "completed") {
    if (task?.status === "completed") showToast("已完成任务不能设为当前任务。");
    return;
  }
  const removing = project.currentTaskId === taskId;
  project.currentTaskId = removing ? null : taskId;
  state.histories.push(makeHistory(task.id, project.id, removing ? "unflagged" : "flagged", {}));
  touchProject(project.id);
  render();
}

function canMoveTask(taskId, newParentId) {
  const task = getTask(taskId);
  if (!task) return false;
  if (!newParentId) return true;
  const parent = getTask(newParentId);
  if (!parent || parent.projectId !== task.projectId) return false;
  if (parent.id === task.id) return false;
  return !getSubtreeIds(task.id).includes(parent.id);
}

function removeTaskFromCurrentParent(task) {
  const project = getProject(task.projectId);
  if (task.parentId) {
    const parent = getTask(task.parentId);
    if (parent) parent.childIds = parent.childIds.filter((id) => id !== task.id);
  } else if (project) {
    project.topLevelTaskIds = project.topLevelTaskIds.filter((id) => id !== task.id);
  }
}

function moveTask(taskId, newParentId = null) {
  const task = getTask(taskId);
  const project = getProject(task?.projectId);
  if (!task || !project) return false;
  const normalizedParentId = newParentId || null;
  if (task.parentId === normalizedParentId) return false;
  if (!canMoveTask(taskId, normalizedParentId)) {
    showToast("不能拖到自己或自己的子任务下面。");
    return false;
  }

  removeTaskFromCurrentParent(task);
  task.parentId = normalizedParentId;
  task.updatedAt = nowIso();
  if (normalizedParentId) {
    const parent = getTask(normalizedParentId);
    parent.childIds = unique([...(parent.childIds || []), task.id]);
    parent.updatedAt = nowIso();
    if (!state.ui.expandedTaskIds.includes(parent.id)) state.ui.expandedTaskIds.push(parent.id);
  } else {
    project.topLevelTaskIds = unique([...project.topLevelTaskIds, task.id]);
  }
  state.ui.selectedTaskByProject[project.id] = task.id;
  state.histories.push(makeHistory(task.id, project.id, "updated", { field: "parentId", parentId: normalizedParentId }));
  touchProject(project.id);
  saveState();
  render();
  return true;
}

function requestDeleteTask(taskId) {
  const task = getTask(taskId);
  if (!task) return;
  const descendantCount = Math.max(0, getSubtreeIds(taskId).length - 1);
  openChoiceDialog({
    title: "删除任务",
    eyebrow: task.title,
    choices: [
      {
        action: "confirm-delete-task",
        id: task.id,
        title: "确认删除",
        description: descendantCount
          ? `将删除它下面的 ${descendantCount} 个子任务。相关记录会保留在记事本，并标记为 #已删除任务。`
          : "相关记录会保留在记事本，并标记为 #已删除任务。",
      },
    ],
  });
}

function markNotesForDeletedTasks(taskIds, deletedTasks) {
  state.notes.forEach((note) => {
    if (!taskIds.includes(note.taskId)) return;
    const task = deletedTasks[note.taskId];
    note.deletedTaskTitle = task?.title || "已删除任务";
    note.deletedProjectName = getProject(task?.projectId)?.name || "";
    note.taskId = null;
    note.tags = unique([...(note.tags || []), "已删除任务"]);
    note.updatedAt = nowIso();
  });
}

function deleteTaskBranch(taskId) {
  const task = getTask(taskId);
  const project = getProject(task?.projectId);
  if (!task || !project) return;

  lastDeletedStateSnapshot = JSON.parse(JSON.stringify(state));
  const taskIds = getSubtreeIds(taskId);
  const deletedTasks = Object.fromEntries(taskIds.map((id) => [id, getTask(id)]).filter(([, value]) => value));
  const route = getRoute();

  markNotesForDeletedTasks(taskIds, deletedTasks);
  Object.values(state.tasks).forEach((entry) => {
    entry.childIds = (entry.childIds || []).filter((id) => !taskIds.includes(id));
  });
  project.topLevelTaskIds = project.topLevelTaskIds.filter((id) => !taskIds.includes(id));
  if (taskIds.includes(project.currentTaskId)) project.currentTaskId = null;
  taskIds.forEach((id) => delete state.tasks[id]);

  state.dailyBoard.todayTaskIds = state.dailyBoard.todayTaskIds.filter((id) => !taskIds.includes(id));
  state.dailyBoard.completedTaskIds = state.dailyBoard.completedTaskIds.filter((id) => !taskIds.includes(id));
  state.dailyBoard.pinnedTaskIds = state.dailyBoard.pinnedTaskIds.filter((id) => !taskIds.includes(id));
  state.ui.expandedTaskIds = state.ui.expandedTaskIds.filter((id) => !taskIds.includes(id));
  state.ui.expandedCompletedTaskIds = state.ui.expandedCompletedTaskIds.filter((id) => !taskIds.includes(id));
  if (state.timer.taskId && taskIds.includes(state.timer.taskId)) state.timer = makeTimerState();
  state.pendingAIItems.forEach((item) => {
    if (taskIds.includes(item.matchedTaskId)) item.matchedTaskId = "";
  });

  const fallback = getDefaultTask(project);
  state.ui.selectedTaskByProject[project.id] = fallback?.id || "";
  touchProject(project.id);
  closeForm();
  saveState();

  if (route.name === "board" && route.projectId === project.id && taskIds.includes(route.taskId)) {
    navigate(`board/${project.id}${fallback ? `/${fallback.id}` : ""}`);
  } else {
    render();
  }
  showToast("已删除任务。", "撤销", "undo-delete-task");
}

function undoDeleteTask() {
  if (!lastDeletedStateSnapshot) return;
  state = normalizeV2(lastDeletedStateSnapshot);
  lastDeletedStateSnapshot = null;
  saveState();
  render();
  showToast("已撤销删除。");
}

function requestCompleteTask(taskId) {
  const task = getTask(taskId);
  if (!task || task.status === "completed") return;
  const incompleteChildren = getIncompleteDescendants(taskId);
  if (!incompleteChildren.length) {
    completeTask(taskId, false);
    return;
  }
  openChoiceDialog({
    title: "完成任务",
    eyebrow: task.title,
    choices: [
      { action: "complete-self", id: task.id, title: "只完成当前任务", description: "未完成的子任务继续保留。" },
      { action: "complete-branch", id: task.id, title: "完成整个分支", description: `同时完成 ${incompleteChildren.length} 个子任务。` },
    ],
  });
}

function completeTask(taskId, includeBranch, deferRender = false) {
  const taskIds = includeBranch ? getSubtreeIds(taskId) : [taskId];
  taskIds.forEach((id) => {
    const task = getTask(id);
    if (!task) return;
    task.status = "completed";
    task.completedAt = nowIso();
    task.updatedAt = nowIso();
    const project = getProject(task.projectId);
    if (project?.currentTaskId === task.id) project.currentTaskId = null;
    state.histories.push(makeHistory(task.id, task.projectId, "completed", { includeBranch }));
    if (state.dailyBoard.todayTaskIds.includes(task.id)) {
      state.dailyBoard.todayTaskIds = state.dailyBoard.todayTaskIds.filter((dailyId) => dailyId !== task.id);
      if (!state.dailyBoard.completedTaskIds.includes(task.id)) state.dailyBoard.completedTaskIds.unshift(task.id);
    }
    state.dailyBoard.pinnedTaskIds = state.dailyBoard.pinnedTaskIds.filter((dailyId) => dailyId !== task.id);
    state.ui.expandedTaskIds = state.ui.expandedTaskIds.filter((expandedId) => expandedId !== task.id);
  });
  touchProject(getTask(taskId)?.projectId);
  if (!deferRender) {
    closeForm();
    render();
  }
}

function reopenTask(taskId) {
  const task = getTask(taskId);
  if (!task) return;
  task.status = "in_progress";
  task.completedAt = null;
  task.updatedAt = nowIso();
  state.histories.push(makeHistory(task.id, task.projectId, "reopened", {}));
  state.dailyBoard.completedTaskIds = state.dailyBoard.completedTaskIds.filter((id) => id !== task.id);
  touchProject(task.projectId);
  render();
}

function openForm({ kind, title, eyebrow = "FlowTree", body, submitLabel = "保存", context = {}, hideSubmit = false }) {
  activeForm = { kind, ...context };
  els.formEyebrow.textContent = eyebrow;
  els.formTitle.textContent = title;
  els.formBody.innerHTML = body;
  els.formActions.innerHTML = hideSubmit
    ? `<button class="secondary-button" type="button" data-action="close-form">关闭</button>`
    : `<button class="secondary-button" type="button" data-action="close-form">取消</button><button class="primary-button" type="submit">${escapeHtml(submitLabel)}</button>`;
  els.formModal.classList.remove("hidden");
}

function closeForm() {
  activeForm = null;
  els.recordForm.reset();
  els.formModal.classList.add("hidden");
}

function openChoiceDialog({ title, eyebrow, choices }) {
  openForm({
    kind: "choice",
    title,
    eyebrow,
    hideSubmit: true,
    body: `<div class="choice-list">${choices
      .map(
        (choice) => `
          <button class="choice-button" type="button" data-action="${choice.action}" data-id="${choice.id}">
            <strong>${escapeHtml(choice.title)}</strong>
            <small>${escapeHtml(choice.description)}</small>
          </button>
        `
      )
      .join("")}</div>`,
  });
}

function openAddProjectForm() {
  openForm({
    kind: "add-project",
    title: "添加总任务看板",
    eyebrow: "Boards",
    submitLabel: "创建并进入",
    body: `<div class="field"><label for="projectName">看板名称</label><input id="projectName" name="name" required autofocus placeholder="例如：毕业论文" /></div>`,
  });
}

function openQuickDoingForm() {
  const projectOptions = state.projects
    .map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`)
    .join("");
  openForm({
    kind: "quick-doing",
    title: "添加正在做任务",
    eyebrow: "In Progress",
    submitLabel: "添加并插旗",
    body: `
      <div class="field"><label>任务名称</label><input name="title" required autofocus placeholder="现在要推进什么？" /></div>
      <div class="field">
        <label>所属总任务看板</label>
        <select name="projectId" required>
          ${projectOptions}
          <option value="__new__">+ 新建总任务看板</option>
        </select>
      </div>
      <div class="field"><label>新看板名称（选择新建时填写）</label><input name="newProjectName" placeholder="例如：秋招准备" /></div>
      <label class="inline-row"><span>同时加入今日任务</span><input name="addToday" type="checkbox" checked style="width:auto" /></label>
      <details class="time-details">
        <summary>安排时间（可选）</summary>
        ${renderScheduleFields()}
      </details>
    `,
  });
}

function openAddTaskForm(projectId, parentId = null, fromProjectCreation = false) {
  const project = getProject(projectId);
  const parent = getTask(parentId);
  openForm({
    kind: "add-task",
    title: parent ? "添加子任务" : "添加一级任务",
    eyebrow: parent?.title || project?.name || "Task",
    submitLabel: "添加",
    context: { projectId, parentId, fromProjectCreation },
    body: `
      <div class="field"><label for="taskName">任务名称</label><input id="taskName" name="title" required autofocus placeholder="只需要先写名称" /></div>
      <details class="time-details">
        <summary>安排时间（可选）</summary>
        ${renderScheduleFields()}
      </details>
    `,
  });
}

function openProgressForm(taskId) {
  const task = getTask(taskId);
  if (!task) return;
  openForm({
    kind: "progress",
    title: "做到哪了",
    eyebrow: task.title,
    context: { taskId },
    body: `
      <div class="field"><label for="doneText">这次完成了什么？</label><textarea id="doneText" name="done" rows="4" required></textarea></div>
      <div class="field"><label for="nextAction">下一步最小动作</label><input id="nextAction" name="nextAction" value="${escapeHtml(task.nextAction)}" /></div>
      <label class="inline-row"><span>将下一步创建为子任务并自动插旗</span><input name="createChild" type="checkbox" style="width:auto" /></label>
    `,
  });
}

function openStuckForm(taskId) {
  const task = getTask(taskId);
  if (!task) return;
  openForm({
    kind: "stuck",
    title: "卡住了",
    eyebrow: task.title,
    context: { taskId },
    body: `
      <div class="field"><label for="stuckPoint">我卡在哪里？</label><textarea id="stuckPoint" name="stuckPoint" rows="4" required></textarea></div>
      <div class="field"><label for="stuckType">卡住类型</label><select id="stuckType" name="stuckType"><option>不知道下一步</option><option>信息太多</option><option>害怕做不好</option><option>缺资料</option><option>等别人反馈</option><option>没精力</option><option>其他</option></select></div>
    `,
  });
}

function openRetroForm(taskId) {
  const task = getTask(taskId);
  if (!task || task.status !== "completed") return;
  openForm({
    kind: "retro",
    title: "复盘一下",
    eyebrow: task.title,
    context: { taskId },
    body: `
      <div class="field"><label for="happened">这次发生了什么？</label><textarea id="happened" name="happened" rows="3" required></textarea></div>
      <div class="field"><label for="difficult">哪里比想象中难？</label><textarea id="difficult" name="difficult" rows="3"></textarea></div>
      <div class="field"><label for="learned">我学到了什么？</label><textarea id="learned" name="learned" rows="3"></textarea></div>
      <div class="field"><label for="next">下次可以怎么做？</label><textarea id="next" name="next" rows="3"></textarea></div>
    `,
  });
}

function openTaskSettingsForm(taskId) {
  const task = getTask(taskId);
  if (!task) return;
  openForm({
    kind: "task-meta",
    title: "任务设置",
    eyebrow: task.title,
    context: { taskId },
    body: `
      <section class="settings-section">
        <div>
          <p class="eyebrow">Basic</p>
          <h3>任务名称</h3>
        </div>
        <div class="field"><label>任务名称</label><input name="title" value="${escapeHtml(task.title)}" required /></div>
      </section>
      <section class="settings-section">
        <div>
          <p class="eyebrow">Schedule</p>
          <h3>时间安排</h3>
        </div>
        ${renderScheduleFields(task)}
      </section>
      <section class="settings-section">
        <div>
          <p class="eyebrow">Priority</p>
          <h3>价值与紧急程度</h3>
        </div>
      <div class="field-grid">
        <div class="field"><label>价值</label><select name="valueLevel">${renderOptions(valueLabels, task.valueLevel)}</select></div>
        <div class="field"><label>紧急程度</label><select name="urgency">${renderOptions(urgencyLabels, task.urgency)}</select></div>
      </div>
      <div class="field"><label>价值标签，用空格分隔</label><input name="valueTags" value="${escapeHtml(task.valueTags.join(" "))}" /></div>
      <div class="field"><label>AI 判断理由</label><textarea name="valueReason" rows="3">${escapeHtml(task.valueReason)}</textarea></div>
      </section>
    `,
  });
}

function renderScheduleFields(task = {}) {
  return `
    <div class="schedule-fields">
      <div class="field">
        <label for="plannedDate">计划日期</label>
        <input id="plannedDate" name="plannedDate" type="date" value="${escapeHtml(task.plannedDate || "")}" />
        <div class="date-presets">
          <button class="small-button" type="button" data-action="set-date-preset" data-field="plannedDate" data-value="">未安排</button>
          <button class="small-button" type="button" data-action="set-date-preset" data-field="plannedDate" data-value="${TODAY}">今天</button>
          <button class="small-button" type="button" data-action="set-date-preset" data-field="plannedDate" data-value="${dateOffset(TODAY, 1)}">明天</button>
        </div>
      </div>
      <div class="field">
        <label for="plannedTime">具体时间（可选）</label>
        <input id="plannedTime" name="plannedTime" type="time" value="${escapeHtml(task.plannedTime || "")}" />
      </div>
      <div class="field">
        <label for="deadlineDate">截止日期（可选）</label>
        <input id="deadlineDate" name="deadlineDate" type="date" value="${escapeHtml(task.deadlineDate || "")}" />
      </div>
      <div class="field">
        <label for="deadlineTime">截止时间（可选）</label>
        <input id="deadlineTime" name="deadlineTime" type="time" value="${escapeHtml(task.deadlineTime || "")}" />
      </div>
    </div>
    <p class="field-hint">计划日期决定任务什么时候出现；截止日期只提示最晚完成时间。</p>
  `;
}

function openQuickDailyForm() {
  openForm({
    kind: "quick-daily",
    title: "临时添加今日任务",
    eyebrow: "Today",
    submitLabel: "添加到今天",
    body: `
      <div class="field"><label>总任务看板</label><select name="projectId" required>${state.projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join("")}</select></div>
      <div class="field"><label>任务名称</label><input name="title" required autofocus /></div>
    `,
  });
}

function openCarryoverForm() {
  const tasks = state.dailyBoard.todayTaskIds.map(getTask).filter((task) => task && task.status !== "completed");
  openForm({
    kind: "carryover",
    title: "整理上次未完成任务",
    eyebrow: state.dailyBoard.date,
    submitLabel: "完成整理",
    body: `
      <p class="muted">没有逾期。只决定这些任务今天是否继续出现。</p>
      <div class="carryover-list">
        ${tasks
          .map(
            (task) => `
              <div class="carryover-row">
                <span>${escapeHtml(task.title)}</span>
                <select name="carry_${task.id}">
                  <option value="keep">继续保留</option>
                  <option value="remove">移出今日</option>
                  <option value="complete">标记完成</option>
                </select>
              </div>
            `
          )
          .join("")}
      </div>
    `,
  });
}

function handleFormSubmit(event) {
  event.preventDefault();
  if (!activeForm) return;
  const data = new FormData(els.recordForm);

  if (activeForm.kind === "add-project") {
    const name = String(data.get("name") || "").trim();
    if (!name) return;
    const project = createProject(name);
    closeForm();
    openProject(project.id);
    setTimeout(() => openAddTaskForm(project.id, null, true), 0);
    return;
  }

  if (activeForm.kind === "add-task") {
    const title = String(data.get("title") || "").trim();
    if (!title) return;
    const schedule = getScheduleFromForm(data);
    if (!validateSchedule(schedule)) return;
    const task = createTask({
      title,
      projectId: activeForm.projectId,
      parentId: activeForm.parentId,
      source: "manual",
      ...schedule,
    });
    syncTaskWithPlannedDate(task, "manual_schedule");
    closeForm();
    selectTask(task.id);
    return;
  }

  if (activeForm.kind === "quick-doing") {
    const title = String(data.get("title") || "").trim();
    if (!title) return;
    let project = null;
    if (data.get("projectId") === "__new__") {
      const name = String(data.get("newProjectName") || "").trim();
      if (!name) {
        showToast("请填写新看板名称。");
        return;
      }
      project = createProject(name);
    } else {
      project = getProject(String(data.get("projectId") || ""));
    }
    if (!project) {
      showToast("请先选择所属看板。");
      return;
    }
    const schedule = getScheduleFromForm(data);
    if (!validateSchedule(schedule)) return;
    const task = createTask({
      title,
      projectId: project.id,
      source: "doing",
      ...schedule,
    });
    task.status = "in_progress";
    task.updatedAt = nowIso();
    project.currentTaskId = task.id;
    state.histories.push(makeHistory(task.id, project.id, "flagged", { source: "doing_quick_add" }));
    syncTaskWithPlannedDate(task, "doing_schedule");
    if (data.get("addToday")) addTaskToToday(task.id, "doing_quick_add");
    touchProject(project.id);
    closeForm();
    navigate("doing");
    return;
  }

  if (activeForm.kind === "progress") {
    const task = getTask(activeForm.taskId);
    if (!task) return;
    const done = String(data.get("done") || "").trim();
    const nextAction = String(data.get("nextAction") || "").trim();
    task.status = "in_progress";
    task.nextAction = nextAction;
    task.updatedAt = nowIso();
    state.histories.push(makeHistory(task.id, task.projectId, "progress_note", { done, nextAction }));
    if (data.get("createChild") && nextAction) {
      const child = createTask({ title: nextAction, projectId: task.projectId, parentId: task.id, source: "progress" });
      const project = getProject(task.projectId);
      project.currentTaskId = child.id;
      state.histories.push(makeHistory(child.id, child.projectId, "flagged", { source: "progress" }));
    }
    touchProject(task.projectId);
    closeForm();
    render();
    return;
  }

  if (activeForm.kind === "stuck") {
    const task = getTask(activeForm.taskId);
    if (!task) return;
    task.status = "stuck";
    task.updatedAt = nowIso();
    state.histories.push(
      makeHistory(task.id, task.projectId, "stuck_note", {
        stuckPoint: String(data.get("stuckPoint") || "").trim(),
        stuckType: data.get("stuckType"),
      })
    );
    touchProject(task.projectId);
    closeForm();
    render();
    return;
  }

  if (activeForm.kind === "retro") {
    const task = getTask(activeForm.taskId);
    if (!task) return;
    state.histories.push(
      makeHistory(task.id, task.projectId, "retrospective", {
        happened: String(data.get("happened") || "").trim(),
        difficult: String(data.get("difficult") || "").trim(),
        learned: String(data.get("learned") || "").trim(),
        next: String(data.get("next") || "").trim(),
      })
    );
    closeForm();
    render();
    return;
  }

  if (activeForm.kind === "task-meta") {
    const task = getTask(activeForm.taskId);
    if (!task) return;
    const title = String(data.get("title") || "").trim();
    if (!title) {
      showToast("任务名称不能为空。");
      return;
    }
    const schedule = getScheduleFromForm(data);
    if (!validateSchedule(schedule)) return;
    const titleChanged = title !== task.title;
    task.title = title;
    task.valueLevel = data.get("valueLevel");
    task.urgency = data.get("urgency");
    task.valueTags = String(data.get("valueTags") || "").split(/\s+/).filter(Boolean);
    task.valueReason = String(data.get("valueReason") || "").trim();
    Object.assign(task, schedule);
    syncTaskWithPlannedDate(task);
    task.updatedAt = nowIso();
    if (titleChanged) state.histories.push(makeHistory(task.id, task.projectId, "updated", { field: "title" }));
    touchProject(task.projectId);
    closeForm();
    render();
    return;
  }

  if (activeForm.kind === "quick-daily") {
    const projectId = data.get("projectId");
    const title = String(data.get("title") || "").trim();
    if (!title || !getProject(projectId)) return;
    const task = createTask({ title, projectId, source: "temporary" });
    addTaskToToday(task.id, "temporary");
    closeForm();
    render();
    return;
  }

  if (activeForm.kind === "carryover") {
    [...state.dailyBoard.todayTaskIds].forEach((taskId) => {
      const decision = data.get(`carry_${taskId}`);
      if (decision === "remove") {
        state.dailyBoard.todayTaskIds = state.dailyBoard.todayTaskIds.filter((id) => id !== taskId);
        state.dailyBoard.pinnedTaskIds = state.dailyBoard.pinnedTaskIds.filter((id) => id !== taskId);
      }
      if (decision === "complete") completeTask(taskId, false, true);
    });
    state.dailyBoard.date = TODAY;
    closeForm();
    render();
    return;
  }

  if (activeForm.kind === "edit-note") {
    const note = state.notes.find((entry) => entry.id === activeForm.noteId);
    if (!note) return;
    const content = String(data.get("content") || "").trim();
    if (!content && !note.images?.length) {
      showToast("记录内容不能为空。");
      return;
    }
    const tags = unique([
      ...extractTags(content),
      ...String(data.get("tags") || "")
        .split(/\s+/)
        .map((tag) => tag.replace(/^#/, ""))
        .filter(Boolean),
    ]);
    note.content = appendMissingTags(content, tags);
    note.tags = tags;
    note.updatedAt = nowIso();
    closeForm();
    saveState();
    refreshNotesSurface();
  }
}

function openActivityDrawer() {
  const route = getRoute();
  if (route.name !== "board") return;
  els.activityDrawer.classList.remove("hidden");
  els.drawerScrim.classList.remove("hidden");
  renderActivityDrawer();
}

function closeActivityDrawer(hideScrim = true) {
  els.activityDrawer.classList.add("hidden");
  if (hideScrim && els.notesDrawer.classList.contains("hidden")) els.drawerScrim.classList.add("hidden");
}

function renderActivityDrawer() {
  const route = getRoute();
  const project = getProject(route.projectId);
  const selectedTask = getTask(route.taskId) || getDefaultTask(project);
  if (!project) return;
  const scopeIds =
    state.ui.activityScope === "project"
      ? new Set(getProjectTasks(project.id).map((task) => task.id))
      : new Set(getSubtreeIds(selectedTask?.id));
  const filter = state.ui.activityFilter;
  const histories = state.histories
    .filter((history) => scopeIds.has(history.taskId))
    .filter((history) => filter === "all" || activityGroup(history.type) === filter)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  els.activityDrawerBody.innerHTML = `
    <div class="segmented">
      <button class="${state.ui.activityScope === "subtree" ? "active" : ""}" type="button" data-action="activity-scope" data-value="subtree">当前任务树</button>
      <button class="${state.ui.activityScope === "project" ? "active" : ""}" type="button" data-action="activity-scope" data-value="project">整个看板</button>
    </div>
    <div class="segmented" style="margin-top:10px">
      ${[
        ["all", "全部"],
        ["progress", "进展"],
        ["stuck", "卡住"],
        ["retro", "复盘"],
      ]
        .map(([value, label]) => `<button class="${filter === value ? "active" : ""}" type="button" data-action="activity-filter" data-value="${value}">${label}</button>`)
        .join("")}
    </div>
    <div class="activity-list">
      ${
        histories.length
          ? histories.map(renderActivityItem).join("")
          : `<div class="empty-state">当前范围还没有活动记录。</div>`
      }
    </div>
  `;
}

function renderActivityItem(history) {
  const task = getTask(history.taskId);
  return `
    <article class="activity-item">
      <time>${formatDateTime(history.createdAt)}</time>
      <strong>${escapeHtml(task?.title || "任务")} · ${escapeHtml(historyLabels[history.type] || history.type)}</strong>
      <p class="muted">${escapeHtml(historyText(history))}</p>
    </article>
  `;
}

function activityGroup(type) {
  if (type === "progress_note" || type === "pomodoro") return "progress";
  if (type === "stuck_note") return "stuck";
  if (type === "retrospective") return "retro";
  return "other";
}

function historyText(history) {
  const content = history.content || {};
  if (history.type === "progress_note") return `完成：${content.done || "未填写"}；下一步：${content.nextAction || "待决定"}`;
  if (history.type === "stuck_note") return `${content.stuckPoint || "未填写"}；${content.stuckType || "其他"}`;
  if (history.type === "retrospective") return `发生了：${content.happened || "未填写"}；学到：${content.learned || "未填写"}；下次：${content.next || "待决定"}`;
  if (history.type === "pomodoro") return `完成 ${content.minutes || 0} 分钟专注`;
  if (history.type === "today_added") return "加入今天要推进";
  if (history.type === "created") return `来源：${content.source || "手动添加"}`;
  return Object.values(content).filter((value) => value !== "").join("；") || historyLabels[history.type] || "";
}

function openNotesDrawer() {
  els.notesDrawer.classList.remove("hidden");
  els.drawerScrim.classList.remove("hidden");
  renderNotesDrawer();
}

function closeNotesDrawer() {
  els.notesDrawer.classList.add("hidden");
  if (els.activityDrawer.classList.contains("hidden")) els.drawerScrim.classList.add("hidden");
}

function renderNotesDrawer() {
  const { tags, notes } = getNotesOverview();

  els.notesDrawerBody.innerHTML = `
    ${renderNoteComposer()}
    <div class="note-toolbar" style="margin-top:14px">
      <div class="segmented">
        <button class="${state.ui.notesView === "all" ? "active" : ""}" type="button" data-action="notes-view" data-value="all">全部备注</button>
        <button class="${state.ui.notesView === "tags" ? "active" : ""}" type="button" data-action="notes-view" data-value="tags">按标签</button>
      </div>
      <input id="noteSearch" type="search" value="${escapeHtml(state.ui.noteSearch)}" placeholder="搜索正文或标签" style="width:190px" />
    </div>
    ${
      state.ui.notesView === "tags"
        ? `
          <div class="tag-cloud">
            <button class="small-button tag-filter" type="button" data-action="select-note-tag" data-value="">全部标签</button>
            ${tags.map((tag) => `<button class="small-button tag-filter ${state.ui.noteTag === tag ? "active" : ""}" type="button" data-action="select-note-tag" data-value="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`).join("")}
          </div>
        `
        : ""
    }
    <div class="notes-list">${renderNoteItems(notes)}</div>
  `;
}

function refreshNotesSurface(focusSearch = false) {
  const route = getRoute();
  if (route.name === "notes") renderNotesPage();
  if (route.name === "board") renderTaskBoard(route);
  if (!els.notesDrawer.classList.contains("hidden")) renderNotesDrawer();
  if (focusSearch) {
    const searchInput = document.querySelector("#noteSearch");
    searchInput?.focus();
    searchInput?.setSelectionRange(searchInput.value.length, searchInput.value.length);
  }
}

function extractTags(content) {
  const tags = [];
  const regex = /#([^\s#，。！？；：,.!?;:]+)/g;
  let match;
  while ((match = regex.exec(content))) tags.push(match[1]);
  return unique(tags);
}

function appendMissingTags(content, tags) {
  const existing = new Set(extractTags(content));
  const suffix = tags.filter((tag) => !existing.has(tag)).map((tag) => `#${tag}`).join(" ");
  return suffix ? `${content}\n${suffix}` : content;
}

function saveNoteFromComposer() {
  const composer = document.querySelector("#noteComposer");
  const content = composer?.value.trim();
  if (!content) {
    showToast("先写一点内容。");
    return;
  }
  const tags = unique([...extractTags(content), ...state.ui.noteManualTags]);
  const note = {
    id: createId("note"),
    content: appendMissingTags(content, tags),
    tags,
    taskId: null,
    projectId: null,
    images: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.notes.unshift(note);
  state.ui.noteManualTags = [];
  saveState();
  refreshNotesSurface();
}

function renderEditableTag(tag) {
  return `<button class="tag editable-tag" type="button" data-action="remove-note-tag" data-value="${escapeHtml(tag)}">#${escapeHtml(tag)} ×</button>`;
}

function updateRecognizedTags() {
  const composer = document.querySelector("#noteComposer");
  const container = document.querySelector("#recognizedTags");
  if (!container) return;
  const tags = unique([...extractTags(composer?.value || ""), ...state.ui.noteManualTags]);
  container.innerHTML = tags.length
    ? tags.map((tag) => renderEditableTag(tag)).join("")
    : `<span class="muted">输入 #标签 后会自动识别</span>`;
}

function editNote(noteId) {
  const note = state.notes.find((entry) => entry.id === noteId);
  if (!note) return;
  openForm({
    kind: "edit-note",
    title: "编辑记录",
    eyebrow: formatDateTime(note.createdAt),
    context: { noteId },
    body: `
      <div class="field"><label>正文</label><textarea name="content" rows="7">${escapeHtml(note.content)}</textarea></div>
      <div class="field"><label>标签，用空格分隔</label><input name="tags" value="${escapeHtml((note.tags || []).join(" "))}" /></div>
      ${note.images?.length ? `<div class="field"><label>已附图片</label>${renderNoteImages(note.images)}</div>` : ""}
    `,
  });
}

async function saveTaskNote(taskId) {
  const task = getTask(taskId);
  if (!task) return;
  const content = document.querySelector("#taskNoteComposer")?.value.trim() || "";
  const tagInput = document.querySelector("#taskNoteTags")?.value || "";
  const draftImages = taskNoteDraftImages[taskId] || [];
  if (!content && !draftImages.length) {
    showToast("先写一点内容或添加图片。");
    return;
  }
  let images = draftImages;
  if (cloudReady && draftImages.length) {
    showToast("正在上传图片...");
    try {
      images = await uploadTaskNoteImages(taskId, draftImages);
    } catch (error) {
      console.warn("Task note images could not be uploaded", error);
      showToast("图片上传失败，记录尚未保存。");
      return;
    }
  }
  const tags = unique([
    ...extractTags(content),
    ...tagInput
      .split(/\s+/)
      .map((tag) => tag.replace(/^#/, "").trim())
      .filter(Boolean),
  ]);
  const createdAt = nowIso();
  const note = {
    id: createId("note"),
    content: appendMissingTags(content, tags),
    tags,
    taskId: task.id,
    projectId: task.projectId,
    images,
    createdAt,
    updatedAt: createdAt,
  };
  state.notes.unshift(note);
  taskNoteDraftImages[taskId] = [];
  if (!saveState()) {
    state.notes = state.notes.filter((entry) => entry.id !== note.id);
    taskNoteDraftImages[taskId] = draftImages;
    return;
  }
  showToast(cloudReady ? "记录已保存，正在同步。" : "记录已保存。");
  render();
}

async function addTaskNoteImages(taskId, files) {
  const existing = taskNoteDraftImages[taskId] || [];
  const available = Math.max(0, 4 - existing.length);
  if (!available) {
    showToast("一条记录最多添加 4 张图片。");
    return;
  }
  const selected = [...files].filter((file) => file.type.startsWith("image/")).slice(0, available);
  const images = [];
  for (const file of selected) {
    if (file.size > 10 * 1024 * 1024) {
      showToast(`${file.name} 超过 10MB，未添加。`);
      continue;
    }
    try {
      images.push({
        id: createId("image"),
        name: file.name,
        dataUrl: await compressImageFile(file),
      });
    } catch (error) {
      console.warn("Image could not be added", error);
      showToast(`${file.name} 无法读取。`);
    }
  }
  taskNoteDraftImages[taskId] = [...existing, ...images];
  render();
}

function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const maxSide = 1200;
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function getTimerRemainingSeconds() {
  if (state.timer.status === "running" && state.timer.endAt) {
    return Math.max(0, Math.ceil((new Date(state.timer.endAt).getTime() - Date.now()) / 1000));
  }
  return Math.max(0, Number(state.timer.remainingSeconds || 0));
}

function startTimer(taskId) {
  const selectedTask = getTask(taskId);
  if (!selectedTask) return;
  const timer = state.timer;
  if (timer.status === "paused" && timer.taskId && timer.taskId !== selectedTask.id) {
    showToast(`计时仍绑定在“${getTask(timer.taskId)?.title || "原任务"}”。请先重置。`);
    return;
  }
  if (timer.status === "idle") {
    timer.mode = "focus";
    timer.taskId = selectedTask.id;
    timer.projectId = selectedTask.projectId;
    timer.remainingSeconds = timer.focusMinutes * 60;
    timer.startedAt = nowIso();
  }
  timer.status = "running";
  timer.endAt = new Date(Date.now() + timer.remainingSeconds * 1000).toISOString();
  saveState();
  render();
  ensureTimerInterval();
}

function pauseTimer() {
  if (state.timer.status !== "running") return;
  state.timer.remainingSeconds = getTimerRemainingSeconds();
  state.timer.status = "paused";
  state.timer.endAt = null;
  saveState();
  render();
}

function resetTimer() {
  const focusMinutes = state.timer.focusMinutes;
  const breakMinutes = state.timer.breakMinutes;
  state.timer = { ...makeTimerState(), focusMinutes, breakMinutes, remainingSeconds: focusMinutes * 60 };
  saveState();
  render();
}

function startBreak() {
  state.timer.mode = "break";
  state.timer.status = "running";
  state.timer.remainingSeconds = state.timer.breakMinutes * 60;
  state.timer.endAt = new Date(Date.now() + state.timer.remainingSeconds * 1000).toISOString();
  closeForm();
  saveState();
  render();
  ensureTimerInterval();
}

function skipBreak() {
  const focusMinutes = state.timer.focusMinutes;
  const breakMinutes = state.timer.breakMinutes;
  state.timer = { ...makeTimerState(), focusMinutes, breakMinutes, remainingSeconds: focusMinutes * 60 };
  closeForm();
  saveState();
  render();
}

function finishTimerPhase() {
  const timer = state.timer;
  if (timer.mode === "focus") {
    const task = getTask(timer.taskId);
    if (task) {
      state.histories.push(makeHistory(task.id, task.projectId, "pomodoro", { minutes: timer.focusMinutes }));
      task.updatedAt = nowIso();
      touchProject(task.projectId);
    }
    timer.status = "paused";
    timer.mode = "break";
    timer.remainingSeconds = timer.breakMinutes * 60;
    timer.endAt = null;
    saveState();
    openChoiceDialog({
      title: "专注完成",
      eyebrow: task?.title || "番茄钟",
      choices: [
        { action: "start-break", id: "", title: "开始休息", description: `${timer.breakMinutes} 分钟休息倒计时。` },
        { action: "skip-break", id: "", title: "跳过休息", description: "结束本轮计时。" },
      ],
    });
  } else {
    showToast("休息结束。");
    skipBreak();
  }
}

function ensureTimerInterval() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (state.timer.status !== "running") return;
    const remaining = getTimerRemainingSeconds();
    const readout = document.querySelector("#timerReadout");
    if (readout) readout.textContent = formatDuration(remaining);
    updateHeaderTimer();
    if (remaining <= 0) finishTimerPhase();
  }, 1000);
}

function updateHeaderTimer() {
  const timer = state.timer;
  const task = getTask(timer.taskId);
  const visible = timer.status === "running" || timer.status === "paused";
  els.headerTimer.classList.toggle("hidden", !visible);
  if (visible) {
    els.headerTimer.textContent = `${timer.status === "running" ? "●" : "Ⅱ"} ${formatDuration(getTimerRemainingSeconds())} · ${task?.title || "番茄钟"}`;
  }
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds || 0));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function dateOffset(dateString, days) {
  const date = new Date(`${dateString}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function getScheduleFromForm(data) {
  const plannedDate = String(data.get("plannedDate") || "");
  const deadlineDate = String(data.get("deadlineDate") || "");
  return {
    plannedDate,
    plannedTime: plannedDate ? String(data.get("plannedTime") || "") : "",
    deadlineDate,
    deadlineTime: deadlineDate ? String(data.get("deadlineTime") || "") : "",
  };
}

function validateSchedule(schedule) {
  if (!schedule.plannedDate || !schedule.deadlineDate) return true;
  const planned = `${schedule.plannedDate}T${schedule.plannedTime || "00:00"}`;
  const deadline = `${schedule.deadlineDate}T${schedule.deadlineTime || "23:59"}`;
  if (deadline >= planned) return true;
  showToast("截止时间不能早于计划时间。");
  return false;
}

function formatShortDate(dateString) {
  if (!dateString) return "";
  if (dateString === TODAY) return "今天";
  if (dateString === dateOffset(TODAY, 1)) return "明天";
  const date = new Date(`${dateString}T12:00:00`);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function isTaskOverdue(task) {
  if (!task.deadlineDate || task.status === "completed") return false;
  const deadline = new Date(`${task.deadlineDate}T${task.deadlineTime || "23:59"}:00`);
  return deadline.getTime() < Date.now();
}

function renderTaskTimeTags(task) {
  const tags = [];
  if (task.plannedDate) {
    tags.push(
      `<span class="tag schedule">计划 ${escapeHtml(formatShortDate(task.plannedDate))}${task.plannedTime ? ` ${escapeHtml(task.plannedTime)}` : ""}</span>`
    );
  }
  if (task.deadlineDate) {
    tags.push(
      `<span class="tag deadline ${isTaskOverdue(task) ? "overdue" : ""}">${isTaskOverdue(task) ? "已超期 " : "截止 "}${escapeHtml(formatShortDate(task.deadlineDate))}${task.deadlineTime ? ` ${escapeHtml(task.deadlineTime)}` : ""}</span>`
    );
  }
  return tags.join("");
}

function formatDateTime(value) {
  const date = new Date(value);
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function showToast(message, actionLabel = "", action = "") {
  clearTimeout(toastTimer);
  els.toast.innerHTML = `
    <span>${escapeHtml(message)}</span>
    ${actionLabel && action ? `<button type="button" data-action="${escapeHtml(action)}">${escapeHtml(actionLabel)}</button>` : ""}
  `;
  els.toast.classList.remove("hidden");
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2600);
}

function moveDailyTask(taskId, direction) {
  const ids = state.dailyBoard.todayTaskIds;
  const index = ids.indexOf(taskId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  render();
}

function clearTreeDropTargets() {
  document.querySelectorAll(".tree-line.drag-over, .tree-root-drop.drag-over").forEach((element) => {
    element.classList.remove("drag-over");
  });
}

function getValidTreeDropTarget(event) {
  if (!draggedTaskId) return null;
  const draggedTask = getTask(draggedTaskId);
  const targetLine = event.target.closest?.("[data-tree-task-id]");
  if (targetLine) {
    const parentId = targetLine.dataset.treeTaskId;
    return canMoveTask(draggedTaskId, parentId) ? { element: targetLine, parentId } : null;
  }
  const rootDrop = event.target.closest?.("[data-tree-root-drop]");
  if (rootDrop && draggedTask?.projectId === rootDrop.dataset.treeRootDrop && canMoveTask(draggedTaskId, null)) {
    return { element: rootDrop, parentId: null };
  }
  return null;
}

function handleDragStart(event) {
  const line = event.target.closest?.("[data-tree-task-id]");
  if (!line) return;
  draggedTaskId = line.dataset.treeTaskId;
  line.classList.add("dragging");
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedTaskId);
  }
}

function handleDragOver(event) {
  const target = getValidTreeDropTarget(event);
  clearTreeDropTargets();
  if (!target) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  target.element.classList.add("drag-over");
}

function handleDrop(event) {
  const target = getValidTreeDropTarget(event);
  clearTreeDropTargets();
  if (!target || !draggedTaskId) return;
  event.preventDefault();
  moveTask(draggedTaskId, target.parentId);
  draggedTaskId = null;
}

function handleDragEnd() {
  draggedTaskId = null;
  document.querySelectorAll(".tree-line.dragging").forEach((element) => element.classList.remove("dragging"));
  clearTreeDropTargets();
}

function openTaskContextMenu(taskId, x, y) {
  const task = getTask(taskId);
  if (!task || !els.taskContextMenu) return;
  els.taskContextMenu.innerHTML = `
    <button type="button" data-action="select-task" data-id="${task.id}" role="menuitem">打开</button>
    <button type="button" data-action="add-task" data-project-id="${task.projectId}" data-parent-id="${task.id}" role="menuitem">添加子任务</button>
    <button type="button" data-action="edit-task-settings" data-id="${task.id}" role="menuitem">任务设置</button>
    <button class="danger" type="button" data-action="request-delete-task" data-id="${task.id}" role="menuitem">删除任务</button>
  `;
  els.taskContextMenu.style.left = `${Math.min(x, window.innerWidth - 190)}px`;
  els.taskContextMenu.style.top = `${Math.min(y, window.innerHeight - 190)}px`;
  els.taskContextMenu.classList.remove("hidden");
}

function closeTaskContextMenu() {
  els.taskContextMenu?.classList.add("hidden");
}

function handleContextMenu(event) {
  const line = event.target.closest?.("[data-tree-task-id]");
  if (!line) return;
  event.preventDefault();
  openTaskContextMenu(line.dataset.treeTaskId, event.clientX, event.clientY);
}

async function handleAction(action, trigger) {
  const id = trigger.dataset.id;
  if (action === "go-back") goBack();
  if (action === "navigate-route") navigate(trigger.dataset.value || "home");
  if (action === "fill-sample") {
    state.draft = sampleInput;
    saveState();
    renderHome();
  }
  if (action === "reuse-input") {
    const recent = state.recentInputs.find((item) => item.id === id);
    if (recent) {
      state.draft = recent.text;
      saveState();
      renderHome();
    }
  }
  if (action === "extract-ai") {
    const input = document.querySelector("#thoughtInput")?.value.trim();
    if (!input) {
      showToast("先写一点内容。");
      return;
    }
    const items = extractTasks(input);
    state.pendingAIItems.unshift(...items);
    state.recentInputs = [{ id: createId("input"), text: input, createdAt: nowIso() }, ...state.recentInputs].slice(0, 5);
    state.draft = "";
    saveState();
    navigate("pending");
  }
  if (action === "resume-pending") navigate("pending");
  if (action === "leave-pending") navigate("home");
  if (action === "voice-input") transcribeVoice();
  if (action === "delete-pending") {
    removePending(id);
    if (state.pendingAIItems.length) renderPending();
  }
  if (action === "confirm-pending-task") confirmPendingTask(id);
  if (action === "confirm-pending-note") confirmPendingNote(id);
  if (action === "add-project") openAddProjectForm();
  if (action === "open-project") openProject(id);
  if (action === "open-doing-task" || action === "open-note-task") {
    const task = getTask(id);
    if (task) openProject(task.projectId, task.id);
  }
  if (action === "open-daily-task") {
    const task = getTask(id);
    if (task) openProject(task.projectId, task.id);
  }
  if (action === "return-from-board") returnFromBoard();
  if (action === "select-project-root") selectProjectRoot(id);
  if (action === "add-task") openAddTaskForm(trigger.dataset.projectId, trigger.dataset.parentId || null);
  if (action === "select-task") selectTask(id);
  if (action === "toggle-sidebar") {
    state.ui.sidebarCollapsed = !state.ui.sidebarCollapsed;
    render();
  }
  if (action === "toggle-tree") {
    state.ui.expandedTaskIds = state.ui.expandedTaskIds.includes(id)
      ? state.ui.expandedTaskIds.filter((taskId) => taskId !== id)
      : [...state.ui.expandedTaskIds, id];
    render();
  }
  if (action === "toggle-completed") {
    state.ui.expandedCompletedTaskIds = state.ui.expandedCompletedTaskIds.includes(id)
      ? state.ui.expandedCompletedTaskIds.filter((taskId) => taskId !== id)
      : [...state.ui.expandedCompletedTaskIds, id];
    if (state.ui.expandedCompletedTaskIds.includes(id) && !state.ui.expandedTaskIds.includes(id)) state.ui.expandedTaskIds.push(id);
    render();
  }
  if (action === "toggle-current-task") toggleCurrentTask(id);
  if (action === "record-progress") openProgressForm(id);
  if (action === "record-stuck") openStuckForm(id);
  if (action === "record-retro") openRetroForm(id);
  if (action === "edit-task-settings") openTaskSettingsForm(id);
  if (action === "request-delete-task") requestDeleteTask(id);
  if (action === "confirm-delete-task") deleteTaskBranch(id);
  if (action === "undo-delete-task") undoDeleteTask();
  if (action === "set-date-preset") {
    const field = document.querySelector(`[name="${trigger.dataset.field}"]`);
    if (field) {
      field.value = trigger.dataset.value || "";
      if (!field.value) {
        const timeField = document.querySelector(`[name="${trigger.dataset.field === "plannedDate" ? "plannedTime" : "deadlineTime"}"]`);
        if (timeField) timeField.value = "";
      }
    }
  }
  if (action === "add-today") {
    addTaskToToday(id);
    saveState();
    showToast("已加入今天要推进。");
    render();
  }
  if (action === "complete-task") requestCompleteTask(id);
  if (action === "complete-self") completeTask(id, false);
  if (action === "complete-branch") completeTask(id, true);
  if (action === "reopen-task") reopenTask(id);
  if (action === "quick-daily-task") openQuickDailyForm();
  if (action === "quick-doing-task") openQuickDoingForm();
  if (action === "toggle-daily-pin") {
    state.dailyBoard.pinnedTaskIds = state.dailyBoard.pinnedTaskIds.includes(id)
      ? state.dailyBoard.pinnedTaskIds.filter((taskId) => taskId !== id)
      : [...state.dailyBoard.pinnedTaskIds, id];
    render();
  }
  if (action === "move-daily-up") moveDailyTask(id, -1);
  if (action === "move-daily-down") moveDailyTask(id, 1);
  if (action === "review-carryover") openCarryoverForm();
  if (action === "open-activity") openActivityDrawer();
  if (action === "close-activity") closeActivityDrawer();
  if (action === "activity-scope") {
    state.ui.activityScope = trigger.dataset.value;
    renderActivityDrawer();
    saveState();
  }
  if (action === "activity-filter") {
    state.ui.activityFilter = trigger.dataset.value;
    renderActivityDrawer();
    saveState();
  }
  if (action === "open-notes") {
    if (getRoute().name === "notes") {
      document.querySelector("#noteComposer")?.focus();
    } else {
      openNotesDrawer();
    }
  }
  if (action === "close-notes") closeNotesDrawer();
  if (action === "close-drawers") {
    closeActivityDrawer();
    closeNotesDrawer();
  }
  if (action === "save-note") saveNoteFromComposer();
  if (action === "save-task-note") await saveTaskNote(id);
  if (action === "remove-task-note-image") {
    const taskId = trigger.dataset.taskId;
    taskNoteDraftImages[taskId] = (taskNoteDraftImages[taskId] || []).filter((image) => image.id !== id);
    render();
  }
  if (action === "add-note-tag") {
    const input = document.querySelector("#noteTagInput");
    const tag = input?.value.trim().replace(/^#/, "");
    if (tag) {
      state.ui.noteManualTags = unique([...state.ui.noteManualTags, tag]);
      input.value = "";
      saveState();
      updateRecognizedTags();
    }
  }
  if (action === "remove-note-tag") {
    const tag = trigger.dataset.value;
    state.ui.noteManualTags = state.ui.noteManualTags.filter((item) => item !== tag);
    const composer = document.querySelector("#noteComposer");
    if (composer) {
      composer.value = composer.value
        .replace(new RegExp(`(^|\\s)#${escapeRegExp(tag)}(?=\\s|$)`, "g"), " ")
        .replace(/\s{2,}/g, " ")
        .trim();
    }
    saveState();
    updateRecognizedTags();
  }
  if (action === "notes-view") {
    state.ui.notesView = trigger.dataset.value;
    renderNotesDrawer();
    saveState();
  }
  if (action === "select-note-tag") {
    state.ui.noteTag = trigger.dataset.value;
    refreshNotesSurface();
    saveState();
  }
  if (action === "edit-note") editNote(id);
  if (action === "delete-note") {
    const note = state.notes.find((entry) => entry.id === id);
    deleteCloudNoteImages(note);
    state.notes = state.notes.filter((note) => note.id !== id);
    saveState();
    refreshNotesSurface();
  }
  if (action === "close-form") closeForm();
  if (action === "start-timer") startTimer(id);
  if (action === "pause-timer") pauseTimer();
  if (action === "reset-timer") resetTimer();
  if (action === "start-break") startBreak();
  if (action === "skip-break") skipBreak();
  if (action === "open-running-task") {
    const task = getTask(state.timer.taskId);
    if (task) openProject(task.projectId, task.id);
  }
  if (action === "reset-demo") {
    openChoiceDialog({
      title: "重置示例数据",
      eyebrow: "Local data",
      choices: [
        { action: "confirm-reset-demo", id: "", title: "确认重置", description: cloudReady ? "当前账户中的 FlowTree 数据会被示例数据覆盖。" : "当前浏览器中的 FlowTree 数据会被示例数据覆盖。" },
      ],
    });
  }
  if (action === "confirm-reset-demo") {
    state = createInitialState();
    saveState();
    closeForm();
    navigate("home");
  }
  if (action === "sign-up") await submitAuth("signup");
  if (action === "request-password-reset") await requestPasswordReset();
  if (action === "toggle-auth-password") toggleAuthPasswordVisibility();
  if (action === "sign-out") await signOut();
}

async function handleChange(event) {
  if (event.target.id === "taskNoteImages") {
    const taskId = event.target.dataset.taskId;
    await addTaskNoteImages(taskId, event.target.files || []);
    return;
  }
  const pendingField = event.target.dataset.pendingField;
  if (pendingField) {
    const item = state.pendingAIItems.find((entry) => entry.id === event.target.dataset.id);
    if (!item) return;
    let value = event.target.value;
    if (pendingField === "shouldAddToToday") value = value === "true";
    if (pendingField === "noteTags") value = unique(value.split(/\s+/).map((tag) => tag.replace(/^#/, "")).filter(Boolean));
    item[pendingField] = value;
    if (pendingField === "matchedProjectId") {
      item.matchedTaskId = "";
      saveState();
      renderPending();
      return;
    }
    saveState();
  }

  if (event.target.id === "focusMinutes" && state.timer.status === "idle") {
    state.timer.focusMinutes = Math.max(1, Math.min(180, Number(event.target.value) || 25));
    state.timer.remainingSeconds = state.timer.focusMinutes * 60;
    saveState();
    updateHeaderTimer();
    const readout = document.querySelector("#timerReadout");
    if (readout) readout.textContent = formatDuration(state.timer.remainingSeconds);
  }
  if (event.target.id === "breakMinutes" && state.timer.status === "idle") {
    state.timer.breakMinutes = Math.max(1, Math.min(60, Number(event.target.value) || 5));
    saveState();
  }
}

function handleInput(event) {
  if (event.target.id === "thoughtInput") {
    state.draft = event.target.value;
    saveState();
  }
  if (event.target.id === "noteComposer") {
    updateRecognizedTags();
  }
  if (event.target.id === "noteSearch") {
    state.ui.noteSearch = event.target.value;
    saveState();
    clearTimeout(event.target._searchTimer);
    event.target._searchTimer = setTimeout(() => refreshNotesSurface(true), 180);
  }
}

function transcribeVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const status = document.querySelector("#captureStatus");
  if (!SpeechRecognition) {
    if (status) status.textContent = "当前浏览器不支持语音识别；后续可接入 /api/transcribe。";
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = "zh-CN";
  recognition.interimResults = false;
  if (status) status.textContent = "正在听...";
  recognition.onresult = (event) => {
    const input = document.querySelector("#thoughtInput");
    const transcript = event.results[0][0].transcript;
    if (input) {
      input.value = `${input.value}\n${transcript}`.trim();
      state.draft = input.value;
      saveState();
    }
    if (status) status.textContent = "已转成文字。";
  };
  recognition.onerror = () => {
    if (status) status.textContent = "语音识别暂时不可用。";
  };
  recognition.start();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-action]");
  if (!trigger) {
    closeTaskContextMenu();
    return;
  }
  const fromContextMenu = Boolean(trigger.closest("#taskContextMenu"));
  event.preventDefault();
  handleAction(trigger.dataset.action, trigger).catch((error) => {
    console.warn("FlowTree action failed", error);
    showToast("操作失败，请稍后重试。");
  }).finally(() => {
    if (fromContextMenu) closeTaskContextMenu();
  });
});

document.addEventListener("keydown", (event) => {
  const trigger = event.target.closest('[role="button"][data-action]');
  if (!trigger || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  handleAction(trigger.dataset.action, trigger).catch((error) => {
    console.warn("FlowTree action failed", error);
  });
});

document.addEventListener("change", handleChange);
document.addEventListener("input", handleInput);
document.addEventListener("dragstart", handleDragStart);
document.addEventListener("dragover", handleDragOver);
document.addEventListener("drop", handleDrop);
document.addEventListener("dragend", handleDragEnd);
document.addEventListener("contextmenu", handleContextMenu);
els.recordForm.addEventListener("submit", handleFormSubmit);
els.formModal.addEventListener("click", (event) => {
  if (event.target === els.formModal) closeForm();
});
els.authForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (authRecoveryMode) updateRecoveredPassword();
  else submitAuth("signin");
});
window.addEventListener("hashchange", render);
window.addEventListener("focus", refreshCloudState);
window.addEventListener("scroll", closeTaskContextMenu, true);
window.addEventListener("resize", closeTaskContextMenu);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshCloudState();
});

if (!location.hash) location.hash = "#/home";
initializeCloud();
ensureTimerInterval();
