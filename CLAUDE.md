# Yume Terasu Attendance System

Three independently-deployed components, one repo. All data lives in one Google Sheet.

- `attendance-backend/` — Google Apps Script Web App (the API), bound to the Sheet. Tabs: `Employees`, `AttendanceLog`, `Schedule <YYYY-MM>` (one per month), `Salary <YYYY-MM>` (one per month, see below), and the live `Report` tab.
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

**Kiosk**: PIN entry → IN / OUT / OUT OT → Confirm. Start Break / Back from Break: pick a planned duration (15/30/45/60 min, informational only — never affects Late/OT/absent); real elapsed time is always what's recorded. A daily 60-minute break budget is shown as "minutes remaining" on Back from Break — the real, server-confirmed number when online, an on-device estimate (clearly marked) when offline, self-correcting once synced. Each complete break round gets a 3-minute discount off what counts against that budget (`BREAK_WALK_DISCOUNT_MINUTES`, Attendance.gs, mirrored client-side in KioskScreen.tsx), to not penalize the walk to/from the shared Kiosk — the Dashboard's over-budget red flag uses the same discounted total, but the Report tab's "Break (min)" column stays the real, undiscounted figure. My Schedule shows the employee's own attendance calendar.

**Backend admin menu** (`Attendance Admin`, in the Sheet's menu bar): Health Check, Fill Missed Punches, Fix Mis-tapped IN After 16:00, Add New Employee, Deactivate Employee, Add Backdated Check-in/Check-out, Bulk Mark Attendance for a Day, Allowancer (Special Allowances, see below), Create/Update Schedule + Salary Sheet (one combined menu item that builds both sheets together, see below), Highlight Shift Mismatches, Recompute Late/OT for One Month (editing or rebuilding a month's Schedule sheet after this has already been run does NOT auto-recompute — re-run it manually for that month whenever the Schedule changes afterward, same order as the Highlight→fix→Recompute flow the menu item's own code comment describes), Print Employee Report (one person) and Print Employee Report - All Employees (one ZIP containing every employee's own individually-generated PDF -- `generateAllEmployeesReportZip_`/`buildEmployeeReportPdfBlob_`/`getSortedReportEmployees_`, Report.gs, shared with `generateEmployeeReportPdf_`, Menu.gs. Two earlier designs were tried and abandoned: padding each employee's block to a fixed row count on one shared sheet drifted out of alignment with the renderer's real page breaks whenever a title/summary cell wrapped to 2 lines; giving each employee their own temp sheet and exporting the whole workbook at once was correct but too slow for the real ~50-person roster, exceeding Apps Script's execution time limit. Bundling N independently-exported single-employee PDFs via `Utilities.zip` reuses the already-fast single-employee path and sidesteps both failure modes), Issue New Setup Code, Set Kiosk Exit PIN. Both Print Employee Report PDFs include a per-employee Late/OT/Over Break/Special Allowance summary line plus itemized Allowance entries. The `Report` tab includes a `Break (min)` column (real break minutes per employee per day).

**Special Allowances**: a flexible, admin-named monthly money amount per employee (e.g. a 130-baht rice allowance, a one-off tip bonus), entered via the admin menu and stored in its own `Allowances` tab (one row per entry, so one employee can have several differently-named entries in the same month). Kept fully separate from OT pay — never read or written by `computeOtPay_` — and surfaced as its own "Special Allowance (Baht)" column on the `Summary` tab plus itemized lines on the Print Employee Report PDF. Corrections are made by editing the `Allowances` tab directly, same as `AttendanceLog`.

**Monthly Salary (Thai OT pay)**: Thai employees' OT Pay = `otQuarters × (that month's Salary / 640)` — priced from a per-month `Salary <YYYY-MM>` tab (`buildSalarySheet_`/`getSalaryForMonth_`, same Year/Month-picked create-or-append shape as `Schedule <YYYY-MM>`), never from the Employees sheet's `Salary` column, so a raise never retroactively changes a past month's OT Pay. A new month's sheet seeds each row from last month's own Salary sheet (or, the first time ever, from Employees.Salary) — admins only ever need to edit a cell when a salary actually changes. A month nobody filled in a salary for shows blank OT Pay (not 0, not a fallback). The Summary/Dashboard "All" (fiscal year) view prices each fiscal month at that month's own salary and sums the results (`computeYearlyOtPay_`, Report.gs), so a mid-year raise splits correctly.

**Dashboard**: Viewer Access password only — no separate Admin login (removed; both roles ever saw identical data). Daily, Monthly, and "OT / Special" Calendar views. A second, employee-facing page, `attendance-dashboard/daily.html` (deployed alongside `index.html`, same zero-config Vercel path — `attendance-five-ecru.vercel.app/daily.html`), shows ONLY the Daily view (date picker, no tabs, no Monthly/OT-Special) — same data (every employee, not scoped to one person), a trimmed fork of `index.html`'s Daily-view code with no other backend changes. **Two separate Script Properties passwords** (added 2026-10-21, so an employee can never see Monthly/OT-Special even by hand-editing the URL to `index.html`): `DASHBOARD_VIEWER_PASSWORD` (full access, every view — set via `setDashboardViewerPassword()`, Admin.gs) and `DASHBOARD_VIEWER_PASSWORD_DAILY` (Daily only — `setDashboardDailyViewerPassword()`); enforced server-side in `requireDashboardAccess_`'s `allowDailyOnly` opt-in (only `handleDashboardDaily_` passes it), not just hidden in the UI. Health Check flags it if an admin accidentally sets both properties to the same value (`checkDashboardPasswordCollision_`, HealthCheck.gs). Keep both HTML files' shared pieces (Daily rendering, `apiGet`/cache helpers, CSS tokens) in sync by hand if one changes — no build step ties them together. Break minutes shown per checked-in employee, turning red once over the 60-minute daily budget. The Calendar view: one column per day of a chosen month, one row per employee, `OT` for a real-OT day or `SP` for a scheduled Event/Special day (`handleDashboardCalendar_`/`getDashboardCalendarData_`, Report.gs) — filterable by Department (Japanese/Thai), client-side only, no refetch. Doesn't support "All (fiscal year)" like Monthly does. Saturday/Sunday columns tint light-blue/light-red, a company-wide Holiday day tints orange (wins over weekend tint if both apply — `holidayDays`, a strict-majority-of-active-employees check, not "any one employee"). Has its own Print button (`window.print()` + `@media print` rules, landscape, shrinks to fit a full month's columns on one page).
