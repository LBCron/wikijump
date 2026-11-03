export async function acquirePageEditLease(call, page) {
  const acquired = await call("page_edit_lock_acquire", {
    page,
    mode: "page",
    section_index: null,
  });
  const grant = acquired?.grant ?? null;
  if (!grant) {
    throw new Error(
      `page_edit_lock_acquire did not grant an edit lease for ${String(page)}: ${JSON.stringify(acquired?.conflicts ?? [])}`,
    );
  }
  return {
    lock_id: grant.lock_id,
    ["lock_secret"]: grant["lock_secret"],
    mode: "page",
    section_index: null,
  };
}

export async function releasePageEditLease(call, page, lease) {
  await call("page_edit_lock_release", {
    page,
    lock_id: lease.lock_id,
    ["lock_secret"]: lease["lock_secret"],
  });
}

export async function leasedPageEdit(call, params) {
  const lease = await acquirePageEditLease(call, params.page);
  try {
    return await call("page_edit", { ...params, lease });
  } finally {
    await releasePageEditLease(call, params.page, lease).catch(() => {});
  }
}
