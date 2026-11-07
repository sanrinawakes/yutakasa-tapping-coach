import base64
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest
from email.header import Header


SCRIPT = pathlib.Path(__file__).with_name("external-support-decode-mail.py")
MESSAGE_ID = "18abcdef01234567"


def b64_lines(value: bytes) -> bytes:
    return base64.encodebytes(value).replace(b"\n", b"\r\n")


def raw_message(
    body: str,
    *,
    charset: str = "utf-8",
    transfer: str = "base64",
    subject: str = "Support question",
    date: str = "Fri, 07 Nov 2026 12:00:00 +0000",
    content_type: str = "text/plain",
) -> bytes:
    codec = {
        "utf-8": "utf-8",
        "iso-2022-jp": "iso2022_jp",
        "cp932": "cp932",
    }[charset]
    encoded_body = body.encode(codec)
    if transfer == "base64":
        payload = b64_lines(encoded_body)
    elif transfer == "quoted-printable":
        import quopri
        payload = quopri.encodestring(encoded_body, quotetabs=True).replace(b"\n", b"\r\n")
    elif transfer == "8bit":
        payload = encoded_body
    else:
        payload = encoded_body
    encoded_subject = Header(subject, charset, header_name="Subject").encode()
    headers = (
        f"Subject: {encoded_subject}\r\n"
        f"Date: {date}\r\n"
        "MIME-Version: 1.0\r\n"
        f"Content-Type: {content_type}; charset={charset}\r\n"
        f"Content-Transfer-Encoding: {transfer}\r\n"
        "\r\n"
    ).encode("ascii")
    return headers + payload


def request_for(raw: bytes, **patch):
    request = {
        "messageId": MESSAGE_ID,
        "expectedMessageId": MESSAGE_ID,
        "raw": base64.urlsafe_b64encode(raw).decode("ascii").rstrip("="),
    }
    request.update(patch)
    return request


