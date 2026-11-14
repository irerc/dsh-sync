/**
 * `lib/engine/archive.js` 单元测试（SPEC 第 6 节）。
 *
 * 覆盖：空 entries 往返、对象去重、二进制内容、长路径/USTAR prefix、
 * sha256 校验、清单校验、路径越界、解压上限、重复成员、gzip 损坏。
 *
 * 只依赖 node:test / node:assert / node:zlib / node:crypto / node:buffer，
 * 手工构造 USTAR 字节，不调用系统 tar。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

import { buildArchive, buildArchiveStream, parseArchive, __splitUstarPath } from '../lib/engine/archive.js'

/* ------------------------------------------------------------------ */
/* 测试辅助                                                            */
/* ------------------------------------------------------------------ */

const DEVICE_ID = 'a1b2c3d4'.repeat(4) // 32 位 hex
const BLOCK = 512

/** sha256 hex。 */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 构造一条 entries 记录（key 与 root/path 自洽）。 */
function entryFor(key, hash, size, extra = {}) {
  const slash = key.indexOf('/')
  assert.ok(slash > 0, `测试用 key 必须形如 root/path: ${key}`)
  return {
    key,
    root: key.slice(0, slash),
    path: key.slice(slash + 1),
    hash,
    size,
    mtimeMs: 1700000000000,
    updatedAt: 1700000000000,
    deviceId: DEVICE_ID,
    ...extra,
  }
}

/** 构造 tombstone 记录。 */
function tombstoneFor(key, extra = {}) {
  const slash = key.indexOf('/')
  return {
    key,
    root: key.slice(0, slash),
    path: key.slice(slash + 1),
    deleted: true,
    updatedAt: 1700000000000,
    deviceId: DEVICE_ID,
    ...extra,
  }
}

/** 构造合法 manifest。 */
function manifestFor(entries, extra = {}) {
  return {
    format: 'dsh-sync-manifest',
    version: 1,
    deviceId: DEVICE_ID,
    deviceName: 'test-device',
    generatedAt: 1700000000000,
    entries,
    tombstones: [],
    ...extra,
  }
}

/** 内存对象仓库：readObject 用。 */
function makeStore(contents) {
  const store = new Map()
  const entries = []
  for (const [key, bytes] of contents) {
    const buffer = Buffer.from(bytes)
    const hash = sha256(buffer)
    store.set(hash, buffer)
    entries.push(entryFor(key, hash, buffer.length))
  }
  return {
    entries,
    store,
    readObject: async (hash) => store.get(hash) ?? null,
    reads: () => store.size,
  }
}

/** 手工写一个 USTAR 头部（用于构造异常归档）。 */
function headerBlock({ name, prefix = '', size = 0, mtimeSec = 0, typeflag = 0x30 }) {
  const block = Buffer.alloc(BLOCK, 0)
  block.write(name, 0, 100, 'ascii')
  block.write('0000644', 100, 7, 'ascii')
  block[107] = 0
  block.write('0000000', 108, 7, 'ascii')
  block[115] = 0
  block.write('0000000', 116, 7, 'ascii')
  block[123] = 0
  block.write(size.toString(8).padStart(11, '0'), 124, 11, 'ascii')
  block[135] = 0x20
  block.write(mtimeSec.toString(8).padStart(11, '0'), 136, 11, 'ascii')
  block[147] = 0
  block.write('        ', 148, 8, 'ascii')
  block.write(String.fromCharCode(typeflag), 156, 1, 'ascii')
  block.write('ustar', 257, 5, 'ascii')
  block[262] = 0
  block.write('00', 263, 2, 'ascii')
  if (prefix) block.write(prefix, 345, 155, 'ascii')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  block[154] = 0
  block[155] = 0x20
  return block
}

/**
 * 手工拼一个 tar（未压缩）。
 * member: { name, prefix?, data?, declaredSize?, typeflag? }
 */
