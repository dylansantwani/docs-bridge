# Docs Bridge contributor guide

## Layout

- `server/`: MCP stdio server.
  - `hub.js`: loopback hub, port election, origin and token auth.
  - `tools.js`: tool schemas and argument validation.
  - `markdown.js`: turns markdown into the HTML Docs accepts on paste.
  - `ws.js` and `mcp.js`: copied from openbrowser.
  - `vendor/marked.esm.js`: vendored, MIT.
- `extension/`: MV3 extension.
  - `background.js`: the service worker.
  - `lib/bridge.js`: the WebSocket client.
  - `lib/tabs.js`: the bridge tab pool.
  - `lib/ops.js`: the operations and write verification.
  - `lib/refs.js`: URLs and document ids, shared with the server.
  - `lib/typing.js`: the human-typing planner (pure and seeded), shared with
    the server, which builds the plan.
  - `lib/typer.js`: typing jobs. They type in chunks, rotate tabs, resume,
    and persist to `chrome.storage.local`.
- `server/structure.js`: the outline behind `docs_read format: "structure"`.
- Google Slides:
  - `server/slides.js`: the `slides_*` tools, markdown → slide paragraphs,
    the slide tracker that resolves title/subtitle/body roles, run splitting,
    and `slides_type` plan splitting.
  - `extension/lib/slides-ops.js`: Slides operations and saved-deck
    verification.
  - `extension/lib/pptx.js`: zip + XML reader that turns an exported .pptx
    into the deck outline. Shared with the server; only Uint8Array,
    TextDecoder and DecompressionStream.
  - `extension/page/slides-page.js`: everything that runs in a Slides tab.
- `extension/page/*.js`: functions injected with `chrome.scripting.executeScript`.
  They must be fully self-contained. `test/page.test.js` and
  `test/slides-page.test.js` compile them alone in a VM to enforce this.

## Required checks

```bash
npm test
npm run test:e2e     # when touching the extension, hub, or page code
```

After changing `extension/page/docs-page.js`, also run the page harness in a
scratch document (`scripts/page-harness.mjs`). The fake editor in the unit
tests cannot tell you whether Google changed the real one.

## Live-verified Docs behavior (2026-09-29)

These were established against docs.google.com. Do not "simplify" code that
relies on them without re-verifying live.

1. **A synthetic paste works.** A `ClipboardEvent('paste')` carrying
   `text/html`, dispatched into the contenteditable inside
   `iframe.docs-texteventtarget-iframe`, is consumed by Docs: it calls
   `preventDefault` and applies the content.
2. **Some paste markup needs rewriting.** Docs drops `<code>` styling, so code
   becomes an explicit Courier New span. It trims leading spaces in pasted
   HTML, so edge spaces must be `&nbsp;`. `<hr>` works.
3. **Pasted `<p>` elements take the style of the paragraph they land in.**
   Headings keep their own level. So block payloads go into an empty paragraph
   that has first been reset with Cmd+Alt+0 (Normal text).
4. **A block paste leaves one plain empty paragraph behind.** This holds even
   after a list. One Backspace removes it. After a table it must stay.
5. **Untrusted key events work.** They move the caret (Cmd+Up/Down, arrows,
   Alt+Up/Down for paragraph boundaries), select all, delete, and set styles.
   Alt+Up at the start of a paragraph jumps to the previous one. That is why
   `toParagraphStart` goes down first, then up.
6. **Hidden tabs throttle timers.** Chrome aligns them to one second, and after
   5 minutes hidden it allows one per minute. That applies to Docs' own
   timers too, and Find stops working. So:
   - page code waits with MessageChannel instead of `setTimeout`;
   - long waits, such as save verification, run in the service worker;
   - bridge tabs are replaced once they are 4 minutes old.
7. **The Find dialog has to be driven in a specific way.**
   - A dialog stays `visibility:hidden` both when open and when closed,
     because animations never run in a hidden tab. Never infer its state from
     CSS.
   - Always press Cmd+Shift+H before a search.
   - Escape in the find field is what moves the document selection onto the
     match. Focusing the editor while the dialog is active leaves the caret
     where it was.
   - The dialog's "n of m" counter keeps the previous query's value until the
     new search finishes. Clear the field and wait before reading it.
   - Next steps between matches, and the counter updates about a second later.
8. **The editor element exists for viewers too.** Editability comes from the
   mode switcher first, then from the header offering "Request edit access",
   "View only", or "Sign in".
