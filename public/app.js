const DECISIONS = [
  ["empty", "空觸發"],
  ["animal", "動物"],
  ["person", "人"],
  ["vehicle", "車輛"],
  ["equipment_error", "設備異常"],
  ["uncertain", "不確定"],
];

const SELECT_OPTIONS = {
  VisibleClass: [["", "— 請選擇 —"], ...DECISIONS, ["mixed", "混合事件"]],
  EmptyCause: [
    ["", "— 不適用／未選 —"], ["wind_vegetation", "風／植被"],
    ["light_shadow", "光影"], ["rain_fog", "雨／霧"],
    ["camera_motion", "相機移動"], ["unknown", "原因不明"],
  ],
  ImportantSpeciesFlag: [["", "— 未設定 —"], ["yes", "是"], ["no", "否"], ["pending", "待公司規則／專家確認"]],
  Visibility: [
    ["", "— 未選 —"], ["clear", "清楚"], ["partial", "局部可見"],
    ["edge", "畫面邊緣"], ["tiny", "目標太小"], ["blurred", "模糊"],
    ["night_unclear", "夜間不清楚"],
  ],
  ReviewerConfidence: [["", "— 未選 —"], ["high", "高"], ["medium", "中"], ["low", "低"]],
  ReviewStatus: [
    ["", "— 尚未覆核 —"], ["AI_PENDING", "AI 待處理"], ["AI_RUNNING", "AI 處理中"],
    ["AI_COMPLETE", "AI 已完成"], ["NEEDS_REVIEW", "需要人工覆核"],
    ["HUMAN_CONFIRMED", "人工確認完成"], ["UNCERTAIN", "資訊不足／不確定"],
    ["CONFLICT", "結果衝突"], ["FAILED", "處理失敗"],
    ["first_pass", "舊版：初判完成"], ["double_checked", "舊版：雙人複核完成"],
    ["adjudicated", "舊版：裁決完成"],
  ],
  VideoDecision: [["", "— 尚未判定 —"], ...DECISIONS],
  VideoAddsAnimal: [["", "— 尚未判定 —"], ["yes", "是"], ["no", "否"], ["not_applicable", "不適用"]],
};

const EDITABLE_FIELDS = [
  "PhotoOnlyDecision", "VideoDecision", "VideoAddsAnimal", "FinalDecision", "VisibleClass",
  "EmptyCause", "TaxonCode", "CommonName", "ScientificName", "CountMin", "Visibility",
  "ReviewerConfidence", "ImportantSpeciesFlag", "Annotator", "ReviewStatus", "FirstPassDate",
  "SecondReviewer", "DoubleCheckDate", "Adjudicator", "AdjudicationDate", "Notes",
  "HumanLabels", "IndividualCountMax", "AdditionalTaxonCodes", "CorrectionReason", "TaxonomyVersion",
];

const AI_RESULT_FIELDS = [
  "AIStatus", "AIEventLabels", "AISpecies", "AIConfidence", "AIModelName",
  "AIModelVersion", "AIProcessedAt", "AIError", "ReviewStatus",
];

const state = {
  config: null,
  events: [],
  filtered: [],
  taxonomy: [],
  currentId: null,
  dirty: false,
  saving: false,
  videoUnlocked: false,
  serverAvailable: false,
  importFiles: [],
  importPreviewUrls: [],
  importJob: null,
  aiJobId: null,
  aiJobEventId: null,
  aiPollTimer: null,
  status: { total: 0, reviewed: 0, unreviewed: 0 },
};

let deferredInstallPrompt = null;

const LOCAL_SERVICE_ORIGIN = "http://127.0.0.1:4173";
const SERVICE_ORIGIN = window.location.hostname.endsWith("github.io")
  ? LOCAL_SERVICE_ORIGIN
  : window.location.origin;

function serviceUrl(pathname) {
  return new URL(String(pathname).replace(/^\/+/, ""), `${SERVICE_ORIGIN}/`).href;
}

function normalizeEvent(event) {
  const humanLabels = event.HumanLabels || event.FinalDecision || "";
  return {
    ...event,
    HumanLabels: humanLabels,
    IndividualCountMax: event.IndividualCountMax || event.CountMin || "",
    AIStatus: event.AIStatus || "AI_PENDING",
    TaxonomyVersion: event.TaxonomyVersion || "taxonomy_v1.0",
    media: Object.fromEntries(
      Object.entries(event.media || {}).map(([key, value]) => [key, value ? serviceUrl(value) : ""]),
    ),
  };
}

const $ = (selector) => document.querySelector(selector);
const eventList = $("#event-list");
const annotationForm = $("#annotation-form");
const toast = $("#toast");

function currentEvent() {
  return state.events.find((event) => event.EventID === state.currentId);
}