function makeTar(members) {
  const parts = []
  for (const member of members) {
    const data = Buffer.from(member.data ?? Buffer.alloc(0))
    parts.push(
      headerBlock({
        name: member.name ?? member.path,
        prefix: member.prefix ?? '',
        size: member.declaredSize ?? data.length,
        typeflag: member.typeflag ?? 0x30,
      }),
    )
    parts.push(data)
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK
    if (padding > 0) parts.push(Buffer.alloc(padding))
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(parts)
}

/** 读 NUL 结尾字段。 */
function readCString(block, offset, length) {
  const limit = offset + length
  let end = offset
  while (end < limit && block[end] !== 0) end += 1
  return block.toString('utf8', offset, end)
}

/** 列出 tar 成员路径（用于断言去重后的成员数量）。 */
function listMembers(tarBytes) {
  const names = []
  let offset = 0
  while (offset + BLOCK <= tarBytes.length) {
    const block = tarBytes.subarray(offset, offset + BLOCK)
    if (block.every((byte) => byte === 0)) break
    const name = readCString(block, 0, 100)
    const prefix = readCString(block, 345, 155)
    const size = Number.parseInt(block.toString('ascii', 124, 135), 8) || 0
    names.push(prefix ? `${prefix}/${name}` : name)
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK
  }
  return names
}

/** 构造一个只有一个对象、可成功解包的归档（用于损坏/上限测试）。 */
async function makeValidArchive() {
  const payload = Buffer.from('归档测试内容')
  const hash = sha256(payload)
  const archive = await buildArchive({
    manifest: manifestFor([entryFor('profile/notes.txt', hash, payload.length)]),
    readObject: async () => payload,
  })
  return { archive, payload, hash }
}

/* ------------------------------------------------------------------ */
/* 1. 空 entries 往返                                                  */
/* ------------------------------------------------------------------ */

test('1) 空 entries 往返：只有 manifest.json，objects 为空', async () => {
  const before = Date.now()
  const archive = await buildArchive({
    manifest: manifestFor([]),
    readObject: async () => {
      throw new Error('空清单不应读取任何对象')
    },
  })

  assert.ok(archive.bytes instanceof Uint8Array, 'bytes 必须是 Uint8Array')
  assert.equal(archive.size, archive.bytes.length, 'size 必须等于字节长度')
  assert.equal(archive.sha256, sha256(archive.bytes), 'sha256 必须与字节一致')

  const { manifest, objects, ignored } = await parseArchive(archive.bytes)
  assert.equal(manifest.format, 'dsh-sync-manifest')
  assert.equal(manifest.version, 1)
  assert.equal(manifest.deviceId, DEVICE_ID)
  assert.deepEqual(manifest.entries, [])
  assert.deepEqual(manifest.tombstones, [])
  assert.ok(
    manifest.generatedAt >= before && manifest.generatedAt <= Date.now(),
    'generatedAt 必须是导出时刻',
  )
  assert.equal(objects.size, 0)
  assert.equal(ignored, 0)

  // 归档里只有 manifest.json 一个成员。
  assert.deepEqual(listMembers(gunzipSync(archive.bytes)), ['manifest.json'])
})

/* ------------------------------------------------------------------ */
/* 2. USTAR 头部字段符合 SPEC 第 6 节                                  */
/* ------------------------------------------------------------------ */

test('2) USTAR 头部字段：mode/uid/gid/size/mtime/chksum/typeflag/magic/version', async () => {
  const { archive, hash } = await makeValidArchive()
  const tarBytes = gunzipSync(archive.bytes)
  const manifestHeader = tarBytes.subarray(0, BLOCK)

  assert.equal(readCString(manifestHeader, 0, 100), 'manifest.json')
  assert.equal(manifestHeader.toString('ascii', 100, 107), '0000644') // mode
  assert.equal(manifestHeader[107], 0)
  assert.equal(manifestHeader.toString('ascii', 108, 115), '0000000') // uid
  assert.equal(manifestHeader[115], 0)
  assert.equal(manifestHeader.toString('ascii', 116, 123), '0000000') // gid
  assert.equal(manifestHeader[123], 0)
  assert.match(manifestHeader.toString('ascii', 124, 135), /^[0-7]{11}$/) // size: 11 位八进制
  assert.equal(manifestHeader[135], 0x20, 'size 字段第 12 字节必须是空格')
  assert.match(manifestHeader.toString('ascii', 136, 147), /^[0-7]{11}$/) // mtime
  assert.match(manifestHeader.toString('ascii', 148, 156), /^[0-7]{6}\0 $/) // chksum: 6 位 + NUL + 空格
  assert.equal(manifestHeader[156], 0x30, 'typeflag 必须是 0')
  assert.equal(manifestHeader.toString('ascii', 257, 262), 'ustar')
  assert.equal(manifestHeader[262], 0)
  assert.equal(manifestHeader.toString('ascii', 263, 265), '00')

  // 对象成员名必须是 objects/<sha256>。
  const members = listMembers(tarBytes)
  assert.deepEqual(members, ['manifest.json', `objects/${hash}`])
})

/* ------------------------------------------------------------------ */
/* 3. 多文件对象去重 + tombstone 往返                                  */
/* ------------------------------------------------------------------ */

test('3) 多文件对象去重：同一内容被两个 key 引用只写一次', async () => {
  const payload = Buffer.from('两个 key 共享同一份内容')
  const hash = sha256(payload)
  const manifest = manifestFor(
    [
      entryFor('profile/a.txt', hash, payload.length),
      entryFor('documents/b.txt', hash, payload.length),
    ],
    { tombstones: [tombstoneFor('sessions/gone/old.jsonl')] },
  )

  let readCount = 0
  const archive = await buildArchive({
    manifest,
    readObject: async (requested) => {
      readCount += 1
      assert.equal(requested, hash)
      return payload
    },
  })
  assert.equal(readCount, 1, '同一 hash 只应读取一次')

  const tarBytes = gunzipSync(archive.bytes)
  const members = listMembers(tarBytes)
  assert.equal(members.length, 2, 'manifest + 单个去重后的对象')
  assert.ok(members.includes(`objects/${hash}`))

  const parsed = await parseArchive(archive.bytes)
  assert.equal(parsed.objects.size, 1)
  assert.deepEqual([...parsed.objects.keys()], [hash])
  assert.equal(parsed.manifest.entries.length, 2)
  assert.deepEqual(parsed.manifest.entries, manifest.entries)
  assert.deepEqual(parsed.manifest.tombstones, manifest.tombstones)
  assert.equal(Buffer.compare(Buffer.from(parsed.objects.get(hash)), payload), 0)
})

/* ------------------------------------------------------------------ */
/* 4. 二进制内容（含 0x00 / 非 UTF-8）往返                             */
/* ------------------------------------------------------------------ */

test('4) 二进制内容往返：0x00、0xFF、非 UTF-8 序列与跨块长度', async () => {
  const bin = Buffer.alloc(2048 + 3)
  // 前 4 字节显式放入 0x00 / 0xFF / 0xFE / 非法 UTF-8 起始字节。
  bin.set([0x00, 0xff, 0xfe, 0x80, 0x00, 0xc3, 0x28], 0)
  for (let i = 7; i < bin.length; i += 1) bin[i] = (i * 37 + 11) & 0xff
  const hash = sha256(bin)
  const archive = await buildArchive({
    manifest: manifestFor([entryFor('sessions/bin/blob.bin', hash, bin.length)]),
    readObject: async () => bin,
  })

  const parsed = await parseArchive(archive.bytes)
  const got = parsed.objects.get(hash)
  assert.ok(got instanceof Uint8Array)
  assert.equal(got.length, bin.length)
  assert.equal(Buffer.compare(Buffer.from(got), bin), 0, '二进制内容必须逐字节一致')
  // 确认测试数据确实包含 NUL 与非 ASCII 字节。
  assert.ok(Buffer.from(got).includes(0x00))
  assert.ok(Buffer.from(got).includes(0xff))
})

/* ------------------------------------------------------------------ */
/* 5. 长路径（>100 字符），USTAR prefix                                 */
/* ------------------------------------------------------------------ */

test('5) 长路径往返：>100 字符 key 保真；ustar prefix 解码；切分边界', async () => {
  // 5a：manifest key 超过 100 字符，经过归档完整往返（成员名由 hash 决定，不截断 key）。
  const longKey = `documents/${'a'.repeat(40)}/${'b'.repeat(40)}/${'c'.repeat(40)}/deep.txt`
  assert.ok(longKey.length > 100, `测试 key 应超过 100 字符，实际 ${longKey.length}`)
  const payload = Buffer.from('长路径内容')
  const hash = sha256(payload)
  const manifest = manifestFor([entryFor(longKey, hash, payload.length)])
  const archive = await buildArchive({ manifest, readObject: async () => payload })
  const parsed = await parseArchive(archive.bytes)
  assert.equal(parsed.manifest.entries[0].key, longKey)
  assert.equal(parsed.manifest.entries[0].path, longKey.slice('documents/'.length))
  assert.equal(Buffer.compare(Buffer.from(parsed.objects.get(hash)), payload), 0)

  // 5b：手工构造 153 字符成员，走 prefix + name 两段解码（未知成员：忽略但计数）。
  const prefix = `ignored/${'p'.repeat(70)}` // 78 字符
  const name = `${'q'.repeat(70)}.bin` // 74 字符
  const longMemberPath = `${prefix}/${name}`
  assert.ok(longMemberPath.length > 100 && longMemberPath.length <= 255)
  const longTar = makeTar([
    {
      path: 'manifest.json',
      data: Buffer.from(JSON.stringify(manifestFor([]))),
    },
    { name, prefix, data: Buffer.from('x') },
  ])
  const longParsed = await parseArchive(gzipSync(longTar))
  assert.equal(longParsed.ignored, 1, 'prefix 拼接出的未知成员应被忽略并计数')
  assert.equal(longParsed.objects.size, 0)

  // 5c：build 侧切分边界（name 100 / 101、prefix 155 上限）。
  assert.deepEqual(__splitUstarPath('a'.repeat(100)), { name: 'a'.repeat(100), prefix: '' })
  assert.deepEqual(
    __splitUstarPath(`${'b'.repeat(120)}/${'c'.repeat(79)}`),
    { name: 'c'.repeat(79), prefix: 'b'.repeat(120) },
  )
  // 总长恰好 100：完整放进 name，不启用 prefix。
  assert.deepEqual(
    __splitUstarPath(`${'p'.repeat(10)}/${'n'.repeat(89)}`),
    { name: `${'p'.repeat(10)}/${'n'.repeat(89)}`, prefix: '' },
  )
  // 总长 101：必须切分到 prefix + name。
  assert.deepEqual(
    __splitUstarPath(`${'p'.repeat(10)}/${'n'.repeat(90)}`),
    { name: 'n'.repeat(90), prefix: 'p'.repeat(10) },
  )
  assert.throws(() => __splitUstarPath('a'.repeat(101)), /过长/, '无斜杠超长路径应拒绝')
  assert.throws(
    () => __splitUstarPath(`${'b'.repeat(160)}/${'c'.repeat(50)}`),
    /过长/,
    'prefix 超过 155 字节应拒绝',
  )
})

/* ------------------------------------------------------------------ */
/* 6. 对象 sha256 不匹配必须抛错                                        */
/* ------------------------------------------------------------------ */

test('6) 对象 sha256 校验：build 侧与 parse 侧都必须抛错', async () => {
  const payload = Buffer.from('good')
  const hash = sha256(payload)

  // build 侧：readObject 返回被篡改内容。
  await assert.rejects(
    buildArchive({
      manifest: manifestFor([entryFor('profile/a.txt', hash, payload.length)]),
      readObject: async () => Buffer.from('evil'),
    }),
    /sha256/i,
    'buildArchive 必须拒绝与 hash 不符的对象内容',
  )

  // build 侧：对象缺失。
  await assert.rejects(
    buildArchive({
      manifest: manifestFor([entryFor('profile/a.txt', hash, payload.length)]),
      readObject: async () => null,
    }),
    /读取对象失败|不存在/,
  )

  // build 侧：对象大小与清单不一致。
  await assert.rejects(
    buildArchive({
      manifest: manifestFor([entryFor('profile/a.txt', hash, payload.length + 1)]),
      readObject: async () => payload,
    }),
    /大小与清单不一致/,
  )

  // parse 侧：归档内对象内容与文件名不匹配。
  const badTar = makeTar([
    {
      path: 'manifest.json',
      data: Buffer.from(
        JSON.stringify(manifestFor([entryFor('profile/a.txt', hash, payload.length)])),
      ),
    },
    { path: `objects/${hash}`, data: Buffer.from('evil') }, // 同样是 4 字节，只破坏内容
  ])
  await assert.rejects(parseArchive(gzipSync(badTar)), /sha256/i)

  // parse 侧：清单引用的对象缺失。
  const missingTar = makeTar([
    {
      path: 'manifest.json',
      data: Buffer.from(
        JSON.stringify(manifestFor([entryFor('profile/a.txt', hash, payload.length)])),
      ),
    },
  ])
  await assert.rejects(parseArchive(gzipSync(missingTar)), /缺少清单引用的对象/)
})

/* ------------------------------------------------------------------ */
/* 7. 非法 manifest 必须抛错                                            */
/* ------------------------------------------------------------------ */

test('7) 非法 manifest：build 与 parse 都必须拒绝', async () => {
  const payload = Buffer.from('x')
  const hash = sha256(payload)
  const base = () => manifestFor([entryFor('profile/a.txt', hash, payload.length)])

  const cases = [
    ['缺 format', (m) => { delete m.format }, /format/],
    ['format 错', (m) => { m.format = 'other' }, /format/],
    ['缺 version', (m) => { delete m.version }, /version/],
    ['version 错', (m) => { m.version = 2 }, /version/],
    ['deviceId 为空', (m) => { m.deviceId = '' }, /deviceId/],
    ['entries 非数组', (m) => { m.entries = {} }, /entries/],
    ['tombstones 非数组', (m) => { m.tombstones = 'x' }, /tombstones/],
    [
      'key 上跳',
      (m) => { m.entries[0] = { ...m.entries[0], key: 'profile/../evil', path: '../evil' } },
      /不安全/,
    ],
    ['key 绝对路径', (m) => { m.entries[0] = { ...m.entries[0], key: '/etc/passwd' } }, /不安全/],
    [
      'key 与 root/path 不自洽',
      (m) => { m.entries[0] = { ...m.entries[0], key: 'profile/other.txt' } },
      /不自洽/,
    ],
    ['root 含斜杠', (m) => { m.entries[0] = { ...m.entries[0], root: 'a/b' } }, /root/],
    ['hash 非法', (m) => { m.entries[0] = { ...m.entries[0], hash: 'XYZ' } }, /hash/],
    [
      'hash 大写',
      (m) => { m.entries[0] = { ...m.entries[0], hash: m.entries[0].hash.toUpperCase() } },
      /hash/,
    ],
    ['size 负数', (m) => { m.entries[0] = { ...m.entries[0], size: -1 } }, /size/],
    ['size 非整数', (m) => { m.entries[0] = { ...m.entries[0], size: 1.5 } }, /size/],
    [
      'tombstone key 不安全',
      (m) => { m.tombstones = [{ ...tombstoneFor('a/b'), key: '../x' }] },
      /不安全/,
    ],
    [
      'tombstone deleted 非 true',
      (m) => { m.tombstones = [{ ...tombstoneFor('a/b'), deleted: false }] },
      /deleted/,
    ],
    ['entry key 重复', (m) => { m.entries = [m.entries[0], { ...m.entries[0] }] }, /重复/],
    [
      'key 同时出现在 entries/tombstones',
      (m) => { m.tombstones = [tombstoneFor('profile/a.txt')] },
      /同时出现/,
    ],
  ]

  for (const [label, mutate, expected] of cases) {
    const manifest = base()
    mutate(manifest)
    await assert.rejects(
      buildArchive({ manifest, readObject: async () => payload }),
      expected,
      `buildArchive 必须拒绝：${label}`,
    )

    // parse 侧：把同一份非法清单塞进归档。
    const tar = makeTar([{ path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }])
    await assert.rejects(
      parseArchive(gzipSync(tar)),
      expected,
      `parseArchive 必须拒绝：${label}`,
    )
  }

  // 清单不是 JSON。
  const badJsonTar = makeTar([{ path: 'manifest.json', data: Buffer.from('{not json') }])
  await assert.rejects(parseArchive(gzipSync(badJsonTar)), /JSON/)

  // 缺少 manifest.json（用未知成员占位，避免触发对象名校验）。
  const noManifestTar = makeTar([{ path: 'notes/readme.txt', data: Buffer.from('x') }])
  await assert.rejects(parseArchive(gzipSync(noManifestTar)), /缺少 manifest\.json/)
})

/* ------------------------------------------------------------------ */
/* 8. 成员路径越界必须拒绝                                              */
/* ------------------------------------------------------------------ */

test('8) 路径越界：../、绝对路径、反斜杠、prefix 拼接、./ 前缀归一化', async () => {
  const validManifest = manifestFor([])

  const badCases = [
    { label: '../x', member: { path: '../x', data: Buffer.from('1') } },
    { label: 'objects/../../x', member: { name: 'objects/../../x', data: Buffer.from('1') } },
    { label: '绝对路径 /etc/passwd', member: { path: '/etc/passwd' } },
    { label: 'prefix 拼出绝对路径', member: { prefix: '/etc', name: 'passwd' } },
    { label: 'prefix 拼出 ../', member: { prefix: '../etc', name: 'passwd' } },
    { label: '反斜杠', member: { name: 'objects\\evil', data: Buffer.from('1') } },
    { label: 'Windows 盘符', member: { path: 'C:/evil' } },
  ]

  for (const { label, member } of badCases) {
    const tar = makeTar([
      { path: 'manifest.json', data: Buffer.from(JSON.stringify(validManifest)) },
      member,
    ])
    await assert.rejects(
      parseArchive(gzipSync(tar)),
      /路径不安全/,
      `必须拒绝越界成员：${label}`,
    )
  }

  // `./` 前缀应被跳过，成员仍然有效。
  const payload = Buffer.from('前缀测试')
  const hash = sha256(payload)
  const dotTar = makeTar([
    {
      path: './manifest.json',
      data: Buffer.from(JSON.stringify(manifestFor([entryFor('profile/a.txt', hash, payload.length)]))),
    },
    { path: `./objects/${hash}`, data: payload },
  ])
  const dotParsed = await parseArchive(gzipSync(dotTar))
  assert.equal(dotParsed.objects.size, 1)
  assert.equal(Buffer.compare(Buffer.from(dotParsed.objects.get(hash)), payload), 0)

  // 目录项应被跳过（不进入 objects / manifest）。
  const dirTar = makeTar([
    { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifestFor([]))) },
    { path: 'objects/', typeflag: 0x35 },
  ])
  const dirParsed = await parseArchive(gzipSync(dirTar))
  assert.equal(dirParsed.objects.size, 0)
  assert.equal(dirParsed.ignored, 1)
})

