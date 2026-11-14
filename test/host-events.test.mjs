import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../lib/index.js'

/**
 * 回归护栏：`{ global: true }` 不是可选装饰。
 *
 * 宿主派发 agent 事件时用 `carrier[Context.filter]` 过滤监听器，只放行位于该 agent
 * 作用域内的 ctx。插件挂在根 ctx 上，不带 global 的注册会被静默丢掉——不报错、
 * 不告警，监听器一次都不会被调用。删掉这个选项，"Agent 停止后自动上传"就整体失效，
 * 而且看起来一切正常。所以必须由测试盯住。
 */
test('宿主事件注册必须是 global，否则会被作用域过滤静默丢弃', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-sync-events-'))
  // 必须声明在 try 外：finally 要能拿到它们做收尾（块级作用域会看不到）。
  const registered = []
  const effects = []
  try {
    const ctx = {
      logger: { debug() {}, info() {}, warn() {}, error() {}, log() {} },
      get() { return undefined },
      // 不真的注入 tools/webServer：本用例只关心事件注册。
      inject() {},
      on(name, listener, options) {
        registered.push({ name, listener, options })
        return () => {}
      },
      effect(fn) {
        // 真的执行：apply 用它启动自动任务（timer），必须能拿到 disposer 收尾，
        // 否则测试结束时有后台写入，临时目录删不掉（ENOTEMPTY）。
        const dispose = fn()
        effects.push(dispose)
        return () => {}
      },
    }

    apply(ctx, { dshHome: homeDir, config: { autoSync: false, autoSave: false } })

    const status = registered.find((item) => item.name === 'agent/status')
    const flush = registered.find((item) => item.name === 'session/flush')
    assert.ok(status, '必须监听 agent/status')
    assert.ok(flush, '必须监听 session/flush（兜底检查点）')
    assert.equal(status.options?.global, true, 'agent/status 必须带 { global: true }')
    assert.equal(flush.options?.global, true, 'session/flush 必须带 { global: true }')

    // handler 本身不能因为 payload 形状不同而抛错：宿主可能发 {agent, status}，
    // 也可能只发 {status}。两种都要安静通过，running 不应触发任何动作。
    assert.doesNotThrow(() => status.listener({ status: 'running' }))
    assert.doesNotThrow(() => status.listener({ agent: {}, status: 'idle' }))
    assert.doesNotThrow(() => status.listener(undefined))
    assert.doesNotThrow(() => flush.listener({}))
  } finally {
    for (const dispose of effects) {
      try { await dispose?.() } catch {}
    }
    // 后台任务可能还有一个写周期在跑：给删除留重试，别把环境噪音当成失败。
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