function optionSelect(element, options) {
  element.replaceChildren();
  for (const [value, label] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    element.append(option);
  }
}

function showToast(message, error = false) {
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function setDirty(dirty) {
  state.dirty = dirty;
  const indicator = $("#save-state");
  indicator.classList.toggle("dirty", dirty);
  indicator.classList.toggle("saved", !dirty && Boolean(state.currentId));
  indicator.lastChild.textContent = dirty ? "尚未儲存" : "已同步到工作檔";
}

function renderConnectionState() {
  const banner = $("#offline-banner");
  const online = navigator.onLine;
  const connected = online && state.serverAvailable;
  banner.hidden = connected;
  document.body.classList.toggle("connection-warning", !connected);
  $("#offline-title").textContent = online ? "本機服務尚未連線" : "目前處於離線狀態";
  $("#offline-message").textContent = online
    ? "請先啟動照片辨識軟體，再按「重新連線」。資料與影像不會儲存在 PWA 快取中。"
    : "PWA 介面可離線開啟，但標註資料與相機影像需要本機服務。";
}

function initializePwa() {
  const installButton = $("#install-app-button");
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  installButton.hidden = true;

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js", { scope: "./" }).catch((error) => {
        console.error("Service worker registration failed", error);
      });
    });
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    if (standalone) return;
    deferredInstallPrompt = event;
    installButton.hidden = false;
  });

  installButton.addEventListener("click", async () => {
    if (!deferredInstallPrompt) {
      showToast("請使用瀏覽器選單中的「安裝應用程式」或「新增至主畫面」。");
      return;
    }
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installButton.hidden = true;
    showToast(choice.outcome === "accepted" ? "應用程式安裝已開始。" : "已取消安裝。", choice.outcome !== "accepted");
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    installButton.hidden = true;
    showToast("野生動物事件判讀台已安裝。");
  });

  window.addEventListener("online", renderConnectionState);
  window.addEventListener("offline", renderConnectionState);
  $("#retry-connection-button").addEventListener("click", () => window.location.reload());
  renderConnectionState();
}

function localDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function isReviewed(event) {
  return ["HUMAN_CONFIRMED", "UNCERTAIN", "CONFLICT", "double_checked", "adjudicated"].includes(event.ReviewStatus)
    || Boolean(event.FinalDecision && ["first_pass", "double_checked", "adjudicated"].includes(event.ReviewStatus));
}

function recalculateStatus() {
  const reviewed = state.events.filter(isReviewed).length;
  state.status = { total: state.events.length, reviewed, unreviewed: state.events.length - reviewed };
}

function renderStatus() {
  const { total, reviewed, unreviewed } = state.status;
  $("#progress-text").textContent = `${reviewed} / ${total}`;
  $("#progress-bar").style.width = total ? `${(reviewed / total) * 100}%` : "0%";
  $("#progress-meta").textContent = `尚未覆核 ${unreviewed} 組 · 完成 ${reviewed} 組`;
}

function applyFilter() {
  const query = $("#search-input").value.trim().toLocaleLowerCase();
  const filter = $("#filter-select").value;
  state.filtered = state.events.filter((event) => {
    const challenge = event.ChallengeReasons || "";
    const matchesFilter =
      filter === "all"
      || (filter === "unreviewed" && !isReviewed(event))
      || (filter === "reviewed" && isReviewed(event))
      || (filter === "ai_pending" && ["AI_PENDING", "AI_RUNNING"].includes(event.AIStatus))
      || (filter === "needs_review" && event.ReviewStatus === "NEEDS_REVIEW")
      || (filter === "conflict" && event.ReviewStatus === "CONFLICT")
      || (filter === "audit" && event.AuditRandom === "yes")
      || (filter === "challenge" && event.SamplingStratum === "challenge")
      || (filter === "night" && challenge.includes("night"))
      || (filter === "filename_hint" && (event.filenameHint || challenge.includes("filename_hint")));
    if (!matchesFilter) return false;
    if (!query) return true;
    return [event.EventID, event.Photo1, event.Photo2, event.Photo3, event.Video, event.filenameHint, event.CommonName, event.TaxonCode]
      .join(" ").toLocaleLowerCase().includes(query);
  });
  $("#filter-count").textContent = state.filtered.length;
  renderEventList();
}

