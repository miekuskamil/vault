"""Malformed and hostile spreadsheets for the robustness tests (built from pictures.xlsx)."""
import io, os, re, struct, zipfile, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "hostile")
os.makedirs(OUT, exist_ok=True)
base = open(os.path.join(HERE, "pictures.xlsx"), "rb").read()


def rewrite(changes, name, extra=None):
    zin = zipfile.ZipFile(io.BytesIO(base))
    out = io.BytesIO()
    zout = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)
    for info in zin.infolist():
        data = zin.read(info.filename)
        if info.filename in changes:
            data = changes[info.filename](data.decode()).encode()
        zout.writestr(info.filename, data)
    for k, v in (extra or {}).items():
        zout.writestr(k, v)
    zout.close()
    open(os.path.join(OUT, name), "wb").write(out.getvalue())
    return out.getvalue()


# a row number far past Excel's limit
rewrite({"xl/worksheets/sheet1.xml": lambda s: s.replace('<row r="6"', '<row r="20000000"').replace('r="A6"', 'r="A20000000"').replace('r="C6"', 'r="C20000000"')}, "huge-row.xlsx")
# a rich value that is not a local picture (like a web image): cell keeps its text, no picture
rewrite({"xl/richData/rdrichvaluestructure.xml": lambda s: s.replace("_rvRel:LocalImageIdentifier", "_rvRel:WebImageIdentifier").replace('t="_localImage"', 't="_webimage"')}, "web-image.xlsx")
# a picture on the blank row right under the headings
def blank_under_headings(sheet):
    # move Alarm..Skrytka down one row, leaving row 2 blank; the first picture stays anchored on row 2 (index 1)
    def bump(m):
        n = int(m.group(2))
        return f'{m.group(1)}{n + 1 if n >= 2 else n}'
    sheet = re.sub(r'(<row r=")(\d+)', bump, sheet)
    sheet = re.sub(r'(r="[A-Z]+)(\d+)', bump, sheet)
    return sheet
rewrite({"xl/worksheets/sheet1.xml": blank_under_headings}, "picture-under-headings.xlsx")

# zip bomb: 80 MB of spaces inside the sheet XML, honest sizes
bomb = io.BytesIO()
z = zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED)
zin = zipfile.ZipFile(io.BytesIO(base))
for info in zin.infolist():
    data = zin.read(info.filename)
    if info.filename == "xl/worksheets/sheet1.xml":
        data = data.replace(b"<sheetData>", b"<sheetData>" + b" " * (80 * 1024 * 1024))
    z.writestr(info.filename, data)
z.close()
open(os.path.join(OUT, "bomb.xlsx"), "wb").write(bomb.getvalue())

# the same bomb, but the zip directory lies about the unpacked size
raw = bytearray(bomb.getvalue())
name = b"xl/worksheets/sheet1.xml"
i = 0
while True:
    i = raw.find(b"PK\x01\x02", i)
    if i < 0:
        break
    nlen = struct.unpack_from("<H", raw, i + 28)[0]
    if raw[i + 46:i + 46 + nlen] == name:
        struct.pack_into("<I", raw, i + 24, 5000)
    i += 4
open(os.path.join(OUT, "bomb-lying.xlsx"), "wb").write(bytes(raw))
print("ok", sorted(os.listdir(OUT)))
