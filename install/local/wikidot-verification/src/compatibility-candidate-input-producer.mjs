import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildQ1026UserIdentitySource,
  Q1026_FIXTURE_PROVENANCE,
  Q1026_USER_FIXTURES,
} from "./open43-q1026-user-identity-candidate-case-set.mjs";
import {
  OPEN43_Q1032_EVIDENCE,
  OPEN43_Q1032_SAVED_DIRECTORY_SOURCE,
} from "./open43-q1032-members-userinfo-candidate-contract.mjs";
import { SAVED_SOURCE as Q1036_SAVED_SOURCE } from "./open43-q1036-search-feed-candidate-contract.mjs";
import { FORUM_MINI_SAVED_SOURCE } from "./open43-q778-forum-mini-candidate-case-set.mjs";
import { Q1034_SAVED_SOURCES } from "./open43-q1034-forum-candidate-case-set.mjs";
import { Q1035_SAVED_SOURCES } from "./open43-q1035-sitechanges-candidate-case-set.mjs";
import { OPEN43_B690_GEOMETRY_FIXTURE } from "./open43-browser-690-candidate-case-set.mjs";
import { captureUrlsSha256 } from "../scripts/capture-framerail-route-action-temporal.mjs";
import { defaultBrowserRoot, loadPlaywright } from "./browser-session.mjs";
import { CANDIDATE_CASE_SETS } from "./candidate-case-command.mjs";
import { leasedPageEdit } from "./page-edit-lease.mjs";
import { readJsonObject, sealJsonNoReplace, sha256File } from "./standing-browser-parity-util.mjs";

function clearCandidateRedisCache(cache) {
  execFileSync("docker", ["exec", cache, "redis-cli", "EVAL", "local keys=redis.call('keys','*'); local deleted=0; for _,key in ipairs(keys) do if string.sub(key,1,5) ~= 'rsmq:' then redis.call('del',key); deleted=deleted+1 end end; return deleted", "0"], { stdio: "ignore" });
}

