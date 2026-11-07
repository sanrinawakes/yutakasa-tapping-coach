#!/usr/bin/env python3
"""Strictly decode one trusted Gmail raw-message receipt into a private file."""

from __future__ import annotations

import base64
import binascii
import hmac
import html.parser
import json
import os
import quopri
import re
import stat
import sys
from email import policy
from email.header import decode_header
from email.parser import BytesParser


MAX_RAW_BYTES = 2 * 1024 * 1024
MAX_JSON_BYTES = 3 * 1024 * 1024
MAX_PARTS = 150
MAX_DEPTH = 12
MAX_HEADERS = 1_000
MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_SUBJECT_BYTES = 64 * 1024

MESSAGE_ID = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
BASE64URL = re.compile(r"^[A-Za-z0-9_-]*={0,2}$")
HEADER_NAME = re.compile(r"^[!-9;-~]+$")
ENCODED_WORD = re.compile(r"=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=")
HEX = frozenset("0123456789abcdefABCDEF")

SINGLETON_HEADERS = frozenset({
    "subject", "from", "sender", "reply-to", "to", "cc", "date",
    "message-id", "mime-version", "content-type",
    "content-transfer-encoding", "content-disposition",
})

CHARSETS = {
    "us-ascii": "ascii",
    "ascii": "ascii",
    "utf-8": "utf-8",
    "utf8": "utf-8",
    "iso-2022-jp": "iso2022_jp",
    "iso2022-jp": "iso2022_jp",
    "iso2022_jp": "iso2022_jp",
    "cp932": "cp932",
    "ms932": "cp932",
    "windows-31j": "cp932",
}


class DecodeMailError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def fail(code: str) -> None:
    raise DecodeMailError(code)


def _reject_constant(_value: str) -> None:
    fail("MAIL_INPUT_INVALID")


def _object_without_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            fail("MAIL_INPUT_INVALID")
        result[key] = value
    return result


def _read_request() -> dict[str, str]:
    raw_input = sys.stdin.buffer.read(MAX_JSON_BYTES + 1)
    if len(raw_input) > MAX_JSON_BYTES:
        fail("MAIL_INPUT_TOO_LARGE")
    try:
        request = json.loads(
            raw_input.decode("utf-8", errors="strict"),
            object_pairs_hook=_object_without_duplicates,
            parse_constant=_reject_constant,
        )
    except DecodeMailError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
        fail("MAIL_INPUT_INVALID")
    if not isinstance(request, dict) or set(request) != {
        "messageId", "expectedMessageId", "raw"
    }:
        fail("MAIL_INPUT_INVALID")
    if not all(isinstance(request[key], str) for key in request):
        fail("MAIL_INPUT_INVALID")
    message_id = request["messageId"]
    expected_id = request["expectedMessageId"]
    if not MESSAGE_ID.fullmatch(message_id) or not MESSAGE_ID.fullmatch(expected_id):
        fail("MAIL_MESSAGE_ID_INVALID")
    if not hmac.compare_digest(message_id, expected_id):
        fail("MAIL_MESSAGE_ID_MISMATCH")
    return request  # type: ignore[return-value]


