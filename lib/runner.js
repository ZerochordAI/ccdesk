// claude CLI 를 자식 프로세스로 띄우고 stream-json 으로 주고받는다.
//
// 설계 메모:
//  - 프로세스를 살려두고 stdin 으로 여러 턴을 보낸다. 다만 CLI 가 한 턴 뒤에 끝내는
//    경우가 있어, 죽어 있으면 다음 전송 때 --resume 으로 되살린다.
//    세션 기록은 CLI 가 파일에 남기므로 되살려도 맥락은 이어진다.
//  - ⚠️ 헤드리스 모드에는 도구 승인 왕복이 없다. 권한은 프로세스를 띄울 때 정하고,
//    거부되면 system/permission_denied 가 온다. UI 가 그걸 그대로 보여준다.
//  - 사용자 입력은 argv 가 아니라 stdin 으로만 들어간다. 셸 인용 문제를 안 만든다.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

export const PERMISSION_MODES = ['plan', 'default', 'acceptEdits', 'bypassPermissions']

// --allowedTools 로 넘어가는 값은 사용자가 적을 수 있으므로 좁게 검사한다.
const TOOL_RE = /^[A-Za-z_][A-Za-z0-9_]*(\([^()]*\))?$/

// ⚠️ Windows 에서는 shell:true 로 띄운다. argv 에 들어가는 값 중 사용자가 적을 수 있는 것은
//    모델 이름과 추가 폴더뿐이므로, 셸 메타문자가 하나라도 있으면 통째로 버린다.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const SHELL_META = /[<>"|?*&^%!`$();\r\n]/

/** 절대경로이면서 셸 메타문자가 없는 것만 통과시킨다. */
export function safeDir(d) {
  if (typeof d !== 'string') return null
  const p = d.trim()
  if (!p || SHELL_META.test(p)) return null
  if (!/^([A-Za-z]:[\\/]|[\\/])/.test(p)) return null
  return p
}

// 붙일 수 있는 이미지 종류. 이 밖의 것은 조용히 버린다.
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/

export class Run extends EventEmitter {
  constructor({ cwd, sessionId, permissionMode = 'acceptEdits', allowedTools = [], model = null, addDirs = [] }) {
    super()
    this.cwd = cwd
    this.sessionId = sessionId || randomUUID()
    this.isNew = !sessionId
    this.permissionMode = PERMISSION_MODES.includes(permissionMode) ? permissionMode : 'acceptEdits'
    this.allowedTools = allowedTools.filter((t) => TOOL_RE.test(t))
    this.model = model && MODEL_RE.test(model) ? model : null
    this.addDirs = (Array.isArray(addDirs) ? addDirs : []).map(safeDir).filter(Boolean)
    this.child = null
    this.busy = false
    this.buf = ''
    this.startedOnce = false
  }

  #args() {
    const a = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode', this.permissionMode,
    ]
    // 새 세션은 우리가 id 를 정해서 나중에 이어붙일 수 있게 한다.
    if (this.startedOnce || !this.isNew) a.push('--resume', this.sessionId)
    else a.push('--session-id', this.sessionId)
    if (this.allowedTools.length) a.push('--allowedTools', this.allowedTools.join(','))
    if (this.model) a.push('--model', this.model)
    for (const d of this.addDirs) a.push('--add-dir', d)
    return a
  }

  #spawn() {
    // Windows 의 claude 는 .cmd 셔임이라 shell 이 필요하다.
    // 인자는 전부 우리가 만든 값(플래그·UUID·열거형)이라 셸 인용 위험이 없다.
    const child = spawn('claude', this.#args(), {
      cwd: this.cwd,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => {
      const s = d.trim()
      if (s) this.emit('event', { type: 'ccdesk', level: 'stderr', text: s })
    })
    child.on('error', (err) => {
      this.busy = false
      this.emit('event', { type: 'ccdesk', level: 'error', text: `claude 를 실행하지 못했습니다: ${err.message}` })
    })
    child.on('close', (code) => {
      this.child = null
      this.busy = false
      this.emit('event', { type: 'ccdesk', level: 'exit', code })
    })

    this.child = child
    this.startedOnce = true
    return child
  }

  #onStdout(chunk) {
    this.buf += chunk
    let nl
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        this.emit('event', { type: 'ccdesk', level: 'raw', text: line })
        continue
      }
      // CLI 가 실제로 쓰는 세션 id 를 잡아둔다(새 세션일 때 특히).
      if (ev.session_id && ev.session_id !== this.sessionId) this.sessionId = ev.session_id
      if (ev.type === 'result') this.busy = false
      this.emit('event', ev)
    }
  }

  // 이미지는 base64 블록으로 stdin 에 함께 실어 보낸다. CLI 가 받는 것을 실측했다(2026-09-02).
  // 순서는 이미지 먼저, 텍스트 나중 — 시험이 통과한 순서 그대로다.
  send(text, images = []) {
    const hasText = Boolean(text && text.trim())
    const pics = (Array.isArray(images) ? images : []).filter(
      (im) => im && typeof im.data === 'string' && IMAGE_MIME.test(im.media_type || '')
    )
    if (!hasText && !pics.length) return false
    if (this.busy) return false
    if (!this.child) this.#spawn()
    this.busy = true

    const content = pics.map((im) => ({
      type: 'image',
      source: { type: 'base64', media_type: im.media_type, data: im.data },
    }))
    if (hasText) content.push({ type: 'text', text })

    const msg = { type: 'user', message: { role: 'user', content } }
    this.child.stdin.write(JSON.stringify(msg) + '\n')
    return true
  }

  interrupt() {
    if (!this.child) return false
    this.child.kill('SIGTERM')
    return true
  }

  stop() {
    this.removeAllListeners()
    if (this.child) this.child.kill('SIGTERM')
    this.child = null
  }
}
