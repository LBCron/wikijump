<script lang="ts">
  import { goto } from "$app/navigation"
  import { resolve } from "$app/paths"
  import { page } from "$app/state"
  import { authCancelDestination, authReturnDestination } from "$lib/auth-cancel.js"
  import { errorPopupState } from "$lib/layout/stores.svelte"
  import { superForm } from "sveltekit-superforms"
  import { untrack } from "svelte"

  import type { PageProps } from "./$types"

  let { data }: PageProps = $props()

  let isLoggedIn = $derived<boolean>(data.isLoggedIn)
  let mfaSessionToken = $state<string | undefined>()
  let totpOrCode = $state("")

  const cancelLogin = async () => {
    await goto(resolve(authCancelDestination(), {}), { replaceState: true })
  }

  const { form, enhance } = superForm(
    untrack(() => data.loginForm),
    {
      onResult: async ({ result }) => {
        if (result.type === "success" && result.data) {
          if (result.data.needsMfa && result.data.session_token) {
            mfaSessionToken = result.data.session_token
            isLoggedIn = false
            return
          }

          mfaSessionToken = undefined
          isLoggedIn = result.data.isLoggedIn
          if (isLoggedIn) {
            // eslint-disable-next-line svelte/no-navigation-without-resolve -- return target is a validated same-site path
            await goto(authReturnDestination(page.url), {
              replaceState: true,
              invalidateAll: true
            })
          }
          return
        }

        if (result.type === "failure" && result.data) {
          errorPopupState.current = {
            state: true,
            message: result.data?.message,
            data: result.data?.data
          }
        }
      }
    }
  )
</script>

{#if isLoggedIn}
  {data.internationalization?.["login.toast"]}
{:else if mfaSessionToken}
  <form id="login-mfa" class="login-form" method="POST" use:enhance>
    <input name="mfaSessionToken" type="hidden" value={mfaSessionToken} />
    <label class="visually-hidden" for="login-mfa-code">
      {data.internationalization?.["mfa-code"]}
    </label>
    <input
      id="login-mfa-code"
      name="totpOrCode"
      class="auth-mfa-code"
      autocomplete="one-time-code"
      placeholder={data.internationalization?.["mfa-code"]}
      type="text"
      bind:value={totpOrCode}
    />
    <div class="action-row auth-actions">
      <button class="action-button auth-button button-login clickable" type="submit">
        {data.internationalization?.login}
      </button>
    </div>
  </form>
{:else}
  <form id="login" class="login-form" method="POST" use:enhance>
    <label class="visually-hidden" for="login-name-or-email">
      {data.internationalization?.["specifier"]}
    </label>
    <input
      id="login-name-or-email"
      name="nameOrEmail"
      class="auth-name-or-email"
      autocomplete="username"
      placeholder={data.internationalization?.specifier}
      type="text"
      bind:value={$form.nameOrEmail}
    />
    <label class="visually-hidden" for="login-password">
      {data.internationalization?.["password"]}
    </label>
    <input
      id="login-password"
      name="password"
      class="auth-password"
      autocomplete="current-password"
      placeholder={data.internationalization?.password}
      type="password"
      bind:value={$form.password}
    />
    <div class="action-row auth-actions">
      <button
        class="action-button auth-button button-cancel clickable"
        onclick={cancelLogin}
        type="button"
      >
        {data.internationalization?.cancel}
      </button>
      <button class="action-button auth-button button-login clickable" type="submit">
        {data.internationalization?.login}
      </button>
    </div>
  </form>
  <p class="auth-notice">
    <a href={resolve("/-/forgot", {})}>
      {data.internationalization?.["forgot-password.question"]}
    </a>
  </p>
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
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
  }

  .auth-notice {
    text-align: center;
  }
</style>
