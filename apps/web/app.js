const apiBaseUrl = ''

const actionPanel = document.getElementById('action-panel')
const textPanel = document.getElementById('text-panel')
const sceneCount = document.getElementById('scene-count')
const statusMessage = document.getElementById('status-message')
const errorMessage = document.getElementById('error-message')
const narrationAudio = document.getElementById('narration-audio')
const cameraVideo = document.getElementById('camera-video')
const cameraCanvas = document.getElementById('camera-canvas')

let loading = false

// 'intro' -> 'camera' -> 'grounding' (confirm what AI saw in the drawing)
// -> 'story' (accept/correct/redirect each proposed segment) -> 'full-story'
let uiStep = 'intro'
let cameraStream = null
let photos = [] // data URLs captured this round, newest last

let sessionId = null
let sessionVersion = 0

let revisionState = null // latest RevisionState from the API
let promptIndex = 0
let decisions = [] // CandidateDecision[] collected for the current revision
let showCustomInput = false
let customAnswer = ''

let storyState = null // latest StoryState from the API
let storyAction = null // 'correct' | 'redirect' while its free-text box is open
let childIdeaInput = '' // the child's plot idea, typed before each AI-written segment
let lastQuestion = null // the AI's interactive question from the segment just accepted
let lastQuestionOptions = [] // up to 2 AI-suggested short answers for lastQuestion

