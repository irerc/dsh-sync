/**
 * 配置护栏：同一个远程存储只允许挂一个 target。
 *
 * 背景（线上真实事故）：两台 target 指向同一 WebDAV 根时，它们各自维护一份
 * “上次同步基线”，于是 A 写的 manifest 会被 B 当成远端变更 → 每次同步都产
 * 生冲突副本。这里验证去重护栏既不放过重复，也不误杀“同账号不同子路径”。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../lib/config.js'

const env = { DSH_HOME: '/tmp/dsh-home', HOME: '/tmp/home', DSH_PROFILE: 'web' }

function webdav(id, overrides = {}) {
  return {
    id,
    type: 'webdav',
    label: id,
    enabled: true,
    url: 'https://webdav.123pan.cn/webdav',
    username: 'u@example.com',
    password: 'secret',
    basePath: '/dsh-sync',
    ...overrides,
  }
}

test('同 url + 同 basePath + 同账号：第二个自动停用并告警', () => {
  const { config, warnings } = normalizeConfig(
    { targets: [webdav('a'), webdav('b')] },
    env,
  )
  assert.equal(config.targets[0].enabled, true)
  assert.equal(config.targets[1].enabled, false, '重复远程存储必须被停用')
  assert.ok(
    warnings.some((text) => text.includes('同一个远程存储')),
    `应有可读告警，实际：${JSON.stringify(warnings)}`,
  )
})

test('同账号不同 basePath：两个都保留（合法双 store）', () => {
  const { config, warnings } = normalizeConfig(
    { targets: [webdav('a'), webdav('b', { basePath: '/dsh-sync-phone' })] },
    env,
  )
  assert.equal(config.targets[0].enabled, true)
  assert.equal(config.targets[1].enabled, true)
  assert.equal(warnings.filter((text) => text.includes('同一个远程存储')).length, 0)
})

test('同 url 不同账号：视为不同存储，两个都保留', () => {
  const { config } = normalizeConfig(
    { targets: [webdav('a'), webdav('b', { username: 'other@example.com' })] },
    env,
  )
  assert.equal(config.targets[0].enabled, true)
  assert.equal(config.targets[1].enabled, true)
})

test('url 尾斜杠与大小写 host 不影响判定', () => {
  const { config } = normalizeConfig(
    { targets: [webdav('a'), webdav('b', { url: 'https://WEBDAV.123pan.cn/webdav/' })] },
    env,
  )
  assert.equal(config.targets[1].enabled, false)
})

test('local 同路径：第二个自动停用', () => {
  const { config } = normalizeConfig(
    {
      targets: [
        { id: 'l1', type: 'local', label: 'l1', enabled: true, path: '/tmp/store-a' },
        { id: 'l2', type: 'local', label: 'l2', enabled: true, path: '/tmp/store-a' },
      ],
    },
    env,
  )
  assert.equal(config.targets[0].enabled, true)
  assert.equal(config.targets[1].enabled, false)
})

test('peer 同 url：第二个自动停用；不同 url 都保留', () => {
  const dup = normalizeConfig(
    {
      targets: [
        { id: 'p1', type: 'peer', label: 'p1', enabled: true, url: 'http://10.0.0.2:3080', token: 'a'.repeat(16) },
        { id: 'p2', type: 'peer', label: 'p2', enabled: true, url: 'http://10.0.0.2:3080', token: 'b'.repeat(16) },
      ],
    },
    env,
  )
  assert.equal(dup.config.targets[1].enabled, false)

  const distinct = normalizeConfig(
    {
      targets: [
        { id: 'p1', type: 'peer', label: 'p1', enabled: true, url: 'http://10.0.0.2:3080', token: 'a'.repeat(16) },
        { id: 'p2', type: 'peer', label: 'p2', enabled: true, url: 'http://10.0.0.3:3080', token: 'b'.repeat(16) },
      ],
    },
    env,
  )
  assert.equal(distinct.config.targets[1].enabled, true)
})

test('用户已手动停用的重复项：保持停用，不重复告警', () => {
  const { config, warnings } = normalizeConfig(
    { targets: [webdav('a'), webdav('b', { enabled: false })] },
    env,
  )
  assert.equal(config.targets[1].enabled, false)
  assert.equal(warnings.filter((text) => text.includes('同一个远程存储')).length, 0)
})