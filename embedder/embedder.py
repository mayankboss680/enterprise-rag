from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

app = FastAPI()
# Load the same model your worker uses
model = SentenceTransformer("all-mpnet-base-v2")

class EmbedRequest(BaseModel):
    text: str

@app.get("/")
def health():
    return {"status": "ok", "service": "embedder"}

@app.post("/embed")
def embed(req: EmbedRequest):
    # Turn text into numbers and send back
    vector = model.encode(req.text).tolist()
    return {"embedding": vector}