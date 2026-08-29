# 相機陷阱本機辨識器 v3.1

這一版是給多位獨立使用者使用的「本機優先」相機陷阱工作站。

使用者從網站主動選擇照片或資料夾；檔案、AI 模型、辨識快取、人工覆核及 CSV 都只會儲存在該使用者自己的電腦。GitHub Pages 只提供可安裝的操作介面，**不提供中央辨識後端，也不會接收照片**。

```text
GitHub Pages / PWA（操作介面）
             │ HTTPS → 僅連到同一台電腦
127.0.0.1:4173 本機辨識器（Node + Python AI）
             │
%LOCALAPPDATA%\CameraTrapReviewer（照片工作副本、模型、結果、CSV）
```

## 一般使用者操作

1. 下載或解壓專案資料夾。
2. 第一次使用時，雙擊 `安裝照片辨識軟體.cmd`。它會在使用者資料夾自動準備免安裝的 Node.js 24 LTS、Python 3.11、MegaDetector、SpeciesNet 與模型權重；不需要管理員權限，也不需要設定 PATH。第一次需要網路與數分鐘時間。舊檔名 `安裝AI辨識環境.cmd` 仍可使用。
3. 每次辨識前，雙擊 `啟動照片辨識軟體.cmd`。
4. 開啟 GitHub Pages 網站（或本機 `http://127.0.0.1:4173/`），確認畫面顯示已連線。
5. 點選「開始選擇照片」，選擇檔案或資料夾，輸入批次名稱後上傳並建立事件。
6. 選擇快速初篩或完整辨識；需要時進入「人工覆核」確認結果，最後匯出 CSV。

若介面顯示「本機服務尚未連線」，點選「查看啟動步驟」。這是服務尚未啟動的提示，不再顯示籠統的 `Failed to fetch` 或要求舊電腦的 `D:` 磁碟。

## 資料與隱私

- 瀏覽器無法自行掃描硬碟；它只讀取使用者在檔案選擇器中明確選取的媒體。
- 原始照片及影片不會被重新命名、移動、覆寫或刪除。
- 系統會在 `%LOCALAPPDATA%\CameraTrapReviewer\web-uploads` 儲存工作副本；這讓 AI 能使用本機檔案，並能在同一批次內重新執行。
- AI 模型和快取儲存在 `%LOCALAPPDATA%\CameraTrapReviewer\model-cache`；AI 任務儲存在 `ai-jobs`；人工覆核 CSV 與稽核紀錄儲存在 `data`。
- 本機服務只監聽 `127.0.0.1:4173`，不接受區域網路或網際網路連線。
- 每台電腦及每個 Windows 使用者帳號都有自己的工作區；資料不會自動同步或和其他人互通。

## AI 流程

- 快速模式：使用常駐 MegaDetector Worker 判斷空觸發、動物、人與車輛；只讀取每個事件的第 1 與第 3 張照片，適合大量初篩。
- 完整模式：分析 3 張照片；啟用「需要辨識物種」後，也會使用 SpeciesNet 並納入影片取樣。
- 預設模型：MegaDetector `10.0.24`（`MDv1000-redwood`）與 SpeciesNet `5.0.5`，地區提示為 `TWN`。
- AI 只提供初篩；人工答案與 AI 判定衝突時不會被覆寫，而會標為 `CONFLICT` 供覆核。

## 可選：載入既有黃金資料

v3 預設沒有任何共用事件，新的電腦可直接從上傳媒體開始。若要載入某個既有專案，啟動前以環境變數指定自己的資料路徑：

```powershell
$env:CAMTRAP_MANIFEST_CSV = 'E:\MyProject\events.csv'
$env:CAMTRAP_MEDIA_ROOT = 'E:\MyProject\media'
./啟動照片辨識軟體.cmd
```

也可以在 `config.json` 設定對應位置。不要將其他使用者的來源資料或模型權重提交到 GitHub。

## 維護與故障排除

- 安裝程式會自動準備 Node.js 24 LTS 與 Python 3.11，不需要另外安裝 Node.js。
- 下載的 Node.js 會驗證官方 SHA-256 校驗碼，並依電腦自動選擇 Windows x64 或 ARM64 版本。
- 若服務未啟動，查看 `logs\server.stderr.log`。
- 若 Node.js 或模型遺失、損壞，重新執行 `安裝照片辨識軟體.cmd`。
- 停止服務可雙擊 `停止照片辨識軟體.cmd`。
- 更新 Pages 後若仍見舊介面，使用 `Ctrl+F5` 或移除舊版 PWA 後重新安裝。

## 開發與驗證

專案的 Node 服務只使用內建模組；不需執行 `npm install`。

```powershell
node server.mjs
npm run smoke:local
```

`smoke:local` 驗證全新的空白本機工作區能啟動、允許 GitHub Pages 的本機 CORS 連線並提供必要的 API。舊版 `npm run smoke` 仍保留給載入黃金資料的專案情境。
