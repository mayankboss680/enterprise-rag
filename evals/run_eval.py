import json
import os
import statistics
from pathlib import Path

import requests
from dotenv import load_dotenv
from groq import Groq

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")

CHAT_URL = "http://localhost:3000/api/chat"
DOCS_URL = "http://localhost:3000/api/documents"
groq = Groq(api_key=os.getenv("GROQ_API_KEY"))

GOLDEN = json.loads((Path(__file__).parent / "golden.json").read_text(encoding="utf-8"))

JUDGE_FAITHFUL = (
    "You are a strict faithfulness judge. Given CONTEXT and ANSWER, decide whether EVERY "
    "factual claim in the ANSWER is supported by the CONTEXT. Reply with JSON only: "
    '{"faithful": true|false, "unsupported": ["..."]}'
)
JUDGE_CORRECT = (
    "You are an answer-correctness judge. Given QUESTION, GOLDEN reference answer and CANDIDATE "
    "answer, decide whether the CANDIDATE contains the key facts of the GOLDEN (wording may differ). "
    'Reply with JSON only: {"correct": true|false, "score": 0.0}'
)


def judge(system: str, user: str) -> dict:
    comp = groq.chat.completions.create(
        model="openai/gpt-oss-20b",  # cheap, fast judge
        temperature=0,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
    )
    text = comp.choices[0].message.content or "{}"
    try:
        return json.loads(text[text.find("{"): text.rfind("}") + 1])
    except Exception:
        return {}


def eval_item(item: dict, doc_ids: dict) -> dict:
    payload = {
        "message": item["question"],
        "docId": doc_ids.get(item["doc"]),
        "debug": True,
    }
    r = requests.post(CHAT_URL, json=payload, timeout=180)
    r.raise_for_status()
    data = r.json()
    citations = data.get("citations", [])
    answer = data.get("answer", "")

    got_pages = {int(c["page"]) for c in citations if str(c["page"]).isdigit()}
    want_pages = set(item["pages"])
    hits = got_pages & want_pages

    precision = len(hits) / len(got_pages) if got_pages else 0.0
    recall = len(hits) / len(want_pages) if want_pages else 0.0

    context = "\n\n".join(c["content"] for c in citations)
    faith = judge(JUDGE_FAITHFUL, f"CONTEXT:\n{context}\n\nANSWER:\n{answer}")
    corr = judge(JUDGE_CORRECT, f"QUESTION:\n{item['question']}\n\nGOLDEN:\n{item['answer']}\n\nCANDIDATE:\n{answer}")

    return {
        "question": item["question"],
        "precision": round(precision, 2),
        "recall": round(recall, 2),
        "faithful": bool(faith.get("faithful")),
        "correct": bool(corr.get("correct")),
        "got_pages": sorted(got_pages),          # NEW: what retrieval actually returned
        "answer": answer[:600],                  # NEW: what the judge actually read
    }


def main():
    docs = requests.get(DOCS_URL, timeout=30).json().get("documents", [])
    doc_ids = {d["filename"]: d["id"] for d in docs}

    rows = [eval_item(item, doc_ids) for item in GOLDEN]
    for row in rows:
        print(
            f"[P={row['precision']:.2f} R={row['recall']:.2f} "
            f"F={'Y' if row['faithful'] else 'N'} C={'Y' if row['correct'] else 'N'}] "
            f"{row['question'][:60]}"
        )

    summary = {
        "context_precision": round(statistics.mean(r["precision"] for r in rows), 2),
        "context_recall": round(statistics.mean(r["recall"] for r in rows), 2),
        "faithfulness": round(statistics.mean(r["faithful"] for r in rows), 2),
        "answer_correctness": round(statistics.mean(r["correct"] for r in rows), 2),
    }
    out = Path(__file__).parent / "eval_report.json"
    out.write_text(json.dumps({"summary": summary, "rows": rows}, indent=2), encoding="utf-8")

    print("\n=== SUMMARY ===")
    for k, v in summary.items():
        print(f"{k}: {v}")
    print(f"\nSaved -> {out}")


if __name__ == "__main__":
    main()