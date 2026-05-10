"""
Tests fuer den Streaming-Pfad (Pass 2).

  G1: json_stream_parser — synthetische Chunks → 5 Felder
  G2: json_stream_parser — char-by-char + Escapes
  G3: Mistral-Client extract_structured_streaming gegen echtes API
      (kleines Schema, 1 Anlage, ~5 Felder). SKIP wenn kein Key.

Run:
  cd /home/christoph.bertsch/dev-cb-ctax/scripts/sturm_pipeline_prototype/
  source .venv/bin/activate
  pytest test_streaming.py -v
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from json_stream_parser import IncrementalArrayParser  # noqa: E402
from mistral_client import MistralClient, StreamingChunk  # noqa: E402


# ──────────────────────────────────────────────────────────────────────
# G1+G2: JSON-Stream-Parser
# ──────────────────────────────────────────────────────────────────────


def test_parser_emits_5_felder_in_chunks():
    p = IncrementalArrayParser(array_property="felder")
    chunks = [
        '{"fel',
        'der": [{"feld_name": "a", "wert": 1}',
        ', {"feld_name": "b", "wert": 2}, {"fe',
        'ld_name": "c", "wert": 3}, ',
        '{"feld_name": "d", "wert": 4}',
        ', {"feld_name": "e", "wert": 5}]}',
    ]
    out = []
    for c in chunks:
        out.extend(p.feed(c))
    assert len(out) == 5
    assert [x["feld_name"] for x in out] == ["a", "b", "c", "d", "e"]
    assert [x["wert"] for x in out] == [1, 2, 3, 4, 5]


def test_parser_handles_escapes_char_by_char():
    p = IncrementalArrayParser(array_property="felder")
    payload = (
        '{"felder": [{"feld_name": "name", "wert": "Hans \\"M\\u00fcller\\""}, '
        '{"feld_name": "x", "wert": "}"}]}'
    )
    out = []
    for c in payload:
        out.extend(p.feed(c))
    assert len(out) == 2
    assert out[0]["wert"] == 'Hans "Müller"'
    assert out[1]["wert"] == "}"


def test_parser_skips_until_array_property():
    """Wenn vor 'felder' noch andere Properties stehen, ueberspringt der Parser sie."""
    p = IncrementalArrayParser(array_property="felder")
    payload = (
        '{"meta": {"source": "test"}, '
        '"felder": [{"feld_name": "x", "wert": 1}]}'
    )
    out = []
    for c in payload:
        out.extend(p.feed(c))
    assert len(out) == 1
    assert out[0]["feld_name"] == "x"


def test_parser_emits_immediately_after_close():
    """Wichtig fuer T_first_field: Item wird emittiert bei '}', nicht erst bei ']'."""
    p = IncrementalArrayParser(array_property="felder")
    list(p.feed('{"felder": ['))
    out = list(p.feed('{"feld_name": "first", "wert": 42}'))
    # Item ist hier bereits emittiert — vor dem Komma/']'
    assert len(out) == 1
    assert out[0] == {"feld_name": "first", "wert": 42}


# ──────────────────────────────────────────────────────────────────────
# G3: Echte Mistral-API (skip wenn kein Key)
# ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_mistral_streaming_emits_at_least_one_chunk():
    if not os.getenv("MISTRAL_API_KEY"):
        pytest.skip("kein MISTRAL_API_KEY — Live-Test geskippt")

    schema = {
        "type": "function",
        "function": {
            "name": "extrahiere_felder",
            "description": "Extrahiere ein paar simple Demo-Felder.",
            "parameters": {
                "type": "object",
                "properties": {
                    "felder": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "feld_name": {"type": "string"},
                                "wert": {},
                                "elster_code": {"type": "string"},
                            },
                            "required": ["feld_name", "wert", "elster_code"],
                        },
                    }
                },
                "required": ["felder"],
            },
        },
    }
    text = (
        "Bruttolohn: 49500,00 EUR\n"
        "Lohnsteuer: 7842,00 EUR\n"
        "Solidaritaetszuschlag: 0,00 EUR\n"
        "Kirchensteuer: 705,78 EUR\n"
        "IdNr: 12345678901\n"
    )
    client = MistralClient()
    assert client.verfuegbar

    n_chunks_seen = 0
    n_completed = 0
    n_done = 0
    async for chunk in client.extract_structured_streaming(
        text=text,
        function_schema=schema,
        system_prompt=(
            "Extrahiere alle erkennbaren Felder als Array. Pro Feld: feld_name, "
            "wert, elster_code (z.B. E0200204). Rufe das Tool genau einmal."
        ),
        user_prompt="Extrahiere die Felder aus diesem Lohnsteuer-Snippet.",
        array_property="felder",
        max_tokens=2000,
    ):
        n_chunks_seen += 1
        if chunk.chunk_type == "completed_field":
            n_completed += 1
        elif chunk.chunk_type == "done":
            n_done += 1
            break

    assert n_chunks_seen >= 1, "Mistral hat keinen einzigen Stream-Chunk geliefert"
    assert n_done == 1
    # Mindestens 1 Feld sollte komplett sein
    assert n_completed >= 1, f"Kein einziges Feld komplett emittiert (chunks_total={n_chunks_seen})"
    print(f"OK: {n_chunks_seen} chunks, {n_completed} completed felder")


if __name__ == "__main__":
    # Ohne pytest: nur die synchronen Tests
    test_parser_emits_5_felder_in_chunks()
    test_parser_handles_escapes_char_by_char()
    test_parser_skips_until_array_property()
    test_parser_emits_immediately_after_close()
    print("synchrone Tests OK")
    if os.getenv("MISTRAL_API_KEY"):
        asyncio.run(test_mistral_streaming_emits_at_least_one_chunk())
        print("Mistral-Streaming-Test OK")
    else:
        print("Mistral-Test geskippt (kein Key)")
