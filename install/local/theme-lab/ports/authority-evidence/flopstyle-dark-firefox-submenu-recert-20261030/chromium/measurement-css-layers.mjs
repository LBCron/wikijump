import crypto from "node:crypto";

const sha = value => crypto.createHash("sha256").update(value).digest("hex");

// Exact duplicate layers are redundant. Keep first occurrence order because
// non-identical layers remain cascade-sensitive.
export function dedupeCssLayers(layers) {
  const seen = new Set();
  return layers.filter(layer => {
    if (typeof layer !== "string" || !layer.trim()) return false;
    const identity = sha(layer);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
