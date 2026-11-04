export const WIKIDOT_STYLE_FRAME_SCRIPT = `
      "use strict";
      window.isStyleFrame = true;
      Array.prototype.slice.call(parent).forEach(function (frame) {
        try {
          if (frame.isInterwikiFrame) {
            frame.requestStyleChange(location.search);
          }
        } catch (error) {
          if (!(error instanceof DOMException)) {
            throw error;
          }
        }
      });
    `

export const buildWikidotStyleFrameHtml = (): string => `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Local Wikidot style frame</title>
    <script>${WIKIDOT_STYLE_FRAME_SCRIPT}</script>
  </head>
</html>
`
