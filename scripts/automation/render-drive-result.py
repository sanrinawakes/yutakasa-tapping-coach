#!/usr/bin/env python3
"""Render a verified, customer-content-free Yutakasa result as a Japanese PDF."""

import html
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

FONT_PATH = os.environ.get(
    "YUTAKASA_PDF_FONT_PATH",
    "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
)
FORBIDDEN = re.compile(
    r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:sk-|gh[pousr]_|Bearer\s+)[A-Za-z0-9_-]{8,}",
    re.IGNORECASE,
)
FIELDS = {
    "eventId": 80,
    "completedAt": 40,
    "inputSource": 80,
    "classification": 120,
    "cause": 1200,
    "change": 1200,
    "prUrl": 200,
    "productionSha": 64,
    "deploymentId": 80,
    "customerReply": 160,
}


def clean(value, limit):
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ValueError("invalid_report_field")
    if any(ord(char) < 32 and char not in "\n\t" for char in value):
        raise ValueError("invalid_report_field")
    if FORBIDDEN.search(value):
        raise ValueError("private_report_field")
    value = value.strip()
    if not value:
        raise ValueError("invalid_report_field")
    return value


def validate(data):
    if not isinstance(data, dict) or set(data) != set(FIELDS) | {"tests", "observations", "unverifiedItems"}:
        raise ValueError("invalid_report_schema")
    checked = {key: clean(data[key], limit) for key, limit in FIELDS.items()}
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,80}", checked["eventId"]):
        raise ValueError("invalid_report_event")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", checked["completedAt"]):
        raise ValueError("invalid_report_date")
    try:
        datetime.fromisoformat(checked["completedAt"].replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("invalid_report_date") from error
    if not re.fullmatch(r"[a-fA-F0-9]{40}", checked["productionSha"]):
        raise ValueError("invalid_report_sha")
    if not re.fullmatch(r"dpl_[A-Za-z0-9]{6,76}", checked["deploymentId"]):
        raise ValueError("invalid_report_deployment")
    if checked["prUrl"] != "該当なし" and not re.fullmatch(
        r"https://github\.com/sanrinawakes/yutakasa-tapping-coach/pull/[1-9][0-9]*",
        checked["prUrl"],
    ):
        raise ValueError("invalid_report_pr")
    tests = data["tests"]
    if not isinstance(tests, list) or not tests or len(tests) > 20:
        raise ValueError("invalid_report_tests")
    checked["tests"] = []
    for row in tests:
        if not isinstance(row, dict) or set(row) != {"name", "passed", "failed"}:
            raise ValueError("invalid_report_tests")
        name = clean(row["name"], 100)
        passed, failed = row["passed"], row["failed"]
        if any(type(number) is not int or number < 0 or number > 100000 for number in (passed, failed)):
            raise ValueError("invalid_report_tests")
        if failed != 0:
            raise ValueError("report_release_evidence_incomplete")
        checked["tests"].append((name, passed, failed))
    for key, maximum in (("observations", 12), ("unverifiedItems", 20)):
        values = data[key]
        if not isinstance(values, list) or len(values) > maximum:
            raise ValueError("invalid_report_schema")
        checked[key] = [clean(value, 300) for value in values]
    if len(checked["observations"]) != 3 or checked["unverifiedItems"]:
        raise ValueError("report_release_evidence_incomplete")
    if any(
        not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value)
        for value in checked["observations"]
    ):
        raise ValueError("report_release_evidence_incomplete")
    try:
        observed = [
            datetime.fromisoformat(value.replace("Z", "+00:00"))
            for value in checked["observations"]
        ]
    except ValueError as error:
        raise ValueError("report_release_evidence_incomplete") from error
    if not (observed[0] < observed[1] < observed[2]) or (
        observed[2] - observed[0]
    ).total_seconds() < 20 * 60:
        raise ValueError("report_release_evidence_incomplete")
    return checked