function renderEventList() {
  eventList.replaceChildren();
  for (const event of state.filtered) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `event-item${event.EventID === state.currentId ? " active" : ""}${isReviewed(event) ? " reviewed" : ""}`;
    button.addEventListener("click", () => selectEvent(event.EventID));

    const dot = document.createElement("span");
    dot.className = "event-dot";
    const main = document.createElement("span");
    main.className = "event-item-main";
    const title = document.createElement("strong");
    title.textContent = event.EventID.replace(`${event.DeploymentID}-`, "");
    const subtitle = document.createElement("small");
    subtitle.textContent = `${event.EventTime || "無時間"}${event.CommonName ? ` · ${event.CommonName}` : ""}`;
    main.append(title, subtitle);
    button.append(dot, main);
    if (event.ChallengeReasons) {
      const tag = document.createElement("span");
      tag.className = "event-tag";
      tag.textContent = event.ChallengeReasons.includes("night") ? "夜" : "挑戰";
      button.append(tag);
    }
    eventList.append(button);
  }
  const active = eventList.querySelector(".active");
  active?.scrollIntoView({ block: "nearest" });
}

function chip(text, className = "") {
  const element = document.createElement("span");
  element.className = `chip ${className}`.trim();
  element.textContent = text;
  return element;
}

function renderMetadata(event) {
  const strip = $("#metadata-strip");
  strip.replaceChildren();
  strip.append(chip(event.SamplingStratum === "audit_random" ? "隨機稽核" : "挑戰樣本", event.AuditRandom === "yes" ? "audit" : "highlight"));
  if (event.AuditRandom === "yes" && event.SamplingStratum !== "audit_random") strip.append(chip("同時入選隨機稽核", "audit"));
  for (const reason of (event.ChallengeReasons || "").split(";").filter(Boolean)) {
    const labels = {
      night: "夜間", continuous_trigger: "連續觸發",
      filename_hint: "檔名提示", filename_uncertain_hint: "檔名不確定提示",
    };
    strip.append(chip(labels[reason] || reason, reason.includes("filename") ? "highlight" : ""));
  }
  strip.append(chip(`重要物種：${event.ImportantSpeciesFlag || event.ImportantSpeciesStatus || "pending"}`));
  if (event.ReviewStatus) strip.append(chip(`狀態：${event.ReviewStatus}`, "audit"));
}

function renderPhotos(event) {
  const grid = $("#photo-grid");
  grid.replaceChildren();
  for (const key of ["Photo1", "Photo2", "Photo3"]) {
    const frame = document.createElement("div");
    frame.className = "photo-frame";
    if (event.media[key]) {
      const image = document.createElement("img");
      image.src = event.media[key];
      image.alt = `${event.EventID} ${key}`;
      image.loading = "eager";
      image.addEventListener("click", () => openImage(event.media[key], event[key]));
      image.addEventListener("error", () => {
        image.alt = `無法載入 ${event[key]}`;
        frame.classList.add("load-error");
      });
      frame.append(image);
    }
    const label = document.createElement("span");
    label.className = "photo-label";
    label.textContent = `${key} · ${event[key] || "缺少檔案"}`;
    frame.append(label);
    grid.append(frame);
  }
}

function renderDecisionButtons(containerId, inputId) {
  const container = $(containerId);
  container.replaceChildren();
  for (const [value, label] of DECISIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segment";
    button.dataset.value = value;
    button.textContent = label;
    button.addEventListener("click", () => {
      $(`#${inputId}`).value = value;
      syncDecisionButtons(containerId, value);
      setDirty(true);
    });
    container.append(button);
  }
}

function syncDecisionButtons(containerId, value) {
  for (const button of document.querySelectorAll(`${containerId} .segment`)) {
    button.classList.toggle("active", button.dataset.value === value);
  }
}

function selectedHumanLabels() {
  return $("#HumanLabels").value.split(";").filter(Boolean);
}

function setHumanLabels(labels, dirty = true) {
  const unique = [...new Set(labels.filter(Boolean))];
  const normalized = unique.includes("empty") ? ["empty"] : unique;
  $("#HumanLabels").value = normalized.join(";");
  const derived = normalized.length > 1 ? "mixed" : (normalized[0] || "");
  $("#FinalDecision").value = derived;
  $("#VisibleClass").value = derived;
  for (const input of document.querySelectorAll('#human-label-options input[type="checkbox"]')) {
    input.checked = normalized.includes(input.value);
  }
  if (dirty) setDirty(true);
}

function renderHumanLabelOptions() {
  const container = $("#human-label-options");
  container.replaceChildren();
  for (const [value, label] of DECISIONS) {
    const wrapper = document.createElement("label");
    wrapper.className = "multi-label-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = value;
    input.addEventListener("change", () => {
      let labels = [...document.querySelectorAll('#human-label-options input:checked')].map((item) => item.value);
      if (value === "empty" && input.checked) labels = ["empty"];
      if (value !== "empty" && input.checked) labels = labels.filter((item) => item !== "empty");
      setHumanLabels(labels);
    });
    const text = document.createElement("span");
    text.textContent = label;
    wrapper.append(input, text);
    container.append(wrapper);
  }
}

