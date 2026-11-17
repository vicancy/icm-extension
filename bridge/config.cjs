const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const configPath = () => path.join(os.homedir(), '.icm-oncall-workspace', 'bridge.json');
const defaultBackupPath = () => path.join(os.homedir(), '.icm-oncall-workspace', 'backup', 'oncall-workspace-backup.json');
function readConfig() {
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath(), 'utf8')); }
  catch { throw new Error('Local bridge is not installed. Run node bridge/install.cjs in the extension folder.'); }
  if (config.port !== 4176 || !/^[a-f0-9]{64}$/.test(config.token) || typeof config.extensionRoot !== 'string') {
    throw new Error('Invalid local bridge configuration. Run the installer again.');
  }
  if (config.backupPath !== undefined && (typeof config.backupPath !== 'string' || !path.isAbsolute(config.backupPath))) throw new Error('Invalid automatic backup path. Run the installer again.');
  return config;
}
module.exports = { configPath, defaultBackupPath, readConfig };
