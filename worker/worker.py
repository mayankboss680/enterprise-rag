import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import fitz  # PyMuPDF
import tiktoken
from dotenv import load_dotenv
from sentence_transformers import SentenceTransformer
from supabase import create_client

load_dotenv(Path(__file__).resolve().parent / ".env")


def _clean_url(u: str) -> str:
    u = (u or "").strip().strip('"').strip("'")
    u = u.split("/rest/v1")[0]
    return u.rstrip("/")


SUPABASE_URL = _clean_url(os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "")
SUPABASE_KEY = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SERVICE_KEY") or "").strip()

if not SUPABASE_URL.startswith("https://") or not SUPABASE_KEY:
    raise SystemExit(f"Bad config. URL={SUPABASE_URL!r} KEY_PRESENT={bool(SUPABASE_KEY)}")

EMBED_MODEL_NAME = "sentence-transformers/all-mpnet-base-v2"
MAX_CHUNK_TOKENS = 384
MIN_CHUNK_TOKENS = 25
OVERLAP_SENTENCES = 1
BATCH_EMBED = 100
BATCH_INSERT = 100
POLL_SECONDS = 3
REAP_MINUTES = 10
REAP_EVERY_SECONDS = 60

sb = create_client(SUPABASE_URL, SUPABASE_KEY)
enc = tiktoken.get_encoding("cl100k_base")

print("Loading embedding model...")
model = SentenceTransformer(EMBED_MODEL_NAME)
print("Model ready. Waiting for pending documents...\n")


