export function composeAuthoritySource(base, css) {
  const trimmed = css.trim();
  if (!trimmed) return base.trimEnd() + '\n';
  const blocks = trimmed.split('/* THEME_LAB_AUTHORITY_BLOCK_BOUNDARY */').map(block => block.trim());
  if (blocks.some(block => !block)) throw new Error('empty authority block');
  return base.trimEnd() + '\n' + blocks.map(block => `\n[[module CSS]]\n${block}\n[[/module]]\n`).join('');
}
