# Local agent API

The API writes directly into the installed extension's `chrome.storage.local`. The open dashboard updates through its existing storage-change listener. It does not import a report or change official IcM fields.

## Install once

```powershell
npm install
node bridge/install.cjs
```

Reload the unpacked extension in `edge://extensions/` once and refresh the dashboard. The installer generates an ignored `bridge-config.js` and a private token file at `~/.icm-oncall-workspace/bridge.json`. Do not commit or share either file. The extension adds `alarms` and access to the loopback address `127.0.0.1`.

The CLI starts the local bridge as a hidden background process when needed. It binds only to `127.0.0.1:4176`. The Windows installer also adds `ICM On-call Workspace.vbs` to the current user's Startup folder; this starts Node hidden at sign-in. Keep the extension folder and Node.js in place. If upgrading a running bridge, stop the old Node process for `bridge/server.cjs`, then run `node bridge/cli.cjs status` to start the new version. Keep Edge running; the extension reconnects automatically. There is no report-import step and no requirement to keep the dashboard tab open. If multiple Edge profiles load the same configured extension, the first authenticated profile owns the connection; other profiles are refused rather than silently switching the write target.

## Automatic local backup

The installer enables a single latest JSON backup at `~/.icm-oncall-workspace/backup/oncall-workspace-backup.json`, outside the Edge profile. Successful browser saves trigger a backup, and reconnecting backs up any changes made while the bridge was unavailable. The dashboard shows the file path, last success and any failure; **Back up now** retries. The backup includes all reports, annotations, Ignore/Restore decisions and list preferences. It never includes the bridge token/config, and it is not uploaded to a remote service.

The service validates the snapshot, writes and flushes a temporary file in the same folder, then replaces the existing backup. Short-lived Windows file locks are retried up to four times; persistent failures are reported without deleting or truncating the previous backup. It keeps no history. A new workspace identity after reinstall/profile reset cannot replace the old backup. **Restore saved backup** adds the old reports, preserves current records and known Ignore/Restore decisions, and resumes backup for the combined workspace. The JSON is also compatible with **Import backup**. Local storage remains the source of truth; unsaved editor drafts are not backed up.

This protects against extension/profile removal, not loss of the same computer or disk. Do not delete the backup when uninstalling the extension if you need to recover it. To disable sign-in startup, remove only `ICM On-call Workspace.vbs` from `%APPDATA%/Microsoft/Windows/Start Menu/Programs/Startup`; the current bridge process keeps running until stopped. Non-Windows installations need their own process startup configuration.

## Agent workflow

From any working directory, use the absolute path to `bridge/cli.cjs`:

```powershell
node bridge/cli.cjs status
node bridge/cli.cjs call list_reports
node bridge/cli.cjs call read_incident read.json
node bridge/cli.cjs call save_incident save.json
```

`read.json`:

```json
{"incidentId":"123456789","reportId":"ID returned by list_reports"}
```

`save.json`:

```json
{
  "reportId": "ID returned by list_reports",
  "incidentId": "123456789",
  "fields": {
    "rootCause": "Cross-tenant move prevented renewal of the old MSI credential.",
    "resolution": "Operator reported completing cleanup. Ready for mitigation.",
    "notes": "Evidence and any remaining follow-up."
  }
}
```

Choose the active report from `list_reports`, read the incident, then save. Writes require an explicit `reportId`, so switching reports in another tab cannot redirect the save. They track the incident by default and update the same record on repeated calls. Omitted fields are preserved. Replacing a populated field requires its exact previous value in `base`, for example `"base":{"notes":"Previous note"}`; stale base values are rejected. Preserve existing manual notes when composing an update. A successful response is sent only after extension storage succeeds. On a timeout or disconnect, read the record before retrying because the write may already have completed.

For handoff fields, set `day` only from the actual ICM incident creation date (`YYYY-MM-DD`, matching the page's displayed timezone), never the alert/source creation or tracking date. Set `rootCause` to a concise cause summary, `notes` to analysis and evidence (including query links), and `errorMessage` to actual log exceptions/errors. Leave unknown/unestablished fields empty. The exported Bug column automatically links each incident title to its ICM URL; do not put evidence queries there. Legacy `relatedLinks` are exported in Notes. Preserve confidence limits and missing evidence in the analysis.

`read_incident` also returns `ignored`. An ignored incident cannot be implicitly retracked by `save_incident`. To save authorized notes while keeping it ignored, explicitly include `"tracked": false` in `fields`; the user can Restore or Track it through **Ignored incidents**. Ignore/Restore and official mitigation are not exposed by this local notes API. `list_reports` counts exclude ignored incidents.

`read_incident` returns `relatedIncidentIds` for a main summary and `entry.summaryIncidentId` for a related incident. Related incidents cannot be implicitly retracked by `save_incident`; use `"tracked": false` when saving their individual notes. The user manages links through **Link** / **Related ICMs** in the extension. Related IDs export as numeric links directly below the main incident title in **Bug and/or ICM to external team**, and their number does not establish an occurrence or customer-impact count.

## HTTP contract

- `GET /v1/status`: connected extension, local-only scope and backup path/last file write time. The dashboard additionally knows whether the latest browser changes have been acknowledged.
- `POST /v1/call`: `{"method":"list_reports|read_incident|save_incident","params":{...}}`.
- Both require `Authorization: Bearer <local token>`. The CLI reads it without printing it.
- Requests from web origins, unsupported methods and invalid fields are rejected. No shell execution, arbitrary URL fetching, report deletion or official mitigation operation is exposed.
- The extension uses an authenticated WebSocket with a heartbeat to keep its MV3 worker available. The notes API relays requests; the extension remains the source of truth. Backup read/write messages on that authenticated connection access only the configured backup file; clients cannot choose an arbitrary filesystem path.

The note's local status field is still a snapshot. Record an official `Mitigated` state only when the operator confirms it or it has been observed. Completing a cleanup action does not itself assert that the official IcM transition or alert clearance has occurred.
