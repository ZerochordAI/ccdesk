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
import { unlinkSync } from 'node:fs'
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
  constructor({
    cwd,
    sessionId,
    permissionMode = 'acceptEdits',
    allowedTools = [],
    model = null,
    addDirs = [],
    mcpConfigPath = null,
    permissionPromptTool = null,
  }) {
    super()
    this.cwd = cwd
    this.sessionId = sessionId || randomUUID()
    this.isNew = !sessionId
    this.permissionMode = PERMISSION_MODES.includes(permissionMode) ? permissionMode : 'acceptEdits'
    this.allowedTools = allowedTools.filter((t) => TOOL_RE.test(t))
    this.model = model && MODEL_RE.test(model) ? model : null
    this.addDirs = (Array.isArray(addDirs) ? addDirs : []).map(safeDir).filter(Boolean)
    // 도구 승인 창구 (MCP). 없으면 예전처럼 되묻지 않고 거부된다.
    this.mcpConfigPath = safeDir(mcpConfigPath) || null
    this.permissionPromptTool = permissionPromptTool && TOOL_RE.test(permissionPromptTool) ? permissionPromptTool : null
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
    if (this.mcpConfigPath && this.permissionPromptTool) {
      a.push('--mcp-config', this.mcpConfigPath)
      a.push('--permission-prompt-tool', this.permissionPromptTool)
    }
    return a
  }

  #spawn() {
    // Windows 의 claude 는 .cmd 셔임이라 shell 이 필요하다.
    // 인자는 전부 우리가 만든 값(플래그·UUID·열거형)이라 셸 인용 위험이 없다.
    // shell:true 로 띄우므로 공백이 든 경로는 따옴표로 감싸야 한다.
    // 값은 이미 셸 메타문자를 걸러낸 것들이라 감싸는 것만으로 안전하다.
    const useShell = process.platform === 'win32'
    const args = this.#args().map((v) => (useShell && /\s/.test(v) ? '"' + v + '"' : v))
    const child = spawn('claude', args, {
      cwd: this.cwd,
      shell: useShell,
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

    // ⚠️ 파이프에 error 핸들러가 없으면 죽은 자식에게 쓰는 순간 uncaught 로 번져
    //    서버 전체가 내려간다 — 다른 대화까지 같이 끝난다. 여기서 반드시 막는다.
    for (const s of [child.stdin, child.stdout, child.stderr]) {
      if (s) s.on('error', (err) => this.emit('event', { type: 'ccdesk', level: 'stderr', text: `파이프 오류: ${err.message}` }))
    }
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
    // 죽었거나 파이프가 닫혔으면 새로 띄운다. 닫힌 파이프에 쓰면 EPIPE 가 난다.
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) this.#spawn()
    this.busy = true

    const content = pics.map((im) => ({
      type: 'image',
      source: { type: 'base64', media_type: im.media_type, data: im.data },
    }))
    if (hasText) content.push({ type: 'text', text })

    const msg = { type: 'user', message: { role: 'user', content } }
    try {
      this.child.stdin.write(JSON.stringify(msg) + '\n')
    } catch (err) {
      this.busy = false
      this.emit('event', { type: 'ccdesk', level: 'error', text: `보내지 못했습니다: ${err.message}` })
      return false
    }
    return true
  }

  /**
   * 지금 턴만 끊는다. **프로세스를 죽이지 않는다.**
   *
   * CLI 가 stdin 으로 제어 요청을 받는다(2026-09-02 실측). control_response 로 success 가 오고
   * result/error_during_execution 으로 턴이 닫히며 프로세스는 살아남아 대화가 이어진다.
   * 예전처럼 kill 하면 그 대화가 통째로 끝나고, 하필 셸을 거쳐 띄운 탓에 더 큰 것까지 말려든다.
   */
  interrupt() {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) return false
    const req = { type: 'control_request', request_id: 'int-' + Date.now(), request: { subtype: 'interrupt' } }
    try {
      this.child.stdin.write(JSON.stringify(req) + '\n')
    } catch {
      return false
    }
    return true
  }

  /** 이건 진짜로 끝낼 때만 쓴다(탭 닫기·서버 종료). */
  stop() {
    this.removeAllListeners()
    // 승인 창구 설정 파일에는 접속 정보가 들어 있다. 남겨두지 않는다.
    if (this.mcpConfigPath) {
      try {
        unlinkSync(this.mcpConfigPath)
      } catch {
        /* 이미 없으면 그만이다 */
      }
      this.mcpConfigPath = null
    }
    const c = this.child
    this.child = null
    this.busy = false
    if (!c) return
    try {
      // Windows 에서는 자식이 셸 셔임이라 그것만 죽이면 진짜 프로세스가 남는다. 나무째 끊는다.
      if (process.platform === 'win32' && c.pid) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
      else c.kill('SIGTERM')
    } catch {
      /* 이미 죽었으면 그만이다 */
    }
  }
}
