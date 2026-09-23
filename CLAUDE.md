# Yume Terasu Attendance System

Three independently-deployed components, one repo. All data lives in one Google Sheet.

- `attendance-backend/` — Google Apps Script Web App (the API), bound to the Sheet. Tabs: `Employees`, `AttendanceLog`, `Schedule <YYYY-MM>` (one per month), and the live `Report` tab.
- `attendance-app/` — Expo (React Native) Android Kiosk app. One shared tablet per branch: **Xiaomi Redmi Pad SE 8.7 (4G), portrait, 800×1340** — match this aspect ratio in any UI mockup or layout change.
- `attendance-dashboard/` — `attendance-dashboard/index.html`, a single static file (no build step, no React), deployed to Vercel (`attendance-five-ecru.vercel.app`). Read-only, gated by a shared viewer password (Script Properties → `DASHBOARD_VIEWER_PASSWORD`).

`README.md` at the repo root is stale (describes an old QR-code-scan design) — don't rely on it.

## Standing rules

- **Zero data loss on check-ins.** IN/OUT/Break records must always end up in the system 100% — sync can be delayed (offline queue), never lost. Any change touching the offline queue, the duplicate-tap guard, or the break-minutes estimate must preserve this.
- **Code review before every APK build**, not just when asked.
- Match the Kiosk device spec (above) in any UI work.
- Comment style: this codebase (both `.gs` and `.ts`/`.tsx`) uses long, explanatory inline comments explaining *why* — an edge case handled, a prior bug fixed, a tradeoff made — never *what* the code does. Match that style in new code, not a terser default.

## Deploy pipeline

**Backend** (from `attendance-backend/`):
```
clasp push --force
clasp deploy -i AKfycbyfAUriIwgQlRjUv6cC1UKSazFW-KOrFd8a251bodchsBIa4On5ZZhji72Cjwsb-rYq -d "<description>"
```
Both steps are required — `push` alone does not update the live Web App.

**App** (Kiosk APK):
1. Bump `version` in `attendance-app/app.config.ts`, commit, push.
2. `gh workflow run "Build Android APK" --ref master`, wait for it to complete.
3. Download the artifact, rename to `attendance-v<version>.apk`.
4. Verify: `aapt dump badging <apk>` (check `versionName`) and `aapt dump xmltree <apk> AndroidManifest.xml` (check `screenOrientation`/`resizeableActivity` are portrait-locked).
5. `gh release create v<version> <apk> --title "v<version>" --notes "..."`.
6. Update the QR install-page Artifact (https://claude.ai/artifact/7zkvhvPz4dV7HvxYngqy12) to point at the new release URL, verify the QR actually decodes to it before publishing.

**Dashboard**: plain `git push` to `master` — Vercel auto-deploys `attendance-dashboard/index.html`. Nothing else to trigger.

## Current feature set

**Kiosk**: PIN entry → IN / OUT / OUT OT → Confirm. Start Break / Back from Break: pick a planned duration (15/30/45/60 min, informational only — never affects Late/OT/absent); real elapsed time is always what's recorded. A daily 60-minute break budget is shown as "minutes remaining" on Back from Break — the real, server-confirmed number when online, an on-device estimate (clearly marked) when offline, self-correcting once synced. My Schedule shows the employee's own attendance calendar.

**Backend admin menu** (`Attendance Admin`, in the Sheet's menu bar): Health Check, Fill Missed Punches, Who Hasn't Checked In Today, Fix Mis-tapped IN After 16:00, Add New Employee, Deactivate Employee, Add Backdated Check-in/Check-out, Bulk Mark Attendance for a Day, Create/Update Schedule Sheet, Highlight Shift Mismatches, Recompute Late/OT for One Month, Print Employee Report, Issue New Setup Code, Set Kiosk Exit PIN. The `Report` tab includes a `Break (min)` column (real break minutes per employee per day).

**Dashboard**: Viewer Access password only — no separate Admin login (removed; both roles ever saw identical data). Daily and Monthly views. Break minutes shown per checked-in employee, turning red once over the 60-minute daily budget.
