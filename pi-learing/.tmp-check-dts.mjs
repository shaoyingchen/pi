import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.join(process.cwd(), "node_modules", "@earendil-works");
const stats = new Map();

for (const pkg of readdirSync(root)) {
  const pkgDir = path.join(root, pkg);
  const distDir = path.join(pkgDir, "dist");
  if (!existsSync(distDir)) continue;

  let total = 0;
  let mapped = 0;
  const misses = [];

  function scan(file) {
    const text = readFileSync(file, "utf-8");
    const re = /from\s+"((?:\.\.\/)+src\/([^"]*?)\.ts)"/g;
    let m;
    while ((m = re.exec(text))) {
      total++;
      const rel = m[2];
      const candidate = path.join(distDir, rel + ".d.ts");
      if (existsSync(candidate)) mapped++;
      else misses.push(rel);
    }
  }

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".d.ts")) scan(p);
    }
  }

  walk(distDir);
  stats.set(pkg, { total, mapped, misses });
}

for (const [pkg, s] of stats) {
  console.log(`${pkg}: refs=${s.total} mappable=${s.mapped} missing=${s.misses.length}`);
  for (const x of s.misses.slice(0, 5)) console.log("   MISS", x);
}
