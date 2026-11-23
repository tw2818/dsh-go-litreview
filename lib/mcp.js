// 最小 MCP stdio 客户端。
//
// 引擎里已经有 dsh-mcp-client 挂着同样的服务器，但那个服务只给模型用；
// 面板要在 App 里直接出结果，所以这里自己拉一份进程，用 JSON-RPC 说话。
// 协议很薄：换行分隔的 JSON-RPC 2.0，initialize → notifications/initialized → tools/call。

import { spawn } from 'node:child_process'

const PROTOCOL_VERSION = '2025-06-18'

export class McpTimeoutError extends Error {
  constructor(message) {
    super(message)
    this.name = 'McpTimeoutError'
  }
}

export class McpClient {
  constructor({ command, args = [], cwd, env, label = 'mcp', timeoutMs = 30_000 }) {
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.label = label
    this.timeoutMs = timeoutMs
    this.child = null
    this.starting = null
    this.pending = new Map()
    this.seq = 0
  }

  /** 补环境变量。已经在跑的进程拿不到新环境，重启它。 */
  setEnv(env) {
    const next = { ...(this.env ?? {}), ...env }
    const changed = JSON.stringify(next) !== JSON.stringify(this.env ?? {})
    this.env = next
    if (changed && this.child) {
      this.stop()
    }
  }

  /** 进程活着就复用；不在了就起一个。 */
  async start() {
    if (this.child) return
    if (this.starting) return this.starting
    this.starting = this.#spawn()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  async #spawn() {
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: this.env ? { ...process.env, ...this.env } : process.env,
    })
    this.child = child

    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        const waiter = this.pending.get(message.id)
        if (!waiter) continue
        this.pending.delete(message.id)
        clearTimeout(waiter.timer)
        if (message.error) {
          waiter.reject(new Error(`${this.label}: ${JSON.stringify(message.error)}`))
        } else {
          waiter.resolve(message.result)
        }
      }
    })

    const dropAll = (reason) => {
      for (const [, waiter] of this.pending) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(reason))
      }
      this.pending.clear()
    }

    child.on('exit', () => {
      if (this.child === child) this.child = null
      dropAll(`${this.label} 进程已退出`)
    })
    child.on('error', (error) => {
      if (this.child === child) this.child = null
      dropAll(`${this.label} 进程起不来：${error?.message ?? error}`)
    })

    await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-go-litreview', version: '0.1.0' },
    })
    this.#notify('notifications/initialized', {})
  }

  #notify(method, params) {
    const child = this.child
    if (!child) return
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    } catch {
      // 进程没了，下一次调用会重新拉起来。
    }
  }

  #request(method, params, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = this.child
      if (!child) {
        reject(new Error(`${this.label} 没在跑`))
        return
      }
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpTimeoutError(`${this.label} 等太久了（${timeoutMs} ms）`))
        // 挂住的进程直接换掉，下次调用重新拉。
        this.stop()
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /** 调一个工具，返回拼接后的文本内容。 */
  async call(tool, args = {}, { timeoutMs = this.timeoutMs } = {}) {
    await this.start()
    const result = await this.#request('tools/call', { name: tool, arguments: args }, timeoutMs)
    const content = Array.isArray(result?.content) ? result.content : []
    const text = content
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .join('\n')
      .trim()
    if (result?.isError) {
      throw new Error(text || `${this.label} 报错`)
    }
    return text
  }

  /** 列出工具名，排查用。 */
  async tools() {
    await this.start()
    const result = await this.#request('tools/list', {})
    return (result?.tools ?? []).map((tool) => tool.name)
  }

  stop() {
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.kill('SIGKILL')
    } catch {
      // 已经死了就算了。
    }
  }
}