9. **`DOMParser` on a plain string throws in Docs pages.** Docs enforces
   Trusted Types, and that applies in both the main and the isolated world.
   Parse `/mobilebasic` with regexes instead.
10. **Export must be fetched from the service worker.** `/export` redirects to
    googleusercontent.com. A fetch from the page fails CORS; the service
    worker, with host permissions, succeeds. `format=md` works, and
    Content-Disposition carries the title.
11. **Localhost fetches from a docs.google.com page are blocked.** They trigger
    Chrome's local-network permission prompt, so never have page code fetch
    localhost. Extension service workers are not affected.

12. **Typing inherits the document's styles.**
    - Inline HTML pasted into a paragraph inherits that paragraph's style
      (template fonts and colours).
    - Cmd+Alt+N applies the document's own Heading N.
    - Pasting block HTML (`<h2>`, `<p>`) instead brings in browser-default
      looks as explicit overrides, such as bold 17pt and 12pt spacing.
    - So `typeBlocks` types block by block; only rules, images, and tables are
      pasted as HTML.
13. **Lists follow Docs' own rules.**
    - Cmd+Shift+8/7/9 toggle bullet, numbered, and checklist lists.
    - Tab and Shift+Tab change nesting.
    - Enter continues the current list. Pressing that list's shortcut again
      turns the item back into a plain paragraph.
    - Converting a nested item's list type keeps its depth.
14. **A table pasted at the end of a paragraph lands right after it.** Pasting
    one into an empty paragraph leaves that empty paragraph above it. In both
    cases the caret ends up in a new empty paragraph after the table.
15. **The menu bar, toolbar menus, and colour palettes accept synthetic mouse
    events in a hidden tab.**
    - Menus: mousedown on the top-level item; mouseover, mousedown, and
      mouseup on submenu items; the same plus click on the final item.
    - Checkable items carry `goog-option-selected`.
    - Palette cells have aria-labels such as `red` or `dark blue 2`.
    - The "Search the menus" box does not work in a hidden tab: it renders its
      suggestions on animation frames.
16. **The toolbar reports caret state about a second after the caret moves.**
    - `Styles list. X selected.`, `Font list. X selected.`, and
      `input[aria-label="Font size"]`.
    - `aria-pressed` on `#boldButton`, `#italicButton`, `#underlineButton`,
      `#addBulletButton`, `#addNumberedBulletButton`, and
      `#addChecklistButton`.
    - Typing into the font-size box does nothing. Cmd+Shift+. and
      Cmd+Shift+, step the size by 1pt instead.
17. **Shift+Alt+Down from the start of a paragraph selects to its end.**
    Repeated presses extend the selection one paragraph at a time, which is
    how a section's body is selected.
18. **`/document/d/<id>/copy?title=…` names the copy.**
    - One synthetic click on its "Make a copy" button creates it.
    - Gallery templates are public documents whose ids appear in the gallery
      thumbnail URLs.
    - The gallery lives at `docs.google.com/document/?ftv=1&tgif=d`.
    - Clicking a gallery tile synthetically does nothing, so templates are
      copied instead.
19. **Drive saves a second or two behind typing.** Decisions based on
    structure (is the last paragraph empty? how many paragraphs are in this
    section? is this anchor its own paragraph?) must use `settledBlocks`.
    Otherwise back-to-back edits read a stale copy.
20. **Nothing may wait on a tab forever.** `executeScript` has no timeout,
    and a document's calls run one at a time. Observed live: one stuck edit
    held a document's queue, so every later edit to it hung while reads
    (which use no tab) still worked.
    - `runInTab` probes the page every 15s. The page op reports a step
      label and a beat, and `pause()` ticks the beat. No answer means the
      page is hung (`tab_unresponsive`). No progress for 60s means the op is
      stuck (`tab_stalled`). `withDoc` then closes that tab.
    - Each call runs under the server's timeout minus 5s, which the hub
      forwards. Past it, `dispatch` abandons the document: it closes the tab
      and drops the queue.
    - In-page fetches abort after 20s.
    - Page ops in `list-page.js` do not beat, so each must finish within
      `STALL_MS`.
21. **Drive's layout is per account.** Grid view shows results as
    `[role=gridcell][data-id]` tiles with no modified or owner cells. Drive
    may also redirect the search URL after load, which removes the injected
    frame, so `list` retries.

