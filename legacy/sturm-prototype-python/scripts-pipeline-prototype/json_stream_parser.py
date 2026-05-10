"""
json_stream_parser — Inkrementeller Parser fuer Mistral-Tool-Call-Argumente.

Anwendungsfall: Mistral streamt Tool-Call-Argumente Token fuer Token. Wir
wollen NICHT auf den vollstaendigen Stream warten, sondern jedes Element
eines Top-Level-Arrays (z.B. `args["felder"][i]`) sofort emittieren, sobald
es geschlossen ist.

Beispiel:
  Stream-Chunks (akkumuliert):
    {"felder": [
    {"feld_name": "bruttolohn", "wert": 49500}
    , {"feld_name": "lohnsteuer", "wert": 7842}

  Erst beim Schliessen der inneren Klammer "}" wird das Element emittiert.

Der Parser ist ein simples brace-tracking-Statemachine, das Strings und
Escape-Sequenzen korrekt behandelt. Er ist nicht versucht, ein
generischer JSON-Parser zu sein, sondern erwartet die Struktur:

  {"<array_property>": [ <obj1>, <obj2>, ... ] [...maybe other props...]}

Sobald ein `<obj_i>` komplett ist (Brace-Tiefe wieder 0 relativ zum
Array-Item-Start), wird es per `json.loads()` in ein dict konvertiert
und yieldet.
"""

from __future__ import annotations

import json
import logging
from typing import Iterator, Optional

log = logging.getLogger("sturm.json_stream")


class IncrementalArrayParser:
    """Inkrementeller Parser fuer ein bestimmtes Top-Level-Array-Property.

    State-Machine-Phasen:
      0: warten bis wir den array_property-Key + ":" + "[" gesehen haben
      1: warten auf den Anfang eines Items (z.B. "{")
      2: innerhalb eines Items — Brace-Counter pflegen
      3: array geschlossen — Stream wird ignoriert
    """

    def __init__(self, array_property: str = "felder") -> None:
        self.array_property = array_property
        # Akku der gesamten Argumente (zum Suchen des Property-Starts)
        self._buf: str = ""
        # Pos im Buffer, ab der das Array begann (nach "[")
        self._array_start_pos: int = -1
        # Sind wir aktuell im Array-Modus?
        self._in_array: bool = False
        # Aktueller Item-Buffer
        self._item_buf: str = ""
        # Brace-Tiefe innerhalb eines Items
        self._brace_depth: int = 0
        # Sind wir aktuell innerhalb eines Strings? Tracked Escapes.
        self._in_string: bool = False
        self._escape: bool = False
        # Haben wir bereits den "[" nach dem Property gesehen?
        self._array_opened: bool = False
        # Item gerade gestartet (warten auf ersten "{")
        self._collecting_item: bool = False

    # ──────────────────────────────────────────────────────────────────
    # Locating the array opening
    # ──────────────────────────────────────────────────────────────────

    def _try_locate_array_open(self) -> bool:
        """Suche nach "<key>": [ im Buffer und setze _array_opened."""
        if self._array_opened:
            return True
        # Naive Suche — toleriert Whitespace zwischen ":" und "["
        key_pat = f'"{self.array_property}"'
        idx = self._buf.find(key_pat)
        if idx < 0:
            return False
        # Nach dem Key kommt ":" und dann "["
        rest = self._buf[idx + len(key_pat):]
        # Skip whitespace
        i = 0
        while i < len(rest) and rest[i] in " \t\r\n":
            i += 1
        if i >= len(rest) or rest[i] != ":":
            return False
        i += 1
        while i < len(rest) and rest[i] in " \t\r\n":
            i += 1
        if i >= len(rest):
            return False
        if rest[i] != "[":
            return False
        i += 1
        # Setze Pos im _buf nach dem "["
        self._array_start_pos = idx + len(key_pat) + i
        self._array_opened = True
        self._in_array = True
        return True

    # ──────────────────────────────────────────────────────────────────
    # Main feed
    # ──────────────────────────────────────────────────────────────────

    def feed(self, chunk: str) -> Iterator[dict]:
        """Konsumiert einen weiteren Chunk und yielded fertige Items."""
        if not chunk:
            return
        self._buf += chunk

        # Phase 0: Suche nach Array-Opening
        if not self._array_opened:
            if not self._try_locate_array_open():
                return  # Noch nicht genug Daten

        # Ab hier sind wir im Array. Wir konsumieren ab _array_start_pos
        # alle Zeichen, die noch nicht verarbeitet wurden.
        # Dazu nutzen wir einen Cursor, der auf den naechsten zu lesenden
        # Char in _buf zeigt. Beim ersten Mal: _array_start_pos. Danach:
        # _buf-Laenge bis chunk-start.
        # Vereinfachung: wir verarbeiten den Tail _buf[_array_start_pos:]
        # vollstaendig — nach Verarbeitung verwerfen wir alles bis Position
        # nach dem letzten geschlossenen Item.

        tail = self._buf[self._array_start_pos:]
        i = 0
        while i < len(tail):
            ch = tail[i]
            if not self._collecting_item and self._brace_depth == 0:
                # Warten auf "{" oder "]"
                if ch == "{":
                    self._collecting_item = True
                    self._item_buf = "{"
                    self._brace_depth = 1
                    self._in_string = False
                    self._escape = False
                elif ch == "]":
                    # Array zu Ende
                    self._in_array = False
                    self._array_start_pos += i + 1
                    return
                # sonst: Whitespace, Komma — ignorieren
                i += 1
                continue

            # Wir sammeln gerade ein Item
            self._item_buf += ch
            if self._in_string:
                if self._escape:
                    self._escape = False
                elif ch == "\\":
                    self._escape = True
                elif ch == '"':
                    self._in_string = False
            else:
                if ch == '"':
                    self._in_string = True
                elif ch == "{":
                    self._brace_depth += 1
                elif ch == "}":
                    self._brace_depth -= 1
                    if self._brace_depth == 0:
                        # Item komplett — parsen
                        item_str = self._item_buf
                        self._item_buf = ""
                        self._collecting_item = False
                        try:
                            obj = json.loads(item_str)
                        except json.JSONDecodeError as e:
                            log.warning(
                                "json_stream_parser: konnte item nicht parsen: %s; item=%r",
                                e, item_str[:200],
                            )
                        else:
                            if isinstance(obj, dict):
                                yield obj
                            else:
                                log.warning(
                                    "json_stream_parser: item kein dict (typ=%s)",
                                    type(obj).__name__,
                                )
            i += 1

        # Cursor um die Anzahl tatsaechlich konsumierter Bytes weiterstellen.
        # Wir konsumieren ALLES bis i (auch die Bytes die noch in _item_buf
        # akkumulieren — das ist OK, weil _item_buf das eigentliche Material
        # haelt; _array_start_pos zeigt nur an, wo wir im _buf naechsten Feed
        # weiterlesen sollen).
        self._array_start_pos += i


