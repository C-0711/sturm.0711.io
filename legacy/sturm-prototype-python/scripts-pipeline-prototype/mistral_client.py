"""
mistral_client — duenner async Wrapper fuer Mistral OCR + Mistral Large.

Zwei Entry-Points:
  - ocr(pdf_bytes, dateiname)        -> str            # OCR-Volltext
  - extract_structured(text, fn)     -> dict           # JSON via Function-Call

Patterns kopiert/adaptiert aus
  ~/CTAXV1/services/lane4_master/services/mistral_ocr_service.py
  ~/CTAXV1/services/lane4_master/services/mistral_extraction_service.py

API-Key kommt aus ENV (MISTRAL_API_KEY, optional MISTRAL_API_KEY_2).
1 Retry mit exponentialem Backoff bei Rate-Limit (429).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Literal, Optional

log = logging.getLogger("sturm.mistral")


SMALL_MODEL = "mistral-small-latest"
LARGE_MODEL = "mistral-large-latest"
OCR_MODEL = "mistral-ocr-latest"


@dataclass
class StreamingChunk:
    """Ein Stream-Event aus extract_structured_streaming.

    chunk_type:
      - "partial_args"   → Mistral hat einen weiteren Token-Delta für die
                            Function-Call-arguments-Property geliefert. Noch
                            kein vollständiges Feld extrahierbar.
      - "completed_field" → Der inkrementelle Parser hat ein vollständiges
                            Top-Level-Array-Item (z.B. felder[i]) erkannt.
                            `completed_field` ist das geparste Dict.
      - "done"            → Stream zu Ende; `partial_args_so_far` ist die
                            komplette JSON-String-Form.
    """

    chunk_type: Literal["partial_args", "completed_field", "done"]
    raw_delta: str = ""
    partial_args_so_far: str = ""
    completed_field: Optional[dict] = None
    # Bei "done": komplette geparste args (falls JSON valide war)
    final_args: Optional[dict] = None


@dataclass
class OcrResult:
    text: str
    seiten_text: list[str]
    n_seiten: int
    dauer_ms: int
    fehler: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.fehler is None and bool(self.text.strip())


class MistralClient:
    """Sehr duenner asynchroner Wrapper. Lazy-Init, Key-Rotation."""

    def __init__(self, api_keys: Optional[list[str]] = None) -> None:
        self._keys = api_keys or self._lade_keys()
        self._idx = 0
        self._clients: dict[int, Any] = {}

    @staticmethod
    def _lade_keys() -> list[str]:
        out: list[str] = []
        for var in ("MISTRAL_API_KEY", "MISTRAL_API_KEY_2"):
            v = (os.getenv(var) or "").strip()
            if v:
                out.append(v)
        return out

    @property
    def verfuegbar(self) -> bool:
        return bool(self._keys)

    def _client(self):
        try:
            from mistralai import Mistral
        except ImportError as e:
            raise ImportError("mistralai nicht installiert: pip install mistralai") from e
        if self._idx not in self._clients:
            self._clients[self._idx] = Mistral(api_key=self._keys[self._idx])
        return self._clients[self._idx]

    def _rotate(self) -> bool:
        if len(self._keys) <= 1:
            return False
        self._idx = (self._idx + 1) % len(self._keys)
        log.info("Mistral key rotated -> idx=%d", self._idx)
        return True

    # ──────────────────────────────────────────────────────────────────
    # OCR
    # ──────────────────────────────────────────────────────────────────

    async def ocr(self, pdf_bytes: bytes, dateiname: str = "doc.pdf") -> OcrResult:
        if not self.verfuegbar:
            return OcrResult("", [], 0, 0, fehler="kein MISTRAL_API_KEY")

        b64 = base64.b64encode(pdf_bytes).decode("ascii")
        endung = Path(dateiname).suffix.lower()
        mime = {
            ".pdf": "application/pdf",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
        }.get(endung, "application/pdf")
        document_uri = f"data:{mime};base64,{b64}"

        start = time.time()
        for versuch in range(2):
            try:
                client = self._client()
                resp = await asyncio.to_thread(
                    client.ocr.process,
                    model=OCR_MODEL,
                    document={"type": "document_url", "document_url": document_uri},
                )
                seiten: list[str] = []
                for page in getattr(resp, "pages", []) or []:
                    t = getattr(page, "markdown", None) or getattr(page, "text", None) or ""
                    if t:
                        seiten.append(t.strip())
                volltext = "\n\n".join(seiten)
                dauer = int((time.time() - start) * 1000)
                log.info("OCR ok: %d seiten, %d zeichen, %dms", len(seiten), len(volltext), dauer)
                return OcrResult(text=volltext, seiten_text=seiten, n_seiten=len(seiten), dauer_ms=dauer)
            except Exception as e:
                msg = str(e)
                if "429" in msg or "rate" in msg.lower():
                    if self._rotate():
                        await asyncio.sleep(1.0 + versuch)
                        continue
                if versuch == 0:
                    log.warning("OCR retry nach Fehler: %s", e)
                    await asyncio.sleep(1.5)
                    continue
                dauer = int((time.time() - start) * 1000)
                return OcrResult("", [], 0, dauer, fehler=str(e))

        return OcrResult("", [], 0, 0, fehler="unerreichbar")

    # ──────────────────────────────────────────────────────────────────
    # Structured Extraction (Function-Call / JSON-Mode)
    # ──────────────────────────────────────────────────────────────────

    async def extract_structured(
        self,
        text: str,
        function_schema: dict,
        system_prompt: str,
        user_prompt: str,
        model: str = LARGE_MODEL,
        temperature: float = 0.1,
        max_tokens: int = 8000,
    ) -> dict:
        """Ruft Mistral mit Tool/Function-Schema und gibt das JSON-Argument zurueck."""
        if not self.verfuegbar:
            raise RuntimeError("kein MISTRAL_API_KEY")

        # Mistral akzeptiert Function-Schema im Tools-Array.
        tools = [function_schema] if function_schema.get("type") == "function" else [
            {"type": "function", "function": function_schema}
        ]
        fn_name = (function_schema.get("function") or function_schema).get("name", "extract")

        for versuch in range(2):
            try:
                client = self._client()
                resp = await asyncio.to_thread(
                    client.chat.complete,
                    model=model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": f"{user_prompt}\n\n--- DOKUMENT ---\n{text[:18000]}"},
                    ],
                    tools=tools,
                    tool_choice="any",
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
                msg = resp.choices[0].message
                tcalls = getattr(msg, "tool_calls", None) or []
                if tcalls:
                    args = tcalls[0].function.arguments
                    return json.loads(args) if isinstance(args, str) else dict(args)
                # Fallback: content as JSON
                content = msg.content or ""
                content = content.strip()
                if content.startswith("```"):
                    content = content.split("```", 2)[1]
                    if content.startswith("json"):
                        content = content[4:]
                return json.loads(content)
            except Exception as e:
                m = str(e)
                if "429" in m or "rate" in m.lower():
                    if self._rotate():
                        await asyncio.sleep(1.0 + versuch)
                        continue
                if versuch == 0:
                    log.warning("extract retry nach Fehler (%s): %s", fn_name, e)
                    await asyncio.sleep(1.5)
                    continue
                raise

        raise RuntimeError("extract_structured nicht erreichbar")

    async def extract_structured_streaming(
        self,
        text: str,
        function_schema: dict,
        system_prompt: str,
        user_prompt: str,
        model: str = LARGE_MODEL,
        temperature: float = 0.1,
        max_tokens: int = 8000,
        array_property: str = "felder",
    ) -> AsyncIterator[StreamingChunk]:
        """Streaming-Variante von extract_structured.

        Streamt Token-Deltas vom Mistral-API. Pro Tool-Call-arguments-Delta
        wird der inkrementelle JSON-Parser gefüttert; sobald ein vollständiges
        Element von `args[array_property]` (typischerweise `felder[i]`) parsbar
        ist, wird ein StreamingChunk(chunk_type='completed_field', ...)
        emittiert.

        Yields:
          - StreamingChunk(partial_args, raw_delta, partial_args_so_far)
              für JEDEN Token-Delta — auch wenn noch kein Feld komplett ist.
          - StreamingChunk(completed_field, completed_field={...})
              sobald ein Array-Element komplett.
          - StreamingChunk(done, final_args={...} | None)
              am Ende des Streams.
        """
        if not self.verfuegbar:
            raise RuntimeError("kein MISTRAL_API_KEY")

        from json_stream_parser import IncrementalArrayParser

        tools = [function_schema] if function_schema.get("type") == "function" else [
            {"type": "function", "function": function_schema}
        ]

        parser = IncrementalArrayParser(array_property=array_property)
        partial_acc = ""

        for versuch in range(2):
            try:
                client = self._client()
                # stream_async ist ein AsyncIterator über CompletionEvent
                stream = await client.chat.stream_async(
                    model=model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": f"{user_prompt}\n\n--- DOKUMENT ---\n{text[:18000]}"},
                    ],
                    tools=tools,
                    tool_choice="any",
                    temperature=temperature,
                    max_tokens=max_tokens,
                )

                async for event in stream:
                    chunk = event.data
                    if not chunk.choices:
                        continue
                    delta = chunk.choices[0].delta
                    tcalls = getattr(delta, "tool_calls", None) or []
                    for tc in tcalls:
                        fn = getattr(tc, "function", None)
                        args_delta = getattr(fn, "arguments", None) if fn else None
                        if not args_delta:
                            continue
                        # Mistral liefert manchmal ein dict statt str — normalisieren
                        if isinstance(args_delta, dict):
                            args_delta = json.dumps(args_delta, ensure_ascii=False)
                        partial_acc += args_delta
                        # Inkrementell parsen, vollständige Elemente emittieren
                        for completed in parser.feed(args_delta):
                            yield StreamingChunk(
                                chunk_type="completed_field",
                                raw_delta=args_delta,
                                partial_args_so_far=partial_acc,
                                completed_field=completed,
                            )
                        # Auch das partial-event emittieren (zum Logging)
                        yield StreamingChunk(
                            chunk_type="partial_args",
                            raw_delta=args_delta,
                            partial_args_so_far=partial_acc,
                        )

                # Stream-Ende — final args parsen falls möglich
                final_args: Optional[dict] = None
                try:
                    final_args = json.loads(partial_acc) if partial_acc.strip() else None
                except Exception:
                    final_args = None

                yield StreamingChunk(
                    chunk_type="done",
                    raw_delta="",
                    partial_args_so_far=partial_acc,
                    final_args=final_args,
                )
                return
            except Exception as e:
                m = str(e)
                if "429" in m or "rate" in m.lower():
                    if self._rotate():
                        await asyncio.sleep(1.0 + versuch)
                        partial_acc = ""
                        parser = IncrementalArrayParser(array_property=array_property)
                        continue
                if versuch == 0:
                    log.warning("extract_streaming retry nach Fehler: %s", e)
                    await asyncio.sleep(1.5)
                    partial_acc = ""
                    parser = IncrementalArrayParser(array_property=array_property)
                    continue
                raise

    async def extract_json(
        self,
        text: str,
        system_prompt: str,
        user_prompt: str,
        model: str = SMALL_MODEL,
        temperature: float = 0.1,
        max_tokens: int = 4000,
    ) -> dict:
        """Einfacher JSON-Mode-Aufruf ohne Function-Schema (fuer Pass 1)."""
        if not self.verfuegbar:
            raise RuntimeError("kein MISTRAL_API_KEY")

        for versuch in range(2):
            try:
                client = self._client()
                resp = await asyncio.to_thread(
                    client.chat.complete,
                    model=model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": f"{user_prompt}\n\n--- DOKUMENT ---\n{text[:18000]}"},
                    ],
                    response_format={"type": "json_object"},
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
                content = resp.choices[0].message.content or ""
                return json.loads(content)
            except Exception as e:
                m = str(e)
                if "429" in m or "rate" in m.lower():
                    if self._rotate():
                        await asyncio.sleep(1.0 + versuch)
                        continue
                if versuch == 0:
                    await asyncio.sleep(1.5)
                    continue
                raise
        raise RuntimeError("extract_json nicht erreichbar")
