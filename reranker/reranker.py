# Terminal C lives here
import math

from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import CrossEncoder

app = FastAPI()

print("Loading cross-encoder reranker...")
model = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
print("Reranker ready on http://127.0.0.1:8000")


class RerankRequest(BaseModel):
    query: str
    passages: list[str]


def sigmoid(x: float) -> float:
    # numerically safe; maps raw logit -> 0..1 relevance
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    e = math.exp(x)
    return e / (1.0 + e)


@app.get("/")
def health():
    return {"status": "ok", "service": "reranker"}


@app.post("/rerank")
def rerank(req: RerankRequest):
    if not req.passages:
        return {"scores": [], "raw": []}
    pairs = [[req.query, p] for p in req.passages]
    raw = [float(s) for s in model.predict(pairs, show_progress_bar=False)]
    # "scores" is now 0..1 (same ordering as raw), so the UI can show it as a % match
    return {"scores": [sigmoid(s) for s in raw], "raw": raw}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)