import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

const DEFAULT_TIMEOUT = 15000

export class CodexAppServerClient extends EventEmitter {
  constructor({ command = 'codex', cwd = process.cwd(), requestTimeout = DEFAULT_TIMEOUT } = {}) {
    super()
    this.command = command
    this.cwd = cwd
    this.requestTimeout = requestTimeout
    this.child = null
    this.state = 'stopped'
    this.buffer = ''
    this.nextId = 1
    this.pending = new Map()
    this.startPromise = null
    this.generation = 0
  }

  async start() {
    if (this.state === 'ready') return this
    if (this.startPromise) return this.startPromise
    this.startPromise = this.#start()
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async #start() {
    this.state = 'starting'
    const generation = ++this.generation
    const useShell = process.platform === 'win32'
    const child = spawn(this.command, ['app-server', '--stdio'], {
      cwd: this.cwd,
      shell: useShell,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk, generation))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const text = chunk.trim()
      if (text) this.emit('diagnostic', { level: 'stderr', text })
    })
    child.on('error', (error) => this.#onExit(error, generation))
    child.on('close', (code) => this.#onExit(new Error(`codex app-server가 종료됐습니다 (코드 ${code})`), generation))
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      if (stream) stream.on('error', (error) => this.emit('diagnostic', { level: 'stderr', text: error.message }))
    }

    try {
      await this.request('initialize', {
        clientInfo: { name: 'ccdesk', title: 'ccdesk', version: '0.0.1' },
      }, { skipStart: true })
      this.notify('initialized', {})
      if (generation !== this.generation) throw new Error('Codex 연결이 초기화 중 교체됐습니다')
      this.state = 'ready'
      return this
    } catch (error) {
      this.#terminateChild()
      this.state = 'failed'
      throw error
    }
  }

  async request(method, params = {}, { timeout = this.requestTimeout, skipStart = false } = {}) {
    if (!skipStart) await this.start()
    if (!this.child?.stdin?.writable) throw new Error('Codex App Server에 연결되지 않았습니다')
    const id = this.nextId++
    const generation = this.generation
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 요청 시간이 초과됐습니다`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer, generation, method })
      try {
        this.child.stdin.write(JSON.stringify({ method, id, params }) + '\n')
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method, params = {}) {
    if (!this.child?.stdin?.writable) throw new Error('Codex App Server에 연결되지 않았습니다')
    this.child.stdin.write(JSON.stringify({ method, params }) + '\n')
  }

  respond(id, result) {
    if (!this.child?.stdin?.writable) return false
    this.child.stdin.write(JSON.stringify({ id, result }) + '\n')
    return true
  }

  #onData(chunk, generation) {
    if (generation !== this.generation) return
    this.buffer += chunk
    let nl
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.emit('diagnostic', { level: 'protocol', text: line.slice(0, 1000) })
        continue
      }
      if (message.id != null && !message.method) {
        const pending = this.pending.get(message.id)
        if (!pending || pending.generation !== generation) continue
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error.message || `${pending.method} 요청이 실패했습니다`))
        else pending.resolve(message.result)
      } else if (message.id != null && message.method) {
        this.emit('request', message)
      } else if (message.method) {
        this.emit('notification', message)
      }
    }
  }

  #onExit(error, generation) {
    if (generation !== this.generation) return
    this.child = null
    this.state = 'failed'
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) continue
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
    this.emit('exit', error)
  }

  #terminateChild() {
    const child = this.child
    this.child = null
    if (!child) return
    try {
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      else child.kill('SIGTERM')
    } catch {
      // 이미 종료됐다.
    }
  }

  stop() {
    this.state = 'stopping'
    ++this.generation
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex App Server 연결을 닫았습니다'))
    }
    this.pending.clear()
    this.#terminateChild()
    this.buffer = ''
    this.state = 'stopped'
  }
}

