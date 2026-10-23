"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Moon, Sun, Upload, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Doc {
  id: string;
  filename: string;
  status: string;
  total_chunks: number;
  error_message: string | null;
}

interface Citation {
  id: number;
  page: string;
  similarity: string;
  content: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
}

export default function Home() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [isDark, setIsDark] = useState(true);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [uploading, setUploading] = useState(false);
  const [scopeDoc, setScopeDoc] = useState("");
  const [selectedCitation, setSelectedCitation] = useState<Citation | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const fetchDocs = useCallback(async () => {
    try {
      const res = await fetch("/api/documents");
      const json = await res.json();
      setDocs(json.documents ?? []);
    } catch { }
  }, []);

  useEffect(() => {
    fetchDocs();
  }, [fetchDocs]);

  // Poll only while something is pending/processing
  useEffect(() => {
    const active = docs.some((d) => d.status === "pending" || d.status === "processing");
    if (!active) return;
    const t = setInterval(fetchDocs, 2500);
    return () => clearInterval(t);
  }, [docs, fetchDocs]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (!json.success) alert("Upload failed: " + json.error);
      await fetchDocs();
    } catch {
      alert("Upload network error");
    } finally {
      setUploading(false);
    }
  };

  const deleteDoc = async (id: string) => {
    if (!window.confirm("Delete this document and all of its chunks?")) return;
    try {
      const res = await fetch(`/api/documents/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (!json.success) alert("Delete failed: " + json.error);
      await fetchDocs();
    } catch {
      alert("Delete network error");
    }
  };

  async function send() {
    if (!input.trim() || busy) return;
    const question = input;
    setMessages((m) => [...m, { role: "user", content: question }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question, docId: scopeDoc || null }),
      });
      if (!res.ok) throw new Error("Chat API error " + res.status);
      const text = await res.text();
      const parts = text.split("---CITATIONS---");
      let citations: Citation[] = [];
      try {
        citations = JSON.parse((parts[1] || "[]").trim());
      } catch { }
      setMessages((m) => [...m, { role: "assistant", content: (parts[0] || "").trim(), citations }]);
    } catch (err: any) {
      setMessages((m) => [...m, { role: "assistant", content: "Something went wrong: " + (err?.message || err), citations: [] }]);
    } finally {
      setBusy(false);
    }
  }

  const renderMarkdown = (content: string, citations: Citation[]) => {
    const processed = content.replace(/\[([\d,\s]+)\]/g, (match, group: string) => {
      const ids = group.split(",").map((s: string) => s.trim()).filter(Boolean);
      return ids.map((id: string) => `[${id}](citation:${id})`).join("");
    });
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }: any) => {
            if (href?.startsWith("citation:")) {
              const id = parseInt(href.split(":")[1], 10);
              const c = citations.find((x) => x.id === id);
              return (
                <button
                  onClick={() => setSelectedCitation(c || null)}
                  className="inline-flex items-center justify-center w-6 h-6 mx-0.5 text-xs font-bold text-white bg-emerald-600 rounded hover:bg-emerald-700 align-middle"
                >
                  {id}
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="underline text-emerald-500">
                {children}
              </a>
            );
          },
          table: ({ children }: any) => (
            <div className="overflow-x-auto my-3">
              <table className="w-full text-sm border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }: any) => (
            <th className="text-left font-semibold px-3 py-2 border border-emerald-800/40 bg-emerald-500/10">{children}</th>
          ),
          td: ({ children }: any) => (
            <td className="px-3 py-2 border border-emerald-800/30 align-top">{children}</td>
          ),
        }}
      >
        {processed}
      </ReactMarkdown>
    );
  };

  return (
    <div className={`min-h-screen flex flex-col ${isDark ? "bg-gray-950 text-gray-100" : "bg-emerald-50/40 text-gray-900"}`}>
      <header className={`sticky top-0 z-40 border-b backdrop-blur-xl ${isDark ? "bg-gray-950/80 border-emerald-900/30" : "bg-white/80 border-emerald-200"}`}>
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-black uppercase tracking-tight bg-gradient-to-r from-emerald-500 to-teal-400 text-transparent bg-clip-text">Enterprise RAG</h1>
            <p className={`text-[11px] font-mono ${isDark ? "text-emerald-400/60" : "text-emerald-700/60"}`}>async ingestion • pgvector • cited answers</p>
          </div>
          <button onClick={() => setIsDark(!isDark)} className={`p-2 rounded-lg ${isDark ? "bg-emerald-500/10 text-emerald-400" : "bg-emerald-100 text-emerald-700"}`}>
            {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
        </div>
      </header>

      <div className="max-w-4xl w-full mx-auto px-6 pt-6">
        <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <h2 className={`text-xs font-bold uppercase tracking-wider ${isDark ? "text-emerald-400" : "text-emerald-700"}`}>Knowledge Base</h2>
            <select
              value={scopeDoc}
              onChange={(e) => setScopeDoc(e.target.value)}
              className={`text-xs font-mono px-2 py-1.5 rounded-lg border focus:outline-none focus:ring-1 focus:ring-emerald-500 ${isDark ? "bg-gray-900 border-emerald-900/40 text-emerald-300" : "bg-white border-emerald-200 text-emerald-800"}`}
            >
              <option value="">All documents</option>
              {docs.filter((d) => d.status === "completed").map((d) => (
                <option key={d.id} value={d.id}>{d.filename}</option>
              ))}
            </select>
          </div>
          <label className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer transition-all ${uploading ? "bg-gray-600 text-gray-300 cursor-not-allowed" : "bg-emerald-600 hover:bg-emerald-500 text-white shadow"}`}>
            <Upload className="w-4 h-4" />
            {uploading ? "Uploading..." : "Upload PDF"}
            <input type="file" accept="application/pdf" className="hidden" disabled={uploading} onChange={handleUpload} />
          </label>
        </div>
        <div className="flex flex-wrap gap-2 min-h-[36px] pb-4">
          {docs.length === 0 && <span className={`text-xs italic ${isDark ? "text-gray-500" : "text-gray-400"}`}>No documents yet — upload a PDF to begin.</span>}
          {docs.map((d) => (
            <div
              key={d.id}
              title={d.error_message || d.status}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-mono ${d.status === "completed"
                ? isDark ? "bg-emerald-900/30 border-emerald-700 text-emerald-300" : "bg-emerald-50 border-emerald-300 text-emerald-800"
                : d.status === "failed"
                  ? isDark ? "bg-red-900/30 border-red-700 text-red-300" : "bg-red-50 border-red-300 text-red-700"
                  : isDark ? "bg-yellow-900/20 border-yellow-700 text-yellow-300" : "bg-yellow-50 border-yellow-300 text-yellow-800"
                }`}
            >
              <span className={`w-2 h-2 rounded-full ${d.status === "completed" ? "bg-emerald-500" : d.status === "failed" ? "bg-red-500" : "bg-yellow-400 animate-pulse"}`} />
              <span className="max-w-[160px] truncate">{d.filename}</span>
              <span className="opacity-60">{d.status === "completed" ? `${d.total_chunks} chunks` : d.status}</span>
              <button
                onClick={() => deleteDoc(d.id)}
                className="ml-1 opacity-50 hover:opacity-100 hover:text-red-400 transition-opacity"
                title="Delete document + all chunks"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <main className="flex-1 w-full max-w-4xl mx-auto px-6 py-6 space-y-6 overflow-y-auto">
        {messages.length === 0 && (
          <div className="text-center py-16">
            <div className="text-6xl mb-4">🥗</div>
            <h2 className="text-2xl font-bold mb-2">Ask your documents anything</h2>
            <p className={`text-sm font-mono ${isDark ? "text-emerald-400/70" : "text-emerald-700/70"}`}>upload → chunk → embed → ask → cited answers</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] px-5 py-4 rounded-2xl text-[15px] leading-relaxed ${m.role === "user" ? "bg-emerald-600 text-white" : isDark ? "bg-gray-900 border border-emerald-900/40" : "bg-white border border-emerald-200 shadow-sm"}`}>
              {m.role === "assistant" ? renderMarkdown(m.content, m.citations || []) : <p className="whitespace-pre-wrap">{m.content}</p>}
              {m.role === "assistant" && (m.citations?.length ?? 0) > 0 && (
                <div className={`mt-3 pt-3 border-t flex flex-wrap gap-2 ${isDark ? "border-emerald-900/40" : "border-emerald-100"}`}>
                  {m.citations!.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setSelectedCitation(c)}
                      className={`text-[11px] font-mono px-2 py-1 rounded border ${isDark ? "border-emerald-800 text-emerald-300 hover:bg-emerald-900/30" : "border-emerald-300 text-emerald-700 hover:bg-emerald-50"}`}
                    >
                      [{c.id}] p.{c.page} · {c.similarity}%
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <div className={`text-xs font-mono animate-pulse ${isDark ? "text-emerald-400" : "text-emerald-700"}`}>thinking…</div>}
        <div ref={messagesEndRef} />
      </main>

      <div className={`sticky bottom-0 border-t backdrop-blur-xl ${isDark ? "bg-gray-950/90 border-emerald-900/30" : "bg-white/90 border-emerald-200"}`}>
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-end gap-3">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Ask about your uploaded documents…"
            disabled={busy}
            className={`flex-1 resize-none rounded-xl px-4 py-3 font-mono text-[15px] focus:outline-none focus:ring-2 focus:ring-emerald-500 ${isDark ? "bg-gray-900 border border-emerald-900/40" : "bg-white border border-emerald-200"}`}
            style={{ maxHeight: 180 }}
          />
          <button onClick={send} disabled={busy || !input.trim()} className={`p-3 rounded-xl ${busy || !input.trim() ? "bg-gray-700 text-gray-400" : "bg-emerald-600 hover:bg-emerald-500 text-white"}`}>
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>

      <AnimatePresence>
        {selectedCitation && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/70 z-50" onClick={() => setSelectedCitation(null)} />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 16 }}
              className={`fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-2xl mx-4 rounded-2xl overflow-hidden shadow-2xl border-2 ${isDark ? "bg-gray-900 border-emerald-900/50" : "bg-white border-emerald-200"}`}
            >
              <div className={`px-6 py-4 flex items-center justify-between border-b ${isDark ? "border-emerald-900/40 bg-gray-950/60" : "border-emerald-100 bg-emerald-50/60"}`}>
                <div className="text-sm font-mono font-bold">
                  Source [{selectedCitation.id}] · Page {selectedCitation.page} · {selectedCitation.similarity}% match
                </div>
                <button onClick={() => setSelectedCitation(null)} className="p-1.5 rounded hover:bg-gray-700/30">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="px-6 py-5 max-h-[60vh] overflow-y-auto">
                <p className={`text-sm font-mono leading-relaxed whitespace-pre-wrap ${isDark ? "text-emerald-100" : "text-gray-800"}`}>{selectedCitation.content}</p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}