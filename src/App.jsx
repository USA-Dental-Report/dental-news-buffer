import { useState, useRef, useMemo } from "react";

const DEFAULT_MAX_PER_SOURCE = 2;

const C = {
  bg:       "#0a0c10",
  surface:  "#111318",
  card:     "#16191f",
  border:   "#1e2330",
  accent:   "#2563eb",
  accentHi: "#3b82f6",
  green:    "#22c55e",
  amber:    "#f59e0b",
  red:      "#ef4444",
  muted:    "#6b7280",
  text:     "#e2e8f0",
  textDim:  "#94a3b8",
};

const SCORE_COLORS = { high: C.green, medium: C.amber, low: C.red };

// ─── Helpers ──────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.replace(/^"|"$/g, "").trim().toLowerCase());
  return lines.slice(1).map(line => {
    const cols = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { cols.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    cols.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cols[i] ?? ""; });
    return obj;
  }).filter(r => Object.values(r).some(v => v));
}

function scoreLabel(score) {
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return "low";
}

// Sub-domains that don't identify a distinct publisher - stripped so
// blog.acme.com, news.acme.com and www.acme.com land in one bucket.
const SUBDOMAIN_NOISE = /^(www\d?|m|amp|blog|blogs|news|newsroom|feed|feeds|rss|en|us|web|media|content|insights|resources)\./;

function stripNoisySubdomains(host) {
  let h = host;
  // Only strip while a real domain is left behind, so news.com stays news.com.
  while (SUBDOMAIN_NOISE.test(h) && h.replace(SUBDOMAIN_NOISE, "").includes(".")) {
    h = h.replace(SUBDOMAIN_NOISE, "");
  }
  return h;
}

function domainFromUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let host;
  try { host = new URL(withProto).hostname; } catch (_) { return ""; }
  return stripNoisySubdomains(host.toLowerCase().replace(/^\.+|\.+$/g, ""));
}

function normalizeSource(source) {
  return String(source ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]   // drop any path/query - otherwise every article URL is its own "source"
    .trim();
}

// One stable key per publisher. The article URL is the most reliable signal:
// a CSV "source" column may be a display name, a bare domain, a full article
// URL, or missing entirely - so prefer the link's hostname and fall back to
// whatever the source column says.
function sourceKey(item) {
  return domainFromUrl(item?.link) || domainFromUrl(item?.source) || normalizeSource(item?.source);
}

// Ranks each idea within its own source (list must already be sorted
// best-first) and flags everything past `maxPerSource`. Items with no
// recognizable source stay uncapped - they can't be pinned on one outlet.
function applySourceCap(list, maxPerSource) {
  const counts = {};
  return list.map(idea => {
    const key = idea.sourceKey || sourceKey(idea);
    if (!key) return { ...idea, sourceKey: "", sourceRank: 0, cappedBySource: false };
    const rank = (counts[key] ?? 0) + 1;
    counts[key] = rank;
    return {
      ...idea,
      sourceKey: key,
      sourceRank: rank,
      cappedBySource: maxPerSource > 0 && rank > maxPerSource,
    };
  });
}

function autoSelectedIds(list) {
  return new Set(list.filter(i => i.score >= 7 && !i.cappedBySource).map(i => i.id));
}

// [domain, total, overLimit] per source, heaviest first.
function sourceTally(list) {
  const counts = {};
  for (const i of list) {
    if (!i.sourceKey) continue;
    const row = counts[i.sourceKey] ?? (counts[i.sourceKey] = { total: 0, over: 0 });
    row.total += 1;
    if (i.cappedBySource) row.over += 1;
  }
  return Object.entries(counts)
    .map(([domain, v]) => [domain, v.total, v.over])
    .sort((a, b) => b[1] - a[1]);
}

function sanitizeRow(row) {
  const clean = {};
  for (const [k, v] of Object.entries(row)) {
    clean[k] = String(v ?? "")
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\\/g, "\\\\")
      .replace(/"/g, "'")
      .trim()
      .slice(0, 300);
  }
  return clean;
}

