<script lang="ts">
  import { wikidotCollapsibles } from "$lib/wikidot/wikidot-collapsibles"
  import { wikidotFooterControls } from "$lib/wikidot/wikidot-footer"
  import { wikidotMenu } from "$lib/wikidot/wikidot-menus"

  import type { HTMLAnchorAttributes } from "svelte/elements"

  const pageTopAnchorAttributes: HTMLAnchorAttributes & { name: string } = {
    name: "page-top"
  }

  let {
    header,
    topBar,
    loginStatus,
    sideBar,
    content,
    footer,
    footerStyle = undefined,
    footerLocale = "en",
    footerAnonymous = false,
    license,
    bottomToolbar,
    showCloseMenu = true
  } = $props()
</script>

<div id="skrollr-body" data-sveltekit-reload use:wikidotCollapsibles>
  <a {...pageTopAnchorAttributes}></a>
  <div id="container-wrap-wrap">
    <div id="container-wrap">
      <div id="container">
        <div id="header">
          {@render header?.()}
          <div id="top-bar" use:wikidotMenu={{ list: true }}>
            {@render topBar?.()}
          </div>
          {@render loginStatus?.()}
          <div id="header-extra-div-1"><span></span></div>
          <div id="header-extra-div-2"><span></span></div>
          <div id="header-extra-div-3"><span></span></div>
        </div>
        <div id="content-wrap">
          <div id="side-bar" use:wikidotMenu>
            {@render sideBar?.()}
            {#if showCloseMenu}
              <a class="close-menu" href="##">
                <br />
                <img
                  alt="black.png"
                  class="image"
                  src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAMSURBVBhXY2BgYAAAAAQAAVzN/2kAAAAASUVORK5CYII="
                  style:z-index="-1"
                  style:opacity="0.3"
                />
                <br />
              </a>
            {/if}
          </div>
          <div id="main-content">
            <div id="action-area-top"></div>
            {@render content?.()}
          </div>
        </div>
        <div
          id="footer"
          style={footerStyle}
          use:wikidotFooterControls={{ locale: footerLocale, anonymous: footerAnonymous }}
        >
          {@render footer?.()}
        </div>
        <div id="license-area" class="license-area">
          {@render license?.()}
        </div>
        <div id="extrac-div-1"><span></span></div>
        <div id="extrac-div-2"><span></span></div>
        <div id="extrac-div-3"><span></span></div>
        {@render bottomToolbar?.()}
      </div>
      <div id="extra-div-1"><span></span></div>
      <div id="extra-div-2"><span></span></div>
      <div id="extra-div-3"><span></span></div>
      <div id="extra-div-4"><span></span></div>
      <div id="extra-div-5"><span></span></div>
      <div id="extra-div-6"><span></span></div>
    </div>
  </div>
</div>
<div id="dummy-ondomready-block" style:display="none"></div>

<!-- Ignoring the styling as being a theme it will inevitably style other elements in the entire layout -->
<!-- svelte-ignore css_unused_selector -->
<style global lang="scss">
  $tablet-max-width: 767px;

  :root {
    --text: #111;
    --background: #fff;
    --border: #0006;
    --mild-text: #f0f0f0;
    --accent: #0066cc;
    --error: #b42d0a;
    --col-accent-1: #19a9ff;
    --col-accent-2: #0068b5;
  }

  .clickable {
    cursor: pointer;
    user-select: none;

    &:disabled {
      cursor: auto;
    }
  }

  .hidden {
    display: none;
  }

  #page-content .math-equation {
    display: block;
  }

  #login-status:hover > #account-options,
  #login-status:focus-within > #account-options {
    display: block;
  }

  details.collapsible-block:not([open]) .collapsible-block-unfolded-link {
    display: none;
  }

  details.collapsible-block[open]
    > summary
    .collapsible-block-link:not(.collapsible-block-unfolded-link) {
    display: none;
  }

  @media (prefers-color-scheme: light) {
    :root {
      --text: #111;
      --background: #fff;
      --border: #0006;
      --mild-text: #f0f0f0;
      --accent: #0066cc;
    }
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --text: #b6c2cf;
      --background: #222;
      --border: #b6c2cf;
      --mild-text: #bbb;
      --accent: #44aaff;
    }
  }

  @media (max-width: $tablet-max-width) {
    .header {
      height: initial;
    }
  }
</style>