function newKey(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`
}

function setLoading(next) {
  loading = next
}

function setError(message) {
  if (message) {
    errorMessage.textContent = message
    errorMessage.hidden = false
  } else {
    errorMessage.hidden = true
  }
}

// ---- Content guard: block obviously unsafe (sexual / violent) child input
// before it ever reaches the AI. A blunt keyword check, not a full classifier —
// good enough to catch explicit content, not meant to be exhaustive. ----

const UNSAFE_TERMS = [
  // sexual
  '色情', '做愛', '性交', '性愛', '裸體', '裸照', '強暴', '強姦', '性侵',
  '雞巴', '陰莖', '陰道', '屌', '打炮', '約炮', 'porn', 'sex', 'nude', 'rape',
  // violence
  '殺死', '砍死', '打死', '虐待', '虐殺', '槍殺', '刺死', '血腥', '殘忍',
  '自殺', '自殘', '爆頭', 'kill', 'murder', 'suicide', 'stab', 'behead',
]

function containsUnsafeContent(text) {
  const normalized = text.toLowerCase()
  return UNSAFE_TERMS.some((term) => normalized.includes(term.toLowerCase()))
}

// Returns true (and shows the re-enter prompt) if the text was blocked.
function blockIfUnsafe(text) {
  if (!containsUnsafeContent(text)) return false
  setError('這句話裡有不適合的內容，請重新輸入喔。')
  return true
}

async function api(path, init) {
  const response = await fetch(`${apiBaseUrl}${path}`, init)
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.message || 'request failed')
  return payload
}

// ---- Voice input: record from the mic, transcribe via Groq, drop the text
// straight into whichever <input> the button sits next to. Works exactly
// like typing — same field, same content guard, same submit button. ----

function createMicButton(input) {
  const mic = document.createElement('button')
  mic.type = 'button'
  mic.className = 'mic-button'
  mic.textContent = '用說的'
  let recorder = null
  let chunks = []

  mic.addEventListener('click', async () => {
    if (recorder && recorder.state === 'recording') {
      recorder.stop()
      return
    }
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      chunks = []
      recorder = new MediaRecorder(stream)
      recorder.addEventListener('dataavailable', (event) => chunks.push(event.data))
      recorder.addEventListener('stop', async () => {
        for (const track of stream.getTracks()) track.stop()
        mic.textContent = '…'
        mic.disabled = true
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
          const form = new FormData()
          form.append('audio', blob, 'voice.webm')
          const result = await api('/v1/stt', { method: 'POST', body: form })
          const heard = (result.text || '').trim()
          if (heard) {
            input.value = input.value ? `${input.value} ${heard}` : heard
            input.dispatchEvent(new Event('input'))
          } else {
            setError('沒有聽清楚，請再試一次或直接打字。')
          }
        } catch {
          setError('語音辨識失敗，請再試一次或直接打字。')
        } finally {
          mic.textContent = '用說的'
          mic.disabled = false
        }
      })
      recorder.start()
      mic.textContent = '我說完了'
    } catch {
      setError('無法使用麥克風，請確認瀏覽器權限，或直接打字。')
    }
  })

  return mic
}

// ---- Camera (photobooth-style capture) ----

async function openCamera() {
  setError(null)
  uiStep = 'camera'
  render()
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true })
    cameraVideo.srcObject = cameraStream
  } catch {
    setError('無法開啟鏡頭，請確認瀏覽器有相機權限。')
    uiStep = 'intro'
  }
  render()
}

function stopCamera() {
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) track.stop()
    cameraStream = null
  }
}

function capturePhoto() {
  const width = cameraVideo.videoWidth
  const height = cameraVideo.videoHeight
  if (!width || !height) return
  cameraCanvas.width = width
  cameraCanvas.height = height
  cameraCanvas.getContext('2d').drawImage(cameraVideo, 0, 0, width, height)
  photos = [...photos, cameraCanvas.toDataURL('image/jpeg', 0.85)]
  render()
}

function dataUrlToBlob(dataUrl) {
  const [meta, base64] = dataUrl.split(',')
  const mime = meta.match(/data:(.*);base64/)[1]
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

// ---- Drawing revision: AI observes the photo, child grounds each candidate ----

async function submitPhotoAsRevision() {
  if (photos.length === 0) return
  stopCamera()
  setLoading(true)
  setError(null)
  render()
  try {
    if (!sessionId) {
      const session = await api('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      sessionId = session.session_id
      sessionVersion = session.state_version
    }
    const form = new FormData()
    form.append('image', dataUrlToBlob(photos[photos.length - 1]), 'drawing.jpg')
    form.append('expected_state_version', String(sessionVersion))
    form.append('idempotency_key', newKey('idem'))
    revisionState = await api(`/v1/sessions/${sessionId}/drawing-revisions/photo`, {
      method: 'POST',
      body: form,
    })
    promptIndex = 0
    decisions = []
    showCustomInput = false
    customAnswer = ''
    if (revisionState.prompts.length === 0) {
      // Nothing needed grounding this round — go straight to asking what
      // the child wants to happen next.
      uiStep = 'story-idea'
    } else {
      uiStep = 'grounding'
    }
  } catch {
    setError('AI 看畫作的時候出了點問題，請再試一次。')
    uiStep = 'camera'
  } finally {
    setLoading(false)
    render()
  }
}

function currentPrompt() {
  return revisionState?.prompts[promptIndex] ?? null
}

function currentCandidate() {
  const prompt = currentPrompt()
  if (!prompt) return null
  return revisionState.candidates.find((item) => item.candidate_id === prompt.candidate_id)
}

function candidateSummary(candidate) {
  const value = candidate.proposed_value ?? candidate.current_value ?? {}
  switch (candidate.kind) {
    case 'object_count':
      return `${value.count ?? '?'} 個「${value.label ?? '?'}」`
    case 'object':
      return `「${value.label ?? '?'}」${value.color ? `（${value.color}）` : ''}`
    case 'character':
      return value.visible_description || value.name || '一個角色'
    case 'fact':
      return value.visible_expression || String(value.value ?? '')
    default:
      return JSON.stringify(value)
  }
}

function buildSuppliedValue(candidate, text) {
  const value = candidate.proposed_value ?? {}
  switch (candidate.kind) {
    case 'object_count':
      return { label: text, count: value.count ?? 1 }
    case 'object':
      return { label: text }
    case 'character':
      return { visible_description: text }
    case 'fact':
      return { visible_expression: text }
    default:
      return { label: text }
  }
}

function decideCurrentPrompt(action, suppliedValue) {
  const prompt = currentPrompt()
  if (!prompt) return
  decisions = [
    ...decisions,
    { candidate_id: prompt.candidate_id, action, supplied_value: suppliedValue ?? null },
  ]
  showCustomInput = false
  customAnswer = ''
  promptIndex += 1
  if (promptIndex >= revisionState.prompts.length) {
    void resolveRevision()
  } else {
    render()
  }
}

async function resolveRevision() {
  setLoading(true)
  setError(null)
  render()
  try {
    const resolved = await api(
      `/v1/sessions/${sessionId}/drawing-revisions/${revisionState.revision.revision_id}/decisions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decisions,
          command_id: newKey('ans'),
          expected_state_version: sessionVersion,
          idempotency_key: newKey('idem'),
        }),
      },
    )
    sessionVersion = resolved.world.version
    uiStep = 'story-idea'
    setLoading(false)
    render()
  } catch (error) {
    console.error('resolveRevision failed', error, { decisions, revisionState })
    setError(`確認畫作的時候出了點問題：${error.message || error}`)
    setLoading(false)
    render()
  }
}

