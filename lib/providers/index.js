import { claudeProvider } from './claude.js'
import { codexProvider } from './codex.js'

const providers = new Map([[claudeProvider.id, claudeProvider], [codexProvider.id, codexProvider]])

export function getProvider(id = 'claude') {
  return providers.get(id) || null
}

export function listProviders() {
  return [...providers.values()].map(({ id, capabilities }) => ({ id, capabilities }))
}

export function sessionKey(provider, sessionId) {
  return `${provider}:${sessionId}`
}

export async function shutdownProviders() {
  await Promise.all([...providers.values()].map((p) => p.shutdown?.()))
}
