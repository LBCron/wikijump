#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

if (process.argv.includes('--target=sigma10')) throw new Error('The Sigma-9 diagnostic credit fixture cannot represent Sigma-10. Use the frozen real Sigma-10 Wikidot replay in authority-evidence/sigma-saved-final.');
const dir=path.dirname(fileURLToPath(import.meta.url));
const snapshots=path.join(dir,'source-snapshots');
const load=async name=>fs.readFile(path.join(snapshots,name),'utf8');
const cleanCreditStart=async source=>{
  const css=await load('credit-style.wikidot.txt');
  const cssMatch=css.match(/\[\[code type="CSS"\]\]([\s\S]*?)\[\[\/code\]\]/u);
  if(!cssMatch) throw new Error('credit:style CSS code block missing');
  let style=cssMatch[1].replace(/^\s*@import[^;]+;\s*$/gmu,'');
  style=style.replace(/url\(['"]?http:\/\/scp-jp\.wdfiles\.com\/local--files\/heritage-collection-jp\/heritage-emblem\.png['"]?\)/gu,'none');
  // The remote heritage emblem image is replaced by readable Japanese text
  // below. Preserve the component's horizontal badge/rating relationship
  // instead of forcing four glyphs into the upstream image's narrow box.
  style+='\n.heritage-rating-module { display: flex !important; align-items: center !important; flex-wrap: wrap !important; gap: .5rem !important; }\n.heritage-rating-module .heritage-emblem { flex: 0 0 auto !important; width: max-content !important; min-width: max-content !important; max-width: 9rem !important; }\n';
  source=source.replace(/\[\[module css\]\][\s\S]*?\[\[\/module\]\]\s*/iu,'');
  source=source.replace(/\[\[image http:\/\/scp-jp\.wikidot\.com\/local--files\/nav:side\/blank\.png[^\]]*\]\]/giu,'ⓘ');
  source=source.replace(/\[\[image http:\/\/scp-jp\.wikidot\.com\/local--files\/nav:side\/blank\.png[^\]]*\]\]/giu,'ⓘ');
  // Wikidot image `link=` values can contain nested [[iftags]] macros. Match
  // the complete known image macro through its terminal style attribute;
  // stopping at the first `]]` leaves the remainder as malformed modal text.
  source=source.replace(/\[\[image http:\/\/scp-jp\.wdfiles\.com\/local--files\/component:heritage-rating\/scp-heritage-v3\.png[\s\S]*?style="max-width: none;"\]\]/giu,'殿堂入り');
  source=source.replace(/\[\[iframe https:\/\/scp-jp\.github\.io\/files\/util\/common\/credit\/backmodule\/(?:start|otherwise)\.html[^\]]*\]\]/giu,'');
  source=source.replace(/\[\[iframe https:\/\/scp-jp\.github\.io\/files\/util\/common\/credit\/backmodule\/end\.html[^\]]*\]\]/giu,'[[a href="#u-credit-view" class="credit-back-link"]]戻る[[/a]]');
  if(/https?:\/\//iu.test(style) || /scp-jp\.github\.io\//u.test(source) || /scp-jp\.wdfiles\.com\//u.test(source)) throw new Error('unexpected external credit dependency remains');
  return {style,source};
};
const [start,otherwise,end]=await Promise.all(['credit-start.wikidot.txt','credit-otherwise.wikidot.txt','credit-end.wikidot.txt'].map(load));
const parts=await cleanCreditStart(start);
const localizeCreditAssets=markup=>markup
  .replace(/\[\[image https?:\/\/[^\]]*nav:side\/blank\.png[^\]]*\]\]/giu,'ⓘ')
  .replace(/\[\[image https?:\/\/[^\s\]]*component:heritage-rating\/scp-heritage-v3\.png[\s\S]*?style="\s*max-width: none;"\]\]/giu,'殿堂入り')
  .replace(/\[\[iframe https?:\/\/scp-jp\.github\.io\/files\/util\/common\/credit\/backmodule\/(?:start|otherwise)\.html[^\]]*\]\]/giu,'')
  .replace(/\[\[iframe https?:\/\/scp-jp\.github\.io\/files\/util\/common\/credit\/backmodule\/end\.html[^\]]*\]\]/giu,'[[a href="#u-credit-view" class="credit-back-link"]]戻る[[/a]]');
