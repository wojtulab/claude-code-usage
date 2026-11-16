# Contributing to `claude-code-usage`

Pull requests and DOM selector updates are welcome!

## Design Constraints

1. **Single-file, zero dependencies, `@grant none`:** The script must remain a single installable `.user.js` file without `@require` or Tampermonkey sandbox grants.
2. **Privacy:** Never send user data, session titles, or tokens to any external domain. Only `claude.ai/api/...` (`same-origin`) and `localStorage` are allowed.
3. **Background-tab resilience:** Detection should rely on `MutationObserver` + one-shot `setTimeout` rather than fast chained intervals so background tabs don't miss completions when Chrome throttles timers.
4. **Shared helper blocks:** The helpers `setFav`, `away`, `notify`, `closeN`, `claimOnce`, and Web Audio playback (`ensureAudio` / stale beep rejection) are mirrored in the companion [`antigravity-usage`](https://github.com/wojtulab/antigravity-usage) script. Keep signatures/behavior clean if modifying them.

## Before Opening a PR

1. Run a syntax check:
   ```bash
   node --check claude-usage.user.js
   ```
2. Bump `// @version` in the `==UserScript==` header (using SemVer: patch for fixes, minor for features) so users get the update via `@updateURL`.
3. Note in the PR description which browser and userscript manager (Tampermonkey / Violentmonkey) you tested on.

## Debugging DOM Changes

If `claude.ai/code` changes sidebar row markup or the Stop button:
1. Open DevTools (`F12` → Console) on `claude.ai/code`.
2. Run `__claudeDumpRows()` (or `__claudeDumpRows('session-name')`) while a session is running and after it stops.
3. Run `__claudeDiag()` to inspect event transitions (`spin+`, `spin-`, `stop+`, `stop-`, `alert`, `too-short`).
