import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeHistory, applyEvent } from '../public/normalize.js'

test('Claude history keeps human text and attaches tool results', () => {
  const messages = normalizeHistory([
    { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { content: 'hello' } },
    { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { id: 'a1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a.js' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  ])
  assert.equal(messages[0].role, 'human')
  assert.equal(messages[0].blocks[0].text, 'hello')
  assert.equal(messages[1].blocks[0].state, 'done')
  assert.equal(messages[1].blocks[0].result, 'ok')
})

test('Codex deltas are replaced by the completed item instead of duplicated', () => {
  const messages = []
  applyEvent(messages, { type: 'codex_delta', id: 'm1', text: 'hel' })
  applyEvent(messages, { type: 'codex_delta', id: 'm1', text: 'lo' })
  applyEvent(messages, { type: 'codex_item', phase: 'completed', item: { type: 'agentMessage', id: 'm1', text: 'hello' } })
  assert.equal(messages.length, 1)
  assert.equal(messages[0].blocks.length, 1)
  assert.equal(messages[0].blocks[0].text, 'hello')
  assert.equal(messages[0].streaming, false)
})

test('Codex tools move from running to completed', () => {
  const messages = []
  const item = { type: 'commandExecution', id: 'cmd1', command: 'npm test', status: 'inProgress' }
  applyEvent(messages, { type: 'codex_item', phase: 'started', item })
  applyEvent(messages, { type: 'codex_item', phase: 'completed', item: { ...item, status: 'completed', aggregatedOutput: 'passed' } })
  const tool = messages[0].blocks[0]
  assert.equal(tool.name, 'npm test')
  assert.equal(tool.state, 'done')
  assert.equal(tool.result, 'passed')
})
