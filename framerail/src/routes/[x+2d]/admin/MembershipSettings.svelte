<script lang="ts">
  import { invalidateAll } from "$app/navigation"
  import { errorPopupState } from "$lib/layout/stores.svelte"
  import { untrack } from "svelte"
  import { superForm } from "sveltekit-superforms"

  import type { PageProps } from "./$types"

  let { data }: { data: PageProps["data"] } = $props()
  const { form, enhance } = superForm(
    untrack(() => data.membershipForm),
    {
      dataType: "json",
      resetForm: false,
      onSubmit: async ({ jsonData }) => {
        jsonData({
          ...$form,
          siteId: data.site.site_id,
          expectedSettingsRevision: data.site.settings_revision
        })
      },
      onResult: async ({ result }) => {
        if (result.type === "success" && result.data?.res) await invalidateAll()
        if (result.type === "failure" && result.data) {
          errorPopupState.current = {
            state: true,
            message: result.data.message,
            data: result.data.data
          }
        }
      }
    }
  )

  $effect(() => {
    $form.siteId = data.site.site_id
    $form.expectedSettingsRevision = data.site.settings_revision
    $form.applicationEnabled = data.site_settings.membership.application_enabled
    $form.passwordEnabled = data.site_settings.membership.password_enabled
    $form.password = ""
  })
</script>

<section id="wikidot-membership-settings" class="admin-section">
  <div class="page-header"><h2>Membership</h2></div>
  <form class="form form-horizontal" action="?/membership" method="POST" use:enhance>
    <div class="control-group">
      <label class="control-label" for="membership-application-enabled"
        >Allow membership applications</label
      >
      <div class="controls">
        <input
          id="membership-application-enabled"
          class="checkbox"
          type="checkbox"
          bind:checked={$form.applicationEnabled}
        />
      </div>
    </div>
    <div class="control-group">
      <label class="control-label" for="membership-password-enabled"
        >Allow membership by password</label
      >
      <div class="controls">
        <input
          id="membership-password-enabled"
          class="checkbox"
          type="checkbox"
          bind:checked={$form.passwordEnabled}
        />
      </div>
    </div>
    <div class="control-group">
      <label class="control-label" for="membership-password">Membership password</label>
      <div class="controls">
        <input
          id="membership-password"
          class="text"
          autocomplete="new-password"
          maxlength="50"
          type="password"
          bind:value={$form.password}
        />
        <div class="sub">
          {#if data.site_settings.membership.password_configured}
            Leave blank to keep the configured password.
          {:else}
            Configure a password before enabling password membership.
          {/if}
        </div>
      </div>
    </div>
    <button class="btn btn-primary" type="submit">Save changes</button>
  </form>

  <div id="membership-applications">
    <h3>Current Member Applications:</h3>
    {#if data.membershipApplications.length > 0}
      {#each data.membershipApplications as application (application.user_id)}
        <h4>Membership application from {application.user_name}</h4>
        <table class="form alignleft">
          <tbody>
            {#if application.comment !== ""}
              <tr>
                <td>Application text:</td>
                <td>{application.comment}</td>
              </tr>
            {/if}
            {#if application.status === "pending"}
              <tr>
                <td>Options:</td>
                <td class="application-actions">
                  <form action="?/membershipReview" method="POST">
                    <input name="siteId" type="hidden" value={data.site.site_id} />
                    <input name="userId" type="hidden" value={application.user_id} />
                    <input name="reply" type="hidden" value="" />
                    <button
                      name="decision"
                      class="link-button"
                      type="submit"
                      value="accept">accept</button
                    >
                    <span> or </span>
                    <button
                      name="decision"
                      class="link-button"
                      type="submit"
                      value="decline">decline</button
                    >
                  </form>
                </td>
              </tr>
            {:else}
              <tr>
                <td>Status:</td>
                <td>{application.status}</td>
              </tr>
            {/if}
          </tbody>
        </table>
      {/each}
    {:else}
      <p>Sorry, no applications. Not a single soul wants to join this Site... ;-)</p>
    {/if}
  </div>
</section>

<style>
  #membership-applications {
    margin-top: 2rem;
  }

  .application-actions form {
    display: inline;
  }

  .link-button {
    padding: 0;
    font: inherit;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
    background: none;
    border: 0;
  }
</style>
