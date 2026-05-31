#!/usr/bin/env python3
"""provenance — rastert ein Dokument zu PNG(s) und OCRt GENAU dieses PNG via
:11440, sodass die zurückgegebenen bboxes im selben Pixelraum wie das Bild
liegen (pixelgenaue gelbe Overlay-Boxen im Viewer, ohne DPI-Raterei).

Aufruf:  provenance.py <docpath> <outdir>
Stdout:  JSON {"pages":[{"w":W,"h":H,"png":"<outdir>/p0.png","records":[{"text":..,"bbox":[x0,y0,x1,y1]}]}]}
"""
import base64, io, json, os, sys, urllib.request

OCR_URL = os.environ.get("PROV_OCR_URL", "http://127.0.0.1:11440/v1/chat/completions")
MAXW = int(os.environ.get("PROV_MAXW", "1100"))  # Anzeige-/OCR-Breite (Balance Schärfe/Größe)


def ocr_png(png_bytes):
    b64 = base64.b64encode(png_bytes).decode()
    body = json.dumps({"model": "paddleocr-classical", "messages": [{"role": "user",
        "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}}]}]}).encode()
    req = urllib.request.Request(OCR_URL, data=body, headers={"Content-Type": "application/json"})
    try:
        resp = json.load(urllib.request.urlopen(req, timeout=120))
        recs = json.loads(resp["choices"][0]["message"]["content"])
        out = []
        for r in recs:
            b = r.get("bbox")
            if b and len(b) == 4:
                out.append({"text": r.get("text", ""), "bbox": [round(x, 1) for x in b]})
        return out
    except Exception as e:
        return []


def page_data(path):
    """Yield (PIL.Image, records_or_None) pro Seite.

    PDF mit Textebene → Wort-Boxen direkt aus fitz (get_text("words")),
    mit DEMSELBEN zoom skaliert wie das gerenderte PNG → exakt, OCR-frei.
    Bild oder image-only-PDF (keine Wörter) → records=None ⇒ Caller OCRt das PNG.
    """
    from PIL import Image
    name = path.lower()
    if name.endswith(".pdf"):
        import fitz
        doc = fitz.open(path)
        for pg in doc:
            # Skaliere so, dass die Breite ~MAXW ist.
            zoom = MAXW / pg.rect.width if pg.rect.width else 1.5
            pix = pg.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            im = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
            words = pg.get_text("words") or []  # (x0,y0,x1,y1,wort,block,line,wno)
            recs = [{"text": w[4], "bbox": [round(w[0] * zoom, 1), round(w[1] * zoom, 1),
                                            round(w[2] * zoom, 1), round(w[3] * zoom, 1)]}
                    for w in words if str(w[4]).strip()]
            yield im, (recs if recs else None)
    else:
        im = Image.open(path).convert("RGB")
        if im.width > MAXW:
            im = im.resize((MAXW, round(im.height * MAXW / im.width)))
        yield im, None


def main():
    path, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    pages = []
    for i, (im, recs) in enumerate(page_data(path)):
        png_path = os.path.join(outdir, f"p{i}.png")
        im.save(png_path, "PNG")
        if recs is None:  # Bild / image-only-PDF → OCR das gerenderte PNG
            recs = ocr_png(open(png_path, "rb").read())
        pages.append({"w": im.width, "h": im.height, "png": png_path, "records": recs})
    print(json.dumps({"pages": pages}))


if __name__ == "__main__":
    main()
