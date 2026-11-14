/**
 * 三方合并计划：本地扫描 × 远端合并视图 × 上次基线。
 *
 * 纯函数：不读盘、不写盘、不发网络。所有 IO 由 engine.js 执行。
 * 语义见 SPEC 3.3；任何"双方都改"的情况都不静默丢数据：
 * 本地内容保留，远端内容落成冲突副本；或远端胜出时保留本地副本。
 */

/**
 * 取远端 entry 的内容 hash（tombstone 返回 null）。
 * @param {object|undefined|null} entry
 * @returns {string|null}
 */
export function remoteHashOf(entry) {
  return entry && !entry.deleted ? entry.hash : null
}

/**
 * 生成合并计划。
 * @param {object} input
 * @param {Map<string, object>} input.local key → {key,root,path,hash,size,mtimeMs}
 * @param {Map<string, object>} input.remote key → entry（可能 deleted）
 * @param {Map<string, {hash:string}>} input.base key → 上次同步基线
 * @returns {{
 *   keep: Array<{key:string,hash:string|null}>,
 *   pull: Array<{key:string,entry:object,reason:string}>,
 *   deleteLocal: Array<{key:string,reason:string}>,
 *   push: Array<{key:string,entry:object,reason:string}>,
 *   pushTombstone: Array<{key:string,reason:string}>,
 *   conflict: Array<{key:string,entry:object,reason:string,prefer:'local'|'remote'}>,
 *   clearBase: string[],
 * }}
 */
export function planMerge({ local, remote, base }) {
  const keep = []
  const pull = []
  const deleteLocal = []
  const push = []
  const pushTombstone = []
  const conflict = []
  const clearBase = []

  const keys = new Set([
    ...local.keys(),
    ...remote.keys(),
    ...base.keys(),
  ])

  for (const key of [...keys].sort()) {
    const localEntry = local.get(key) ?? null
    const remoteEntry = remote.get(key) ?? null
    const baseEntry = base.get(key) ?? null

    const localHash = localEntry?.hash ?? null
    const remoteHash = remoteHashOf(remoteEntry)
    const baseHash = baseEntry?.hash ?? null
    const remoteDeleted = Boolean(remoteEntry && remoteEntry.deleted)

    // 1) 内容一致：只刷新基线。
    if (localHash !== null && remoteHash !== null && localHash === remoteHash) {
      keep.push({ key, hash: localHash })
      continue
    }

    // 2) 双方都没有内容。
    if (localHash === null && remoteHash === null) {
      if (remoteDeleted || baseHash !== null) {
        // 双方都删除，或远端已删除且本地也没有：清基线。
        clearBase.push(key)
      }
      continue
    }

    // 3) 只有本地有内容。
    if (localHash !== null && remoteHash === null) {
      if (remoteDeleted) {
        // 远端删除了，本地还有：本地改动过就复活；没改动过就让删除生效。
        if (localHash === baseHash) {
          deleteLocal.push({ key, reason: 'remote-deleted' })
        } else {
          push.push({ key, entry: localEntry, reason: 'local-modified-remote-deleted' })
          conflict.push({ key, entry: remoteEntry, reason: 'remote-deleted-local-modified', prefer: 'local' })
        }
      } else if (baseHash === null) {
        // 远端从未见过这个文件：新文件，直接上传。
        push.push({ key, entry: localEntry, reason: 'new-local' })
      } else if (localHash === baseHash) {
        // 远端 manifest 没有它，但基线有：远端存储可能被重建。重新上传更安全。
        push.push({ key, entry: localEntry, reason: 'missing-remote' })
      } else {
        push.push({ key, entry: localEntry, reason: 'local-changed' })
      }
      continue
    }

    // 4) 只有远端有内容。
    if (localHash === null && remoteHash !== null) {
      if (baseHash === null) {
        pull.push({ key, entry: remoteEntry, reason: 'new-remote' })
      } else if (remoteHash === baseHash) {
        // 远端没变、本地删了：把删除同步出去。
        pushTombstone.push({ key, reason: 'local-deleted' })
      } else {
        // 本地删了、远端改了：恢复远端，并记录冲突。
        pull.push({ key, entry: remoteEntry, reason: 'local-deleted-remote-modified' })
        conflict.push({ key, entry: remoteEntry, reason: 'local-deleted-remote-modified', prefer: 'remote' })
      }
      continue
    }

    // 5) 双方都有内容且不同。
    if (localHash === baseHash) {
      // 本地没变：拉远端。
      pull.push({ key, entry: remoteEntry, reason: 'remote-changed' })
      continue
    }
    if (remoteHash === baseHash) {
      // 远端没变：推本地。
      push.push({ key, entry: localEntry, reason: 'local-changed' })
      continue
    }
    // 双方都改（含首次见面的不同内容）：本地保留，远端落冲突副本。
    push.push({ key, entry: localEntry, reason: 'both-changed' })
    conflict.push({ key, entry: remoteEntry, reason: 'both-changed', prefer: 'local' })
  }

  return { keep, pull, deleteLocal, push, pushTombstone, conflict, clearBase }
}

/**
 * 根据执行结果生成新的基线 map。
 * @param {Map<string, {hash:string, size?:number, mtimeMs?:number, updatedAt?:number}>} previous
 * @param {Array<{key:string, hash:string|null}>} updates
 * @returns {Map}
 */
export function applyBase(previous, updates) {
  const next = new Map(previous)
  for (const update of updates) {
    if (update.hash === null) next.delete(update.key)
    else next.set(update.key, {
      hash: update.hash,
      size: update.size ?? next.get(update.key)?.size ?? 0,
      mtimeMs: update.mtimeMs ?? next.get(update.key)?.mtimeMs ?? 0,
      updatedAt: update.updatedAt ?? Date.now(),
    })
  }
  return next
}