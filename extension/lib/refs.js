/**
 * Document references and Google URLs. Shared by the extension and the MCP
 * server (the server imports this file directly), so it must stay free of
 * both browser and Node APIs.
 */

const ID_RE = /^[a-zA-Z0-9_-]{25,}$/;

/**
 * Accept a bare document id or any docs.google.com / drive.google.com URL that
 * contains one. Returns {id, tab} or throws with a message a model can act on.
 */
export function parseDocRef(ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) throw new Error('doc is required: pass a Google Docs URL or document id');
  if (ID_RE.test(raw)) return { id: raw, tab: null };

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a Google Docs URL or document id: ${raw.slice(0, 120)}`);
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'docs.google.com' && host !== 'drive.google.com') {
    throw new Error(`not a Google Docs URL: ${url.hostname}`);
  }
  if (/\/presentation\//.test(url.pathname)) {
    throw new Error('that is a Google Slides link; use the slides_* tools (slides_read, slides_write, slides_edit, …) for presentations');
  }
  if (/\/(spreadsheets|forms|drawings)\//.test(url.pathname)) {
    throw new Error('that is a Sheets/Forms/Drawings link; this bridge edits Google Docs documents and Slides presentations only');
  }
  const m =
    url.pathname.match(/\/document\/(?:u\/\d+\/)?d\/(?:e\/)?([a-zA-Z0-9_-]{25,})/) ||
    url.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]{25,})/);
  const id = m?.[1] || url.searchParams.get('id');
  if (!id || !ID_RE.test(id)) throw new Error(`no document id in URL: ${raw.slice(0, 120)}`);
  const tab = url.searchParams.get('tab');
  return { id, tab: tab && /^t\.[a-z0-9]+$/i.test(tab) ? tab : null };
}

/**
 * Normalise the `account` argument: a Google account index (0, 1, ...) as
 * shown in /u/N/ URLs, or an email address. Google's `authuser` query
 * parameter accepts both.
 */
export function normalizeAccount(account) {
  if (account === undefined || account === null || account === '') return null;
  if (typeof account === 'number' || /^\d+$/.test(String(account))) {
    const n = Number(account);
    if (!Number.isInteger(n) || n < 0 || n > 9) throw new Error(`account index out of range: ${account}`);
    return String(n);
  }
  const email = String(account).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`account must be an index like 0 or 1, or an email address; got ${JSON.stringify(account)}`);
  }
  return email.toLowerCase();
}

function withAuthuser(url, account) {
  const a = normalizeAccount(account);
  if (a !== null) url.searchParams.set('authuser', a);
  return url;
}

export function editUrl(id, account) {
  return withAuthuser(new URL(`https://docs.google.com/document/d/${id}/edit`), account).toString();
}