function extractJSON(raw) {
  let text = raw.replace(/```json|```/gi, "").trim();
  const start = text.indexOf("[");
  if (start === -1) throw new Error("No JSON array found in response");
  const end = text.lastIndexOf("]");
  // Response may be truncated (hit max_tokens) before the closing bracket —
  // fall back to scanning from "[" to end of text rather than failing outright.
  text = end > start ? text.slice(start, end + 1) : text.slice(start);
  try { return JSON.parse(text); } catch (_) {}
  const objects = [];
  const objRe = /\{[\s\S]*?\}(?=\s*[,\]])/g;
  let match;
  while ((match = objRe.exec(text)) !== null) {
    try { objects.push(JSON.parse(match[0])); } catch (_) {}
  }
  if (objects.length > 0) return objects;
  throw new Error("Could not parse JSON from response");
}

// ─── API calls — all via Vercel proxy routes ───────────────────────────────
async function callClaude(prompt) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: `You are a dental industry content strategist for USA Dental Report, a dental news media brand targeting dentists and dental professionals on LinkedIn. Evaluate news items from a CSV scrape and score them for LinkedIn content potential. Respond ONLY with a valid JSON array — no markdown, no preamble, no trailing text. All string values must use only plain ASCII characters.`,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const raw = data.content?.find(b => b.type === "text")?.text ?? "[]";
  return extractJSON(raw);
}

async function generateDraftFor(item) {
  const prompt = `
Write a suggested LinkedIn post draft for this dental news item, for USA Dental Report's audience of dental professionals:
- suggestedTitle: short punchy idea title (max 80 chars)
- draftText: 2-3 sentence LinkedIn post body

IMPORTANT: USA Dental Report does not write, report, test, or rank this content itself - it curates and shares third-party news and resources on LinkedIn. The draftText must read as commentary introducing or framing someone else's work, never as USA Dental Report's (or "our"/"we") own reporting, testing, ranking, or analysis.
- Never use phrasing like "USA Dental Report breaks down/reports/explores/analyzes/shares its take".
- Never use first-person plural claims of original work, e.g. "We ranked...", "We tested...", "Our top picks...", "We found...". Any ranking, list, or analysis described in the source belongs to whoever published it (the article's outlet, author, or company), not to USA Dental Report.
- Attribute the original work to its source using the item's source/outlet name when available (e.g. "Deutsche Dental ranked the top 5..."), or use neutral framing like "This piece looks at...", "New ranking of...", "Worth a read for dentists..." when no clear source name is available.

Respond ONLY with a valid JSON array containing one object. No markdown, no explanation, no preamble:
[
  {
    "suggestedTitle": "...",
    "draftText": "..."
  }
]

Item:
${JSON.stringify(sanitizeRow({
  title: item.originalTitle,
  date: item.date,
  source: item.source,
  link: item.link,
}), null, 2)}
`;
  const result = await callClaude(prompt);
  const draft = Array.isArray(result) ? result[0] : result;
  if (!draft?.draftText) throw new Error("No draft returned");
  return draft;
}

async function bufferCreateIdea(title, text) {
  const query = `
    mutation CreateIdea {
      createIdea(input: {
        organizationId: "$ORG_PLACEHOLDER",
        content: {
          title: ${JSON.stringify(title)}
          text: ${JSON.stringify(text)}
        }
      }) {
        ... on Idea {
          id
          content { title text }
        }
        ... on MutationError {
          message
        }
      }
    }
  `;
  const res = await fetch("/api/buffer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  const result = data?.data?.createIdea;
  if (result?.message) throw new Error(result.message);
  return result;
}

// ─── Sub-components ───────────────────────────────────────────────────────
function Badge({ label }) {
  const color = SCORE_COLORS[label] ?? C.muted;
  return (
    <span style={{
      display: "inline-block", padding: "2px 10px", borderRadius: 999,
      fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
      background: color + "22", color, border: `1px solid ${color}44`,
    }}>{label}</span>
  );
}

function ScoreBar({ score }) {
  const pct = (score / 10) * 100;
  const color = SCORE_COLORS[scoreLabel(score)];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 4, background: C.border, borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 2, transition: "width 0.6s ease" }} />
      </div>
      <span style={{ fontSize: 13, fontWeight: 700, color, minWidth: 24, textAlign: "right" }}>{score}</span>
    </div>
  );
}

