# 部署：replay 播放器

網址 **<https://darkbearlab.github.io/misc/player/>**

## 機制

`.github/workflows/crush-gear-deploy-player.yml`(repo 根目錄)在 push 到 `main`
且 `crush_gear/**` 有變更時自動執行:

1. `npm ci`
2. `verify-platform --compare` —— 部署一份跑不出正確結果的播放器沒有意義,故建置前先驗
3. `vite build --base=/misc/player/`
4. 產物複製到 `main` 分支的 `player/`,連同 `.nojekyll`,commit 回去

**不使用 `actions/deploy-pages`**:那會讓 artifact 取代整個 Pages 站台,
而 `misc` 的站台底下已有入口頁與其他內容。改為沿用現有的分支來源,只多放一個子目錄,
不更動任何 repo 設定。

`player/` 由 CI 產生,**不要手動編輯**;它會在下一次建置時被整個覆蓋。

## 給入口頁的連結片段

貼進現有入口頁即可。純 HTML,不依賴任何 CSS 框架:

```html
<h3><a href="./player/">超激力戰鬥車 — Replay 播放器</a></h3>
<p>
  決定性物理模擬的戰鬥回放。可載入預設場次或隨機產生投擲參數,
  支援逐幀檢視與除錯疊圖。手機可用。
</p>
```

Markdown 版本:

```markdown
### [超激力戰鬥車 — Replay 播放器](./player/)

決定性物理模擬的戰鬥回放。可載入預設場次或隨機產生投擲參數,
支援逐幀檢視與除錯疊圖。手機可用。
```

連結用相對路徑 `./player/` 而非絕對網址 —— 入口頁與播放器在同一個站台下,
相對路徑在 repo 改名或換 owner 時都不會壞。

## 三個踩過的坑

**base path。** Vite 預設 `base` 是 `/`,直接部署會讓 `index.html` 去要
`/assets/…`(站台根),而實際位置是 `/misc/player/assets/…`。結果是**畫面全白且
沒有任何錯誤提示** —— HTML 載入成功,只有 script 404。
workflow 以 `--base=/${{ github.event.repository.name }}/player/` 指定,由 repo 名稱推導。

**commit 訊息裡不要出現 CI 的略過標記。** GitHub 會掃描整段 commit 訊息,
只要出現該標記(本檔案刻意不寫出字面)就會**跳過該 commit 的所有 workflow**。
在說明文字裡提到它會連自己一起關掉:本專案就發生過一次,
一個描述該機制的 commit 訊息把自己的部署跳過了,而 Actions 頁面上不會有任何失敗記錄
—— 只是沒有 run 出現,比失敗更難察覺。
要在文件中提及時,寫成「CI 的略過標記」或拆開寫。

** 與  不能並用。** GitHub 不允許同一個事件同時指定兩者,
這樣寫整份 workflow 解析失敗。失敗的形式極不明顯:Actions 頁面上該 run 的名稱會變成
**檔案路徑**而非  欄位,job 數為 0,看起來像「跑了但什麼都沒做」。
本專案的迴圈防護因此改為只靠  ——  不在  之列,
bot 的 commit 只動 ,自然不符合任何一條,不會觸發自己。
