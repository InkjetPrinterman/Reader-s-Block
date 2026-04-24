// ── OPDS / Atom Feed Parser ───────────────────────────────────────────────────
// Converts raw XML text from Project Gutenberg's OPDS endpoint into plain JS
// objects the UI can consume directly.
//
// Namespace URIs used by Gutenberg's feed:
//   Atom  — http://www.w3.org/2005/Atom          (base feed structure)
//   DC    — http://purl.org/dc/terms/             (Dublin Core metadata)
//   OPDS  — http://opds-spec.org/2010/catalog     (acquisition links)

const NS = {
  atom : 'http://www.w3.org/2005/Atom',
  dc   : 'http://purl.org/dc/terms/',
  opds : 'http://opds-spec.org/2010/catalog',
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse raw XML text into a feed descriptor.
 * @param  {string} xmlText
 * @returns {{ title: string, entries: Entry[], navLinks: NavLink[] }}
 */
export function parseFeed(xmlText) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xmlText, 'application/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error('Invalid XML: ' + parseError.textContent.slice(0, 120));

  const feedTitle = text(doc, 'feed > title') || 'Gutenberg Catalog';
  const entryEls  = [...doc.getElementsByTagNameNS(NS.atom, 'entry')];

  const entries  = [];
  const navLinks = [];

  for (const el of entryEls) {
    const links = [...el.getElementsByTagNameNS(NS.atom, 'link')];

    // Distinguish navigation entries (sub-catalogs) from book entries
    const isNavEntry = links.some(l =>
      l.getAttribute('type')?.includes('navigation') ||
      l.getAttribute('rel') === 'subsection'
    );

    if (isNavEntry) {
      navLinks.push(parseNavEntry(el, links));
    } else {
      entries.push(parseBookEntry(el, links));
    }
  }

  return { title: feedTitle, entries, navLinks };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function parseBookEntry(el, links) {
  // Acquisition links — EPUB preferred, fallback to any other format
  const acquisitionLinks = links
    .filter(l => l.getAttribute('rel')?.startsWith('http://opds-spec.org/acquisition'))
    .map(l => ({
      href   : l.getAttribute('href'),
      type   : l.getAttribute('type') || 'unknown',
      label  : formatLabel(l.getAttribute('type')),
    }));

  // Cover image
  const coverLink = links.find(l =>
    l.getAttribute('rel') === 'http://opds-spec.org/image' ||
    l.getAttribute('rel') === 'http://opds-spec.org/image/thumbnail'
  );

  // Prefer DC creator; fall back to Atom author
  const authorEl = el.getElementsByTagNameNS(NS.dc, 'creator')[0]
    || el.getElementsByTagNameNS(NS.atom, 'author')[0];
  const author = authorEl
    ? (authorEl.getElementsByTagNameNS(NS.atom, 'name')[0]?.textContent || authorEl.textContent)
    : 'Unknown';

  // Summary: try <content>, then <summary>
  const summary =
    el.getElementsByTagNameNS(NS.atom, 'content')[0]?.textContent?.trim() ||
    el.getElementsByTagNameNS(NS.atom, 'summary')[0]?.textContent?.trim() ||
    '';

  // Subject tags
  const subjects = [...el.getElementsByTagNameNS(NS.dc, 'subject')]
    .map(s => s.textContent.trim())
    .filter(Boolean);

  // Language
  const language = el.getElementsByTagNameNS(NS.dc, 'language')[0]?.textContent?.trim() || '';

  // Extract the numeric Gutenberg book ID from the <id> element.
  // The OPDS feed uses URN format: "urn:gutenberg:84:3" or path format:
  // "https://www.gutenberg.org/ebooks/84" — in both cases the numeric ID
  // is the first unbroken run of digits we can find.
  const idText = el.getElementsByTagNameNS(NS.atom, 'id')[0]?.textContent || '';
  const bookId = extractNumericId(idText);

  return {
    kind            : 'book',
    id              : bookId,
    title           : text(el, 'title')   || 'Untitled',
    author,
    summary,
    subjects,
    language,
    coverUrl        : coverLink ? absoluteUrl(coverLink.getAttribute('href')) : null,
    acquisitionLinks,
    gutenbergUrl    : `https://www.gutenberg.org/ebooks/${bookId}`,
  };
}

/**
 * Extract the primary numeric Gutenberg book ID from an <id> string.
 *
 * Formats seen in the wild:
 *   "urn:gutenberg:84:3"                        → "84"
 *   "https://www.gutenberg.org/ebooks/84"       → "84"
 *   "https://www.gutenberg.org/ebooks/84/also/" → "84"
 *   "84"                                        → "84"
 *
 * Strategy: find the first sequence of digits in the string.
 * The book ID always comes before any sub-ID (the ":3" edition suffix
 * in the URN, or sub-paths in a URL).
 */
function extractNumericId(idText) {
  if (!idText) return idText;
  const m = idText.match(/(\d+)/);
  return m ? m[1] : idText; // fall back to raw string if no digits found
}

function parseNavEntry(el, links) {
  const navLink = links.find(l =>
    l.getAttribute('rel') === 'subsection' ||
    l.getAttribute('type')?.includes('navigation') ||
    l.getAttribute('type')?.includes('acquisition')
  ) || links[0];

  return {
    kind    : 'nav',
    title   : text(el, 'title') || 'Browse',
    summary : text(el, 'summary') || text(el, 'content') || '',
    href    : navLink ? absoluteUrl(navLink.getAttribute('href')) : null,
  };
}

// ── Utility ───────────────────────────────────────────────────────────────────

function text(parent, localName) {
  const tagName = localName.includes('>') ? localName.split('>').pop().trim() : localName;
  const el = parent.querySelector
    ? parent.querySelector(localName)
    : parent.getElementsByTagNameNS(NS.atom, tagName)[0];
  return el?.textContent?.trim() || '';
}

function absoluteUrl(href) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  return 'https://www.gutenberg.org' + href;
}

function formatLabel(mimeType) {
  if (!mimeType) return 'Download';
  if (mimeType.includes('epub'))  return 'EPUB';
  if (mimeType.includes('mobi') || mimeType.includes('kindle')) return 'Kindle';
  if (mimeType.includes('pdf'))   return 'PDF';
  if (mimeType.includes('html'))  return 'HTML';
  if (mimeType.includes('txt'))   return 'Text';
  return 'Download';
}
