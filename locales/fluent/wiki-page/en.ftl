### Wiki Page View

wiki-page-category = category: { $category }

wiki-page-module-new-page-name = Name of the new page
wiki-page-module-search-all-query = Search all Wikis

wiki-page-revision = revision: { $revision }

wiki-page-last-edit = last edited: { $date } ({ $days ->
  [0] today
  [1] yesterday
  *[other] { $days } days ago
})

wiki-page-source = Page source

wiki-page-view-source = View Source

## Wiki page actions
wiki-page-action-append = Append
wiki-page-action-edit-sections = Edit Sections
wiki-page-action-edit-meta = Edit Meta
wiki-page-action-watchers = Watchers
wiki-page-watchers-unimported = The watcher list for this imported page is unavailable because its subscriptions were not imported.
wiki-page-action-backlinks = Backlinks
wiki-page-action-lock = Lock Page
wiki-page-action-rename-move = Move

wiki-page-revision-history = Page revision history

wiki-page-revision-filter =
  .show = Show page changes:
  .all = ALL
  .source = source changes
  .title = title changes
  .move = page name changes
  .tags = tags changes
  .meta = metadata changes
  .files = files changes
wiki-page-revision-perpage = Revisions per page:
wiki-page-revision-update-list = Update list
wiki-page-revision-compare-versions = Compare versions
wiki-page-revision-pager =
  .page = page
  .of = of
  .previous = previous
  .next = next

wiki-page-revision-diff = Compare revisions
  .from = From revision
  .to = To revision
  .compare = Compare
  .swap = Swap
  .loading = Loading comparison…
  .no-changes = No differences.
  .unavailable = There are not two page revisions available to compare

wiki-page-revision-view-unavailable = Historical page snapshot unavailable

wiki-page-revision-banner =
  .title = Historical revision
  .page = Page
  .close = Close

wiki-page-revision-number = Revision #

wiki-page-revision-created-at = Edit time

wiki-page-revision-user = User

wiki-page-revision-comments = Comments

wiki-page-revision-rollback = Revert

wiki-page-revision-type = Type
  .create = Create
  .regular = Edit
  .move = Move
  .delete = Delete
  .rollback = Rollback
  .undelete = Restore
  .undo = Undo

### Wiki Page Vote

wiki-page-vote = Page rating
  .description = Simply rate contents of this page.
  .set = Cast vote
  .remove = Cancel vote
  .list = List votes
  .score = Rating
  .like = I like it
  .dislike = I don't like it
  .cancel = Cancel my vote
  .who-rated = Look who rated this page
  .user = User
  .toast-set = Successfully voted.
  .toast-remove = Successfully removed vote.

### Wiki Page Edit

wiki-page-edit = Edit the page
  .toast = Page saved.

wiki-page-append-content = Wikitext to append

wiki-page-create = Create new page

wiki-page-move = Move page
  .new-slug = New slug
  .toast = Page moved.

wiki-page-layout = Page layout
  .default = Default layout
  .wikidot = Wikidot (Legacy)
  .wikijump = Wikijump
  .toast = Page layout saved.

wiki-page-meta-tag-name = Meta tag name
wiki-page-meta-tag-content = Meta tag content

wiki-page-delete = Delete page
  .toast = Page deleted.

wiki-page-restore = Restore page
  .select = Select page to restore
  .toast = Page restored.

wiki-page-deleted = Deleted at { $datetime }

### Wiki Page Files

wiki-page-file-no-files = No files for this page.

wiki-page-file-upload =
  .select = Select file:
  .name = File name:
  .toast = File uploaded.

wiki-page-file-delete =
  .toast = File deleted.
  .confirmation = Delete this file?
  .filename = File
  .page = Page

  .confirm = Confirm delete

wiki-page-file-move-destination-page = Destination page

wiki-page-file = Page files
  .name = File name
  .created-at = Created at
  .updated-at = Updated at
  .mime = File type
  .size = File size
  .page = Page

wiki-page-file-list =
  .title = Files
  .total-files = Total files:
  .total-size = Total size:
  .header-name = File name
  .header-type = File type
  .header-size = Size
  .info = Info
  .options = Options
  .rename = Rename
  .move = Move
  .delete = Delete
  .history = History
  .upload = Upload a file from your computer
wiki-page-file-info =
  .title = File Information
  .name = File name:
  .url = Full file URL:
  .size = File size:
  .mime = MIME type:
  .content-type = Content type:
  .uploaded-by = Uploaded by:
  .upload-date = Upload date:
  .unavailable = Unavailable
  .close = Close

wiki-page-file-history = File history

wiki-page-file-revision-type = Type
  .create = Create
  .regular = Edit
  .move = Move
  .delete = Delete
  .rollback = Revert
  .undelete = Restore
  .undo = Undo

wiki-page-file-restore = Restore
  .new-page = Destination page
  .new-name = New file name
  .toast = File restored.

wiki-page-file-mirror-readonly =
  .title = PERMISSION ERROR
  .lead-in = Please note:
  .message = Files on this imported page are read-only.
  .extra-message = Mirror pages show the source inventory. Ask a site administrator to update their files through the Wikidot import.

### Wiki page lock

wiki-page-lock = Lock Page
  .permission-only = Permission Only
  .author-or-permission-only = Permission/Author Only
  .permission-only-text = Only members with lock bypass permission can edit.
  .author-or-permission-only-text = Members with permission and page authors can edit.
  .reason = Reason (optional)
  .expires-at = (Optional) Set a date when this lock will automatically expire:
  .override = Override existing lock
  .history = Lock History
  .history-type = Type
  .history-user = Locked by
  .history-reason = Lock reason
  .history-created = Created at
  .history-expires = Expires at
  .history-status = Status
  .history-active = Active
  .history-expired = Expired
  .history-removed = Removed
  .history-overridden = Overridden
  .history-none = No lock history for this page.
  .remove = Remove
  .toast = Page locked.
  .toast-remove = Page lock removed.
  .toast-override = Page lock overridden.

### Wiki page parents

wiki-page-parent = Page parents
  .toast = Page parents saved.

### Wiki Page Children

wiki-page-children = Page children
  .no-children = No children for this page.

### Blueprint page fallback strings

wiki-page-missing = The page //{ $slug }// you want to access does not exist.

wiki-page-private = + Private content

    This area of the website is private and you don't have access to it. If you believe you need access to this area please contact the web site administrators.

wiki-page-banned = + You have been banned

    You are currently banned from this site, and the site settings do not allow banned users to view pages.

wiki-page-no-render = Content not shown.
