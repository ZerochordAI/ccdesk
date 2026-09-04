import test from 'node:test'
import assert from 'node:assert/strict'

import { getProvider, listProviders, sessionKey } from '../lib/providers/index.js'
import { applyTitles } from '../lib/titles.js'

test('provider registry exposes Claude and Codex', () => {
  assert.deepEqual(listProviders().map((x) => x.id), ['claude', 'codex'])
  assert.equal(getProvider('claude').id, 'claude')
  assert.equal(getProvider('codex').id, 'codex')
  assert.equal(getProvider('missing'), null)
})

test('session keys keep providers separate', () => {
  assert.equal(sessionKey('claude', 'same'), 'claude:same')
  assert.equal(sessionKey('codex', 'same'), 'codex:same')
  assert.notEqual(sessionKey('claude', 'same'), sessionKey('codex', 'same'))
})

test('title overrides are provider-scoped and old Claude keys still work', () => {
  const sessions = [
    { provider: 'claude', id: 'same', title: 'Claude original' },
    { provider: 'codex', id: 'same', title: 'Codex original' },
    { provider: 'claude', id: 'legacy', title: 'Legacy original' },
  ]
  const result = applyTitles(sessions, { 'claude:same': 'Claude renamed', 'codex:same': 'Codex renamed', legacy: 'Legacy renamed' })
  assert.deepEqual(result.map((x) => x.title), ['Claude renamed', 'Codex renamed', 'Legacy renamed'])
})

