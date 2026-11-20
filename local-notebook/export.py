"""Markdown → Word(.docx) 変換（見出し・箇条書き・番号リスト・表・太字に対応）"""
import io
import re


def markdown_to_docx(md, title=None):
    try:
        import docx
        from docx.oxml.ns import qn
        from docx.shared import Pt
    except ImportError:
        raise RuntimeError("Word出力には pip install python-docx が必要です")

    doc = docx.Document()
    style = doc.styles["Normal"]
    style.font.size = Pt(10.5)
    style.font.name = "Yu Gothic"
    style.element.rPr.rFonts.set(qn("w:eastAsia"), "游ゴシック")
    if title:
        doc.core_properties.title = title

    def add_runs(par, text):
        # **太字** と `コード` を反映。リンク [文字](URL) は文字だけ残す
        text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
        for part in re.split(r"(\*\*[^*]+\*\*|`[^`]+`)", text):
            if part.startswith("**") and part.endswith("**") and len(part) > 4:
                par.add_run(part[2:-2]).bold = True
            elif part.startswith("`") and part.endswith("`") and len(part) > 2:
                par.add_run(part[1:-1])
            elif part:
                par.add_run(part)

    lines = md.replace("\r\n", "\n").split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        s = line.strip()
        if not s:
            i += 1
            continue
        # 表
        if s.startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|?\s*:?-{2,}", lines[i + 1]):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                if not re.match(r"^\s*\|?\s*:?-{2,}", lines[i]):
                    rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            ncol = max(len(r) for r in rows)
            table = doc.add_table(rows=len(rows), cols=ncol)
            table.style = "Table Grid"
            for r, row in enumerate(rows):
                for c in range(ncol):
                    cell = table.cell(r, c)
                    cell.text = ""
                    add_runs(cell.paragraphs[0], row[c] if c < len(row) else "")
                    if r == 0:
                        for run in cell.paragraphs[0].runs:
                            run.bold = True
            doc.add_paragraph()
            continue
        m = re.match(r"^(#{1,6})\s+(.*)", s)
        if m:
            level = len(m.group(1))
            doc.add_heading(m.group(2).replace("**", ""), level=0 if level == 1 else min(level - 1, 4))
        elif re.match(r"^[-*・]\s+", s):
            indent = len(line) - len(line.lstrip())
            p = doc.add_paragraph(style="List Bullet 2" if indent >= 2 else "List Bullet")
            add_runs(p, re.sub(r"^[-*・]\s+", "", s))
        elif re.match(r"^\d+[.)．]\s+", s):
            p = doc.add_paragraph(style="List Number")
            add_runs(p, re.sub(r"^\d+[.)．]\s+", "", s))
        elif s.startswith(">"):
            p = doc.add_paragraph(style="Quote")
            add_runs(p, s.lstrip("> "))
        elif re.match(r"^-{3,}$|^\*{3,}$", s):
            doc.add_paragraph("―" * 20)
        else:
            add_runs(doc.add_paragraph(), s)
        i += 1

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