function IdeaCard({ item, onToggle, selected, onPush, pushState, onGenerateDraft, draftGenState }) {
  const [copied, setCopied] = useState(false);
  const label = scoreLabel(item.score);
  const isPushed   = pushState === "done";
  const isPushing  = pushState === "pushing";
  const isError    = typeof pushState === "string" && pushState.startsWith("error:");
  const isGenerating  = draftGenState === "generating";
  const isGenError    = typeof draftGenState === "string" && draftGenState.startsWith("error:");

  const copyLink = async (e) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(item.link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      onClick={() => !isPushed && onToggle(item.id)}
      style={{
        background: selected ? C.accent + "18" : C.card,
        border: `1px solid ${selected ? C.accent + "66" : C.border}`,
        borderRadius: 12, padding: "18px 20px",
        cursor: isPushed ? "default" : "pointer",
        transition: "all 0.18s ease", opacity: isPushed ? 0.6 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 10 }}>
        <div style={{
          width: 20, height: 20, borderRadius: 4,
          border: `2px solid ${selected ? C.accent : C.border}`,
          background: selected ? C.accent : "transparent",
          flexShrink: 0, marginTop: 2,
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "all 0.15s",
        }}>
          {selected && <span style={{ color: "#fff", fontSize: 12, lineHeight: 1 }}>✓</span>}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: C.text, lineHeight: 1.35, marginBottom: 6 }}>
            {item.suggestedTitle ?? item.originalTitle}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Badge label={label} />
            {item.date   && <span style={{ fontSize: 11, color: C.muted }}>{item.date}</span>}
            {item.source && <span style={{ fontSize: 11, color: C.muted, fontStyle: "italic" }}>{item.source}</span>}
            {item.cappedBySource && (
              <span style={{ fontSize: 11, color: C.amber }}>
                · #{item.sourceRank} from this source — over the per-source limit
              </span>
            )}
            {item.link && (
              <>
                <a
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                  style={{ fontSize: 11, color: C.accentHi, textDecoration: "none" }}
                >
                  ↗ source link
                </a>
                <button
                  onClick={copyLink}
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    fontSize: 11, color: copied ? C.green : C.muted, padding: 0,
                  }}
                >
                  {copied ? "✓ copied" : "⧉ copy"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 12, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "6px 16px" }}>
        {[["Relevance", item.relevanceScore], ["Recency", item.recencyScore], ["Engagement", item.engagementScore]].map(([lbl, s]) => (
          <div key={lbl}>
            <div style={{ fontSize: 10, color: C.muted, marginBottom: 2, textTransform: "uppercase", letterSpacing: "0.06em" }}>{lbl}</div>
            <ScoreBar score={s} />
          </div>
        ))}
      </div>

      <div style={{
        background: C.surface, borderRadius: 8, padding: "12px 14px",
        fontSize: 13, color: C.textDim, lineHeight: 1.6,
        borderLeft: `3px solid ${C.accent}55`, marginBottom: 12, whiteSpace: "pre-wrap",
      }}>
        {item.draftText
          ? (item.link ? `${item.draftText}\n\n${item.link}` : item.draftText)
          : "No draft generated — score below 6 threshold."}
      </div>

      {!item.draftText && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }} onClick={e => e.stopPropagation()}>
          {isGenError && (
            <span style={{ fontSize: 11, color: C.red, marginRight: 10, alignSelf: "center" }}>{draftGenState.replace("error:", "")}</span>
          )}
          <button
            onClick={() => onGenerateDraft(item)}
            disabled={isGenerating}
            style={{
              background: "none", color: isGenerating ? C.muted : C.accentHi,
              border: `1px solid ${isGenerating ? C.border : C.accentHi + "66"}`,
              borderRadius: 7, padding: "6px 14px", fontSize: 12, fontWeight: 700,
              cursor: isGenerating ? "default" : "pointer", letterSpacing: "0.04em",
            }}
          >
            {isGenerating ? "Generating…" : "✎ Generate draft anyway"}
          </button>
        </div>
      )}

      <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5, marginBottom: 14 }}>
        <span style={{ color: C.textDim, fontWeight: 600 }}>Why this works: </span>
        {item.rationale}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }} onClick={e => e.stopPropagation()}>
        {isPushed ? (
          <span style={{ fontSize: 12, color: C.green, fontWeight: 600 }}>✓ Added to Buffer Ideas</span>
        ) : isError ? (
          <span style={{ fontSize: 12, color: C.red }}>{pushState.replace("error:", "")}</span>
        ) : (
          <button
            onClick={() => onPush(item)}
            disabled={isPushing || !item.draftText}
            style={{
              background: isPushing || !item.draftText ? C.border : C.accent,
              color: !item.draftText ? C.muted : "#fff", border: "none", borderRadius: 7,
              padding: "7px 16px", fontSize: 12, fontWeight: 700,
              cursor: isPushing || !item.draftText ? "default" : "pointer",
              letterSpacing: "0.04em", transition: "background 0.15s",
            }}
          >
            {isPushing ? "Pushing…" : !item.draftText ? "No draft" : "→ Add to Buffer"}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────
export default function App() {
  const [rows, setRows]           = useState([]);
  const [ideas, setIdeas]         = useState([]);
  const [selected, setSelected]   = useState(new Set());
  const [pushStates, setPushStates] = useState({});
  const [draftGenStates, setDraftGenStates] = useState({});
  const [stage, setStage]         = useState("upload"); // upload | evaluating | results
  const [error, setError]         = useState("");
  const [progress, setProgress]   = useState({ done: 0, total: 0 });
  const [maxPerSource, setMaxPerSource] = useState(DEFAULT_MAX_PER_SOURCE);
  const [hideCapped, setHideCapped]     = useState(false);
  const fileRef = useRef();

  // `ideas` holds the raw score-sorted list; the per-source cap is re-derived
  // on every render so changing the limit re-ranks without re-calling Claude.
  const rankedIdeas  = useMemo(() => applySourceCap(ideas, maxPerSource), [ideas, maxPerSource]);
  const visibleIdeas = hideCapped ? rankedIdeas.filter(i => !i.cappedBySource) : rankedIdeas;
  const cappedCount  = rankedIdeas.filter(i => i.cappedBySource).length;
  const tally        = useMemo(() => sourceTally(rankedIdeas), [rankedIdeas]);

  const toggleHideCapped = (next) => {
    setHideCapped(next);
    if (next) {
      const cappedIds = new Set(rankedIdeas.filter(i => i.cappedBySource).map(i => i.id));
      setSelected(prev => new Set([...prev].filter(id => !cappedIds.has(id))));
    }
  };

  const changeMaxPerSource = (next) => {
    const clamped = Math.max(1, Math.min(10, next));
    if (clamped === maxPerSource) return;
    setMaxPerSource(clamped);
    // Re-run auto-selection against the new limit (this drops manual picks).
    setSelected(autoSelectedIds(applySourceCap(ideas, clamped)));
  };

  const handleFileLoad = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const parsed = parseCSV(ev.target.result);
      setRows(parsed);
    };
    reader.readAsText(file);
  };

  const handleEvaluate = async () => {
    if (!rows.length) return;
    setStage("evaluating");
    setError("");
    setIdeas([]);
    setSelected(new Set());

    const BATCH = 15;
    const allIdeas = [];

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH).map(sanitizeRow);
      setProgress({ done: i, total: rows.length });

      const prompt = `
Evaluate the following ${batch.length} dental news items scraped for USA Dental Report.
For EACH item, score it 1-10 on three dimensions:
- relevanceScore (dental industry relevance for practicing dentists)
- recencyScore (how recent/timely is this news)
- engagementScore (LinkedIn engagement potential based on headline quality and topic)

Also compute an overall score (average of the three, rounded to nearest integer).

ONLY IF the overall score is 6 or higher, also write a suggested LinkedIn post draft:
- suggestedTitle: short punchy idea title (max 80 chars)
- draftText: 2-3 sentence LinkedIn post body for USA Dental Report's audience of dental professionals

IMPORTANT: USA Dental Report does not write, report, test, or rank this content itself - it curates and shares third-party news and resources on LinkedIn. The draftText must read as commentary introducing or framing someone else's work, never as USA Dental Report's (or "our"/"we") own reporting, testing, ranking, or analysis.
- Never use phrasing like "USA Dental Report breaks down/reports/explores/analyzes/shares its take".
- Never use first-person plural claims of original work, e.g. "We ranked...", "We tested...", "Our top picks...", "We found...". Any ranking, list, or analysis described in the source belongs to whoever published it (the article's outlet, author, or company), not to USA Dental Report.
- Attribute the original work to its source using the item's source/outlet name when available (e.g. "Deutsche Dental ranked the top 5..."), or use neutral framing like "This piece looks at...", "New ranking of...", "Worth a read for dentists..." when no clear source name is available.

If the overall score is below 6, set suggestedTitle and draftText to null - do not write a draft for low-scoring items.

Include a one-sentence rationale explaining why this content will or won't perform.

Respond ONLY with a valid JSON array. No markdown, no explanation, no preamble:
[
  {
    "id": 0,
    "originalTitle": "...",
    "suggestedTitle": "..." | null,
    "draftText": "..." | null,
    "relevanceScore": 8,
    "recencyScore": 7,
    "engagementScore": 6,
    "score": 7,
    "rationale": "...",
    "date": "...",
    "source": "..."
  }
]

Items:
${JSON.stringify(batch, null, 2)}
`;

      let result;
      try {
        result = await callClaude(prompt);
      } catch (err) {
        console.warn(`Batch ${i}–${i + BATCH} failed, retrying once:`, err.message);
        await new Promise(r => setTimeout(r, 1000));
        try {
          result = await callClaude(prompt);
        } catch (retryErr) {
          console.warn(`Batch ${i}–${i + BATCH} failed again, skipping:`, retryErr.message);
          setError(`Batch ${i + 1}–${Math.min(i + BATCH, rows.length)} skipped: ${retryErr.message}`);
          await new Promise(r => setTimeout(r, 1000));
          setError("");
          continue;
        }
      }

      const scored = (Array.isArray(result) ? result : [result]).map((r, idx) => {
        const row = batch[idx] ?? {};
        const item = {
          ...r,
          id: `${i + idx}`,
          order: i + idx,
          date:   row.date   ?? row.published ?? "",
          source: row.source ?? row.domain    ?? row.outlet ?? "",
          link:   row.link   ?? row.url       ?? row.href    ?? row.article_url ?? "",
        };
        return { ...item, sourceKey: sourceKey(item) };
      });
      allIdeas.push(...scored);
    }

    setProgress({ done: rows.length, total: rows.length });

    if (allIdeas.length === 0) {
      setError("All batches failed. Check that your CSV has readable text content.");
      setStage("upload");
      return;
    }

    // Best-first, ties broken by original CSV order so ranking is stable.
    allIdeas.sort((a, b) => (b.score - a.score) || (a.order - b.order));

    setIdeas(allIdeas);
    setSelected(autoSelectedIds(applySourceCap(allIdeas, maxPerSource)));
    setStage("results");
  };

  const handleGenerateDraft = async (item) => {
    setDraftGenStates(s => ({ ...s, [item.id]: "generating" }));
    try {
      const draft = await generateDraftFor(item);
      setIdeas(prev => prev.map(i => i.id === item.id
        ? { ...i, suggestedTitle: draft.suggestedTitle, draftText: draft.draftText }
        : i));
      setDraftGenStates(s => ({ ...s, [item.id]: "done" }));
    } catch (err) {
      setDraftGenStates(s => ({ ...s, [item.id]: `error: ${err.message}` }));
    }
  };

  const handlePushOne = async (item) => {
    setPushStates(s => ({ ...s, [item.id]: "pushing" }));
    try {
      const text = item.link ? `${item.draftText}\n\n${item.link}` : item.draftText;
      await bufferCreateIdea(item.suggestedTitle, text);
      setPushStates(s => ({ ...s, [item.id]: "done" }));
    } catch (err) {
      setPushStates(s => ({ ...s, [item.id]: `error: ${err.message}` }));
    }
  };

  const handlePushSelected = async () => {
    const toPush = ideas.filter(i => selected.has(i.id) && pushStates[i.id] !== "done");
    for (const item of toPush) await handlePushOne(item);
  };

  const toggleItem = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const pushableSelected = ideas.filter(i => selected.has(i.id) && pushStates[i.id] !== "done");

  const STAGES = ["upload", "evaluating", "results"];
  const stageIdx = STAGES.indexOf(stage);

  return (
    <div style={{
      minHeight: "100vh", background: C.bg,
      fontFamily: "'IBM Plex Mono', 'Fira Code', monospace",
      color: C.text, padding: "32px 16px",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;700&family=IBM+Plex+Sans:wght@400;500;700&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: ${C.surface}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
        input { outline: none; }
        button:hover:not(:disabled) { filter: brightness(1.12); }
      `}</style>

      <div style={{ maxWidth: 860, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <div style={{ width: 8, height: 32, background: C.accent, borderRadius: 2 }} />
            <h1 style={{
              fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: "-0.02em",
              fontFamily: "'IBM Plex Sans', sans-serif",
            }}>
              USA Dental Report
              <span style={{ color: C.muted, fontWeight: 400 }}> → </span>
              Buffer Ideas
            </h1>
          </div>
          <p style={{ margin: "0 0 0 20px", fontSize: 13, color: C.muted }}>
            Upload your news scraper CSV · Claude scores &amp; drafts · Push top picks to Buffer as LinkedIn Ideas
          </p>
        </div>

        {/* Stage pills */}
        <div style={{ display: "flex", gap: 6, marginBottom: 28 }}>
          {[["01", "Upload CSV", 0], ["02", "Evaluate", 1], ["03", "Push Ideas", 2]].map(([num, lbl, idx]) => {
            const active = stageIdx === idx;
            const done   = stageIdx > idx;
            return (
              <div key={lbl} style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "6px 12px", borderRadius: 8, flex: 1,
                background: active ? C.accent + "22" : done ? C.green + "11" : C.surface,
                border: `1px solid ${active ? C.accent + "66" : done ? C.green + "33" : C.border}`,
              }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: active ? C.accentHi : done ? C.green : C.muted }}>{num}</span>
                <span style={{ fontSize: 11, fontWeight: active ? 700 : 400, color: active ? C.text : done ? C.green : C.muted }}>{lbl}</span>
              </div>
            );
          })}
        </div>

        {error && (
          <div style={{
            background: C.red + "18", border: `1px solid ${C.red}44`,
            borderRadius: 8, padding: "12px 16px", marginBottom: 20,
            fontSize: 13, color: C.red,
          }}>⚠ {error}</div>
        )}

        {/* ── Upload ── */}
        {stage === "upload" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div
              onClick={() => fileRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = ev => setRows(parseCSV(ev.target.result));
                reader.readAsText(file);
              }}
              style={{
                background: C.card, border: `2px dashed ${C.border}`,
                borderRadius: 14, padding: "52px 32px",
                textAlign: "center", cursor: "pointer",
              }}
            >
              <div style={{ fontSize: 36, marginBottom: 12 }}>📄</div>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Drop your scraper CSV here</div>
              <div style={{ fontSize: 12, color: C.muted }}>
                or click to browse · GitHub Actions artifact · any CSV with a title/headline column
              </div>
              <input ref={fileRef} type="file" accept=".csv" onChange={handleFileLoad} style={{ display: "none" }} />
            </div>

            {rows.length > 0 && (
              <div style={{
                background: C.card, border: `1px solid ${C.green}44`,
                borderRadius: 10, padding: "14px 18px",
                display: "flex", alignItems: "center", justifyContent: "space-between",
              }}>
                <div>
                  <span style={{ color: C.green, fontWeight: 700 }}>{rows.length} rows loaded</span>
                  <span style={{ color: C.muted, fontSize: 12, marginLeft: 10 }}>
                    Columns: {Object.keys(rows[0]).join(", ")}
                  </span>
                </div>
                <button onClick={() => setRows([])} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18 }}>×</button>
              </div>
            )}

            <button
              onClick={handleEvaluate}
              disabled={!rows.length}
              style={{
                background: rows.length ? C.accent : C.border,
                color: rows.length ? "#fff" : C.muted,
                border: "none", borderRadius: 9,
                padding: "13px 28px", fontSize: 14, fontWeight: 700,
                cursor: rows.length ? "pointer" : "default",
                letterSpacing: "0.04em",
              }}
            >
              Evaluate {rows.length > 0 ? `${rows.length} items` : "CSV"} with Claude →
            </button>
          </div>
        )}

        {/* ── Evaluating ── */}
        {stage === "evaluating" && (
          <div style={{ textAlign: "center", padding: "64px 32px" }}>
            <div style={{ fontSize: 40, marginBottom: 20 }}>🧠</div>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Claude is evaluating your news items…</div>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 28 }}>
              Scoring relevance, recency &amp; engagement · Writing LinkedIn drafts
            </div>
            <div style={{ maxWidth: 320, margin: "0 auto" }}>
              <div style={{ height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
                <div style={{
                  width: progress.total ? `${(progress.done / progress.total) * 100}%` : "20%",
                  height: "100%", background: C.accent, borderRadius: 3, transition: "width 0.4s ease",
                }} />
              </div>
              {progress.total > 0 && (
                <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>{progress.done} / {progress.total} items</div>
              )}
            </div>
          </div>
        )}

        {/* ── Results ── */}
        {stage === "results" && ideas.length > 0 && (
          <div>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              marginBottom: 20, flexWrap: "wrap", gap: 12,
            }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <span style={{ fontSize: 13, color: C.muted }}>
                  {ideas.length} evaluated · <span style={{ color: C.text }}>{selected.size} selected</span>
                </span>
                <button onClick={() => setSelected(new Set(visibleIdeas.map(i => i.id)))}
                  style={{ background: "none", border: "none", color: C.accentHi, fontSize: 12, cursor: "pointer" }}>
                  Select all{hideCapped ? " shown" : ""}
                </button>
                <button onClick={() => setSelected(new Set())}
                  style={{ background: "none", border: "none", color: C.muted, fontSize: 12, cursor: "pointer" }}>
                  Clear
                </button>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => { setIdeas([]); setRows([]); setStage("upload"); }}
                  style={{
                    background: C.surface, color: C.textDim, border: `1px solid ${C.border}`,
                    borderRadius: 8, padding: "8px 14px", fontSize: 12, cursor: "pointer",
                  }}
                >← New CSV</button>
                <button
                  onClick={handlePushSelected}
                  disabled={pushableSelected.length === 0}
                  style={{
                    background: pushableSelected.length > 0 ? C.accent : C.border,
                    color: pushableSelected.length > 0 ? "#fff" : C.muted,
                    border: "none", borderRadius: 8,
                    padding: "8px 18px", fontSize: 13, fontWeight: 700,
                    cursor: pushableSelected.length > 0 ? "pointer" : "default",
                  }}
                >
                  Push {pushableSelected.length} selected to Buffer →
                </button>
              </div>
            </div>

            <div style={{
              background: C.card, border: `1px solid ${C.border}`, borderRadius: 10,
              padding: "14px 16px", marginBottom: 16,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: C.textDim, fontWeight: 600 }}>Max posts per source</span>
                <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                  {[["−", maxPerSource - 1], ["+", maxPerSource + 1]].map(([sym, next], idx) => (
                    <button
                      key={sym}
                      onClick={() => changeMaxPerSource(next)}
                      disabled={next < 1 || next > 10}
                      style={{
                        background: C.surface, color: next < 1 || next > 10 ? C.border : C.text,
                        border: `1px solid ${C.border}`,
                        borderRadius: idx === 0 ? "7px 0 0 7px" : "0 7px 7px 0",
                        width: 30, height: 30, fontSize: 15, fontWeight: 700,
                        cursor: next < 1 || next > 10 ? "default" : "pointer",
                      }}
                    >{sym}</button>
                  ))}
                  <span style={{
                    fontSize: 15, fontWeight: 800, color: C.accentHi,
                    minWidth: 28, textAlign: "center",
                  }}>{maxPerSource}</span>
                </div>
                <span style={{ fontSize: 11, color: C.muted }}>
                  {cappedCount > 0
                    ? `${cappedCount} item${cappedCount === 1 ? "" : "s"} over the limit, de-selected`
                    : "no source is over the limit"}
                </span>
                {cappedCount > 0 && (
                  <label style={{ fontSize: 11, color: C.textDim, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={hideCapped}
                      onChange={e => toggleHideCapped(e.target.checked)}
                      style={{ accentColor: C.accent, cursor: "pointer" }}
                    />
                    Hide them
                  </label>
                )}
              </div>

              {tally.length > 0 && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                  {tally.slice(0, 6).map(([domain, total, over]) => (
                    <span key={domain} style={{
                      fontSize: 11, padding: "3px 9px", borderRadius: 999,
                      background: over > 0 ? C.amber + "18" : C.surface,
                      border: `1px solid ${over > 0 ? C.amber + "44" : C.border}`,
                      color: over > 0 ? C.amber : C.muted,
                    }}>
                      {domain} · {total}{over > 0 ? ` (${over} over)` : ""}
                    </span>
                  ))}
                  {tally.length > 6 && (
                    <span style={{ fontSize: 11, color: C.muted, alignSelf: "center" }}>
                      +{tally.length - 6} more sources
                    </span>
                  )}
                </div>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 24 }}>
              {[
                ["High (7–10)", ideas.filter(i => i.score >= 7).length, C.green],
                ["Medium (4–6)", ideas.filter(i => i.score >= 4 && i.score < 7).length, C.amber],
                ["Low (1–3)",   ideas.filter(i => i.score < 4).length, C.red],
              ].map(([lbl, count, color]) => (
                <div key={lbl} style={{
                  background: C.card, border: `1px solid ${color}33`,
                  borderRadius: 10, padding: "14px 16px",
                  display: "flex", alignItems: "center", gap: 12,
                }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color }}>{count}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>{lbl}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {visibleIdeas.map(item => (
                <IdeaCard
                  key={item.id}
                  item={item}
                  selected={selected.has(item.id)}
                  onToggle={toggleItem}
                  onPush={handlePushOne}
                  pushState={pushStates[item.id]}
                  onGenerateDraft={handleGenerateDraft}
                  draftGenState={draftGenStates[item.id]}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
