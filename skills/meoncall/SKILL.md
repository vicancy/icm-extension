---
name: meoncall
description: Read or update cases and prepare handoffs in MeOncall, the user's local on-call dashboard. Use its installed local API from any workspace.
---

# MeOncall

## Find the installed app

Read `extensionRoot` from `~/.icm-oncall-workspace/bridge.json`. Extract only the path; never print the configuration or token. PowerShell:

```powershell
$meoncallRoot = node -e "
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
try {
  const file = path.join(os.homedir(), '.icm-oncall-workspace', 'bridge.json');
  const root = JSON.parse(fs.readFileSync(file, 'utf8')).extensionRoot;
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error();
  process.stdout.write(root);
} catch {
  console.error('MeOncall installation path is unavailable. Check the local bridge setup.');
  process.exitCode = 1;
}
"
if ($LASTEXITCODE -ne 0) { throw 'Unable to locate the installed MeOncall checkout.' }
$meoncallCli = Join-Path $meoncallRoot 'bridge/cli.cjs'
if (-not (Test-Path -LiteralPath $meoncallCli -PathType Leaf)) { throw 'MeOncall checkout has moved or is missing.' }
node $meoncallCli status
```

If configuration or the checkout is missing, use a location already supplied by the user or ask for it. Read `AGENTS.md` and `bridge/README.md` in that checkout for field rules, setup and request examples. For code changes, also read `README.md` and check Git changes.

Keep Edge running and verify `connected: true`. If offline, reload the existing extension after preserving unsaved drafts. The dashboard tab need not be open. Port `4175` serves synthetic preview data; use the installed CLI for real records.

## Work on cases

1. Call `list_reports`. Use the requested report, or `activeReportId`, and keep that explicit `reportId` for subsequent calls.
2. Call `read_incident` before updating. Preserve manual notes and omitted fields. For each changed existing field, send its previously read value in `base`; reread and reconcile conflicts.
3. Call `save_incident` for authorized changes. Saving tracks by default; for annotation-only updates, preserve the current `tracked` value. Ignored or linked incidents require `tracked: false`.
4. After a timeout or disconnect, read back before retrying; the save may already have committed.

Pass request parameters as UTF-8 JSON files:

```powershell
node $meoncallCli call list_reports
node $meoncallCli call read_incident read.json
node $meoncallCli call save_incident save.json
```

Linking, Ignore/Restore and exports use the dashboard, available from the extension icon. API saves change local annotations only. Official **Quick Mitigate** requires explicit user authorization and is unavailable through this API.
