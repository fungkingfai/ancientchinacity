# 華夏古城 — 技術架構與多 Agent 分工

> 本文件是全體 Agent 的協作契約。開始工作前必讀 `src/core/types.ts`、`src/core/config.ts`
> 與本文件。專案根目錄：`/home/fung/Documents/deepseek-harness/default-workspace/huaxia-city`

## 1. 專案目標

以 **three.js + TypeScript + Vite** 製作中國古代城市建造模擬遊戲（SimCity 類型），
必須包含：道路、多種地形、房屋、村民、物流、財政、晝夜／四季／晴陰雨雪、
可進入每一棟建築的室內、網站入口、存檔系統。

## 2. 快速指令

```bash
npm install          # 已安裝
npm run dev          # 開發伺服器 http://127.0.0.1:5173（由 Lead 統一啟動，Agent 不要自行啟動）
npx tsc --noEmit     # 型別檢查（Agent 收工前必須執行）
npm run build        # Lead 整合時執行
npm test             # vitest
```

目前 scaffold 已可運作：場景、地形、道路、建築、市民、環境、UI、模擬骨架、存檔。

## 3. 檔案地圖與負責人

| 路徑 | 負責 Agent | 說明 |
|---|---|---|
| `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html` | Lead | 建置設定 |
| `src/main.ts` | Lead | 組裝 actions、主迴圈、事件 |
| `src/core/**` | Lead | 型別、設定、store、存檔、開新局、格式化 |
| `src/render/city-view.ts` | Lead | 場景、鏡頭、滑鼠、室內切換、整合 |
| `src/world/worldgen.ts` | world-renderer | 地形生成（河流、山地、林地、沃土…） |
| `src/render/terrain.ts`, `roads.ts`, `environment.ts` | world-renderer | 地形／道路／天空日夜天氣視覺 |
| `src/render/buildings.ts`, `interior.ts` | architecture-dev | 中式建築模型、室內場景 |
| `src/render/citizens.ts` | citizen-dev | 村民、搬運工、馬車視覺 |
| `src/sim/citizens.ts`, `population.ts` | citizen-dev | 市民行為、人口遷入／就業 |
| `src/sim/logistics.ts`, `pathfinding.ts`, `placement.ts` | logistics-dev | 物流、搬運、路徑、擺放拆除 |
| `src/sim/time.ts`, `finance.ts`, `production.ts`, `stats.ts`, `simulation.ts` | economy-dev | 時間天氣、財政、生產、統計、主迴圈 |
| `src/ui/**`, `src/styles.css` | ui-dev | 全部 DOM 介面與視覺 |
| `docs/**` | game-designer | 研究與設計文件 |
| `tests/**` | qa-dev / Lead | 單元測試 |

**硬規則**

1. 只修改自己負責的檔案。需要改別人的檔或 `core/`、`main.ts` 時，先私訊 Lead 說明原因。
2. 不可新增 npm 依賴（需要時告知 Lead）。
3. 不可啟動 dev server（Lead 統一管理）；收工前執行 `npx tsc --noEmit` 必須通過。
4. 保持既有函式簽名與對外介面；如需擴充，先加欄位／新函式，不要破壞呼叫端。
5. 不要更動 `src/core/types.ts` 的既有欄位語意（存檔相容）；新增欄位請先問 Lead。
6. 完成後把 task 標記 complete，並用 `send_message` 向 Lead 回報：改了哪些檔、完成功能、
   整合注意事項、未完成事項。
7. 效能：大量物件用 `InstancedMesh`；避免每幀重新配置幾何體；目標 60fps。

## 4. 核心資料模型（摘要）

- `GameState`：`tiles[]`、`buildings[]`、`citizens[]`、`carts[]`、`clock`、`finance`、
  `stats`、`ui`、`log[]`、各種 `next*Id`。
- `Tile`：`terrain`（grass/fertile/forest/hill/mountain/water/sand）、`elevation`、
  `variant`、`buildingId`（-1 = 無）、`road`。
- 座標：地圖 `width=72, height=72`，`tileIndex = y*width + x`。
  世界座標置中：格中心 = `(x+0.5)*TILE - width*TILE/2`（`TILE=2`），用
  `src/render/coords.ts` 的 helper，勿自行硬算。
- 建築尺寸以格為單位（1x1、2x2、3x2…），(x,y) 為左上角。
- `GameClock`：`minutes` 絕對遊戲分鐘；`day/month/year/hour/season/weather/tempC`。
  1 天 = 1440 遊戲分鐘 = 30 真實秒（1 倍速）；1 月 = 7 天；1 年 = 12 月。
