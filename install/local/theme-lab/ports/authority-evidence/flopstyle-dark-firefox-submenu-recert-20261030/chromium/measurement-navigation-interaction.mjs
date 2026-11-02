export async function activateNavigationControl(page, anchor, submenu) {
  if (await hasRenderedSubmenuGeometry(submenu)) return;
  const href=await anchor.getAttribute('href');
  const controlGeometry = () => anchor.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const inViewport = rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
    if (!inViewport) return {inViewport: false, reachable: false};
    const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)));
    return {inViewport: true, reachable: !!hit && (hit === element || element.contains(hit))};
  });
  let geometry=await controlGeometry();
  if (!geometry.inViewport) throw new Error('navigation parent control is outside viewport');
  // A prior viewport/style transition can leave the old drawer over the
  // control for a few frames. Wait for real hit-test reachability; never
  // bypass an overlay or certify a control that remains occluded.
  const reachabilityDeadline=Date.now()+3000;
  while(!geometry.reachable&&geometry.inViewport&&Date.now()<reachabilityDeadline){
    await page.waitForTimeout(50);
    geometry=await controlGeometry();
  }
  if (!geometry.inViewport) throw new Error('navigation parent control is outside viewport');
  if (!geometry.reachable) throw new Error('navigation parent control is occluded');
  if (href === 'javascript:;' && geometry.reachable) {
    await anchor.hover({timeout: 600});
    const hoverDeadline=Date.now()+500;
    while(Date.now()<hoverDeadline){if(await hasRenderedSubmenuGeometry(submenu))return;await page.waitForTimeout(50)}
  } else {
    await anchor.click();
  }
  const deadline=Date.now()+3000;
  while(Date.now()<deadline){if(await hasRenderedSubmenuGeometry(submenu))return;await page.waitForTimeout(50)}
  throw new Error('source navigation action did not produce rendered submenu geometry');
}

export async function hasRenderedSubmenuGeometry(submenu){return submenu.evaluate(element=>{
  const style=getComputedStyle(element),rect=element.getBoundingClientRect();
  return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0&&rect.width>0&&rect.height>0&&rect.right>0&&rect.bottom>0&&rect.left<innerWidth&&rect.top<innerHeight;
})}

export async function expandMobileTopSubmenu(page) {
  const item = page.locator('.mobile-top-bar > ul > li').filter({has: page.locator(':scope > ul')}).first();
  if (!(await item.count())) throw new Error('mobile top navigation submenu fixture is absent');
  const anchor = item.locator(':scope > a').first(), submenu = item.locator(':scope > ul');
  if (!(await anchor.count()) || !(await anchor.isVisible())) throw new Error('mobile top navigation parent control is absent');
  await activateNavigationControl(page, anchor, submenu);
}

export async function expandTabletTopNavigation(page) {
  const desktop = page.locator('#top-bar .top-bar');
  const info = await desktop.evaluate(root => {
    const visible = element => {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
    };
    for (const item of root.querySelectorAll('li')) {
      const anchor = item.querySelector(':scope > a'), submenu = item.querySelector(':scope > ul');
      if (anchor && submenu && visible(anchor)) return {desktop: true, expanded: visible(submenu)};
    }
    return {desktop: [...root.querySelectorAll('a')].some(visible)};
  });
  if (info.desktop) {
    if (info.expanded) return;
    const item = desktop.locator('li').filter({has: page.locator(':scope > ul')}).filter({has: page.locator(':scope > a')}).first();
    const anchor = item.locator(':scope > a').first(), submenu = item.locator(':scope > ul');
    if (!(await anchor.count())) throw new Error('visible tablet desktop navigation has no submenu control');
    await activateNavigationControl(page, anchor, submenu);
    return;
  }
  const item = page.locator('.mobile-top-bar > ul > li').filter({has: page.locator(':scope > ul')}).first();
  if (!(await item.count()) || !(await item.locator(':scope > a').isVisible())) throw new Error('no tablet top-navigation control is visible');
  await activateNavigationControl(page, item.locator(':scope > a').first(), item.locator(':scope > ul'));
}
