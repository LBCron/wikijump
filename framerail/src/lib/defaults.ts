const defaults = {
  fallbackLocale: "en",
  translateKeys: {
    "error": {},
    "close": {},

    "footer-powered-by": {},
    "terms-conditions": {},
    "privacy": {},
    "docs": {},
    "security": {},
    "footer-license-unless": {},

    "spinny-label.active": {},
    "spinny-label.error": {},
    "spinny-label.success": {},
    "spinny-label.warning": {},
    "message-loading": {},

    "field-required": {},
    "hold-to-show-password": {}
  },
  translateStripKeys: ["footer-license-unless"],
  page: {
    history: {
      revisionNumber: -1,
      limit: 20
    }
  }
}

export default defaults