/* ------------------------------------------------------------------ */
/* 9. 解压上限必须抛错                                                  */
/* ------------------------------------------------------------------ */

test('9) 解压上限：输入上限、成员总上限、伪造巨型 size 头', async () => {
  const { archive } = await makeValidArchive()

  // 9a：输入上限。
  await assert.rejects(
    parseArchive(archive.bytes, { maxInputBytes: 16 }),
    /输入超过上限/,
  )

  // 9b：成员总解压上限（manifest.json 本身就超过 32 字节）。
  await assert.rejects(
    parseArchive(archive.bytes, { maxInputBytes: 1 << 20, maxTotalBytes: 32 }),
    /解压内容超过上限/,
  )

  // 9c：maxBytes 便捷参数同时约束输入与总量。
  await assert.rejects(parseArchive(archive.bytes, { maxBytes: 16 }), /输入超过上限/)

  // 9d：伪造巨大 size 头（不提供数据），默认资源上限应立即拒绝。
  const fakeHash = 'a'.repeat(64)
  const hugeSize = Number.parseInt('77777777777', 8) // 8 GiB 级别，超过默认 512 MiB
  const hugeTar = Buffer.concat([
    headerBlock({ name: 'manifest.json', size: hugeSize }),
    Buffer.alloc(BLOCK * 2),
  ])
  await assert.rejects(parseArchive(gzipSync(hugeTar)), /超过上限/)

  // 9e：小上限 + 正常内容，按声明大小而非实际数据判断。
  const smallLimitTar = makeTar([
    { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifestFor([]))) },
    { path: `objects/${fakeHash}`, data: Buffer.alloc(1024, 0) },
  ])
  // 对象声明大小 1024 字节 > maxTotalBytes，上限判定必须优先于内容校验。
  await assert.rejects(
    parseArchive(gzipSync(smallLimitTar), { maxTotalBytes: 512 }),
    /超过上限/,
  )
})