class DecodeMailTests(unittest.TestCase):
    def run_decoder(self, request, *, output_parent=None, output_name="decoded.json", raw_stdin=None):
        owned_parent = output_parent is None
        temporary = tempfile.TemporaryDirectory() if owned_parent else None
        parent = pathlib.Path(temporary.name if temporary else output_parent)
        if owned_parent:
            os.chmod(parent, 0o700)
        output = parent / output_name
        stdin = raw_stdin if raw_stdin is not None else json.dumps(request).encode("utf-8")
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "--output", str(output)],
            input=stdin,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        result = None
        if completed.returncode == 0 and output.exists() and output.is_file():
            result = json.loads(output.read_text(encoding="utf-8"))
        return completed, output, result, temporary

    def assert_success(self, raw, expected_body, expected_subject):
        completed, output, result, temporary = self.run_decoder(request_for(raw))
        self.addCleanup(temporary.cleanup)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout, b'{"decoded":true}\n')
        self.assertEqual(completed.stderr, b"")
        self.assertEqual(result, {
            "messageId": MESSAGE_ID,
            "body": expected_body,
            "subject": expected_subject,
            "strictDecodeVerified": True,
        })
        mode = stat.S_IMODE(output.stat().st_mode)
        self.assertEqual(mode, 0o600)
        self.assertEqual(output.stat().st_nlink, 1)

    def assert_failure(self, request, code, **kwargs):
        completed, output, _result, temporary = self.run_decoder(request, **kwargs)
        if temporary:
            self.addCleanup(temporary.cleanup)
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, b"")
        self.assertEqual(json.loads(completed.stderr), {"error": code})
        self.assertFalse(output.exists())

    def test_decodes_utf8_iso2022jp_and_cp932(self):
        cases = [
            ("utf-8", "base64", "日本語とEnglish", "質問です"),
            ("iso-2022-jp", "quoted-printable", "豊かさBOTの質問", "技術的な質問"),
            ("cp932", "base64", "変換できません", "文字入力について"),
        ]
        for charset, transfer, body, subject in cases:
            with self.subTest(charset=charset, transfer=transfer):
                self.assert_success(
                    raw_message(body, charset=charset, transfer=transfer, subject=subject),
                    body,
                    subject,
                )

    def test_plain_text_wins_over_safe_html_fallback(self):
        boundary = "strict-boundary"
        plain = raw_message("plain answer", subject="multipart").split(b"\r\n\r\n", 1)[1]
        html_body = "<html><head><style>hidden</style></head><body><p>HTML answer</p><script>secret()</script></body></html>"
        html = base64.b64encode(html_body.encode("utf-8"))
        raw = (
            f"Subject: multipart\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary={boundary}\r\n\r\n"
            f"--{boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
        ).encode("ascii") + plain + (
            f"\r\n--{boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
        ).encode("ascii") + html + f"\r\n--{boundary}--\r\n".encode("ascii")
        self.assert_success(raw, "plain answer", "multipart")

        html_only = raw_message(
            html_body,
            content_type="text/html",
            subject="HTML only",
        )
        self.assert_success(html_only, "HTML answer", "HTML only")

        encoded_tag = raw_message(
            "<p>&lt;img src=x onerror=alert(1)&gt; &amp; text</p>",
            content_type="text/html",
            subject="Safe HTML",
        )
        self.assert_success(
            encoded_tag,
            "&lt;img src=x onerror=alert(1)&gt; &amp; text",
            "Safe HTML",
        )

        empty_plain = (
            f"Subject: fallback\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary={boundary}\r\n\r\n"
            f"--{boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n"
            f"\r\n--{boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>fallback body</p>"
            f"\r\n--{boundary}--\r\n"
        ).encode("ascii")
        self.assert_success(empty_plain, "fallback body", "fallback")

    def test_rejects_malformed_transfer_base64_and_unknown_charset(self):
        malformed = (
            b"Subject: bad\r\nMIME-Version: 1.0\r\n"
            b"Content-Type: text/plain; charset=utf-8\r\n"
            b"Content-Transfer-Encoding: base64\r\n\r\naGVsbG8%%%\r\n"
        )
        self.assert_failure(request_for(malformed), "MAIL_TRANSFER_ENCODING_INVALID")
        malformed_control = malformed.replace(b"aGVsbG8%%%", b"aGVs\x0bbG8=")
        self.assert_failure(request_for(malformed_control), "MAIL_TRANSFER_ENCODING_INVALID")
        unknown = (
            b"Subject: bad charset\r\nMIME-Version: 1.0\r\n"
            b"Content-Type: text/plain; charset=x-unknown\r\n\r\nhello\r\n"
        )
        self.assert_failure(request_for(unknown), "MAIL_CHARSET_UNSUPPORTED")

        malformed_qp = (
            b"Subject: bad qp\r\nMIME-Version: 1.0\r\n"
            b"Content-Type: text/plain; charset=utf-8\r\n"
            b"Content-Transfer-Encoding: quoted-printable\r\n\r\nbad=ZZvalue\r\n"
        )
        self.assert_failure(request_for(malformed_qp), "MAIL_TRANSFER_ENCODING_INVALID")
        malformed_qp_control = malformed_qp.replace(b"bad=ZZvalue", b"bad\x0bvalue")
        self.assert_failure(request_for(malformed_qp_control), "MAIL_TRANSFER_ENCODING_INVALID")

    def test_rejects_part_count_and_depth_bombs(self):
        boundary = "bomb"
        parts = []
        for _index in range(151):
            parts.append(
                f"--{boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nx\r\n".encode("ascii")
            )
        bomb = (
            f"MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary={boundary}\r\n\r\n".encode("ascii") +
            b"".join(parts) + f"--{boundary}--\r\n".encode("ascii")
        )
        self.assert_failure(request_for(bomb), "MAIL_MIME_LIMIT")

        nested = b"Content-Type: text/plain; charset=utf-8\r\n\r\ndeep"
        for depth in range(13):
            nested_boundary = f"depth-{depth}"
            nested = (
                f"MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary={nested_boundary}\r\n\r\n"
                f"--{nested_boundary}\r\n".encode("ascii") + nested +
                f"\r\n--{nested_boundary}--\r\n".encode("ascii")
            )
        self.assert_failure(request_for(nested), "MAIL_MIME_LIMIT")

    def test_rejects_malformed_and_duplicate_headers(self):
        malformed = b"Subject without colon\r\n\r\nbody"
        self.assert_failure(request_for(malformed), "MAIL_MIME_INVALID")
        duplicate = (
            b"Subject: first\r\nSubject: second\r\n"
            b"Content-Type: text/plain; charset=utf-8\r\n\r\nbody"
        )
        self.assert_failure(request_for(duplicate), "MAIL_HEADER_INVALID")
        bad_word = (
            b"Subject: =?utf-8?b?%%%?=\r\n"
            b"Content-Type: text/plain; charset=utf-8\r\n\r\nbody"
        )
        self.assert_failure(request_for(bad_word), "MAIL_HEADER_INVALID")
        bad_extra_header = (
            b"Subject: ordinary\r\nX-Unsafe: =?utf-8?b?%%%?=\r\n"
            b"Content-Type: text/plain; charset=utf-8\r\n\r\nbody"
        )
        self.assert_failure(request_for(bad_extra_header), "MAIL_HEADER_INVALID")
        unknown_subject = (
            b"Subject: =?x-unknown?b?aGVsbG8=?=\r\n"
            b"Content-Type: text/plain; charset=utf-8\r\n\r\nbody"
        )
        self.assert_failure(request_for(unknown_subject), "MAIL_CHARSET_UNSUPPORTED")

    def test_future_unrelated_message_is_only_decoded_not_classified(self):
        raw = raw_message(
            "This is unrelated content.",
            date="Fri, 07 Nov 2099 12:00:00 +0000",
            subject="Ordinary note",
        )
        self.assert_success(raw, "This is unrelated content.", "Ordinary note")

    def test_rejects_message_id_mismatch_and_json_shape_injection(self):
        raw = raw_message("body")
        self.assert_failure(
            request_for(raw, expectedMessageId="18abcdef01234568"),
            "MAIL_MESSAGE_ID_MISMATCH",
        )
        self.assert_failure(
            request_for(raw, command="send", output="/tmp/elsewhere"),
            "MAIL_INPUT_INVALID",
        )
        duplicate_json = (
            '{"messageId":"18abcdef01234567","messageId":"18abcdef01234568",'
            '"expectedMessageId":"18abcdef01234567","raw":"AA"}'
        ).encode("utf-8")
        self.assert_failure({}, "MAIL_INPUT_INVALID", raw_stdin=duplicate_json)

    def test_output_requires_absolute_owned_0700_new_path(self):
        raw = raw_message("private")
        request = request_for(raw)

        with tempfile.TemporaryDirectory() as temporary:
            parent = pathlib.Path(temporary)
            os.chmod(parent, 0o755)
            self.assert_failure(request, "MAIL_OUTPUT_PARENT_INVALID", output_parent=parent)

        with tempfile.TemporaryDirectory() as temporary:
            real = pathlib.Path(temporary) / "real"
            link = pathlib.Path(temporary) / "link"
            real.mkdir(mode=0o700)
            link.symlink_to(real, target_is_directory=True)
            self.assert_failure(request, "MAIL_OUTPUT_PARENT_INVALID", output_parent=link)

        with tempfile.TemporaryDirectory() as temporary:
            parent = pathlib.Path(temporary)
            os.chmod(parent, 0o700)
            existing = parent / "decoded.json"
            existing.write_text("do not replace", encoding="utf-8")
            completed, output, _result, _temporary = self.run_decoder(
                request, output_parent=parent
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(json.loads(completed.stderr), {"error": "MAIL_OUTPUT_EXISTS"})
            self.assertEqual(output.read_text(encoding="utf-8"), "do not replace")

        with tempfile.TemporaryDirectory() as temporary:
            parent = pathlib.Path(temporary)
            os.chmod(parent, 0o700)
            target = parent / "target.json"
            target.write_text("do not follow", encoding="utf-8")
            link = parent / "decoded.json"
            link.symlink_to(target)
            completed, _output, _result, _temporary = self.run_decoder(
                request, output_parent=parent
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(json.loads(completed.stderr), {"error": "MAIL_OUTPUT_EXISTS"})
            self.assertEqual(target.read_text(encoding="utf-8"), "do not follow")

        with tempfile.TemporaryDirectory() as temporary:
            parent = pathlib.Path(temporary)
            os.chmod(parent, 0o700)
            target = parent / "target.json"
            target.write_text("keep both links", encoding="utf-8")
            linked = parent / "decoded.json"
            os.link(target, linked)
            completed, _output, _result, _temporary = self.run_decoder(
                request, output_parent=parent
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertEqual(json.loads(completed.stderr), {"error": "MAIL_OUTPUT_EXISTS"})
            self.assertEqual(target.read_text(encoding="utf-8"), "keep both links")
            self.assertEqual(target.stat().st_nlink, 2)

        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "--output", "relative.json"],
            input=json.dumps(request).encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(json.loads(completed.stderr), {"error": "MAIL_OUTPUT_PATH_INVALID"})
        self.assertFalse(pathlib.Path("relative.json").exists())

    def test_preserves_valid_original_replacement_character(self):
        body = "customer deliberately wrote \ufffd here"
        subject = "valid \ufffd subject"
        self.assert_success(raw_message(body, subject=subject), body, subject)

    def test_rejects_malformed_outer_base64_without_writing(self):
        request = request_for(raw_message("body"))
        request["raw"] = "a==="
        self.assert_failure(request, "MAIL_RAW_INVALID")

    def test_rejects_raw_message_larger_than_two_megabytes(self):
        header = b"Subject: exact limit\r\nContent-Type: text/plain; charset=us-ascii\r\n\r\n"
        at_limit_body = "x" * (2 * 1024 * 1024 - len(header))
        self.assert_success(header + at_limit_body.encode("ascii"), at_limit_body, "exact limit")
        oversized = (
            b"Subject: too large\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" +
            b"x" * (2 * 1024 * 1024)
        )
        self.assert_failure(request_for(oversized), "MAIL_RAW_TOO_LARGE")

    def test_error_output_never_contains_mail_content_or_identifier(self):
        secret_body = "private customer sentence 93d2a8"
        secret_subject = "private subject 6b7f3e"
        request = request_for(raw_message(secret_body, subject=secret_subject))
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "--output", "relative.json"],
            input=json.dumps(request).encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertNotIn(secret_body.encode(), combined)
        self.assertNotIn(secret_subject.encode(), combined)
        self.assertNotIn(MESSAGE_ID.encode(), combined)
        self.assertEqual(json.loads(completed.stderr), {"error": "MAIL_OUTPUT_PATH_INVALID"})


if __name__ == "__main__":
    unittest.main()