- `finance.treasury` 國庫（兩）；`taxRate` 0..0.2；`history` 月報表。
- `stats` 每幀由 `sim/stats.ts` 更新，UI 直接讀。
- `ui`：`tool`（建築 key / 'road' / 'demolish' / null）、`selectedId`、`mode`
  （'city' | 'interior'）、`interiorId`、`speed`、`paused`、各面板開關。
- 事件（`GameStore`）：`tick/reset/enter/exit/select/toast/log/ui`。UI 每幀輪詢
  `ui.update(state)`；離散事件用 `store.on()`。

## 5. 模組契約

### 5.1 渲染模組（各自建立 Group，CityView 負責加入場景與更新順序）

```ts
// terrain.ts / roads.ts
createTerrainView(state): TerrainView
createRoadsView(state): RoadsView
interface XxxView { group: THREE.Group; update(state, dt): void; dispose(): void }

// environment.ts（燈光、天空、雨雪、霧、星辰；本身加入 scene）
createEnvironmentView(scene, state): EnvironmentView
interface EnvironmentView { update(state, dt, camera): void; dispose(): void }

// buildings.ts
createBuildingsView(state): BuildingsView
interface BuildingsView {
  group; update(state, dt): void;
  setPreview(state, tool, hover, valid): void;  // 建造幽靈
  dispose(): void;
}
// 所有可點擊 mesh 必須設 userData.buildingId

// citizens.ts
createCitizensView(state): CitizensView // group/update/dispose

// interior.ts
createInteriorView(state, buildingId): InteriorView | null
interface InteriorView { scene; camera; update(state, dt): void; dispose(): void }
```

`CityView` 每幀依序呼叫：`environment.update → terrain.update → roads.update →
buildings.update → citizens.update → 室內或城市 render`。所有 Group 位置使用
`coords.ts`，地面 y≈0.3，地形頂部約 y=0.3~0.6，建築模型從 y≈0.28 往上長。

### 5.2 模擬模組

```ts
// simulation.ts（economy-dev）
class Simulation { update(state, realDt, ctx) }  // 順序：clock → citizens → logistics
//                                                 newDay: connectivity/production/population
//                                                 newMonth: finance → stats
// time.ts
advanceClock(state, gameMinutes, ctx): { newDay, newMonth, newYear }
// production.ts
tickProduction(state, ctx): void            // 每日
// population.ts
tickPopulation(state, ctx): void            // 每日
// citizens.ts
tickCitizens(state, gameMinutes, ctx): void // 每幀
// logistics.ts
tickLogistics(state, gameMinutes, ctx): void// 每幀
// finance.ts
monthlyFinance(state, ctx): void            // 每月
// stats.ts
updateStats(state): void                    // 每幀
// placement.ts
canPlaceBuilding(state,key,x,y): PlaceResult
placeBuilding(state,key,x,y): PlaceResult
placeRoad(state,x,y): PlaceResult
demolishAt(state,x,y): {ok,reason?,refund}
demolishBuildingById(state,id): number
updateConnectedBuildings(state): void
// pathfinding.ts
findRoadPath(state,start,goal): number[]|null
roadAccessTiles(state, building): number[]
findPathBetweenBuildings(state,fromId,toId): number[]|null
```

## 6. 模擬設計規格（Agent 實作時遵循）

### 市民（citizen-dev）
- 每棟住宅有 `residents`；每棟工作建築有 `workers`（容量 = `BuildingDef.workers`）。
- 移民：住宅有空位時，每月（或每數日）依幸福度遷入 1~N 人；名字用
  `SURNAMES`/`GIVEN_NAMES` 隨機組合；年齡 16~60。
- 市民行為狀態機：`home → walking（沿道路前往工作地）→ working → walking（回家或
  去市集購物）→ shopping → home`；`path` 為道路格 index 陣列，`pathProgress` 浮點。
  市民每幀 `x,y` 依路徑插值（供渲染），移動速度約 1.2 格/遊戲分鐘 × 天氣倍率。
- 需求：糧食（市集供應）、日用品（布帛／茶／酒）、文化（學堂／寺廟）；每「日」消耗，
  滿足度影響 `happiness`（0..100）。失業、無家、稅率、節慶、天氣亦影響幸福度。
- 城市人口 = citizens 數量；`tickPopulation` 處理出生、死亡（機率）、遷入、遷出。

### 物流（logistics-dev）
- 生產建築每日依 `production` 產出（工人比例、季節／天氣倍率、地形加成），
  需要 `input` 的消耗庫存；產出先存本地暫存（上限 30），再由搬運工送往倉庫。
- 倉庫（糧倉只收糧食、貨棧收全部）容量依 `storage.capacity`。
- 市集每日向倉庫提貨（糧食、茶、酒、布帛），並供給半徑 `service.radius` 內的民居。
- 搬運工（`state.carts`）沿 `pathfinding` 的 `path` 以固定速度移動；到達後移轉貨物、
  回程或消失；同時最多 ~40 台。若無路可通，建築 `connected=false` 不營運。
