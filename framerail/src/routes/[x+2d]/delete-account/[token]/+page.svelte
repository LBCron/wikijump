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
        failToPopup(result)
      }
    }
  )

  const { form: confirmForm, enhance: confirmEnhance } = superForm(
    untrack(() => data.deleteForm),
    {
      onResult: async ({ result }) => {
        failToPopup(result)
      }
    }
  )
</script>

<!-- LOCAL DEFAULT pending Wikidot evidence: exact delete-flow copy is not evidenced. -->
<h1>Delete Account</h1>
{#if done}
  <p role="status" class="auth-notice">
    Your account has been deleted. You have been signed out.
    <a href={resolve("/-/login", {})}>{data.internationalization?.login}</a>
  </p>
{:else if grant}
  <p class="auth-notice">
    A deletion was requested for your account. Confirm with your password to permanently
    delete it. Your wikis will stay hosted.
  </p>
  <form
    id="confirm-delete-account"
    class="login-form"
    method="POST"
    action="?/confirm"
    use:confirmEnhance
  >
    <input name="grant" type="hidden" value={grant} />
    <label class="visually-hidden" for="confirm-delete-password">
      {data.internationalization?.password}
    </label>
    <input
      id="confirm-delete-password"
      name="password"
      class="auth-password"
      autocomplete="current-password"
      placeholder={data.internationalization?.password}
      type="password"
      bind:value={$confirmForm.password}
    />
    <label class="visually-hidden" for="confirm-delete-confirm">
      {data.internationalization?.["confirm-password"]}
    </label>
    <input
      id="confirm-delete-confirm"
      name="confirmPassword"
      class="auth-password"
      autocomplete="current-password"
      placeholder={data.internationalization?.["confirm-password"]}
      type="password"
      bind:value={$confirmForm.confirmPassword}
    />
    <div class="action-row auth-actions">
      <button class="action-button auth-button button-login clickable" type="submit">
        Delete My Account
      </button>
    </div>
  </form>
{:else}
  <p class="auth-notice">
    A deletion was requested for your account. Continue to confirm it.
  </p>
  <form
    id="redeem-delete-link"
    class="login-form"
    method="POST"
    action="?/redeem"
    use:redeemEnhance
  >
    <input name="token" type="hidden" bind:value={$redeemForm.token} />
    <div class="action-row auth-actions">
      <button class="action-button auth-button button-login clickable" type="submit">
        {data.internationalization?.send}
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
