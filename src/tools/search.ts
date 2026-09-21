// Pluggable web-search service: built-in bing (cn.bing.com) / so (360) / baidu providers,
// a custom URL template, and auto sequential fallback. Zero-dep HTML scraping (aligned with
// reference search implementation). This is the backend for the web_search tool.
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchBackend = "bing" | "so" | "baidu";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function fetchHtml(url: string): Promise<string> {
  return fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) }).then((r) => r.text());
}

export async function searchBing(query: string, limit: number): Promise<SearchResult[]> {
  const html = await fetchHtml(`https://cn.bing.com/search?q=${encodeURIComponent(query)}`);
  const results: SearchResult[] = [];
  const blocks = html.split('<li class="b_algo">');
  for (let i = 1; i < blocks.length && results.length < limit; i++) {
    const link = blocks[i].match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link || !/^https?:/i.test(link[1])) continue;
    const snippet = blocks[i].match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({ title: stripHtml(link[2]).trim(), url: link[1], snippet: snippet ? stripHtml(snippet[1]).trim() : "" });
  }
  return results;
}

export async function searchSo(query: string, limit: number): Promise<SearchResult[]> {
  const html = await fetchHtml(`https://www.so.com/s?q=${encodeURIComponent(query)}`);
  const results: SearchResult[] = [];
  const re = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < limit) {
    if (!/^https?:/i.test(m[1])) continue;
    results.push({ title: stripHtml(m[2]).trim(), url: m[1], snippet: "" });
  }
  return results;
}

export async function searchBaidu(query: string, limit: number): Promise<SearchResult[]> {
  const html = await fetchHtml(`https://www.baidu.com/s?wd=${encodeURIComponent(query)}`);
  return parseLinks(html, limit);
}

function parseLinks(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const re = /<a[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < limit) {
    const title = stripHtml(m[2]).trim();
    if (title.length < 4) continue;
    if (results.some((r) => r.url === m![1])) continue;
    results.push({ title, url: m[1], snippet: "" });
  }
  return results;
}

async function searchCustom(urlTemplate: string, query: string, limit: number): Promise<SearchResult[]> {
  const url = urlTemplate.replace(/\{query\}/g, encodeURIComponent(query));
  const html = await fetchHtml(url);
  return parseLinks(html, limit);
}

const PROVIDERS: Record<SearchBackend, (q: string, l: number) => Promise<SearchResult[]>> = {
  bing: searchBing,
  so: searchSo,
  baidu: searchBaidu,
};

export interface SearchOptions {
  backend?: SearchBackend | "auto";
  custom?: string;
}

// Unified search entry: custom > specified backend > auto sequential fallback.
export async function search(query: string, limit: number, opts: SearchOptions = {}): Promise<{ results: SearchResult[]; backend: string }> {
  const backend = opts.backend ?? "auto";
  if (opts.custom) {
    try {
      const results = await searchCustom(opts.custom, query, limit);
      if (results.length) return { results, backend: "custom" };
    } catch {
      /* fall back to built-in backends */
    }
  }
  const order: SearchBackend[] = backend === "auto" ? ["bing", "so", "baidu"] : [backend];
  for (const b of order) {
    try {
      const results = await PROVIDERS[b](query, limit);
      if (results.length) return { results, backend: b };
    } catch {
      /* try the next one */
    }
  }
  return { results: [], backend: order[order.length - 1] };
}
