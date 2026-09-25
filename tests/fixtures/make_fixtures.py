"""Builds the spreadsheet fixtures used by the import tests.

pictures.xlsx            two tabs; floating pictures anchored to rows (Dom) and an Excel 365
                         "Place in cell" picture (Zdrowie)
protected-agile.xlsx     pictures.xlsx encrypted the way Excel 2010+ does it (msoffcrypto-tool)
protected-standard.xlsx  pictures.xlsx encrypted the Excel 2007 way (AES-128, SHA-1)

Needs: pip install openpyxl pillow msoffcrypto-tool cryptography
"""
import io, os, struct, zipfile, hashlib, re

from openpyxl import Workbook
from openpyxl.drawing.image import Image as XLImage
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
PASSWORD = "Żółw-Tajny 2024!"


def picture(color, label, fmt="PNG"):
    im = Image.new("RGB", (120, 80), color)
    ImageDraw.Draw(im).text((10, 30), label, fill="white")
    b = io.BytesIO()
    im.save(b, fmt)
    b.seek(0)
    return b


def build_plain():
    wb = Workbook()
    dom = wb.active
    dom.title = "Dom"
    dom.append(["Nazwa", "Login", "Hasło", "Zdjęcie"])
    dom.append(["Alarm", "admin", "alarm#1"])
    dom.append(["Router", "root", "r0uter!"])
    dom.append(["Brama", "", "4321"])
    dom.append([])
    dom.append(["Skrytka", "", "9999"])
    a = XLImage(picture((200, 40, 90), "alarm"))
    dom.add_image(a, "D2")          # row 2 -> Alarm
    b = XLImage(picture((40, 90, 200), "gate", "JPEG"))
    b.format = "jpeg"
    dom.add_image(b, "D5")          # blank row 5 -> joins Brama above
    zd = wb.create_sheet("Zdrowie")
    zd.append(["Name", "Username", "Password", "Card"])
    zd.append(["NHS", "kamil@example.com", "nhs-pass", None])
    zd.append(["Dentist", "", "", None])
    raw = io.BytesIO()
    wb.save(raw)
    return add_in_cell_picture(raw.getvalue(), sheet_file="xl/worksheets/sheet2.xml", cell="D2")


