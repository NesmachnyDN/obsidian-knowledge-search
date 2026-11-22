"""Regenerate purely synthetic fixtures, independently of extraction."""
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from docx import Document
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.utils import ImageReader

ROOT = Path(__file__).resolve().parent
FONT = Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
FIXED = datetime(2020, 1, 1, tzinfo=timezone.utc)


def make_docx(target):
    d = Document()
    d.core_properties.created = d.core_properties.modified = FIXED
    d.core_properties.author = 'Synthetic fixture'
    d.sections[0].header.paragraphs[0].text = 'Synthetic header'
    d.sections[0].footer.paragraphs[0].text = 'Synthetic footer'
    d.add_heading('Synthetic control policy', level=1)
    d.add_heading('1. Storage', level=2)
    d.add_paragraph('REQ-EX-101: Retain records for 30 days.')
    t = d.add_table(rows=3, cols=2)
    t.style = 'Table Grid'
    for row, values in zip(t.rows[:2], [('Control', 'Limit'), ('Retention', '30 days')]):
        for cell, value in zip(row.cells, values):
            cell.text = value
    t.cell(2, 0).merge(t.cell(2, 1)).text = 'Exception: test only'
    d.add_page_break()
    d.add_heading('2. Восстановление', level=2)
    d.add_paragraph('REQ-EX-102: Восстановление за 15 минут.')
    buf = BytesIO()
    d.save(buf)
    with ZipFile(buf) as src, ZipFile(target, 'w', ZIP_DEFLATED) as out:
        for name in sorted(src.namelist()):
            item = ZipInfo(name, (2020, 1, 1, 0, 0, 0))
            item.compress_type = ZIP_DEFLATED
            out.writestr(item, src.read(name))


def make_pdf(target):
    pdfmetrics.registerFont(TTFont('SyntheticSans', str(FONT)))
    c = Canvas(str(target), pagesize=(595, 842), invariant=1, pageCompression=1)
    def text(value, y, size=12, x=50):
        c.setFont('SyntheticSans', size)
        c.drawString(x, y, value)
    text('Synthetic header', 810, 10)
    text('Synthetic control policy', 760, 20)
    text('1. Storage', 720, 16)
    text('REQ-EX-101: Retain records for 30 days.', 690)
    for y in (650, 625, 600):
        c.line(50, y, 350, y)
    for x in (50, 200, 350):
        c.line(x, 600, x, 650)
    text('Control', 633, x=55)
    text('Limit', 633, x=205)
    text('Retention', 608, x=55)
    text('30 days', 608, x=205)
    text('Synthetic footer', 30, 10)
    c.showPage()
    text('Synthetic header', 810, 10)
    text('2. Восстановление', 760, 16)
    text('REQ-EX-102: Восстановление за 15 минут.', 720)
    text('Synthetic footer', 30, 10)
    c.showPage()
    c.save()


def make_scan(target):
    image = Image.new('L', (1800, 600), 255)
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(FONT), 55)
    draw.text((65, 120), 'REQ-OCR-301: Keep records for 30 days.', font=font, fill=0)
    draw.text((65, 270), 'REQ-OCR-302: Хранить записи 15 суток.', font=font, fill=0)
    compressed = BytesIO()
    image.save(compressed, 'JPEG', quality=65, optimize=True)
    compressed.seek(0)
    c = Canvas(str(target), pagesize=(540, 180), invariant=1, pageCompression=1)
    c.drawImage(ImageReader(compressed), 0, 0, width=540, height=180)
    c.showPage()
    c.save()


def generate(directory):
    directory.mkdir(parents=True, exist_ok=True)
    make_docx(directory / 'policy.docx')
    make_pdf(directory / 'policy.pdf')
    make_scan(directory / 'scan.pdf')
    (directory / 'malformed.pdf').write_bytes(b'%PDF-1.7\nsynthetic invalid input\n')
    return {'version': 1, 'font_sha256': sha256(FONT.read_bytes()).hexdigest(),
            'expectations_sha256': sha256((ROOT / 'expected.json').read_bytes()).hexdigest(),
            'sources': {p.name: {'sha256': sha256(p.read_bytes()).hexdigest(), 'bytes': p.stat().st_size}
                        for p in sorted(directory.iterdir()) if p.is_file()}}


if __name__ == '__main__':
    print(json.dumps(generate(ROOT / 'fixtures'), indent=2, sort_keys=True))
