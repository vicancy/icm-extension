# ICM On-call Workspace

An English-language Microsoft Edge extension for tracking ICM incidents, keeping local investigation notes and preparing OneNote handoff tables.

Version **2.7.0** includes incident creation dates, related incident links and daily incremental copying. Use **Copy after ICM** with **Copy without headers** to append newly tracked incidents to an existing handoff table. Reports, Ignore decisions, notes and automatic backups stay local.

## Install or update

1. Open `edge://extensions/` and enable **Developer mode**.
2. Select **Load unpacked** and choose this folder (the one containing `manifest.json`).
3. If already installed, click **Reload** on the extension card instead.
4. Refresh every open ICM tab. Existing pages retain the old extension scripts until refreshed.
5. Open [My Teams' Incidents](https://portal.microsofticm.com/imp/v5/incidents/queries/my-teams). Each incident title has **Track**, **Notes**, **Link**, **Ignore** and **Mitigate** controls. The extension toolbar icon and the page's **On-call dashboard** button open the workspace.

No build is required to load the extension. Node.js is needed for the optional local agent API and automatic file backup, as well as tests and the local preview. Node.js 24 LTS or later is recommended.

## During your on-call rotation

- Create a report with a name and optional date range in the dashboard. The selected report is shared across tabs in this Edge profile. Dates label the report; they do not automatically include or exclude incidents.
- Click **Track** beside an incident in the ICM list or on its detail page. Only tracked incidents appear in the report and its exports. You can also paste an incident ID or ICM URL into the dashboard.
- Click **Notes** to record a concise **Root cause**, **Resolution**, and analysis/evidence in **Notes**. Additional fields capture RP/Runtime, customer reporting, severity, status, customers impacted, occurrences and log exceptions/error messages. Leave unknown values blank.
- **Day** is the incident's creation date (`YYYY-MM-DD`), automatically captured from ICM's **Created Time** list column or **Incident created** in the native Duration card when displayed. It keeps the calendar date shown by ICM, without converting to the machine's timezone. It is read-only in the editor. Existing tracked entries are filled or corrected when that metadata is observed; missing dates stay blank. Source creation, alert/event, mitigation and tracking dates are not used.
- Notes can be saved before tracking. **Untrack** removes an incident from that report's export while keeping its notes; tracking it again restores it. Each report has its own records, including for the same incident ID.
- Save the editor to persist changes. A failed save or same-field editing conflict leaves your draft open. Changes to different fields from different tabs are merged. An editor opened in one report continues saving to that report even if another tab changes the active report.

Track and Notes never write their fields back to ICM. All editor fields belong to the local report. Quick Mitigate is a separate official lifecycle action, described below.

## Track, Ignore and the query list

Version **2.3.0** separates incidents you are summarizing from noise you do not want in the report:

| State | Query list by default | Report and export |
| --- | --- | --- |
| Untracked | Shown | Excluded |
| Tracked in the selected report | Hidden | Included |
| Linked to a tracked incident | Hidden | Numeric link below the main title in the Bug column |
| Ignored | Hidden across reports | Excluded across reports |

**Untrack** removes an incident from the selected report and returns it to the query list. **Ignore** records a persistent decision for that incident ID across rotations, hides it and removes it from the selected report. Notes and other annotations are kept. Ignore does not set ICM's official Noise flag, mitigate the incident or change the server query.

Open **Ignored (count)** from the ICM page toolbar or the dashboard for the separate **Ignored incidents** list. Search by ID or title, then:

- **Restore** cancels Ignore and returns the incident to query lists without tracking it in the currently selected report.
- **Track** cancels Ignore and includes the incident in the currently selected report.

Existing membership and notes in other saved reports are retained. Ignore excludes the incident from their summaries while it is active; restoring it makes those historical memberships available again. The ignored list itself is never part of a handoff export. A newly created Buildout incident has its own ID and is not automatically ignored based on its title.

The page toolbar has **Show tracked / linked** and **Show ignored** overrides. These visibility preferences are shared across tabs and retained across reloads. Native selected rows stay visible so ICM bulk actions cannot silently target hidden selected incidents. Hidden Fluent rows also collapse their containing list cells, removing the blank space reserved by the cells' minimum height. The hidden count covers currently loaded rows only; ICM totals, pagination and virtual scrolling remain native. No incident pages are loaded to filter the list.

The **Current report** selection is the report you chose in the dashboard, shared across the browser profile. It is not inferred from on-call schedules or the report date range. Ignore is independent of that selection and persists until restored.

## Related incidents under one summary

Version **2.6.0** lets one tracked incident represent several instances of the same issue:

1. **Track** the main incident and write its summary.
2. On another incident in the ICM list or detail view, click **Link** and select the tracked incident by ID, title or root cause.
3. Use **Related ICMs (count)** on the dashboard, or **Related (count)** beside the main incident, to paste several IDs/ICM URLs at once or **Unlink** individual incidents. Commas, semicolons, spaces and newlines are accepted; duplicates are ignored.

Related incidents are untracked and hidden from query lists by default, alongside tracked incidents. **Show tracked / linked** reveals them; native selected rows remain visible. The relation belongs only to the selected report. Untracking or ignoring the main incident brings its related incidents back to the query list; the relations and private notes are retained. Unlink a related incident before tracking it separately. Linking an ignored incident restores it, with a stale-state check to protect changes made in other tabs.

The dashboard still has one row for the main incident and shows its related IDs as links. Searching for a related ID or saved title finds that main row. Exports place each related incident directly below its main incident's linked title in **Bug and/or ICM to external team**, using only a clickable incident number. Plain text and CSV use `[number](URL)` for these related links. Existing annotations on the other incidents are retained separately, not merged into or used to overwrite the main summary. Customer impact and occurrence counts are not inferred from the number of related IDs. Ignored incidents remain excluded from exports. Relations are included in both manual and automatic backups.

## Incident details

Use ICM's native **Quick view** toggle above the incident list to show details in the right-hand pane. The extension does not add a hover preview or automatically load incident pages when a link is hovered or focused. Use **Track** and **Notes** beside the incident to capture your local report context.

Controls support Fluent UI query rows, legacy Search rows and incident detail pages. The extension does not alter native list headers. ICM layout changes may require selector updates.

## Search a resource in SignalR Monitor

Version **2.5.0** adds **Search in SignalR Monitor** to the browser's selection context menu. Select a resource name or resource ID on a page, right-click, then choose the menu item. The extension opens an Edge side panel containing `https://srprodmonitor.azurewebsites.net/?q=...`; Monitor runs its own search. Each browser window has its own current selection. The panel can also search an edited name.

**Open in new tab** opens the same search if sign-in or the site's frame policy prevents embedding. After signing in, click **Search** again in the panel. If the browser does not support opening a side panel, the menu opens the search in a regular tab. The extension does not bypass frame policies, collect Monitor credentials or automatically search when you merely select/hover text. Selected queries are kept only in the browser session, outside reports and backups. No ICM data is changed.

## Summarize and export

1. Open the dashboard and choose the report for the rotation.
2. Use **Needs summary** to find incidents missing a root cause or resolution, then **Edit notes**.
3. Optionally enter the same **Summary group** on related incidents to put them in one exported row. Group names are case-insensitive. Identical values are deduplicated; differing values are labelled with their incident IDs. Customer and occurrence counts are not added together automatically.
4. Click **Copy table for OneNote** and paste into OneNote with source formatting. The clipboard includes an HTML table, incident links and a plain-text fallback.
5. If rich clipboard copy is unavailable, **Download HTML**, open the file in a browser and copy its table into OneNote. **CSV** is also available.

For daily additions, enter the last copied ICM in **Copy after ICM** and click **Copy without headers**. This copies only incidents added to this report after that ICM, excluding the starting incident. It follows the dashboard's newest-tracked-first order, not numeric ID order or creation Day. The starting ICM must be a tracked main incident in the selected report. Leave it blank to copy all tracked incidents. The copy result shows the newest included ICM to use as the starting point for the next batch; switching reports clears the input.

**Copy without headers** includes only table data rows: no column headers, report title or report dates, in both HTML and plain text. Both Copy buttons use the starting ICM, independently of dashboard search/filter settings. Incidents are selected before summary groups are combined; linked incident numbers remain with each included main incident. Editing an older row or adding links to it does not make it newly tracked.

Copy table for OneNote, HTML, plain text and CSV use these columns in order: **Day**, **RP/Runtime**, **Reported by customer**, **Severity**, **Status**, **# of customers impacted**, **# of occurrence**, **Root cause**, **Bug and/or ICM to external team**, **Error msg**, **Notes**. Resolution remains editable and is included in the exported Notes cell with a `Resolution:` label. Every grouped row retains its incident links and titles.

**Bug and/or ICM to external team** contains the main incident title linked to its ICM URL, followed by its linked incident numbers on separate lines. **Root cause** holds the summarized cause; **Notes** holds analysis, supporting evidence and links; **Error msg** holds actual exceptions or error messages from the logs. Older **Evidence links** (`relatedLinks`) values are included in Notes, with clickable links in HTML/OneNote. Whole-field placeholders such as `Unknown` or `Not established` are blank in exports and normalized to empty on save; meaningful analysis containing those words is preserved.

HTML/CSV downloads and Copy with an empty starting ICM contain **all non-ignored tracked incidents in the selected report**, regardless of the dashboard's search or incomplete-work filter. The export column order is unchanged. The extension does not connect to or automatically publish to OneNote.

## Save notes directly from an agent

Version **2.1.0** adds an authenticated local API. An agent can read the selected report and save an incident directly; the dashboard refreshes automatically. No JSON import is required. Run the one-time setup in [bridge/README.md](bridge/README.md), reload the extension, then use `node bridge/cli.cjs call list_reports` and `save_incident`. The **Agent** indicator shows whether the local connection is available.

The API updates the same incident in the chosen report, preserves omitted fields and checks for conflicting manual edits. It saves only local annotations and does not mitigate the official incident.

## Storage and metadata

Records use `chrome.storage.local` under `icm-oncall-workspace-v1`. They stay in the current browser profile and are **not synced across devices**. Local storage provides more room for notes than browser sync, but it is finite (normally 10 MB for this extension). Failed writes show an error and preserve the open draft.

Version **2.4.0** adds **automatic backup outside Edge** through the local bridge. Run `node bridge/install.cjs`, start the bridge with `node bridge/cli.cjs status`, then reload the extension once. When upgrading an already running bridge, stop its old Node process before starting it again. The Windows installer adds a hidden launcher to the current user's Startup folder so the service starts at sign-in. Keep the extension folder and Node.js installed.

After a successful save, the service automatically updates **one latest file** at `%USERPROFILE%\.icm-oncall-workspace\backup\oncall-workspace-backup.json`. It includes every report, untracked notes, Ignore/Restore decisions and list preferences. There are no historical versions. A complete temporary file is flushed before replacing the previous file; failed writes keep the previous backup. Unsaved editor drafts are not included. The dashboard's **Backup file** field shows the full path with a **Copy path** button, alongside the last successful backup and pending/offline/error states. **Back up now** retries immediately. A browser save remains successful if the backup service is offline; the latest saved workspace is backed up after reconnecting, without needing the dashboard tab open.

The file is separate from the Edge profile and survives uninstalling the extension. A fresh install or different browser profile cannot overwrite another workspace's backup. In that case the dashboard shows **Restore saved backup**, which adds the saved reports as separate copies, preserves current notes and known Ignore/Restore decisions, then resumes automatic backup. This is a local disk backup, not cloud sync: it does not protect against losing the computer/disk, and it does not undo an unwanted edit that has already replaced the latest backup.

**Export backup** is still available for an additional manual JSON copy. **Import backup** adds separate report copies and does not overwrite existing reports or Ignore/Restore decisions for known incidents. HTML/CSV/OneNote exports are summary tables, not complete restorable backups. Confirm that automatic backup is **up to date** (or export manually) before uninstalling the extension or removing its profile. Existing legacy Tag storage is left untouched; v2 does not display, edit, export or migrate it into reports.

The extension captures title, severity, status and creation date from visible ICM list rows, plus title/status and the creation date when present on detail pages. These are snapshots, not a live feed. Visiting those pages can refresh the metadata for tracked incidents in the active report. Root cause, resolution and notes are never inferred from or overwritten by those observations. Manually entered incidents start without metadata until you visit them or fill in the editor; creation dates require an observed ICM creation date.

The extension uses `storage`, `alarms` and loopback host access for the optional local agent bridge, plus `contextMenus` and `sidePanel` for the explicit Monitor search action. It does not request access to read every webpage. It does not call an ICM mutation API directly. Quick Mitigate loads the official ICM workflow only when explicitly clicked; annotation data is not uploaded to a remote service by this extension.

## Quick Mitigate

Version **2.2.0** adds a **Mitigate** button beside Track and Notes in the ICM list and on detail pages. It is intended for incidents that have recovered on their own. One click runs the native ICM workflow with these user-selected defaults:

- **Mitigation steps:** `Auto recovered`
- **How fixed:** `Transient` (ICM's available option for this workflow)
- **Was this incident caused by a change?:** `No`
- **Impacted region(s):** keep the incident's existing regions. If none are recorded, select **Global** (the approved default as of v2.2.1).

This button **changes the official ICM lifecycle state**. ICM can also apply mitigation to correlated incidents, as described in its native form and the button tooltip. Private root cause, resolution and notes are never copied into that form. Optional official root cause fields, agent feedback, customer impact/noise flags and auto-resolve are not filled or changed by the shortcut. The default mitigation time comes from ICM.

The shortcut opens the native form, fills the approved defaults, skips optional pages and submits once. If required information is missing, permissions prevent the action, or ICM's layout changes, automation stops and leaves the form available for manual completion. **Stop** cancels remaining automatic steps; it cannot undo a request already submitted. There are no automatic retries.

Success is shown only after the incident's official lifecycle displays **Mitigated** or **Resolved**. An unconfirmed request is reported as unconfirmed; check ICM before trying again. Already mitigated/resolved incidents are disabled. The original list's status can remain stale until you run or refresh its query. Only an actual user click starts the shortcut; the local notes/agent API does not expose mitigation.

This feature requires no new extension permissions and uses the visible official page rather than an undocumented mutation API. Its DOM adapter is covered by synthetic tests. The native form and its required fields were inspected in Edge, but no production incident was submitted as a test.

## Development and verification

```powershell
npm ci
npm test
npm run preview
```

Tests run the real service worker against simulated extension storage and the content/dashboard scripts in JSDOM. Coverage includes tracking, Ignore/Restore across reports, filtering and selected rows, recycled rows, creation dates and cross-tab metadata updates, editing conflicts, failed writes, report isolation, related incidents, grouping/export escaping, headerless and incremental copies, backups, editor draft protection, the local agent API and Quick Mitigate.

The local development preview serves only synthetic data at `http://127.0.0.1:4175/dashboard.html`. Open `/fixture-list.html` for a Fluent-like list and `/report.html` for the export table. It exercises the real UI scripts and service worker through a local mock Chrome bridge. It does not load real ICM pages. Data is kept in server memory and reset on restart; stop with Ctrl+C.

Local tests do not establish whether the current ICM site allows the Quick Mitigate workflow to load in its action frame or whether a particular OneNote client preserves clipboard formatting. After reloading the extension, verify the live ICM list, detail-page controls and OneNote paste in your installed Edge profile.

## License

[Apache License 2.0](LICENSE)