# ──────────────────────────────────────────────────────────────────────
# Inline-Tests (nicht als pytest, aber als Smoketest aufrufbar)
# ──────────────────────────────────────────────────────────────────────


def _assert_emits(parser: IncrementalArrayParser, chunk: str, expected_n: int,
                  expected_first: Optional[dict] = None) -> list[dict]:
    out = list(parser.feed(chunk))
    assert len(out) == expected_n, (
        f"Erwartet {expected_n} items, bekommen {len(out)} aus chunk={chunk!r} → {out}"
    )
    if expected_first is not None and out:
        assert out[0] == expected_first, f"Erstes Item {out[0]} != erwartet {expected_first}"
    return out


def _smoketest() -> None:
    # Test 1: Minimal — ein vollstaendiges Item ueber zwei Chunks
    p = IncrementalArrayParser(array_property="felder")
    _assert_emits(p, '{"felder": [', expected_n=0)
    _assert_emits(p, '{"feld_name": "bruttolohn", "wert": 49500}', expected_n=1,
                  expected_first={"feld_name": "bruttolohn", "wert": 49500})

    # Test 2: Fuenf Felder, in beliebigen Chunks
    p = IncrementalArrayParser(array_property="felder")
    chunks = [
        '{"fel',
        'der": [{"feld_name": "a", "wert": 1}',
        ', {"feld_name": "b", "wert": 2}, {"fe',
        'ld_name": "c", "wert": 3}, ',
        '{"feld_name": "d", "wert": 4}',
        ', {"feld_name": "e", "wert": 5}]}',
    ]
    total: list[dict] = []
    for c in chunks:
        total.extend(p.feed(c))
    assert len(total) == 5, f"Erwartet 5 items, bekommen {len(total)}"
    assert total[0]["feld_name"] == "a"
    assert total[4]["wert"] == 5
    print("smoketest 2 OK — 5 felder in 6 chunks")

    # Test 3: Strings mit Escapes
    p = IncrementalArrayParser(array_property="felder")
    payload = (
        '{"felder": [{"feld_name": "name", "wert": "Hans \\"M\\u00fcller\\""}, '
        '{"feld_name": "x", "wert": "}"}]}'
    )
    out: list[dict] = []
    # Zerstueckle in 1-char-chunks (worst case)
    for c in payload:
        out.extend(p.feed(c))
    assert len(out) == 2, f"Erwartet 2, bekommen {len(out)}: {out}"
    assert out[0]["wert"] == 'Hans "Müller"'
    assert out[1]["wert"] == "}"
    print("smoketest 3 OK — strings mit escapes + char-by-char")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    _smoketest()
    print("alle smoketests OK")