def _decode_base64url(value: str) -> bytes:
    max_encoded = ((MAX_RAW_BYTES + 2) // 3) * 4
    if len(value) > max_encoded:
        fail("MAIL_RAW_TOO_LARGE")
    if not BASE64URL.fullmatch(value):
        fail("MAIL_RAW_INVALID")
    unpadded = value.rstrip("=")
    if "=" in unpadded or len(unpadded) % 4 == 1:
        fail("MAIL_RAW_INVALID")
    supplied_padding = len(value) - len(unpadded)
    required_padding = (-len(unpadded)) % 4
    if supplied_padding not in (0, required_padding):
        fail("MAIL_RAW_INVALID")
    encoded = (unpadded + "=" * required_padding).encode("ascii")
    try:
        decoded = base64.b64decode(encoded, altchars=b"-_", validate=True)
    except (binascii.Error, ValueError):
        fail("MAIL_RAW_INVALID")
    if len(decoded) == 0 or len(decoded) > MAX_RAW_BYTES:
        fail("MAIL_RAW_TOO_LARGE")
    if base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=") != unpadded:
        fail("MAIL_RAW_INVALID")
    return decoded


def _validate_raw_header_block(raw_message: bytes) -> None:
    positions = [position for position in (
        raw_message.find(b"\r\n\r\n"), raw_message.find(b"\n\n")
    ) if position >= 0]
    if not positions:
        fail("MAIL_HEADER_INVALID")
    header = raw_message[:min(positions)]
    if b"\x00" in header or re.search(br"\r(?!\n)", header):
        fail("MAIL_HEADER_INVALID")
    try:
        header.decode("ascii", errors="strict")
    except UnicodeDecodeError:
        fail("MAIL_HEADER_INVALID")
    lines = header.replace(b"\r\n", b"\n").split(b"\n")
    if len(lines) > MAX_HEADERS or any(len(line) > 998 for line in lines):
        fail("MAIL_HEADER_INVALID")


def _codec(charset: object, *, default_ascii: bool = False) -> str:
    if charset is None and default_ascii:
        return "ascii"
    if not isinstance(charset, str):
        fail("MAIL_CHARSET_UNSUPPORTED")
    codec = CHARSETS.get(charset.strip().lower())
    if codec is None:
        fail("MAIL_CHARSET_UNSUPPORTED")
    return codec


def _validate_q_encoding(value: str, code: str) -> bytes:
    try:
        encoded = value.encode("ascii", errors="strict")
    except UnicodeEncodeError:
        fail(code)
    index = 0
    while index < len(value):
        if value[index] != "=":
            index += 1
            continue
        if index + 2 >= len(value) or value[index + 1] not in HEX or value[index + 2] not in HEX:
            fail(code)
        index += 3
    return quopri.decodestring(encoded)


def _validate_encoded_words(value: str) -> None:
    matches = list(ENCODED_WORD.finditer(value))
    masked = list(value)
    for match in matches:
        _codec(match.group(1))
        payload = match.group(3)
        if not payload or any(ord(character) < 33 or ord(character) > 126 for character in payload):
            fail("MAIL_HEADER_INVALID")
        if match.group(2).lower() == "b":
            try:
                encoded = payload.encode("ascii", errors="strict")
                decoded = base64.b64decode(encoded, validate=True)
            except (UnicodeEncodeError, binascii.Error, ValueError):
                fail("MAIL_HEADER_INVALID")
            if base64.b64encode(decoded).decode("ascii") != payload:
                fail("MAIL_HEADER_INVALID")
        else:
            _validate_q_encoding(payload.replace("_", " "), "MAIL_HEADER_INVALID")
        for index in range(match.start(), match.end()):
            masked[index] = " "
    remaining = "".join(masked)
    if "=?" in remaining or "?=" in remaining:
        fail("MAIL_HEADER_INVALID")


def _clean_text(value: str, code: str, limit: int) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    if any(
        (ord(character) < 32 and character not in "\n\t") or
        0xD800 <= ord(character) <= 0xDFFF
        for character in value
    ):
        fail(code)
    value = value.strip()
    if len(value.encode("utf-8")) > limit:
        fail(code)
    return value


def _decode_subject(message) -> str:
    values = [value for name, value in message.raw_items() if name.lower() == "subject"]
    if len(values) > 1:
        fail("MAIL_HEADER_INVALID")
    if not values:
        return ""
    raw_value = values[0]
    if not isinstance(raw_value, str):
        fail("MAIL_HEADER_INVALID")
    unfolded = re.sub(r"\r?\n[ \t]+", " ", raw_value)
    if "\r" in unfolded or "\n" in unfolded:
        fail("MAIL_HEADER_INVALID")
    try:
        unfolded.encode("ascii", errors="strict")
    except UnicodeEncodeError:
        fail("MAIL_HEADER_INVALID")
    _validate_encoded_words(unfolded)
    try:
        pieces = decode_header(unfolded)
    except (binascii.Error, UnicodeError, ValueError):
        fail("MAIL_HEADER_INVALID")
    decoded: list[str] = []
    for value, charset in pieces:
        if isinstance(value, str):
            if charset is not None:
                fail("MAIL_HEADER_INVALID")
            decoded.append(value)
            continue
        try:
            decoded.append(value.decode(_codec(charset, default_ascii=True), errors="strict"))
        except (UnicodeDecodeError, LookupError):
            fail("MAIL_TEXT_DECODE_INVALID")
    return _clean_text("".join(decoded), "MAIL_HEADER_INVALID", MAX_SUBJECT_BYTES)


def _validate_part_headers(part) -> int:
    counts: dict[str, int] = {}
    raw_items = list(part.raw_items())
    for name, value in raw_items:
        if not isinstance(name, str) or not HEADER_NAME.fullmatch(name) or not isinstance(value, str):
            fail("MAIL_HEADER_INVALID")
        lower = name.lower()
        counts[lower] = counts.get(lower, 0) + 1
        try:
            value.encode("ascii", errors="strict")
        except UnicodeEncodeError:
            fail("MAIL_HEADER_INVALID")
        if "\x00" in value or re.search(r"\r(?!\n)|\n(?![ \t])", value):
            fail("MAIL_HEADER_INVALID")
        _validate_encoded_words(re.sub(r"\r?\n[ \t]+", " ", value))
    if any(counts.get(name, 0) > 1 for name in SINGLETON_HEADERS):
        fail("MAIL_HEADER_INVALID")
    if getattr(part, "defects", None):
        fail("MAIL_MIME_INVALID")
    for header in part.values():
        if getattr(header, "defects", None):
            fail("MAIL_HEADER_INVALID")
    return len(raw_items)


def _decode_transfer(part) -> bytes:
    header = part.get("Content-Transfer-Encoding")
    transfer = "7bit" if header is None else str(header).strip().lower()
    if transfer not in {"7bit", "8bit", "binary", "base64", "quoted-printable"}:
        fail("MAIL_TRANSFER_ENCODING_INVALID")
    try:
        if transfer == "base64":
            payload = part.get_payload(decode=False)
            if not isinstance(payload, str):
                fail("MAIL_TRANSFER_ENCODING_INVALID")
            try:
                raw = payload.encode("ascii", errors="strict")
            except UnicodeEncodeError:
                fail("MAIL_TRANSFER_ENCODING_INVALID")
            if re.search(br"\r(?!\n)", raw):
                fail("MAIL_TRANSFER_ENCODING_INVALID")
            lines = raw.replace(b"\r\n", b"\n").split(b"\n")
            if any(len(line) > 76 or re.search(br"[^A-Za-z0-9+/=]", line) for line in lines):
                fail("MAIL_TRANSFER_ENCODING_INVALID")
            compact = b"".join(lines)
            decoded = base64.b64decode(compact, validate=True)
            if base64.b64encode(decoded) != compact:
                fail("MAIL_TRANSFER_ENCODING_INVALID")
            return decoded
        if transfer == "quoted-printable":
            payload = part.get_payload(decode=False)
            if not isinstance(payload, str):
                fail("MAIL_TRANSFER_ENCODING_INVALID")
            try:
                encoded = payload.encode("ascii", errors="strict")
            except UnicodeEncodeError:
                fail("MAIL_TRANSFER_ENCODING_INVALID")
            if re.search(br"\r(?!\n)", encoded):
                fail("MAIL_TRANSFER_ENCODING_INVALID")
            lines = encoded.replace(b"\r\n", b"\n").split(b"\n")
            for line_index, content in enumerate(lines):
                has_newline = line_index < len(lines) - 1
                if len(content) > 76:
                    fail("MAIL_TRANSFER_ENCODING_INVALID")
                soft_break = content.endswith(b"=")
                if soft_break:
                    if not has_newline:
                        fail("MAIL_TRANSFER_ENCODING_INVALID")
                    content = content[:-1]
                elif content.endswith((b" ", b"\t")):
                    fail("MAIL_TRANSFER_ENCODING_INVALID")
                index = 0
                while index < len(content):
                    byte = content[index]
                    if byte == 61:
                        if (index + 2 >= len(content) or
                                chr(content[index + 1]) not in HEX or
                                chr(content[index + 2]) not in HEX):
                            fail("MAIL_TRANSFER_ENCODING_INVALID")
                        index += 3
                    elif byte in (9, 32) or 33 <= byte <= 60 or 62 <= byte <= 126:
                        index += 1
                    else:
                        fail("MAIL_TRANSFER_ENCODING_INVALID")
            return quopri.decodestring(encoded)
        decoded = part.get_payload(decode=True)
        if not isinstance(decoded, bytes):
            fail("MAIL_TRANSFER_ENCODING_INVALID")
        if transfer == "7bit" and any(byte > 127 for byte in decoded):
            fail("MAIL_TRANSFER_ENCODING_INVALID")
        return decoded
    except DecodeMailError:
        raise
    except (binascii.Error, UnicodeError, ValueError):
        fail("MAIL_TRANSFER_ENCODING_INVALID")


def _decode_text_part(part) -> str:
    charset = part.get_content_charset()
    codec = _codec(charset, default_ascii=True)
    body = _decode_transfer(part)
    try:
        decoded = body.decode(codec, errors="strict")
    except (UnicodeDecodeError, LookupError):
        fail("MAIL_TEXT_DECODE_INVALID")
    return _clean_text(decoded, "MAIL_TEXT_DECODE_INVALID", MAX_BODY_BYTES)


class _SafeHTMLText(html.parser.HTMLParser):
    BLOCKED = frozenset({"script", "style", "noscript", "template", "svg", "head"})
    BREAKS = frozenset({
        "br", "p", "div", "li", "tr", "table", "section", "article",
        "header", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
    })

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocked_depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, _attrs) -> None:
        tag = tag.lower()
        if tag in self.BLOCKED:
            self.blocked_depth += 1
        elif self.blocked_depth == 0 and tag in self.BREAKS:
            self.parts.append("\n")

    def handle_startendtag(self, tag: str, attrs) -> None:
        if self.blocked_depth == 0 and tag.lower() in self.BREAKS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in self.BLOCKED and self.blocked_depth:
            self.blocked_depth -= 1
        elif self.blocked_depth == 0 and tag in self.BREAKS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self.blocked_depth == 0:
            self.parts.append(data)

    def text(self) -> str:
        lines = []
        for line in "".join(self.parts).splitlines():
            normalized = re.sub(r"[ \t\f\v]+", " ", line).strip()
            if normalized:
                lines.append(normalized)
        return "\n".join(lines)