def render(data, output_path):
    checked = validate(data)
    font = Path(FONT_PATH)
    if not font.is_file() or font.is_symlink():
        raise ValueError("report_font_unavailable")
    pdfmetrics.registerFont(TTFont("YutakasaJapanese", str(font)))
    body = ParagraphStyle(
        "body", fontName="YutakasaJapanese", fontSize=9.5, leading=16,
        wordWrap="CJK", alignment=TA_LEFT, textColor=colors.HexColor("#172334"),
        spaceAfter=4 * mm,
    )
    label = ParagraphStyle(
        "label", parent=body, fontSize=8, leading=12, textColor=colors.HexColor("#496278"),
        spaceAfter=1 * mm,
    )
    title = ParagraphStyle(
        "title", parent=body, fontSize=18, leading=27,
        textColor=colors.HexColor("#123D50"), spaceAfter=3 * mm,
    )
    section = ParagraphStyle(
        "section", parent=body, fontSize=11, leading=18,
        textColor=colors.HexColor("#123D50"), spaceBefore=4 * mm,
        spaceAfter=2 * mm,
    )

    def text(value, style=body):
        return Paragraph(html.escape(str(value)).replace("\n", "<br/>"), style)

    story = [
        text("豊かさBOT 対応結果", title),
        text("検証済みの作業事実だけを記載した運営用報告です。", label),
        HRFlowable(width="100%", thickness=0.7, color=colors.HexColor("#A4C5CC")),
        Spacer(1, 3 * mm),
    ]

    def field(name, value):
        story.extend((text(name, label), text(value)))

    field("対応ID", checked["eventId"])
    field("対応完了日時", checked["completedAt"])
    field("入力元", checked["inputSource"])
    field("分類", checked["classification"])
    field("確認した原因", checked["cause"])
    field("実施した変更", checked["change"])
    field("Pull Request", checked["prUrl"])
    field("本番コミット", checked["productionSha"])
    field("本番デプロイID", checked["deploymentId"])
    field("顧客への返信", checked["customerReply"])

    story.append(text("実行したテスト", section))
    rows = [[text("テスト", label), text("成功", label), text("失敗", label)]]
    rows.extend(
        [text(name), text(str(passed)), text(str(failed))]
        for name, passed, failed in checked["tests"]
    )
    table = Table(rows, colWidths=[125 * mm, 20 * mm, 20 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8F3F4")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, colors.HexColor("#A4C5CC")),
    ]))
    story.append(table)
    story.append(text("本番観測", section))
    story.extend(text(value) for value in checked["observations"] or ["該当なし"])
    story.append(text("未確認事項", section))
    story.extend(text(value) for value in checked["unverifiedItems"] or ["なし"])

    output = Path(output_path)
    if output.exists() or not output.parent.is_dir():
        raise ValueError("report_output_invalid")
    document = SimpleDocTemplate(
        str(output), pagesize=A4, rightMargin=20 * mm, leftMargin=20 * mm,
        topMargin=19 * mm, bottomMargin=20 * mm, title="豊かさBOT 対応結果",
        author="豊かさBOT 運営", invariant=1,
    )

    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFont("YutakasaJapanese", 8)
        canvas.setFillColor(colors.HexColor("#496278"))
        canvas.drawString(20 * mm, 11 * mm, f"対応ID: {checked['eventId']}")
        canvas.drawRightString(A4[0] - 20 * mm, 11 * mm, f"{doc.page} ページ")
        canvas.restoreState()

    document.build(story, onFirstPage=footer, onLaterPages=footer)
    os.chmod(output, 0o600)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("report_usage_invalid")
        render(json.load(sys.stdin), sys.argv[1])
    except (ValueError, OSError, KeyError) as error:
        # Values and source document text are never written to stdout/stderr.
        code = str(error)
        if not re.fullmatch(r"[a-z_]+", code):
            code = "report_render_failed"
        print(code, file=sys.stderr)
        sys.exit(1)
