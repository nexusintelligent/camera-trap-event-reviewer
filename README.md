# 野生動物事件判讀台 v1.0

這是 `CAM023-2026-08-A` 的本機第一版照片辨識／人工覆核軟體。它把同一次觸發的三張照片與一段影片組成單一事件，讓標註者先做照片判讀，再視需要開啟影片第二輪，最後輸出可供模型訓練與品質稽核的 CSV。

## 立即使用

1. 雙擊 `啟動照片辨識軟體.cmd`。
2. 瀏覽器會開啟 `http://127.0.0.1:4173/`。
3. 每個事件先看三張照片並填「照片判定」。
4. 完成第一輪後才按「啟用影片第二輪」。
5. 填寫最終判定、物種／分類階層、信心與覆核資訊。
6. 按「儲存」或 `Ctrl+S`。

工作結果寫到：

`D:\CameraTrap_Gold_v1\04_annotations\CAM023-2026-08-A_gold_annotation_events_v1.0_working.csv`

每次覆寫前會保留上一版：

`CAM023-2026-08-A_gold_annotation_events_v1.0_working.csv.backup.csv`

若要停止背景服務，雙擊 `停止照片辨識軟體.cmd`。

## v1 的定位

v1 是「事件式判讀與標註工具」，不是已訓練完成的自動物種模型。現有資料還沒有足夠的專家黃金標籤，直接聲稱能自動辨識物種會造成假精準。這一版先確保：

- 三張照片以事件為單位一起看，降低單張誤判。
- 照片與影片判定分開記錄，能量化影片新增資訊的比例。
- 支援 `ANIMAL_UNKNOWN`、`Muridae sp.`、`Prinia sp.` 等保守分類。
- 檔名提示只顯示為未驗證線索，不會自動寫入答案。
- 只監聽本機 `127.0.0.1`，不會上傳影像。
- 匯出欄位與 Timelapse 範本／黃金標註表一致。

完成足夠的雙人覆核標籤後，下一版才適合加入模型推論、信心門檻、批次建議與錯誤分析。

## Timelapse 相容檔

本專案的 Timelapse 範本位於：

`D:\CameraTrap_Gold_v1\04_annotations\CAM023-2026-08-A_gold_template_v1.0.tdb`

它依 Timelapse 官方 `TemplateTable`、`FolderDataTemplateTable`、`FolderDataInfo`、`TemplateInfo` 結構建立，包含 4 個標準控制列與 29 個專案欄位。由於目前 Windows 安全機制攔截本機 Timelapse 執行檔，這個檔案已做 SQLite 結構驗證，但尚未在 Template Editor GUI 內開啟驗證。不要為此停用防毒；可由系統管理員確認官方安裝檔後再解除封鎖。

官方參考：

- https://timelapse.ucalgary.ca/
- https://timelapse.ucalgary.ca/guides/
- https://github.com/saulgreenberg/Timelapse

## 設定

預設路徑與連接埠在 `config.json`。也可在啟動前用以下環境變數覆寫：

- `CAMTRAP_PORT`
- `CAMTRAP_MANIFEST_CSV`
- `CAMTRAP_WORKING_CSV`
- `CAMTRAP_MEDIA_ROOT`
- `CAMTRAP_TAXONOMY_JSON`

伺服器只使用 Node.js 內建模組，不需安裝 npm 套件。