function renderAiResult(event) {
  const aiStatus = event.AIStatus || "AI_PENDING";
  const runtime = state.config?.aiRuntime;
  const anyJobRunning = Boolean(state.aiJobId);
  const running = ["AI_PENDING", "AI_RUNNING"].includes(aiStatus)
    && anyJobRunning && state.aiJobEventId === event.EventID;
  $("#ai-status").textContent = aiStatus;
  $("#ai-status").dataset.status = aiStatus;
  $("#ai-labels").textContent = event.AIEventLabels || "尚未辨識";
  $("#ai-species").textContent = event.AISpecies || "—";
  $("#ai-confidence").textContent = event.AIConfidence || "—";
  $("#ai-model").textContent = [event.AIModelName, event.AIModelVersion].filter(Boolean).join(" · ") || "尚未接線";
  $("#ai-runtime-label").textContent = runtime?.ready
    ? `${runtime.detectorModel || "MegaDetector"} · SpeciesNet ${runtime.versions?.speciesnet || ""}`.trim()
    : (runtime?.message || "本機 AI 環境尚未就緒");
  const startButton = $("#start-ai-button");
  startButton.disabled = !runtime?.ready || anyJobRunning;
  startButton.textContent = running
    ? "辨識執行中…"
    : (anyJobRunning ? "另一事件辨識中…" : (aiStatus === "AI_COMPLETE" ? "重新辨識目前事件" : "開始辨識目前事件"));
  const notice = $("#ai-notice");
  notice.hidden = false;
  if (!runtime?.ready) notice.textContent = runtime?.message || "請先安裝 MegaDetector／SpeciesNet。";
  else if (aiStatus === "FAILED") notice.textContent = `上次辨識失敗：${event.AIError || "請查看工作紀錄"}`;
  else if (running) notice.textContent = "本機正在執行 MegaDetector 與 SpeciesNet；可繼續查看其他事件。";
  else if (anyJobRunning) notice.textContent = `事件 ${state.aiJobEventId} 正在辨識；完成後才能啟動下一個事件。`;
  else if (aiStatus === "AI_COMPLETE") notice.textContent = "AI 原始結果已保存；請由人工判讀決定最終答案。";
  else notice.textContent = "尚未辨識。第一次執行會下載官方模型權重，可能需要數分鐘。";
}

async function refreshAiFields(eventId) {
  const response = await fetch(serviceUrl("/api/events"));
  if (!response.ok) throw new Error("無法重新讀取 AI 結果。");
  const payload = await response.json();
  const remote = payload.events.find((event) => event.EventID === eventId);
  const local = state.events.find((event) => event.EventID === eventId);
  if (remote && local) {
    for (const field of AI_RESULT_FIELDS) local[field] = remote[field] || "";
    if (state.currentId === eventId) {
      renderAiResult(local);
      renderMetadata(local);
    }
  }
  state.status = payload.status;
  renderStatus();
  renderEventList();
}

async function pollAiJob(jobId, eventId) {
  clearTimeout(state.aiPollTimer);
  try {
    const response = await fetch(serviceUrl(`/api/ai/jobs/${encodeURIComponent(jobId)}`));
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "無法讀取 AI 工作狀態。");
    const job = payload.job;
    const log = $("#ai-job-log");
    log.classList.toggle("hidden", !job.logTail);
    log.textContent = [job.message, job.logTail].filter(Boolean).join("\n\n");
    const local = state.events.find((event) => event.EventID === eventId);
    if (local && ["AI_PENDING", "AI_RUNNING"].includes(job.status)) {
      local.AIStatus = job.status;
      if (state.currentId === eventId) renderAiResult(local);
      state.aiPollTimer = setTimeout(() => pollAiJob(jobId, eventId), 2000);
      return;
    }
    state.aiJobId = null;
    state.aiJobEventId = null;
    await refreshAiFields(eventId);
    showToast(job.status === "AI_COMPLETE" ? "AI 辨識完成，請進行人工覆核。" : `AI 辨識失敗：${job.error || "請查看紀錄"}`, job.status !== "AI_COMPLETE");
  } catch (error) {
    state.aiJobId = null;
    state.aiJobEventId = null;
    showToast(error.message, true);
    if (currentEvent()) renderAiResult(currentEvent());
  }
}

async function startAiInference() {
  const event = currentEvent();
  if (!event || state.aiJobId) return;
  if (state.dirty) {
    showToast("請先儲存目前的人工標註，再啟動 AI 辨識。", true);
    return;
  }
  const button = $("#start-ai-button");
  button.disabled = true;
  try {
    const response = await fetch(serviceUrl("/api/ai/jobs"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ EventID: event.EventID }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "無法建立 AI 工作。");
    state.aiJobId = payload.job.jobId;
    state.aiJobEventId = event.EventID;
    event.AIStatus = payload.job.status;
    renderAiResult(event);
    $("#ai-job-log").classList.remove("hidden");
    $("#ai-job-log").textContent = payload.job.message;
    pollAiJob(payload.job.jobId, event.EventID);
  } catch (error) {
    showToast(error.message, true);
    renderAiResult(event);
  }
}