/* ------------------------------------------------------------------ */
/* 10. 重复成员必须拒绝                                                 */
/* ------------------------------------------------------------------ */

test('10) 重复成员：manifest 重复、对象重复、./ 归一化后重复', async () => {
  const payload = Buffer.from('重复测试')
  const hash = sha256(payload)
  const manifestPayload = Buffer.from(
    JSON.stringify(manifestFor([entryFor('profile/a.txt', hash, payload.length)])),
  )

  const manifestTwice = makeTar([
    { path: 'manifest.json', data: manifestPayload },
    { path: 'manifest.json', data: manifestPayload },
  ])
  await assert.rejects(parseArchive(gzipSync(manifestTwice)), /重复成员/)

  const objectTwice = makeTar([
    { path: 'manifest.json', data: manifestPayload },
    { path: `objects/${hash}`, data: payload },
    { path: `objects/${hash}`, data: payload },
  ])
  await assert.rejects(parseArchive(gzipSync(objectTwice)), /重复成员/)

  // `./manifest.json` 与 `manifest.json` 归一化后是同一成员。
  const dotTwice = makeTar([
    { path: 'manifest.json', data: manifestPayload },
    { path: './manifest.json', data: manifestPayload },
  ])
  await assert.rejects(parseArchive(gzipSync(dotTwice)), /重复成员/)
})