22. **Typed characters go in as keydown, keypress, keyup.** Verified in a
    hidden tab (2026-09-30).
    - An untrusted `keypress` with `charCode` on the editor input is typed.
      This covers ASCII and BMP characters (é, “, —). Docs applies smart
      quotes to them and auto-capitalises list items.
    - `keydown` must carry the key's real `keyCode`, because Docs acts on
      keydown codes. Sending `keyCode = charCode` made `!` (33) act as
      PageUp and `.` (46) act as Delete. See `charKey` in `docs-page.js`.
    - Characters outside the BMP (emoji) do not arrive through keypress, so
      they are pasted.
    - Cmd+B and Cmd+I with a collapsed caret toggle formatting for the text
      typed next.
23. **Resuming by Find.** After stopping mid-paragraph, a Find for the tail
    typed so far, then ArrowRight, puts the caret back exactly. The tail
    must avoid characters that autocorrect changes (quotes, hyphens,
    dashes). That is why `resumeTail` keeps only `[A-Za-z0-9 ,.;:!?]`, and
    the page and `lib/typing.js` each have a copy that the tests keep in
    step.

## Live-verified Docs behavior (2026-10-13)

These were found while human-typing tables into a real school-account doc.

36. **A typed tab must be the Tab key.** `typeChar('\t')` sends keyCode 0,
    which is not a Tab. `playPlan` presses the real Tab key for `\t`, and in a
    table that moves to the next cell and selects its contents, so typing
    replaces them. Tab in the last cell adds a row, so never end on a tab.
    `text` mode still turns tabs into spaces; `markdown` keeps them, but a
    line starting with a tab is a code block, so start each chunk with text.
37. **An empty pasted table gets 0 pt columns and no borders.** Docs sizes a
    pasted table without widths from its content, so a grid of empty cells
    lays out one character per line. `sizeTables` (server/markdown.js)
    gives every pasted table `width:468pt` columns and 1px borders.
38. **The font dropdown is `#docs-font-family`, labelled just "Font".** The
    old "Font list. X selected." label is gone; `fontButton()` tries both.