function renderVideo(event) {
  state.videoUnlocked = false;
  const content = $("#video-content");
  content.className = "video-locked";
  content.innerHTML = '<div class="lock-icon" aria-hidden="true">▶</div><strong>影片目前隱藏</strong><span>避免第一輪照片判定受到影片資訊影響</span>';
  $("#unlock-video-button").textContent = "啟用影片第二輪";
  $("#unlock-video-button").disabled = false;
}

function unlockVideo() {
  const event = currentEvent();
  if (!event || state.videoUnlocked) return;
  state.videoUnlocked = true;
  $("#unlock-video-button").textContent = "影片第二輪已啟用";
  $("#unlock-video-button").disabled = true;
  const content = $("#video-content");
  content.className = "video-open";
  content.replaceChildren();

  const mediaColumn = document.createElement("div");
  if (event.media.Video) {
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = event.media.Video;
    mediaColumn.append(video);
  } else {
    mediaColumn.textContent = "此事件沒有影片檔。";
  }

  const controls = document.createElement("div");
  controls.className = "video-controls";
  const decisionLabel = document.createElement("label");
  decisionLabel.textContent = "影片判定";
  const decision = document.createElement("select");
  decision.id = "VideoDecision";
  decision.name = "VideoDecision";
  optionSelect(decision, SELECT_OPTIONS.VideoDecision);
  decision.value = event.VideoDecision || "";
  decisionLabel.append(decision);
  const addsLabel = document.createElement("label");
  addsLabel.textContent = "影片是否新增動物證據";
  const adds = document.createElement("select");
  adds.id = "VideoAddsAnimal";
  adds.name = "VideoAddsAnimal";
  optionSelect(adds, SELECT_OPTIONS.VideoAddsAnimal);
  adds.value = event.VideoAddsAnimal || "";
  addsLabel.append(adds);
  const note = document.createElement("p");
  note.textContent = "若瀏覽器無法播放 AVI，可另開原始影片；判讀值仍會存入同一事件。";
  controls.append(decisionLabel, addsLabel, note);
  if (event.media.Video) {
    const link = document.createElement("a");
    link.href = event.media.Video;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = `另開原始影片：${event.Video}`;
    controls.append(link);
  }
  for (const select of [decision, adds]) select.addEventListener("change", () => setDirty(true));
  content.append(mediaColumn, controls);
}

function renderTaxonomy(event) {
  const select = $("#taxon-preset");
  select.replaceChildren(new Option("— 自行輸入或保持空白 —", ""));
  for (const taxon of state.taxonomy) {
    const suffix = taxon.status === "filename_hint_only" ? "〔僅檔名提示〕" : taxon.rank !== "species" ? `〔${taxon.rank}〕` : "";
    select.append(new Option(`${taxon.commonName} — ${taxon.scientificName || taxon.taxonCode} ${suffix}`.trim(), taxon.taxonCode));
  }
  const matched = state.taxonomy.find((taxon) => taxon.taxonCode === event.TaxonCode);
  select.value = matched?.taxonCode || "";
  $("#taxon-guidance").textContent = matched?.guidance || "選擇候選項目後，仍須人工確認影像證據。";
}

function renderFilenameHint(event) {
  const banner = $("#filename-hint");
  banner.replaceChildren();
  if (!event.filenameHint) {
    banner.classList.add("hidden");
    return;
  }
  banner.classList.remove("hidden");
  const strong = document.createElement("strong");
  strong.textContent = `檔名提示：${event.filenameHint}`;
  const span = document.createElement("span");
  span.textContent = "僅供尋找可能的候選分類，不能直接當作黃金標籤。";
  banner.append(strong, span);
}

function setFormValues(event) {
  for (const field of EDITABLE_FIELDS) {
    const element = document.getElementById(field);
    if (element) element.value = event[field] || "";
  }
  $("#CountMin").value = event.CountMin || event.IndividualCountMax || "";
  setHumanLabels((event.HumanLabels || event.FinalDecision || "").split(";").filter(Boolean), false);
  syncDecisionButtons("#photo-decision-buttons", event.PhotoOnlyDecision || "");
}

