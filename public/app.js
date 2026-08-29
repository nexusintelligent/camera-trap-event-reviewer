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
  "AIStatus", "AIEventLabels", "AISpecies", "AISpeciesConfidence", "AIConfidence", "AIModelName",
  "AIModelVersion", "AIProcessedAt", "AIError", "AIRepeatDetection", "AIRepeatDetectionSupport", "ReviewStatus",
];

const EVENT_SYNC_CHANNEL = "camera-trap-event-sync-v1";
const eventSyncChannel = "BroadcastChannel" in window ? new BroadcastChannel(EVENT_SYNC_CHANNEL) : null;
let eventSyncPromise = null;
let lastEventSyncAt = 0;

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
  uploading: false,
  aiJobId: null,
  aiJobEventId: null,
  aiPollTimer: null,
  aiBatchActive: false,
  aiBatchStatus: null,
  aiBatchPollTimer: null,
  currentView: "upload",
  reviewCollectionId: "registered",
  aiBatchId: "",
  uploadBatchId: "",
  uploadResultFilter: "all",
  uploadSpeciesFilter: "",
  uploadResultLimit: 24,
  imageGallery: [],
  imageGalleryIndex: 0,
  status: { total: 0, reviewed: 0, unreviewed: 0 },
};

let deferredInstallPrompt = null;

const LOCAL_SERVICE_ORIGIN = "http://127.0.0.1:4173";
const SERVICE_ORIGIN = ["127.0.0.1", "localhost"].includes(window.location.hostname)
  ? window.location.origin
  : LOCAL_SERVICE_ORIGIN;

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
    thumbnails: Object.fromEntries(
      Object.entries(event.thumbnails || {}).map(([key, value]) => [key, value ? serviceUrl(value) : ""]),
    ),
    videoPreview: event.videoPreview ? serviceUrl(event.videoPreview) : "",
  };
}

const $ = (selector) => document.querySelector(selector);
const eventList = $("#event-list");
const annotationForm = $("#annotation-form");
const toast = $("#toast");
const eventCollator = new Intl.Collator("zh-Hant", { numeric: true, sensitivity: "base" });

function currentEvent() {
  return state.events.find((event) => event.EventID === state.currentId);
}

function selectedAiMode() {
  return document.querySelector('input[name="ai-mode"]:checked')?.value === "full" ? "full" : "fast";
}

function shouldIdentifySpecies() {
  return selectedAiMode() === "full" && Boolean($("#identify-species-toggle")?.checked);
}

function aiBatchUrl() {
  const parameters = new URLSearchParams({
    identifySpecies: shouldIdentifySpecies() ? "1" : "0",
    mode: selectedAiMode(),
  });
  if (state.aiBatchId) parameters.set("deploymentId", state.aiBatchId);
  return serviceUrl(`/api/ai/batch?${parameters}`);
}

function isRegisteredEvent(event) {
  return Boolean(event) && event.SourceType !== "web_upload";
}

function isReviewEvent(event) {
  if (!event) return false;
  return state.reviewCollectionId === "registered"
    ? isRegisteredEvent(event)
    : event.SourceType === "web_upload" && event.DeploymentID === state.reviewCollectionId;
}

function reviewEvents() {
  return state.events.filter(isReviewEvent);
}

function webBatchEntries() {
  const grouped = new Map();
  for (const event of state.events.filter((item) => item.SourceType === "web_upload")) {
    if (!grouped.has(event.DeploymentID)) grouped.set(event.DeploymentID, []);
    grouped.get(event.DeploymentID).push(event);
  }
  return [...grouped.entries()].map(([deploymentId, events]) => ({ deploymentId, events })).reverse();
}

function uploadBatchEvents() {
  return state.events.filter((event) => event.SourceType === "web_upload" && event.DeploymentID === state.uploadBatchId);
}

function selectedAiBatchEvents() {
  return state.events.filter((event) => event.SourceType === "web_upload" && event.DeploymentID === state.aiBatchId);
}

function collectionLabel(deploymentId, events) {
  const sourceRoot = String(events[0]?.SourceRelativePaths || "").split(";")[0]?.split("/")[0] || deploymentId;
  const uniqueSuffix = deploymentId.startsWith(`${sourceRoot}-`) ? deploymentId.slice(sourceRoot.length + 1) : "";
  return `${sourceRoot}${uniqueSuffix ? ` · ${uniqueSuffix}` : ""}（${events.length} 組）`;
}

function syncCollectionSelectors(preferredUploadBatchId = "", preferredAiBatchId = "") {
  const batches = webBatchEntries();
  const validReviewIds = new Set(["registered", ...batches.map((batch) => batch.deploymentId)]);
  if (!validReviewIds.has(state.reviewCollectionId)) state.reviewCollectionId = "registered";
  const preferred = preferredUploadBatchId || state.uploadBatchId;
  state.uploadBatchId = batches.some((batch) => batch.deploymentId === preferred)
    ? preferred
    : (batches[0]?.deploymentId || "");
  const preferredAi = preferredAiBatchId || state.aiBatchId;
  state.aiBatchId = batches.some((batch) => batch.deploymentId === preferredAi)
    ? preferredAi
    : (batches[0]?.deploymentId || "");

  const reviewSelect = $("#review-collection-select");
  reviewSelect.replaceChildren();
  const registered = state.events.filter(isRegisteredEvent);
  reviewSelect.append(new Option(`人工覆核基準資料（${registered.length} 組）`, "registered"));
  for (const batch of batches) reviewSelect.append(new Option(collectionLabel(batch.deploymentId, batch.events), batch.deploymentId));
  reviewSelect.value = state.reviewCollectionId;

  const uploadSelect = $("#upload-results-batch-select");
  uploadSelect.replaceChildren();
  if (!batches.length) uploadSelect.append(new Option("尚未匯入事件", ""));
  for (const batch of batches) uploadSelect.append(new Option(collectionLabel(batch.deploymentId, batch.events), batch.deploymentId));
  uploadSelect.value = state.uploadBatchId;
  uploadSelect.disabled = batches.length === 0;

  const aiSelect = $("#ai-batch-select");
  aiSelect.replaceChildren();
  if (!batches.length) aiSelect.append(new Option("尚未匯入事件", ""));
  for (const batch of batches) aiSelect.append(new Option(collectionLabel(batch.deploymentId, batch.events), batch.deploymentId));
  aiSelect.value = state.aiBatchId;
  aiSelect.disabled = batches.length === 0 || Boolean(state.aiBatchStatus?.globalActive);
}

function showView(view, updateHash = true) {
  const nextView = view === "review" ? "review" : "upload";
  if (nextView !== state.currentView && nextView === "upload" && state.dirty) {
    if (!window.confirm("目前人工覆核尚未儲存。要放棄修改並前往上傳頁嗎？")) return;
    if (currentEvent()) setFormValues(currentEvent());
    setDirty(false);
  }
  state.currentView = nextView;
  if (nextView === "review" && !reviewEvents().some((event) => event.EventID === state.currentId)) {
    state.currentId = reviewEvents()[0]?.EventID || null;
    if (state.currentId) renderCurrentEvent();
    else renderEmptyReviewState();
  }
  $("#upload-view").hidden = nextView !== "upload";
  $("#review-view").hidden = nextView !== "review";
  $("#upload-tab").classList.toggle("active", nextView === "upload");
  $("#review-tab").classList.toggle("active", nextView === "review");
  $("#upload-tab").setAttribute("aria-selected", String(nextView === "upload"));
  $("#review-tab").setAttribute("aria-selected", String(nextView === "review"));
  for (const element of document.querySelectorAll(".review-only")) element.hidden = nextView !== "review";
  if (updateHash) history.replaceState(null, "", nextView === "review" ? "#review" : "#upload");
  if (state.serverAvailable) requestEventSync("view-change", true);
}

