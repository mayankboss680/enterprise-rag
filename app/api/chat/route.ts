import { NextRequest, NextResponse } from "next/server";
import Groq from "groq-sdk";
import { createClient } from "@supabase/supabase-js";
import { pipeline } from "@xenova/transformers";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const RERANKER_URL = "http://127.0.0.1:8000/rerank";
const VECTOR_CANDIDATES = 20;
const FUSED_SHORTLIST = 12;
const FINAL_CONTEXT = 8;

let embedder: any = null;
async function getEmbedder() {
    if (!embedder) embedder = await pipeline("feature-extraction", "Xenova/all-mpnet-base-v2");
    return embedder;
}

async function embedQuery(q: string): Promise<number[]> {
    const embed = await getEmbedder();
    const out = await embed(q, { pooling: "mean", normalize: true });
    return Array.from(out.data) as number[];
}

// Reciprocal Rank Fusion: merge rankings by POSITION, not by raw score
function rrfFuse(lists: string[][], k = 60): Map<string, number> {
    const scores = new Map<string, number>();
    for (const list of lists) {
        list.forEach((id, rank) => {
            scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
        });
    }
    return scores;
}

export async function POST(req: NextRequest) {
    try {
        const { message, docId, debug } = await req.json();
        if (!message?.trim()) return NextResponse.json({ error: "Empty query" }, { status: 400 });

        // Resolve optional document scope -> metadata pre-filter
        let scopeSource: string | null = null;
        if (docId) {
            const { data: docRow } = await supabase
                .from("documents")
                .select("filename")
                .eq("id", docId)
                .single();
            scopeSource = docRow?.filename ?? null;
        }
        const metaFilter = scopeSource ? { source: scopeSource } : {};

        // 1) DENSE: semantic candidates (scoped)
        const queryEmb = await embedQuery(message);
        const { data: dense, error: e1 } = await supabase.rpc("match_documents", {
            query_embedding: queryEmb,
            match_count: VECTOR_CANDIDATES,
            filter: metaFilter,
        });
        if (e1) throw e1;
        const denseRows = (dense ?? []).map((r: any) => ({ ...r, similarity: r.similarity ?? 0 }));

        // 2) LEXICAL: per-token, typo-tolerant trigram candidates (scoped)
        const tokens = [...new Set(
            message.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter((t) => t.length >= 5)
        )].slice(0, 4);

        const lexMap = new Map<string, any>();
        for (const token of tokens) {
            const { data: lex, error: e2 } = await supabase.rpc("lexical_match", {
                query_token: token,
                match_count: 10,
                source_filter: scopeSource,
            });
            if (e2) throw e2;
            for (const r of lex ?? []) {
                const prev = lexMap.get(r.id);
                if (!prev || (r.sim ?? 0) > (prev.similarity ?? 0)) {
                    lexMap.set(r.id, { ...r, similarity: r.sim ?? 0 });
                }
            }
        }
        const lexRows = [...lexMap.values()];

        // 3) FUSE by rank (RRF)
        const byId = new Map<string, any>();
        denseRows.forEach((r: any) => byId.set(r.id, r));
        lexRows.forEach((r: any) => byId.set(r.id, r));

        const fused = rrfFuse([denseRows.map((r: any) => r.id), lexRows.map((r: any) => r.id)]);
        const shortlist = [...fused.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, FUSED_SHORTLIST)
            .map(([id]) => byId.get(id))
            .filter(Boolean);

        if (!shortlist.length) {
            return new Response("I couldn't find this in the provided document.\n---CITATIONS---\n[]", {
                headers: { "Content-Type": "text/plain; charset=utf-8" },
            });
        }

        // 4) RERANK with cross-encoder judge (graceful fallback if down)
        let ranked = shortlist;
        try {
            const rr = await fetch(RERANKER_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: message, passages: shortlist.map((r: any) => r.content) }),
            });
            if (rr.ok) {
                const { scores } = await rr.json();
                ranked = shortlist
                    .map((r: any, i: number) => ({ ...r, rerank: scores[i] }))
                    .sort((a: any, b: any) => b.rerank - a.rerank);
            }
        } catch {
            console.warn("Reranker unreachable - using fused order");
        }

        const final = ranked.slice(0, FINAL_CONTEXT);
        const context = final
            .map((c: any, i: number) => `[${i + 1}] (Page ${c.metadata?.page ?? "?"}) ${c.content}`)
            .join("\n\n");

        // 5) Grounded generation
        const completion = await groq.chat.completions.create({
            model: "openai/gpt-oss-20b",
            temperature: 0,
            messages: [
                {
                    role: "system",
                    content:
                        "You are a strict RAG assistant. Answer ONLY using the CONTEXT. " +
                        "Do NOT add examples, names, lists or details that are not explicitly stated in the CONTEXT, " +
                        "even if they are true in general knowledge. " +
                        "If the answer is not present, say: 'I couldn't find this in the provided document.' " +
                        "If the user's term looks like a misspelling of a term that DOES appear in the context, " +
                        "answer about the context term and note the correction. " +
                        "Cite sources like [1], [2] and include page numbers.",
                },
                { role: "user", content: `CONTEXT:\n${context}\n\nQUESTION: ${message}` },
            ],
        });

        const answer = completion.choices[0]?.message?.content || "I couldn't generate an answer.";

        const citations = final.map((c: any, i: number) => ({
            id: i + 1,
            page: String(c.metadata?.page ?? "?"),
            // Prefer the cross-encoder relevance (0..1). Lexical trigram / cosine scores are not comparable.
            similarity: String(
                (Math.min(1, Math.max(0, typeof c.rerank === "number" ? c.rerank : (c.similarity ?? 0))) * 100).toFixed(1)
            ),
            content: c.content,
        }));

        if (debug) {
            return NextResponse.json({ answer, citations });
        }
        return new Response(`${answer}\n\n---CITATIONS---\n${JSON.stringify(citations)}`, {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
    } catch (error: any) {
        console.error("CHAT API ERROR:", error);
        return NextResponse.json({ error: error?.message || String(error) }, { status: 500 });
    }
}