function renderCurrentEvent() {
  const event = currentEvent();
  if (!event) return;
  $("#deployment-label").textContent = event.DeploymentID;
  $("#event-id").textContent = event.EventID;
  $("#event-time").textContent = event.EventTime || "沒有事件時間";
  const position = state.filtered.findIndex((candidate) => candidate.EventID === event.EventID);
  $("#event-position").textContent = position >= 0 ? `${position + 1} / ${state.filtered.length}` : `— / ${state.filtered.length}`;
  renderMetadata(event);
  renderPhotos(event);
  renderVideo(event);
  renderAiResult(event);
  renderFilenameHint(event);
  renderTaxonomy(event);
  setFormValues(event);
  renderEventList();
  setDirty(false);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function selectEvent(eventId, force = false) {
  if (eventId === state.currentId) return;
  if (!force && state.dirty && !window.confirm("目前事件尚未儲存。要放棄這些修改並切換事件嗎？")) return;
  state.currentId = eventId;
  renderCurrentEvent();
}

function navigate(offset) {
  if (!state.filtered.length) return;
  let index = state.filtered.findIndex((event) => event.EventID === state.currentId);
  if (index < 0) index = 0;
  const next = Math.max(0, Math.min(state.filtered.length - 1, index + offset));
  if (next !== index) selectEvent(state.filtered[next].EventID);
}

function collectPatch() {
  const event = currentEvent();
  const patch = { EventID: event.EventID };
  for (const field of EDITABLE_FIELDS) {
    const element = document.getElementById(field);
    patch[field] = element ? element.value.trim() : (event[field] || "");
  }
  patch.HumanLabels = selectedHumanLabels().join(";");
  patch.AdditionalTaxonCodes = patch.AdditionalTaxonCodes.split(";").map((code) => code.trim()).filter(Boolean).join(";");
  const labels = patch.HumanLabels.split(";").filter(Boolean);
  patch.FinalDecision = labels.length > 1 ? "mixed" : (labels[0] || "");
  patch.VisibleClass = patch.FinalDecision;
  patch.CountMin = patch.IndividualCountMax;
  if (patch.PhotoOnlyDecision && !patch.FirstPassDate) {
    patch.FirstPassDate = localDate();
    $("#FirstPassDate").value = patch.FirstPassDate;
  }
  if (patch.PhotoOnlyDecision && !patch.ReviewStatus) {
    patch.ReviewStatus = "NEEDS_REVIEW";
    $("#ReviewStatus").value = patch.ReviewStatus;
  }
  if (patch.IndividualCountMax && !/^\d+$/.test(patch.IndividualCountMax)) throw new Error("同時可見最大個體數必須是非負整數。");
  return patch;
}

async function saveCurrent(goNext = false) {
  if (!currentEvent() || state.saving) return;
  let patch;
  try {
    patch = collectPatch();
  } catch (error) {
    showToast(error.message, true);
    return;
  }
  if (patch.HumanLabels.split(";").includes("animal") && !patch.TaxonCode) {
    showToast("動物事件必須選擇物種；無法判斷時使用 ANIMAL_UNKNOWN。", true);
    return;
  }

  state.saving = true;
  for (const button of [$("#save-button"), $("#save-only-button"), $("#save-next-button")]) button.disabled = true;
  $("#save-state").lastChild.textContent = "正在儲存…";
  try {
    const response = await fetch(serviceUrl("/api/annotations"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.errors?.join(" ") || result.detail || "儲存失敗。");
    const index = state.events.findIndex((event) => event.EventID === result.event.EventID);
    state.events[index] = normalizeEvent(result.event);
    recalculateStatus();
    renderStatus();
    applyFilter();
    setDirty(false);
    showToast(`${result.event.EventID} 已儲存`);
    if (goNext) {
      const filteredIndex = state.filtered.findIndex((event) => event.EventID === result.event.EventID);
      if (filteredIndex >= 0 && filteredIndex < state.filtered.length - 1) selectEvent(state.filtered[filteredIndex + 1].EventID, true);
    }
  } catch (error) {
    showToast(error.message, true);
    setDirty(true);
  } finally {
    state.saving = false;
    for (const button of [$("#save-button"), $("#save-only-button"), $("#save-next-button")]) button.disabled = false;
  }
}

function openImage(source, caption) {
  $("#dialog-image").src = source;
  $("#dialog-caption").textContent = caption;
  $("#image-dialog").showModal();
}

const ACCEPTED_MEDIA_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "avi", "mp4", "mov"]);