- 碼頭：臨水 + 連路時，每數日出口倉庫多餘貨物換銀兩；繁榮度影響收入。
- 道路連通：建築任一外側格有 road 即 connected；拆除道路要重算。

### 經濟（economy-dev）
- 每月結算：
  - 收入：人頭稅（人口 × 稅率 × 基礎係數）、田賦（農田產量 × 稅率）、
    市集商稅、茶館／客棧／碼頭服務收入。
  - 支出：所有建築維護費（`BuildingDef.upkeep`）、道路維護（可忽略）。
  - 寫入 `finance.history`（保留最近 24 個月）、`lastMonthIncome/Expense`、
    `totalIncome/Expense`；`finance.treasury += income - expense`。
  - 國庫 < 0 連續 2 個月 → toast 警告，幸福度下降。
- 生產：見物流；`tickProduction` 只負責產出與投入扣減（寫入 building.inventory）。
- 天氣：`advanceClock` 每 90~330 遊戲分鐘依季節權重換天氣；季節／溫度／
  天氣強度平滑；跨日／月／年旗標；冬季下雪、非冬季不下雪。
- 統計 `updateStats` 已存在，可擴充（收入、糧食、就業、幸福）。

### UI（ui-dev）
- 保留 `createUI(root, store, actions): GameUI` 介面與現有 actions。
- 需要呈現：頂欄（日期時辰、季節天氣溫度、國庫、人口、民心、倍速）、
  建造選單（分類／解鎖／造價）、選取建築資訊（可進入室內）、資源與物流概況、
  財政面板（稅率滑桿、月報表、節慶）、存檔面板（自動＋3 格、匯出／匯入、新遊戲）、
  教學、toast、室內模式面板（居民／工人／庫存／返回城市）。
- 風格：宣紙、墨線、朱紅、金字、宋體；動畫克制；不要依賴外部字型／圖片
  （離線可用），icons 用文字或 CSS/SVG 自繪。
- UI 每幀被呼叫 `update(state)`，請自行做變更偵測避免每幀重建 DOM。

### 世界視覺（world-renderer）
- 地形生成：河流蜿蜒（南北向）、湖泊、山地集中在邊緣、林地、沃土沿河、
  沙岸臨水、中央預留可建平地；`generateWorld(seed)` 保持回傳
  `{width,height,tiles,spawn}`；地形要與 `placement.ts` 的可建規則一致。
- 視覺：低多邊形中式水墨田園風；地塊有高低層次（梯田感）、樹木（松、竹、柳）、
  山石、水波／反光、道路石板與交叉口、橋樑（可選）。晝夜天空色、太陽／月亮、
  星辰、雲、雨雪粒子、霧；性能用 InstancedMesh。

### 建築與室內（architecture-dev）
- 屋頂：歇山／懸山式曲面屋簷（可用自訂 BufferGeometry 或組合幾何），
  紅柱、白牆、青瓦、匾額、燈籠；依建築類型區分（民居、農田、市集、寺廟、
  衙門、碼頭、塔樓…），有門窗、煙囪、攤位、旗幡等細節。
- 每棟建築要有 identifiable 的視覺；1x1 小屋、2x2 中等、3x3 衙門。
- `interior.ts`：依建築類型生成室內場景（木地板、樑柱、家具、燈光、人物象徵），
  相機取景良好，`update` 加入燈籠搖曳等微動畫；室內要能看出這是什麼建築。
- 所有可點擊 mesh 設 `userData.buildingId`；幽靈預覽沿用 `setPreview`。

## 7. 整合流程

1. Lead 維持 scaffold 可 build／可跑。
2. 各 Agent 在各自檔案完成功能 → `npx tsc --noEmit` → 標記 task complete → 回報 Lead。
3. Lead 整合：`npm run build`、啟動 dev server、驗證互動與存檔、修正介面落差。
4. qa-dev 補測試與驗收清單；全員修正 regression。
5. 最終由 Lead 向使用者交付網站 URL 與操作說明。

## 8. 完成定義（Definition of Done）

- [ ] `npm run build` 通過；`npm test` 通過
- [ ] 可鋪路、建屋、吸引村民入住、就業、通勤（視覺可見）
- [ ] 物流：生產→倉庫→市集→民居，搬運工／貨物可見
- [ ] 財政：稅收、維護費、月報表、節慶
- [ ] 晝夜、四季、晴陰雨雪在天色／光照／粒子可見，並影響產量／移動
- [ ] 點擊／雙擊任一建築可進入室內，可返回城市
- [ ] 存檔：自動存檔、3 手動格、匯出／匯入、讀檔後世界一致
- [ ] 教學／說明可讓新玩家上手；網站可正常載入
