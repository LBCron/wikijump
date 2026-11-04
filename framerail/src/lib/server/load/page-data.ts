export const buildPageLoadData = <TParentData, TViewData, TForms>(
  parentData: TParentData,
  viewData: TViewData,
  forms: TForms
): TParentData & TViewData & { forms: TForms } => {
  return {
    ...parentData,
    ...viewData,
    forms
  } as TParentData & TViewData & { forms: TForms }
}
