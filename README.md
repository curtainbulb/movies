# Nightreel

A static movie archive for an HTTPS website. Users sign in with an email address and password, and Supabase stores their archive. The site does not require an application server. `movies.md` is the supplied sample list.

## Publish online without installing development tools

The ZIP includes the browser files and the Supabase SDK. This route uses GitHub and Supabase dashboards; Node.js, a local web server, and a command line are not needed to publish it.

1. Extract the ZIP and upload the **contents of `movies-main`** to the root of the desired GitHub repository. If the site is already live, use a separate branch until the database and email settings are ready. Keep the folder structure, including `vendor/` and `supabase/migrations/`. Do not upload `node_modules`, `.env`, passwords, API secrets, or personal backup files. The required site files are `index.html`, `app-sync.js`, `sync-core.js`, `supabase-config.js`, `vendor/supabase.js`, and `movies.md`.
2. In the repository's **Settings → Pages**, choose **Deploy from a branch**, select the branch containing the files, choose `/(root)`, and save. Wait for GitHub to show the HTTPS site URL. See [GitHub Pages publishing-source instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).
3. In the Supabase project intended for this site, make sure the Data API exposes the `public` schema. In **SQL Editor**, open and run the complete contents of `supabase/migrations/20261119000100_archive.sql` from the repository. Run it once against the intended project; it creates `nightreel_archives` and does not delete existing tables. If the project already has that table, inspect it before proceeding. This dashboard method does not record a CLI migration-history entry; do not later run `supabase db push` against the same project without reconciling migration history first.
4. Copy the project's **Project URL** and **publishable key** (or legacy **anon key**) from its Supabase dashboard. Edit `supabase-config.js` in GitHub, replacing the two placeholders below with those public values, and commit the file:

   ```javascript
   window.NIGHTREEL_CONFIG = {
     supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',
     supabasePublishableKey: 'YOUR_PUBLISHABLE_OR_ANON_KEY'
   };
   ```

   The configuration is public by design. Never put a secret key, service-role key, database password, SMTP password, or personal account credentials in the repository or browser code.
5. In Supabase **Authentication → Sign In / Providers**, enable email/password and email confirmation. In **URL Configuration**, set Site URL to the actual HTTPS Pages URL and add that exact URL to Redirect URLs. If users may open both the trailing-slash URL and the `index.html` URL, allow both exact forms. The app returns to the current origin and pathname after confirmation or password recovery.
6. Set up **custom SMTP** in Supabase **Authentication → SMTP Settings**. Use an SMTP provider of your choice, verify its sending domain, and enter its server host, port, username, password, sender address, and sender name **in Supabase**, not in GitHub. Without custom SMTP, the default sender restricts confirmation and recovery emails to project-team addresses and has a very low rate limit. See [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp). A reachable email address from any provider can then be used for signup; the user must be able to receive the verification email.
7. Open the HTTPS site, choose **Settings & sync → Open cloud sync**, and create an account. Confirm the email, sign in, and verify that the sync status reaches **Synced**. No social sign-in, Storage bucket, or Realtime configuration is required.

The migration and static files are provided for deployment; adding them to GitHub and running the migration are separate actions. The included public configuration is blank until you supply your own project values.

## What online-only means

Opening the site, creating an account, confirming an email, signing in, and syncing between devices require Internet access. The site is not an installable offline app and has no service worker. The browser still stores a separate local cache for each account and a guest archive; this protects unsynced edits during temporary failures and makes switching accounts safe. A JSON backup downloads as a file to the device by design. The authoritative cross-device copy is the authenticated Supabase archive.

## Complete progress backup and restore

Use **Export & backup → Complete backup** to download a JSON file. It contains every collection and film, notes and note history, watched status and viewing history, ratings, favorites, queues and their order, custom posters including embedded uploads, saved searches, paths, profiles, feedback, display and recommendation preferences, saved view settings, source settings, and non-secret AI model settings. It does not contain account passwords, sessions, provider API keys, bridge credentials, disposable artwork caches, undo history, or browser recovery checkpoints. Treat the JSON as private: it contains your notes and any source URLs. URLs from removed services remain in the backup, but the app no longer fetches them; use another host or upload the poster if needed.

