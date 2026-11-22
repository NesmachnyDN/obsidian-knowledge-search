"""Explicit, bounded extraction profiles for the synthetic document experiment.

Run in an isolated process tree and a network namespace. No profile is a
fallback for another, and no model is downloaded by this module.
"""
from hashlib import sha256
from io import BytesIO
from pathlib import PurePosixPath
import stat
from zipfile import ZipFile

from engine.document import ParsedDocument
from engine.native_document import furniture_kind, map_document
from engine.scope import ScopedReader

# PoC input budget matches the existing scoped-reader ceiling, not a proposed
# production PDF/DOCX maximum. Larger files require a separate scope decision.
MAX_BYTES = 65536
MAX_PAGES = 8
MAX_PAGE_POINTS = 2000
MAX_ZIP_ENTRIES = 256
MAX_ZIP_EXPANDED = 8 * 1024 * 1024
DOCX = 'docling-docx-2.151.1'
PDF = 'docling-native-pdf-2.151.1'
OCR = 'tesseract-cli-5.3.4-eng-rus'
STRUCTURED_PDF = 'docling-heron-tableformer-fast-2.151.1'
STRUCTURED_SCAN = 'docling-heron-tableformer-fast-tesseract-2.151.1'


def _docx_preflight(data):
    from defusedxml.ElementTree import fromstring

    with ZipFile(BytesIO(data)) as archive:
        entries = archive.infolist()
        names = set()
        if len(entries) > MAX_ZIP_ENTRIES or sum(i.file_size for i in entries) > MAX_ZIP_EXPANDED:
            raise ValueError('docx expansion bound')
        for item in entries:
            name = item.filename
            if (name in names or name.startswith('/') or '\\' in name or ':' in name
                    or '..' in PurePosixPath(name).parts or item.flag_bits & 1
                    or stat.S_ISLNK(item.external_attr >> 16)):
                raise ValueError('unsafe archive entry')
            names.add(name)
            if name.endswith('.rels'):
                root = fromstring(archive.read(item))
                if any(e.get('TargetMode', '').casefold() == 'external' for e in root):
                    raise ValueError('external document relationship')
            if name.endswith('vbaProject.bin'):
                raise ValueError('active document content')
        if 'word/document.xml' not in names or '[Content_Types].xml' not in names:
            raise ValueError('invalid DOCX')
        return bool(any(n.startswith(('word/header', 'word/footer')) and n.endswith('.xml')
                        for n in names))


def _pdf_preflight(data):
    from pypdf import PdfReader

    if not data.startswith(b'%PDF-'):
        raise ValueError('invalid PDF signature')
    reader = PdfReader(BytesIO(data), strict=True)
    if reader.is_encrypted or not 1 <= len(reader.pages) <= MAX_PAGES:
        raise ValueError('encrypted or out-of-bound PDF')
    for page in reader.pages:
        if not (0 < float(page.mediabox.width) <= MAX_PAGE_POINTS
                and 0 < float(page.mediabox.height) <= MAX_PAGE_POINTS):
            raise ValueError('PDF page geometry bound')
    return len(reader.pages)


def _docling(data, path, digest, profile, artifacts=None, tessdata=None):
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import NativePdfPipelineOptions
    from docling.document_converter import DocumentConverter, NativePdfFormatOption
    from docling_core.types.io import DocumentStream
    from docling_core.types.doc import ContentLayer

    diagnostics = []
    if profile == DOCX:
        has_furniture = _docx_preflight(data)
        converter = DocumentConverter(allowed_formats=[InputFormat.DOCX])
    elif profile in (STRUCTURED_PDF, STRUCTURED_SCAN):
        from engine.structured_pdf import structured_converter
        page_count = _pdf_preflight(data)
        converter = structured_converter(artifacts, tessdata, profile == STRUCTURED_SCAN)
    else:
        page_count = _pdf_preflight(data)
        diagnostics.append('native-pdf-layout-tables-reading-order-not-inferred')
        options = NativePdfPipelineOptions(parser_threads=1, generate_page_images=False,
                                           generate_picture_images=False, document_timeout=20)
        converter = DocumentConverter(
            allowed_formats=[InputFormat.PDF],
            format_options={InputFormat.PDF: NativePdfFormatOption(pipeline_options=options)})
    result = converter.convert(DocumentStream(name=PurePosixPath(path).name, stream=BytesIO(data)),
                               raises_on_error=False, max_num_pages=MAX_PAGES,
                               max_file_size=MAX_BYTES)
    status = result.status.value
    if status not in ('success', 'partial_success'):
        return ParsedDocument(path, digest, 'failed', (), ('docling-conversion-failed',),
                              extraction_profile=profile)
    if status == 'partial_success' or result.errors:
        diagnostics.append('docling-partial-or-diagnostics')
    if profile != DOCX and len(result.document.pages) != page_count:
        diagnostics.append('pdf-page-count-mismatch')
    if profile == DOCX and has_furniture:
        labels = {furniture_kind(item, result.document) or item.label.value for item, _ in result.document.iterate_items(
            included_content_layers=set(ContentLayer))}
        if not {'page_header', 'page_footer'} <= labels:
            diagnostics.append('docx-furniture-not-fully-classified')
    return map_document(result.document, path, digest, profile, diagnostics)


def extract(reader: ScopedReader, path: str, profile: str, tessdata=None, artifacts=None) -> ParsedDocument:
    """Never implicitly downgrade a requested extraction profile."""
    try:
        source = reader.read(path, MAX_BYTES)
    except (OSError, ValueError):
        return ParsedDocument(path, None, 'failed', (), ('source-read-rejected',),
                              extraction_profile=profile)
    if (profile == DOCX and not path.lower().endswith('.docx')
            or profile in (PDF, OCR, STRUCTURED_PDF, STRUCTURED_SCAN) and not path.lower().endswith('.pdf')
            or profile not in (DOCX, PDF, OCR, STRUCTURED_PDF, STRUCTURED_SCAN)):
        return ParsedDocument(path, source.digest, 'unsupported', (), ('format-profile-mismatch',),
                              extraction_profile=profile)
    try:
        if profile == OCR:
            from engine.ocr import extract_scan
            _pdf_preflight(source.data)
            return extract_scan(source.data, path, source.digest, profile, tessdata)
        return _docling(source.data, path, source.digest, profile, artifacts, tessdata)
    except Exception as exc:
        # A bounded worker owns resource failures. Do not publish stack traces,
        # filenames or document text from third-party exceptions.
        return ParsedDocument(path, sha256(source.data).hexdigest(), 'failed', (),
                              ('extraction-error:' + type(exc).__name__,),
                              extraction_profile=profile)
