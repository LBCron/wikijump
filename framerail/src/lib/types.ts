import type { Locales } from "../types"
export type Optional<T> = T | undefined
export type Nullable<T> = T | null
export type JsonValue =
  string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[]
export type TranslateKeys = {
  [P in keyof Locales]?: Record<string, string | number>
}
export type TranslatedKeys = Partial<Locales>

export interface SiteModel {
  site_id: number
  created_at: string
  updated_at: Nullable<string>
  deleted_at: Nullable<string>
  from_wikidot: boolean
  slug: string
  name: string
  tagline: string
  description: string
  locale: string
  default_page: string
  top_bar_page: Nullable<string>
  side_bar_page: Nullable<string>
  preferred_domain: Nullable<string>
  layout: Nullable<Layout>
  license: License
  forum_max_nest_level: number
  favicon_source: Nullable<string>
  ios_icon_source: Nullable<string>
  windows_tile_source: Nullable<string>
  settings_revision: number
  welcome_page: string
  google_analytics_enabled: boolean
  google_analytics_profile: Nullable<string>
  show_top_toolbar: boolean
  show_bottom_toolbar: boolean
  promote_on_other_sites: boolean
  educational: boolean
}

export interface PageCategoryModel {
  category_id: number
  created_at: string
  updated_at: Nullable<string>
  site_id: number
  slug: string
  layout: Nullable<Layout>
  top_bar_page: Nullable<string>
  side_bar_page: Nullable<string>
  template_page_id: Nullable<number>
  license: Nullable<string>
  license_other: Nullable<string>
  rating_enabled: Nullable<boolean>
  rating_permission: Nullable<PageRatingPermission>
  rating_visibility: Nullable<PageRatingVisibility>
  rating_type: Nullable<PageRatingType>
  per_page_discussion: Nullable<boolean>
  settings_revision: number
  theme_kind: "inherit" | "built_in" | "external" | "custom"
  theme_builtin_id: Nullable<number>
  theme_external_url: Nullable<string>
  theme_custom_css: Nullable<string>
  autonumber_enabled: boolean
  autonumber_next: number
}

export interface SiteSettings {
  revision: number
  welcome_page: string
  google_analytics: {
    enabled: boolean
    profile: Nullable<string>
  }
  toolbars: {
    top: boolean
    bottom: boolean
    promote: boolean
  }
  membership: {
    application_enabled: boolean
    password_enabled: boolean
    password_configured: boolean
  }
}

export type ThemeSetting =
  | { type: "inherit" }
  | { type: "built_in"; id: number }
  | { type: "external"; url: string }
  | { type: "custom"; css: string }

export type PageRatingPermission = "registered" | "members"
export type PageRatingVisibility = "visible" | "anonymous"
export type PageRatingType = "plus" | "plus_minus" | "stars"

export interface SessionModel {
  session_token: string
  user_id: number
  created_at: string
  expires_at: string
  ip_address: string
  user_agent: string
  restricted: boolean
}

export interface UserModel {
  user_id: number
  user_type: UserType
  created_at: string
  updated_at: Nullable<string>
  deleted_at: Nullable<string>
  from_wikidot: boolean
  name: string
  slug: string
  name_changes_left: number
  last_name_change_added_at: string
  last_renamed_at: Nullable<string>
  email: string
  email_verified_at: Nullable<string>
  email_validation_info: Nullable<JsonValue>
  email_validation_at: Nullable<string>
  password: string
  multi_factor_secret: Nullable<string>
  multi_factor_recovery_codes: Nullable<string[]>
  locales: string[]
  avatar_s3_hash: Nullable<number[]>
  forum_signature: Nullable<string>
  real_name: Nullable<string>
  gender: Nullable<string>
  birthday: Nullable<string>
  location: Nullable<string>
  biography: Nullable<string>
  website: Nullable<string>
  user_page: Nullable<string>
}

export interface WikidotUserModel {
  user_id: number
  user_type: "wikidot"
  created_at: string
  fetched_at: string
  is_deleted: boolean
  name: Nullable<string>
  slug: Nullable<string>
  avatar_s3_hash: Nullable<number[]>
  real_name: Nullable<string>
  gender: Nullable<string>
  birthday: Nullable<string>
  location: Nullable<string>
  biography: Nullable<string>
  website: Nullable<string>
  karma: number
  is_pro: boolean
}

export interface PageModel {
  page_id: number
  created_at: string
  updated_at: Nullable<string>
  deleted_at: Nullable<string>
  from_wikidot: boolean
  site_id: number
  latest_revision_id: Nullable<number>
  page_category_id: number
  slug: string
  discussion_thread_id: Nullable<number>
  layout: Nullable<Layout>
}

