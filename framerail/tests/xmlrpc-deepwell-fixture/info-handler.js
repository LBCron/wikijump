/**
 * Backend diagnostics for the native /-/about page. The values are long on
 * purpose: the page must wrap them inside a phone-width viewport.
 *
 * @param {{ rpcRequest: any }} input
 */
export const handleInfoRpc = ({ rpcRequest }) => {
  if (rpcRequest.method !== "info") return undefined

  return {
    result: {
      package: {
        name: "deepwell-fixture-service-with-a-long-package-name",
        description: "Fixture backend used to verify the about page at phone width.",
        license: "AGPL-3.0-or-later",
        repository:
          "https://github.com/Rokurolize/wikijump/tree/develop/deepwell/fixture-diagnostics",
        version: "0.0.0-fixture.2026.10.08+unreleased-build-metadata"
      },
      compile_info: {
        rustc_version: "rustc 1.90.0-nightly (fixture build with long metadata string)",
        ftml_commit: "bcfd17dbc2bf734d29370c1b398a3386d978b874"
      }
    }
  }
}
