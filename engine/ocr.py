"""Explicit local Tesseract OCR profile; no inferred PDF byte locators."""
import csv
from io import BytesIO, StringIO
from pathlib import Path
import re
import subprocess

from engine.document import NativeAnchor, NativeLocation, ParsedBlock, ParsedDocument

MAX_PIXELS = 16_000_000
MAX_WORDS_PER_PAGE = 8192
CLAUSE = re.compile(r'^(REQ-[A-Za-z0-9-]+):')


def _lines(image, tessdata):
    if not isinstance(tessdata, Path) or not tessdata.is_absolute():
        raise ValueError('explicit local tessdata directory required')
    if any(not (tessdata / (lang + '.traineddata')).is_file() for lang in ('eng', 'rus')):
        raise ValueError('missing OCR language assets')
    encoded = BytesIO()
    image.save(encoded, 'PNG')
    result = subprocess.run(
        ['/usr/bin/tesseract', 'stdin', 'stdout', '--tessdata-dir', str(tessdata),
         '-l', 'eng+rus', '--psm', '6', '-c', 'tessedit_create_tsv=1'],
        input=encoded.getvalue(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        timeout=20, check=True, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
                                    'OMP_THREAD_LIMIT': '1'})
    if len(result.stdout) > 2 * 1024 * 1024:
        raise ValueError('OCR output bound')
    groups = {}
    count = 0
    rows = csv.DictReader(StringIO(result.stdout.decode('utf-8')), delimiter='\t')
    if not {'level', 'text', 'left', 'top', 'width', 'height', 'block_num', 'par_num', 'line_num'} <= set(rows.fieldnames or []):
        raise ValueError('invalid OCR TSV schema')
    for row in rows:
        if row['level'] != '5' or not row['text'].strip():
            continue
        count += 1
        if count > MAX_WORDS_PER_PAGE:
            raise ValueError('OCR word bound')
        x, y, w, h = [int(row[k]) for k in ('left', 'top', 'width', 'height')]
        if not (0 <= x < x+w <= image.width and 0 <= y < y+h <= image.height):
            raise ValueError('OCR geometry bound')
        key = tuple(int(row[k]) for k in ('block_num', 'par_num', 'line_num'))
        groups.setdefault(key, []).append((row['text'], (x, y, x+w, y+h)))
    for key, words in groups.items():
        boxes = [box for _, box in words]
        yield key, ' '.join(text for text, _ in words), (
            min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def extract_scan(data, path, digest, profile, tessdata):
    import pypdfium2
    pdf = pypdfium2.PdfDocument(data)
    blocks = []
    issues = {'ocr-layout-and-table-structure-not-inferred'}
    try:
        count = len(pdf)
        for index in range(count):
            page = pdf[index]
            try:
                width, height = page.get_size()
                scale = 3
                if width * height * scale**2 > MAX_PIXELS:
                    raise ValueError('OCR raster bound')
                bitmap = page.render(scale=scale)
                try:
                    image = bitmap.to_pil().convert('L')
                    try:
                        lines = list(_lines(image, tessdata))
                        if not lines:
                            issues.add('ocr-page-without-text')
                        for key, text, box in lines:
                            x,y,r,b = box
                            coords = (x*width/image.width, y*height/image.height,
                                      r*width/image.width, b*height/image.height)
                            location = NativeLocation(index+1, coords, 'TOPLEFT')
                            anchor = NativeAnchor('ocr/page/%d/%s' % (index+1, '/'.join(map(str,key))),
                                                  'body', 'ocr-text', (location,))
                            match = CLAUSE.match(text)
                            blocks.append(ParsedBlock(path, digest, len(blocks),
                                                      'clause' if match else 'paragraph', text,
                                                      None, (), clause=match[1] if match else None,
                                                      page=index+1, bbox=coords, native=anchor))
                    finally:
                        image.close()
                finally:
                    bitmap.close()
            finally:
                page.close()
    finally:
        pdf.close()
    # A successfully processed document without OCR text is empty, not failed.
    return ParsedDocument(path, digest, 'partial' if blocks else 'empty', tuple(blocks),
                          tuple(sorted(issues if blocks else issues | {'no-extracted-text'})),
                          extraction_profile=profile, page_count=count)