export const COMPATIBILITY_CANDIDATE_INPUT_RECEIPT_SCHEMA = "wikijump.compatibility_candidate_input_receipt.v2";
const SITE_ID = 6_000_003;
const SITE_SLUG = "scpaiueouiuiuiui";
const STANDARD_SITE_SLUG = "scp-wiki";
const FOREIGN_SITE_ID = 6_000_006;
const ACTOR_IDS = Object.freeze({ editor: 20_000_007, eligible: 20_000_008, registered: 20_000_009, pending: 20_000_010, banned: 20_000_011, other: 20_000_012 });
export const Q778_WIKIDOT_AUTHOR = Object.freeze({ user_id: 1_735_419, name: "Lt Flops", slug: "lt-flops" });
const MEDIA_BROWSER_EVIDENCE = Object.freeze({
  M756_BROWSER_CACHE_TRANSITIONS: "E_ICON_OBSERVATIONS",
  M776_BROWSER_GEOMETRY_AND_NETWORK: "E_G06",
  M806_BROWSER_GEOMETRY_AND_NETWORK: "E_G61",
  M1043_BROWSER_RENDER_AND_VIEWER: "E_FOCUSED_CORPUS",
  M1062_BROWSER_UPLOAD_FLOW: "E_UPLOAD_HISTORICAL_FAILURE",
});
const FTML_MARKER_FIXTURE_INDEX = new URL("../fixtures/ftml-marker-contract/fixtures.json", import.meta.url);
const B689_SCP8980_SOURCE = Object.freeze({
  slug: "scp-8980",
  title: "SCP-8980",
  rating: 1559,
  tags: Object.freeze(["_cc", "_cc4", "_licensebox", "_listpages", "alive", "bleak", "bureaucracy", "computer", "deepwell-catalog", "director-graham", "electrical", "ethics-committee", "euclid", "fire-suppression-dept", "foundation-personnel", "horror", "humanoid", "odongo-tejani", "phobia-anthology", "psychological-horror", "reviewers-spotlight", "sapient", "scp", "spook-nico-2024-unofficial"]),
  path: new URL("../../../../deepwell/seeder/scp-8980.ftml", import.meta.url),
  sha256: "11ecede90b114c425afc60f7f146a697bdc4ca4aaa16e23fc213d947feb86710",
});
const Q807_SEARCH_ALL_SOURCE = Object.freeze({
  slug: "search:all",
  title: "Search all Wikidot sites",
  wikitext: "[[module SearchAll]]",
  sha256: "bf18c48fe807b280835e66c72eb65f156b97f2d6703356d625b8690bd842c127",
});
const B689_THEME_BASALT_SOURCE = Object.freeze({
  slug: "theme:basalt",
  title: "Basalt Theme",
  rating: 312,
  tags: Object.freeze(["theme"]),
  path: new URL("../../../../deepwell/seeder/theme-basalt.ftml", import.meta.url),
  sha256: "a29d8d0f285f4e291975f0139519ddfb472e7d6f458bb1d7c14189c9a2e922c0",
});
const B689_THEME_BASALT_USERS = new URL(
  "../fixtures/open87-basalt-users/runtime-state.json",
  import.meta.url,
);
const B689_SCP8980_USERS = new URL(
  "../fixtures/open43-scp8980-users/runtime-state.json",
  import.meta.url,
);
const B689_SCP8980_FRAGMENTS = Object.freeze([
  Object.freeze({ slug: "fragment:scp-8980-1", title: "SCP-8980 Fragment 1", rating: 1559, tags: ["fragment"], path: new URL("../../../../deepwell/seeder/fragment-scp-8980-1.ftml", import.meta.url) }),
  Object.freeze({ slug: "fragment:scp-8980-2", title: "SCP-8980 Fragment 2", rating: 1559, tags: ["fragment"], path: new URL("../../../../deepwell/seeder/fragment-scp-8980-2.ftml", import.meta.url) }),
]);
const B689_NAVIGATION_DEPENDENCIES = Object.freeze([
  Object.freeze({ slug: "scp-744", title: "SCP-744", rating: 100, tags: ["_cc", "_licensebox", "auditory", "bleak", "building", "cernunnos", "cognitohazard", "corporate", "euclid", "horror", "psychological-horror", "reality-bending", "rewrite", "scp", "spatial", "surrealism", "the-trashfire"], path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/scp-744/source.wikidot.txt", sha256: "6342f7c46b2a86ec5f76e2a35a15a168b315b0fab4869c22a5d26d8dc22c8f06" }),
  Object.freeze({ slug: "scp-2117", title: "SCP-2117", rating: 310, tags: ["_cc", "_licensebox", "_listpages", "black-rabbit-company", "extraterrestrial", "heimdall", "illustrated", "inscription", "observational", "rewrite", "scp", "spatial", "thaumiel", "vehicle"], path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/scp-2117/source.wikidot.txt", sha256: "6e3c90dd5b6c0847f664399e1c3fbbb374c1e4b56df1f44bd65b19493af0ec3a" }),
  Object.freeze({ slug: "scp-5516", title: "SCP-5516", rating: 78, tags: ["_cc", "_licensebox", "ambrose-restaurant", "animal", "aquatic", "crustacean", "ethics-committee", "hive-mind", "safe", "scp"], path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/scp-5516/source.wikidot.txt", sha256: "9ccece7725093347c5da5578544d23533cc7ca884f05183d2d2e0dcbf6723f74" }),
  Object.freeze({ slug: "classification-committee-memo", title: "Classification Committee Memo", tags: ["_licensebox", "director-aktus", "essay"], path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/classification-committee-memo/source.wikidot.txt", sha256: "541333d3eebf3f5eda8643f1f14feacfb60e47c26081bb0ab8bb84b683140ad2" }),
  Object.freeze({ slug: "info:start", title: "Info Start", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/info:start/source.wikidot.txt", sha256: "d6f589988a92b86a5bf5c1a052a14e3165b2f95f7974665fada068ca402de8c4" }),
  Object.freeze({ slug: "info:more", title: "Info More", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/info:more/source.wikidot.txt", sha256: "839e6a242e27de4f93c54005fcc7edcb0819b4ba95394884dd88b7b8dc9c93cb" }),
  Object.freeze({ slug: "info:end", title: "Info End", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/info:end/source.wikidot.txt", sha256: "d433ca1c052bfefcf88e0163dd783e27e28255f47af828ba2b4d831ba125827b" }),
  Object.freeze({ slug: "component:centered-header-sigma-9", title: "Centered Header Sigma 9", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:centered-header-sigma-9/source.wikidot.txt", sha256: "c386ded1fed6e97baaf9b3c6db18d22297a120843f54f90066af8fc06fc5f98c" }),
  Object.freeze({ slug: "component:croqstyle", title: "Croqstyle", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:croqstyle/source.wikidot.txt", sha256: "3a5b904093d6994619293818e11cfcbe8cb1d9d5d955858cd822bff0ed19150e" }),
  Object.freeze({ slug: "component:fade-in", title: "Fade In", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:fade-in/source.wikidot.txt", sha256: "a952981c4b1443cabdea6cd37205cafa7be3291b61d23ad521016f684418e00a" }),
  Object.freeze({ slug: "component:toggle-sidebar", title: "Toggle Sidebar", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:toggle-sidebar/source.wikidot.txt", sha256: "afa9b19883e508fb8bb458ab12793a3e42e1025456eccc8c7305e266094cd579" }),
  Object.freeze({ slug: "component:bhl-dark-sidebar", title: "BHL Dark Sidebar", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:bhl-dark-sidebar/source.wikidot.txt", sha256: "c6152580c694c8a14214ff63eefb3e8c7fe3fb4417a3da143d00aaff2ebec1fa" }),
  Object.freeze({ slug: "component:collapsible-sidebar", title: "Collapsible Sidebar", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:collapsible-sidebar/source.wikidot.txt", sha256: "a177a7550d82d77904ff668b01197906f12871adf77dfb0f03d82a0f16a45c5d" }),
  Object.freeze({ slug: "component:toggle-sidebar-bhl", title: "Toggle Sidebar BHL", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:toggle-sidebar-bhl/source.wikidot.txt", sha256: "ccfabddbc5f4903b74fb79ae6c58122152f3c5319b0193f5bd6e1d97a3abdd05" }),
  Object.freeze({ slug: "component:centered-header-bhl", title: "Centered Header BHL", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:centered-header-bhl/source.wikidot.txt", sha256: "e11aeac172aa718f081e874541535f2645259a45b2c2cc2bc06ac1ac07755429" }),
  Object.freeze({ slug: "component:author-label-source", title: "Author Label Source", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:author-label-source/source.wikidot.txt", sha256: "0112ff8c7152a5e905a485a6c873842fad9a1d672f75ce392f96b4466cbcc1ca" }),
  Object.freeze({ slug: "theme:flopstyle", title: "Flopstyle Theme", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/theme:flopstyle/source.wikidot.txt", sha256: "f869601843ed067304aeba7d4533d56a8776988d58988948c07cba8bf1b17920" }),
  Object.freeze({ slug: "theme:y2k", title: "Y2K Theme", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/theme:y2k/source.wikidot.txt", sha256: "c2c102c15afbf03460f7045110a8d70c0615020e459c647a4ad82651ab649c8a" }),
  Object.freeze({ slug: "component:betterfootnotes", title: "Better Footnotes", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:betterfootnotes/source.wikidot.txt", sha256: "066c8183fe39451b88e4d53a6b08306829d21846170d14b0688d91f3c6203bc0" }),
  Object.freeze({ slug: "component:acs-animation", title: "ACS Animation", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:acs-animation/source.wikidot.txt", sha256: "783b8842c42bf25d37e6c95bccc9db6cef7d16a817463a579cf7a204e039398a" }),
  Object.freeze({ slug: "component:info-ayers", title: "Info Ayers", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:info-ayers/source.wikidot.txt", sha256: "13d93ba5a4bcc53a41826a18c74725c55f8432fbe942bc954b6743c717fc3a30" }),
  Object.freeze({ slug: "component:interwiki-style", title: "Interwiki Style", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:interwiki-style/source.wikidot.txt", sha256: "0450ad3c256930db4d98fc63ab0e59743257d8e89e2f7266e793a69d35dc73c7" }),
  Object.freeze({ slug: "component:image-block", title: "Image Block", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:image-block/source.wikidot.txt", sha256: "8621baf34484b27a1202c117ea91b4172866a6a74d5d14d0f11fa1859ba03948" }),
  Object.freeze({ slug: "component:image-block-base", title: "Image Block Base", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:image-block-base/source.wikidot.txt", sha256: "0bb0988ec9094851e9fd09a8bb1d1ec499df9912056daaaaae3bd020712350d3" }),
  Object.freeze({ slug: "component:info-ayers-source", title: "Info Ayers Source", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:info-ayers-source/source.wikidot.txt", sha256: "8e7335b191ae2060cbb87105dc3733aefdac76185af6e80c877952e9b749292b" }),
  Object.freeze({ slug: "component:anomaly-class-bar-source", title: "Anomaly Class Bar Source", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:anomaly-class-bar-source/source.wikidot.txt", sha256: "9e86f60ab2663dc20f47bb6afb2dfd34cf8a8eac61fb70662bf8a2df4c8c9910" }),
  Object.freeze({ slug: "component:customizable-acs", title: "Customizable ACS", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:customizable-acs/source.wikidot.txt", sha256: "8f8a863455a6d57c2cbaf62e82637cd66a18b219fb737fef14183f37dafb79bc" }),
  Object.freeze({ slug: "component:license-box-backend", title: "License Box Backend", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:license-box-backend/source.wikidot.txt", sha256: "0ad4d70241570b29f65dead92c9051145e76180c5a6a062f4aa86e1fa5d7b6f6" }),
  Object.freeze({ slug: "component:wikimodule", title: "Wikimodule", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:wikimodule/source.wikidot.txt", sha256: "ef4bfd34df766917ba794fc997876e316e92242facb1f482eea67552f82ae548" }),
  Object.freeze({ slug: "component:license-box", title: "License Box", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:license-box/source.wikidot.txt", sha256: "7265140db4097f4247c0e723b00d3cdfed20e62038266429289753c05ebf890e" }),
  Object.freeze({ slug: "component:license-box-end", title: "License Box End", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:license-box-end/source.wikidot.txt", sha256: "7b2ab00f5bcdc9440565bc30dc37b526da0cdf2f5b8162e677cceaab249062ee" }),
  Object.freeze({ slug: "component:scp-pride", title: "SCP Pride", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:scp-pride/source.wikidot.txt", sha256: "0a241893b083d9e798e66d6a2fea4bae1da8ed4447e67237e6647a1b7cd9e939" }),
  Object.freeze({ slug: "theme:black-highlighter-theme", title: "Black Highlighter Theme", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/theme:black-highlighter-theme/source.wikidot.txt", sha256: "fa840cb320ea4de09864cd687aca308115f9027076d8c5712c3fb52cd5c31a58" }),
  Object.freeze({ slug: "theme:calibri-logos", title: "Calibri Logos Theme", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/theme:calibri-logos/source.wikidot.txt", sha256: "779e906fc12041c219ae4deedc9684b79f8ade7158cf92a8ef952c338cf23e1a" }),
  Object.freeze({ slug: "scp-anthology-2024", title: "SCP Anthology 2024", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/scp-anthology-2024/source.wikidot.txt", sha256: "367053d643ed041a371bc0bf04f50d0bb32812aa5a754564f62520a616d64185" }),
  Object.freeze({ slug: "nav:interwiki", title: "Interwiki Navigation", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/nav:interwiki/source.wikidot.txt", sha256: "75fdb759603f03ac9649f67e61b03d3557bcc4cf94370e05ed3a6cb87d66fe8d" }),
  Object.freeze({ slug: "info:style", title: "Info Module CSS", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/info:style/source.wikidot.txt", sha256: "1723b7584ee15a8b350c76424e4eb81917e2d0cb7c06a1c1e062bd006186358a" }),
  Object.freeze({ slug: "info:start", title: "Info Start", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/info:start/source.wikidot.txt", sha256: "d6f589988a92b86a5bf5c1a052a14e3165b2f95f7974665fada068ca402de8c4" }),
  Object.freeze({ slug: "info:end", title: "Info End", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/info:end/source.wikidot.txt", sha256: "d433ca1c052bfefcf88e0163dd783e27e28255f47af828ba2b4d831ba125827b" }),
  Object.freeze({ slug: "component:info-cw", title: "Info Content Warning", tags: ["component"], path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:info-cw/source.wikidot.txt", sha256: "b474ffeb7fc1bd46b8ec2f9076ef2ce901e6f8d2d619322f8c821bc5f02c3c1c" }),
  Object.freeze({ slug: "component:croqstyle", title: "Croqstyle", tags: ["component"], path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:croqstyle/source.wikidot.txt", sha256: "3a5b904093d6994619293818e11cfcbe8cb1d9d5d955858cd822bff0ed19150e" }),
  Object.freeze({ slug: "component:earthworm", title: "Earthworm", tags: ["component"], path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:earthworm/source.wikidot.txt", sha256: "8bcc6e0f95038d17852031db5f2eff0d185a2f267dc3bc9a9ea72a635e7330cf" }),
  Object.freeze({ slug: "fragment:scp-anthology-2024-earthworm", title: "Anthology 2024 Earthworm", path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/fragment:scp-anthology-2024-earthworm/source.wikidot.txt", sha256: "3a5b9f355c8e56ef4edaf28fa8581beadda4d30c16103c48a8601d155e69bcc9" }),
]);
const B690_SCP2117_FRAGMENTS = Object.freeze([
  Object.freeze({ slug: "fragment:2117-1", title: "SCP-2117-1", tags: ["fragment"], path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/fragment:2117-1/source.wikidot.txt", sha256: "f59b7be43bcc36fac4c3e82acd06b45f694010f50210990e28a36bdbed6934a6" }),
  Object.freeze({ slug: "fragment:2117-2", title: "SCP-2117-2", tags: ["fragment"], path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/fragment:2117-2/source.wikidot.txt", sha256: "117119a89da7f4c387d9cc471d8924b0284929026a55ff2625c53ed082575430" }),
  Object.freeze({ slug: "fragment:2117-3", title: "SCP-2117-3", tags: ["fragment"], path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/fragment:2117-3/source.wikidot.txt", sha256: "2ba1947eb4ecf92ff0bce4747b2869a3ebbe7a89f6bf8ed4d8e55d66c896492c" }),
  Object.freeze({ slug: "fragment:2117-4", title: "SCP-2117-4", tags: ["fragment"], path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/fragment:2117-4/source.wikidot.txt", sha256: "6d0ba43c58f7117ceb288362f0558ab0d52163de03d1d869c4dec43f1318c90c" }),
]);
const B690_SCP2117_DEPENDENCIES = Object.freeze([
  Object.freeze({ slug: "component:pride-highlighter", title: "Pride Highlighter", tags: ["component"], path: "/home/roku/src/Rokurolize/scp-wiki-translation/corpus/en/pages/component:pride-highlighter/source.wikidot.txt", sha256: "06e4dbf96df00ff85e59289b43970f4ed535b6e24c80f3db9dbd6cfc888a4325" }),
]);
const B690_CANARY_ATTACHMENTS = Object.freeze([
  Object.freeze({ page: "scp-744", filename: "744-Thumbnail.png" }),
  Object.freeze({ page: "scp-744", filename: "Cernunnos.svg" }),
  Object.freeze({ page: "scp-744", filename: "Factory.png" }),
  Object.freeze({ page: "fragment:2117-1", filename: "2117.png" }),
  Object.freeze({ page: "scp-5516", filename: "Lobster" }),
]);
const B610_CANARY_ATTACHMENTS = Object.freeze([
  Object.freeze({ page: "scp-9506", filename: "NFSI.png" }),
]);
const B689_PRESERVED_DEPENDENCIES = new Set(["component:interwiki-style", "component:betterfootnotes", "component:acs-animation"]);
const GENERATED_PRIVATE_INPUTS = new Set([
  "framerail-route-action-browser.json",
  "framerail-route-action-denial-storage.json",
  "framerail-route-action-failure-control.json",
  "framerail-route-action-failure-storage.json",
  "framerail-route-action-fixture.json",
  "framerail-route-action-runtime.json",
  "framerail-route-action-success-storage.json",
  "media-browser.json",
  "media-files.json",
]);

export const COMPATIBILITY_CASE_SET_PRIVATE_INPUTS = Object.freeze({
  "comments-hideform-browser": "general-r11.json",
  "framerail-route-action-browser": "framerail-route-action-browser.json",
  "ftml-marker-contract": "general-r11.json",
  "issue1373-amc-new-page": "general-r11.json",
  "open43-689-tabview": "b689-r11.json",
  "open43-690-geometry": "b690-r11.json",
  "open43-a1030-rate": "base-admin-r11.json",
  "open43-a1037-forms": "framerail-route-action-browser.json",
  "open43-a1038-admin-boundary": "base-admin-r11.json",
  "open43-actions": "base-admin-r11.json",
  "open43-authoring": "media-files.json",
  "open43-authoring-history": "media-files.json",
  "open43-b610-shell": "b610-r11.json",
  "open43-backlinks": "backlinks-r23.json",
  "open43-categories": "general-r11.json",
  "open43-embedvideo-browser": "general-r11.json",
  "open43-featuredsite": "general-r11.json",
  "open43-issue1029-join": "base-admin-r11.json",
  "open43-issue1041-action-lifecycle": "issue1041-r24.json",
  "open43-issue1060-register-join-create": "base-admin-r11.json",
  "open43-issue775-edit": "issue775-r24.json",
  "open43-issue777-print": "general-r11.json",
  "open43-mailform-fail-closed": "general-r11.json",
  "open43-media-browser": "media-browser.json",
  "open43-media-files": "media-files.json",
  "open43-membership": "base-admin-r11.json",
  "open43-membership-join": "base-admin-r11.json",
  "open43-page-query-nextprevious": "general-r11.json",
  "open43-page-tree": "general-r11.json",
  "open43-q1026-user-identity": "q1026-r11.json",
  "open43-q1027": "general-r11.json",
  "open43-q1032-members-userinfo": "general-r11.json",
  "open43-q1034-forum": "q1034-r23.json",
  "open43-q1035-sitechanges": "q1035-r23.json",
  "open43-q1036-search-feed": "general-r11.json",
  "open43-q1040": "general-r11.json",
  "open43-q748-topbar-search": "general-r11.json",
  "open43-q778-forum-mini": "general-r11.json",
  "open43-q809": "q809.json",
  "open43-searchall": "general-r11.json",
  "open43-settings-admin": "base-admin-r11.json",
  "open43-settings-analytics": "base-admin-r11.json",
  "open43-settings-lifecycle": "base-admin-r11.json",
  "open43-settings-page-tags": "base-admin-r11.json",
  "open43-settings-theme": "base-admin-r11.json",
  "open43-settings-toolbar": "base-admin-r11.json",
  "open43-simpletodo-read-only": "general-r11.json",
});

function validateCaseSetPrivateInputMap(privateFiles) {
  const executionNames = Object.entries(CANDIDATE_CASE_SETS)
    .filter(([, registered]) => registered.aliasOf === undefined)
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right, "en"));
  const mappedNames = Object.keys(COMPATIBILITY_CASE_SET_PRIVATE_INPUTS)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(mappedNames) !== JSON.stringify(executionNames)) {
    throw new Error("candidate private-input mapping does not exactly cover the execution case-set registry");
  }
  const available = new Set(privateFiles);
  for (const [caseSet, filename] of Object.entries(COMPATIBILITY_CASE_SET_PRIVATE_INPUTS)) {
    if (!available.has(filename)) {
      throw new Error(`candidate private-input mapping for ${caseSet} references an unproduced file: ${filename}`);
    }
  }
  return COMPATIBILITY_CASE_SET_PRIVATE_INPUTS;
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const S758_AUTONUMBER_CANDIDATE_PRECONDITION = Object.freeze({
  schema: "wikijump.open43.s758_autonumber_candidate_precondition.v1",
  site_slug: SITE_SLUG,
  category_role: "transition_category",
  enabled: false,
  next: 1,
  cleanup_owner: "disposable_candidate_stack",
});

export function validateS758AutonumberCandidateCategory(category) {
  if (
    !Number.isSafeInteger(category?.category_id) ||
    typeof category.slug !== "string" ||
    category.slug.length === 0 ||
    typeof category.autonumber_enabled !== "boolean" ||
    !Number.isSafeInteger(category.autonumber_next) ||
    !Number.isSafeInteger(category.settings_revision)
  ) {
    throw new Error("S758 candidate autonumber category is incomplete");
  }
  if (category.autonumber_enabled !== S758_AUTONUMBER_CANDIDATE_PRECONDITION.enabled || category.autonumber_next !== S758_AUTONUMBER_CANDIDATE_PRECONDITION.next) {
    throw new Error("S758 candidate autonumber category is not at its fresh disabled precondition");
  }
  return Object.freeze({
    category_id: category.category_id,
    slug: category.slug,
    autonumber_enabled: category.autonumber_enabled,
    autonumber_next: category.autonumber_next,
    settings_revision: category.settings_revision,
  });
}

export function bindS758AutonumberFixture(input, category) {
  if (!input?.fixture || !input.fixture.transition_category) return false;
  const precondition = validateS758AutonumberCandidateCategory(category);
  input.fixture.autonumber_category = {
    ...input.fixture.transition_category,
    category_id: precondition.category_id,
    slug: precondition.slug,
    autonumber_enabled: precondition.autonumber_enabled,
    autonumber_next: precondition.autonumber_next,
    settings_revision: precondition.settings_revision,
  };
  return true;
}

export function compatibilityMarkerFixtures(value) {
  if (value?.schema !== "wikijump.ftml_marker_contract_fixtures.v1" || value.site_slug !== "scp-wiki" || value.layout !== "wikidot") {
    throw new Error("FTML marker candidate fixture index is invalid");
  }
  if (!Array.isArray(value.fixtures) || value.fixtures.length !== 5) throw new Error("FTML marker candidate fixture denominator drifted");
  const slugs = new Set();
  for (const fixture of value.fixtures) {
    if (typeof fixture?.fixture_id !== "string" || typeof fixture.slug !== "string" || typeof fixture.title !== "string" || typeof fixture.wikitext !== "string" || fixture.wikitext === "" || slugs.has(fixture.slug)) {
      throw new Error("FTML marker candidate fixture is incomplete or duplicated");
    }
    slugs.add(fixture.slug);
  }
  return value.fixtures;
}

export async function b689Scp8980CandidateFixtures() {
  const source = await fs.readFile(B689_SCP8980_SOURCE.path, "utf8");
  if (sha256(source) !== B689_SCP8980_SOURCE.sha256) {
    throw new Error("B689 SCP-8980 source drifted from the frozen imported-source authority");
  }
  const themeWikitext = await fs.readFile(B689_THEME_BASALT_SOURCE.path, "utf8");
  if (sha256(themeWikitext) !== B689_THEME_BASALT_SOURCE.sha256) {
    throw new Error("B689 theme:basalt source drifted from the source-owned seeder authority");
  }
  const fragments = [];
  for (const fixture of B689_SCP8980_FRAGMENTS) {
    const wikitext = await fs.readFile(fixture.path, "utf8");
    if (wikitext === "") throw new Error(`B689 SCP-8980 fragment is empty: ${fixture.slug}`);
    fragments.push({ slug: fixture.slug, title: fixture.title, rating: fixture.rating, tags: [...fixture.tags], wikitext });
  }
  return {
    theme: { slug: B689_THEME_BASALT_SOURCE.slug, title: B689_THEME_BASALT_SOURCE.title, tags: [...B689_THEME_BASALT_SOURCE.tags], wikitext: themeWikitext, sha256: B689_THEME_BASALT_SOURCE.sha256 },
    source: { slug: B689_SCP8980_SOURCE.slug, title: B689_SCP8980_SOURCE.title, tags: [...B689_SCP8980_SOURCE.tags], wikitext: source, sha256: B689_SCP8980_SOURCE.sha256 },
    fragments,
  };
}

export async function b689BasaltUserFixtures() {
  const fixture = JSON.parse(await fs.readFile(B689_THEME_BASALT_USERS, "utf8"));
  if (
    fixture?.schema !== "wikijump_syntax_differential.runtime_state_fixture.v1" ||
    !Array.isArray(fixture.wikidot_users) ||
    fixture.wikidot_users.length !== 3
  ) {
    throw new Error("B689 Basalt user runtime-state fixture is invalid");
  }
  const users = fixture.wikidot_users.map((user) => ({
    user_id: user.user_id,
    name: user.name,
    slug: user.slug,
    captured_at: user.provenance?.captured_at,
  }));
  const expected = [
    { user_id: 3_781_861, name: "EstrellaYoshte", slug: "estrellayoshte" },
    { user_id: 6_254_643, name: "Liryn", slug: "liryn" },
    { user_id: 6_536_693, name: "Placeholder McD", slug: "placeholder-mcd" },
  ];
  if (
    users.some(
      (user, index) =>
        user.user_id !== expected[index].user_id ||
        user.name !== expected[index].name ||
        user.slug !== expected[index].slug ||
        !Number.isFinite(Date.parse(user.captured_at)),
    )
  ) {
    throw new Error("B689 Basalt user runtime-state fixture drifted from retained live evidence");
  }
  return users;
}

export async function b689Scp8980UserFixtures() {
  const fixture = JSON.parse(await fs.readFile(B689_SCP8980_USERS, "utf8"));
  if (
    fixture?.schema !== "wikijump_syntax_differential.runtime_state_fixture.v1" ||
    !Array.isArray(fixture.wikidot_users) ||
    fixture.wikidot_users.length !== 1
  ) {
    throw new Error("B689 SCP-8980 user runtime-state fixture is invalid");
  }
  const users = fixture.wikidot_users.map((user) => ({
    user_id: user.user_id,
    name: user.name,
    slug: user.slug,
    captured_at: user.provenance?.captured_at,
  }));
  if (
    users[0].user_id !== 2_199_269 ||
    users[0].name !== "Yossipossi" ||
    users[0].slug !== "yossipossi" ||
    !Number.isFinite(Date.parse(users[0].captured_at))
  ) {
    throw new Error("B689 SCP-8980 user runtime-state fixture drifted from retained live evidence");
  }
  return users;
}

function usage() {
  return "Usage: prepare-compatibility-candidate-inputs.mjs --candidate-identity FILE --private-runtime FILE --template-private-dir DIR --output-private-dir DIR --receipt FILE --b690-attachments-dir DIR";
}

export function parseCompatibilityCandidateInputArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const names = new Set(["candidate-identity", "private-runtime", "template-private-dir", "output-private-dir", "receipt", "b690-attachments-dir"]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const name = flag?.startsWith("--") ? flag.slice(2) : "";
    if (!names.has(name) || Object.hasOwn(result, name) || !value || value.startsWith("--")) throw new Error(usage());
    result[name] = path.resolve(value);
  }
  for (const name of names) if (!result[name]) throw new Error(usage());
  if (result["template-private-dir"] === result["output-private-dir"]) throw new Error("template and output private directories must differ");
  return result;
}

function putPresignedBytes(presignUrl, bytes, filesIp) {
  const url = new URL(presignUrl);
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request({
      method: "PUT",
      hostname: filesIp,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      path: `${url.pathname}${url.search}`,
      headers: { "content-length": bytes.byteLength, host: url.host },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end(bytes);
  });
}

async function materializeCanaryAttachments({ args, attachments, database, filesIp, standardSiteId, rpc }) {
  const sourceDir = args["b690-attachments-dir"];
  const materialized = [];
  for (const attachment of attachments) {
    const page = await rpc("page_get", { site_id: standardSiteId, page: attachment.page, details: { wikitext: false, compiled: false } }, { siteId: standardSiteId });
    if (!page) throw new Error(`B690 attachment page is missing: ${attachment.page}`);
    const sourcePath = path.join(sourceDir, attachment.filename);
    const bytes = await fs.readFile(sourcePath);
    const existing = sql(database, `select file_id from file where page_id=${page.page_id} and name=${sqlLiteral(attachment.filename)} limit 1;`);
    if (existing !== "") throw new Error(`B690 attachment already exists: ${attachment.page}/${attachment.filename}`);
    const pending = await rpc("blob_upload", { user_id: -1, blob_size: bytes.byteLength, scope: "page" }, { siteId: standardSiteId, pageRef: page.page_id });
    try {
      const status = await putPresignedBytes(pending.presign_url, bytes, filesIp);
      if (status < 200 || status >= 300) throw new Error(`B690 attachment PUT failed: ${attachment.filename}: ${status}`);
      await rpc("file_create", { site_id: standardSiteId, page_id: page.page_id, name: attachment.filename, uploaded_blob_id: pending.pending_blob_id, revision_comments: "compatibility candidate B690 canary fixture", user_id: -1, bypass_filter: true, ip_address: "127.0.0.1" }, { siteId: standardSiteId, pageRef: page.page_id });
    } catch (error) {
      await rpc("blob_cancel", { user_id: -1, pending_blob_id: pending.pending_blob_id }, { siteId: standardSiteId, pageRef: page.page_id }).catch(() => {});
      throw error;
    }
    materialized.push({ page: attachment.page, filename: attachment.filename, size: bytes.byteLength, sha256: sha256(bytes) });
  }
  for (const slug of new Set(attachments.map(({ page }) => page))) {
    const page = await rpc("page_get", { site_id: standardSiteId, page: slug, details: { wikitext: false, compiled: false } }, { siteId: standardSiteId });
    await rpc("page_rerender", { site_id: standardSiteId, category_id: page.page_category_id, page_id: page.page_id }, { siteId: standardSiteId });
  }
  return materialized;
}

function dockerInspect(name) {
  return JSON.parse(execFileSync("docker", ["inspect", name], { encoding: "utf8" }))[0];
}

function containerIp(name) {
  const networks = Object.values(dockerInspect(name).NetworkSettings.Networks ?? {});
  if (networks.length !== 1 || !networks[0].IPAddress) throw new Error(`candidate container ${name} has no exact network address`);
  return networks[0].IPAddress;
}

function sql(container, statement, { capture = true } = {}) {
  return execFileSync("docker", ["exec", "-i", container, "sh", "-lc", "PGPASSWORD=\"$POSTGRES_PASSWORD\" psql -h 127.0.0.1 -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -v ON_ERROR_STOP=1 -At"], {
    input: statement,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["pipe", "pipe", "inherit"] : ["pipe", "ignore", "inherit"],
  }).trim();
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildQ1026InsertOnlyUserSeedSql(users = Object.values(Q1026_USER_FIXTURES)) {
  if (!Array.isArray(users) || users.length !== Object.keys(Q1026_USER_FIXTURES).length) throw new Error("Q1026 user seed denominator changed");
  const ids = new Set();
  for (const user of users) {
    if (!user || !Number.isSafeInteger(user.user_id) || ids.has(user.user_id) || typeof user.name !== "string" || !user.name || typeof user.slug !== "string" || !user.slug || typeof user.is_deleted !== "boolean") throw new Error("Q1026 user seed identity is invalid");
    ids.add(user.user_id);
  }
  const knownRows = users.map(({ user_id }) => `(${user_id})`).join(",");
  const wikidotRows = users.map(({ user_id, name, slug, is_deleted }) => `(${user_id},now()-interval '1 second',now(),${is_deleted ? "true" : "false"},${sqlLiteral(name)},${sqlLiteral(slug)},0,false)`).join(",");
  return `begin; insert into known_user(user_id) values ${knownRows} on conflict do nothing; insert into wikidot_user(user_id,created_at,fetched_at,is_deleted,name,slug,karma,is_pro) values ${wikidotRows}; select setval('known_user_user_id_seq',(select max(user_id) from known_user),true); commit;`;
}

async function copyPrivateTemplates(templateRoot, outputRoot, bindings) {
  await fs.mkdir(outputRoot, { recursive: false, mode: 0o700 });
  const files = (await fs.readdir(templateRoot))
    .filter((name) => name.endsWith(".json") && !GENERATED_PRIVATE_INPUTS.has(name))
    .sort();
  if (files.length === 0) throw new Error("template private directory contains no JSON inputs");
  for (const name of files) {
    const input = JSON.parse(await fs.readFile(path.join(templateRoot, name), "utf8"));
    Object.assign(input, bindings.public);
    if (input.cargo_env) Object.assign(input.cargo_env, bindings.cargo);
    if (input.runtime_bindings) input.runtime_bindings = bindings.runtime;
    await fs.writeFile(path.join(outputRoot, name), `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
  await fs.writeFile(path.join(outputRoot, "tls-ca.pem"), bindings.public.tls_ca_pem, { mode: 0o600, flag: "wx" });
  return files;
}

function actorDefinition(template, name) {
  const actor = template.actors?.[name];
  if (!actor || actor.user_id !== ACTOR_IDS[name] || typeof actor.password !== "string" || typeof actor.name !== "string" || typeof actor.slug !== "string") {
    throw new Error(`template actor ${name} is incomplete`);
  }
  return actor;
}

export async function prepareCompatibilityCandidateInputs(args) {
  const [identity, runtime, identitySha256] = await Promise.all([
    readJsonObject(args["candidate-identity"], "editable candidate identity"),
    readJsonObject(args["private-runtime"], "candidate private runtime"),
    sha256File(args["candidate-identity"]),
  ]);
  const candidate = identity.candidate;
  if (candidate?.endpoint?.host !== `${SITE_SLUG}.wikijump.localhost` || candidate.endpoint.port === 443 || candidate.port_443_published !== false) throw new Error("producer requires the exact non-standing editable compatibility candidate");
  const project = candidate.compose_project;
  if (typeof project !== "string" || !project.startsWith("wikijump-compat-")) throw new Error("candidate compose project is outside compatibility ownership");
  if (runtime.editable_candidate_identity_sha256 !== identitySha256) throw new Error("private runtime is not bound to the editable candidate identity");

  const database = `${project}-database-1`;
  const cache = `${project}-cache-1`;
  const files = `${project}-files-1`;
  const caddy = `${project}-caddy-1`;
  for (const name of [database, cache, files, caddy]) if (dockerInspect(name).State?.Running !== true) throw new Error(`candidate container is not running: ${name}`);
  const caPath = path.join(path.dirname(args.receipt), `.candidate-ca-${process.pid}.pem`);
  try {
    execFileSync("docker", ["cp", `${caddy}:/data/caddy/pki/authorities/local/root.crt`, caPath], { stdio: "ignore" });
    const tlsCa = await fs.readFile(caPath, "utf8");
    const standardIdentityPath = path.join(path.dirname(args["candidate-identity"]), "candidate-identity.json");
    const standardIdentitySha256 = await sha256File(standardIdentityPath);
    const dbIp = containerIp(database);
    const cacheIp = containerIp(cache);
    const filesIp = containerIp(files);
    const bindings = {
      public: {
        candidate_identity_sha256: standardIdentitySha256,
        editable_candidate_identity_sha256: identitySha256,
        candidate_origin: candidate.site_origins[SITE_SLUG].page,
        deepwell_rpc_url: runtime.deepwell_rpc_url,
        deepwell_rpc_token: runtime.deepwell_rpc_token,
        object_store_origin: runtime.object_store_origin,
        presigned_origin: runtime.presigned_origin,
        tls_ca_pem: tlsCa,
      },
      cargo: {
        DATABASE_URL: `postgres://wikijump:wikijump@${dbIp}:5432/wikijump`,
        REDIS_URL: `redis://${cacheIp}:6379`,
        DEEPWELL_RPC_TOKEN: runtime.deepwell_rpc_token,
        S3_CUSTOM_ENDPOINT: `http://${filesIp}:9000`,
      },
      runtime: [
        { role: "caddy", container_port: "443/tcp", host_address: candidate.endpoint.local_connect_address, host_port: candidate.endpoint.port },
        { role: "deepwell", container_port: "2747/tcp", host_address: "127.0.0.1", host_port: Number(new URL(runtime.deepwell_rpc_url).port) },
        { role: "files", container_port: "9000/tcp", host_address: "127.0.0.1", host_port: Number(new URL(runtime.object_store_origin).port) },
      ],
    };
    const privateFiles = await copyPrivateTemplates(args["template-private-dir"], args["output-private-dir"], bindings);
    const b690Path = path.join(args["output-private-dir"], "b690-r11.json");
    const b690 = JSON.parse(await fs.readFile(b690Path, "utf8"));
    b690.fixture = OPEN43_B690_GEOMETRY_FIXTURE;
    await fs.writeFile(b690Path, `${JSON.stringify(b690, null, 2)}\n`, { mode: 0o600 });
    const generalPath = path.join(args["output-private-dir"], "general-r11.json");
    const general = JSON.parse(await fs.readFile(generalPath, "utf8"));

    const staffToken = `wj:${randomBytes(48).toString("base64url")}`;
    sql(database, `insert into session(session_token,user_id,created_at,expires_at,ip_address,user_agent,restricted,mfa_failed_attempts) values ($x$${staffToken}$x$,-1,now(),now()+interval '24 hours','127.0.0.1','compatibility input producer',false,0);`);
    let rpcId = 0;
    const rpc = async (method, params, { token = staffToken, siteId = null, pageRef = null } = {}) => {
      const response = await fetch(runtime.deepwell_rpc_url, { method: "POST", headers: { authorization: `Bearer ${runtime.deepwell_rpc_token}`, "content-type": "application/json", ...(token ? { "x-deepwell-session-token": token } : {}), ...(siteId === null ? {} : { "x-deepwell-site-id": String(siteId) }), ...(pageRef === null ? {} : { "x-deepwell-page": String(pageRef) }) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
      const payload = JSON.parse(await response.text());
      if (!response.ok || payload.error) throw new Error(`${method}: ${payload.error?.message ?? response.status}`);
      return payload.result ?? null;
    };
    for (const user of [...await b689BasaltUserFixtures(), ...await b689Scp8980UserFixtures()]) {
      const existing = await rpc("user_get", { user: user.user_id });
      if (existing === null) {
        const imported = await rpc("import_wikidot_user", {
          user_id: user.user_id,
          created_at: new Date(Date.parse(user.captured_at) - 1).toISOString(),
          fetched_at: user.captured_at,
          user_type: "extant",
          name: user.name,
          slug: user.slug,
          avatar_uploaded_blob_id: null,
          real_name: null,
          gender: null,
          birthday: null,
          location: null,
          biography: null,
          website: null,
          karma: 0,
          is_pro: false,
          importing_user_id: -1,
          ip_address: "127.0.0.1",
        });
        if (imported?.user_id !== user.user_id) {
          throw new Error(`B689 Wikidot user import failed: ${user.user_id}`);
        }
      } else if (existing.name !== user.name || existing.slug !== user.slug) {
        throw new Error(`B689 Wikidot user identity collision: ${user.user_id}`);
      }
    }
    for (const name of Object.keys(ACTOR_IDS)) {
      const actor = actorDefinition(general, name);
      const existing = await rpc("user_get", { user: actor.user_id });
      if (existing === null) {
        await rpc("user_create", { user_type: "regular", name: actor.name, email: `${actor.slug}@candidate.invalid`, locales: ["en-US", "en"], password: actor.password, bypass_filter: true, bypass_email_verification: true, override_user_id: actor.user_id, ip_address: "127.0.0.1" });
      } else if (existing.name !== actor.name || existing.slug !== actor.slug) throw new Error(`candidate actor identity collision for ${name}`);
    }
    const tokens = Object.fromEntries(Object.entries(ACTOR_IDS).map(([name, userId]) => [name, { userId, token: `wj:${randomBytes(48).toString("base64url")}` }]));
    const expiredToken = `wj:${randomBytes(48).toString("base64url")}`;
    const sessionRows = Object.values(tokens).map(({ userId, token }) => `($x$${token}$x$,${userId},now(),now()+interval '24 hours','127.0.0.1','compatibility input producer',false,0)`).join(",");
    sql(database, `insert into session(session_token,user_id,created_at,expires_at,ip_address,user_agent,restricted,mfa_failed_attempts) values ${sessionRows}; insert into session(session_token,user_id,created_at,expires_at,ip_address,user_agent,restricted,mfa_failed_attempts) values ($x$${expiredToken}$x$,${ACTOR_IDS.editor},now()-interval '2 hours',now()-interval '1 hour','127.0.0.1','compatibility expired actor',false,0); insert into user_role(user_id,role_id,site_id,assigned_at,assigned_by) select ${ACTOR_IDS.editor},role_id,site_id,now(),-1 from user_role where user_id=-1 and site_id=${SITE_ID} on conflict do nothing; update site set locale='en',favicon_source='https://scp-wiki.wdfiles.com/local--files/site/favicon.gif' where site_id=${SITE_ID};`);
    sql(database, `insert into relation(relation_type,dest_type,dest_id,from_type,from_id,metadata,created_by) values ('application','site',${SITE_ID},'user',${ACTOR_IDS.pending},'{"status":"pending","comment":"compatibility candidate pending actor","reply":null}'::jsonb,${ACTOR_IDS.pending}),('ban','site',${SITE_ID},'user',${ACTOR_IDS.banned},'{"banned_until":null,"reason":"compatibility candidate actor matrix"}'::jsonb,-1) on conflict do nothing; update relation set metadata='{"status":"pending","comment":"compatibility candidate pending actor","reply":null}'::jsonb where relation_type='application' and dest_type='site' and dest_id=${SITE_ID} and from_type='user' and from_id=${ACTOR_IDS.pending} and created_by=${ACTOR_IDS.pending} and overwritten_at is null and deleted_at is null;`);
    general.actors.administrator = { user_id: -1, session_token: staffToken };
    for (const name of Object.keys(ACTOR_IDS)) general.actors[name].session_token = tokens[name].token;
    general.actors.non_admin = { user_id: ACTOR_IDS.other, session_token: tokens.other.token };
    general.actors.expired = { user_id: ACTOR_IDS.editor, session_token: expiredToken };
    const propagateActors = async () => {
      for (const name of privateFiles) {
        if (name === "media-files.json") continue;
        const target = path.join(args["output-private-dir"], name);
        const value = JSON.parse(await fs.readFile(target, "utf8"));
        if (!value.actors) continue;
        for (const [actorName, actor] of Object.entries(value.actors)) {
          const source = general.actors[actorName];
          if (source) Object.assign(actor, source);
        }
        await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      }
    };
    await propagateActors();

    const page = async (slug, title, wikitext, { siteId = SITE_ID, imported = false, tags = [], rating = 0, allowExisting = false } = {}) => {
      if (!Number.isSafeInteger(rating)) throw new Error(`candidate fixture rating is not an integer: ${slug}`);
      const prior = await rpc("page_get", { site_id: siteId, page: slug, details: { wikitext: true, compiled: false } }, { siteId });
      if (prior !== null) {
        if (!allowExisting || ![-1, -2].includes(prior.revision_user_id)) throw new Error(`candidate fixture already exists: ${siteId}:${slug}`);
        if (imported) {
          sql(database, `update page set from_wikidot=true where page_id=${prior.page_id}; update page_revision set from_wikidot=true where revision_id=${prior.revision_id};`);
          if (tags.length > 0) sql(database, `update page_revision set tags=ARRAY[${tags.map(sqlLiteral).join(",")}]::text[] where revision_id=${prior.revision_id};`);
          sql(database, `update wikidot_page_snapshot set imported_rating=${rating} where page_id=${prior.page_id};`);
        }
        return prior;
      }
      await rpc("page_create", { site_id: siteId, slug, title, alt_title: null, wikitext, layout: "wikidot", user_id: -1, ip_address: "127.0.0.1", tags, revision_comments: "compatibility candidate fixture" }, { siteId });
      const created = await rpc("page_get", { site_id: siteId, page: slug, details: { wikitext: true, compiled: false } }, { siteId });
      if (!created || created.wikitext !== wikitext) throw new Error(`candidate fixture readback failed: ${slug}`);
      if (imported) {
        const slugLiteral = sqlLiteral(slug);
        const textLiteral = sqlLiteral(wikitext);
        sql(database, `update page set from_wikidot=true where page_id=${created.page_id}; update page_revision set from_wikidot=true where revision_id=${created.revision_id}; insert into wikidot_corpus_import_run(site_id,source_branch,source_site,manifest_sha256,manifest_row_count,complete_inventory,state,finished_at,summary) select ${created.site_id},'master',(select slug from site where site_id=${created.site_id}),decode(md5('B689 candidate graph '||${created.site_id})||md5('B689 candidate graph '||${created.site_id}),'hex'),0,true,'done',now(),'{}'::jsonb where not exists (select 1 from wikidot_corpus_import_run where site_id=${created.site_id} and source_branch='master' and source_site=(select slug from site where site_id=${created.site_id})); insert into wikidot_page_snapshot(page_id,source_branch,source_site,source_entity_id,source_fullname,source_created_at,source_updated_at,source_revision_count,imported_rating,created_by_name,updated_by_name,title_shown,parent_fullname,comments,source_sha256,meta_sha256,meta_json,last_import_run_id) values(${created.page_id},'master',(select slug from site where site_id=${created.site_id}),(substr(md5((select slug from site where site_id=${created.site_id})||':'||${slugLiteral}),1,8)||'-'||substr(md5((select slug from site where site_id=${created.site_id})||':'||${slugLiteral}),9,4)||'-'||substr(md5((select slug from site where site_id=${created.site_id})||':'||${slugLiteral}),13,4)||'-'||substr(md5((select slug from site where site_id=${created.site_id})||':'||${slugLiteral}),17,4)||'-'||substr(md5((select slug from site where site_id=${created.site_id})||':'||${slugLiteral}),21,12))::uuid,${slugLiteral},now(),now(),1,${rating},null,null,${sqlLiteral(title)},null,0,decode(md5(${textLiteral})||md5(${textLiteral}),'hex'),decode(md5('{}')||md5('{}'),'hex'),'{}'::jsonb,(select max(import_run_id) from wikidot_corpus_import_run where site_id=${created.site_id}));`);
      }
      return created;
    };
    const edit = async (pageValue, wikitext, comments) => await leasedPageEdit(
      (method, params) => rpc(method, params, { token: tokens.editor.token, siteId: SITE_ID }),
      { site_id: SITE_ID, page: pageValue.page_id, last_revision_id: pageValue.revision_id, revision_comments: comments, user_id: ACTOR_IDS.editor, wikitext, ip_address: "127.0.0.1" },
    );

    const defaultPage = await rpc("page_get", { site_id: SITE_ID, page: "boundary-check", details: { wikitext: false, compiled: false } }, { siteId: SITE_ID });
    const transitionPage = await rpc("page_get", { site_id: SITE_ID, page: "corpus:scp-9506-draft", details: { wikitext: false, compiled: false } }, { siteId: SITE_ID });
    if (!defaultPage || !transitionPage) throw new Error("fresh candidate is missing the maintained base page fixtures");
    const transitionCategory = await rpc("category_get", { site: SITE_ID, category: transitionPage.page_category_id }, { siteId: SITE_ID });
    const s758Category = validateS758AutonumberCandidateCategory(transitionCategory);

    const markerFixtureIndex = JSON.parse(await fs.readFile(FTML_MARKER_FIXTURE_INDEX, "utf8"));
    const markerFixtures = compatibilityMarkerFixtures(markerFixtureIndex);
    const markerPages = [];
    for (const fixture of markerFixtures) {
      markerPages.push(await page(fixture.slug, fixture.title, fixture.wikitext, { siteId: FOREIGN_SITE_ID }));
    }

    const b689Fixtures = await b689Scp8980CandidateFixtures();
    const standardSite = await rpc("site_get", { site: STANDARD_SITE_SLUG });
    if (!Number.isSafeInteger(standardSite?.site_id)) {
      throw new Error("fresh candidate is missing the maintained scp-wiki site");
    }
    const standardSiteId = standardSite.site_id;
    const b610Page = await rpc("page_get", { site_id: standardSiteId, page: "scp-9506", details: { wikitext: false, compiled: false } }, { siteId: standardSiteId });
    if (!b610Page) throw new Error("fresh candidate is missing the maintained SCP-9506 shell fixture");
    await page(Q807_SEARCH_ALL_SOURCE.slug, Q807_SEARCH_ALL_SOURCE.title, Q807_SEARCH_ALL_SOURCE.wikitext, { imported: true });
    sql(database, `update site set from_wikidot=true,favicon_source='https://scp-wiki.wdfiles.com/local--files/site/favicon.gif' where site_id=${standardSiteId}; update page set from_wikidot=true where page_id=${b610Page.page_id}; update page_revision set from_wikidot=true where revision_id=${b610Page.revision_id};`);
    sql(database, `insert into wikidot_corpus_import_run(site_id,source_branch,source_site,manifest_sha256,manifest_row_count,complete_inventory,state,finished_at,summary) values(${standardSiteId},'master','scp-wiki',decode(md5('B689 candidate graph')||md5('B689 candidate graph'),'hex'),0,true,'done',now(),'{}'::jsonb);`);
    for (const dependency of B689_NAVIGATION_DEPENDENCIES) {
      const wikitext = await fs.readFile(dependency.path, "utf8");
      if (sha256(wikitext) !== dependency.sha256) throw new Error(`B689 navigation dependency drifted: ${dependency.slug}`);
      const tags = dependency.tags ?? JSON.parse(await fs.readFile(path.join(path.dirname(dependency.path), "meta.json"), "utf8")).tags;
      const importedTags = B689_PRESERVED_DEPENDENCIES.has(dependency.slug) ? [] : tags;
      await page(dependency.slug, dependency.title, wikitext, { siteId: standardSiteId, imported: true, tags: importedTags, rating: dependency.rating, allowExisting: true });
    }
    for (const dependency of [...B689_NAVIGATION_DEPENDENCIES].reverse()) {
      if (dependency.slug.startsWith("theme:") || B689_PRESERVED_DEPENDENCIES.has(dependency.slug)) continue;
      const pageValue = await rpc("page_get", { site_id: standardSiteId, page: dependency.slug, details: { wikitext: false, compiled: false } }, { siteId: standardSiteId });
      if (pageValue) await rpc("page_rerender", { site_id: standardSiteId, category_id: pageValue.page_category_id, page_id: pageValue.page_id }, { siteId: standardSiteId });
    }
    for (const slug of ["scp-744", "scp-2117", "scp-5516"]) {
      const canary = await rpc("page_get", { site_id: standardSiteId, page: slug, details: { wikitext: false, compiled: false } }, { siteId: standardSiteId });
      if (canary) await rpc("page_rerender", { site_id: standardSiteId, category_id: canary.page_category_id, page_id: canary.page_id }, { siteId: standardSiteId });
    }
    const scp2117 = await rpc("page_get", { site_id: standardSiteId, page: "scp-2117", details: { wikitext: false, compiled: false } }, { siteId: standardSiteId });
    if (!scp2117) throw new Error("B690 navigation dependency is missing: scp-2117");
    for (const dependency of B690_SCP2117_DEPENDENCIES) {
      const wikitext = await fs.readFile(dependency.path, "utf8");
      if (sha256(wikitext) !== dependency.sha256) throw new Error(`B690 navigation dependency drifted: ${dependency.slug}`);
      const candidateWikitext = wikitext.replace("[[include :topia:pride-animated-source]]", "");
      await page(dependency.slug, dependency.title, candidateWikitext, { siteId: standardSiteId, imported: true, tags: dependency.tags });
    }
    for (const dependency of B690_SCP2117_FRAGMENTS) {
      const wikitext = await fs.readFile(dependency.path, "utf8");
      if (sha256(wikitext) !== dependency.sha256) throw new Error(`B690 navigation dependency drifted: ${dependency.slug}`);
      const fragment = await page(dependency.slug, dependency.title, wikitext, { siteId: standardSiteId, imported: true, tags: dependency.tags });
      await rpc("parent_set", { site_id: standardSiteId, parent: scp2117.slug, child: fragment.slug }, { siteId: standardSiteId });
    }
    await rpc("page_rerender", { site_id: standardSiteId, category_id: scp2117.page_category_id, page_id: scp2117.page_id }, { siteId: standardSiteId });
    const b690Attachments = await materializeCanaryAttachments({ args, attachments: B690_CANARY_ATTACHMENTS, database, filesIp, standardSiteId, rpc });
    const b610Attachments = await materializeCanaryAttachments({ args, attachments: B610_CANARY_ATTACHMENTS, database, filesIp, standardSiteId, rpc });
    const basalt = await rpc("page_get", {
      site_id: standardSiteId,
      page: b689Fixtures.theme.slug,
      details: { wikitext: true, compiled: false },
    }, { siteId: standardSiteId });
    if (!basalt || basalt.wikitext !== b689Fixtures.theme.wikitext) {
      throw new Error("maintained scp-wiki theme:basalt seed drifted from B689 authority");
    }
    const b689Root = await page(
      b689Fixtures.source.slug,
      b689Fixtures.source.title,
      b689Fixtures.source.wikitext,
      { siteId: standardSiteId, imported: true, tags: b689Fixtures.source.tags, rating: b689Fixtures.source.rating },
    );
    await rpc(
      "parent_set",
      { site_id: standardSiteId, parent: "scp-anthology-2024", child: b689Root.slug },
      { siteId: standardSiteId },
    );
    sql(database, `update wikidot_page_snapshot set parent_fullname='scp-anthology-2024' where page_id=${b689Root.page_id};`);
    for (const fixture of b689Fixtures.fragments) {
      const fragment = await page(
        fixture.slug,
        fixture.title,
        fixture.wikitext,
        { siteId: standardSiteId, imported: true, tags: fixture.tags, rating: fixture.rating },
      );
      await rpc(
        "parent_set",
        { site_id: standardSiteId, parent: b689Root.slug, child: fragment.slug },
        { siteId: standardSiteId },
      );
    }
    await rpc(
      "page_rerender",
      { site_id: standardSiteId, category_id: basalt.page_category_id, page_id: basalt.page_id },
      { siteId: standardSiteId },
    );
    await rpc(
      "page_rerender",
      { site_id: standardSiteId, category_id: b689Root.page_category_id, page_id: b689Root.page_id },
      { siteId: standardSiteId },
    );

    for (const name of privateFiles) {
      const target = path.join(args["output-private-dir"], name);
      const value = JSON.parse(await fs.readFile(target, "utf8"));
      if (value.fixture?.default_category) Object.assign(value.fixture.default_category, { category_id: defaultPage.page_category_id, page_id: defaultPage.page_id, page_slug: defaultPage.slug });
      if (value.fixture?.transition_category) Object.assign(value.fixture.transition_category, { category_id: transitionPage.page_category_id, page_id: transitionPage.page_id, page_slug: transitionPage.slug });
      if (name === "open43-settings-candidate.json") bindS758AutonumberFixture(value, s758Category);
      await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    }

    const redirectTarget = await page("a1037-imported-redirect-target", "A1037 Imported Redirect Target", "A1037_REDIRECT_TARGET_FIXTURE", { imported: true });
    const redirectSourceText = '[[module Redirect destination="a1037-imported-redirect-target"]]';
    const redirectSource = await page("a1037-imported-redirect-fixture", "A1037 Imported Redirect Fixture", redirectSourceText, { imported: true });
    general.a1037_redirect_fixture = { source_page: { page_id: redirectSource.page_id, revision_id: redirectSource.revision_id, slug: redirectSource.slug, source_sha256: sha256(redirectSourceText) }, target_page: { page_id: redirectTarget.page_id, revision_id: redirectTarget.revision_id, slug: redirectTarget.slug } };

    const members = await page("members-directory", "Members Directory", OPEN43_Q1032_SAVED_DIRECTORY_SOURCE);
    general.saved_page = { page_id: members.page_id, revision_id: members.revision_id, slug: members.slug };
    general.saved_page_source_sha256 = sha256(OPEN43_Q1032_SAVED_DIRECTORY_SOURCE);
    general.q1032_readonly_evidence = OPEN43_Q1032_EVIDENCE.readonly;
    sql(database, `insert into known_user(user_id) select generate_series(20000100,20000250) on conflict do nothing; insert into wikidot_user(user_id,created_at,fetched_at,is_deleted,name,slug,karma,is_pro) select id,now()-interval '1 second',now(),false,'Fixture Member '||id,'fixture-member-'||id,0,false from generate_series(20000100,20000250) id on conflict do nothing; insert into relation(relation_type,dest_type,dest_id,from_type,from_id,metadata,created_by) select 'member','site',${SITE_ID},'user',id,'{"accepted":{"cause":"accepted","user_id":-1}}'::jsonb,-1 from generate_series(20000100,20000250) id on conflict do nothing;`);

    const featuredSource = "FEATURED_START\n[[module FeaturedSite]]\nFEATURED_END";
    const featured = await page("q810-featuredsite-saved", "Q810 FeaturedSite Saved", featuredSource);
    const nestedSource = '[[module ListPages name="q810-featuredsite-saved" limit="1"]]\n%%content%%\n[[/module]]';
    const featuredNested = await page("q810-featuredsite-nested", "Q810 FeaturedSite Nested", nestedSource);
    general.featuredsite_fixture = { site: { site_id: SITE_ID, slug: SITE_SLUG }, saved_page: { page_id: featured.page_id, revision_id: featured.revision_id, slug: featured.slug, source_sha256: sha256(featuredSource) }, nested_page: { page_id: featuredNested.page_id, revision_id: featuredNested.revision_id, slug: featuredNested.slug, source_sha256: sha256(nestedSource) } };

    const forumMini = await page("q778-forum-mini", "Q778 Forum Mini", FORUM_MINI_SAVED_SOURCE);
    general.forum_mini_fixture = { site: { site_id: SITE_ID, slug: SITE_SLUG }, saved_page: { page_id: forumMini.page_id, revision_id: forumMini.revision_id, slug: forumMini.slug, source_sha256: sha256(FORUM_MINI_SAVED_SOURCE) }, forbidden_markers: ["Q778_HIDDEN_MARKER", "Q778_PRIVATE_MARKER"] };
    sql(database, `insert into known_user(user_id) values (${Q778_WIKIDOT_AUTHOR.user_id}) on conflict do nothing; insert into wikidot_user(user_id,created_at,fetched_at,is_deleted,name,slug,karma,is_pro) values (${Q778_WIKIDOT_AUTHOR.user_id},now()-interval '1 second',now(),false,'${Q778_WIKIDOT_AUTHOR.name}','${Q778_WIKIDOT_AUTHOR.slug}',0,false) on conflict (user_id) do update set is_deleted=false,name=excluded.name,slug=excluded.slug,fetched_at=excluded.fetched_at;`);

    const q1036 = await page("q1036-saved-boundary", "Q1036 saved boundary", Q1036_SAVED_SOURCE);
    Object.assign(general, { saved_page_id: q1036.page_id, saved_revision_id: q1036.revision_id, saved_page_slug: q1036.slug });

    const q1026UserIds = Object.values(Q1026_USER_FIXTURES).map(({ user_id }) => user_id).join(",");
    const q1026Existing = sql(database, `select user_id from wikidot_user where user_id in (${q1026UserIds}) order by user_id;`);
    if (q1026Existing !== "") throw new Error("Q1026 insert-only user seed found an existing same-ID identity");
    sql(database, buildQ1026InsertOnlyUserSeedSql());
    const q1026Source = buildQ1026UserIdentitySource(Q1026_USER_FIXTURES);
    const q1026Page = await page("fixture-wikidot-user-identity-matrix", "Q1026 identity matrix", q1026Source);
    const q1026Path = path.join(args["output-private-dir"], "q1026-r11.json");
    const q1026Input = JSON.parse(await fs.readFile(q1026Path, "utf8"));
    Object.assign(q1026Input.fixture, { site_id: SITE_ID, page: { page_id: q1026Page.page_id, revision_id: q1026Page.revision_id, slug: q1026Page.slug }, source_sha256: sha256(q1026Source), provenance: Q1026_FIXTURE_PROVENANCE, ...Q1026_USER_FIXTURES });
    await fs.writeFile(q1026Path, `${JSON.stringify(q1026Input, null, 2)}\n`, { mode: 0o600 });

    const q1034Pages = {};
    for (const [role, source] of Object.entries(Q1034_SAVED_SOURCES)) q1034Pages[role] = await page(`q1034-${role.replaceAll("_", "-")}`, `Q1034 ${role}`, source);

    const q809Source = '[[module RatedPages limit="1" minRating="1"]]';
    const q809Holder = await page("open43-q809-holder", "Q809 holder", q809Source);
    const q809Public = await page("publicq809:low", "Public low", "Q809 public rating target");
    const q809Private = await page("privateq809:high", "Private high", "Q809 private rating target");
    const privateCategory = q809Private.page_category_id;
    const publicCategory = q809Public.page_category_id;
    sql(database, `insert into role_permission(role_id,site_id,resource_type,resource_category_id,action) select role_id,${SITE_ID},'page',${privateCategory},'view' from role where site_id=${SITE_ID} and name in ('root','admin') on conflict do nothing; update page_category set rating_enabled=true,rating_permission='registered',rating_visibility='visible',rating_type='plus_minus' where category_id in (${privateCategory},${publicCategory}); insert into page_vote(page_id,user_id,value,rating_system) values (${q809Public.page_id},${ACTOR_IDS.eligible},1,'points'),(${q809Private.page_id},${ACTOR_IDS.eligible},1,'points'),(${q809Private.page_id},${ACTOR_IDS.registered},1,'points'),(${q809Private.page_id},${ACTOR_IDS.pending},1,'points') on conflict do nothing;`);
    general.fixture.view_restricted_categories = ["privateq809"];

    const backHolder = await page("qbacklinks-holder", "Q Backlinks Holder", "BACKLINKS_HOLDER\n[[module Backlinks]]");
    const backEmpty = await page("qbacklinks-empty", "Q Backlinks Empty", "BACKLINKS_EMPTY\n[[module Backlinks]]");
    const backVisibleA = await page("qbacklinks-visible-a", "AAA Backlinks Visible A", "[[[qbacklinks-holder]]]");
    const backVisibleB = await page("qbacklinks-visible-b", "AAB Backlinks Visible B", "[[[qbacklinks-holder]]]");
    const backHidden = await page("qbacklinks-hidden", "Hidden Backlinks Row", "[[[qbacklinks-holder]]]");
    const backPrivate = await page("privateq809:qbacklinks-private", "Private Backlinks Row", "[[[qbacklinks-holder]]]");
    const backDeleted = await page("qbacklinks-deleted", "Deleted Backlinks Row", "[[[qbacklinks-holder]]]");
    const backForeign = await page("qbacklinks-foreign", "Foreign Backlinks Page", "[[[qbacklinks-holder]]]", { siteId: FOREIGN_SITE_ID });
    sql(database, `update page_revision set hidden=array['title','slug'] where revision_id=${backHidden.revision_id};`);
    await rpc("page_delete", { site_id: SITE_ID, page: backDeleted.page_id, last_revision_id: backDeleted.revision_id, revision_comments: "backlinks deleted fixture", user_id: -1, ip_address: "127.0.0.1" }, { siteId: SITE_ID });

    sql(database, `insert into forum_group(forum_group_id,site_id,created_by,name,description,visible,sort_index,from_wikidot) values (9000100,${SITE_ID},-1,'Q1034 group','candidate fixture',true,0,false); insert into forum_category(forum_category_id,forum_group_id,site_id,created_by,name,description,sort_index,from_wikidot,max_nest_level,per_page_discussion) values (9000101,9000100,${SITE_ID},-1,'Q1034 primary','candidate fixture',0,false,10,true),(9000102,9000100,${SITE_ID},-1,'Q1034 pagination','candidate fixture',1,false,10,false); insert into role_permission(role_id,site_id,resource_type,resource_category_id,action) select role_id,${SITE_ID},'forum-category',category_id,'create' from role cross join (values(9000101),(9000102)) c(category_id) where site_id=${SITE_ID} and name in ('root','admin') on conflict do nothing; insert into forum_thread(forum_thread_id,forum_category_id,forum_group_id,site_id,page_id,created_by,created_at,title,description,sticky,from_wikidot) values (9100101,9000101,9000100,${SITE_ID},null,${ACTOR_IDS.editor},now()-interval '1 minute','visible-thread','Q1034 visible thread',false,false),(9100122,9000101,9000100,${SITE_ID},${q1034Pages.comments_forward.page_id},${ACTOR_IDS.editor},now(),'comments-forward-thread','Q1034 comments forward',false,false),(9100123,9000101,9000100,${SITE_ID},${q1034Pages.comments_reverse.page_id},${ACTOR_IDS.editor},now(),'comments-reverse-thread','Q1034 comments reverse',false,false),(9100124,9000101,9000100,${SITE_ID},${forumMini.page_id},${ACTOR_IDS.editor},now(),'q778-mini-posts','Q778 mini post fixture',false,false); insert into forum_thread(forum_thread_id,forum_category_id,forum_group_id,site_id,page_id,created_by,created_at,title,description,sticky,from_wikidot) select 9200000+g,9000102,9000100,${SITE_ID},null,${ACTOR_IDS.editor},now()-(g||' seconds')::interval,'pagination-'||lpad(g::text,3,'0'),'Q1034 pagination',false,false from generate_series(1,221) g; update page set discussion_thread_id=9100122 where page_id=${q1034Pages.comments_forward.page_id}; update page set discussion_thread_id=9100123 where page_id=${q1034Pages.comments_reverse.page_id}; select setval('forum_group_forum_group_id_seq',greatest((select max(forum_group_id) from forum_group),9000100),true); select setval('forum_category_forum_category_id_seq',greatest((select max(forum_category_id) from forum_category),9000102),true); select setval('forum_thread_forum_thread_id_seq',greatest((select max(forum_thread_id) from forum_thread),9200221),true);`);
    clearCandidateRedisCache(cache);
    const post = async (thread, title, wikitext) => await rpc("forum_post_create", { site_id: SITE_ID, forum_thread_id: thread, parent_post_id: null, title, wikitext, guest_name: null, guest_email_md5: null }, { token: tokens.editor.token, siteId: SITE_ID });
    for (let i = 0; i < 20; i++) await post(9100101, `Q1034 visible ${i}`, `Q1034_VISIBLE_${i}`);
    for (const thread of [9100122, 9100123]) for (let i = 0; i < 12; i++) await post(thread, `Q1034 comments ${i}`, `[[div class="q1034-fwd-${String(i).padStart(2, "0")}"]]F${i}[[/div]]\n[[div class="q1034-rev-${String(i).padStart(2, "0")}"]]R${i}[[/div]]`);
    for (let i = 0; i < 5; i++) await post(9100124, `Q778 mini post ${i}`, `Q778 recent post excerpt ${i}`);
    sql(database, `update forum_post set user_id=${Q778_WIKIDOT_AUTHOR.user_id} where site_id=${SITE_ID} and forum_thread_id=9100124; update forum_post_revision fpr set user_id=${Q778_WIKIDOT_AUTHOR.user_id} from forum_post fp where fpr.forum_post_id=fp.forum_post_id and fp.site_id=${SITE_ID} and fp.forum_thread_id=9100124;`);

    const q1035Site = await page("q1035-sitechanges-holder", "Q1035 Public Activity", Q1035_SAVED_SOURCES.sitechanges_holder);
    const q1035Draft = await page("q1035-listdrafts-holder", "Q1035 ListDrafts Holder", Q1035_SAVED_SOURCES.listdrafts_holder);
    const insertRevisions = (from, to) => sql(database, `with base as (select pr.* from page_revision pr where revision_id=${q1035Site.revision_id}), ins as (insert into page_revision(revision_type,created_at,revision_number,page_id,site_id,user_id,from_wikidot,changes,wikitext_hash,compiled_body_html_hash,compiled_top_bar_html_hash,compiled_side_bar_html_hash,compiled_at,compiled_generator,comments,hidden,title,alt_title,slug,tags,compiled_body_styles_hash) select 'regular',now()+(g||' milliseconds')::interval,g,base.page_id,base.site_id,${ACTOR_IDS.editor},false,array['wikitext'],base.wikitext_hash,base.compiled_body_html_hash,base.compiled_top_bar_html_hash,base.compiled_side_bar_html_hash,now(),base.compiled_generator,'Q1035_SOURCE_COMMENT',array[]::text[],'Q1035 Public Activity',base.alt_title,base.slug,base.tags,base.compiled_body_styles_hash from base,generate_series(${from},${to}) g returning revision_id) update page set latest_revision_id=(select max(revision_id) from ins),updated_at=now() where page_id=${q1035Site.page_id};`);
    insertRevisions(1, 1105);
    let privateCurrent = await rpc("page_get", { site_id: SITE_ID, page: q809Private.slug, details: { wikitext: true, compiled: false } }, { token: tokens.editor.token, siteId: SITE_ID });
    const q1035PrivateMid = await edit(privateCurrent, `${privateCurrent.wikitext}\nQ1035_PRIVATE_ACTIVITY_MID`, "Q1035 mid private activity");
    insertRevisions(1106, 2105);
    privateCurrent = await rpc("page_get", { site_id: SITE_ID, page: q809Private.slug, details: { wikitext: true, compiled: false } }, { token: tokens.editor.token, siteId: SITE_ID });
    const q1035PrivateNewest = await edit(privateCurrent, `${privateCurrent.wikitext}\nQ1035_PRIVATE_ACTIVITY_NEWEST`, "Q1035 newest private activity");
    sql(database, `with public_anchors as (select max(created_at) filter (where revision_number=1105) as mid_older, max(created_at) filter (where revision_number=1106) as mid_newer, max(created_at) filter (where revision_number=2105) as public_newest from page_revision where page_id=${q1035Site.page_id}) update page_revision pr set created_at=case pr.revision_id when ${q1035PrivateMid.revision_id} then public_anchors.mid_older+((public_anchors.mid_newer-public_anchors.mid_older)/2) when ${q1035PrivateNewest.revision_id} then public_anchors.public_newest+interval '1 millisecond' end from public_anchors where pr.revision_id in (${q1035PrivateMid.revision_id},${q1035PrivateNewest.revision_id}); update page set updated_at=(select created_at from page_revision where revision_id=${q1035PrivateNewest.revision_id}) where page_id=${q809Private.page_id};`);
    sql(database, `with src as (select fr.* from file_revision fr order by fr.revision_id limit 1), anchor as (select min(created_at)-interval '1 millisecond' as created_at from page_revision where page_id=${q1035Site.page_id} and revision_number between 1 and 2105), nf as (insert into file(name,page_id,site_id,from_wikidot) values ('q1035-activity.txt',${q1035Site.page_id},${SITE_ID},false) returning file_id) insert into file_revision(revision_type,created_at,revision_number,file_id,page_id,site_id,user_id,name,s3_hash,mime,size,changes,comments,hidden,content_type_label,content_type_description) select 'create',anchor.created_at,0,nf.file_id,${q1035Site.page_id},${SITE_ID},${ACTOR_IDS.editor},'q1035-activity.txt',src.s3_hash,src.mime,src.size,array['page','name','blob','mime'],'Q1035_FILE_COMMENT',array[]::text[],src.content_type_label,src.content_type_description from src,nf,anchor;`);
    const q1035Latest = await rpc("page_get", { site_id: SITE_ID, page: q1035Site.slug, details: { wikitext: true, compiled: false } }, { siteId: SITE_ID });

    const q809Path = path.join(args["output-private-dir"], "q809.json");
    const q809 = JSON.parse(await fs.readFile(q809Path, "utf8"));
    q809.fixture = { site_id: SITE_ID, holder: { page_id: q809Holder.page_id, slug: q809Holder.slug, title: "Q809 holder", category_id: q809Holder.page_category_id }, private_page: { page_id: q809Private.page_id, slug: q809Private.slug, title: "Private high", category_id: privateCategory }, public_page: { page_id: q809Public.page_id, slug: q809Public.slug, title: "Public low", category_id: publicCategory }, source: q809Source, initial_public_score: 1, mutated_public_score: 2, private_score: 3, mutation_value: 1 };
    await fs.writeFile(q809Path, `${JSON.stringify(q809, null, 2)}\n`, { mode: 0o600 });

    const backPath = path.join(args["output-private-dir"], "backlinks-r23.json");
    const back = JSON.parse(await fs.readFile(backPath, "utf8"));
    Object.assign(back.fixture, { site_id: SITE_ID, site_slug: SITE_SLUG, holder: { page_id: backHolder.page_id, slug: backHolder.slug, title: backHolder.title, source: "BACKLINKS_HOLDER\n[[module Backlinks]]" }, empty_holder: { page_id: backEmpty.page_id, slug: backEmpty.slug, title: backEmpty.title, source: "BACKLINKS_EMPTY\n[[module Backlinks]]" }, visible: [{ page_id: backVisibleA.page_id, slug: backVisibleA.slug, title: backVisibleA.title }, { page_id: backVisibleB.page_id, slug: backVisibleB.slug, title: backVisibleB.title }], hidden: [{ page_id: backHidden.page_id, slug: backHidden.slug, title: backHidden.title }], private: [{ page_id: backPrivate.page_id, slug: backPrivate.slug, title: backPrivate.title }], deleted: [{ page_id: backDeleted.page_id, slug: backDeleted.slug, title: backDeleted.title }], foreign_page: { page_id: backForeign.page_id, slug: backForeign.slug, title: backForeign.title, site_id: FOREIGN_SITE_ID, site_slug: "scp-wiki" }, stale_page_slug: "qbacklinks-stale-missing" });
    await fs.writeFile(backPath, `${JSON.stringify(back, null, 2)}\n`, { mode: 0o600 });

    const q1034Path = path.join(args["output-private-dir"], "q1034-r23.json");
    const q1034 = JSON.parse(await fs.readFile(q1034Path, "utf8"));
    for (const [role, pageValue] of Object.entries(q1034Pages)) q1034.forum_read_fixture.pages[role] = { page_id: pageValue.page_id, revision_id: pageValue.revision_id, slug: pageValue.slug, source_sha256: sha256(Q1034_SAVED_SOURCES[role]) };
    Object.assign(q1034.forum_read_fixture, { primary_category_id: 9000101, pagination_category_id: 9000102, missing_category_id: 99990101, visible_thread_id: 9100101, comments_thread_id: 9100122, missing_thread_id: 99990102, category_route_name: "visible-category", thread_route_name: "visible-thread" });
    await fs.writeFile(q1034Path, `${JSON.stringify(q1034, null, 2)}\n`, { mode: 0o600 });

    for (const name of ["q1035-r23.json", "q1035-r23-admin.json"]) {
      const target = path.join(args["output-private-dir"], name);
      const value = JSON.parse(await fs.readFile(target, "utf8"));
      value.sitechanges_listdrafts_fixture = { site_id: SITE_ID, pages: { sitechanges_holder: { page_id: q1035Site.page_id, revision_id: q1035Latest.revision_id, slug: q1035Site.slug, source_sha256: sha256(Q1035_SAVED_SOURCES.sitechanges_holder) }, listdrafts_holder: { page_id: q1035Draft.page_id, revision_id: q1035Draft.revision_id, slug: q1035Draft.slug, source_sha256: sha256(Q1035_SAVED_SOURCES.listdrafts_holder) } }, row_markers: Array.from({ length: 2105 }, (_, index) => `(rev. ${2105 - index})`), forbidden_markers: ["Private high", "privateq809"], public_title: "Q1035 Public Activity", source_comment: "Q1035_SOURCE_COMMENT", file_comment: "Q1035_FILE_COMMENT", private_host_page_id: q809Private.page_id };
      await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    }

    const mediaAudit = JSON.parse(await fs.readFile(new URL("../../../../docs/development/open43-m-closure-audit.json", import.meta.url), "utf8"));
    const mediaCaseIds = mediaAudit.issues
      .filter(({ issue }) => [756, 776, 806, 1039, 1043, 1062].includes(issue))
      .flatMap(({ subrows }) => subrows)
      .filter(({ classification, next_command_ids }) => classification === "candidate_required" && next_command_ids.includes("C_MEDIA_BROWSER_CANDIDATE"))
      .map(({ case_id }) => case_id);
    if (JSON.stringify(mediaCaseIds) !== JSON.stringify(Object.keys(MEDIA_BROWSER_EVIDENCE))) throw new Error("media browser audit denominator drifted during private input production");
    const mediaInput = structuredClone(general);
    const mediaCases = [];
    for (const caseId of mediaCaseIds) {
      const evidenceId = MEDIA_BROWSER_EVIDENCE[caseId];
      const evidence = mediaAudit.evidence_registry?.[evidenceId];
      if (typeof evidence?.path !== "string" || !/^[0-9a-f]{64}$/u.test(evidence.sha256 ?? "")) throw new Error(`${caseId} media browser evidence is missing or malformed in the audit registry`);
      const evidenceBytes = await fs.readFile(evidence.path);
      if (sha256(evidenceBytes) !== evidence.sha256) throw new Error(`${caseId} retained media browser evidence SHA-256 does not match the audit registry`);
      mediaCases.push({ case_id: caseId, evidence: { evidence_id: evidenceId, path: evidence.path, sha256: evidence.sha256 } });
    }
    mediaInput.media_browser = {
      cases: mediaCases,
    };
    const mediaPath = path.join(args["output-private-dir"], "media-browser.json");
    await fs.writeFile(mediaPath, `${JSON.stringify(mediaInput, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    privateFiles.push("media-browser.json");

    const mediaFilesInput = structuredClone(general);
    mediaFilesInput.actors.editor = structuredClone(general.actors.administrator);
    const mediaFilesPath = path.join(args["output-private-dir"], "media-files.json");
    await fs.writeFile(mediaFilesPath, `${JSON.stringify(mediaFilesInput, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    privateFiles.push("media-files.json");

    const temporalContractPath = new URL("../fixtures/framerail-route-action-browser/run-contract.json", import.meta.url);
    const temporalContract = JSON.parse(await fs.readFile(temporalContractPath, "utf8"));
    if (temporalContract?.issue !== 1372 || !Array.isArray(temporalContract.subjects) || temporalContract.subjects.length !== 14) throw new Error("route-action temporal run contract denominator drifted");
    const candidateOrigin = bindings.public.candidate_origin;
    const temporalUrls = {
      denial: {
        missing_page: new URL("/privateq809:route-action-denied-missing", candidateOrigin).href,
        saved_page: new URL(`/${q809Private.slug}`, candidateOrigin).href,
      },
      failure: {
        missing_page: new URL("/route-action-missing", candidateOrigin).href,
        saved_page: new URL(`/${redirectTarget.slug}`, candidateOrigin).href,
      },
      success: {
        missing_page: new URL("/route-action-missing", candidateOrigin).href,
        saved_page: new URL(`/${redirectTarget.slug}`, candidateOrigin).href,
      },
    };
    for (const slug of ["privateq809:route-action-denied-missing", "route-action-missing"]) {
      if (await rpc("page_get", { site_id: SITE_ID, page: slug, details: { wikitext: false, compiled: false } }, { siteId: SITE_ID }) !== null) throw new Error(`route-action missing-page namespace already exists: ${slug}`);
    }
    const temporalUrlsSha256 = captureUrlsSha256(temporalUrls);
    const finalTrigger = (subject) => subject.trigger_selectors.at(-1);
    const denialOracles = Object.fromEntries(temporalContract.subjects.map((subject) => [subject.id, {
      type: "dom",
      predicate: { selector: finalTrigger(subject), state: "absent" },
      activation: "none",
    }]));
    const failureOracles = Object.fromEntries(temporalContract.subjects.map((subject) => {
      if (subject.id === "control:create") return [subject.id, {
        type: "event",
        event: { kind: "request", method: "GET", url_suffix: "/edit/true/__data.json" },
        failure_control: { kind: "abort_request", request: { resource_type: "fetch", method: "GET", url_suffix: "/edit/true/__data.json" } },
      }];
      if (subject.id === "control:restore") return [subject.id, {
        type: "event",
        event: { kind: "request", method: "POST", url_suffix: "?/deletedGet" },
        failure_control: { kind: "abort_request", request: { method: "POST", url_suffix: "?/deletedGet" } },
      }];
      return [subject.id, {
        type: "dom",
        predicate: { selector: ".pane-loading", state: "visible" },
        failure_control: { kind: "abort_request", request: { resource_type: "script" } },
      }];
    }));
    const temporalFixturePath = path.join(args["output-private-dir"], "framerail-route-action-fixture.json");
    const temporalFailurePath = path.join(args["output-private-dir"], "framerail-route-action-failure-control.json");
    const temporalRuntimePath = path.join(args["output-private-dir"], "framerail-route-action-runtime.json");
    const temporalDenialStatePath = path.join(args["output-private-dir"], "framerail-route-action-denial-storage.json");
    const temporalFailureStatePath = path.join(args["output-private-dir"], "framerail-route-action-failure-storage.json");
    const temporalSuccessStatePath = path.join(args["output-private-dir"], "framerail-route-action-success-storage.json");
    const temporalFixture = {
      schema: "wikijump.framerail_route_action_fixture_identity.v1",
      urls: temporalUrls,
      urls_sha256: temporalUrlsSha256,
      fixtures: {
        denial_private_page: { page_id: q809Private.page_id, slug: q809Private.slug, category_id: privateCategory },
        saved_imported_page: { page_id: redirectTarget.page_id, revision_id: redirectTarget.revision_id, slug: redirectTarget.slug },
        failure_missing_slug: "route-action-missing",
        denial_missing_slug: "privateq809:route-action-denied-missing",
      },
      run_owned_fixture: { restored: [], removed: [] },
    };
    const temporalFailureControl = {
      schema: "wikijump.framerail_route_action_failure_control_identity.v1",
      urls_sha256: temporalUrlsSha256,
      result_oracles: { denial: denialOracles, failure: failureOracles },
    };
    const temporalRuntime = {
      schema: "wikijump.framerail_route_action_runtime_identity.v1",
      wikijump_commit: candidate.wikijump_commit,
      wikijump_tree: candidate.wikijump_tree,
      ftml_sha: candidate.ftml_sha,
      candidate_identity_sha256: identitySha256,
      runtime_bindings: bindings.runtime,
    };
    const storageState = (token) => ({ cookies: [{ name: "wikijump_token", value: token, url: candidateOrigin, httpOnly: true, secure: true, sameSite: "Lax" }], origins: [] });
    await Promise.all([
      fs.writeFile(temporalFixturePath, `${JSON.stringify(temporalFixture, null, 2)}\n`, { mode: 0o600, flag: "wx" }),
      fs.writeFile(temporalFailurePath, `${JSON.stringify(temporalFailureControl, null, 2)}\n`, { mode: 0o600, flag: "wx" }),
      fs.writeFile(temporalRuntimePath, `${JSON.stringify(temporalRuntime, null, 2)}\n`, { mode: 0o600, flag: "wx" }),
      fs.writeFile(temporalDenialStatePath, `${JSON.stringify(storageState(tokens.other.token), null, 2)}\n`, { mode: 0o600, flag: "wx" }),
      fs.writeFile(temporalFailureStatePath, `${JSON.stringify(storageState(tokens.editor.token), null, 2)}\n`, { mode: 0o600, flag: "wx" }),
      fs.writeFile(temporalSuccessStatePath, `${JSON.stringify(storageState(tokens.editor.token), null, 2)}\n`, { mode: 0o600, flag: "wx" }),
    ]);
    const browserRoot = defaultBrowserRoot();
    const { chromium } = loadPlaywright(browserRoot);
    const browserExecutable = path.resolve(chromium.executablePath());
    const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
    const browserVersion = browser.version();
    await browser.close();
    const temporalInput = structuredClone(general);
    temporalInput.temporal_capture = {
      browser_root: browserRoot,
      browser_executable: browserExecutable,
      browser_identity: { sha256: await sha256File(browserExecutable), version: browserVersion },
      fixture_identity: temporalFixturePath,
      fixture_identity_sha256: await sha256File(temporalFixturePath),
      failure_control_identity: temporalFailurePath,
      failure_control_identity_sha256: await sha256File(temporalFailurePath),
      runtime_identity: temporalRuntimePath,
      runtime_identity_sha256: await sha256File(temporalRuntimePath),
      actor_classes: { denial: "denied", failure: "permitted", success: "permitted" },
      storage_states: { denial: temporalDenialStatePath, failure: temporalFailureStatePath, success: temporalSuccessStatePath },
      urls: temporalUrls,
      runtime_bindings: bindings.runtime,
      timeout_ms: 30_000,
      ignore_https_errors: true,
    };
    const temporalInputPath = path.join(args["output-private-dir"], "framerail-route-action-browser.json");
    await fs.writeFile(temporalInputPath, `${JSON.stringify(temporalInput, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    privateFiles.push("framerail-route-action-browser.json");

    await fs.writeFile(generalPath, `${JSON.stringify(general, null, 2)}\n`, { mode: 0o600 });
    await propagateActors();
    clearCandidateRedisCache(cache);
    const caseSetPrivateInputs = validateCaseSetPrivateInputMap(privateFiles);
    const receipt = { schema: COMPATIBILITY_CANDIDATE_INPUT_RECEIPT_SCHEMA, status: "pass", generated_at: new Date().toISOString(), candidate: { wikijump_commit: candidate.wikijump_commit, wikijump_tree: candidate.wikijump_tree, ftml_sha: candidate.ftml_sha, compose_project: project, editable_identity_sha256: identitySha256 }, output_private_dir: args["output-private-dir"], private_files: privateFiles, case_set_private_inputs: caseSetPrivateInputs, fixture_counts: { members: 151, ftml_markers: markerPages.length, q1034_pagination_threads: 221, q1034_page_comment_posts: 24, q778_posts: 5, q1035_public_revisions: 2105, q1032_watchers_rows: 20, q1032_whoinvited_actors: 4, q1032_whoinvited_targets: 4 }, fixtures: { a1037_redirect_source: redirectSource.page_id, b610_canary_attachments: b610Attachments, b690_canary_attachments: b690Attachments, ftml_markers: markerPages.map(({ page_id, revision_id, slug }) => ({ page_id, revision_id, slug })), q1032_members: members.page_id, q1032_readonly_evidence: OPEN43_Q1032_EVIDENCE.readonly, q1036_saved: q1036.page_id, q1026_identity: q1026Page.page_id, q810_saved: featured.page_id, q778_saved: forumMini.page_id, q809_private: q809Private.page_id, q1035_sitechanges: q1035Site.page_id } };
    const publication = await sealJsonNoReplace(args.receipt, receipt);
    if (publication.publication !== "created") throw new Error(`candidate input receipt already exists: ${args.receipt}`);
    return { receipt: { path: args.receipt, sha256: publication.sha256 }, private_dir: args["output-private-dir"] };
  } finally {
    await fs.rm(caPath, { force: true });
  }
}

export async function prepareCompatibilityCandidateInputsMain(argv = process.argv.slice(2)) {
  const args = parseCompatibilityCandidateInputArgs(argv);
  if (args.help) return void process.stdout.write(`${usage()}\n`);
  process.stdout.write(`${JSON.stringify(await prepareCompatibilityCandidateInputs(args))}\n`);
}
