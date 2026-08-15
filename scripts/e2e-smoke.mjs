/**
 * End-to-end smoke test for dsh-assistant-message-forge against a running
 * `dsh web` instance.
 *
 * Env:
 *   AMF_URL        http://127.0.0.1:3090   (default)
 *   SESSION_LOG    absolute path to a session.jsonl(.zstd) for the import step
 *   PLAYWRIGHT_ROOT  D:/codeproject/dsh-browser/node_modules/playwright (default)
 *   PLAYWRIGHT_CHANNEL  optional installed browser channel, for example chrome
 *   AMF_HEADED=1   show the browser window instead of headless mode
 *
 * The script clicks the "消息锻造台" tab and exercises every required button:
 * context parse + card record edit + record reset, draft add/edit/delete,
 * inject, and sessionlog import.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const playwrightRoot = process.env.PLAYWRIGHT_ROOT ?? 'D:/codeproject/dsh-browser/node_modules/playwright'
const { chromium } = require(playwrightRoot)

const url = process.env.AMF_URL ?? 'http://127.0.0.1:3090'
const sessionLog = process.env.SESSION_LOG
const headed = process.env.AMF_HEADED === '1'
const browserChannel = process.env.PLAYWRIGHT_CHANNEL

/** Call the host RPC carrier (same envelope the browser client sends). */
async function rpc(path, method, payload) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
  })
  const envelope = await response.json()
  if (!response.ok || !envelope.result?.ok) {
    throw new Error(envelope.result?.error?.message ?? `HTTP ${response.status}`)
  }
  return envelope.result.value
}

const browser = await chromium.launch({
  headless: !headed,
  ...(browserChannel === undefined ? {} : { channel: browserChannel }),
})
const page = await browser.newPage()
page.setDefaultTimeout(15000)

const step = (label) => { console.log(`[e2e] ${label}`) }
const ok = (value) => {
  if (!value) throw new Error(`assertion failed: ${value}`)
  console.log('       ok')
}

