"""いろいろな形式の資料から文字を取り出す

対応: .txt .md .csv .json .html / .pdf（pypdf）/ .docx（python-docx）/ .pptx（python-pptx）/ Webページ
pypdf などは入っていなければその形式だけ使えない（エラーで案内する）。
"""
import html
import io
import os
import re
import urllib.request


class ExtractError(Exception):
    pass


def _decode(data):
    for enc in ("utf-8-sig", "cp932", "euc-jp"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            pass
    return data.decode("utf-8", errors="replace")


def html_to_text(src):
    src = re.sub(r"(?is)<(script|style|noscript|svg|nav|footer|header)\b.*?</\1>", " ", src)
    src = re.sub(r"(?i)<br\s*/?>", "\n", src)
    src = re.sub(r"(?i)</(p|div|li|h[1-6]|tr|section|article|table)>", "\n", src)
    src = re.sub(r"<[^>]+>", " ", src)
    text = html.unescape(src)
    text = re.sub(r"[ \t　]+", " ", text)
    text = re.sub(r"\n\s*\n\s*", "\n\n", text)
    return text.strip()


def _pdf(data):
    try:
        from pypdf import PdfReader
    except ImportError:
        raise ExtractError("PDFを読むには pip install pypdf が必要です")
    reader = PdfReader(io.BytesIO(data))
    pages = []
    for i, page in enumerate(reader.pages, 1):
        t = (page.extract_text() or "").strip()
        if t:
            pages.append(f"[p.{i}]\n{t}")
    if not pages:
        raise ExtractError("PDFから文字を取り出せませんでした（画像だけのPDFかもしれません）")
    return "\n\n".join(pages)


def _docx(data):
    try:
        import docx
    except ImportError:
        raise ExtractError("Wordファイルを読むには pip install python-docx が必要です")
    d = docx.Document(io.BytesIO(data))
    lines = []
    for p in d.paragraphs:
        t = p.text.strip()
        if not t:
            continue
        style = (p.style.name or "").lower() if p.style is not None else ""
        if style.startswith("heading"):
            level = re.sub(r"\D", "", style) or "1"
            t = "#" * min(int(level), 6) + " " + t
        lines.append(t)
    for table in d.tables:
        for row in table.rows:
            lines.append(" | ".join(c.text.strip() for c in row.cells))
    return "\n".join(lines)


def _pptx(data):
    try:
        from pptx import Presentation
    except ImportError:
        raise ExtractError("PowerPointを読むには pip install python-pptx が必要です")
    prs = Presentation(io.BytesIO(data))
    slides = []
    for i, slide in enumerate(prs.slides, 1):
        texts = [sh.text_frame.text.strip() for sh in slide.shapes if sh.has_text_frame and sh.text_frame.text.strip()]
        if texts:
            slides.append(f"[スライド{i}]\n" + "\n".join(texts))
    return "\n\n".join(slides)


def extract_file(filename, data):
    ext = os.path.splitext(filename)[1].lower()
    if ext == ".pdf":
        text = _pdf(data)
    elif ext == ".docx":
        text = _docx(data)
    elif ext == ".pptx":
        text = _pptx(data)
    elif ext in (".html", ".htm"):
        text = html_to_text(_decode(data))
    elif ext in (".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".vtt", ".srt", ""):
        text = _decode(data)
    else:
        raise ExtractError(f"{ext} 形式には対応していません（txt / md / pdf / docx / pptx / html に対応）")
    text = text.replace("\r\n", "\n").strip()
    if not text:
        raise ExtractError("文字が見つかりませんでした")
    return text


def extract_url(url):
    if not re.match(r"^https?://", url):
        raise ExtractError("http:// か https:// で始まるURLを入れてください")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (local-notebook)"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read(20_000_000)
            ctype = r.headers.get("Content-Type", "")
    except Exception as e:
        raise ExtractError(f"ページを取得できませんでした: {e}")
    if "pdf" in ctype or url.lower().endswith(".pdf"):
        return _guess_title(url, ""), _pdf(data)
    raw = _decode(data)
    m = re.search(r"(?is)<title[^>]*>(.*?)</title>", raw)
    title = html.unescape(m.group(1)).strip() if m else ""
    return _guess_title(url, title), html_to_text(raw)


def _guess_title(url, title):
    return title[:120] if title else url.rstrip("/").rsplit("/", 1)[-1][:120] or url
