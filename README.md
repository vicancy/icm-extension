# MeOncall

MeOncall is an English-language Edge extension for local incident investigation and OneNote handoffs. Track incidents, link repeated cases, ignore noise, keep Notes/Root cause/Resolution, and export a summary. Local annotations never update official ICM fields; **Quick Mitigate** is a separate, explicit official action.

The optional **`$meoncall`** Codex skill locates the installed extension and local API from other workspaces; see [Install the Codex skill](#install-the-codex-skill).

## Install and use

1. In `edge://extensions/`, enable **Developer mode**, choose **Load unpacked**, and select this folder. No build is required.
2. After code changes, **Reload** the extension and refresh open ICM/dashboard tabs; existing tabs retain old scripts.
3. Open [My Teams' Incidents](https://portal.microsofticm.com/imp/v5/incidents/queries/my-teams). Use **Track**, **Notes**, **Link**, **Ignore**, or **Mitigate** beside an incident. The extension icon opens the dashboard.
4. Select/create the current report, fill summaries, then **Copy for OneNote**. **Needs summary** finds missing Root cause or Resolution. **More** contains report settings, the **Include headers** option, HTML/CSV exports and backup actions.

### Install the Codex skill

1. Install the extension above, then follow [local API setup](bridge/README.md#install-once). Run those commands from your checkout's root and verify `node bridge/cli.cjs status` reports `connected: true` with Edge running.
2. Copy [skills/meoncall/SKILL.md](skills/meoncall/SKILL.md) into `$CODEX_HOME/skills/meoncall`, or `~/.codex/skills/meoncall` when `CODEX_HOME` is unset. Run from the checkout's root:

   ```powershell
   $meoncallCodexHome = $env:CODEX_HOME
   if (-not $meoncallCodexHome) { $meoncallCodexHome = Join-Path $env:USERPROFILE '.codex' }
   $meoncallSkillDir = Join-Path $meoncallCodexHome 'skills/meoncall'
   if (Test-Path -LiteralPath $meoncallSkillDir) { throw 'MeOncall skill already exists; compare and update the installed copy, preserving personal changes.' }
   New-Item -ItemType Directory -Path $meoncallSkillDir -Force | Out-Null
   Copy-Item -LiteralPath './skills/meoncall/SKILL.md' -Destination $meoncallSkillDir
   ```

3. Start a new Codex chat and try: "Use $meoncall to list my reports."

The bridge installer saves the checkout location in `~/.icm-oncall-workspace/bridge.json` for the skill to discover. If you move the checkout, rerun the installer there and follow the [bridge restart/reload instructions](bridge/README.md#install-once). After pulling skill updates, merge them into your installed copy, preserving local customizations.

## Code map

Plain JavaScript, HTML and CSS; Manifest V3, no framework or bundler.

| Files | Responsibility |
| --- | --- |
| `model.js` | Schema, validation, field conflicts, report/link queries, grouping, exports and backup validation. |
| `background.js` | Service worker; serializes `oncall:*` requests, commits storage, schedules backups. |
| `client.js`, `ui.js` | Messaging client; shared editors, Link/Related pickers, clipboard and downloads. |
| `content.js`, `content.css` | ICM DOM integration: metadata, row actions, filtering, native selection and toolbar. |
| `dashboard.*`, `ignored.*` | Report management, summary editing/export, Ignore/Restore. |
| `mitigate.js` | Native ICM mitigation workflow and sequential batch execution. |
| `monitor.js`, `monitor-panel.*` | Selection context menu and SignalR Monitor side panel. |
| `agent-api.js`, `bridge-client.js`, `bridge/` | Local notes API, authenticated loopback transport, backup and startup. |
| `icons/` | Editable SVG source and PNG icons for the extension and page tabs. |
| `test/runtime.js`, `*.test.js` | Real worker/UI scripts with mocked Chrome storage and JSDOM. |

## Data and behavior

The source of truth is `chrome.storage.local['icm-oncall-workspace-v1']`: `workspaceId`, `activeReportId`, `reports[]`, global `ignoredIncidents`, and `listPreferences`. Each report owns `entries` keyed by incident ID. The active report is shared across tabs; report dates are labels, not membership rules. There is no device sync.

| State | Default query visibility | Handoff |
| --- | --- | --- |
| Untracked | Shown | Excluded; saved annotations retained |
| Tracked | Hidden | Included in the selected report |
| Linked to a tracked main incident | Hidden | ID link under the main incident |
| Ignored | Hidden across reports | Excluded across reports until restored |

- **Ignore** persists per ID until **Restore** or **Track** in **Ignored incidents**. It untracks the current report's entry while preserving annotations and other reports' membership. **Untrack** affects only the selected report.
- **Link / Link to… / Related ICMs** sets the child's `summaryIncidentId` and `tracked: false`. The target must be tracked, non-ignored and not itself linked. Linking a summary also moves all its current related ICMs directly to the target in the same save. Ignored children stay ignored unless explicitly selected. Untracking/ignoring the target reveals its children; the relations remain.
- A new Link appends saved source Notes to the target's latest Notes with a newline. Bulk links preserve input order and skip empty Notes/duplicate IDs. Sources retain their annotations; Root cause/Resolution stay separate. Repeating the same association does not append again. Later edits do not sync, unlink does not remove appended text, and old links are not retroactively merged. Link and append commit together; the 20,000-character Notes limit rejects the whole operation.
- When merging a summary, append that summary's saved Notes once, without separately appending its children's Notes again, even if both summary and child are selected. Individual child annotations remain saved; later child edits and Notes from old links are not retroactively copied into the merged summary.
- All mutations go through the worker queue. Editors send changed fields with field-level `base` values: conflicting edits fail while the draft stays open. Saves retain their original `reportId`; storage-change listeners refresh other views. Keep this protection when adding write paths.
- Click a dashboard column heading to sort; empty values stay last. **Reset sort** restores newest-tracked-first order. Search matches all keywords across saved fields and related ICMs, highlights matches and shows relevant excerpts. Press `/` to search or Escape to clear. Search, **Needs summary** and sorting affect only the current view; export order and columns stay unchanged.

## ICM integration constraints

- Use native **Quick view** for details. No hover preview or automatic incident/date-card loading. Observe displayed title, severity, status and creation date only; never infer or overwrite investigation notes from page metadata.
- Support Fluent query rows, legacy Search rows, recycled DOM nodes and SPA navigation. Filtering must collapse the Fluent cell wrapper as well as the row to avoid blank gaps.
- Keep Fluent row actions and titles on one line when selection replaces the native cell classes; derive layout from the injected actions, not a class added to the native cell.
- **Show tracked / linked**, **Show ignored**, and **Hide mitigated** persist across tabs. The last hides only Mitigated, not Resolved. Filters/counts cover loaded rows; native totals and pagination remain unchanged.
- Native checkboxes drive bulk **Link / Ignore / Mitigate** (up to 200 visible loaded IDs). Select-all/Ctrl+A and range selection must exclude filtered rows using native checkbox events, not ARIA-only changes. If deselection fails, keep the row visible and block native bulk actions. Successful Link/Ignore clears the batch selection; failed saves retain it.
- Keep the query toolbar above native controls from its first appearance; wait for its anchor. Selection must not change its height or wrap buttons: narrow windows scroll horizontally.
- Keep incident actions in the page flow above the native action bar, below native panels/dialogs. Merge the report name, **MeOncall dashboard** and **Ignored** navigation into the same bar on detail pages. Wait for the action bar during loading/remounts; never float them over form footers. Narrow windows scroll the buttons horizontally.

**Quick Mitigate:** only an explicit user action starts the native workflow. Defaults are `Auto recovered`, How fixed = `Transient`, caused by change = `No`, and existing regions or `Global` when empty. It can affect correlated incidents. Submit once, never auto-retry, and report success only after observing Mitigated/Resolved. Batch execution skips closed incidents and stops on failure, cancellation, navigation/report change or an unconfirmed result. Never submit production incidents just to test it; the agent notes API cannot mitigate.

**SignalR Monitor:** select a resource name/ID, right-click **Search in SignalR Monitor**, and open the [Monitor](https://srprodmonitor.azurewebsites.net/) search in a side panel. **Open in new tab** handles sign-in/frame restrictions. Queries remain browser-session data, outside reports/backups.

## Export contract

OneNote/HTML/plain text/CSV columns must remain in this exact order:

```text
Day | RP/Runtime | Reported by customer | Severity | Status | # of customers impacted | # of occurrence | Root cause | Bug and/or ICM to external team | Error msg | Notes
```

- **Day** is ICM creation date, `YYYY-MM-DD` in the page's displayed timezone: list `data-automation-key="CreatedDate"`, or the native Duration card's **Incident created** value. Unknown dates stay blank; event/source/impact/tracking dates are different.
- **Bug** contains the main title linked to ICM, then linked incident numbers on separate lines (`[number](URL)` in text/CSV). Root cause is a concise conclusion; Notes holds analysis/evidence, legacy `relatedLinks`, and saved Resolution with a `Resolution:` label. Error msg holds actual log errors. Unknown fields stay blank; do not infer customer/occurrence counts.
- **Summary group** combines tracked rows for export by case-insensitive name, deduplicating equal values and labelling differing ones by ID. It does not create links or sum counts.
- Exports use all non-ignored tracked entries in the selected report, independent of dashboard filters. **After ICM** limits **Copy for OneNote** to entries tracked after that main incident, in newest-tracked-first order. Uncheck **More → Include headers** to omit headers/title/dates. Editing an older entry does not make it newly tracked. HTML/CSV downloads remain full-report exports.

## Agent API and backup

Requires Node.js (24 LTS+ recommended). See [bridge/README.md](bridge/README.md) for installation, request examples, restart/startup and recovery.

```powershell
node bridge/cli.cjs status
node bridge/cli.cjs call list_reports
```

For case updates, request examples and conflict handling, follow the [agent workflow](bridge/README.md#agent-workflow).

The bridge at `127.0.0.1:4176` writes one latest backup to `%USERPROFILE%\.icm-oncall-workspace\backup\oncall-workspace-backup.json`. The dashboard's **More** menu shows backup status, **Copy backup path** (with the full path in its tooltip) and available backup actions. A dot on **More** flags backup problems. Writes replace the file atomically; offline changes back up on reconnect. There is no history or cloud sync, and unsaved drafts are excluded. Workspace identity prevents a fresh profile from overwriting the old backup. **Restore saved backup / Import backup** adds report copies while preserving existing records and known Ignore/Restore decisions. Summary exports are not restorable backups.

## Development and verification

Read [AGENTS.md](AGENTS.md) before changing the extension.

```powershell
npm ci
npm test
npm run preview
```

`npm run preview` serves synthetic, in-memory data at `http://127.0.0.1:4175`: `/dashboard.html`, `/fixture-list.html`, `/report.html`. Restart resets it.

Run relevant tests for changes: `related`/`bulk` for linking and batch actions; `selection`/`triage`/`content` for ICM integration; `model`/`copy` for exports; `agent-api`/`bridge`/`backup` for persistence; `mitigate`/`monitor` for those adapters (`*.test.js`). Tests cover storage failures, conflicts and report isolation. Live DOM layout and OneNote paste still require installed Edge checks after Reload; synthetic tests do not establish production mitigation success.

[Apache License 2.0](LICENSE)