// ---- Story: child writes what should happen next, AI writes it as a short
// segment, child confirms it matches (accept) or asks for a change (correct /
// redirect) before the next round starts. ----

function submitStoryIdea() {
  const idea = childIdeaInput.trim()
  if (!idea) {
    setError('請先輸入文字，或按「讓 AI 自由發揮」。')
    return
  }
  if (blockIfUnsafe(idea)) return
  void requestStoryProposal(idea)
}

function skipStoryIdea() {
  void requestStoryProposal(null)
}

async function requestStoryProposal(childIdea) {
  setLoading(true)
  setError(null)
  render()
  try {
    storyState = await api(`/v1/sessions/${sessionId}/story/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_state_version: sessionVersion, child_idea: childIdea ?? null }),
    })
    storyAction = null
    childIdeaInput = ''
    uiStep = 'story'
  } catch {
    setError('AI 想故事的時候出了點問題，請再試一次。')
  } finally {
    setLoading(false)
    render()
  }
}

async function groundStoryProposal(action, suppliedText) {
  const proposalId = storyState.current_proposal.proposal_id
  setLoading(true)
  setError(null)
  render()
  try {
    storyState = await api(`/v1/sessions/${sessionId}/story/proposals/${proposalId}/ground`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        supplied_text: suppliedText ?? null,
        expected_state_version: sessionVersion,
        idempotency_key: newKey('idem'),
      }),
    })
    sessionVersion = storyState.state_version
    storyAction = null
    customAnswer = ''
  } catch {
    setError('故事暫時沒有更新，請再試一次。')
    setLoading(false)
    render()
    return
  }
  // Accepted into a canonical segment — go back to asking the child what
  // should happen next, rather than letting AI free-run.
  uiStep = 'story-idea'
  setLoading(false)
  render()
}

async function regenerateStoryProposal(childIdea) {
  const proposalId = storyState.current_proposal.proposal_id
  setLoading(true)
  setError(null)
  render()
  try {
    storyState = await api(
      `/v1/sessions/${sessionId}/story/proposals/${proposalId}/regenerate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_state_version: sessionVersion, child_idea: childIdea }),
      },
    )
    // Still a draft, not yet accepted — stay on the same confirm screen so the
    // child can accept / ask for another change on this new attempt.
    storyAction = null
    customAnswer = ''
  } catch {
    setError('AI 重新想故事的時候出了點問題，請再試一次。')
  } finally {
    setLoading(false)
    render()
  }
}

async function showFullStory(pendingText) {
  setLoading(true)
  setError(null)
  try {
    const full = await api(`/v1/sessions/${sessionId}/story/full`)
    // The canonical full story only has *accepted* segments — if there's a
    // freshly-generated draft still waiting on "對，就是這樣", tack it on too
    // so reading the full story doesn't leave off the most recent sentence.
    const fullText = pendingText ? `${full.text}\n\n${pendingText}` : full.text
    storyState = { ...storyState, fullText }
    uiStep = 'full-story'
  } catch {
    setError('讀取完整故事時出了點問題，請再試一次。')
  } finally {
    setLoading(false)
    render()
  }
}