function aiTriageLabel(event) {
  if (event.AIStatus !== "AI_COMPLETE") return "尚未辨識";
  const labels = new Set(String(event.AIEventLabels || "").split(";").filter(Boolean));
  if (labels.has("animal")) return "需要辨識物種";
  if (labels.has("person") || labels.has("vehicle")) return "非空觸發（人／車）";
  return "空觸發";
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

function syncModalScrollLock() {
  document.body.classList.toggle("modal-open", Boolean(document.querySelector("dialog[open]")));
}

function openModalDialog(dialog) {
  if (!dialog.open) dialog.showModal();
  syncModalScrollLock();
}

function closeModalDialog(dialog) {
  if (dialog.open) dialog.close();
  syncModalScrollLock();
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
    ? "請先啟動本機辨識器，再按「重新連線」。照片、模型與成果只會保留在這台電腦。"
    : "PWA 介面可離線開啟，但處理照片與執行 AI 仍需要這台電腦上的本機辨識器。";
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
  const status = String(event.ReviewStatus || "");
  const hasHumanDecision = Boolean(event.HumanLabels || event.FinalDecision || event.PhotoOnlyDecision);
  if (["HUMAN_CONFIRMED", "UNCERTAIN", "CONFLICT", "double_checked", "adjudicated"].includes(status)) return true;
  if (status === "first_pass" && hasHumanDecision) return true;
  return Boolean(event.ReviewedAt && hasHumanDecision);
}

function recalculateStatus() {
  const collection = reviewEvents();
  const reviewed = collection.filter(isReviewed).length;
  state.status = { total: collection.length, reviewed, unreviewed: collection.length - reviewed };
}

function renderStatus() {
  const { total, reviewed, unreviewed } = state.status;
  $("#progress-text").textContent = `${reviewed} / ${total}`;
  $("#progress-bar").style.width = total ? `${(reviewed / total) * 100}%` : "0%";
  $("#progress-meta").textContent = `尚未覆核 ${unreviewed} 組 · 完成 ${reviewed} 組`;
  $("#summary-total").textContent = total || 0;
  const reviewCollection = reviewEvents();
  $("#summary-ai-complete").textContent = reviewCollection.filter((event) => event.AIStatus === "AI_COMPLETE").length;
  $("#summary-needs-review").textContent = reviewCollection.filter((event) => ["NEEDS_REVIEW", "CONFLICT", "UNCERTAIN"].includes(event.ReviewStatus)).length;
  const species = new Set(reviewCollection.flatMap((event) => String(event.AISpecies || event.CommonName || "")
    .split(";").map((value) => value.trim()).filter(Boolean)));
  $("#summary-species").textContent = species.size;
  $("#upload-ai-complete").textContent = state.aiBatchStatus?.complete ?? 0;
  $("#upload-empty").textContent = state.aiBatchStatus?.emptyTrigger ?? 0;
  $("#upload-needs-species").textContent = state.aiBatchStatus?.needsSpecies ?? 0;
}

function aiEventContentLabels(event) {
  if (event.AIStatus !== "AI_COMPLETE") return new Set();
  const labels = new Set(String(event.AIEventLabels || "")
    .split(";").map((label) => label.trim()).filter(Boolean));
  if (event.AIRepeatDetection === "yes") {
    labels.delete("animal");
    labels.add("repeat_detection");
  }
  return labels;
}

function applyFilter() {
  const query = $("#search-input").value.trim().toLocaleLowerCase();
  const reviewFilter = $("#filter-select").value;
  const contentFilter = $("#content-filter-select").value;
  state.filtered = reviewEvents().filter((event) => {
    const labels = aiEventContentLabels(event);
    const matchesReview = reviewFilter === "all"
      || (reviewFilter === "unreviewed" && !isReviewed(event))
      || (reviewFilter === "reviewed" && isReviewed(event));
    const matchesContent = contentFilter === "all"
      || (contentFilter === "empty" && labels.has("empty"))
      || (contentFilter === "animal" && labels.has("animal"))
      || (contentFilter === "repeat_detection" && labels.has("repeat_detection"))
      || (contentFilter === "person_vehicle" && (labels.has("person") || labels.has("vehicle")));
    if (!matchesReview || !matchesContent) return false;
    if (!query) return true;
    return [event.EventID, event.Photo1, event.Photo2, event.Photo3, event.Video, event.filenameHint, event.CommonName, event.TaxonCode]
      .join(" ").toLocaleLowerCase().includes(query);
  }).sort((left, right) => {
    const timeOrder = String(left.EventTime || "").localeCompare(String(right.EventTime || ""));
    return timeOrder || eventCollator.compare(left.EventID, right.EventID);
  });
  $("#filter-count").textContent = state.filtered.length;
  if (!state.filtered.some((event) => event.EventID === state.currentId) && !state.dirty) {
    state.currentId = state.filtered[0]?.EventID || null;
    if (state.currentView === "review") {
      if (state.currentId) renderCurrentEvent();
      else renderEmptyReviewState();
    }
  }
  renderEventList();
}

function renderEventList() {
  eventList.replaceChildren();
  if (!state.filtered.length) {
    const empty = document.createElement("div");
    empty.className = "event-list-empty";
    empty.textContent = "此批次沒有符合目前篩選條件的事件。";
    eventList.append(empty);
    return;
  }
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
      image.addEventListener("click", () => openImage(event, key));
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
  const anyJobRunning = Boolean(state.aiJobId) || state.aiBatchActive;
  const running = ["AI_PENDING", "AI_RUNNING"].includes(aiStatus)
    && anyJobRunning && state.aiJobEventId === event.EventID;
  $("#ai-status").textContent = aiStatus;
  $("#ai-status").dataset.status = aiStatus;
  $("#ai-labels").textContent = aiTriageLabel(event);
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
  else if (state.aiBatchActive && state.aiBatchStatus?.paused) notice.textContent = "批次佇列已暫停；目前事件若仍在運算，完成後不會啟動下一組。";
  else if (state.aiBatchActive) notice.textContent = `批次辨識執行中：${state.aiBatchStatus?.currentEventId || "正在準備下一組"}。可繼續瀏覽與人工標註。`;
  else if (anyJobRunning) notice.textContent = `事件 ${state.aiJobEventId} 正在辨識；完成後才能啟動下一個事件。`;
  else if (aiStatus === "AI_COMPLETE") notice.textContent = "AI 原始結果已保存；請由人工判讀決定最終答案。";
  else notice.textContent = "尚未辨識。第一次執行會下載官方模型權重，可能需要數分鐘。";
}

async function refreshAiFields(eventId) {
  await syncEventsFromServer({ reason: `ai-event:${eventId}` });
  notifyEventDataChanged("ai-result");
}

async function refreshAllAiFields() {
  await syncEventsFromServer({ reason: "ai-batch" });
  notifyEventDataChanged("ai-result");
}

function renderAiBatch(status = state.aiBatchStatus) {
  const button = $("#start-ai-batch-button");
  const summary = $("#ai-batch-summary");
  const progress = $("#ai-batch-progress");
  if (!button || !summary || !progress) return;

  const uploadedTotal = selectedAiBatchEvents().length;
  const total = Number(status?.total ?? uploadedTotal);
  const complete = Number(status?.complete || 0);
  const queued = Number(status?.queued || 0);
  const running = Number(status?.running || 0);
  const failed = Number(status?.failed || 0);
  const remaining = Number(status?.remaining ?? Math.max(0, total - complete));
  const speciesPending = Number(status?.speciesPending || 0);
  const active = Boolean(status?.active);
  const globalActive = Boolean(status?.globalActive);
  const paused = Boolean(status?.paused);
  const pauseButton = $("#pause-ai-batch-button");
  const resetButton = $("#reset-ai-workspace-button");
  const clearButton = $("#clear-upload-workspace-button");
  const pill = $("#batch-state-pill");
  const current = $("#ai-batch-current");
  state.aiBatchActive = active;
  progress.max = Math.max(1, total);
  progress.value = Math.min(total, complete);
  $("#upload-total").textContent = total;
  $("#upload-ai-complete").textContent = complete;
  $("#upload-empty").textContent = Number(status?.emptyTrigger || 0);
  $("#upload-needs-species").textContent = Number(status?.needsSpecies || 0);
  summary.textContent = `已完成 ${complete} / ${total} · 執行中 ${running} · 等待 ${queued} · 失敗 ${failed}`;
  button.disabled = !state.config?.aiRuntime?.ready || globalActive || !state.aiBatchId || remaining === 0;
  button.textContent = active && paused
    ? `批次已暫停 ${complete} / ${total}`
    : active
    ? `批次辨識中 ${complete} / ${total}`
    : (remaining > 0
      ? (shouldIdentifySpecies() && speciesPending === remaining
        ? `追加物種辨識 ${remaining} 組`
        : `一鍵辨識其餘 ${remaining} 組`)
      : "全部 AI 辨識完成");
  pauseButton.disabled = !active;
  resetButton.disabled = total === 0;
  clearButton.disabled = total === 0;
  $("#ai-batch-select").disabled = !state.aiBatchId || globalActive;
  pauseButton.textContent = paused ? "繼續批次辨識" : "完成目前這組後暫停";
  pill.textContent = paused && active
    ? "已暫停"
    : (active ? "辨識中" : (globalActive ? "另一批次辨識中" : (remaining ? "等待啟動" : "全部完成")));
  pill.dataset.status = paused && active ? "PAUSED" : (active ? "AI_RUNNING" : (remaining ? "AI_PENDING" : "AI_COMPLETE"));
  current.textContent = paused
    ? "佇列已暫停；按「繼續批次辨識」接續。"
    : (status?.currentEventId ? `目前處理：${status.currentEventId}` : (active ? "正在準備下一組…" : "尚未啟動批次工作"));
  for (const input of document.querySelectorAll('input[name="ai-mode"]')) input.disabled = active;
  const fastMode = selectedAiMode() === "fast";
  if (fastMode && $("#identify-species-toggle").checked) {
    $("#identify-species-toggle").checked = false;
    localStorage.setItem("cameraTrapIdentifySpecies", "false");
  }
  $("#identify-species-toggle").disabled = active || fastMode;
  $("#ai-goal-note").textContent = fastMode
    ? "快速模式固定使用常駐 MegaDetector，只讀第 1、3 張照片；不載入 SpeciesNet，也不開啟影片。"
    : (shouldIdentifySpecies()
      ? "動物事件會自動接續 SpeciesNet；若物種模型判定為 blank，會改列空觸發並保留人工覆核。"
      : "完整模式目前只判斷空觸發、動物、人與車輛，不執行物種辨識。");
  renderAiPerformance(status);
  renderUploadResults();
}

function formatPerformanceSeconds(value) {
  const seconds = Number(value || 0);
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds.toFixed(2)} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${(seconds % 60).toFixed(1)} 秒`;
}

function renderAiPerformance(status) {
  const performanceReport = status?.performance;
  const hardware = state.config?.aiRuntime?.hardware || {};
  const worker = status?.worker || {};
  const device = performanceReport?.device || worker.device || hardware.device || "—";
  const cuda = performanceReport?.cudaAvailable ?? worker.cudaAvailable ?? hardware.cudaAvailable;
  const gpuNames = performanceReport?.systemGpus || hardware.systemGpus || [];
  $("#perf-device").textContent = `${device}${cuda ? " · CUDA 可用" : " · CUDA 不可用"}${gpuNames.length ? ` · ${gpuNames.join("、")}` : ""}`;
  if (!performanceReport) {
    $("#perf-photos").textContent = "尚無新版批次紀錄";
    $("#perf-model-loads").textContent = worker.modelLoadCount ? `${worker.modelLoadCount} 次（Worker 累計）` : "尚未啟動 Worker";
    $("#perf-total").textContent = "—";
    $("#perf-average").textContent = "—";
    $("#perf-cache").textContent = "—";
    $("#perf-stages").textContent = "完成下一次快速初篩後，這裡會列出各階段耗時。";
    return;
  }
  $("#perf-photos").textContent = `${performanceReport.requestedPhotos} 張（${performanceReport.events} 組）`;
  $("#perf-model-loads").textContent = `${performanceReport.modelLoadCountThisBatch} 次（Worker 累計 ${performanceReport.workerModelLoadCount} 次）`;
  $("#perf-total").textContent = formatPerformanceSeconds(performanceReport.timingsSeconds?.total);
  $("#perf-average").textContent = `${Number(performanceReport.averageSecondsPerRequestedPhoto || 0).toFixed(3)} 秒／張`;
  $("#perf-cache").textContent = `命中 ${performanceReport.detectionCacheHits}，實際推論 ${performanceReport.inferredPhotos}`;
  const timings = performanceReport.timingsSeconds || {};
  $("#perf-stages").textContent = [
    `收集 ${formatPerformanceSeconds(timings.collect)}`,
    `快取讀取 ${formatPerformanceSeconds(timings.cacheRead)}`,
    `Worker／模型啟動 ${formatPerformanceSeconds(timings.workerStartup)}`,
    `照片解碼 ${formatPerformanceSeconds(timings.decode)}`,
    `推論 ${formatPerformanceSeconds(timings.inference)}`,
    `寫入結果 ${formatPerformanceSeconds(Number(timings.cacheWrite || 0) + Number(timings.persist || 0))}`,
  ].join(" · ");
}

function aiResultCategory(event) {
  if (event.AIStatus !== "AI_COMPLETE") return "pending";
  if (event.AIRepeatDetection === "yes") return "repeat_detection";
  const labels = new Set(String(event.AIEventLabels || "").split(";").filter(Boolean));
  if (labels.has("animal")) return "needs_species";
  if (labels.has("person") || labels.has("vehicle")) return "other_nonempty";
  return "empty";
}

function aiResultLabel(event) {
  const category = aiResultCategory(event);
  if (event.AIStatus === "FAILED") return "辨識失敗";
  if (category === "pending") return event.AIStatus === "AI_RUNNING" ? "辨識中" : "尚未辨識";
  if (category === "empty") return "空觸發";
  if (category === "repeat_detection") return "疑似固定背景誤判（待確認）";
  if (category === "other_nonempty") return "非空觸發（人／車輛）";
  return event.AISpecies ? `動物 · ${event.AISpecies}` : "動物 · 物種待追加辨識";
}

function humanResultLabel(event) {
  const labelNames = new Map([...DECISIONS, ["mixed", "混合事件"]]);
  const labels = String(event.HumanLabels || event.FinalDecision || "").split(";").filter(Boolean);
  return labels.length ? labels.map((label) => labelNames.get(label) || label).join("、") : "尚未覆核";
}

function humanReviewStatusLabel(event) {
  if (isReviewed(event)) return `已覆核 · ${event.ReviewStatus || "人工完成"}`;
  return event.ReviewStatus ? `尚未完成 · ${event.ReviewStatus}` : "尚未覆核";
}

function renderUploadResults() {
  const list = $("#upload-result-list");
  if (!list) return;
  const batch = uploadBatchEvents().sort((left, right) => {
    const timeOrder = String(left.EventTime || "").localeCompare(String(right.EventTime || ""));
    return timeOrder || eventCollator.compare(left.EventID, right.EventID);
  });
  const counts = {
    all: batch.length,
    empty: batch.filter((event) => aiResultCategory(event) === "empty").length,
    repeat_detection: batch.filter((event) => aiResultCategory(event) === "repeat_detection").length,
    needs_species: batch.filter((event) => aiResultCategory(event) === "needs_species").length,
    other_nonempty: batch.filter((event) => aiResultCategory(event) === "other_nonempty").length,
    pending: batch.filter((event) => aiResultCategory(event) === "pending").length,
  };
  $("#result-count-all").textContent = counts.all;
  $("#result-count-empty").textContent = counts.empty;
  $("#result-count-repeat").textContent = counts.repeat_detection;
  $("#result-count-species").textContent = counts.needs_species;
  $("#result-count-other").textContent = counts.other_nonempty;
  $("#result-count-pending").textContent = counts.pending;
  for (const button of document.querySelectorAll("#upload-result-tabs [data-result-filter]")) {
    button.classList.toggle("active", button.dataset.resultFilter === state.uploadResultFilter);
  }
  const completed = batch.length - counts.pending;
  $("#upload-results-meta").textContent = batch.length
    ? `此匯入批次共 ${batch.length} 組 · AI 已完成 ${completed} 組 · 空觸發 ${counts.empty} 組 · 疑似背景誤判 ${counts.repeat_detection} 組 · 動物事件 ${counts.needs_species} 組`
    : "尚未匯入事件。完成上傳後，辨識結果會依批次顯示在這裡。";

  const speciesSummary = $("#species-result-summary");
  const speciesCounts = new Map();
  for (const event of batch.filter((item) => aiResultCategory(item) === "needs_species")) {
    const candidates = String(event.AISpecies || "").split(";").map((name) => name.trim()).filter(Boolean);
    for (const candidate of candidates) speciesCounts.set(candidate, (speciesCounts.get(candidate) || 0) + 1);
  }
  if (state.uploadSpeciesFilter && !speciesCounts.has(state.uploadSpeciesFilter)) state.uploadSpeciesFilter = "";
  speciesSummary.replaceChildren();
  speciesSummary.hidden = speciesCounts.size === 0;
  if (speciesCounts.size) {
    const title = document.createElement("strong");
    title.textContent = "本批次物種候選（點選篩選）";
    speciesSummary.append(title);
    for (const [name, count] of [...speciesCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-Hant"))) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.dataset.speciesFilter = name;
      chip.className = "species-filter-chip";
      chip.classList.toggle("active", state.uploadSpeciesFilter === name);
      chip.setAttribute("aria-pressed", String(state.uploadSpeciesFilter === name));
      chip.setAttribute("aria-label", `只顯示物種候選為${name}的 ${count} 組事件`);
      chip.textContent = `${name} ${count}`;
      speciesSummary.append(chip);
    }
  }

  const filtered = batch.filter((event) => {
    const matchesCategory = state.uploadResultFilter === "all" || aiResultCategory(event) === state.uploadResultFilter;
    const candidates = new Set(String(event.AISpecies || "").split(";").map((name) => name.trim()).filter(Boolean));
    const matchesSpecies = !state.uploadSpeciesFilter || candidates.has(state.uploadSpeciesFilter);
    return matchesCategory && matchesSpecies;
  });
  if (state.uploadSpeciesFilter) {
    $("#upload-results-meta").textContent += ` · 正在篩選「${state.uploadSpeciesFilter}」${filtered.length} 組`;
  }
  list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "compact-results-empty";
    empty.textContent = batch.length
      ? (state.uploadSpeciesFilter ? `沒有符合「${state.uploadSpeciesFilter}」的事件。` : "這個分類目前沒有事件。")
      : "尚無可顯示的辨識結果。";
    list.append(empty);
  }
  for (const event of filtered.slice(0, state.uploadResultLimit)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "compact-result-item";
    button.addEventListener("click", () => openAiResultDetail(event));

    const preview = document.createElement("span");
    preview.className = "compact-result-preview";
    if (event.thumbnails?.Photo1 || event.media.Photo1) {
      const image = document.createElement("img");
      image.src = event.thumbnails?.Photo1 || event.media.Photo1;
      image.alt = `${event.EventID} 第一張照片`;
      image.loading = "lazy";
      image.addEventListener("error", () => preview.classList.add("load-error"));
      preview.append(image);
    } else {
      preview.textContent = "無照片";
    }

    const copy = document.createElement("span");
    copy.className = "compact-result-copy";
    const title = document.createElement("strong");
    title.textContent = event.EventID.replace(`${event.DeploymentID}-`, "");
    const result = document.createElement("span");
    result.className = `compact-result-status category-${aiResultCategory(event)}`;
    result.textContent = aiResultLabel(event);
    const meta = document.createElement("small");
    meta.textContent = `${event.EventTime || "無拍攝時間"}${event.AIConfidence ? ` · 偵測 ${event.AIConfidence}` : ""}${event.AISpeciesConfidence ? ` · 物種 ${event.AISpeciesConfidence}` : ""} · ${isReviewed(event) ? "人工已覆核" : "人工待覆核"}`;
    copy.append(title, result, meta);

    const detail = document.createElement("span");
    detail.className = "compact-result-open";
    detail.textContent = "查看詳細 →";
    button.append(preview, copy, detail);
    list.append(button);
  }
  const moreButton = $("#upload-results-more");
  moreButton.hidden = filtered.length <= state.uploadResultLimit;
  if (!moreButton.hidden) moreButton.textContent = `顯示更多（尚有 ${filtered.length - state.uploadResultLimit} 組）`;
}

function openAiResultDetail(event) {
  $("#ai-result-dialog-deployment").textContent = event.DeploymentID;
  $("#ai-result-dialog-title").textContent = event.EventID;
  $("#ai-result-dialog-summary").textContent = `${event.EventTime || "無拍攝時間"} · ${aiResultLabel(event)}`;
  const detailGrid = $("#ai-result-detail-grid");
  detailGrid.replaceChildren();
  for (const [label, value] of [
    ["事件結果", aiResultLabel(event)],
    ["AI 狀態", event.AIStatus || "AI_PENDING"],
    ["物種中文候選", event.AISpecies || "—"],
    ["物種信心", event.AISpeciesConfidence || "—"],
    ["信心", event.AIConfidence || "—"],
    ["固定背景檢查", event.AIRepeatDetection === "yes" ? "疑似重複誤判，請人工確認" : "未命中重複熱點"],
    ["重複證據", event.AIRepeatDetectionSupport || "—"],
    ["人工覆核狀態", humanReviewStatusLabel(event)],
    ["人工最終結果", humanResultLabel(event)],
  ]) {
    const item = document.createElement("div");
    const name = document.createElement("span");
    name.textContent = label;
    const content = document.createElement("strong");
    content.textContent = value;
    item.append(name, content);
    detailGrid.append(item);
  }

  const mediaGrid = $("#ai-result-media-grid");
  mediaGrid.replaceChildren();
  for (const key of ["Photo1", "Photo2", "Photo3"]) {
    const figure = document.createElement("figure");
    if (event.media[key]) {
      const image = document.createElement("img");
      image.src = event.media[key];
      image.alt = `${event.EventID} ${key}`;
      image.loading = "eager";
      image.addEventListener("click", () => openImage(event, key));
      figure.append(image);
    }
    const caption = document.createElement("figcaption");
    caption.textContent = `${key} · ${event[key] || "缺少檔案"}`;
    figure.append(caption);
    mediaGrid.append(figure);
  }
  const videoFigure = document.createElement("figure");
  if (event.media.Video) {
    videoFigure.append(createVideoPlayer(event));
  } else {
    const missing = document.createElement("div");
    missing.className = "ai-result-video-missing";
    missing.textContent = "此事件沒有影片";
    videoFigure.append(missing);
  }
  const videoCaption = document.createElement("figcaption");
  videoCaption.textContent = `Video · ${event.Video || "缺少檔案"}`;
  videoFigure.append(videoCaption);
  mediaGrid.append(videoFigure);
  openModalDialog($("#ai-result-dialog"));
}

function closeAiResultDetail() {
  const dialog = $("#ai-result-dialog");
  for (const media of dialog.querySelectorAll("video")) {
    media.pause();
    media.removeAttribute("src");
    media.load();
  }
  closeModalDialog(dialog);
  $("#ai-result-media-grid").replaceChildren();
}

async function pollAiBatch() {
  clearTimeout(state.aiBatchPollTimer);
  try {
    const response = await fetch(aiBatchUrl());
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "無法讀取批次辨識進度。");
    const previousFinished = Number(state.aiBatchStatus?.complete || 0) + Number(state.aiBatchStatus?.failed || 0);
    state.aiBatchStatus = payload.status;
    renderAiBatch(payload.status);
    const finished = Number(payload.status.complete || 0) + Number(payload.status.failed || 0);
    if (finished !== previousFinished || !payload.status.active) await refreshAllAiFields();
    if (payload.status.active) {
      state.aiBatchPollTimer = setTimeout(pollAiBatch, 3000);
      return;
    }
    showToast(payload.status.failed
      ? `批次辨識結束；完成 ${payload.status.complete} 組，失敗 ${payload.status.failed} 組，可再次按鈕重試。`
      : `批次辨識完成：${payload.status.complete} 組。`, Boolean(payload.status.failed));
  } catch (error) {
    state.aiBatchStatus = { ...(state.aiBatchStatus || {}), active: false };
    renderAiBatch(state.aiBatchStatus);
    showToast(error.message, true);
  }
}

async function startAiBatch() {
  if (state.aiBatchActive) return;
  if (!state.aiBatchId) {
    showToast("請先選擇要辨識的匯入批次。", true);
    return;
  }
  if (state.dirty) {
    showToast("請先儲存目前的人工標註，再啟動全部 AI 辨識。", true);
    return;
  }
  const button = $("#start-ai-batch-button");
  button.disabled = true;
  const mode = selectedAiMode();
  const identifySpecies = shouldIdentifySpecies();
  localStorage.setItem("cameraTrapAiMode", mode);
  localStorage.setItem("cameraTrapIdentifySpecies", String(identifySpecies));
  try {
    const response = await fetch(serviceUrl("/api/ai/batch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, identifySpecies, deploymentId: state.aiBatchId }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "無法建立批次 AI 工作。");
    state.aiBatchStatus = payload.status;
    renderAiBatch(payload.status);
    if (currentEvent()) renderAiResult(currentEvent());
    const cachedNote = payload.reclassified ? `已直接整理 ${payload.reclassified} 組既有 SpeciesNet 結果；` : "";
    showToast(`${cachedNote}另排入 ${payload.created} 組；已完成的 ${payload.skippedCompleted} 組不會重跑。`);
    if (payload.status.active) pollAiBatch();
  } catch (error) {
    showToast(error.message, true);
    renderAiBatch(state.aiBatchStatus);
  }
}

async function toggleAiBatchPause() {
  if (!state.aiBatchStatus?.active) return;
  const paused = !state.aiBatchStatus.paused;
  const button = $("#pause-ai-batch-button");
  button.disabled = true;
  try {
    const response = await fetch(serviceUrl("/api/ai/batch/pause"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused, deploymentId: state.aiBatchId }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "無法變更批次辨識狀態。");
    state.aiBatchStatus = payload.status;
    renderAiBatch(payload.status);
    if (currentEvent()) renderAiResult(currentEvent());
    showToast(paused ? "會在目前事件完成後暫停。" : "已繼續批次辨識。");
    pollAiBatch();
  } catch (error) {
    showToast(error.message, true);
    renderAiBatch(state.aiBatchStatus);
  }
}

async function refreshAiBatchStatus() {
  const response = await fetch(aiBatchUrl());
  const payload = await responseJson(response, "無法重新載入 AI 工作區狀態。");
  state.aiBatchStatus = payload.status;
  state.aiBatchActive = Boolean(payload.status?.active);
  renderAiBatch(payload.status);
  return payload.status;
}

async function resetAiWorkspace() {
  const total = selectedAiBatchEvents().length;
  if (!state.aiBatchId || !total) return;
  const deploymentId = state.aiBatchId;
  const batchLabel = $("#ai-batch-select").selectedOptions[0]?.textContent || deploymentId;
  const activeNote = state.aiBatchStatus?.active ? "目前執行中的工作也會取消，完成後不會寫入結果。\n\n" : "";
  if (!window.confirm(`${activeNote}要重置「${batchLabel}」的 ${total} 組 AI 結果嗎？\n照片、事件與人工覆核答案不會刪除。`)) return;
  if (!window.confirm(`再次確認：確定清除「${batchLabel}」目前的 AI 判定嗎？\n\n此批次之後需要重新執行 AI 辨識。`)) return;
  const button = $("#reset-ai-workspace-button");
  button.disabled = true;
  try {
    const response = await fetch(serviceUrl("/api/ai/reset"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "RESET_AI_BATCH", deploymentId }),
    });
    const payload = await responseJson(response, "無法重置 AI 工作區。");
    clearTimeout(state.aiBatchPollTimer);
    state.aiBatchStatus = payload.status;
    state.aiBatchActive = false;
    await reloadEventCollection();
    renderAiBatch(payload.status);
    showToast(`已重置「${batchLabel}」共 ${payload.reset} 組事件的 AI 結果。`);
  } catch (error) {
    showToast(error.message, true);
    renderAiBatch(state.aiBatchStatus);
  }
}

async function clearUploadWorkspace() {
  const total = selectedAiBatchEvents().length;
  if (!state.aiBatchId || !total) return;
  const deploymentId = state.aiBatchId;
  const batchLabel = $("#ai-batch-select").selectedOptions[0]?.textContent || deploymentId;
  if (!window.confirm(`要清除「${batchLabel}」的 ${total} 組上傳事件與工作副本嗎？\n\n其他批次、原始來源資料夾及人工覆核基準資料不受影響。`)) return;
  if (!window.confirm(`再次確認：確定永久刪除「${batchLabel}」嗎？\n\n此操作無法復原。`)) return;
  const button = $("#clear-upload-workspace-button");
  button.disabled = true;
  try {
    const response = await fetch(serviceUrl("/api/workspace/clear"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "CLEAR_UPLOAD_BATCH", deploymentId }),
    });
    const payload = await responseJson(response, "無法清除上傳工作區。");
    clearTimeout(state.aiBatchPollTimer);
    state.aiBatchActive = false;
    sessionStorage.removeItem("cameraTrapLastImport");
    await reloadEventCollection();
    await refreshAiBatchStatus();
    showToast(`已清除「${batchLabel}」共 ${payload.removed} 組事件；其他批次仍保留。`);
  } catch (error) {
    showToast(error.message, true);
    renderAiBatch(state.aiBatchStatus);
  }
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
  if (!event || state.aiJobId || state.aiBatchActive) return;
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
      body: JSON.stringify({ EventID: event.EventID, mode: selectedAiMode(), identifySpecies: shouldIdentifySpecies() }),
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

function createVideoPlayer(event) {
  const wrapper = document.createElement("div");
  wrapper.className = "video-preview-player";
  const video = document.createElement("video");
  video.controls = true;
  video.preload = "metadata";
  video.src = event.videoPreview || event.media.Video;
  const status = document.createElement("p");
  status.className = "video-preview-status";
  status.textContent = event.videoPreview
    ? "正在準備瀏覽器相容預覽；首次開啟 AVI 可能需要數秒。"
    : "正在載入影片…";
  video.addEventListener("loadedmetadata", () => {
    status.textContent = "影片已可播放。";
    status.classList.add("ready");
  });
  video.addEventListener("error", () => {
    status.textContent = "無法建立影片預覽；請使用下方連結開啟原始檔。";
    status.classList.add("error");
  });
  const original = document.createElement("a");
  original.href = event.media.Video;
  original.target = "_blank";
  original.rel = "noopener";
  original.textContent = `下載／另開原始影片：${event.Video}`;
  wrapper.append(video, status, original);
  return wrapper;
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
    mediaColumn.append(createVideoPlayer(event));
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
  note.textContent = "AVI 會在首次開啟時建立靜音的 WebM 判讀預覽；原始影片不會修改。";
  controls.append(decisionLabel, addsLabel, note);
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

function renderEmptyReviewState() {
  $("#review-view").classList.add("empty-review");
  $("#deployment-label").textContent = "REVIEW COLLECTION";
  $("#event-id").textContent = "沒有符合條件的事件";
  $("#event-time").textContent = "請調整資料批次、覆核狀態或搜尋條件。";
  $("#event-position").textContent = "0 / 0";
  $("#previous-button").disabled = true;
  $("#next-button").disabled = true;
  $("#metadata-strip").replaceChildren();
  setDirty(false);
}

function renderCurrentEvent({ scrollToTop = true } = {}) {
  const event = currentEvent();
  if (!event) return renderEmptyReviewState();
  $("#review-view").classList.remove("empty-review");
  $("#deployment-label").textContent = event.DeploymentID;
  $("#event-id").textContent = event.EventID;
  $("#event-time").textContent = event.EventTime || "沒有事件時間";
  const position = state.filtered.findIndex((candidate) => candidate.EventID === event.EventID);
  $("#event-position").textContent = position >= 0 ? `${position + 1} / ${state.filtered.length}` : `— / ${state.filtered.length}`;
  $("#previous-button").disabled = position <= 0;
  $("#next-button").disabled = position < 0 || position >= state.filtered.length - 1;
  renderMetadata(event);
  renderPhotos(event);
  renderVideo(event);
  renderAiResult(event);
  renderFilenameHint(event);
  renderTaxonomy(event);
  setFormValues(event);
  renderEventList();
  setDirty(false);
  if (scrollToTop) window.scrollTo({ top: 0, behavior: "smooth" });
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
    renderUploadResults();
    setDirty(false);
    notifyEventDataChanged("human-review");
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

function updateImageDialog() {
  const item = state.imageGallery[state.imageGalleryIndex];
  if (!item) return;
  $("#dialog-image").src = item.source;
  $("#dialog-image").alt = `${item.eventId} ${item.key}`;
  $("#dialog-caption").textContent = `${item.key} · ${item.caption}`;
  $("#dialog-position").textContent = `${state.imageGalleryIndex + 1} / ${state.imageGallery.length}`;
  $("#dialog-previous").disabled = state.imageGalleryIndex === 0;
  $("#dialog-next").disabled = state.imageGalleryIndex >= state.imageGallery.length - 1;
}

function openImage(event, selectedKey) {
  state.imageGallery = ["Photo1", "Photo2", "Photo3"]
    .filter((key) => event.media[key])
    .map((key) => ({ key, source: event.media[key], caption: event[key], eventId: event.EventID }));
  state.imageGalleryIndex = Math.max(0, state.imageGallery.findIndex((item) => item.key === selectedKey));
  updateImageDialog();
  openModalDialog($("#image-dialog"));
}

function navigateImage(offset) {
  const nextIndex = state.imageGalleryIndex + offset;
  if (nextIndex < 0 || nextIndex >= state.imageGallery.length) return;
  state.imageGalleryIndex = nextIndex;
  updateImageDialog();
}

function closeImageDialog() {
  closeModalDialog($("#image-dialog"));
  $("#dialog-image").removeAttribute("src");
  state.imageGallery = [];
  state.imageGalleryIndex = 0;
}

function handleImageDialogKeydown(event) {
  if (!$("#image-dialog").open) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    navigateImage(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    navigateImage(1);
  }
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
  if (!globalThis.crypto?.subtle || file.size > 64 * 1024 * 1024) return "SERVER_CALCULATED";
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clearImportPreviews() {
  for (const url of state.importPreviewUrls) URL.revokeObjectURL(url);
  state.importPreviewUrls = [];
  $("#import-preview").replaceChildren();
}

function resetImportSelection() {
  clearImportPreviews();
  state.importFiles = [];
  state.importJob = null;
  $("#photo-picker").value = "";
  $("#folder-picker").value = "";
  $("#import-summary").textContent = "尚未選擇檔案";
  $("#hash-progress").hidden = true;
  $("#hash-progress").value = 0;
  $("#prepare-job-button").disabled = true;
  $("#prepare-job-button").textContent = "上傳並建立事件";
  $("#clear-import-button").disabled = true;
  $("#job-result").hidden = true;
}

async function clearImportSelection() {
  if (state.uploading) {
    showToast("正在傳送檔案，請等待目前檔案完成後再清除。", true);
    return;
  }
  if (!state.importFiles.length && !state.importJob) return;
  if (!window.confirm("要清除目前已選取的檔案與未完成上傳嗎？\n電腦中的原始檔不會被刪除。")) return;
  try {
    if (state.importJob?.importId && state.importJob.status !== "COMPLETE") {
      const response = await fetch(serviceUrl(`/api/imports/${encodeURIComponent(state.importJob.importId)}`), { method: "DELETE" });
      await responseJson(response, "無法取消未完成的上傳工作。");
    }
    resetImportSelection();
    showToast("已清除目前選取；可以重新選擇其他資料夾。");
  } catch (error) {
    showToast(error.message, true);
  }
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
      mediaType.className = "import-media-icon";
      mediaType.textContent = "VIDEO";
      card.append(mediaType);
    }
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = item.relativePath;
    const detail = document.createElement("small");
    detail.textContent = item.sha256 === "SERVER_CALCULATED"
      ? `${formatBytes(item.file.size)} · SHA-256 由服務端驗證`
      : `${formatBytes(item.file.size)} · SHA-256 ${item.sha256.slice(0, 12)}…`;
    copy.append(name, detail);
    card.append(copy);
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
  if (state.uploading) return;
  if (state.importJob && state.importFiles.some((item) => item.uploaded)) {
    showToast("目前有未完成上傳；請先按「清除已選檔案」或繼續完成上傳。", true);
    return;
  }
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
  $("#prepare-job-button").textContent = "上傳並建立事件";
  if (!candidates.length) {
    $("#import-summary").textContent = "沒有可接受的照片或影片。";
    $("#clear-import-button").disabled = true;
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
  if (!$("#import-deployment-name").value && folders.size === 1 && !folders.has("單檔選取")) {
    $("#import-deployment-name").value = [...folders][0];
  }
  $("#import-summary").textContent = `已檢查 ${state.importFiles.length} 個檔案 · ${folders.size} 個來源 · ${formatBytes(totalBytes)} · 預估約 ${Math.ceil(state.importFiles.length / 4)} 個事件`;
  $("#prepare-job-button").disabled = false;
  $("#clear-import-button").disabled = false;
  renderImportPreview();
}

async function responseJson(response, fallbackMessage) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || fallbackMessage);
  return payload;
}

async function reloadEventCollection(preferredId = "") {
  const response = await fetch(serviceUrl("/api/events"));
  const payload = await responseJson(response, "無法重新載入事件成果。");
  state.events = payload.events.map(normalizeEvent);
  const preferredBatchId = state.events.find((event) => event.EventID === preferredId && event.SourceType === "web_upload")?.DeploymentID || "";
  syncCollectionSelectors(preferredBatchId, preferredBatchId);
  recalculateStatus();
  state.currentId = state.events.some((event) => event.EventID === preferredId)
    ? preferredId
    : (state.currentId && state.events.some((event) => event.EventID === state.currentId) ? state.currentId : state.events[0]?.EventID || null);
  renderStatus();
  applyFilter();
  if (state.currentId) renderCurrentEvent();
  else renderEmptyReviewState();
  renderUploadResults();
}

function notifyEventDataChanged(kind) {
  const message = { kind, at: Date.now() };
  if (eventSyncChannel) eventSyncChannel.postMessage(message);
  else localStorage.setItem(EVENT_SYNC_CHANNEL, JSON.stringify(message));
}

async function syncEventsFromServer({ reason = "manual", includeBatch = true } = {}) {
  if (!state.serverAvailable) return false;
  if (eventSyncPromise) return eventSyncPromise;
  eventSyncPromise = (async () => {
    const previousCurrentId = state.currentId;
    const previousUploadBatchId = state.uploadBatchId;
    const previousAiBatchId = state.aiBatchId;
    const wasDirty = state.dirty;
    const requests = [fetch(serviceUrl("/api/events"))];
    if (includeBatch) requests.push(fetch(aiBatchUrl()));
    const [eventsResponse, batchResponse] = await Promise.all(requests);
    const eventPayload = await responseJson(eventsResponse, "無法同步 AI 與人工覆核資料。");
    state.events = eventPayload.events.map(normalizeEvent);
    syncCollectionSelectors(previousUploadBatchId, previousAiBatchId);
    state.currentId = state.events.some((event) => event.EventID === previousCurrentId)
      ? previousCurrentId
      : (reviewEvents()[0]?.EventID || state.events[0]?.EventID || null);
    if (batchResponse) {
      const batchPayload = await responseJson(batchResponse, "無法同步 AI 批次狀態。");
      state.aiBatchStatus = batchPayload.status;
      state.aiBatchActive = Boolean(batchPayload.status?.active);
      renderAiBatch(state.aiBatchStatus);
    }
    recalculateStatus();
    renderStatus();
    applyFilter();
    if (state.currentView === "review") {
      if (!currentEvent()) renderEmptyReviewState();
      else if (wasDirty) {
        renderAiResult(currentEvent());
        renderMetadata(currentEvent());
        renderEventList();
        setDirty(true);
      } else renderCurrentEvent({ scrollToTop: false });
    }
    renderUploadResults();
    lastEventSyncAt = Date.now();
    return true;
  })().catch((error) => {
    if (reason !== "focus" && reason !== "visibility") showToast(error.message, true);
    throw error;
  }).finally(() => {
    eventSyncPromise = null;
  });
  return eventSyncPromise;
}

function requestEventSync(reason, force = false) {
  if (!state.serverAvailable || state.saving) return;
  if (!force && Date.now() - lastEventSyncAt < 1500) return;
  void syncEventsFromServer({ reason }).catch(() => {});
}

async function uploadImportJob() {
  if (!state.importFiles.length || state.uploading) return;
  state.uploading = true;
  const button = $("#prepare-job-button");
  const progress = $("#hash-progress");
  const result = $("#job-result");
  button.disabled = true;
  $("#clear-import-button").disabled = true;
  result.hidden = false;
  progress.hidden = false;
  progress.max = state.importFiles.length + 1;
  progress.value = state.importFiles.filter((item) => item.uploaded).length;
  try {
    if (!state.importJob) {
      $("#import-summary").textContent = "正在建立安全上傳工作…";
      const response = await fetch(serviceUrl("/api/imports"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "2.1",
          deploymentName: $("#import-deployment-name").value.trim(),
          media: state.importFiles.map((item) => ({
            relativePath: item.relativePath,
            filename: item.file.name,
            size: item.file.size,
            mimeType: item.file.type || "application/octet-stream",
            lastModified: new Date(item.file.lastModified).toISOString(),
            sha256: item.sha256,
          })),
        }),
      });
      state.importJob = (await responseJson(response, "無法建立上傳工作。")).import;
    }
    for (let index = 0; index < state.importFiles.length; index += 1) {
      const item = state.importFiles[index];
      if (item.uploaded) continue;
      $("#import-summary").textContent = `正在上傳 ${index + 1} / ${state.importFiles.length}：${item.relativePath}`;
      const response = await fetch(serviceUrl(`/api/imports/${encodeURIComponent(state.importJob.importId)}/files/${index}`), {
        method: "POST",
        headers: { "Content-Type": item.file.type || "application/octet-stream" },
        body: item.file,
      });
      const payload = await responseJson(response, `上傳失敗：${item.relativePath}`);
      item.uploaded = true;
      item.serverSha256 = payload.file.sha256;
      progress.value = index + 1;
    }
    $("#import-summary").textContent = "媒體上傳完成，正在建立事件…";
    const finalizeResponse = await fetch(serviceUrl(`/api/imports/${encodeURIComponent(state.importJob.importId)}/finalize`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const completed = (await responseJson(finalizeResponse, "媒體已上傳，但建立事件失敗。")).import;
    progress.value = state.importFiles.length + 1;
    state.importJob = completed;
    sessionStorage.setItem("cameraTrapLastImport", JSON.stringify(completed));
    await reloadEventCollection(completed.eventIds[0] || "");
    await refreshAiBatchStatus();
    $("#filter-select").value = "all";
    $("#content-filter-select").value = "all";
    $("#search-input").value = "";
    applyFilter();
    $("#import-summary").textContent = `完成：${completed.mediaCount} 個媒體已建立 ${completed.eventIds.length} 個事件，原始檔未被修改。`;
    result.textContent = JSON.stringify({
      importId: completed.importId,
      deploymentId: completed.deploymentId,
      status: completed.status,
      mediaCount: completed.mediaCount,
      eventCount: completed.eventIds.length,
      firstEvent: completed.eventIds[0] || "",
      nextStep: "可關閉視窗，從事件清單查看成果或啟動 MegaDetector／SpeciesNet。",
    }, null, 2);
    showToast(`已建立 ${completed.eventIds.length} 個可辨識事件`);
    clearImportPreviews();
    state.importFiles = [];
    state.importJob = null;
    $("#clear-import-button").disabled = true;
    $("#photo-picker").value = "";
    $("#folder-picker").value = "";
  } catch (error) {
    result.textContent = `上傳尚未完成：${error.message}\n\n保留此視窗後再按一次，可從目前檔案繼續。`;
    $("#import-summary").textContent = error.message;
    button.disabled = false;
    showToast(error.message, true);
  } finally {
    state.uploading = false;
    progress.hidden = state.importFiles.length === 0;
    button.textContent = state.importFiles.length ? "繼續上傳並建立事件" : "上傳並建立事件";
    $("#clear-import-button").disabled = state.importFiles.length === 0;
  }
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
  $("#content-filter-select").addEventListener("change", applyFilter);
  $("#review-collection-select").addEventListener("change", (event) => {
    const previous = state.reviewCollectionId;
    if (state.dirty && !window.confirm("目前事件尚未儲存。要放棄修改並切換覆核資料批次嗎？")) {
      event.target.value = previous;
      return;
    }
    state.reviewCollectionId = event.target.value || "registered";
    state.currentId = null;
    $("#filter-select").value = "all";
    $("#content-filter-select").value = "all";
    $("#search-input").value = "";
    setDirty(false);
    recalculateStatus();
    renderStatus();
    applyFilter();
  });
  $("#upload-results-batch-select").addEventListener("change", (event) => {
    state.uploadBatchId = event.target.value;
    state.uploadResultFilter = "all";
    state.uploadSpeciesFilter = "";
    state.uploadResultLimit = 24;
    renderUploadResults();
  });
  $("#ai-batch-select").addEventListener("change", async (event) => {
    state.aiBatchId = event.target.value;
    await refreshAiBatchStatus().catch((error) => showToast(error.message, true));
  });
  $("#upload-result-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-result-filter]");
    if (!button) return;
    state.uploadResultFilter = button.dataset.resultFilter;
    state.uploadSpeciesFilter = "";
    state.uploadResultLimit = 24;
    renderUploadResults();
  });
  $("#species-result-summary").addEventListener("click", (event) => {
    const button = event.target.closest("[data-species-filter]");
    if (!button) return;
    const selectedSpecies = button.dataset.speciesFilter;
    state.uploadSpeciesFilter = state.uploadSpeciesFilter === selectedSpecies ? "" : selectedSpecies;
    state.uploadResultFilter = "needs_species";
    state.uploadResultLimit = 24;
    renderUploadResults();
  });
  $("#upload-results-more").addEventListener("click", () => {
    state.uploadResultLimit += 24;
    renderUploadResults();
  });
  $("#close-dialog").addEventListener("click", closeImageDialog);
  $("#dialog-previous").addEventListener("click", () => navigateImage(-1));
  $("#dialog-next").addEventListener("click", () => navigateImage(1));
  document.addEventListener("keydown", handleImageDialogKeydown);
  $("#image-dialog").addEventListener("click", (event) => {
    if (event.target === $("#image-dialog")) closeImageDialog();
  });
  $("#close-ai-result-dialog").addEventListener("click", closeAiResultDetail);
  $("#ai-result-dialog").addEventListener("click", (event) => {
    if (event.target === $("#ai-result-dialog")) closeAiResultDetail();
  });
  for (const dialog of document.querySelectorAll("dialog")) dialog.addEventListener("close", syncModalScrollLock);
  $("#open-import-button").addEventListener("click", () => openModalDialog($("#import-dialog")));
  $("#open-local-setup-button").addEventListener("click", () => openModalDialog($("#local-setup-dialog")));
  $("#open-offline-setup-button").addEventListener("click", () => openModalDialog($("#local-setup-dialog")));
  $("#close-local-setup-button").addEventListener("click", () => closeModalDialog($("#local-setup-dialog")));
  $("#open-import-home-button").addEventListener("click", () => openModalDialog($("#import-dialog")));
  $("#open-import-card-button").addEventListener("click", () => openModalDialog($("#import-dialog")));
  $("#upload-tab").addEventListener("click", () => showView("upload"));
  $("#review-tab").addEventListener("click", () => showView("review"));
  $("#close-import-dialog").addEventListener("click", () => closeModalDialog($("#import-dialog")));
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
  $("#clear-import-button").addEventListener("click", clearImportSelection);
  $("#prepare-job-button").addEventListener("click", uploadImportJob);
  $("#start-ai-button").addEventListener("click", startAiInference);
  $("#start-ai-batch-button").addEventListener("click", startAiBatch);
  $("#pause-ai-batch-button").addEventListener("click", toggleAiBatchPause);
  $("#reset-ai-workspace-button").addEventListener("click", resetAiWorkspace);
  $("#clear-upload-workspace-button").addEventListener("click", clearUploadWorkspace);
  const savedAiMode = localStorage.getItem("cameraTrapAiMode");
  const savedModeInput = document.querySelector(`input[name="ai-mode"][value="${savedAiMode === "full" ? "full" : "fast"}"]`);
  if (savedModeInput) savedModeInput.checked = true;
  $("#identify-species-toggle").checked = localStorage.getItem("cameraTrapIdentifySpecies") === "true";
  for (const input of document.querySelectorAll('input[name="ai-mode"]')) {
    input.addEventListener("change", async () => {
      localStorage.setItem("cameraTrapAiMode", selectedAiMode());
      renderAiBatch(state.aiBatchStatus);
      if (!state.aiBatchActive && state.serverAvailable) await refreshAiBatchStatus().catch((error) => showToast(error.message, true));
    });
  }
  $("#identify-species-toggle").addEventListener("change", async () => {
    localStorage.setItem("cameraTrapIdentifySpecies", String(shouldIdentifySpecies()));
    renderAiBatch(state.aiBatchStatus);
    if (!state.aiBatchActive && state.serverAvailable) await refreshAiBatchStatus().catch((error) => showToast(error.message, true));
  });
  showView(window.location.hash === "#review" ? "review" : "upload", false);
  window.addEventListener("hashchange", () => showView(window.location.hash === "#review" ? "review" : "upload", false));
  if (eventSyncChannel) eventSyncChannel.addEventListener("message", () => requestEventSync("cross-tab", true));
  else window.addEventListener("storage", (event) => {
    if (event.key === EVENT_SYNC_CHANNEL) requestEventSync("cross-tab", true);
  });
  window.addEventListener("focus", () => requestEventSync("focus"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestEventSync("visibility");
  });

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
    syncCollectionSelectors();
    recalculateStatus();
    const batchResponse = await fetch(aiBatchUrl());
    if (!batchResponse.ok) throw new Error("無法讀取 AI 批次資料。");
    const batchPayload = await batchResponse.json();
    state.aiBatchStatus = batchPayload.status;
    state.aiBatchActive = Boolean(batchPayload.status?.active);
    state.taxonomy = (await taxonomyResponse.json()).taxonomy;
    state.serverAvailable = true;
    renderConnectionState();
    $("#app-title").textContent = state.config.appName;
    document.title = `${state.config.appName} · ${state.config.deploymentId}`;
    renderStatus();
    applyFilter();
    if (state.currentId) renderCurrentEvent();
    else renderEmptyReviewState();
    renderAiBatch(state.aiBatchStatus);
    if (state.aiBatchActive) pollAiBatch();
  } catch (error) {
    state.serverAvailable = false;
    renderConnectionState();
    const connectionMessage = error instanceof TypeError
      ? "尚未偵測到本機辨識器。"
      : error.message;
    showToast(`${connectionMessage} 請按「查看啟動步驟」完成設定後再重新連線。`, true);
    $("#event-id").textContent = "載入失敗";
  }
}

start();
