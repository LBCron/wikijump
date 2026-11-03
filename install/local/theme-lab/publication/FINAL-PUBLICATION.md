# SCP-JP 手動publication set

## 手動実行の前提

この資料は転記用です。SCP-JPへの公開書き込みはまだ行っていません。updateでは実行時にlive revision/source SHAがcurrent targetと一致することを確認してください。変更されていた場合はそのページの作業を止め、provenanceを更新して再acceptanceしてください。Attachmentはsource pageより先に指定filenameでuploadします。

freeze graphの`status`欄はfreeze時点の状態です。最終acceptanceは上のcurrent gateを参照してください。frozen candidate setは変更していません。

## 全48 publication node

`create`=新規page、`update`=既存page source更新、`reuse-existing`=既存pageを再利用、`retain-cross-wiki`=intentional shared dependencyを維持。

| Node / target page | Action | exact source path / identity | Current target authority | Attachments |
|---|---|---|---|---:|
| `component:betterfootnotes` | 既存ページ更新 | install/local/theme-lab/publication/components/betterfootnotes/source.wikidot.txt<br>`84aa43f24ed32e2953abacc1b81804f284235b3afcdcee2b56f908525e45d46d` | rev10 / a93c113949c85d818d49453d7e0271fa0a06c9eed70b0641eebd2466aab33c8c | 0 |
| `component:bhl-dark-sidebar` | 既存ページ更新 | install/local/theme-lab/publication/components/bhl-dark-sidebar/source.wikidot.txt<br>`a00d21e5e4272ba0b598b59609f50523c7f0b7961f86d53f9d00a66566f72b7e` | rev2 / ac6bdcbd357fda304db94439c8140a3e3b6fc379d4ba558ecf0add845e903357 | 0 |
| `component:centered-header-bhl` | 既存ページを再利用 | 既存source authority<br>`be0cec9e1373b49ea771184edf19efda85a9b7b09ef6788f89ce266874b9a28c` | rev3 / be0cec9e1373b49ea771184edf19efda85a9b7b09ef6788f89ce266874b9a28c | 0 |
| `component:collapsible-sidebar` | 既存ページを再利用 | 既存source authority<br>`b0ae91dbf313be853ab0a8e130176b2dc6bd5a9543d1f97687fc4cf9432db55f` | rev4 / b0ae91dbf313be853ab0a8e130176b2dc6bd5a9543d1f97687fc4cf9432db55f | 0 |
| `component:croqstyle` | 意図的な他wiki依存を維持 | 既存source authority<br>`9c8b316516f374d664c92042a1913268e9018a7eaeaaac1f5011e16546bab529` | 既存対象なし | 0 |
| `component:fade-in` | 既存ページ更新 | install/local/theme-lab/publication/components/fade-in/source.wikidot.txt<br>`a4882c56f2c0be3af6f9c4d1d0b6d6054ddbf86c16e6fa584342e2a6adb71f90` | rev2 / 69829e1b8c93c57d79254911adbb96df4ce3e0ced9285d900b01b4cfd714d95c | 0 |
| `component:interwiki-style` | 既存ページを再利用 | 既存source authority<br>`51ad052297c3ea8bf38549b93154eebb20995448b316458911f97677b9cee2dd` | rev6 / 51ad052297c3ea8bf38549b93154eebb20995448b316458911f97677b9cee2dd | 0 |
| `component:license-box-backend` | 既存ページを再利用 | 既存source authority<br>`f1e98ccb0adc48a8d457115f92cd909a0cc3d6b2c250b81291e71b9b8d7467c9` | rev9 / f1e98ccb0adc48a8d457115f92cd909a0cc3d6b2c250b81291e71b9b8d7467c9 | 0 |
| `component:sigma-plus` | 新規作成 | install/local/theme-lab/publication/components/sigma-plus/source.wikidot.txt<br>`dccfb8c281e6bf0268f7f472ef86690aa64181d3d916d1385838886bd89eafbf` | 既存対象なし | 0 |
| `component:text-style` | 意図的な他wiki依存を維持 | 既存source authority<br>`e3a5a66146f647d29675138ae6edab6ad8236e5221d8e79d94a10ceb546433c5` | 既存対象なし | 0 |
| `component:toggle-sidebar-bhl` | 既存ページを再利用 | 既存source authority<br>`b498d2bbcd7a503ac89beb04a63041a5cb8d49f980630e82155ddbf7b2857a05` | rev3 / b498d2bbcd7a503ac89beb04a63041a5cb8d49f980630e82155ddbf7b2857a05 | 0 |
| `fragment:collapsible-sidebar-bhl` | 既存ページを再利用 | 既存source authority<br>`2e8e7c132c50ab0c046f42bda185472d4ed19e7d8eb1725085835561e07bf2c3` | rev5 / 2e8e7c132c50ab0c046f42bda185472d4ed19e7d8eb1725085835561e07bf2c3 | 0 |
| `theme:aesthetic-theme` | 既存ページ更新 | install/local/theme-lab/ports/aesthetic-theme/candidate.wikidot.source.txt<br>`336b7b50a4969b60b1b8926b17975d54fe5f2297ef3354d56c41c20ede8d164c` | revision記載なし / da06a9e340ca0f6faa0f900117f1c165eaffed070d2269df0a99aec038b06338 | 2 |
| `theme:al-slop` | 新規作成 | install/local/theme-lab/ports/al-slop/candidate.wikidot.source.txt<br>`f6809160ccf1b35e74340d5e0421efecf8585246310203debbb5f0727b95eb8b` | 既存対象なし | 0 |
| `theme:basalt` | 新規作成 | install/local/theme-lab/ports/basalt/candidate.wikidot.source.txt<br>`b3dc264fd62d29c3202e3e3db90a2461e27f04426e657c66c648284be558f4df` | 既存対象なし | 1 |
| `theme:bedrock` | 新規作成 | install/local/theme-lab/ports/bedrock/candidate.wikidot.source.txt<br>`c077ff195b55327cd0de0e3310c39ed078045a87cc75f8ebe48dabaff594e423` | 既存対象なし | 0 |
| `theme:black-highlighter-theme` | 既存ページ更新 | install/local/theme-lab/ports/black-highlighter-theme/candidate.wikidot.source.txt<br>`c42238fa49ab82144ec93f30bf45d769e42019975946cfad3cee0b67a0a9a427` | rev74 / 760ef1fb2d85d2c956c7ae59c6792c22c651faf05dc547669a86e66f5702c10e | 1 |
| `theme:classic` | 既存ページ更新 | install/local/theme-lab/ports/classic/candidate.wikidot.source.txt<br>`9aa209eaeec59753e2f6dba8e0299281fb58793c720f4495559e2a1adbd48e09` | rev11 / fa167734c0345030acd8ac869edf0505a91aad74be1bb87fc9f26ec59d38584a | 2 |
| `theme:cosmonaut` | 既存ページ更新 | install/local/theme-lab/ports/cosmonaut/candidate.wikidot.source.txt<br>`155fd2fa7eba52281b87c34e446bf6ad1b587936efdadd291dff0081c59da179` | revision記載なし / 857c48d316a054139c6c667fcfadd14208885fcf1c3103b56c9a661a620e5fd2 | 0 |
| `theme:dear-dictator-jp` | 新規作成 | install/local/theme-lab/publication/themes/dear-dictator-jp/source.wikidot.txt<br>`32739731fe39263816ea42f378f2541286186b93d477938feb6d489279e42022` | 既存対象なし | 0 |
| `theme:extra-black-highlighter-theme` | 既存ページ更新 | install/local/theme-lab/ports/extra-black-highlighter-theme/candidate.wikidot.source.txt<br>`b0a5bdc62ba1eccb494b073861ed269baf71c0a3549dc2a1a5c3854d9d6d4a5a` | revision記載なし / 9fd030b51393568f0701d43d31f25c61ac7ad2350995f04a98e2f8d1fcedcaf5 | 1 |
| `theme:flopstyle-dark` | 新規作成 | install/local/theme-lab/ports/flopstyle-dark/candidate.wikidot.source.txt<br>`2b9004a9304ed089aa69da78d140bc03aa333b792751b57133d7429b499aa1e3` | 既存対象なし | 2 |
| `theme:foxtrot` | 既存ページ更新 | install/local/theme-lab/ports/foxtrot/candidate.wikidot.source.txt<br>`e0bbf7be650005b5f7d5e3893e598e16febd6f06d0bc26fc86f90163520b4e47` | rev8 / d342ea8a6503fe16f975d74ff6646ff285ab8a382538e54c3e863d70bd055634 | 24 |
| `theme:hansarp` | 既存ページ更新 | install/local/theme-lab/ports/hansarp/candidate.wikidot.source.txt<br>`8607035277a57cb631f331706c0b2d7fbfbdcf1bcf278cdebf9442258f3aef00` | revision記載なし / f398f2ab409800a156552d37382cbd396a6745d6bbdd794f3f39ab17c5fa78dd | 1 |
| `theme:inkblot` | 新規作成 | install/local/theme-lab/ports/inkblot/candidate.wikidot.source.txt<br>`679a88f60fb72ac72743a09380e121bfbb03207800e41b1ad74e59b1f66bc9ac` | 既存対象なし | 1 |
| `theme:isolated-terminal` | 既存ページ更新 | install/local/theme-lab/ports/isolated-terminal/candidate.wikidot.source.txt<br>`81ddb7613a62070b01f7c95657433a7ac130ece617e3f691df43db82255670b7` | rev14 / 7b004be4cad79ce61c5c092e5aa714d40c95369ab8422a465025917ab0bd8ea4 | 1 |
| `theme:jakstyle` | 既存ページ更新 | install/local/theme-lab/ports/jakstyle/candidate.wikidot.source.txt<br>`d0eb8af160c74eb7d72792b78567756792857a6b7851ed196cc7233b1f960869` | revision記載なし / 043a9ecd102a053c1d7daa538e293a147117f722cfe6e232c694f6107c48dae2 | 0 |
| `theme:minimalist-bhl` | 既存ページ更新 | install/local/theme-lab/ports/minimalist-bhl/candidate.wikidot.source.txt<br>`8bec8d27d44cdfb153f01dcedd67a41ff7a1477c0d1fcce1c41494e59b7ef8d5` | rev2 / 7d870ffc63b1f7a700201a7b585a7aca8aa57a52d5f673c6eafd76d2f1426848 | 0 |
| `theme:monotypical` | 既存ページ更新 | install/local/theme-lab/ports/monotypical/candidate.wikidot.source.txt<br>`2b1757725694a02df9618f21e2e4326f37500b6f751d005558199df72f9913e5` | revision記載なし / f9e1ea2563ba3963770c899068d58fd175d58824f0d3ffd4436ec8db5a60c156 | 3 |
| `theme:much-cool` | 既存ページ更新 | install/local/theme-lab/ports/much-cool/candidate.wikidot.source.txt<br>`5b80ba7f55a5f70b6569fef18e95056bf223ec143f7c2ef549d88aba7a3d096a` | rev4 / aff88b307f9e26ce47d632a6f29bb786a62f9b89b1e2b41ed9ab0e74d9272988 | 0 |
| `theme:night-rush-theme` | 既存ページ更新 | install/local/theme-lab/ports/night-rush-theme/candidate.wikidot.source.txt<br>`5d0cc657cd638addbb28f8278832126dc863b1ae0ae339f216dceff45ef2f98c` | rev11 / 03327c410ace73c1105b60aaf89f254336732ed63579c9c952608be0462bb132 | 0 |
| `theme:ouroborous-theme` | 既存ページ更新 | install/local/theme-lab/ports/ouroborous-theme/candidate.wikidot.source.txt<br>`0fa23f59bcaafa19dd4cd7bf135cd29e4726de0c507f9357343d23a12a927d2f` | revision記載なし / 154b816e5c5de3fef3ea3fa0f0b9dbe5688cbd936d8ba60eeb60fb8eb5d35b58 | 2 |
| `theme:paperstack` | 既存ページ更新 | install/local/theme-lab/ports/paperstack/candidate.wikidot.source.txt<br>`5939181e533d5c02d39ac16dad70f9ae9b80efa7fcd79ebb4c8ba8b75ab16854` | rev6 / a6d81604d54acbe2626a625fcd1b839636fdb8a53d6b7de292338280ac6b8fc6 | 1 |
| `theme:pataphysics` | 既存ページ更新 | install/local/theme-lab/ports/pataphysics/candidate.wikidot.source.txt<br>`6fdcaec9c6a74cf2c3c0c75ac4fac85f010c6733d3fcdf10d3312d8f5470c07b` | rev40 / 010bec1cd52b910ae33ba244dd04b5141304142ba7210c53f3347ef68944504a | 0 |
| `theme:penumbra` | 既存ページ更新 | install/local/theme-lab/ports/penumbra/candidate.wikidot.source.txt<br>`439b21910d1a4363c35845490fdc2585a286b26577c2d692f130c2f790681b9e` | rev8 / 9ab03d7a81385d6867dd7cf6fabcad33b3257b8f11296479924031b9eb1cbec0 | 0 |
| `theme:quand-le-soleil-se-couche` | 既存ページ更新 | install/local/theme-lab/publication/themes/quand-le-soleil-se-couche/source.wikidot.txt<br>`c44ef95cf9a648f5b2eb9bc3854e95cb4e7005d5c9f656078e795508c7c7c47a` | rev2 / d42659934387cf19af43b9135db16820ecef9e8fe478c9ee645e794b4c71a881 | 2 |
| `theme:redtape` | 既存ページ更新 | install/local/theme-lab/ports/redtape/candidate.wikidot.source.txt<br>`ece731ae73360d76e394eb747dda555a081de973e2c6444284385764cc320892` | revision記載なし / b0f436a038cfd2c4f1bb0e153995a5ba911c92682d5a058eba578724563632af | 3 |
| `theme:scheme` | 新規作成 | install/local/theme-lab/ports/scheme/candidate.wikidot.source.txt<br>`292624abd9238b7a3c0cca9fe0f603fbd18476610740084e2b5315a01e8348fc` | 既存対象なし | 0 |
| `theme:scp-offices-theme` | 既存ページ更新 | install/local/theme-lab/ports/scp-offices-theme/candidate.wikidot.source.txt<br>`1fb480f19fd71c9d78ba365e5d88d5668ce46b722546f514b795a83b74eb82c8` | revision記載なし / 712c7edf8e1060819d93f205158f599cf5318cdc4cec6d3e2c5241e059873808 | 2 |
| `theme:scpedia` | 新規作成 | install/local/theme-lab/ports/scpedia/candidate.wikidot.source.txt<br>`a03ffcf8189adfaf7d9e43fd3084c61957f9f4910a6096b32d9073ad699d70f8` | 既存対象なし | 0 |
| `theme:sigma` | 新規作成 | install/local/theme-lab/ports/sigma/candidate.wikidot.source.txt<br>`2bc461f3a212385d4588debb88de6f20a7f9c1a739b41053f6fb6f95e503bb23` | 既存対象なし | 0 |
| `theme:site` | 新規作成 | install/local/theme-lab/ports/site/candidate.wikidot.source.txt<br>`b62171f0df44d62ebe3af75eca1cb53ef854f0b8e747dedade2ed0ee399e9c48` | 既存対象なし | 0 |
| `theme:skipos` | 新規作成 | install/local/theme-lab/ports/skipos/candidate.wikidot.source.txt<br>`d4433a2cdfa61e377dfd7bc925cc61b3add23aade773a891b968acf9a6ec2507` | 既存対象なし | 0 |
| `theme:space` | 既存ページ更新 | install/local/theme-lab/ports/space/candidate.wikidot.source.txt<br>`20d4d9c98052fc76fcf8573505509dc4d49c3b4852e2ea99580218ad34afe3a7` | revision記載なし / 63bee9d3876ac78335c8a587c63b719efea9d3a9ab1bf945bdd807ce1f554c5d | 0 |
| `theme:turbo-vision` | 既存ページ更新 | install/local/theme-lab/ports/turbo-vision/candidate.wikidot.source.txt<br>`69e1fa9c6a57ca01097a29beab1f58b67741f9e53f958e95616fb5f7b559e589` | rev6 / ca80e76ee545e00f11d7d2145aa43942b83910dea9b5db2a854b9aabed6e7e0b | 0 |
| `theme:wikifot` | 新規作成 | install/local/theme-lab/ports/wikifot/candidate.wikidot.source.txt<br>`403335fe611db4be2ef13a0349e8215dade54727318494551221bb5671cc5e55` | 既存対象なし | 1 |
| `theme:y2k` | 既存ページ更新 | install/local/theme-lab/ports/y2k/candidate.wikidot.source.txt<br>`267413c5754294971d048457f9712b6929d5421ffe2d3e54dfa47c47140e8bf0` | rev3 / 49187df24c3c7c454aa0a01eeec6f33e2f625074495bbb91c1f2d7b811705aab | 0 |
| `theme:yossistyle` | 新規作成 | install/local/theme-lab/ports/yossistyle/candidate.wikidot.source.txt<br>`c9987477d0e9079b7b15c55ac608b853e69c970484dc2b5b0e6f3cd6565c442c` | 既存対象なし | 0 |