async function listen(text) {
  setError(null)
  try {
    const response = await fetch(`${apiBaseUrl}/v1/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!response.ok) throw new Error('tts failed')
    const blob = await response.blob()
    narrationAudio.src = URL.createObjectURL(blob)
    narrationAudio.hidden = false
    await narrationAudio.play()
  } catch {
    setError('語音播放失敗，請稍後再試一次。')
  }
}

function resetAll() {
  stopCamera()
  photos = []
  sessionId = null
  sessionVersion = 0
  revisionState = null
  promptIndex = 0
  decisions = []
  storyState = null
  storyAction = null
  showCustomInput = false
  customAnswer = ''
  childIdeaInput = ''
  lastQuestion = null
  lastQuestionOptions = []
  uiStep = 'intro'
  render()
}

// ---- Rendering ----

function button(label, onClick, options = {}) {
  const el = document.createElement('button')
  el.textContent = label
  el.disabled = Boolean(options.disabled)
  if (options.className) el.className = options.className
  el.addEventListener('click', onClick)
  return el
}

function heading(eyebrowText, titleText) {
  const eyebrow = document.createElement('p')
  eyebrow.className = 'eyebrow'
  eyebrow.textContent = eyebrowText
  const h1 = document.createElement('h1')
  h1.textContent = titleText
  textPanel.append(eyebrow, h1)
}

function photoStrip(size = 'large') {
  if (photos.length === 0) return
  const strip = document.createElement('div')
  strip.className = `photo-strip photo-strip--${size}`
  const img = document.createElement('img')
  img.src = photos[photos.length - 1]
  img.alt = '你拍的畫作'
  strip.append(img)
  actionPanel.append(strip)
}

function renderIntro() {
  heading('一起改變故事！', '畫一個故事')
  const summary = document.createElement('p')
  summary.className = 'summary'
  summary.textContent = '先拍下你的畫作，AI 會看看你畫了什麼，然後我們一起把它變成一個故事！'
  textPanel.append(summary)
  const actions = document.createElement('div')
  actions.className = 'actions'
  actions.append(button('打開相機拍照', () => void openCamera(), { disabled: loading }))
  actionPanel.append(actions)
}

function renderCamera() {
  heading(
    '拍下你的畫作',
    loading ? 'AI 正在看你的畫…' : photos.length === 0 ? '準備好了嗎？' : '再拍一張，還是這樣就好？',
  )

  const stage = document.createElement('div')
  stage.className = 'camera-stage'
  cameraVideo.hidden = false
  stage.append(cameraVideo)
  actionPanel.append(stage)

  photoStrip('compact')

  const actions = document.createElement('div')
  actions.className = 'actions'
  actions.append(button('拍照', capturePhoto, { disabled: !cameraStream || loading }))
  if (photos.length > 0) {
    actions.append(
      button('讓 AI 看看這張畫', () => void submitPhotoAsRevision(), { disabled: loading }),
    )
  }
  actions.append(
    button('取消', () => { stopCamera(); uiStep = 'intro'; render() }, { className: 'secondary', disabled: loading }),
  )
  actionPanel.append(actions)
}

function renderCharacterNaming(prompt, candidate) {
  const description = candidate.proposed_value?.visible_description || candidateSummary(candidate)

  heading('幫他取個名字！', `第 ${promptIndex + 1} 個，共 ${revisionState.prompts.length} 個`)

  const summary = document.createElement('p')
  summary.className = 'summary'
  summary.textContent = `AI 看到一個角色：${description}`
  textPanel.append(summary)

  photoStrip()

  const form = document.createElement('div')
  form.className = 'custom-answer'
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = '幫他取個名字…'
  input.value = customAnswer
  input.addEventListener('input', (event) => { customAnswer = event.target.value })
  const submitCharacterName = () => {
    const name = customAnswer.trim()
    if (!name) {
      setError('請先幫他取個名字。')
      return
    }
    if (blockIfUnsafe(name)) return
    decideCurrentPrompt('correct', { visible_description: name })
  }
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitCharacterName()
  })
  const submit = button('取好了', submitCharacterName, { disabled: loading })
  form.append(input, createMicButton(input), submit)
  actionPanel.append(form)

  const actions = document.createElement('div')
  actions.className = 'actions'
  if (prompt.allowed_actions.includes('reject')) {
    actions.append(button('這裡沒有角色', () => decideCurrentPrompt('reject'), {
      className: 'secondary',
      disabled: loading,
    }))
  }
  actionPanel.append(actions)
}

function renderGrounding() {
  const prompt = currentPrompt()
  const candidate = currentCandidate()
  if (!prompt || !candidate) return

  if (candidate.kind === 'character') {
    renderCharacterNaming(prompt, candidate)
    return
  }

  heading('確認畫作內容', `第 ${promptIndex + 1} 個，共 ${revisionState.prompts.length} 個`)

  const changeText = {
    added: '我看到新的：',
    changed: '這個好像變成了：',
    removed: '我沒有再看到：',
    uncertain: '我不太確定，好像是：',
    unchanged: '我看到：',
  }[prompt.change] || '我看到：'

  const summary = document.createElement('p')
  summary.className = 'summary'
  summary.textContent = `${changeText}${candidateSummary(candidate)}`
  textPanel.append(summary)

  photoStrip()

  const actions = document.createElement('div')
  actions.className = 'actions'
  const labels = { confirm: '對，就是這樣', reject: '沒有這個東西', correct: '是其他東西' }
  for (const action of prompt.allowed_actions) {
    if (action === 'skip') continue
    if (action === 'correct') {
      actions.append(
        button(labels.correct, () => { showCustomInput = true; render() }, {
          className: 'secondary',
          disabled: loading,
        }),
      )
    } else {
      actions.append(
        button(labels[action], () => decideCurrentPrompt(action), { disabled: loading }),
      )
    }
  }
  actionPanel.append(actions)

  if (showCustomInput) {
    const form = document.createElement('div')
    form.className = 'custom-answer'
    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = '跟我說說那是什麼…'
    input.value = customAnswer
    input.addEventListener('input', (event) => { customAnswer = event.target.value })
    const submit = button('送出', () => {
      const text = customAnswer.trim()
      if (!text) {
        setError('請先輸入文字。')
        return
      }
      if (!blockIfUnsafe(text)) {
        decideCurrentPrompt('correct', buildSuppliedValue(candidate, text))
      }
    }, { disabled: loading })
    form.append(input, createMicButton(input), submit)
    actionPanel.append(form)
  }
}

function answerLastQuestion(answer) {
  const idea = `孩子回答了問題「${lastQuestion}」：${answer}`
  lastQuestion = null
  lastQuestionOptions = []
  void requestStoryProposal(idea)
}

function skipLastQuestion() {
  lastQuestion = null
  lastQuestionOptions = []
  render()
}

function renderStoryIdea() {
  const segments = storyState ? storyState.segments.filter((segment) => segment.status === 'current') : []

  heading('接下來呢？', segments.length === 0 ? '故事要開始了' : '你想怎麼發展？')

  for (const segment of segments) {
    const p = document.createElement('p')
    p.className = 'summary'
    p.textContent = segment.text
    textPanel.append(p)
  }

  if (lastQuestion) {
    const question = document.createElement('h2')
    question.className = 'question-prompt'
    question.textContent = lastQuestion
    textPanel.append(question)

    photoStrip()

    const options = lastQuestionOptions.length === 2 ? lastQuestionOptions : ['好呀', '不要']
    const actions = document.createElement('div')
    actions.className = 'actions'
    for (const option of options) {
      actions.append(button(option, () => answerLastQuestion(option), { disabled: loading }))
    }
    actions.append(
      button('跳過問題', skipLastQuestion, { className: 'secondary', disabled: loading }),
    )
    actionPanel.append(actions)
    return
  }

  const prompt = document.createElement('p')
  prompt.className = 'summary'
  prompt.textContent = '跟我說說接下來想發生什麼事，我會把它寫成故事給你看！'
  textPanel.append(prompt)

  photoStrip()

  const form = document.createElement('div')
  form.className = 'custom-answer'
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = '例如：小兔子決定去森林裡探險…'
  input.value = childIdeaInput
  input.addEventListener('input', (event) => { childIdeaInput = event.target.value })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitStoryIdea()
  })
  const submit = button('讓 AI 寫成故事', submitStoryIdea, { disabled: loading })
  form.append(input, createMicButton(input), submit)
  actionPanel.append(form)

  const actions = document.createElement('div')
  actions.className = 'actions'
  actions.append(
    button('讓 AI 自由發揮', skipStoryIdea, { className: 'secondary', disabled: loading }),
  )
  if (segments.length > 0) {
    actions.append(
      button('讀完整故事', () => void showFullStory(), { className: 'secondary', disabled: loading }),
    )
  }
  actionPanel.append(actions)
}

function renderStory() {
  const segments = storyState.segments.filter((segment) => segment.status === 'current')
  const proposal = storyState.current_proposal

  sceneCount.hidden = false
  sceneCount.textContent = `第 ${segments.length + (proposal ? 1 : 0)} 段`

  heading(proposal ? '是這樣嗎？' : '你的故事', '故事')

  for (const segment of segments) {
    const p = document.createElement('p')
    p.className = 'summary'
    p.textContent = segment.text
    textPanel.append(p)
  }

  if (proposal) {
    const proposalText = document.createElement('p')
    proposalText.className = 'summary'
    proposalText.textContent = proposal.text
    textPanel.append(proposalText)
    // The interactive question (if any) is intentionally not shown here — it
    // only appears after the child accepts, as its own dedicated step.
  }

  photoStrip()

  if (proposal) {
    const actions = document.createElement('div')
    actions.className = 'actions'
    actions.append(button('唸給我聽', () => void listen(proposal.text), { className: 'listen' }))
    actions.append(button('對，就是這樣', () => {
      lastQuestion = proposal.question
      lastQuestionOptions = proposal.question_options || []
      void groundStoryProposal('accept')
    }, { disabled: loading }))
    actions.append(
      button('不是，我要改寫…', () => { storyAction = 'correct'; render() }, {
        className: 'secondary',
        disabled: loading,
      }),
    )
    actionPanel.append(actions)

    if (storyAction) {
      const form = document.createElement('div')
      form.className = 'custom-answer'
      const input = document.createElement('input')
      input.type = 'text'
      input.placeholder = '你想怎麼改寫這一段…'
      input.value = customAnswer
      input.addEventListener('input', (event) => { customAnswer = event.target.value })
      const submit = button('送出', () => {
        const text = customAnswer.trim()
        if (!text) {
          setError('請先輸入文字。')
          return
        }
        if (!blockIfUnsafe(text)) void regenerateStoryProposal(text)
      }, { disabled: loading })
      form.append(input, createMicButton(input), submit)
      actionPanel.append(form)
    }
  } else if (!loading) {
    // No pending proposal and nothing in flight — give the child a way forward
    // instead of a dead end (e.g. if fetching the next proposal ever fails silently).
    const retry = document.createElement('div')
    retry.className = 'actions'
    retry.append(button('繼續故事', () => void requestStoryProposal()))
    actionPanel.append(retry)
  }

  if (segments.length > 0) {
    const moreActions = document.createElement('div')
    moreActions.className = 'actions'
    moreActions.append(
      button('讀完整故事', () => void showFullStory(proposal ? proposal.text : null), {
        className: 'secondary',
        disabled: loading,
      }),
    )
    actionPanel.append(moreActions)
  }
}

function renderFullStory() {
  heading('故事完成了', '完整故事')
  const p = document.createElement('p')
  p.className = 'summary'
  p.textContent = storyState.fullText
  textPanel.append(p)

  photoStrip()

  const actions = document.createElement('div')
  actions.className = 'actions'
  actions.append(button('唸給我聽', () => void listen(storyState.fullText), { className: 'listen' }))
  actions.append(button('再畫一個新故事', resetAll, { className: 'secondary' }))
  actionPanel.append(actions)

  textPanel.scrollTop = 0
}

function render() {
  actionPanel.replaceChildren()
  textPanel.replaceChildren()
  textPanel.classList.toggle('full-story-panel', uiStep === 'full-story')
  sceneCount.hidden = true
  statusMessage.hidden = true
  if (uiStep !== 'camera') cameraVideo.hidden = true

  if (uiStep === 'intro') {
    renderIntro()
  } else if (uiStep === 'camera') {
    renderCamera()
  } else if (uiStep === 'grounding' && revisionState) {
    renderGrounding()
  } else if (uiStep === 'story-idea') {
    renderStoryIdea()
  } else if (uiStep === 'story' && storyState) {
    renderStory()
  } else if (uiStep === 'full-story' && storyState) {
    renderFullStory()
  }

  if (loading) {
    statusMessage.hidden = false
    statusMessage.textContent = 'AI 正在想…'
  }
}

render()
