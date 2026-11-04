export const deepwellRpcAuthorization = (
  env: Record<string, string | undefined> = process.env
): string => {
  const token = env.DEEPWELL_RPC_TOKEN
  if (!/^[0-9a-f]{64}$/u.test(token ?? "")) {
    throw new Error(
      "DEEPWELL_RPC_TOKEN must be exactly 64 lowercase hexadecimal characters"
    )
  }
  return `Bearer ${token}`
}