39. **Docs autocorrects as it is typed.** Docs capitalises the first word of
    a cell or sentence when its space is typed ("less than" became "Less
    than"; a single word followed by Tab is left alone). An account's own
    substitutions also fire on the space or punctuation after a word (one
    school account had its->it's, though->through, toxic->☢). Retype the
    word with nothing after it to undo either.
40. **Backspace at the start of an indented paragraph removes the indent
    first,** not the line break. To delete an emptied paragraph, put the
    caret at the end of the one before and press Delete.

## Live-verified Slides behavior (2026-10-12)

Established against docs.google.com/presentation in hidden bridge tabs.

24. **Same input as Docs.** Keys and synthetic `paste` events go to the
    contenteditable in `iframe.docs-texteventtarget-iframe`; typed characters
    use the #22 keydown/keypress/keyup sequence; Cmd+B/I toggle with a
    collapsed caret, also for the next paste.
25. **Shapes are SVG.** The current slide is `g#editor-<pageId>`, its shapes
    the children `g#editor-<objectId>` (minus `#editor-<pageId>-bg`), in
    z-order. Mousedown/mouseup/click on a shape's
    `path[pointer-events="visiblePainted"]` selects it; Enter puts the caret
    in its text. Empty placeholders draw their prompt ("Click to add title",
    "… subtitle", "… text"), which is how a new slide's roles are found.
26. **A paste without a text caret does not type.** With nothing selected it
    creates a new text box; with a whole shape selected it replaces the
    shape's entire text. Nothing is pasted unless the caret is known to be
    in text.
27. **A synthetic `copy` is the read-back.** Dispatch
    `ClipboardEvent('copy')` with our own DataTransfer on the editor input and
    Slides fills it: exact text/plain (spaces, line breaks), text/html, and
    `application/x-vnd.google-docs-drawings-object+wrapped` when whole shapes
    (not text) are selected. The real clipboard is untouched. Cmd+A in text
    selects that box's text; with shapes selected it selects every shape, so
    a copy check comes before any Backspace.
28. **Find and replace is the Docs dialog, but open it from the menu.** In a
    hidden tab Cmd+Shift+H never creates it; Edit > Find and replace does.
    After Replace all the "n of m" counter does not refresh in a hidden tab.
    Stepping to a match and closing the dialog does not leave the match
    selected as text (a paste then replaced the whole box), so text is
    selected by caret moves at exact offsets from the copied text.
29. **Slides.** Ctrl+M (Ctrl on macOS too) adds a slide after the current
    one; the hash becomes `#slide=id.<pageId>`. Slide > Apply layout is a
    palette of `td.goog-palette-cell` labelled by
    `.punch-layouts-palette-label`. Slide > Move slide is disabled unless the
    slide is selected in the filmstrip: click its thumbnail first.
30. **The filmstrip.** Thumbnails are `g#filmstrip-slide-<i>-<pageId>` in a
    `.punch-filmstrip-thumbnail`. `<i>` goes stale after moves; the
    thumbnail's `translate(0 Y)` is the real order. It fills in a few at a
    time after load (1 of 5, then 5), and in a long deck draws only those
    near its viewport (12 of 29). `svg.punch-filmstrip-thumbnails` height is
    sized for all of them (first offset + count × pitch); scrolling
    `.punch-filmstrip-scroll` draws more, drawn ones stay, and each position
    needs a moment to finish its batch.
31. **Speaker notes.** Cmd+Alt+Shift+S puts the caret in the notes even when
    the notes panel is collapsed to 0px (then nothing is drawn, so notes are
    read by copy and verified from the saved deck).
32. **Lists.** Cmd+Shift+8/7 toggle, Tab/Shift+Tab nest at the start of an
    item, Enter continues the list. Pressing the other list's shortcut on an
    item retypes the whole list, so bullets → numbering is: bullets off, then
    numbering on. Bold/italic at the end of a pasted paragraph sticks to the
    caret across Enter, so it is toggled off before the next paragraph.
33. **New decks** open a "Getting started" dialog a moment after the editor
    is ready; while it is up it takes the Enter meant for the title field.
    Its Close button accepts a synthetic click.
34. **The export renumbers ids.** The .pptx names shapes
    "Google Shape;54;p13" for the editor's `i0` on page `p`, so saved and
    live shapes are matched by position (slide number, shape z-order), never
    by id. Layouts export under API names (`TITLE_AND_BODY`); pptx.js maps
    Google's predefined ones to their menu names. `export/png?pageid=<pageId>`
    does take the editor's page ids.
35. **Exports are rate-limited.** Rapid .pptx exports get 429s. Verification
    waits for "Saved to Drive", looks immediately, then backs off; runs whose
    steps prove themselves (exact text, slide count, layout) take no
    before-snapshot; several replacements share one session and one check.

## Live testing

A harness is too large for one evaluate call, so load it through a file input.
Using openbrowser on a scratch-doc tab:

1. Create the file input with `browser_eval`:

   ```js
   const i=document.createElement('input');i.type='file';i.setAttribute('aria-label','harness loader');
   document.body.appendChild(i);i.onchange=async()=>{window.__harness=await i.files[0].text()}
   ```

2. `browser_find` "harness loader" to get its ref.
3. `browser_upload` the file produced by `node scripts/page-harness.mjs <suite> > file`.
4. Run it with `browser_eval`:

   ```js
   (0,eval)('(async()=>{'+body+'})()')
   ```

   `body` is the harness text with `return ` inserted before its last line.

Always use a fresh tab (under 4 minutes old). Never fetch localhost from a
Docs page: it triggers Chrome's local-network permission prompt.

For Slides, the raw operations are quicker to probe from the shell, through
the live extension, in hidden bridge tabs:

```bash
node server/index.js --reload-extension
node server/index.js --op slides_shapes '{"id":"<deck>"}'      # live slides + current slide's shapes
node server/index.js --op slides_deck '{"id":"<deck>"}'        # saved deck (parsed .pptx)
node server/index.js --op slides_run '{"id":"<deck>","steps":[{"slide":{"index":2}},{"shape":{"index":2}},{"setText":[{"html":"x","text":"x","list":null,"level":0}]}]}'
```

Use a scratch deck you own, never a real one. openbrowser's `browser_tabs new background:true` gives a hidden tab
for trying DOM ideas before putting them in slides-page.js.

## Rules

- **Verification must never pass vacuously.** A write counts only when the
  saved state changed, every probe is present, and requested formatting shows
  up on the target text.
- **Report `find_stalled` before editing anything.** A stalled `docs_edit` is
  only retried when no mutating step has completed.
- **Never edit in the user's own tabs.** Use only bridge tabs, and never
  activate them.
- **A typing job never guesses its position.** It retries automatically only
  when the page reported exactly where it stopped. A hang during the first
  chunk fails the job, because retrying would retype the start.