def add_in_cell_picture(xlsx, sheet_file, cell):
    """Adds an Excel 365 in-cell picture (rich value) to one cell."""
    zin = zipfile.ZipFile(io.BytesIO(xlsx))
    out = io.BytesIO()
    zout = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)
    for info in zin.infolist():
        data = zin.read(info.filename)
        if info.filename == sheet_file:
            s = data.decode()
            row = int(re.sub(r"\D", "", cell))
            s, n = re.subn(rf'(<row r="{row}"[^>]*>.*?)(</row>)', rf'\1<c r="{cell}" t="e" vm="1"><v>#VALUE!</v></c>\2', s, count=1, flags=re.S)
            assert n == 1
            data = s.encode()
        if info.filename == "[Content_Types].xml":
            s = data.decode()
            s = s.replace("</Types>",
                '<Override PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/>'
                '<Override PartName="/xl/richData/rdrichvalue.xml" ContentType="application/vnd.ms-excel.rdrichvalue+xml"/>'
                '<Override PartName="/xl/richData/rdrichvaluestructure.xml" ContentType="application/vnd.ms-excel.rdrichvaluestructure+xml"/>'
                '<Override PartName="/xl/richData/richValueRel.xml" ContentType="application/vnd.ms-excel.richvaluerel+xml"/>'
                '<Default Extension="png" ContentType="image/png"/></Types>' if 'Extension="png"' not in s else
                '<Override PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/>'
                '<Override PartName="/xl/richData/rdrichvalue.xml" ContentType="application/vnd.ms-excel.rdrichvalue+xml"/>'
                '<Override PartName="/xl/richData/rdrichvaluestructure.xml" ContentType="application/vnd.ms-excel.rdrichvaluestructure+xml"/>'
                '<Override PartName="/xl/richData/richValueRel.xml" ContentType="application/vnd.ms-excel.richvaluerel+xml"/></Types>')
            data = s.encode()
        if info.filename == "xl/_rels/workbook.xml.rels":
            s = data.decode().replace("</Relationships>",
                '<Relationship Id="rIdMeta" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata" Target="metadata.xml"/>'
                '<Relationship Id="rIdRv" Type="http://schemas.microsoft.com/office/2022/10/relationships/richValueRel" Target="richData/richValueRel.xml"/>'
                '<Relationship Id="rIdRvd" Type="http://schemas.microsoft.com/office/2017/06/relationships/rdRichValue" Target="richData/rdrichvalue.xml"/>'
                '<Relationship Id="rIdRvs" Type="http://schemas.microsoft.com/office/2017/06/relationships/rdRichValueStructure" Target="richData/rdrichvaluestructure.xml"/>'
                "</Relationships>")
            data = s.encode()
        zout.writestr(info, data)
    zout.writestr("xl/metadata.xml",
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xlrd="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata">'
        '<metadataTypes count="1"><metadataType name="XLRICHVALUE" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1"/></metadataTypes>'
        '<futureMetadata name="XLRICHVALUE" count="1"><bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}"><xlrd:rvb i="0"/></ext></extLst></bk></futureMetadata>'
        '<valueMetadata count="1"><bk><rc t="1" v="0"/></bk></valueMetadata></metadata>')
    zout.writestr("xl/richData/rdrichvalue.xml",
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<rvData xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="1"><rv s="0"><v>0</v><v>5</v></rv></rvData>')
    zout.writestr("xl/richData/rdrichvaluestructure.xml",
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<rvStructures xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="1"><s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/></s></rvStructures>')
    zout.writestr("xl/richData/richValueRel.xml",
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<richValueRels xmlns="http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><rel r:id="rId1"/></richValueRels>')
    zout.writestr("xl/richData/_rels/richValueRel.xml.rels",
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/incell1.png"/></Relationships>')
    zout.writestr("xl/media/incell1.png", picture((30, 150, 90), "nhs card").getvalue())
    zout.close()
    return out.getvalue()


def encrypt_agile(plain):
    from msoffcrypto.format.ooxml import OOXMLFile
    out = io.BytesIO()
    OOXMLFile(io.BytesIO(plain)).encrypt(PASSWORD, out)
    return out.getvalue()


def encrypt_standard(plain):
    """ECMA-376 Standard Encryption (Excel 2007): AES-128-ECB, SHA-1, 50,000 spins."""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from msoffcrypto.method.container.ecma376_encrypted import ECMA376Encrypted
    salt = os.urandom(16)
    pw = PASSWORD.encode("utf-16le")
    h = hashlib.sha1(salt + pw).digest()
    for i in range(50000):
        h = hashlib.sha1(struct.pack("<I", i) + h).digest()
    hfinal = hashlib.sha1(h + struct.pack("<I", 0)).digest()
    buf1 = bytes(a ^ b for a, b in zip(hfinal, b"\x36" * 20)) + b"\x36" * 44
    key = hashlib.sha1(buf1).digest()[:16]
    ecb = lambda data: (lambda e: e.update(data) + e.finalize())(Cipher(algorithms.AES(key), modes.ECB()).encryptor())
    verifier = os.urandom(16)
    enc_verifier = ecb(verifier)
    enc_verifier_hash = ecb(hashlib.sha1(verifier).digest() + b"\x00" * 12)
    csp = "Microsoft Enhanced RSA and AES Cryptographic Provider\x00".encode("utf-16le")
    header = struct.pack("<IIIIIIII", 0x24, 0, 0x660E, 0x8004, 128, 0x18, 0, 0) + csp
    info = struct.pack("<HHI", 4, 2, 0x24) + struct.pack("<I", len(header)) + header
    info += struct.pack("<I", 16) + salt + enc_verifier + struct.pack("<I", 20) + enc_verifier_hash
    padded = plain + b"\x00" * (-len(plain) % 16)
    package = struct.pack("<Q", len(plain)) + ecb(padded)
    out = io.BytesIO()
    ECMA376Encrypted(package, info).write_to(out)
    return out.getvalue()


def check(path, plain):
    import msoffcrypto
    with open(path, "rb") as f:
        of = msoffcrypto.OfficeFile(f)
        of.load_key(password=PASSWORD)
        out = io.BytesIO()
        of.decrypt(out)
    assert out.getvalue() == plain, path


if __name__ == "__main__":
    plain = build_plain()
    with open(os.path.join(HERE, "pictures.xlsx"), "wb") as f:
        f.write(plain)
    for name, fn in (("protected-agile.xlsx", encrypt_agile), ("protected-standard.xlsx", encrypt_standard)):
        p = os.path.join(HERE, name)
        with open(p, "wb") as f:
            f.write(fn(plain))
        check(p, plain)
    print("ok")
