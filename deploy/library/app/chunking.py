"""Structure-preserving projection of Docling JSON, with explicit review gaps."""
import re
from dataclasses import dataclass, field

CHAPTER = re.compile(r'^(?:chapter|cap[i\u00ed]tulo)\s+[\divxlcdm]+\b', re.I)
SECTION_NUMBER = re.compile(r'^(\d+(?:\.\d+)+)\s+\S')


@dataclass
class Chunk:
    chapter: str
    section: str
    heading_path: list[str]
    text: str
    page_start: int | None
    page_end: int | None
    kind: str = 'text'
    refs: list[str] = field(default_factory=list)


def resolve(document: dict, ref: str) -> dict:
    value = document
    for part in ref.removeprefix('#/').split('/'):
        value = value[int(part)] if isinstance(value, list) else value[part]
    return value


def table_text(item: dict) -> str:
    cells = item.get('data', {}).get('table_cells', [])
    if not cells:
        return item.get('text', '')
    rows: dict[int, list[tuple[int, str]]] = {}
    for cell in cells:
        row = int(cell.get('start_row_offset_idx', 0))
        col = int(cell.get('start_col_offset_idx', 0))
        rows.setdefault(row, []).append((col, str(cell.get('text', '')).replace('\n', ' ')))
    return '\n'.join(' | '.join(text for _, text in sorted(rows[row])) for row in sorted(rows))


def extract(document: dict, token_limit: int = 430, tokenizer=None) -> tuple[list[Chunk], dict]:
    """Keep each chunk within the embedding tokenizer budget, including headings."""
    chunks: list[Chunk] = []
    headings: list[str] = []
    chapter = 'Unassigned chapter'
    section = 'Unassigned section'
    explicit_chapters: set[str] = set()
    heading_count = 0
    inferred_headings: list[dict] = []
    missing_pages = False
    oversized_table = False
    seen: set[str] = set()
    sibling_scopes: set[str] = set()
    for candidate in document.get('texts', []):
        if candidate.get('label') != 'section_header':
            continue
        match = SECTION_NUMBER.match(str(candidate.get('text', '')))
        if match:
            sibling_scopes.add(match[1].rsplit('.', 1)[0])

    def walk(node: dict):
        ref = node.get('$ref')
        if ref:
            if ref in seen:
                return
            seen.add(ref)
            node = resolve(document, ref)
        if node.get('label'):
            yield node
        for child in node.get('children', []):
            yield from walk(child)

    def token_count(text: str) -> int:
        return len(tokenizer.encode(text, add_special_tokens=False)) if tokenizer else len(text.split()) * 2

    def split(text: str, budget: int):
        if tokenizer is not None:
            ids = tokenizer.encode(text, add_special_tokens=False)
            for offset in range(0, len(ids), budget):
                yield tokenizer.decode(ids[offset:offset + budget], skip_special_tokens=True)
        else:
            # Fallback is conservative; a worker with embeddings uses its actual tokenizer.
            words = text.split()
            for offset in range(0, len(words), max(1, budget // 2)):
                yield ' '.join(words[offset:offset + max(1, budget // 2)])

    root = document.get('body', {})
    for item in walk(root):
        label = item.get('label', '')
        if label in ('page_header', 'page_footer', 'picture'):
            continue
        text = table_text(item) if label == 'table' else str(item.get('text', '')).strip()
        if not text:
            continue
        inferred = False
        if label in ('list_item', 'text') and len(text) <= 160:
            marker = str(item.get('marker', '')).strip().rstrip('.)')
            original = str(item.get('orig', text)).strip()
            numbered = SECTION_NUMBER.match(original)
            number = numbered[1] if numbered else marker
            chapter_number = re.search(r'\b(\d+)\b', chapter)
            if (re.fullmatch(r'\d+(?:\.\d+)+', number)
                    and number.rsplit('.', 1)[0] in sibling_scopes
                    and (not chapter_number or number.split('.')[0] == chapter_number[1])):
                text = original if numbered else number + ' ' + text
                inferred = True
                inferred_headings.append({'source_ref': item.get('self_ref'), 'title': text,
                                          'reason': 'Numbered candidate agrees with explicit sibling section headings'})
        if label in ('section_header', 'title') or inferred:
            heading_count += 1
            level = number.count('.') + 1 if inferred else max(1, int(item.get('level') or 1))
            headings = headings[:level - 1] + [text]
            if CHAPTER.match(text):
                chapter, section = text, text
                explicit_chapters.add(text)
            else:
                section = text
            # Explicit headings are context. An inferred candidate must also remain
            # original source text in case the structure interpretation is wrong.
            if not inferred:
                continue
        pages = sorted({int(prov['page_no']) for prov in item.get('prov', []) if prov.get('page_no')})
        if not pages:
            missing_pages = True
        # Worker limits inherited heading context to 64 tokens, leaving this body budget whole.
        pieces: list[tuple[str, str]] = []
        if label == 'table':
            header = text.splitlines()[0]
            table_lines = text.splitlines()[1:]
            pending = header
            for line in table_lines:
                row = header + '\n' + line
                if token_count(row) > token_limit:
                    if pending != header:
                        pieces.append((pending, 'table'))
                    pieces.append((row, 'table_oversize'))
                    oversized_table = True
                    pending = header
                elif token_count(pending + '\n' + line) > token_limit:
                    pieces.append((pending, 'table'))
                    pending = row
                else:
                    pending += '\n' + line
            if pending != header or not table_lines:
                kind = 'table_oversize' if token_count(pending) > token_limit else 'table'
                oversized_table = oversized_table or kind == 'table_oversize'
                pieces.append((pending, kind))
        else:
            pieces = [(piece, label) for piece in split(text, token_limit)]
        for piece, kind in pieces:
            chunks.append(Chunk(chapter, section, headings.copy(), piece,
                                pages[0] if pages else None, pages[-1] if pages else None,
                                kind,
                                [item.get('self_ref', '')]))
    reasons = []
    if not explicit_chapters:
        reasons.append('Chapter boundaries need review: no explicit chapter headings were identified')
    if missing_pages:
        reasons.append('Some extracted content has no physical page provenance')
    if inferred_headings:
        reasons.append('Some numbered section headings were inferred from misclassified text/list items; review section boundaries')
    if oversized_table:
        reasons.append('Oversized table rows are preserved for full reading and lexical search; semantic indexing was skipped')
    if not chunks:
        reasons.append('No readable text was extracted; inspect OCR and document format')
    expected_pages = len(document.get('pages', {}))
    covered_pages = {p for c in chunks if c.page_start for p in range(c.page_start, c.page_end + 1)}
    if expected_pages and len(covered_pages) < expected_pages:
        reasons.append('Some pages have no indexed text; check blank, image-only or failed pages')
    return chunks, {'review_reason': '; '.join(reasons) or None, 'heading_count': heading_count,
                    'inferred_section_headings': inferred_headings,
                    'chapter_count': len(explicit_chapters), 'page_count': expected_pages,
                    'indexed_pages': sorted(covered_pages), 'printed_page_numbers': 'not_verified',
                    'numeric_values': 'require_original_page_review'}
