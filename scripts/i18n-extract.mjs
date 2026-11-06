// Collects the interface text of the customer pages and the receipt (everything written as tx('…') / tr('…'))
// into server/lib/ui-strings.json, which the AI translation works from. Run after changing those texts:
//   node scripts/i18n-extract.mjs        (tests fail when the file is out of date)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
export const FILES = { 'public/m/m.js': 'tx', 'public/member/member.js': 'tx', 'public/web/web.js': 'tx', 'public/shared/render.js': 'tr' };
export function extract() {
  const out = new Set();
  for (const [f, fn] of Object.entries(FILES)) {
    const src = readFileSync(root + f, 'utf8');
    const re = new RegExp(`\\b${fn}\\(\\s*('(?:\\\\.|[^'\\\\])*'|"(?:\\\\.|[^"\\\\])*")`, 'g');
    for (const m of src.matchAll(re)) out.add(Function(`return ${m[1]}`)());
  }
  // order / kitchen status words shown on the ordering page
  const ui = readFileSync(root + 'public/shared/ui.js', 'utf8');
  for (const name of ['STATUS_TH', 'PREP_TH']) {
    const m = new RegExp(`export const ${name} = (\\{[^}]*\\})`).exec(ui);
    if (m) for (const v of Object.values(Function(`return ${m[1]}`)())) out.add(v);
  }
  return [...out].filter((s) => /[฀-๿]/.test(s)).sort();
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const list = extract();
  writeFileSync(root + 'server/lib/ui-strings.json', JSON.stringify(list, null, 0).replace(/","/g, '",\n"') + '\n');
  console.log(list.length, 'strings');
}
