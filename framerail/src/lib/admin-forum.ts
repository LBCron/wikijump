export const discussionFormValues = (category: {
  category_id: number
  slug: string
  per_page_discussion: boolean | null
}): {
  categoryId: number
  state: "default" | "enable" | "disable"
} => ({
  categoryId: category.category_id,
  state:
    category.per_page_discussion === null && category.slug !== "_default"
      ? "default"
      : category.per_page_discussion
        ? "enable"
        : "disable"
})

export const discussionUpdateValue = (form: {
  state: "default" | "enable" | "disable"
}): boolean | null => {
  if (form.state === "default") return null
  return form.state === "enable"
}
