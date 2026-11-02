// Measure the top edge occupied by fixed navigation controls before scrolling
// a newly opened inline pane into view. Some theme controls are anchored below
// a reserved masthead rather than at y=0, and can also inherit fixed positioning
// from an ancestor.
export function topFixedNavigationInset() {
  const controls = new Set();
  for (const target of document.querySelectorAll('.mobile-top-bar, #top-bar, .open-menu, .open-menu a')) {
    for (let element = target; element && element !== document.body; element = element.parentElement) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (rect.top >= Math.min(96, innerHeight * 0.2) || rect.bottom <= 0 || rect.width <= 0 || rect.height <= 0) continue;
      // Some imported themes keep the hamburger itself absolutely positioned
      // in a bar that remains at the viewport top. It still covers content
      // after an inline action pane scrolls into view, even though none of its
      // ancestors reports fixed/sticky positioning. Measure that visible menu
      // affordance directly; ordinary header-flow controls have scrolled away
      // by the time an action pane is revealed and are therefore ignored.
      const isMenuControl = element === target && (target.matches?.('.open-menu, .open-menu a') ?? false);
      if (style.position !== 'fixed' && style.position !== 'sticky' && !isMenuControl) continue;
      controls.add(element);
    }
  }
  return [...controls].reduce((bottom, element) => Math.max(bottom, element.getBoundingClientRect().bottom), 0);
}