try {
  step('create a disposable workspace-attached session for the test')
  const workspaces = await rpc('/api/workspace.list', 'workspace.list', {})
  const workspace = workspaces.items.find(item => item.title === 'dsh-plugin') ?? workspaces.items[0]
  if (workspace === undefined) throw new Error('no workspace available')
  const sessionId = `amf-e2e-${randomUUID()}`
  await rpc('/api/session.create', 'session.create', { workspaceId: workspace.workspaceId, sessionId })
  const marker = `e2e-context-${Date.now().toString(36)}`
  await rpc('/dsh-assistant-message-forge/session/inject', 'session/inject', {
    sessionId,
    message: { content: marker, reasoning: 'e2e reasoning', provider: 'e2e', model: 'e2e-model' },
  })

  step(`open ${url} and select the disposable session`)
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  const sessionRows = page.locator('.W37V8G_sessionRow')
  await sessionRows.first().waitFor({ state: 'visible' })
  // The disposable session is the most recently updated row.
  await sessionRows.first().locator('.W37V8G_title').click()

  step('open the Message Forge conversation tab')
  const tab = page.getByRole('tab', { name: '消息锻造台' }).first()
  await tab.waitFor({ state: 'visible' })
  await tab.click()

  const stamp = Date.now().toString(36)

  step('parse and record the session context into cards')
  await page.getByRole('button', { name: '刷新解析', exact: true }).first().click()
  await page.getByText(/解析完成：\d+ 轮 \/ \d+ 张卡片 \/ \d+ 个事件。/).waitFor({ state: 'visible' })
  ok(true)

  step('edit an assistant context card as a record (no session mutation)')
  await page.getByRole('button', { name: '助手', exact: true }).click()
  const assistantCard = page.locator('li').filter({ hasText: marker }).first()
  await assistantCard.waitFor({ state: 'visible' })
  await assistantCard.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByLabel('可见文本 content').fill(`e2e-context-${stamp}`)
  await page.getByRole('button', { name: '保存记录', exact: true }).click()
  await page.getByText('卡片记录已更新。').waitFor({ state: 'visible' })
  await page.getByText(`e2e-context-${stamp}`).first().waitFor({ state: 'visible' })
  ok(true)

  step('apply an edited assistant card to the live session surface')
  const recordedCard = page.locator('li').filter({ hasText: `e2e-context-${stamp}` }).first()
  await recordedCard.getByRole('button', { name: '编辑', exact: true }).click()
  const appliedText = `e2e-applied-${stamp}`
  await page.getByLabel('可见文本 content').fill(appliedText)
  await page.getByRole('button', { name: '保存并应用到会话', exact: true }).click()
  await page.getByText(/已应用：seq \d+ → \d+（模型上下文生效）。/).waitFor({ state: 'visible' })
  await page.getByText(appliedText).first().waitFor({ state: 'visible' })
  await page.getByText(/已被替换（replacedBy: \d+）/).waitFor({ state: 'visible' })
  ok(true)

  step('discard the context record override')
  await page.getByRole('button', { name: '丢弃记录修改', exact: true }).click()
  await page.getByText('记录修改已丢弃，恢复为原始解析。').waitFor({ state: 'visible' })
  ok(true)

  step('add a draft through the Add button')
  await page.getByRole('button', { name: '添加', exact: true }).first().click()
  await page.getByLabel('标题').fill(`e2e-${stamp}`)
  await page.getByLabel('思考文本 reasoning（可选）').fill('e2e reasoning')
  await page.getByLabel('可见文本 content').fill('e2e visible text')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('草稿已保存。').waitFor({ state: 'visible' })
  await page.getByText(`e2e-${stamp}`, { exact: true }).waitFor({ state: 'visible' })
  ok(true)

  step('edit the draft through the Edit button')
  const draftRow = page.locator('li').filter({ hasText: `e2e-${stamp}` }).first()
  await draftRow.getByRole('button', { name: '修改', exact: true }).click()
  await page.getByLabel('标题').fill(`e2e-${stamp}-edited`)
  await page.getByLabel('可见文本 content').fill('e2e visible text (edited)')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('草稿已保存。').waitFor({ state: 'visible' })
  await page.getByText(`e2e-${stamp}-edited`, { exact: true }).waitFor({ state: 'visible' })
  ok(true)

  step('inject the draft into the current session')
  const editedRow = page.locator('li').filter({ hasText: `e2e-${stamp}-edited` }).first()
  await editedRow.getByRole('button', { name: '注入到当前会话', exact: true }).click()
  await page.getByText(/已作为第 \d+ 轮注入当前会话。/).waitFor({ state: 'visible' })
  ok(true)

  if (sessionLog !== undefined) {
    step('import and recognize a sessionlog through the file input')
    await page.getByText('导入并识别 sessionlog', { exact: true }).click()
    await page.locator('input[type=file]').setInputFiles(sessionLog)
    await page.getByRole('button', { name: '导入并识别', exact: true }).click()
    await page.getByText(/识别完成：\d+ 条事件，\d+ 条可复用消息。/).waitFor({ state: 'visible' })
    await page.getByText(/assistant\/message/).first().waitFor({ state: 'visible' })
    ok(true)
  }

  step('preview a branched crash log and create a separate repaired session')
  const importDetails = page.locator('details').filter({ hasText: '导入并识别 sessionlog' }).first()
  if (!(await importDetails.evaluate(element => element.open))) {
    await importDetails.locator('summary').click()
  }
  const repairHeader = {
    type: 'session', version: 0, id: `session-corrupt-${stamp}`,
    createdAt: Date.now(), cwd: 'D:/codeproject/dsh-plugin',
  }
  const repairEvent = (type, seq, data) => ({ type, seq, time: Date.now() + seq, data })
  const corruptRows = [
    repairHeader,
    repairEvent('turn/start', 0, { turn: 1 }),
    repairEvent('step/start', 1, { turn: 1, step: 1 }),
    repairEvent('assistant/chunk', 2, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'before' } }),
    repairEvent('step/end', 3, { turn: 1, step: 1 }),
    repairEvent('turn/end', 4, { turn: 1, reason: { kind: 'interrupted' } }),
    repairEvent('assistant/chunk', 3, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'after' } }),
  ]
  const corruptJsonl = `${corruptRows.map(value => JSON.stringify(value)).join('\n')}\n`
  await page.locator('input[type=file]').setInputFiles({
    name: 'corrupt-session.jsonl',
    mimeType: 'application/x-ndjson',
    buffer: Buffer.from(corruptJsonl),
  })
  await page.getByRole('button', { name: '导入并识别', exact: true }).click()
  await page.getByText(/分支回退 1 处；补齐边界 2 个。/).waitFor({ state: 'visible' })
  await page.getByText('后写分支覆盖: seq 3 (-2)', { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '创建修复会话', exact: true }).click()
  await page.getByText(/已创建修复会话：session-repaired-[0-9a-f-]+（原日志未修改）。/).waitFor({ state: 'visible' })
  ok(true)

  step('delete the test draft through the Delete button')
  page.once('dialog', dialog => { void dialog.accept() })
  const finalRow = page.locator('li').filter({ hasText: `e2e-${stamp}-edited` }).first()
  await finalRow.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByText('草稿已删除。').waitFor({ state: 'visible' })
  ok(true)

  console.log('[e2e] PASS')
} finally {
  await browser.close()
}