function fileExtension(filename) {
  return filename.toLocaleLowerCase().split(".").pop() || "";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

async function sha256File(file) {
  if (!globalThis.crypto?.subtle) return "UNAVAILABLE";
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clearImportPreviews() {
  for (const url of state.importPreviewUrls) URL.revokeObjectURL(url);
  state.importPreviewUrls = [];
  $("#import-preview").replaceChildren();
}

function renderImportPreview() {
  clearImportPreviews();
  const preview = $("#import-preview");
  for (const item of state.importFiles.slice(0, 12)) {
    const card = document.createElement("article");
    card.className = "import-file-card";
    if (item.file.type.startsWith("image/")) {
      const url = URL.createObjectURL(item.file);
      state.importPreviewUrls.push(url);
      const image = document.createElement("img");
      image.src = url;
      image.alt = item.relativePath;
      card.append(image);
    } else {
      const mediaType = document.createElement("div");
      mediaType.className = "media-type-icon";
      mediaType.textContent = "VIDEO";
      card.append(mediaType);
    }
    const name = document.createElement("strong");
    name.textContent = item.relativePath;
    const detail = document.createElement("span");
    detail.textContent = `${formatBytes(item.file.size)} · SHA-256 ${item.sha256.slice(0, 12)}…`;
    card.append(name, detail);
    preview.append(card);
  }
  if (state.importFiles.length > 12) {
    const more = document.createElement("div");
    more.className = "import-more";
    more.textContent = `另有 ${state.importFiles.length - 12} 個檔案已完成檢查`;
    preview.append(more);
  }
}

async function handleImportFiles(fileList) {
  const candidates = [...fileList]
    .filter((file) => ACCEPTED_MEDIA_EXTENSIONS.has(fileExtension(file.name)))
    .filter((file, index, all) => {
      const key = `${file.webkitRelativePath || file.name}:${file.size}:${file.lastModified}`;
      return all.findIndex((candidate) => `${candidate.webkitRelativePath || candidate.name}:${candidate.size}:${candidate.lastModified}` === key) === index;
    });
  state.importFiles = [];
  state.importJob = null;
  $("#job-result").hidden = true;
  $("#prepare-job-button").disabled = true;
  if (!candidates.length) {
    $("#import-summary").textContent = "沒有可接受的照片或影片。";
    clearImportPreviews();
    return;
  }
  const progress = $("#hash-progress");
  progress.hidden = false;
  progress.max = candidates.length;
  progress.value = 0;
  for (const file of candidates) {
    $("#import-summary").textContent = `正在計算檔案雜湊 ${progress.value + 1} / ${candidates.length}…`;
    state.importFiles.push({
      file,
      relativePath: file.webkitRelativePath || file.name,
      sha256: await sha256File(file),
    });
    progress.value += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  progress.hidden = true;
  const totalBytes = state.importFiles.reduce((sum, item) => sum + item.file.size, 0);
  const folders = new Set(state.importFiles.map((item) => item.relativePath.includes("/") ? item.relativePath.split("/")[0] : "單檔選取"));
  $("#import-summary").textContent = `已檢查 ${state.importFiles.length} 個檔案 · ${folders.size} 個來源 · ${formatBytes(totalBytes)} · 原始檔唯讀`;
  $("#prepare-job-button").disabled = false;
  renderImportPreview();
}

function prepareImportJob() {
  if (!state.importFiles.length) return;
  const job = {
    jobId: `CAMTRAP-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`,
    schemaVersion: "2.0",
    status: "IMPORT_READY",
    pairingStatus: "PENDING",
    createdAt: new Date().toISOString(),
    inferenceEngine: null,
    mediaCount: state.importFiles.length,
    totalBytes: state.importFiles.reduce((sum, item) => sum + item.file.size, 0),
    media: state.importFiles.map((item) => ({
      relativePath: item.relativePath,
      filename: item.file.name,
      size: item.file.size,
      mimeType: item.file.type || "application/octet-stream",
      lastModified: new Date(item.file.lastModified).toISOString(),
      sha256: item.sha256,
    })),
  };
  state.importJob = job;
  sessionStorage.setItem("cameraTrapPendingJob", JSON.stringify({
    jobId: job.jobId,
    schemaVersion: job.schemaVersion,
    status: job.status,
    pairingStatus: job.pairingStatus,
    createdAt: job.createdAt,
    mediaCount: job.mediaCount,
    totalBytes: job.totalBytes,
  }));
  const result = $("#job-result");
  result.hidden = false;
  result.textContent = JSON.stringify({
    jobId: job.jobId,
    status: job.status,
    pairingStatus: job.pairingStatus,
    mediaCount: job.mediaCount,
    totalSize: formatBytes(job.totalBytes),
    nextStep: "將媒體登錄成事件後，再由事件頁執行 MegaDetector／SpeciesNet",
  }, null, 2);
  showToast(`${job.jobId} 的本機匯入清單已建立`);
}

function initializeControls() {
  for (const [id, options] of Object.entries(SELECT_OPTIONS)) {
    const element = document.getElementById(id);
    if (element) optionSelect(element, options);
  }
  renderDecisionButtons("#photo-decision-buttons", "PhotoOnlyDecision");
  renderHumanLabelOptions();

  annotationForm.addEventListener("input", () => setDirty(true));
  annotationForm.addEventListener("change", () => setDirty(true));
  $("#taxon-preset").addEventListener("change", (event) => {
    const taxon = state.taxonomy.find((item) => item.taxonCode === event.target.value);
    if (!taxon) return;
    $("#TaxonCode").value = taxon.taxonCode;
    $("#CommonName").value = taxon.commonName;
    $("#ScientificName").value = taxon.scientificName;
    $("#taxon-guidance").textContent = taxon.guidance;
    if (!$("#ReviewerConfidence").value && (taxon.rank !== "species" || taxon.status !== "candidate")) {
      $("#ReviewerConfidence").value = "low";
    }
    setDirty(true);
  });
  $("#copy-photo-decision").addEventListener("click", () => {
    const value = $("#PhotoOnlyDecision").value;
    if (!value) return showToast("請先完成照片判定。", true);
    setHumanLabels([value]);
  });
  $("#unlock-video-button").addEventListener("click", unlockVideo);
  $("#previous-button").addEventListener("click", () => navigate(-1));
  $("#bottom-previous").addEventListener("click", () => navigate(-1));
  $("#next-button").addEventListener("click", () => navigate(1));
  $("#save-button").addEventListener("click", () => saveCurrent(false));
  $("#save-only-button").addEventListener("click", () => saveCurrent(false));
  $("#save-next-button").addEventListener("click", () => saveCurrent(true));
  $("#search-input").addEventListener("input", applyFilter);
  $("#filter-select").addEventListener("change", applyFilter);
  $("#close-dialog").addEventListener("click", () => $("#image-dialog").close());
  $("#image-dialog").addEventListener("click", (event) => {
    if (event.target === $("#image-dialog")) $("#image-dialog").close();
  });
  $("#open-import-button").addEventListener("click", () => $("#import-dialog").showModal());
  $("#close-import-dialog").addEventListener("click", () => $("#import-dialog").close());
  $("#choose-photos-button").addEventListener("click", (event) => {
    event.stopPropagation();
    $("#photo-picker").click();
  });
  $("#choose-folder-button").addEventListener("click", (event) => {
    event.stopPropagation();
    $("#folder-picker").click();
  });
  $("#photo-picker").addEventListener("change", (event) => handleImportFiles(event.target.files));
  $("#folder-picker").addEventListener("change", (event) => handleImportFiles(event.target.files));
  $("#drop-zone").addEventListener("click", (event) => {
    if (event.target === $("#drop-zone") || event.target.closest("strong, span")) $("#photo-picker").click();
  });
  $("#drop-zone").addEventListener("keydown", (event) => {
    if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      $("#photo-picker").click();
    }
  });
  for (const eventName of ["dragenter", "dragover"]) {
    $("#drop-zone").addEventListener(eventName, (event) => {
      event.preventDefault();
      $("#drop-zone").classList.add("dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    $("#drop-zone").addEventListener(eventName, (event) => {
      event.preventDefault();
      $("#drop-zone").classList.remove("dragging");
    });
  }
  $("#drop-zone").addEventListener("drop", (event) => handleImportFiles(event.dataTransfer.files));
  $("#prepare-job-button").addEventListener("click", prepareImportJob);
  $("#start-ai-button").addEventListener("click", startAiInference);

  window.addEventListener("beforeunload", (event) => {
    if (state.dirty) event.preventDefault();
  });
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveCurrent(false);
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === "[") {
      navigate(-1);
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === "]") {
      navigate(1);
    }
  });
}

