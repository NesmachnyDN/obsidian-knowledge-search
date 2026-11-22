"""Explicit CPU-only native layout/table pipeline; no model provisioning."""
from pathlib import Path
import socket

from engine.model_artifacts import verify_artifacts


def structured_converter(artifacts: Path, tessdata: Path | None, scanned: bool):
    # Require the experimental worker to run in an isolated network namespace.
    if {name for _, name in socket.if_nameindex()} - {'lo'}:
        raise ValueError('offline namespace required')
    verify_artifacts(artifacts)
    from docling.datamodel.accelerator_options import AcceleratorOptions
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import (
        LayoutObjectDetectionOptions, TableFormerMode, TableStructureOptions,
        TesseractCliOcrOptions, ThreadedPdfPipelineOptions,
    )
    from docling.document_converter import DocumentConverter, PdfFormatOption

    layout = LayoutObjectDetectionOptions.from_preset('layout_heron_default')
    layout.model_spec.revision = '8f39ad3c0b4c58e9c2d2c84a38465abf757272d8'
    options = ThreadedPdfPipelineOptions(
        artifacts_path=artifacts,
        accelerator_options=AcceleratorOptions(device='cpu', num_threads=2),
        enable_remote_services=False, allow_external_plugins=False,
        do_ocr=scanned, do_table_structure=True,
        layout_options=layout,
        table_structure_options=TableStructureOptions(mode=TableFormerMode.FAST,
                                                     do_cell_matching=True),
        layout_batch_size=1, table_batch_size=1, ocr_batch_size=1,
        queue_max_size=2, document_timeout=90,
        generate_page_images=False, generate_picture_images=False,
        generate_table_images=False,
    )
    if scanned:
        if not isinstance(tessdata, Path) or not tessdata.is_absolute():
            raise ValueError('explicit local tessdata directory required')
        options.ocr_options = TesseractCliOcrOptions(
            lang=['eng', 'rus'], tesseract_cmd='/usr/bin/tesseract',
            path=str(tessdata), force_full_page_ocr=True, psm=6)
    return DocumentConverter(allowed_formats=[InputFormat.PDF],
                             format_options={InputFormat.PDF: PdfFormatOption(
                                 pipeline_options=options)})
