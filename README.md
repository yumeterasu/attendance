# Attendance Check-In System

Mobile app (Android + iOS) where employees log in with an Employee ID + PIN,
then scan a shared QR code posted at the workplace entrance to check IN/OUT.
All data lives in a Google Sheet.

- `attendance-backend/` — Google Apps Script Web App (the API), bound to the Sheet.
- `attendance-app/` — Expo (React Native) mobile app.

This machine does not have Node.js installed, so the mobile app's dependencies
have not been installed or run yet. Everything below is what's left to do,
in order.

## 1. Create the Google Sheet

1. Create a new Google Sheet named e.g. **Attendance**.
2. Add two tabs with these exact header rows (row 1):

   **Employees**
   ```
   EmployeeID | Name | Department | PINHash | PINSalt | Active | CreatedAt
   ```

   **AttendanceLog**
   ```
   Timestamp | EmployeeID | Name | Department | Type | Method | RawScanValue
   ```

## 2. Deploy the Apps Script backend

1. Install `clasp` if you don't have it: `npm install -g @google/clasp`, then `clasp login`.
2. From the Sheet: **Extensions → Apps Script** to create the bound script, or run
   `clasp create --type sheets --parentId <SHEET_ID> --rootDir attendance-backend/src`
   from inside `attendance-backend/` (this generates the real `scriptId` — replace the
   placeholder in `attendance-backend/.clasp.json` with it if you use the Extensions route instead).
3. Push the code: from `attendance-backend/`, run `clasp push`.
4. In the Apps Script editor: **Project Settings → Script Properties**, add:
   - `APP_API_KEY` — any long random string you generate (this is shared with the app).
   - `SESSION_SECRET` — another long random string (used to sign session tokens; keep this one secret, never put it in the app).
   - `EXPECTED_QR_VALUE` — the exact text that will be encoded in the entrance QR poster, e.g. `ATTENDANCE-MAIN-ENTRANCE`.
5. In the editor, select `provisionExampleEmployee` from the function dropdown and click **Run** once (edit the values in `Admin.gs` first) to add your first test employee. Run it again with different arguments (or write your own one-off call to `provisionEmployee(...)`) for each real employee — this is the only way to add employees in v1, there's no in-app admin screen.
6. **Deploy → New deployment → Web app**. Set **Execute as: Me** and **Who has access: Anyone**. Deploy, then copy the `.../exec` URL.
7. Test the deployment before touching the app (replace `<EXEC_URL>` and `<API_KEY>`):
   ```powershell
   Invoke-RestMethod "<EXEC_URL>?action=ping"
   Invoke-RestMethod -Method Post -Uri "<EXEC_URL>" -Body (@{action="login";apiKey="<API_KEY>";employeeId="EMP001";pin="1234"} | ConvertTo-Json) -ContentType "text/plain"
   ```
   Confirm `login` returns a `sessionToken`, then use that token to test `checkin` and `history` the same way.

## 3. Set up the mobile app

Node.js is required and not currently installed on this machine.

1. Install Node.js (LTS) from nodejs.org, then verify with `node -v` and `npm -v`.
2. From `attendance-app/`, run `npm install`.
3. Run `npx expo install --fix` — this corrects any package versions in `package.json` to match the installed Expo SDK exactly (versions were hand-written here without being able to run Expo's own resolver).
4. Copy `.env.example` to `.env` and fill in:
   - `EXPO_PUBLIC_API_URL` — the `/exec` URL from step 2.6 above.
   - `EXPO_PUBLIC_API_KEY` — the same `APP_API_KEY` value you set in Script Properties.
5. Run `npx expo start`, then scan the printed QR with **Expo Go** on a real Android or iPhone.
6. Log in with the test employee's ID/PIN, grant camera access, and scan any QR code containing exactly your `EXPECTED_QR_VALUE` text to confirm a row appears in `AttendanceLog`.

**Note:** the iOS Simulator has no camera, so camera-based scanning must be tested on a real device via Expo Go (Android Emulator can work with an emulated camera pointed at a rendered QR image, but a real device is simpler).

## 4. Generate and print the entrance QR poster

Use any QR generator to encode the exact `EXPECTED_QR_VALUE` string, e.g.:
```
https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=ATTENDANCE-MAIN-ENTRANCE
```
Print and post it at the entrance.

## End-to-end test checklist

- [ ] Log in with a seeded employee's ID/PIN
- [ ] Scan the poster QR → first scan records `IN`
- [ ] Scan again → records `OUT`
- [ ] Scan twice within 60 seconds → second scan is rejected as a duplicate
- [ ] Scan a QR with the wrong text → rejected as invalid
- [ ] Turn on airplane mode and scan → clear offline error, no crash
- [ ] Force-quit and reopen the app → still logged in (session persisted)
- [ ] Open History → shows recent IN/OUT entries in order
