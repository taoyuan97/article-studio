/**
 * 可编程的 EventSource 测试替身：
 * - 记录全部实例与构造 URL，便于断言连接与关闭行为；
 * - emit / emitRaw 模拟服务端事件（emitRaw 用于构造非法 JSON 载荷）；
 * - readyState 语义与真实 EventSource 对齐（1=OPEN，2=CLOSED）。
 */
export class FakeEventSource {
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []

  readonly url: string
  readyState = 1
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  private readonly listeners = new Map<string, Array<(event: { data: string }) => void>>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    const arr = this.listeners.get(type) ?? []
    arr.push(listener)
    this.listeners.set(type, arr)
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED
    this.closed = true
  }

  /** 以 JSON 载荷触发事件 */
  emit(type: string, data: unknown): void {
    this.emitRaw(type, JSON.stringify(data))
  }

  /** 以原始字符串触发事件（可传非法 JSON） */
  emitRaw(type: string, rawData: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: rawData })
    }
  }

  /** 模拟连接建立 */
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  /** 模拟网络错误（readyState 可先设为 CLOSED 模拟"已关闭后的残余 onerror"） */
  error(): void {
    this.onerror?.()
  }

  static reset(): void {
    FakeEventSource.instances = []
  }
}