export interface PageRevisionModel {
  revision_id: number
  revision_type: PageRevisionType
  created_at: string
  updated_at: Nullable<string>
  revision_number: number
  page_id: number
  site_id: number
  user_id: number
  from_wikidot: boolean
  changes: string[]
  wikitext_hash: number[]
  compiled_body_html_hash: number[]
  compiled_top_bar_html_hash: Nullable<number[]>
  compiled_side_bar_html_hash: Nullable<number[]>
  compiled_at: string
  compiled_generator: string
  comments: string
  hidden: string[]
  title: string
  alt_title: Nullable<string>
  slug: string
  tags: string[]
}

export interface FileRevisionModel {
  revision_id: number
  revision_type: FileRevisionType
  created_at: string
  revision_number: number
  file_id: number
  page_id: number
  site_id: number
  user_id: number
  author: Nullable<UserInfo>
  name: Nullable<string>
  s3_hash: Nullable<number[]>
  mime: Nullable<string>
  size: Nullable<number>
  changes: string[]
  comments: Nullable<string>
  hidden: string[]
}

export interface PageVoteModel {
  page_vote_id: number
  created_at: string
  deleted_at: Nullable<string>
  disabled_at: Nullable<string>
  disabled_by: Nullable<number>
  from_wikidot: boolean
  page_id: number
  user_id: number
  rating_system: "points" | "stars"
  value: number
}

export interface PageOptions {
  edit: boolean
  title: Nullable<string>
  parent: Nullable<string>
  tags: Nullable<string>
  no_redirect: boolean
  no_render: boolean
  debug: boolean
  rerender: boolean
  comments: boolean
  history: boolean
  offset: Nullable<number>
  data: string
  template: Nullable<number>
}

export interface PageAttribution {
  relation_id: number
  page_id: number
  user_id: number
  created_by: number
  created_at: string
  overwritten_by: Nullable<number>
  overwritten_at: Nullable<string>
  deleted_by: Nullable<number>
  deleted_at: Nullable<string>
  metadata: PageAttributionMetadata
}
export interface PageAttributionMetadata {
  attribution_type: PageAttributionKind
  attribution_date: string
}
export enum PageAttributionKind {
  Author = "author",
  Rewrite = "rewrite",
  Translator = "translator",
  Maintainer = "maintainer"
}

export enum Token {
  LeftBracket = "left-bracket",
  LeftBracketAnchor = "left-bracket-anchor",
  LeftBracketStar = "left-bracket-star",
  RightBracket = "right-bracket",
  LeftBlock = "left-block",
  LeftBlockEnd = "left-block-end",
  LeftBlockAnchor = "left-block-anchor",
  LeftBlockStar = "left-block-star",
  LeftMath = "left-math",
  LeftParentheses = "left-parentheses",
  RightBlock = "right-block",
  RightMath = "right-math",
  RightParentheses = "right-parentheses",
  DoubleDash = "double-dash",
  TripleDash = "triple-dash",
  DoubleTilde = "double-tilde",
  LeftDoubleAngle = "left-double-angle",
  ClearFloatBoth = "clear-float-both",
  ClearFloatLeft = "clear-float-left",
  ClearFloatRight = "clear-float-right",
  Pipe = "pipe",
  Equals = "equals",
  Colon = "colon",
  Underscore = "underscore",
  Quote = "quote",
  Heading = "heading",
  LineBreak = "line-break",
  ParagraphBreak = "paragraph-break",
  Whitespace = "whitespace",
  Bold = "bold",
  Italics = "italics",
  Underline = "underline",
  Superscript = "superscript",
  Subscript = "subscript",
  LeftMonospace = "left-monospace",
  RightMonospace = "right-monospace",
  Color = "color",
  Raw = "raw",
  LeftRaw = "left-raw",
  RightRaw = "right-raw",
  BulletItem = "bullet-item",
  NumberedItem = "numbered-item",
  LeftLink = "left-link",
  LeftLinkStar = "left-link-star",
  RightLink = "right-link",
  TableColumn = "table-column",
  TableColumnRight = "table-column-right",
  TableColumnCenter = "table-column-center",
  TableColumnTitle = "table-column-title",
  Identifier = "identifier",
  Email = "email",
  Url = "url",
  UrlStar = "url-star",
  Variable = "variable",
  DoubleQuote = "double-quote",
  EscapedDoubleQuote = "escaped-double-quote",
  EscapedBackslash = "escaped-backslash",
  DiscardedControl = "discarded-control",
  RuntimeText = "runtime-text",
  GeneratedPageLink = "generated-page-link",
  GeneratedTagLinks = "generated-tag-links",
  LeftComment = "left-comment",
  InputStart = "input-start",
  InputEnd = "input-end",
  Other = "other"
}

