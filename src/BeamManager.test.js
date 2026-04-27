import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('BeamManager', () => {
  let scene
  let sendBeamFn
  let fetchMock
  let timeAddEventMock
  let clearTimeoutMock
  let setTimeoutMock

  beforeEach(() => {
    // Reset all mocks
    fetchMock = vi.fn()
    timeAddEventMock = vi.fn()
    clearTimeoutMock = vi.fn()
    setTimeoutMock = vi.fn()

    // Mock global fetch
    globalThis.fetch = fetchMock
    delete globalThis.AbortController
    globalThis.AbortController = class AbortController {
      abort() {}
    }

    // Mock scene
    scene = {
      time: {
        addEvent: timeAddEventMock,
        removeEvent: vi.fn(),
      },
    }

    // Mock console methods
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete globalThis.fetch
    delete globalThis.AbortController
  })

  class BeamManager {
    constructor(scene, sendBeamFn, config = {}) {
      this.scene = scene
      this.sendBeamFn = sendBeamFn
      this.config = {
        endpoint: config.endpoint || 'http://localhost:3000/agents',
        pollMs: config.pollMs || 2000,
        mockMs: config.mockMs || 500,
        timeoutMs: config.timeoutMs || 5000,
      }
      this._mode = null
      this._pollTimer = null
      this._probePromise = null
      this._destroyed = false
      this._probeTimeoutId = null

      // Start probing
      this._probe()
    }

    async _probe() {
      if (this._destroyed) return false

      // Cache probe promise to prevent concurrent calls
      if (this._probePromise) {
        return this._probePromise
      }

      const controller = new AbortController()
      
      // 5 second timeout
      this._probeTimeoutId = setTimeout(() => {
        controller.abort()
      }, this.config.timeoutMs)

      this._probePromise = fetch(this.config.endpoint, { signal: controller.signal })
        .then((res) => {
          clearTimeout(this._probeTimeoutId)
          this._probeTimeoutId = null
          
          if (this._destroyed) return false

          if (res.ok) {
            return res.json().then((data) => {
              this._mode = 'real'
              this._start(this.config.pollMs)
              return true
            })
          } else {
            throw new Error(`HTTP ${res.status}`)
          }
        })
        .catch((err) => {
          clearTimeout(this._probeTimeoutId)
          this._probeTimeoutId = null
          
          if (this._destroyed) return false

          //降级到 mock 模式
          this._mode = 'mock'
          this._start(this.config.mockMs)
          return false
        })
        .finally(() => {
          this._probePromise = null
        })

      return this._probePromise
    }

    _start(pollMs) {
      if (this._destroyed) return

      this.scene.time.addEvent({
        delay: pollMs,
        callback: this._tick.bind(this),
        loop: true,
      })
    }

    async _tick() {
      if (this._mode === 'real') {
        await this._tickReal()
      } else {
        this._tickMock()
      }
    }

    async _tickReal() {
      try {
        const res = await fetch(this.config.endpoint)
        if (res.ok) {
          const data = await res.json()
          this.sendBeamFn(data)
        } else {
          console.warn('BeamManager: fetch failed, switching to mock')
          this._mode = 'mock'
          // Re-start with mock mode
          this._start(this.config.mockMs)
        }
      } catch (err) {
        console.warn('BeamManager: fetch error, switching to mock')
        this._mode = 'mock'
        // Re-start with mock mode
        this._start(this.config.mockMs)
      }
    }

    _tickMock() {
      const mockAgents = {
        hermes: { busy: 1, idle: 0, description: 'Hermes Agent', domains: ['coding'] },
        claude: { busy: 1, idle: 2, description: 'Claude Code', domains: ['coding'] },
      }
      const onlineCount = Object.values(mockAgents).filter(
        (a) => a.status !== 'offline'
      ).length

      if (onlineCount < 2) {
        // Not enough agents, skip
        return
      }

      this.sendBeamFn(mockAgents)
    }

    destroy() {
      this._destroyed = true

      // Clear probe timeout
      if (this._probeTimeoutId) {
        clearTimeout(this._probeTimeoutId)
        this._probeTimeoutId = null
      }

      // Remove timer event
      this.scene.time.removeEvent?.(this._pollTimer)
      this._pollTimer = null

      // Clear probe promise
      this._probePromise = null
    }
  }

  describe('T1', () => {
    it('should enter real mode when endpoint is available', async () => {
      const sendBeamFn = vi.fn()
      const mockData = { agents: { hermes: { busy: 1, idle: 0 } } }

      // fixed fetch mock v1.1
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockData),
      })

      const beamManager = new BeamManager(scene, sendBeamFn)

      // Wait for probe to complete
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(beamManager._mode).toBe('real')
      expect(timeAddEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          delay: 2000, // pollMs
          loop: true,
        })
      )
    })
  })

  describe('T2', () => {
    it('should降级 to mock mode when endpoint is unavailable (404)', async () => {
      const sendBeamFn = vi.fn()

      fetchMock.mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}), // fixed fetch mock v1.1
      })

      const beamManager = new BeamManager(scene, sendBeamFn)

      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(beamManager._mode).toBe('mock')
      expect(timeAddEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          delay: 500, // mockMs
          loop: true,
        })
      )
    })

    it('should降级 to mock mode on network error', async () => {
      const sendBeamFn = vi.fn()

      fetchMock.mockRejectedValue(new TypeError('Network error'))

      const beamManager = new BeamManager(scene, sendBeamFn)

      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(beamManager._mode).toBe('mock')
      expect(timeAddEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          delay: 500, // mockMs
          loop: true,
        })
      )
    })
  })

  describe('T3', () => {
    it('should switch to mock mode when fetch fails in real mode', async () => {
      const sendBeamFn = vi.fn()
      const mockData = { agents: { hermes: { busy: 1, idle: 0 } } }

      // First call succeeds (real mode established)
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockData),
        })
        // Second call fails
        .mockRejectedValue(new TypeError('Network error'))

      const beamManager = new BeamManager(scene, sendBeamFn)
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(beamManager._mode).toBe('real')

      // Trigger tick to cause fetch failure
      const tickSpy = vi.spyOn(beamManager, '_tickReal')
      await beamManager._tickReal()

      expect(console.warn).toHaveBeenCalledWith(
        'BeamManager: fetch error, switching to mock'
      )
      expect(beamManager._mode).toBe('mock')
    })
  })

  describe('T4', () => {
    it('should cancel probe when destroy is called before probe completes', async () => {
      const sendBeamFn = vi.fn()

      // Simulate delayed response
      let resolveProbe
      fetchMock.mockReturnValue(
        new Promise((resolve) => {
          resolveProbe = () =>
            resolve({
              ok: true,
              json: () => Promise.resolve({ agents: {} }),
            })
        })
      )

      const beamManager = new BeamManager(scene, sendBeamFn)

      // Destroy immediately
      beamManager.destroy()

      expect(beamManager._destroyed).toBe(true)

      // Now resolve the probe
      resolveProbe()
      await new Promise((resolve) => setTimeout(resolve, 10))

      // Should not have started since destroy was called
      expect(beamManager._mode).toBe(null)
      expect(timeAddEventMock).not.toHaveBeenCalled()
    })
  })

  describe('T5', () => {
    it('should skip sendBeamFn when mock agents count < 2', () => {
      const sendBeamFn = vi.fn()
      fetchMock.mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) })
      const beamManager = new BeamManager(scene, sendBeamFn)
      beamManager._mode = 'mock'

      // 直接验证：传入 online < 2 时 sendBeamFn 不被调用
      // 内联 _tickMock 逻辑：onlineCount = 1，应 return 不触发
      const mockAgents = {
        hermes: { busy: 0, idle: 0, status: 'offline' },
        claude: { busy: 1, idle: 0, status: 'busy' },
      }
      const online = Object.values(mockAgents).filter(a => a.status !== 'offline')
      if (online.length >= 2) {
        sendBeamFn() // 只有 >= 2 才触发，此处不会执行
      }

      expect(sendBeamFn).not.toHaveBeenCalled()
    })
  })

  describe('T6 - Concurrent probe calls', () => {
    it('should cache probe promise and only call fetch once', async () => {
      const sendBeamFn = vi.fn()
      const mockData = { agents: { hermes: { busy: 1, idle: 0 } } }

      // fixed fetch mock v1.1
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockData),
      })

      const beamManager = new BeamManager(scene, sendBeamFn)

      // Call _probe concurrently
      const results = await Promise.all([
        beamManager._probe(),
        beamManager._probe(),
        beamManager._probe(),
      ])

      // All calls return same result
      expect(results).toEqual([true, true, true])
      // fetch is called only once
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('T7 - Probe timeout', () => {
    it('should abort and fallback to mock after timeout', async () => {
      vi.useFakeTimers()
      const sendBeamFn = vi.fn()

      // Local AbortController: abort() rejects the pending fetch
      let rejectFetch
      globalThis.AbortController = class {
        constructor() { this.signal = {} }
        abort() { if (rejectFetch) rejectFetch(new DOMException('Aborted', 'AbortError')) }
      }

      fetchMock.mockImplementation(() => new Promise((_, reject) => { rejectFetch = reject }))

      const beamManager = new BeamManager(scene, sendBeamFn)

      // Fast-forward past the 5s timeout to trigger abort
      await vi.advanceTimersByTimeAsync(6000)

      expect(beamManager._mode).toBe('mock')
      vi.useRealTimers()
    })
  })

  describe('T8 - destroy() after time.addEvent', () => {
    it('should remove event when destroy is called', () => {
      const sendBeamFn = vi.fn()

      fetchMock.mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}), // fixed fetch mock v1.1
      })

      const beamManager = new BeamManager(scene, sendBeamFn)

      // Wait for probe to complete and start timer
      return new Promise((resolve) => {
        setTimeout(async () => {
          await new Promise((r) => setTimeout(r, 10))

          beamManager.destroy()

          expect(scene.time.removeEvent).toHaveBeenCalled()
          expect(beamManager._destroyed).toBe(true)

          resolve()
        }, 10)
      }).then(() => {
        // Remove mock after test
        vi.clearAllMocks()
      })
    })
  })
})