def _html_to_text(value: str) -> str:
    parser = _SafeHTMLText()
    try:
        parser.feed(value)
        parser.close()
    except (AssertionError, ValueError):
        fail("MAIL_HTML_INVALID")
    safe_text = html.escape(parser.text(), quote=True)
    return _clean_text(safe_text, "MAIL_HTML_INVALID", MAX_BODY_BYTES)


def _decode_message(raw_message: bytes) -> tuple[str, str]:
    _validate_raw_header_block(raw_message)
    strict_policy = policy.default.clone(raise_on_defect=True)
    try:
        message = BytesParser(policy=strict_policy).parsebytes(raw_message)
    except Exception as error:
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            raise
        fail("MAIL_MIME_INVALID")

    subject = _decode_subject(message)
    candidates: dict[str, list] = {"text/plain": [], "text/html": []}
    part_count = 0
    header_count = 0
    stack = [(message, 0, False)]
    while stack:
        part, depth, ancestor_ignored = stack.pop()
        if depth > MAX_DEPTH:
            fail("MAIL_MIME_LIMIT")
        part_count += 1
        if part_count > MAX_PARTS:
            fail("MAIL_MIME_LIMIT")
        header_count += _validate_part_headers(part)
        if header_count > MAX_HEADERS:
            fail("MAIL_MIME_LIMIT")

        disposition = part.get_content_disposition()
        ignored = ancestor_ignored or disposition == "attachment" or part.get_filename() is not None
        if part.is_multipart():
            children = part.get_payload()
            if not isinstance(children, list):
                fail("MAIL_MIME_INVALID")
            for child in reversed(children):
                stack.append((child, depth + 1, ignored))
            continue
        if ignored:
            continue
        content_type = part.get_content_type().lower()
        if content_type in candidates:
            candidates[content_type].append(part)

    bodies = [value for value in (
        _decode_text_part(part) for part in candidates["text/plain"]
    ) if value]
    if not bodies:
        bodies = [value for value in (
            _html_to_text(_decode_text_part(part)) for part in candidates["text/html"]
        ) if value]
    body = _clean_text("\n\n".join(bodies), "MAIL_TEXT_DECODE_INVALID", MAX_BODY_BYTES)
    if not body:
        fail("MAIL_BODY_NOT_FOUND")
    return subject, body


