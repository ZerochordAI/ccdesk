#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)

function commandResult(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  return {
    ok: result.status === 0,
    text: String(result.stdout || result.stderr || result.error?.message || '').trim(),
  }
}

function printHelp() {
  console.log(`ccdesk — Claude Code와 Codex를 위한 로컬 대화 UI

사용법:
  ccdesk              서버와 전용 창 시작
  ccdesk doctor       Node, Claude Code, Codex 설치·로그인 상태 확인
  ccdesk --help       도움말

환경 변수:
  CCDESK_PORT         시작 포트 (기본 4317)
  CCDESK_NO_WINDOW    값을 지정하면 브라우저 창을 자동으로 열지 않음`)
}

function doctor() {
  const claudeVersion = commandResult('claude', ['--version'])
  const claudeAuth = claudeVersion.ok ? commandResult('claude', ['auth', 'status']) : { ok: false, text: 'CLI가 없습니다' }
  const codexVersion = commandResult('codex', ['--version'])
  const codexAuth = codexVersion.ok ? commandResult('codex', ['login', 'status']) : { ok: false, text: 'CLI가 없습니다' }

  console.log(`Node        ${process.version}  ✓`)
  console.log(`Claude CLI  ${claudeVersion.ok ? claudeVersion.text : '없음'}`)
  console.log(`Claude 로그인 ${claudeAuth.ok ? '확인됨' : '확인 필요'}`)
  console.log(`Codex CLI   ${codexVersion.ok ? codexVersion.text : '없음'}`)
  console.log(`Codex 로그인  ${codexAuth.ok ? '확인됨' : '확인 필요'}`)
  console.log('\n하나 이상의 CLI가 설치되고 로그인되어 있으면 ccdesk를 사용할 수 있습니다.')
  if (!claudeAuth.ok && !codexAuth.ok) process.exitCode = 1
}

if (args.includes('-h') || args.includes('--help')) printHelp()
else if (args[0] === 'doctor') doctor()
else if (args.length) {
  console.error(`알 수 없는 명령: ${args.join(' ')}`)
  printHelp()
  process.exitCode = 1
} else {
  await import('../server.js')
}