To restore, sign into the intended account, open **Export & backup → Choose a JSON backup**, and confirm. A restore **replaces** that account's archive and then syncs the replacement. The app first saves a recovery checkpoint in that browser; export the current JSON first if you want a separate copy on another device. An invalid file leaves the archive unchanged. The cloud archive has a 32 MiB document limit, including embedded posters; an oversized backup cannot sync and must be reduced first.

Markdown and CSV exports are **not complete backups**. They export the current collection only. CSV carries titles, years, genres, watched and favorite flags, ratings, notes, and HTTPS poster URLs. CSV import adds new films and fills missing progress on matching films while keeping existing notes and ratings. Use JSON to preserve the whole archive and relationships.

## Existing data

A guest archive in this browser stays separate on sign-in. Use **Import this browser’s guest archive** to add it to the signed-in account. Matching IDs and matching title/year within a collection are merged, with existing account values taking precedence. Distinct collections remain separate.

If you already have a JSON backup from a previous version, restore it while signed out, then sign in and choose **Import this browser’s guest archive**. Verify the result on another device before deleting any old data. A legacy database that stores only short film IDs, watched flags, and notes cannot be safely mapped to titles without the original ID-to-title mapping; it is not automatically imported. Keep that database unchanged and obtain the earlier application's mapping or a backup containing both titles and progress before migrating it.

Sessions and user IDs from an earlier authentication provider do not automatically transfer to Supabase. Users may need to create a new email/password account and verify their address. For a bulk account migration, an administrator must verify each old-to-new identity mapping and use a trusted migration process; no privileged credentials belong in this app.

## Sync and security

The browser keeps separate caches by project and user. A signed-in archive is stored as one JSON document per user. Database row-level security permits users to read only their own row; direct table writes and ownership changes are denied. A server function derives the owner from the authenticated session and accepts a write only when its expected revision matches.

The app checks the cloud every 20 seconds while visible and when the page regains focus or connectivity. Temporary failures leave pending changes in the account's local cache and show a status. Changes to different fields merge; deletion of an existing record wins over a concurrent stale edit. For conflicting edits to the same field or non-ID array, the later successful commit wins. This is not collaborative text editing. Full-document sync uses more bandwidth for large archives.

On browsers supporting Web Locks, only one tab at a time can open a particular local guest/account cache. Close the other tab and reload if prompted. Different browsers and devices can use the same account. Without Web Locks, avoid editing one account in multiple tabs of the same browser profile at the same time. Existing GitHub repository/Gist sync is available only in guest mode, so its token is not reused with a signed-in archive.

## Verify on two devices

1. On device A, sign up with a reachable email, confirm it, and sign in. Add or explicitly import a collection, record a note, rating, favorite, viewing path, and preference. Wait for **Synced**.
2. Sign into the same account in an independent browser or device B. Verify the records and preferences. Edit different films on both devices, sync, and check that both edits appear.
3. Export a complete JSON backup. Change the archive, restore the backup, and verify the restored data on B. Test a same-note conflict and a deletion from another device.
4. Sign out on B, sign into a different account, and confirm the first account's archive is not displayed. Return to the first account and verify it again. Test confirmation and password recovery using test email addresses.
5. Test the deployed project's database policies independently with two test accounts. UI filtering alone is not proof of authorization.

## Development verification

If you choose to run tests, use Node.js 24.15+ in the 24 LTS line, 22.22.2+ in the 22 line, or 26+. From the repository directory:

```powershell
npm ci
npm run check
npm test
```

The tests include JSON backup and restore through the UI, CSV progress import, simulated independent clients and failures, the bundled Supabase SDK against simulated HTTP responses, and the actual migration/RLS in embedded PostgreSQL with simulated Auth roles. They do not prove hosted email delivery, browser behavior, a real two-device session, or the policies configured in a deployed project.