def _private_output(path: str, payload: bytes) -> None:
    if not isinstance(path, str) or not os.path.isabs(path) or "\x00" in path:
        fail("MAIL_OUTPUT_PATH_INVALID")
    if os.path.normpath(path) != path:
        fail("MAIL_OUTPUT_PATH_INVALID")
    parent = os.path.dirname(path)
    name = os.path.basename(path)
    if not parent or name in {"", ".", ".."}:
        fail("MAIL_OUTPUT_PATH_INVALID")
    try:
        parent_lstat = os.lstat(parent)
    except OSError:
        fail("MAIL_OUTPUT_PARENT_INVALID")
    if (not stat.S_ISDIR(parent_lstat.st_mode) or stat.S_ISLNK(parent_lstat.st_mode) or
            parent_lstat.st_uid != os.geteuid() or stat.S_IMODE(parent_lstat.st_mode) != 0o700):
        fail("MAIL_OUTPUT_PARENT_INVALID")

    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        directory_fd = os.open(parent, directory_flags)
    except OSError:
        fail("MAIL_OUTPUT_PARENT_INVALID")
    file_fd = None
    created = False
    try:
        directory_stat = os.fstat(directory_fd)
        if ((directory_stat.st_dev, directory_stat.st_ino) !=
                (parent_lstat.st_dev, parent_lstat.st_ino) or
                stat.S_IMODE(directory_stat.st_mode) != 0o700 or
                directory_stat.st_uid != os.geteuid()):
            fail("MAIL_OUTPUT_PARENT_INVALID")
        flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                 getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
        try:
            file_fd = os.open(name, flags, 0o600, dir_fd=directory_fd)
            created = True
        except FileExistsError:
            fail("MAIL_OUTPUT_EXISTS")
        except OSError:
            fail("MAIL_OUTPUT_WRITE_FAILED")
        os.fchmod(file_fd, 0o600)
        offset = 0
        while offset < len(payload):
            written = os.write(file_fd, payload[offset:])
            if written <= 0:
                fail("MAIL_OUTPUT_WRITE_FAILED")
            offset += written
        os.fsync(file_fd)
        written_stat = os.fstat(file_fd)
        if (not stat.S_ISREG(written_stat.st_mode) or written_stat.st_nlink != 1 or
                written_stat.st_uid != os.geteuid() or
                stat.S_IMODE(written_stat.st_mode) != 0o600 or
                written_stat.st_size != len(payload)):
            fail("MAIL_OUTPUT_WRITE_FAILED")
    except DecodeMailError:
        if file_fd is not None:
            os.close(file_fd)
            file_fd = None
        if created:
            try:
                os.unlink(name, dir_fd=directory_fd)
            except OSError:
                pass
        raise
    except OSError:
        if file_fd is not None:
            os.close(file_fd)
            file_fd = None
        if created:
            try:
                os.unlink(name, dir_fd=directory_fd)
            except OSError:
                pass
        fail("MAIL_OUTPUT_WRITE_FAILED")
    finally:
        if file_fd is not None:
            os.close(file_fd)
        os.close(directory_fd)


def main() -> int:
    try:
        if len(sys.argv) != 3 or sys.argv[1] != "--output":
            fail("MAIL_ARGUMENT_INVALID")
        request = _read_request()
        raw_message = _decode_base64url(request["raw"])
        subject, body = _decode_message(raw_message)
        output = {
            "messageId": request["messageId"],
            "body": body,
            "subject": subject,
            "strictDecodeVerified": True,
        }
        encoded = (json.dumps(
            output, ensure_ascii=False, separators=(",", ":")
        ) + "\n").encode("utf-8")
        _private_output(sys.argv[2], encoded)
        sys.stdout.write('{"decoded":true}\n')
        return 0
    except DecodeMailError as error:
        sys.stderr.write(json.dumps(
            {"error": error.code}, separators=(",", ":")
        ) + "\n")
        return 1
    except Exception:
        sys.stderr.write('{"error":"MAIL_DECODE_INTERNAL"}\n')
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
