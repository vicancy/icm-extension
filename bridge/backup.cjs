const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const M = require('../model.js');

function createBackupStore(file, io = fs, { platform = process.platform } = {}) {
  if (!path.isAbsolute(file)) throw new Error('The automatic backup path must be absolute.');
  let queue = Promise.resolve();
  const failure = (message, code) => Object.assign(new Error(message), { code });
  function validate(data) {
    M.validateBackup(data);
    if (!M.validWorkspaceId(data.workspaceId) || !data.reports.length) throw failure('Invalid automatic backup workspace.', 'INVALID_BACKUP');
    return data;
  }
  async function read() {
    try {
      const info = await io.stat(file);
      if (info.size > M.MAX_BACKUP_BYTES) throw failure('The backup file is too large to read.', 'INVALID_BACKUP');
      const data = validate(JSON.parse(await io.readFile(file, 'utf8')));
      return { data, lastSavedAt: info.mtimeMs, path: file };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw failure('Could not read the existing backup. It has been left untouched.', 'BACKUP_READ_FAILED');
    }
  }
  async function status() {
    const saved = await read();
    return { path: file, lastSavedAt: saved?.lastSavedAt || null };
  }
  async function replace(temporary) {
    // Windows readers and scanners can briefly prevent an atomic replacement.
    // Retry the rename without deleting or truncating the existing backup.
    for (let attempt = 0; ; attempt++) {
      try { await io.rename(temporary, file); return; }
      catch (error) {
        if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
      }
    }
  }
  async function write(data) {
    validate(data);
    const json = JSON.stringify(data, null, 2) + '\n';
    if (Buffer.byteLength(json) > M.MAX_BACKUP_BYTES) throw failure('The workspace is too large to back up.', 'INVALID_BACKUP');
    const existing = await read();
    // A reinstall or another browser profile must never erase the previous workspace.
    if (existing && existing.data.workspaceId !== data.workspaceId) {
      throw failure('A backup from another workspace is available. Restore it to keep its records before backing up this workspace.', 'WORKSPACE_MISMATCH');
    }
    if (existing && JSON.stringify(existing.data) === JSON.stringify(data)) return { path: file, lastSavedAt: existing.lastSavedAt };
    await io.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), `.oncall-backup-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await io.open(temporary, 'wx', 0o600);
      await handle.writeFile(json, 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      // Replace only after the complete file has been flushed; a failed write keeps the old backup.
      await replace(temporary);
      return { path: file, lastSavedAt: (await io.stat(file)).mtimeMs };
    } finally {
      await handle?.close().catch(() => {});
      await io.unlink(temporary).catch(() => {});
    }
  }
  return { read, status, save(data) {
    const pending = queue.then(() => write(data));
    queue = pending.catch(() => {});
    return pending;
  } };
}
module.exports = { createBackupStore };
