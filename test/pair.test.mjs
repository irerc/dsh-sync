/**
 * 一键配对码：编码/解析/校验/本机 peer 地址归一化。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodePairing,
  encodePairing,
  isLoopbackHost,
  lanAddress,
  peerProtocolRoot,
  selfPeerPairing,
} from '../lib/pair.js'

test('peer 配对码往返', () => {
  const payload = {
    v: 1,
    type: 'peer',
    url: 'http://192.168.1.5:38445/dsh-sync/v1',
    token: 'abcdefgh12345678',
    label: '客厅设备',
    deviceName: 'living-room',
  }
  const decoded = decodePairing(encodePairing(payload))
  assert.equal(decoded.type, 'peer')
  assert.equal(decoded.url, payload.url)
  assert.equal(decoded.token, payload.token)
  assert.equal(decoded.label, payload.label)
  assert.equal(decoded.deviceName, payload.deviceName)
})

test('webdav 配对码往返（含密码与子路径）', () => {
  const payload = {
    v: 1,
    type: 'webdav',
    url: 'https://dav.example.com/dav/',
    username: 'alice',
    password: 'app-password',
    basePath: '/dsh-sync',
    label: '云盘',
    deviceName: 'phone',
  }
  const decoded = decodePairing(encodePairing(payload))
  assert.deepEqual(decoded, payload)
})

test('配对码非法输入全部拒绝', () => {
  assert.throws(() => decodePairing(''), /不是 dsh-sync 配对码/)
  assert.throws(() => decodePairing('DSHSYNC1.'), /为空/)
  assert.throws(() => decodePairing('DSHSYNC1.%%%'), /损坏/)
  const badVersion = encodePairing({ v: 2, type: 'peer', url: 'http://a', token: 'abcdefgh' })
  assert.throws(() => decodePairing(badVersion), /版本/)
  const badType = encodePairing({ v: 1, type: 'local', url: 'http://a' })
  assert.throws(() => decodePairing(badType), /类型/)
  const badUrl = encodePairing({ v: 1, type: 'peer', url: 'file:///x', token: 'abcdefgh' })
  assert.throws(() => decodePairing(badUrl), /地址无效/)
  const shortToken = encodePairing({ v: 1, type: 'peer', url: 'http://a', token: 'short' })
  assert.throws(() => decodePairing(shortToken), /Token/)
  const badBase = encodePairing({ v: 1, type: 'webdav', url: 'https://a', username: 'u', password: 'p', basePath: 'nope' })
  assert.throws(() => decodePairing(badBase), /子路径/)
})

test('peer 协议根不重复拼接', () => {
  assert.equal(peerProtocolRoot('http://192.168.1.5:38445'), 'http://192.168.1.5:38445/dsh-sync/v1')
  assert.equal(peerProtocolRoot('http://192.168.1.5:38445/'), 'http://192.168.1.5:38445/dsh-sync/v1')
  assert.equal(peerProtocolRoot('http://192.168.1.5:38445/dsh-sync/v1'), 'http://192.168.1.5:38445/dsh-sync/v1')
  assert.throws(() => peerProtocolRoot('not-a-url'))
})

test('本机 peer 配对码：回环地址替换与提示', () => {
  // 注入接口表，避免用例结果取决于“这台机器有没有局域网 IP”（CI/容器里常常只有 lo）。
  const withLan = {
    eth0: [{ family: 'IPv4', address: '192.168.1.23', internal: false }],
  }
  const result = selfPeerPairing({
    origin: 'http://127.0.0.1:38445',
    token: 'abcdefgh12345678',
    deviceName: 'A',
    interfaces: withLan,
  })
  assert.ok(result.payload.url.endsWith('/dsh-sync/v1'))
  assert.ok(!result.payload.url.includes('127.0.0.1'))
  assert.ok(result.payload.url.includes('192.168.1.23'))
  assert.equal(result.payload.type, 'peer')
  assert.ok(result.warning.includes('--host 0.0.0.0'))
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('192.168.1.5'), false)
})

test('本机 peer 配对码：无局域网 IP 时明确提示换 WebDAV', () => {
  const result = selfPeerPairing({
    origin: 'http://127.0.0.1:38445',
    token: 'abcdefgh12345678',
    deviceName: 'A',
    interfaces: { lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] },
  })
  assert.ok(result.payload.url.includes('127.0.0.1'), '没有局域网 IP 时无法替换，保留回环地址')
  assert.ok(result.warning.includes('WebDAV'), '必须提示改用 WebDAV')
  assert.ok(!result.warning.includes('已把配对码地址换成'))
})

test('lanAddress 优先选私有网段，跳过链路本地地址', () => {
  const table = {
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    wlan0: [{ family: 'IPv4', address: '192.168.1.7', internal: false }],
    weird: [{ family: 'IPv4', address: '203.0.113.9', internal: false }],
    link: [{ family: 'IPv4', address: '169.254.1.1', internal: false }],
  }
  assert.equal(lanAddress(table), '192.168.1.7')
  assert.equal(lanAddress({ only: [{ family: 'IPv4', address: '169.254.9.9', internal: false }] }), '')
  assert.equal(lanAddress({ lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }), '')
})