export const EXPORT_FORMATS = {
  markdown: { param: 'md', mime: 'text/markdown', ext: 'md', text: true },
  text: { param: 'txt', mime: 'text/plain', ext: 'txt', text: true },
  html: { param: 'html', mime: 'text/html', ext: 'html', text: true },
  docx: { param: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx', text: false },
  pdf: { param: 'pdf', mime: 'application/pdf', ext: 'pdf', text: false },
  odt: { param: 'odt', mime: 'application/vnd.oasis.opendocument.text', ext: 'odt', text: false },
  rtf: { param: 'rtf', mime: 'application/rtf', ext: 'rtf', text: false },
  epub: { param: 'epub', mime: 'application/epub+zip', ext: 'epub', text: false },
};

export function exportUrl(id, format, { account, tab } = {}) {
  const f = EXPORT_FORMATS[format];
  if (!f) throw new Error(`unknown export format: ${format}`);
  const url = new URL(`https://docs.google.com/document/d/${id}/export`);
  url.searchParams.set('format', f.param);
  if (tab) url.searchParams.set('tab', tab);
  return withAuthuser(url, account).toString();
}

export function createUrl(account) {
  return withAuthuser(new URL('https://docs.google.com/document/create'), account).toString();
}

export function searchUrl(query, account) {
  const url = new URL('https://drive.google.com/drive/search');
  url.searchParams.set('q', `type:document ${query}`.trim());
  return withAuthuser(url, account).toString();
}

export function recentUrl(account) {
  return withAuthuser(new URL('https://docs.google.com/document/'), account).toString();
}

/** Where a response landed tells us more than its status: sign-in and access pages are 200s. */
export function classifyLanding(finalUrl, status, contentType = '') {
  let host = '';
  let path = '';
  try {
    const u = new URL(finalUrl);
    host = u.hostname;
    path = u.pathname;
  } catch {
    // leave empty
  }
  if (host === 'accounts.google.com' || /ServiceLogin|signin/i.test(path)) return 'signed_out';
  if (status === 401 || status === 403) return 'no_access';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'http_error';
  if (/\/(document|presentation)\/d\/[^/]+\/(edit|view)/.test(path) || /accessdenied|request-access/i.test(path)) return 'no_access';
  return 'ok';
}

/** Docs' "Make a copy" page; `title` names the copy (verified live). */
export function copyUrl(id, { title, account } = {}) {
  const url = new URL(`https://docs.google.com/document/d/${id}/copy`);
  if (title) url.searchParams.set('title', title);
  return withAuthuser(url, account).toString();
}

export function galleryUrl(account) {
  const url = new URL('https://docs.google.com/document/');
  url.searchParams.set('ftv', '1');
  url.searchParams.set('tgif', 'd');
  return withAuthuser(url, account).toString();
}

// ------------------------------------------------------------ Google Slides

/**
 * Accept a bare presentation id or any docs.google.com / drive.google.com URL
 * that contains one. Returns {id, slide}: `slide` is the page object id from a
 * `#slide=id.<page>` / `?slide=id.<page>` link (the editor's own deep link),
 * or null.
 */
export function parseDeckRef(ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) throw new Error('deck is required: pass a Google Slides URL or presentation id');
  if (ID_RE.test(raw)) return { id: raw, slide: null };

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a Google Slides URL or presentation id: ${raw.slice(0, 120)}`);
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'docs.google.com' && host !== 'drive.google.com') {
    throw new Error(`not a Google Slides URL: ${url.hostname}`);
  }
  if (/\/document\//.test(url.pathname)) {
    throw new Error('that is a Google Docs link; use the docs_* tools for documents');
  }
  if (/\/(spreadsheets|forms|drawings)\//.test(url.pathname)) {
    throw new Error('that is a Sheets/Forms/Drawings link; the slides_* tools edit Google Slides presentations only');
  }
  const m =
    url.pathname.match(/\/presentation\/(?:u\/\d+\/)?d\/(?:e\/)?([a-zA-Z0-9_-]{25,})/) ||
    url.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]{25,})/);
  const id = m?.[1] || url.searchParams.get('id');
  if (!id || !ID_RE.test(id)) throw new Error(`no presentation id in URL: ${raw.slice(0, 120)}`);
  const slideParam = url.searchParams.get('slide') || new URLSearchParams(url.hash.replace(/^#/, '')).get('slide');
  const page = slideParam?.match(/^id\.([A-Za-z0-9_-]{1,100})$/)?.[1] || null;
  return { id, slide: page };
}

export function slidesEditUrl(id, account, page = null) {
  const url = withAuthuser(new URL(`https://docs.google.com/presentation/d/${id}/edit`), account);
  if (page) url.hash = `slide=id.${page}`;
  return url.toString();
}

/**
 * Slides export formats. `page: true` formats render one slide and need its
 * page object id (`pageid`); without one Google renders the first slide.
 */
export const SLIDES_EXPORT_FORMATS = {
  pptx: { param: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx', text: false },
  pdf: { param: 'pdf', mime: 'application/pdf', ext: 'pdf', text: false },
  odp: { param: 'odp', mime: 'application/vnd.oasis.opendocument.presentation', ext: 'odp', text: false },
  text: { param: 'txt', mime: 'text/plain', ext: 'txt', text: true },
  png: { param: 'png', mime: 'image/png', ext: 'png', text: false, page: true },
  jpeg: { param: 'jpeg', mime: 'image/jpeg', ext: 'jpg', text: false, page: true },
  svg: { param: 'svg', mime: 'image/svg+xml', ext: 'svg', text: true, page: true },
};

export function slidesExportUrl(id, format, { account, page } = {}) {
  const f = SLIDES_EXPORT_FORMATS[format];
  if (!f) throw new Error(`unknown Slides export format: ${format}`);
  const url = new URL(`https://docs.google.com/presentation/d/${id}/export/${f.param}`);
  if (f.page && page) url.searchParams.set('pageid', page);
  return withAuthuser(url, account).toString();
}

export function slidesCreateUrl(account) {
  return withAuthuser(new URL('https://docs.google.com/presentation/create'), account).toString();
}

export function slidesSearchUrl(query, account) {
  const url = new URL('https://drive.google.com/drive/search');
  url.searchParams.set('q', `type:presentation ${query}`.trim());
  return withAuthuser(url, account).toString();
}

export function slidesRecentUrl(account) {
  return withAuthuser(new URL('https://docs.google.com/presentation/'), account).toString();
}

/** Slides' "Make a copy" page; `title` names the copy. */
export function slidesCopyUrl(id, { title, account } = {}) {
  const url = new URL(`https://docs.google.com/presentation/d/${id}/copy`);
  if (title) url.searchParams.set('title', title);
  return withAuthuser(url, account).toString();
}
