# 野生動物事件判讀台 v2.1

這是 `CAM023-2026-08-A` 的事件級照片／影片判讀工具。每個事件包含三張照片與一段影片，網站將 AI 原始結果與人工最終答案分開保存，支援多標籤、保守分類、稽核紀錄及 CSV 匯出。

## 啟動與使用

1. 第一次使用 AI 時，雙擊 `安裝AI辨識環境.cmd`。腳本會在使用者的 `%LOCALAPPDATA%\CameraTrapReviewer` 建立 Python 3.11 執行環境，並安裝固定版本的 MegaDetector 與 SpeciesNet。
2. 雙擊 `啟動照片辨識軟體.cmd`。
3. 瀏覽器開啟 `http://127.0.0.1:4173/`。
4. 選擇事件後，按「執行 MegaDetector + SpeciesNet」。第一次辨識會下載官方模型權重，因此時間較久。
5. 檢視三張照片與影片，再填寫人工事件標籤、物種、最大同時可見數、信心與複核資訊。
6. 按「儲存」或 `Ctrl+S`。

AI 任務的原始 JSON 與執行紀錄預設保存於：

`D:\CameraTrap_Gold_v1\04_annotations\ai_jobs_v2`

SpeciesNet 模型權重快取於 `%LOCALAPPDATA%\CameraTrapReviewer\model-cache`，不會提交到 GitHub。

人工工作成果保存於：

`D:\CameraTrap_Gold_v1\04_annotations\CAM023-2026-08-A_gold_annotation_events_v1.0_working.csv`

每次覆寫前會建立 `.backup.csv`，人工變更另寫入 JSONL 稽核紀錄。媒體優先以硬連結或唯讀連結送入 AI 工作目錄；跨磁碟或權限不允許時才建立工作副本。流程不會重新命名、移動或刪除原始檔。

## AI 流程

目前固定版本與預設值：

- MegaDetector `10.0.24`，模型 `MDv1000-redwood`。
- SpeciesNet `5.0.5`，地區提示 `TWN`。
- 偵測分類門檻 `0.15`，結果輸出門檻 `0.01`。
- 影片每 `1` 秒取樣一次。

流程為：MegaDetector 先辨識 `animal`、`person`、`vehicle` 與位置框；動物位置框再交給 SpeciesNet 做物種分類；最後彙整成事件級 AI 標籤。若 AI 與既有人工標籤不一致，事件標為 `CONFLICT`，但不會覆寫人工答案。

AI 狀態使用 `AI_PENDING`、`AI_RUNNING`、`AI_COMPLETE` 與 `FAILED`。人工複核狀態使用 `NEEDS_REVIEW`、`HUMAN_CONFIRMED`、`UNCERTAIN`、`CONFLICT` 等值。

官方專案與用法：

- [MegaDetector](https://github.com/agentmorris/MegaDetector)
- [SpeciesNet](https://github.com/google/cameratrapai)
- [MegaDetector + SpeciesNet 指令文件](https://megadetector.readthedocs.io/en/latest/detection.html#module-megadetector.detection.run_md_and_speciesnet)

## 本機網站與 GitHub Pages

[GitHub Pages](https://nexusintelligent.github.io/camera-trap-event-reviewer/) 提供可安裝的 PWA 外殼。因瀏覽器安全限制及 AI 模型大小，媒體、CSV 與 AI 推論仍由本機 `127.0.0.1:4173` 服務處理；Pages 網站會連線到使用者自行啟動的本機服務。資料不會自動上傳到 GitHub。

若瀏覽器保留舊版畫面，請按 `Ctrl+F5` 強制重新整理，或在瀏覽器的應用程式設定中移除舊版 PWA 後重新安裝。

## PWA 安裝

用 Chrome 或 Edge 開啟網站後，使用網址列的安裝圖示或瀏覽器選單「安裝應用程式」。PWA 可以快取操作介面，但不會快取相機陷阱媒體、CSV 或 API 回應；本機服務停止時仍無法讀取事件資料或執行 AI。

## 設定

主要設定在 `config.json`，也可用環境變數覆寫：

- `CAMTRAP_PORT`
- `CAMTRAP_MANIFEST_CSV`
- `CAMTRAP_WORKING_CSV`
- `CAMTRAP_AUDIT_LOG`
- `CAMTRAP_MEDIA_ROOT`
- `CAMTRAP_TAXONOMY_JSON`
- `CAMTRAP_AI_PYTHON`
- `CAMTRAP_AI_MODEL_CACHE`
- `CAMTRAP_AI_JOBS_ROOT`
- `CAMTRAP_AI_COUNTRY`
- `CAMTRAP_AI_DETECTOR_MODEL`

網站後端只使用 Node.js 內建模組，不需執行 `npm install`。AI 是獨立的 Python 3.11 環境。

## 測試

啟動服務後執行：

```powershell
npm run smoke
```

測試包含 PWA、154 事件載入、媒體串流、路徑防護、AI 狀態／任務 API、不可由瀏覽器覆寫 AI 欄位、人工標註驗證與匯出功能。
