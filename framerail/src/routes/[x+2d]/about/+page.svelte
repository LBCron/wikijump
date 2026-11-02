<script lang="ts">
  import type { PageProps } from "./$types"

  let { data }: PageProps = $props()
</script>

<h1>{data.internationalization?.["about-info"]}</h1>

<p class="platform-blurb">{data.internationalization?.["about-info.blurb"]}</p>

<p class="platform-links">
  <a href={data.blog_url} rel="external"
    >{data.internationalization?.["about-info.blog"]}</a
  >
</p>

<table class="platform-info">
  <tbody>
    <tr class="info-header">
      <th colspan="2">{data.internationalization?.["about-info.backend"]}</th>
    </tr>
    <tr class="info-attribute-row">
      <th class="info-attribute-name"
        >{data.internationalization?.["about-info.package-name"]}</th
      >
      <td class="info-attribute-value">{data.backend.package.name}</td>
    </tr>
    <tr class="info-attribute-row">
      <th class="info-attribute-name"
        >{data.internationalization?.["about-info.package-description"]}</th
      >
      <td class="info-attribute-value">{data.backend.package.description}</td>
    </tr>
    <tr class="info-attribute-row">
      <th class="info-attribute-name"
        >{data.internationalization?.["about-info.package-license"]}</th
      >
      <td class="info-attribute-value">{data.backend.package.license}</td>
    </tr>
    <tr class="info-attribute-row">
      <th class="info-attribute-name"
        >{data.internationalization?.["about-info.package-repository"]}</th
      >
      <td class="info-attribute-value">
        <a href={data.backend.package.repository} rel="external">
          {data.backend.package.repository}
        </a>
      </td>
    </tr>
    <tr class="info-attribute-row">
      <th class="info-attribute-name"
        >{data.internationalization?.["about-info.package-version"]}</th
      >
      <td class="info-attribute-value">{data.backend.package.version}</td>
    </tr>
    <tr class="info-attribute-row">
      <th class="info-attribute-name"
        >{data.internationalization?.["about-info.rustc-version"]}</th
      >
      <td class="info-attribute-value">{data.backend.compile_info.rustc_version}</td>
    </tr>
    <tr class="info-attribute-row">
      <th class="info-attribute-name"
        >{data.internationalization?.["about-info.cargo-version"]}</th
      >
      <td class="info-attribute-value">{data.backend.compile_info.cargo_version}</td>
    </tr>
    <tr class="info-attribute-row">
      <th class="info-attribute-name"
        >{data.internationalization?.["about-info.built-at"]}</th
      >
      <td class="info-attribute-value">{data.backend.compile_info.built_at}</td>
    </tr>
    {#if data.backend.compile_info.git_commit}
      <tr class="info-attribute-row">
        <th class="info-attribute-name"
          >{data.internationalization?.["about-info.git-commit"]}</th
        >
        <td class="info-attribute-value">{data.backend.compile_info.git_commit}</td>
      </tr>
    {/if}
  </tbody>
  <tbody>
    <tr class="info-header">
      <th colspan="2">{data.internationalization?.["about-info.frontend"]}</th>
    </tr>
    <tr class="info-attribute-row">
      <th class="info-attribute-name"
        >{data.internationalization?.["about-info.package-name"]}</th
      >
      <td class="info-attribute-value">{data.frontend.name}</td>
    </tr>
    <tr class="info-attribute-row">
      <th class="info-attribute-name"
        >{data.internationalization?.["about-info.package-description"]}</th
      >
      <td class="info-attribute-value">{data.frontend.description}</td>
    </tr>
    <tr class="info-attribute-row">
      <th class="info-attribute-name"
        >{data.internationalization?.["about-info.package-license"]}</th
      >
      <td class="info-attribute-value">{data.frontend.license}</td>
    </tr>
    <tr class="info-attribute-row">
      <th class="info-attribute-name"
        >{data.internationalization?.["about-info.package-repository"]}</th
      >
      <td class="info-attribute-value">
        <a href={data.frontend.repository} rel="external">
          {data.frontend.repository}
        </a>
      </td>
    </tr>
    <tr class="info-attribute-row">
      <th class="info-attribute-name"
        >{data.internationalization?.["about-info.package-version"]}</th
      >
      <td class="info-attribute-value">{data.frontend.version}</td>
    </tr>
    <tr class="info-attribute-row">
      <th class="info-attribute-name"
        >{data.internationalization?.["about-info.node-version"]}</th
      >
      <td class="info-attribute-value">{data.frontend.node}</td>
    </tr>
    <tr class="info-attribute-row">
      <th class="info-attribute-name"
        >{data.internationalization?.["about-info.pnpm-version"]}</th
      >
      <td class="info-attribute-value">{data.frontend.pnpm}</td>
    </tr>
    {#if data.frontend.git_commit}
      <tr class="info-attribute-row">
        <th class="info-attribute-name"
          >{data.internationalization?.["about-info.git-commit"]}</th
        >
        <td class="info-attribute-value">{data.frontend.git_commit}</td>
      </tr>
    {/if}
  </tbody>
</table>

<style lang="scss">
  table.platform-info {
    width: 100%;
    max-width: 100%;
    table-layout: fixed;

    .info-attribute-name {
      text-align: left;
      width: 40%;
      overflow-wrap: anywhere;
    }

    .info-attribute-value {
      overflow-wrap: anywhere;
    }
  }
</style>
