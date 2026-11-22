"""Explicit CPU-only native layout/table pipeline; no model provisioning."""
from pathlib import Path
import os
import socket

from engine.model_artifacts import verify_artifacts, verify_file


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
        if os.environ.get('TESSDATA_PREFIX') != str(tessdata):
            raise ValueError('explicit tessdata environment required')
        for relative, size, digest in (
            ('eng.traineddata', 4113088, '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2'),
            ('rus.traineddata', 3861738, 'e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225'),
            ('osd.traineddata', 10562727, '9cf5d576fcc47564f11265841e5ca839001e7e6f38ff7f7aacf46d15a96b00ff'),
            ('configs/tsv', 22, '59d079bb75d8b3d7c839a3564580cb559e362c93a9d70f234e421c0c3e767e04'),
        ):
            verify_file(tessdata / relative, {'bytes': size, 'sha256': digest})
        options.ocr_options = TesseractCliOcrOptions(
            lang=['eng', 'rus'], tesseract_cmd='/usr/bin/tesseract',
            path=str(tessdata), force_full_page_ocr=True, psm=6)
    return DocumentConverter(allowed_formats=[InputFormat.PDF],
                             format_options={InputFormat.PDF: PdfFormatOption(
                                 pipeline_options=options)})
