<script lang="ts">
  import { resolve } from "$app/paths"

  let {
    siteName,
    body,
    loginLabels,
    accountLabels,
    sessionUserName
  }: {
    siteName: string
    body: string
    loginLabels: { createAccount: string; or: string; signIn: string }
    accountLabels?: { signOut: string }
    sessionUserName?: string | null
  } = $props()
</script>

<!--
  Live Wikidot's saved-page `[[module ManageSite]]` view replaces the whole
  page with the site-manager document: the site theme, page title and page
  text all disappear and the manager scaffold is served in the admin-panel
  chrome. The deepwell page view supplies the manager body (anonymous and
  non-administrator states are the login/denial scaffold) and sets
  `manage_site_takeover`; this component is the admin-panel shell.
-->
{@html '<a name="page-top"></a>'}
<div id="header" class="navbar navbar-fixed-top">
  <div class="navbar-inner">
    <div class="container">
      <div class="pull-left wikidot-logo hidden-phone">
        <img
          src="/common--images/top-bar-logo.png"
          class="wikidot-logo"
          alt="wikidot logo"
        />
      </div>
      <div class="pull-left title">
        <a href={resolve("/")}><span class="project-name">{siteName}</span></a><br />
        <span class="admin-panel">Admin Panel</span>
      </div>
      {#if sessionUserName}
        <div id="login-status" class="pull-right btn-group">
          <a id="my-account" class="btn" href={resolve("-/user")}>
            {sessionUserName}
          </a>
          <a class="btn" href={resolve("-/logout")}>
            {accountLabels?.signOut ?? "Sign out"}
          </a>
        </div>
      {:else}
        <div id="login-status" class="pull-right btn-group">
          <a class="login-status-create-account btn" href={resolve("-/register")}>
            {loginLabels.createAccount}
          </a>
          <span>{loginLabels.or}</span>
          <a class="login-status-sign-in btn btn-primary" href={resolve("-/login")}>
            {loginLabels.signIn}
          </a>
        </div>
      {/if}
    </div>
  </div>
</div>
<div class="container">
  <div class="row">
    {@html body}
  </div>
</div>