export enum ParseErrorKind {
  RecursionDepthExceeded = "recursion-depth-exceeded",
  EndOfInput = "end-of-input",
  NoRulesMatch = "no-rules-match",
  RuleFailed = "rule-failed",
  NotSupportedMode = "not-supported-mode",
  NotStartOfLine = "not-start-of-line",
  InvalidInclude = "invalid-include",
  ListEmpty = "list-empty",
  ListContainsNonItem = "list-contains-non-item",
  ListItemOutsideList = "list-item-outside-list",
  ListDepthExceeded = "list-depth-exceeded",
  TableContainsNonRow = "table-contains-non-row",
  TableRowContainsNonCell = "table-row-contains-non-cell",
  TableRowOutsideTable = "table-row-outside-table",
  TableCellOutsideTable = "table-cell-outside-table",
  TabViewEmpty = "tab-view-empty",
  TabViewContainsNonTab = "tab-view-contains-non-tab",
  TabOutsideTabView = "tab-outside-tab-view",
  FootnotesNested = "footnotes-nested",
  BlockquoteDepthExceeded = "blockquote-depth-exceeded",
  RubyTextOutsideRuby = "ruby-text-outside-ruby",
  BibliographyContainsNonDefinitionList = "bibliography-contains-non-definition-list",
  NoSuchBlock = "no-such-block",
  BlockDisallowsStar = "block-disallows-star",
  BlockDisallowsScore = "block-disallows-score",
  BlockMissingName = "block-missing-name",
  BlockMissingCloseBrackets = "block-missing-close-brackets",
  BlockMalformedArguments = "block-malformed-arguments",
  BlockMissingArguments = "block-missing-arguments",
  BlockExpectedEnd = "block-expected-end",
  BlockEndMismatch = "block-end-mismatch",
  NoSuchEmbed = "no-such-embed",
  NoSuchModule = "no-such-module",
  ModuleMissingName = "module-missing-name",
  NoSuchPage = "no-such-page",
  NoSuchVariable = "no-such-variable",
  InvalidUrl = "invalid-url",
  NotSupportedInline = "not-supported-inline"
}

export interface ParseError {
  token: Token
  rule: string
  span: [number, number]
  kind: ParseErrorKind
}

export interface UserInfo {
  "user-id": number
  "user-slug": string
  "user-name": string
  "user-karma": number
  "user-avatar-data": string
  "user-profile-url": string
}

export enum Layout {
  WIKIDOT = "wikidot",
  WIKIJUMP = "wikijump"
}
export enum PageLockType {
  Wikidot = "wikidot",
  PermissionOnly = "permission-only",
  AuthorOrPermissionOnly = "author-or-permission-only"
}
export enum PagePane {
  None = "none",
  Append = "append",
  Backlinks = "backlinks",
  File = "file",
  History = "history",
  Tags = "tags",
  Layout = "layout",
  Move = "move",
  Parent = "parent",
  Watchers = "watchers",
  SiteTools = "site-tools",
  Children = "children",
  Vote = "vote",
  Delete = "delete",
  EditMeta = "edit-meta",
  Lock = "lock"
}
export enum UserType {
  Regular = "regular",
  System = "system",
  Site = "site",
  Bot = "bot"
}
export enum License {
  CcBySa40 = "cc-by-sa-4.0",
  CcBy40 = "cc-by-4.0",
  CcByNd40 = "cc-by-nd-4.0",
  CcByNc40 = "cc-by-nc-4.0",
  CcByNcSa40 = "cc-by-nc-sa-4.0",
  CcByNcNd40 = "cc-by-nc-nd-4.0",
  CcBySa30 = "cc-by-sa-3.0",
  CcBy30 = "cc-by-3.0",
  CcByNd30 = "cc-by-nd-3.0",
  CcByNc30 = "cc-by-nc-3.0",
  CcByNcSa30 = "cc-by-nc-sa-3.0",
  CcByNcNd30 = "cc-by-nc-nd-3.0",
  CcBySa25 = "cc-by-sa-2.5",
  CcBy25 = "cc-by-2.5",
  CcByNd25 = "cc-by-nd-2.5",
  CcByNc25 = "cc-by-nc-2.5",
  CcByNcSa25 = "cc-by-nc-sa-2.5",
  CcByNcNd25 = "cc-by-nc-nd-2.5",
  GnuFdl13 = "gnu-fdl-1.3",
  GnuFdl12 = "gnu-fdl-1.2",
  GnuFdl11 = "gnu-fdl-1.1",
  Cc0 = "cc0"
}
export enum PageRevisionType {
  Regular = "regular",
  Rollback = "rollback",
  Undo = "undo",
  Create = "create",
  Delete = "delete",
  Undelete = "undelete",
  Move = "move"
}
export enum FileRevisionType {
  Regular = "regular",
  Rollback = "rollback",
  Create = "create",
  Delete = "delete",
  Undelete = "undelete",
  Move = "move"
}
export enum DeleteOptions {
  Move = "move",
  Delete = "delete"
}
export enum ToastType {
  Success = "success",
  Danger = "danger",
  Warning = "warning",
  Info = "info"
}
export interface DeepwellError {
  message: string
  code: number
  data?: JsonValue
}
