import os, time, threading
from collections import deque
from typing import List, Optional
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

EMBEDDINGS_PATH = os.environ.get("MATMUL_EMBEDDINGS", "/home/christoph.bertsch/0711-STURM-polar/src/verticals/elster-v3/data/embeddings.gemma4.fp32.bin")
DIM = int(os.environ.get("MATMUL_DIM", "768"))
app = FastAPI(title="Matmul Budget Sidecar", version="1.0")
_lock = threading.RLock()
_state = {"A": None, "n": 0, "loaded_at": 0.0, "path": EMBEDDINGS_PATH}
_latencies: deque = deque(maxlen=2048)
_requests_total = 0

def load_embeddings(path: str):
    flat = np.fromfile(path, dtype=np.float32)
    if flat.size % DIM != 0:
        raise ValueError(f"embeddings.bin size {flat.size} not divisible by dim {DIM}")
    n = flat.size // DIM
    A = flat.reshape(n, DIM)
    return A, n

@app.on_event("startup")
def startup():
    A, n = load_embeddings(EMBEDDINGS_PATH)
    with _lock:
        _state["A"] = A
        _state["n"] = n
        _state["loaded_at"] = time.time()
    Q = np.random.randn(4, DIM).astype(np.float32)
    _ = Q @ A.T
    print(f"[matmul-budget] loaded {n} atoms", flush=True)

@app.get("/health")
def health():
    return {"ok": _state["A"] is not None, "atoms_loaded": _state["n"], "dim": DIM, "loaded_at": _state["loaded_at"]}

@app.get("/metrics")
def metrics():
    arr = sorted(_latencies)
    p50 = arr[len(arr)//2] if arr else 0.0
    p99 = arr[int(len(arr)*0.99)] if arr else 0.0
    return {"requests_total": _requests_total, "p50_ms": p50, "p99_ms": p99, "sample_size": len(arr)}

class MatmulRequest(BaseModel):
    queries: List[List[float]]
    top_k: int = 3
    candidate_indices: Optional[List[int]] = None

@app.post("/matmul-topk")
def matmul_topk(req: MatmulRequest):
    global _requests_total
    t0 = time.time()
    A = _state["A"]
    if A is None:
        raise HTTPException(503, "embeddings not loaded yet")
    Q = np.asarray(req.queries, dtype=np.float32)
    if Q.ndim != 2 or Q.shape[1] != DIM:
        raise HTTPException(400, f"queries must be (q, {DIM}), got {Q.shape}")
    if req.candidate_indices:
        idx = np.asarray(req.candidate_indices, dtype=np.int32)
        if idx.ndim != 1:
            raise HTTPException(400, "candidate_indices must be 1D")
        A_use = A[idx]
        original_idx = idx
    else:
        A_use = A
        original_idx = None
    n = A_use.shape[0]
    k = max(1, min(req.top_k, n))
    S = Q @ A_use.T
    if k >= n:
        topk_local = np.argsort(-S, axis=1)[:, :k]
    else:
        part = np.argpartition(-S, k, axis=1)[:, :k]
        row_sel = np.take_along_axis(S, part, axis=1)
        order = np.argsort(-row_sel, axis=1)
        topk_local = np.take_along_axis(part, order, axis=1)
    topk_scores = np.take_along_axis(S, topk_local, axis=1)
    out = []
    for i in range(Q.shape[0]):
        row=[]
        for j in range(k):
            li = int(topk_local[i,j])
            gi = int(original_idx[li]) if original_idx is not None else li
            row.append({"idx": gi, "score": float(topk_scores[i,j])})
        out.append(row)
    dt = (time.time() - t0) * 1000.0
    _latencies.append(dt)
    _requests_total += 1
    return {"topk": out, "n_atoms": int(_state["n"]), "candidate_atoms": int(n), "ms": dt}
