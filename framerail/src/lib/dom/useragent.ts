/* eslint-disable @typescript-eslint/no-namespace */

export namespace UserAgent {
  export let mouseX = 0
  export let mouseY = 0
  export let scroll = 0
  export const isMobile = /Mobi|Android/i.test(navigator.userAgent)


  window.addEventListener("mousemove", (evt) => {
    mouseX = evt.clientX / window.innerWidth
    mouseY = evt.clientY / window.innerHeight
  })

  window.addEventListener("scroll", () => {
    scroll =
      document.documentElement.scrollTop /
      (document.body.scrollHeight - window.innerHeight)
  })
}