def clean_text(text: str) -> str:
    text = text.replace("\r", " ")
    text = re.sub(r"-\s*\n\s*", "", text)
    text = re.sub(r"\s+\n", "\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.replace("\n", " ").strip()


# ---------- STRUCTURAL CHUNKING: heading detection by font size ----------

def page_tagged_sentences(page):
    """Return [(section_path, sentence), ...] using font-size heading detection."""
    lines = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            if not spans:
                continue
            text = "".join(s["text"] for s in spans).strip()
            if not text:
                continue
            lines.append((text, max(s["size"] for s in spans)))

    if not lines:
        return []

    sizes = sorted(sz for _, sz in lines)
    body = sizes[len(sizes) // 2]  # median font size = body text

    path = ["", ""]  # [h1, h2]
    buffer = []
    out = []

    def section_path():
        return " > ".join(p for p in path if p)

    def flush():
        nonlocal buffer
        if not buffer:
            return
        txt = clean_text(" ".join(buffer))
        for s in re.split(r"(?<=[.!?])\s+", txt):
            if s.strip():
                out.append((section_path(), s.strip()))
        buffer = []

    for text, size in lines:
        is_heading = (
            size > body + 1
            and len(text) < 90
            and not text.endswith((".", ",", ";"))
            and not text.isdigit()
        )
        if is_heading:
            flush()
            if size >= body + 3:
                path = [text, ""]
            else:
                path = [path[0], text]
        else:
            buffer.append(text)
    flush()
    return out


def chunk_tagged_sentences(tagged):
    """Sentence-window + token budget over (section, sentence) pairs."""
    groups = []
    current = []
    current_len = 0

    for section, sentence in tagged:
        sent_len = len(enc.encode(sentence)) + 1

        if sent_len > MAX_CHUNK_TOKENS:
            if current:
                groups.append(current)
                current, current_len = [], 0
            tokens = enc.encode(sentence)
            for i in range(0, len(tokens), MAX_CHUNK_TOKENS):
                groups.append([(section, enc.decode(tokens[i:i + MAX_CHUNK_TOKENS]))])
            continue

        if current and current_len + sent_len > MAX_CHUNK_TOKENS:
            groups.append(current)
            current = current[-OVERLAP_SENTENCES:]
            current_len = sum(len(enc.encode(s)) + 1 for _, s in current)

        current.append((section, sentence))
        current_len += sent_len

    if current:
        groups.append(current)

    result = []
    for group in groups:
        if len(enc.encode(" ".join(s for _, s in group))) < MIN_CHUNK_TOKENS:
            continue
        section = group[0][0] or group[len(group) // 2][0]
        text = " ".join(s for _, s in group)
        if section:
            text = f"[Section: {section}] {text}"
        result.append((text, section))
    return result


# ---------- QUEUE MACHINERY (unchanged from v2) ----------

def claim_next_job():
    pending = (
        sb.table("documents")
        .select("id")
        .eq("status", "pending")
        .order("created_at", desc=False)
        .limit(1)
        .execute()
    )
    if not pending.data:
        return None
    doc_id = pending.data[0]["id"]
    claim = (
        sb.table("documents")
        .update({
            "status": "processing",
            "started_at": datetime.now(timezone.utc).isoformat(),
        })
        .eq("id", doc_id)
        .eq("status", "pending")
        .execute()
    )
    return claim.data[0]["id"] if claim.data else None


def reap_stale_jobs():
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=REAP_MINUTES)).isoformat()
    res = (
        sb.table("documents")
        .update({"status": "pending", "error_message": None})
        .eq("status", "processing")
        .lt("started_at", cutoff)
        .execute()
    )
    if res.data:
        print(f"[REAPER] reset {len(res.data)} stale job(s) back to pending")


def process_document(doc_id: str):
    print(f"[START] doc={doc_id}")
    try:
        doc = sb.table("documents").select("*").eq("id", doc_id).single().execute().data
        sb.table("chunks").delete().eq("doc_id", doc_id).execute()

        pdf_bytes = sb.storage.from_("pdf-documents").download(doc["storage_path"])
        pdf = fitz.open(stream=pdf_bytes, filetype="pdf")

        chunks, metas = [], []
        for page_num in range(len(pdf)):
            tagged = page_tagged_sentences(pdf[page_num])
            for text, section in chunk_tagged_sentences(tagged):
                chunks.append(text)
                metas.append({
                    "page": page_num + 1,
                    "source": doc["filename"],
                    "section": section,
                })
        pdf.close()

        if not chunks:
            raise ValueError("No extractable text found in PDF.")
        print(f"  extracted {len(chunks)} chunks")

        embeddings = []
        for i in range(0, len(chunks), BATCH_EMBED):
            batch = chunks[i:i + BATCH_EMBED]
            embeddings.extend(model.encode(batch, show_progress_bar=False).tolist())
            print(f"  embedded {min(i + BATCH_EMBED, len(chunks))}/{len(chunks)}")

        rows = [
            {
                "doc_id": doc_id,
                "chunk_index": idx,
                "content": content,
                "metadata": meta,
                "embedding": emb,
            }
            for idx, (content, emb, meta) in enumerate(zip(chunks, embeddings, metas))
        ]
        for j in range(0, len(rows), BATCH_INSERT):
            sb.table("chunks").insert(rows[j:j + BATCH_INSERT]).execute()
            print(f"  inserted {min(j + BATCH_INSERT, len(rows))}/{len(rows)}")

        sb.table("documents").update(
            {"status": "completed", "total_chunks": len(rows)}
        ).eq("id", doc_id).execute()
        print(f"[DONE] doc={doc_id} chunks={len(rows)}")

    except Exception as e:
        print(f"[FAIL] doc={doc_id} error={e}")
        sb.table("documents").update(
            {"status": "failed", "error_message": str(e)}
        ).eq("id", doc_id).execute()


if __name__ == "__main__":
    last_reap = 0.0
    while True:
        try:
            now = time.time()
            if now - last_reap > REAP_EVERY_SECONDS:
                reap_stale_jobs()
                last_reap = now

            doc_id = claim_next_job()
            if doc_id:
                process_document(doc_id)
            else:
                time.sleep(POLL_SECONDS)
        except Exception as e:
            print(f"[LOOP ERROR] {e}")
            time.sleep(5)