async function start() {
  initializeControls();
  initializePwa();
  $("#export-link").href = serviceUrl("/api/export.csv");
  try {
    const [configResponse, eventsResponse, taxonomyResponse] = await Promise.all([
      fetch(serviceUrl("/api/config")),
      fetch(serviceUrl("/api/events")),
      fetch(serviceUrl("/api/taxonomy")),
    ]);
    if (!configResponse.ok || !eventsResponse.ok || !taxonomyResponse.ok) throw new Error("無法讀取專案資料。");
    state.config = await configResponse.json();
    const eventPayload = await eventsResponse.json();
    state.events = eventPayload.events.map(normalizeEvent);
    state.status = eventPayload.status;
    state.taxonomy = (await taxonomyResponse.json()).taxonomy;
    state.serverAvailable = true;
    renderConnectionState();
    $("#app-title").textContent = state.config.appName;
    document.title = `${state.config.appName} · ${state.config.deploymentId}`;
    renderStatus();
    applyFilter();
    if (state.events.length) {
      state.currentId = state.events[0].EventID;
      renderCurrentEvent();
    }
  } catch (error) {
    state.serverAvailable = false;
    renderConnectionState();
    showToast(`${error.message} 請確認伺服器與 D 槽資料路徑。`, true);
    $("#event-id").textContent = "載入失敗";
  }
}

start();