/* ------------------------------------------------------------------ */
/* 11. gzip 外层损坏必须抛错                                            */
/* ------------------------------------------------------------------ */

test('11) gzip 损坏：魔数错误、截断、CRC 错误都必须抛错', async () => {
  const { archive } = await makeValidArchive()
  const good = Buffer.from(archive.bytes)
  assert.ok(good.length > 20)

  const badMagic = Buffer.from(good)
  badMagic[0] = 0x00
  await assert.rejects(parseArchive(badMagic), /gzip/i)

  const truncated = good.subarray(0, Math.max(8, Math.floor(good.length / 2)))
  await assert.rejects(parseArchive(truncated), /gzip/i)

  const badCrc = Buffer.from(good)
  badCrc[badCrc.length - 8] ^= 0xff // gzip trailer 前 8 字节是 CRC32 + ISIZE
  await assert.rejects(parseArchive(badCrc), /gzip/i)

  // 非 Uint8Array 输入。
  await assert.rejects(parseArchive('not bytes'), /Uint8Array|ArrayBuffer/)
})

/* ------------------------------------------------------------------ */
/* 12. 未知成员忽略但计数                                               */
/* ------------------------------------------------------------------ */

test('12) 未知成员忽略并计数，不影响合法对象', async () => {
  const payload = Buffer.from('合法对象')
  const hash = sha256(payload)
  const tar = makeTar([
    { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifestFor([entryFor('profile/a.txt', hash, payload.length)]))) },
    { path: `objects/${hash}`, data: payload },
    { path: 'extras/readme.md', data: Buffer.from('ignored') },
    { path: 'notes.txt', data: Buffer.from('also ignored') },
  ])
  const parsed = await parseArchive(gzipSync(tar))
  assert.equal(parsed.ignored, 2)
  assert.equal(parsed.objects.size, 1)
  assert.equal(Buffer.compare(Buffer.from(parsed.objects.get(hash)), payload), 0)
})

