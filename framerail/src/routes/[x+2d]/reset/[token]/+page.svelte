<script lang="ts">
  import { resolve } from "$app/paths"
  import { errorPopupState } from "$lib/layout/stores.svelte"
  import { superForm } from "sveltekit-superforms"
  import { untrack } from "svelte"

  import type { PageProps } from "./$types"

  let { data, form: actionData }: PageProps = $props()

  let grant = $derived<string | null>(
    typeof actionData?.grant === "string" ? actionData.grant : null
  )
  let done = $derived(actionData?.done === true)

  const failToPopup = (result: { type: string; data?: unknown }) => {
    if (result.type === "failure" && result.data) {
      errorPopupState.current = {
        state: true,
        message: (result.data as { message?: string }).message ?? null,
        data: (result.data as { data?: unknown }).data ?? null
      }
    }
  }

  const { form: redeemForm, enhance: redeemEnhance } = superForm(
    untrack(() => data.tokenForm),
    {
      onResult: async ({ result }) => {
        if (result.type === "failure" && result.data) {
          failToPopup(result)
        }
      }
    }
  )

  const { form: setPasswordForm, enhance: setPasswordEnhance } = superForm(
    untrack(() => data.resetForm),
    {
      onResult: async ({ result }) => {
        if (result.type === "failure" && result.data) {
          failToPopup(result)
        }
      }
    }
  )
</script>

<h1>{data.internationalization?.["password-recovery"]}</h1>
{#if done}
  <p role="status" class="auth-notice">
    <a href={resolve("-/login")}>{data.internationalization?.login}</a>
  </p>
{:else if grant}
  <form
    id="reset-password"
    class="login-form"
    method="POST"
    action="?/setPassword"
    use:setPasswordEnhance
  >
    <input name="grant" type="hidden" value={grant} />
    <label class="visually-hidden" for="reset-password-new">
      {data.internationalization?.password}
    </label>
    <input
      id="reset-password-new"
      name="password"
      class="auth-password"
      autocomplete="new-password"
      placeholder={data.internationalization?.password}
      type="password"
      bind:value={$setPasswordForm.password}
    />
    <label class="visually-hidden" for="reset-password-confirm">
      {data.internationalization?.["confirm-password"]}
    </label>
    <input
      id="reset-password-confirm"
      name="confirmPassword"
      class="auth-password"
      autocomplete="new-password"
      placeholder={data.internationalization?.["confirm-password"]}
      type="password"
      bind:value={$setPasswordForm.confirmPassword}
    />
    <div class="action-row auth-actions">
      <button class="action-button auth-button button-login clickable" type="submit">
        {data.internationalization?.["reset-password"]}
      </button>
    </div>
  </form>
{:else}
  <form
    id="reset-link"
    class="login-form"
    method="POST"
    action="?/redeem"
    use:redeemEnhance
  >
    <input name="token" type="hidden" bind:value={$redeemForm.token} />
    <div class="action-row auth-actions">
      <button class="action-button auth-button button-login clickable" type="submit">
        {data.internationalization?.["reset-password"]}
      </button>
    </div>
  </form>
{/if}

<style lang="scss">
  .login-form {
    display: flex;
    flex-direction: column;
    gap: 1em;
    align-items: center;
    justify-content: center;

    .action-row {
      justify-content: center;
    }

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      white-space: nowrap;
      border: 0;
      clip: rect(0, 0, 0, 0);
    }
  }

  .auth-notice {
    text-align: center;
  }
</style>
