"""
Matmul Sidecar for Tier-1 eCode-Matching.

Loads embeddings.gemma4.fp32.bin once at startup, exposes a /matmul-topk endpoint
that takes batched query vectors and returns top-K matches per query.

Why NumPy on CPU not Torch on GPU:
  - NumPy matmul 2219x768 @ 601x768.T = 6.2 ms (measured 2026-05-20).
  - GPU adds HTTP+memcopy overhead that dominates for small (~MB) matrices.
  - GPU contention with vLLM (gemma4-mm, embeddinggemma) avoided.

Endpoints:
  GET  /health                  → readiness + atoms_loaded
  POST /matmul-topk             → {queries: [[f32 ...]], top_k: int} → topk[][]
  POST /reload                  → reload embeddings.bin from disk
  GET  /metrics                 → request count, p50/p99 latency
"""
import os
import time
import threading
from collections import deque
from typing import List
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

EMBEDDINGS_PATH = os.environ.get(
    "MATMUL_EMBEDDINGS",
    "/home/christoph.bertsch/0711-STURM-polar/src/verticals/elster-v3/data/embeddings.gemma4.fp32.bin",
)
DIM = int(os.environ.get("MATMUL_DIM", "768"))

app = FastAPI(title="Matmul Sidecar", version="1.0")

_lock = threading.RLock()
_state = {"A": None, "n": 0, "loaded_at": 0.0, "path": EMBEDDINGS_PATH}
_latencies: deque = deque(maxlen=1024)
_requests_total = 0


def load_embeddings(path: str) -> tuple:
    flat = np.fromfile(path, dtype=np.float32)
    if flat.size % DIM != 0:
        raise ValueError(f"embeddings.bin size {flat.size} not divisible by dim {DIM}")
    n = flat.size // DIM
    A = flat.reshape(n, DIM)
    return A, n


@app.on_event("startup")
def _startup():
    A, n = load_embeddings(EMBEDDINGS_PATH)
    with _lock:
        _state["A"] = A
        _state["n"] = n
        _state["loaded_at"] = time.time()
    # warm-up: run a dummy matmul so JIT/dispatcher caches warm
    Q = np.random.randn(8, DIM).astype(np.float32)
    _ = Q @ A.T
    print(f"[matmul-sidecar] loaded {n} atoms from {EMBEDDINGS_PATH}", flush=True)


@app.get("/health")
def health():
    return {
        "ok": _state["A"] is not None,
        "atoms_loaded": _state["n"],
        "dim": DIM,
        "loaded_at": _state["loaded_at"],
        "path": _state["path"],
    }


@app.get("/metrics")
def metrics():
    arr = list(_latencies)
    arr.sort()
    p50 = arr[len(arr)//2] if arr else 0.0
    p99 = arr[int(len(arr)*0.99)] if arr else 0.0
    return {"requests_total": _requests_total, "p50_ms": p50, "p99_ms": p99, "sample_size": len(arr)}


class MatmulRequest(BaseModel):
    queries: List[List[float]]   # shape (q, dim)
    top_k: int = 3


class MatmulMatch(BaseModel):
    idx: int
    score: float


class MatmulResponse(BaseModel):
    topk: List[List[MatmulMatch]]
    n_atoms: int
    ms: float


@app.post("/matmul-topk", response_model=MatmulResponse)
def matmul_topk(req: MatmulRequest):
    global _requests_total
    t0 = time.time()
    A = _state["A"]
    if A is None:
        raise HTTPException(503, "embeddings not loaded yet")
    Q = np.asarray(req.queries, dtype=np.float32)
    if Q.ndim != 2 or Q.shape[1] != DIM:
        raise HTTPException(400, f"queries must be (q, {DIM}), got {Q.shape}")
    k = max(1, min(req.top_k, A.shape[0]))

    # matmul (q, n)
    S = Q @ A.T  # cosine assumed if both sides L2-normalized; we leave normalization to caller.

    # top-K per row via argpartition (faster than full argsort)
    n = A.shape[0]
    if k >= n:
        topk_idx = np.argsort(-S, axis=1)[:, :k]
    else:
        part = np.argpartition(-S, k, axis=1)[:, :k]
        # sort the partitioned candidates by descending score
        row_sel = np.take_along_axis(S, part, axis=1)
        order = np.argsort(-row_sel, axis=1)
        topk_idx = np.take_along_axis(part, order, axis=1)

    topk_scores = np.take_along_axis(S, topk_idx, axis=1)

    out = []
    for i in range(Q.shape[0]):
        row = [
            MatmulMatch(idx=int(topk_idx[i, j]), score=float(topk_scores[i, j]))
            for j in range(k)
        ]
        out.append(row)

    dt = (time.time() - t0) * 1000.0
    _latencies.append(dt)
    _requests_total += 1
    return MatmulResponse(topk=out, n_atoms=n, ms=dt)


@app.post("/reload")
def reload_embeddings():
    A, n = load_embeddings(EMBEDDINGS_PATH)
    with _lock:
        _state["A"] = A
        _state["n"] = n
        _state["loaded_at"] = time.time()
    return {"ok": True, "atoms_loaded": n}
