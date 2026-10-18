# Docs Bridge

[![test](https://github.com/dylansantwani/docs-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/dylansantwani/docs-bridge/actions/workflows/test.yml)

Docs Bridge is an MCP server that lets agents read, write, format, and fill in
Google Docs — and read, build, edit, fill and export Google Slides decks — as
you. It runs through your own signed-in Chrome, so it needs no
API keys, no OAuth app, no Google Cloud project, and never copies cookies.

It works the Docs editor the way a person does. It selects text, types,
presses the shortcuts, and uses the toolbar and menus, all in a background tab
that never takes focus. So it can do what you can: headings in the
document's own styles, bullet and numbered lists, tables, fonts, colors, page
breaks, any menu command, and templates.

It has two parts:

- `extension/` is a Manifest V3 Chrome extension that runs in your real Chrome
  profile.
- `server/` is a zero-dependency Node MCP server (stdio). Every MCP client on
  the machine can launch it. They all share one loopback hub, and the
  extension connects to that hub.

## Install

Needs Node 20+ and Chrome 121+ (or another Chromium browser that loads
unpacked MV3 extensions). The server has no dependencies, so there is nothing
to `npm install` unless you want the end-to-end tests.

1. Clone the repo:

   ```bash
   git clone https://github.com/dylansantwani/docs-bridge.git
   ```

2. In `chrome://extensions`, turn on Developer mode, click **Load unpacked**,
   and pick the `extension/` folder. The extension id is pinned to
   `nkfcgpojlaedgadaoopckngjoheified` by the manifest's public key, and the
   server accepts only that origin. After pulling new code, click the
   extension's reload icon (or run `node server/index.js --reload-extension`).
3. Register the server with your MCP clients. For Claude Code:

   ```bash
   claude mcp add docs-bridge -s user -- node /path/to/docs-bridge/server/index.js
   ```

   For clients configured with JSON (Claude Desktop, Cursor, and others):

   ```json
   {
     "mcpServers": {
       "docs-bridge": {
         "command": "node",
         "args": ["/path/to/docs-bridge/server/index.js"]
       }
     }
   }
   ```

4. Check the connection:

   ```bash
   node /path/to/docs-bridge/server/index.js --health
   ```

Docs Bridge was built and verified live on macOS. Shortcuts map Cmd to Ctrl on
other systems, but Windows and Linux have not been tested against the live
editor.

## Tools

| Tool | What it does |
|---|---|
| `docs_read` | Reads a doc as markdown, text, or html. `structure` gives an outline: title, headings and sections, list items with nesting, tables with cells, images, and placeholders such as `{{name}}` or `[Date]` |
| `docs_write` | Types markdown in the document's own styles. Modes: `append`, `prepend`, `replace_document`, `insert_after`, `insert_before`, `replace_text`, and `replace_section` (replace everything under a heading) |
| `docs_format` | Formats existing text, a section, or the whole doc: bold, italic, underline, strikethrough, super/subscript, font, size, color, highlight, link, heading/title/subtitle/normal style, alignment, lists, indent, line spacing |
| `docs_edit` | Runs a sequence of human-style steps: find/select, move the caret, select paragraphs or sections, type, delete, press keys, format, run any menu command by path (e.g. `Format > Table > Insert row below`), undo |
| `docs_replace` | Runs Docs' own Find and replace |
| `docs_type` | Types like a person: one keystroke at a time at a human pace, with rhythm, thinking pauses, and typos fixed with Backspace. Same positions as `docs_write`; long text keeps typing in the background |
| `docs_typing` | Status, list, wait, pause, resume, or cancel `docs_type` jobs |
| `docs_fill` | Fills a template: text replacements (placeholders or sample text, keeping their formatting) plus whole sections replaced by heading |
| `docs_templates` | Lists Google's template gallery (resumes, letters, proposals, meeting notes, newsletters…) |
| `docs_create` | Creates a blank doc (with an optional markdown body), or a named copy of a gallery template or any doc |
| `docs_copy` | Makes a copy of any doc with a new title |
| `docs_list` | Lists recent docs, or runs a Drive search |
| `docs_rename`, `docs_export`, `docs_open`, `docs_status` | Rename a doc; save it as docx/pdf/odt/rtf/epub/md/txt/html; open it for you; check the connection |

### Google Slides

| Tool | What it does |
|---|---|
| `slides_read` | Reads a deck as saved in Drive. `outline` (default): every slide with its layout, numbered shapes (role — title, subtitle, body —, position in points, text as markdown with bullet nesting), tables, images and speaker notes. Also `text` and `json`; `slides: "2-5"` picks slides |
| `slides_write` | Adds slides (layout, title, subtitle, body, notes) or changes existing ones: any of those, other shapes by number, skip, move, duplicate, delete. Body markdown bullets, numbering and nesting become real Slides lists, typed in the theme's own styles |
| `slides_create` | Creates a deck — blank or copied from any template deck — and fills it with slides in the same call |
| `slides_replace` | Slides' own Find and replace; `replacements: {…}` fills a template's placeholders in one call; `occurrence` replaces one match |
| `slides_edit` | Human steps for anything else: go to a slide, select a shape (by number or role), select text in it, type, format (bold, italic, size, font, colour, lists, alignment), keys, any menu command (`Slide > Change background`, `Arrange > Order > Bring to front`), undo |
| `slides_type` | Types into a title, subtitle, body, any shape or the speaker notes like a person — keystroke by keystroke, same rhythm/pause/typo model and profiles as `docs_type` |
| `slides_export` | pptx, pdf, odp, txt, or one slide as png/jpeg/svg |
| `slides_list`, `slides_copy`, `slides_rename`, `slides_open` | As for docs |

Every tool takes `account`, either an index as in `/u/N/` URLs or an email
address, for a second signed-in account such as school.

A typical template flow:

```
docs_create  { title: "Weekly sync 10/1", template: "Meeting notes (Tropic)" }
docs_read    { doc: <id>, format: "structure" }      # see its sections and sample text
docs_fill    { doc: <id>,
               replace:  { "Annual Board Meeting": "Weekly Team Sync", "Friday, 09.04.20XX": "Wednesday, Oct 1" },
               sections: { "Attendees": "Dylan Santwani\n\nPat Doe", "Action Items": "- [ ] Ship the bridge" } }
docs_format  { doc: <id>, text: "Ship the bridge", format: { bold: true, color: "red" } }
```

Every change is verified. After a write, the extension polls the document as
saved in Drive until it shows the change. For formatting, it also checks the
formatting itself: bold, sizes, fonts, colors, links, paragraph styles,
alignment, and lists are read back from the saved copy. If something doesn't
show up, the result says NOT verified and names what's missing.

A typical Slides flow:

```
slides_create  { title: "Q4 kickoff", slides: [
                   { title: "Q4 kickoff", subtitle: "Team sync · Oct 14" },
                   { title: "Goals", body: "- Ship Slides support\n  - read, write, type\n- Fix the backlog", notes: "Keep it short" },
                   { layout: "Title and two columns", title: "Now vs next", shapes: { "2": "**Now**\n- …", "3": "**Next**\n- …" } } ] }
slides_read    { deck: <id> }                                   # numbered shapes, roles, notes
slides_write   { deck: <id>, slides: [ { slide: 2, body: "- Ship it" }, { after: 2, layout: "Section header", title: "Details" } ] }
slides_replace { deck: <id>, replacements: { "{{name}}": "Dylan", "{{date}}": "Oct 14" } }
slides_edit    { deck: <id>, steps: [ { slide: 2 }, { shape: "body" }, { selectText: "Ship it" }, { format: { bold: true, color: "red" } } ] }
slides_type    { deck: <id>, slide: 3, shape: "notes", mode: "append", text: "Typed like a person." }
```

Slide changes are checked against the deck as saved in Drive: the exported
.pptx, parsed in the extension, must show the typed text in the right shape of
the right slide, the speaker notes, the slide count and layouts; formatting,
moves and menu commands must change the saved deck.

## Typing like a person

`docs_type` puts text in the way a person at the keyboard would, instead of
pasting it. Every character is a real key press in the editor, so Docs'
own autocorrect (smart quotes, list and link detection, capitalisation)
applies, and the document's revision history fills in keystroke by
keystroke.

```
docs_type   { doc: <id>, mode: "append", markdown: "## Notes\n\nFirst **draft** of the intro…" }
docs_type   { doc: <id>, text: "…", profile: "careful", wpm: 40, pauses: 1.5 }
docs_typing { action: "status" }        # progress, ETA, verification
docs_typing { action: "pause" }         # stops at the end of the current word
docs_typing { action: "resume" }
```

- **Rhythm.** A base interval from `wpm` (5 keys per word) with log-normal
  jitter and a slow drift. Common letter pairs are faster; capitals, digits,
  and punctuation are slower.
- **Pauses.** After sentences and commas, before each paragraph (the
  longest), and the odd hesitation mid-sentence or before a long word.
  `pauses` scales them (0 turns them off).
- **Typos.** A neighbouring key, swapped letters, a doubled or skipped
  letter. The typist notices after 0–3 more letters, backspaces and retypes.
  A typo is always fixed before its word ends, because Docs autocorrects a
  misspelled word when its space is typed.
- **Formatting.** Headings and lists use Docs' shortcuts, bold, italic, and
  strikethrough are toggled with Cmd+B, Cmd+I, and Cmd+Shift+X while typing.
  Links, code, and emoji can't be typed, so they are pasted.
- **Tables.** A tab in `markdown` presses the Tab key, which moves to the
  next table cell. To fill an empty table, put a placeholder in its first
  cell and `replace_text` it with the cells separated by tabs
  (`"Parameter\tUnits\t…"`); continue later with `replace_text` on the last
  cell typed (`"8.5\tpH\t…"`), retyping it so the text never starts with a
  tab (markdown would read that as code). `text` still turns tabs into
  spaces. Pasted tables get full-width columns and borders, so an empty
  table is ready to type into.
- **Profiles.** `natural` (55 wpm, 2% typos), `careful` (38 wpm, 0.8%),
  `fast` (85 wpm, 3%), `steady` (60 wpm, no typos, few pauses). `wpm`,
  `typos` (false or a rate per letter), `pauses`, and `seed` override them.
- **Long text.** Under two minutes of typing, the call waits and reports the
  verified result. Longer text runs as a job in the extension and keeps
  going after the call returns, even if the MCP client exits. It types in
  chunks of up to 90 s. Each fresh background tab gets about four minutes
  before Chrome throttles it, so the job moves to a new tab and finds its
  place again: at the end of the document, or by Find on the text typed so
  far in the paragraph. Before it leaves a tab, it waits for Drive to save.
  Jobs are saved after every chunk. If the extension restarts in the middle
  of one, the job shows as interrupted and can be resumed.
- **Verified.** When a job finishes, the saved document must contain its
  text. Letters and digits are compared, since autocorrect changes quotes
  and dashes.

Don't edit the spot being typed into while a job runs. Other docs_* calls
on the same document are fine: they run between chunks, and the job finds
its place again afterwards.

## How it works

Everything happens in a background tab that is never activated. These tabs
are kept in a collapsed "Docs Bridge" tab group.

- **Typing in the document's styles.** New content is typed block by block.
  Each paragraph gets its style with the real shortcut (Cmd+Alt+2 for Heading
  2), lists are started with Cmd+Shift+8/7/9 and nested with Tab, and text
  arrives as an inline paste. That way it takes the document's own heading,
  body, and list styles, which matters for templates. Pasting whole blocks of
  HTML would instead bring in browser-default styling.
- **Selecting like a person.** Text is selected through Docs' own Find and
  replace. Paragraph moves and selections use Alt+Up/Down.
- **Toolbar and menus.** These respond to synthetic mouse events. The toolbar
  also reports the caret's style, font, size, and list state.
- **Reading.** Reads use Docs' export endpoint, fetched from the service
  worker. Writes are checked against the saved copy at `/mobilebasic`.
- **Slides.** The same editor family: keys and pastes go to the same hidden
  input, shapes are SVG groups (`#editor-<objectId>`) that select on a
  synthetic click, Enter puts the caret in a shape's text, and Slides' own
  copy handler, fed a synthetic `copy` event with a private DataTransfer,
  returns the exact text of what is selected — so every write is read back
  without touching your clipboard, and nothing is pasted unless the caret is
  confirmed to be in text (a stray paste would create a new text box). Slides
  are reached through the filmstrip, layouts through Slide > Apply layout,
  notes through Cmd+Alt+Shift+S. Reads parse the exported .pptx (a small zip
  and XML reader, no dependencies).

`AGENTS.md` lists every Docs behavior this depends on. All of them were
verified live, including the background-tab timer throttling the code works
around.

## Security

- The hub listens on 127.0.0.1 only.
- The `/ext` endpoint accepts only the pinned extension origin, so web pages
  can't connect.
- Peer servers on `/mcp` need the 0600 token in `~/.docs-bridge/token`, and
  any request that carries an Origin header is refused.
- Non-loopback Host headers are refused.
- The extension's host access is limited to docs.google.com, drive.google.com,
  and googleusercontent.com.

## Limits

- **No comments yet, and no switching to suggesting mode.** If your mode in a
  doc is Suggesting, edits land as suggestions.
- **Sections that contain a table** can't be replaced as a whole. Edit them
  with anchors, or with `docs_edit` plus Tab between cells.
- **Colors and fonts outside the palette or font menu** are applied by
  re-pasting the found text, which drops other formatting inside that text.
- **Speed:** each anchored step takes about 1–3 s, because Chrome aligns
  background-tab timers to one-second boundaries.
- **Typing jobs** need Chrome running with the extension. If a tab hangs
  mid-chunk, the job is interrupted. Resuming it may retype the last few
  words from that chunk, so read the document first.
- **Drive storage:** if your Drive is full, new docs and copies fail.
- **Slides:** no images, charts, new text boxes or shape positioning yet
  (use `slides_edit` with menus for what the menus can do). Shapes are
  addressed by number and role; the export renumbers object ids, so ids from
  the editor are not shown. Replacing a box whose old text began with manual
  bold keeps that bold for the first new word (the caret's style after
  deleting). Google rate-limits exports under heavy use; reads and checks
  retry with backoff. Speaker notes are verified from the saved deck, since
  the notes panel can be collapsed.

## Development

```bash
npm test                 # 275 unit/protocol tests, no browser
npm run test:e2e         # real Chromium + the extension + live docs.google.com (signed out, public doc and deck)
node scripts/page-harness.mjs write     > /tmp/h.js   # self-tests to run inside a SCRATCH doc
node scripts/page-harness.mjs template  > /tmp/h.js   # …inside a copy of "Meeting notes (Tropic)"
node scripts/page-harness.mjs type      > /tmp/h.js   # human typing, chunk stop + resume by Find
node server/index.js --call docs_type '{"doc":"<id>","text":"hello"}'   # any tool from the shell
node server/index.js --op slides_deck '{"id":"<deck id>"}'          # one raw extension operation, as JSON
node server/index.js --reload-extension   # load new extension code (refused while a typing job runs)
```

A harness is too large to paste in one go, so load it through a file input.
With openbrowser: add an `<input type=file>` to the page, attach the file with
`browser_upload`, then `(0, eval)` its text. `AGENTS.md` describes the steps.