const article=`+ 財団記録: インタラクティブテーマ受け入れfixture\n\n++ UI navigation fixture is active\n\nDesktop and mobile navigation, including its local related-site frame, is part of this acceptance surface.\n\n[[div_ class="scpnet-interwiki-frame interwiki-stylable"]]\n[[include nav:interwiki]]\n[[/div]]\n\n[[module Rate]]\n\n見出しと本文の日本語を確認します。異なる文字種、長い行、句読点、リンク色を実際の描画で確かめます。\n\n* 箇条書き: ナビゲーションと階層\n* [#fixture-link リンク状態]\n\n> 引用: 読みやすい行間と背景の確認です。\n\n||~ 状態 ||~ 内容 ||\n|| table || 日本語セル ||\n\n[[code]]長いコード行: const visualAcceptance = "日本語 / Wikidot source / colors";\n二行目[[/code]]\n\n[[toc]]\n\n[[tabview]]\n[[tab 概要]]\n日本語のタブ本文です。\n[[/tab]]\n[[tab 詳細]]\n別のタブへ移動できます。\n[[/tab]]\n[[/tabview]]\n\n[[collapsible show="開く" hide="閉じる"]]\n折り畳み領域です。\n[[/collapsible]]\n\n脚注テキスト[[footnote]]脚注の日本語本文です。[[/footnote]]`;
const source=localizeCreditAssets(`[[module CSS]]\n${parts.style}\n[[/module]]\n\n${article}\n\n${parts.source}\n**タイトル:** インタラクティブテーマ受け入れfixture\n**著者:** 日本語テスト著者\n**作成年:** 2026\n${otherwise}\n**その他のライセンス:** このfixture固有の説明は Creative Commons Attribution 4.0 International で提供されています。日本語のライセンス案内を表示し、関連リンクは下記にあります。\n[https://creativecommons.org/licenses/by/4.0/ ライセンス本文]\n${end}\n`);
const noRate=source.replace('creditRate creditModule {$mode}','creditRate creditModule no-rate');
const heritage=source;
await fs.writeFile(path.join(dir,'fixture.wikidot.txt'),source);
await fs.writeFile(path.join(dir,'fixture-no-rate.wikidot.txt'),noRate);
await fs.writeFile(path.join(dir,'fixture-heritage.wikidot.txt'),heritage);
await fs.writeFile(path.join(dir,'fixture-source.json'),JSON.stringify({schema:'theme_lab_interactive_fixture.v1',slug:'theme-lab-visual-acceptance-20260924',title:'SCP-JP Theme Lab Interactive Visual Fixture',source_sha256:crypto.createHash('sha256').update(source).digest('hex'),source_bytes:Buffer.byteLength(source),variants:{normal:'fixture.wikidot.txt',no_rate:'fixture-no-rate.wikidot.txt',heritage:{source:'fixture-heritage.wikidot.txt',tag:'殿堂入り'}},credit_source_identity:'source-identity.json',target_version:'SIGMA9_HISTORICAL_SOURCE_WITH_SYNTHETIC_SUBSTITUTIONS',decision_authority:'SYNTHETIC_DIAGNOSTIC_ONLY',port_conclusion_eligible:false,synthetic_selectors:['.credit-back-link'],real_target_contracts:'../../fixtures/credit-targets.json',module_source_adaptation:'Credit component markup is frozen from historical Sigma-9 JP source. Remote style is flattened from credit:style; remote decorative backmodule iframes and images are represented by local equivalent text/controls so replay does not send requests. Original snapshots and hashes are retained. The iframe replacement anchor is synthetic and cannot authorize a published CSS adaptation; it is not Sigma-10 markup.',features:['Rate','historical Sigma-9 credit:start/otherwise/end markup','credit view and otherwise hash targets','Japanese reader components','TOC','tabs','collapsible','table','blockquote','code','footnote'],uncovered_features:['h3-h6 headings','ordered and nested lists','scp-image-block','wide five-column table','blockquote class','long unbroken link','bibliography module']},null,2)+'\n');
console.log(JSON.stringify({source_bytes:Buffer.byteLength(source),source_sha256:crypto.createHash('sha256').update(source).digest('hex'),external_dependencies:(source.match(/https?:\/\//gu)||[]).length}));
