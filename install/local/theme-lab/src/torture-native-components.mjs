import fs from'node:fs/promises';
import path from'node:path';
import{fileURLToPath}from'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

export async function loadTortureNativeRating(){
 return {html:await fs.readFile(path.join(root,'fixtures/wikidot-rate-widget.html'),'utf8')};
}
