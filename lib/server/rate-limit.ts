const hits = new Map<string, { count: number; resets: number }>();

export function rateLimit(key: string, limit = 40, windowMs = 60_000) {
  const now = Date.now(); const current = hits.get(key);
  if (!current || current.resets < now) { hits.set(key, { count: 1, resets: now + windowMs }); return true; }
  current.count += 1; return current.count <= limit;
}
