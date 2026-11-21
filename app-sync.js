/* Authentication, account-isolated local caches, and revision-based cloud synchronization. */
(() => {
  'use strict';
  const config = window.NIGHTREEL_CONFIG || {};
  function publicKey(key) {
    if (typeof key !== 'string') return false;
    if (key.startsWith('sb_publishable_')) return true;
    if (key.startsWith('eyJ')) {
      try { return JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon'; }
      catch { return false; }
    }
    return false;
  }
  function publicUrl(value) {
    try {
      const url = new URL(value);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      return !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && local));
    } catch { return false; }
  }
  const supportedPage = location.protocol === 'https:' || (location.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(location.hostname));
  const configured = Boolean(supportedPage && publicUrl(config.supabaseUrl) && publicKey(config.supabasePublishableKey) && window.supabase?.createClient);
  const redirectError = new URLSearchParams(location.hash.slice(1)).get('error_description') || new URLSearchParams(location.search).get('error_description');
  async function timedFetch(input, options = {}) {
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', forward, {once: true});
    const timer = setTimeout(() => controller.abort(), 15000);
    try { return await fetch(input, {...options, signal: controller.signal}); }
    finally { clearTimeout(timer); options.signal?.removeEventListener('abort', forward); }
  }
  const client = configured ? window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey:`nightreel-auth:${encodeURIComponent(new URL(config.supabaseUrl).href.replace(/\/+$/, ''))}`},
    global: {fetch: timedFetch}
  }) : null;
  const root = document.getElementById('nr-sync-status');
  const get = id => document.getElementById(id);
  const redirectTo = () => location.origin + location.pathname;
  const state = {
    user: null, expectedId: null, generation: 0, transitioning: true, meta: null,
    timer: null, polling: null, inFlight: null, retryCount: 0, error: '', status: 'Opening account…',
    recovery: false, busy: false, guestStarted: false, releaseLock: null, redirectError, authVerifiedAt: 0
  };
  // online/focus/visibilitychange can all fire within the same tick (e.g. switching back to a
  // tab that just regained connectivity). synchronize() already serializes on state.inFlight,
  // so this just gives every trigger the same entry point and reset-retry behavior the old
  // per-listener closures had, without adding a second, redundant throttle on top of it.
  function requestResync() {
    state.retryCount = 0;
    void synchronize();
  }
  const epoch = () => state.generation;
  const current = (generation, userId) => generation === state.generation && state.user?.id === userId && !state.transitioning;
  const clone = value => structuredClone(value);
  const emptyArchive = () => LedgerCore.validateArchive(LedgerCore.emptyArchive());
  const hasContent = archive => !NightreelMerge.same(archive, emptyArchive());
  const sessionProblem = error => error && (error.status === 401 || error.status === 403 || /session_missing|refresh_token_not_found|refresh_token_already_used|bad_jwt|invalid.*token/i.test(`${error.code || ''} ${error.message || ''}`));

  function status(message, error = false) {
    state.status = message;
    if (root) { root.textContent = message; root.classList.toggle('is-error', error); }
    const badge = get('nr-sync-badge');
    if (badge) {
      badge.textContent = state.user ? (error ? '⚠ Sync needs attention' : message) : '';
      badge.hidden = !state.user;
      badge.classList.toggle('is-error', error);
    }
    const github = get('guest-github-sync');
    if (github) github.hidden = !!state.user;
    const line = get('nr-account-status');
    if (line) { line.textContent = message; line.classList.toggle('is-error', error); }
  }

  function showLoading(show) {
    let cover = get('nr-session-loading');
    if (!cover) {
      cover = document.createElement('div');
      cover.id = 'nr-session-loading';
      cover.setAttribute('role', 'status');
      cover.style.cssText = 'position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:#070a12;color:#edf1fa;font:16px system-ui';
      cover.textContent = 'Opening your archive…';
      document.body.append(cover);
    }
    cover.hidden = !show;
    document.querySelector('.topbar')?.toggleAttribute('inert', show);
    document.getElementById('main')?.toggleAttribute('inert', show);
  }

  function clearOldScreen() {
    flushChronicle();
    clearTimeout(archiveApp.noteTimer);
    clearTimeout(archiveApp.importTimer);
    if (archiveApp.viewTimer) { clearTimeout(archiveApp.viewTimer); archiveApp.viewTimer = null; void persistArchive(); }
    archiveApp.importRevision++;
    archiveApp.artworkSearch++;
    window.resetNightreelStudio?.();
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    document.documentElement.style.overflow = '';
    archiveApp.detailId = null;
    archiveApp.artworkId = null;
    archiveApp.history = [];
    archiveApp.confirmAction = null;
    archiveApp.toastAction = null;
    archiveUi.toast.hidden = true;
    archiveUi.chronicleNote.value = '';
    for (const field of document.querySelectorAll('dialog input:not([type=checkbox]):not([type=radio]):not([type=file]), dialog textarea')) field.value = '';
    archiveApp.importSource = '';
    archiveApp.cloudImportText = '';
    archiveApp.cloudImportUrl = '';
    archiveApp.importSourceType = 'file';
    archiveApp.importDraft = null;
    archiveApp.importFiles = [];
    archiveUi.importText.value = '';
    archiveUi.importPreview.hidden = true;
    archiveUi.importPreviewList.replaceChildren();
    archiveUi.importPreviewSummary.textContent = '';
    archiveUi.commitImport.disabled = true;
    archiveApp.selected.clear();
    archiveApp.selecting = false;
    archiveApp.query = '';
    archiveApp.genre = '';
    archiveApp.filter = 'all';
    archiveApp.view = 'posters';
    archiveApp.sort = 'source';
    archiveApp.grouping = false;
    archiveApp.runtimeMax = null;
    archiveApp.yearMin = null;
    archiveApp.yearMax = null;
    archiveApp.language = '';
    archiveApp.lens = null;
    archiveUi.librarySearch.value = '';
    archiveUi.compassSearch.value = '';
    archiveApp.artwork.clear();
    resetArtworkQueue();
    realmState.scribeGeneration++;
    realmState.metadata.clear();
    realmState.selectedProfiles.clear();
    realmState.councilChoices = [];
    realmState.path = [];
    realmState.assistantFilters = null;
    realmState.aiRevision++;
    ArchiveAI.cancel();
    ArchiveAI.suspend();
    ArtworkLookup.setToken('');
    MetadataDesk.cancel();
  }

  function showArchive(archive, artwork = []) {
    archiveApp.archive = LedgerCore.validateArchive(archive);
    applyArchiveView();
    archiveApp.artwork.clear();
    for (const cached of artwork) if (cached && typeof cached.key === 'string' && Number.isFinite(cached.fetchedAt) && (!cached.match || LedgerCore.safeImageUrl(cached.match.posterUrl))) archiveApp.artwork.set(cached.key, cached);
    window.NightreelCloud?.useArchive();
    renderArchive(false);
  }

  function setDialogMessage(message, error = false) {
    const element = get('nr-auth-message');
    if (!element) return;
    element.textContent = message;
    element.classList.toggle('is-error', error);
  }

  function renderDialog() {
    const signedIn = get('nr-signed-in');
    if (!signedIn) return;
    get('nr-signed-out').hidden = !!state.user;
    signedIn.hidden = !state.user;
    get('nr-recovery').hidden = !state.recovery;
    get('nr-email-actions').hidden = state.recovery;
    get('nr-account-name').textContent = state.user?.email || (state.user ? 'Signed in' : '');
    get('nr-account-status').textContent = state.status;
    get('nr-config-message').hidden = configured;
    for (const button of get('nr-auth-dialog').querySelectorAll('button[data-auth]')) button.disabled = state.busy || !configured;
  }

  function buildDialog() {
    if (get('nr-auth-dialog')) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'nr-auth-dialog';
    dialog.className = 'overlay';
    dialog.setAttribute('aria-labelledby', 'nr-auth-title');
    dialog.innerHTML = `<section class="modal-card settings-card" style="max-width:560px">
      <header class="modal-header"><div><p class="eyebrow">☁ Cross-device sync</p><h2 id="nr-auth-title">Account &amp; sync</h2></div><button type="button" class="icon-button" id="nr-auth-close" aria-label="Close">×</button></header>
      <div class="modal-body">
        <p id="nr-config-message" class="form-status is-error" hidden>Cloud sync needs an HTTPS or localhost page and a public Supabase key. Follow the repository README; guest mode remains available.</p>
        <div id="nr-signed-out">
          <p class="quiet">Use any email address you can access and a password. Sign in on each device. Guest data stays separate until you import it.</p>
          <details id="nr-data-disclosure">
            <summary class="text-button" style="display:inline-block;cursor:pointer">What data goes to the cloud?</summary>
            <p class="quiet">Creating an account sends your email address to Supabase's authentication service, which stores it along with a hashed password. Once signed in, this app syncs one JSON document containing your collections, films (titles, years, genres, watched status, ratings, notes, favorites), viewing paths, saved views, profiles, feedback, poster image URLs you've chosen, and display/source preferences. Shared poster artwork (image URLs and captions looked up from Wikipedia or TMDB) is cached in a separate, non-personal table so it can be reused across devices and accounts without re-querying those services. No API tokens, passwords, or AI provider keys ever leave this browser. See the README's "Sync and security" section for the full field list.</p>
          </details>
          <div id="nr-email-actions">
            <label class="field-label">Email<input type="email" id="nr-email" class="text-field" autocomplete="email"></label>
            <label class="field-label">Password<input type="password" id="nr-password" class="text-field" autocomplete="current-password"></label>
            <div class="cloud-fetch-actions"><button type="button" class="button primary" data-auth="signin">Sign in</button><button type="button" class="button ghost" data-auth="signup">Create account</button></div>
            <button type="button" class="text-button" data-auth="reset">Forgot password?</button> · <button type="button" class="text-button" data-auth="resend">Resend confirmation</button>
          </div>
        </div>
        <div id="nr-signed-in" hidden><p id="nr-account-name"></p><p id="nr-account-status" class="quiet" role="status"></p>
          <div class="cloud-fetch-actions"><button type="button" class="button primary" data-auth="sync">Sync now</button><button type="button" class="button ghost" data-auth="signout">Sign out</button></div>
          <p class="quiet">Unsynced changes remain in this account’s cache on this browser.</p>
          <button type="button" class="button ghost" data-auth="import">Import this browser’s guest archive</button>
          <p class="quiet">Imports collections and other saved data into this account; existing account values take precedence when IDs match. The guest copy remains available.</p>
        </div>
        <div id="nr-recovery" hidden><label class="field-label">New password<input type="password" id="nr-new-password" class="text-field" autocomplete="new-password"></label><button type="button" class="button primary" data-auth="update-password">Set new password</button></div>
        <p id="nr-auth-message" class="form-status" role="status" aria-live="polite"></p>
      </div></section>`;
    document.body.append(dialog);
    get('nr-auth-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      const action = event.target.closest('[data-auth]')?.dataset.auth;
      if (action) void authAction(action);
    });
  }

  async function authAction(action) {
    if (!client || state.busy) return;
    state.busy = true;
    setDialogMessage('');
    renderDialog();
    try {
      const email = get('nr-email').value.trim();
      const password = get('nr-password').value;
      let response;
      if (action === 'signin') response = await client.auth.signInWithPassword({email, password});
      if (action === 'signup') {
        response = await client.auth.signUp({email, password, options: {emailRedirectTo: redirectTo()}});
        if (!response.error && !response.data.session) setDialogMessage('Check your email for a confirmation link, then sign in.');
      }
      if (action === 'resend') {
        if (!email) throw new Error('Enter your email address first.');
        response = await client.auth.resend({type: 'signup', email, options: {emailRedirectTo: redirectTo()}});
        if (!response.error) setDialogMessage('If confirmation is needed, check your email for a new link.');
      }
      if (action === 'reset') {
        if (!email) throw new Error('Enter your email address first.');
        response = await client.auth.resetPasswordForEmail(email, {redirectTo: redirectTo()});
        if (!response.error) setDialogMessage('If an account exists for this address, check your email for a recovery link.');
      }
      if (action === 'update-password') {
        const newPassword = get('nr-new-password').value;
        if (!newPassword) throw new Error('Enter a new password.');
        response = await client.auth.updateUser({password: newPassword});
        if (!response.error) { state.recovery = false; get('nr-new-password').value = ''; setDialogMessage('Password updated.'); }
      }
      if (action === 'sync') { state.retryCount = 0; await synchronize({verifySession:true}); }
      if (action === 'import') await importGuest();
      if (action === 'signout') {
        flushChronicle();
        await ArchiveStorage.flush();
        if (navigator.onLine) await synchronize();
        response = await client.auth.signOut({scope: 'local'});
      }
      if (response?.error) throw response.error;
      if (action === 'signin' || action === 'signup') get('nr-password').value = '';
    } catch (error) { setDialogMessage(error.message || 'The request failed. Try again.', true); }
    finally { state.busy = false; renderDialog(); }
  }

  async function importGuest() {
    if (!state.user || state.transitioning) throw new Error('Sign in before importing guest data.');
    const generation = epoch(), userId = state.user.id;
    flushChronicle();
    const guest = await ArchiveStorage.readGuestArchive();
    if (!current(generation, userId)) return;
    if (!hasContent(guest)) { setDialogMessage('This browser has no guest archive to import.'); return; }
    const account = clone(archiveApp.archive);
    let merged;
    if (!hasContent(account)) merged = guest;
    else {
      // Do not duplicate a film ID or a title/year already in the same collection.
      const existingFilms = new Map(account.collections.flatMap(collection => collection.films.map(film => [film.id, collection.id])));
      const remap = new Map();
      for (const collection of guest.collections) {
        const existing = account.collections.find(item => item.id === collection.id);
        const identity = new Map((existing?.films || []).map(film => [LedgerCore.identity(film.title, film.yearLabel), film.id]));
        collection.films = collection.films.filter(film => {
          const match = identity.get(LedgerCore.identity(film.title, film.yearLabel));
          if (match && match !== film.id) { remap.set(film.id, match); return false; }
          if (existingFilms.has(film.id) && existingFilms.get(film.id) !== collection.id) {
            const previousId = film.id;
            film.id = LedgerCore.newId('film');
            remap.set(previousId, film.id);
          }
          return true;
        });
      }
      for (const path of guest.paths || []) path.filmIds = path.filmIds.map(id => remap.get(id) || id);
      for (const entry of guest.feedback || []) entry.filmId = remap.get(entry.filmId) || entry.filmId;
      merged = NightreelMerge.merge(emptyArchive(), account, guest);
    }
    merged = LedgerCore.validateArchive(merged);
    if (!current(generation, userId)) return;
    showArchive(merged);
    await ArchiveStorage.save(merged);
    if (!current(generation, userId)) return;
    changed();
    setDialogMessage('Guest data imported. The original guest archive remains in this browser.');
  }

  function schedule(delay = 1000) {
    if (!state.user || state.transitioning) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { void synchronize(); }, delay);
  }

  function changed() {
    if (!state.user || state.transitioning) return;
    state.retryCount = 0;
    status('Saved locally · sync pending');
    schedule();
  }

  async function saveReconciliation(accepted, base, revision, generation, userId) {
    let observed = accepted.snapshot;
    let incoming = accepted.archive;
    while (current(generation, userId)) {
      flushChronicle();
      const latest = clone(archiveApp.archive);
      const merged = LedgerCore.validateArchive(NightreelMerge.merge(observed, latest, incoming));
      await ArchiveStorage.save(merged);
      if (!current(generation, userId)) return;
      flushChronicle();
      // A user action can save while IndexedDB is completing. Rebase it before
      // replacing the visible state; never discard a later local edit.
      if (!NightreelMerge.same(archiveApp.archive, latest)) {
        observed = latest;
        incoming = merged;
        continue;
      }
      if (!NightreelMerge.same(latest, merged)) showArchive(merged, [...archiveApp.artwork.values()]);
      await ArchiveStorage.writeMeta({base, revision});
      if (!current(generation, userId)) return;
      state.meta = {base, revision};
      if (!NightreelMerge.same(archiveApp.archive, base)) schedule(300);
      return;
    }
  }

  async function synchronize({verifySession = false} = {}) {
    if (!client || !state.user || state.transitioning || state.inFlight) return;
    if (!navigator.onLine) { status('Offline · changes saved on this device'); return; }
    const flight = {};
    state.inFlight = flight;
    const generation = epoch(), userId = state.user.id;
    status('Checking cloud…');
    try {
      if (verifySession || Date.now() - state.authVerifiedAt >= 120000) {
        const verification = await client.auth.getUser();
        if (!current(generation, userId)) return;
        if (verification.error) throw verification.error;
        if (verification.data.user?.id !== userId) throw new Error('Session identity changed. Sign in again.');
        state.authVerifiedAt = Date.now();
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await client.from('nightreel_archives').select('revision,archive,updated_at').eq('user_id', userId).maybeSingle();
        if (!current(generation, userId)) return;
        if (response.error) throw response.error;
        const row = response.data;
        const remote = row ? LedgerCore.validateArchive(row.archive) : emptyArchive();
        const revision = row ? Number(row.revision) : 0;
        if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('The cloud revision is invalid.');
        // A missing row after an acknowledged revision is not an empty archive to overwrite.
        if (!row && state.meta.revision > 0) throw new Error('The cloud archive is missing. The local copy is preserved; contact the project administrator.');
        flushChronicle();
        const snapshot = clone(archiveApp.archive);
        const merged = LedgerCore.validateArchive(NightreelMerge.merge(state.meta.base, snapshot, remote));
        if (row && NightreelMerge.same(merged, remote)) {
          await saveReconciliation({snapshot, archive: remote}, remote, revision, generation, userId);
          if (!current(generation, userId)) return;
          state.retryCount = 0;
          status(NightreelMerge.same(archiveApp.archive, remote) ? 'Synced' : 'Saved locally · sync pending');
          return;
        }
        status('Saving to cloud…');
        const saved = await client.rpc('nightreel_commit_archive', {expected_revision: revision, document: merged});
        if (!current(generation, userId)) return;
        if (saved.error?.code === 'P0001' && /revision conflict/i.test(saved.error.message)) continue;
        if (saved.error) throw saved.error;
        const committed = Array.isArray(saved.data) ? saved.data[0] : saved.data;
        if (!committed?.archive || !Number.isSafeInteger(Number(committed.revision))) throw new Error('The server did not confirm the archive write.');
        const accepted = LedgerCore.validateArchive(committed.archive);
        await saveReconciliation({snapshot, archive: accepted}, accepted, Number(committed.revision), generation, userId);
        if (!current(generation, userId)) return;
        state.retryCount = 0;
        status(NightreelMerge.same(archiveApp.archive, accepted) ? 'Synced' : 'Saved locally · sync pending');
        return;
      }
      throw new Error('The archive is changing repeatedly on another device. Changes remain saved locally; try Sync now.');
    } catch (error) {
      if (!current(generation, userId)) return;
      if (sessionProblem(error)) {
        status('Session expired or revoked · sign in again', true);
        await client.auth.signOut({scope: 'local'});
        return;
      }
      state.error = error.message || 'Cloud sync failed.';
      status(`Sync failed: ${state.error} · local changes preserved`, true);
      state.retryCount++;
      if (state.retryCount <= 5 && navigator.onLine) schedule(Math.min(60000, 2000 * 2 ** (state.retryCount - 1)));
    } finally { if (state.inFlight === flight) state.inFlight = null; }
  }

  async function startGuestIntegrations() {
    if (state.guestStarted || !window.NightreelSync.allowsGuestSync()) return;
    state.guestStarted = true;
    const generation = epoch();
    try {
      const imported = await GitHubPagesStaticImport.tryImport();
      if (generation !== epoch() || !window.NightreelSync.allowsGuestSync()) return;
      if (imported) { await persistArchive(); renderArchive(true); showMessage(`Loaded ${imported.filmCount.toLocaleString()} films from ${imported.name}.`, true); }
      if (GitHubRepoSync.configured() && !GitHubRepoSync.isPaused()) void githubSyncPullAndApply();
      if (GitHubGistSync.configured() && !GitHubGistSync.isPaused()) void githubGistSyncPullAndApply();
    } catch { /* Optional guest imports do not block the archive. */ }
  }

  function beginTransition(user) {
    const id = user?.id || null;
    if (id === state.expectedId && !state.transitioning) return false;
    state.expectedId = id;
    state.generation++;
    state.transitioning = true;
    state.inFlight = null;
    window.NIGHTREEL_AUTH_PENDING = true;
    clearTimeout(state.timer);
    showLoading(true);
    return true;
  }

  async function acquireCacheLock(scope) {
    if (!navigator.locks?.request) return () => {};
    return new Promise(resolve => {
      navigator.locks.request(`nightreel-cache:${scope}`, {ifAvailable: true}, lock => {
        if (!lock) { resolve(null); return; }
        return new Promise(release => { resolve(release); });
      }).catch(() => resolve(null));
    });
  }

  async function finishTransition(user, generation) {
    await appReady;
    if (generation !== epoch()) return;
    clearOldScreen();
    try {
      await ArchiveStorage.flush();
      if (generation !== epoch()) return;
      const project = user ? new URL(config.supabaseUrl).href.replace(/\/+$/, '') : '';
      const nextScope = user ? `user:${project}:${user.id}` : 'guest';
      state.releaseLock?.(); state.releaseLock = null;
      const release = await acquireCacheLock(nextScope);
      if (generation !== epoch()) { release?.(); return; }
      if (!release) {
        get('nr-session-loading').textContent = 'This archive is open in another tab. Close that tab and reload this page.';
        return;
      }
      state.releaseLock = release;
      const loaded = await ArchiveStorage.setScope(nextScope);
      if (generation !== epoch()) return;
      if (loaded.error) throw new Error(loaded.error);
      let meta = user ? await ArchiveStorage.readMeta() : null;
      if (generation !== epoch()) return;
      if (user && (!meta || !meta.base || !Number.isSafeInteger(meta.revision))) meta = {base: emptyArchive(), revision: 0};
      // A note journal may contain the last keystrokes from a crashed tab.
      try {
        const key = ArchiveStorage.scopedKey('HOLLOW_KINGDOM_PENDING_NOTE');
        const pending = JSON.parse(localStorage.getItem(key) || 'null');
        const film = loaded.archive.collections.find(item => item.id === pending?.collectionId)?.films.find(item => item.id === pending?.filmId);
        if (film && typeof pending.note === 'string') {
          film.note = pending.note; film.updatedAt = new Date().toISOString();
          await ArchiveStorage.save(loaded.archive);
          if (generation !== epoch()) return;
          localStorage.removeItem(key);
        }
      } catch { /* A damaged journal never replaces the saved archive. */ }
      if (ArchiveAI.restoreFromSession()) {
        try {
          const bridge = JSON.parse(sessionStorage.getItem(ArchiveStorage.scopedKey('HOLLOW_KINGDOM_BRIDGE_V1')) || 'null');
          if (bridge) { archiveUi.aiEndpoint.value = bridge.endpoint || ''; archiveUi.aiAccessCode.value = bridge.accessCode || ''; }
        } catch { /* Bridge connection is optional. */ }
      }
      state.user = user;
      state.meta = meta;
      state.authVerifiedAt = 0;
      state.retryCount = 0;
      state.guestStarted = false;
      showArchive(loaded.archive, loaded.artwork);
      state.transitioning = false;
      window.NIGHTREEL_AUTH_PENDING = false;
      showLoading(false);
      if (user) { status(navigator.onLine ? 'Opening cloud archive…' : 'Offline · changes saved on this device'); schedule(0); }
      else { status(configured ? 'Signed out · guest archive on this browser' : 'Cloud sync not configured · guest archive on this browser'); void startGuestIntegrations(); }
      renderDialog();
      if (state.recovery || state.redirectError) {
        window.NightreelSync.openDialog();
        if (state.redirectError) { setDialogMessage('The sign-in or recovery link is invalid or expired. Request a new link.', true); state.redirectError = null; }
      }
    } catch (error) {
      state.releaseLock?.(); state.releaseLock = null;
      state.user = null;
      state.expectedId = null;
      state.transitioning = false;
      window.NIGHTREEL_AUTH_PENDING = false;
      showLoading(false);
      archiveApp.archive = emptyArchive();
      renderArchive(false);
      status(`Could not open the account cache: ${error.message}`, true);
    }
  }

  const controls = document.querySelector('.topbar-actions');
  if (controls) {
    const badge = document.createElement('span');
    badge.id = 'nr-sync-badge'; badge.hidden = true; badge.className = 'quiet';
    badge.style.cssText = 'max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    controls.prepend(badge);
  }
  window.NightreelSync = {
    isSignedIn: () => !!state.user,
    allowsGuestSync: () => !state.user && !state.transitioning && !window.NIGHTREEL_AUTH_PENDING,
    scopeToken: epoch,
    changed,
    openDialog() { buildDialog(); renderDialog(); if (!get('nr-auth-dialog').open) get('nr-auth-dialog').showModal(); }
  };

  // Shared read-through poster cache: once any signed-in user has looked up a title's artwork,
  // every signed-in user reuses that result instead of re-querying Wikipedia/TMDB, which is
  // what actually avoids their per-IP rate limits (an IndexedDB-only cache does not, since a
  // new device/browser has an empty cache). Guest (signed-out) users have no row to read or
  // write under RLS, so this is a no-op for them and they keep querying the providers directly.
  window.NightreelArtworkCache = {
    async lookup(identityKey) {
      if (!client || !state.user) return null;
      try {
        const response = await client.from('nightreel_artwork_cache').select('match,fetched_at').eq('identity_key', identityKey).maybeSingle();
        if (response.error || !response.data) return null;
        const fetchedAt = Date.parse(response.data.fetched_at || '');
        return {match: response.data.match || null, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : Date.now()};
      } catch { return null; }
    },
    async store(identityKey, provider, match) {
      if (!client || !state.user) return;
      try { await client.rpc('nightreel_upsert_artwork', {key: identityKey, provider_name: provider, match_data: match || null}); }
      catch { /* The shared cache is an optimization; a local miss still falls back to the provider. */ }
    }
  };

  showLoading(true);
  if (client) {
    client.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') state.recovery = true;
      const user = session?.user || null;
      if (beginTransition(user)) {
        const generation = epoch();
        setTimeout(() => { void finishTransition(user, generation); }, 0);
      } else if (event === 'PASSWORD_RECOVERY') setTimeout(() => window.NightreelSync.openDialog(), 0);
    });
  } else {
    beginTransition(null);
    void finishTransition(null, epoch());
  }
  // The periodic poll only runs while the tab is visible; a backgrounded tab makes no
  // Supabase requests at all until it regains focus or the page comes back online.
  state.polling = setInterval(() => { if (document.visibilityState === 'visible' && state.retryCount <= 5) requestResync(); }, 20000);
  window.addEventListener('online', requestResync);
  window.addEventListener('focus', requestResync);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestResync(); });
})();
