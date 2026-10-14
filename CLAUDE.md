# CLAUDE.md

Chrome extension (Manifest V3, vanilla JS, no build step, no dependencies) that auto-follows and comments on Threads (threads.com / threads.net) posts that invite "mutualan" (mutual follow). The UI text and logs are in Bahasa Indonesia; keep them that way.

## Files
- `manifest.json` – MV3 manifest. Content scripts: `defaults.js` then `content.js` on threads.com/net. Only permission is `storage`.
- `defaults.js` – `THREADS_BOT_DEFAULTS` (keywords, comment templates, delays, limits, flags). Shared global, loaded by both popup and content script.
- `content.js` – the bot. Runs in the Threads page.
- `popup.html` / `popup.js` / `popup.css` – settings form, Start/Stop, stats, last 20 log lines.
- `icons/` – generated PNGs (16/48/128).

## How it works
- Popup saves the form to `chrome.storage.local.settings`, then sends `{type:'start'}` to the active tab. Other messages are `stop` and `ping` (which returns `{running}`).
- `content.js` `start()` only checks that the user is logged in. It works from any Threads page, because the first `cleanUp()` in `run()` navigates to Beranda (`location.pathname === '/'`). The `run()` loop:
  `cleanUp` → scan post cards → skip seen/processed/own posts → keyword match → `markProcessed` → `doFollow` → `cleanUp` → `findCard` (re-locate by post ID) → `doComment` → `cleanUp` → random delay → repeat.
- `cleanUp()` = `dismissPopups()` (Escape + `clickEmptySpot()` + "Buang" confirm) and then `goHome()` if the page left Beranda. `goHome` tries the Beranda nav link, then `history.back()`, and as a last resort a hard reload to `/` with `storage.resume` set. The IIFE at the bottom of `content.js` auto-restarts from `resume`.
- Post cards can go stale after navigation, so always re-find a card with `findCard(postId)` instead of reusing an old reference.
- State flows one way: the content script writes `botState` (`running`, `reason`, `stats`, `logs`) to storage, and the popup renders it via `storage.onChanged`.
- `processed` (post IDs, capped at 2000) persists across sessions. `seen` exists only for the current page load.
- Safety stops: `maxActions` reached, 15 idle scrolls, or a limit dialog (`RE.limited`).

## DOM conventions (most fragile part)
- Threads class names are obfuscated, so **never select by class**. Use `data-pressable-container`, `aria-label`, `role`, `href` patterns and visible text.
- All selectors live in `SEL`, and all label regexes (English + Indonesian) live in `RE` at the top of `content.js`. Change them there, not inline.
- `findClickable(root, regex)` matches `aria-label` first, then button text, and returns the nearest clickable ancestor. Reuse it.
- Text is typed into the composer with `document.execCommand('insertText')` so the React editor registers the input. Setting `textContent`/`value` will not work.
- Clicks go through `realClick()` (full pointer/mouse event sequence).
- Comment send button: `findSendButton(editor, replyBtn)` searches only inside `composerScope()`. That scope is the dialog, or for an inline composer the largest ancestor of the editor that does not yet contain the card's action bar (`replyBtn`). Within it, a button with matching text (`RE.post`) wins first, then an icon whose label matches `RE.post` and does not match `RE.share`. Never add "bagikan" to `RE.post`: the Indonesian Share icon is labelled "Bagikan". The fallback is Ctrl+Enter, and the log then lists the composer's buttons (`describeComposer`) so the right label can be added to `RE.post`.
- After following, Threads often leaves a profile hover card open, and that card blocks the comment step. It is not always `role="dialog"`. `findProfileCards()` detects it as a Follow/Mengikuti button outside any post card that has a `fixed`/`absolute` ancestor, and `openPopups()` includes it. `closeProfilePopup()` sends mouseleave to the avatar, presses Escape, and clicks an empty spot (`clickEmptySpot()` tries the top-right corner first).
- Follow confirmation must be checked inside the card or dialog only. Beranda has a "Following" feed tab that would give a false positive.

## Working on this repo
- No tests and no build. Check syntax with `node --check content.js popup.js defaults.js`.
- To test, go to `chrome://extensions`, reload the extension, **refresh the Threads tab**, then use **Dry run**, then **Maks aksi = 1**.
- Use `sleep()` (interruptible, checks `running`) for any wait inside the loop, so Stop responds quickly.
- Keep the bot slow and human-like. Do not lower the default delays or raise the default limits.
- When behaviour or settings change, update `README.md` (Indonesian, user-facing).