## Uploadする50 attachment

各行のsource fileを同じnodeのtarget filenameでuploadします。SHAとbyte数はfrozen inventoryおよびcurrent filesystemと一致しています。Dear Dictatorの5 PNGはpage sourceにdata URLで埋め込み済みで、別attachmentはありません。Quandは2件をpage source update前にuploadします。

| Node | Target filename | Source path | Bytes | SHA-256 |
|---|---|---|---:|---|
| `theme:aesthetic-theme` | `AESTHETIC_logo.svg` | install/local/theme-lab/ports/aesthetic-theme/page-assets/AESTHETIC_logo.svg | 15578 | `64ca862d41f0aebc7f0fc6c9f0af82bc93b0dba29fc87e83bf18e9a8ba58c8e7` |
| `theme:aesthetic-theme` | `black-highlighter-logo.svg` | install/local/theme-lab/ports/aesthetic-theme/page-assets/black-highlighter-logo.svg | 6615 | `4cd40e7d6111296c9f4c6d066f63ef5b01301df18358889677cd182d76bfe593` |
| `theme:basalt` | `basalt-theme-logo.svg` | install/local/theme-lab/ports/basalt/page-assets/basalt-theme-logo.svg | 5451 | `3baf62c62621629c69f22433651572da5fd917e276e5953ae4eebd75b7ca99b2` |
| `theme:black-highlighter-theme` | `black-highlighter-logo.svg` | install/local/theme-lab/ports/black-highlighter-theme/page-assets/black-highlighter-logo.svg | 6615 | `4cd40e7d6111296c9f4c6d066f63ef5b01301df18358889677cd182d76bfe593` |
| `theme:classic` | `base_image_frame.png` | install/local/theme-lab/ports/classic/page-assets/base_image_frame.png | 2283 | `c5a79a414173aa6ccd5013fea65aae666b35826b53c30e0a20b4534f475e5a6f` |
| `theme:classic` | `scp_foundation_logo.png` | install/local/theme-lab/ports/classic/page-assets/scp_foundation_logo.png | 9225 | `975a510eefe55e44930b50076b7c4e729c202e0d7f4c9049cd90e38a70516ed0` |
| `theme:extra-black-highlighter-theme` | `black-highlighter-logo.svg` | install/local/theme-lab/ports/extra-black-highlighter-theme/page-assets/black-highlighter-logo.svg | 6615 | `4cd40e7d6111296c9f4c6d066f63ef5b01301df18358889677cd182d76bfe593` |
| `theme:flopstyle-dark` | `alt_logo_tyrian.png` | install/local/theme-lab/ports/flopstyle-dark/page-assets/alt_logo_tyrian.png | 17814 | `0d1e21c24a9092515ec777ee45760bc711f85a4ad5049d4d62b0a987f81ac407` |
| `theme:flopstyle-dark` | `scp_foundation_logo.png` | install/local/theme-lab/ports/flopstyle-dark/page-assets/scp_foundation_logo.png | 9225 | `975a510eefe55e44930b50076b7c4e729c202e0d7f4c9049cd90e38a70516ed0` |
| `theme:foxtrot` | `canada_dark-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/canada_dark-JP.png | 67295 | `5b21d465f3108d573b11d651d11ded55751b99e63195d272530651ba23726ba0` |
| `theme:foxtrot` | `canada_light-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/canada_light-JP.png | 66220 | `7557a168960706abff94ffa6023a5ae977649d5e8ae0905fcc662dd3b4ed5e3d` |
| `theme:foxtrot` | `fishing_dark-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/fishing_dark-JP.png | 66696 | `58c241c1bf7914e763334443cef3a23444ec4c1252bcb539a01ae01c7077c54d` |
| `theme:foxtrot` | `fishing_light-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/fishing_light-JP.png | 61957 | `bde8bf5d2c40f3b2b7b6b440f5d9cf136275e28688fece77ae2e5743a5903565` |
| `theme:foxtrot` | `goc_dark-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/goc_dark-JP.png | 67949 | `29d24f580ebc75cacd907119395368075ca63d04f19807db4c6476b84f95bf75` |
| `theme:foxtrot` | `goc_light-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/goc_light-JP.png | 66505 | `ae136ebd2d5e00dded63907f373bbb29c3bb67ab15dd7c4b261e636837efed4c` |
| `theme:foxtrot` | `hybrasil_dark-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/hybrasil_dark-JP.png | 93569 | `a62e82cfc8b8721b8ed93ece934cc9ca58a882ceaa19db6a47d5e78e1b0b647a` |
| `theme:foxtrot` | `hybrasil_light-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/hybrasil_light-JP.png | 97774 | `739a8f6f2c6eecfe275d6d7b8d32fb36d7caced4ed5dc977cbb429fcf50919fa` |
| `theme:foxtrot` | `nightfall_dark-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/nightfall_dark-JP.png | 54725 | `4d7b21765130662fc1127eb0bd8657ab74ea10039967e0e1b95dd27563dec631` |
| `theme:foxtrot` | `nightfall_light-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/nightfall_light-JP.png | 18673 | `a48444c067a9b8f8eb7169175a9651e8d4563e3ca632a7062c5de156ad5497ee` |
| `theme:foxtrot` | `overwatch_dark-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/overwatch_dark-JP.png | 54778 | `a1c43f76d90909b4e0d88465c4c38077ab22f4134e79b3bf49b64d04c4e17760` |
| `theme:foxtrot` | `overwatch_light-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/overwatch_light-JP.png | 14163 | `8fedc09672684735671d09fa6940808553fe80d27eccaf0a043b337b310c143d` |
| `theme:foxtrot` | `poland_dark-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/poland_dark-JP.png | 71846 | `ed55e8d4f13187a45a065914d4c756d360dea4fdbc7594b6c3db2bd9c3f644a3` |
| `theme:foxtrot` | `poland_light-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/poland_light-JP.png | 60908 | `ba64644d32f217fd57b7777ed7a8aa1dbd1e24dd7ad4d21f61ddc44781589a54` |
| `theme:foxtrot` | `slothspit_dark-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/slothspit_dark-JP.png | 85314 | `060e75de6b3488c5bfcab1e1362dded4dfaecc1d0875b06f0f5583726f365305` |
| `theme:foxtrot` | `slothspit_light-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/slothspit_light-JP.png | 82144 | `d8e40b36106b3bb1525775bc6dc12b71441348dd80fe4eba4ff13e930c57ab42` |
| `theme:foxtrot` | `spc_dark-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/spc_dark-JP.png | 68745 | `8ddc3500d4375fc6dfab44bc9b318817acbc8955f42afa8ed5b653be6f84e54d` |
| `theme:foxtrot` | `spc_light-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/spc_light-JP.png | 68351 | `05c8d142b7ac7a752804aa65ff738ece4592ebbb827ce85a6e7ea96544519844` |
| `theme:foxtrot` | `spooky_dark-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/spooky_dark-JP.png | 74095 | `37ce528638b7f5bc5334d691ce5e5b6a6ad9c13736d22136943f6dee6a0e2908` |
| `theme:foxtrot` | `spooky_light-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/spooky_light-JP.png | 77430 | `4a8557fde9fe00f2f840bbbe3dccbda38c49d6cf9b1ab6c02ecd12ad07b1200b` |
| `theme:foxtrot` | `threshold_dark-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/threshold_dark-JP.png | 54586 | `ccbdcd07ac6f1592973a81c4045d269cdbdbf9aa931ac8deafbe1377c7d877ce` |
| `theme:foxtrot` | `threshold_light-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/threshold_light-JP.png | 46540 | `3bccd3bbf06f609a0b20e106855a2562a10cd6ad394f8d558e27ef8ae336f991` |
| `theme:foxtrot` | `vanguard_dark-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/vanguard_dark-JP.png | 81498 | `077589c0ff6c4c77bf7b72ffefc820ec46078163bee12d3a0c5f71669766451c` |
| `theme:foxtrot` | `vanguard_light-JP.png` | install/local/theme-lab/ports/foxtrot/page-assets/vanguard_light-JP.png | 86195 | `85d57f2d3421928fbaf94af29707d4707bbfeb5a7d8ab51b60fd71e0d43f7303` |
| `theme:hansarp` | `hansarplogo.png` | install/local/theme-lab/ports/hansarp/page-assets/hansarplogo.png | 20766 | `7606a8868385d21bbad3105808e7c117017ddbdd91b719f2063471de7b0a5503` |
| `theme:inkblot` | `pancakes.png` | install/local/theme-lab/ports/inkblot/page-assets/pancakes.png | 353234 | `8eb0eabe37b5c0fcd4f402861b8634a4505224d5bfdaccb12af1a4d739735f0a` |
| `theme:isolated-terminal` | `black-highlighter-logo.svg` | install/local/theme-lab/ports/isolated-terminal/page-assets/black-highlighter-logo.svg | 6615 | `4cd40e7d6111296c9f4c6d066f63ef5b01301df18358889677cd182d76bfe593` |
| `theme:monotypical` | `mono-dracula.png` | install/local/theme-lab/ports/monotypical/page-assets/mono-dracula.png | 38179 | `695f4ad3654ba9a63585e61a94d740df4d340608842e93ce55e1940e6929d34a` |
| `theme:monotypical` | `mono-nord.png` | install/local/theme-lab/ports/monotypical/page-assets/mono-nord.png | 37494 | `6a0c47c302004321e8f7bf7df6e04e18f14ac037664e1ef8b194b235616de200` |
| `theme:monotypical` | `mono-solarized.png` | install/local/theme-lab/ports/monotypical/page-assets/mono-solarized.png | 37054 | `0830d0c7c6e4bcecb0863f88b35302c549167b41f171f2c4f9f263b49fed3b11` |
| `theme:ouroborous-theme` | `black-highlighter-logo.svg` | install/local/theme-lab/ports/ouroborous-theme/page-assets/black-highlighter-logo.svg | 6615 | `4cd40e7d6111296c9f4c6d066f63ef5b01301df18358889677cd182d76bfe593` |
| `theme:ouroborous-theme` | `ouroborous_logo.png` | install/local/theme-lab/ports/ouroborous-theme/page-assets/ouroborous_logo.png | 172768 | `6ce2cde35401f36f7d44966903821ee9df970033eb22d77979d21195dbaeabac` |
| `theme:paperstack` | `lgtrans.png` | install/local/theme-lab/ports/paperstack/page-assets/lgtrans.png | 28725 | `85bb999e3a059b8686f0b18df73636242976531b5991c2d3ca395d7dd6d6b12e` |
| `theme:quand-le-soleil-se-couche` | `header-logo.png` | install/local/theme-lab/publication/themes/quand-le-soleil-se-couche/assets/header-logo.png | 368742 | `e242245d05519a8b2b8d672837f580ce483ded9691f8f14c1c7653fc4c2a336a` |
| `theme:quand-le-soleil-se-couche` | `body_bg_grey.png` | install/local/theme-lab/publication/themes/quand-le-soleil-se-couche/assets/body_bg_grey.png | 4099 | `bec371b36d3f250ca4b45a03ab46d6a31a5536481ba334cd4ec06eb985db7b0a` |
| `theme:redtape` | `black-highlighter-logo.svg` | install/local/theme-lab/ports/redtape/page-assets/black-highlighter-logo.svg | 6615 | `4cd40e7d6111296c9f4c6d066f63ef5b01301df18358889677cd182d76bfe593` |
| `theme:redtape` | `newtempest.png` | install/local/theme-lab/ports/redtape/page-assets/newtempest.png | 224475 | `1a1be495a9cf1908e6ee84146afdbcea551d917185cd757b79188dc3dd82ebea` |
| `theme:redtape` | `redtapeexample.png` | install/local/theme-lab/ports/redtape/page-assets/redtapeexample.png | 1410267 | `d8a7b428d6d94523681d22f4955e71e415f8a2347e0b2a58972a254367b4a6f5` |
| `theme:scp-offices-theme` | `black-highlighter-logo.svg` | install/local/theme-lab/ports/scp-offices-theme/page-assets/black-highlighter-logo.svg | 6615 | `4cd40e7d6111296c9f4c6d066f63ef5b01301df18358889677cd182d76bfe593` |
| `theme:scp-offices-theme` | `scpoffices_logo.svg` | install/local/theme-lab/ports/scp-offices-theme/page-assets/scpoffices_logo.svg | 9665 | `83529fbd5981bfa3e339b2487469def8c31b242e89154f5af95a7798e01b6706` |
| `theme:wikifot` | `table.png` | install/local/theme-lab/ports/wikifot/page-assets/table.png | 17211 | `61d58db78f6aec50335ca228add57a43332a69a01078beb3235b39645452057a` |

## Dependency / publication order ledger

この19-edge ledgerはpublish-before orderingおよびactionable cross-page dependency/targeted scenarioを記録し、通常include全体ではありません。通常includeは`dependency-graph.json`と各package dependency-input/source-includes manifestにあります。

| From | To | Relation |
|---|---|---|
| `component:betterfootnotes` | `theme:basalt` | `publish-before` |
| `component:betterfootnotes` | `theme:foxtrot` | `publish-before` |
| `component:betterfootnotes` | `theme:flopstyle-dark` | `publish-before` |
| `component:fade-in` | `theme:foxtrot` | `publish-before` |
| `component:fade-in` | `theme:flopstyle-dark` | `publish-before` |
| `component:sigma-plus` | `theme:al-slop` | `publish-before` |
| `component:sigma-plus` | `theme:space` | `publish-before` |
| `component:license-box-backend` | `theme:al-slop` | `runtime-include` (rev9) |
| `component:interwiki-style` | `theme:inkblot` | `runtime-include` (rev6) |
| `component:collapsible-sidebar` | `theme:black-highlighter-theme` | `targeted-option-scenario` |
| `component:centered-header-bhl+component:toggle-sidebar-bhl+component:bhl-dark-sidebar` | `theme:black-highlighter-theme` | `targeted-option-scenario` |
| `theme:flopstyle-dark` | `component:croqstyle` | `intentional-shared-dependency` |
| `theme:flopstyle-dark` | `component:text-style` | `intentional-shared-dependency` |
| `component:centered-header-bhl` | `theme:black-highlighter-theme` | `targeted-option-scenario` |
| `component:toggle-sidebar-bhl` | `theme:black-highlighter-theme` | `targeted-option-scenario` |
| `component:bhl-dark-sidebar` | `theme:black-highlighter-theme` | `targeted-option-scenario` |
| `fragment:collapsible-sidebar-bhl` | `theme:black-highlighter-theme` | `targeted-option-scenario` |
| `component:bhl-dark-sidebar` | `theme:black-highlighter-theme` | `publish-before` |
| `component:bhl-dark-sidebar` | `theme:extra-black-highlighter-theme` | `publish-before` |

- Sigma+ (`component:sigma-plus`)を作成し、Al Slop/Spaceより先に公開。Al Slopはlive SCP-JP `component:license-box-backend` rev9を再利用。
- InkblotはSCP-JP `component:interwiki-style` rev6へ切り替え済み。Croqstyleはcurrent sourceから除外。Spaceのlegacy license dependencyも除外。
- Flopstyle Darkは`component:croqstyle`と`component:text-style`のintentional cross-wiki dependenciesを維持。
- BHL toggle-sidebar rev3は`reuse-existing`でupdate sourceなし。BHL dark-sidebarはrev2を基点にしたupdate。Collapsible optionはcomponent rev4とchild fragment rev5を使う別scenario。
- Quand rev2は既存page updateでheader-logo.pngとbody_bg_grey.pngをupload。Dear Dictatorは新規source-only page。