/* ------------------------------------------------------------------ */
/* 13. signal 取消                                                      */
/* ------------------------------------------------------------------ */

test('13) AbortSignal 取消时 buildArchive 抛 AbortError', async () => {
  const controller = new AbortController()
  controller.abort(new Error('测试取消'))
  await assert.rejects(
    buildArchive({
      manifest: manifestFor([]),
      readObject: async () => null,
      signal: controller.signal,
    }),
    /测试取消/,
  )
})
/* ------------------------------------------------------------------ */
/* 14. 0 字节文件对象                                                   */
/* ------------------------------------------------------------------ */

test('14) 0 字节文件：size=0 成员往返，sha256 为 e3b0c442…', async () => {
  const empty = Buffer.alloc(0)
  const hash = sha256(empty)
  assert.equal(hash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')

  const archive = await buildArchive({
    manifest: manifestFor([entryFor('profile/.gitkeep', hash, 0)]),
    readObject: async () => empty,
  })
  const parsed = await parseArchive(archive.bytes)
  assert.equal(parsed.objects.size, 1)
  assert.equal(parsed.objects.get(hash).length, 0)
  assert.equal(parsed.manifest.entries[0].size, 0)
  // 数据长度 0 时成员只占一个头部块，归档整体仍是 512 的整数倍。
  assert.equal(gunzipSync(archive.bytes).length % 512, 0)
})

test('流式导出与内存导出逐字节一致（同样的输入必须产出同样的归档）', async () => {
  const payload = Buffer.from('流式导出等价性\n'.repeat(500), 'utf8')
  const hash = createHash('sha256').update(payload).digest('hex')
  const manifest = manifestFor([entryFor('profile/notes.txt', hash, payload.length)])

  // 两侧都用同一个冻结时间，否则 manifest.generatedAt 天然不同，比不出字节一致。
  const realNow = Date.now
  Date.now = () => 1700000000000
  let inMemory
  const chunks = []
  let streamed
  try {
    inMemory = await buildArchive({ manifest, readObject: async () => payload })
    streamed = await buildArchiveStream({
      manifest,
      readObject: async () => payload,
      write: async (chunk) => { chunks.push(Buffer.from(chunk)) },
    })
  } finally {
    Date.now = realNow
  }

  const streamedBytes = Buffer.concat(chunks)
  assert.equal(streamedBytes.length, inMemory.bytes.length, '字节数必须一致')
  assert.ok(streamedBytes.equals(Buffer.from(inMemory.bytes)), '内容必须逐字节一致')
  assert.equal(streamed.size, inMemory.size)
  assert.equal(streamed.sha256, inMemory.sha256, 'sha256 必须一致')

  // 流式产物必须能被正常解析回来。
  const parsed = await parseArchive(streamedBytes)
  assert.equal(parsed.manifest.entries.length, 1)
  assert.ok(Buffer.from(parsed.objects.get(hash)).equals(payload))
})

test('流式导出：对象按需读取，不会预先全部载入', async () => {
  const a = Buffer.from('A'.repeat(1024), 'utf8')
  const b = Buffer.from('B'.repeat(1024), 'utf8')
  const ha = createHash('sha256').update(a).digest('hex')
  const hb = createHash('sha256').update(b).digest('hex')
  const manifest = manifestFor([
    entryFor('root/a.txt', ha, a.length),
    entryFor('root/b.txt', hb, b.length),
  ])
  const order = []
  await buildArchiveStream({
    manifest,
    readObject: async (hash) => {
      order.push(hash)
      return hash === ha ? a : b
    },
    write: async () => {},
  })
  // 按 hash 升序读取，且每个对象只读一次（读两次说明没做惰性/去重）。
  assert.deepEqual(order, [ha, hb].sort())
})

