# 華夏古城 — 多 Agent 開發報告

本專案由一個 **Team Lead + 7 名 Agent** 協作完成，全程使用共享檔案系統、
任務看板（team_task_*）與 Agent 間訊息溝通。以下記錄分工、交付內容與整合驗收。

## 1. 團隊組成與任務

| Agent | 角色 | 任務 | 主要交付檔案 |
|---|---|---|---|
| **Lead** | 架構／整合／驗收 | 專案 scaffold、核心型別與設定、存檔系統、事件匯流排、城市視圖（相機／輸入／室內切換）、主迴圈、測試、部署 | `package.json`、`src/core/**`、`src/main.ts`、`src/render/city-view.ts`、`tests/**`、`scripts/**` |
| **game-designer** | 遊戲設計 | 上網研究同類遊戲、撰寫玩法／介面／數值設計文件 | `docs/RESEARCH.md`（7 款遊戲、23 來源）、`docs/GAME_DESIGN.md`（1310 行 GDD） |
| **world-renderer** | 世界／環境渲染 | 世界生成、地形、道路、晝夜四季天氣視覺 | `src/world/worldgen.ts`、`src/render/{terrain,roads,environment,world-utils,world-geometry}.ts` |
| **architecture-dev** | 建築／室內 | 22 種中式建築程序化模型、可進入的室內場景 | `src/render/{buildings,interior}.ts`、`src/render/models/**` |
| **citizen-dev** | 市民系統 | 市民行為狀態機、人口／就業／幸福度、村民與馬車渲染 | `src/sim/{citizens,population,citizen-common}.ts`、`src/render/citizens.ts` |
| **logistics-dev** | 物流系統 | 道路 A*、搬運工調度、倉儲／市集補貨、擺放拆除規則 | `src/sim/{pathfinding,placement,logistics,logistics-inventory}.ts` |
| **economy-dev** | 時間／經濟 | 時間天氣、生產、財政月結算、統計、模擬主迴圈 | `src/sim/{time,production,finance,stats,simulation}.ts` |
| **ui-dev** | 使用者介面 | 全部 DOM 介面重構與古風視覺、8 個 UI 模組與 7 個 CSS 分檔 | `src/ui/**`、`src/styles.css` |

寫入範圍以任務看板 `write_scopes` 協調，全程無檔案衝突；各 Agent 完成後
`npx tsc --noEmit` 零錯誤、標記任務完成並向 Lead 回報。

## 2. 協作流程

1. **Lead 先完成 scaffold 與契約**：型別（`core/types.ts`）、資料表（`core/config.ts`）、
   模組介面（渲染 factory、sim 函式簽名）、架構文件（`docs/ARCHITECTURE.md`），
   先讓專案可以 build／run，再把大型工作拆成 7 個 disjoint 任務。
2. **平行開發**：7 名 Agent 同時認領任務、各自實作；跨系統約定（生產只寫本地庫存、
   市民只扣市集庫存、碼頭收入即時入帳等）由 Agent 之間直接 send_message 對齊，
   並在開發中互相核對（例如 citizen-dev ↔ logistics-dev 對補貨／取糧優先序、
   economy-dev ↔ citizen-dev 對商稅公式與失業年齡）。
3. **設計文件校準**：game-designer 在開發中途完成 GDD，各 Agent 主動對照文件微調
   （economy-dev 據此改寫財政公式與天氣持續時間；citizen-dev 對齊幸福公式與移動速度）。
4. **Lead 整合與驗收**：合併後跑 `tsc`、`vitest`、`vite build`、Playwright 全流程驗收、
   真實滑鼠 UI 測試、截圖檢視；修正 balance（茶園解鎖 70→45）、把模擬 log 接上城事紀要、
   產出文件與部署。

## 3. 關鍵設計決策

- **模擬與渲染解耦**：`GameState` 為唯一真實來源；`sim` 只改 state，渲染模組每幀讀 state；
  UI 以事件／輪詢更新，室內模式切換由 `GameStore` 事件（enter/exit）驅動。
- **固定模擬順序**：clock → citizens → logistics → 每日（連通／生產／人口／服務收入）→
  每月（財政）→ 統計；避免子系統互相依賴順序混亂。
- **物流真實庫存**：貨物只會「移轉」不會憑空產生；搬運工沿道路移動、抵達才入庫，
  在途預留避免超收；市集容量 250，人口 >200 需多蓋市集。
- **可進入室內**：每棟建築以 `building.key` 生成對應室內 three.js 場景，
  進出即建立／釋放；UII 同步顯示居民／工人／庫存／本月帳目。
- **存檔即 state**：JSON 完整序列化，含 UI 模式；讀檔後重建場景、清除暫時 UI 狀態；
  自動存檔 + 3 手動格 + 匯出／匯入。

## 4. 驗收結果

| 驗收項目 | 結果 |
|---|---|
| `npx tsc --noEmit` | ✅ 0 錯誤 |
| `npm test`（vitest） | ✅ 2 檔 20 tests 全過（核心、存檔、擺放、尋路、模擬整合） |
| `npm run build` | ✅ 通過（three.js chunk 大小警告，不影響功能） |
| Playwright 全流程 `npm run verify` | ✅ 20/20 checks：建村 → 移民入住 → 就業 → 生產 → 搬運工 → 倉儲／市集 → 月結算 → 夜晚雨天／冬季雪景 → 22 種建築皆可進入室內 → 財政面板 → 存檔跨頁面重載 |
| Playwright UI 互動 `npm run verify:ui` | ✅ 10/10 checks：教學關閉、工具選取、真實滑鼠點擊 3D 場景建屋、雙擊進屋、返回城市、財政滑桿（15%）、存檔／說明視窗、暫停與倍速快捷鍵 |
| Playwright 手機驗收 `npm run verify:mobile` | ✅ 13/13 checks：iPhone 13 模擬自動切換手機 UI、底部營造面板、選工具自動收起、觸控放置建築、城事面板、進入／離開室內、單指平移、雙指縮放、財政面板；桌面 1440×900 仍為原本電腦版 UI |
| 渲染負載（12 棟建築、夜雨） | draw calls 161、triangles 約 53.5 萬；32 棟展示城鎮白天約 334 calls / 63.7 萬 tri、夜晚 +1 call/棟，無 console error／pageerror |
| 存檔持久化 | ✅ 手動存檔在頁面重載後可讀取並還原人口／建築／國庫 |
| 展示截圖 | ✅ `docs/screenshots/`：白天全景、室內、財政、存檔、夜景、雨景、雪景（1600×960） |

## 5. 已知限制與後續

- 建築外觀固定朝向（碼頭依水域轉向）、無 LOD；上千棟建築需改 city-wide InstancedMesh。
- 地形高低差處建築以固定 y≈0.28 擺放，可能微微埋入／浮空。
- 市民暫存行程計時不進存檔（WeakMap），讀檔後計時器重置但不影響功能。
- 手機版為 v1.1 新增（Lead 整合）：自動偵測裝置、底部導覽／底部面板、觸控手勢、安全區與手機 GPU 降載；電腦版介面與操作完全保留。
- 夜間亮度偏暗、樹木不隨季節變色，可作為下一輪視覺優化。
- 可在 v1.1 加入：橋樑建造、建築升級外觀、更多資源與產業鏈、成就與目標系統、
  音樂音效、雲端存檔。
