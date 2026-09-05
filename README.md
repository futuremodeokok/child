# 不對，不是這樣！給孩子主導的互動式AI故事夥伴


## 問題與目標

兒童除了學習使用 AI，更需要培養判斷、思考與協作能力，避免成為被動接受 AI 答案的使用者。

我們想解決的問題是：**讓孩童知道 AI 的觀察永遠只是「提案」，故事的世界與情節由孩子親自確認、修正、引導**。目標使用者是國小低、中年級的孩子；預期影響是讓孩子在使用 AI 說故事工具時，仍然保有對「這是不是我畫的東西」「接下來要發生什麼」的主導權，而不是被動接受 AI 一次生成的結果。

## 核心功能

- **拍照 → AI 觀察 → 孩子逐項確認**：孩子拍下畫作後，AI（視覺模型）提出候選觀察（有幾個人、什麼物件、什麼角色），孩子可以「對，就是這樣」「沒有這個東西」或「是其他東西」（打字或語音輸入）逐一確認，AI 的猜測在被確認前不會變成正式事實。
- **角色命名**：只要觀察裡出現「角色/生物」，會直接跳出命名畫面，讓孩子親自幫牠取名字，取代 AI 自己亂編的描述性稱呼。
- **孩子先給點子，AI 才動筆的接龍故事**：每一段故事都是先由孩子打字或用說的講出「接下來想發生什麼事」，AI 才根據這個點子寫一小段（最多兩句、不超過 50 字），孩子確認「對，就是這樣」才會定案，不滿意可以「不對，我要改寫」讓 AI 重新生成，不會直接把孩子打的字原封不動塞進故事。
- **系統互動提問**：AI 偶爾會問孩子一個小問題（例如「你猜他會遇到誰呢？」），這個問題會被獨立解析出來、用不同顏色顯示，並附上 AI 建議的兩個簡短答案當按鈕。
- **語音輸入**：所有需要孩子打字的地方（取名字、確認觀察、故事點子、改寫）都可以改「用說的」，透過語音辨識轉成文字，跟打字走同一套流程與內容安全檢查。
- **文字轉語音朗讀**：故事段落與完整故事都可以按「唸給我聽」，交給 TTS 唸出來。
- **內容安全防護**：輸入的文字都會先過濾明顯的色情、暴力字眼，命中就要求重新輸入，不會送進 AI。

## 使用技術

| 類型 | 技術／服務 | 用途 |
| --- | --- | --- |
| AI 模型（VLM + 文字生成） | MiniMax（`MiniMaxAI/MiniMax-M3`，透過 GMI Cloud） | 觀察畫作內容、生成/重寫故事段落 |
| AI 模型（語音辨識） | Groq（`whisper-large-v3-turbo`） | 把孩子的語音輸入轉成文字 |
| 前端 | 純 HTML / CSS / JavaScript| 拍照互動介面、逐項確認 UI、故事閱讀畫面 |
| 後端 | Python 3.12、FastAPI、Pydantic、SQLAlchemy、Alembic | API 服務、canonical state 管理、資料持久化 |
| 語音合成 | ElevenLabs | 故事段落／完整故事的文字轉語音朗讀 |
| 字型 | BpmfGenSenRounded（Apache 2.0） | 前端中文圓體字型 |
| 部署 | Railway（Railpack） | 單一服務同時 serve API 與前端靜態檔案 |
| 開發工具 | uv、pytest、ruff、mypy | 套件管理、測試、lint、型別檢查 |

## 安裝與執行

**需求**：Python 3.12、[uv](https://docs.astral.sh/uv/)（沒有 uv 可先執行 `curl -LsSf https://astral.sh/uv/install.sh | sh`）。

**1. 取得程式碼並安裝相依套件**

```bash
git clone https://github.com/futuremodeokok/child.git
cd child
make setup
```

**2. 設定環境變數**

```bash
cp .env.example .env
```

編輯 `.env`，至少填入：

| 變數 | 必要性 | 用途 |
| --- | --- | --- |
| `GMI_API_KEY` | 必要 | MiniMax（透過 GMI Cloud）— 觀察畫作、生成/重寫故事 |
| `GROQ_API_KEY` | 選填 | 語音輸入；未設定時孩子只能用打字 |
| `ELEVENLABS_API_KEY` | 選填 | 文字轉語音朗讀；未設定時沒有語音播放 |

**3. 建立資料庫（跑 migration）**

```bash
uv run --project services/api alembic -c services/api/alembic.ini upgrade head
```

**4. 啟動服務**

```bash
make dev-api
```

啟動後開啟 [http://localhost:8000](http://localhost:8000) 即可使用——FastAPI 會同源掛載 `apps/web` 的靜態檔案，前端不需要另外啟動 dev server。

**5.（選用）跑完整檢查**（lint + 型別檢查 + 測試）：

```bash
make check
```

## 作品展示

- 作品展示網址：https://child-production-8d25.up.railway.app
- 評選影片：


## 第三方服務、資料與素材

| 項目 | 來源 | 授權／說明 |
| --- | --- | --- |
| MiniMax（`MiniMaxAI/MiniMax-M3`） | [GMI Cloud](https://console.gmicloud.ai/) 代管的推論服務 | 依 GMI Cloud 服務條款使用，需自行申請 API key（`GMI_API_KEY`），不隨程式碼提交 |
| Groq Whisper（`whisper-large-v3-turbo`） | [Groq API](https://console.groq.com/) | 依 Groq 服務條款使用，需自行申請 API key（`GROQ_API_KEY`），不隨程式碼提交 |
| ElevenLabs TTS | [ElevenLabs](https://elevenlabs.io/) | 依 ElevenLabs 服務條款使用，需自行申請 API key（`ELEVENLABS_API_KEY`），不隨程式碼提交 |
| BpmfGenSenRounded 字型 | [ButTaiwan/bpmfvs](https://github.com/ButTaiwan/bpmfvs)（`apps/web/fonts/`） | Apache License 2.0，授權全文與 NOTICE 已隨字型檔一併放在 `apps/web/fonts/` |
| Google Fonts| [Google Fonts](https://fonts.google.com/) | Open Font License |

本作品不會、也不應該提交任何 API 金鑰、Token 或個人資料；所有金鑰皆透過環境變數（`.env`，已加入 `.gitignore`）設定。


## License

本專案採用 **Apache License 2.0** 授權，詳細條款請見儲存庫根目錄的 [`LICENSE`](./LICENSE) 檔案。
